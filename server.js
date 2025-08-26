const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.static('static'));

// Configuração do multer para upload de imagens
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'static/images/items';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const name = path.basename(file.originalname, ext);
        cb(null, `${name}${ext}`);
    }
});

const upload = multer({ storage });

// Chave secreta para JWT (em produção, use uma variável de ambiente)
const JWT_SECRET = process.env.JWT_SECRET || 'sua_chave_secreta_super_segura_aqui_2024';

// O caminho do arquivo de banco pode ser configurado via variável de ambiente DB_PATH (ex.: /home/user/data/faccao_control.db)
const DB_PATH = process.env.DB_PATH || 'faccao_control.db';

// Conectar ao banco de dados SQLite
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Erro ao conectar ao banco de dados:', err.message);
    } else {
        console.log('✅ Banco de dados inicializado com sucesso!');
        initializeDatabase();
    }
});

// Função para inicializar o banco de dados
function initializeDatabase() {
    // Criar tabela de usuários
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'membro'
    )`);

    // Criar tabela de membros
    db.run(`CREATE TABLE IF NOT EXISTS membros (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        rg TEXT,
        telefone TEXT,
        cargo TEXT DEFAULT 'membro',
        data_cadastro DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Criar tabela de rotas
    db.run(`CREATE TABLE IF NOT EXISTS rotas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        membro_id INTEGER,
        quantidade INTEGER DEFAULT 1,
        data_entrega DATE,
        status TEXT DEFAULT 'pendente',
        data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (membro_id) REFERENCES membros (id)
    )`);

    // Criar tabela de encomendas
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

    // Criar tabela de estoque
    db.run(`CREATE TABLE IF NOT EXISTS estoque (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT NOT NULL,
        nome TEXT NOT NULL,
        quantidade INTEGER DEFAULT 0,
        preco REAL DEFAULT 0,
        data_atualizacao DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Criar tabela de famílias
    db.run(`CREATE TABLE IF NOT EXISTS familias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT UNIQUE NOT NULL,
        data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Criar tabela de imagens
    db.run(`CREATE TABLE IF NOT EXISTS imagens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        caminho TEXT NOT NULL,
        data_upload DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Criar tabela de inventário família
    db.run(`CREATE TABLE IF NOT EXISTS inventario_familia (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        quantidade INTEGER DEFAULT 0,
        preco REAL DEFAULT 0,
        imagem TEXT,
        data_atualizacao DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Criar tabela de requisições família
    db.run(`CREATE TABLE IF NOT EXISTS requisicoes_familia (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER,
        quantidade INTEGER,
        usuario TEXT,
        status TEXT DEFAULT 'pendente',
        data_requisicao DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (item_id) REFERENCES inventario_familia (id)
    )`);

    // Criar tabela de histórico do inventário família
    db.run(`CREATE TABLE IF NOT EXISTS historico_inventario_familia (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER,
        tipo_operacao TEXT,
        quantidade INTEGER,
        usuario TEXT,
        data_operacao DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (item_id) REFERENCES inventario_familia (id)
    )`);

    // Criar tabela de saídas avulsas
    db.run(`CREATE TABLE IF NOT EXISTS saidas_avulsas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT NOT NULL,
        item TEXT NOT NULL,
        quantidade INTEGER NOT NULL,
        destino TEXT,
        usuario TEXT,
        data_saida DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Remover duplicatas de rotas antes de criar o índice único. Isso é necessário porque
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

    // Criar índice único para famílias
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_familias_nome ON familias(nome)', (err) => {
        if (err) {
            console.error('Erro ao criar índice único em famílias:', err.message);
        }
    });

    // Criar índice único para inventário família
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_inventario_familia_nome ON inventario_familia(nome)', (err) => {
        if (err) {
            console.error('Erro ao criar índice único em inventário família:', err.message);
        }
    });

    // Criar índice único para imagens
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_imagens_nome ON imagens(nome)', (err) => {
        if (err) {
            console.error('Erro ao criar índice único em imagens:', err.message);
        }
    });

    // Criar índice único para membros (RG)
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_membros_rg ON membros(rg)', (err) => {
        if (err) {
            console.error('Erro ao criar índice único em membros (RG):', err.message);
        }
    });

    // Criar índice único para estoque (tipo, nome). Antes de criar o índice, é necessário
    // garantir que não há registros duplicados. Se o índice único já foi
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

    // Inserir dados iniciais de estoque se não existirem
    const estoqueInicial = [
        // Materiais
        { tipo: 'material', nome: 'Alumínio', quantidade: 320, preco: 24.50 },
        { tipo: 'material', nome: 'Cobre', quantidade: 320, preco: 24.62 },
        { tipo: 'material', nome: 'Emb Plástica', quantidade: 320, preco: 24.50 },
        { tipo: 'material', nome: 'Ferro', quantidade: 320, preco: 24.50 },
        { tipo: 'material', nome: 'Titânio', quantidade: 26, preco: 24.62 },
        // Munições
        { tipo: 'municao', nome: '5mm', quantidade: 0, preco: 100.00 },
        { tipo: 'municao', nome: '9mm', quantidade: 0, preco: 125.00 },
        { tipo: 'municao', nome: '762mm', quantidade: 0, preco: 200.00 },
        { tipo: 'municao', nome: '12cbc', quantidade: 0, preco: 200.00 }
    ];

    estoqueInicial.forEach(item => {
        db.run('INSERT OR IGNORE INTO estoque (tipo, nome, quantidade, preco) VALUES (?, ?, ?, ?)', 
               [item.tipo, item.nome, item.quantidade, item.preco]);
    });

    // Inserir inventário família inicial se não existir
    const inventarioInicial = [
        { nome: '45acb', quantidade: 0, preco: 1500.00, imagem: '45acb.jpg' },
        { nome: 'adrenalina', quantidade: 0, preco: 50.00, imagem: 'adrenalina.jpg' },
        { nome: 'ak103', quantidade: 0, preco: 8000.00, imagem: 'ak103.jpg' },
        { nome: 'ak47', quantidade: 0, preco: 7500.00, imagem: 'ak47.jpg' },
        { nome: 'algema', quantidade: 0, preco: 200.00, imagem: 'algema.jpg' },
        { nome: 'aug', quantidade: 0, preco: 9000.00, imagem: 'aug.jpg' },
        { nome: 'balinha', quantidade: 0, preco: 25.00, imagem: 'balinha.jpg' },
        { nome: 'c4', quantidade: 0, preco: 2000.00, imagem: 'c4.jpg' },
        { nome: 'camisadeforca', quantidade: 0, preco: 500.00, imagem: 'camisadeforca.jpg' },
        { nome: 'capuz', quantidade: 0, preco: 100.00, imagem: 'capuz.jpg' },
        { nome: 'chavedeouro', quantidade: 0, preco: 1000.00, imagem: 'chavedeouro.jpg' },
        { nome: 'chavedeplatina', quantidade: 0, preco: 2000.00, imagem: 'chavedeplatina.jpg' },
        { nome: 'clipextendido', quantidade: 0, preco: 300.00, imagem: 'clipextendido.jpg' },
        { nome: 'colete', quantidade: 0, preco: 1500.00, imagem: 'colete.jpg' },
        { nome: 'colt45', quantidade: 0, preco: 2500.00, imagem: 'colt45.jpg' },
        { nome: 'compensador', quantidade: 0, preco: 400.00, imagem: 'compensador.jpg' },
        { nome: 'farinha', quantidade: 0, preco: 100.00, imagem: 'farinha.jpg' },
        { nome: 'fiveseven', quantidade: 0, preco: 3000.00, imagem: 'fiveseven.jpg' },
        { nome: 'flippermk4', quantidade: 0, preco: 1200.00, imagem: 'flippermk4.jpg' },
        { nome: 'flippermk5', quantidade: 0, preco: 1500.00, imagem: 'flippermk5.jpg' },
        { nome: 'grip', quantidade: 0, preco: 250.00, imagem: 'grip.jpg' },
        { nome: 'h', quantidade: 0, preco: 75.00, imagem: 'h.jpg' },
        { nome: 'katana', quantidade: 0, preco: 800.00, imagem: 'katana.jpg' },
        { nome: 'lanterna', quantidade: 0, preco: 150.00, imagem: 'lanterna.jpg' },
        { nome: 'lança', quantidade: 0, preco: 600.00, imagem: 'lança.jpg' },
        { nome: 'm16', quantidade: 0, preco: 8500.00, imagem: 'm16.jpg' },
        { nome: 'm1911', quantidade: 0, preco: 2000.00, imagem: 'm1911.jpg' },
        { nome: 'masterpick', quantidade: 0, preco: 800.00, imagem: 'masterpick.jpg' },
        { nome: 'miniuzi', quantidade: 0, preco: 4000.00, imagem: 'miniuzi.jpg' },
        { nome: 'mira', quantidade: 0, preco: 200.00, imagem: 'mira.jpg' },
        { nome: 'mtar', quantidade: 0, preco: 7000.00, imagem: 'mtar.jpg' },
        { nome: 'mtar21', quantidade: 0, preco: 7500.00, imagem: 'mtar21.jpg' },
        { nome: 'oxy', quantidade: 0, preco: 150.00, imagem: 'oxy.jpg' },
        { nome: 'pager', quantidade: 0, preco: 300.00, imagem: 'pager.jpg' },
        { nome: 'placa', quantidade: 0, preco: 2500.00, imagem: 'placa.jpg' },
        { nome: 'rape', quantidade: 0, preco: 200.00, imagem: 'rape.jpg' },
        { nome: 'rastreador', quantidade: 0, preco: 500.00, imagem: 'rastreador.jpg' },
        { nome: 'spas12', quantidade: 0, preco: 6000.00, imagem: 'spas12.jpg' },
        { nome: 'supressor', quantidade: 0, preco: 600.00, imagem: 'supressor.jpg' },
        { nome: 'tec9', quantidade: 0, preco: 3500.00, imagem: 'tec9.jpg' },
        { nome: 'vaselina', quantidade: 0, preco: 50.00, imagem: 'vaselina.jpg' },
        { nome: 'viagra', quantidade: 0, preco: 100.00, imagem: 'viagra.jpg' }
    ];

    inventarioInicial.forEach(item => {
        db.run('INSERT OR IGNORE INTO inventario_familia (nome, quantidade, preco, imagem) VALUES (?, ?, ?, ?)', 
               [item.nome, item.quantidade, item.preco, item.imagem]);
    });

    // Criar tabela de configuração
    db.run(`CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    // Inserir taxa de comissão padrão (7%) se ainda não existir
    db.run('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)', ['commission_rate', '0.07']);

    // Criar usuário admin padrão
    const hashedPassword = bcrypt.hashSync('tofu$2025', 10);
    db.run(`INSERT OR IGNORE INTO usuarios (username, password, role) VALUES (?, ?, ?)`, 
           ['tofu', hashedPassword, 'admin']);

    // Criar usuário líder padrão para testes
    const hashedLiderPassword = bcrypt.hashSync('lider$2025', 10);
    db.run(`INSERT OR IGNORE INTO usuarios (username, password, role) VALUES (?, ?, ?)`,
           ['lider', hashedLiderPassword, 'lider']);

    // Criar usuário gerente padrão para testes
    const hashedGerentePassword = bcrypt.hashSync('gerente$2025', 10);
    db.run(`INSERT OR IGNORE INTO usuarios (username, password, role) VALUES (?, ?, ?)`,
           ['gerente', hashedGerentePassword, 'gerente']);

    // Criar usuário membro padrão para testes
    const hashedMembroPassword = bcrypt.hashSync('membro$2025', 10);
    db.run(`INSERT OR IGNORE INTO usuarios (username, password, role) VALUES (?, ?, ?)`,
           ['membro', hashedMembroPassword, 'membro']);

    console.log('🚀 Servidor rodando na porta', PORT);
    console.log('📱 Acesse: http://localhost:' + PORT + '/static/login_simple.html');
    console.log('👤 Usuário: tofu | Senha: tofu$2025');
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

// Função para gerar rotas automaticamente para a próxima semana
function generateRotasParaProximaSemana() {
    const hoje = new Date();
    const proximaSegunda = new Date(hoje);
    proximaSegunda.setDate(hoje.getDate() + (1 + 7 - hoje.getDay()) % 7);
    
    if (proximaSegunda.getTime() === hoje.getTime()) {
        proximaSegunda.setDate(proximaSegunda.getDate() + 7);
    }

    const diasSemana = [];
    for (let i = 0; i < 7; i++) {
        const dia = new Date(proximaSegunda);
        dia.setDate(proximaSegunda.getDate() + i);
        diasSemana.push(dia.toISOString().split('T')[0]);
    }

    db.all('SELECT id FROM membros', (err, membros) => {
        if (err) {
            console.error('Erro ao buscar membros:', err);
            return;
        }

        membros.forEach(membro => {
            diasSemana.forEach(dia => {
                db.run('INSERT OR IGNORE INTO rotas (membro_id, data_entrega, quantidade) VALUES (?, ?, ?)', 
                       [membro.id, dia, 1]);
            });
        });
    });
}

// Gerar rotas para a próxima semana na inicialização
setTimeout(generateRotasParaProximaSemana, 1000);

// Rotas de autenticação
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    db.get('SELECT * FROM usuarios WHERE username = ?', [username], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role
            }
        });
    });
});

