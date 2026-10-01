// Netlify Function that serves every /api/* route. Data is kept in Netlify Blobs.
// Required environment variables (Netlify → Project configuration → Environment variables):
//   ADMIN_PASSWORD  organizer password
//   KTA_SECRET      long random string used to sign sign-in cookies and hash phone numbers
//                   (keep it fixed: changing it signs everyone out and resets voter identities)
import { getStore } from "@netlify/blobs";
import { createApp, parseCookies } from "../../lib/app.js";

let handle;
function app() {
  if (handle) return handle;
  const blobs = getStore({ name: "kta-awards", consistency: "strong" });
  const store = {
    get: key => blobs.get(key, { type: "json" }),
    set: (key, value) => blobs.setJSON(key, value),
    del: key => blobs.delete(key),
    list: async prefix => (await blobs.list({ prefix })).blobs.map(b => b.key),
  };
  handle = createApp({ store, secret: process.env.KTA_SECRET, adminPassword: process.env.ADMIN_PASSWORD });
  return handle;
}

const send = (status, body, headers = {}) => {
  const isText = typeof body === "string";
  return new Response(isText ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": isText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
};

export default async (req, context) => {
  if (!process.env.KTA_SECRET) return send(503, { error: "The voting service isn't configured yet. Add KTA_SECRET and ADMIN_PASSWORD in Netlify's environment variables, then redeploy." });
  const url = new URL(req.url);
  try {
    const origin = req.headers.get("origin");
    if (req.method !== "GET" && origin && new URL(origin).host !== url.host) return send(403, { error: "Cross-site request blocked." });
    let body = null;
    if (req.method === "POST") {
      if (!(req.headers.get("content-type") || "").includes("application/json")) return send(415, { error: "Send JSON." });
      const raw = await req.text();
      if (raw.length > 100_000) return send(413, { error: "Request too large." });
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: "Invalid JSON." }); }
    }
    const out = await app()({
      method: req.method, path: url.pathname, headers: Object.fromEntries(req.headers),
      cookies: parseCookies(req.headers.get("cookie")), body, ip: context.ip || "?", secure: url.protocol === "https:",
    });
    return send(out.status, out.body, out.headers);
  } catch (e) {
    if (!e.status) console.error(e);
    return send(e.status || 500, { error: e.status ? e.message : "Something went wrong on the server." });
  }
};

export const config = { path: "/api/*" };
