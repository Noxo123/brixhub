const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const BRIXHUB_API_URL = (process.env.BRIXHUB_API_URL || 'https://brixhub.net/api/v1').replace(/\/$/, '');
const BRIXHUB_API_KEY = process.env.BRIXHUB_API_KEY || '';
const MAX_BODY = 64 * 1024;
const RATE_WINDOW = 60_000;
const RATE_MAX = Number(process.env.RATE_LIMIT || 30);
const buckets = new Map();

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
}

function allowed(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const current = buckets.get(ip) || { start: now, count: 0 };
  if (now - current.start >= RATE_WINDOW) {
    current.start = now;
    current.count = 0;
  }
  current.count++;
  buckets.set(ip, current);
  return current.count <= RATE_MAX;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function brixhub(path, options = {}) {
  if (!BRIXHUB_API_KEY) throw Object.assign(new Error('BRIXHUB_API_KEY is not configured'), { status: 500 });
  const response = await fetch(`${BRIXHUB_API_URL}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': BRIXHUB_API_KEY,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text || 'Invalid upstream response' }; }
  if (!response.ok) {
    const error = new Error(data?.message || `BrixHub returned ${response.status}`);
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }
  return data;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, service: 'brixhub', time: new Date().toISOString() });
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return json(res, 200, { ok: true, configured: Boolean(BRIXHUB_API_KEY), api: '/api/search' });
  }

  if (req.method === 'POST' && url.pathname === '/api/search') {
    if (!allowed(req)) return json(res, 429, { ok: false, error: 'Rate limit exceeded' });
    const payload = await readBody(req);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return json(res, 400, { ok: false, error: 'JSON object expected' });
    }

    // Keep the public proxy limited to ordinary, authorized search fields.
    const allowedFields = [
      'NomFamille', 'Prenom', 'Email', 'Telephone', 'Ville',
      'Profession', 'SIREN', 'SIRET', 'DiscordID', 'SteamID',
      'page', 'limit'
    ];
    const query = {};
    for (const key of allowedFields) {
      if (payload[key] !== undefined && payload[key] !== null && String(payload[key]).trim() !== '') {
        query[key] = payload[key];
      }
    }
    if (!Object.keys(query).some(k => !['page', 'limit'].includes(k))) {
      return json(res, 400, { ok: false, error: 'Provide at least one search field' });
    }

    const result = await brixhub('/search', {
      method: 'POST',
      body: JSON.stringify(query),
    });
    return json(res, 200, { ok: true, data: result });
  }

  return json(res, 404, { ok: false, error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]`, error);
    json(res, error.status || 500, { ok: false, error: error.message || 'Internal server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BrixHub server listening on 0.0.0.0:${PORT}`);
  console.log(`BrixHub API: ${BRIXHUB_API_URL}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
