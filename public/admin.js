(() => {
const { $, el, api, toast, PILLARS, fmt, pillarsOf, resultsTable } = KTA;
let S = null, editing = null, tab = "results", catFilter = "all";
const catName = id => S.categories.find(c => c.id === id)?.name || "Unknown category";

/* ---------- tabs ---------- */
$("adminTabs").addEventListener("click", e => {
  const b = e.target.closest(".chip"); if (!b) return;
  tab = b.dataset.t;
  for (const c of document.querySelectorAll("#adminTabs .chip")) c.setAttribute("aria-pressed", String(c.dataset.t === tab));
  for (const s of document.querySelectorAll("[data-sec]")) s.hidden = s.dataset.sec !== tab;
});

/* ---------- confirm-in-place delete ---------- */
function deleteButton(label, onConfirm) {
  const b = el("button", { class: "btn sm danger", type: "button", text: label });
  let armed = false, t;
  b.addEventListener("click", () => {
    if (armed) { clearTimeout(t); onConfirm(); return; }
    armed = true; b.classList.add("armed"); b.textContent = "Confirm";
    t = setTimeout(() => { armed = false; b.classList.remove("armed"); b.textContent = label; }, 3500);
  });
  return b;
}
async function act(fn, ok) {
  try { await fn(); if (ok) toast(ok); await refresh(); }
  catch (e) { toast(e.message); if (e.status === 401) showLogin(); }
}

/* ---------- render ---------- */
function catOptions(sel, withAll) {
  const cur = sel.value; const opts = [];
  if (withAll) opts.push(el("option", { value: "all", text: "All categories" }));
  for (const p of pillarsOf(S.categories)) {
    const cs = S.categories.filter(c => c.pillar === p); if (!cs.length) continue;
    opts.push(el("optgroup", { label: p }, cs.map(c => el("option", { value: c.id, text: c.name }))));
  }
  sel.replaceChildren(...opts);
  if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
}

function renderResults() {
  const ext = Object.values(S.external).reduce((a, x) => a + (Number(x) || 0), 0);
  const scoring = S.jurors.filter(j => j.scored > 0).length;
  $("resSub").textContent = `Jury ${S.settings.juryWeight}% · Public ${100 - S.settings.juryWeight}%. Public score is each nominee's share of the category's public votes; jury score is the average rubric total out of 100.`;
  $("stats").replaceChildren(
    el("div", {}, el("b", { text: String(S.voters) }), "online voters"),
    el("div", {}, el("b", { text: String(ext) }), "off-platform votes"),
    el("div", {}, el("b", { text: `${scoring}/${S.jurors.length}` }), "jurors scoring"),
    el("div", {}, el("b", { text: S.published ? new Date(S.published.computedAt).toLocaleString() : "Not yet" }), "last published"));
  $("publish").textContent = S.published ? "Republish results" : "Publish results";
  const box = $("liveResults"); box.replaceChildren();
  if (!S.results.length) box.append(el("div", { class: "notice", text: "Add nominees to see results here." }));
  for (const c of S.results) box.append(resultsTable(c.name, `${c.pillar} · ${c.total} public votes`, c.rows, true));
}

function renderNominees() {
  catOptions($("nCat"), false); catOptions($("catFilter"), true); $("catFilter").value = catFilter;
  const box = $("nomTable"); box.replaceChildren();
  const list = S.nominees.filter(n => catFilter === "all" || n.category === catFilter)
    .sort((a, b) => catName(a.category).localeCompare(catName(b.category)) || a.name.localeCompare(b.name));
  if (!list.length) { box.append(el("div", { class: "empty-cat", text: "No nominees here yet. Add the first one above." })); return; }
  const tb = el("tbody");
  for (const n of list) {
    const ext = el("input", { type: "number", min: "0", step: "1", value: String(S.external[n.id] || 0), "aria-label": `Off-platform votes for ${n.name}` });
    ext.addEventListener("change", () => act(() => api("/api/admin/external", { body: { nominee: n.id, count: ext.value } }), "Off-platform votes saved"));
    tb.append(el("tr", {},
      el("td", {}, el("b", { text: n.name }), n.sample ? el("span", { class: "sample", text: "Sample" }) : null, n.org ? el("div", { class: "muted", text: n.org }) : null),
      el("td", { text: catName(n.category) }),
      el("td", { class: "r num", text: String(S.tallies[n.id] || 0) }),
      el("td", { class: "r" }, ext),
      el("td", { class: "r" }, el("div", { class: "row", style: "justify-content:flex-end;gap:6px;flex-wrap:nowrap" },
        el("button", { class: "btn sm", type: "button", onclick: () => editNominee(n) }, "Edit"),
        deleteButton("Delete", () => act(() => api("/api/admin/nominee/" + encodeURIComponent(n.id), { method: "DELETE" }), "Nominee deleted"))))));
  }
  box.append(el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, el("th", { text: "Nominee" }), el("th", { text: "Category" }), el("th", { class: "r", text: "Online" }), el("th", { class: "r", text: "Off-platform" }), el("th", {}))), tb)));
}
function editNominee(n) {
  editing = n ? n.id : null;
  $("nomFormTitle").textContent = n ? "Edit nominee" : "Add a nominee";
  $("saveNom").textContent = n ? "Save changes" : "Add nominee";
  $("cancelNom").hidden = !n;
  $("nName").value = n?.name || ""; $("nOrg").value = n?.org || ""; $("nBio").value = n?.bio || "";
  if (n) { $("nCat").value = n.category; $("nName").focus(); window.scrollTo({ top: 0, behavior: "smooth" }); }
}

