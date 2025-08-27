const express = require('express');
const sqlite3 = require('sqlite3').verbose();
// Usa bcryptjs em vez de bcrypt puro para evitar a dependência nativa ausente.
const bcrypt = require('bcryptjs');

// Nome da coluna que identifica os itens na tabela inventario_familia. Alguns
// bancos antigos usam "item" em vez de "nome". Esta variável será
// inicializada durante a função initializeDatabase() consultando a
// estrutura da tabela via PRAGMA. Quando null, as rotas de inventário
// assumirão apenas id/quantidade/preço/imagem.
let inventarioFamiliaNameColumn = null;
let inventarioFamiliaHasCategoria = false;
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json({ limit: '10mb' }));

// Middleware de tratamento de erro para JSON malformado
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.error('Erro de JSON malformado:', err.message);
        return res.status(400).json({ error: 'JSON malformado na requisição' });
    }
    next();
});

// Middleware para garantir que respostas da API sejam sempre JSON
app.use('/api', (req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
    next();
});
// Servir arquivos estáticos na raiz e também sob o prefixo /static.
// Isso permite acessar login_simple.html tanto em /login_simple.html quanto em /static/login_simple.html.
app.use(express.static(path.join(__dirname, 'static')));
app.use('/static', express.static(path.join(__dirname, 'static')));

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

    // Criar tabela de inventário família. Por padrão usamos coluna
    // "nome" para identificar o item, mas se um banco antigo já
    // existe com coluna "item" em vez de "nome", a coluna antiga
    // permanecerá. A verificação da coluna será feita depois via PRAGMA.
    db.run(`CREATE TABLE IF NOT EXISTS inventario_familia (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT,
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

    // Detecta se a tabela inventario_familia possui coluna "nome" ou "item"
    // e define a variável global inventarioFamiliaNameColumn. Também
    // cria um índice único na coluna, se ela existir, para evitar
    // duplicidades. O índice não será criado se nenhuma coluna de nome
    // for encontrada.
    db.all('PRAGMA table_info(inventario_familia)', (err, rows) => {
        if (err) {
            console.error('Erro ao inspecionar a estrutura da tabela inventario_familia:', err.message);
            return;
        }
        const colNome = rows.find(col => col.name === 'nome');
        const colItem = rows.find(col => col.name === 'item');
        const colCategoria = rows.find(col => col.name === 'categoria');
        if (colNome) {
            inventarioFamiliaNameColumn = 'nome';
            db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_inventario_familia_nome ON inventario_familia(nome)', (idxErr) => {
                if (idxErr) {
                    console.error('Erro ao criar índice único em inventário família:', idxErr.message);
                }
            });
        } else if (colItem) {
            inventarioFamiliaNameColumn = 'item';
            db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_inventario_familia_item ON inventario_familia(item)', (idxErr) => {
                if (idxErr) {
                    console.error('Erro ao criar índice único em inventário família (coluna item):', idxErr.message);
                }
            });
        } else {
            inventarioFamiliaNameColumn = null;
            console.warn('A tabela inventario_familia não possui colunas "nome" nem "item". Operações de nome serão ignoradas.');
        }
        inventarioFamiliaHasCategoria = !!colCategoria;

        // Garante que a coluna imagem exista na tabela inventario_familia
        const colImagem = rows.find(col => col.name === 'imagem');
        if (!colImagem) {
            db.run('ALTER TABLE inventario_familia ADD COLUMN imagem TEXT', (altErr) => {
                if (altErr) {
                    console.warn('Não foi possível adicionar a coluna imagem em inventario_familia:', altErr.message);
                } else {
                    console.log('Coluna imagem adicionada à tabela inventario_familia');
                }
            });
        }
        // Também detecta subcategoria; se existir e for NOT NULL, vamos usar default 'Geral'
        const colSubcategoria = rows.find(col => col.name === 'subcategoria');
        if (colSubcategoria && colSubcategoria.notnull === 1) {
            db.run("UPDATE inventario_familia SET subcategoria = COALESCE(subcategoria, 'Geral')", (updErr) => {
                if (updErr) {
                    console.warn('Falha ao definir default para subcategoria:', updErr.message);
                }
            });
        }

        // Após determinar a coluna, podemos fazer o seeding de itens de exemplo se
        // a tabela estiver vazia. Inserimos somente se a coluna existir.
        if (inventarioFamiliaNameColumn) {
            db.all('SELECT COUNT(*) as count FROM inventario_familia', (countErr, countRows) => {
                if (countErr) return;
                if (countRows[0].count === 0) {
                    const seedItems = [
                        { nome: 'Alumínio', quantidade: 0, preco: 0, imagem: null },
                        { nome: 'Cobre', quantidade: 0, preco: 0, imagem: null },
                        { nome: 'Emb Plástica', quantidade: 0, preco: 0, imagem: null },
                        { nome: 'Ferro', quantidade: 0, preco: 0, imagem: null },
                        { nome: 'Titânio', quantidade: 0, preco: 0, imagem: null }
                    ];
                    seedItems.forEach(item => {
                        const insertCols = [inventarioFamiliaNameColumn, 'quantidade', 'preco', 'imagem'].join(', ');
                        const placeholders = ['?', '?', '?', '?'].join(', ');
                        const values = [item.nome, item.quantidade, item.preco, item.imagem];
                        db.run(`INSERT INTO inventario_familia (${insertCols}) VALUES (${placeholders})`, values);
                    });
                }
            });
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

    // Migração de colunas para a tabela rotas (compatibilidade com bancos antigos)
    db.all('PRAGMA table_info(rotas)', (err, rotasCols) => {
        if (err) {
            console.warn('Falha ao inspecionar a tabela rotas:', err.message);
            return;
        }
        const hasMembroNome = rotasCols.some(c => c.name === 'membro_nome');
        const hasPagamento = rotasCols.some(c => c.name === 'pagamento');
        const hasPagante = rotasCols.some(c => c.name === 'pagante_username');
        const hasComprovante = rotasCols.some(c => c.name === 'comprovante_path');
        const hasDataPagamento = rotasCols.some(c => c.name === 'data_pagamento');

        if (!hasMembroNome) {
            db.run('ALTER TABLE rotas ADD COLUMN membro_nome TEXT', (e) => e && console.warn('Erro ao adicionar coluna membro_nome em rotas:', e.message));
        }
        if (!hasPagamento) {
            db.run('ALTER TABLE rotas ADD COLUMN pagamento REAL DEFAULT 0', (e) => e && console.warn('Erro ao adicionar coluna pagamento em rotas:', e.message));
        }
        if (!hasPagante) {
            db.run('ALTER TABLE rotas ADD COLUMN pagante_username TEXT', (e) => e && console.warn('Erro ao adicionar coluna pagante_username em rotas:', e.message));
        }
        if (!hasComprovante) {
            db.run('ALTER TABLE rotas ADD COLUMN comprovante_path TEXT', (e) => e && console.warn('Erro ao adicionar coluna comprovante_path em rotas:', e.message));
        }
        if (!hasDataPagamento) {
            db.run('ALTER TABLE rotas ADD COLUMN data_pagamento DATETIME', (e) => e && console.warn('Erro ao adicionar coluna data_pagamento em rotas:', e.message));
        }
    });

    // Consolidar e remover duplicatas no estoque. Agrupamos por tipo e pelo
    // nome normalizado (trim e lower), somamos as quantidades e mantemos
    // o registro de menor rowid. Não criamos mais um índice único,
    // pois bancos de dados antigos ou valores acentuados podem
    // causar conflitos. O front‑end deduplica as opções quando exibe
    // os itens.
    db.serialize(() => {
        db.all(`SELECT tipo,
                       LOWER(TRIM(nome)) AS norm_nome,
                       SUM(quantidade) AS total_qty,
                       MIN(rowid) AS keep_rowid
                FROM estoque
                GROUP BY tipo, norm_nome
                HAVING COUNT(*) > 1`, (selErr, rows) => {
            if (selErr) {
                console.error('Erro ao selecionar duplicatas do estoque:', selErr.message);
                return;
            }
            rows.forEach(row => {
                db.run('UPDATE estoque SET quantidade = ? WHERE rowid = ?', [row.total_qty, row.keep_rowid]);
                db.run('DELETE FROM estoque WHERE tipo = ? AND LOWER(TRIM(nome)) = ? AND rowid <> ?', [row.tipo, row.norm_nome, row.keep_rowid]);
            });
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

    // Seeding de inventário família removido: agora é feito de forma dinâmica na
    // detecção da estrutura da tabela. Veja o código PRAGMA acima.

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

    // Corrigir estoque negativo (se existir)
    corrigirEstoqueNegativo();

    console.log('🚀 Servidor rodando na porta', PORT);
    console.log('📱 Acesse: http://localhost:' + PORT + '/static/login_simple.html');
    console.log('👤 Usuário: tofu | Senha: tofu$2025');
}

// Função para corrigir estoque negativo
function corrigirEstoqueNegativo() {
    console.log('🔍 Verificando e corrigindo estoque negativo...');
    
    db.all('SELECT id, tipo, nome, quantidade FROM estoque WHERE quantidade < 0', (err, rows) => {
        if (err) {
            console.error('Erro ao verificar estoque negativo:', err.message);
            return;
        }
        
        if (rows.length === 0) {
            console.log('✅ Nenhum item com estoque negativo encontrado');
            return;
        }
        
        console.log(`⚠️  Encontrados ${rows.length} itens com estoque negativo, corrigindo...`);
        
        rows.forEach(row => {
            console.log(`🔧 Corrigindo ${row.nome}: ${row.quantidade} → 0`);
            db.run('UPDATE estoque SET quantidade = 0, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?', [row.id], (err) => {
                if (err) {
                    console.error(`❌ Erro ao corrigir ${row.nome}:`, err.message);
                } else {
                    console.log(`✅ ${row.nome} corrigido com sucesso`);
                }
            });
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
// COMENTADO: Estava criando rotas automaticamente na inicialização
// setTimeout(generateRotasParaProximaSemana, 1000);

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

// Alias para a rota de login utilizada pelo front-end login_simple.html. Aceita
// POST em /api/auth/login e delega ao mesmo handler de /api/login.
app.post('/api/auth/login', (req, res) => {
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
            user: { id: user.id, username: user.username, role: user.role }
        });
    });
});

// Rota de registro de usuário utilizada por login_simple.html.
// Permite criar uma nova conta com role 'membro'. Também cadastra
// automaticamente o membro na tabela membros com o nome, RG e telefone
// fornecidos. Por motivos de simplicidade e segurança básica, caso o
// username já exista, retorna erro.
app.post('/api/auth/register', (req, res) => {
    const { username, password, nome, rg, telefone } = req.body;
    if (!username || !password || !nome) {
        return res.status(400).json({ error: 'Dados incompletos para cadastro' });
    }
    // Verificar se já existe usuário com o mesmo username
    db.get('SELECT id FROM usuarios WHERE username = ?', [username], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (row) {
            return res.status(400).json({ error: 'Nome de usuário já está em uso' });
        }
        // Hash da senha
        const hashed = bcrypt.hashSync(password, 10);
        // Inserir usuário com role padrão 'membro'
        db.run(
            'INSERT INTO usuarios (username, password, role) VALUES (?, ?, ?)',
            [username, hashed, 'membro'],
            function (userErr) {
                if (userErr) {
                    return res.status(500).json({ error: userErr.message });
                }
                const usuarioId = this.lastID;
                // Inserir membro associado
                db.run(
                    'INSERT INTO membros (nome, rg, telefone, cargo) VALUES (?, ?, ?, ?)',
                    [nome, rg || null, telefone || null, 'membro'],
                    function (mErr) {
                        if (mErr) {
                            return res.status(500).json({ error: mErr.message });
                        }
                        return res.json({ message: 'Cadastro realizado com sucesso' });
                    }
                );
            }
        );
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
                            // Atualiza status para pronto (sem baixar estoque)
                            await new Promise((resUpd, rejUpd) => {
                                db.run('UPDATE encomendas SET status = ? WHERE id = ?', ['pronto', pedido.id], function(errUpd) {
                                    if (errUpd) {
                                        return rejUpd(errUpd);
                                    }
                                    console.log(`🎉 Encomenda ${pedido.id} marcada como pronta (estoque reservado logicamente).`);
                                    resUpd();
                                });
                            });
                            // Atualiza estoque em memória para reserva lógica (sem baixar do banco)
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
app.get('/api/encomendas', authenticateToken, (req, res) => {
    db.all('SELECT * FROM encomendas ORDER BY data_criacao DESC', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.post('/api/encomendas', authenticateToken, async (req, res) => {
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

app.put('/api/encomendas/:id', authenticateToken, (req, res) => {
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
                        // A encomenda estava pronta (estoque reservado logicamente) e agora foi entregue: baixar estoque efetivamente.
                        // Primeiro baixa as quantidades anteriores, depois ajusta se houve mudanças.
                        
                        // Baixar estoque das quantidades anteriores (que estavam apenas reservadas)
                        baixarEstoquePorEncomenda(q5Anterior, q9Anterior, q762Anterior, q12Anterior)
                            .then(() => {
                                // Depois ajustar se as quantidades mudaram
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
                                    return baixarEstoquePorEncomenda(baixas.q5, baixas.q9, baixas.q762, baixas.q12)
                                        .then(() => devolverEstoquePorEncomenda(devolucoes.q5, devolucoes.q9, devolucoes.q762, devolucoes.q12));
                                }
                                return Promise.resolve();
                            })
                            .then(() => {
                                sendAndVerify({ message: 'Encomenda entregue e estoque baixado com sucesso' });
                            })
                            .catch(errBaixar => {
                                console.error('Erro ao baixar estoque:', errBaixar);
                                sendAndVerify({ message: 'Encomenda atualizada, mas erro ao baixar estoque' });
                            });
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

app.delete('/api/encomendas/:id', authenticateToken, (req, res) => {
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
app.get('/api/estoque', authenticateToken, (req, res) => {
    // Consolida duplicatas somando quantidades por tipo e nome
    db.all('SELECT tipo, nome, SUM(quantidade) as quantidade, AVG(preco) as preco, MAX(data_atualizacao) as data_atualizacao FROM estoque GROUP BY tipo, nome ORDER BY tipo, nome', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Atualizar estoque (quantidade). Disponível para todos os usuários autenticados.
app.put('/api/estoque/:tipo/:item', authenticateToken, (req, res) => {
    const { tipo, item } = req.params;
    const { quantidade } = req.body;

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

// Atualizar estoque adicionando materiais ou munições. Disponível para todos os usuários autenticados.
app.post('/api/estoque/adicionar', authenticateToken, (req, res) => {
    const { tipo, item, quantidade, baixar_materiais } = req.body;

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

// Rota para retirar itens do estoque - disponível para todos os usuários autenticados
app.post('/api/estoque/retirar', authenticateToken, (req, res) => {
    const { tipo, item, quantidade, destinos } = req.body;
    const usuario = req.user && req.user.username;

    console.log(`🔍 RETIRADA DE ESTOQUE - Tipo: ${tipo}, Item: ${item}, Quantidade: ${quantidade}, Usuário: ${usuario}`);

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
            
            const estoqueDisponivel = rowSel ? (rowSel.quantidade || 0) : 0;
            
            console.log(`📊 Estoque disponível para ${item}: ${estoqueDisponivel}, Quantidade solicitada: ${qtd}`);
            
            // Validação rigorosa: não permitir estoque negativo
            if (estoqueDisponivel < qtd) {
                console.log(`❌ Estoque insuficiente para ${item}`);
                return res.status(400).json({ 
                    error: `Estoque insuficiente. Disponível: ${estoqueDisponivel}, Solicitado: ${qtd}` 
                });
            }

            // Verificar se a retirada resultaria em estoque negativo
            if (estoqueDisponivel - qtd < 0) {
                console.log(`❌ Retirada resultaria em estoque negativo para ${item}`);
                return res.status(400).json({ 
                    error: `Retirada resultaria em estoque negativo. Disponível: ${estoqueDisponivel}, Após retirada: ${estoqueDisponivel - qtd}` 
                });
            }

        // Retirar do estoque
        console.log(`🔄 Executando UPDATE: quantidade = quantidade - ${qtd} WHERE tipo = ${tipo} AND nome = ${item}`);
        db.run('UPDATE estoque SET quantidade = quantidade - ?, data_atualizacao = CURRENT_TIMESTAMP WHERE tipo = ? AND nome = ?', 
               [qtd, tipo, item], function(errUpd) {
            if (errUpd) {
                console.error(`❌ Erro no UPDATE:`, errUpd.message);
                return res.status(500).json({ error: errUpd.message });
            }
            
            console.log(`✅ UPDATE executado com sucesso. Registros afetados: ${this.changes}`);

            // Registrar saída avulsa
            const destinoStr = destinosArray.length > 0 ? destinosArray.join(', ') : 'Não especificado';
            db.run('INSERT INTO saidas_avulsas (tipo, item, quantidade, destino, usuario) VALUES (?, ?, ?, ?, ?)',
                   [tipo, item, qtd, destinoStr, usuario], function(errSaida) {
                if (errSaida) {
                    console.error('Erro ao registrar saída avulsa:', errSaida.message);
                }
                res.json({ 
                    message: `Item retirado do estoque com sucesso. Estoque restante: ${estoqueDisponivel - qtd}`,
                    estoque_restante: estoqueDisponivel - qtd
                });
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

// Permite fabricar munições em lotes. Disponível para todos os usuários autenticados.
app.post('/api/estoque/fabricar', authenticateToken, (req, res) => {
    const { tipo_municao, lotes } = req.body;

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
app.get('/api/rotas', authenticateToken, (req, res) => {
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

app.post('/api/rotas', authenticateToken, (req, res) => {
    const { membro_id, quantidade, data_entrega } = req.body;
    const qtdRotas = quantidade || 1;
    const membroId = parseInt(membro_id);

    // Validar dados de entrada
    if (!membroId || isNaN(membroId)) {
        return res.status(400).json({ error: 'ID do membro é obrigatório e deve ser um número válido' });
    }
    if (!data_entrega) {
        return res.status(400).json({ error: 'Data de entrega é obrigatória' });
    }

    // Primeiro, buscar o nome do membro
    db.get('SELECT nome FROM membros WHERE id = ?', [membroId], (errMembro, membro) => {
        if (errMembro) {
            return res.status(500).json({ error: errMembro.message });
        }
        if (!membro) {
            return res.status(404).json({ error: `Membro com ID ${membroId} não encontrado` });
        }

        // Calcular materiais necessários: 160 de cada material + 13 titânios por rota
        const materiaisNecessarios = [
            { nome: 'Alumínio', quantidade: 160 * qtdRotas },
            { nome: 'Emb Plástica', quantidade: 160 * qtdRotas },
            { nome: 'Cobre', quantidade: 160 * qtdRotas },
            { nome: 'Ferro', quantidade: 160 * qtdRotas },
            { nome: 'Titânio', quantidade: 13 * qtdRotas }
        ];

        // Verificar se há material suficiente
        db.all('SELECT nome, SUM(quantidade) as quantidade FROM estoque WHERE tipo = "material" GROUP BY nome', (errMat, rows) => {
            if (errMat) {
                return res.status(500).json({ error: errMat.message });
            }

            const estoqueAtual = {};
            rows.forEach(row => {
                estoqueAtual[row.nome] = row.quantidade;
            });

            // Verificar se há material suficiente
            const faltaMaterial = materiaisNecessarios.find(mat => 
                (estoqueAtual[mat.nome] || 0) < mat.quantidade
            );

            if (faltaMaterial) {
                return res.status(400).json({ 
                    error: `Material insuficiente: ${faltaMaterial.nome}. Necessário: ${faltaMaterial.quantidade}, Disponível: ${estoqueAtual[faltaMaterial.nome] || 0}` 
                });
            }

            // Criar a rota com status "entregue" e pagamento de R$ 16.000 por rota
            const pagamentoTotal = 16000 * qtdRotas;
            db.run('INSERT INTO rotas (membro_id, membro_nome, quantidade, data_entrega, status, pagamento) VALUES (?, ?, ?, ?, ?, ?)', 
                   [membroId, membro.nome, qtdRotas, data_entrega, 'entregue', pagamentoTotal], function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint failed')) {
                        return res.status(400).json({ error: 'Já existe uma rota para este membro nesta data' });
                    }
                    return res.status(500).json({ error: err.message });
                }

                // Adicionar materiais ao estoque (produção)
                let materiaisProcessados = 0;
                let erroMaterial = null;

                materiaisNecessarios.forEach(material => {
                    db.run('UPDATE estoque SET quantidade = quantidade + ?, data_atualizacao = CURRENT_TIMESTAMP WHERE tipo = "material" AND nome = ?', 
                           [material.quantidade, material.nome], function(errUpdate) {
                        materiaisProcessados++;
                        
                        if (errUpdate && !erroMaterial) {
                            erroMaterial = errUpdate;
                        }

                        // Quando todos os materiais foram processados
                        if (materiaisProcessados === materiaisNecessarios.length) {
                            if (erroMaterial) {
                                console.error('Erro ao adicionar material:', erroMaterial.message);
                                return res.status(500).json({ 
                                    error: 'Rota criada mas erro ao adicionar materiais: ' + erroMaterial.message 
                                });
                            }

                            res.json({
                                message: `Rota cadastrada com sucesso! Materiais adicionados ao estoque: ${materiaisNecessarios.map(m => `${m.quantidade} ${m.nome}`).join(', ')}`,
                                id: this.lastID,
                                pagamento: pagamentoTotal
                            });
                        }
                    });
                });
            });
        });
    });
});

app.put('/api/rotas/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { quantidade, status } = req.body;

    if (!quantidade || !status) {
        return res.status(400).json({ error: 'Quantidade e status são obrigatórios' });
    }

    // Recupera dados anteriores da rota para controle de estoque
    db.get('SELECT status, quantidade FROM rotas WHERE id = ?', [id], (errSelect, row) => {
        if (errSelect) {
            return res.status(500).json({ error: errSelect.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Rota não encontrada' });
        }
        
        const statusAnterior = row.status;
        const quantidadeAnterior = row.quantidade;
        
        // Atualiza a rota
        db.run('UPDATE rotas SET quantidade = ?, status = ? WHERE id = ?', [quantidade, status, id], function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }

            // Controle de estoque baseado em mudanças de status
            // Se a rota estava entregue e agora foi cancelada, remover materiais do estoque
            if (statusAnterior === 'entregue' && status === 'cancelada') {
                removerMateriaisPorRota(quantidadeAnterior).then(() => {
                    res.json({ 
                        message: `Rota cancelada e materiais removidos do estoque (${160 * quantidadeAnterior} de cada material + ${13 * quantidadeAnterior} titânio)` 
                    });
                }).catch(errStock => {
                    console.error('Erro ao remover materiais após cancelamento:', errStock);
                    res.json({ message: 'Rota cancelada, mas erro ao remover materiais do estoque' });
                });
            } 
            // Se mudou de cancelada para entregue, adicionar materiais ao estoque novamente
            else if (statusAnterior === 'cancelada' && status === 'entregue') {
                adicionarMateriaisPorRota(quantidade).then(() => {
                    res.json({ 
                        message: `Rota reativada e materiais adicionados ao estoque (${160 * quantidade} de cada material + ${13 * quantidade} titânio)` 
                    });
                }).catch(errStock => {
                    console.error('Erro ao adicionar materiais após reativação:', errStock);
                    res.json({ message: 'Rota reativada, mas erro ao adicionar materiais ao estoque' });
                });
            }
            // Se mudou apenas a quantidade mas continua entregue, ajustar estoque
            else if (statusAnterior === 'entregue' && status === 'entregue' && quantidade !== quantidadeAnterior) {
                const diferenca = quantidade - quantidadeAnterior;
                if (diferenca > 0) {
                    // Aumentou quantidade: adicionar mais materiais
                    adicionarMateriaisPorRota(diferenca).then(() => {
                        res.json({ message: `Quantidade aumentada e materiais adicionais adicionados ao estoque` });
                    }).catch(errStock => {
                        console.error('Erro ao adicionar materiais adicionais:', errStock);
                        res.json({ message: 'Quantidade atualizada, mas erro ao adicionar materiais adicionais' });
                    });
                } else {
                    // Diminuiu quantidade: remover materiais excedentes
                    removerMateriaisPorRota(Math.abs(diferenca)).then(() => {
                        res.json({ message: `Quantidade reduzida e materiais excedentes removidos do estoque` });
                    }).catch(errStock => {
                        console.error('Erro ao remover materiais excedentes:', errStock);
                        res.json({ message: 'Quantidade atualizada, mas erro ao remover materiais excedentes' });
                    });
                }
            }
            else {
                res.json({ message: 'Rota atualizada com sucesso' });
            }
        });
    });
});

/**
 * Remove materiais do estoque quando uma rota é cancelada ou excluída.
 * Para cada rota cancelada, remove 160 unidades de Alumínio, Cobre, Emb Plástica e Ferro,
 * e 13 unidades de Titânio. Retorna uma Promise para permitir encadeamento.
 */
function removerMateriaisPorRota(qtd) {
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
        let hasError = false;
        
        updates.forEach(item => {
            // Primeiro verificar o estoque atual, depois atualizar limitando a 0
            db.get('SELECT quantidade FROM estoque WHERE tipo = "material" AND nome = ?', [item.nome], (errSelect, row) => {
                if (errSelect) {
                    console.error('Erro ao verificar estoque de', item.nome, ':', errSelect.message);
                    hasError = true;
                    pending--;
                    if (pending === 0) {
                        if (hasError) {
                            reject(new Error('Erro ao remover alguns materiais'));
                        } else {
                            resolve();
                        }
                    }
                    return;
                }
                
                const estoqueAtual = row ? (row.quantidade || 0) : 0;
                const novaQuantidade = Math.max(0, estoqueAtual - item.quantidade);
                
                db.run('UPDATE estoque SET quantidade = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE tipo = "material" AND nome = ?', 
                       [novaQuantidade, item.nome], function(errUpdate) {
                    if (errUpdate) {
                        console.error('Erro ao remover material:', item.nome, errUpdate.message);
                        hasError = true;
                    }
                    pending--;
                    if (pending === 0) {
                        if (hasError) {
                            reject(new Error('Erro ao remover alguns materiais'));
                        } else {
                            resolve();
                        }
                    }
                });
            });
        });
    });
}

/**
 * Adiciona materiais ao estoque quando uma rota é criada (produção).
 * Para cada rota, adiciona 160 unidades de Alumínio, Cobre, Emb Plástica e Ferro,
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
        let hasError = false;
        
        updates.forEach(item => {
            db.run('UPDATE estoque SET quantidade = quantidade + ?, data_atualizacao = CURRENT_TIMESTAMP WHERE tipo = "material" AND nome = ?', 
                   [item.quantidade, item.nome], function(err) {
                if (err) {
                    console.error('Erro ao adicionar material:', item.nome, err.message);
                    hasError = true;
                }
                pending--;
                if (pending === 0) {
                    if (hasError) {
                        reject(new Error('Erro ao adicionar alguns materiais'));
                    } else {
                        resolve();
                    }
                }
            });
        });
    });
}

app.delete('/api/rotas/:id', authenticateToken, (req, res) => {
    const { id } = req.params;

    // Primeiro, verificar se a rota existe e recuperar dados para controle de estoque
    db.get('SELECT status, quantidade FROM rotas WHERE id = ?', [id], (errSelect, rota) => {
        if (errSelect) {
            return res.status(500).json({ error: errSelect.message });
        }
        if (!rota) {
            return res.status(404).json({ error: 'Rota não encontrada' });
        }

        // Se a rota estava entregue, remover materiais do estoque
        if (rota.status === 'entregue') {
            removerMateriaisPorRota(rota.quantidade).then(() => {
                // Agora excluir a rota
                db.run('DELETE FROM rotas WHERE id = ?', [id], function (err) {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    if (this.changes === 0) {
                        return res.status(404).json({ error: 'Rota não encontrada' });
                    }
                    res.json({ 
                        message: `Rota excluída com sucesso. Materiais removidos do estoque: ${160 * rota.quantidade} de cada material + ${13 * rota.quantidade} titânio` 
                    });
                });
            }).catch(errStock => {
                console.error('Erro ao remover materiais após exclusão:', errStock);
                res.status(500).json({ error: 'Erro ao remover materiais do estoque' });
            });
        } else {
            // Se não estava entregue, apenas excluir
            db.run('DELETE FROM rotas WHERE id = ?', [id], function (err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Rota não encontrada' });
                }
                res.json({ message: 'Rota excluída com sucesso' });
            });
        }
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
app.get('/api/inventario-familia', authenticateToken, (req, res) => {
    // Seleciona os itens do inventário família ordenados pelo nome, se existir.
    const orderBy = inventarioFamiliaNameColumn ? `ORDER BY ${inventarioFamiliaNameColumn}` : 'ORDER BY id';
    const query = `SELECT * FROM inventario_familia ${orderBy}`;
    db.all(query, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        // Para garantir compatibilidade, se a coluna de nome não existir,
        // mapeia o valor para a propriedade nome no objeto retornado.
        if (!inventarioFamiliaNameColumn) {
            // Nada a mapear
        } else if (inventarioFamiliaNameColumn !== 'nome') {
            // Renomear coluna existente para "nome" na resposta
            rows = rows.map(r => {
                r.nome = r[inventarioFamiliaNameColumn];
                return r;
            });
        }
        res.json(rows);
    });
});

app.post('/api/inventario-familia', authenticateToken, (req, res) => {
    const { nome, item, categoria, subcategoria, quantidade, preco, imagem } = req.body;
    
    // Validação dos dados de entrada
    if (!categoria || !item || typeof quantidade !== 'number' || quantidade < 0) {
        return res.status(400).json({ error: 'Dados inválidos: categoria, item e quantidade são obrigatórios' });
    }
    
    // Log para debug
    console.log('🔍 POST /inventario-familia:', { nome, item, categoria, quantidade, preco, imagem });
    console.log('🔍 inventarioFamiliaNameColumn:', inventarioFamiliaNameColumn);
    
    // Prepara consulta de inserção dependendo da coluna de nome disponível
    let query;
    let values;
    const nomeValor = nome !== undefined && nome !== null ? nome : item;
    
    if (inventarioFamiliaNameColumn) {
        if (inventarioFamiliaHasCategoria) {
            // Se existir subcategoria na tabela, tenta preencher também
            db.all('PRAGMA table_info(inventario_familia)', (e2, cols2) => {
                const hasSub = !e2 && cols2 && cols2.find(c => c.name === 'subcategoria');
                if (hasSub) {
                    query = `INSERT INTO inventario_familia (${inventarioFamiliaNameColumn}, quantidade, preco, imagem, categoria, subcategoria) VALUES (?, ?, ?, ?, ?, ?)`;
                    values = [nomeValor, quantidade || 0, preco || 0, imagem, categoria || 'Geral', subcategoria || 'Geral'];
                } else {
                    query = `INSERT INTO inventario_familia (${inventarioFamiliaNameColumn}, quantidade, preco, imagem, categoria) VALUES (?, ?, ?, ?, ?)`;
                    values = [nomeValor, quantidade || 0, preco || 0, imagem, categoria || 'Geral'];
                }
                console.log('🔍 Query com subcategoria:', query, values);
                proceedInsert();
            });
            return;
        } else {
            query = `INSERT INTO inventario_familia (${inventarioFamiliaNameColumn}, quantidade, preco, imagem) VALUES (?, ?, ?, ?)`;
            values = [nomeValor, quantidade || 0, preco || 0, imagem];
        }
    } else {
        // Não há coluna de nome: inserimos apenas quantidade, preco, imagem
        if (inventarioFamiliaHasCategoria) {
            db.all('PRAGMA table_info(inventario_familia)', (e2, cols2) => {
                const hasSub = !e2 && cols2 && cols2.find(c => c.name === 'subcategoria');
                if (hasSub) {
                    query = 'INSERT INTO inventario_familia (quantidade, preco, imagem, categoria, subcategoria) VALUES (?, ?, ?, ?, ?)';
                    values = [quantidade || 0, preco || 0, imagem, categoria || 'Geral', subcategoria || 'Geral'];
                } else {
                    query = 'INSERT INTO inventario_familia (quantidade, preco, imagem, categoria) VALUES (?, ?, ?, ?)';
                    values = [quantidade || 0, preco || 0, imagem, categoria || 'Geral'];
                }
                console.log('🔍 Query sem nome:', query, values);
                proceedInsert();
            });
            return;
        } else {
            query = 'INSERT INTO inventario_familia (quantidade, preco, imagem) VALUES (?, ?, ?, ?)';
            values = [quantidade || 0, preco || 0, imagem];
        }
    }
    
    console.log('🔍 Query final:', query, values);
    proceedInsert();

    function proceedInsert() {
        console.log('🔍 Executando query:', query);
        console.log('🔍 Com valores:', values);
        
        db.run(query, values, function (err) {
            if (err) {
                console.error('❌ Erro na inserção:', err.message);
                if (err.message && err.message.includes('UNIQUE constraint failed')) {
                    return res.status(400).json({ error: 'Item já cadastrado' });
                }
                return res.status(500).json({ error: err.message });
            }
            
            console.log('✅ Item inserido com sucesso, ID:', this.lastID);
            res.json({
                message: 'Item adicionado ao inventário com sucesso',
                id: this.lastID
            });
        });
    }
});

app.put('/api/inventario-familia/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { nome, item, categoria, quantidade, preco, imagem } = req.body;

    console.log('🔍 PUT /inventario-familia:', { id, nome, item, categoria, quantidade, preco, imagem });

    // Primeiro, buscar o item atual para preservar dados existentes
    db.get(`SELECT * FROM inventario_familia WHERE id = ?`, [id], (err, itemAtual) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!itemAtual) {
            return res.status(404).json({ error: 'Item não encontrado' });
        }

        console.log('🔍 Item atual:', itemAtual);

        // Usar valores existentes se não fornecidos, preservando dados
        const nomeValor = nome !== undefined && nome !== null ? nome : 
                         (item !== undefined && item !== null ? item : 
                         (inventarioFamiliaNameColumn ? itemAtual[inventarioFamiliaNameColumn] : null));
        
        const quantidadeValor = quantidade !== undefined ? quantidade : itemAtual.quantidade;
        const precoValor = preco !== undefined ? preco : itemAtual.preco;
        const imagemValor = imagem !== undefined ? imagem : itemAtual.imagem;
        const categoriaValor = categoria !== undefined ? categoria : itemAtual.categoria;

        console.log('🔍 Valores para atualização:', { nomeValor, quantidadeValor, precoValor, imagemValor, categoriaValor });

        // Monta consulta de atualização dependendo da coluna de nome disponível
        let updateQuery;
        let params;
        
        if (inventarioFamiliaNameColumn) {
            if (inventarioFamiliaHasCategoria) {
                updateQuery = `UPDATE inventario_familia SET ${inventarioFamiliaNameColumn} = ?, quantidade = ?, preco = ?, imagem = ?, categoria = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?`;
                params = [nomeValor, quantidadeValor, precoValor, imagemValor, categoriaValor, id];
            } else {
                updateQuery = `UPDATE inventario_familia SET ${inventarioFamiliaNameColumn} = ?, quantidade = ?, preco = ?, imagem = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?`;
                params = [nomeValor, quantidadeValor, precoValor, imagemValor, id];
            }
        } else {
            if (inventarioFamiliaHasCategoria) {
                updateQuery = 'UPDATE inventario_familia SET quantidade = ?, preco = ?, imagem = ?, categoria = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?';
                params = [quantidadeValor, precoValor, imagemValor, categoriaValor, id];
            } else {
                updateQuery = 'UPDATE inventario_familia SET quantidade = ?, preco = ?, imagem = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?';
                params = [quantidadeValor, precoValor, imagemValor, id];
            }
        }

        console.log('🔍 Query de atualização:', updateQuery);
        console.log('🔍 Parâmetros:', params);

        db.run(updateQuery, params, function (err) {
            if (err) {
                console.error('❌ Erro na atualização:', err.message);
                if (err.message && err.message.includes('UNIQUE constraint failed')) {
                    return res.status(400).json({ error: 'Nome já existe para outro item' });
                }
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Item não encontrado' });
            }
            
            console.log('✅ Item atualizado com sucesso');
            res.json({ message: 'Item atualizado com sucesso' });
        });
    });
});

app.delete('/api/inventario-familia/:id', authenticateToken, (req, res) => {
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
    // Seleciona requisições junto com dados do inventário família. Usa a coluna de nome
    // configurada ou retorna nulo se não houver coluna
    const nomeCol = inventarioFamiliaNameColumn ? `i.${inventarioFamiliaNameColumn} as item_nome` : 'NULL as item_nome';
    const query = `SELECT r.*, ${nomeCol}, i.preco as item_preco 
                   FROM requisicoes_familia r 
                   LEFT JOIN inventario_familia i ON r.item_id = i.id 
                   ORDER BY r.data_solicitacao DESC`;
    db.all(query, (err, rows) => {
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

// Endpoint para registrar pagamento de rota
app.put('/api/rotas/:id/pagamento', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { pagante_id } = req.body;

    if (!pagante_id) {
        return res.status(400).json({ error: 'ID do pagante é obrigatório' });
    }

    // Verificar se a rota existe e está entregue
    db.get('SELECT * FROM rotas WHERE id = ?', [id], (err, rota) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!rota) {
            return res.status(404).json({ error: 'Rota não encontrada' });
        }
        if (rota.status !== 'entregue') {
            return res.status(400).json({ error: 'Só é possível registrar pagamento para rotas entregues' });
        }

        // Verificar se o usuário pagante existe e é líder ou admin
        db.get('SELECT username, role FROM usuarios WHERE id = ?', [pagante_id], (errUser, usuario) => {
            if (errUser) {
                return res.status(500).json({ error: errUser.message });
            }
            if (!usuario) {
                return res.status(404).json({ error: 'Usuário pagante não encontrado' });
            }
            if (usuario.role !== 'lider' && usuario.role !== 'admin') {
                return res.status(403).json({ error: 'Apenas líderes e administradores podem registrar pagamentos' });
            }

            // Registrar o pagamento
            const dataPagamento = new Date().toISOString();
            db.run('UPDATE rotas SET pagante_username = ?, data_pagamento = ? WHERE id = ?', 
                   [usuario.username, dataPagamento, id], function(err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                
                res.json({ 
                    message: 'Pagamento registrado com sucesso',
                    pagante: usuario.username,
                    data_pagamento: dataPagamento
                });
            });
        });
    });
});

// Endpoint para registrar histórico do inventário família
app.post('/api/historico-inventario-familia', authenticateToken, (req, res) => {
    const { item_id, tipo_operacao, quantidade, usuario, motivo } = req.body;

    if (!item_id || !tipo_operacao || !quantidade || !usuario) {
        return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos' });
    }

    // Verificar se o item existe
    db.get('SELECT id FROM inventario_familia WHERE id = ?', [item_id], (err, item) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!item) {
            return res.status(404).json({ error: 'Item não encontrado' });
        }

        // Inserir no histórico
        db.run('INSERT INTO historico_inventario_familia (item_id, tipo_operacao, quantidade, usuario, data_operacao) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)', 
               [item_id, tipo_operacao, quantidade, usuario], function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            res.json({ 
                message: 'Histórico registrado com sucesso',
                id: this.lastID
            });
        });
    });
});

// Endpoint para listar usuários (apenas para administradores)
app.get('/api/usuarios', authenticateToken, (req, res) => {
    // Verificar se o usuário é administrador
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Acesso negado. Apenas administradores podem listar usuários.' });
    }

    db.all('SELECT id, username, role FROM usuarios ORDER BY username', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Endpoint para excluir item específico do inventário família
app.delete('/api/inventario-familia/item/:nome', authenticateToken, (req, res) => {
    const { nome } = req.params;
    
    // Verificar se o usuário é administrador ou líder
    if (req.user.role !== 'admin' && req.user.role !== 'lider') {
        return res.status(403).json({ error: 'Acesso negado. Apenas administradores e líderes podem excluir itens.' });
    }

    console.log(`🗑️ Tentando excluir item: ${nome}`);

    // Construir a query de exclusão baseada na coluna de nome disponível
    let deleteQuery;
    let deleteParams;
    
    if (inventarioFamiliaNameColumn) {
        deleteQuery = `DELETE FROM inventario_familia WHERE ${inventarioFamiliaNameColumn} = ?`;
        deleteParams = [nome];
    } else {
        // Se não há coluna de nome, não é possível excluir por nome
        return res.status(400).json({ error: 'Não é possível excluir itens por nome nesta versão do banco' });
    }

    db.run(deleteQuery, deleteParams, function (err) {
        if (err) {
            console.error(`❌ Erro ao excluir item ${nome}:`, err.message);
            return res.status(500).json({ error: err.message });
        }
        
        if (this.changes === 0) {
            console.log(`ℹ️ Item ${nome} não encontrado para exclusão`);
            return res.status(404).json({ error: 'Item não encontrado' });
        }
        
        console.log(`✅ Item ${nome} excluído com sucesso`);
        res.json({ 
            message: `Item ${nome} excluído com sucesso`,
            itens_removidos: this.changes
        });
    });
});



