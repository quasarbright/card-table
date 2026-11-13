// The page: one table, played by hand. Pointer and keyboard input turn into table actions
// (see table.mjs), which are applied and drawn. Everything here is local for now; the
// actions are already the messages a shared table would send.
import { newTable, apply, shuffledOrder, locate, handCenter, seatAngle, MAX_SEATS, RANKS, SUITS, CARD_W, CARD_H, TABLE_R, FELT_R } from "./table.mjs";
import { createView, HAND_R, OWN_HAND_R, GRIP_REACH } from "./view.mjs";
import { suitDefs } from "./faces.mjs";
import { startAboutDiagram } from "./about.mjs";

document.body.insertAdjacentHTML("afterbegin", suitDefs());

const SAVE_KEY = "card-table:state";
let state = load() ?? newTable(4);
let me = state.seats[0].id;
const view = createView(document.getElementById("table"), { viewer: me });

let drag = null;      // what's being carried
let pending = null;   // a press that hasn't become a drag yet
let hovered = null;   // { card } or { pile }: what keyboard shortcuts act on
let menu = null;

// ---- state ---------------------------------------------------------------------------------

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY));
    return s && s.cards && s.piles && s.hands && s.seats ? s : null;
  } catch { return null; }
}
function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch {} }

function dispatch(action, renderOpts = {}) {
  state = apply(state, action);
  save();
  draw(renderOpts);
}

function draw(o = {}) {
  view.render(state, {
    ...o,
    drag: drag && drag.active ? drag : null,
    target: drag?.target,
    presence: drag?.active ? [{ seat: me, cards: drag.cards ?? state.piles[drag.pile]?.cards ?? [] }] : [],
  });
}

function relayout() {
  const narrow = innerWidth < 600;
  view.stage.classList.add("ct-still");
  view.layout(narrow ? 70 : 20, narrow ? 120 : 92);
  draw({ instant: true });
  requestAnimationFrame(() => view.stage.classList.remove("ct-still"));
}

// ---- the bottom bar ------------------------------------------------------------------------

const playersEl = document.getElementById("players");
const viewerEl = document.getElementById("viewer");
function fillSelects() {
  playersEl.innerHTML = Array.from({ length: MAX_SEATS - 1 }, (_, i) => {
    const n = i + 2;
    return `<button role="radio" aria-checked="${n === state.seats.length}" data-n="${n}">${n}</button>`;
  }).join("");
  viewerEl.innerHTML = state.seats.map((s) =>
    `<button role="radio" aria-checked="${s.id === me}" data-seat="${s.id}" style="--seat:${s.color}" aria-label="${s.name}" data-tip="${s.name}"></button>`).join("");
}
playersEl.addEventListener("click", (e) => {
  const n = +e.target.closest("[data-n]")?.dataset.n;
  if (!n || n === state.seats.length) return;
  dispatch({ type: "setSeats", n });
  if (!state.seats.some((s) => s.id === me)) me = state.seats[0].id;
  setViewer(me);
});
viewerEl.addEventListener("click", (e) => {
  const id = e.target.closest("[data-seat]")?.dataset.seat;
  if (id) setViewer(id);
});
function setViewer(id) {
  me = id; view.viewer = id;
  fillSelects();
  closeMenu();
  draw();
}
document.getElementById("gather").addEventListener("click", () => {
  dispatch({ type: "gather", id: newId(), x: 500, y: 500, rot: view.uprightRot() });
});

// ---- helpers -------------------------------------------------------------------------------

let idCounter = 0;
function newId() { return `p${Date.now().toString(36)}${(idCounter++).toString(36)}`; }

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
  // into a hand: inside its zone, at the slot the pointer is over
  const n = state.seats.length;
  for (let i = 0; i < n; i++) {
    const seat = state.seats[i], own = seat.id === me;
    const c = handCenter(i, n, own ? OWN_HAND_R : HAND_R), a = seatAngle(i, n);
    const right = { x: Math.sin(a), y: -Math.cos(a) }, out = { x: Math.cos(a), y: Math.sin(a) };
    const along = (x - c.x) * right.x + (y - c.y) * right.y, across = (x - c.x) * out.x + (y - c.y) * out.y;
    if (Math.abs(along) > (own ? 150 : 115) || Math.abs(across) > (own ? 75 : 60)) continue;
    let index = 0;
    for (const id of state.hands[seat.id]) {
      const q = place.get(id);
      if ((q.x - c.x) * right.x + (q.y - c.y) * right.y < along) index++;
    }
    return { hand: seat.id, index };
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
    }, HOLD_MS);
  }
});
// the right button while carrying (the left one held down) flips what you carry
addEventListener("mousedown", (e) => { if (drag && e.button === 2) { e.preventDefault(); flipCarried(); } });

