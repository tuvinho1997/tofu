const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
// Chave secreta utilizada para assinar tokens JWT. Deve ser definida via variável de ambiente em produção.
const JWT_SECRET = process.env.JWT_SECRET || 'faccao_control_secret_key_2025';

// Middleware
app.use(cors());
// Define um limite maior para JSON e URL-encoded para suportar uploads de imagens codificadas em base64
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use('/static', express.static(path.join(__dirname, 'static')));

// Servir arquivos de comprovantes e uploads
// Permite definir o diretório de uploads via variável de ambiente (UPLOADS_DIR). Caso não seja definido, usa a pasta padrão "uploads" dentro do projeto.
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    // Cria a pasta de uploads, incluindo diretórios intermediários se necessário
    fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// Banco de dados SQLite
// O caminho do arquivo de banco pode ser configurado via variável de ambiente DB_PATH (ex.: /home/user/data/faccao_control.db)
const DB_PATH = process.env.DB_PATH || 'faccao_control.db';
const db = new sqlite3.Database(DB_PATH);

// Inicializar banco de dados
function initDatabase() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // Tabela de usuários
            db.run(`CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT DEFAULT 'admin',
                ativo BOOLEAN DEFAULT 1,
                data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Tabela de membros
            db.run(`CREATE TABLE IF NOT EXISTS membros (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nome TEXT NOT NULL,
                rg TEXT NOT NULL,
                telefone TEXT,
                ativo BOOLEAN DEFAULT 1,
                cargo TEXT DEFAULT 'membro',
                data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Garante que a coluna cargo exista. Caso a tabela já exista sem a coluna cargo, adiciona-a com valor padrão 'membro'.
            db.run('ALTER TABLE membros ADD COLUMN cargo TEXT DEFAULT "membro"', (err) => {
                if (err && !/duplicate column/i.test(err.message)) {
                    console.error('Erro ao adicionar coluna cargo em membros:', err.message);
                }
            });
            // Garante que a coluna telefone exista. Caso a tabela já exista sem essa coluna, adiciona-a.
            db.run('ALTER TABLE membros ADD COLUMN telefone TEXT', (err) => {
                if (err && !/duplicate column/i.test(err.message)) {
                    console.error('Erro ao adicionar coluna telefone em membros:', err.message);
                }
            });

            // Garante que a coluna usuario_id exista em membros para vincular membros a usuários (cadastros pendentes).
            db.run('ALTER TABLE membros ADD COLUMN usuario_id INTEGER', (err) => {
                if (err && !/duplicate column/i.test(err.message)) {
                    console.error('Erro ao adicionar coluna usuario_id em membros:', err.message);
                }
            });

            // Tabela de rotas
            db.run(`CREATE TABLE IF NOT EXISTS rotas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                membro_id INTEGER,
                membro_nome TEXT,
                quantidade INTEGER,
                data_entrega DATE,
                status TEXT DEFAULT 'pendente',
                comprovante_path TEXT,
                /*
                 * Campo pagamento registra quanto o membro recebe por realizar a rota.
                 * A cada rota entregue, o membro tem direito a R$ 16.000,00.
                 * Se o status da rota for diferente de "entregue", o pagamento permanece em 0
                 * até que a rota seja marcada como entregue. Esse campo facilita a
                 * contabilização de custos de operação.
                 */
                pagamento REAL DEFAULT 0,
                /*
                 * Identificador do usuário que lançou o pagamento da rota.  Este campo
                 * armazena o id do usuário com papel de líder responsável pelo
                 * pagamento. Se nulo, indica que o pagamento ainda não foi
                 * lançado.  Quando um pagamento for confirmado, será
                 * preenchido com o id do líder selecionado.
                 */
                pagamento_usuario_id INTEGER,
                data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (membro_id) REFERENCES membros (id)
            )`);

            // Garante que a coluna comprovante_path exista. Caso a tabela já exista sem essa coluna, adiciona-a.
            db.run('ALTER TABLE rotas ADD COLUMN comprovante_path TEXT', (err) => {
                if (err && !/duplicate column/i.test(err.message)) {
                    console.error('Erro ao adicionar coluna comprovante_path em rotas:', err.message);
                }
            });
            // Garante que a coluna pagamento exista. Se a tabela rotas já estiver criada sem esta coluna,
            // adiciona-a com valor padrão 0. Esse campo registra quanto o membro recebe por rota.
            db.run('ALTER TABLE rotas ADD COLUMN pagamento REAL DEFAULT 0', (err) => {
                if (err && !/duplicate column/i.test(err.message)) {
                    console.error('Erro ao adicionar coluna pagamento em rotas:', err.message);
                }
            });

            // Garante que a coluna pagamento_usuario_id exista. Esta coluna guarda o id do
            // usuário (líder) que realizou o lançamento do pagamento. Caso a tabela
            // já exista sem esta coluna, adiciona-a.
            db.run('ALTER TABLE rotas ADD COLUMN pagamento_usuario_id INTEGER', (err) => {
                if (err && !/duplicate column/i.test(err.message)) {
                    console.error('Erro ao adicionar coluna pagamento_usuario_id em rotas:', err.message);
                }
            });

            // Remove rotas duplicadas mantendo apenas o primeiro registro para cada
            // combinação (membro_id, data_entrega). Sem esta remoção, a criação
            // do índice único abaixo poderia falhar se houver duplicidades já
            // cadastradas.
            db.run(`DELETE FROM rotas
                    WHERE rowid NOT IN (SELECT MIN(rowid) FROM rotas GROUP BY membro_id, data_entrega)`, (err) => {
                if (err) {
                    console.error('Erro ao remover duplicatas de rotas:', err.message);
                }
                // Cria um índice único para impedir a criação de mais de uma rota
                // para o mesmo membro e data de entrega.  Isso garante que
                // generateRotasParaProximaSemana() não insira rotas duplicadas
                // quando o servidor reinicia.
                db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rotas_membro_data ON rotas(membro_id, data_entrega)', (idxErr) => {
                    if (idxErr) {
                        console.error('Erro ao criar índice único em rotas:', idxErr.message);
                    }
                });
            });

            // Tabela de encomendas
            db.run(`CREATE TABLE IF NOT EXISTS encomendas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cliente TEXT NOT NULL,
                familia TEXT NOT NULL,
                telefone_cliente TEXT,
                municao_5mm INTEGER DEFAULT 0,
                municao_9mm INTEGER DEFAULT 0,
                municao_762mm INTEGER DEFAULT 0,
                municao_12cbc INTEGER DEFAULT 0,
                valor_total REAL,
                comissao REAL,
                status TEXT DEFAULT 'pendente',
                usuario TEXT,
                data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Garante que a coluna usuario exista na tabela encomendas. Caso a tabela já exista sem essa coluna, adiciona-a.
            db.run('ALTER TABLE encomendas ADD COLUMN usuario TEXT', (err) => {
                if (err && !/duplicate column/i.test(err.message)) {
                    console.error('Erro ao adicionar coluna usuario em encomendas:', err.message);
                }
            });

            // Garante que a coluna telefone_cliente exista na tabela encomendas. Caso a tabela já exista sem essa coluna, adiciona-a.
            db.run('ALTER TABLE encomendas ADD COLUMN telefone_cliente TEXT', (err) => {
                if (err && !/duplicate column/i.test(err.message)) {
                    console.error('Erro ao adicionar coluna telefone_cliente em encomendas:', err.message);
                }
            });

            // Tabela de estoque
            db.run(`CREATE TABLE IF NOT EXISTS estoque (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tipo TEXT NOT NULL,
                nome TEXT NOT NULL,
                quantidade INTEGER DEFAULT 0,
                preco REAL DEFAULT 0,
                data_atualizacao DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Antes de criar o índice único no estoque, remova eventuais registros
            // duplicados de (tipo, nome). Caso duplicatas existam, a criação do
            // índice único falharia com um erro de violação de restrição, o que
            // impediria a remoção posterior. Para garantir que o índice seja
            // criado sem erros, primeiro eliminamos todas as duplicatas
            // preservando o registro de menor rowid para cada par (tipo, nome).
            db.run(`DELETE FROM estoque
                    WHERE rowid NOT IN (SELECT MIN(rowid) FROM estoque GROUP BY tipo, nome)`, (delErr) => {
                if (delErr) {
                    console.error('Erro ao remover duplicatas do estoque:', delErr.message);
                }
                // Depois de garantir que não há registros duplicados, cria o índice
                // único. Se o índice já existir, nada é feito. Se ainda não existir,
                // ele será criado sem violar a restrição, pois não há mais
                // duplicatas.
                db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_estoque_tipo_nome ON estoque(tipo, nome)', (idxErr) => {
                    if (idxErr) {
                        console.error('Erro ao criar índice único em estoque:', idxErr.message);
                    }
                });
            });

            // Tabela de imagens
            db.run(`CREATE TABLE IF NOT EXISTS imagens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nome TEXT NOT NULL,
                tipo TEXT NOT NULL,
                caminho TEXT NOT NULL,
                descricao TEXT,
                data_upload DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Tabela de saídas avulsas de estoque. Armazena retiradas destinadas a membros específicas.
            db.run(`CREATE TABLE IF NOT EXISTS saidas_avulsas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tipo TEXT NOT NULL,
                item TEXT NOT NULL,
                quantidade REAL NOT NULL,
                retirado_por TEXT NOT NULL,
                destinos TEXT,
                data_saida DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Tabela de famílias
            db.run(`CREATE TABLE IF NOT EXISTS familias (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nome TEXT NOT NULL UNIQUE,
                data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // -------------------------------------------------------------------
            // Tabelas de Inventário da Família e Requisições de Itens
            // -------------------------------------------------------------------
            // Inventário da família: itens agrupados por categoria e item. Não há
            // mais conceito de subcategoria; cada registro associa um item a uma
            // categoria.  Um índice único em (categoria, item) impede
            // duplicidades.
            db.run(`CREATE TABLE IF NOT EXISTS inventario_familia (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                categoria TEXT NOT NULL,
                -- "item" representa o nome do produto. Mantemos também a coluna
                -- "subcategoria" por compatibilidade com versões anteriores. As duas
                -- colunas armazenam o mesmo valor.
                item TEXT,
                subcategoria TEXT,
                quantidade INTEGER DEFAULT 0,
                preco REAL DEFAULT 0,
                data_atualizacao DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            // Garante a existência das colunas item e subcategoria. Caso a
            // tabela já exista mas falte alguma delas, adiciona a coluna.
            db.run('ALTER TABLE inventario_familia ADD COLUMN item TEXT', (err) => {
                if (err && !/duplicate column/i.test(err.message)) {
                    console.error('Erro ao adicionar coluna item em inventario_familia:', err.message);
                }
            });
            db.run('ALTER TABLE inventario_familia ADD COLUMN subcategoria TEXT', (err) => {
                if (err && !/duplicate column/i.test(err.message)) {
                    console.error('Erro ao adicionar coluna subcategoria em inventario_familia:', err.message);
                }
            });
            // Copia valores entre item e subcategoria se algum estiver nulo. Essa
            // sincronização garante compatibilidade com registros antigos.
            db.run(`UPDATE inventario_familia SET item = subcategoria WHERE (item IS NULL OR item = '') AND subcategoria IS NOT NULL`);
            db.run(`UPDATE inventario_familia SET subcategoria = item WHERE (subcategoria IS NULL OR subcategoria = '') AND item IS NOT NULL`);
            // Índice único para evitar duplicidade (categoria, item)
            db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_inventario_cat_item ON inventario_familia(categoria, item)');

            // Requisições de itens da família: registra pedidos de membros/gerentes
            // e o processamento por líderes ou administradores.
            db.run(`CREATE TABLE IF NOT EXISTS requisicoes_familia (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL,
                membro_id INTEGER,
                solicitante_nome TEXT,
                solicitante_cargo TEXT,
                solicitante_rg TEXT,
                solicitante_telefone TEXT,
                quantidade INTEGER NOT NULL,
                status TEXT DEFAULT 'pendente',
                lider_id INTEGER,
                data_solicitacao DATETIME DEFAULT CURRENT_TIMESTAMP,
                data_resposta DATETIME,
                data_entrega DATETIME,
                FOREIGN KEY (item_id) REFERENCES inventario_familia(id),
                FOREIGN KEY (membro_id) REFERENCES membros(id),
                FOREIGN KEY (lider_id) REFERENCES usuarios(id)
            )`);

            // Histórico de alterações do inventário da família: registra todas as
            // modificações feitas no estoque com informações de auditoria.
            db.run(`CREATE TABLE IF NOT EXISTS historico_inventario_familia (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL,
                usuario_id INTEGER NOT NULL,
                usuario_nome TEXT NOT NULL,
                quantidade_anterior INTEGER NOT NULL,
                quantidade_nova INTEGER NOT NULL,
                motivo TEXT NOT NULL,
                data_alteracao DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (item_id) REFERENCES inventario_familia(id),
                FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
            )`);

            // Preenche o inventário da família com categorias e itens padrão, se
            // ainda não existirem.  As quantidades iniciais são 0 e o preço
            // inicial é 0. Use INSERT OR IGNORE para evitar duplicatas caso
            // os itens já tenham sido cadastrados.
            const itensFamilia = [
                // Produtos Comprados
                { categoria: 'Produtos Comprados', item: 'Erva' },
                { categoria: 'Produtos Comprados', item: 'Farinha' },
                { categoria: 'Produtos Comprados', item: 'Lança' },
                { categoria: 'Produtos Comprados', item: 'Viagra' },
                { categoria: 'Produtos Comprados', item: 'H.' },
                { categoria: 'Produtos Comprados', item: 'Oxy' },
                { categoria: 'Produtos Comprados', item: 'Balinha' },
                { categoria: 'Produtos Comprados', item: 'Rapé' },
                // Produtos para Roubo
                { categoria: 'Produtos para Roubo', item: 'C4' },
                { categoria: 'Produtos para Roubo', item: 'Masterpick' },
                // Produtos de Ação Fechada
                { categoria: 'Produtos de Ação Fechada', item: 'MK1' },
                { categoria: 'Produtos de Ação Fechada', item: 'MK2' },
                { categoria: 'Produtos de Ação Fechada', item: 'MK3' },
                { categoria: 'Produtos de Ação Fechada', item: 'MK4' },
                { categoria: 'Produtos de Ação Fechada', item: 'MK5' },
                { categoria: 'Produtos de Ação Fechada', item: 'Chave Ouro' },
                { categoria: 'Produtos de Ação Fechada', item: 'Chave Platina' },
                // Produtos de Ação - Pistolas
                { categoria: 'Produtos de Ação - Pistolas', item: 'Five' },
                { categoria: 'Produtos de Ação - Pistolas', item: 'Desert' },
                { categoria: 'Produtos de Ação - Pistolas', item: '.45 acb' },
                { categoria: 'Produtos de Ação - Pistolas', item: 'colt 45' },
                { categoria: 'Produtos de Ação - Pistolas', item: 'm1911' },
                // Produtos de Ação - Sub-metralhadora
                { categoria: 'Produtos de Ação - Sub-metralhadora', item: 'Mtar' },
                { categoria: 'Produtos de Ação - Sub-metralhadora', item: 'Tec-9' },
                { categoria: 'Produtos de Ação - Sub-metralhadora', item: 'Mini uzi' },
                { categoria: 'Produtos de Ação - Sub-metralhadora', item: 'M-tar 21' },
                // Produtos de Ação - Fuzil
                { categoria: 'Produtos de Ação - Fuzil', item: 'AK 103' },
                { categoria: 'Produtos de Ação - Fuzil', item: 'AUG' },
                { categoria: 'Produtos de Ação - Fuzil', item: 'AK 47' },
                { categoria: 'Produtos de Ação - Fuzil', item: 'M16' },
                // Produtos de Ação - Escopeta
                { categoria: 'Produtos de Ação - Escopeta', item: 'spas 12' },
                // Equipamentos diversos
                { categoria: 'Equipamentos', item: 'Pager' },
                { categoria: 'Equipamentos', item: 'Camisa de Força' },
                { categoria: 'Equipamentos', item: 'Algema' },
                { categoria: 'Equipamentos', item: 'Capuz' },
                { categoria: 'Equipamentos', item: 'Adrenalina' },
                { categoria: 'Equipamentos', item: 'Colete' },
                { categoria: 'Equipamentos', item: 'Placa' },
                { categoria: 'Equipamentos', item: 'Vaselina' },
                { categoria: 'Equipamentos', item: 'Rastreador' },
                // Acessórios
                { categoria: 'Acessórios', item: 'Supressor' },
                { categoria: 'Acessórios', item: 'Grip avançado' },
                { categoria: 'Acessórios', item: 'Compensador' },
                { categoria: 'Acessórios', item: 'Clipe extendido' },
                { categoria: 'Acessórios', item: 'Lanterna' }
            ];
            itensFamilia.forEach(item => {
                // Insere o valor tanto em "item" quanto em "subcategoria" para
                // manter compatibilidade. Caso já exista, a inserção é ignorada.
                db.run('INSERT OR IGNORE INTO inventario_familia (categoria, item, subcategoria, quantidade, preco) VALUES (?, ?, ?, 0, 0)',
                    [item.categoria, item.item, item.item]);
            });

            // Tabela de configuração geral. Armazena chaves de configuração como a taxa de comissão.
            db.run(`CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT
            )`);
            // Insere taxa de comissão padrão (7%) se ainda não existir
            db.run('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)', ['commission_rate', '0.07']);

            // Criar usuário admin padrão
            const hashedPassword = bcrypt.hashSync('tofu$2025', 10);
            db.run(`INSERT OR IGNORE INTO usuarios (username, password, role) VALUES (?, ?, ?)`, 
                   ['tofu', hashedPassword, 'admin']);

            // Criar usuário líder padrão para testes
            const hashedLiderPassword = bcrypt.hashSync('lider$2025', 10);
            db.run(`INSERT OR IGNORE INTO usuarios (username, password, role) VALUES (?, ?, ?)`,
                   ['lider', hashedLiderPassword, 'lider']);

            // Garante que a coluna ativo exista na tabela usuarios. Caso a tabela já exista sem essa coluna, adiciona-a.
            db.run('ALTER TABLE usuarios ADD COLUMN ativo BOOLEAN DEFAULT 1', (err) => {
                if (err && !/duplicate column/i.test(err.message)) {
                    console.error('Erro ao adicionar coluna ativo em usuarios:', err.message);
                }
            });

            // Inicializar estoque com materiais
            // Inicializa o estoque com todas as quantidades zeradas.  Anteriormente o
            // sistema criava um estoque inicial com 1000 unidades de alumínio, cobre,
            // embalagem plástica e ferro, 100 de titânio e zero de munições.  A pedido
            // do usuário, o estoque padrão agora começa vazio para cada item.  O
            // preço permanece o mesmo apenas como referência para cálculos.
            const materiais = [
                { tipo: 'material', nome: 'Alumínio', quantidade: 0, preco: 24.50 },
                { tipo: 'material', nome: 'Cobre', quantidade: 0, preco: 24.62 },
                { tipo: 'material', nome: 'Emb Plástica', quantidade: 0, preco: 24.50 },
                { tipo: 'material', nome: 'Ferro', quantidade: 0, preco: 24.50 },
                { tipo: 'material', nome: 'Titânio', quantidade: 0, preco: 24.62 },
                { tipo: 'municao', nome: '5mm', quantidade: 0, preco: 100.00 },
                { tipo: 'municao', nome: '9mm', quantidade: 0, preco: 125.00 },
                { tipo: 'municao', nome: '762mm', quantidade: 0, preco: 200.00 },
                { tipo: 'municao', nome: '12cbc', quantidade: 0, preco: 200.00 }
            ];

            materiais.forEach(material => {
                db.run(`INSERT OR IGNORE INTO estoque (tipo, nome, quantidade, preco) VALUES (?, ?, ?, ?)`,
                       [material.tipo, material.nome, material.quantidade, material.preco]);
            });

            console.log('✅ Banco de dados inicializado com sucesso!');
            resolve();
        });
    });
}

