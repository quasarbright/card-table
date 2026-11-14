// The table's state and the actions that change it. No rules of any game live here: the
// engine knows about cards, stacks on the table, hands, and who can see which card.
//
// Every change goes through apply(state, action), which is pure and deterministic. Anything
// random (a shuffle's new order) is decided before the action is made and carried in it, so
// once the table is shared between players, each peer can apply the same actions and end up
// with the same table.
//
// state = {
//   seats: [{ id, name, color, player }],         // in order around the table; player: who sits there
//   cards: { [id]: { id, rank, suit, faceUp, privateTo } },
//   piles: { [id]: { id, x, y, rot, z, look, cards: [bottom … top] } },
//     look: squared up (none), "few" (loosely heaped, the top few showing) or "spread" (in a row)
//   hands: { [seatId]: [cardId, …] },             // left to right, as the owner sees them
//   shownHands: { [seatId]: true },               // hands laid flat, face up, for everyone
//   nextZ,                                        // stacking order for piles
// }
//
// Table coordinates: the table is a wide rounded rectangle TABLE_W × TABLE_H, its middle at
// (CX, CY), with a rail RAIL wide around the felt. Seats sit along the two long sides: the first
// half (rounded up) along the bottom, the rest along the top, numbered going round the table
// (along the bottom right to left, then along the top left to right), seat 0 at the bottom.
// seatAngle(i, n) is the way out from the middle toward a seat, measured like screen angles
// (y down): π/2 for the bottom side, -π/2 for the top.

export const TABLE_W = 1100, TABLE_H = 660, RAIL = 50;
export const FELT_W = TABLE_W - 2 * RAIL, FELT_H = TABLE_H - 2 * RAIL, FELT_RADIUS = 90;
export const CX = TABLE_W / 2, CY = TABLE_H / 2;
export const CARD_W = 70, CARD_H = 98;
export const SUITS = ["S", "H", "D", "C"];
export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
// the colors players can choose from; a new seat takes the first one nobody has
export const SEAT_COLORS = ["#f0b84a", "#6cb8f0", "#f0708c", "#b392f0", "#f28a52", "#4fd1c5", "#a3d977", "#e88fd9"];
export const MAX_SEATS = 6;

// seat i of n: which side, where along it (x), and how wide its share of the side is
export function seatSpot(i, n) {
  const bottom = Math.ceil(n / 2), top = n - bottom;
  const onBottom = i < bottom, count = onBottom ? bottom : top;
  // left-to-right position on its side
  const j = onBottom ? bottom - 1 - i : i - bottom;
  // (kept in from the ends, so hands by the corners stay clear of their curve)
  const share = (FELT_W - 80) / count;
  return { x: CX + (j - (count - 1) / 2) * share, a: onBottom ? Math.PI / 2 : -Math.PI / 2, room: share - 16 };
}
export function seatAngle(i, n) { return seatSpot(i, n).a; }
// how wide a seat's hand may spread
export function seatRoom(i, n) { return seatSpot(i, n).room; }

// a point r out from the table's middle line toward seat i, in front of that seat
export function handCenter(i, n, r = FELT_H / 2 - 70) {
  const { x, a } = seatSpot(i, n);
  return { x: x + r * Math.cos(a), y: CY + r * Math.sin(a) };
}

// the nearest point to (x, y) where something reaching ext.x either side and ext.y above and
// below lies on the felt, at least `margin` in from its edge
export function clampToFelt(x, y, margin = 50, ext = { x: 0, y: 0 }) {
  const hw = Math.max(0, FELT_W / 2 - margin - ext.x), hh = Math.max(0, FELT_H / 2 - margin - ext.y);
  const r = Math.max(0, Math.min(FELT_RADIUS - margin, hw, hh));
  let dx = Math.max(-hw, Math.min(hw, x - CX)), dy = Math.max(-hh, Math.min(hh, y - CY));
  // in a rounded corner, back along the corner's curve
  const ix = hw - r, iy = hh - r, ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax > ix && ay > iy) {
    const ex = ax - ix, ey = ay - iy, d = Math.hypot(ex, ey);
    if (d > r) { dx = Math.sign(dx) * (ix + ex * r / d); dy = Math.sign(dy) * (iy + ey * r / d); }
  }
  return { x: CX + dx, y: CY + dy };
}

export function makeSeats(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `Player ${i + 1}`, color: SEAT_COLORS[i], player: null }));
}

export function deckCards() {
  const cards = {};
  for (const suit of SUITS) for (const rank of RANKS) {
    const id = rank + suit;
    cards[id] = { id, rank, suit, faceUp: false, privateTo: null };
  }
  return cards;
}

