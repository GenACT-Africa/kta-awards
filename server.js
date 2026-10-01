// KTA Awards — local voting server. Zero dependencies: needs Node.js 18 or newer.
// Start with:  node server.js     (or: npm start)
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PW_FILE = path.join(DATA_DIR, "admin-password.txt");

const CRITERIA = ["impact", "leadership", "innovation", "community", "evidence"];
const PILLARS = ["Education", "Corporate & Formal", "Agriculture", "Non-Formal & SME", "Impact & Special"];

/* ------------------------------------------------------------------ store */
fs.mkdirSync(DATA_DIR, { recursive: true });

function seed() {
  const cats = [
    ["Educator of the Year", "Education"], ["Higher Education Leadership", "Education"],
    ["EdTech Innovation", "Education"], ["Community Inclusion", "Education"],
    ["Executive Leaders", "Corporate & Formal"], ["Healthcare", "Corporate & Formal"],
    ["Finance & Banking", "Corporate & Formal"], ["Legal & Governance Luminaries", "Corporate & Formal"],
    ["Agri-Industrialist of the Year", "Agriculture"], ["Sustainable & Climate Champions", "Agriculture"],
    ["Micro-Enterprise Innovation", "Non-Formal & SME"], ["Hospitality", "Non-Formal & SME"],
    ["Manufacturing & Logistics", "Non-Formal & SME"], ["Diaspora Champions", "Impact & Special"],
    ["Media Pioneers", "Impact & Special"], ["Sports Icons", "Impact & Special"],
    ["Lifetime Legacy Award (25+ years impact)", "Impact & Special"],
  ].map(([name, pillar]) => ({ id: slug(name), name, pillar }));
  return {
    settings: { votingOpen: true, juryWeight: 80, resultsPublished: false, note: "" },
    categories: cats,
    nominees: [
      { id: "sample-a", name: "Sample Nominee A", category: "educator-of-the-year", org: "Replace with a real finalist", bio: "Placeholder entry so you can see how a ballot card looks. Edit or delete it in the organizer panel.", sample: true },
      { id: "sample-b", name: "Sample Nominee B", category: "educator-of-the-year", org: "Replace with a real finalist", bio: "Placeholder entry. Delete once real nominees are added.", sample: true },
    ],
    external: {},          // nomineeId -> off-platform vote count
    voters: {},            // voterKey (hashed phone) -> { picks: {categoryId: nomineeId}, createdAt, updatedAt }
    voterTokens: {},       // token -> voterKey
    jurors: [],            // { id, name, codeHash, createdAt }
    juryTokens: {},        // token -> jurorId
    scores: {},            // jurorId -> { nomineeId: {criterion: 1..10} }
    published: null,       // snapshot of results
    salt: crypto.randomBytes(16).toString("hex"),
  };
}

let db;
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
catch (e) {
  if (e.code !== "ENOENT") { console.error("Could not read data/db.json:", e.message); process.exit(1); }
  db = seed(); saveNow();
}

let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 150); }
function saveNow() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
process.on("SIGINT", () => { saveNow(); process.exit(0); });
process.on("SIGTERM", () => { saveNow(); process.exit(0); });

/* ------------------------------------------------------------ admin secret */
let adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  try { adminPassword = fs.readFileSync(PW_FILE, "utf8").trim(); } catch {}
  if (!adminPassword) {
    adminPassword = crypto.randomBytes(9).toString("base64url");
    fs.writeFileSync(PW_FILE, adminPassword + "\n", { mode: 0o600 });
  }
}
const adminSessions = new Map(); // token -> expiry ms

/* ---------------------------------------------------------------- helpers */
function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "item"; }
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const token = () => crypto.randomBytes(24).toString("base64url");
function safeEq(a, b) {
  const x = Buffer.from(sha(String(a))), y = Buffer.from(sha(String(b)));
  return crypto.timingSafeEqual(x, y);
}
function normPhone(p) {
  let d = String(p || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0") && d.length === 10) d = "255" + d.slice(1); // local Tanzanian format
  d = d.replace(/\D/g, "");
  return d.length >= 9 && d.length <= 15 ? d : null;
}
const str = (v, max) => String(v ?? "").trim().slice(0, max);

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

// Simple fixed-window rate limiter per IP.
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return false; }
  b.n++; return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();

