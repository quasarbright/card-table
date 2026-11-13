// The page: one shared table, played by hand. Pointer and keyboard input turn into table
// actions (see table.mjs). A session (sync.mjs) applies them and keeps every player's table the
// same; while you drag, where your cards are is streamed to everyone else as it happens.
import { newTable, apply, shuffledOrder, locate, handCenter, seatAngle, MAX_SEATS, RANKS, SUITS, CARD_W, CARD_H, TABLE_R, FELT_R } from "./table.mjs";
import { createView, HAND_R, OWN_HAND_R, GRIP_REACH, handGap, handReach } from "./view.mjs";
import { suitDefs } from "./faces.mjs";
import { startAboutDiagram } from "./about.mjs";
import { connect } from "./net.mjs";
import { hostSession, clientSession } from "./sync.mjs";
import { openGate, closeGate, swatches, wireSwatches } from "./gate.mjs";
import { openShare, closeShare } from "./share.mjs";

document.body.insertAdjacentHTML("afterbegin", suitDefs());

// ?net=local talks between tabs of this browser instead of over the internet (for tests); each
// tab is then its own player, so it keeps its identity per tab
const params = new URLSearchParams(location.search);
const NET = params.get("net") === "local" ? "local" : "trystero";
const store = NET === "local" ? sessionStorage : localStorage;
const read = (k) => { try { return store.getItem(`card-table:${k}`); } catch { return null; } };
const write = (k, v) => { try { store.setItem(`card-table:${k}`, v); } catch {} };

// this browser's player id, kept so a reload sits you back in your seat
let player = read("player");
if (!player) { player = Math.random().toString(36).slice(2, 12); write("player", player); }

let session = null;           // hostSession or clientSession, once you've hosted or joined
let state = newTable(4);      // the table being drawn (a blank one behind the opening screen)
let me = state.seats[0].id;   // the seat you see the table from
let online = [];              // players connected right now
const view = createView(document.getElementById("table"), { viewer: me });

let drag = null;      // what's being carried
let pending = null;   // a press that hasn't become a drag yet
let hovered = null;   // { card } or { pile }: what keyboard shortcuts act on, and what lifts
let menu = null;

// ---- the session ---------------------------------------------------------------------------

// fx: how to animate a change ({ delays: { card: ms }, stackFlip: { cards, x, y } }); it travels
// with the action so everyone sees the same deal and the same stack turning over
function dispatch(action, fx = null) { session?.dispatch(action, fx); }

function onChange(next, fx, by) {
  state = next;
  if (by) remote.delete(by); // their drop has landed
  if (!state.seats.some((s) => s.id === me)) me = session?.seat ?? state.seats[0].id;
  view.viewer = me;
  draw(fx ?? {});
  refreshBar();
}
function undo() { if (!drag) { closeMenu(); session?.undo(); } }

function draw(o = {}) {
  placeHandBar();
  const now = performance.now();
  const others = [...remote.values()].filter((r) => now - r.at < 4000).map((r) => r.d);
  view.render(state, {
    ...o,
    hover: drag || pending ? null : hovered?.card,
    drag: drag && drag.active ? drag : null,
    target: drag?.target,
    remote: others,
    online: new Set(online),
    editSeat: session?.seat ?? null,
    presence: [
      ...(drag?.active ? [{ seat: me, cards: drag.cards ?? state.piles[drag.pile]?.cards ?? [] }] : []),
      ...others.map((d) => ({ seat: d.seat, cards: d.cards ?? state.piles[d.pile]?.cards ?? [] })),
    ],
  });
}

function relayout() {
  const narrow = innerWidth < 600;
  view.stage.classList.add("ct-still");
  view.layout(narrow ? 70 : 20, narrow ? 120 : 92);
  draw({ instant: true });
  requestAnimationFrame(() => view.stage.classList.remove("ct-still"));
}

// ---- other players' drags, as they happen --------------------------------------------------