// Recupera a taxa de comissão atual da tabela de configuração. Se o valor
// não estiver definido, retorna o padrão de 7%.
function getCommissionRate() {
    return new Promise((resolve, reject) => {
        db.get('SELECT value FROM config WHERE key = ?', ['commission_rate'], (err, row) => {
            if (err) {
                return reject(err);
            }
            if (row && row.value !== undefined && row.value !== null) {
                const rate = parseFloat(row.value);
                resolve(isNaN(rate) ? 0.07 : rate);
            } else {
                resolve(0.07);
            }
        });
    });
}

// Middleware de autenticação
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Token de acesso requerido' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token inválido' });
        }
        req.user = user;
        next();
    });
}

/**
 * Gera rotas pendentes para cada membro ativo para todos os dias da próxima semana.
 * Se a rota já existir para o membro e data, não é criada novamente.
 * A semana considerada inicia na próxima segunda‑feira e inclui 7 dias.
 */
async function generateRotasParaProximaSemana() {
    return new Promise((resolve, reject) => {
        // Obtém a data atual e calcula a próxima segunda‑feira
        const hoje = new Date();
        const diaSemana = hoje.getDay(); // 0=domingo, 1=segunda, ..., 6=sábado
        // Distância até a próxima segunda‑feira
        let diasAteSegunda = 8 - diaSemana;
        if (diaSemana === 0) {
            // Se hoje é domingo (0), próxima segunda é amanhã (1 dia)
            diasAteSegunda = 1;
        }
        const inicioSemana = new Date(hoje);
        inicioSemana.setDate(hoje.getDate() + diasAteSegunda);

        // Gera array de 7 datas (segunda a domingo)
        const datas = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(inicioSemana);
            d.setDate(inicioSemana.getDate() + i);
            const isoDate = d.toISOString().substring(0, 10);
            datas.push(isoDate);
        }

        // Buscar todos os membros ativos que tenham o cargo 'membro'. Somente
        // membros (e não gerentes/líderes) recebem rotas pendentes
        db.all('SELECT id, nome FROM membros WHERE ativo = 1 AND cargo = "membro"', (err, membros) => {
            if (err) {
                console.error('Erro ao consultar membros para geração de rotas:', err.message);
                return reject(err);
            }
            let pendentes = 0;
            // Para cada membro e cada data, tenta inserir a rota.  Se já
            // existir uma rota para a combinação (membro_id, data_entrega), a
            // inserção será ignorada por causa do índice único idx_rotas_membro_data.
            membros.forEach(membro => {
                datas.forEach(dataEntrega => {
                    db.run('INSERT OR IGNORE INTO rotas (membro_id, membro_nome, quantidade, data_entrega, status) VALUES (?, ?, ?, ?, ?)',
                        [membro.id, membro.nome, 0, dataEntrega, 'pendente'], function(err2) {
                            if (err2) {
                                console.error('Erro ao inserir rota pendente:', err2.message);
                            } else if (this.changes > 0) {
                                pendentes++;
                            }
                        });
                });
            });
            console.log(`Rotas geradas/atualizadas para a próxima semana: ${pendentes}`);
            resolve();
        });
    });
}

