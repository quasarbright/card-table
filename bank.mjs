// Chips at the table: my chips sketch's ledger and its controls, inside Card Table. They're off
// until the host hands them out. Then each name plate carries its player's count, the pots sit on
// the felt (view.mjs draws those two), and this module draws the rest:
//   the dock along the bottom, to bet or give from your own chips;
//   the host's Chips sheet (set up, then manage), the pot sheet (award, refund, move, rename),
//   and the sheet for another player's chips;
//   a short note by the pot whenever chips move.
// Everything goes through table actions (table.mjs), so chips ride the table's one session,
// its history, and undo.
import { potOf, chipsOf, refundShares, chipTotal, defaultPotName } from "./table.mjs";
import { partsHTML } from "./history.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const fmt = (n) => Number(n).toLocaleString("en-US");
// a poker chip in a player's color
export const chipDot = (color, cls = "") => `<span class="ct-chipdot ${cls}" style="--c:${color}"><i></i></span>`;
const readAmt = (inp) => parseInt(String(inp.value).replace(/\D/g, ""), 10) || 0;
const writeAmt = (inp, n) => { inp.value = n ? fmt(n) : ""; };
const sameRef = (a, b) => a && b && a.k === b.k && a.id === b.id;

// the quick amounts under the box, scaled to the stakes
function quickAmounts(start) {
  if (start <= 200) return [1, 5, 10, 25];
  if (start <= 2000) return [5, 10, 25, 100];
  if (start <= 20000) return [25, 100, 500, 1000];
  return [100, 1000, 5000, 10000];
}

