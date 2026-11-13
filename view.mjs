// Draws a table state as one seat sees it. Cards are DOM elements, one per card, kept across
// renders; each one springs toward where it belongs every frame, so every move (a deal, a hand
// opening a gap, a dragged card) is continuous. The same view runs the main table and the small
// tables in the about modal.
import { TABLE_R, FELT_R, CARD_W, CARD_H, seatAngle, handCenter, canSee, tiltedToward, locate } from "./table.mjs";
import { faceSVG, backSVG } from "./faces.mjs";

const DEG = 180 / Math.PI;
export const HAND_R = FELT_R - 62;          // where other seats' hands sit
export const OWN_HAND_R = FELT_R - 66;      // the viewer's own hand, a bit closer to them and bigger
export const GRIP_REACH = CARD_H / 2 + 17; // from a stack's middle to its count tab
const HELD_TILT = 38, LOOK_TILT = 28; // degrees: a held card, a face-down card being looked at
const TURN_MS = 220, STACK_TURN_MS = 460;
const SLOT = "__slot";

// a steady pseudo-random number in [-1, 1] for a card: a messy stack keeps its look
function jitter(id, salt) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 2001) / 1000 - 1;
}

// spacing between neighbors in a hand of k cards
export function handGap(own, k, shown = false) {
  // your own hand, held or shown, is spaced so every card is easy to pick out and drop
  // between; other held hands bunch up more
  if (own || shown) return Math.min(own ? 46 : 38, (own ? 480 : 300) / Math.max(1, k - 1));
  return Math.min(20, 260 / Math.max(1, k - 1));
}
// how far along and across from a hand's middle it still takes drops
export function handReach(own, k, shown = false) {
  const along = Math.max(0, k - 1) * handGap(own, k, shown) / 2 + CARD_W / 2 + 22;
  return { along: Math.max(own ? 150 : 115, along), across: own ? 75 : 60 };
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
    layout, render, cardEl: (id) => cardEls.get(id), placement, handSlot,
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
    const out = new Map();
    const n = st.seats.length;
    const drags = dragsOf(o);
    const carried = new Set(drags.flatMap((d) => d.cards ?? []));
    const wholeOf = new Map(drags.filter((d) => d.whole).map((d) => [d.pile, d]));
    const rides = new Map();
    const piles = Object.values(st.piles).sort((a, b) => a.z - b.z);
    piles.forEach((p, pi) => {
      const wd = wholeOf.get(p.id), whole = !!wd;
      const px = whole ? wd.x : p.x, py = whole ? wd.y : p.y, prot = whole ? wd.rot : p.rot;
      const cards = p.cards.filter((id) => !carried.has(id));
      const k = cards.length;
      const c = Math.cos(prot), s = Math.sin(prot);
      cards.forEach((id, i) => {
        const d = Math.min(i, 40) * 0.22; // a stack's thickness
        let ox = -d, oy = -d, a = 0;
        if (p.messy && k > 1) {
          // loosely heaped: the top three step back up and to the left so their corners show,
          // the rest lie askew under the third with only their edges peeking out
          const depth = Math.min(k - 1 - i, 2), deep = k - 1 - i > 2;
          const j = (n) => jitter(id, n);
          ox = -depth * 15 + 15 + j(1) * (deep ? 6 : 2.5);
          oy = -depth * 7 + 7 + j(2) * (deep ? 5 : 2);
          a = (deep ? j(3) * 0.24 : j(3) * 0.11 - depth * 0.05);
        }
        out.set(id, {
          x: px + ox * c - oy * s, y: py + ox * s + oy * c, rot: prot + a,
          z: (whole ? 5000 : pi * 60) + i, scale: whole ? 1.04 : 1, lifted: whole, drag: wd,
        });
      });
    });
    st.seats.forEach((seat, si) => {
      const own = seat.id === viewer, shown = !!st.shownHands?.[seat.id];
      const list = st.hands[seat.id].filter((id) => !carried.has(id));
      const into = drags.find((d) => d.cards && d.target?.hand === seat.id);
      const gapAt = into ? Math.min(into.target.slot, list.length) : -1;
      // reordering a hand from inside it: the carried card rides along the hand, a little
      // raised, and the others make room for it; anything else coming in opens a wider gap
      const reorder = gapAt >= 0 && into.inHand;
      if (gapAt >= 0) list.splice(gapAt, 0, SLOT);
      list.forEach((id, i) => {
        // the cards either side of the gap step aside so it's wide enough to see
        const q = handSlot(si, n, own, i, list.length, gapAt < 0 || reorder ? 0 : Math.sign(i - gapAt), shown);
        if (id === SLOT) {
          if (reorder) rides.set(into, { ...q, z: 10000 + si * 100 + i, angle: seatAngle(si, n), hand: seat.id });
          else if (into.local) out.slot = { ...q, z: 10000 + si * 100 + i };
          return;
        }
        out.set(id, { ...q, z: 10000 + si * 100 + i, hand: seat.id, own, bob: own ? i : null });
      });
    });
    for (const d of drags) {
      if (!d.cards) continue;
      const r = rides.get(d);
      d.cards.forEach((id, i) => {
        if (r) {
          // along the hand's line, under the pointer, raised toward the middle of the table
          const right = { x: Math.sin(r.angle), y: -Math.cos(r.angle) }, outward = { x: Math.cos(r.angle), y: Math.sin(r.angle) };
          const along = (d.x - r.x) * right.x + (d.y - r.y) * right.y;
          out.set(id, {
            x: r.x + right.x * along - outward.x * 16, y: r.y + right.y * along - outward.y * 16,
            rot: r.rot, z: r.z, scale: r.scale, carried: true, riding: true, hand: r.hand, drag: d,
          });
        } else out.set(id, { x: d.x, y: d.y, rot: d.rot, z: 20000 + i, scale: 1.1, lifted: true, carried: true, drag: d });
      });
    }
    return out;
  }

  // slot i of k in a seat's hand: a shallow arc, fanned a little, facing the seat
  // (shown: laid flat in a straight row at table size instead)
  function handSlot(si, n, own, i, k, aside = 0, shown = false) {
    const a = seatAngle(si, n);
    // a shown hand slides toward the middle so its cards' tops stick out of the hand's area
    const hc = handCenter(si, n, (own ? OWN_HAND_R : HAND_R) - (shown ? handReach(own, k).across + 22 - CARD_H / 2 : 0));
    const t = i - (k - 1) / 2;
    const along = t * handGap(own, k, shown) + aside * (own ? 26 : 18);
    const fan = shown ? 0 : t * Math.min(4, 40 / Math.max(1, k)) / DEG;
    const arc = shown ? 0 : t * t * 0.35;
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
  //   online: Set of players connected, delays: { card: ms }, stackFlip: { cards, x, y } (a
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
      // a carried card shows whichever side its carrier will put down; someone else's card
      // held face up over a third player's hand is shown to that player only
      const dr = pl.carried ? pl.drag : null;
      if (dr?.faceUp != null && (dr.local || !pl.riding)) {
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
      const toward = pl.lifted ? null : tiltedToward(st, id);
      const s = toward ? seatOf(st, toward) : null;
      // axis across the line to the seat, in the card's own frame
      const ax = s ? s.angle + Math.PI / 2 - pl.rot : 0;
      const tgt = {
        x: pl.x, y: pl.y, rot: pl.rot, scale: pl.scale, z: pl.z, sway: 0,
        tilt: s ? (pl.hand ? HELD_TILT : LOOK_TILT) : 0,
        axis: [Math.cos(ax).toFixed(4), Math.sin(ax).toFixed(4)], persp: pl.hand ? 260 : 340,
        lift: interactive && o.hover === id && !pl.lifted ? 1 : 0,
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
      e.classList.toggle("ct-hover", tgt.lift > 0);
      // ring: whoever is touching it; otherwise whoever is looking at a face-down card
      const ringSeat = touch.get(id) ?? (!pl.hand && !card.faceUp ? card.privateTo : null);
      const ring = ringSeat ? seatOf(st, ringSeat)?.seat.color : null;
      e.style.setProperty("--ring", ring ?? "transparent");
      e.classList.toggle("ct-ringed", !!ring);
      e.classList.toggle("ct-touched", touch.has(id));
    }
    for (const [id, e] of cardEls) if (!live.has(id)) { e.remove(); cardEls.delete(id); shown.delete(id); springs.delete(id); }
    followers = [];
    if (interactive) { renderGrips(st, o); renderZones(st, place, o); renderTags(st, o); renderEyes(st, place, o); }
    wake();
  }

  function renderSeats(st, o) {
    const n = st.seats.length;
    seatLayer.replaceChildren();
    st.seats.forEach((seat, i) => {
      const a = seatAngle(i, n);
      const r = (FELT_R + TABLE_R) / 2;
      const plate = el("div", "ct-plate", seatLayer);
      plate.style.setProperty("--seat", seat.color);
      // an empty seat says so; a player who has dropped off is dimmed until they're back
      const open = interactive && o.online && !seat.player;
      plate.textContent = open ? "Open seat" : seat.id === viewer && interactive ? `${seat.name} (you)` : seat.name;
      plate.classList.toggle("ct-open", !!open);
      plate.classList.toggle("ct-away", !!(interactive && o.online && seat.player && !o.online.has(seat.player)));
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
  function renderGrips(st, o) {
    gripLayer.replaceChildren();
    const carriedNow = new Set(dragsOf(o).flatMap((d) => d.cards ?? []));
    for (const p of Object.values(st.piles)) {
      // a card being carried off the stack no longer counts
      const rest = p.cards.filter((id) => !carriedNow.has(id));
      if (rest.length < 2) continue;
      const g = el("div", "ct-grip", gripLayer);
      g.dataset.pile = p.id;
      g.textContent = rest.length;
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
  }

  // each hand's area, always drawn (it lights up while you carry cards into it), and the gap
  // carried cards would fill
  function renderZones(st, place, o) {
    zoneLayer.replaceChildren();
    zoneEyeLayer.replaceChildren();
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
      const z = el("div", "ct-zone", zoneLayer);
      z.style.setProperty("--seat", seat.color);
      const a = seatAngle(i, n);
      z.style.transform = `translate(${c.x}px, ${c.y}px) rotate(${(a - Math.PI / 2) * DEG}deg) translate(-50%, -50%)`;
      const reach = handReach(own, st.hands[seat.id].length + 1, !!st.shownHands?.[seat.id]);
      z.style.width = `${2 * reach.along}px`; z.style.height = `${2 * reach.across}px`;
      z.classList.toggle("ct-target", o.target?.hand === seat.id);
      // who can see this hand: an eye on the area's inner corner, to the right as its owner sits
      if (!st.hands[seat.id].length) return;
      const shown = !!st.shownHands?.[seat.id];
      const right = { x: Math.sin(a), y: -Math.cos(a) }, outward = { x: Math.cos(a), y: Math.sin(a) };
      const ex = c.x + right.x * reach.along - outward.x * reach.across, ey = c.y + right.y * reach.along - outward.y * reach.across;
      const eye = el("div", "ct-eye ct-zone-eye", zoneEyeLayer);
      eye.innerHTML = eyeSVG(shown);
      eye.classList.toggle("ct-eye-open", shown);
      eye.title = shown ? "Everyone can see this hand" : own ? "Only you can see your hand" : `Only ${seat.name} can see this hand`;
      eye.style.transform = `translate(${ex}px, ${ey}px) rotate(${-frame.rot * DEG}deg) translate(-50%, -50%)`;
    });
  }

  // a name tag by whatever each player is touching
  function renderTags(st, o) {
    tagLayer.replaceChildren();
    for (const p of o.presence ?? []) {
      const s = seatOf(st, p.seat);
      if (!s || !p.cards.length) continue;
      const tag = el("div", "ct-tag", tagLayer);
      tag.style.setProperty("--seat", s.seat.color);
      tag.textContent = p.seat === viewer ? "You" : s.seat.name;
      const follow = () => {
        const pts = p.cards.map(curOf).filter(Boolean);
        if (!pts.length) return;
        // the top right corner of the carried card, as the viewer sees it
        const up = view.screenDir(CARD_W / 2 + 6, -CARD_H / 2 - 4);
        const x = Math.max(...pts.map((q) => q.x)), y = Math.min(...pts.map((q) => q.y));
        tag.style.transform = `translate(${x + up.x}px, ${y + up.y}px) rotate(${-frame.rot * DEG}deg)`;
      };
      follow(); followers.push(follow);
    }
  }

  // An eye on the cards you're touching: crossed out while only you can see the face, open when
  // everyone can. Your peeks, and whatever you're carrying (your hand has one by its buttons).
  function renderEyes(st, place, o) {
    eyeLayer.replaceChildren();
    for (const [id, pl] of place) {
      const card = st.cards[id];
      let open, to = null;
      if (pl.carried) {
        if (pl.riding || !pl.drag?.local) continue;
        open = o.drag?.faceUp != null ? o.drag.faceUp : card.faceUp;
        // held over another player's hand: flipped, it's shown to just them
        if (o.drag?.from?.hand && o.target?.hand && o.target.hand !== viewer) to = seatOf(st, o.target.hand)?.seat;
      } else if (!pl.hand && !card.faceUp && card.privateTo === viewer) open = false;
      else continue;
      const eye = el("div", "ct-eye", eyeLayer);
      eye.innerHTML = eyeSVG(open);
      eye.title = !open ? "Only you can see this card" : to ? `${to.name} can see this card` : "Everyone can see this card";
      if (to && open) eye.style.setProperty("--eye", to.color);
      eye.classList.toggle("ct-eye-them", !!(to && open));
      eye.dataset.card = id;
      eye.classList.toggle("ct-eye-open", open);
      const follow = () => {
        const c = curOf(id);
        if (!c) return;
        // the card's top right corner, as placed on the table
        const cs = Math.cos(c.rot), sn = Math.sin(c.rot), hx = (CARD_W / 2) * c.scale - 4, hy = -(CARD_H / 2) * c.scale + 4;
        eye.style.transform = `translate(${c.x + hx * cs - hy * sn}px, ${c.y + hx * sn + hy * cs}px) rotate(${-frame.rot * DEG}deg) translate(-50%, -50%)`;
      };
      follow(); followers.push(follow);
    }
  }

  return view;
}

// an eye, or the same eye struck through
export function eyeSVG(open) {
  return `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>${open ? "" : `<path d="M4 20 20 4" stroke-width="2.4"/>`}</svg>`;
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

export { locate };
