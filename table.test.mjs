import test from "node:test";
import assert from "node:assert/strict";
import { newTable, apply, locate, canSee, tiltedToward, shuffledOrder, checkConservation, CX, CY } from "./table.mjs";

const run = (state, ...actions) => actions.reduce((s, a) => {
  const next = apply(s, a);
  assert.ok(checkConservation(next), `cards lost or doubled after ${a.type}`);
  return next;
}, state);

const top = (s, pile) => s.piles[pile].cards.at(-1);

test("a new table is one face-down deck, A♠ on top", () => {
  const s = newTable(4);
  assert.equal(s.seats.length, 4);
  assert.equal(s.piles.deck.cards.length, 52);
  assert.equal(top(s, "deck"), "AS");
  assert.ok(checkConservation(s));
  assert.equal(canSee(s, "AS", "s0"), false);
});

test("apply does not change the state it was given", () => {
  const s = newTable();
  apply(s, { type: "flip", cards: ["AS"] });
  assert.equal(s.cards.AS.faceUp, false);
});

test("taking the top card makes a new pile; moving the last card away removes it", () => {
  let s = run(newTable(), { type: "moveCards", cards: ["AS"], to: { newPile: { id: "p1", x: 100, y: 100 } } });
  assert.deepEqual(s.piles.p1.cards, ["AS"]);
  assert.equal(top(s, "deck"), "2S");
  s = run(s, { type: "moveCards", cards: ["AS"], to: { pile: "deck" } });
  assert.equal(s.piles.p1, undefined);
  assert.equal(top(s, "deck"), "AS");
});

test("a pile dropped on another goes on top, in order", () => {
  let s = run(newTable(),
    { type: "moveCards", cards: ["AS"], to: { newPile: { id: "a", x: 0, y: 0 } } },
    { type: "moveCards", cards: ["2S"], to: { pile: "a" } },
    { type: "moveCards", cards: ["3S"], to: { newPile: { id: "b", x: 0, y: 0 } } });
  s = run(s, { type: "moveCards", cards: [...s.piles.a.cards], to: { pile: "b" } });
  assert.deepEqual(s.piles.b.cards, ["3S", "AS", "2S"]);
});

test("hands: only the owner sees, and the card tilts toward them", () => {
  const s = run(newTable(), { type: "moveCards", cards: ["AS"], to: { hand: "s1", index: 0 } });
  assert.deepEqual(locate(s, "AS"), { hand: "s1", index: 0 });
  assert.equal(canSee(s, "AS", "s1"), true);
  assert.equal(canSee(s, "AS", "s0"), false);
  assert.equal(tiltedToward(s, "AS"), "s1");
  // shown: everyone sees it, no tilt
  const shown = run(s, { type: "flip", cards: ["AS"] });
  assert.equal(canSee(shown, "AS", "s0"), true);
  assert.equal(tiltedToward(shown, "AS"), null);
});

test("reordering a hand counts the index before the card leaves", () => {
  let s = run(newTable(), { type: "deal", pile: "deck", count: 3, seats: ["s0"] });
  assert.deepEqual(s.hands.s0, ["AS", "2S", "3S"]);
  s = run(s, { type: "moveCards", cards: ["AS"], to: { hand: "s0", index: 3 } });
  assert.deepEqual(s.hands.s0, ["2S", "3S", "AS"]);
  s = run(s, { type: "moveCards", cards: ["AS"], to: { hand: "s0", index: 0 } });
  assert.deepEqual(s.hands.s0, ["AS", "2S", "3S"]);
  s = run(s, { type: "moveCards", cards: ["AS"], to: { hand: "s0", index: 2 } });
  assert.deepEqual(s.hands.s0, ["2S", "AS", "3S"]);
});

test("looking at a face-down card: only that seat sees it; a flip or a move ends it", () => {
  let s = run(newTable(), { type: "setPrivate", cards: ["AS"], seat: "s2" });
  assert.equal(canSee(s, "AS", "s2"), true);
  assert.equal(canSee(s, "AS", "s0"), false);
  assert.equal(tiltedToward(s, "AS"), "s2");
  assert.equal(run(s, { type: "flip", cards: ["AS"] }).cards.AS.privateTo, null);
  assert.equal(run(s, { type: "moveCards", cards: ["AS"], to: { newPile: { id: "x", x: 0, y: 0 } } }).cards.AS.privateTo, null);
  // face-up cards can't be private
  s = run(newTable(), { type: "flip", cards: ["AS"] }, { type: "setPrivate", cards: ["AS"], seat: "s0" });
  assert.equal(s.cards.AS.privateTo, null);
});