const remote = new Map(); // seat → { d: their drag, at: when it last moved }
function onRemoteDrag(d) {
  if (!d?.seat || d.seat === session?.seat) return;
  if (d.end) {
    // their drop is on its way; hold the card where it is a moment so it doesn't flick back
    const r = remote.get(d.seat);
    if (r) setTimeout(() => { if (remote.get(d.seat) === r) { remote.delete(d.seat); draw(); } }, 400);
    return;
  }
  remote.set(d.seat, { d, at: performance.now() });
  draw();
}
// yours, at most ~30 times a second, and always the last position
let lastSent = 0, sendTimer = 0;
function sendDrag() {
  if (!session || online.length < 2) return;
  const now = performance.now();
  clearTimeout(sendTimer);
  if (now - lastSent < 33) { sendTimer = setTimeout(sendDrag, 33 - (now - lastSent)); return; }
  lastSent = now;
  if (!drag?.active) { netRef?.send("drag", { seat: session.seat, end: true }); return; }
  const t = drag.target;
  netRef?.send("drag", {
    seat: session.seat, cards: drag.cards ?? null, pile: drag.pile ?? null, whole: !!drag.whole,
    x: drag.x, y: drag.y, rot: drag.rot, faceUp: drag.faceUp ?? null, inHand: !!drag.inHand,
    from: drag.from?.hand ? { hand: drag.from.hand } : null,
    target: t ? { hand: t.hand ?? null, slot: t.slot ?? null, pile: t.pile ?? null } : null,
  });
}

// ---- hosting and joining ---------------------------------------------------------------------

let netRef = null;
const newTableId = () => Math.random().toString(36).slice(2, 10);
function tableUrl(id) {
  const u = new URL(location.href);
  u.search = ""; u.hash = "";
  u.searchParams.set("t", id);
  if (NET === "local") u.searchParams.set("net", "local");
  return u.toString();
}

function hostSave(id) { return (st) => write(`host:${id}`, JSON.stringify(st)); }
function hostSaved(id) { try { return JSON.parse(read(`host:${id}`)); } catch { return null; } }

function startHost(id, name, color) {
  history.replaceState(null, "", tableUrl(id));
  let st = hostSaved(id);
  if (!st?.seats?.some((s) => s.player === player)) {
    st = st ?? newTable(4);
    st = apply(st, { type: "sit", seat: st.seats.find((s) => !s.player)?.id ?? st.seats[0].id, player, name, color });
  }
  const net = connect(id, NET);
  netRef = net;
  online = [player];
  session = hostSession(net, st, { player, name }, {
    onChange, save: hostSave(id), onRoster(list) { online = list; refreshBar(); draw(); },
  });
  net.on("drag", onRemoteDrag);
  net.start();
  hostSave(id)(st);
  state = st; me = session.seat; view.viewer = me;
  closeGate();
  relayout(); refreshBar();
}

function startJoin(id, name, color) {
  const net = connect(id, NET);
  netRef = net;
  openGate({ step: "connecting" });
  const giveUp = setTimeout(() => {
    if (!session?.connected) openGate({ step: "unreachable", retry: () => location.reload() });
  }, 25000);
  session = clientSession(net, { player, name, color }, {
    onChange,
    onWelcome(seat) {
      clearTimeout(giveUp);
      if (!seat) { openGate({ step: "full", host: hostOwn }); return; }
      write(`joined:${id}`, "1");
      me = seat; view.viewer = me;
      closeGate();
      relayout();
    },
    onRoster(list) { online = list; refreshBar(); draw(); },
    onLost() { remote.clear(); openGate({ step: "lost", host: hostOwn }); },
  });
  net.on("drag", onRemoteDrag);
  net.start();
}
const hostOwn = () => { location.href = tableUrl("").replace(/[?&]t=[^&]*/, "").replace(/\?$/, ""); };

// ---- the bottom bar ------------------------------------------------------------------------

