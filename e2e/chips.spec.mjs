// Chips, with real mouse and keyboard: made by the host, split, taken, dealt, carried and merged.
import { test, expect } from "@playwright/test";
import { serveFromCache } from "./helpers.mjs";
import { CX, CY } from "../table.mjs";

async function open(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/net::ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.route((url) => url.hostname !== "localhost", serveFromCache);
  await page.goto("/index.html?net=local");
  await page.getByRole("button", { name: "Host a table" }).click();
  await page.fill("#ct-name", "Mike");
  await page.getByRole("button", { name: "Host table" }).click();
  await page.waitForFunction(() => !!window.cardTable?.session);
  await page.evaluate(() => {
    const t = window.cardTable; t.reset(2);
    t.dispatch({ type: "sit", seat: "s1", player: "p2", name: "Ana" });
  });
  await settle(page);
  return errors;
}
const settle = (page) => page.waitForTimeout(500);
const state = (page) => page.evaluate(() => window.cardTable.state);
const amounts = async (page) => Object.values((await state(page)).chips).map((c) => c.amount).sort((a, b) => a - b);
const stackSel = (id) => `.ct-chips[data-chip="${id}"]`;
async function middle(page, sel) {
  const b = await page.locator(sel).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
const make = (page, id, amount, to) => page.evaluate(([id, amount, to]) => window.cardTable.dispatch({ type: "makeChips", id, amount, to }), [id, amount, to]);

test("the host's new chips go in the middle, onto the stack already there", async ({ page }) => {
  const errors = await open(page);
  for (const v of ["500", "250"]) {
    await page.getByRole("button", { name: "New chips" }).click();
    await page.locator(".ct-count-in").fill(v);
    await page.getByRole("button", { name: `Put ${v} in the middle` }).click();
    await settle(page);
  }
  const s = await state(page);
  const all = Object.values(s.chips);
  expect(all.map((c) => c.amount)).toEqual([750]);
  expect(Math.abs(all[0].x - CX)).toBeLessThan(200);
  expect(Math.abs(all[0].y - CY)).toBeLessThan(5);
  expect(errors).toEqual([]);
});

// open a stack's menu and pick an item
async function menuOn(page, id, item) {
  await page.click(`${stackSel(id)} .ct-chips-amt`);
  await page.getByRole("button", { name: item }).click();
}
// take some off a stack into a new stack beside it
async function take(page, id, amount) {
  await menuOn(page, id, "Take…");
  await page.locator(".ct-count-in").fill(String(amount));
  await page.getByRole("button", { name: `Take ${amount}` }).click();
  await settle(page);
}

test("take some off a stack on the felt or in your hand: a new stack beside it", async ({ page }) => {
  const errors = await open(page);
  await make(page, "pot", 300, { x: CX, y: CY - 60 });
  await make(page, "other", 5, { x: CX + 56, y: CY - 60 });
  await make(page, "mine", 100, { hand: "s0" });
  await make(page, "last", 7, { hand: "s0" });
  await settle(page);
  await take(page, "pot", 120);
  let s = await state(page);
  expect(s.chips.pot.amount).toBe(180);
  const got = Object.values(s.chips).find((c) => c.amount === 120);
  // to its right on screen, past the stack already there, level with it
  expect(got.x).toBeGreaterThan(CX + 80);
  expect(Math.abs(got.y - (CY - 60))).toBeLessThan(1);
  // in your hand: right after the stack it came off
  await take(page, "mine", 30);
  s = await state(page);
  expect(s.chipHands.s0.map((id) => s.chips[id].amount)).toEqual([70, 30, 7]);
  expect(errors).toEqual([]);
});

test("split a stack into even stacks, like cards: on the felt and in your hand", async ({ page }) => {
  const errors = await open(page);
  await make(page, "pot", 1000, { x: CX, y: CY - 60 });
  await make(page, "mine", 10, { hand: "s0" });
  await settle(page);
  await menuOn(page, "pot", "Split…");
  await page.getByRole("button", { name: "more" }).click();
  await page.getByRole("button", { name: "Split into 3" }).click();
  await settle(page);
  let s = await state(page);
  const onFelt = Object.values(s.chips).filter((c) => !s.chipHands.s0.includes(c.id));
  expect(onFelt.map((c) => c.amount).sort()).toEqual([333, 333, 334]);
  // side by side across the view
  const ys = onFelt.map((c) => c.y), xs = onFelt.map((c) => c.x).sort((a, b) => a - b);
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1);
  expect(xs[1] - xs[0]).toBeGreaterThan(40);
  // (it remembers the last count, as for cards)
  await menuOn(page, "mine", "Split…");
  await page.getByRole("button", { name: "Split into 3" }).click();
  await settle(page);
  s = await state(page);
  expect(s.chipHands.s0.map((id) => s.chips[id].amount)).toEqual([4, 3, 3]);
  expect(errors).toEqual([]);
});