// Rotas de autenticação
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    db.get('SELECT * FROM usuarios WHERE username = ?', [username], (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Erro interno do servidor' });
        }

        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        // Verifica se o usuário foi aprovado (campo ativo)
        if (!user.ativo) {
            return res.status(403).json({ error: 'Usuário ainda não foi aprovado. Aguarde autorização.' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            message: 'Login realizado com sucesso',
            token: token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role
            }
        });
    });
});

// Cadastro de novos usuários (solicitação de cadastro)
// Cria um usuário com role 'membro' e ativo = 0 e um registro correspondente em membros com cargo 'membro' e ativo = 0.
app.post('/api/auth/register', async (req, res) => {
    const { username, password, nome, rg, telefone } = req.body;

    // Verificações básicas
    if (!username || !password || !nome || !rg) {
        return res.status(400).json({ error: 'Usuário, senha, nome e RG são obrigatórios' });
    }
    // Verifica se já existe usuário com o mesmo username
    db.get('SELECT id FROM usuarios WHERE username = ?', [username], (err, existingUser) => {
        if (err) {
            return res.status(500).json({ error: 'Erro ao verificar usuário existente' });
        }
        if (existingUser) {
            return res.status(400).json({ error: 'Nome de usuário já em uso' });
        }
        // Hash da senha
        const hashed = bcrypt.hashSync(password, 10);
        // Insere na tabela de usuários com role 'membro' e ativo 0
        db.run('INSERT INTO usuarios (username, password, role, ativo) VALUES (?, ?, ?, 0)', [username, hashed, 'membro'], function(err2) {
            if (err2) {
                console.error(err2);
                return res.status(500).json({ error: 'Erro ao registrar usuário' });
            }
            const userId = this.lastID;
            // Insere na tabela de membros com cargo 'membro', ativo 0 e vínculo ao usuário
            db.run('INSERT INTO membros (nome, rg, telefone, cargo, ativo, usuario_id) VALUES (?, ?, ?, ?, 0, ?)', [nome, rg, telefone || null, 'membro', userId], function(err3) {
                if (err3) {
                    console.error(err3);
                    return res.status(500).json({ error: 'Erro ao registrar membro' });
                }
                // Registro criado com sucesso
                return res.json({ message: 'Cadastro realizado. Aguarde aprovação de um líder ou administrador.' });
            });
        });
    });
});

app.get('/api/auth/init-admin', (req, res) => {
    res.json({ message: 'Admin já inicializado' });
});

// Rotas de membros
app.get('/api/membros', (req, res) => {
    db.all('SELECT * FROM membros WHERE ativo = 1 ORDER BY data_criacao DESC', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.post('/api/membros', (req, res) => {
    const { nome, rg, cargo, telefone } = req.body;
    if (!nome || !rg) {
        return res.status(400).json({ error: 'Nome e RG são obrigatórios' });
    }
    const cargoVal = cargo || 'membro';
    const telVal = telefone || null;
    db.run('INSERT INTO membros (nome, rg, cargo, telefone) VALUES (?, ?, ?, ?)', [nome, rg, cargoVal, telVal], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({
            message: 'Membro cadastrado com sucesso',
            id: this.lastID
        });
    });
});

// Inativa um membro existente. Apenas administradores ou líderes podem
// remover (inativar) membros. Gerentes e membros não possuem esta permissão.
app.delete('/api/membros/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const role = req.user && req.user.role;
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    db.run('UPDATE membros SET ativo = 0 WHERE id = ?', [id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: 'Membro removido com sucesso' });
    });
});

// Atualizar dados de um membro (nome, rg, cargo). Somente administradores, gerentes ou líderes podem modificar.
app.put('/api/membros/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { nome, rg, cargo, telefone } = req.body;

    // Verifica permissões do usuário logado. Apenas administradores ou líderes
    // podem editar dados de membros. Gerentes e membros não têm essa permissão.
    const role = req.user && req.user.role;
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    if (!nome || !rg) {
        return res.status(400).json({ error: 'Nome e RG são obrigatórios' });
    }
    const cargoVal = cargo || 'membro';
    const telVal = telefone || null;
    db.run('UPDATE membros SET nome = ?, rg = ?, cargo = ?, telefone = ? WHERE id = ?', [nome, rg, cargoVal, telVal, id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Membro não encontrado' });
        }
        res.json({ message: 'Membro atualizado com sucesso' });
    });
});

// Rotas de rotas
app.get('/api/rotas', (req, res) => {
    // Retorna todas as rotas, incluindo o nome do usuário que realizou o pagamento (se houver).
    // Fazemos um LEFT JOIN com a tabela de usuários para obter o username do pagante.
    const sql = `
        SELECT rotas.*, u.username AS pagante_username
        FROM rotas
        LEFT JOIN usuarios u ON rotas.pagamento_usuario_id = u.id
        ORDER BY rotas.data_criacao DESC
    `;
    db.all(sql, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Cria uma nova rota. Apenas usuários autenticados podem cadastrar rotas.  
// Membros e gerentes podem cadastrar rotas, mas não podem editá-las posteriormente.  
app.post('/api/rotas', authenticateToken, (req, res) => {
    const { membro_nome, quantidade, data_entrega, status, comprovante } = req.body;
    if (!membro_nome || !quantidade || !data_entrega) {
        return res.status(400).json({ error: 'Membro, quantidade e data de entrega são obrigatórios' });
    }
    const qtd = parseInt(quantidade);
    if (isNaN(qtd) || qtd <= 0) {
        return res.status(400).json({ error: 'Quantidade inválida' });
    }
    // Determina status: se não informado, assume "pendente" (rotas automáticas) ou 'entregue' para rotas manuais
    const rotaStatus = status || 'pendente';

    // Processa imagem de comprovante se fornecida (base64 DataURL)
    let comprovantePath = null;
    if (comprovante) {
        try {
            // exemplo de formato: data:image/png;base64,AAAA...
            const matches = comprovante.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
            if (matches) {
                const ext = matches[1];
                const base64Data = matches[2];
                const fileName = `comprovante_${Date.now()}.${ext}`;
                const filePath = path.join(uploadsDir, fileName);
                fs.writeFileSync(filePath, base64Data, 'base64');
                comprovantePath = `/uploads/${fileName}`;
            } else {
                console.warn('Formato de imagem de comprovante inválido');
            }
        } catch (e) {
            console.error('Erro ao salvar comprovante:', e.message);
        }
    }

    // Ao cadastrar uma nova rota, o pagamento começa como 0. Apenas quando um
    // administrador ou líder lançar o pagamento é que o valor será registrado.
    db.run('INSERT INTO rotas (membro_nome, quantidade, data_entrega, status, comprovante_path) VALUES (?, ?, ?, ?, ?)',
        [membro_nome, qtd, data_entrega, rotaStatus, comprovantePath], function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }

            const rotaId = this.lastID;
            // Se a rota já nasce entregue, atualiza o estoque com o acréscimo de materiais proporcional à quantidade
            if (rotaStatus === 'entregue') {
                adicionarMateriaisPorRota(qtd).then(() => {
                    res.json({
                        message: 'Rota cadastrada com sucesso',
                        id: rotaId
                    });
                }).catch(errStock => {
                    console.error('Erro ao adicionar materiais após cadastro de rota:', errStock);
                    res.json({
                        message: 'Rota cadastrada com sucesso (erro ao atualizar estoque)',
                        id: rotaId
                    });
                });
            } else {
                res.json({
                    message: 'Rota cadastrada com sucesso',
                    id: rotaId
                });
            }
        }
    );
});

// Excluir rota. Restrito a administradores, gerentes e líderes.
app.delete('/api/rotas/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const role = req.user && req.user.role;
    // Somente administradores ou líderes podem remover rotas. Membros e gerentes
    // podem cadastrar rotas, mas não possuem permissão de exclusão.
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    db.run('DELETE FROM rotas WHERE id = ?', [id], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Rota não encontrada' });
        }
        res.json({ message: 'Rota removida com sucesso' });
    });
});

// Lança pagamento de uma rota entregue. Somente administradores ou líderes podem pagar.
app.put('/api/rotas/:id/pagamento', authenticateToken, (req, res) => {
    const { id } = req.params;
    const role = req.user && req.user.role;
    // Apenas administradores ou líderes estão autorizados a lançar pagamento.
    // Gerentes e membros não possuem esta permissão.
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    const { pagante_id } = req.body;
    // Verifica se o pagante foi informado
    if (!pagante_id) {
        return res.status(400).json({ error: 'É necessário informar o líder responsável pelo pagamento' });
    }
    // Valida se o pagante existe e tem papel de líder
    db.get('SELECT role FROM usuarios WHERE id = ?', [pagante_id], (errUser, userRow) => {
        if (errUser) {
            return res.status(500).json({ error: errUser.message });
        }
        if (!userRow || userRow.role !== 'lider') {
            return res.status(400).json({ error: 'Usuário selecionado não é um líder válido' });
        }
        // Verifica se a rota existe, está entregue e ainda não foi paga
        db.get('SELECT status, pagamento, quantidade FROM rotas WHERE id = ?', [id], (errSelect, row) => {
            if (errSelect) {
                return res.status(500).json({ error: errSelect.message });
            }
            if (!row) {
                return res.status(404).json({ error: 'Rota não encontrada' });
            }
            if (row.status !== 'entregue') {
                return res.status(400).json({ error: 'Pagamento só pode ser lançado para rotas entregues' });
            }
            if (row.pagamento && row.pagamento > 0) {
                return res.status(400).json({ error: 'Pagamento já foi lançado para esta rota' });
            }
            // Multiplica o pagamento unitário (16 mil) pela quantidade entregue
            const valorUnitario = 16000;
            const valorPagamento = (row.quantidade || 1) * valorUnitario;
            // Atualiza pagamento e registra o usuário que lançou o pagamento
            db.run('UPDATE rotas SET pagamento = ?, pagamento_usuario_id = ? WHERE id = ?', [valorPagamento, pagante_id, id], function (errUpdate) {
                if (errUpdate) {
                    return res.status(500).json({ error: errUpdate.message });
                }
                res.json({ message: 'Pagamento lançado com sucesso', valor: valorPagamento });
            });
        });
    });
});

