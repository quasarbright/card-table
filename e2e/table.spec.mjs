// Real mouse and keyboard input on the table, checked against the table state.
import { test, expect } from "@playwright/test";
import { serveFromCache } from "./helpers.mjs";

async function open(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/net::ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.route((url) => url.hostname !== "localhost", serveFromCache);
  await page.goto("/index.html");
  await page.waitForFunction(() => !!window.cardTable);
  await page.evaluate(() => window.cardTable.reset(4));
  await settle(page);
  return errors;
}
// long enough for the cards' springs to come to rest
const settle = (page) => page.waitForTimeout(650);
const state = (page) => page.evaluate(() => window.cardTable.state);
const topOf = async (page, pile) => (await state(page)).piles[pile].cards.at(-1);

async function center(page, sel) {
  const b = await page.locator(sel).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
const cardSel = (id) => `.ct-card[data-id="${id}"]`;
async function dragTo(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  // let the last move land before letting go (Firefox under load can lag a frame)
  await page.waitForTimeout(80);
  await page.mouse.up();
  await settle(page);
}
// a point on the table, in screen coordinates
const at = (page, x, y) => page.evaluate(([x, y]) => window.cardTable.view.toScreen(x, y), [x, y]);
const showsFace = (page, id) => page.locator(`${cardSel(id)} .ct-index`).count().then((n) => n > 0);

test("drag the top card off the deck, then click it and pick Flip", async ({ page }) => {
  const errors = await open(page);
  const top = await topOf(page, "deck");
  await dragTo(page, await center(page, cardSel(top)), await at(page, 300, 350));
  let s = await state(page);
  expect(s.piles.deck.cards.length).toBe(51);
  const pile = Object.values(s.piles).find((p) => p.cards.includes(top));
  expect(pile.id).not.toBe("deck");
  expect(Math.hypot(pile.x - 300, pile.y - 350)).toBeLessThan(15);
  expect(await showsFace(page, top)).toBe(false);
  // a drag doesn't leave a menu behind
  await expect(page.locator(".ct-menu")).toHaveCount(0);

  const c = await center(page, cardSel(top));
  await page.mouse.click(c.x, c.y);
  await page.getByRole("button", { name: /^Flip/ }).click();
  await settle(page);
  expect((await state(page)).cards[top].faceUp).toBe(true);
  expect(await showsFace(page, top)).toBe(true);

  // and back onto the deck
  await dragTo(page, await center(page, cardSel(top)), await center(page, ".ct-grip"));
  s = await state(page);
  expect(s.piles.deck.cards.at(-1)).toBe(top);
  expect(Object.keys(s.piles)).toEqual(["deck"]);
  expect(errors).toEqual([]);
});

test("a card dragged into your hand shows you its face and others its back", async ({ page }) => {
  const errors = await open(page);
  const top = await topOf(page, "deck");
  await dragTo(page, await center(page, cardSel(top)), await at(page, 500, 870));
  expect((await state(page)).hands.s0).toEqual([top]);
  expect(await showsFace(page, top)).toBe(true);
  await page.click('#viewer [data-seat="s1"]');
  await page.waitForTimeout(700);
  expect(await showsFace(page, top)).toBe(false);
  // pass it to Player 3's hand, as Player 2
  const p3 = await page.evaluate(() => { const v = window.cardTable.view; return v.toScreen(500, 500 - 378); });
  await dragTo(page, await center(page, cardSel(top)), p3);
  expect((await state(page)).hands.s2).toEqual([top]);
  expect(errors).toEqual([]);
});

test("reorder your hand by dragging a card along it", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.cardTable.dispatch({ type: "deal", pile: "deck", count: 4, seats: ["s0"] }));
  await settle(page);
  const before = (await state(page)).hands.s0;
  // the first card is mostly covered by the next one: press its uncovered left edge, up high
  // where the tilt makes the card widest
  const b = await page.locator(cardSel(before[0])).boundingBox();
  const press = { x: b.x + 12, y: b.y + b.height * 0.3 };
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".ct-card")?.dataset.id, [press.x, press.y])).toBe(before[0]);
  const last = await center(page, cardSel(before[3]));
  await dragTo(page, press, { x: last.x + 30, y: last.y });
  const after = (await state(page)).hands.s0;
  expect(after).toEqual([before[1], before[2], before[3], before[0]]);
});