// a fresh table: one face-down deck in the middle, in new-deck order
export function newTable(nSeats = 4) {
  const seats = makeSeats(nSeats);
  const cards = deckCards();
  const hands = Object.fromEntries(seats.map((s) => [s.id, []]));
  // new-deck order from the top: A♠ … K♠, … ; the array is bottom → top
  const order = Object.keys(cards).reverse();
  return {
    seats, cards, hands,
    piles: { deck: { id: "deck", x: CX, y: CY, rot: 0, z: 1, cards: order } },
    nextZ: 2,
    shownHands: {},
  };
}

// ---- lookups -------------------------------------------------------------------------------

// where a card is: { pile, index } or { hand: seatId, index }
export function locate(state, cardId) {
  for (const p of Object.values(state.piles)) {
    const i = p.cards.indexOf(cardId);
    if (i >= 0) return { pile: p.id, index: i };
  }
  for (const [seat, hand] of Object.entries(state.hands)) {
    const i = hand.indexOf(cardId);
    if (i >= 0) return { hand: seat, index: i };
  }
  return null;
}

// Can `seatId` see this card's face? Face-up cards: everyone. In a hand: the hand's owner,
// unless the card has been turned face up to show it. Face down on the table: only the seat
// it's private to (someone looking at it), if any.
export function canSee(state, cardId, seatId) {
  const c = state.cards[cardId];
  if (c.faceUp) return true;
  const where = locate(state, cardId);
  if (where?.hand) return where.hand === seatId || !!state.shownHands?.[where.hand];
  return c.privateTo === seatId;
}

// the seat a card is turned toward, if any: its holder, or whoever is looking at it
export function tiltedToward(state, cardId) {
  const c = state.cards[cardId];
  const where = locate(state, cardId);
  if (where?.hand) return c.faceUp || state.shownHands?.[where.hand] ? null : where.hand;
  return c.faceUp ? null : c.privateTo;
}

// ---- actions -------------------------------------------------------------------------------
//
// { type: "moveCards", cards: [ids], to }   to = { pile: id, index? } (on top, or at index)
//                                               | { newPile: { id, x, y, rot } }
//                                               | { hand: seatId, index }
// { type: "movePile", pile, x, y }
// { type: "flip", cards: [ids] }             turn each card over in place
// { type: "flipPile", pile }                 turn the whole stack over: order reverses too; it
//                                            keeps its look
// { type: "setPrivate", cards: [ids], seat } seat = null makes them hidden from everyone again
// { type: "shuffle", pile, order }           order: the pile's cards, bottom → top
// { type: "deal", pile, count, seats }       count cards to each seat's hand, one at a time
// { type: "sit", seat, player, name, color? } a player takes a seat (and leaves any other),
//                                            in that color unless another player has it
// { type: "stand", seat }                    the seat's player gets up (the seat and its hand stay)
// { type: "setPlayer", seat, name?, color? } rename or recolor a seat; a color no player has
//                                            (an empty seat holding it swaps with you)
// { type: "setHandShown", seat, shown }     lay a hand flat and face up (it stays that seat's)
// { type: "setHandLocked", seat, locked }   a locked hand (the default) is its player's alone:
//                                            nobody else takes, flips or peeks at its cards
// { type: "setLook", pile, look }           null (squared up), "few" or "spread"
// { type: "setMessy", pile, messy }         the same as look "few" / null
// { type: "batch", actions: [...] }         several actions as one step (one undo)
// { type: "split", pile, parts: [{ id, x, y, rot }] }  cut into parts.length stacks; parts[0]
//                                            keeps the pile's id and gets the bottom cards
// { type: "gather", id, x, y, rot }          every card into one face-down stack
// { type: "setSeats", n }                    seats grow as people sit down (removed seats' hands
//                                            go to the middle)

export function apply(state, action) {
  const s = structuredClone(state);
  const fn = ACTIONS[action.type];
  if (!fn) throw new Error(`unknown action ${action.type}`);
  fn(s, action);
  return s;
}

function take(s, cardId) {
  const where = locate(s, cardId);
  if (!where) throw new Error(`no card ${cardId}`);
  if (where.pile) {
    const p = s.piles[where.pile];
    p.cards.splice(where.index, 1);
    if (p.cards.length === 0) delete s.piles[p.id];
  } else {
    s.hands[where.hand].splice(where.index, 1);
  }
  return where;
}