function send(res, status, body, headers = {}) {
  const isStr = typeof body === "string" || Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isStr ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}
const fail = (res, status, error) => send(res, status, { error });

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers["content-type"] || "").includes("application/json")) return reject(Object.assign(new Error("Send JSON."), { status: 415 }));
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 100_000) { reject(Object.assign(new Error("Request too large."), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(Object.assign(new Error("Invalid JSON."), { status: 400 })); } });
    req.on("error", reject);
  });
}
const ip = req => req.socket.remoteAddress || "?";

/* ---------------------------------------------------------------- scoring */
function compute() {
  const jw = db.settings.juryWeight / 100, pw = 1 - jw;
  const jurorIds = new Set(db.jurors.map(j => j.id));
  const tallies = {};
  for (const v of Object.values(db.voters)) for (const n of Object.values(v.picks || {})) tallies[n] = (tallies[n] || 0) + 1;
  const out = [];
  for (const c of db.categories) {
    const noms = db.nominees.filter(n => n.category === c.id);
    if (!noms.length) continue;
    const rows = noms.map(n => {
      const inApp = tallies[n.id] || 0;
      const ext = Math.max(0, Number(db.external[n.id]) || 0);
      const js = [];
      for (const [jid, sc] of Object.entries(db.scores)) {
        if (!jurorIds.has(jid)) continue;
        const s = sc[n.id];
        if (s && CRITERIA.every(k => Number(s[k]) >= 1)) js.push(CRITERIA.reduce((a, k) => a + Number(s[k]), 0) / (CRITERIA.length * 10) * 100);
      }
      return { id: n.id, name: n.name, org: n.org || "", inApp, ext, votes: inApp + ext,
        jury: js.length ? js.reduce((a, b) => a + b, 0) / js.length : null, jurors: js.length };
    });
    const total = rows.reduce((a, r) => a + r.votes, 0);
    for (const r of rows) { r.pub = total ? r.votes / total * 100 : 0; r.final = jw * (r.jury ?? 0) + pw * r.pub; }
    rows.sort((a, b) => b.final - a.final || b.votes - a.votes);
    out.push({ id: c.id, name: c.name, pillar: c.pillar, total, rows });
  }
  return out;
}
const round = n => n == null ? null : Math.round(n * 100) / 100;

function publicBallot() {
  return {
    settings: { votingOpen: db.settings.votingOpen, note: db.settings.note, juryWeight: db.settings.juryWeight },
    categories: db.categories,
    nominees: db.nominees.map(({ id, name, category, org, bio, sample }) => ({ id, name, category, org, bio, sample: !!sample })),
    voters: Object.values(db.voters).filter(v => Object.keys(v.picks || {}).length).length,
  };
}

/* ----------------------------------------------------------------- routes */
function voterOf(req) { const t = parseCookies(req).kta_voter; const k = t && db.voterTokens[t]; return k && db.voters[k] ? k : null; }
function jurorOf(req) { const t = parseCookies(req).kta_jury; const id = t && db.juryTokens[t]; return id && db.jurors.find(j => j.id === id) ? id : null; }
function isAdmin(req) {
  const t = parseCookies(req).kta_admin; const exp = t && adminSessions.get(t);
  if (!exp || exp < Date.now()) { if (t) adminSessions.delete(t); return false; }
  return true;
}

