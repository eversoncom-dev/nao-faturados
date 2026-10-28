// Backend local do nao-faturados.html — só existe pra dar vida aos botões
// "Testar Conexão" (Administração) e "Testar Consulta" (as 3 áreas de SELECT
// por produto: Aéreo/Terrestre/Faturadas), que já chamam
// http://localhost:3001/api/... desde que foram criados no HTML.
//
// Padrão de conexão herdado do qa-platform (backend/src/integrations/sqlServerErp.js,
// já validado contra o ERP Benner real): timeout alto (consultas com múltiplos
// JOIN passam do default de 15s do driver), suporte a instância nomeada
// ("servidor\instancia", ex: "10.141.0.111\bi") e guard de "só SELECT/WITH"
// — este servidor só LÊ dados, nunca grava nada no ERP.
//
// Como rodar: `npm install` (uma vez) e depois `npm start` (ou `node server.js`)
// nesta mesma pasta. Precisa da VPN até o servidor do ERP pra conectar de verdade.

const express = require('express');
const crypto  = require('crypto');
const cors = require('cors');
const sql = require('mssql');

// 3002, não 3001 — a 3001 já está em uso pelo backend de outro projeto
// nesta mesma máquina (faturamento-automatico/server), rodando de verdade
// desde 21/08/2026; não dá pra reaproveitar essa porta.
const PORTA_SERVIDOR = 3002;
const QUERY_GUARD = /^(\s*(--[^\n]*)?\n)*\s*(with|select)\b/im;
const ERR_TEXT_VARCHAR = /data types text and (n?varchar|varchar)/i;

const SQL_KEYWORDS = /^(CAST|CONVERT|ISNULL|COALESCE|NULLIF|VARCHAR|NVARCHAR|CHAR|TEXT|MAX|MIN|SUM|COUNT|AVG|LEN|LEFT|RIGHT|SUBSTRING|UPPER|LOWER|TRIM|LTRIM|RTRIM|REPLACE|PATINDEX|CASE|WHEN|THEN|ELSE|END|AS|FROM|JOIN|INNER|FULL|OUTER|CROSS|ON|WHERE|AND|OR|NOT|IN|IS|NULL|SELECT|HAVING|GROUP|ORDER|BY|DISTINCT|TOP|INTO|SET|UPDATE|DELETE|INSERT|UNION|ALL|WITH|BETWEEN|EXISTS|ANY|SOME|ASC|DESC)$/i;

// Passo 3: (subquery_retornando_text) = 'x'
// Ex: case when (select max(tipoaccounting) from ...) = 'V'
// → case when CAST((select max(tipoaccounting) from ...) AS VARCHAR(MAX)) = 'V'
// Usa contagem de parênteses para encontrar o abre-parênteses correspondente.
function fixParenSubqueryComparison(q) {
  const re = /\)\s*(?:=|<>|!=)\s*N?'(?:[^']|'')*'/gi;
  const hits = [];
  let m;
  while ((m = re.exec(q)) !== null) {
    const closeIdx = m.index;
    let depth = 0, openIdx = -1;
    for (let j = closeIdx; j >= 0; j--) {
      if (q[j] === ')') depth++;
      else if (q[j] === '(') { if (--depth === 0) { openIdx = j; break; } }
    }
    if (openIdx < 0) continue;
    const inside = q.slice(openIdx + 1, closeIdx).trimStart();
    if (/^select\s/i.test(inside)) hits.push({ openIdx, closeIdx });
  }
  // Processa da direita para esquerda para preservar os índices
  for (let i = hits.length - 1; i >= 0; i--) {
    const { openIdx, closeIdx } = hits[i];
    q = q.slice(0, openIdx) + 'CAST(' + q.slice(openIdx, closeIdx + 1) + ' AS VARCHAR(MAX))' + q.slice(closeIdx + 1);
  }
  return q;
}

