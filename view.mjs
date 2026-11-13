// Draws a table state as one seat sees it. Cards are DOM elements, one per card, kept across
// renders so CSS transitions animate every move (a deal, a card snapping into a hand). The
// same view runs the main table and the small tables in the about modal.
import { TABLE_R, FELT_R, CARD_W, CARD_H, seatAngle, handCenter, canSee, tiltedToward, locate } from "./table.mjs";
import { faceSVG, backSVG } from "./faces.mjs";

const DEG = 180 / Math.PI;
export const HAND_R = FELT_R - 62;          // where other seats' hands sit
export const OWN_HAND_R = FELT_R - 66;      // the viewer's own hand, a bit closer to them and bigger
export const OWN_HAND_SCALE = 1.3;
const HELD_TILT = 38, LOOK_TILT = 28; // degrees: a held card, a face-down card being looked at

export function createView(root, { viewer = "s0", interactive = true } = {}) {
  root.classList.add("ct-view");
  const stage = el("div", "ct-stage", root);
  el("div", "ct-rail", stage);
  el("div", "ct-felt", stage);
  const seatLayer = el("div", "ct-seats", stage);
  const zoneLayer = el("div", "ct-zones", stage);
  const cardLayer = el("div", "ct-cards", stage);
  const gripLayer = el("div", "ct-grips", stage);
  const tagLayer = el("div", "ct-tags", stage);
  stage.style.width = stage.style.height = `${2 * TABLE_R}px`;

  const cardEls = new Map();   // card id → element
  const shown = new Map();     // card id → "face" | "back" (what the viewer currently sees)
  let frame = { cx: 0, cy: 0, s: 1, rot: 0 };
  let state = null, opts = {};

  const view = {
    root, stage,
    get viewer() { return viewer; },
    set viewer(v) { viewer = v; },
    // screen ⇄ table coordinates
    toTable(clientX, clientY) {
      const b = root.getBoundingClientRect();
      const dx = (clientX - b.left - frame.cx) / frame.s, dy = (clientY - b.top - frame.cy) / frame.s;
      const c = Math.cos(-frame.rot), s = Math.sin(-frame.rot);
      return { x: TABLE_R + dx * c - dy * s, y: TABLE_R + dx * s + dy * c };
    },
    toScreen(x, y) {
      const b = root.getBoundingClientRect();
      const dx = x - TABLE_R, dy = y - TABLE_R, c = Math.cos(frame.rot), s = Math.sin(frame.rot);
      return { x: b.left + frame.cx + (dx * c - dy * s) * frame.s, y: b.top + frame.cy + (dx * s + dy * c) * frame.s };
    },
    // the rotation (radians, table frame) that reads upright from the viewer's seat
    uprightRot() { return -frame.rot; },
    // a direction on screen, in the table frame
    screenDir(dx, dy) {
      const c = Math.cos(-frame.rot), s = Math.sin(-frame.rot);
      return { x: dx * c - dy * s, y: dx * s + dy * c };
    },
    layout, render, cardEl: (id) => cardEls.get(id), placement,
    seatIndex(seatId) { return state.seats.findIndex((s) => s.id === seatId); },
  };

  // fit the table into the root, turned so the viewer's seat is at the bottom
  function layout(reserveTop = 0, reserveBottom = 0) {
    const w = root.clientWidth, h = root.clientHeight;
    const availH = Math.max(100, h - reserveTop - reserveBottom);
    // on a narrow screen keep the whole rail in view: the name plates sit on it
    const fitW = w < 600 ? TABLE_R + 4 : FELT_R + 12;
    const s = Math.min(w / (2 * fitW), availH / (2 * TABLE_R)) * 0.98;
    frame = { cx: w / 2, cy: reserveTop + availH / 2, s, rot: frame.rot };
    applyFrame();
  }
  function applyFrame() {
    stage.style.setProperty("--s", frame.s);
    stage.style.transform =
      `translate(${frame.cx}px, ${frame.cy}px) scale(${frame.s}) rotate(${frame.rot * DEG}deg) translate(${-TABLE_R}px, ${-TABLE_R}px)`;
  }

  // Where every card goes: position, rotation, z order, tilt. `drag` overrides positions of
  // whatever is being carried.
  function placement(st, o = {}) {
    const out = new Map();
    const n = st.seats.length;
    const piles = Object.values(st.piles).sort((a, b) => a.z - b.z);
    piles.forEach((p, pi) => {
      const carried = o.drag?.pile === p.id;
      const px = carried ? o.drag.x : p.x, py = carried ? o.drag.y : p.y, prot = carried ? o.drag.rot : p.rot;
      const k = p.cards.length;
      const gap = p.spread ? Math.min(22, 640 / Math.max(1, k - 1)) : 0;
      const c = Math.cos(prot), s = Math.sin(prot);
      p.cards.forEach((id, i) => {
        let ox, oy;
        if (p.spread) { ox = (i - (k - 1) / 2) * gap; oy = 0; }
        else { const d = Math.min(i, 40) * 0.22; ox = -d; oy = -d; } // a stack's thickness
        out.set(id, {
          x: px + ox * c - oy * s, y: py + ox * s + oy * c, rot: prot,
          z: (carried ? 5000 : pi * 60) + i, scale: 1, lifted: carried,
        });
      });
    });
    st.seats.forEach((seat, si) => {
      const hand = st.hands[seat.id];
      const own = seat.id === viewer;
      const a = seatAngle(si, n);
      const hc = handCenter(si, n, own ? OWN_HAND_R : HAND_R);
      const right = { x: Math.sin(a), y: -Math.cos(a) };
      const k = hand.length;
      const gap = Math.min(own ? 30 : 20, (own ? 420 : 260) / Math.max(1, k - 1));
      hand.forEach((id, i) => {
        const t = i - (k - 1) / 2;
        const fan = t * Math.min(4, 40 / Math.max(1, k)) / DEG;
        const arc = Math.abs(t) * Math.abs(t) * 0.35;
        const along = t * gap;
        out.set(id, {
          x: hc.x + right.x * along + Math.cos(a) * arc, y: hc.y + right.y * along + Math.sin(a) * arc,
          rot: a - Math.PI / 2 + fan, z: 10000 + si * 100 + i, scale: own ? OWN_HAND_SCALE : 1, hand: seat.id,
        });
      });
    });
    if (o.drag?.cards) for (const id of o.drag.cards) {
      out.set(id, { x: o.drag.x, y: o.drag.y, rot: o.drag.rot, z: 20000, scale: o.drag.scale ?? 1.06, lifted: true });
    }
    return out;
  }

  function seatOf(st, seatId) {
    const i = st.seats.findIndex((s) => s.id === seatId);
    return i < 0 ? null : { seat: st.seats[i], angle: seatAngle(i, st.seats.length) };
  }

  // st: table state; o: { drag, presence: [{ seat, cards }], delays: Map, target, instant }
  function render(st, o = {}) {
    state = st; opts = o;
    const n = st.seats.length;
    const vi = st.seats.findIndex((s) => s.id === viewer);
    const targetRot = -(seatAngle(Math.max(0, vi), n) - Math.PI / 2);
    // turn the short way round
    let d = targetRot - frame.rot;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 1e-6) { frame.rot += d; applyFrame(); }

    renderSeats(st);
    const place = placement(st, o);
    const touch = new Map(); // card id → seat touching it
    for (const p of o.presence ?? []) for (const id of p.cards) touch.set(id, p.seat);
    const live = new Set();
    for (const [id, pl] of place) {
      live.add(id);
      let e = cardEls.get(id);
      const card = st.cards[id];
      if (!e) {
        e = el("div", "ct-card", cardLayer);
        e.dataset.id = id;
        el("div", "ct-inner", e);
        cardEls.set(id, e);
      }
      const look = canSee(st, id, viewer) ? "face" : "back";
      if (shown.get(id) !== look) {
        const inner = e.firstChild;
        const html = look === "face" ? faceSVG(card.rank, card.suit) : backSVG();
        if (shown.has(id) && !o.instant) {
          // turning over: squash, swap the picture at the edge-on moment, unsquash
          inner.classList.remove("ct-turn"); void inner.offsetWidth; inner.classList.add("ct-turn");
          setTimeout(() => { if (shown.get(id) === look) inner.innerHTML = html; }, 110);
        } else inner.innerHTML = html;
        shown.set(id, look);
      }
      // tilt toward whoever holds or looks at it
      const toward = pl.lifted ? null : tiltedToward(st, id);
      let tilt = "";
      if (toward) {
        const s = seatOf(st, toward);
        if (s) {
          const amt = pl.hand ? HELD_TILT : LOOK_TILT;
          // axis across the line to the seat, in the card's own frame
          const ax = s.angle + Math.PI / 2 - pl.rot;
          tilt = ` perspective(${pl.hand ? 260 : 340}px) rotate3d(${Math.cos(ax).toFixed(4)}, ${Math.sin(ax).toFixed(4)}, 0, ${amt}deg)`;
        }
      }
      e.style.transform = `translate(${pl.x - CARD_W / 2}px, ${pl.y - CARD_H / 2}px) rotate(${pl.rot * DEG}deg) scale(${pl.scale})${tilt}`;
      e.style.zIndex = pl.z;
      e.style.transitionDelay = o.delays?.get(id) ? `${o.delays.get(id)}ms` : "";
      e.classList.toggle("ct-lifted", !!pl.lifted);
      e.classList.toggle("ct-carried", !!(o.drag && (o.drag.cards?.includes(id) || pl.lifted)));
      e.classList.toggle("ct-target", o.target?.card === id);
      // ring: whoever is touching it; otherwise whoever is looking at a face-down card
      const ringSeat = touch.get(id) ?? (!pl.hand && !card.faceUp ? card.privateTo : null);
      const ring = ringSeat ? seatOf(st, ringSeat)?.seat.color : null;
      e.style.setProperty("--ring", ring ?? "transparent");
      e.classList.toggle("ct-ringed", !!ring);
      e.classList.toggle("ct-touched", touch.has(id));
    }
    for (const [id, e] of cardEls) if (!live.has(id)) { e.remove(); cardEls.delete(id); shown.delete(id); }
    if (interactive) { renderGrips(st, place, o); renderZones(st, o); renderTags(st, place, o); }
  }

  function renderSeats(st) {
    const n = st.seats.length;
    seatLayer.replaceChildren();
    st.seats.forEach((seat, i) => {
      const a = seatAngle(i, n);
      const r = (FELT_R + TABLE_R) / 2;
      const plate = el("div", "ct-plate", seatLayer);
      plate.style.setProperty("--seat", seat.color);
      plate.textContent = seat.id === viewer && interactive ? `${seat.name} (you)` : seat.name;
      // level on screen; but on a narrow screen, seats at the sides run along the rail instead,
      // turned whichever way reads upright
      let turn = -frame.rot;
      const onScreen = a + frame.rot;
      if (root.clientWidth < 600 && Math.abs(Math.cos(onScreen)) > 0.5) {
        let t = onScreen - Math.PI / 2;
        t = Math.atan2(Math.sin(t), Math.cos(t));
        if (Math.abs(t) > Math.PI / 2) t += Math.PI;
        turn = t - frame.rot;
      }
      plate.style.transform = `translate(${TABLE_R + r * Math.cos(a)}px, ${TABLE_R + r * Math.sin(a)}px) rotate(${turn * DEG}deg) translate(-50%, -50%)`;
      plate.classList.toggle("ct-me", seat.id === viewer);
    });
  }

  // the tab under each stack: how many cards, and a handle to move the whole stack
  function renderGrips(st, place, o) {
    gripLayer.replaceChildren();
    for (const p of Object.values(st.piles)) {
      // a card being carried off the stack no longer counts
      const rest = p.cards.filter((id) => !o.drag?.cards?.includes(id));
      if (!rest.length || (rest.length < 2 && !p.spread)) continue;
      const top = place.get(rest.at(-1)), bottom = place.get(rest[0]);
      const cx = (top.x + bottom.x) / 2, cy = (top.y + bottom.y) / 2;
      const down = view.screenDir(0, 1);
      const reach = CARD_H / 2 + 12;
      const g = el("div", "ct-grip", gripLayer);
      g.dataset.pile = p.id;
      g.textContent = rest.length;
      g.title = "Drag to move the whole stack. Right-click for shuffle, deal and more.";
      g.style.transform = `translate(${cx + down.x * reach}px, ${cy + down.y * reach}px) rotate(${-frame.rot * DEG}deg) translate(-50%, -50%)`;
      g.style.zIndex = top.z + 1;
      g.classList.toggle("ct-carried", o.drag?.pile === p.id);
      g.classList.toggle("ct-target", o.target?.pile === p.id && !o.target.card);
    }
  }

  // while carrying cards: where each hand would take them
  function renderZones(st, o) {
    zoneLayer.replaceChildren();
    if (!o.drag) return;
    const n = st.seats.length;
    st.seats.forEach((seat, i) => {
      const own = seat.id === viewer;
      const c = handCenter(i, n, own ? OWN_HAND_R : HAND_R);
      const z = el("div", "ct-zone", zoneLayer);
      z.style.setProperty("--seat", seat.color);
      const a = seatAngle(i, n);
      z.style.transform = `translate(${c.x}px, ${c.y}px) rotate(${(a - Math.PI / 2) * DEG}deg) translate(-50%, -50%)`;
      z.style.width = `${own ? 300 : 230}px`; z.style.height = `${own ? 150 : 120}px`;
      z.classList.toggle("ct-target", o.target?.hand === seat.id);
    });
  }

  // a name tag by whatever each player is touching
  function renderTags(st, place, o) {
    tagLayer.replaceChildren();
    for (const p of o.presence ?? []) {
      const pts = p.cards.map((id) => place.get(id)).filter(Boolean);
      if (!pts.length) continue;
      const s = seatOf(st, p.seat);
      if (!s) continue;
      const x = Math.max(...pts.map((q) => q.x)), y = Math.min(...pts.map((q) => q.y));
      const up = view.screenDir(CARD_W / 2 + 6, -CARD_H / 2 - 4);
      const tag = el("div", "ct-tag", tagLayer);
      tag.style.setProperty("--seat", s.seat.color);
      tag.textContent = p.seat === viewer ? "You" : s.seat.name;
      tag.style.transform = `translate(${x + up.x}px, ${y + up.y}px) rotate(${-frame.rot * DEG}deg)`;
    }
  }

  return view;
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

export { locate };