// Rota para verificar token
app.get('/api/verify-token', authenticateToken, (req, res) => {
    res.json({ user: req.user });
});

/**
 * Baixa munições do estoque físico quando uma encomenda é marcada como entregue.
 * Esta função é chamada apenas quando o status muda de outro estado para "entregue",
 * garantindo que o estoque seja baixado apenas uma vez por encomenda.
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
 * Devolve munições ao estoque quando uma encomenda entregue é cancelada (status muda
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
/**
 * Percorre as encomendas pendentes e marca-as como prontas quando houver
 * estoque suficiente. As encomendas são processadas por ordem de
 * criação (primeiro as mais antigas) para garantir que quem pediu
 * primeiro tenha prioridade. Ao marcar uma encomenda como "pronto",
 * a quantidade de munições correspondente é baixada do banco de dados,
 * efetivamente reservando o estoque. Se não houver estoque suficiente
 * para uma encomenda, a verificação é interrompida.
 *
 * Esta função ignora reservas implícitas de encomendas já prontas, pois
 * essas quantidades já foram removidas do estoque ao marcar a encomenda
 * como pronta.
 *
 * @returns {Promise<void>} Uma promise que resolve quando a verificação
 *                          terminar.
 */
function verificarEncomendasProntas() {
    return new Promise((resolve, reject) => {
        console.log('🔍 Iniciando verificação de encomendas prontas...');
        // Recupera estoque atual de munições (consolidado)
        db.all('SELECT nome, SUM(quantidade) as quantidade FROM estoque WHERE tipo = "municao" GROUP BY nome', async (errStock, estoqueRows) => {
            if (errStock) {
                console.error('Erro ao obter estoque para verificação de encomendas prontas:', errStock);
                return reject(errStock);
            }
            // Mapeia estoque disponível por tipo
            const estoqueDisponivel = {};
            estoqueRows.forEach(row => {
                estoqueDisponivel[row.nome] = row.quantidade;
            });
            console.log('📦 Estoque consolidado de munições:', estoqueDisponivel);

            // Recupera encomendas pendentes ordenadas pela data de criação
            db.all('SELECT * FROM encomendas WHERE status = "pendente" ORDER BY data_criacao ASC', async (errOrders, pendentes) => {
                if (errOrders) {
                    console.error('Erro ao obter encomendas pendentes:', errOrders);
                    return reject(errOrders);
                }
                console.log('⏳ Número de encomendas pendentes:', pendentes.length);
                try {
                    for (const pedido of pendentes) {
                        const req5 = pedido.municao_5mm || 0;
                        const req9 = pedido.municao_9mm || 0;
                        const req762 = pedido.municao_762mm || 0;
                        const req12 = pedido.municao_12cbc || 0;

                        console.log(`🔍 Verificando encomenda ${pedido.id} (${pedido.cliente}):`);
                        console.log(`   Necessário: 5mm=${req5}, 9mm=${req9}, 762mm=${req762}, 12cbc=${req12}`);
                        console.log(`   Disponível: 5mm=${estoqueDisponivel['5mm'] || 0}, 9mm=${estoqueDisponivel['9mm'] || 0}, 762mm=${estoqueDisponivel['762mm'] || 0}, 12cbc=${estoqueDisponivel['12cbc'] || 0}`);

                        // Verifica se há estoque suficiente para esta encomenda
                        if ((estoqueDisponivel['5mm'] || 0) >= req5 &&
                            (estoqueDisponivel['9mm'] || 0) >= req9 &&
                            (estoqueDisponivel['762mm'] || 0) >= req762 &&
                            (estoqueDisponivel['12cbc'] || 0) >= req12) {
                            // Atualiza status para pronto
                            await new Promise((resUpd, rejUpd) => {
                                db.run('UPDATE encomendas SET status = ? WHERE id = ?', ['pronto', pedido.id], function(errUpd) {
                                    if (errUpd) {
                                        return rejUpd(errUpd);
                                    }
                                    console.log(`🎉 Encomenda ${pedido.id} marcada como pronta.`);
                                    resUpd();
                                });
                            });
                            // Baixa a quantidade de munições do estoque
                            try {
                                await baixarEstoquePorEncomenda(req5, req9, req762, req12);
                                console.log(`📦 Estoque atualizado para encomenda ${pedido.id}`);
                            } catch (errBaixa) {
                                console.error('Erro ao baixar estoque para encomenda pronta:', errBaixa);
                                // Se não conseguir baixar, desfaz a mudança de status para evitar inconsistencia
                                await new Promise((resRevert, rejRevert) => {
                                    db.run('UPDATE encomendas SET status = ? WHERE id = ?', ['pendente', pedido.id], function(errRev) {
                                        if (errRev) return rejRevert(errRev);
                                        resRevert();
                                    });
                                });
                                return reject(errBaixa);
                            }
                            // Atualiza estoque em memória
                            estoqueDisponivel['5mm'] = (estoqueDisponivel['5mm'] || 0) - req5;
                            estoqueDisponivel['9mm'] = (estoqueDisponivel['9mm'] || 0) - req9;
                            estoqueDisponivel['762mm'] = (estoqueDisponivel['762mm'] || 0) - req762;
                            estoqueDisponivel['12cbc'] = (estoqueDisponivel['12cbc'] || 0) - req12;
                        } else {
                            console.log(`❌ Estoque insuficiente para encomenda ${pedido.id}, parando verificação.`);
                            break;
                        }
                    }
                    console.log('🏁 Verificação de encomendas prontas concluída.');
                    resolve();
                } catch (errLoop) {
                    console.error('Erro durante verificação de encomendas prontas:', errLoop);
                    reject(errLoop);
                }
            });
        });
    });
}

