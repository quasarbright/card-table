// Draws a table state as one seat sees it. Cards are DOM elements, one per card, kept across
// renders; each one springs toward where it belongs every frame, so every move (a deal, a hand
// opening a gap, a dragged card) is continuous. The same view runs the main table and the small
// tables in the about modal.
import { TABLE_R, FELT_R, CARD_W, CARD_H, seatAngle, handCenter, canSee, tiltedToward, locate } from "./table.mjs";
import { faceSVG, backSVG } from "./faces.mjs";

const DEG = 180 / Math.PI;
export const HAND_R = FELT_R - 62;          // where other seats' hands sit
export const OWN_HAND_R = FELT_R - 66;      // the viewer's own hand, a bit closer to them and bigger
export const OWN_HAND_SCALE = 1.3;
export const GRIP_REACH = CARD_H / 2 + 17; // from a stack's middle to its count tab
const HELD_TILT = 38, LOOK_TILT = 28; // degrees: a held card, a face-down card being looked at
const FAN_COUNT = 5, FAN_STEP = 12 / DEG, FAN_SHIFT = 8; // a face-up stack shows this many corners
const TURN_MS = 220, STACK_TURN_MS = 460;
const SLOT = "__slot";

// spacing between neighbours in a hand of k cards
export function handGap(own, k) { return Math.min(own ? 30 : 20, (own ? 420 : 260) / Math.max(1, k - 1)); }

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

  // Where every card goes: position, rotation, z order. `drag` carries cards with the pointer;
  // a hand being dropped into opens a gap (`slot`) where they'd land.
  function placement(st, o = {}) {
    const out = new Map();
    const n = st.seats.length;
    const carried = new Set(o.drag?.cards ?? []);
    const piles = Object.values(st.piles).sort((a, b) => a.z - b.z);
    piles.forEach((p, pi) => {
      const whole = o.drag?.pile === p.id && o.drag.whole;
      const px = whole ? o.drag.x : p.x, py = whole ? o.drag.y : p.y, prot = whole ? o.drag.rot : p.rot;
      const cards = p.cards.filter((id) => !carried.has(id));
      const k = cards.length;
      // a face-up stack fans its top few cards about their bottom-left corners, the way you'd
      // thumb a stack open, so each one's index shows
      let fan = 0;
      while (fan < FAN_COUNT && fan < k && st.cards[cards[k - 1 - fan]].faceUp) fan++;
      const fanFrom = k - fan, shift = Math.max(0, fan - 1) * FAN_SHIFT;
      const c = Math.cos(prot), s = Math.sin(prot);
      cards.forEach((id, i) => {
        const d = Math.min(i, 40) * 0.22; // a stack's thickness
        const a = fan > 1 ? -(k - 1 - Math.max(i, fanFrom)) * FAN_STEP : 0;
        const ox = -CARD_W / 2 + (CARD_W / 2) * Math.cos(a) + (CARD_H / 2) * Math.sin(a) + shift - d;
        const oy = CARD_H / 2 + (CARD_W / 2) * Math.sin(a) - (CARD_H / 2) * Math.cos(a) - d;
        out.set(id, {
          x: px + ox * c - oy * s, y: py + ox * s + oy * c, rot: prot + a,
          z: (whole ? 5000 : pi * 60) + i, scale: whole ? 1.04 : 1, lifted: whole,
        });
      });
    });
    st.seats.forEach((seat, si) => {
      const own = seat.id === viewer;
      const list = st.hands[seat.id].filter((id) => !carried.has(id));
      const gapAt = o.target?.hand === seat.id ? o.target.slot : -1;
      if (gapAt >= 0) list.splice(gapAt, 0, SLOT);
      list.forEach((id, i) => {
        // the cards either side of the gap step aside so it's wide enough to see
        const q = handSlot(si, n, own, i, list.length, gapAt < 0 ? 0 : Math.sign(i - gapAt));
        if (id === SLOT) { out.slot = { ...q, z: 10000 + si * 100 + i }; return; }
        out.set(id, { ...q, z: 10000 + si * 100 + i, hand: seat.id, own, bob: own ? i : null });
      });
    });
    if (o.drag?.cards) {
      const big = o.drag.from?.hand === viewer ? OWN_HAND_SCALE : 1;
      o.drag.cards.forEach((id, i) => out.set(id, {
        x: o.drag.x, y: o.drag.y, rot: o.drag.rot, z: 20000 + i, scale: big * 1.1, lifted: true, carried: true,
      }));
    }
    return out;
  }

  // slot i of k in a seat's hand: a shallow arc, fanned a little, facing the seat
  function handSlot(si, n, own, i, k, aside = 0) {
    const a = seatAngle(si, n);
    const hc = handCenter(si, n, own ? OWN_HAND_R : HAND_R);
    const t = i - (k - 1) / 2;
    const along = t * handGap(own, k) + aside * (own ? 26 : 18);
    const fan = t * Math.min(4, 40 / Math.max(1, k)) / DEG;
    const arc = t * t * 0.35;
    return {
      x: hc.x + Math.sin(a) * along + Math.cos(a) * arc, y: hc.y - Math.cos(a) * along + Math.sin(a) * arc,
      rot: a - Math.PI / 2 + fan, scale: own ? OWN_HAND_SCALE : 1,
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
      t.sway = t.carried ? Math.max(-0.4, Math.min(0.4, (v.x * right.x + v.y * right.y) * 0.0011)) : 0;
      const k = reduced ? 2000 : t.carried ? 900 : 190, zeta = t.carried ? 0.85 : 0.68;
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

  // st: table state; o: { drag, presence: [{ seat, cards }], delays: Map, target, instant, hover,
  //   stackFlip: { cards: Set, x, y } (a stack just turned over, and its middle) }
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
      const look = canSee(st, id, viewer) ? "face" : "back";
      // a whole stack turning over turns as one block, about the stack's middle
      const whole = !o.instant && shown.has(id) && o.stackFlip?.cards.has(id);
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
        carried: !!pl.carried, bob: interactive ? pl.bob : null,
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
        const delay = o.delays?.get(id) || (o.stackFlip?.cards.has(id) ? STACK_TURN_MS / 2 : 0);
        setTarget(sp, tgt, delay, now);
        sp.dirty = true;
      }
      e.classList.toggle("ct-lifted", !!pl.lifted);
      e.classList.toggle("ct-carried", !!(o.drag && (o.drag.cards?.includes(id) || pl.lifted)));
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
    if (interactive) { renderGrips(st, o); renderZones(st, place, o); renderTags(st, o); }
    wake();
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
  function renderGrips(st, o) {
    gripLayer.replaceChildren();
    for (const p of Object.values(st.piles)) {
      // a card being carried off the stack no longer counts
      const rest = p.cards.filter((id) => !o.drag?.cards?.includes(id));
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

  // while carrying cards: where each hand would take them, and the gap they'd fill
  function renderZones(st, place, o) {
    zoneLayer.replaceChildren();
    const was = slotEl.classList.contains("ct-on");
    slotEl.classList.toggle("ct-on", !!place.slot);
    if (place.slot) {
      const q = place.slot;
      // appear in place; after that, slide from gap to gap
      slotEl.style.transition = was ? "" : "opacity .15s";
      slotEl.style.zIndex = q.z;
      slotEl.style.transform = `translate(${q.x - CARD_W / 2}px, ${q.y - CARD_H / 2}px) rotate(${q.rot * DEG}deg) scale(${q.scale})`;
    }
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

  return view;
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

export { locate };