test("deal from the menu: right-click the stack's count, Deal…, one more, Deal", async ({ page }) => {
  const errors = await open(page);
  const g = await center(page, ".ct-grip");
  await page.mouse.click(g.x, g.y, { button: "right" });
  await page.getByRole("button", { name: /Deal…/ }).click();
  await expect(page.locator(".ct-count")).toHaveText("5");
  await page.locator('.ct-step[data-d="1"]').click();
  await page.locator(".ct-menu [data-deal]").click();
  await page.waitForTimeout(6 * 4 * 70 + 600);
  const s = await state(page);
  for (const seat of ["s0", "s1", "s2", "s3"]) expect(s.hands[seat].length).toBe(6);
  expect(s.piles.deck.cards.length).toBe(52 - 24);
  // the first card goes to the player after you
  expect(s.hands.s1[0]).toBe("AS");
  expect(errors).toEqual([]);
});

test("keys act on what's under the pointer: S shuffles, P looks, F flips", async ({ page }) => {
  await open(page);
  const before = (await state(page)).piles.deck.cards.join();
  const top = await topOf(page, "deck");
  const c = await center(page, cardSel(top));
  await page.mouse.move(c.x, c.y);
  await page.mouse.move(c.x + 1, c.y);
  await page.keyboard.press("s");
  await settle(page);
  expect((await state(page)).piles.deck.cards.join()).not.toBe(before);

  const newTop = await topOf(page, "deck");
  await page.mouse.move(c.x, c.y + 1);
  await page.keyboard.press("p");
  await settle(page);
  expect((await state(page)).cards[newTop].privateTo).toBe("s0");
  expect(await showsFace(page, newTop)).toBe(true);
  await expect(page.locator(cardSel(newTop))).toHaveClass(/ct-ringed/);
  await page.click('#viewer [data-seat="s1"]');
  await page.waitForTimeout(700);
  expect(await showsFace(page, newTop)).toBe(false);
  await page.click('#viewer [data-seat="s0"]');
  await page.waitForTimeout(700);

  // on a stack, ⇧F turns just the top card
  const c2 = await center(page, cardSel(newTop));
  await page.mouse.move(c2.x, c2.y);
  await page.mouse.move(c2.x + 1, c2.y);
  await page.keyboard.press("Shift+F");
  await settle(page);
  const s = await state(page);
  expect(s.cards[newTop].faceUp).toBe(true);
  expect(s.cards[newTop].privateTo).toBe(null);
  expect(s.cards[s.piles.deck.cards[0]].faceUp).toBe(false);
});

test("F over a stack turns the whole stack, again on every press", async ({ page }) => {
  const errors = await open(page);
  const bottom = (await state(page)).piles.deck.cards[0];
  const c = await center(page, cardSel(await topOf(page, "deck")));
  await page.mouse.move(c.x, c.y);
  await page.mouse.move(c.x + 1, c.y);
  await page.keyboard.press("f");
  await page.waitForTimeout(150);
  // mid-turn the old top is still on top: the reorder waits for the edge-on moment
  await expect(page.locator(".ct-stackturn")).not.toHaveCount(0);
  await settle(page);
  let s = await state(page);
  expect(s.piles.deck.cards.at(-1)).toBe(bottom);
  expect(s.piles.deck.cards.every((id) => s.cards[id].faceUp)).toBe(true);
  // a turned-over stack lands squared up: every card at the stack's own angle
  const rots = await page.evaluate(() => {
    const st = window.cardTable.state, place = window.cardTable.view.placement(st);
    return st.piles.deck.cards.slice(-6).map((id) => place.get(id).rot - st.piles.deck.rot);
  });
  for (const r of rots) expect(r).toBeCloseTo(0, 5);
  // without moving the mouse: twice more
  await page.keyboard.press("f");
  await settle(page);
  await page.keyboard.press("f");
  await settle(page);
  s = await state(page);
  expect(s.piles.deck.cards.at(-1)).toBe(bottom);
  expect(s.cards[bottom].faceUp).toBe(true);
  expect(errors).toEqual([]);
});