const undoEl = document.getElementById("undo");
undoEl.addEventListener("click", undo);
const playersEl = document.getElementById("players");
const viewerEl = document.getElementById("viewer");
// the host sets how many seats there are; while the host is alone they can sit in any seat to
// check what each player sees
function refreshBar() {
  const host = !!session?.isHost, alone = online.length < 2;
  undoEl.disabled = !session?.canUndo();
  playersEl.closest(".ct-group").hidden = !host;
  viewerEl.closest(".ct-group").hidden = !(host && alone);
  document.getElementById("gather").hidden = !session;
  document.getElementById("share").hidden = !session;
  if (host && !alone && me !== session.seat) { me = session.seat; view.viewer = me; draw(); }
  const taken = state.seats.reduce((m, s, i) => (s.player ? i + 1 : m), 2);
  playersEl.innerHTML = Array.from({ length: MAX_SEATS - 1 }, (_, i) => {
    const n = i + 2;
    return `<button role="radio" aria-checked="${n === state.seats.length}" data-n="${n}"${n < taken ? " disabled" : ""}>${n}</button>`;
  }).join("");
  viewerEl.innerHTML = state.seats.map((s) =>
    `<button role="radio" aria-checked="${s.id === me}" data-seat="${s.id}" style="--seat:${s.color}" aria-label="${s.name}" data-tip="${s.name}"></button>`).join("");
}
playersEl.addEventListener("click", (e) => {
  const n = +e.target.closest("[data-n]")?.dataset.n;
  if (!n || n === state.seats.length) return;
  dispatch({ type: "setSeats", n });
});
viewerEl.addEventListener("click", (e) => {
  const id = e.target.closest("[data-seat]")?.dataset.seat;
  if (id) setViewer(id);
});
function setViewer(id) {
  me = id; view.viewer = id;
  refreshBar();
  closeMenu();
  draw();
}
document.getElementById("gather").addEventListener("click", () => {
  dispatch({ type: "gather", id: newId(), x: 500, y: 500, rot: view.uprightRot() });
});
document.getElementById("share").addEventListener("click", (e) => openShare(e.currentTarget));

// ---- helpers -------------------------------------------------------------------------------

let idCounter = 0;
// pile ids are made by whoever makes the pile, so they carry the player's id to stay unique
function newId() { return `p${player.slice(0, 4)}${Date.now().toString(36)}${(idCounter++).toString(36)}`; }

// what a press on this element means: a card (the top one, for a stack) or a whole pile
function targetOf(elem) {
  const cardEl = elem?.closest?.(".ct-card");
  if (cardEl) return cardTarget(cardEl.dataset.id);
  const grip = elem?.closest?.(".ct-grip");
  if (grip && state.piles[grip.dataset.pile]) return { pile: grip.dataset.pile, whole: true };
  return null;
}
function cardTarget(id) {
  const where = locate(state, id);
  if (!where) return null;
  if (where.pile) {
    const p = state.piles[where.pile];
    return { card: p.cards.at(-1), pile: p.id };
  }
  return { card: id, hand: where.hand };
}
// the same target, after the table changed under it (a stack flipped, a card moved)
function refresh(t) {
  if (!t) return null;
  if (t.whole) return state.piles[t.pile] ? t : null;
  return cardTarget(t.card);
}
// a stack of more than one card
const isStack = (t) => !t.hand && state.piles[t.pile]?.cards.length > 1;

// where carried cards would land if dropped at (x, y), in table coordinates
function dropTarget(x, y) {
  const carried = new Set(drag.cards ?? state.piles[drag.pile].cards);
  const place = view.placement(state);
  // onto a stack: the pointer over its top card or its count tab
  let best = null, bestD = Infinity;
  const down = view.screenDir(0, 1), reach = GRIP_REACH;
  for (const p of Object.values(state.piles)) {
    if (p.id === drag.pile && drag.whole) continue;
    const rest = p.cards.filter((id) => !carried.has(id));
    if (!rest.length) continue;
    for (const id of [rest.at(-1)]) {
      const q = place.get(id);
      const c = Math.cos(-q.rot), s = Math.sin(-q.rot);
      const lx = (x - q.x) * c - (y - q.y) * s, ly = (x - q.x) * s + (y - q.y) * c;
      const onCard = Math.abs(lx) < CARD_W / 2 + 6 && Math.abs(ly) < CARD_H / 2 + 6;
      const onTab = p.cards.length > 1 &&
        Math.hypot(x - (q.x + down.x * reach), y - (q.y + down.y * reach)) < 22;
      const d = Math.hypot(q.x - x, q.y - y);
      if ((onCard || onTab) && d < bestD) { bestD = d; best = { pile: p.id, card: id }; }
    }
  }
  if (best) return best;
  // into a hand: inside its zone, at the gap nearest the pointer. `slot` counts among the cards
  // that stay; `index` is the same place counted before the carried cards leave (moveCards)
  const n = state.seats.length;
  for (let i = 0; i < n; i++) {
    const seat = state.seats[i], own = seat.id === me;
    const c = handCenter(i, n, own ? OWN_HAND_R : HAND_R), a = seatAngle(i, n);
    const right = { x: Math.sin(a), y: -Math.cos(a) }, out = { x: Math.cos(a), y: Math.sin(a) };
    const along = (x - c.x) * right.x + (y - c.y) * right.y, across = (x - c.x) * out.x + (y - c.y) * out.y;
    const hand = state.hands[seat.id], rest = hand.filter((id) => !carried.has(id));
    const shown = !!state.shownHands?.[seat.id];
    const reach = handReach(own, rest.length + 1, shown);
    if (Math.abs(along) > reach.along || Math.abs(across) > reach.across) continue;
    // each card in the closed-up hand shows its left strip (the next card covers the rest);
    // the pointer goes after every card whose strip middle it's past
    const r = rest.length, gap = handGap(own, r, shown), halfW = CARD_W / 2;
    let slot = 0;
    for (let j = 0; j < r; j++) if ((j - (r - 1) / 2) * gap - halfW + gap / 2 < along) slot = j + 1;
    const index = slot < rest.length ? hand.indexOf(rest[slot]) : hand.length;
    return { hand: seat.id, slot, index };
  }
  return null;
}

