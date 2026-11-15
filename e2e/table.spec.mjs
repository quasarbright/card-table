// Real mouse and keyboard input on the table, checked against the table state.
import { test, expect } from "@playwright/test";
import { serveFromCache } from "./helpers.mjs";
import { CX, CY, clampToFelt } from "../table.mjs";

async function open(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/net::ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.route((url) => url.hostname !== "localhost", serveFromCache);
  await host(page);
  await page.evaluate(() => window.cardTable.reset(4));
  await settle(page);
  return errors;
}
// long enough for the cards' springs to come to rest
// host a table through the opening screen (tabs talk over a BroadcastChannel: ?net=local)
async function host(page, name = "Mike") {
  await page.goto("/index.html?net=local");
  await page.fill("#ct-name", name);
  await page.getByRole("button", { name: "Open a table" }).click();
  await page.waitForFunction(() => !!window.cardTable?.session);
}
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
// the middle of a seat's hand area, on screen
const handAt = (page, i) => center(page, `.ct-zone >> nth=${i}`);
const showsFace = (page, id) => page.locator(`${cardSel(id)} .ct-index`).count().then((n) => n > 0);

test("every badge's icon sits in its middle", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.cardTable.dispatch({ type: "deal", pile: "deck", count: 3, seats: ["s0", "s1"] }));
  await settle(page);
  // a peeked card gets an eye too
  const c = await center(page, cardSel(await topOf(page, "deck")));
  await page.mouse.move(c.x, c.y); await page.keyboard.press("p");
  await settle(page);
  const off = await page.evaluate(() => [...document.querySelectorAll(".ct-lock, .ct-eye, .ct-plate-edit")].map((e) => {
    const a = e.getBoundingClientRect(), s = e.querySelector("svg").getBoundingClientRect();
    return { cls: e.className, dx: (s.x + s.width / 2) - (a.x + a.width / 2), dy: (s.y + s.height / 2) - (a.y + a.height / 2) };
  }));
  expect(off.length).toBeGreaterThan(4);
  for (const o of off) {
    expect(Math.abs(o.dx), o.cls).toBeLessThan(0.5);
    expect(Math.abs(o.dy), o.cls).toBeLessThan(0.5);
  }
});