// ctx: { state(), session(), me() (your seat id), dispatch(action), relayout() }
export function createBank(ctx) {
  const st = () => ctx.state();
  const myPlayer = () => st().seats.find((x) => x.id === ctx.session()?.seat)?.player ?? null;
  const isHost = () => !!ctx.session()?.isHost;
  const players = () => st().seats.filter((x) => x.player && st().bank && x.player in st().bank.chips);
  const nameOf = (ref) => ref.k === "pot" ? potOf(st(), ref.id)?.name ?? "the pot" : st().seats.find((x) => x.player === ref.id)?.name ?? "them";
  const colorOf = (playerId) => st().seats.find((x) => x.player === playerId)?.color ?? "#888";

  // ---- sheets: a panel in the middle of the screen, as in chips ----
  let sheetClose = null, sheetUpdate = null;
  function openSheet(html, { update, onClose } = {}) {
    sheetClose?.();
    const back = document.createElement("div");
    back.className = "ct-sheet-back";
    back.innerHTML = `<div class="ct-sheet ct-bank-sheet" role="dialog" aria-modal="true">${html}</div>`;
    const el = back.firstChild;
    const close = () => {
      if (sheetClose !== close) return;
      sheetClose = sheetUpdate = null;
      back.remove(); removeEventListener("keydown", onKey); onClose?.();
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-close]")) close(); });
    addEventListener("keydown", onKey);
    document.body.appendChild(back);
    sheetClose = close;
    sheetUpdate = update ? () => { if (update(el) === false) close(); } : null;
    return { el, close };
  }
  const head = (title, right = "") => `<div class="ct-sheet-head"><h3>${title}</h3>${right}<button class="ct-x" data-close aria-label="Close">×</button></div>`;
  const $ = (sel, root) => root.querySelector(sel);
  const $$ = (sel, root) => [...root.querySelectorAll(sel)];
  // the host is the only one who can change these: their own dispatch goes straight through
  const run = (action) => { ctx.dispatch(action); return true; };

  // an amount box with an "All" button
  const amountField = (name, label = "All") => `<div class="ct-row" style="margin-bottom:10px">
    <input class="ct-text" data-amt="${name}" inputmode="numeric" placeholder="Amount" />
    <button type="button" class="ct-soft ct-soft-inline" data-max="${name}">${label}</button></div>`;
  function wireAmounts(el, getMax, onChange) {
    for (const inp of $$("[data-amt]", el)) inp.addEventListener("input", () => { writeAmt(inp, readAmt(inp)); onChange?.(); });
    for (const b of $$("[data-max]", el)) b.addEventListener("click", () => { writeAmt($(`[data-amt="${b.dataset.max}"]`, el), getMax(b.dataset.max)); onChange?.(); });
  }

  // where chips can go: the pots first, then the players
  const allRefs = (exclude) => [
    ...(st().bank?.pots ?? []).map((p) => ({ k: "pot", id: p.id })),
    ...players().map((x) => ({ k: "p", id: x.player })),
  ].filter((r) => !sameRef(r, exclude));
  function destPills(refs, selected) {
    const pots = refs.filter((r) => r.k === "pot"), people = refs.filter((r) => r.k === "p");
    let h = "";
    h += pots.map((r) => { const p = potOf(st(), r.id); return `<button type="button" class="ct-dest ct-dest-pot" data-k="pot" data-id="${esc(r.id)}" aria-pressed="${sameRef(r, selected)}">${esc(p.name)} <small>${fmt(p.chips)}</small></button>`; }).join("");
    if (people.length) {
      h += `<span class="ct-dest-lbl">${pots.length ? "or to" : "to"}</span>`;
      h += people.map((r) => `<button type="button" class="ct-dest" data-k="p" data-id="${esc(r.id)}" aria-pressed="${sameRef(r, selected)}">${chipDot(colorOf(r.id), "ct-sm")}${esc(nameOf(r))}</button>`).join("");
    }
    return h || `<span class="ct-dest-empty">Nowhere to send chips yet.</span>`;
  }
  function sheetDests(holder, exclude, onChange) {
    let sel = null;
    const draw = () => { if (sel && chipsOf(st(), sel) == null) sel = null; holder.innerHTML = destPills(allRefs(exclude), sel); };
    holder.addEventListener("click", (e) => {
      const b = e.target.closest(".ct-dest");
      if (!b) return;
      const r = { k: b.dataset.k, id: b.dataset.id };
      sel = sameRef(r, sel) ? null : r; draw(); onChange?.();
    });
    draw();
    return { get value() { return sel; }, draw };
  }

  // ---- the host's Chips button ----
  let startAmount = 1000;
  function chipsSheet() {
    if (!isHost()) return;
    if (!st().bank) return setupSheet();
    manageSheet();
  }
  function setupSheet() {
    const { el, close } = openSheet(`${head("Play with chips")}
      <p>Everyone at the table gets the same stack, and so does anyone who sits down later. Bets go into a pot in the middle.</p>
      <span class="ct-field-label">Everyone starts with</span>
      <input class="ct-text ct-big-amt" data-amt="start" inputmode="numeric" />
      <div class="ct-quickrow" style="margin:10px 0 16px">${[100, 500, 1000, 5000].map((n) => `<button type="button" data-set="${n}">${fmt(n)}</button>`).join("")}</div>
      <button class="ct-big" data-go></button>`);
    const inp = $("[data-amt=start]", el), go = $("[data-go]", el);
    const sync = () => { const v = readAmt(inp); go.textContent = v ? `Give everyone ${fmt(v)}` : "Give everyone chips"; go.disabled = !v; };
    writeAmt(inp, startAmount); sync();
    inp.addEventListener("input", () => { writeAmt(inp, readAmt(inp)); sync(); });
    $$("[data-set]", el).forEach((b) => b.addEventListener("click", () => { writeAmt(inp, +b.dataset.set); sync(); }));
    const start = () => { const v = readAmt(inp); if (!v) return; startAmount = v; run({ type: "startChips", start: v }); close(); };
    go.addEventListener("click", start);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });
    setTimeout(() => { inp.focus(); inp.select(); });
  }
  function manageSheet() {
    const { el, close } = openSheet(`${head("Chips", `<span class="ct-sheet-big" data-total></span>`)}
      <span class="ct-field-label">Players</span>
      <div data-rows></div>
      <details><summary>Give everyone more <span class="ct-sum-hint">a rebuy</span></summary><div>
        <div class="ct-row"><input class="ct-text" data-amt="more" inputmode="numeric" placeholder="Amount each" /><button class="ct-soft ct-soft-inline" data-more>Give</button></div></div></details>
      <details><summary>New players start with <span class="ct-sum-hint" data-start></span></summary><div>
        <p>What each new player sits down with. Doesn't change anyone already here.</p>
        <div class="ct-row"><input class="ct-text" data-amt="start" inputmode="numeric" /><button class="ct-soft ct-soft-inline" data-save-start>Save</button></div></div></details>
      <details><summary>Add a pot</summary><div>
        <div class="ct-row"><input class="ct-text" data-pot-name maxlength="20" /><button class="ct-soft ct-soft-inline" data-add-pot>Add</button></div></div></details>
      <details><summary class="ct-danger-text">Put the chips away</summary><div>
        <p>Everyone's chips and the pots go away for good. Undo brings them back.</p>
        <button class="ct-soft ct-danger-btn" data-end>Put the chips away</button></div></details>`, {
      update: () => { if (!st().bank) return false; draw(); },
    });
    const rows = $("[data-rows]", el);
    const draw = () => {
      const b = st().bank, step = quickAmounts(b.start)[1];
      $("[data-total]", el).textContent = `${fmt(chipTotal(st()))} in all`;
      $("[data-start]", el).textContent = fmt(b.start);
      $("[data-pot-name]", el).placeholder = defaultPotName(st());
      const focused = document.activeElement?.dataset?.player;
      rows.innerHTML = players().map((x) => `<div class="ct-prow">${chipDot(x.color)}<span class="ct-prow-name">${esc(x.name)}</span>
        <button class="ct-step-sm" data-d="-${step}" data-p="${esc(x.player)}" aria-label="${step} fewer">−</button>
        <input class="ct-prow-n" data-player="${esc(x.player)}" inputmode="numeric" value="${fmt(b.chips[x.player])}" aria-label="${esc(x.name)}'s chips" />
        <button class="ct-step-sm" data-d="${step}" data-p="${esc(x.player)}" aria-label="${step} more">+</button></div>`).join("");
      if (focused) rows.querySelector(`[data-player="${CSS.escape(focused)}"]`)?.focus();
    };
    rows.addEventListener("click", (e) => {
      const b = e.target.closest("[data-d]");
      if (!b) return;
      const n = Math.max(0, (st().bank.chips[b.dataset.p] ?? 0) + +b.dataset.d);
      run({ type: "setChips", target: { k: "p", id: b.dataset.p }, amount: n });
    });
    rows.addEventListener("change", (e) => {
      const inp = e.target.closest("[data-player]");
      if (inp) run({ type: "setChips", target: { k: "p", id: inp.dataset.player }, amount: readAmt(inp) });
    });
    rows.addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur?.(); });
    wireAmounts(el, () => 0);
    writeAmt($("[data-amt=start]", el), st().bank.start);
    $("[data-more]", el).addEventListener("click", () => { const v = readAmt($("[data-amt=more]", el)); if (v) { run({ type: "giveAll", amount: v }); close(); } });
    $("[data-save-start]", el).addEventListener("click", () => { run({ type: "setStart", amount: readAmt($("[data-amt=start]", el)) }); draw(); });
    $("[data-add-pot]", el).addEventListener("click", () => { run({ type: "addPot", id: `pot${Date.now().toString(36)}`, name: $("[data-pot-name]", el).value }); close(); });
    $("[data-end]", el).addEventListener("click", () => { run({ type: "endChips" }); close(); });
    draw();
  }

  // ---- a pot: award it (the host), as in chips ----
  function potSheet(id) {
    if (!isHost() || !potOf(st(), id)) return;
    const winners = new Set();
    const { el, close } = openSheet(`
      ${head(`<span data-name></span>`, `<span class="ct-sheet-big" data-chips></span>`)}
      <div class="ct-block">
        <span class="ct-field-label">Who won it?</span>
        <div class="ct-winners" data-winners></div>
        <div class="ct-preview" data-preview></div>
        <button class="ct-big" data-award disabled>Award</button>
        <button class="ct-soft ct-refund" data-refund>Refund <small data-refund-note></small></button>
      </div>
      <details><summary>Move some chips</summary><div>
        ${amountField("move")}
        <div class="ct-dests ct-dests-wrap" data-dests></div>
        <button class="ct-soft" data-move>Move</button></div></details>
      <details><summary>Set the exact amount</summary><div><div class="ct-row">
        <input class="ct-text" data-amt="set" inputmode="numeric" placeholder="New amount" />
        <button class="ct-soft ct-soft-inline" data-set>Set</button></div></div></details>
      <details><summary>Rename</summary><div><div class="ct-row">
        <input class="ct-text" data-rename maxlength="20" />
        <button class="ct-soft ct-soft-inline" data-save>Save</button></div></div></details>
      <details><summary>Remove this pot</summary><div>
        <p data-rm-note></p>
        <button class="ct-soft ct-danger-btn" data-remove>Remove pot</button></div></details>`, {
      update: () => { if (!potOf(st(), id)) return false; draw(); },
    });
    const ref = { k: "pot", id };
    $("[data-rename]", el).value = potOf(st(), id).name;
    const dests = sheetDests($("[data-dests]", el), ref, () => moveBtn());
    wireAmounts(el, () => potOf(st(), id).chips, () => moveBtn());
    const moveBtn = () => {
      const a = readAmt($("[data-amt=move]", el)), b = $("[data-move]", el), p = potOf(st(), id);
      b.disabled = !a || !dests.value || a > p.chips;
      b.textContent = !dests.value ? "Move" : `Move ${a ? fmt(a) + " " : ""}→ ${nameOf(dests.value)}`;
    };
    const preview = () => {
      const p = potOf(st(), id), n = winners.size, btn = $("[data-award]", el), pv = $("[data-preview]", el);
      const share = n ? Math.floor(p.chips / n) : 0, left = p.chips - share * n;
      btn.disabled = !n || !share;
      if (!p.chips) { pv.textContent = "This pot is empty."; btn.textContent = "Award"; return; }
      if (!n) { pv.textContent = "Pick the winner. Pick more than one to split it."; btn.textContent = "Award"; return; }
      if (!share) { pv.textContent = `Not enough chips to split ${n} ways.`; return; }
      const names = [...winners].map((w) => nameOf({ k: "p", id: w }));
      pv.textContent = n === 1 ? `${names[0]} gets all ${fmt(p.chips)}.` : `${fmt(share)} each${left ? ` · ${fmt(left)} stays in the pot` : ""}.`;
      btn.textContent = n === 1 ? `Give it to ${names[0]}` : n === players().length ? "Split between everyone" : `Split ${n} ways`;
    };
    const draw = () => {
      const p = potOf(st(), id), ps = players();
      for (const w of [...winners]) if (!ps.some((x) => x.player === w)) winners.delete(w);
      $("[data-name]", el).textContent = p.name;
      $("[data-chips]", el).textContent = fmt(p.chips);
      const all = ps.length > 1 && winners.size === ps.length;
      $("[data-winners]", el).innerHTML = ps.map((x) => `<button class="ct-winner" data-w="${esc(x.player)}" aria-pressed="${winners.has(x.player)}">${chipDot(x.color)}<span>${esc(x.name)}</span></button>`).join("")
        + (ps.length > 1 ? `<button class="ct-winner ct-everyone" data-everyone aria-pressed="${all}">Everyone</button>` : "");
      $("[data-max]", el).innerHTML = `All <span class="ct-muted">${fmt(p.chips)}</span>`;
      $("[data-rm-note]", el).textContent = p.chips ? "Award or move its chips first." : "It's empty, so nothing is lost.";
      $("[data-remove]", el).disabled = !!p.chips;
      const shares = refundShares(st(), id);
      $("[data-refund]", el).disabled = !shares.length;
      $("[data-refund-note]", el).textContent = shares.length ? shares.map(([w, n]) => `${nameOf({ k: "p", id: w })} ${fmt(n)}`).join(" · ") : "nothing to give back";
      dests.draw(); preview(); moveBtn();
    };
    $("[data-winners]", el).addEventListener("click", (e) => {
      const b = e.target.closest(".ct-winner");
      if (!b) return;
      const ps = players();
      if (b.dataset.everyone != null) { if (winners.size === ps.length) winners.clear(); else ps.forEach((x) => winners.add(x.player)); }
      else if (winners.has(b.dataset.w)) winners.delete(b.dataset.w); else winners.add(b.dataset.w);
      draw();
    });
    $("[data-refund]", el).addEventListener("click", () => { run({ type: "refund", pot: id }); close(); });
    $("[data-award]", el).addEventListener("click", () => { run({ type: "award", pot: id, winners: [...winners] }); close(); });
    $("[data-move]", el).addEventListener("click", () => { run({ type: "transfer", from: ref, to: dests.value, amount: readAmt($("[data-amt=move]", el)) }); close(); });
    $("[data-set]", el).addEventListener("click", () => { if ($("[data-amt=set]", el).value) { run({ type: "setChips", target: ref, amount: readAmt($("[data-amt=set]", el)) }); close(); } });
    $("[data-save]", el).addEventListener("click", () => { run({ type: "renamePot", id, name: $("[data-rename]", el).value }); close(); });
    $("[data-remove]", el).addEventListener("click", () => { run({ type: "removePot", id }); close(); });
    draw();
  }

  // ---- another player's chips (the host) ----
  function playerSheet(playerId, { more } = {}) {
    if (!isHost() || chipsOf(st(), { k: "p", id: playerId }) == null) return false;
    const ref = { k: "p", id: playerId };
    const { el, close } = openSheet(`
      ${head(`<span data-name></span>`, `<span class="ct-sheet-big" data-chips></span>`)}
      <div class="ct-block"><span class="ct-field-label">Move their chips</span>
        ${amountField("move")}
        <div class="ct-dests ct-dests-wrap" data-dests></div>
        <button class="ct-big" data-move disabled>Move</button></div>
      <details><summary>Set the exact amount</summary><div><p>For buy-ins, rebuys, or fixing a mistake.</p><div class="ct-row">
        <input class="ct-text" data-amt="set" inputmode="numeric" placeholder="New amount" />
        <button class="ct-soft ct-soft-inline" data-set>Set</button></div></div></details>
      ${more ? `<button class="ct-soft" data-more>Seat options…</button>` : ""}`, {
      update: () => { if (chipsOf(st(), ref) == null) return false; draw(); },
    });
    const dests = sheetDests($("[data-dests]", el), ref, () => moveBtn());
    wireAmounts(el, () => chipsOf(st(), ref), () => moveBtn());
    const moveBtn = () => {
      const a = readAmt($("[data-amt=move]", el)), b = $("[data-move]", el);
      b.disabled = !a || !dests.value || a > chipsOf(st(), ref);
      b.textContent = !dests.value ? "Pick where they go" : `Move ${a ? fmt(a) + " " : ""}→ ${nameOf(dests.value)}`;
    };
    const draw = () => {
      $("[data-name]", el).innerHTML = `${chipDot(colorOf(playerId), "ct-sm")} ${esc(nameOf(ref))}`;
      $("[data-chips]", el).textContent = fmt(chipsOf(st(), ref));
      $("[data-max]", el).innerHTML = `All <span class="ct-muted">${fmt(chipsOf(st(), ref))}</span>`;
      dests.draw(); moveBtn();
    };
    $("[data-move]", el).addEventListener("click", () => { run({ type: "transfer", from: ref, to: dests.value, amount: readAmt($("[data-amt=move]", el)) }); close(); });
    $("[data-set]", el).addEventListener("click", () => { if ($("[data-amt=set]", el).value) { run({ type: "setChips", target: ref, amount: readAmt($("[data-amt=set]", el)) }); close(); } });
    $("[data-more]", el)?.addEventListener("click", () => { close(); more(); });
    draw();
    return true;
  }

  // ---- the dock: bet or give from your own chips ----
  const dock = document.createElement("form");
  dock.className = "ct-dock";
  dock.hidden = true;
  dock.setAttribute("autocomplete", "off");
  dock.innerHTML = `
    <span class="ct-dock-mine">You have<b data-mine>0</b></span>
    <div class="ct-dests" data-dests></div>
    <div class="ct-dock-amt"><input data-amt inputmode="numeric" placeholder="0" aria-label="Amount" /><button type="button" class="ct-dock-clr" data-clear aria-label="Clear">×</button></div>
    <div class="ct-quickrow" data-quick></div>
    <button class="ct-send" type="submit" data-send><span data-l1>Bet</span><small data-l2></small></button>`;
  document.body.appendChild(dock);
  const amtIn = $("[data-amt]", dock);
  let dest = null, destAuto = false;
  function renderDock() {
    const b = st().bank, me = myPlayer();
    const show = !!b && !!me && me in b.chips;
    if (dock.hidden === show) { dock.hidden = !show; document.body.classList.toggle("ct-has-dock", show); ctx.relayout(); }
    if (!show) return;
    const refs = allRefs({ k: "p", id: me });
    if (dest && (chipsOf(st(), dest) == null || (destAuto && b.pots.length !== 1))) dest = null;
    if (!dest && b.pots.length === 1) { dest = { k: "pot", id: b.pots[0].id }; destAuto = true; }
    $("[data-mine]", dock).textContent = fmt(b.chips[me]);
    $("[data-dests]", dock).innerHTML = destPills(refs, dest);
    const qa = quickAmounts(b.start), quick = $("[data-quick]", dock);
    if (quick.dataset.for !== qa.join()) {
      quick.dataset.for = qa.join();
      quick.innerHTML = qa.map((n) => `<button type="button" data-add="${n}">+${fmt(n)}</button>`).join("") + `<button type="button" class="ct-all" data-all>All in</button>`;
    }
    dockState();
  }
  function dockState() {
    const me = myPlayer(), mine = st().bank?.chips[me] ?? 0, a = readAmt(amtIn), btn = $("[data-send]", dock);
    const over = a > mine;
    amtIn.classList.toggle("ct-over", over);
    let l1 = "Send", l2 = "";
    if (dest) { l1 = dest.k === "pot" ? (a && a === mine ? "All in" : "Bet") : "Give"; l2 = "→ " + nameOf(dest); }
    else l2 = (st().bank?.pots.length ?? 0) > 1 ? "pick a pot" : "pick where";
    if (a) l1 += " " + fmt(a);
    if (over) l2 = "more than you have";
    $("[data-l1]", btn).textContent = l1;
    $("[data-l2]", btn).textContent = l2;
    btn.disabled = !dest || !a || over;
  }
  amtIn.addEventListener("input", () => {
    const pos = amtIn.value.length - amtIn.selectionStart;
    writeAmt(amtIn, readAmt(amtIn));
    try { amtIn.setSelectionRange(amtIn.value.length - pos, amtIn.value.length - pos); } catch {}
    dockState();
  });
  $("[data-clear]", dock).addEventListener("click", () => { writeAmt(amtIn, 0); dockState(); });
  $("[data-quick]", dock).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const mine = st().bank?.chips[myPlayer()] ?? 0;
    writeAmt(amtIn, b.dataset.all != null ? mine : Math.min(readAmt(amtIn) + +b.dataset.add, Math.max(mine, readAmt(amtIn))));
    dockState();
  });
  $("[data-dests]", dock).addEventListener("click", (e) => {
    const b = e.target.closest(".ct-dest");
    if (!b) return;
    const r = { k: b.dataset.k, id: b.dataset.id };
    // with one pot it's always the default; picking a player again goes back to it
    dest = sameRef(r, dest) && !(st().bank.pots.length === 1 && r.k === "pot") ? null : r;
    destAuto = false;
    renderDock();
  });
  dock.addEventListener("submit", (e) => {
    e.preventDefault();
    const a = readAmt(amtIn), me = myPlayer();
    if (!dest || !a || a > (st().bank?.chips[me] ?? 0)) return;
    const to = dest;
    ctx.dispatch({ type: "transfer", from: { k: "p", id: me }, to, amount: a });
    writeAmt(amtIn, 0);
    // a single pot stays picked; anything else is picked again next time
    if (!(to.k === "pot" && st().bank.pots.length === 1)) dest = null;
    amtIn.blur();
    renderDock();
  });
  // keys typed into the dock aren't the table's shortcuts
  dock.addEventListener("keydown", (e) => e.stopPropagation());

  // ---- a note by the pot when chips move ----
  const notes = document.createElement("div");
  notes.className = "ct-notes";
  document.body.appendChild(notes);
  function note(line, potId) {
    const n = document.createElement("div");
    n.className = "ct-note";
    n.innerHTML = partsHTML(line.parts, st());
    notes.prepend(n);
    while (notes.children.length > 3) notes.lastChild.remove();
    placeNotes(potId);
    setTimeout(() => { n.classList.add("ct-note-out"); setTimeout(() => n.remove(), 300); }, 3200);
  }
  // just above the pot the chips went to (or the first pot), on screen
  let notesPot = null;
  function placeNotes(potId = notesPot) {
    notesPot = potId;
    const card = document.querySelector(`.ct-pot[data-pot="${CSS.escape(potId ?? "")}"]`) ?? document.querySelector(".ct-pot");
    if (!card) { notes.style.left = "50%"; notes.style.top = "70px"; return; }
    const r = card.getBoundingClientRect();
    notes.style.left = `${r.left + r.width / 2}px`;
    notes.style.top = `${r.top - 8}px`;
  }

  return {
    renderDock,
    chipsSheet, potSheet, playerSheet,
    // a change landed: a note for chips moving, and every open sheet catches up
    changed(line) {
      renderDock();
      sheetUpdate?.();
      if (line?.money && st().bank) note(line, line.parts.find((x) => x?.r === "pot")?.id ?? null);
      if (notes.children.length) placeNotes();
    },
    get dockHeight() { return dock.hidden ? 0 : dock.offsetHeight + 12; },
  };
}