test("click opens the actions, a second click closes them", async ({ page }) => {
  await open(page);
  const c = await center(page, cardSel(await topOf(page, "deck")));
  await page.mouse.click(c.x, c.y);
  await expect(page.getByRole("button", { name: /Flip stack/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Flip top card/ })).toBeVisible();
  await page.mouse.click(c.x, c.y);
  await expect(page.locator(".ct-menu")).toHaveCount(0);
  // the count tab too
  const g = await center(page, ".ct-grip");
  await page.mouse.click(g.x, g.y);
  await expect(page.getByRole("button", { name: /Shuffle/ })).toBeVisible();
});

test("dragging the count moves the whole stack", async ({ page }) => {
  await open(page);
  await dragTo(page, await center(page, ".ct-grip"), await at(page, 650, 400));
  const s = await state(page);
  expect(s.piles.deck.cards.length).toBe(52);
  expect(Math.hypot(s.piles.deck.x - 650, s.piles.deck.y - 400)).toBeLessThan(80);
});

test("the table survives a reload; gather brings everything back", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.cardTable.deal("deck", 3));
  await page.reload();
  await page.waitForFunction(() => !!window.cardTable);
  expect((await state(page)).hands.s1.length).toBe(3);
  await page.click("#gather");
  const s = await state(page);
  expect(Object.values(s.piles)).toHaveLength(1);
  expect(Object.values(s.piles)[0].cards).toHaveLength(52);
});

test("fewer players: removed hands go back to the middle", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.cardTable.deal("deck", 2));
  await page.click('#players [data-n="2"]');
  await settle(page);
  const s = await state(page);
  expect(s.seats).toHaveLength(2);
  expect(await page.locator(".ct-plate").count()).toBe(2);
  expect(Object.values(s.piles).reduce((n, p) => n + p.cards.length, 0)).toBe(52 - 4);
});