// give a seat a color; an empty seat that had it takes the seat's old one
function recolor(s, seat, color) {
  const other = s.seats.find((q) => q !== seat && q.color === color);
  if (other) other.color = seat.color;
  seat.color = color;
}

function raise(s, pileId) { s.piles[pileId].z = s.nextZ++; }

const ACTIONS = {
  moveCards(s, { cards, to }) {
    // an index (into a hand, or a stack) counts positions before any of the moved cards leave
    let index = to.hand ? to.index ?? s.hands[to.hand].length : to.pile ? to.index ?? null : 0;
    for (const id of cards) {
      const from = take(s, id);
      if (to.hand && from.hand === to.hand && from.index < index) index--;
      if (to.pile && index != null && from.pile === to.pile && from.index < index) index--;
      // a card leaving someone's hand, or landing in one, stops being looked at
      s.cards[id].privateTo = null;
    }
    if (to.hand) {
      for (const id of cards) s.cards[id].faceUp = false;
      s.hands[to.hand].splice(Math.max(0, Math.min(index, s.hands[to.hand].length)), 0, ...cards);
    } else if (to.pile) {
      const p = s.piles[to.pile];
      if (!p) throw new Error(`no pile ${to.pile}`);
      if (index == null) p.cards.push(...cards);
      else p.cards.splice(Math.max(0, Math.min(index, p.cards.length)), 0, ...cards);
      raise(s, to.pile);
    } else if (to.newPile) {
      const { id, x, y, rot = 0 } = to.newPile;
      if (s.piles[id]) throw new Error(`pile ${id} exists`);
      s.piles[id] = { id, x, y, rot, z: 0, cards: [...cards] };
      raise(s, id);
    }
  },
  movePile(s, { pile, x, y, rot }) {
    const p = s.piles[pile];
    p.x = x; p.y = y;
    if (rot !== undefined) p.rot = rot;
    raise(s, pile);
  },
  flip(s, { cards }) {
    for (const id of cards) {
      const c = s.cards[id];
      c.faceUp = !c.faceUp;
      c.privateTo = null;
    }
  },
  flipPile(s, { pile }) {
    const p = s.piles[pile];
    p.cards.reverse();
    // it keeps how it lies: squared up, the top few showing, or spread out
    for (const id of p.cards) { s.cards[id].faceUp = !s.cards[id].faceUp; s.cards[id].privateTo = null; }
    raise(s, pile);
  },
  setPrivate(s, { cards, seat }) {
    for (const id of cards) if (!s.cards[id].faceUp) s.cards[id].privateTo = seat;
  },
  shuffle(s, { pile, order }) {
    const p = s.piles[pile];
    if (order.length !== p.cards.length || [...order].sort().join() !== [...p.cards].sort().join())
      throw new Error("shuffle order must be the same cards");
    p.cards = [...order];
    for (const id of p.cards) { s.cards[id].faceUp = false; s.cards[id].privateTo = null; }
  },
  deal(s, { pile, count, seats }) {
    for (let k = 0; k < count; k++) for (const seat of seats) {
      const p = s.piles[pile];
      if (!p) return;
      const id = p.cards[p.cards.length - 1];
      ACTIONS.moveCards(s, { cards: [id], to: { hand: seat } });
    }
  },
  sit(s, { seat, player, name, color }) {
    for (const x of s.seats) if (x.player === player) x.player = null;
    const x = s.seats.find((q) => q.id === seat);
    if (!x) throw new Error(`no seat ${seat}`);
    x.player = player; x.name = name;
    if (s.openHands) delete s.openHands[seat]; // a new player's hand starts locked
    if (color && SEAT_COLORS.includes(color) && !s.seats.some((q) => q !== x && q.player && q.color === color)) recolor(s, x, color);
  },
  stand(s, { seat }) {
    const x = s.seats.find((q) => q.id === seat);
    if (!x) throw new Error(`no seat ${seat}`);
    x.player = null;
    if (s.openHands) delete s.openHands[seat];
  },
  setPlayer(s, { seat, name, color }) {
    const x = s.seats.find((q) => q.id === seat);
    if (!x) throw new Error(`no seat ${seat}`);
    if (name != null) x.name = String(name).slice(0, 20);
    if (color != null) {
      if (!SEAT_COLORS.includes(color) || s.seats.some((q) => q !== x && q.player && q.color === color)) throw new Error("color taken");
      recolor(s, x, color);
    }
  },
  setHandShown(s, { seat, shown }) {
    s.shownHands = { ...(s.shownHands ?? {}) };
    if (shown) s.shownHands[seat] = true; else delete s.shownHands[seat];
  },
  setHandLocked(s, { seat, locked }) {
    s.openHands = { ...(s.openHands ?? {}) };
    if (locked) delete s.openHands[seat]; else s.openHands[seat] = true;
  },
  setLook(s, { pile, look }) {
    const p = s.piles[pile];
    delete p.messy;
    if (look === "few" || look === "spread") p.look = look; else delete p.look;
  },
  setMessy(s, { pile, messy }) { ACTIONS.setLook(s, { pile, look: messy ? "few" : null }); },
  batch(s, { actions }) { for (const a of actions) ACTIONS[a.type](s, a); },
  split(s, { pile, parts }) {
    const cards = s.piles[pile].cards, n = parts.length;
    if (parts[0].id !== pile || n < 2 || n > cards.length) throw new Error("bad split");
    delete s.piles[pile];
    parts.forEach(({ id, x, y, rot = 0 }, k) => {
      const from = Math.round((k * cards.length) / n), to = Math.round(((k + 1) * cards.length) / n);
      s.piles[id] = { id, x, y, rot, z: 0, cards: cards.slice(from, to) };
      raise(s, id);
    });
  },
  gather(s, { id, x, y, rot = 0 }) {
    const all = [...Object.values(s.piles).sort((a, b) => a.z - b.z).flatMap((p) => p.cards),
      ...Object.values(s.hands).flat()];
    s.piles = {};
    for (const seat of Object.keys(s.hands)) s.hands[seat] = [];
    for (const c of Object.values(s.cards)) { c.faceUp = false; c.privateTo = null; }
    s.piles[id] = { id, x, y, rot, z: 0, cards: all };
    raise(s, id);
  },
  setSeats(s, { n }) {
    n = Math.max(1, Math.min(MAX_SEATS, n));
    const seats = makeSeats(n);
    // seats that stay keep their names, players and colors; new ones take colors nobody has
    for (let i = 0; i < Math.min(n, s.seats.length); i++) {
      seats[i].name = s.seats[i].name; seats[i].player = s.seats[i].player ?? null; seats[i].color = s.seats[i].color;
    }
    for (let i = s.seats.length; i < n; i++) {
      seats[i].color = SEAT_COLORS.find((c) => !seats.slice(0, i).some((q) => q.color === c));
    }
    const leftover = s.seats.slice(n).flatMap((seat) => s.hands[seat.id]);
    const hands = Object.fromEntries(seats.map((seat) => [seat.id, s.hands[seat.id] ?? []]));
    const keep = new Set(seats.map((seat) => seat.id));
    for (const c of Object.values(s.cards)) if (c.privateTo && !keep.has(c.privateTo)) c.privateTo = null;
    s.seats = seats; s.hands = hands;
    s.shownHands = Object.fromEntries(Object.entries(s.shownHands ?? {}).filter(([id]) => hands[id]));
    s.openHands = Object.fromEntries(Object.entries(s.openHands ?? {}).filter(([id]) => hands[id]));
    if (leftover.length) {
      for (const id of leftover) s.cards[id].faceUp = false;
      const id = `returned${s.nextZ}`;
      s.piles[id] = { id, x: CX, y: CY, rot: 0, z: 0, cards: leftover };
      raise(s, id);
    }
  },
};

