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

test("the host gives every player chips, and makes a stack on the felt", async ({ page }) => {
  const errors = await open(page);
  await page.getByRole("button", { name: "New chips" }).click();
  await page.locator(".ct-count-in").fill("500");
  await page.getByRole("button", { name: "Give each player 500" }).click();
  await settle(page);
  let s = await state(page);
  expect(s.chipHands.s0.map((id) => s.chips[id].amount)).toEqual([500]);
  expect(s.chipHands.s1.map((id) => s.chips[id].amount)).toEqual([500]);
  const at = await page.evaluate(([x, y]) => window.cardTable.view.toScreen(x, y), [CX + 200, CY]);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await page.getByRole("button", { name: "New chips…" }).click();
  await page.locator(".ct-count-in").fill("75");
  await page.getByRole("button", { name: "Put 75 here" }).click();
  await settle(page);
  s = await state(page);
  const pot = Object.values(s.chips).find((c) => c.amount === 75);
  expect(Math.hypot(pot.x - (CX + 200), pot.y - CY)).toBeLessThan(2);
  expect(errors).toEqual([]);
});

test("split a stack in your hand, carry part of it onto a stack on the felt, and they join", async ({ page }) => {
  const errors = await open(page);
  await make(page, "mine", 1000, { hand: "s0" });
  await make(page, "pot", 340, { x: CX, y: CY - 60 });
  await settle(page);
  await page.click(`${stackSel("mine")} .ct-chips-amt`);
  await page.getByRole("button", { name: "Split…" }).click();
  await page.locator(".ct-count-in").fill("250");
  await page.keyboard.press("Enter");
  await settle(page);
  let s = await state(page);
  expect(s.chipHands.s0.map((id) => s.chips[id].amount)).toEqual([750, 250]);
  const bet = s.chipHands.s0[1];
  // carried, it wears your color and an eye
  const from = await middle(page, `${stackSel(bet)} .ct-chips-art`), to = await middle(page, `${stackSel("pot")} .ct-chips-art`);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y - 20, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.waitForTimeout(150);
  await expect(page.locator(stackSel(bet))).toHaveClass(/ct-ringed/);
  await expect(page.locator(`${stackSel(bet)} .ct-eye`)).toHaveCount(1);
  await expect(page.locator(stackSel("pot"))).toHaveClass(/ct-target/);
  await page.mouse.up();
  await settle(page);
  s = await state(page);
  expect(s.chips.pot.amount).toBe(590);
  expect(s.chips[bet]).toBeUndefined();
  expect(await amounts(page)).toEqual([590, 750]);
  expect(errors).toEqual([]);
});

test("take some of a stack into your hand; drop a stack on the felt", async ({ page }) => {
  await open(page);
  await make(page, "pot", 300, { x: CX, y: CY });
  await settle(page);
  await page.click(`${stackSel("pot")} .ct-chips-amt`);
  await page.getByRole("button", { name: "Take…" }).click();
  await page.locator(".ct-count-in").fill("120");
  await page.getByRole("button", { name: "Take 120" }).click();
  await settle(page);
  let s = await state(page);
  expect(s.chips.pot.amount).toBe(180);
  const got = s.chipHands.s0[0];
  expect(s.chips[got].amount).toBe(120);
  // out of the hand onto the empty felt
  const from = await middle(page, `${stackSel(got)} .ct-chips-art`);
  const to = await page.evaluate(([x, y]) => window.cardTable.view.toScreen(x, y), [CX - 250, CY + 40]);
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 }); await page.waitForTimeout(80); await page.mouse.up();
  await settle(page);
  s = await state(page);
  expect(s.chipHands.s0).toEqual([]);
  expect(Math.abs(s.chips[got].x - (CX - 250))).toBeLessThan(20);
});

test("deal chips: the same amount into each player's hand", async ({ page }) => {
  await open(page);
  await make(page, "bank", 1000, { x: CX, y: CY });
  await settle(page);
  await page.click(`${stackSel("bank")} .ct-chips-amt`);
  await page.getByRole("button", { name: "Deal…" }).click();
  await page.locator(".ct-count-in").fill("200");
  await page.getByRole("button", { name: "Deal 200 each" }).click();
  await settle(page);
  const s = await state(page);
  expect(s.chips.bank.amount).toBe(600);
  for (const seat of ["s0", "s1"]) expect(s.chipHands[seat].map((id) => s.chips[id].amount)).toEqual([200]);
});

test("a stack's amount can't be typed past what it has; steps land on round numbers", async ({ page }) => {
  await open(page);
  await make(page, "pot", 37, { x: CX, y: CY });
  await settle(page);
  await page.click(`${stackSel("pot")} .ct-chips-amt`);
  await page.getByRole("button", { name: "Take…" }).click();
  const box = page.locator(".ct-count-in");
  await box.fill("999");
  await expect(page.getByRole("button", { name: "Take 37" })).toBeVisible();
  // (one at a time below 20; above that, by round amounts, landing on them)
  await box.fill("12");
  await page.getByRole("button", { name: "more" }).click();
  await expect(box).toHaveValue("13");
  await page.keyboard.press("Escape");
  await make(page, "big", 500, { x: CX + 150, y: CY });
  await settle(page);
  await page.click(`${stackSel("big")} .ct-chips-amt`);
  await page.getByRole("button", { name: "Take…" }).click();
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