test("carry a whole stack out of your hand onto another, and they join", async ({ page }) => {
  await open(page);
  await make(page, "mine", 250, { hand: "s0" });
  await make(page, "pot", 340, { x: CX, y: CY - 60 });
  await settle(page);
  const from = await middle(page, `${stackSel("mine")} .ct-chips-art`), to = await middle(page, `${stackSel("pot")} .ct-chips-art`);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y - 20, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.waitForTimeout(150);
  await expect(page.locator(stackSel("mine"))).toHaveClass(/ct-ringed/);
  await expect(page.locator(`${stackSel("mine")} .ct-eye`)).toHaveCount(1);
  await page.mouse.up();
  await settle(page);
  const s = await state(page);
  expect(s.chips.pot.amount).toBe(590);
  expect(s.chips.mine).toBeUndefined();
});

test("deal chips from the felt and from your hand: the same amount into each player's hand", async ({ page }) => {
  await open(page);
  await make(page, "bank", 1000, { x: CX, y: CY });
  await settle(page);
  await menuOn(page, "bank", "Deal…");
  await page.locator(".ct-count-in").fill("200");
  await page.getByRole("button", { name: "Deal 200 each" }).click();
  await settle(page);
  let s = await state(page);
  expect(s.chips.bank.amount).toBe(600);
  for (const seat of ["s0", "s1"]) expect(s.chipHands[seat].map((id) => s.chips[id].amount)).toEqual([200]);
  const mine = s.chipHands.s0[0];
  await menuOn(page, mine, "Deal…");
  await page.locator(".ct-count-in").fill("50");
  await page.getByRole("button", { name: "Deal 50 each" }).click();
  await settle(page);
  s = await state(page);
  expect(s.chipHands.s1.map((id) => s.chips[id].amount)).toEqual([200, 50]);
  expect(s.chipHands.s0.map((id) => s.chips[id].amount)).toEqual([100, 50]);
});

test("a stack's amount can't be typed past what it has; steps land on round numbers", async ({ page }) => {
  await open(page);
  await make(page, "pot", 37, { x: CX, y: CY });
  await settle(page);
  await menuOn(page, "pot", "Take…");
  const box = page.locator(".ct-count-in");
  await box.fill("999");
  // (taking leaves at least one: taking all of it is just moving the stack)
  await expect(page.getByRole("button", { name: "Take 36" })).toBeVisible();
  // (one at a time below 20; above that, by round amounts, landing on them)
  await box.fill("12");
  await page.getByRole("button", { name: "more" }).click();
  await expect(box).toHaveValue("13");
  await page.keyboard.press("Escape");
  await make(page, "big", 500, { x: CX + 150, y: CY });
  await settle(page);
  await menuOn(page, "big", "Take…");
  await box.fill("123");
  await page.getByRole("button", { name: "more" }).click();
  await expect(box).toHaveValue("130");
});

test("cards in a hand make room for its chips, and still drop between each other", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.cardTable.dispatch({ type: "deal", pile: "deck", count: 4, seats: ["s0"] }));
  await make(page, "a", 100, { hand: "s0" });
  await make(page, "b", 25, { hand: "s0" });
  await settle(page);
  const cards = await page.evaluate(() => window.cardTable.state.hands.s0);
  const last = await page.locator(`.ct-card[data-id="${cards.at(-1)}"]`).boundingBox();
  const chip = await page.locator(`${stackSel("a")} .ct-chips-art`).boundingBox();
  // the chips stand clear to the right of the cards
  expect(chip.x).toBeGreaterThan(last.x + last.width - 30);
});

test("Deal is there with nobody else at the table: it deals to you", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.cardTable.dispatch({ type: "stand", seat: "s1" }));
  await make(page, "bank", 100, { x: CX, y: CY });
  await settle(page);
  await menuOn(page, "bank", "Deal…");
  await page.locator(".ct-count-in").fill("40");
  await page.getByRole("button", { name: "Deal 40 each" }).click();
  await settle(page);
  const s = await state(page);
  expect(s.chips.bank.amount).toBe(60);
  expect(s.chipHands.s0.map((id) => s.chips[id].amount)).toEqual([40]);
});