// Rota para forçar verificação de encomendas prontas
app.post('/api/verificar-prontos', (req, res) => {
    verificarEncomendasProntas()
        .then(() => {
            res.json({ message: 'Verificação de encomendas prontas executada com sucesso' });
        })
        .catch(err => {
            console.error('Erro ao verificar encomendas prontas:', err);
            res.status(500).json({ error: 'Erro ao verificar encomendas prontas: ' + err.message });
        });
});

// Rota para forçar verificação de encomendas prontas
app.post('/api/verificar-prontos', (req, res) => {
    verificarEncomendasProntas()
        .then(() => {
            res.json({ message: 'Verificação de encomendas prontas executada com sucesso' });
        })
        .catch(err => {
            console.error('Erro ao verificar encomendas prontas:', err);
            res.status(500).json({ error: 'Erro ao verificar encomendas prontas: ' + err.message });
        });
});

// Rota para limpar duplicatas do estoque manualmente
app.post('/api/limpar-duplicatas', authenticateToken, (req, res) => {
    const role = req.user && req.user.role;
    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    db.run(`DELETE FROM estoque WHERE rowid NOT IN (SELECT MIN(rowid) FROM estoque GROUP BY tipo, nome)`, function(err) {
        if (err) {
            console.error('Erro ao limpar duplicatas:', err);
            return res.status(500).json({ error: 'Erro ao limpar duplicatas: ' + err.message });
        }
        res.json({ 
            message: 'Duplicatas removidas com sucesso',
            removidas: this.changes
        });
    });
});