// Aplica CAST automático em todos os padrões que falham com colunas TEXT:
//   1. col = 'x'  /  col <> 'x'  /  col LIKE 'x'
//   2. col IN ('x','y',...)  /  col NOT IN ('x','y',...)
//   3. (subquery_returning_text) = 'x'
//   4. col1 = K_col  ou  K_col = col2  (campos K_ do Benner são frequentemente TEXT)
function fixTextVarchar(query) {
  let q = query.replace(
    /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*(=|<>|!=|NOT\s+LIKE|LIKE)\s*(N?'(?:[^']|'')*')/gi,
    (match, col, op, val) => SQL_KEYWORDS.test(col) ? match : `CAST(${col} AS VARCHAR(MAX)) ${op} ${val}`
  );
  q = q.replace(
    /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s+(NOT\s+IN|IN)\s*\(/gi,
    (match, col, op) => SQL_KEYWORDS.test(col) ? match : `CAST(${col} AS VARCHAR(MAX)) ${op} (`
  );
  q = fixParenSubqueryComparison(q);
  // Step 4: K_ columns (Benner custom fields — tipo TEXT) em comparações coluna=coluna
  // col = K_col  →  CAST(col AS VARCHAR(MAX)) = CAST(K_col AS VARCHAR(MAX))
  q = q.replace(
    /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*(=|<>|!=)\s*((?:[A-Za-z_]\w*\.)?K_[A-Za-z_]\w*)\b(?!\s*\()/gi,
    (match, col1, op, kCol) => SQL_KEYWORDS.test(col1) ? match : `CAST(${col1} AS VARCHAR(MAX)) ${op} CAST(${kCol} AS VARCHAR(MAX))`
  );
  // K_col = col  →  CAST(K_col AS VARCHAR(MAX)) = CAST(col AS VARCHAR(MAX))
  q = q.replace(
    /\b((?:[A-Za-z_]\w*\.)?K_[A-Za-z_]\w*)\s*(=|<>|!=)\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\b(?!\s*[('[])/gi,
    (match, kCol, op, col2) => SQL_KEYWORDS.test(col2) ? match : `CAST(${kCol} AS VARCHAR(MAX)) ${op} CAST(${col2} AS VARCHAR(MAX))`
  );
  return q;
}

const path  = require('path');
const fs    = require('fs');
const https = require('https');
const cron  = require('node-cron');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const forge = require('node-forge');

const QUERIES_FILE = path.join(__dirname, 'queries.json');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use(express.static(__dirname, { etag: false, lastModified: false, setHeaders: res => res.setHeader('Cache-Control','no-store') }));
app.get('/', (_req, res) => res.redirect('/nao-faturados.html'));

// Monta a config do driver mssql a partir do que vem do formulário de
// Administração ({servidor, porta, banco, usuario, senha}). Servidor pode vir
// como só o host ("192.168.1.100") ou como "host\instancia" (ex: "10.141.0.111\bi")
// — nesse segundo caso a instância é resolvida via SQL Browser (UDP 1434) em
// vez da porta fixa, igual ao ERP Benner real usado no projeto qa-platform.
function buildConfig({ servidor, porta, banco, usuario, senha }) {
  const [host, instanceName] = String(servidor || '').split('\\');
  return {
    server: host,
    ...(instanceName ? { options: { instanceName } } : { port: Number(porta) || 1433 }),
    database: banco,
    user: usuario,
    password: senha,
    options: {
      encrypt: true,
      trustServerCertificate: true,
      ...(instanceName ? { instanceName } : {}),
    },
    connectionTimeout: 8000,
    requestTimeout: 600000, // 10min — consultas de faturamento com vários JOIN podem demorar
  };
}

async function comConexao(config, fn) {
  let pool;
  try {
    pool = await sql.connect(config);
    return await fn(pool);
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {
        /* conexão já encerrada — ignora */
      }
    }
  }
}

app.post('/api/test-connection', async (req, res) => {
  const { servidor, banco, usuario } = req.body || {};
  if (!servidor || !banco || !usuario) {
    return res.json({ ok: false, message: 'Preencha servidor, banco e usuário antes de testar.' });
  }
  try {
    const versao = await comConexao(buildConfig(req.body), async (pool) => {
      const r = await pool.request().query('SELECT @@VERSION AS versao');
      return String(r.recordset[0]?.versao ?? '').split('\n')[0];
    });
    res.json({ ok: true, message: `Conectado com sucesso a "${banco}". ${versao}`.trim() });
  } catch (err) {
    res.json({ ok: false, message: err instanceof Error ? err.message : 'Falha desconhecida ao conectar.' });
  }
});

app.post('/api/test-query', async (req, res) => {
  const { query, produto } = req.body || {};
  if (!query || !QUERY_GUARD.test(query)) {
    return res.json({ ok: false, message: 'Apenas consultas SELECT/WITH são permitidas.' });
  }
  const runQuery = async (q) => comConexao(buildConfig(req.body), async (pool) => {
    const r = await pool.request().query(q);
    return r.recordset.length;
  });
  try {
    const total = await runQuery(query);
    res.json({ ok: true, message: `Consulta de "${produto}" executada com sucesso: ${total} linha(s) retornada(s).` });
  } catch (err) {
    if (ERR_TEXT_VARCHAR.test(err.message)) {
      try {
        const total = await runQuery(fixTextVarchar(query));
        return res.json({ ok: true, message: `Consulta de "${produto}" executada com sucesso: ${total} linha(s). (CAST aplicado automaticamente em colunas TEXT)` });
      } catch {}
    }
    res.json({ ok: false, message: err instanceof Error ? err.message : 'Falha desconhecida ao executar a consulta.' });
  }
});

// Item pedido em 2026-09-07: "Testar Consulta" só confirmava que a query
// funciona e contava linhas — não trazia os dados de verdade, por isso as
// abas (Aéreo/Terrestre/Faturadas) e os cards continuavam mostrando só a
// planilha de demonstração mesmo depois do teste dar certo. Este endpoint
// devolve as linhas de verdade pro botão "📥 Carregar Dados" no HTML.
// arrayRowMode (em vez de objeto) evita perda de dado se a consulta repetir
// nome de coluna (mesmo cuidado já usado no qa-platform pra esse ERP).
const LIMITE_LINHAS = 100000;
app.post('/api/run-query', async (req, res) => {
  const { query } = req.body || {};
  if (!query || !QUERY_GUARD.test(query)) {
    return res.json({ ok: false, message: 'Apenas consultas SELECT/WITH são permitidas.' });
  }
  const executar = async (q) => comConexao(buildConfig(req.body), async (pool) => {
    const request = pool.request();
    request.arrayRowMode = true;
    const r = await request.query(q);
    return { colunas: r.recordset.columns.map((c) => c.name), linhas: r.recordset };
  });
  let resultado;
  let castAplicado = false;
  try {
    resultado = await executar(query);
  } catch (err) {
    console.error('[run-query] ERRO:', err.message);
    console.log('[run-query] query recebida (200 chars):', query.slice(0, 200));
    if (ERR_TEXT_VARCHAR.test(err.message)) {
      const queryFixed = fixTextVarchar(query);
      console.log('[run-query] Aplicando CAST. Query corrigida (200 chars):', queryFixed.slice(0, 200));
      try {
        resultado = await executar(queryFixed);
        castAplicado = true;
        console.log('[run-query] CAST resolveu o problema.');
      } catch (err2) {
        console.error('[run-query] CAST falhou:', err2.message);
        return res.json({ ok: false, message: err2 instanceof Error ? err2.message : 'Falha ao executar a consulta.' });
      }
    } else {
      return res.json({ ok: false, message: err instanceof Error ? err.message : 'Falha desconhecida ao executar a consulta.' });
    }
  }
  const { colunas, linhas } = resultado;
  const truncado = linhas.length > LIMITE_LINHAS;
  res.json({
    ok: true,
    colunas,
    linhas: truncado ? linhas.slice(0, LIMITE_LINHAS) : linhas,
    total: linhas.length,
    truncado,
    castAplicado,
  });
});

// Queries persistidas em queries.json para não depender só do localStorage do browser.
// GET devolve o arquivo salvo; se não existir, lê os .sql do disco como fallback.
// POST recebe {aereo?, terrestre?, faturadas?, clientes?} e mescla com o que já existe.
app.get('/api/queries', (_req, res) => {
  const ler = (nome) => { try { return fs.readFileSync(path.join(__dirname, nome), 'utf8'); } catch { return ''; } };
  const base = {
    aereo:      ler('status-prazo.sql'),
    terrestre:  ler('status-prazo-terrestre.sql'),
    faturadas:  ler('status-faturadas.sql'),
    clientes:   '',
  };
  if (fs.existsSync(QUERIES_FILE)) {
    try {
      const salvo = JSON.parse(fs.readFileSync(QUERIES_FILE, 'utf8'));
      // Queries salvas pelo usuário prevalecem; .sql como fallback para chaves ausentes
      return res.json({ ...base, ...salvo });
    } catch {}
  }
  res.json(base);
});

app.post('/api/queries', (req, res) => {
  let existing = {};
  if (fs.existsSync(QUERIES_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(QUERIES_FILE, 'utf8')); } catch {}
  }
  const updated = { ...existing, ...req.body };
  fs.writeFileSync(QUERIES_FILE, JSON.stringify(updated, null, 2), 'utf8');
  res.json({ ok: true });
});

// ── NÃO CONFORMIDADES ────────────────────────────────────────────────────────
const NC_FILE       = path.join(__dirname, 'nao-conformidades.json');
const MOTIVOS_NC_FILE = path.join(__dirname, 'motivos-nc.json');
const ADMIN_PIN_NC  = '1234'; // PIN para adicionar novos motivos

const _lerNC = () => { try { return JSON.parse(fs.readFileSync(NC_FILE,'utf8')); } catch { return []; } };
const _lerMotivosCustom = () => { try { return JSON.parse(fs.readFileSync(MOTIVOS_NC_FILE,'utf8')); } catch { return []; } };

app.get('/api/nao-conformidades', (_req, res) => {
  res.json({ registros: _lerNC(), motivosCustom: _lerMotivosCustom() });
});

app.post('/api/nao-conformidades', (req, res) => {
  const registros = _lerNC();
  const novo = { ...req.body, id: 'nc_' + Date.now(), data_cadastro: new Date().toISOString() };
  registros.push(novo);
  fs.writeFileSync(NC_FILE, JSON.stringify(registros, null, 2), 'utf8');
  res.json({ ok: true, id: novo.id });
});

app.delete('/api/nao-conformidades/:id', (req, res) => {
  const { pin } = req.body || {};
  if (pin !== ADMIN_PIN_NC) return res.json({ ok: false, message: 'PIN incorreto. Somente o Administrador pode excluir ocorrências.' });
  const registros = _lerNC().filter(r => r.id !== req.params.id);
  fs.writeFileSync(NC_FILE, JSON.stringify(registros, null, 2), 'utf8');
  res.json({ ok: true });
});

app.post('/api/motivos-nc', (req, res) => {
  const { pin, motivo } = req.body || {};
  if (pin !== ADMIN_PIN_NC) return res.json({ ok: false, message: 'PIN incorreto.' });
  if (!motivo || !motivo.trim()) return res.json({ ok: false, message: 'Motivo não informado.' });
  const motivos = _lerMotivosCustom();
  const novo = motivo.trim();
  if (!motivos.includes(novo)) {
    motivos.push(novo);
    fs.writeFileSync(MOTIVOS_NC_FILE, JSON.stringify(motivos, null, 2), 'utf8');
  }
  res.json({ ok: true, motivos });
});

// ── ALERTAS DE E-MAIL ────────────────────────────────────────────────────────
const EMAIL_CONFIG_FILE    = path.join(__dirname, 'email-config.json');
const EMAILS_FAT_FILE      = path.join(__dirname, 'emails-faturistas.json');
const EMAIL_LOG_FILE       = path.join(__dirname, 'email-cron.log');
const PERFIS_FILE          = path.join(__dirname, 'perfis.json');
const USUARIOS_FILE        = path.join(__dirname, 'usuarios.json');

const _lerEmailConfig = () => { try { return JSON.parse(fs.readFileSync(EMAIL_CONFIG_FILE,'utf8')); } catch { return {}; } };

// Normaliza o JSON: suporta formato antigo { "NOME": "email" } e novo { "NOME": { email, teams } }
function _lerEmailFat() {
  try {
    const raw = JSON.parse(fs.readFileSync(EMAILS_FAT_FILE,'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = typeof v === 'string' ? { email: v, teams: '' } : { email: v.email || '', teams: v.teams || '' };
    }
    return out;
  } catch { return {}; }
}

function _logCron(msg) {
  const linha = `[${new Date().toLocaleString('pt-BR')}] ${msg}`;
  console.log(linha);
  try { fs.appendFileSync(EMAIL_LOG_FILE, linha + '\n', 'utf8'); } catch {}
}

app.get('/api/email-config', (_req, res) => {
  const cfg    = _lerEmailConfig();
  const emails = _lerEmailFat();
  let ultimoLog = '';
  try { ultimoLog = fs.readFileSync(EMAIL_LOG_FILE,'utf8').trim().split('\n').slice(-30).join('\n'); } catch {}
  const certOk = fs.existsSync(CERT_PFX_PATH);
  res.json({
    graph:    cfg.graph ? { tenantId: cfg.graph.tenantId, clientId: cfg.graph.clientId, fromEmail: cfg.graph.fromEmail } : null,
    cron:     cfg.cron  ? { servidor: cfg.cron.servidor, porta: cfg.cron.porta, banco: cfg.cron.banco, usuario: cfg.cron.usuario } : null,
    emails, certOk,
    cronAtivo: !!(cfg.graph?.clientId && cfg.graph?.tenantId && certOk && cfg.cron?.servidor),
    ultimoLog,
  });
});

app.post('/api/email-config', (req, res) => {
  const { pin, graph, cron: cronCreds } = req.body || {};
  if (pin !== ADMIN_PIN_NC) return res.json({ ok: false, message: 'PIN incorreto.' });
  const existing = _lerEmailConfig();
  const updated  = { ...existing };
  if (graph) {
    updated.graph = { tenantId: graph.tenantId, clientId: graph.clientId, fromEmail: graph.fromEmail || 'everson.costa@voetur.com.br' };
    updated.graph.pfxPass = graph.pfxPass !== undefined ? graph.pfxPass : (existing.graph?.pfxPass || '');
  }
  if (cronCreds) {
    updated.cron = { servidor: cronCreds.servidor, porta: cronCreds.porta || '1433', banco: cronCreds.banco, usuario: cronCreds.usuario };
    updated.cron.senha = cronCreds.senha || existing.cron?.senha || '';
  }
  fs.writeFileSync(EMAIL_CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf8');
  res.json({ ok: true });
});

app.post('/api/email-faturistas', (req, res) => {
  const { pin, faturista, email, teams } = req.body || {};
  if (pin !== ADMIN_PIN_NC) return res.json({ ok: false, message: 'PIN incorreto.' });
  if (!faturista || !email) return res.json({ ok: false, message: 'Faturista e e-mail são obrigatórios.' });
  const fat = _lerEmailFat();
  fat[faturista] = { email, teams: teams !== undefined ? teams : (fat[faturista]?.teams || '') };
  fs.writeFileSync(EMAILS_FAT_FILE, JSON.stringify(fat, null, 2), 'utf8');
  res.json({ ok: true, emails: fat });
});

app.delete('/api/email-faturistas/:nome', (req, res) => {
  const { pin } = req.body || {};
  if (pin !== ADMIN_PIN_NC) return res.json({ ok: false, message: 'PIN incorreto.' });
  const emails = _lerEmailFat();
  delete emails[decodeURIComponent(req.params.nome)];
  fs.writeFileSync(EMAILS_FAT_FILE, JSON.stringify(emails, null, 2), 'utf8');
  res.json({ ok: true, emails });
});

// ─── GRAPH API — E-MAIL VIA CERTIFICADO ─────────────────────────────────────
const CERT_PFX_PATH = path.join(__dirname, 'cert-sendmail.pfx');

function _lerCertPfx(pfxPass) {
  if (!fs.existsSync(CERT_PFX_PATH)) throw new Error('cert-sendmail.pfx não encontrado na pasta do projeto.');
  const pfxBuffer = fs.readFileSync(CERT_PFX_PATH);
  const pfxAsn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
  const pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, false, pfxPass || '');
  const keyBags = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag = (keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] || [])[0];
  if (!keyBag) throw new Error('Chave privada não encontrada no certificado.');
  const privateKey = forge.pki.privateKeyToPem(keyBag.key);
  const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag });
  const certBag = (certBags[forge.pki.oids.certBag] || [])[0];
  if (!certBag) throw new Error('Certificado público não encontrado no PFX.');
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(certBag.cert)).getBytes();
  const thumbprint = forge.md.sha1.create().update(certDer).digest().toHex().toUpperCase();
  return { privateKey, thumbprint };
}

