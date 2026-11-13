// The table's state and the actions that change it. No rules of any game live here: the
// engine knows about cards, stacks on the table, hands, and who can see which card.
//
// Every change goes through apply(state, action), which is pure and deterministic. Anything
// random (a shuffle's new order) is decided before the action is made and carried in it, so
// once the table is shared between players, each peer can apply the same actions and end up
// with the same table.
//
// state = {
//   seats: [{ id, name, color }],                 // in order around the table
//   cards: { [id]: { id, rank, suit, faceUp, privateTo } },
//   piles: { [id]: { id, x, y, rot, z, spread, cards: [bottom … top] } },
//   hands: { [seatId]: [cardId, …] },             // left to right, as the owner sees them
//   nextZ,                                        // stacking order for piles
// }
//
// Table coordinates: the table is a circle of radius TABLE_R centered on (TABLE_R, TABLE_R).
// Seat i of n sits at angle seatAngle(i, n), measured like screen angles (y down), with seat
// 0 at the bottom.

export const TABLE_R = 500;
export const FELT_R = 440;
export const CARD_W = 70, CARD_H = 98;
export const SUITS = ["S", "H", "D", "C"];
export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
export const SEAT_COLORS = ["#f0b84a", "#6cb8f0", "#f0708c", "#b392f0", "#f28a52", "#4fd1c5"];
export const MAX_SEATS = SEAT_COLORS.length;

export function seatAngle(i, n) { return Math.PI / 2 + (i * 2 * Math.PI) / n; }

// where a seat's hand sits on the table (just inside the felt's edge)
export function handCenter(i, n, r = FELT_R - 70) {
  const a = seatAngle(i, n);
  return { x: TABLE_R + r * Math.cos(a), y: TABLE_R + r * Math.sin(a) };
}

export function makeSeats(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `Player ${i + 1}`, color: SEAT_COLORS[i] }));
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
    piles: { deck: { id: "deck", x: TABLE_R, y: TABLE_R, rot: 0, z: 1, spread: false, cards: order } },
    nextZ: 2,
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
  if (where?.hand) return where.hand === seatId;
  return c.privateTo === seatId;
}

// the seat a card is turned toward, if any: its holder, or whoever is looking at it
export function tiltedToward(state, cardId) {
  const c = state.cards[cardId];
  const where = locate(state, cardId);
  if (where?.hand) return c.faceUp ? null : where.hand;
  return c.faceUp ? null : c.privateTo;
}

// ---- actions -------------------------------------------------------------------------------
//
// { type: "moveCards", cards: [ids], to }   to = { pile: id } (on top)
//                                               | { newPile: { id, x, y, rot } }
//                                               | { hand: seatId, index }
// { type: "movePile", pile, x, y }
// { type: "flip", cards: [ids] }             turn each card over in place
// { type: "flipPile", pile }                 turn the whole stack over: order reverses too
// { type: "setPrivate", cards: [ids], seat } seat = null makes them hidden from everyone again
// { type: "shuffle", pile, order }           order: the pile's cards, bottom → top
// { type: "deal", pile, count, seats }       count cards to each seat's hand, one at a time
// { type: "setSpread", pile, spread }        stacked, or spread out in a row
// { type: "gather", id, x, y, rot }          every card into one face-down stack
// { type: "setSeats", n }                    hands of removed seats go to the middle

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

function raise(s, pileId) { s.piles[pileId].z = s.nextZ++; }

const ACTIONS = {
  moveCards(s, { cards, to }) {
    // a hand index counts positions before any of the moved cards leave the hand
    let index = to.hand ? to.index ?? s.hands[to.hand].length : 0;
    for (const id of cards) {
      const from = take(s, id);
      if (to.hand && from.hand === to.hand && from.index < index) index--;
      // a card leaving someone's hand, or landing in one, stops being looked at
      s.cards[id].privateTo = null;
    }
    if (to.hand) {
      for (const id of cards) s.cards[id].faceUp = false;
      s.hands[to.hand].splice(Math.max(0, Math.min(index, s.hands[to.hand].length)), 0, ...cards);
    } else if (to.pile) {
      if (!s.piles[to.pile]) throw new Error(`no pile ${to.pile}`);
      s.piles[to.pile].cards.push(...cards);
      raise(s, to.pile);
    } else if (to.newPile) {
      const { id, x, y, rot = 0 } = to.newPile;
      if (s.piles[id]) throw new Error(`pile ${id} exists`);
      s.piles[id] = { id, x, y, rot, z: 0, spread: false, cards: [...cards] };
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
  setSpread(s, { pile, spread }) { s.piles[pile].spread = spread; raise(s, pile); },
  gather(s, { id, x, y, rot = 0 }) {
    const all = [...Object.values(s.piles).sort((a, b) => a.z - b.z).flatMap((p) => p.cards),
      ...Object.values(s.hands).flat()];
    s.piles = {};
    for (const seat of Object.keys(s.hands)) s.hands[seat] = [];
    for (const c of Object.values(s.cards)) { c.faceUp = false; c.privateTo = null; }
    s.piles[id] = { id, x, y, rot, z: 0, spread: false, cards: all };
    raise(s, id);
  },
  setSeats(s, { n }) {
    n = Math.max(2, Math.min(MAX_SEATS, n));
    const seats = makeSeats(n);
    // keep names of seats that stay
    for (let i = 0; i < Math.min(n, s.seats.length); i++) seats[i].name = s.seats[i].name;
    const leftover = s.seats.slice(n).flatMap((seat) => s.hands[seat.id]);
    const hands = Object.fromEntries(seats.map((seat) => [seat.id, s.hands[seat.id] ?? []]));
    const keep = new Set(seats.map((seat) => seat.id));
    for (const c of Object.values(s.cards)) if (c.privateTo && !keep.has(c.privateTo)) c.privateTo = null;
    s.seats = seats; s.hands = hands;
    if (leftover.length) {
      for (const id of leftover) s.cards[id].faceUp = false;
      const id = `returned${s.nextZ}`;
      s.piles[id] = { id, x: TABLE_R, y: TABLE_R, rot: 0, z: 0, spread: false, cards: leftover };
      raise(s, id);
    }
  },
};

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