function renderJury() {
  const box = $("jurorList"); box.replaceChildren();
  if (!S.jurors.length) { box.append(el("div", { class: "empty-cat", text: "No jurors yet." })); return; }
  for (const j of S.jurors) box.append(el("div", { class: "list-item" },
    el("div", { class: "grow" }, el("b", { text: j.name }), el("div", { class: "muted", text: j.scored ? `${j.scored} finalists scored` : "Not started" })),
    deleteButton("Remove", () => act(() => api("/api/admin/juror/" + encodeURIComponent(j.id), { method: "DELETE" }), "Juror removed"))));
}

function renderSettings() {
  if (!$("adminApp").contains(document.activeElement) || !document.activeElement.closest("[data-sec=settings] .panel:first-child")) {
    $("setOpen").checked = S.settings.votingOpen; $("setPublished").checked = S.settings.resultsPublished;
    $("setJury").value = S.settings.juryWeight; showWeights(S.settings.juryWeight); $("setNote").value = S.settings.note || "";
  }
  if (!$("cPillar").options.length) $("cPillar").replaceChildren(...PILLARS.map(p => el("option", { value: p, text: p })));
  const box = $("catList"); box.replaceChildren();
  for (const c of S.categories) {
    const count = S.nominees.filter(n => n.category === c.id).length;
    const del = deleteButton("Delete", () => act(() => api("/api/admin/category/" + encodeURIComponent(c.id), { method: "DELETE" }), "Category deleted"));
    if (count) { del.disabled = true; del.title = "Remove its nominees first"; }
    box.append(el("div", { class: "list-item" }, el("div", { class: "grow" }, el("b", { text: c.name }), el("div", { class: "muted", text: `${c.pillar} · ${count} ${count === 1 ? "nominee" : "nominees"}` })), del));
  }
}
const showWeights = v => { $("wJury").textContent = v + "%"; $("wPublic").textContent = (100 - v) + "%"; };

function renderAll() { renderResults(); renderNominees(); renderJury(); renderSettings(); }

/* ---------- events ---------- */
$("setJury").addEventListener("input", e => showWeights(e.target.value));
$("saveSettings").addEventListener("click", () => act(() => api("/api/admin/settings", { body: {
  votingOpen: $("setOpen").checked, resultsPublished: $("setPublished").checked, juryWeight: Number($("setJury").value), note: $("setNote").value } }), "Settings saved"));
$("publish").addEventListener("click", () => act(() => api("/api/admin/publish", { body: {} }),
  S?.settings.resultsPublished ? "Results published" : "Results saved. Turn on “Show published results” in Settings to reveal them."));
$("nomForm").addEventListener("submit", e => {
  e.preventDefault();
  const body = { id: editing, name: $("nName").value, category: $("nCat").value, org: $("nOrg").value, bio: $("nBio").value };
  act(async () => { await api("/api/admin/nominee", { body }); editNominee(null); }, editing ? "Nominee updated" : "Nominee added");
});
$("cancelNom").addEventListener("click", () => editNominee(null));
$("catFilter").addEventListener("change", e => { catFilter = e.target.value; renderNominees(); });
$("catForm").addEventListener("submit", e => {
  e.preventDefault();
  act(async () => { await api("/api/admin/category", { body: { name: $("cName").value, pillar: $("cPillar").value } }); $("cName").value = ""; }, "Category added");
});
$("jurorForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const r = await api("/api/admin/juror", { body: { name: $("jName").value } });
    $("jName").value = "";
    $("newCode").replaceChildren(el("div", { class: "notice warn", style: "margin-top:12px" },
      el("strong", { text: `Access code for ${r.name}: ` }), el("span", { class: "code", text: r.code }),
      el("div", { style: "margin-top:6px;font-size:14px", text: "Copy it now and send it to the juror privately. It won't be shown again." })));
    await refresh();
  } catch (err) { toast(err.message); }
});
$("logout").addEventListener("click", async () => { try { await api("/api/admin/logout", { body: {} }); } catch {} showLogin(); });

/* ---------- auth + load ---------- */
function showLogin() { $("alogin").hidden = false; $("adminApp").hidden = true; }
async function refresh() {
  try { S = await api("/api/admin/state"); $("alogin").hidden = true; $("adminApp").hidden = false; renderAll(); }
  catch (e) { if (e.status === 401) showLogin(); else toast(e.message); }
}
$("aloginForm").addEventListener("submit", async e => {
  e.preventDefault(); $("aloginErr").textContent = "";
  try { await api("/api/admin/login", { body: { password: $("apw").value } }); $("apw").value = ""; await refresh(); }
  catch (err) { $("aloginErr").textContent = err.message; }
});
refresh();
setInterval(() => { if (S && !document.hidden && tab === "results") refresh(); }, 15000);
})();