test("the about modal draws the same table from two seats", async ({ page }) => {
  const errors = await open(page);
  await page.getByRole("button", { name: "about" }).click();
  const minis = page.locator(".cohesion-about .ct-mini");
  await expect(minis).toHaveCount(2);
  await page.waitForTimeout(2600);
  expect(await minis.nth(0).locator(".ct-card").count()).toBe(52);
  // Player 1 sees their own hand's faces; Player 2 sees theirs
  const faces = await page.evaluate(() => [...document.querySelectorAll(".cohesion-about .ct-mini")].map((m) => m.querySelectorAll(".ct-index").length));
  expect(faces[0]).toBeGreaterThan(0);
  expect(faces[1]).toBeGreaterThan(0);
  await expect(page.locator("#ct-about-caption")).not.toHaveText("");
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("deal the whole stack from the menu", async ({ page }) => {
  await open(page);
  const g = await center(page, ".ct-grip");
  await page.mouse.click(g.x, g.y);
  await page.getByRole("button", { name: /Deal…/ }).click();
  await page.getByRole("button", { name: "Deal all 52" }).click();
  await page.waitForTimeout(52 * 70 + 600);
  const s = await state(page);
  expect(s.piles.deck).toBeUndefined();
  expect(Object.values(s.hands).map((h) => h.length)).toEqual([13, 13, 13, 13]);
});

test("split a stack into three", async ({ page }) => {
  await open(page);
  const g = await center(page, ".ct-grip");
  await page.mouse.click(g.x, g.y);
  await page.getByRole("button", { name: /Split…/ }).click();
  await page.locator('.ct-step[data-d="1"]').click();
  await page.getByRole("button", { name: "Split into 3" }).click();
  await settle(page);
  const piles = Object.values((await state(page)).piles);
  expect(piles.map((p) => p.cards.length).sort()).toEqual([17, 17, 18]);
  expect(await page.locator(".ct-grip").count()).toBe(3);
});

test("press and hold a stack, then drag: the whole stack moves", async ({ page }) => {
  await open(page);
  const c = await center(page, cardSel(await topOf(page, "deck")));
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.waitForTimeout(450);
  const to = await at(page, 650, 420);
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await settle(page);
  const s = await state(page);
  expect(s.piles.deck.cards).toHaveLength(52);
  expect(Math.hypot(s.piles.deck.x - 650, s.piles.deck.y - 420)).toBeLessThan(20);
});

test("F while dragging flips what you carry", async ({ page }) => {
  await open(page);
  const top = await topOf(page, "deck");
  const c = await center(page, cardSel(top));
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 40, c.y - 60, { steps: 4 });
  await page.keyboard.press("f");
  await page.waitForTimeout(150);
  expect(await showsFace(page, top)).toBe(true);
  const to = await at(page, 330, 380);
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await settle(page);
  const s = await state(page);
  expect(s.cards[top].faceUp).toBe(true);
  expect(s.piles.deck.cards).toHaveLength(51);
  // a held stack too
  const g = await center(page, cardSel(await topOf(page, "deck")));
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await page.waitForTimeout(450);
  await page.keyboard.press("f");
  await page.mouse.up();
  await settle(page);
  const after = await state(page);
  expect(after.piles.deck.cards.every((id) => after.cards[id].faceUp)).toBe(true);
});

test("carrying a card over your hand opens a gap where it will land", async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(() => window.cardTable.dispatch({ type: "deal", pile: "deck", count: 5, seats: ["s0"] }));
  await settle(page);
  const hand = (await state(page)).hands.s0;
  const xOf = (id) => page.locator(cardSel(id)).boundingBox().then((b) => b.x);
  const before = await Promise.all(hand.map(xOf));
  const top = await topOf(page, "deck");
  await page.mouse.move(...Object.values(await center(page, cardSel(top))));
  await page.mouse.down();
  // over the middle card's visible strip
  const mid = await page.locator(cardSel(hand[2])).boundingBox();
  await page.mouse.move(mid.x + 12, mid.y + mid.height * 0.4, { steps: 10 });
  await page.waitForTimeout(500);
  await expect(page.locator(".ct-slot.ct-on")).toHaveCount(1);
  const during = await Promise.all(hand.map(xOf));
  // cards left of the gap step left, cards right of it step right
  expect(during[0]).toBeLessThan(before[0]);
  expect(during[4]).toBeGreaterThan(before[4]);
  await page.mouse.up();
  await settle(page);
  expect((await state(page)).hands.s0.indexOf(top)).toBe(2);
  await expect(page.locator(".ct-slot.ct-on")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the card under the pointer lifts", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.cardTable.dispatch({ type: "deal", pile: "deck", count: 4, seats: ["s0"] }));
  await settle(page);
  const id = (await state(page)).hands.s0[1];
  const b = await page.locator(cardSel(id)).boundingBox();
  await page.mouse.move(b.x + 12, b.y + b.height * 0.4);
  await page.waitForTimeout(400);
  await expect(page.locator(cardSel(id))).toHaveClass(/ct-hover/);
  const lifted = await page.locator(`${cardSel(id)} .ct-inner`).evaluate((e) => parseFloat(e.style.translate.split(" ")[1]));
  expect(lifted).toBeLessThan(-5);
});

test("undo and redo, from the button and the keyboard", async ({ page }) => {
  await open(page);
  await expect(page.locator("#undo")).toBeDisabled();
  const top = await topOf(page, "deck");
  await dragTo(page, await center(page, cardSel(top)), await at(page, 330, 380));
  expect((await state(page)).piles.deck.cards).toHaveLength(51);
  await page.click("#undo");
  await settle(page);
  expect((await state(page)).piles.deck.cards).toHaveLength(52);
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  expect((await state(page)).piles.deck.cards).toHaveLength(51);
  await page.keyboard.press("ControlOrMeta+Z");
  expect((await state(page)).piles.deck.cards).toHaveLength(52);
});

test("Show hand lays your hand flat for everyone, and it stays your hand", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.cardTable.dispatch({ type: "deal", pile: "deck", count: 4, seats: ["s0"] }));
  await settle(page);
  const hand = (await state(page)).hands.s0;
  const bar = page.locator(".ct-handbar");
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Show hand" }).click();
  await settle(page);
  expect((await state(page)).hands.s0).toEqual(hand);
  await page.click('#viewer [data-seat="s1"]');
  await page.waitForTimeout(700);
  for (const id of hand) expect(await showsFace(page, id)).toBe(true);
  await page.click('#viewer [data-seat="s0"]');
  await bar.getByRole("button", { name: "Hide hand" }).click();
  await page.click('#viewer [data-seat="s1"]');
  await page.waitForTimeout(700);
  for (const id of hand) expect(await showsFace(page, id)).toBe(false);
  await page.click('#viewer [data-seat="s0"]');
  await page.click("#undo");
  expect((await state(page)).shownHands.s0).toBe(true);
});

