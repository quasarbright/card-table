// Two players at one table: two tabs of one browser, talking over a BroadcastChannel
// (?net=local) instead of the internet, driven with real mouse input.
import { test, expect } from "@playwright/test";
import { serveFromCache } from "./helpers.mjs";
import { CX, CY, clampToFelt } from "../table.mjs";

async function tab(context) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/net::ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.route((url) => url.hostname !== "localhost", serveFromCache);
  page.errors = errors;
  return page;
}
async function host(page, name) {
  await page.goto("/index.html?net=local");
  await page.fill("#ct-name", name);
  await page.getByRole("button", { name: "Open a table" }).click();
  await page.waitForFunction(() => !!window.cardTable?.session);
}
async function join(page, url, name) {
  await page.goto(url);
  await expect(page.getByRole("button", { name: "Join table" })).toBeVisible();
  await page.fill("#ct-name", name);
  await page.getByRole("button", { name: "Join table" }).click();
  await page.waitForFunction(() => window.cardTable?.session?.connected);
  await expect(page.locator(".ct-gate")).toHaveCount(0);
}
const state = (page) => page.evaluate(() => window.cardTable.state);
const settle = (page) => page.waitForTimeout(650);
const cardSel = (id) => `.ct-card[data-id="${id}"]`;
async function center(page, sel) {
  const b = await page.locator(sel).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
const at = (page, x, y) => page.evaluate(([x, y]) => window.cardTable.view.toScreen(x, y), [x, y]);

// the host gives a watcher a seat, from their name at the top
async function seat(A, B, name) {
  await A.locator(".ct-toast", { hasText: name }).getByRole("button", { name: "Later" }).click();
  await A.locator(".ct-chip", { hasText: name }).click();
  await A.getByRole("button", { name: "Give a seat" }).click();
  await B.waitForFunction(() => !!window.cardTable?.session?.seat);
}
async function twoAtATable(context) {
  const A = await tab(context), B = await tab(context);
  await host(A, "Mike");
  await join(B, A.url(), "Ana");
  await seat(A, B, "Ana");
  return { A, B };
}

test("joining from the link you watch first; the host gives you the next seat", async ({ context }) => {
  const A = await tab(context), B = await tab(context);
  await host(A, "Mike");
  await join(B, A.url(), "Ana");
  // watching: no seat, a note saying so, and Ana's name on the host's screen
  expect(await B.evaluate(() => window.cardTable.session.seat)).toBeNull();
  await expect(B.locator(".ct-spectate")).toContainText("You're watching Mike's table");
  await expect(A.locator(".ct-chip", { hasText: "Ana" })).toBeVisible();
  expect((await state(A)).seats).toHaveLength(1);
  await seat(A, B, "Ana");
  await expect(B.locator(".ct-spectate")).toBeHidden();
  await expect(A.locator(".ct-chip")).toHaveCount(0);
  expect(await B.evaluate(() => window.cardTable.session.seat)).toBe("s1");
  await expect(A.locator(".ct-plate", { hasText: "Ana" })).toBeVisible();
  await expect(B.locator(".ct-plate", { hasText: "Mike" })).toBeVisible();
  await expect(B.locator(".ct-plate", { hasText: "Ana (you)" })).toBeVisible();
  // a table starts with the host's seat and grows one for each person who joins
  expect((await state(A)).seats).toHaveLength(2);
  await expect(A.locator("#players")).toHaveCount(0);
  await expect(A.locator("#viewer")).toBeHidden();
  expect(JSON.stringify(await state(A))).toBe(JSON.stringify(await state(B)));
  expect([...A.errors, ...B.errors]).toEqual([]);
});

test("the host gets a note for each arrival, stacked; seat from it, wave it off, or answer an ask", async ({ context }) => {
  const A = await tab(context), B = await tab(context), C = await tab(context);
  await host(A, "Mike");
  await join(B, A.url(), "Ana");
  await join(C, A.url(), "Bo");
  // two notes, one under the other
  const notes = A.locator(".ct-toast");
  await expect(notes).toHaveCount(2);
  await expect(notes.nth(0)).toContainText("Ana joined");
  await expect(notes.nth(1)).toContainText("Bo joined");
  const [a, b] = [await notes.nth(0).boundingBox(), await notes.nth(1).boundingBox()];
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
  // Give a seat seats Ana and clears her note; her banner goes away
  await notes.nth(0).getByRole("button", { name: "Give a seat" }).click();
  await B.waitForFunction(() => !!window.cardTable.session.seat);
  await expect(B.locator(".ct-spectate")).toBeHidden();
  await expect(notes).toHaveCount(1);
  // Later waves Bo's off; asking brings it back as a request
  await notes.nth(0).getByRole("button", { name: "Later" }).click();
  await expect(notes).toHaveCount(0);
  await C.locator(".ct-spectate").getByRole("button", { name: "Ask for a seat" }).click();
  await expect(C.locator(".ct-spectate").getByRole("button", { name: "Asked" })).toBeDisabled();
  await expect(notes).toHaveCount(1);
  await expect(notes.nth(0)).toContainText("Bo wants a seat");
  // a note goes once its person leaves
  await C.close();
  await expect(notes).toHaveCount(0, { timeout: 8000 });
  expect([...A.errors, ...B.errors]).toEqual([]);
});

test("a drag shows on the other screen while it happens, and the drop lands on both", async ({ context }) => {
  const { A, B } = await twoAtATable(context);
  const top = (await state(A)).piles.deck.cards.at(-1);
  const before = await center(B, cardSel(top));
  await A.mouse.move(...Object.values(await center(A, cardSel(top))));
  await A.mouse.down();
  const to = await at(A, CX - 170, CY - 48);
  await A.mouse.move(to.x, to.y, { steps: 15 });
  await B.waitForTimeout(500);
  // mid-drag: B's copy of the card has moved, and carries the dragger's name
  const during = await center(B, cardSel(top));
  expect(Math.hypot(during.x - before.x, during.y - before.y)).toBeGreaterThan(40);
  await expect(B.locator(".ct-tag", { hasText: "Mike" })).toBeVisible();
  await A.mouse.up();
  await settle(B);
  await expect(B.locator(".ct-tag")).toHaveCount(0);
  const a = await state(A), b = await state(B);
  expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  expect(Object.values(b.piles).find((p) => p.cards.includes(top)).id).not.toBe("deck");
});

test("a joiner's move reaches the host, and anyone can undo it", async ({ context }) => {
  const { A, B } = await twoAtATable(context);
  const top = (await state(B)).piles.deck.cards.at(-1);
  await B.mouse.move(...Object.values(await center(B, cardSel(top))));
  await B.mouse.down();
  const to = await at(B, CX + 150, CY - 48);
  await B.mouse.move(to.x, to.y, { steps: 10 });
  await B.mouse.up();
  await settle(A);
  expect((await state(A)).piles.deck.cards).toHaveLength(51);
  // undo is the table's: the host can take back the joiner's move
  await expect(A.locator("#undo")).toBeEnabled();
  await expect(B.locator("#undo")).toBeEnabled();
  await A.click("#undo");
  await settle(B);
  expect((await state(A)).piles.deck.cards).toHaveLength(52);
  expect((await state(B)).piles.deck.cards).toHaveLength(52);
  await expect(B.locator("#undo")).toBeDisabled();
});

test("undoing past someone's arrival keeps them at the table", async ({ context }) => {
  const A = await tab(context), B = await tab(context);
  await host(A, "Mike");
  await A.evaluate(() => window.cardTable.shufflePile("deck"));
  await join(B, A.url(), "Ana");
  await seat(A, B, "Ana");
  await B.click("#undo");
  await settle(A);
  const s = await state(A);
  expect(s.seats.map((x) => x.name)).toEqual(["Mike", "Ana"]);
  expect(await B.evaluate(() => window.cardTable.session.seat)).toBe("s1");
  expect(JSON.stringify(await state(B))).toBe(JSON.stringify(s));
  await expect(A.locator("#undo")).toBeDisabled();
});

test("your hand stays hidden from the other player until you show it", async ({ context }) => {
  const { A, B } = await twoAtATable(context);
  await A.evaluate(() => window.cardTable.deal("deck", 2));
  await A.waitForTimeout(800);
  const anaCards = (await state(A)).hands.s1;
  expect(anaCards).toHaveLength(2);
  for (const id of anaCards) expect(await A.locator(`${cardSel(id)} .ct-index`).count()).toBe(0);
  for (const id of anaCards) expect(await B.locator(`${cardSel(id)} .ct-index`).count()).toBeGreaterThan(0);
  await B.locator(".ct-handbar").getByRole("button", { name: "Show hand" }).click();
  await settle(A);
  for (const id of anaCards) expect(await A.locator(`${cardSel(id)} .ct-index`).count()).toBeGreaterThan(0);
});

test("a hand is locked until its player opens it: until then nobody else can take from it", async ({ context }) => {
  const { A, B } = await twoAtATable(context);
  await A.evaluate(() => window.cardTable.deal("deck", 2));
  await A.waitForTimeout(800);
  const mine = (await state(A)).hands.s0;
  // a lock on each hand, in its player's color; only your own is a button
  await expect(B.locator(".ct-lock.ct-locked")).toHaveCount(2);
  await expect(B.locator(".ct-lock-mine")).toHaveCount(1);
  expect(await B.locator('.ct-lock[data-seat="s0"]').evaluate((e) => e.style.getPropertyValue("--seat"))).toBe((await state(A)).seats[0].color);
  // Ana can't pick up Mike's card...
  const mid = await at(B, CX, CY);
  let c = await center(B, cardSel(mine[0]));
  await B.mouse.move(c.x, c.y); await B.mouse.down();
  await B.mouse.move(mid.x, mid.y, { steps: 6 }); await B.mouse.up();
  await settle(A);
  expect((await state(A)).hands.s0).toEqual(mine);
  // ...nor reach it by sending the move directly: the host turns it down
  await B.evaluate((id) => window.cardTable.dispatch({ type: "moveCards", cards: [id], to: { hand: "s1", index: 0 } }), mine[0]);
  await settle(A);
  expect((await state(A)).hands.s0).toEqual(mine);
  expect(JSON.stringify(await state(B))).toBe(JSON.stringify(await state(A)));
  // Mike opens his hand; now Ana can take
  await A.locator(".ct-lock-mine").click();
  await expect(B.locator('.ct-lock[data-seat="s0"]')).not.toHaveClass(/ct-locked/);
  c = await center(B, cardSel(mine[0]));
  await B.mouse.move(c.x, c.y); await B.mouse.down();
  await B.mouse.move(mid.x, mid.y, { steps: 6 }); await B.mouse.up();
  await settle(A);
  expect((await state(A)).hands.s0).toHaveLength(1);
  // undo takes back the move, not the unlocking
  await A.evaluate(() => window.cardTable.undo());
  await settle(A);
  expect((await state(A)).hands.s0).toEqual(mine);
  await expect(A.locator(".ct-lock-mine")).not.toHaveClass(/ct-locked/);
  await A.locator(".ct-lock-mine").click();
  await expect(B.locator('.ct-lock[data-seat="s0"]')).toHaveClass(/ct-locked/);
  // the host can open or close anyone's hand; a player only their own
  await expect(B.locator('.ct-lock[data-seat="s0"]')).not.toHaveClass(/ct-lock-click/);
  await B.evaluate(() => window.cardTable.dispatch({ type: "setHandLocked", seat: "s0", locked: false }));
  await settle(A);
  expect(await A.evaluate(() => !!window.cardTable.state.openHands?.s0)).toBe(false);
  await A.locator('.ct-lock[data-seat="s1"]').click();
  await expect(B.locator('.ct-lock[data-seat="s1"]')).not.toHaveClass(/ct-locked/);
  await A.locator('.ct-lock[data-seat="s1"]').click();
  await expect(B.locator('.ct-lock[data-seat="s1"]')).toHaveClass(/ct-locked/);
  expect([...A.errors, ...B.errors]).toEqual([]);
});

test("when the host closes the table, the others are told", async ({ context }) => {
  const { A, B } = await twoAtATable(context);
  await A.close();
  await expect(B.getByRole("heading", { name: "The host left" })).toBeVisible();
});

test("your name is remembered for next time", async ({ context }) => {
  const A = await tab(context);
  await host(A, "Mike");
  await A.goto("/index.html?net=local");
  await expect(A.locator("#ct-name")).toHaveValue("Mike");
});

test("Invite shows the table's link and a QR code", async ({ context }) => {
  const A = await tab(context);
  await host(A, "Mike");
  await A.getByRole("button", { name: "Invite" }).click();
  await expect(A.locator(".ct-share-url")).toHaveValue(A.url());
  await expect(A.locator(".ct-qr svg")).toHaveCount(1);
  await A.keyboard.press("Escape");
  await expect(A.locator(".ct-share")).toHaveCount(0);
});

test("pick a color with your name; a joiner asking for a taken one gets a free one", async ({ context }) => {
  const A = await tab(context), B = await tab(context);
  await A.goto("/index.html?net=local");
  await A.fill("#ct-name", "Mike");
  await A.locator('.ct-swatch[data-color="#84cc16"]').click();
  await A.getByRole("button", { name: "Open a table" }).click();
  await A.waitForFunction(() => !!window.cardTable?.session);
  expect((await state(A)).seats[0].color).toBe("#84cc16");
  await B.goto(A.url());
  await B.fill("#ct-name", "Ana");
  await B.locator('.ct-swatch[data-color="#84cc16"]').click();
  await B.getByRole("button", { name: "Join table" }).click();
  await B.waitForFunction(() => window.cardTable?.session?.connected);
  await seat(A, B, "Ana");
  const seats = (await state(A)).seats;
  expect(seats[1].name).toBe("Ana");
  expect(seats[1].color).not.toBe("#84cc16");
});

test("the pencil by your name changes your name and color for everyone", async ({ context }) => {
  const { A, B } = await twoAtATable(context);
  const mikeColor = (await state(A)).seats[0].color;
  await expect(A.locator(".ct-plate-edit")).toHaveCount(1);
  await B.locator(".ct-plate-edit").click();
  // Mike's color is taken; one nobody has isn't
  await expect(B.locator(`.ct-editor .ct-swatch[data-color="${mikeColor}"]`)).toBeDisabled();
  const used = (await state(B)).seats.map((x) => x.color);
  const open = await B.locator(".ct-editor .ct-swatch").evaluateAll((els, used) => els.map((e) => e.dataset.color).find((c) => !used.includes(c)), used);
  await expect(B.locator(`.ct-editor .ct-swatch[data-color="${open}"]`)).toBeEnabled();
  await B.fill("#ct-edit-name", "Ana B");
  await B.locator(`.ct-editor .ct-swatch[data-color="${open}"]`).click();
  await B.getByRole("button", { name: "Save" }).click();
  await settle(A);
  const s = await state(A);
  expect(s.seats[1].name).toBe("Ana B");
  expect(s.seats[1].color).toBe(open);
  await expect(A.locator(".ct-plate", { hasText: "Ana B" })).toBeVisible();
  expect(new Set(s.seats.map((x) => x.color)).size).toBe(s.seats.length);
});

test("while you look through a stack, the others see your ring on it but not the cards", async ({ context }) => {
  const { A, B } = await twoAtATable(context);
  // once seated, the view turns to the new seat; click the count after it has
  await settle(B);
  const g = await center(B, ".ct-grip");
  await B.mouse.click(g.x, g.y);
  await B.getByRole("button", { name: "Peek stack" }).click();
  await settle(A);
  expect(await B.locator(".ct-card .ct-index").count()).toBe(104);
  expect(await A.locator(".ct-card .ct-index").count()).toBe(0);
  await expect(A.locator(".ct-tag", { hasText: "Ana" })).toBeVisible();
  await B.keyboard.press("Escape");
  await settle(A);
  await expect(A.locator(".ct-tag")).toHaveCount(0);
});

test("a spectator can't move cards", async ({ context }) => {
  const A = await tab(context), B = await tab(context);
  await host(A, "Mike");
  await join(B, A.url(), "Ana");
  const top = (await state(B)).piles.deck.cards.at(-1);
  await B.mouse.move(...Object.values(await center(B, cardSel(top))));
  await B.mouse.down();
  const to = await at(B, CX + 150, CY - 48);
  await B.mouse.move(to.x, to.y, { steps: 8 });
  await B.mouse.up();
  await settle(A);
  expect((await state(A)).piles.deck.cards).toHaveLength(52);
  await expect(B.locator(".ct-menu")).toHaveCount(0);
});

test("the host can make a player a spectator, and kick someone off the table", async ({ context }) => {
  const { A, B } = await twoAtATable(context);
  await A.evaluate(() => window.cardTable.deal("deck", 2));
  await A.waitForTimeout(700);
  await A.locator('.ct-plate[data-seat="s1"]').click();
  await A.getByRole("button", { name: "Make spectator" }).click();
  await B.waitForFunction(() => !window.cardTable.session.seat);
  // the seat stays, empty, with Ana's cards in its hand
  const s = await state(A);
  expect(s.seats[1].player).toBeNull();
  expect(s.hands.s1).toHaveLength(2);
  await expect(A.locator(".ct-chip", { hasText: "Ana" })).toBeVisible();
  // kicking asks twice
  await A.locator(".ct-chip", { hasText: "Ana" }).click();
  await A.getByRole("button", { name: "Kick from the table" }).click();
  await A.getByRole("button", { name: "Kick Ana for good?" }).click();
  await expect(B.getByRole("heading", { name: "You were removed from the table" })).toBeVisible();
  await expect(A.locator(".ct-chip")).toHaveCount(0);
  // and can't come back to this table
  await B.goto(A.url());
  await expect(B.getByRole("heading", { name: "You were removed from the table" })).toBeVisible({ timeout: 10000 });
});

test("a table gets a 5-letter code; the home screen lists it, and joining by code works", async ({ context }) => {
  const A = await tab(context), B = await tab(context);
  await host(A, "Mike");
  const code = new URL(A.url()).hash.slice(1);
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
  await expect(A.locator("#codeTag")).toHaveText(code);
  // Ana types the code on the home screen
  await B.goto("/index.html?net=local");
  await B.locator(".ct-code-in").fill(code.toLowerCase());
  await expect(B.getByRole("button", { name: "Join table" })).toBeVisible();
  await B.fill("#ct-name", "Ana");
  await B.getByRole("button", { name: "Join table" }).click();
  await B.waitForFunction(() => window.cardTable?.session?.connected);
  await seat(A, B, "Ana");
  // both home screens list the table: Mike's as his, Ana's by its host's name
  await A.goto("/index.html?net=local");
  await expect(A.locator(".ct-recent a", { hasText: code })).toContainText("hosting");
  await B.goto("/index.html?net=local");
  await expect(B.locator(".ct-recent a", { hasText: code })).toContainText("Mike's table");
  // and one click takes Mike back to his table
  await A.locator(".ct-recent a", { hasText: code }).click();
  await A.waitForFunction(() => !!window.cardTable?.session);
  expect(new URL(A.url()).hash.slice(1)).toBe(code);
});

test("a code nobody is hosting says so", async ({ context }) => {
  const B = await tab(context);
  await B.goto("/index.html?net=local");
  await B.locator(".ct-code-in").fill("ZZZZZ");
  await B.fill("#ct-name", "Ana");
  await B.getByRole("button", { name: "Join table" }).click();
  await expect(B.getByRole("heading", { name: "Can't reach table ZZZZZ" })).toBeVisible({ timeout: 40000 });
});

test("with each tab a different player, two tabs are two people", async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem("card-table:settings", JSON.stringify({ tabsArePlayers: true })));
  const A = await tab(context), B = await tab(context);
  await A.goto("/index.html");
  await A.waitForFunction(() => !!window.cardTable);
  await B.goto("/index.html");
  await B.waitForFunction(() => !!window.cardTable);
  const a = await A.evaluate(() => [window.cardTable.tab, window.cardTable.player]);
  const b = await B.evaluate(() => [window.cardTable.tab, window.cardTable.player]);
  expect(a[0]).not.toBe(b[0]);
  expect(a[1]).not.toBe(b[1]);
  // the gear says which tab this is
  await B.locator(".ct-gate .ct-gear").click();
  await expect(B.getByRole("switch", { name: /Each tab is a different player/ })).toHaveAttribute("aria-checked", "true");
  await expect(B.locator(".ct-sheet-note")).toContainText("player tab");
});