// ---- pointer input -------------------------------------------------------------------------

const tableEl = document.getElementById("table");

const keyOf = (t) => (t.whole ? `pile:${t.pile}` : t.card);
const HOLD_MS = 320; // press and hold on a stack this long and you pick up the whole stack

tableEl.addEventListener("pointerdown", (e) => {
  // a second finger while carrying flips what you carry
  if (drag) { if (e.pointerId !== drag.pointerId) { e.preventDefault(); flipCarried(); } return; }
  // a press on the card whose menu is open just closes it
  const reopen = menu && menu.forKey;
  if (menu && !menu.contains(e.target)) closeMenu();
  if (e.button !== 0) return;
  const t = targetOf(e.target);
  if (!t) return;
  e.preventDefault();
  tableEl.setPointerCapture(e.pointerId);
  pending = { ...t, sx: e.clientX, sy: e.clientY, pointerId: e.pointerId, touch: e.pointerType !== "mouse", wasOpen: reopen === keyOf(t) };
  if (isStack(t) && !t.whole) {
    const mine = pending;
    mine.timer = setTimeout(() => {
      if (pending !== mine) return;
      pending = null;
      startDrag({ pile: t.pile, whole: true, pointerId: mine.pointerId }, view.toTable(mine.sx, mine.sy));
      draw();
      sendDrag();
    }, HOLD_MS);
  }
});
// the right button while carrying (the left one held down) flips what you carry
addEventListener("mousedown", (e) => { if (drag && e.button === 2) { e.preventDefault(); flipCarried(); } });

tableEl.addEventListener("pointermove", (e) => {
  if (drag && e.pointerId !== drag.pointerId) return;
  if (!pending && !drag) { setHover(targetOf(e.target)); return; }
  const p = view.toTable(e.clientX, e.clientY);
  if (pending && !drag) {
    if (Math.hypot(e.clientX - pending.sx, e.clientY - pending.sy) < (pending.touch ? 8 : 4)) return;
    clearTimeout(pending.timer);
    startDrag(pending, view.toTable(pending.sx, pending.sy));
    pending = null;
  }
  if (drag) {
    drag.x = p.x + drag.offX; drag.y = p.y + drag.offY;
    const was = drag.target?.hand;
    drag.target = dropTarget(p.x, p.y);
    drag.inHand = drag.from?.hand === me && drag.target?.hand === me;
    // over someone else's hand a card shows its back; flip it there to show it to just them
    if (drag.from?.hand && drag.target?.hand && drag.target.hand !== me && drag.target.hand !== was) drag.faceUp = false;
    draw();
    sendDrag();
  }
});

function startDrag(t, at) {
  hovered = null;
  const place = view.placement(state);
  if (t.whole) {
    const pile = state.piles[t.pile];
    drag = { active: true, whole: true, pile: t.pile, rot: pile.rot, offX: pile.x - at.x, offY: pile.y - at.y };
  } else {
    const q = place.get(t.card);
    drag = { active: true, cards: [t.card], from: t, rot: view.uprightRot(), offX: q.x - at.x, offY: q.y - at.y };
    // the side it'll go down on: out of your hand that's face up, unless you flip it on the way
    drag.faceUp = t.hand ? t.hand === me : state.cards[t.card].faceUp;
  }
  drag.pointerId = t.pointerId;
  drag.x = at.x + drag.offX; drag.y = at.y + drag.offY;
}

function flipCarried() {
  if (!drag) return;
  if (drag.faceUp != null) { drag.faceUp = !drag.faceUp; draw(); sendDrag(); return; }
  if (drag.whole) flipStack(drag.pile, { x: drag.x, y: drag.y });
  else dispatch({ type: "flip", cards: drag.cards });
}

