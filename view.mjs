// Draws a table state as one seat sees it. Cards are DOM elements, one per card, kept across
// renders; each one springs toward where it belongs every frame, so every move (a deal, a hand
// opening a gap, a dragged card) is continuous. The same view runs the main table and the small
// tables in the about modal.
import { TABLE_W, TABLE_H, CX, CY, FELT_H, RAIL, CARD_W, CARD_H, seatAngle, seatSpot, seatRoom, handCenter, canSee, tiltedToward, locate, handLocked, handChips } from "./table.mjs";
import { faceSVG, backSVG } from "./faces.mjs";

const DEG = 180 / Math.PI;
export const HAND_R = FELT_H / 2 - 62;      // how far out from the middle line other seats' hands sit
export const OWN_HAND_R = FELT_H / 2 - 66;  // the viewer's own hand, a bit closer to them and bigger
export const GRIP_REACH = CARD_H / 2 + 17; // from a stack's middle to its count tab
// a hand area's corners round by 22; a badge on a corner sits on that curve, this far in from
// the corner of the box on each side
const CORNER_IN = 22 * (1 - Math.SQRT1_2);
const HELD_TILT = 38, LOOK_TILT = 28; // degrees: a held card, a face-down card being looked at
const TURN_MS = 220, STACK_TURN_MS = 460;
const SLOT = "__slot";
const SPREAD_GAP = 22, SPREAD_WIDTH = 600; // a spread stack: card spacing, and the most room it takes
// spacing in a spread stack of k cards
export function spreadGap(k) { return Math.min(SPREAD_GAP, SPREAD_WIDTH / Math.max(1, k - 1)); }

// a steady pseudo-random number in [-1, 1] for a card: a messy stack keeps its look
function jitter(id, salt) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 2001) / 1000 - 1;
}

// spacing between neighbors in a hand of k cards, in a seat with `room` to spread across
export function handGap(own, k, shown = false, room = Infinity) {
  // your own hand, held or shown, is spaced so every card is easy to pick out and drop
  // between; other held hands bunch up more
  // (a big hand of yours spreads wider, up to 640 or the seat's room, and its area grows with it)
  const fit = room - CARD_W - 44;
  if (own || shown) return Math.min(own ? 46 : 38, Math.min(own ? 640 : 300, fit) / Math.max(1, k - 1));
  return Math.min(20, Math.min(260, fit) / Math.max(1, k - 1));
}
// A hand's chip stacks stand in a row at its right end; the cards make room, centered on what's
// left. m stacks take this much of the hand's length:
export const CHIP_STEP = 50;
export const chipRowWidth = (m) => (m ? m * CHIP_STEP + 6 : 0);
// the room a seat's cards have, with its chips beside them
export const cardRoom = (st, si, n) => seatRoom(si, n) - chipRowWidth(handChips(st, st.seats[si].id).length);