test("drag the top card off the deck, then click it and pick Flip", async ({ page }) => {
  const errors = await open(page);
  const top = await topOf(page, "deck");
  await dragTo(page, await center(page, cardSel(top)), await at(page, CX - 200, CY - 90));
  let s = await state(page);
  expect(s.piles.deck.cards.length).toBe(51);
  const pile = Object.values(s.piles).find((p) => p.cards.includes(top));
  expect(pile.id).not.toBe("deck");
  expect(Math.hypot(pile.x - (CX - 200), pile.y - (CY - 90))).toBeLessThan(15);
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

test("a card or stack dropped off the felt comes back onto it", async ({ page }) => {
  const errors = await open(page);
  // a card, dropped in the corner of the screen: it lands in the felt's corner
  const top = await topOf(page, "deck");
  const vp = page.viewportSize();
  await dragTo(page, await center(page, cardSel(top)), { x: vp.width - 10, y: 10 });
  let s = await state(page);
  const pile = Object.values(s.piles).find((p) => p.cards.includes(top));
  const on = clampToFelt(pile.x, pile.y);
  expect(Math.hypot(on.x - pile.x, on.y - pile.y)).toBeLessThan(0.5);
  expect(pile.x).toBeGreaterThan(CX + 300); expect(pile.y).toBeLessThan(CY - 150);
  // the whole deck, spread out, dropped off the bottom left: the whole row comes back on
  await page.evaluate(() => window.cardTable.dispatch({ type: "setLook", pile: "deck", look: "spread" }));
  await settle(page);
  await page.mouse.move(...Object.values(await center(page, ".ct-grip")));
  await page.mouse.down(); await page.waitForTimeout(400);
  await page.mouse.move(5, vp.height - 5, { steps: 8 }); await page.waitForTimeout(80); await page.mouse.up();
  await settle(page);
  s = await state(page);
  const d = s.piles.deck, len = 600;
  for (const t of [0, len]) {
    const x = d.x + Math.cos(d.rot) * t, y = d.y + Math.sin(d.rot) * t, c = clampToFelt(x, y, 49);
    expect(Math.hypot(c.x - x, c.y - y)).toBeLessThan(1);
  }
  expect(errors).toEqual([]);
});

test("a card dragged into your hand shows you its face and others its back", async ({ page }) => {
  const errors = await open(page);
  const top = await topOf(page, "deck");
  await dragTo(page, await center(page, cardSel(top)), await handAt(page, 0));
  expect((await state(page)).hands.s0).toEqual([top]);
  expect(await showsFace(page, top)).toBe(true);
  await page.click('#viewer [data-seat="s1"]');
  await page.waitForTimeout(700);
  expect(await showsFace(page, top)).toBe(false);
  // pass it to Player 3's hand, as Player 2
  const p3 = await handAt(page, 2);
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
  // squared up before, squared up after: every card at the stack's own angle
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
  await expect(page.getByRole("button", { name: /Flip top card/ })).toHaveCount(0);
  await page.mouse.click(c.x, c.y);
  await expect(page.locator(".ct-menu")).toHaveCount(0);
  // the count tab too
  const g = await center(page, ".ct-grip");
  await page.mouse.click(g.x, g.y);
  await expect(page.getByRole("button", { name: /Shuffle/ })).toBeVisible();
});

test("dragging the count moves the whole stack", async ({ page }) => {
  await open(page);
  await dragTo(page, await center(page, ".ct-grip"), await at(page, CX + 150, CY - 60));
  const s = await state(page);
  expect(s.piles.deck.cards.length).toBe(52);
  expect(Math.hypot(s.piles.deck.x - (CX + 150), s.piles.deck.y - (CY - 60))).toBeLessThan(80);
});

test("the table survives a reload; gather brings everything back", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.cardTable.deal("deck", 3));
  await page.reload();
  // the host's table resumes without the opening screen
  await page.waitForFunction(() => !!window.cardTable?.session);
  await expect(page.locator(".ct-gate")).toHaveCount(0);
  expect((await state(page)).hands.s1.length).toBe(3);
  await page.click("#gather");
  const s = await state(page);
  expect(Object.values(s.piles)).toHaveLength(1);
  expect(Object.values(s.piles)[0].cards).toHaveLength(52);
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
  const to = await at(page, CX + 150, CY - 48);
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await settle(page);
  const s = await state(page);
  expect(s.piles.deck.cards).toHaveLength(52);
  expect(Math.hypot(s.piles.deck.x - (CX + 150), s.piles.deck.y - (CY - 48))).toBeLessThan(20);
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
  const to = await at(page, CX - 170, CY - 72);
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

test("carrying a card into your hand: it rides in the gap where it will land", async ({ page }) => {
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
  // the card rides in the gap itself, so there's no ghost outline
  await expect(page.locator(".ct-slot.ct-on")).toHaveCount(0);
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

test("undo, from the button and the keyboard", async ({ page }) => {
  await open(page);
  await expect(page.locator("#undo")).toBeDisabled();
  const top = await topOf(page, "deck");
  await dragTo(page, await center(page, cardSel(top)), await at(page, CX - 170, CY - 72));
  expect((await state(page)).piles.deck.cards).toHaveLength(51);
  await page.click("#undo");
  await settle(page);
  expect((await state(page)).piles.deck.cards).toHaveLength(52);
  await expect(page.locator("#undo")).toBeDisabled();
  await dragTo(page, await center(page, cardSel(top)), await at(page, CX - 170, CY - 72));
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
  const p2 = await handAt(page, 1);
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
  await dragTo(page, last, await at(page, CX - 170, CY - 72));
  expect((await state(page)).cards[c].faceUp).toBe(true);
  // the first card's uncovered strip; flip it while carrying
  const b = await page.locator(cardSel(a)).boundingBox();
  await page.mouse.move(b.x + 10, b.y + b.height * 0.35);
  await page.mouse.down();
  const to = await at(page, CX + 150, CY - 72);
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

test("Show top few and Spread stack; Straighten stack squares either up", async ({ page }) => {
  await open(page);
  const g = await center(page, ".ct-grip");
  const menuPick = async (name) => {
    await page.mouse.click(g.x, g.y);
    await page.getByRole("button", { name }).click();
    await settle(page);
  };
  await menuPick("Show top few");
  expect((await state(page)).piles.deck.look).toBe("few");
  await menuPick("Straighten stack");
  expect((await state(page)).piles.deck.look).toBeUndefined();
  await menuPick("Spread stack");
  expect((await state(page)).piles.deck.look).toBe("spread");
  // spread out, any card can be picked up on its own
  const deck = (await state(page)).piles.deck.cards;
  const mid = deck[20];
  const b = await page.locator(cardSel(mid)).boundingBox();
  await dragTo(page, { x: b.x + 4, y: b.y + b.height / 2 }, await at(page, CX, CY + 120));
  const s = await state(page);
  expect(s.piles.deck.cards).not.toContain(mid);
  expect(s.piles.deck.cards).toHaveLength(51);
  await menuPick("Straighten stack");
  expect((await state(page)).piles.deck.look).toBeUndefined();
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

test("Drop hand puts your hand on the table face down, spread out", async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(() => window.cardTable.dispatch({ type: "deal", pile: "deck", count: 5, seats: ["s0"] }));
  await settle(page);
  const hand = (await state(page)).hands.s0;
  await page.locator(".ct-handbar").getByRole("button", { name: "Drop hand" }).click();
  await settle(page);
  const s = await state(page);
  expect(s.hands.s0).toEqual([]);
  const pile = Object.values(s.piles).find((p) => p.cards.includes(hand[0]));
  expect(pile.cards).toEqual(hand);
  expect(pile.look).toBe("spread");
  for (const id of hand) expect(s.cards[id].faceUp).toBe(false);
  // in front of you: between your seat and the middle
  expect(pile.y).toBeGreaterThan(CY);
  await page.click("#undo");
  expect((await state(page)).hands.s0).toEqual(hand);
  expect(errors).toEqual([]);
});

test("Peek stack spreads it face up on your screen only; the table doesn't change", async ({ page }) => {
  await open(page);
  const deck = (await state(page)).piles.deck.cards;
  const faces = () => page.locator(".ct-card .ct-index").count();
  expect(await faces()).toBe(0);
  const xOf = (id) => page.locator(cardSel(id)).boundingBox().then((b) => b.x);
  const before = [await xOf(deck[0]), await xOf(deck.at(-1))];
  const g = await center(page, ".ct-grip");
  await page.mouse.click(g.x, g.y);
  await page.getByRole("button", { name: "Peek stack" }).click();
  await settle(page);
  expect((await state(page)).piles.deck.look).toBeUndefined();
  await expect(page.locator("#undo")).toBeDisabled();
  const spread = [await xOf(deck[0]), await xOf(deck.at(-1))];
  expect(spread[1] - spread[0]).toBeGreaterThan(300);
  // every face shows, to you (two corner indices per card), with one struck-through eye
  expect(await faces()).toBe(52 * 2);
  await expect(page.locator(".ct-eye:not(.ct-eye-open):not(.ct-zone-eye)")).toHaveCount(1);
  expect(Object.values((await state(page)).cards).every((c) => !c.faceUp && !c.privateTo)).toBe(true);
  // a card in the middle can be taken out on its own
  const mid = deck[30];
  const b = await page.locator(cardSel(mid)).boundingBox();
  await dragTo(page, { x: b.x + 4, y: b.y + b.height / 2 }, await at(page, CX, CY + 132));
  expect((await state(page)).piles.deck.cards).not.toContain(mid);
  await page.keyboard.press("Escape");
  await settle(page);
  expect(await faces()).toBe(0);
  const after = [await xOf(deck[0]), await xOf(deck.at(-2))];
  expect(Math.abs(after[1] - after[0])).toBeLessThan(20);
  expect(before[1] - before[0]).toBeLessThan(20);
});

test("a face-up card dropped on another face-up card starts a spread stack", async ({ page }) => {
  await open(page);
  const [a, b] = (await state(page)).piles.deck.cards.slice(-2).reverse();
  // a face up on its own, then b face up on top of it
  await page.evaluate(([a, b]) => {
    const t = window.cardTable;
    t.dispatch({ type: "batch", actions: [
      { type: "moveCards", cards: [a], to: { newPile: { id: "one", x: 380, y: 270 } } }, { type: "flip", cards: [a] },
      { type: "moveCards", cards: [b], to: { newPile: { id: "two", x: 710, y: 270 } } }, { type: "flip", cards: [b] },
    ] });
  }, [a, b]);
  await settle(page);
  await dragTo(page, await center(page, cardSel(b)), await center(page, cardSel(a)));
  const s = await state(page);
  const pile = Object.values(s.piles).find((p) => p.cards.includes(a));
  expect(pile.cards).toEqual([a, b]);
  expect(pile.look).toBe("spread");
  // a face-down card on a face-down card makes an ordinary stack
  const c = s.piles.deck.cards.at(-1);
  await dragTo(page, await center(page, cardSel(c)), await at(page, CX, CY + 132));
  const d = (await state(page)).piles.deck.cards.at(-1);
  await dragTo(page, await center(page, cardSel(d)), await center(page, cardSel(c)));
  const p2 = Object.values((await state(page)).piles).find((p) => p.cards.includes(c));
  expect(p2.cards).toEqual([c, d]);
  expect(p2.look).toBeUndefined();
});

test("a card carried over a spread stack goes into the gap it opens; on top, the row stays put", async ({ page }) => {
  await open(page);
  // a face-up row of six
  await page.evaluate(() => {
    const t = window.cardTable, six = t.state.piles.deck.cards.slice(-6);
    t.dispatch({ type: "batch", actions: [
      { type: "moveCards", cards: six, to: { newPile: { id: "row", x: 330, y: 260, rot: t.view.uprightRot() } } },
      { type: "flip", cards: six }, { type: "setLook", pile: "row", look: "spread" },
    ] });
  });
  await settle(page);
  const row = (await state(page)).piles.row.cards;
  const xOf = (id) => page.locator(cardSel(id)).boundingBox().then((b) => b.x);
  const firstX = await xOf(row[0]);
  // carry the deck's top card to where the 3rd card's middle is: it goes in there, 3rd
  const top = await topOf(page, "deck");
  const third = await page.evaluate(() => {
    const t = window.cardTable, row = t.state.piles.row, along = 2 * 22;
    return t.view.toScreen(row.x + Math.cos(row.rot) * along, row.y + Math.sin(row.rot) * along);
  });
  await page.mouse.move(...Object.values(await center(page, cardSel(top))));
  await page.mouse.down();
  await page.mouse.move(third.x, third.y, { steps: 12 });
  await page.waitForTimeout(400);
  await expect(page.locator(".ct-slot.ct-on")).toHaveCount(0); // it rides in the gap instead
  await page.waitForTimeout(80);
  await page.mouse.up();
  await settle(page);
  let s = await state(page);
  expect(s.piles.row.cards.indexOf(top)).toBe(2);
  expect(s.piles.row.cards).toHaveLength(7);
  expect(Math.abs((await xOf(row[0])) - firstX)).toBeLessThan(2);
  // dropped past the end: on top, and the row doesn't shift
  const next = await topOf(page, "deck");
  const last = await page.locator(cardSel(s.piles.row.cards.at(-1))).boundingBox();
  await dragTo(page, await center(page, cardSel(next)), { x: last.x + last.width - 4, y: last.y + last.height / 2 });
  s = await state(page);
  expect(s.piles.row.cards.at(-1)).toBe(next);
  expect(Math.abs((await xOf(row[0])) - firstX)).toBeLessThan(2);
});

test("a whole stack carried over a spread stack opens a gap its size and goes in there", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const t = window.cardTable, d = t.state.piles.deck.cards;
    t.dispatch({ type: "batch", actions: [
      { type: "moveCards", cards: d.slice(-5), to: { newPile: { id: "row", x: 300, y: 250, rot: t.view.uprightRot() } } },
      { type: "flip", cards: d.slice(-5) }, { type: "setLook", pile: "row", look: "spread" },
      // a spread stack of three to carry in
      { type: "moveCards", cards: d.slice(-8, -5), to: { newPile: { id: "three", x: 450, y: 420, rot: t.view.uprightRot() } } },
      { type: "flip", cards: d.slice(-8, -5) }, { type: "setLook", pile: "three", look: "spread" },
    ] });
  });
  await settle(page);
  const row = (await state(page)).piles.row.cards, three = (await state(page)).piles.three.cards;
  const xOf = (id) => page.locator(cardSel(id)).boundingBox().then((b) => b.x);
  const lastX = await xOf(row[4]);
  // hold the three-card stack to lift it whole, and carry it over the gap after the 2nd card
  const g = await center(page, '.ct-grip[data-pile="three"]');
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  // the pointer over the row where the stack's middle should go: the 4th place (its first card
  // in the 3rd), with the row 22 apart
  const aim = await page.evaluate(() => {
    const t = window.cardTable, row = t.state.piles.row, along = 3 * 22;
    return t.view.toScreen(row.x + Math.cos(row.rot) * along, row.y + Math.sin(row.rot) * along);
  });
  await page.mouse.move(aim.x, aim.y, { steps: 14 });
  await page.waitForTimeout(500);
  // the cards after the gap moved right by about three slots
  expect((await xOf(row[4])) - lastX).toBeGreaterThan(40);
  await page.waitForTimeout(80);
  await page.mouse.up();
  await settle(page);
  const s = await state(page);
  expect(s.piles.three).toBeUndefined();
  expect(s.piles.row.cards).toEqual([row[0], row[1], ...three, row[2], row[3], row[4]]);
});

// a stack of five face-down cards at the middle, looked through with "Peek stack"
async function peekFive(page) {
  await page.evaluate(([x, y]) => {
    const t = window.cardTable, five = t.state.piles.deck.cards.slice(-5);
    t.dispatch({ type: "moveCards", cards: five, to: { newPile: { id: "five", x, y } } });
  }, [CX + 250, CY]);
  await settle(page);
  const c = await center(page, cardSel(await topOf(page, "five")));
  await page.mouse.click(c.x, c.y);
  await page.getByRole("button", { name: "Peek stack" }).click();
  await settle(page);
  return (await state(page)).piles.five.cards;
}

test("a card pulled out of a stack you're looking through stays under the pointer", async ({ page }) => {
  await open(page);
  const cards = await peekFive(page);
  const top = cards.at(-1);
  const from = await center(page, cardSel(top));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y - 40, { steps: 3 });
  await page.mouse.move(from.x - 30, from.y - 160, { steps: 8 });
  await page.waitForTimeout(400);
  const now = await center(page, cardSel(top));
  // grabbed by its middle, it's carried by its middle (a little bigger, but centered)
  expect(Math.hypot(now.x - (from.x - 30), now.y - (from.y - 160))).toBeLessThan(6);
  await page.mouse.up();
});

test("a stack you're looking through rearranges like a hand", async ({ page }) => {
  await open(page);
  const cards = await peekFive(page);
  // the bottom card (leftmost) carried past the fourth goes in after it
  // (grabbed by the strip of it that shows: the next card covers its middle)
  const box = await page.locator(cardSel(cards[0])).boundingBox();
  const a = { x: box.x + 8, y: box.y + box.height / 2 }, d = await center(page, cardSel(cards[3])), e = await center(page, cardSel(cards[4]));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 10, a.y, { steps: 2 });
  await page.mouse.move((d.x + e.x) / 2, a.y, { steps: 14 });
  await page.waitForTimeout(200);
  // while carried it rides in the row, face up, over the others
  expect(await showsFace(page, cards[0])).toBe(true);
  const z = await page.evaluate((ids) => ids.map((id) => +getComputedStyle(document.querySelector(`.ct-card[data-id="${id}"]`)).zIndex), cards);
  expect(z[0]).toBeGreaterThan(Math.max(...z.slice(1, 4)));
  // and the stack still has its eye, and the card you're moving your ring
  expect(await page.locator(".ct-eye").count()).toBe(1);
  await page.mouse.up();
  await settle(page);
  const after = (await state(page)).piles.five.cards;
  expect(after).toEqual([cards[1], cards[2], cards[3], cards[0], cards[4]]);
  // still looking through it, and nothing got turned over
  expect(await showsFace(page, cards[1])).toBe(true);
  expect((await state(page)).cards[cards[0]].faceUp).toBe(false);
});

test("names sit in the middle of their plates", async ({ page }) => {
  await open(page);
  const off = await page.evaluate(() => [...document.querySelectorAll(".ct-plate")].map((p) => {
    const a = p.getBoundingClientRect(), n = p.querySelector(".ct-plate-name").getBoundingClientRect();
    return (n.y + n.height / 2) - (a.y + a.height / 2);
  }));
  expect(off.length).toBeGreaterThan(1);
  for (const dy of off) expect(Math.abs(dy)).toBeLessThan(0.5);
});

test("a stack you're looking through keeps its eye while you move its top card through it", async ({ page }) => {
  await open(page);
  const cards = await peekFive(page);
  const top = await center(page, cardSel(cards[4])), b = await center(page, cardSel(cards[1]));
  await page.mouse.move(top.x, top.y);
  await page.mouse.down();
  await page.mouse.move(top.x - 10, top.y, { steps: 2 });
  await page.mouse.move(b.x, top.y, { steps: 12 });
  await page.waitForTimeout(300);
  expect(await page.locator(".ct-eye").count()).toBe(1);
  // every card you're handling wears your ring, the one you carry too
  const ringed = await page.evaluate((ids) => ids.map((id) => document.querySelector(`.ct-card[data-id="${id}"]`).classList.contains("ct-ringed")), cards);
  expect(ringed).toEqual([true, true, true, true, true]);
  await page.mouse.up();
  await settle(page);
  expect(await page.locator(".ct-eye").count()).toBe(1);
});
