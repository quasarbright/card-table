// Chips, as in my chips sketch: off until the host hands them out; then bets from the dock, pots on
// the felt, the host's sheets; and the table's history, with rewind and restore.
import { test, expect } from "@playwright/test";
import { serveFromCache } from "./helpers.mjs";

async function tab(context) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/net::ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.route((url) => url.hostname !== "localhost", serveFromCache);
  page.errors = errors;
  return page;
}
async function host(page, name = "Mike") {
  await page.goto("/index.html?net=local");
  await page.fill("#ct-name", name);
  await page.getByRole("button", { name: "Open a table" }).click();
  await page.waitForFunction(() => !!window.cardTable?.session);
}
async function join(page, url, name) {
  await page.goto(url);
  await page.fill("#ct-name", name);
  await page.getByRole("button", { name: "Join table" }).click();
  await page.waitForFunction(() => window.cardTable?.session?.connected);
}
async function seat(A, B, name) {
  await A.locator(".ct-toast", { hasText: name }).getByRole("button", { name: "Give a seat" }).click();
  await B.waitForFunction(() => !!window.cardTable?.session?.seat);
}
const state = (page) => page.evaluate(() => window.cardTable.state);
const settle = (page) => page.waitForTimeout(500);
async function startChips(A, amount = "1,000") {
  await A.getByRole("button", { name: "Chips", exact: true }).click();
  await A.locator(".ct-bank-sheet [data-amt=start]").fill(amount);
  await A.getByRole("button", { name: /^Give everyone/ }).click();
  await settle(A);
}
async function bet(page, n) {
  await page.locator(".ct-dock [data-amt]").fill(String(n));
  await page.locator(".ct-dock [data-send]").click();
  await settle(page);
}

test("no chips until the host hands them out; then counts on the plates, a pot, and a dock", async ({ context }) => {
  const A = await tab(context);
  await host(A);
  await expect(A.locator(".ct-plate-chips:visible")).toHaveCount(0);
  await expect(A.locator(".ct-pot")).toHaveCount(0);
  await expect(A.locator(".ct-dock")).toBeHidden();
  await startChips(A, "500");
  const me = await A.evaluate(() => window.cardTable.player);
  expect((await state(A)).bank.chips[me]).toBe(500);
  await expect(A.locator(".ct-plate.ct-me .ct-plate-chips")).toHaveText("500");
  await expect(A.locator(".ct-pot")).toHaveCount(1);
  await expect(A.locator(".ct-dock")).toBeVisible();
  expect(A.errors).toEqual([]);
});

test("a bet from the dock goes into the pot, with a note by it; the host awards the pot", async ({ context }) => {
  const A = await tab(context), B = await tab(context);
  await host(A);
  await join(B, A.url(), "Ana");
  await seat(A, B, "Ana");
  await startChips(A);
  // Ana bets 120: the pot and her plate change on both screens, and a note says so
  await expect(B.locator(".ct-dock")).toBeVisible();
  await bet(B, 120);
  await expect(A.locator(".ct-pot .ct-pot-amt")).toHaveText("120");
  await expect(A.locator(".ct-note", { hasText: "bet" })).toContainText("Ana bet 120 → Pot");
  await expect(B.locator(".ct-plate.ct-me .ct-plate-chips")).toHaveText("880");
  // the host gives it to Ana
  await A.locator(".ct-pot").click();
  await A.locator(".ct-winner", { hasText: "Ana" }).click();
  await A.getByRole("button", { name: "Give it to Ana" }).click();
  await settle(A);
  const ana = (await state(A)).seats.find((s) => s.name === "Ana").player;
  expect((await state(B)).bank.chips[ana]).toBe(1000);
  // a player can't award: their pot card does nothing
  await B.locator(".ct-pot").click();
  await expect(B.locator(".ct-bank-sheet")).toHaveCount(0);
  expect([...A.errors, ...B.errors]).toEqual([]);
});

