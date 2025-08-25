# Sistema de Controle da Facção - Node.js

Sistema completo de controle para facções de GTA RP desenvolvido em Node.js/Express com SQLite.

## 🚀 Funcionalidades

- ✅ **Sistema de Login** - Autenticação JWT
- ✅ **Gestão de Membros** - Cadastro e controle de membros
- ✅ **Controle de Rotas** - Gerenciamento de entregas
- ✅ **Sistema de Encomendas** - Pedidos com cálculo automático de comissões
- ✅ **Controle de Estoque** - Materiais e munições
- ✅ **Sistema de Fabricação** - Produção de munições
- ✅ **Relatórios** - Análises e estatísticas
- ✅ **Upload de Imagens** - Gerenciamento de arquivos
- ✅ **Layout Responsivo** - Funciona em desktop e mobile

## 📋 Pré-requisitos

- Node.js 14+ 
- npm ou yarn

## 🔧 Instalação

1. Clone ou baixe o projeto
2. Instale as dependências:
```bash
npm install
```

3. Inicie o servidor:
```bash
npm start
```

4. Acesse o sistema:
```
http://localhost:5000
```

## 👤 Credenciais Padrão

- **Usuário:** tofu
- **Senha:** tofu$2025

## 🗄️ Banco de Dados

O sistema usa SQLite com as seguintes tabelas:
- `usuarios` - Usuários do sistema
- `membros` - Membros da facção
- `rotas` - Controle de rotas/entregas
- `encomendas` - Pedidos de munições
- `estoque` - Materiais e munições
- `imagens` - Arquivos uploadados

## 💰 Preços das Munições

- **5mm:** R$ 100,00
- **9mm:** R$ 125,00
- **762mm:** R$ 200,00
- **12cbc:** R$ 200,00

## 🔧 Receitas de Fabricação

Cada lote produz 200 munições:
- Alumínio: 55 unidades
- Cobre: 55 unidades
- Emb Plástica: 55 unidades
- Ferro: 55 unidades
- Titânio: 2 unidades

## 📁 Estrutura do Projeto

```
faccao-control-nodejs/
├── server.js              # Servidor Express principal
├── package.json           # Dependências e scripts
├── faccao_control.db      # Banco SQLite (criado automaticamente)
├── static/                # Arquivos estáticos
│   ├── login_simple.html  # Tela de login
│   ├── dashboard_api.html # Dashboard principal
│   └── Yin_yang.svg.png   # Logo da facção
└── README.md              # Este arquivo
```

## 🚀 Scripts Disponíveis

- `npm start` - Inicia o servidor
- `npm run dev` - Inicia com nodemon (desenvolvimento)

## 🎨 Layout

- **Design elegante** com glassmorphism
- **Símbolo Yin Yang** da organização no fundo
- **Cores cinza escuro** personalizadas
- **Interface responsiva** para mobile e desktop

## 🔒 Segurança

- Autenticação JWT
- Senhas criptografadas com bcrypt
- Validação de dados
- Proteção CORS

## 📊 APIs Disponíveis

### Autenticação
- `POST /api/auth/login` - Login
- `GET /api/auth/init-admin` - Inicializar admin

### Membros
- `GET /api/membros` - Listar membros
- `POST /api/membros` - Cadastrar membro
- `DELETE /api/membros/:id` - Remover membro

### Rotas
- `GET /api/rotas` - Listar rotas
- `POST /api/rotas` - Cadastrar rota
- `DELETE /api/rotas/:id` - Remover rota

### Encomendas
- `GET /api/encomendas` - Listar encomendas
- `POST /api/encomendas` - Cadastrar encomenda
- `DELETE /api/encomendas/:id` - Remover encomenda

### Estoque
- `GET /api/estoque` - Listar estoque
- `POST /api/estoque/fabricar` - Fabricar munições

### Imagens
- `GET /api/imagens` - Listar imagens

### Relatórios
- `GET /api/relatorios/geral` - Relatório geral

## 🤝 Suporte

Sistema desenvolvido pela equipe Manus AI para controle de facções GTA RP.

---

**Versão Node.js 100% fiel ao sistema Flask original!**

