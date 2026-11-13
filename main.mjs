// The page: one table, played by hand. Pointer and keyboard input turn into table actions
// (see table.mjs), which are applied and drawn. Everything here is local for now; the
// actions are already the messages a shared table would send.
import { newTable, apply, shuffledOrder, locate, handCenter, seatAngle, MAX_SEATS, RANKS, SUITS, CARD_W, CARD_H } from "./table.mjs";
import { createView, HAND_R, OWN_HAND_R } from "./view.mjs";
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
let lastTap = null;   // for double-click / double-tap
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
  playersEl.innerHTML = Array.from({ length: MAX_SEATS - 1 }, (_, i) => `<option value="${i + 2}">${i + 2}</option>`).join("");
  playersEl.value = state.seats.length;
  viewerEl.innerHTML = state.seats.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");
  viewerEl.value = me;
}
playersEl.addEventListener("change", () => {
  dispatch({ type: "setSeats", n: +playersEl.value });
  if (!state.seats.some((s) => s.id === me)) setViewer(state.seats[0].id);
  fillSelects();
});
viewerEl.addEventListener("change", () => setViewer(viewerEl.value));
function setViewer(id) {
  me = id; view.viewer = id;
  viewerEl.value = id;
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
  if (cardEl) {
    let id = cardEl.dataset.id;
    const where = locate(state, id);
    if (!where) return null;
    if (where.pile) {
      const p = state.piles[where.pile];
      if (!p.spread) id = p.cards.at(-1);
      return { card: id, pile: p.id };
    }
    return { card: id, hand: where.hand };
  }
  const grip = elem?.closest?.(".ct-grip");
  if (grip && state.piles[grip.dataset.pile]) return { pile: grip.dataset.pile, whole: true };
  return null;
}