// Rotas de encomendas
app.get('/api/encomendas', (req, res) => {
    db.all('SELECT * FROM encomendas ORDER BY data_criacao DESC', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.post('/api/encomendas', async (req, res) => {
    const { cliente, familia, telefone_cliente, municao_5mm, municao_9mm, municao_762mm, municao_12cbc, valor_total, comissao, usuario } = req.body;

    db.run(
        'INSERT INTO encomendas (cliente, familia, telefone_cliente, municao_5mm, municao_9mm, municao_762mm, municao_12cbc, valor_total, comissao, usuario) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [cliente, familia, telefone_cliente, municao_5mm || 0, municao_9mm || 0, municao_762mm || 0, municao_12cbc || 0, valor_total, comissao, usuario],
        function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
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

app.put('/api/encomendas/:id', (req, res) => {
    const { id } = req.params;
    const { cliente, familia, telefone_cliente, municao_5mm, municao_9mm, municao_762mm, municao_12cbc, valor_total, comissao, status } = req.body;

    // Função auxiliar para enviar resposta e executar verificação de encomendas prontas.
    // Isso é necessário porque após alterar uma encomenda (especialmente o status),
    // o sistema deve reavaliar se outras encomendas pendentes podem ser marcadas como prontas com
    // base no estoque atualizado. Por exemplo, se uma encomenda "pronta" for cancelada,
    // o estoque "reservado" é liberado e outras encomendas pendentes podem se tornar prontas.
    // Também é executada quando quantidades de munições são alteradas, pois isso pode afetar
    // a disponibilidade de estoque para outras encomendas. A verificação é executada de forma
    // assíncrona após o envio da resposta para não bloquear a requisição do usuário.
    // Em caso de erro na verificação, apenas um log é registrado, sem afetar a resposta
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

        const statusAnterior = row.status;
        const q5Anterior = row.municao_5mm || 0;
        const q9Anterior = row.municao_9mm || 0;
        const q762Anterior = row.municao_762mm || 0;
        const q12Anterior = row.municao_12cbc || 0;

        const q5Novo = municao_5mm || 0;
        const q9Novo = municao_9mm || 0;
        const q762Novo = municao_762mm || 0;
        const q12Novo = municao_12cbc || 0;

        // Atualiza a encomenda
        db.run(
            'UPDATE encomendas SET cliente = ?, familia = ?, telefone_cliente = ?, municao_5mm = ?, municao_9mm = ?, municao_762mm = ?, municao_12cbc = ?, valor_total = ?, comissao = ?, status = ? WHERE id = ?',
            [cliente, familia, telefone_cliente, q5Novo, q9Novo, q762Novo, q12Novo, valor_total, comissao, status, id],
            function (err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }

                // Controle de estoque baseado em mudanças de status
                // 1. Se a encomenda estava entregue e deixa de estar entregue,
                //    devolvemos todo o estoque anteriormente baixado.
                if (statusAnterior === 'entregue' && status !== 'entregue') {
                    devolverEstoquePorEncomenda(q5Anterior, q9Anterior, q762Anterior, q12Anterior)
                        .then(() => {
                            sendAndVerify({ message: 'Encomenda atualizada e estoque devolvido com sucesso' });
                        })
                        .catch(errDevolver => {
                            console.error('Erro ao devolver estoque:', errDevolver);
                            sendAndVerify({ message: 'Encomenda atualizada, mas erro ao devolver estoque' });
                        });
                    return;
                }
                // 2. Se a encomenda estava pronta (estoque já reservado) e muda para pendente ou cancelada,
                //    devolvemos as quantidades reservadas. Caso mude para entregue, nada a fazer
                //    pois o estoque já foi baixado ao marcar como pronto.
                if (statusAnterior === 'pronto' && status !== 'pronto') {
                    if (status === 'entregue') {
                        // A encomenda estava pronta e agora foi entregue: estoque já está reservado.
                        // Entretanto, se houver alterações de quantidade, ajusta o estoque.
                        const deltaQ5p = q5Novo - q5Anterior;
                        const deltaQ9p = q9Novo - q9Anterior;
                        const deltaQ762p = q762Novo - q762Anterior;
                        const deltaQ12p = q12Novo - q12Anterior;
                        if (deltaQ5p !== 0 || deltaQ9p !== 0 || deltaQ762p !== 0 || deltaQ12p !== 0) {
                            // Ajusta estoque baseado na diferença entre novo e antigo
                            const baixas = {
                                q5: Math.max(0, deltaQ5p),
                                q9: Math.max(0, deltaQ9p),
                                q762: Math.max(0, deltaQ762p),
                                q12: Math.max(0, deltaQ12p)
                            };
                            const devolucoes = {
                                q5: Math.abs(Math.min(0, deltaQ5p)),
                                q9: Math.abs(Math.min(0, deltaQ9p)),
                                q762: Math.abs(Math.min(0, deltaQ762p)),
                                q12: Math.abs(Math.min(0, deltaQ12p))
                            };
                            baixarEstoquePorEncomenda(baixas.q5, baixas.q9, baixas.q762, baixas.q12)
                                .then(() => devolverEstoquePorEncomenda(devolucoes.q5, devolucoes.q9, devolucoes.q762, devolucoes.q12))
                                .then(() => {
                                    sendAndVerify({ message: 'Encomenda atualizada e estoque ajustado com sucesso' });
                                })
                                .catch(errAjuste => {
                                    console.error('Erro ao ajustar estoque:', errAjuste);
                                    sendAndVerify({ message: 'Encomenda atualizada, mas erro ao ajustar estoque' });
                                });
                        } else {
                            sendAndVerify({ message: 'Encomenda atualizada com sucesso' });
                        }
                    } else {
                        // Mudou de pronto para outro status (pendente, cancelado): devolve reserva
                        devolverEstoquePorEncomenda(q5Anterior, q9Anterior, q762Anterior, q12Anterior)
                            .then(() => {
                                sendAndVerify({ message: 'Encomenda atualizada e estoque devolvido com sucesso' });
                            })
                            .catch(errDevolver => {
                                console.error('Erro ao devolver estoque:', errDevolver);
                                sendAndVerify({ message: 'Encomenda atualizada, mas erro ao devolver estoque' });
                            });
                    }
                    return;
                }
                // 3. Se a encomenda não era entregue e passa a ser entregue (sem ter estado pronta),
                //    baixamos o estoque. Isso cobre status pendente ou cancelado -> entregue.
                if (statusAnterior !== 'entregue' && status === 'entregue') {
                    if (statusAnterior === 'pronto') {
                        // Estoque já foi baixado quando marcou como pronto, apenas ajusta se quantidades mudaram.
                        const deltaQ5p = q5Novo - q5Anterior;
                        const deltaQ9p = q9Novo - q9Anterior;
                        const deltaQ762p = q762Novo - q762Anterior;
                        const deltaQ12p = q12Novo - q12Anterior;
                        if (deltaQ5p !== 0 || deltaQ9p !== 0 || deltaQ762p !== 0 || deltaQ12p !== 0) {
                            const baixas = {
                                q5: Math.max(0, deltaQ5p),
                                q9: Math.max(0, deltaQ9p),
                                q762: Math.max(0, deltaQ762p),
                                q12: Math.max(0, deltaQ12p)
                            };
                            const devolucoes = {
                                q5: Math.abs(Math.min(0, deltaQ5p)),
                                q9: Math.abs(Math.min(0, deltaQ9p)),
                                q762: Math.abs(Math.min(0, deltaQ762p)),
                                q12: Math.abs(Math.min(0, deltaQ12p))
                            };
                            baixarEstoquePorEncomenda(baixas.q5, baixas.q9, baixas.q762, baixas.q12)
                                .then(() => devolverEstoquePorEncomenda(devolucoes.q5, devolucoes.q9, devolucoes.q762, devolucoes.q12))
                                .then(() => {
                                    sendAndVerify({ message: 'Encomenda atualizada e estoque ajustado com sucesso' });
                                })
                                .catch(errAjuste => {
                                    console.error('Erro ao ajustar estoque:', errAjuste);
                                    sendAndVerify({ message: 'Encomenda atualizada, mas erro ao ajustar estoque' });
                                });
                        } else {
                            sendAndVerify({ message: 'Encomenda atualizada com sucesso' });
                        }
                    } else {
                        // Status anterior não era pronto nem entregue: baixar estoque para todas as quantidades
                        baixarEstoquePorEncomenda(q5Novo, q9Novo, q762Novo, q12Novo)
                            .then(() => {
                                sendAndVerify({ message: 'Encomenda atualizada e estoque baixado com sucesso' });
                            })
                            .catch(errBaixar => {
                                console.error('Erro ao baixar estoque:', errBaixar);
                                sendAndVerify({ message: 'Encomenda atualizada, mas erro ao baixar estoque' });
                            });
                    }
                    return;
                }
                // 4. Ajustes de quantidades quando a encomenda continua entregue ou continua pronta
                if (statusAnterior === 'entregue' && status === 'entregue') {
                    const deltaQ5 = q5Novo - q5Anterior;
                    const deltaQ9 = q9Novo - q9Anterior;
                    const deltaQ762 = q762Novo - q762Anterior;
                    const deltaQ12 = q12Novo - q12Anterior;
                    if (deltaQ5 !== 0 || deltaQ9 !== 0 || deltaQ762 !== 0 || deltaQ12 !== 0) {
                        const baixas = {
                            q5: Math.max(0, deltaQ5),
                            q9: Math.max(0, deltaQ9),
                            q762: Math.max(0, deltaQ762),
                            q12: Math.max(0, deltaQ12)
                        };
                        const devolucoes = {
                            q5: Math.abs(Math.min(0, deltaQ5)),
                            q9: Math.abs(Math.min(0, deltaQ9)),
                            q762: Math.abs(Math.min(0, deltaQ762)),
                            q12: Math.abs(Math.min(0, deltaQ12))
                        };
                        baixarEstoquePorEncomenda(baixas.q5, baixas.q9, baixas.q762, baixas.q12)
                            .then(() => devolverEstoquePorEncomenda(devolucoes.q5, devolucoes.q9, devolucoes.q762, devolucoes.q12))
                            .then(() => {
                                sendAndVerify({ message: 'Encomenda atualizada e estoque ajustado com sucesso' });
                            })
                            .catch(errAjuste => {
                                console.error('Erro ao ajustar estoque:', errAjuste);
                                sendAndVerify({ message: 'Encomenda atualizada, mas erro ao ajustar estoque' });
                            });
                    } else {
                        sendAndVerify({ message: 'Encomenda atualizada com sucesso' });
                    }
                    return;
                }
                if (statusAnterior === 'pronto' && status === 'pronto') {
                    // Ajuste de quantidades quando continua pronto (reserva). Sem alterar status.
                    const deltaQ5 = q5Novo - q5Anterior;
                    const deltaQ9 = q9Novo - q9Anterior;
                    const deltaQ762 = q762Novo - q762Anterior;
                    const deltaQ12 = q12Novo - q12Anterior;
                    if (deltaQ5 !== 0 || deltaQ9 !== 0 || deltaQ762 !== 0 || deltaQ12 !== 0) {
                        const baixas = {
                            q5: Math.max(0, deltaQ5),
                            q9: Math.max(0, deltaQ9),
                            q762: Math.max(0, deltaQ762),
                            q12: Math.max(0, deltaQ12)
                        };
                        const devolucoes = {
                            q5: Math.abs(Math.min(0, deltaQ5)),
                            q9: Math.abs(Math.min(0, deltaQ9)),
                            q762: Math.abs(Math.min(0, deltaQ762)),
                            q12: Math.abs(Math.min(0, deltaQ12))
                        };
                        baixarEstoquePorEncomenda(baixas.q5, baixas.q9, baixas.q762, baixas.q12)
                            .then(() => devolverEstoquePorEncomenda(devolucoes.q5, devolucoes.q9, devolucoes.q762, devolucoes.q12))
                            .then(() => {
                                sendAndVerify({ message: 'Encomenda atualizada e estoque ajustado com sucesso' });
                            })
                            .catch(errAjuste => {
                                console.error('Erro ao ajustar estoque:', errAjuste);
                                sendAndVerify({ message: 'Encomenda atualizada, mas erro ao ajustar estoque' });
                            });
                    } else {
                        sendAndVerify({ message: 'Encomenda atualizada com sucesso' });
                    }
                    return;
                }
                // 5. Demais casos: nenhuma alteração de estoque é necessária
                sendAndVerify({ message: 'Encomenda atualizada com sucesso' });
            }
        );
    });
});

app.delete('/api/encomendas/:id', (req, res) => {
    const { id } = req.params;

    // Primeiro, obtém os dados da encomenda para controle de estoque
    db.get('SELECT status, municao_5mm, municao_9mm, municao_762mm, municao_12cbc FROM encomendas WHERE id = ?', [id], (errSelect, row) => {
        if (errSelect) {
            return res.status(500).json({ error: errSelect.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Encomenda não encontrada' });
        }

        // Se a encomenda estava entregue, devolver ao estoque
        if (row.status === 'entregue') {
            devolverEstoquePorEncomenda(row.municao_5mm || 0, row.municao_9mm || 0, row.municao_762mm || 0, row.municao_12cbc || 0)
                .then(() => {
                    // Após devolver ao estoque, exclui a encomenda
                    db.run('DELETE FROM encomendas WHERE id = ?', [id], function (err) {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }
                        res.json({ message: 'Encomenda excluída e estoque devolvido com sucesso' });
                        // Verifica se outras encomendas podem ser marcadas como prontas
                        verificarEncomendasProntas().catch(err => {
                            console.error('Erro ao verificar encomendas prontas após exclusão:', err);
                        });
                    });
                })
                .catch(errDevolver => {
                    console.error('Erro ao devolver estoque:', errDevolver);
                    res.status(500).json({ error: 'Erro ao devolver estoque: ' + errDevolver.message });
                });
        } else {
            // Encomenda não estava entregue, apenas exclui
            db.run('DELETE FROM encomendas WHERE id = ?', [id], function (err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                res.json({ message: 'Encomenda excluída com sucesso' });
                // Verifica se outras encomendas podem ser marcadas como prontas
                verificarEncomendasProntas().catch(err => {
                    console.error('Erro ao verificar encomendas prontas após exclusão:', err);
                });
            });
        }
    });
});

// Rotas de estoque
app.get('/api/estoque', (req, res) => {
    // Consolida duplicatas somando quantidades por tipo e nome
    db.all('SELECT tipo, nome, SUM(quantidade) as quantidade, AVG(preco) as preco, MAX(data_atualizacao) as data_atualizacao FROM estoque GROUP BY tipo, nome ORDER BY tipo, nome', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Atualizar estoque adicionando materiais ou munições. Disponível apenas para administradores ou líderes.
// Atualiza um item específico do estoque (quantidade). Apenas administradores, gerentes ou líderes podem editar o valor
app.put('/api/estoque/:tipo/:item', authenticateToken, (req, res) => {
    const { tipo, item } = req.params;
    const { quantidade } = req.body;
    const role = req.user && req.user.role;

    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }

    db.run('UPDATE estoque SET quantidade = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE tipo = ? AND nome = ?', [quantidade, tipo, item], function (err) {
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
app.post('/api/estoque/adicionar', authenticateToken, (req, res) => {
    const { tipo, item, quantidade, baixar_materiais } = req.body;
    const role = req.user && req.user.role;

    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }

    if (tipo === 'material') {
        // Atualizar material
        db.run('UPDATE estoque SET quantidade = quantidade + ?, data_atualizacao = CURRENT_TIMESTAMP WHERE tipo = ? AND nome = ?', [quantidade, tipo, item], function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
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
        const qtdMunicao = parseInt(quantidade) || 0;
        if (qtdMunicao <= 0) {
            return res.status(400).json({ error: 'Quantidade deve ser maior que zero' });
        }

        // Calcular materiais necessários baseado na munição
        let totalMaterial, totalTitanio;
        switch (item) {
            case '5mm':
                totalMaterial = Math.ceil(qtdMunicao / 50) * 8;
                totalTitanio = Math.ceil(qtdMunicao / 50) * 1;
                break;
            case '9mm':
                totalMaterial = Math.ceil(qtdMunicao / 50) * 10;
                totalTitanio = Math.ceil(qtdMunicao / 50) * 1;
                break;
            case '762mm':
                totalMaterial = Math.ceil(qtdMunicao / 50) * 12;
                totalTitanio = Math.ceil(qtdMunicao / 50) * 1;
                break;
            case '12cbc':
                totalMaterial = Math.ceil(qtdMunicao / 50) * 15;
                totalTitanio = Math.ceil(qtdMunicao / 50) * 2;
                break;
            default:
                return res.status(400).json({ error: 'Tipo de munição inválido' });
        }

        // Se baixar_materiais for 'sim', verificar e subtrair materiais
        if (baixar_materiais === 'sim') {
            const materiaisNecessarios = [
                { nome: 'Alumínio', quantidade: totalMaterial },
                { nome: 'Cobre', quantidade: totalMaterial },
                { nome: 'Emb Plástica', quantidade: totalMaterial },
                { nome: 'Ferro', quantidade: totalMaterial },
                { nome: 'Titânio', quantidade: totalTitanio }
            ];
            // Antes de subtrair, verifica se há material suficiente
            db.all('SELECT nome, SUM(quantidade) as quantidade FROM estoque WHERE tipo = "material" GROUP BY nome', (errMat, rows) => {
                if (errMat) {
                    console.error('Erro ao consultar materiais:', errMat.message);
                    // Continua a operação, mas não baixa materiais
                    updateMunicaoOnly();
                    return;
                }

                const estoqueAtual = {};
                rows.forEach(row => {
                    estoqueAtual[row.nome] = row.quantidade;
                });

                // Verifica se há material suficiente
                const faltaMaterial = materiaisNecessarios.find(mat => 
                    (estoqueAtual[mat.nome] || 0) < mat.quantidade
                );

                if (faltaMaterial) {
                    return res.status(400).json({ 
                        error: `Material insuficiente: ${faltaMaterial.nome}. Necessário: ${faltaMaterial.quantidade}, Disponível: ${estoqueAtual[faltaMaterial.nome] || 0}` 
                    });
                }

                // Baixar materiais
                let materiaisProcessados = 0;
                materiaisNecessarios.forEach(material => {
                    db.run('UPDATE estoque SET quantidade = quantidade - ?, data_atualizacao = CURRENT_TIMESTAMP WHERE tipo = "material" AND nome = ?', 
                           [material.quantidade, material.nome], function(errUpdate) {
                        if (errUpdate) {
                            console.error('Erro ao baixar material:', material.nome, errUpdate.message);
                        }
                        materiaisProcessados++;
                        if (materiaisProcessados === materiaisNecessarios.length) {
                            updateMunicaoAndFinalize();
                        }
                    });
                });

                function updateMunicaoAndFinalize() {
                    // Atualizar munição
                    db.run('UPDATE estoque SET quantidade = quantidade + ?, data_atualizacao = CURRENT_TIMESTAMP WHERE tipo = ? AND nome = ?', 
                           [qtdMunicao, tipo, item], function(errMun) {
                        if (errMun) {
                            return res.status(500).json({ error: errMun.message });
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
                        finalizeUpdate();
                    });
                }
            });
        return;
        }

        function updateMunicaoOnly() {
            // Apenas atualizar munição sem baixar materiais
            db.run('UPDATE estoque SET quantidade = quantidade + ?, data_atualizacao = CURRENT_TIMESTAMP WHERE tipo = ? AND nome = ?', 
                   [qtdMunicao, tipo, item], function(err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                res.json({ message: 'Estoque de munição atualizado com sucesso' });
                // Após atualizar o estoque, verifica se encomendas pendentes podem ser marcadas como prontas
                verificarEncomendasProntas().catch(err => {
                    console.error('Erro ao verificar encomendas prontas após atualização de munições:', err);
                });
            });
        }

        updateMunicaoOnly();
        return;
    }

    res.status(400).json({ error: 'Tipo inválido' });
});

// Rota para retirar itens do estoque
app.post('/api/estoque/retirar', authenticateToken, (req, res) => {
    const { tipo, item, quantidade, destinos } = req.body;
    const role = req.user && req.user.role;
    const usuario = req.user && req.user.username;

    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }

    const qtd = parseInt(quantidade) || 0;
    if (qtd <= 0) {
        return res.status(400).json({ error: 'Quantidade deve ser maior que zero' });
    }

    // Processar destinos
    let destinosArray = [];
    if (Array.isArray(destinos)) {
        destinosArray = destinos;
    } else if (typeof destinos === 'string') {
        destinosArray = destinos.split(',').map(s => s.trim()).filter(Boolean);
    }
    // Verificar estoque disponível (soma duplicatas se existirem)
    db.get('SELECT SUM(quantidade) as quantidade FROM estoque WHERE tipo = ? AND nome = ?', [tipo, item], (errSel, rowSel) => {
        if (errSel) {
            return res.status(500).json({ error: errSel.message });
        }
        if (!rowSel || (rowSel.quantidade || 0) < qtd) {
            return res.status(400).json({ 
                error: `Estoque insuficiente. Disponível: ${rowSel ? (rowSel.quantidade || 0) : 0}, Solicitado: ${qtd}` 
            });
        }

        // Retirar do estoque
        db.run('UPDATE estoque SET quantidade = quantidade - ?, data_atualizacao = CURRENT_TIMESTAMP WHERE tipo = ? AND nome = ?', 
               [qtd, tipo, item], function(errUpd) {
            if (errUpd) {
                return res.status(500).json({ error: errUpd.message });
            }

            // Registrar saída avulsa
            const destinoStr = destinosArray.length > 0 ? destinosArray.join(', ') : 'Não especificado';
            db.run('INSERT INTO saidas_avulsas (tipo, item, quantidade, destino, usuario) VALUES (?, ?, ?, ?, ?)',
                   [tipo, item, qtd, destinoStr, usuario], function(errSaida) {
                if (errSaida) {
                    console.error('Erro ao registrar saída avulsa:', errSaida.message);
                }
                res.json({ message: 'Item retirado do estoque com sucesso' });
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
    const role = req.user && req.user.role;

    if (role !== 'admin' && role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado' });
    }

    const numLotes = parseInt(lotes) || 0;
    if (numLotes <= 0) {
        return res.status(400).json({ error: 'Número de lotes deve ser maior que zero' });
    }

    // Calcular materiais necessários e munições produzidas
    let materiaisNecessarios, municoesProduzidas;
    switch (tipo_municao) {
        case '5mm':
            materiaisNecessarios = { aluminio: 8 * numLotes, cobre: 8 * numLotes, emb_plastica: 8 * numLotes, ferro: 8 * numLotes, titanio: 1 * numLotes };
            municoesProduzidas = 50 * numLotes;
            break;
        case '9mm':
            materiaisNecessarios = { aluminio: 10 * numLotes, cobre: 10 * numLotes, emb_plastica: 10 * numLotes, ferro: 10 * numLotes, titanio: 1 * numLotes };
            municoesProduzidas = 50 * numLotes;
            break;
        case '762mm':
            materiaisNecessarios = { aluminio: 12 * numLotes, cobre: 12 * numLotes, emb_plastica: 12 * numLotes, ferro: 12 * numLotes, titanio: 1 * numLotes };
            municoesProduzidas = 50 * numLotes;
            break;
        case '12cbc':
            materiaisNecessarios = { aluminio: 15 * numLotes, cobre: 15 * numLotes, emb_plastica: 15 * numLotes, ferro: 15 * numLotes, titanio: 2 * numLotes };
            municoesProduzidas = 50 * numLotes;
            break;
        default:
            return res.status(400).json({ error: 'Tipo de munição inválido' });
    }

    // Verificar se há materiais suficientes
    db.all('SELECT nome, quantidade FROM estoque WHERE tipo = "material"', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        const estoqueMateriais = {};
        rows.forEach(row => {
            estoqueMateriais[row.nome] = row.quantidade;
        });

        // Verificar disponibilidade
        const checks = [
            { nome: 'Alumínio', necessario: materiaisNecessarios.aluminio, disponivel: estoqueMateriais['Alumínio'] || 0 },
            { nome: 'Cobre', necessario: materiaisNecessarios.cobre, disponivel: estoqueMateriais['Cobre'] || 0 },
            { nome: 'Emb Plástica', necessario: materiaisNecessarios.emb_plastica, disponivel: estoqueMateriais['Emb Plástica'] || 0 },
            { nome: 'Ferro', necessario: materiaisNecessarios.ferro, disponivel: estoqueMateriais['Ferro'] || 0 },
            { nome: 'Titânio', necessario: materiaisNecessarios.titanio, disponivel: estoqueMateriais['Titânio'] || 0 }
        ];

        const materialInsuficiente = checks.find(check => check.disponivel < check.necessario);
        if (materialInsuficiente) {
            return res.status(400).json({ 
                error: `Material insuficiente: ${materialInsuficiente.nome}. Necessário: ${materialInsuficiente.necessario}, Disponível: ${materialInsuficiente.disponivel}` 
            });
        }

        // Baixar materiais
        const updates = [
            { nome: 'Alumínio', quantidade: materiaisNecessarios.aluminio },
            { nome: 'Cobre', quantidade: materiaisNecessarios.cobre },
            { nome: 'Emb Plástica', quantidade: materiaisNecessarios.emb_plastica },
            { nome: 'Ferro', quantidade: materiaisNecessarios.ferro },
            { nome: 'Titânio', quantidade: materiaisNecessarios.titanio }
        ];

        let updatesCompletos = 0;
        updates.forEach(update => {
            db.run('UPDATE estoque SET quantidade = quantidade - ?, data_atualizacao = CURRENT_TIMESTAMP WHERE tipo = "material" AND nome = ?', 
                   [update.quantidade, update.nome], function(errUpdate) {
                if (errUpdate) {
                    console.error('Erro ao baixar material:', update.nome, errUpdate.message);
                }
                updatesCompletos++;
                if (updatesCompletos === updates.length) {
                    // Adicionar munições
                    db.run('UPDATE estoque SET quantidade = quantidade + ?, data_atualizacao = CURRENT_TIMESTAMP WHERE tipo = "municao" AND nome = ?', 
                           [municoesProduzidas, tipo_municao], function(errMunicao) {
                        if (errMunicao) {
                            return res.status(500).json({ error: errMunicao.message });
                        }
                        res.json({ 
                            message: `Fabricação concluída com sucesso! Produzidas ${municoesProduzidas} munições ${tipo_municao}`,
                            municoes_produzidas: municoesProduzidas
                        });
                        // Após fabricar munições, verifica se encomendas pendentes podem ser marcadas como prontas
                        verificarEncomendasProntas().catch(err => {
                            console.error('Erro ao verificar encomendas prontas após fabricação:', err);
                        });
                    });
                }
            });
        });
    });
});

// Rotas de membros
app.get('/api/membros', (req, res) => {
    db.all('SELECT * FROM membros ORDER BY nome', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.post('/api/membros', (req, res) => {
    const { nome, rg, telefone, cargo } = req.body;

    db.run('INSERT INTO membros (nome, rg, telefone, cargo) VALUES (?, ?, ?, ?)', [nome, rg, telefone, cargo || 'membro'], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: 'RG já cadastrado' });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({
            message: 'Membro cadastrado com sucesso',
            id: this.lastID
        });
    });
});

app.put('/api/membros/:id', (req, res) => {
    const { id } = req.params;
    const { nome, rg, telefone, cargo } = req.body;

    db.run('UPDATE membros SET nome = ?, rg = ?, telefone = ?, cargo = ? WHERE id = ?', [nome, rg, telefone, cargo, id], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: 'RG já cadastrado para outro membro' });
            }
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Membro não encontrado' });
        }
        res.json({ message: 'Membro atualizado com sucesso' });
    });
});

app.delete('/api/membros/:id', (req, res) => {
    const { id } = req.params;

    db.run('DELETE FROM membros WHERE id = ?', [id], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Membro não encontrado' });
        }
        res.json({ message: 'Membro excluído com sucesso' });
    });
});

// Rotas de rotas
app.get('/api/rotas', (req, res) => {
    db.all(`SELECT r.*, m.nome as membro_nome 
            FROM rotas r 
            LEFT JOIN membros m ON r.membro_id = m.id 
            ORDER BY r.data_entrega DESC, m.nome`, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.post('/api/rotas', (req, res) => {
    const { membro_id, quantidade, data_entrega } = req.body;

    db.run('INSERT INTO rotas (membro_id, quantidade, data_entrega) VALUES (?, ?, ?)', [membro_id, quantidade || 1, data_entrega], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: 'Já existe uma rota para este membro nesta data' });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({
            message: 'Rota cadastrada com sucesso',
            id: this.lastID
        });
    });
});

app.put('/api/rotas/:id', (req, res) => {
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
                    console.error('Erro ao atualizar material:', item.nome, err.message);
                }
                pending--;
                if (pending === 0) {
                    resolve();
                }
            });
        });
    });
}

app.delete('/api/rotas/:id', (req, res) => {
    const { id } = req.params;

    db.run('DELETE FROM rotas WHERE id = ?', [id], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Rota não encontrada' });
        }
        res.json({ message: 'Rota excluída com sucesso' });
    });
});