test("the host's Chips sheet: set a count, a rebuy, a new pot, and putting them away", async ({ context }) => {
  const A = await tab(context);
  await host(A);
  await startChips(A);
  const me = await A.evaluate(() => window.cardTable.player);
  await A.locator(".ct-dock [data-manage]").click();
  await A.locator(".ct-prow-n").first().fill("750");
  await A.locator(".ct-prow-n").first().press("Enter");
  await settle(A);
  expect((await state(A)).bank.chips[me]).toBe(750);
  await A.locator(".ct-bank-sheet summary", { hasText: "Give everyone more" }).click();
  await A.locator(".ct-bank-sheet [data-amt=more]").fill("100");
  await A.getByRole("button", { name: "Give", exact: true }).click();
  await settle(A);
  expect((await state(A)).bank.chips[me]).toBe(850);
  await A.locator(".ct-dock [data-manage]").click();
  await A.locator(".ct-bank-sheet summary", { hasText: "Add a pot" }).click();
  await A.getByRole("button", { name: "Add", exact: true }).click();
  await settle(A);
  await expect(A.locator(".ct-pot")).toHaveCount(2);
  await A.locator(".ct-dock [data-manage]").click();
  await A.locator(".ct-bank-sheet summary", { hasText: "Remove all chips" }).click();
  await A.locator(".ct-bank-sheet [data-end]").click();
  await settle(A);
  expect((await state(A)).bank).toBeNull();
  await expect(A.locator(".ct-pot")).toHaveCount(0);
  await expect(A.locator(".ct-dock")).toBeHidden();
});

test("history: every change has a line; the host rewinds and restores, cards and chips together", async ({ context }) => {
  const A = await tab(context);
  await host(A);
  await A.evaluate(() => window.cardTable.dispatch({ type: "deal", pile: "deck", count: 2, seats: ["s0"] }));
  await startChips(A);
  await bet(A, 40);
  await A.locator("#history").click();
  const lines = A.locator(".ct-h-list li");
  await expect(lines.nth(0)).toContainText("Mike bet 40 → Pot");
  await expect(lines.nth(1)).toContainText("handed out chips");
  await expect(lines.nth(2)).toContainText("dealt 2 cards each");
  // back to just after the deal: no chips yet, the cards still dealt
  await lines.nth(2).getByRole("button", { name: "rewind to here" }).click();
  await settle(A);
  expect((await state(A)).bank ?? null).toBeNull();
  expect((await state(A)).hands.s0.length).toBe(2);
  await expect(lines.nth(0)).toHaveClass(/ct-h-rewound/);
  // and forward again
  await lines.nth(0).getByRole("button", { name: "restore to here" }).click();
  await settle(A);
  expect((await state(A)).bank.pots[0].chips).toBe(40);
  // undo is a rewind of one line
  await A.getByRole("button", { name: "Undo" }).click();
  await settle(A);
  expect((await state(A)).bank.pots[0].chips).toBe(0);
  await expect(lines.nth(0)).toHaveClass(/ct-h-rewound/);
  expect(A.errors).toEqual([]);
});

test("the history never names a card someone is hiding", async ({ context }) => {
  const A = await tab(context);
  await host(A);
  await A.evaluate(() => {
    const t = window.cardTable; t.reset(2);
    t.dispatch({ type: "sit", seat: "s1", player: "p2", name: "Ana" });
    t.dispatch({ type: "deal", pile: "deck", count: 1, seats: ["s1"] });
    t.dispatch({ type: "setHandLocked", seat: "s1", locked: false });
    t.dispatch({ type: "moveCards", cards: [t.state.hands.s1[0]], to: { hand: "s0" } });
  });
  await A.locator("#history").click();
  const text = await A.locator(".ct-h-list").innerText();
  expect(text).toContain("took a card from Ana");
  expect(text).not.toMatch(/[A2-9JQK10]+[♠♥♦♣]/);
});