tableEl.addEventListener("pointerup", (e) => {
  if (drag && e.pointerId !== drag.pointerId) return;
  if (pending) {
    clearTimeout(pending.timer);
    // a click (no drag): the actions for what was clicked
    const t = pending; pending = null;
    if (!t.wasOpen) openMenu(refresh(t), t.sx, t.sy);
    return;
  }
  if (!drag) return;
  const d = drag; drag = null;
  sendDrag();
  const to = d.target;
  if (d.whole) {
    const cards = state.piles[d.pile].cards;
    if (to?.pile) dispatch({ type: "moveCards", cards: [...cards], to: { pile: to.pile } });
    else if (to?.hand) dispatch({ type: "moveCards", cards: [...cards], to: { hand: to.hand, index: to.index } });
    else dispatch({ type: "movePile", pile: d.pile, x: d.x, y: d.y });
  } else {
    const from = d.from;
    const alone = from.pile && state.piles[from.pile].cards.length === 1;
    let act;
    if (to?.pile) act = { type: "moveCards", cards: d.cards, to: { pile: to.pile } };
    else if (to?.hand) act = { type: "moveCards", cards: d.cards, to: { hand: to.hand, index: to.index } };
    else if (alone) act = { type: "movePile", pile: from.pile, x: d.x, y: d.y, rot: d.rot };
    else act = { type: "moveCards", cards: d.cards, to: { newPile: { id: newId(), x: d.x, y: d.y, rot: d.rot + (Math.random() - .5) * 0.06 } } };
    // onto the table on whichever side it was carried (into a hand, it's just held)
    const lands = from.hand ? false : state.cards[d.cards[0]].faceUp;
    if (!to?.hand && d.faceUp !== lands) act = { type: "batch", actions: [act, { type: "flip", cards: d.cards }] };
    dispatch(act);
  }
});
tableEl.addEventListener("pointercancel", (e) => {
  if (drag && e.pointerId !== drag.pointerId) return;
  clearTimeout(pending?.timer); pending = null; drag = null; draw(); sendDrag();
});
tableEl.addEventListener("pointerleave", () => { if (!drag) setHover(null); });
// the card under the pointer lifts a little; redraw only when that changes
function setHover(t) {
  const was = hovered?.card;
  hovered = t;
  if (t?.card !== was && !drag && !pending) draw();
}

tableEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (drag) return;
  const t = targetOf(e.target);
  if (t) openMenu(t, e.clientX, e.clientY); else closeMenu();
});

// ---- the actions, as the menu and keys offer them -----------------------------------------

function flipTarget(t) {
  if (t.whole) flipStack(t.pile);
  else dispatch({ type: "flip", cards: [t.card] });
}
function flipStack(pileId, at = state.piles[pileId]) {
  const p = state.piles[pileId];
  dispatch({ type: "flipPile", pile: pileId }, { stackFlip: { cards: [...p.cards], x: at.x, y: at.y } });
}
function toggleLook(t) {
  const c = state.cards[t.card];
  dispatch({ type: "setPrivate", cards: [t.card], seat: c.privateTo === me ? null : me });
}
function shufflePile(pileId) {
  const p = state.piles[pileId];
  dispatch({ type: "shuffle", pile: pileId, order: shuffledOrder(p.cards) });
  for (const id of p.cards.slice(-10)) {
    const inner = view.cardEl(id)?.firstChild;
    if (inner) { inner.classList.remove("ct-riffle"); void inner.offsetWidth; inner.classList.add("ct-riffle"); }
  }
}
// deal from the top, one card at a time, starting with the player after you
function deal(pileId, count) {
  const n = state.seats.length, mi = state.seats.findIndex((s) => s.id === me);
  const seats = Array.from({ length: n }, (_, k) => state.seats[(mi + 1 + k) % n].id);
  const order = [...state.piles[pileId].cards].reverse().slice(0, count * n);
  const delays = Object.fromEntries(order.map((id, k) => [id, k * 70]));
  dispatch({ type: "deal", pile: pileId, count, seats }, { delays });
}
// lay a hand flat and face up for everyone, or pick it back up; the cards stay in the hand
function toggleShown(seat) {
  dispatch({ type: "setHandShown", seat, shown: !state.shownHands?.[seat] });
}
function sortHand(seat) {
  const key = (id) => SUITS.indexOf(state.cards[id].suit) * 20 + RANKS.indexOf(state.cards[id].rank);
  const sorted = [...state.hands[seat]].sort((a, b) => key(a) - key(b));
  dispatch({ type: "moveCards", cards: sorted, to: { hand: seat, index: 0 } });
}