// Rotas de famílias
app.get('/api/familias', (req, res) => {
    db.all('SELECT * FROM familias ORDER BY nome', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.post('/api/familias', (req, res) => {
    const { nome } = req.body;

    db.run('INSERT INTO familias (nome) VALUES (?)', [nome], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: 'Família já cadastrada' });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({
            message: 'Família cadastrada com sucesso',
            id: this.lastID
        });
    });
});

app.delete('/api/familias/:id', (req, res) => {
    const { id } = req.params;

    db.run('DELETE FROM familias WHERE id = ?', [id], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Família não encontrada' });
        }
        res.json({ message: 'Família excluída com sucesso' });
    });
});

// Rotas de inventário família
app.get('/api/inventario-familia', (req, res) => {
    db.all('SELECT * FROM inventario_familia ORDER BY nome', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.post('/api/inventario-familia', (req, res) => {
    const { nome, quantidade, preco, imagem } = req.body;

    db.run('INSERT INTO inventario_familia (nome, quantidade, preco, imagem) VALUES (?, ?, ?, ?)', 
           [nome, quantidade || 0, preco || 0, imagem], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: 'Item já cadastrado' });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({
            message: 'Item adicionado ao inventário com sucesso',
            id: this.lastID
        });
    });
});

app.put('/api/inventario-familia/:id', (req, res) => {
    const { id } = req.params;
    const { nome, quantidade, preco, imagem } = req.body;

    db.run('UPDATE inventario_familia SET nome = ?, quantidade = ?, preco = ?, imagem = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?', 
           [nome, quantidade, preco, imagem, id], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: 'Nome já existe para outro item' });
            }
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Item não encontrado' });
        }
        res.json({ message: 'Item atualizado com sucesso' });
    });
});