async function api(req, res, url) {
  const p = url.pathname, m = req.method;

  /* --- public --- */
  if (m === "GET" && p === "/api/ballot") return send(res, 200, publicBallot());

  if (m === "GET" && p === "/api/me") {
    const k = voterOf(req);
    return send(res, 200, k ? { registered: true, picks: db.voters[k].picks } : { registered: false, picks: {} });
  }

  if (m === "POST" && p === "/api/voter") {
    if (limited("reg:" + ip(req), 60, 3600_000)) return fail(res, 429, "Too many sign-ins from this network. Try again in an hour.");
    const body = await readJson(req);
    const phone = normPhone(body.phone);
    if (!phone) return fail(res, 400, "Enter a valid phone number, for example +255 712 345 678.");
    const key = sha(db.salt + ":" + phone);
    if (!db.voters[key]) db.voters[key] = { picks: {}, createdAt: new Date().toISOString() };
    const t = token(); db.voterTokens[t] = key; save();
    return send(res, 200, { registered: true, picks: db.voters[key].picks }, { "Set-Cookie": cookie("kta_voter", t, 60 * 60 * 24 * 90) });
  }

  if (m === "POST" && p === "/api/vote") {
    const k = voterOf(req);
    if (!k) return fail(res, 401, "Enter your phone number before voting.");
    if (!db.settings.votingOpen) return fail(res, 403, "Public voting is closed.");
    if (limited("vote:" + k, 120, 600_000)) return fail(res, 429, "Too many changes. Wait a few minutes.");
    const body = await readJson(req);
    const cat = db.categories.find(c => c.id === body.category);
    if (!cat) return fail(res, 400, "Unknown category.");
    const picks = db.voters[k].picks;
    if (body.nominee == null) delete picks[cat.id];
    else {
      const n = db.nominees.find(x => x.id === body.nominee && x.category === cat.id);
      if (!n) return fail(res, 400, "That nominee isn't in this category.");
      picks[cat.id] = n.id;
    }
    db.voters[k].updatedAt = new Date().toISOString(); save();
    return send(res, 200, { picks });
  }

  if (m === "POST" && p === "/api/voter/logout") {
    const t = parseCookies(req).kta_voter; if (t) { delete db.voterTokens[t]; save(); }
    return send(res, 200, { ok: true }, { "Set-Cookie": cookie("kta_voter", "", 0) });
  }

  if (m === "GET" && p === "/api/results") {
    if (!db.settings.resultsPublished || !db.published) return send(res, 200, { sealed: true });
    return send(res, 200, db.published);
  }

  /* --- jury --- */
  if (m === "POST" && p === "/api/jury/login") {
    if (limited("jlogin:" + ip(req), 15, 900_000)) return fail(res, 429, "Too many attempts. Wait 15 minutes.");
    const body = await readJson(req);
    const code = str(body.code, 40).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const j = db.jurors.find(x => x.codeHash === sha(db.salt + ":jury:" + code));
    if (!j) return fail(res, 401, "That access code isn't recognised. Check it with the organizer.");
    const t = token(); db.juryTokens[t] = j.id; save();
    return send(res, 200, { ok: true }, { "Set-Cookie": cookie("kta_jury", t, 60 * 60 * 24 * 30) });
  }
  if (p.startsWith("/api/jury/") ) {
    const jid = jurorOf(req);
    if (!jid) return fail(res, 401, "Sign in with your jury access code.");
    if (m === "GET" && p === "/api/jury/me") {
      const j = db.jurors.find(x => x.id === jid);
      return send(res, 200, { name: j.name, scores: db.scores[jid] || {}, ballot: publicBallot() });
    }
    if (m === "POST" && p === "/api/jury/score") {
      const body = await readJson(req);
      const n = db.nominees.find(x => x.id === body.nominee);
      if (!n) return fail(res, 400, "Unknown nominee.");
      const clean = {};
      for (const k of CRITERIA) { const v = Number(body.scores?.[k]); if (Number.isInteger(v) && v >= 1 && v <= 10) clean[k] = v; }
      db.scores[jid] = db.scores[jid] || {}; db.scores[jid][n.id] = clean; save();
      return send(res, 200, { ok: true, scores: clean });
    }
    if (m === "POST" && p === "/api/jury/logout") {
      const t = parseCookies(req).kta_jury; delete db.juryTokens[t]; save();
      return send(res, 200, { ok: true }, { "Set-Cookie": cookie("kta_jury", "", 0) });
    }
  }

  /* --- admin --- */
  if (m === "POST" && p === "/api/admin/login") {
    if (limited("alogin:" + ip(req), 10, 900_000)) return fail(res, 429, "Too many attempts. Wait 15 minutes.");
    const body = await readJson(req);
    if (!safeEq(body.password || "", adminPassword)) return fail(res, 401, "Wrong password.");
    const t = token(); adminSessions.set(t, Date.now() + 12 * 3600_000);
    return send(res, 200, { ok: true }, { "Set-Cookie": cookie("kta_admin", t, 12 * 3600) });
  }
  if (p.startsWith("/api/admin/")) {
    if (!isAdmin(req)) return fail(res, 401, "Sign in as organizer.");

    if (m === "POST" && p === "/api/admin/logout") {
      adminSessions.delete(parseCookies(req).kta_admin);
      return send(res, 200, { ok: true }, { "Set-Cookie": cookie("kta_admin", "", 0) });
    }
    if (m === "GET" && p === "/api/admin/state") {
      const tallies = {};
      for (const v of Object.values(db.voters)) for (const n of Object.values(v.picks || {})) tallies[n] = (tallies[n] || 0) + 1;
      return send(res, 200, {
        settings: db.settings, categories: db.categories, nominees: db.nominees, external: db.external, tallies,
        jurors: db.jurors.map(j => ({ id: j.id, name: j.name, scored: Object.keys(db.scores[j.id] || {}).length })),
        voters: Object.values(db.voters).filter(v => Object.keys(v.picks || {}).length).length,
        results: compute(), published: db.published, pillars: PILLARS,
      });
    }
    if (m === "POST" && p === "/api/admin/settings") {
      const b = await readJson(req);
      const jw = Math.round(Number(b.juryWeight));
      db.settings = {
        votingOpen: !!b.votingOpen, resultsPublished: !!b.resultsPublished,
        juryWeight: Number.isFinite(jw) ? Math.min(100, Math.max(0, jw)) : db.settings.juryWeight,
        note: str(b.note, 160),
      };
      save(); return send(res, 200, { settings: db.settings });
    }
    if (m === "POST" && p === "/api/admin/category") {
      const b = await readJson(req); const name = str(b.name, 120); const pillar = str(b.pillar, 60);
      if (!name || !pillar) return fail(res, 400, "Give the category a name and a pillar.");
      let id = slug(name); while (db.categories.some(c => c.id === id)) id = slug(name) + "-" + crypto.randomBytes(2).toString("hex");
      db.categories.push({ id, name, pillar }); save(); return send(res, 200, { id });
    }
    if (m === "DELETE" && p.startsWith("/api/admin/category/")) {
      const id = decodeURIComponent(p.split("/").pop());
      if (db.nominees.some(n => n.category === id)) return fail(res, 409, "Remove this category's nominees first.");
      db.categories = db.categories.filter(c => c.id !== id); save(); return send(res, 200, { ok: true });
    }
    if (m === "POST" && p === "/api/admin/nominee") {
      const b = await readJson(req);
      const name = str(b.name, 120), category = str(b.category, 80);
      if (!name) return fail(res, 400, "Add the nominee's name.");
      if (!db.categories.some(c => c.id === category)) return fail(res, 400, "Pick a category.");
      const data = { name, category, org: str(b.org, 160), bio: str(b.bio, 600) };
      const existing = b.id && db.nominees.find(n => n.id === b.id);
      if (existing) {
        if (existing.category !== category) for (const v of Object.values(db.voters)) if (v.picks[existing.category] === existing.id) delete v.picks[existing.category];
        Object.assign(existing, data); delete existing.sample;
      } else db.nominees.push({ id: slug(name) + "-" + crypto.randomBytes(3).toString("hex"), ...data });
      save(); return send(res, 200, { ok: true });
    }
    if (m === "DELETE" && p.startsWith("/api/admin/nominee/")) {
      const id = decodeURIComponent(p.split("/").pop());
      db.nominees = db.nominees.filter(n => n.id !== id);
      for (const v of Object.values(db.voters)) for (const [c, n] of Object.entries(v.picks)) if (n === id) delete v.picks[c];
      delete db.external[id]; save(); return send(res, 200, { ok: true });
    }
    if (m === "POST" && p === "/api/admin/external") {
      const b = await readJson(req);
      if (!db.nominees.some(n => n.id === b.nominee)) return fail(res, 400, "Unknown nominee.");
      db.external[b.nominee] = Math.max(0, Math.floor(Number(b.count) || 0)); save(); return send(res, 200, { ok: true });
    }
    if (m === "POST" && p === "/api/admin/juror") {
      const b = await readJson(req); const name = str(b.name, 100);
      if (!name) return fail(res, 400, "Add the juror's name.");
      const code = crypto.randomBytes(5).toString("hex").toUpperCase().slice(0, 8);
      const j = { id: "j-" + crypto.randomBytes(4).toString("hex"), name, codeHash: sha(db.salt + ":jury:" + code), createdAt: new Date().toISOString() };
      db.jurors.push(j); save();
      return send(res, 200, { id: j.id, name, code }); // code shown once
    }
    if (m === "DELETE" && p.startsWith("/api/admin/juror/")) {
      const id = decodeURIComponent(p.split("/").pop());
      db.jurors = db.jurors.filter(j => j.id !== id);
      for (const [t, jid] of Object.entries(db.juryTokens)) if (jid === id) delete db.juryTokens[t];
      save(); return send(res, 200, { ok: true });
    }
    if (m === "POST" && p === "/api/admin/publish") {
      db.published = { computedAt: new Date().toISOString(), juryWeight: db.settings.juryWeight,
        categories: compute().map(c => ({ id: c.id, name: c.name, pillar: c.pillar, total: c.total,
          rows: c.rows.map(r => ({ name: r.name, org: r.org, votes: r.votes, pub: round(r.pub), jury: round(r.jury), final: round(r.final) })) })) };
      save(); return send(res, 200, { published: db.published });
    }
    if (m === "GET" && p === "/api/admin/export.csv") {
      const q = s => `"${String(s ?? "").replace(/"/g, '""')}"`;
      const lines = [["Pillar", "Category", "Rank", "Nominee", "Organisation", "In-app votes", "Off-platform votes", "Public score", "Jury score", "Jurors scored", "Final score"].map(q).join(",")];
      for (const c of compute()) c.rows.forEach((r, i) => lines.push([c.pillar, c.name, i + 1, r.name, r.org, r.inApp, r.ext, round(r.pub), r.jury == null ? "" : round(r.jury), r.jurors, round(r.final)].map(q).join(",")));
      return send(res, 200, lines.join("\r\n"), { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="kta-awards-results.csv"' });
    }
  }
  return fail(res, 404, "Not found.");
}

/* ----------------------------------------------------------------- static */
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp" };
const PRETTY = { "/": "index.html", "/vote": "vote.html", "/jury": "jury.html", "/admin": "admin.html", "/results": "results.html" };
function serveStatic(req, res, url) {
  let rel = PRETTY[url.pathname] || url.pathname.replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Page not found");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
}

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      // Same-origin check for state-changing requests (defence in depth alongside SameSite cookies).
      if (req.method !== "GET" && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return fail(res, 403, "Cross-site request blocked.");
      return await api(req, res, url);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    serveStatic(req, res, url);
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    console.error(e); fail(res, 500, "Something went wrong on the server.");
  }
});

server.listen(PORT, HOST, () => {
  const nets = require("node:os").networkInterfaces();
  const lan = Object.values(nets).flat().filter(n => n && n.family === "IPv4" && !n.internal).map(n => `http://${n.address}:${PORT}`);
  console.log(`\n  KTA Awards is running\n`);
  console.log(`  Landing page   http://localhost:${PORT}/`);
  console.log(`  Ballot         http://localhost:${PORT}/vote`);
  console.log(`  Jury           http://localhost:${PORT}/jury`);
  console.log(`  Organizer      http://localhost:${PORT}/admin`);
  if (lan.length) console.log(`  On your network: ${lan.join("  ")}`);
  console.log(`\n  Organizer password: ${process.env.ADMIN_PASSWORD ? "(from ADMIN_PASSWORD)" : adminPassword + "   (saved in data/admin-password.txt)"}\n`);
});
