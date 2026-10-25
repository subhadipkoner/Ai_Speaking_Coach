// AI Speaking Coach server — zero dependencies (Node 18+).
// Run: node server.js   (env: PORT, ANTHROPIC_API_KEY, MODEL, AI_DAILY_LIMIT, DATA_DIR)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 3000;
const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.MODEL || 'claude-haiku-5-5';
const AI_LIMIT = +process.env.AI_DAILY_LIMIT || 150;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'), DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { users: {}, sessions: {}, certs: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
let pending = false;
function persist() { // debounced atomic write
  if (pending) return; pending = true;
  setTimeout(() => { pending = false; const t = DB_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(db)); fs.renameSync(t, DB_FILE); }, 200);
}
process.on('SIGINT', () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {} process.exit(); });

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const SECRET = crypto.randomBytes(16).toString('hex'); // per-process pepper for OTP hashes
const otps = new Map();
// SMS provider: SMS_PROVIDER=twilio (TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM) | default "console" (prints OTP in server log — dev only)
async function sendSms(mobile, code) {
  const text = `${code} is your AI Speaking Coach login OTP. Valid for 5 minutes. Do not share it.`;
  if ((process.env.SMS_PROVIDER || 'console') === 'twilio') {
    const { TWILIO_SID: sid, TWILIO_TOKEN: tok, TWILIO_FROM: from } = process.env;
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: '+91' + mobile, From: from, Body: text }) });
    if (!r.ok) throw new Error('Twilio ' + r.status + ' ' + (await r.text()).slice(0, 200));
  } else console.log(`[DEV SMS] OTP for ${mobile}: ${code}`);
}
const today = () => new Date().toISOString().slice(0, 10);
const clamp = (n, a = 0, b = 100) => Math.max(a, Math.min(b, Math.round(+n) || 0));
const str = (s, n) => String(s == null ? '' : s).slice(0, n);

const hits = new Map(); // simple in-memory rate limiter
function limited(key, max, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms);
  a.push(now); hits.set(key, a); return a.length > max;
}
const aiUse = new Map();

