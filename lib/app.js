// KTA Awards API — shared by the local server (server.js) and the Netlify Function.
// Storage is a small key/value interface so it runs on local JSON files or Netlify Blobs:
//   get(key) -> object|null, set(key, object), del(key), list(prefix) -> [keys]
import crypto from "node:crypto";

export const CRITERIA = ["impact", "leadership", "innovation", "community", "evidence"];
export const PILLARS = ["Education", "Corporate & Formal", "Agriculture", "Non-Formal & SME", "Impact & Special"];

const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "item";
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const rand = n => crypto.randomBytes(n).toString("hex");
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const round = n => n == null ? null : Math.round(n * 100) / 100;

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
    external: {},   // nomineeId -> off-platform votes
    jurors: [],     // { id, name, codeHash, createdAt }
  };
}

export function normPhone(p) {
  let d = String(p || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0") && d.length === 10) d = "255" + d.slice(1); // local Tanzanian format
  d = d.replace(/\D/g, "");
  return d.length >= 9 && d.length <= 15 ? d : null;
}

// Per-instance rate limiter (best effort; on serverless each instance keeps its own counts).
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); if (buckets.size > 5000) buckets.clear(); return false; }
  return ++b.n > max;
}

/**
 * createApp({ store, secret, adminPassword })
 * Returns handle(req) where req = { method, path, headers (lowercase keys), cookies, body (object|null), ip, secure }
 * and the result is { status, headers, body } with body a string or object (sent as JSON).
 */
