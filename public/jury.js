(() => {
const { $, el, api, toast, CRITERIA } = KTA;
const S = { name: "", scores: {}, ballot: null, cat: null };
const timers = {};

function nomsIn(cid) { return S.ballot.nominees.filter(n => n.category === cid).sort((a, b) => a.name.localeCompare(b.name)); }
const complete = n => CRITERIA.every(k => Number(S.scores[n.id]?.[k.k]) >= 1);

function render() {
  const b = $("juryBody"); b.replaceChildren();
  const cats = S.ballot.categories.filter(c => nomsIn(c.id).length);
  if (!cats.length) { b.append(el("div", { class: "notice", text: "No finalists to score yet." })); return; }
  if (!cats.some(c => c.id === S.cat)) S.cat = cats[0].id;
  const doneCats = cats.filter(c => nomsIn(c.id).every(complete)).length;
  const sel = el("select", { id: "catSel", onchange: e => { S.cat = e.target.value; render(); } },
    cats.map(c => { const o = el("option", { value: c.id, text: `${c.pillar} · ${c.name}` }); o.selected = c.id === S.cat; return o; }));
  b.append(el("div", { class: "panel" },
    el("div", { class: "toolbar", style: "margin:0" },
      el("div", {}, el("h2", { text: `Welcome, ${S.name}` }), el("p", { class: "sub", style: "margin:0", text: "Scores save as you go and are visible only to the organizers." })),
      el("button", { class: "btn sm", onclick: logout }, "Sign out")),
    el("div", { class: "row", style: "margin-top:14px" },
      el("div", { class: "field" }, el("label", { for: "catSel", text: "Category" }), sel),
      el("div", { class: "jtotal" }, el("b", { text: `${doneCats}/${cats.length}` }), " categories fully scored"))));
  const cur = cats.find(c => c.id === S.cat);
  if (cur && (cur.qualifies || cur.evidence)) b.append(el("div", { class: "notice elig-box" },
    el("strong", { text: cur.name }),
    cur.qualifies ? el("p", {}, el("b", { text: "Who qualifies: " }), cur.qualifies) : null,
    cur.evidence ? el("p", {}, el("b", { text: "Evidence to look for: " }), cur.evidence) : null));
  for (const n of nomsIn(S.cat)) {
    const sc = S.scores[n.id] || {};
    const total = CRITERIA.reduce((a, k) => a + (Number(sc[k.k]) || 0), 0);
    const crit = el("div", { class: "crit" });
    for (const k of CRITERIA) {
      const id = `s-${n.id}-${k.k}`;
      const s = el("select", { id, onchange: e => setScore(n.id, k.k, e.target.value) }, el("option", { value: "", text: "–" }),
        Array.from({ length: 10 }, (_, i) => { const o = el("option", { value: String(i + 1), text: String(i + 1) }); o.selected = Number(sc[k.k]) === i + 1; return o; }));
      crit.append(el("div", { class: "field" }, el("label", { for: id, text: k.label }), s));
    }
    b.append(el("div", { class: "jcard" },
      el("div", { class: "jcard-h" },
        el("div", {}, el("b", { text: n.name }), n.sample ? el("span", { class: "sample", text: "Sample" }) : null, n.org ? el("div", { class: "muted", style: "font-size:14px", text: n.org }) : null),
        el("div", { class: "jtotal" }, "Total ", el("b", { text: `${total}/50` }))),
      n.bio ? el("p", { style: "margin:0 0 12px;font-size:14px", text: n.bio }) : null, crit));
  }
}

function setScore(nid, k, v) {
  S.scores[nid] = { ...(S.scores[nid] || {}) };
  if (v) S.scores[nid][k] = Number(v); else delete S.scores[nid][k];
  render();
  clearTimeout(timers[nid]);
  timers[nid] = setTimeout(async () => {
    try { await api("/api/jury/score", { body: { nominee: nid, scores: S.scores[nid] } }); toast("Scores saved"); }
    catch (e) { toast(e.message); if (e.status === 401) showLogin(); }
  }, 600);
}

function showLogin() { $("jlogin").hidden = false; $("juryBody").replaceChildren(); }
async function logout() { try { await api("/api/jury/logout", { body: {} }); } catch {} showLogin(); }

async function load() {
  try {
    const r = await api("/api/jury/me");
    S.name = r.name; S.scores = r.scores; S.ballot = r.ballot; $("jlogin").hidden = true; render();
  } catch (e) { if (e.status === 401) showLogin(); else $("juryBody").replaceChildren(el("div", { class: "notice warn", text: e.message })); }
}
$("jloginForm").addEventListener("submit", async e => {
  e.preventDefault(); $("jloginErr").textContent = "";
  try { await api("/api/jury/login", { body: { code: $("jcode").value } }); await load(); }
  catch (err) { $("jloginErr").textContent = err.message; }
});
load();
})();