app.delete('/api/inventario-familia/:id', (req, res) => {
    const { id } = req.params;

    db.run('DELETE FROM inventario_familia WHERE id = ?', [id], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Item não encontrado' });
        }
        res.json({ message: 'Item excluído com sucesso' });
    });
});

// Rotas de requisições família
app.get('/api/requisicoes-familia', (req, res) => {
    db.all(`SELECT r.*, i.nome as item_nome, i.preco as item_preco 
            FROM requisicoes_familia r 
            LEFT JOIN inventario_familia i ON r.item_id = i.id 
            ORDER BY r.data_requisicao DESC`, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.post('/api/requisicoes-familia', (req, res) => {
    const { item_id, quantidade, usuario } = req.body;

    // Verificar se há quantidade suficiente no inventário
    db.get('SELECT quantidade FROM inventario_familia WHERE id = ?', [item_id], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Item não encontrado' });
        }
        if (row.quantidade < quantidade) {
            return res.status(400).json({ error: 'Quantidade insuficiente no inventário' });
        }

        // Criar requisição
        db.run('INSERT INTO requisicoes_familia (item_id, quantidade, usuario) VALUES (?, ?, ?)', 
               [item_id, quantidade, usuario], function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }

            // Registrar no histórico
            db.run('INSERT INTO historico_inventario_familia (item_id, tipo_operacao, quantidade, usuario) VALUES (?, ?, ?, ?)',
                   [item_id, 'requisicao', quantidade, usuario]);

            res.json({
                message: 'Requisição criada com sucesso',
                id: this.lastID
            });
        });
    });
});