export function createApp({ store, secret, adminPassword }) {
  if (!secret) throw new Error("A secret is required.");
  const hmac = s => crypto.createHmac("sha256", secret).update(s).digest("base64url");
  const sign = payload => { const p = Buffer.from(JSON.stringify(payload)).toString("base64url"); return p + "." + hmac(p); };
  const verify = tok => {
    if (!tok || typeof tok !== "string") return null;
    const [p, sig] = tok.split("."); if (!p || !sig) return null;
    const want = hmac(p);
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    try { const v = JSON.parse(Buffer.from(p, "base64url").toString()); return v.exp && v.exp < Date.now() ? null : v; } catch { return null; }
  };
  const phoneKey = phone => sha(secret + ":phone:" + phone).slice(0, 40);
  const codeHash = code => sha(secret + ":jury:" + code);

  /* ---- config (one small document, written only by organizers) ---- */
  let cfgCache = null, cfgAt = 0;
  async function config() {
    if (cfgCache && Date.now() - cfgAt < 2000) return cfgCache;
    let c = await store.get("config");
    if (!c) { c = seed(); await store.set("config", c); }
    cfgCache = c; cfgAt = Date.now(); return c;
  }
  async function saveConfig(c) { await store.set("config", c); cfgCache = c; cfgAt = Date.now(); }

  /* ---- voters: one document per voter so concurrent votes never overwrite each other ---- */
  async function allVoters() {
    const keys = await store.list("voters/");
    const out = [];
    for (let i = 0; i < keys.length; i += 50) {
      const docs = await Promise.all(keys.slice(i, i + 50).map(k => store.get(k)));
      for (const d of docs) if (d && d.picks && Object.keys(d.picks).length) out.push(d);
    }
    return out;
  }
  let countCache = { n: 0, at: 0 };
  async function voterCount() {
    if (Date.now() - countCache.at < 30000) return countCache.n;
    const n = (await allVoters()).length; countCache = { n, at: Date.now() }; return n;
  }
  async function allScores(jurors) {
    const out = {};
    await Promise.all(jurors.map(async j => { out[j.id] = (await store.get("scores/" + j.id)) || {}; }));
    return out;
  }

  async function compute(c, voters, scores) {
    const jw = c.settings.juryWeight / 100, pw = 1 - jw;
    const tallies = {}; // nomineeId -> votes, counted only where the pick matches the nominee's current category
    const cur = Object.fromEntries(c.nominees.map(n => [n.id, n.category]));
    for (const v of voters) for (const [cat, n] of Object.entries(v.picks)) if (cur[n] === cat) tallies[n] = (tallies[n] || 0) + 1;
    const out = [];
    for (const cat of c.categories) {
      const noms = c.nominees.filter(n => n.category === cat.id);
      if (!noms.length) continue;
      const rows = noms.map(n => {
        const inApp = tallies[n.id] || 0;
        const ext = Math.max(0, Number(c.external[n.id]) || 0);
        const js = [];
        for (const sc of Object.values(scores)) {
          const s = sc[n.id];
          if (s && CRITERIA.every(k => Number(s[k]) >= 1)) js.push(CRITERIA.reduce((a, k) => a + Number(s[k]), 0) / (CRITERIA.length * 10) * 100);
        }
        return { id: n.id, name: n.name, org: n.org || "", inApp, ext, votes: inApp + ext,
          jury: js.length ? js.reduce((a, b) => a + b, 0) / js.length : null, jurors: js.length };
      });
      const total = rows.reduce((a, r) => a + r.votes, 0);
      for (const r of rows) { r.pub = total ? r.votes / total * 100 : 0; r.final = jw * (r.jury ?? 0) + pw * r.pub; }
      rows.sort((a, b) => b.final - a.final || b.votes - a.votes);
      out.push({ id: cat.id, name: cat.name, pillar: cat.pillar, total, rows });
    }
    return { results: out, tallies };
  }

  const ballot = async c => ({
    settings: { votingOpen: c.settings.votingOpen, note: c.settings.note, juryWeight: c.settings.juryWeight },
    categories: c.categories,
    nominees: c.nominees.map(({ id, name, category, org, bio, sample }) => ({ id, name, category, org, bio, sample: !!sample })),
    voters: await voterCount(),
  });

  /* ---- response helpers ---- */
  const json = (status, body, headers = {}) => ({ status, body, headers });
  const fail = (status, error) => json(status, { error });
  const cookie = (req, name, value, maxAge) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.secure ? "; Secure" : ""}`;
  const bad = (status, msg) => { throw Object.assign(new Error(msg), { status }); };
  const body = req => { if (req.body == null || typeof req.body !== "object") bad(400, "Send JSON."); return req.body; };

  return async function handle(req) {
    const { method: m, path: p } = req;
    const c = await config();

    /* ---------------- public ---------------- */
    if (m === "GET" && p === "/api/ballot") return json(200, await ballot(c));

    const voterTok = verify(req.cookies.kta_voter);
    const vkey = voterTok && voterTok.t === "v" ? voterTok.k : null;

    if (m === "GET" && p === "/api/me") {
      if (!vkey) return json(200, { registered: false, picks: {} });
      const v = await store.get("voters/" + vkey);
      return json(200, { registered: true, picks: v?.picks || {} });
    }
    if (m === "POST" && p === "/api/voter") {
      if (limited("reg:" + req.ip, 60, 3600_000)) return fail(429, "Too many sign-ins from this network. Try again in an hour.");
      const phone = normPhone(body(req).phone);
      if (!phone) return fail(400, "Enter a valid phone number, for example +255 712 345 678.");
      const k = phoneKey(phone);
      const v = await store.get("voters/" + k);
      return json(200, { registered: true, picks: v?.picks || {} },
        { "Set-Cookie": cookie(req, "kta_voter", sign({ t: "v", k }), 60 * 60 * 24 * 90) });
    }
    if (m === "POST" && p === "/api/voter/logout") return json(200, { ok: true }, { "Set-Cookie": cookie(req, "kta_voter", "", 0) });

    if (m === "POST" && p === "/api/vote") {
      if (!vkey) return fail(401, "Enter your phone number before voting.");
      if (!c.settings.votingOpen) return fail(403, "Public voting is closed.");
      if (limited("vote:" + vkey, 120, 600_000)) return fail(429, "Too many changes. Wait a few minutes.");
      const b = body(req);
      const cat = c.categories.find(x => x.id === b.category);
      if (!cat) return fail(400, "Unknown category.");
      const v = (await store.get("voters/" + vkey)) || { picks: {}, createdAt: new Date().toISOString() };
      if (b.nominee == null) delete v.picks[cat.id];
      else {
        if (!c.nominees.some(n => n.id === b.nominee && n.category === cat.id)) return fail(400, "That nominee isn't in this category.");
        v.picks[cat.id] = b.nominee;
      }
      v.updatedAt = new Date().toISOString();
      await store.set("voters/" + vkey, v);
      countCache.at = 0;
      return json(200, { picks: v.picks });
    }
    if (m === "GET" && p === "/api/results") {
      const pub = c.settings.resultsPublished && await store.get("results");
      return json(200, pub || { sealed: true });
    }

    /* ---------------- jury ---------------- */
    if (m === "POST" && p === "/api/jury/login") {
      if (limited("jlogin:" + req.ip, 15, 900_000)) return fail(429, "Too many attempts. Wait 15 minutes.");
      const code = str(body(req).code, 40).toUpperCase().replace(/[^A-Z0-9]/g, "");
      const j = c.jurors.find(x => x.codeHash === codeHash(code));
      if (!j) return fail(401, "That access code isn't recognised. Check it with the organizer.");
      return json(200, { ok: true }, { "Set-Cookie": cookie(req, "kta_jury", sign({ t: "j", id: j.id, exp: Date.now() + 30 * 864e5 }), 60 * 60 * 24 * 30) });
    }
    if (p.startsWith("/api/jury/")) {
      const jt = verify(req.cookies.kta_jury);
      const juror = jt && jt.t === "j" && c.jurors.find(x => x.id === jt.id);
      if (!juror) return fail(401, "Sign in with your jury access code.");
      if (m === "GET" && p === "/api/jury/me")
        return json(200, { name: juror.name, scores: (await store.get("scores/" + juror.id)) || {}, ballot: await ballot(c) });
      if (m === "POST" && p === "/api/jury/score") {
        const b = body(req);
        if (!c.nominees.some(n => n.id === b.nominee)) return fail(400, "Unknown nominee.");
        const clean = {};
        for (const k of CRITERIA) { const v = Number(b.scores?.[k]); if (Number.isInteger(v) && v >= 1 && v <= 10) clean[k] = v; }
        const sc = (await store.get("scores/" + juror.id)) || {};
        sc[b.nominee] = clean; await store.set("scores/" + juror.id, sc);
        return json(200, { ok: true, scores: clean });
      }
      if (m === "POST" && p === "/api/jury/logout") return json(200, { ok: true }, { "Set-Cookie": cookie(req, "kta_jury", "", 0) });
    }

    /* ---------------- organizer ---------------- */
    if (m === "POST" && p === "/api/admin/login") {
      if (!adminPassword) return fail(503, "Organizer sign-in isn't set up. Add an ADMIN_PASSWORD environment variable and redeploy.");
      if (limited("alogin:" + req.ip, 10, 900_000)) return fail(429, "Too many attempts. Wait 15 minutes.");
      const given = String(body(req).password || "");
      const ok = crypto.timingSafeEqual(Buffer.from(sha(given)), Buffer.from(sha(adminPassword)));
      if (!ok) return fail(401, "Wrong password.");
      return json(200, { ok: true }, { "Set-Cookie": cookie(req, "kta_admin", sign({ t: "a", exp: Date.now() + 12 * 3600_000 }), 12 * 3600) });
    }
    if (p.startsWith("/api/admin/")) {
      const at = verify(req.cookies.kta_admin);
      if (!at || at.t !== "a") return fail(401, "Sign in as organizer.");

      if (m === "POST" && p === "/api/admin/logout") return json(200, { ok: true }, { "Set-Cookie": cookie(req, "kta_admin", "", 0) });

      if (m === "GET" && (p === "/api/admin/state" || p === "/api/admin/export.csv")) {
        const [voters, scores] = await Promise.all([allVoters(), allScores(c.jurors)]);
        const { results, tallies } = await compute(c, voters, scores);
        if (p === "/api/admin/export.csv") {
          const q = s => `"${String(s ?? "").replace(/"/g, '""')}"`;
          const lines = [["Pillar", "Category", "Rank", "Nominee", "Organisation", "In-app votes", "Off-platform votes", "Public score", "Jury score", "Jurors scored", "Final score"].map(q).join(",")];
          for (const r0 of results) r0.rows.forEach((r, i) => lines.push([r0.pillar, r0.name, i + 1, r.name, r.org, r.inApp, r.ext, round(r.pub), r.jury == null ? "" : round(r.jury), r.jurors, round(r.final)].map(q).join(",")));
          return { status: 200, body: lines.join("\r\n"), headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="kta-awards-results.csv"' } };
        }
        return json(200, {
          settings: c.settings, categories: c.categories, nominees: c.nominees, external: c.external, tallies,
          jurors: c.jurors.map(j => ({ id: j.id, name: j.name, scored: Object.keys(scores[j.id] || {}).length })),
          voters: voters.length, results, published: await store.get("results"), pillars: PILLARS,
        });
      }
      if (m === "POST" && p === "/api/admin/settings") {
        const b = body(req); const jw = Math.round(Number(b.juryWeight));
        c.settings = { votingOpen: !!b.votingOpen, resultsPublished: !!b.resultsPublished,
          juryWeight: Number.isFinite(jw) ? Math.min(100, Math.max(0, jw)) : c.settings.juryWeight, note: str(b.note, 160) };
        await saveConfig(c); return json(200, { settings: c.settings });
      }
      if (m === "POST" && p === "/api/admin/category") {
        const b = body(req); const name = str(b.name, 120), pillar = str(b.pillar, 60);
        if (!name || !pillar) return fail(400, "Give the category a name and a pillar.");
        let id = slug(name); while (c.categories.some(x => x.id === id)) id = slug(name) + "-" + rand(2);
        c.categories.push({ id, name, pillar }); await saveConfig(c); return json(200, { id });
      }
      if (m === "DELETE" && p.startsWith("/api/admin/category/")) {
        const id = decodeURIComponent(p.split("/").pop());
        if (c.nominees.some(n => n.category === id)) return fail(409, "Remove this category's nominees first.");
        c.categories = c.categories.filter(x => x.id !== id); await saveConfig(c); return json(200, { ok: true });
      }
      if (m === "POST" && p === "/api/admin/nominee") {
        const b = body(req); const name = str(b.name, 120), category = str(b.category, 80);
        if (!name) return fail(400, "Add the nominee's name.");
        if (!c.categories.some(x => x.id === category)) return fail(400, "Pick a category.");
        const data = { name, category, org: str(b.org, 160), bio: str(b.bio, 600) };
        const existing = b.id && c.nominees.find(n => n.id === b.id);
        if (existing) { Object.assign(existing, data); delete existing.sample; }
        else c.nominees.push({ id: slug(name) + "-" + rand(3), ...data });
        await saveConfig(c); return json(200, { ok: true });
      }
      if (m === "DELETE" && p.startsWith("/api/admin/nominee/")) {
        const id = decodeURIComponent(p.split("/").pop());
        c.nominees = c.nominees.filter(n => n.id !== id); delete c.external[id];
        await saveConfig(c); return json(200, { ok: true }); // votes for a deleted nominee are ignored in tallies
      }
      if (m === "POST" && p === "/api/admin/external") {
        const b = body(req);
        if (!c.nominees.some(n => n.id === b.nominee)) return fail(400, "Unknown nominee.");
        c.external[b.nominee] = Math.max(0, Math.floor(Number(b.count) || 0)); await saveConfig(c); return json(200, { ok: true });
      }
      if (m === "POST" && p === "/api/admin/juror") {
        const name = str(body(req).name, 100);
        if (!name) return fail(400, "Add the juror's name.");
        const code = rand(4).toUpperCase();
        const j = { id: "j-" + rand(4), name, codeHash: codeHash(code), createdAt: new Date().toISOString() };
        c.jurors.push(j); await saveConfig(c);
        return json(200, { id: j.id, name, code }); // the code is only shown once
      }
      if (m === "DELETE" && p.startsWith("/api/admin/juror/")) {
        const id = decodeURIComponent(p.split("/").pop());
        c.jurors = c.jurors.filter(j => j.id !== id); await saveConfig(c); return json(200, { ok: true });
      }
      if (m === "POST" && p === "/api/admin/publish") {
        const [voters, scores] = await Promise.all([allVoters(), allScores(c.jurors)]);
        const { results } = await compute(c, voters, scores);
        const published = { computedAt: new Date().toISOString(), juryWeight: c.settings.juryWeight,
          categories: results.map(r0 => ({ id: r0.id, name: r0.name, pillar: r0.pillar, total: r0.total,
            rows: r0.rows.map(r => ({ name: r.name, org: r.org, votes: r.votes, pub: round(r.pub), jury: round(r.jury), final: round(r.final) })) })) };
        await store.set("results", published); return json(200, { published });
      }
    }
    return fail(404, "Not found.");
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}