// where carried cards would land if dropped at (x, y), in table coordinates
function dropTarget(x, y) {
  const carried = new Set(drag.cards ?? state.piles[drag.pile].cards);
  const place = view.placement(state);
  // onto a stack: the pointer over its top card (or any card of a spread) or its count tab
  let best = null, bestD = Infinity;
  const down = view.screenDir(0, 1), reach = CARD_H / 2 + 12;
  for (const p of Object.values(state.piles)) {
    if (p.id === drag.pile && drag.whole) continue;
    const rest = p.cards.filter((id) => !carried.has(id));
    if (!rest.length) continue;
    const candidates = p.spread ? rest : [rest.at(-1)];
    for (const id of candidates) {
      const q = place.get(id);
      const c = Math.cos(-q.rot), s = Math.sin(-q.rot);
      const lx = (x - q.x) * c - (y - q.y) * s, ly = (x - q.x) * s + (y - q.y) * c;
      const onCard = Math.abs(lx) < CARD_W / 2 + 6 && Math.abs(ly) < CARD_H / 2 + 6;
      const onTab = !p.spread && p.cards.length > 1 &&
        Math.hypot(x - (q.x + down.x * reach), y - (q.y + down.y * reach)) < 22;
      const d = Math.hypot(q.x - x, q.y - y);
      if ((onCard || onTab) && d < bestD) { bestD = d; best = { pile: p.id, card: p.spread ? id : rest.at(-1) }; }
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

tableEl.addEventListener("pointerdown", (e) => {
  if (menu && !menu.contains(e.target)) closeMenu();
  if (e.button !== 0) return;
  const t = targetOf(e.target);
  if (!t) return;
  e.preventDefault();
  tableEl.setPointerCapture(e.pointerId);
  pending = { ...t, sx: e.clientX, sy: e.clientY, pointerId: e.pointerId, touch: e.pointerType !== "mouse" };
  if (pending.touch) {
    pending.timer = setTimeout(() => {
      if (pending && !drag) { const p = pending; pending = null; openMenu(p, p.sx, p.sy); }
    }, 480);
  }
});

tableEl.addEventListener("pointermove", (e) => {
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
  drag.x = at.x + drag.offX; drag.y = at.y + drag.offY;
}

tableEl.addEventListener("pointerup", (e) => {
  if (pending) {
    clearTimeout(pending.timer);
    const t = pending; pending = null;
    const now = performance.now();
    const key = t.card ?? t.pile;
    if (lastTap && lastTap.key === key && now - lastTap.time < 350) { lastTap = null; flipTarget(t); }
    else lastTap = { key, time: now };
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
tableEl.addEventListener("pointercancel", () => { clearTimeout(pending?.timer); pending = null; drag = null; draw(); });
tableEl.addEventListener("pointerleave", () => { if (!drag) hovered = null; });

tableEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const t = targetOf(e.target);
  if (t) openMenu(t, e.clientX, e.clientY); else closeMenu();
});

// ---- the actions, as the menu and keys offer them -----------------------------------------

function flipTarget(t) {
  if (t.whole) dispatch({ type: "flipPile", pile: t.pile });
  else dispatch({ type: "flip", cards: [t.card] });
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

function openMenu(t, x, y) {
  closeMenu();
  menu = document.createElement("div");
  menu.className = "ct-menu";
  const items = [];
  const item = (label, key, fn) => items.push({ label, key, fn });
  const sep = () => items.push(null);
  const pile = t.pile ? state.piles[t.pile] : null;
  if (t.card) {
    const c = state.cards[t.card];
    if (t.hand) {
      item(c.faceUp ? "Hide it again" : "Show everyone", "F", () => flipTarget(t));
      if (state.hands[t.hand].length > 1) item("Sort hand", "", () => sortHand(t.hand));
    } else {
      item("Flip", "F", () => flipTarget(t));
      if (!c.faceUp) item(c.privateTo === me ? "Stop looking" : "Look at it", "P", () => toggleLook(t));
    }
  }
  if (pile && pile.cards.length > 1) {
    if (items.length) sep();
    item("Flip stack", "⇧F", () => flipTarget({ pile: pile.id, whole: true }));
    item("Shuffle", "S", () => shufflePile(pile.id));
    item(pile.spread ? "Stack up" : "Spread out", "", () => dispatch({ type: "setSpread", pile: pile.id, spread: !pile.spread }));
    item("Deal…", "", () => showDeal(pile.id), true);
  }
  if (!items.length) return;
  for (const it of items) {
    if (!it) { menu.appendChild(document.createElement("hr")); continue; }
    const b = document.createElement("button");
    b.className = "ct-item";
    b.innerHTML = `<span>${it.label}</span><kbd>${it.key}</kbd>`;
    b.addEventListener("click", () => {
      if (it.label === "Deal…") { it.fn(); return; }
      closeMenu(); it.fn();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  placeMenu(x, y);
}

function placeMenu(x, y) {
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
}

let dealCount = 5;
function showDeal(pileId) {
  const n = state.seats.length;
  const max = Math.max(1, Math.floor(state.piles[pileId].cards.length / n));
  dealCount = Math.min(dealCount, max);
  const x = parseFloat(menu.style.left), y = parseFloat(menu.style.top);
  menu.innerHTML = `
    <div class="ct-deal">
      <div class="muted">Cards to each player</div>
      <div class="ct-deal-row">
        <button class="btn ct-step" data-d="-1" title="One fewer card each">−</button>
        <span class="ct-count">${dealCount}</span>
        <button class="btn ct-step" data-d="1" title="One more card each">+</button>
        <button class="btn btn-primary" data-deal title="Deal from the top of the stack, one card at a time around the table">Deal</button>
      </div>
    </div>`;
  const count = menu.querySelector(".ct-count");
  menu.querySelectorAll(".ct-step").forEach((b) => b.addEventListener("click", () => {
    dealCount = Math.max(1, Math.min(max, dealCount + +b.dataset.d));
    count.textContent = dealCount;
  }));
  menu.querySelector("[data-deal]").addEventListener("click", () => { closeMenu(); deal(pileId, dealCount); });
  placeMenu(x, y);
}

// ---- keyboard: acts on the card or stack under the pointer --------------------------------

addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeMenu(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey || drag || !hovered) return;
  if (e.target.closest?.("input, select, textarea")) return;
  const t = hovered;
  if (t.card && !locate(state, t.card)) return;
  const k = e.key.toLowerCase();
  if (k === "f") {
    if (e.shiftKey && t.pile && state.piles[t.pile]) flipTarget({ pile: t.pile, whole: true });
    else if (t.card) flipTarget(t);
    else flipTarget(t);
  } else if (k === "p" && t.card && !t.hand) toggleLook(t);
  else if (k === "s" && t.pile && state.piles[t.pile]?.cards.length > 1) shufflePile(t.pile);
  else return;
  e.preventDefault();
  hovered = null;
});

// ---- start ---------------------------------------------------------------------------------

if (matchMedia("(pointer: coarse)").matches) {
  document.getElementById("hint").textContent =
    "Drag cards anywhere. Double-tap to flip one. Press and hold a card or a stack's count for shuffle, deal and the rest.";
}
fillSelects();
addEventListener("resize", relayout);
relayout();
startAboutDiagram();

// test hook (e2e/*.spec.mjs)
window.cardTable = {
  get state() { return state; }, get me() { return me; }, view, dispatch, setViewer, deal, shufflePile,
  reset(n = 4) { state = newTable(n); save(); fillSelects(); setViewer(state.seats[0].id); },
  cardSize: [CARD_W, CARD_H],
};