test("the history and settings buttons sit at the top right", async ({ context }) => {
  const A = await tab(context);
  await host(A);
  const h = await A.locator("#history").boundingBox(), s = await A.locator("#settings").boundingBox();
  const w = A.viewportSize().width;
  expect(h.y).toBeLessThan(40); expect(s.y).toBeLessThan(40);
  expect(s.x + s.width).toBeGreaterThan(w - 40);
  expect(h.x).toBeLessThan(s.x);
});

test("the host's sheet for a player: their chips, their exact amount, and their seat, all in one", async ({ context }) => {
  const A = await tab(context), B = await tab(context);
  await host(A);
  await join(B, A.url(), "Ana");
  await seat(A, B, "Ana");
  await startChips(A);
  await A.locator('.ct-plate[data-seat="s1"]').click();
  const sheet = A.locator(".ct-bank-sheet");
  await expect(sheet.getByText("Set their exact chip amount")).toBeVisible();
  await sheet.locator("[data-amt=set]").fill("1234");
  await sheet.getByRole("button", { name: "Set", exact: true }).click();
  await settle(A);
  const ana = (await state(A)).seats[1].player;
  expect((await state(A)).bank.chips[ana]).toBe(1234);
  await A.locator('.ct-plate[data-seat="s1"]').click();
  await A.getByRole("button", { name: /Make spectator/ }).click();
  await B.waitForFunction(() => !window.cardTable.session.seat);
  // the dock and the bar don't touch
  const gap = await A.evaluate(() => document.querySelector(".ct-bar").getBoundingClientRect().top - document.querySelector(".ct-dock").getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThan(5);
});

test("the bar's Chips button shows and hides your dock; only the host's dock has Manage", async ({ context }) => {
  const A = await tab(context), B = await tab(context);
  await host(A);
  await join(B, A.url(), "Ana");
  await seat(A, B, "Ana");
  // before chips, only the host has the button
  await expect(B.getByRole("button", { name: "Chips", exact: true })).toBeHidden();
  await startChips(A);
  const chips = B.getByRole("button", { name: "Chips", exact: true });
  await expect(chips).toHaveAttribute("aria-pressed", "true");
  await expect(B.locator(".ct-dock")).toBeVisible();
  await expect(B.locator(".ct-dock [data-manage]")).toBeHidden();
  await expect(A.locator(".ct-dock [data-manage]")).toBeVisible();
  await chips.click();
  await expect(B.locator(".ct-dock")).toBeHidden();
  await expect(chips).toHaveAttribute("aria-pressed", "false");
  await chips.click();
  await expect(B.locator(".ct-dock")).toBeVisible();
});

test("a pot drags out of the way and stays there for everyone; a click still opens it", async ({ context }) => {
  const A = await tab(context), B = await tab(context);
  await host(A);
  await join(B, A.url(), "Ana");
  await seat(A, B, "Ana");
  await startChips(A);
  // Ana drags it
  const box = await B.locator(".ct-pot").boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await B.mouse.move(from.x, from.y); await B.mouse.down();
  await B.mouse.move(from.x - 60, from.y - 40, { steps: 6 });
  await B.mouse.move(from.x - 200, from.y - 80, { steps: 10 });
  await B.mouse.up();
  await settle(B);
  const pot = (await state(A)).bank.pots[0];
  expect(typeof pot.x).toBe("number");
  await expect(B.locator(".ct-bank-sheet")).toHaveCount(0); // a drag isn't a click
  // where it lands on Ana's screen is where she let go
  const after = await B.locator(".ct-pot").boundingBox();
  expect(Math.abs(after.x + after.width / 2 - (from.x - 200))).toBeLessThan(6);
  // not a line in the history
  await A.locator("#history").click();
  await expect(A.locator(".ct-h-list")).not.toContainText("moved");
  await A.keyboard.press("Escape");
  // the host can still click it open
  await A.locator(".ct-pot").click();
  await expect(A.locator(".ct-bank-sheet")).toBeVisible();
});