app.put('/api/requisicoes-familia/:id', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (status === 'aprovada') {
        // Buscar dados da requisição
        db.get('SELECT item_id, quantidade FROM requisicoes_familia WHERE id = ?', [id], (err, req_row) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (!req_row) {
                return res.status(404).json({ error: 'Requisição não encontrada' });
            }

            // Baixar do inventário
            db.run('UPDATE inventario_familia SET quantidade = quantidade - ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?', 
                   [req_row.quantidade, req_row.item_id], function (err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }

                // Atualizar status da requisição
                db.run('UPDATE requisicoes_familia SET status = ? WHERE id = ?', [status, id], function (err) {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    res.json({ message: 'Requisição aprovada e item baixado do inventário' });
                });
            });
        });
    } else {
        // Apenas atualizar status
        db.run('UPDATE requisicoes_familia SET status = ? WHERE id = ?', [status, id], function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Requisição não encontrada' });
            }
            res.json({ message: 'Status da requisição atualizado' });
        });
    }
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

app.post('/api/imagens/upload', upload.single('imagem'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhuma imagem foi enviada' });
    }

    const { originalname, filename, path: filepath } = req.file;
    const relativePath = filepath.replace('static/', '');

    db.run('INSERT INTO imagens (nome, caminho) VALUES (?, ?)', [originalname, relativePath], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: 'Imagem com este nome já existe' });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({
            message: 'Imagem enviada com sucesso',
            id: this.lastID,
            nome: originalname,
            caminho: relativePath
        });
    });
});

