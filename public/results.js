(async () => {
const { $, el, api, resultsTable } = KTA;
const box = $("resultsBody");
try {
  const r = await api("/api/results");
  box.replaceChildren();
  if (r.sealed) {
    box.append(el("div", { class: "notice" }, el("strong", { text: "Results are sealed. " }), "Winners combine expert jury scores with the public vote, and will be announced at the gala."));
    return;
  }
  box.append(el("div", { class: "notice" }, el("strong", { text: "Official results. " }), `Published ${new Date(r.computedAt).toLocaleDateString()} · Jury ${r.juryWeight}% · Public ${100 - r.juryWeight}%`));
  for (const c of r.categories) box.append(resultsTable(c.name, `${c.pillar} · ${c.total} public votes`, c.rows, false));
} catch (e) { box.replaceChildren(el("div", { class: "notice warn", text: e.message })); }
})();