function send(res, code, obj, type = 'application/json') {
  res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
}
function body(req) {
  return new Promise((ok, no) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 65536) { no(new Error('Too large')); req.destroy(); } });
    req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(new Error('Bad JSON')); } });
  });
}
function authUser(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, ''); if (!t) return null;
  const s = db.sessions[sha(t)]; if (!s || s.exp < Date.now()) return null;
  return db.users[s.mobile] || null;
}
function newSession(mobile) {
  const t = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(t)] = { mobile, exp: Date.now() + 30 * 864e5 };
  for (const k in db.sessions) if (db.sessions[k].exp < Date.now()) delete db.sessions[k];
  persist(); return t;
}
const pub = u => ({ name: u.name, mobile: u.mobile, lvl: u.lvl, goal: u.goal, days: u.days, grammar: u.grammar || {}, cert: u.certId ? db.certs[u.certId] : null });
const validName = n => n.length >= 2 && n.length <= 60 && /^[\p{L} .'-]+$/u.test(n);
const validMobile = m => /^[6-9]\d{9}$/.test(m);
const cleanMobile = m => String(m || '').replace(/[\s-]/g, '').replace(/^(\+?91)(?=\d{10}$)/, '');

const routes = {
  'GET /api/ping': async (req, res) => send(res, 200, { ok: 1 }),
  // Step 1: send OTP. `name` present => registration (mobile must be new); absent => login (mobile must exist).
  'POST /api/otp/send': async (req, res, ip) => {
    const b = await body(req), mobile = cleanMobile(b.mobile), reg = b.name !== undefined && b.name !== null && b.name !== '', name = str(b.name, 60).trim().replace(/\s+/g, ' ');
    if (!validMobile(mobile)) return send(res, 400, { error: 'Enter a valid 10-digit mobile number.' });
    if (reg && !validName(name)) return send(res, 400, { error: 'Enter your full name (letters only).' });
    if (reg && db.users[mobile]) return send(res, 409, { error: 'This mobile is already registered. Please use Login.' });
    if (!reg && !db.users[mobile]) return send(res, 404, { error: 'No account for this mobile. Please register first.' });
    const prev = otps.get(mobile);
    if (prev && Date.now() - prev.sent < 30e3) return send(res, 429, { error: 'Please wait 30 seconds before requesting another OTP.' });
    if (limited('otpip' + ip, 20, 36e5) || limited('otpm' + mobile, 5, 36e5)) return send(res, 429, { error: 'Too many OTP requests. Try again later.' });
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    otps.set(mobile, { h: sha(code + mobile + SECRET), exp: Date.now() + 5 * 60e3, sent: Date.now(), tries: 0, name: reg ? name : null });
    try { await sendSms(mobile, code); } catch (e) { otps.delete(mobile); console.error('SMS failed:', e.message); return send(res, 502, { error: 'Could not send SMS. Try again shortly.' }); }
    send(res, 200, { ok: 1, ...(process.env.DEV_OTP_ECHO === '1' ? { devOtp: code } : {}) });
  },
  // Step 2: verify OTP -> create account (if registering) and start a session.
  'POST /api/otp/verify': async (req, res) => {
    const b = await body(req), mobile = cleanMobile(b.mobile), code = str(b.otp, 6), o = otps.get(mobile);
    if (!o || o.exp < Date.now()) { otps.delete(mobile); return send(res, 400, { error: 'OTP expired. Please request a new one.' }); }
    if (++o.tries > 5) { otps.delete(mobile); return send(res, 429, { error: 'Too many wrong attempts. Request a new OTP.' }); }
    const a = Buffer.from(sha(code + mobile + SECRET)), c = Buffer.from(o.h);
    if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(a, c)) return send(res, 401, { error: 'Wrong OTP. Please check and try again.' });
    otps.delete(mobile);
    if (o.name) {
      if (db.users[mobile]) return send(res, 409, { error: 'This mobile is already registered. Please use Login.' });
      db.users[mobile] = { name: o.name, mobile, lvl: 'Intermediate', goal: 'Crack internship interviews with confident professional English', days: {}, created: Date.now() };
    }
    const u = db.users[mobile]; if (!u) return send(res, 404, { error: 'No account for this mobile.' });
    send(res, 200, { token: newSession(mobile), user: pub(u), ai: !!KEY });
  },
  'POST /api/logout': async (req, res) => {
    const t = (req.headers.authorization || '').replace(/^Bearer /, ''); if (t) { delete db.sessions[sha(t)]; persist(); } send(res, 200, { ok: 1 });
  },
  'GET /api/me': async (req, res, ip, u) => send(res, 200, { user: pub(u), ai: !!KEY }),
  'POST /api/settings': async (req, res, ip, u) => {
    const b = await body(req);
    if (['Beginner', 'Intermediate', 'Advanced'].includes(b.lvl)) u.lvl = b.lvl;
    if (b.goal) u.goal = str(b.goal, 120); persist(); send(res, 200, { ok: 1 });
  },
  'POST /api/progress': async (req, res, ip, u) => {
    const b = await body(req), d = Math.floor(+b.day), o = b.result || {};
    if (!(d >= 0 && d < 30)) return send(res, 400, { error: 'Bad day' });
    const arr = a => (Array.isArray(a) ? a : []).slice(0, 4).map(x => str(x, 200));
    const last = { overall: clamp(o.overall), grammar: clamp(o.grammar), vocabulary: clamp(o.vocabulary), fluency: clamp(o.fluency), confidence: clamp(o.confidence), professionalism: clamp(o.professionalism), summary: str(o.summary, 400), strengths: arr(o.strengths), improve: arr(o.improve), homework: str(o.homework, 200), hindi: str(o.hindi, 200) };
    const prev = u.days[d], dt = today();
    u.days[d] = { score: Math.max(last.overall, prev ? prev.score : 0), date: dt, dates: [...new Set([...(prev ? prev.dates : []), dt])], last };
    persist(); send(res, 200, { record: u.days[d] });
  },
  'POST /api/grammar': async (req, res, ip, u) => {
    const b = await body(req), key = str(b.topic, 60), total = Math.floor(+b.total), correct = Math.floor(+b.correct);
    if (!key || !(total >= 1 && total <= 20) || !(correct >= 0 && correct <= total)) return send(res, 400, { error: 'Bad result' });
    u.grammar = u.grammar || {};
    if (!u.grammar[key] && Object.keys(u.grammar).length >= 200) return send(res, 400, { error: 'Too many topics' });
    const p = u.grammar[key], pct = correct / total;
    u.grammar[key] = { title: str(b.title, 80), best: p && p.best / p.total >= pct ? p.best : correct, total: p && p.best / p.total >= pct ? p.total : total, attempts: (p ? p.attempts : 0) + 1, last: Math.round(pct * 100), date: today() };
    persist(); send(res, 200, { grammar: u.grammar });
  },
  'POST /api/certificate': async (req, res, ip, u) => {
    if (Object.keys(u.days).length < 30) return send(res, 403, { error: 'Complete all 30 days first.' });
    if (!u.certId) {
      const sc = Object.values(u.days).map(x => x.score), avg = Math.round(sc.reduce((a, b) => a + b) / 30), id = 'ASC-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      db.certs[id] = { id, name: u.name, mobileTail: u.mobile.slice(-4), avg, best: Math.max(...sc), date: today(), grade: avg >= 80 ? 'DISTINCTION' : avg >= 65 ? 'MERIT' : 'COMPLETION' };
      u.certId = id; persist();
    }
    send(res, 200, { cert: db.certs[u.certId] });
  },
  'POST /api/ai': async (req, res, ip, u) => {
    if (!KEY) return send(res, 503, { error: 'AI not configured on server.' });
    const k = u.mobile + today(), n = (aiUse.get(k) || 0) + 1;
    if (n > AI_LIMIT) return send(res, 429, { error: 'Daily AI limit reached. Free offline mode continues.' });
    const b = await body(req), msgs = b.messages;
    if (!Array.isArray(msgs) || !msgs.length || msgs.length > 14 || msgs.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 6000))
      return send(res, 400, { error: 'Bad request' });
    aiUse.set(k, n);
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: Math.min(+b.max_tokens || 500, 1600), system: str(b.system, 3000), messages: msgs }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { error: (j.error && j.error.message) || 'AI error' });
    send(res, 200, { text: (j.content || []).map(c => c.text || '').join('') });
  }
};
const open = new Set(['GET /api/ping', 'POST /api/otp/send', 'POST /api/otp/verify', 'POST /api/logout']);

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0], ip = req.socket.remoteAddress || '';
  try {
    if (req.method === 'GET' && (url === '/' || url === '/index.html'))
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html');
    const v = url.match(/^\/api\/verify\/(ASC-[0-9A-F]{8})$/i);
    if (req.method === 'GET' && v) { const c = db.certs[v[1].toUpperCase()]; return c ? send(res, 200, { cert: c }) : send(res, 404, { error: 'Certificate not found' }); }
    const route = routes[req.method + ' ' + url];
    if (!route) return send(res, 404, { error: 'Not found' });
    let u = null;
    if (!open.has(req.method + ' ' + url)) { u = authUser(req); if (!u) return send(res, 401, { error: 'Please login again.' }); }
    await route(req, res, ip, u);
  } catch (e) { if (!res.headersSent) send(res, 500, { error: e.message === 'Too large' || e.message === 'Bad JSON' ? e.message : 'Server error' }); }
}).listen(PORT, () => console.log(`AI Speaking Coach → http://localhost:${PORT}  (AI: ${KEY ? 'ON' : 'OFF – free mode only'}, SMS: ${process.env.SMS_PROVIDER || 'console (DEV ONLY — set SMS_PROVIDER=twilio)'})`));
