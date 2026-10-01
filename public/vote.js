(() => {
const { $, el, api, toast, pillarsOf } = KTA;
const S = { ballot: null, me: { registered: false, picks: {} }, filter: "All", busy: false };

function status() {
  const r = $("statusRow"); r.replaceChildren();
  const b = S.ballot; if (!b) return;
  r.append(el("span", { class: "pill " + (b.settings.votingOpen ? "open" : "closed") }, el("span", { class: "dot" }), b.settings.votingOpen ? "Public voting open" : "Public voting closed"));
  r.append(el("span", { class: "pill", text: `${b.voters} ${b.voters === 1 ? "voter" : "voters"} so far` }));
  if (b.settings.note) r.append(el("span", { class: "pill", text: b.settings.note }));
  if (S.me.registered) r.append(el("button", { class: "pill", style: "cursor:pointer", onclick: signOut }, "Not your phone? Sign out"));
}

function render() {
  status();
  const b = S.ballot, body = $("voteBody"), notice = $("voteNotice");
  body.replaceChildren();
  if (!b.categories.length) { notice.hidden = false; notice.textContent = "The ballot isn't set up yet."; return; }
  notice.hidden = true;
  $("signin").hidden = S.me.registered || !b.settings.votingOpen;
  if (!b.settings.votingOpen) body.append(el("div", { class: "notice warn", text: "Public voting is closed. Thank you to everyone who voted." }));

  const nomsIn = cid => b.nominees.filter(n => n.category === cid).sort((x, y) => x.name.localeCompare(y.name));
  const withNoms = b.categories.filter(c => nomsIn(c.id).length);
  const done = withNoms.filter(c => S.me.picks[c.id]).length;
  const pct = withNoms.length ? done / withNoms.length * 100 : 0;
  const pillars = pillarsOf(b.categories);
  body.append(el("div", { class: "toolbar" },
    el("div", { class: "chips" }, ["All", ...pillars].map(p => el("button", { class: "chip", "aria-pressed": String(S.filter === p), onclick: () => { S.filter = p; render(); } }, p))),
    S.me.registered ? el("div", { class: "progress" }, el("span", { class: "bar" }, el("i", { style: `width:${pct}%` })), el("span", {}, el("span", { class: "num", text: `${done}/${withNoms.length}` }), " categories voted")) : null));

  const canVote = S.me.registered && b.settings.votingOpen;
  for (const p of pillars) {
    if (S.filter !== "All" && S.filter !== p) continue;
    const cats = b.categories.filter(c => c.pillar === p); if (!cats.length) continue;
    const sec = el("div", { class: "pillar" }, el("div", { class: "pillar-h" }, el("h2", { text: p }), el("span", { text: `${cats.length} ${cats.length === 1 ? "category" : "categories"}` })));
    for (const c of cats) {
      const noms = nomsIn(c.id);
      const box = el("div", { class: "cat" }, el("div", { class: "cat-h" }, el("h3", { text: c.name }), S.me.picks[c.id] ? el("span", { class: "voted", text: "Voted" }) : null));
      if (!noms.length) { box.append(el("div", { class: "empty-cat", text: "Finalists to be announced." })); sec.append(box); continue; }
      const grid = el("div", { class: "grid", role: "radiogroup", "aria-label": c.name });
      for (const n of noms) {
        grid.append(el("button", { class: "nom", role: "radio", "aria-checked": String(S.me.picks[c.id] === n.id), disabled: !canVote, onclick: () => vote(c, n) },
          el("span", { class: "radio" }),
          el("span", { class: "nom-b" },
            el("span", { class: "nom-n" }, n.name, n.sample ? el("span", { class: "sample", text: "Sample" }) : null),
            n.org ? el("span", { class: "nom-o", text: n.org }) : null,
            n.bio ? el("span", { class: "nom-c", text: n.bio }) : null)));
      }
      box.append(grid); sec.append(box);
    }
    body.append(sec);
  }
}

async function vote(c, n) {
  if (S.busy) return; S.busy = true;
  const nominee = S.me.picks[c.id] === n.id ? null : n.id;
  try {
    const r = await api("/api/vote", { body: { category: c.id, nominee } });
    S.me.picks = r.picks; S.ballot = await api("/api/ballot").catch(() => S.ballot); toast(nominee ? `Vote saved: ${c.name}` : "Vote removed");
  } catch (e) {
    toast(e.message);
    if (e.status === 401) S.me = { registered: false, picks: {} };
    if (e.status === 403) await load();
  } finally { S.busy = false; render(); }
}

async function signOut() {
  try { await api("/api/voter/logout", { body: {} }); } catch {}
  S.me = { registered: false, picks: {} }; render();
}

$("signinForm").addEventListener("submit", async e => {
  e.preventDefault(); $("signinErr").textContent = "";
  try { S.me = await api("/api/voter", { body: { phone: $("phone").value } }); toast("You're in. Pick a finalist in each category."); render(); }
  catch (err) { $("signinErr").textContent = err.message; }
});

async function load() {
  try {
    const [ballot, me] = await Promise.all([api("/api/ballot"), api("/api/me")]);
    S.ballot = ballot; S.me = me; render();
  } catch (e) { $("voteNotice").hidden = false; $("voteNotice").textContent = e.message; }
}
load();
setInterval(() => { if (!document.hidden && !S.busy) api("/api/ballot").then(b => { S.ballot = b; render(); }).catch(() => {}); }, 30000);
})();
