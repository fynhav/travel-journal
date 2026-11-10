// Travel Journal: serves the app and keeps an encrypted copy of the journal.
// The phone encrypts every record before it is sent, so this server only ever stores ciphertext.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Pool } = require('pg');
const ROOT = path.join(__dirname, '..'), PORT = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined, max: 5 });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.css': 'text/css' };
const STATIC = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png']);
const STORES = new Set(['entries', 'photos', 'audio', 'meta']);
const MAX_BODY = 25 * 1024 * 1024;

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS vaults (id text PRIMARY KEY, token_hash text NOT NULL, created timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS records (
    vault text NOT NULL, store text NOT NULL, id text NOT NULL, ver bigint NOT NULL DEFAULT 0,
    deleted boolean NOT NULL DEFAULT false, data bytea, updated timestamptz NOT NULL DEFAULT now(), seq bigserial,
    PRIMARY KEY (vault, store, id))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS records_seq ON records (vault, seq)`);
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'cache-control': 'no-store', ...headers }); res.end(body); };
const json = (res, code, o) => send(res, code, JSON.stringify(o), { 'content-type': 'application/json' });
const body = req => new Promise((ok, no) => { const c = []; let n = 0; req.on('data', d => { n += d.length; if (n > MAX_BODY) { no(new Error('too big')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', no); });

async function auth(req, res, create) {
  const id = String(req.headers['x-vault'] || ''), tok = String(req.headers['x-token'] || '');
  if (!/^[a-f0-9]{32,64}$/.test(id) || tok.length < 32) { json(res, 401, { error: 'bad credentials' }); return null; }
  const r = await pool.query('SELECT token_hash FROM vaults WHERE id=$1', [id]);
  if (!r.rows.length) {
    if (!create) { json(res, 404, { error: 'unknown vault' }); return null; }
    await pool.query('INSERT INTO vaults (id, token_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, sha(tok)]);
    return id;
  }
  if (!safeEq(r.rows[0].token_hash, sha(tok))) { json(res, 401, { error: 'bad credentials' }); return null; }
  return id;
}

async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api\//, '').split('/');
  if (p[0] === 'health') return json(res, 200, { ok: true });
  const vault = await auth(req, res, p[0] === 'put');
  if (!vault) return;
  // PUT /api/put/:store/:id?ver=N&deleted=1  (body = ciphertext). Only a higher version wins.
  if (p[0] === 'put' && req.method === 'PUT') {
    const store = p[1], id = decodeURIComponent(p[2] || ''), ver = Number(url.searchParams.get('ver') || Date.now()), del = url.searchParams.get('deleted') === '1';
    if (!STORES.has(store) || !id || id.length > 200) return json(res, 400, { error: 'bad record' });
    const data = del ? null : await body(req);
    const r = await pool.query(`INSERT INTO records (vault, store, id, ver, deleted, data) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (vault, store, id) DO UPDATE SET ver=EXCLUDED.ver, deleted=EXCLUDED.deleted, data=EXCLUDED.data, updated=now(), seq=nextval('records_seq_seq'::regclass)
      WHERE records.ver < EXCLUDED.ver RETURNING seq`, [vault, store, id, ver, del, data]);
    return json(res, 200, { stored: r.rowCount === 1 });
  }
  // GET /api/changes?since=N  -> list of records changed after seq N (no data)
  if (p[0] === 'changes') {
    const since = Number(url.searchParams.get('since') || 0);
    const r = await pool.query('SELECT store, id, ver, deleted, seq::text, length(data) AS size FROM records WHERE vault=$1 AND seq>$2 ORDER BY seq LIMIT 2000', [vault, since]);
    return json(res, 200, { items: r.rows.map(x => ({ store: x.store, id: x.id, ver: Number(x.ver), deleted: x.deleted, seq: Number(x.seq), size: x.size || 0 })) });
  }
  // GET /api/get/:store/:id -> ciphertext
  if (p[0] === 'get') {
    const r = await pool.query('SELECT data, deleted FROM records WHERE vault=$1 AND store=$2 AND id=$3', [vault, p[1], decodeURIComponent(p[2] || '')]);
    if (!r.rows.length || r.rows[0].deleted) return json(res, 404, { error: 'not found' });
    return send(res, 200, r.rows[0].data, { 'content-type': 'application/octet-stream' });
  }
  // GET /api/stats -> counts, so the app can show "N chapters, M photos safe"
  if (p[0] === 'stats') {
    const r = await pool.query('SELECT store, count(*)::int AS n, coalesce(sum(length(data)),0)::bigint AS bytes FROM records WHERE vault=$1 AND NOT deleted GROUP BY store', [vault]);
    return json(res, 200, { stores: r.rows.map(x => ({ store: x.store, n: x.n, bytes: Number(x.bytes) })) });
  }
  json(res, 404, { error: 'no such route' });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'x-vault,x-token,content-type'); res.setHeader('access-control-allow-methods', 'GET,PUT,OPTIONS');
      if (req.method === 'OPTIONS') return send(res, 204, '');
      return await api(req, res, url);
    }
    let f = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (f.startsWith('vendor/')) { if (f.includes('..')) f = ''; } else if (!STATIC.has(f)) f = 'index.html';
    const fp = path.join(ROOT, f);
    if (!f || !fp.startsWith(ROOT) || !fs.existsSync(fp)) return send(res, 404, 'not found');
    send(res, 200, fs.readFileSync(fp), { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream', 'cache-control': f === 'sw.js' || f === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
  } catch (e) { console.error(e); if (!res.headersSent) json(res, 500, { error: 'server error' }); }
}).listen(PORT, () => console.log('listening', PORT));
init().then(() => console.log('db ready')).catch(e => { console.error('db init failed', e); process.exit(1); });