async function _getGraphToken(cfg) {
  const { privateKey, thumbprint } = _lerCertPfx(cfg.graph?.pfxPass || '');
  const app = new ConfidentialClientApplication({
    auth: {
      clientId: cfg.graph.clientId,
      authority: `https://login.microsoftonline.com/${cfg.graph.tenantId}`,
      clientCertificate: { thumbprint, privateKey },
    },
  });
  const result = await app.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
  return result.accessToken;
}

function _graphPost(token, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'graph.microsoft.com', path: apiPath, method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, res => {
      let rb = ''; res.on('data', d => rb += d); res.on('end', () => resolve({ status: res.statusCode, body: rb }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function _enviarEmailGraph(cfg, to, subject, html) {
  const token = await _getGraphToken(cfg);
  const from = encodeURIComponent(cfg.graph.fromEmail || 'everson.costa@voetur.com.br');
  const r = await _graphPost(token, `/v1.0/users/${from}/sendMail`, {
    message: {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: true,
  });
  if (r.status !== 202) throw new Error(`Graph API retornou ${r.status}: ${r.body}`);
}

// ─── TEAMS HELPERS ───────────────────────────────────────────────────────────
function _postTeamsWebhook(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const u = new URL(webhookUrl);
    const options = {
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function _montarCardTeams(fat, clientes, dataFmt) {
  const facts = clientes.map(c => ({
    title: `${c.nome}${c.cod ? ` (${c.cod})` : ''}`,
    value: c.produto === 'aereo' ? '✈ Aéreo' : '🚌 Terrestre',
  }));
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        msteams: { width: 'Full' },
        body: [
          {
            type: 'Container',
            style: 'emphasis',
            bleed: true,
            items: [
              { type: 'TextBlock', text: '📅 Alerta de Faturamento — Voetur', weight: 'Bolder', size: 'Large', color: 'Accent' },
              { type: 'TextBlock', text: dataFmt, size: 'Small', isSubtle: true, spacing: 'None' },
            ],
          },
          { type: 'TextBlock', text: `Olá, **${fat}**! Hoje é o prazo de envio de fatura para os seguintes clientes:`, wrap: true, spacing: 'Medium' },
          { type: 'FactSet', facts, spacing: 'Small' },
        ],
      },
    }],
  };
}

app.post('/api/teams-testar', async (req, res) => {
  const { faturista } = req.body || {};
  if (!faturista) return res.json({ ok: false, message: 'Nome do faturista não informado.' });
  const fat = _lerEmailFat();
  const info = fat[faturista];
  if (!info?.teams) return res.json({ ok: false, message: `Nenhum webhook Teams cadastrado para "${faturista}".` });
  try {
    const dataFmt = new Date().toLocaleDateString('pt-BR', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    const payload = _montarCardTeams(faturista, [{ nome: 'CLIENTE EXEMPLO', cod: '9999', produto: 'aereo' }], dataFmt);
    const r = await _postTeamsWebhook(info.teams, payload);
    if (r.status >= 200 && r.status < 300) {
      res.json({ ok: true });
    } else {
      res.json({ ok: false, message: `HTTP ${r.status}: ${r.body}` });
    }
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

app.post('/api/email-testar', async (req, res) => {
  const cfg = _lerEmailConfig();
  if (!cfg.graph?.clientId || !cfg.graph?.tenantId) return res.json({ ok: false, message: 'Configure o Tenant ID e Client ID e salve antes de testar.' });
  if (!fs.existsSync(CERT_PFX_PATH)) return res.json({ ok: false, message: 'cert-sendmail.pfx não encontrado na pasta do projeto.' });
  const dest = (req.body || {}).destinatario || cfg.graph.fromEmail;
  try {
    await _enviarEmailGraph(cfg, dest, '✅ Teste de envio — Sistema Voetur',
      '<p>E-mail de teste enviado pelo Sistema de Relatório de Não Faturados (Voetur) via Microsoft Graph API.</p>');
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ─── CRON LOGIC ─────────────────────────────────────────────────────────────
const _PRAZO_ESPECIAL_CRON = { '1526': 26, '1530': 21, '1486': 14 };

function _cronAddDiasUteis(date, n) {
  const d = new Date(date); d.setHours(12,0,0,0);
  let c = 0;
  while (c < n) { d.setDate(d.getDate()+1); if (d.getDay()!==0 && d.getDay()!==6) c++; }
  return d;
}

async function _executarCronEmail() {
  const cfg = _lerEmailConfig();
  if (!cfg.graph?.clientId || !cfg.graph?.tenantId || !cfg.cron?.servidor) {
    _logCron('Configuração incompleta (Graph API ou ERP). Abortando.');
    return;
  }
  if (!fs.existsSync(CERT_PFX_PATH)) {
    _logCron('cert-sendmail.pfx não encontrado. Abortando.');
    return;
  }
  const emails = _lerEmailFat();
  if (!Object.keys(emails).length) {
    _logCron('Nenhum e-mail de faturista cadastrado. Abortando.');
    return;
  }
  const queries = (() => { try { return JSON.parse(fs.readFileSync(QUERIES_FILE,'utf8')); } catch { return {}; } })();
  if (!queries.aereo && !queries.terrestre) {
    _logCron('Sem queries salvas (aereo/terrestre). Abortando.');
    return;
  }

  const hoje = new Date(); hoje.setHours(12,0,0,0);
  const hojeStr = hoje.toISOString().slice(0,10);
  _logCron(`Iniciando verificação de vencimentos para ${hojeStr}...`);

  const cronConn = {
    servidor: cfg.cron.servidor, porta: cfg.cron.porta || '1433',
    banco: cfg.cron.banco, usuario: cfg.cron.usuario, senha: cfg.cron.senha,
  };

  const eventosPorFat = {};

  for (const produto of ['aereo','terrestre']) {
    const q = queries[produto];
    if (!q) continue;
    let colunas, linhas;
    try {
      const r = await comConexao(buildConfig(cronConn), async (pool) => {
        const req2 = pool.request(); req2.arrayRowMode = true;
        const res2 = await req2.query(q);
        return { colunas: res2.recordset.columns.map(c => c.name), linhas: res2.recordset };
      });
      colunas = r.colunas; linhas = r.linhas;
      _logCron(`Query ${produto}: ${linhas.length} linhas.`);
    } catch (err) {
      _logCron(`Erro na query ${produto}: ${err.message}`);
      continue;
    }

    const iF   = colunas.findIndex(c => /RESPONSAVEL.?DOIS/i.test(c));
    const iPer = colunas.findIndex(c => /DATA_FIM_PERIODO/i.test(c));
    const iCod = colunas.findIndex(c => /^(HANDLE|COD_CLIENTE|CODIGO|CLIENTE_ID)$/i.test(c));
    const iNom = colunas.findIndex(c => /^(APELIDO|NOME_CLIENTE|NOME|CLIENTE)$/i.test(c));

    const visto = new Set();
    for (const row of linhas) {
      const fat  = iF  >= 0 ? String(row[iF]  || '').trim() : '';
      const cod  = iCod >= 0 ? String(row[iCod] || '').trim() : '';
      const nome = iNom >= 0 ? String(row[iNom] || '').trim() : cod;
      if (!fat) continue;

      let envioDate;
      if (cod && _PRAZO_ESPECIAL_CRON[cod]) {
        const fim = new Date(hoje.getFullYear(), hoje.getMonth(), _PRAZO_ESPECIAL_CRON[cod] - 1, 12);
        envioDate = _cronAddDiasUteis(fim, 3);
      } else if (iPer >= 0 && row[iPer]) {
        const fim = new Date(row[iPer]); fim.setHours(12,0,0,0);
        if (isNaN(fim)) continue;
        envioDate = _cronAddDiasUteis(fim, 3);
      } else continue;

      if (envioDate.toISOString().slice(0,10) !== hojeStr) continue;

      const key = `${cod}_${produto}`;
      if (visto.has(key)) continue;
      visto.add(key);

      if (!eventosPorFat[fat]) eventosPorFat[fat] = [];
      eventosPorFat[fat].push({ nome, cod, produto });
    }
  }

  if (!Object.keys(eventosPorFat).length) {
    _logCron(`Sem vencimentos hoje (${hojeStr}). Nenhum e-mail enviado.`);
    return;
  }

  // Obtém token Graph uma vez para reutilizar em todos os e-mails
  let graphToken;
  try {
    graphToken = await _getGraphToken(cfg);
    _logCron('Token Graph obtido com sucesso.');
  } catch (err) {
    _logCron(`Erro ao obter token Graph: ${err.message}. Abortando envio de e-mails.`);
  }

  let enviados = 0;
  for (const [fat, clientes] of Object.entries(eventosPorFat)) {
    const fatInfo = emails[fat];
    if (!fatInfo?.email && !fatInfo?.teams) { _logCron(`${fat} — sem e-mail nem webhook Teams. Pulando.`); continue; }

    const dataFmt = hoje.toLocaleDateString('pt-BR', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

    // ── E-MAIL ──────────────────────────────────────────────────────────────
    if (fatInfo.email) {
      const listaHTML = clientes.map(c =>
        `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${c.nome}</td><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${c.cod}</td><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${c.produto==='aereo'?'✈ Aéreo':'🚌 Terrestre'}</td></tr>`
      ).join('');
      const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#1e40af;color:#fff;padding:24px 28px;border-radius:8px 8px 0 0">
    <div style="font-size:22px;font-weight:700">📅 Alerta de Faturamento</div>
    <div style="font-size:14px;opacity:.85;margin-top:4px">${dataFmt}</div>
  </div>
  <div style="background:#fff;padding:24px 28px;border:1px solid #e2e8f0;border-top:none">
    <p style="margin:0 0 16px;font-size:15px;color:#1e293b">Olá, <strong>${fat}</strong>!</p>
    <p style="margin:0 0 16px;font-size:14px;color:#475569">Hoje é o prazo de envio de fatura para os seguintes clientes:</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
      <thead><tr style="background:#f1f5f9">
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Cliente</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Código</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Produto</th>
      </tr></thead>
      <tbody>${listaHTML}</tbody>
    </table>
    <p style="font-size:12px;color:#94a3b8;margin:0">Acesse o sistema de relatório para mais detalhes.</p>
  </div>
  <div style="background:#f8fafc;padding:14px 28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;font-size:11px;color:#94a3b8;text-align:center">Voetur — Sistema de Relatório de Não Faturados</div>
</div>`;
      if (graphToken) {
        try {
          const from = encodeURIComponent(cfg.graph.fromEmail || 'everson.costa@voetur.com.br');
          const r = await _graphPost(graphToken, `/v1.0/users/${from}/sendMail`, {
            message: {
              subject: `📅 Alerta de Faturamento — ${hoje.toLocaleDateString('pt-BR')} — ${clientes.length} cliente(s)`,
              body: { contentType: 'HTML', content: html },
              toRecipients: [{ emailAddress: { address: fatInfo.email } }],
            },
            saveToSentItems: true,
          });
          if (r.status === 202) {
            _logCron(`E-mail enviado para ${fat} <${fatInfo.email}> — ${clientes.length} cliente(s).`);
            enviados++;
          } else {
            _logCron(`ERRO e-mail para ${fat}: Graph retornou ${r.status} — ${r.body}`);
          }
        } catch (err) {
          _logCron(`ERRO e-mail para ${fat} <${fatInfo.email}>: ${err.message}`);
        }
      }
    }

    // ── TEAMS ───────────────────────────────────────────────────────────────
    if (fatInfo.teams) {
      try {
        const card = _montarCardTeams(fat, clientes, dataFmt);
        const r = await _postTeamsWebhook(fatInfo.teams, card);
        if (r.status >= 200 && r.status < 300) {
          _logCron(`Teams enviado para ${fat} — ${clientes.length} cliente(s).`);
        } else {
          _logCron(`ERRO Teams para ${fat}: HTTP ${r.status} — ${r.body}`);
        }
      } catch (err) {
        _logCron(`ERRO Teams para ${fat}: ${err.message}`);
      }
    }
  }
  _logCron(`Concluído — ${enviados} e-mail(s) enviado(s).`);
}

cron.schedule('0 7 * * *', () => {
  _logCron('Cron disparado (07:00).');
  _executarCronEmail();
}, { timezone: 'America/Sao_Paulo' });

// ── VIP SERVICE ─────────────────────────────────────────────────────────────
const VIP_FILE = path.join(__dirname, 'vip-service.json');
const _lerVip = () => { try { return JSON.parse(fs.readFileSync(VIP_FILE, 'utf8')); } catch { return []; } };

app.get('/api/vip-service', (_req, res) => res.json(_lerVip()));

app.post('/api/vip-service', (req, res) => {
  const { ano, mes, valor } = req.body || {};
  if (!ano || !mes || valor === undefined || valor === null || valor === '')
    return res.json({ ok: false, message: 'Ano, mês e valor são obrigatórios.' });
  const registros = _lerVip();
  const idx = registros.findIndex(r => String(r.ano) === String(ano) && String(r.mes) === String(mes));
  const valNum = parseFloat(String(valor).replace(',', '.')) || 0;
  if (idx >= 0) registros[idx].valor = valNum;
  else registros.push({ ano: String(ano), mes: String(mes), valor: valNum });
  fs.writeFileSync(VIP_FILE, JSON.stringify(registros, null, 2), 'utf8');
  res.json({ ok: true });
});

app.delete('/api/vip-service/:ano/:mes', (req, res) => {
  const registros = _lerVip().filter(r => !(String(r.ano) === req.params.ano && String(r.mes) === req.params.mes));
  fs.writeFileSync(VIP_FILE, JSON.stringify(registros, null, 2), 'utf8');
  res.json({ ok: true });
});

// ── PERFIS & USUÁRIOS ────────────────────────────────────────────────────────
const _PERFIS_PADRAO = {
  gestor: {
    nome: 'Gestor',
    descricao: 'Acesso completo a todas as abas e administração',
    permissoes: ['aereo','terrestre','faturadas','calendario','kpis','clientes','naoconf','responsaveis','faturistas','sistemas','divergentes','suspensas','admin']
  },
  operacional: {
    nome: 'Operacional',
    descricao: 'Acesso às abas operacionais, sem administração',
    permissoes: ['aereo','terrestre','faturadas','calendario','kpis','clientes','naoconf','responsaveis','faturistas','sistemas','divergentes','suspensas']
  }
};

const _lerPerfis   = () => { try { return JSON.parse(fs.readFileSync(PERFIS_FILE,'utf8')); } catch { return {}; } };
const _lerUsuarios = () => { try { return JSON.parse(fs.readFileSync(USUARIOS_FILE,'utf8')); } catch { return {}; } };
const _hashSenha   = s => crypto.createHash('sha256').update(s + 'voetur_salt_2026').digest('hex');
const _novoToken   = () => crypto.randomBytes(32).toString('hex');
const _sessoes     = new Map();

// Limpar sessões expiradas a cada hora
setInterval(() => { const now = Date.now(); _sessoes.forEach((v,k) => { if(v.expires < now) _sessoes.delete(k); }); }, 3600000);

app.get('/api/perfis', (_req, res) => {
  const saved = _lerPerfis();
  res.json({ ..._PERFIS_PADRAO, ...saved });
});

app.post('/api/perfis', (req, res) => {
  const { id, nome, descricao, permissoes } = req.body || {};
  if (!id || !nome) return res.json({ ok: false, message: 'ID e nome são obrigatórios.' });
  const perfis = _lerPerfis();
  perfis[id] = { nome, descricao: descricao || '', permissoes: permissoes || [], custom: true };
  fs.writeFileSync(PERFIS_FILE, JSON.stringify(perfis, null, 2), 'utf8');
  res.json({ ok: true });
});

app.put('/api/perfis/:id', (req, res) => {
  const { nome, descricao, permissoes } = req.body || {};
  const id = req.params.id;
  const perfis = _lerPerfis();
  const base = _PERFIS_PADRAO[id] || perfis[id] || {};
  perfis[id] = { ...base, nome: nome||base.nome, descricao: descricao||base.descricao||'', permissoes: permissoes||base.permissoes||[] };
  fs.writeFileSync(PERFIS_FILE, JSON.stringify(perfis, null, 2), 'utf8');
  res.json({ ok: true });
});

app.delete('/api/perfis/:id', (req, res) => {
  const id = req.params.id;
  if (_PERFIS_PADRAO[id]) return res.json({ ok: false, message: 'Perfis padrão (gestor/operacional) não podem ser excluídos.' });
  const perfis = _lerPerfis();
  delete perfis[id];
  fs.writeFileSync(PERFIS_FILE, JSON.stringify(perfis, null, 2), 'utf8');
  res.json({ ok: true });
});

app.get('/api/usuarios', (_req, res) => {
  const users = _lerUsuarios();
  const safe = {};
  Object.entries(users).forEach(([k,v]) => { safe[k] = { nome: v.nome, perfil: v.perfil, ativo: v.ativo !== false }; });
  res.json(safe);
});

app.post('/api/usuarios', (req, res) => {
  const { login, nome, perfil, senha, ativo } = req.body || {};
  if (!login || !nome || !perfil || !senha) return res.json({ ok: false, message: 'Login, nome, perfil e senha são obrigatórios.' });
  const users = _lerUsuarios();
  users[login.toLowerCase()] = { nome, perfil, senha: _hashSenha(senha), ativo: ativo !== false };
  fs.writeFileSync(USUARIOS_FILE, JSON.stringify(users, null, 2), 'utf8');
  res.json({ ok: true });
});

app.put('/api/usuarios/:login', (req, res) => {
  const login = req.params.login.toLowerCase();
  const { nome, perfil, senha, ativo } = req.body || {};
  const users = _lerUsuarios();
  if (!users[login]) return res.json({ ok: false, message: 'Usuário não encontrado.' });
  if (nome)   users[login].nome   = nome;
  if (perfil) users[login].perfil = perfil;
  if (ativo !== undefined) users[login].ativo = ativo;
  if (senha)  users[login].senha  = _hashSenha(senha);
  fs.writeFileSync(USUARIOS_FILE, JSON.stringify(users, null, 2), 'utf8');
  res.json({ ok: true });
});

app.delete('/api/usuarios/:login', (req, res) => {
  const login = req.params.login.toLowerCase();
  const users = _lerUsuarios();
  delete users[login];
  fs.writeFileSync(USUARIOS_FILE, JSON.stringify(users, null, 2), 'utf8');
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const { login, senha } = req.body || {};
  if (!login || !senha) return res.json({ ok: false, message: 'Login e senha obrigatórios.' });
  const users = _lerUsuarios();
  const u = users[login.toLowerCase()];
  if (!u)                return res.json({ ok: false, message: 'Usuário não encontrado.' });
  if (u.ativo === false) return res.json({ ok: false, message: 'Usuário inativo. Fale com o administrador.' });
  if (u.senha !== _hashSenha(senha)) return res.json({ ok: false, message: 'Senha incorreta.' });
  const todosPerfilsObj = { ..._PERFIS_PADRAO, ..._lerPerfis() };
  const perfilInfo = todosPerfilsObj[u.perfil] || {};
  const token = _novoToken();
  _sessoes.set(token, { login: login.toLowerCase(), nome: u.nome, perfil: u.perfil, permissoes: perfilInfo.permissoes || [], expires: Date.now() + 8*3600*1000 });
  res.json({ ok: true, token, nome: u.nome, perfil: u.perfil, permissoes: perfilInfo.permissoes || [] });
});

app.get('/api/auth/verificar', (req, res) => {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token) return res.json({ ok: false });
  const sessao = _sessoes.get(token);
  if (!sessao || sessao.expires < Date.now()) { _sessoes.delete(token); return res.json({ ok: false }); }
  res.json({ ok: true, nome: sessao.nome, perfil: sessao.perfil, permissoes: sessao.permissoes });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) _sessoes.delete(token);
  res.json({ ok: true });
});


app.listen(PORTA_SERVIDOR, () => {
  console.log(`Servidor local do nao-faturados.html rodando em http://localhost:${PORTA_SERVIDOR}`);
});