// how far along and across from a hand's middle it still takes drops
export function handReach(own, k, shown = false, room = Infinity) {
  const along = Math.max(0, k - 1) * handGap(own, k, shown, room) / 2 + CARD_W / 2 + 22;
  return { along: Math.min(room / 2, Math.max(own ? 150 : 115, along)), across: own ? 75 : 60 };
}

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
  const eyeLayer = el("div", "ct-eyes", stage);
  const zoneEyeLayer = el("div", "ct-eyes", stage);
  const slotEl = el("div", "ct-slot", cardLayer); // the gap a carried card would drop into
  stage.style.width = `${TABLE_W}px`; stage.style.height = `${TABLE_H}px`;

  const cardEls = new Map();   // card id → element
  const chipEls = new Map();   // chip stack id → element
  const shown = new Map();     // card id → "face" | "back" (what the viewer currently sees)
  let frame = { cx: 0, cy: 0, s: 1, rot: 0 };
  let state = null, opts = {};

  const view = {
    root, stage,
    get viewer() { return viewer; },
    set viewer(v) { viewer = v; },
    lockAll: false, // the host can lock or unlock anyone's hand
    // screen ⇄ table coordinates
    toTable(clientX, clientY) {
      const b = root.getBoundingClientRect();
      const dx = (clientX - b.left - frame.cx) / frame.s, dy = (clientY - b.top - frame.cy) / frame.s;
      const c = Math.cos(-frame.rot), s = Math.sin(-frame.rot);
      return { x: CX + dx * c - dy * s, y: CY + dx * s + dy * c };
    },
    toScreen(x, y) {
      const b = root.getBoundingClientRect();
      const dx = x - CX, dy = y - CY, c = Math.cos(frame.rot), s = Math.sin(frame.rot);
      return { x: b.left + frame.cx + (dx * c - dy * s) * frame.s, y: b.top + frame.cy + (dx * s + dy * c) * frame.s };
    },
    // the rotation (radians, table frame) that reads upright from the viewer's seat
    uprightRot() { return -frame.rot; },
    // a direction on screen, in the table frame
    screenDir(dx, dy) {
      const c = Math.cos(-frame.rot), s = Math.sin(-frame.rot);
      return { x: dx * c - dy * s, y: dx * s + dy * c };
    },
    layout, render, cardEl: (id) => cardEls.get(id), chipEl: (id) => chipEls.get(id), placement, handSlot, chipPlacement: (st) => chipPlacement(st, opts),
    seatIndex(seatId) { return state.seats.findIndex((s) => s.id === seatId); },
  };

  // fit the table into the root, turned so the viewer's seat is at the bottom
  function layout(reserveTop = 0, reserveBottom = 0) {
    const w = root.clientWidth, h = root.clientHeight;
    const availH = Math.max(100, h - reserveTop - reserveBottom);
    const s = Math.min(w / TABLE_W, availH / TABLE_H) * 0.98;
    frame = { cx: w / 2, cy: reserveTop + availH / 2, s, rot: frame.rot };
    applyFrame();
  }
  function applyFrame() {
    stage.style.setProperty("--s", frame.s);
    stage.style.transform =
      `translate(${frame.cx}px, ${frame.cy}px) scale(${frame.s}) rotate(${frame.rot * DEG}deg) translate(${-CX}px, ${-CY}px)`;
  }

  // every drag in progress: yours (o.drag) and other players' (o.remote: [{ seat, ... }])
  function dragsOf(o) {
    const out = (o.remote ?? []).map((d) => ({ ...d, local: false }));
    if (o.drag) out.push({ ...o.drag, seat: viewer, local: true });
    return out;
  }

  // Where every card goes: position, rotation, z order. Each drag carries cards with its
  // pointer; a hand being dropped into opens a gap where they'd land (with a ghost `slot` for
  // yours).
  function placement(st, o = {}) {
    state = st;
    const out = new Map();
    const n = st.seats.length;
    const drags = dragsOf(o);
    const carried = new Set(drags.flatMap((d) => d.cards ?? []));
    // what a drag carries: its cards, or a whole stack's
    const cardsOf = (d) => d.cards ?? (d.whole ? st.piles[d.pile]?.cards ?? [] : []);
    // a carried card or stack riding in the gap it would fill: one slot per card
    const rideIn = (d, slot, geometry) => {
      const r = rides.get(d) ?? { ...geometry, slots: [] };
      r.slots.push(slot); rides.set(d, r);
    };
    const wholeOf = new Map(drags.filter((d) => d.whole).map((d) => [d.pile, d]));
    const rides = new Map();
    const piles = Object.values(st.piles).sort((a, b) => a.z - b.z);
    piles.forEach((p, pi) => {
      const wd = wholeOf.get(p.id), whole = !!wd;
      // a stack you're looking through turns to face you, the way you'd pick it up to read it,
      // spread around the middle of where its cards already lie (a spread row stays put)
      let px = whole ? wd.x : p.x, py = whole ? wd.y : p.y;
      let prot = whole ? wd.rot : p.rot;
      if (!whole && o.peekSpread?.has(p.id)) {
        if (p.look === "spread") {
          const half = ((p.cards.length - 1) * spreadGap(p.cards.length)) / 2;
          px += Math.cos(p.rot) * half; py += Math.sin(p.rot) * half;
        }
        prot = -frame.rot;
      }
      // a stack you're looking through lies spread out, faces up, on your screen alone; one
      // someone else is looking through tips toward them, like a card they peek at
      const peeking = !!o.peekSpread?.has(p.id);
      const peekBy = o.remotePeek?.get(p.id) ?? null;
      const look = peeking ? "spread" : p.look ?? (p.messy ? "few" : null);
      const cards = p.cards.filter((id) => !carried.has(id));
      // cards carried over a spread stack open a gap where they would go, one slot each, as in
      // a hand (a whole stack too, spread or not)
      const into = look === "spread" ? drags.find((d) => d.pile !== p.id && cardsOf(d).length && d.target?.pile === p.id && d.target.slot != null) : null;
      const nIn = into ? cardsOf(into).length : 0;
      const gapAt = into ? Math.min(into.target.slot, cards.length) : -1;
      if (gapAt >= 0) cards.splice(gapAt, 0, ...Array(nIn).fill(SLOT));
      const k = cards.length;
      const c = Math.cos(prot), s = Math.sin(prot);
      cards.forEach((id, i) => {
        const d = Math.min(i, 40) * 0.22; // a stack's thickness
        let ox = -d, oy = -d, a = 0;
        if (look === "spread" && k > 1) {
          // in a row from the bottom card (at the stack's spot) rightward, each corner showing,
          // so a card put on top doesn't move the rest; peeking, centered where the stack is.
          // Past the gap, cards step a little further aside so it's wide enough to see.
          const gap = spreadGap(k);
          ox = (peeking ? i - (k - 1) / 2 : i) * gap + (gapAt >= 0 && i >= gapAt + nIn ? 14 : 0); oy = 0;
        } else if (look === "few" && k > 1) {
          // loosely heaped: the top three step back up and to the left so their corners show,
          // the rest lie askew under the third with only their edges peeking out
          // (each one steps out 21 to the left: a whole corner index's width, so the card above
          // never covers the rank below it)
          const depth = Math.min(k - 1 - i, 2), deep = k - 1 - i > 2;
          const j = (n) => jitter(id, n);
          ox = -depth * 21 + 21 + j(1) * (deep ? 6 : 1.5);
          oy = -depth * 6 + 6 + j(2) * (deep ? 5 : 1.5);
          a = (deep ? j(3) * 0.24 : j(3) * 0.04 - depth * 0.05);
        }
        if (id === SLOT) {
          // the carried card rides in its gap, a little raised, under the cards to its right;
          // it can lean right with the pointer but never over the card to its left
          // (in a stack you're looking through it stays face up, over the row, like the rest)
          rideIn(into, { x: px + ox * c - oy * s, y: py + ox * s + oy * c, rot: prot, scale: 1, z: (peeking ? 8000 : pi * 60) + i },
            { right: { x: c, y: s }, up: { x: s, y: -c }, raise: peeking ? 16 : 8, min: peeking ? -spreadGap(k) * 0.45 : 0, max: spreadGap(k) * 0.6 + 14, peeking, pile: peeking ? p.id : undefined });
          return;
        }
        out.set(id, {
          x: px + ox * c - oy * s, y: py + ox * s + oy * c, rot: prot + a,
          z: (whole ? 5000 : peeking ? 8000 : pi * 60) + i, scale: whole ? 1.04 : 1, lifted: whole, drag: wd,
          peeking, peekBy, pile: p.id,
        });
      });
    });
    st.seats.forEach((seat, si) => {
      const own = seat.id === viewer, shown = !!st.shownHands?.[seat.id];
      const list = st.hands[seat.id].filter((id) => !carried.has(id));
      const into = drags.find((d) => cardsOf(d).length && d.target?.hand === seat.id);
      const nIn = into ? cardsOf(into).length : 0;
      const gapAt = into ? Math.min(into.target.slot, list.length) : -1;
      // reordering a hand from inside it: the carried card rides along the hand, a little
      // raised, and the others make room for it; anything else coming in opens a wider gap
      // (a card you carry into your own hand rides in too, wherever it came from)
      const reorder = gapAt >= 0 && (into.inHand || (own && into.local));
      if (gapAt >= 0) list.splice(gapAt, 0, ...Array(nIn).fill(SLOT));
      list.forEach((id, i) => {
        // the cards either side of the gap step aside so it's wide enough to see; reordering, the
        // ones to the left step further left so the carried card never hides them
        const side = gapAt < 0 ? 0 : i < gapAt ? -1 : i >= gapAt + nIn ? 1 : 0;
        const q = handSlot(si, n, own, i, list.length, reorder ? (side < 0 ? -1.2 : 0) : side, shown);
        if (id === SLOT) {
          if (reorder) {
            const a = seatAngle(si, n), reach = handGap(own, list.length, shown, cardRoom(st, si, n)) * 0.45;
            rideIn(into, { ...q, z: 10000 + si * 100 + i },
              { hand: seat.id, right: { x: Math.sin(a), y: -Math.cos(a) }, up: { x: -Math.cos(a), y: -Math.sin(a) }, raise: 16, min: -reach, max: reach });
          }
          else if (into.local && i === gapAt) out.slot = { ...q, z: 10000 + si * 100 + i };
          return;
        }
        out.set(id, { ...q, z: 10000 + si * 100 + i, hand: seat.id, own, bob: own ? i : null });
      });
    });
    for (const d of drags) {
      const r = rides.get(d);
      if (r) {
        // in their gap in a hand or a spread stack, raised a little, following the pointer along
        // the row only as far as their slots allow, so they can't slide over their neighbors
        const s0 = r.slots[0];
        const along = Math.max(r.min, Math.min(r.max, (d.x - s0.x) * r.right.x + (d.y - s0.y) * r.right.y));
        cardsOf(d).forEach((id, i) => {
          const q = r.slots[i] ?? r.slots.at(-1);
          out.set(id, {
            x: q.x + r.right.x * along + r.up.x * r.raise, y: q.y + r.right.y * along + r.up.y * r.raise,
            rot: q.rot, z: q.z, scale: q.scale, carried: true, riding: true, hand: r.hand, drag: d, peeking: !!r.peeking, ...(r.pile ? { pile: r.pile } : {}),
          });
        });
      } else if (d.cards) {
        d.cards.forEach((id, i) => out.set(id, { x: d.x, y: d.y, rot: d.rot, z: 20000 + i, scale: 1.1, lifted: true, carried: true, drag: d }));
      }
    }
    return out;
  }

  // slot i of k in a seat's hand: a shallow arc, fanned a little, facing the seat
  // (shown: laid flat in a straight row at table size instead)
  function handSlot(si, n, own, i, k, aside = 0, shown = false) {
    const a = seatAngle(si, n);
    // a shown hand slides toward the middle so its cards' tops stick out of the hand's area
    const room = cardRoom(state, si, n), shift = -chipRowWidth(handChips(state, state.seats[si].id).length) / 2;
    const hc = handCenter(si, n, (own ? OWN_HAND_R : HAND_R) - (shown ? handReach(own, k, false, room).across + 22 - CARD_H / 2 : 0));
    const t = i - (k - 1) / 2;
    const along = t * handGap(own, k, shown, room) + aside * (own ? 26 : 18) + shift;
    const fan = shown ? 0 : t * Math.min(4, 40 / Math.max(1, k)) / DEG;
    // a shallow arch: the same curve for any hand of a dozen or more, never deeper than 12
    const half = Math.max(1, (k - 1) / 2), u = t / half;
    const arc = shown ? 0 : u * u * Math.min(12, 0.35 * half * half);
    return {
      x: hc.x + Math.sin(a) * along + Math.cos(a) * arc, y: hc.y - Math.cos(a) * along + Math.sin(a) * arc,
      rot: a - Math.PI / 2 + fan, scale: 1,
    };
  }

  function seatOf(st, seatId) {
    const i = st.seats.findIndex((s) => s.id === seatId);
    return i < 0 ? null : { seat: st.seats[i], angle: seatAngle(i, st.seats.length) };
  }

  // ---- motion: every card springs toward where it should be, every frame ----------------------
  // A spring per card for position, rotation, scale, tilt and hover lift. Carried cards use a
  // stiffer spring and lean into the direction they're moving.
  const springs = new Map(); // card id → { el, inner, cur, vel, tgt, queued, ... }
  const KEYS = ["x", "y", "rot", "scale", "tilt", "lift", "sway"];
  let raf = 0, lastT = 0;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setTarget(sp, tgt, delay, now) {
    if (delay > 0 || (sp.queued && sp.queued.at > now)) {
      sp.queued = { tgt, at: Math.max(now + delay, sp.queued?.at ?? 0) };
    } else { sp.queued = null; apply(sp, tgt); }
  }
  function apply(sp, tgt) {
    sp.tgt = tgt;
    sp.el.style.zIndex = tgt.z;
  }
  function wake() { if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(tick); } }

  function tick(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
    let busy = false;
    const right = view.screenDir(1, 0);
    for (const sp of springs.values()) {
      if (sp.queued && now >= sp.queued.at) { apply(sp, sp.queued.tgt); sp.queued = null; }
      if (sp.queued) busy = true;
      const t = sp.tgt, c = sp.cur, v = sp.vel;
      // lean: carried cards tilt toward where they're heading
      t.sway = t.carried && !t.remote ? Math.max(-0.4, Math.min(0.4, (v.x * right.x + v.y * right.y) * 0.0011)) : 0;
      // someone else's drag arrives in jumps over the network: a softer spring smooths it
      const k = reduced ? 2000 : t.carried ? (t.remote ? 240 : 900) : 190, zeta = t.carried ? 0.85 : 0.68;
      const kl = 420, zl = 0.62; // lift is quicker and bouncier
      let moving = false;
      for (let step = 0, steps = Math.ceil(dt / 0.008); step < steps; step++) {
        const h = dt / steps;
        for (const key of KEYS) {
          const kk = key === "lift" ? kl : key === "sway" ? 300 : k, z = key === "lift" ? zl : zeta;
          let d = t[key] - c[key];
          if (key === "rot") d = Math.atan2(Math.sin(d), Math.cos(d));
          v[key] += (kk * d - 2 * z * Math.sqrt(kk) * v[key]) * h;
          c[key] += v[key] * h;
        }
      }
      for (const key of KEYS) {
        let d = t[key] - c[key];
        if (key === "rot") d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.abs(d) > 0.01 || Math.abs(v[key]) > 0.05) moving = true;
      }
      if (!moving) for (const key of KEYS) { c[key] = key === "rot" ? c[key] + Math.atan2(Math.sin(t[key] - c[key]), Math.cos(t[key] - c[key])) : t[key]; v[key] = 0; }
      // your own hand never quite sits still
      const bob = t.bob != null && !reduced ? Math.sin(now / 520 + t.bob * 0.9) * 1.1 : 0;
      if (moving || bob || sp.dirty) {
        draw1(sp, bob);
        sp.dirty = moving;
        busy = busy || moving || !!bob;
      }
    }
    for (const g of followers) g();
    if (busy) raf = requestAnimationFrame(tick);
  }

  function draw1(sp, bob) {
    const c = sp.cur, t = sp.tgt;
    let tilt = "";
    if (Math.abs(c.tilt) > 0.05) tilt = ` perspective(${t.persp}px) rotate3d(${t.axis[0]}, ${t.axis[1]}, 0, ${c.tilt}deg)`;
    sp.el.style.transform = `translate(${c.x - CARD_W / 2}px, ${c.y - CARD_H / 2}px) rotate(${(c.rot + c.sway) * DEG}deg) scale(${c.scale})${tilt}`;
    sp.inner.style.translate = `0 ${(-c.lift * 9 + bob).toFixed(2)}px`;
    sp.inner.style.scale = (1 + c.lift * 0.05).toFixed(4);
  }

  // things that ride along with cards (count tabs, name tags, the drop slot) recompute from the
  // cards' current positions each frame
  let followers = [];
  const curOf = (id) => springs.get(id)?.cur;

  // st: table state; o: { drag, remote, presence: [{ seat, cards }], target, instant, hover,
  //   peekSpread: Set of piles to show spread out here only, remotePeek: Map pile → seat looking, online: Set of players connected, delays: { card: ms }, stackFlip: { cards, x, y } (a
  //   stack just turned over, and its middle) }
  function render(st, o = {}) {
    state = st; opts = o;
    const n = st.seats.length;
    const vi = st.seats.findIndex((s) => s.id === viewer);
    const targetRot = -(seatAngle(Math.max(0, vi), n) - Math.PI / 2);
    // turn the short way round
    let d = targetRot - frame.rot;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 1e-6) { frame.rot += d; applyFrame(); }

    renderSeats(st, o);
    const place = placement(st, o);
    const touch = new Map(); // card id → seat touching it
    for (const p of o.presence ?? []) for (const id of p.cards) touch.set(id, p.seat);
    const now = performance.now();
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
      let look = canSee(st, id, viewer) ? "face" : "back";
      // looking through a stack shows you every face in it
      if (pl.peeking) look = "face";
      // a carried card shows whichever side its carrier will put down; someone else's card
      // held face up over a third player's hand is shown to that player only
      const dr = pl.carried ? pl.drag : null;
      if (dr?.faceUp != null && !(pl.riding && pl.peeking) && (dr.local || !pl.riding || !pl.hand)) {
        let up = dr.faceUp;
        if (!dr.local && dr.from?.hand && dr.target?.hand && dr.target.hand !== dr.seat && dr.target.hand !== viewer) up = false;
        look = up ? "face" : "back";
      }
      // a whole stack turning over turns as one block, about the stack's middle
      const whole = !o.instant && shown.has(id) && !!o.stackFlip?.cards.includes(id);
      if (shown.get(id) !== look || whole) {
        const inner = e.firstChild;
        const html = look === "face" ? faceSVG(card.rank, card.suit) : backSVG();
        if (shown.has(id) && !o.instant) {
          // turning over: squash, swap the picture at the edge-on moment, unsquash
          inner.style.transformOrigin = "";
          if (whole) {
            const was = curOf(id) ?? pl;
            const dx = o.stackFlip.x - was.x, dy = o.stackFlip.y - was.y, c = Math.cos(-was.rot), s = Math.sin(-was.rot);
            inner.style.transformOrigin = `${CARD_W / 2 + dx * c - dy * s}px ${CARD_H / 2 + dx * s + dy * c}px`;
          }
          inner.classList.remove("ct-turn", "ct-stackturn"); void inner.offsetWidth;
          inner.classList.add(whole ? "ct-stackturn" : "ct-turn");
          setTimeout(() => { if (shown.get(id) === look) inner.innerHTML = html; }, (whole ? STACK_TURN_MS : TURN_MS) / 2);
        } else inner.innerHTML = html;
        shown.set(id, look);
      }
      // tilt toward whoever holds or looks at it
      // tipped toward whoever holds it or is looking at it (a stack being looked through too)
      const toward = pl.lifted ? null : pl.peeking ? viewer : pl.peekBy ?? tiltedToward(st, id);
      const s = toward ? seatOf(st, toward) : null;
      // axis across the line to the seat, in the card's own frame
      const ax = s ? s.angle + Math.PI / 2 - pl.rot : 0;
      const tgt = {
        x: pl.x, y: pl.y, rot: pl.rot, scale: pl.scale, z: pl.z, sway: 0,
        tilt: s ? (pl.hand ? HELD_TILT : LOOK_TILT) : 0,
        axis: [Math.cos(ax).toFixed(4), Math.sin(ax).toFixed(4)], persp: pl.hand ? 260 : 340,
        // a stack you're looking through floats a little off the table
        lift: interactive && !pl.lifted && (o.hover === id ? 1 : pl.peeking ? 0.7 : 0) || 0,
        carried: !!pl.carried, remote: !!(pl.drag && !pl.drag.local), bob: interactive ? pl.bob : null,
      };
      let sp = springs.get(id);
      if (!sp) {
        sp = { el: e, inner: e.firstChild, cur: { ...tgt }, vel: Object.fromEntries(KEYS.map((k) => [k, 0])), tgt, queued: null, dirty: true };
        springs.set(id, sp);
        apply(sp, tgt);
      } else if (o.instant) {
        sp.queued = null; apply(sp, tgt);
        for (const k of KEYS) { sp.cur[k] = tgt[k]; sp.vel[k] = 0; }
        sp.dirty = true;
      } else {
        // a turning stack reorders and re-fans when it's edge-on, so the swap doesn't show
        const delay = o.delays?.[id] || (o.stackFlip?.cards.includes(id) ? STACK_TURN_MS / 2 : 0);
        setTarget(sp, tgt, delay, now);
        sp.dirty = true;
      }
      e.classList.toggle("ct-lifted", !!pl.lifted);
      e.classList.toggle("ct-carried", !!(pl.drag?.local && (pl.carried || pl.lifted)));
      e.classList.toggle("ct-target", o.target?.card === id);
      e.classList.toggle("ct-hover", tgt.lift > 0 && !pl.peeking);
      e.classList.toggle("ct-peeking", !!pl.peeking);
      // ring: whoever is touching it; otherwise whoever is looking at a face-down card
      const ringSeat = touch.get(id) ?? (pl.peeking ? viewer : null) ?? (!pl.hand && !card.faceUp ? card.privateTo : null);
      const ring = ringSeat ? seatOf(st, ringSeat)?.seat.color : null;
      e.style.setProperty("--ring", ring ?? "transparent");
      e.classList.toggle("ct-ringed", !!ring);
      e.classList.toggle("ct-touched", touch.has(id));
    }
    for (const [id, e] of cardEls) if (!live.has(id)) { e.remove(); cardEls.delete(id); shown.delete(id); springs.delete(id); }
    renderChips(st, o);
    followers = [];
    if (interactive) { renderGrips(st, o); renderZones(st, place, o); renderTags(st, place, o); renderEyes(st, place, o); }
    wake();
  }

  // Where every chip stack stands: the point under the middle of its bottom chip. On the table
  // where it was put; in a hand, in the row at the hand's right end; carried, under the pointer.
  function chipPlacement(st, o) {
    const out = new Map();
    const drags = dragsOf(o);
    const n = st.seats.length;
    const down = (() => { const c = Math.cos(-frame.rot), sn = Math.sin(-frame.rot); return { x: -sn, y: c }; })();
    const onTable = Object.values(st.chips ?? {}).filter((c) => !Object.values(st.chipHands ?? {}).some((l) => l.includes(c.id)));
    onTable.sort((a, b) => a.z - b.z).forEach((c, k) => out.set(c.id, { x: c.x, y: c.y, z: 4000 + k }));
    st.seats.forEach((seat, si) => {
      const list = handChips(st, seat.id);
      if (!list.length) return;
      const own = seat.id === viewer, a = seatAngle(si, n);
      const right = { x: Math.sin(a), y: -Math.cos(a) };
      const c = handCenter(si, n, own ? OWN_HAND_R : HAND_R);
      const W = chipRowWidth(list.length);
      const cardsReach = handReach(own, st.hands[seat.id].length, !!st.shownHands?.[seat.id], cardRoom(st, si, n)).along;
      list.forEach((id, j) => {
        const along = -W / 2 + cardsReach + (j + 0.5) * CHIP_STEP - 16;
        out.set(id, { x: c.x + right.x * along + down.x * 18, y: c.y + right.y * along + down.y * 18, z: 10000 + si * 100 + 90 + j, hand: seat.id });
      });
    });
    for (const d of drags) if (d.chip && out.has(d.chip)) out.set(d.chip, { x: d.x, y: d.y, z: 20000, carried: true, drag: d });
    return out;
  }

  function renderChips(st, o) {
    const place = chipPlacement(st, o);
    const live = new Set();
    for (const [id, pl] of place) {
      const chips = st.chips[id];
      live.add(id);
      let e = chipEls.get(id);
      if (!e) {
        e = el("div", "ct-chips", cardLayer);
        e.dataset.chip = id;
        el("div", "ct-chips-art", e);
        el("div", "ct-chips-amt", e);
        chipEls.set(id, e);
      }
      setHTML(e.firstChild, chipArt(chips.amount));
      setText(e.children[1], chips.amount.toLocaleString("en-US"));
      e.style.zIndex = pl.z;
      // standing up on screen, whichever way the table is turned
      e.style.transform = `translate(${pl.x}px, ${pl.y}px) rotate(${-frame.rot * DEG}deg) scale(${pl.carried ? 1.08 : 1})`;
      e.classList.toggle("ct-moving", !!pl.carried);
      e.classList.toggle("ct-carried", !!pl.drag?.local);
      e.classList.toggle("ct-target", o.target?.stack === id);
      // whoever is carrying it wears it in their color, with an eye: everyone sees chips
      const ringSeat = pl.carried ? (pl.drag.local ? viewer : pl.drag.seat) : null;
      const ring = ringSeat ? seatOf(st, ringSeat)?.seat.color : null;
      e.style.setProperty("--ring", ring ?? "transparent");
      e.classList.toggle("ct-ringed", !!ring);
      let eye = e.querySelector(".ct-eye");
      if (ring && !eye) { eye = el("div", "ct-eye ct-eye-open", e); eye.innerHTML = eyeSVG(true); eye.title = "Everyone can see chips"; }
      if (!ring && eye) eye.remove();
    }
    for (const [id, e] of chipEls) if (!live.has(id)) { e.remove(); chipEls.delete(id); }
  }

  function renderSeats(st, o) {
    const n = st.seats.length;
    const K = keyed(seatLayer);
    st.seats.forEach((seat, i) => {
      const { x: px, a } = seatSpot(i, n);
      const r = (FELT_H + RAIL) / 2;
      const plate = K.get(seat.id, "div", "ct-plate");
      plate.dataset.seat = seat.id;
      plate.style.setProperty("--seat", seat.color);
      // an empty seat says so; a player who has dropped off is dimmed until they're back
      const open = interactive && o.online && !seat.player;
      const label = open ? "Open seat" : seat.id === viewer && interactive ? `${seat.name} (you)` : seat.name;
      const edit = interactive && seat.id === o.editSeat;
      // rebuilt only when what it says changes
      if (plate.__sig !== label + edit) {
        plate.__sig = label + edit;
        plate.replaceChildren();
        el("span", "ct-plate-name", plate).textContent = label;
        // your own seat has a pencil for changing your name and color
        if (edit) {
          const b = el("button", "ct-plate-edit", plate);
          b.type = "button"; b.title = "Change your name or color"; b.setAttribute("aria-label", b.title);
          b.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/></svg>`;
        }
      }
      plate.classList.toggle("ct-open", !!open);
      plate.classList.toggle("ct-away", !!(interactive && o.online && seat.player && !o.online.has(seat.player)));
      // on the rail in front of the seat, level on screen
      plate.style.transform = `translate(${px}px, ${CY + r * Math.sin(a)}px) rotate(${-frame.rot * DEG}deg) translate(-50%, -50%)`;
      plate.classList.toggle("ct-me", seat.id === viewer);
    });
    K.done();
  }

  // the tab under each stack: how many cards, and a handle to move the whole stack
  function renderGrips(st, o) {
    const K = keyed(gripLayer);
    const carriedNow = new Set(dragsOf(o).flatMap((d) => d.cards ?? []));
    for (const p of Object.values(st.piles)) {
      // a card being carried off the stack no longer counts
      const rest = p.cards.filter((id) => !carriedNow.has(id));
      if (rest.length < 2) continue;
      const g = K.get(p.id, "div", "ct-grip");
      g.dataset.pile = p.id;
      setText(g, String(rest.length));
      g.title = "Press and hold the stack, or drag this, to move the whole stack. Click for shuffle, deal and more.";
      g.style.zIndex = (springs.get(rest.at(-1))?.tgt.z ?? 0) + 1;
      g.classList.toggle("ct-carried", o.drag?.pile === p.id);
      g.classList.toggle("ct-target", o.target?.pile === p.id && !o.target.card);
      const topId = rest.at(-1), bottomId = rest[0];
      const follow = () => {
        const top = curOf(topId), bottom = curOf(bottomId);
        if (!top || !bottom) return;
        const down = view.screenDir(0, 1);
        g.style.transform = `translate(${(top.x + bottom.x) / 2 + down.x * GRIP_REACH}px, ${(top.y + bottom.y) / 2 + down.y * GRIP_REACH}px) rotate(${-frame.rot * DEG}deg) translate(-50%, -50%)`;
      };
      follow(); followers.push(follow);
    }
    K.done();
  }

  // each hand's area, always drawn (it lights up while you carry cards into it), and the gap
  // carried cards would fill
  function renderZones(st, place, o) {
    const KZ = keyed(zoneLayer), KE = keyed(zoneEyeLayer);
    const was = slotEl.classList.contains("ct-on");
    slotEl.classList.toggle("ct-on", !!place.slot);
    if (place.slot) {
      const q = place.slot;
      // appear in place; after that, slide from gap to gap
      slotEl.style.transition = was ? "" : "opacity .15s";
      slotEl.style.zIndex = q.z;
      slotEl.style.transform = `translate(${q.x - CARD_W / 2}px, ${q.y - CARD_H / 2}px) rotate(${q.rot * DEG}deg) scale(${q.scale})`;
    }
    const n = st.seats.length;
    st.seats.forEach((seat, i) => {
      const own = seat.id === viewer;
      const c = handCenter(i, n, own ? OWN_HAND_R : HAND_R);
      const z = KZ.get(seat.id, "div", "ct-zone");
      z.style.setProperty("--seat", seat.color);
      const a = seatAngle(i, n);
      z.style.transform = `translate(${c.x}px, ${c.y}px) rotate(${(a - Math.PI / 2) * DEG}deg) translate(-50%, -50%)`;
      const incoming = o.target?.hand === seat.id ? Math.max(1, o.drag?.cards?.length ?? st.piles[o.drag?.pile]?.cards.length ?? 1) : 1;
      const chipW = chipRowWidth(handChips(st, seat.id).length);
      const reach0 = handReach(own, st.hands[seat.id].length + incoming, !!st.shownHands?.[seat.id], cardRoom(st, i, n));
      const reach = { along: reach0.along + chipW / 2, across: reach0.across };
      z.style.width = `${2 * reach.along}px`; z.style.height = `${2 * reach.across}px`;
      z.classList.toggle("ct-target", o.target?.hand === seat.id);
      const right = { x: Math.sin(a), y: -Math.cos(a) }, outward = { x: Math.cos(a), y: Math.sin(a) };
      // whether others can take from this hand: a lock in the player's color on the area's other
      // inner corner; its owner clicks it to lock or unlock
      if (seat.player) {
        const locked = handLocked(st, seat.id);
        const lx = c.x - right.x * (reach.along - CORNER_IN) - outward.x * (reach.across - CORNER_IN), ly = c.y - right.y * (reach.along - CORNER_IN) - outward.y * (reach.across - CORNER_IN);
        const can = own || view.lockAll;
        const lock = KE.get(`lock:${seat.id}`, can ? "button" : "div", "ct-lock");
        lock.style.setProperty("--seat", seat.color);
        lock.classList.toggle("ct-locked", locked);
        lock.classList.toggle("ct-lock-mine", own);
        lock.classList.toggle("ct-lock-click", can);
        lock.dataset.seat = seat.id;
        setHTML(lock, lockSVG(locked));
        const whose = own ? "Your hand" : `${seat.name}'s hand`;
        lock.dataset.tooltip = (locked ? `${whose} is locked: only ${own ? "you" : seat.name} can take from it` : `${whose} is open: anyone can take from it`) +
          (can ? `. Click to ${locked ? "unlock" : "lock"} it` : "");
        if (can) lock.setAttribute("aria-label", `${locked ? "Unlock" : "Lock"} ${own ? "your hand" : whose}`);
        lock.style.transform = `translate(${lx}px, ${ly}px) rotate(${-frame.rot * DEG}deg) translate(-50%, -50%)`;
      }
      // who can see this hand: an eye on the area's inner corner, to the right as its owner sits
      if (!st.hands[seat.id].length) return;
      const shown = !!st.shownHands?.[seat.id];
      const ex = c.x + right.x * (reach.along - CORNER_IN) - outward.x * (reach.across - CORNER_IN), ey = c.y + right.y * (reach.along - CORNER_IN) - outward.y * (reach.across - CORNER_IN);
      const eye = KE.get(`eye:${seat.id}`, "div", "ct-eye ct-zone-eye");
      setHTML(eye, eyeSVG(shown));
      eye.classList.toggle("ct-eye-open", shown);
      eye.title = shown ? "Everyone can see this hand" : own ? "Only you can see your hand" : `Only ${seat.name} can see this hand`;
      eye.style.transform = `translate(${ex}px, ${ey}px) rotate(${-frame.rot * DEG}deg) translate(-50%, -50%)`;
    });
    KZ.done(); KE.done();
  }

  // a point above a card's top edge (along: how far right of its middle), in table coordinates
  function aboveCard(q, along) {
    const cs = Math.cos(q.rot), sn = Math.sin(q.rot), hy = -(CARD_H / 2) * q.scale - 16;
    return { x: q.x + along * cs - hy * sn, y: q.y + along * sn + hy * cs };
  }

  // a name tag by whatever each player is touching
  function renderTags(st, place, o) {
    const K = keyed(tagLayer);
    for (const p of o.presence ?? []) {
      const s = seatOf(st, p.seat);
      if (!s || !p.cards.length) continue;
      const tag = K.get(p.seat, "div", "ct-tag");
      tag.style.setProperty("--seat", s.seat.color);
      setText(tag, p.seat === viewer ? "You" : s.seat.name);
      // a card riding in a row: the tag goes above it, clear of the cards beside it
      const rider = place.get(p.cards.at(-1))?.riding;
      const follow = () => {
        const pts = p.cards.map(curOf).filter(Boolean);
        if (!pts.length) return;
        if (rider) {
          const q = pts.at(-1), a = aboveCard(q, 34);
          tag.style.transform = `translate(${a.x}px, ${a.y}px) rotate(${-frame.rot * DEG}deg) translate(0, -50%)`;
          return;
        }
        // the top right corner of the carried card, as the viewer sees it
        const up = view.screenDir(CARD_W / 2 + 6, -CARD_H / 2 - 4);
        const x = Math.max(...pts.map((q) => q.x)), y = Math.min(...pts.map((q) => q.y));
        tag.style.transform = `translate(${x + up.x}px, ${y + up.y}px) rotate(${-frame.rot * DEG}deg)`;
      };
      follow(); followers.push(follow);
    }
    K.done();
  }

  // An eye on whatever you're holding or handling: struck through while only you see its face,
  // open when everyone can. Carried cards, a card or a stack you're peeking at, a stack you're
  // moving (each hand's area has its own).
  function renderEyes(st, place, o) {
    const K = keyed(eyeLayer);
    // a stack you're looking through has one eye, on the last card in its row as drawn (the
    // card you're moving through it, when that's the one)
    const peekEye = new Map();
    for (const [id, pl] of place) if (pl.peeking && pl.pile && !(pl.z < place.get(peekEye.get(pl.pile))?.z)) peekEye.set(pl.pile, id);
    for (const [id, pl] of place) {
      const card = st.cards[id];
      let open, to = null;
      const isTop = pl.pile && st.piles[pl.pile]?.cards.at(-1) === id;
      if (pl.carried) {
        if (pl.riding && pl.peeking) {
          if (peekEye.get(pl.pile) !== id) continue;
          open = false;
        } else {
          if ((pl.riding && pl.hand) || !pl.drag?.local) continue;
          // a whole stack carried into a row: one eye, on its top card
          if (pl.drag.whole && st.piles[pl.drag.pile]?.cards.at(-1) !== id) continue;
          open = o.drag?.faceUp != null ? o.drag.faceUp : card.faceUp;
          // held over another player's hand: flipped, it's shown to just them
          if (o.drag?.from?.hand && o.target?.hand && o.target.hand !== viewer) to = seatOf(st, o.target.hand)?.seat;
        }
      } else if (pl.peeking) {
        if (peekEye.get(pl.pile) !== id) continue;
        open = false;
      } else if (pl.lifted && pl.drag?.local) {
        // a whole stack you're carrying: one eye on its top card, for what everyone sees of it
        if (!isTop) continue;
        open = card.faceUp;
      } else if (!pl.hand && !card.faceUp && card.privateTo === viewer) open = false;
      else continue;
      const eye = K.get(id, "div", "ct-eye");
      setHTML(eye, eyeSVG(open));
      eye.title = pl.peeking ? "Only you can see these cards"
        : !open ? (pl.lifted ? "Nobody else can see this stack's cards" : "Only you can see this card")
        : to ? `${to.name} can see this card` : "Everyone can see this card";
      if (to && open) eye.style.setProperty("--eye", to.color);
      eye.classList.toggle("ct-eye-them", !!(to && open));
      eye.dataset.card = id;
      eye.classList.toggle("ct-eye-open", open);
      const follow = () => {
        const c = curOf(id);
        if (!c) return;
        // the card's top right corner, as placed on the table (riding in a row: above its top
        // edge, so it covers none of the cards beside it)
        if (pl.riding) {
          const a = aboveCard(c, 14);
          eye.style.transform = `translate(${a.x}px, ${a.y}px) rotate(${-frame.rot * DEG}deg) translate(-50%, -50%)`;
          return;
        }
        const cs = Math.cos(c.rot), sn = Math.sin(c.rot), hx = (CARD_W / 2) * c.scale - 4, hy = -(CARD_H / 2) * c.scale + 4;
        eye.style.transform = `translate(${c.x + hx * cs - hy * sn}px, ${c.y + hx * sn + hy * cs}px) rotate(${-frame.rot * DEG}deg) translate(-50%, -50%)`;
      };
      follow(); followers.push(follow);
    }
    K.done();
  }

  return view;
}