function closeMenu() { menu?.remove(); menu = null; }

// The menu is a small card of choices, opened where you clicked. Deal and Split swap its
// contents for a counter.
function openMenu(t, x, y) {
  closeMenu();
  if (!t) return;
  const items = [];
  const item = (label, key, fn, keepOpen = false) => items.push({ label, key, fn, keepOpen });
  const sep = () => { if (items.length && items.at(-1)) items.push(null); };
  const pile = t.pile ? state.piles[t.pile] : null;
  const c = t.card ? state.cards[t.card] : null;
  const look = () => item(c.privateTo === me ? "Stop peeking" : isStack(t) ? "Peek top card" : "Peek", "P", () => toggleLook(t));
  if (t.hand) {
    item(state.shownHands?.[t.hand] ? "Hide hand" : "Show hand", "", () => toggleShown(t.hand));
    if (state.hands[t.hand].length > 1) item("Sort hand", "", () => sortHand(t.hand));
  } else if (isStack(t)) {
    // F turns the whole stack over; the top card on its own is ⇧F
    item("Flip stack", "F", () => flipStack(pile.id));
    if (c) {
      item("Flip top card", "⇧F", () => flipTarget({ card: t.card, pile: pile.id }));
      if (!c.faceUp) look();
    }
  } else if (c) {
    item("Flip", "F", () => flipTarget(t));
    if (!c.faceUp) look();
  }
  if (pile && pile.cards.length > 1) {
    sep();
    item("Shuffle", "S", () => shufflePile(pile.id));
    item(pile.messy ? "Straighten stack" : "Show top few", "", () => dispatch({ type: "setMessy", pile: pile.id, messy: !pile.messy }));
    item("Deal…", "", () => showDeal(pile.id), true);
    item("Split…", "", () => showSplit(pile.id), true);
  }
  if (!items.length) return;
  menu = document.createElement("div");
  menu.className = "ct-menu";
  menu.forKey = keyOf(t);
  for (const it of items) {
    if (!it) { menu.appendChild(document.createElement("hr")); continue; }
    const b = document.createElement("button");
    b.className = "ct-item";
    b.innerHTML = `<span>${it.label}</span>${it.key ? `<kbd>${it.key}</kbd>` : ""}`;
    b.addEventListener("click", () => { if (!it.keepOpen) closeMenu(); it.fn(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  // just off the pointer, so clicking the same spot again reaches the card, not the menu
  placeMenu(x + 8, y + 8);
}

function placeMenu(x, y) {
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
}

// swap the menu's contents for a counter: − n +, and the buttons below it
function counter({ title, value, min, max, unit, buttons }) {
  const x = parseFloat(menu.style.left), y = parseFloat(menu.style.top);
  menu.innerHTML = `
    <div class="ct-pop">
      <div class="ct-pop-title">${title}</div>
      <div class="ct-stepper">
        <button class="ct-step" data-d="-1" aria-label="fewer">−</button>
        <output class="ct-count">${value}</output>
        <button class="ct-step" data-d="1" aria-label="more">+</button>
        <span class="ct-unit"></span>
      </div>
      <div class="ct-pop-actions"></div>
    </div>`;
  const out = menu.querySelector(".ct-count"), unitEl = menu.querySelector(".ct-unit");
  const actions = menu.querySelector(".ct-pop-actions");
  const btns = buttons.map((b) => {
    const el = document.createElement("button");
    el.className = b.primary ? "ct-act ct-act-ink" : "ct-act";
    if (b.data) el.dataset[b.data] = "";
    el.addEventListener("click", () => { closeMenu(); b.run(value); });
    actions.appendChild(el);
    return [el, b];
  });
  const update = () => {
    out.textContent = value;
    unitEl.textContent = unit(value);
    for (const [el, b] of btns) el.textContent = b.label(value);
    menu.querySelector('[data-d="-1"]').disabled = value <= min;
    menu.querySelector('[data-d="1"]').disabled = value >= max;
  };
  menu.querySelectorAll(".ct-step").forEach((b) => b.addEventListener("click", () => {
    value = Math.max(min, Math.min(max, value + +b.dataset.d));
    update();
  }));
  update();
  placeMenu(x, y);
  return () => value;
}

let dealCount = 5;
function showDeal(pileId) {
  const n = state.seats.length, total = state.piles[pileId].cards.length;
  const max = Math.max(1, Math.floor(total / n));
  dealCount = Math.min(dealCount, max);
  counter({
    title: "Deal from the top, one card at a time around the table",
    value: dealCount, min: 1, max, unit: (v) => (v === 1 ? "card each" : "cards each"),
    buttons: [
      { primary: true, data: "deal", label: (v) => `Deal ${v} each`, run: (v) => { dealCount = v; deal(pileId, v); } },
      { data: "dealAll", label: () => `Deal all ${total}`, run: () => deal(pileId, Math.ceil(total / n)) },
    ],
  });
}

let splitCount = 2;
function showSplit(pileId) {
  const total = state.piles[pileId].cards.length;
  const max = Math.min(total, 8);
  splitCount = Math.min(splitCount, max);
  counter({
    title: "Cut into even stacks, side by side",
    value: splitCount, min: 2, max, unit: () => "stacks",
    buttons: [{ primary: true, data: "split", label: (v) => `Split into ${v}`, run: (v) => { splitCount = v; split(pileId, v); } }],
  });
}

// lay the parts out in a row across the viewer's view, centered on the stack, kept on the felt
function split(pileId, n) {
  const p = state.piles[pileId];
  const right = view.screenDir(1, 0), gap = CARD_W + 34;
  const parts = Array.from({ length: n }, (_, k) => {
    const along = (k - (n - 1) / 2) * gap;
    let x = p.x + right.x * along, y = p.y + right.y * along;
    const r = Math.hypot(x - TABLE_R, y - TABLE_R), lim = FELT_R - 80;
    if (r > lim) { x = TABLE_R + (x - TABLE_R) * lim / r; y = TABLE_R + (y - TABLE_R) * lim / r; }
    return { id: k === 0 ? pileId : newId(), x, y, rot: p.rot };
  });
  dispatch({ type: "split", pile: pileId, parts });
}

// ---- your name and color, from the pencil by your name ---------------------------------------

let editor = null;
function closeEditor() { editor?.remove(); editor = null; }
function openEditor(anchor) {
  closeEditor(); closeMenu();
  const seat = state.seats.find((s) => s.id === session?.seat);
  if (!seat) return;
  // other players' colors are taken; an empty seat's color is yours to take
  const taken = Object.fromEntries(state.seats.filter((s) => s !== seat && s.player).map((s) => [s.color, s.name]));
  editor = document.createElement("div");
  editor.className = "ct-menu ct-editor";
  editor.innerHTML = `
    <form class="ct-pop">
      <label class="ct-pop-title" for="ct-edit-name">Your name</label>
      <input id="ct-edit-name" class="ct-share-url" maxlength="20" spellcheck="false" />
      <div class="ct-pop-title">Your color</div>
      ${swatches(seat.color, taken)}
      <div class="ct-pop-actions"><button class="ct-act ct-act-ink" type="submit">Save</button></div>
    </form>`;
  document.body.appendChild(editor);
  const input = editor.querySelector("input");
  input.value = seat.name;
  let color = seat.color;
  wireSwatches(editor, (c) => { color = c; });
  editor.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.trim() || seat.name;
    write("name", name); write("color", color);
    dispatch({ type: "setPlayer", seat: seat.id, name, ...(color !== seat.color ? { color } : {}) });
    closeEditor();
  });
  const a = anchor.getBoundingClientRect(), r = editor.getBoundingClientRect();
  editor.style.left = `${Math.max(8, Math.min(a.left + a.width / 2 - r.width / 2, innerWidth - r.width - 8))}px`;
  editor.style.top = `${a.top - r.height - 10 > 8 ? a.top - r.height - 10 : Math.min(a.bottom + 10, innerHeight - r.height - 8)}px`;
  input.focus(); input.select();
}
tableEl.addEventListener("click", (e) => {
  const b = e.target.closest?.(".ct-plate-edit");
  if (b) openEditor(b);
});
addEventListener("pointerdown", (e) => {
  if (editor && !editor.contains(e.target) && !e.target.closest?.(".ct-plate-edit")) closeEditor();
});

// ---- your hand's buttons, beside it whenever you hold cards ----------------------------------

const handBar = document.createElement("div");
handBar.className = "ct-handbar";
handBar.innerHTML = `
  <button data-show></button>
  <button data-sort title="Sort your hand by suit, then rank">Sort</button>`;
document.body.appendChild(handBar);
handBar.querySelector("[data-show]").addEventListener("click", () => toggleShown(me));
handBar.querySelector("[data-sort]").addEventListener("click", () => sortHand(me));

function placeHandBar() {
  const hand = state.hands[me] ?? [];
  handBar.classList.toggle("ct-on", hand.length > 0);
  handBar.querySelector("[data-sort]").hidden = hand.length < 2;
  if (!hand.length) return;
  const shown = !!state.shownHands?.[me];
  const btn = handBar.querySelector("[data-show]");
  btn.textContent = shown ? "Hide hand" : "Show hand";
  btn.title = shown ? "Pick your hand back up, so only you see it" : "Lay your hand flat and face up, so everyone sees it. It stays your hand.";
  const i = state.seats.findIndex((x) => x.id === me), n = state.seats.length, a = seatAngle(i, n);
  const r = handBar.getBoundingClientRect();
  // your name plate's middle, on the rail
  const rr = (FELT_R + TABLE_R) / 2;
  const p = view.toScreen(TABLE_R + rr * Math.cos(a), TABLE_R + rr * Math.sin(a));
  if (innerWidth < 600) {
    // narrow: centered under your name
    handBar.style.left = `${p.x - r.width / 2}px`; handBar.style.top = `${p.y + 22}px`;
  } else {
    // to the right of your name
    handBar.style.left = `${p.x + 92}px`; handBar.style.top = `${p.y - r.height / 2}px`;
  }
}

// ---- keyboard: acts on the card or stack under the pointer --------------------------------

addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeMenu(); closeShare(); closeEditor(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.target.closest?.("input, textarea")) {
    e.preventDefault();
    if (!e.shiftKey) undo();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.("input, select, textarea")) return;
  if (drag) {
    if (e.key.toLowerCase() === "f" && !e.repeat) { e.preventDefault(); flipCarried(); }
    return;
  }
  // what's under the pointer, as the table is now: pressing F again flips again
  const t = hovered = refresh(hovered);
  if (!t) return;
  const k = e.key.toLowerCase();
  if (k === "f") {
    if (e.repeat) return e.preventDefault();
    // a stack turns over as a whole; ⇧F turns just its top card
    if (t.hand) return;
    if (t.whole || (isStack(t) && !e.shiftKey)) flipStack(t.pile);
    else if (t.card) flipTarget({ card: t.card });
  } else if (k === "p" && t.card && !t.hand) toggleLook(t);
  else if (k === "s" && t.pile && state.piles[t.pile]?.cards.length > 1) shufflePile(t.pile);
  else return;
  e.preventDefault();
  closeMenu();
});