// a hand is locked while its seat has a player who hasn't unlocked it
export function handLocked(state, seatId) {
  const seat = state.seats.find((q) => q.id === seatId);
  return !!seat?.player && !state.openHands?.[seatId];
}

// whether an action by `by` (a seat id) reaches into someone else's locked hand
export function touchesLockedHand(state, action, by) {
  if (action.type === "batch") return action.actions.some((a) => touchesLockedHand(state, a, by));
  if (action.type === "setHandLocked") return action.seat !== by;
  if (action.type === "setHandShown") return action.seat !== by && handLocked(state, action.seat);
  if (!["moveCards", "flip", "setPrivate"].includes(action.type)) return false;
  return action.cards.some((id) => {
    const hand = locate(state, id)?.hand;
    return hand && hand !== by && handLocked(state, hand);
  });
}

// a random order for a shuffle (made by whoever shuffles, then sent in the action)
export function shuffledOrder(cards, random = Math.random) {
  const a = [...cards];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// every card is in exactly one place (tests use this after every action)
export function checkConservation(state) {
  const seen = [...Object.values(state.piles).flatMap((p) => p.cards), ...Object.values(state.hands).flat()];
  const ids = Object.keys(state.cards);
  if (seen.length !== ids.length || new Set(seen).size !== ids.length) return false;
  for (const p of Object.values(state.piles)) if (p.cards.length === 0) return false;
  return true;
}