tableEl.addEventListener("pointermove", (e) => {
  if (drag && e.pointerId !== drag.pointerId) return;
  if (!pending && !drag) { hovered = targetOf(e.target); return; }
  const p = view.toTable(e.clientX, e.clientY);
  if (pending && !drag) {
    if (Math.hypot(e.clientX - pending.sx, e.clientY - pending.sy) < (pending.touch ? 8 : 4)) return;
    clearTimeout(pending.timer);
    startDrag(pending, view.toTable(pending.sx, pending.sy));
    pending = null;
  }
  if (drag) {
    drag.x = p.x + drag.offX; drag.y = p.y + drag.offY;
    drag.target = dropTarget(p.x, p.y);
    draw();
  }
});

function startDrag(t, at) {
  const place = view.placement(state);
  if (t.whole) {
    const pile = state.piles[t.pile];
    drag = { active: true, whole: true, pile: t.pile, rot: pile.rot, offX: pile.x - at.x, offY: pile.y - at.y };
  } else {
    const q = place.get(t.card);
    drag = { active: true, cards: [t.card], from: t, rot: view.uprightRot(), offX: q.x - at.x, offY: q.y - at.y };
  }
  drag.pointerId = t.pointerId;
  drag.x = at.x + drag.offX; drag.y = at.y + drag.offY;
}

function flipCarried() {
  if (!drag) return;
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
  const to = d.target;
  if (d.whole) {
    const cards = state.piles[d.pile].cards;
    if (to?.pile) dispatch({ type: "moveCards", cards: [...cards], to: { pile: to.pile } });
    else if (to?.hand) dispatch({ type: "moveCards", cards: [...cards], to: { hand: to.hand, index: to.index } });
    else dispatch({ type: "movePile", pile: d.pile, x: d.x, y: d.y });
  } else {
    const from = d.from;
    const alone = from.pile && state.piles[from.pile].cards.length === 1;
    if (to?.pile) dispatch({ type: "moveCards", cards: d.cards, to: { pile: to.pile } });
    else if (to?.hand) dispatch({ type: "moveCards", cards: d.cards, to: { hand: to.hand, index: to.index } });
    else if (alone) dispatch({ type: "movePile", pile: from.pile, x: d.x, y: d.y, rot: d.rot });
    else dispatch({ type: "moveCards", cards: d.cards, to: { newPile: { id: newId(), x: d.x, y: d.y, rot: d.rot + (Math.random() - .5) * 0.06 } } });
  }
});
tableEl.addEventListener("pointercancel", (e) => {
  if (drag && e.pointerId !== drag.pointerId) return;
  clearTimeout(pending?.timer); pending = null; drag = null; draw();
});
tableEl.addEventListener("pointerleave", () => { if (!drag) hovered = null; });

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
  dispatch({ type: "flipPile", pile: pileId }, { stackFlip: { cards: new Set(p.cards), x: at.x, y: at.y } });
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
  const delays = new Map(order.map((id, k) => [id, k * 70]));
  dispatch({ type: "deal", pile: pileId, count, seats }, { delays });
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
  const look = () => item(c.privateTo === me ? "Stop looking" : "Look at it", "P", () => toggleLook(t));
  if (t.hand) {
    item(c.faceUp ? "Hide it again" : "Show everyone", "F", () => flipTarget(t));
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

// ---- keyboard: acts on the card or stack under the pointer --------------------------------

addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeMenu(); return; }
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
fillSelects();
addEventListener("resize", relayout);
relayout();
startAboutDiagram();

// test hook (e2e/*.spec.mjs)
window.cardTable = {
  get state() { return state; }, get me() { return me; }, view, dispatch, setViewer, deal, shufflePile, split,
  reset(n = 4) { state = newTable(n); save(); setViewer(state.seats[0].id); },
  cardSize: [CARD_W, CARD_H],
};
