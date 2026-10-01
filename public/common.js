// Shared helpers for the KTA pages.
window.KTA = (() => {
  const $ = id => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "style") n.style.cssText = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  };
  async function api(path, opts = {}) {
    const init = { method: opts.method || (opts.body ? "POST" : "GET"), headers: {}, credentials: "same-origin" };
    if (opts.body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    let res;
    try { res = await fetch(path, init); } catch { throw Object.assign(new Error("Can't reach the server. Check that it's running and you're on the same network."), { status: 0 }); }
    const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : await res.text();
    if (!res.ok) throw Object.assign(new Error(data.error || "Request failed."), { status: res.status });
    return data;
  }
  let toastT;
  function toast(msg) {
    let t = $("toast"); if (!t) { t = el("div", { id: "toast", class: "toast" }); document.body.append(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2800);
  }
  const PILLARS = ["Education", "Corporate & Formal", "Agriculture", "Non-Formal & SME", "Impact & Special"];
  const CRITERIA = [
    { k: "impact", label: "Measurable impact" }, { k: "leadership", label: "Leadership" },
    { k: "innovation", label: "Innovation" }, { k: "community", label: "Community & mentorship" },
    { k: "evidence", label: "Evidence & references" },
  ];
  const fmt = n => (Math.round(n * 10) / 10).toFixed(1);
  const pillarsOf = cats => PILLARS.concat([...new Set(cats.map(c => c.pillar))].filter(p => !PILLARS.includes(p)));

  function resultsTable(title, sub, rows, showJurors) {
    const tb = el("tbody");
    rows.forEach((r, i) => {
      const win = i === 0 && r.final > 0;
      tb.append(el("tr", { class: win ? "winner" : null },
        el("td", { class: "num", text: String(i + 1) }),
        el("td", {}, r.name, win ? el("span", { class: "crown", text: "WINNER" }) : null),
        el("td", { class: "r num", text: String(r.votes) }),
        el("td", { class: "r num", text: fmt(r.pub) }),
        el("td", { class: "r num", text: r.jury == null ? "–" : fmt(r.jury) + (showJurors ? ` (${r.jurors})` : "") }),
        el("td", { class: "r" }, el("span", { class: "meter" }, el("i", { style: `width:${Math.min(100, r.final)}%` })), el("b", { class: "num", text: fmt(r.final) }))));
    });
    return el("div", { class: "res-cat" }, el("h3", {}, title, el("small", { text: sub })),
      el("div", { class: "table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["#", "Nominee"].map(h => el("th", { text: h })), ["Public votes", "Public score", "Jury score", "Final"].map(h => el("th", { class: "r", text: h })))), tb)));
  }
  return { $, el, api, toast, PILLARS, CRITERIA, fmt, pillarsOf, resultsTable };
})();