test("flipping a stack reverses it and turns every card", () => {
  const s = run(newTable(), { type: "flipPile", pile: "deck" });
  assert.equal(top(s, "deck"), "KC");
  assert.ok(Object.values(s.cards).every((c) => c.faceUp));
});

test("shuffle uses the order in the action, and rejects a different set of cards", () => {
  const s0 = newTable();
  const order = shuffledOrder(s0.piles.deck.cards, mulberry(7));
  const s = run(s0, { type: "shuffle", pile: "deck", order });
  assert.deepEqual(s.piles.deck.cards, order);
  assert.throws(() => apply(s0, { type: "shuffle", pile: "deck", order: order.slice(1) }));
});

test("deal goes round the seats one card at a time, and stops when the pile runs out", () => {
  let s = run(newTable(), { type: "deal", pile: "deck", count: 2, seats: ["s1", "s2"] });
  assert.deepEqual(s.hands.s1, ["AS", "3S"]);
  assert.deepEqual(s.hands.s2, ["2S", "4S"]);
  s = run(newTable(2), { type: "deal", pile: "deck", count: 30, seats: ["s0", "s1"] });
  assert.equal(s.hands.s0.length, 26);
  assert.equal(s.hands.s1.length, 26);
  assert.equal(s.piles.deck, undefined);
});

test("gather brings every card back face down", () => {
  let s = run(newTable(),
    { type: "deal", pile: "deck", count: 5, seats: ["s0", "s1"] },
    { type: "flip", cards: ["KC"] },
    { type: "moveCards", cards: ["KC"], to: { newPile: { id: "k", x: 10, y: 10 } } });
  s = run(s, { type: "gather", id: "g", x: CX, y: CY });
  assert.equal(s.piles.g.cards.length, 52);
  assert.ok(Object.values(s.cards).every((c) => !c.faceUp));
  assert.ok(Object.values(s.hands).every((h) => h.length === 0));
});

test("removing seats returns their hands to the middle", () => {
  let s = run(newTable(4), { type: "deal", pile: "deck", count: 3, seats: ["s0", "s1", "s2", "s3"] },
    { type: "setPrivate", cards: [top(newTable(), "deck")], seat: "s3" });
  s = run(s, { type: "setSeats", n: 2 });
  assert.equal(s.seats.length, 2);
  assert.deepEqual(Object.keys(s.hands), ["s0", "s1"]);
  const returned = Object.values(s.piles).find((p) => p.id.startsWith("returned"));
  assert.equal(returned.cards.length, 6);
  assert.ok(Object.values(s.cards).every((c) => c.privateTo !== "s3"));
});

function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test("split cuts a stack into even parts, bottom cards staying with the original id", () => {
  const s0 = newTable(4);
  const deck = s0.piles.deck.cards;
  const s = apply(s0, { type: "split", pile: "deck", parts: [
    { id: "deck", x: 400, y: 500 }, { id: "b", x: 500, y: 500 }, { id: "c", x: 600, y: 500 }] });
  assert.deepEqual([s.piles.deck, s.piles.b, s.piles.c].map((p) => p.cards.length), [17, 18, 17]);
  assert.deepEqual([...s.piles.deck.cards, ...s.piles.b.cards, ...s.piles.c.cards], deck);
  assert.equal(s.piles.deck.x, 400);
  checkConservation(s);
  assert.throws(() => apply(s0, { type: "split", pile: "deck", parts: [{ id: "x", x: 0, y: 0 }, { id: "y", x: 0, y: 0 }] }));
});

test("dealing a whole stack: the pile is used up and the counts differ by at most one", () => {
  const s = apply(newTable(5), { type: "deal", pile: "deck", count: Math.ceil(52 / 5), seats: ["s0", "s1", "s2", "s3", "s4"] });
  assert.equal(s.piles.deck, undefined);
  assert.deepEqual(Object.values(s.hands).map((h) => h.length), [11, 11, 10, 10, 10]);
});

