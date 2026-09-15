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

const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use(express.static(__dirname));
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

app.listen(PORTA_SERVIDOR, () => {
  console.log(`Servidor local do nao-faturados.html rodando em http://localhost:${PORTA_SERVIDOR}`);
});
