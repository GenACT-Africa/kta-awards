// KTA Awards — local server. No dependencies: needs Node.js 18 or newer.
// Start with:  npm start   (or: node server.js)
// The same API runs on Netlify as a Function (netlify/functions/api.mjs).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createApp, parseCookies } from "./lib/app.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
fs.mkdirSync(DATA, { recursive: true });

/* ---- secrets: from environment, or generated once and kept in data/ ---- */
function keep(file, make) {
  const f = path.join(DATA, file);
  try { const v = fs.readFileSync(f, "utf8").trim(); if (v) return v; } catch {}
  const v = make(); fs.writeFileSync(f, v + "\n", { mode: 0o600 }); return v;
}
const secret = process.env.KTA_SECRET || keep("secret.txt", () => crypto.randomBytes(32).toString("hex"));
const adminPassword = process.env.ADMIN_PASSWORD || keep("admin-password.txt", () => crypto.randomBytes(9).toString("base64url"));

/* ---- file store: each key is a JSON file under data/store/ ---- */
const STORE = path.join(DATA, "store");
const file = key => path.join(STORE, ...key.split("/").map(encodeURIComponent)) + ".json";
const store = {
  async get(key) { try { return JSON.parse(await fs.promises.readFile(file(key), "utf8")); } catch { return null; } },
  async set(key, value) {
    const f = file(key); await fs.promises.mkdir(path.dirname(f), { recursive: true });
    const tmp = f + "." + process.pid + ".tmp"; await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2)); await fs.promises.rename(tmp, f);
  },
  async del(key) { await fs.promises.rm(file(key), { force: true }); },
  async list(prefix) {
    const dir = path.join(STORE, ...prefix.replace(/\/$/, "").split("/").map(encodeURIComponent));
    try { return (await fs.promises.readdir(dir)).filter(n => n.endsWith(".json")).map(n => prefix + decodeURIComponent(n.slice(0, -5))); }
    catch { return []; }
  },
};

const handle = createApp({ store, secret, adminPassword });

/* ---- static files ---- */
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp" };
function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!path.extname(rel)) rel += ".html"; // /vote -> vote.html (matches Netlify's pretty URLs)
  const f = path.normalize(path.join(PUBLIC, rel));
  if (!f.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Page not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(f).pipe(res);
  });
}

const SECURITY = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 100_000) { reject(Object.assign(new Error("Request too large."), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  const url = new URL(req.url, "http://localhost");
  try {
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, url.pathname);
    }
    if (req.method !== "GET" && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw Object.assign(new Error("Cross-site request blocked."), { status: 403 });
    let body = null;
    if (req.method === "POST") {
      const raw = await readBody(req);
      if (!(req.headers["content-type"] || "").includes("application/json")) throw Object.assign(new Error("Send JSON."), { status: 415 });
      try { body = raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error("Invalid JSON."), { status: 400 }); }
    }
    const out = await handle({ method: req.method, path: url.pathname, headers: req.headers, cookies: parseCookies(req.headers.cookie),
      body, ip: req.socket.remoteAddress || "?", secure: false });
    const isText = typeof out.body === "string";
    res.writeHead(out.status, { "Content-Type": isText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "Cache-Control": "no-store", ...out.headers });
    res.end(isText ? out.body : JSON.stringify(out.body));
  } catch (e) {
    if (!e.status) console.error(e);
    res.writeHead(e.status || 500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: e.status ? e.message : "Something went wrong on the server." }));
  }
}).listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === "IPv4" && !n.internal).map(n => `http://${n.address}:${PORT}`);
  console.log(`\n  KTA Awards is running\n`);
  console.log(`  Landing page   http://localhost:${PORT}/`);
  console.log(`  Ballot         http://localhost:${PORT}/vote`);
  console.log(`  Jury           http://localhost:${PORT}/jury`);
  console.log(`  Organizer      http://localhost:${PORT}/admin`);
  if (lan.length) console.log(`  On your network: ${lan.join("  ")}`);
  console.log(`\n  Organizer password: ${process.env.ADMIN_PASSWORD ? "(from ADMIN_PASSWORD)" : adminPassword + "   (saved in data/admin-password.txt)"}\n`);
});