// Atualizar rota (quantidade e status). Somente administradores ou líderes podem atualizar uma rota.
app.put('/api/rotas/:id', authenticateToken, (req, res) => {
    const role = req.user && req.user.role;
    // Somente administradores ou líderes podem editar rotas. Membros e gerentes
    // têm permissão apenas para cadastrar.
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    const { id } = req.params;
    const { quantidade, status } = req.body;

    if (!quantidade || !status) {
        return res.status(400).json({ error: 'Quantidade e status são obrigatórios' });
    }

    // Recupera status anterior da rota para evitar atualização duplicada de estoque
    db.get('SELECT status FROM rotas WHERE id = ?', [id], (errSelect, row) => {
        if (errSelect) {
            return res.status(500).json({ error: errSelect.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Rota não encontrada' });
        }
        const statusAnterior = row.status;
        // Atualiza apenas quantidade e status. O pagamento deve ser lançado manualmente por rota entregue.
        db.run('UPDATE rotas SET quantidade = ?, status = ? WHERE id = ?', [quantidade, status, id], function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            // Se a rota foi marcada como entregue agora e antes não era, incrementa estoque proporcional à quantidade
            if (status === 'entregue' && statusAnterior !== 'entregue') {
                const qtdEntrega = parseFloat(quantidade) || 1;
                adicionarMateriaisPorRota(qtdEntrega).then(() => {
                    res.json({ message: 'Rota atualizada com sucesso' });
                }).catch(errStock => {
                    console.error('Erro ao atualizar estoque após entrega de rota:', errStock);
                    res.json({ message: 'Rota atualizada com sucesso (erro ao atualizar estoque)' });
                });
            } else {
                res.json({ message: 'Rota atualizada com sucesso' });
            }
        });
    });
});

/**
 * Incrementa o estoque de matérias-primas em virtude de uma rota concluída.
 * Para cada rota entregue, adiciona 160 unidades de Alumínio, Cobre, Emb Plástica e Ferro,
 * e 13 unidades de Titânio. Retorna uma Promise para permitir encadeamento.
 */
function adicionarMateriaisPorRota(qtd) {
    return new Promise((resolve, reject) => {
        const quantidadeRota = parseFloat(qtd) || 1;
        const updates = [
            { nome: 'Alumínio', quantidade: 160 * quantidadeRota },
            { nome: 'Cobre', quantidade: 160 * quantidadeRota },
            { nome: 'Emb Plástica', quantidade: 160 * quantidadeRota },
            { nome: 'Ferro', quantidade: 160 * quantidadeRota },
            { nome: 'Titânio', quantidade: 13 * quantidadeRota }
        ];
        let pending = updates.length;
        updates.forEach(item => {
            db.run('UPDATE estoque SET quantidade = quantidade + ? WHERE tipo = "material" AND nome = ?', [item.quantidade, item.nome], function(err) {
                if (err) {
                    return reject(err);
                }
                pending--;
                if (pending === 0) {
                    resolve();
                }
            });
        });
    });
}

/**
 * Subtrai do estoque de munições as quantidades especificadas de cada calibre.
 * Este método é utilizado quando uma encomenda entra em status que reserva estoque
 * (pronto ou entregue). Caso alguma munição não exista no estoque, a operação ainda
 * prossegue para manter consistência de estoque. Retorna uma Promise para encadeamento.
 * @param {number} q5 - Quantidade de 5mm a baixar
 * @param {number} q9 - Quantidade de 9mm a baixar
 * @param {number} q762 - Quantidade de 762mm a baixar
 * @param {number} q12 - Quantidade de 12cbc a baixar
 */
function baixarEstoquePorEncomenda(q5, q9, q762, q12) {
    return new Promise((resolve, reject) => {
        const updates = [];
        if (q5 > 0) updates.push({ nome: '5mm', quantidade: q5 });
        if (q9 > 0) updates.push({ nome: '9mm', quantidade: q9 });
        if (q762 > 0) updates.push({ nome: '762mm', quantidade: q762 });
        if (q12 > 0) updates.push({ nome: '12cbc', quantidade: q12 });
        if (updates.length === 0) {
            return resolve();
        }
        let remaining = updates.length;
        updates.forEach(item => {
            db.run('UPDATE estoque SET quantidade = quantidade - ? WHERE tipo = "municao" AND nome = ?', [item.quantidade, item.nome], function(err) {
                if (err) {
                    return reject(err);
                }
                remaining--;
                if (remaining === 0) {
                    resolve();
                }
            });
        });
    });
}

/**
 * Adiciona ao estoque de munições as quantidades especificadas de cada calibre.
 * Este método é utilizado quando uma encomenda deixa de reservar estoque (status pronto/entregue
 * para pendente/cancelado) ou quando suas quantidades diminuem. Retorna uma Promise.
 * @param {number} q5 - Quantidade de 5mm a devolver
 * @param {number} q9 - Quantidade de 9mm a devolver
 * @param {number} q762 - Quantidade de 762mm a devolver
 * @param {number} q12 - Quantidade de 12cbc a devolver
 */
function devolverEstoquePorEncomenda(q5, q9, q762, q12) {
    return new Promise((resolve, reject) => {
        const updates = [];
        if (q5 > 0) updates.push({ nome: '5mm', quantidade: q5 });
        if (q9 > 0) updates.push({ nome: '9mm', quantidade: q9 });
        if (q762 > 0) updates.push({ nome: '762mm', quantidade: q762 });
        if (q12 > 0) updates.push({ nome: '12cbc', quantidade: q12 });
        if (updates.length === 0) {
            return resolve();
        }
        let remaining = updates.length;
        updates.forEach(item => {
            db.run('UPDATE estoque SET quantidade = quantidade + ? WHERE tipo = "municao" AND nome = ?', [item.quantidade, item.nome], function(err) {
                if (err) {
                    return reject(err);
                }
                remaining--;
                if (remaining === 0) {
                    resolve();
                }
            });
        });
    });
}

/**
 * Verifica as encomendas pendentes e marca como prontas se houver estoque suficiente para
 * atendê-las. As encomendas são processadas em ordem de criação (mais antigas primeiro),
 * garantindo que o estoque seja reservado primeiramente para quem pediu antes. Quando
 * uma encomenda é marcada como pronta, as munições necessárias são imediatamente
 * baixadas do estoque via `baixarEstoquePorEncomenda` para evitar que outras encomendas
 * usem a mesma quantidade. Caso o estoque seja insuficiente para uma encomenda, a
 * verificação é interrompida e nenhuma encomenda posterior é analisada.
 *
 * Retorna uma Promise que resolve quando a verificação estiver concluída. Erros são
 * propagados via rejeição ou registrados no console.
 */
function verificarEncomendasProntas() {
    return new Promise((resolve, reject) => {
        // Recupera estoque atual de munições
        db.all('SELECT nome, quantidade FROM estoque WHERE tipo = "municao"', (errStock, estoqueRows) => {
            if (errStock) {
                console.error('Erro ao obter estoque para verificação de encomendas prontas:', errStock);
                return reject(errStock);
            }
            // Calcula quantidades de munições já reservadas por encomendas em status "pronto" (mas ainda não entregues).
            const estoqueDisponivel = {};
            estoqueRows.forEach(row => {
                estoqueDisponivel[row.nome] = row.quantidade;
            });
            // Soma reservas atuais (encomendas com status = 'pronto')
            db.all('SELECT municao_5mm, municao_9mm, municao_762mm, municao_12cbc FROM encomendas WHERE status = "pronto"', (errRes, reservas) => {
                if (errRes) {
                    console.error('Erro ao obter reservas de encomendas prontas:', errRes);
                    return reject(errRes);
                }
                let reservado5 = 0, reservado9 = 0, reservado762 = 0, reservado12 = 0;
                reservas.forEach(r => {
                    reservado5 += r.municao_5mm || 0;
                    reservado9 += r.municao_9mm || 0;
                    reservado762 += r.municao_762mm || 0;
                    reservado12 += r.municao_12cbc || 0;
                });
                estoqueDisponivel['5mm'] = (estoqueDisponivel['5mm'] || 0) - reservado5;
                estoqueDisponivel['9mm'] = (estoqueDisponivel['9mm'] || 0) - reservado9;
                estoqueDisponivel['762mm'] = (estoqueDisponivel['762mm'] || 0) - reservado762;
                estoqueDisponivel['12cbc'] = (estoqueDisponivel['12cbc'] || 0) - reservado12;

                // Recupera encomendas pendentes em ordem de criação
                db.all('SELECT * FROM encomendas WHERE status = "pendente" ORDER BY data_criacao ASC', async (errOrders, pendentes) => {
                    if (errOrders) {
                        console.error('Erro ao obter encomendas pendentes:', errOrders);
                        return reject(errOrders);
                    }
                    try {
                        for (const pedido of pendentes) {
                            const req5 = pedido.municao_5mm || 0;
                            const req9 = pedido.municao_9mm || 0;
                            const req762 = pedido.municao_762mm || 0;
                            const req12 = pedido.municao_12cbc || 0;
                            // Verifica disponibilidade considerando reservas
                            if ((estoqueDisponivel['5mm'] || 0) >= req5 &&
                                (estoqueDisponivel['9mm'] || 0) >= req9 &&
                                (estoqueDisponivel['762mm'] || 0) >= req762 &&
                                (estoqueDisponivel['12cbc'] || 0) >= req12) {
                                // Marca encomenda como pronta (não remove estoque fisicamente)
                                await new Promise((resUpd, rejUpd) => {
                                    db.run('UPDATE encomendas SET status = ? WHERE id = ?', ['pronto', pedido.id], function(errUpd) {
                                        if (errUpd) return rejUpd(errUpd);
                                        resUpd();
                                    });
                                });
                                // Atualiza estoque disponível em memória
                                estoqueDisponivel['5mm'] = (estoqueDisponivel['5mm'] || 0) - req5;
                                estoqueDisponivel['9mm'] = (estoqueDisponivel['9mm'] || 0) - req9;
                                estoqueDisponivel['762mm'] = (estoqueDisponivel['762mm'] || 0) - req762;
                                estoqueDisponivel['12cbc'] = (estoqueDisponivel['12cbc'] || 0) - req12;
                            } else {
                                // Parar se não houver estoque suficiente para esta encomenda
                                break;
                            }
                        }
                        resolve();
                    } catch (errLoop) {
                        console.error('Erro durante verificação de encomendas prontas:', errLoop);
                        reject(errLoop);
                    }
                });
            });
        });
    });
}

// Rotas de encomendas
app.get('/api/encomendas', (req, res) => {
    db.all('SELECT * FROM encomendas ORDER BY data_criacao DESC', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Inserir encomenda
// Para registrar qual usuário está criando a encomenda, esta rota utiliza o middleware de autenticação. O campo
// "usuario" pode ser enviado no corpo da requisição; se não estiver presente, utiliza o usuário autenticado.
app.post('/api/encomendas', authenticateToken, async (req, res) => {
    const {
        cliente,
        familia,
        telefone_cliente,
        municao_5mm,
        municao_9mm,
        municao_762mm,
        municao_12cbc,
        valor_total,
        comissao,
        status,
        usuario
    } = req.body;

    if (!cliente || !familia) {
        return res.status(400).json({ error: 'Cliente e família são obrigatórios' });
    }

    // Converte quantidades para números inteiros. Caso estejam indefinidas ou vazias, usa 0.
    const qtd5 = parseInt(municao_5mm) || 0;
    const qtd9 = parseInt(municao_9mm) || 0;
    const qtd762 = parseInt(municao_762mm) || 0;
    const qtd12 = parseInt(municao_12cbc) || 0;

    // Preços fixos das munições conforme especificação do sistema.
    const preco5 = 100;
    const preco9 = 125;
    const preco762 = 200;
    const preco12 = 200;

    // Calcula valor total
    const calcTotal = qtd5 * preco5 + qtd9 * preco9 + qtd762 * preco762 + qtd12 * preco12;
    // Obtém a taxa de comissão configurada dinamicamente. Em caso de erro,
    // utiliza a taxa padrão de 7%.
    let commissionRate = 0.07;
    try {
        commissionRate = await getCommissionRate();
    } catch (e) {
        console.error('Erro ao obter taxa de comissão:', e);
    }
    const calcComissao = calcTotal * commissionRate;

    // Usa os valores enviados se existirem; caso contrário, utiliza os valores calculados.
    const totalFinal = (valor_total !== undefined && valor_total !== null && valor_total !== '') ? parseFloat(valor_total) : calcTotal;
    const comissaoFinal = (comissao !== undefined && comissao !== null && comissao !== '') ? parseFloat(comissao) : calcComissao;
    // Determina o usuário responsável: prefere o campo enviado, senão usa o usuário autenticado
    const usuarioFinal = usuario || (req.user && req.user.username) || null;

    // Determina o status final da encomenda.  Membros e gerentes só podem
    // cadastrar encomendas como pendentes.  O campo status enviado pelo
    // frontend é ignorado para esses papéis.
    let statusFinal = 'pendente';
    const userRole = req.user && req.user.role;
    if (userRole === 'admin' || userRole === 'lider') {
        // Administradores e líderes podem definir outro status se informado,
        // caso contrário permanece pendente.
        statusFinal = (status !== undefined && status !== null && status !== '') ? status : 'pendente';
    }

    db.run(
        `INSERT INTO encomendas 
        (cliente, familia, telefone_cliente, municao_5mm, municao_9mm, municao_762mm, municao_12cbc, valor_total, comissao, status, usuario) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            cliente,
            familia,
            telefone_cliente || null,
            qtd5,
            qtd9,
            qtd762,
            qtd12,
            totalFinal,
            comissaoFinal,
            statusFinal,
            usuarioFinal
        ],
        function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            // Responde ao cliente imediatamente
            res.json({
                message: 'Encomenda cadastrada com sucesso',
                id: this.lastID
            });
            // Após cadastrar, verifica se há estoque suficiente para marcar encomendas como prontas
            verificarEncomendasProntas().catch(err => {
                console.error('Erro ao verificar encomendas prontas após cadastro:', err);
            });
        }
    );
});

// Atualiza uma encomenda existente. Recebe dados semelhantes ao cadastro
app.put('/api/encomendas/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const {
        cliente,
        familia,
        telefone_cliente,
        municao_5mm,
        municao_9mm,
        municao_762mm,
        municao_12cbc,
        valor_total,
        comissao,
        status,
        usuario
    } = req.body;

    if (!cliente || !familia) {
        return res.status(400).json({ error: 'Cliente e família são obrigatórios' });
    }
    // Converte quantidades para inteiros
    const qtd5 = parseInt(municao_5mm) || 0;
    const qtd9 = parseInt(municao_9mm) || 0;
    const qtd762 = parseInt(municao_762mm) || 0;
    const qtd12 = parseInt(municao_12cbc) || 0;
    // Preços fixos
    const preco5 = 100;
    const preco9 = 125;
    const preco762 = 200;
    const preco12 = 200;
    const calcTotal = qtd5 * preco5 + qtd9 * preco9 + qtd762 * preco762 + qtd12 * preco12;
    // Obtém taxa de comissão dinâmica. Em caso de erro, utiliza 7%.
    let commissionRateUpd = 0.07;
    try {
        commissionRateUpd = await getCommissionRate();
    } catch (e) {
        console.error('Erro ao obter taxa de comissão:', e);
    }
    const calcComissao = calcTotal * commissionRateUpd;
    const totalFinal = (valor_total !== undefined && valor_total !== null && valor_total !== '') ? parseFloat(valor_total) : calcTotal;
    const comissaoFinal = (comissao !== undefined && comissao !== null && comissao !== '') ? parseFloat(comissao) : calcComissao;
    const newStatus = status || 'pendente';
    const usuarioFinal = usuario || (req.user && req.user.username) || null;

    // Verifica se o usuário tem permissão para realizar alterações na encomenda.
    // Somente administradores ou líderes podem editar encomendas. Membros e gerentes
    // estão autorizados apenas a cadastrar novas encomendas.
    const userRole = req.user && req.user.role;
    if (userRole !== 'admin' && userRole !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    // Verifica se o usuário tem permissão para atualizar para status cancelado
    if (newStatus === 'cancelado') {
        if (userRole !== 'admin' && userRole !== 'lider') {
            return res.status(403).json({ error: 'Apenas líderes podem cancelar encomendas' });
        }
    }

    // Função auxiliar para enviar uma resposta e, em seguida, disparar a verificação
    // de encomendas prontas. Isso garante que, ao alterar o status de uma encomenda,
    // o sistema reavalie se outras pendentes podem ser marcadas como prontas com
    // base no estoque atualizado.
    function sendAndVerify(payload) {
        res.json(payload);
        verificarEncomendasProntas().catch(err => {
            console.error('Erro ao verificar encomendas prontas após atualização de encomenda:', err);
        });
    }

    // Obtém status e quantidades atuais da encomenda
    db.get('SELECT status, municao_5mm, municao_9mm, municao_762mm, municao_12cbc FROM encomendas WHERE id = ?', [id], (errSelect, row) => {
        if (errSelect) {
            return res.status(500).json({ error: errSelect.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Encomenda não encontrada' });
        }
        const oldStatus = row.status;
        const old5 = row.municao_5mm || 0;
        const old9 = row.municao_9mm || 0;
        const old762 = row.municao_762mm || 0;
        const old12 = row.municao_12cbc || 0;

        // Categorias de status que impactam o estoque: apenas "entregue".  A partir de agora,
        // encomendas com status "pronto" não reduzem o estoque imediatamente; a baixa
        // ocorre somente quando a encomenda é marcada como entregue.
        const impactStatuses = ['entregue'];

        // Função auxiliar para ajustar estoque após atualização
        function afterUpdate() {
            // Determina se precisa devolver ou baixar estoque baseado nos status
            const oldInImpact = impactStatuses.includes(oldStatus);
            const newInImpact = impactStatuses.includes(newStatus);
            // Caso saindo de status que reservava estoque
            if (oldInImpact && !newInImpact) {
                // Devolve as quantidades antigas ao estoque e responde
                devolverEstoquePorEncomenda(old5, old9, old762, old12)
                    .then(() => sendAndVerify({ message: 'Encomenda atualizada com sucesso' }))
                    .catch(err => {
                        console.error('Erro ao devolver estoque:', err);
                        sendAndVerify({ message: 'Encomenda atualizada com sucesso (erro ao devolver estoque)' });
                    });
                return;
            }
            // Caso entrando em status que reserva estoque
            if (!oldInImpact && newInImpact) {
                // Baixa as quantidades novas do estoque e responde
                baixarEstoquePorEncomenda(qtd5, qtd9, qtd762, qtd12)
                    .then(() => sendAndVerify({ message: 'Encomenda atualizada com sucesso' }))
                    .catch(err => {
                        console.error('Erro ao baixar estoque:', err);
                        sendAndVerify({ message: 'Encomenda atualizada com sucesso (erro ao atualizar estoque)' });
                    });
                return;
            }
            // Caso mantenha status de impacto, ajustar diferenças nas quantidades
            if (oldInImpact && newInImpact) {
                const diff5 = qtd5 - old5;
                const diff9 = qtd9 - old9;
                const diff762 = qtd762 - old762;
                const diff12 = qtd12 - old12;
                // Ajusta apenas se houver diferença
                const ajustes = [];
                if (diff5 !== 0 || diff9 !== 0 || diff762 !== 0 || diff12 !== 0) {
                    const promises = [];
                    if (diff5 > 0) promises.push(baixarEstoquePorEncomenda(diff5, 0, 0, 0));
                    if (diff5 < 0) promises.push(devolverEstoquePorEncomenda(-diff5, 0, 0, 0));
                    if (diff9 > 0) promises.push(baixarEstoquePorEncomenda(0, diff9, 0, 0));
                    if (diff9 < 0) promises.push(devolverEstoquePorEncomenda(0, -diff9, 0, 0));
                    if (diff762 > 0) promises.push(baixarEstoquePorEncomenda(0, 0, diff762, 0));
                    if (diff762 < 0) promises.push(devolverEstoquePorEncomenda(0, 0, -diff762, 0));
                    if (diff12 > 0) promises.push(baixarEstoquePorEncomenda(0, 0, 0, diff12));
                    if (diff12 < 0) promises.push(devolverEstoquePorEncomenda(0, 0, 0, -diff12));
                    Promise.all(promises)
                        .then(() => sendAndVerify({ message: 'Encomenda atualizada com sucesso' }))
                        .catch(err => {
                            console.error('Erro ao ajustar estoque:', err);
                            sendAndVerify({ message: 'Encomenda atualizada com sucesso (erro ao ajustar estoque)' });
                        });
                } else {
                    sendAndVerify({ message: 'Encomenda atualizada com sucesso' });
                }
                return;
            }
            // Se ambos não impactam, apenas retorna sucesso
            sendAndVerify({ message: 'Encomenda atualizada com sucesso' });
        }

        // Atualiza a encomenda com novos valores
        db.run(
            `UPDATE encomendas SET cliente = ?, familia = ?, telefone_cliente = ?, municao_5mm = ?, municao_9mm = ?, municao_762mm = ?, municao_12cbc = ?, valor_total = ?, comissao = ?, status = ?, usuario = ? WHERE id = ?`,
            [cliente, familia, telefone_cliente || null, qtd5, qtd9, qtd762, qtd12, totalFinal, comissaoFinal, newStatus, usuarioFinal, id],
            function (errUpdate) {
                if (errUpdate) {
                    return res.status(500).json({ error: errUpdate.message });
                }
                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Encomenda não encontrada' });
                }
                // Após atualizar, ajusta estoque de acordo com mudanças de status ou quantidades
                afterUpdate();
            }
        );
    });
});

// Excluir uma encomenda. Apenas administradores ou líderes podem remover encomendas.
app.delete('/api/encomendas/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const role = req.user && req.user.role;
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    db.run('DELETE FROM encomendas WHERE id = ?', [id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: 'Encomenda removida com sucesso' });
    });
});

// Rotas de estoque
app.get('/api/estoque', (req, res) => {
    db.all('SELECT * FROM estoque ORDER BY tipo, nome', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Atualizar estoque adicionando materiais ou munições. Disponível apenas para administradores ou líderes.
// Atualiza um item específico do estoque (quantidade). Apenas administradores, gerentes ou líderes podem editar o valor
app.put('/api/estoque/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { quantidade } = req.body;
    // Verifica permissões
    const role = req.user && req.user.role;
    // Apenas administradores ou líderes podem editar itens do estoque
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    const qtd = parseFloat(quantidade);
    if (isNaN(qtd) || qtd < 0) {
        return res.status(400).json({ error: 'Quantidade inválida' });
    }
    // Atualiza a quantidade do item
    db.run('UPDATE estoque SET quantidade = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?', [qtd, id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Item de estoque não encontrado' });
        }
        // Envia resposta ao cliente e verifica se encomendas pendentes podem ser prontas
        res.json({ message: 'Item de estoque atualizado com sucesso' });
        verificarEncomendasProntas().catch(err => {
            console.error('Erro ao verificar encomendas prontas após atualização de item de estoque:', err);
        });
    });
});

// Atualizar estoque adicionando materiais ou munições. Disponível apenas para administradores ou líderes.
app.post('/api/estoque', authenticateToken, (req, res) => {
    const { tipo, item, quantidade, baixarMateriais } = req.body;

    // Validação simples
    if (!tipo || !item || !quantidade) {
        return res.status(400).json({ error: 'Tipo, item e quantidade são obrigatórios' });
    }

    const role = req.user && req.user.role;
    // Apenas administradores ou líderes podem alterar o estoque (adicionar materiais/munições)
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }

    const qtd = parseFloat(quantidade);
    if (isNaN(qtd) || qtd <= 0) {
        return res.status(400).json({ error: 'Quantidade inválida' });
    }

    // Inserir ou atualizar materiais
    if (tipo === 'material') {
        // Adiciona a quantidade ao material especificado
        db.run('UPDATE estoque SET quantidade = quantidade + ? WHERE tipo = ? AND nome = ?',
            [qtd, 'material', item], function (err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                // Se nenhuma linha foi atualizada, retorna erro
                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Material não encontrado' });
                }
                // Responde ao cliente e executa verificação de encomendas prontas
                res.json({ message: 'Estoque de material atualizado com sucesso' });
                verificarEncomendasProntas().catch(err => {
                    console.error('Erro ao verificar encomendas prontas após atualização de material:', err);
                });
            });
        return;
    }

    if (tipo === 'municao') {
        // Atualiza a quantidade de munições
        db.run('UPDATE estoque SET quantidade = quantidade + ? WHERE tipo = ? AND nome = ?',
            [qtd, 'municao', item], function (err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Tipo de munição não encontrado' });
                }
                // Se for solicitado baixar materiais, calcula consumo de matérias-primas
                if (baixarMateriais && String(baixarMateriais).toLowerCase() === 'sim') {
                    // Cada 200 munições utilizam 55 unidades de quatro materiais e 2 unidades de titânio.
                    // Portanto, a quantidade consumida por munição é 55/200 para os quatro materiais
                    // e 2/200 para titânio.
                    const consumPerBullet = 55 / 200.0;
                    const consumTitanio = 2 / 200.0;
                    const totalMaterial = consumPerBullet * qtd;
                    const totalTitanio = consumTitanio * qtd;
                    const materiaisParaBaixar = [
                        { nome: 'Alumínio', quantidade: totalMaterial },
                        { nome: 'Cobre', quantidade: totalMaterial },
                        { nome: 'Emb Plástica', quantidade: totalMaterial },
                        { nome: 'Ferro', quantidade: totalMaterial },
                        { nome: 'Titânio', quantidade: totalTitanio }
                    ];
                    // Antes de subtrair, verifica se há material suficiente
                    db.all('SELECT nome, quantidade FROM estoque WHERE tipo = "material"', (errMat, rows) => {
                        if (errMat) {
                            console.error('Erro ao consultar materiais:', errMat.message);
                            // Continua a operação, mas não baixa materiais
                            finalizeUpdate();
                            return;
                        }
                        const faltantes = [];
                        materiaisParaBaixar.forEach(mat => {
                            const row = rows.find(r => r.nome === mat.nome);
                            if (!row || row.quantidade < mat.quantidade) {
                                faltantes.push(mat.nome);
                            }
                        });
                        if (faltantes.length > 0) {
                            // Reverte a soma de munições já realizada
                            db.run('UPDATE estoque SET quantidade = quantidade - ? WHERE tipo = "municao" AND nome = ?', [qtd, item], (rollbackErr) => {
                                if (rollbackErr) {
                                    console.error('Erro ao reverter atualização de munições:', rollbackErr.message);
                                }
                                return res.status(400).json({ error: 'Estoque insuficiente para os materiais: ' + faltantes.join(', ') });
                            });
                        } else {
                            // Subtrai quantidades dos materiais
                            let pending = materiaisParaBaixar.length;
                            materiaisParaBaixar.forEach(mat => {
                                db.run('UPDATE estoque SET quantidade = quantidade - ? WHERE tipo = "material" AND nome = ?',
                                    [mat.quantidade, mat.nome], function (err) {
                                        if (err) {
                                            console.error('Erro ao atualizar material', mat.nome, err.message);
                                        }
                                        pending--;
                                        if (pending === 0) {
                                            // Todos materiais atualizados
                                            finalizeUpdate();
                                        }
                                    }
                                );
                            });
                        }
                    });
                } else {
                    // Não baixar materiais
                    finalizeUpdate();
                }

                function finalizeUpdate() {
                    // Envia a resposta ao cliente
                    res.json({ message: 'Estoque de munição atualizado com sucesso' });
                    // Após atualizar o estoque, verifica se encomendas pendentes podem ser marcadas como prontas
                    verificarEncomendasProntas().catch(err => {
                        console.error('Erro ao verificar encomendas prontas após atualização de munições:', err);
                    });
                    return;
                }
            });
        return;
    }

    // Tipo desconhecido
    return res.status(400).json({ error: 'Tipo de item inválido' });
});

// Endpoint para retirar itens do estoque. Destinado a correções de lançamentos errados. Somente administradores
// ou líderes podem realizar retiradas.
app.post('/api/estoque/retirar', authenticateToken, (req, res) => {
    const { tipo, item, quantidade } = req.body;
    // Verifica permissões
    const role = req.user && req.user.role;
    // Apenas administradores ou líderes podem retirar itens do estoque
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    if (!tipo || !item || !quantidade) {
        return res.status(400).json({ error: 'Tipo, item e quantidade são obrigatórios' });
    }
    const qtd = parseFloat(quantidade);
    if (isNaN(qtd) || qtd <= 0) {
        return res.status(400).json({ error: 'Quantidade inválida' });
    }
    // Atualiza o estoque subtraindo a quantidade informada
    db.run('UPDATE estoque SET quantidade = quantidade - ? WHERE tipo = ? AND nome = ?', [qtd, tipo, item], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Item de estoque não encontrado' });
        }
        res.json({ message: 'Retirada realizada com sucesso' });
    });
});

// Endpoint para saída avulsa de estoque, para destinar materiais ou munições a membros. Apenas líderes podem realizar.
app.post('/api/estoque/saida-avulsa', authenticateToken, (req, res) => {
    const { tipo, item, quantidade, destinos } = req.body;
    const role = req.user && req.user.role;
    if (role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    if (!tipo || !item || !quantidade || !destinos) {
        return res.status(400).json({ error: 'Tipo, item, quantidade e destinos são obrigatórios' });
    }
    const qtd = parseFloat(quantidade);
    if (isNaN(qtd) || qtd <= 0) {
        return res.status(400).json({ error: 'Quantidade inválida' });
    }
    // Normaliza destinos: pode vir como array ou string
    let destinosArray = [];
    if (Array.isArray(destinos)) {
        destinosArray = destinos;
    } else if (typeof destinos === 'string') {
        destinosArray = destinos.split(',').map(s => s.trim()).filter(Boolean);
    }
    // Verificar estoque disponível
    db.get('SELECT quantidade FROM estoque WHERE tipo = ? AND nome = ?', [tipo, item], (errSel, rowSel) => {
        if (errSel) {
            return res.status(500).json({ error: errSel.message });
        }
        if (!rowSel || rowSel.quantidade < qtd) {
            return res.status(400).json({ error: 'Estoque insuficiente para realizar a saída' });
        }
        // Atualiza estoque subtraindo a quantidade
        db.run('UPDATE estoque SET quantidade = quantidade - ? WHERE tipo = ? AND nome = ?', [qtd, tipo, item], function (errUp) {
            if (errUp) {
                return res.status(500).json({ error: errUp.message });
            }
            // Registra saída avulsa
            db.run('INSERT INTO saidas_avulsas (tipo, item, quantidade, retirado_por, destinos) VALUES (?, ?, ?, ?, ?)',
                [tipo, item, qtd, req.user.username || '', destinosArray.join(',')], function (errIns) {
                    if (errIns) {
                        return res.status(500).json({ error: errIns.message });
                    }
                    res.json({ message: 'Saída avulsa registrada com sucesso' });
                });
        });
    });
});

// === Configurações do sistema ===
// Retorna a taxa de comissão atual
app.get('/api/config/commission-rate', (req, res) => {
    db.get('SELECT value FROM config WHERE key = ?', ['commission_rate'], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        const rate = row ? parseFloat(row.value) : 0.07;
        res.json({ rate });
    });
});

// Atualiza a taxa de comissão. Somente administradores ou líderes podem definir o percentual.
app.put('/api/config/commission-rate', authenticateToken, (req, res) => {
    const role = req.user && req.user.role;
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    const { rate } = req.body;
    const valor = parseFloat(rate);
    if (isNaN(valor) || valor < 0 || valor > 1) {
        return res.status(400).json({ error: 'Taxa inválida. Forneça um número entre 0 e 1.' });
    }
    db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['commission_rate', String(valor)], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: 'Taxa de comissão atualizada com sucesso', rate: valor });
    });
});

// Permite fabricar munições em lotes. Rota protegida: apenas administradores ou líderes.
app.post('/api/estoque/fabricar', authenticateToken, (req, res) => {
    const { tipo_municao, lotes } = req.body;

    if (!tipo_municao || !lotes) {
        return res.status(400).json({ error: 'Tipo de munição e quantidade de lotes são obrigatórios' });
    }

    // Verifica permissão do usuário
    const role = req.user && req.user.role;
    // Apenas administradores ou líderes podem fabricar munições
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }

    const quantidade = parseFloat(lotes) * 200; // 1 lote = 200 munições
    if (isNaN(quantidade) || quantidade <= 0) {
        return res.status(400).json({ error: 'Quantidade de lotes inválida' });
    }

    // Atualizar estoque de munições
    db.run('UPDATE estoque SET quantidade = quantidade + ? WHERE tipo = "municao" AND nome = ?',
        [quantidade, tipo_municao], function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            // Se nenhuma linha foi atualizada, o tipo de munição não existe
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Tipo de munição não encontrado' });
            }
            res.json({
                message: `${quantidade} munições ${tipo_municao} fabricadas com sucesso`
            });
        });
});

// Rotas de imagens
app.get('/api/imagens', (req, res) => {
    db.all('SELECT * FROM imagens ORDER BY data_upload DESC', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Listar usuários (somente id, username e role). Útil para preencher selects de responsável por encomendas.
app.get('/api/usuarios', (req, res) => {
    db.all('SELECT id, username, role FROM usuarios ORDER BY username', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        // Não retornamos senha nem dados sensíveis
        res.json(rows);
    });
});

// Lista usuários pendentes de aprovação (ativo = 0).
// Requer autenticação e cargos de liderança (admin, gerente ou lider).
app.get('/api/usuarios/pendentes', authenticateToken, (req, res) => {
    const role = req.user && req.user.role;
    // Apenas administradores ou líderes podem acessar usuários pendentes para aprovação
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    // Busca usuários com ativo = 0 e tenta unir com membros através da coluna usuario_id
    const query = `
        SELECT u.id AS user_id, u.username, u.role, u.data_criacao AS user_data_criacao,
               m.id AS membro_id, m.nome, m.rg, m.telefone, m.cargo, m.data_criacao AS membro_data_criacao
        FROM usuarios u
        LEFT JOIN membros m ON m.usuario_id = u.id
        WHERE u.ativo = 0
        ORDER BY u.data_criacao ASC
    `;
    db.all(query, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Ativar um usuário pendente e, opcionalmente, atualizar seu cargo/role.
// Recebe no body { role, cargo } para definir o papel do usuário e o cargo no membro.
app.put('/api/usuarios/:id/ativar', authenticateToken, (req, res) => {
    const roleAtual = req.user && req.user.role;
    // Apenas administradores ou líderes podem ativar usuários pendentes
    if (roleAtual !== 'admin' && roleAtual !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    const userId = req.params.id;
    const { role, cargo } = req.body;
    // Verifica se o usuário existe e está pendente
    db.get('SELECT * FROM usuarios WHERE id = ?', [userId], (err, usuario) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!usuario) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }
        if (usuario.ativo) {
            return res.status(400).json({ error: 'Usuário já está ativo' });
        }
        // Define novo role ou mantém 'membro' se não enviado
        const novoRole = role || usuario.role || 'membro';
        const novoCargo = cargo || 'membro';
        // Atualiza usuário para ativo e role
        db.run('UPDATE usuarios SET ativo = 1, role = ? WHERE id = ?', [novoRole, userId], function(err2) {
            if (err2) {
                return res.status(500).json({ error: err2.message });
            }
            // Atualiza membro associado via usuario_id
            db.run('UPDATE membros SET ativo = 1, cargo = ? WHERE usuario_id = ?', [novoCargo, userId], function(err3) {
                if (err3) {
                    return res.status(500).json({ error: err3.message });
                }
                res.json({ message: 'Usuário ativado com sucesso' });
            });
        });
    });
});

// Rotas de famílias
// Listar famílias
app.get('/api/familias', (req, res) => {
    db.all('SELECT * FROM familias ORDER BY nome', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Cadastrar família (apenas para gerentes/admin)
app.post('/api/familias', authenticateToken, (req, res) => {
    const { nome } = req.body;

    if (!nome) {
        return res.status(400).json({ error: 'Nome da família é obrigatório' });
    }

    // Verifica se o usuário possui permissões para cadastrar família.
    // Membros, gerentes, líderes e administradores podem criar novas famílias.  
    // Não há permissão de edição ou exclusão para membros/gerentes posteriormente.  
    const role = req.user && req.user.role;
    if (!['admin', 'gerente', 'lider', 'membro'].includes(role)) {
        return res.status(403).json({ error: 'Acesso negado' });
    }

    db.run('INSERT INTO familias (nome) VALUES (?)', [nome], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE')) {
                return res.status(400).json({ error: 'Família já cadastrada' });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({ id: this.lastID, nome });
    });
});

// ===========================================================================
// Rotas para Inventário da Família e Requisições
// ===========================================================================

/**
 * Obtém todos os itens do inventário da família. Qualquer usuário logado pode
 * consultar esta rota. Os itens são retornados como um array de objetos com
 * campos: id, categoria, subcategoria, quantidade e preco.
 */
app.get('/api/inventario-familia', authenticateToken, (req, res) => {
    // Lista todos os itens do inventário, ordenados por categoria e item. Não
    // existe mais o campo subcategoria.
    // Seleciona id, categoria, item (preferencialmente coluna item; se nula, usa subcategoria), quantidade e preco.
    db.all('SELECT id, categoria, COALESCE(item, subcategoria) AS item, quantidade, preco, data_atualizacao FROM inventario_familia ORDER BY categoria, item', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

/**
 * Obtém o histórico de alterações do inventário da família. Apenas administradores
 * ou líderes podem consultar esta rota. Retorna as alterações ordenadas por data
 * mais recente primeiro.
 */
app.get('/api/inventario-familia/historico', authenticateToken, (req, res) => {
    const role = req.user && req.user.role;
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    const sql = `
        SELECT h.*, i.categoria, COALESCE(i.item, i.subcategoria) AS item
        FROM historico_inventario_familia h
        JOIN inventario_familia i ON i.id = h.item_id
        ORDER BY h.data_alteracao DESC
        LIMIT 100
    `;
    db.all(sql, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

/**
 * Cria um novo item no inventário da família ou atualiza a quantidade de um
 * item existente. Apenas administradores ou líderes podem adicionar ou
 * modificar itens no inventário da família. O corpo da requisição deve
 * conter: categoria, subcategoria, quantidade, motivo e opcionalmente preco. Se
 * houver um item já cadastrado com a mesma combinação de categoria e
 * subcategoria, a quantidade será incrementada; caso contrário, o item será
 * criado. Retorna os dados do item inserido/atualizado.
 */
app.post('/api/inventario-familia', authenticateToken, (req, res) => {
    const role = req.user && req.user.role;
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    const { categoria, item, quantidade, preco, motivo } = req.body;
    const qtd = parseInt(quantidade);
    const price = preco !== undefined && preco !== null ? parseFloat(preco) : null;
    if (!categoria || !item || isNaN(qtd) || qtd < 0) {
        return res.status(400).json({ error: 'Categoria, item e quantidade válidas são obrigatórias' });
    }
    if (!motivo || motivo.trim() === '') {
        return res.status(400).json({ error: 'Motivo da alteração é obrigatório' });
    }
    // Tenta atualizar um item existente; se nenhum item for atualizado,
    // insere um novo registro.
    db.get('SELECT * FROM inventario_familia WHERE categoria = ? AND (item = ? OR subcategoria = ?)', [categoria, item, item], (err, existing) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (existing) {
            const quantidadeAnterior = existing.quantidade;
            const newQty = existing.quantidade + qtd;
            const newPrice = price !== null ? price : existing.preco;
            db.run('UPDATE inventario_familia SET quantidade = ?, preco = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?', [newQty, newPrice, existing.id], function (updateErr) {
                if (updateErr) {
                    return res.status(500).json({ error: updateErr.message });
                }
                // Registra no histórico de alterações
                db.run('INSERT INTO historico_inventario_familia (item_id, usuario_id, usuario_nome, quantidade_anterior, quantidade_nova, motivo) VALUES (?, ?, ?, ?, ?, ?)', 
                    [existing.id, req.user.id, req.user.username, quantidadeAnterior, newQty, motivo.trim()], function(histErr) {
                    if (histErr) {
                        console.error('Erro ao registrar histórico:', histErr.message);
                    }
                });
                db.get('SELECT * FROM inventario_familia WHERE id = ?', [existing.id], (selErr, updated) => {
                    if (selErr) {
                        return res.status(500).json({ error: selErr.message });
                    }
                    return res.json(updated);
                });
            });
        } else {
            const insertPrice = price !== null ? price : 0;
            // Insere item preenchendo tanto a coluna item quanto a subcategoria, para garantir
            // compatibilidade com esquemas antigos.
            db.run('INSERT INTO inventario_familia (categoria, item, subcategoria, quantidade, preco) VALUES (?, ?, ?, ?, ?)', [categoria, item, item, qtd, insertPrice], function (insertErr) {
                if (insertErr) {
                    return res.status(500).json({ error: insertErr.message });
                }
                // Registra no histórico de alterações (novo item)
                db.run('INSERT INTO historico_inventario_familia (item_id, usuario_id, usuario_nome, quantidade_anterior, quantidade_nova, motivo) VALUES (?, ?, ?, ?, ?, ?)', 
                    [this.lastID, req.user.id, req.user.username, 0, qtd, motivo.trim()], function(histErr) {
                    if (histErr) {
                        console.error('Erro ao registrar histórico:', histErr.message);
                    }
                });
                db.get('SELECT * FROM inventario_familia WHERE id = ?', [this.lastID], (selErr, newItem) => {
                    if (selErr) {
                        return res.status(500).json({ error: selErr.message });
                    }
                    res.json(newItem);
                });
            });
        }
    });
});

/**
 * Atualiza a quantidade e/ou o preço de um item existente no inventário da
 * família. Apenas administradores ou líderes podem realizar esta operação.
 * A rota aceita campos opcionais `quantidade`, `preco` e obrigatório `motivo`; se um dos campos
 * não for fornecido, permanece inalterado. O status atual do item é
 * retornado após a atualização.
 */
app.put('/api/inventario-familia/:id', authenticateToken, (req, res) => {
    const role = req.user && req.user.role;
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    const id = parseInt(req.params.id);
    const qtd = req.body.quantidade !== undefined ? parseInt(req.body.quantidade) : null;
    const price = req.body.preco !== undefined ? parseFloat(req.body.preco) : null;
    const motivo = req.body.motivo;
    if (isNaN(id)) {
        return res.status(400).json({ error: 'ID inválido' });
    }
    if (!motivo || motivo.trim() === '') {
        return res.status(400).json({ error: 'Motivo da alteração é obrigatório' });
    }
    // Verifica se o item existe
    db.get('SELECT * FROM inventario_familia WHERE id = ?', [id], (err, existing) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!existing) {
            return res.status(404).json({ error: 'Item não encontrado' });
        }
        const quantidadeAnterior = existing.quantidade;
        const newQty = qtd !== null ? qtd : existing.quantidade;
        const newPrice = price !== null ? price : existing.preco;
        db.run('UPDATE inventario_familia SET quantidade = ?, preco = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?', [newQty, newPrice, id], function (updateErr) {
            if (updateErr) {
                return res.status(500).json({ error: updateErr.message });
            }
            // Registra no histórico apenas se a quantidade foi alterada
            if (quantidadeAnterior !== newQty) {
                db.run('INSERT INTO historico_inventario_familia (item_id, usuario_id, usuario_nome, quantidade_anterior, quantidade_nova, motivo) VALUES (?, ?, ?, ?, ?, ?)', 
                    [id, req.user.id, req.user.username, quantidadeAnterior, newQty, motivo.trim()], function(histErr) {
                    if (histErr) {
                        console.error('Erro ao registrar histórico:', histErr.message);
                    }
                });
            }
            db.get('SELECT * FROM inventario_familia WHERE id = ?', [id], (selErr, updated) => {
                if (selErr) {
                    return res.status(500).json({ error: selErr.message });
                }
                res.json(updated);
            });
        });
    });
});

/**
 * Cria uma requisição de item do inventário da família. Apenas membros ou
 * gerentes podem criar requisições; líderes e administradores não devem
 * solicitar itens desta forma. O corpo da requisição deve conter
 * `item_id` e `quantidade`. O servidor registra informações do
 * solicitante (nome, cargo, RG e telefone) a partir da tabela de membros
 * associada ao usuário logado. Se o usuário não tiver um cadastro de
 * membro, os campos de contato devem ser fornecidos manualmente.
 */
app.post('/api/requisicoes-familia', authenticateToken, (req, res) => {
    const { item_id, quantidade, solicitante_nome, solicitante_cargo, solicitante_rg, solicitante_telefone } = req.body;
    const qty = parseInt(quantidade);
    if (isNaN(item_id) || isNaN(qty) || qty <= 0) {
        return res.status(400).json({ error: 'Item e quantidade válidos são obrigatórios' });
    }
    // Todos os usuários podem criar requisições
    const role = req.user && req.user.role;
    // Verifica se o item existe no inventário
    db.get('SELECT * FROM inventario_familia WHERE id = ?', [item_id], (err, item) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!item) {
            return res.status(404).json({ error: 'Item não encontrado no inventário da família' });
        }
        // Buscar informações do membro associado ao usuário (se existir)
        db.get('SELECT id, nome, rg, telefone, cargo FROM membros WHERE usuario_id = ?', [req.user.id], (memberErr, member) => {
            if (memberErr) {
                return res.status(500).json({ error: memberErr.message });
            }
            // Inicializa os dados do solicitante com os valores enviados no corpo
            // da requisição. Esses campos podem ser enviados quando o usuário
            // não possui um cadastro na tabela membros (por exemplo, se for um
            // gerente sem vínculo a um membro). Mais abaixo, caso seja
            // encontrado um membro associado ao usuário logado, esses valores
            // serão sobrescritos pelos dados do membro.
            let nomeSolicitante = solicitante_nome;
            let cargoSolicitante = solicitante_cargo;
            let rgSolicitante = solicitante_rg;
            let telefoneSolicitante = solicitante_telefone;
            let membroId = null;
            if (member) {
                // Se o usuário possuir cadastro de membro, utiliza essas
                // informações como dados do solicitante.
                nomeSolicitante = member.nome;
                cargoSolicitante = member.cargo;
                rgSolicitante = member.rg;
                telefoneSolicitante = member.telefone;
                membroId = member.id;
            } else {
                // Caso contrário, garante que nome e cargo estejam pelo menos
                // definidos. Se o front-end não enviar esses campos, usa o
                // username e o papel do usuário logado como fallback. Os
                // campos de RG e telefone permanecem vazios se não
                // fornecidos.
                if (!nomeSolicitante) nomeSolicitante = req.user.username;
                if (!cargoSolicitante) cargoSolicitante = req.user.role;
                if (!rgSolicitante) rgSolicitante = '';
                if (!telefoneSolicitante) telefoneSolicitante = '';
            }
            db.run(`INSERT INTO requisicoes_familia (item_id, membro_id, solicitante_nome, solicitante_cargo, solicitante_rg, solicitante_telefone, quantidade, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'pendente')`,
                [item_id, membroId, nomeSolicitante, cargoSolicitante, rgSolicitante, telefoneSolicitante, qty], function (insertErr) {
                    if (insertErr) {
                        return res.status(500).json({ error: insertErr.message });
                    }
                    db.get(`SELECT r.*, i.categoria, COALESCE(i.item, i.subcategoria) AS item
                            FROM requisicoes_familia r
                            JOIN inventario_familia i ON i.id = r.item_id
                            WHERE r.id = ?`, [this.lastID], (selErr, reqRow) => {
                        if (selErr) {
                            return res.status(500).json({ error: selErr.message });
                        }
                        res.json(reqRow);
                    });
                }
            );
        });
    });
});

/**
 * Lista as requisições de itens do inventário da família. Líderes e
 * administradores veem todas as requisições. Membros e gerentes veem
 * apenas as requisições que eles próprios criaram. Cada linha da
 * requisição inclui informações sobre o item, o solicitante e o líder
 * responsável (se houver).
 */
app.get('/api/requisicoes-familia', authenticateToken, (req, res) => {
    const role = req.user && req.user.role;
    // Monta a consulta base com join para trazer categoria e subcategoria
    let sql = `SELECT r.*, i.categoria, COALESCE(i.item, i.subcategoria) AS item, u.username AS lider_username
               FROM requisicoes_familia r
               JOIN inventario_familia i ON i.id = r.item_id
               LEFT JOIN usuarios u ON u.id = r.lider_id`;
    let params = [];
    if (role !== 'admin' && role !== 'lider') {
        // Restringe a requisições do próprio membro se não for líder/administrador
        sql += ' WHERE r.membro_id = (SELECT id FROM membros WHERE usuario_id = ?)';
        params.push(req.user.id);
    }
    db.all(sql, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

/**
 * Aprova uma requisição de item. Apenas líderes ou administradores podem
 * aprovar uma requisição. Esta ação não altera o estoque até que a
 * requisição seja marcada como entregue. É registrado o id do líder que
 * aprovou e a data de resposta.
 */
app.put('/api/requisicoes-familia/:id/aprovar', authenticateToken, (req, res) => {
    const role = req.user && req.user.role;
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
        return res.status(400).json({ error: 'ID inválido' });
    }
    // Carrega a requisição
    db.get('SELECT * FROM requisicoes_familia WHERE id = ?', [id], (err, reqRow) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!reqRow) {
            return res.status(404).json({ error: 'Requisição não encontrada' });
        }
        if (reqRow.status !== 'pendente') {
            return res.status(400).json({ error: 'Apenas requisições pendentes podem ser aprovadas' });
        }
        db.run('UPDATE requisicoes_familia SET status = ?, lider_id = ?, data_resposta = CURRENT_TIMESTAMP WHERE id = ?', ['aprovado', req.user.id, id], function (updateErr) {
            if (updateErr) {
                return res.status(500).json({ error: updateErr.message });
            }
            db.get(`SELECT r.*, i.categoria, COALESCE(i.item, i.subcategoria) AS item, u.username AS lider_username
                    FROM requisicoes_familia r
                    JOIN inventario_familia i ON i.id = r.item_id
                    LEFT JOIN usuarios u ON u.id = r.lider_id
                    WHERE r.id = ?`, [id], (selErr, updated) => {
                if (selErr) {
                    return res.status(500).json({ error: selErr.message });
                }
                res.json(updated);
            });
        });
    });
});

/**
 * Rejeita uma requisição de item. Apenas líderes ou administradores podem
 * rejeitar uma requisição. O status passa para "rejeitado" e registra
 * quem rejeitou e quando.
 */
app.put('/api/requisicoes-familia/:id/rejeitar', authenticateToken, (req, res) => {
    const role = req.user && req.user.role;
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
        return res.status(400).json({ error: 'ID inválido' });
    }
    db.get('SELECT * FROM requisicoes_familia WHERE id = ?', [id], (err, reqRow) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!reqRow) {
            return res.status(404).json({ error: 'Requisição não encontrada' });
        }
        if (reqRow.status !== 'pendente') {
            return res.status(400).json({ error: 'Apenas requisições pendentes podem ser rejeitadas' });
        }
        db.run('UPDATE requisicoes_familia SET status = ?, lider_id = ?, data_resposta = CURRENT_TIMESTAMP WHERE id = ?', ['rejeitado', req.user.id, id], function (updateErr) {
            if (updateErr) {
                return res.status(500).json({ error: updateErr.message });
            }
            db.get(`SELECT r.*, i.categoria, COALESCE(i.item, i.subcategoria) AS item, u.username AS lider_username
                    FROM requisicoes_familia r
                    JOIN inventario_familia i ON i.id = r.item_id
                    LEFT JOIN usuarios u ON u.id = r.lider_id
                    WHERE r.id = ?`, [id], (selErr, updated) => {
                if (selErr) {
                    return res.status(500).json({ error: selErr.message });
                }
                res.json(updated);
            });
        });
    });
});

/**
 * Marca uma requisição aprovada como entregue. Apenas líderes ou
 * administradores podem marcar a entrega. Quando uma requisição é
 * entregue, a quantidade solicitada é baixada do inventário da família.
 */
app.put('/api/requisicoes-familia/:id/entregar', authenticateToken, (req, res) => {
    const role = req.user && req.user.role;
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
        return res.status(400).json({ error: 'ID inválido' });
    }
    db.get('SELECT * FROM requisicoes_familia WHERE id = ?', [id], (err, reqRow) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!reqRow) {
            return res.status(404).json({ error: 'Requisição não encontrada' });
        }
        if (reqRow.status !== 'aprovado') {
            return res.status(400).json({ error: 'Apenas requisições aprovadas podem ser entregues' });
        }
        // Verifica disponibilidade no inventário
        db.get('SELECT * FROM inventario_familia WHERE id = ?', [reqRow.item_id], (itemErr, item) => {
            if (itemErr) {
                return res.status(500).json({ error: itemErr.message });
            }
            if (!item) {
                return res.status(404).json({ error: 'Item não encontrado no inventário' });
            }
            if (item.quantidade < reqRow.quantidade) {
                return res.status(400).json({ error: 'Quantidade insuficiente no inventário para entrega' });
            }
            // Subtrai a quantidade do inventário e marca a requisição como entregue
            const novaQuantidade = item.quantidade - reqRow.quantidade;
            db.run('UPDATE inventario_familia SET quantidade = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?', [novaQuantidade, item.id], function (updateInvErr) {
                if (updateInvErr) {
                    return res.status(500).json({ error: updateInvErr.message });
                }
                db.run('UPDATE requisicoes_familia SET status = ?, data_entrega = CURRENT_TIMESTAMP WHERE id = ?', ['entregue', id], function (updateReqErr) {
                    if (updateReqErr) {
                        return res.status(500).json({ error: updateReqErr.message });
                    }
            db.get(`SELECT r.*, i.categoria, COALESCE(i.item, i.subcategoria) AS item, u.username AS lider_username
                    FROM requisicoes_familia r
                    JOIN inventario_familia i ON i.id = r.item_id
                    LEFT JOIN usuarios u ON u.id = r.lider_id
                    WHERE r.id = ?`, [id], (selErr, updated) => {
                        if (selErr) {
                            return res.status(500).json({ error: selErr.message });
                        }
                        res.json(updated);
                    });
                });
            });
        });
    });
});

/**
 * Cancela uma requisição entregue. Apenas líderes ou administradores podem
 * cancelar uma requisição já entregue. Ao cancelar, a quantidade é
 * devolvida ao inventário e o status passa para "cancelado".
 */
app.put('/api/requisicoes-familia/:id/cancelar', authenticateToken, (req, res) => {
    const role = req.user && req.user.role;
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
        return res.status(400).json({ error: 'ID inválido' });
    }
    db.get('SELECT * FROM requisicoes_familia WHERE id = ?', [id], (err, reqRow) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!reqRow) {
            return res.status(404).json({ error: 'Requisição não encontrada' });
        }
        if (reqRow.status !== 'entregue') {
            return res.status(400).json({ error: 'Apenas requisições entregues podem ser canceladas' });
        }
        // Devolve a quantidade ao inventário
        db.get('SELECT * FROM inventario_familia WHERE id = ?', [reqRow.item_id], (itemErr, item) => {
            if (itemErr) {
                return res.status(500).json({ error: itemErr.message });
            }
            if (!item) {
                return res.status(404).json({ error: 'Item não encontrado no inventário' });
            }
            const novaQuantidade = item.quantidade + reqRow.quantidade;
            db.run('UPDATE inventario_familia SET quantidade = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?', [novaQuantidade, item.id], function (updateInvErr) {
                if (updateInvErr) {
                    return res.status(500).json({ error: updateInvErr.message });
                }
                db.run('UPDATE requisicoes_familia SET status = ? WHERE id = ?', ['cancelado', id], function (updateReqErr) {
                    if (updateReqErr) {
                        return res.status(500).json({ error: updateReqErr.message });
                    }
                    db.get(`SELECT r.*, i.categoria, COALESCE(i.item, i.subcategoria) AS item, u.username AS lider_username
                            FROM requisicoes_familia r
                            JOIN inventario_familia i ON i.id = r.item_id
                            LEFT JOIN usuarios u ON u.id = r.lider_id
                            WHERE r.id = ?`, [id], (selErr, updated) => {
                        if (selErr) {
                            return res.status(500).json({ error: selErr.message });
                        }
                        res.json(updated);
                    });
                });
            });
        });
    });
});

// Rotas de relatórios
app.get('/api/relatorios/geral', (req, res) => {
    const { periodo } = req.query;
    
    // Implementar lógica de relatórios baseada no período
    res.json({
        membros: 0,
        rotas: 0,
        encomendas: 0,
        vendas: 0,
        comissoes: 0
    });
});

// Rota principal
app.get('/', (req, res) => {
    res.redirect('/static/login_simple.html');
});

// Inicializar banco e servidor
async function startServer() {
    try {
        await initDatabase();

        // A geração automática de rotas pendentes para a próxima semana foi
        // removida a pedido do usuário.  Rotas serão criadas apenas
        // manualmente ou por outras regras de negócio.
        
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Servidor rodando na porta ${PORT}`);
            console.log(`📱 Acesse: http://localhost:${PORT}/static/login_simple.html`);
            console.log(`👤 Usuário: tofu | Senha: tofu$2025`);
        });
    } catch (error) {
        console.error('❌ Erro ao inicializar servidor:', error);
        process.exit(1);
    }
}

startServer();