// A stack of chips, seen from a little above: a column of them, worth `amount` in all, made of
// as few chips as the denominations allow (the biggest at the bottom). A tall stack shows a
// sample of its chips, so it never stands taller than ~14 chips.
// (no chips worth more than 100 below 5,000, so a thousand still looks like a stack)
const DENOMS = [[1000, "#7a5bd0"], [500, "#d08a2a"], [100, "#25242a"], [25, "#2b7d5c"], [5, "#c4413b"], [1, "#e7e1d1"]];
export function chipColors(amount) {
  const out = [];
  const top = amount < 5000 ? 100 : amount < 20000 ? 500 : 1000;
  for (const [v, color] of DENOMS.filter(([v]) => v <= top)) for (let k = Math.floor(amount / v); k > 0; k--) { out.push(color); amount -= v; }
  return out;
}
const CHIP_RX = 20, CHIP_RY = 7, CHIP_T = 4.2, CHIP_MAX = 14;
function chipArt(amount) {
  let all = chipColors(amount);
  if (all.length > CHIP_MAX) all = Array.from({ length: CHIP_MAX }, (_, i) => all[Math.floor((i * (all.length - 1)) / (CHIP_MAX - 1))]);
  const n = all.length, w = CHIP_RX * 2 + 4, h = CHIP_RY * 2 + CHIP_T * (n + 1) + 2;
  const cx = w / 2;
  let g = "";
  all.forEach((color, i) => {
    const y = h - CHIP_RY - 2 - CHIP_T - i * CHIP_T; // the chip's top face
    const light = color === "#e7e1d1", edge = light ? "#b9b2a0" : "#f2ede0";
    // its side: the color, notched with light edge spots, darker below
    g += `<path d="M${cx - CHIP_RX} ${y}v${CHIP_T}a${CHIP_RX} ${CHIP_RY} 0 0 0 ${CHIP_RX * 2} 0v${-CHIP_T}z" fill="${color}"/>` +
      `<path d="M${cx - CHIP_RX} ${y + CHIP_T / 2}a${CHIP_RX} ${CHIP_RY} 0 0 0 ${CHIP_RX * 2} 0" fill="none" stroke="${edge}" stroke-width="${CHIP_T - 1.4}" stroke-dasharray="4.5 6.5"/>` +
      `<path d="M${cx - CHIP_RX} ${y + CHIP_T}a${CHIP_RX} ${CHIP_RY} 0 0 0 ${CHIP_RX * 2} 0" fill="none" stroke="rgba(0,0,0,.45)" stroke-width=".8"/>` +
      `<ellipse cx="${cx}" cy="${y}" rx="${CHIP_RX}" ry="${CHIP_RY}" fill="${color}" stroke="rgba(0,0,0,.35)" stroke-width=".6"/>`;
    if (i === n - 1) g += `<ellipse cx="${cx}" cy="${y}" rx="${CHIP_RX - 4.5}" ry="${CHIP_RY - 1.6}" fill="none" stroke="${edge}" stroke-width="1" stroke-dasharray="3 3.2"/>` +
      `<ellipse cx="${cx}" cy="${y}" rx="${CHIP_RX - 8}" ry="${CHIP_RY - 3}" fill="${edge}" opacity=".18"/>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${g}</svg>`;
}

// an eye, or the same eye struck through
export function eyeSVG(open) {
  return `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>${open ? "" : `<path d="M4 20 20 4" stroke-width="2.4"/>`}</svg>`;
}

// a padlock, shut or with its shackle swung open
export function lockSVG(locked) {
  const shackle = locked ? "M8.5 11V8a3.5 3.5 0 0 1 7 0v3" : "M8.5 11V8a3.5 3.5 0 0 1 6.8-1.2";
  return `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="${shackle}"/><rect x="6.5" y="11" width="11" height="8.5" rx="1.8" fill="currentColor" stroke-width="1.6"/></svg>`;
}

// A layer's children kept from one render to the next by key, so only what changed gets
// touched (rebuilding them on every pointer move made the browser repaint them all each frame).
function keyed(layer) {
  const old = new Map();
  for (const c of layer.children) old.set(c.__key, c);
  const used = new Set();
  return {
    get(key, tag, cls) {
      let e = old.get(key);
      if (!e || e.tagName !== tag.toUpperCase()) {
        e?.remove();
        e = document.createElement(tag); e.__key = key;
        layer.appendChild(e);
        old.set(key, e);
      }
      if (e.className !== cls) e.className = cls;
      used.add(e);
      return e;
    },
    done() { for (const c of [...layer.children]) if (!used.has(c)) c.remove(); },
  };
}
function setHTML(e, html) { if (e.__html !== html) { e.innerHTML = html; e.__html = html; } }
function setText(e, t) { if (e.textContent !== t) e.textContent = t; }

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

export { locate };