app.delete('/api/imagens/:id', (req, res) => {
    const { id } = req.params;

    // Buscar caminho da imagem antes de excluir
    db.get('SELECT caminho FROM imagens WHERE id = ?', [id], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Imagem não encontrada' });
        }

        // Excluir arquivo físico
        const fullPath = path.join('static', row.caminho);
        fs.unlink(fullPath, (fsErr) => {
            if (fsErr) {
                console.error('Erro ao excluir arquivo:', fsErr);
            }
        });

        // Excluir registro do banco
        db.run('DELETE FROM imagens WHERE id = ?', [id], function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ message: 'Imagem excluída com sucesso' });
        });
    });
});

// Rotas de saídas avulsas
app.get('/api/saidas-avulsas', (req, res) => {
    db.all('SELECT * FROM saidas_avulsas ORDER BY data_saida DESC', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Rota para relatórios
app.get('/api/relatorios/estoque', (req, res) => {
    db.all('SELECT * FROM estoque ORDER BY tipo, nome', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.get('/api/relatorios/encomendas', (req, res) => {
    const { data_inicio, data_fim, status } = req.query;
    let query = 'SELECT * FROM encomendas WHERE 1=1';
    const params = [];

    if (data_inicio) {
        query += ' AND date(data_criacao) >= ?';
        params.push(data_inicio);
    }
    if (data_fim) {
        query += ' AND date(data_criacao) <= ?';
        params.push(data_fim);
    }
    if (status && status !== 'todos') {
        query += ' AND status = ?';
        params.push(status);
    }

    query += ' ORDER BY data_criacao DESC';

    db.all(query, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.get('/api/relatorios/rotas', (req, res) => {
    const { data_inicio, data_fim, status } = req.query;
    let query = `SELECT r.*, m.nome as membro_nome 
                 FROM rotas r 
                 LEFT JOIN membros m ON r.membro_id = m.id 
                 WHERE 1=1`;
    const params = [];

    if (data_inicio) {
        query += ' AND r.data_entrega >= ?';
        params.push(data_inicio);
    }
    if (data_fim) {
        query += ' AND r.data_entrega <= ?';
        params.push(data_fim);
    }
    if (status && status !== 'todos') {
        query += ' AND r.status = ?';
        params.push(status);
    }

    query += ' ORDER BY r.data_entrega DESC, m.nome';

    db.all(query, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});