// ---- start ---------------------------------------------------------------------------------

if (matchMedia("(pointer: coarse)").matches) {
  document.getElementById("hint").textContent =
    "Drag a card to move it, or press and hold a stack to move all of it. Tap for everything else.";
}
addEventListener("resize", relayout);
relayout();
refreshBar();
startAboutDiagram();

// Where to begin: a table link (?t=…) joins that table, or resumes it if you're its host or have
// been at it before; otherwise the opening screen offers to host one.
{
  const id = params.get("t");
  const name = read("name") ?? "", color = read("color") ?? undefined;
  const remember = (n, c) => { write("name", n); write("color", c); };
  if (id && hostSaved(id) && name) startHost(id, name, color);
  else if (id && read(`joined:${id}`) && name) startJoin(id, name, color);
  else if (id) openGate({ step: "name", joining: true, name, color, done: (n, c) => { remember(n, c); startJoin(id, n, c); } });
  else openGate({ step: "start", name, color, done: (n, c) => { remember(n, c); startHost(newTableId(), n, c); } });
}

// test hook (e2e/*.spec.mjs)
window.cardTable = {
  get state() { return state; }, get me() { return me; }, get session() { return session; }, get online() { return online; },
  view, dispatch, setViewer, deal, shufflePile, split, undo, toggleShown,
  // host only: a fresh table with n seats, you in the first, no history
  reset(n = 4) {
    const st = apply(newTable(n), { type: "sit", seat: "s0", player, name: read("name") ?? "You", color: read("color") ?? undefined });
    session.replace(st);
  },
  cardSize: [CARD_W, CARD_H],
};