test("carried over another hand a card is hidden until flipped for them; dropping gives it", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.cardTable.dispatch({ type: "deal", pile: "deck", count: 2, seats: ["s0"] }));
  await settle(page);
  const id = (await state(page)).hands.s0.at(-1);
  await page.mouse.move(...Object.values(await center(page, cardSel(id))));
  await page.mouse.down();
  // over Player 2's hand (to your left)
  const p2 = await page.evaluate(() => window.cardTable.view.toScreen(500 - 378, 500));
  await page.mouse.move(p2.x, p2.y, { steps: 12 });
  await page.waitForTimeout(300);
  expect(await showsFace(page, id)).toBe(false);
  await expect(page.locator(".ct-eye:not(.ct-eye-open):not(.ct-zone-eye)")).toHaveCount(1);
  await page.keyboard.press("f");
  await expect(page.locator(".ct-eye.ct-eye-them:not(.ct-zone-eye)")).toHaveCount(1);
  await page.keyboard.press("f");
  await expect(page.locator(".ct-eye.ct-eye-them:not(.ct-zone-eye)")).toHaveCount(0);
  await page.mouse.up();
  await settle(page);
  expect((await state(page)).hands.s1).toEqual([id]);
});

test("a card carried out of your hand goes down face up, or face down if flipped on the way", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.cardTable.dispatch({ type: "deal", pile: "deck", count: 3, seats: ["s0"] }));
  await settle(page);
  const [a, , c] = (await state(page)).hands.s0;
  const last = await center(page, cardSel(c));
  await dragTo(page, last, await at(page, 330, 380));
  expect((await state(page)).cards[c].faceUp).toBe(true);
  // the first card's uncovered strip; flip it while carrying
  const b = await page.locator(cardSel(a)).boundingBox();
  await page.mouse.move(b.x + 10, b.y + b.height * 0.35);
  await page.mouse.down();
  const to = await at(page, 650, 380);
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await expect(page.locator(".ct-eye.ct-eye-open:not(.ct-zone-eye)")).toHaveCount(1);
  await page.keyboard.press("f");
  await expect(page.locator(".ct-eye:not(.ct-eye-open):not(.ct-zone-eye)")).toHaveCount(1);
  await page.mouse.up();
  await settle(page);
  const s = await state(page);
  expect(s.cards[a].faceUp).toBe(false);
  expect(s.hands.s0).toHaveLength(1);
});

test("Show top few heaps a stack loosely; Straighten stack squares it", async ({ page }) => {
  await open(page);
  const g = await center(page, ".ct-grip");
  await page.mouse.click(g.x, g.y);
  await page.getByRole("button", { name: "Show top few" }).click();
  expect((await state(page)).piles.deck.messy).toBe(true);
  await page.mouse.click(g.x, g.y);
  await page.getByRole("button", { name: "Straighten stack" }).click();
  expect((await state(page)).piles.deck.messy).toBe(false);
});

test("peeking puts a struck-through eye on the card", async ({ page }) => {
  await open(page);
  const c = await center(page, cardSel(await topOf(page, "deck")));
  await page.mouse.click(c.x, c.y);
  await page.getByRole("button", { name: "Peek top card" }).click();
  await expect(page.locator(".ct-eye:not(.ct-eye-open):not(.ct-zone-eye)")).toHaveCount(1);
  await page.mouse.click(c.x, c.y);
  await page.getByRole("button", { name: "Stop peeking" }).click();
  await expect(page.locator(".ct-eye:not(.ct-zone-eye)")).toHaveCount(0);
});