test("batch applies its actions in order; flipping a stack keeps how it lies", () => {
  let s = apply(newTable(2), { type: "setLook", pile: "deck", look: "spread" });
  assert.equal(s.piles.deck.look, "spread");
  s = apply(s, { type: "batch", actions: [
    { type: "moveCards", cards: ["AS"], to: { newPile: { id: "a", x: 400, y: 500 } } },
    { type: "flip", cards: ["AS"] },
    { type: "flipPile", pile: "deck" },
  ] });
  assert.equal(s.cards.AS.faceUp, true);
  assert.equal(s.piles.deck.look, "spread");
  checkConservation(s);
});

test("a shown hand is still its owner's, but everyone sees it and it lies flat", () => {
  let s = apply(newTable(3), { type: "deal", pile: "deck", count: 2, seats: ["s0"] });
  const id = s.hands.s0[0];
  assert.equal(canSee(s, id, "s1"), false);
  s = apply(s, { type: "setHandShown", seat: "s0", shown: true });
  assert.equal(canSee(s, id, "s1"), true);
  assert.equal(tiltedToward(s, id), null);
  assert.equal(locate(s, id).hand, "s0");
  s = apply(s, { type: "setHandShown", seat: "s0", shown: false });
  assert.equal(canSee(s, id, "s1"), false);
  assert.equal(tiltedToward(s, id), "s0");
});

test("sit puts a player in one seat; fewer seats keep the players that stay", () => {
  let s = apply(newTable(3), { type: "sit", seat: "s1", player: "abc", name: "Ann" });
  s = apply(s, { type: "sit", seat: "s2", player: "abc", name: "Ann" });
  assert.deepEqual(s.seats.map((x) => x.player), [null, null, "abc"]);
  s = apply(s, { type: "sit", seat: "s0", player: "me", name: "Mo" });
  s = apply(s, { type: "setSeats", n: 4 });
  assert.equal(s.seats[0].name, "Mo");
  assert.equal(s.seats[2].player, "abc");
  assert.equal(s.seats[3].player, null);
});

test("colors: a seat can take any color nobody else has; new seats get a free one", () => {
  let s = apply(newTable(2), { type: "sit", seat: "s0", player: "me", name: "Mo", color: "#a3d977" });
  assert.equal(s.seats[0].color, "#a3d977");
  s = apply(s, { type: "sit", seat: "s1", player: "you", name: "Ann", color: "#a3d977" }); // taken: keeps its own
  assert.equal(s.seats[1].color, "#6cb8f0");
  assert.throws(() => apply(s, { type: "setPlayer", seat: "s1", color: "#a3d977" }));
  s = apply(s, { type: "setPlayer", seat: "s1", name: "Annie", color: "#f0b84a" });
  assert.equal(s.seats[1].name, "Annie");
  s = apply(s, { type: "setSeats", n: 3 });
  assert.equal(new Set(s.seats.map((x) => x.color)).size, 3);
  // an empty seat's color is free to take: the empty seat gets yours
  const open = s.seats[2].color;
  s = apply(s, { type: "setPlayer", seat: "s1", color: open });
  assert.equal(s.seats[1].color, open);
  assert.equal(s.seats[2].color, "#f0b84a");
});

test("a card can go into the middle of a stack, counted before it leaves", () => {
  let s = newTable(2);
  const [a, b, c] = s.piles.deck.cards.slice(-3);
  s = apply(s, { type: "moveCards", cards: [c, b, a], to: { newPile: { id: "row", x: 300, y: 300 } } });
  const d = s.piles.deck.cards.at(-1);
  s = apply(s, { type: "moveCards", cards: [d], to: { pile: "row", index: 1 } });
  assert.deepEqual(s.piles.row.cards, [c, d, b, a]);
  // within the same stack: the top card to the bottom
  s = apply(s, { type: "moveCards", cards: [a], to: { pile: "row", index: 0 } });
  assert.deepEqual(s.piles.row.cards, [a, c, d, b]);
  s = apply(s, { type: "moveCards", cards: [c], to: { pile: "row", index: 4 } });
  assert.deepEqual(s.piles.row.cards, [a, d, b, c]);
  checkConservation(s);
});
