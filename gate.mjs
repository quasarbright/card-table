// The screen in front of the table before you're sitting at it: host a table, or put your name
// in to join a friend's from their link; and what to do when a table can't be reached.
import { SEAT_COLORS } from "./table.mjs";

let el = null;

// a row of color swatches, one checked; taken: { color: who has it }
export function swatches(selected, taken = {}) {
  return `<div class="ct-swatches" role="radiogroup" aria-label="Your color">` + SEAT_COLORS.map((c) => {
    const who = taken[c];
    return `<button type="button" role="radio" class="ct-swatch" style="--seat:${c}" data-color="${c}" aria-checked="${c === selected}"` +
      (who ? ` disabled title="${esc(who)} has this color"` : ` title="Pick this color"`) + `></button>`;
  }).join("") + `</div>`;
}
export function wireSwatches(root, onPick) {
  root.querySelectorAll(".ct-swatch").forEach((b) => b.addEventListener("click", () => {
    root.querySelectorAll(".ct-swatch").forEach((x) => x.setAttribute("aria-checked", x === b));
    onPick(b.dataset.color);
  }));
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// o.step: "start" | "name" | "connecting" | "unreachable" | "full" | "kicked" | "lost"
// o.name, o.color: what to fill in; o.done(name, color): confirmed; o.joining: joining rather than hosting;
// o.retry(), o.host(): the buttons on the error screens
export function openGate(o) {
  if (!el) {
    el = document.createElement("div");
    el.className = "ct-gate";
    el.innerHTML = `<div class="ct-gate-card" role="dialog" aria-modal="true" aria-labelledby="ct-gate-title"></div>`;
    document.body.appendChild(el);
  }
  const card = el.firstChild;
  const show = (html) => { card.innerHTML = html; };
  if (o.step === "start") {
    show(`
      <h1 id="ct-gate-title">Card Table</h1>
      <p>A table and a deck of cards for any card game. Everyone plays from their own screen and sees the cards move as they're played.</p>
      <button class="ct-act ct-act-ink" data-go>Host a table</button>
      <p class="ct-gate-note">Joining a friend's table? Ask them to send you their link.</p>`);
    card.querySelector("[data-go]").addEventListener("click", () => openGate({ ...o, step: "name" }));
  } else if (o.step === "name") {
    show(`
      <h1 id="ct-gate-title">${o.joining ? "Join a table" : "Host a table"}</h1>
      <form class="ct-gate-form">
        <label for="ct-name">Your name</label>
        <input id="ct-name" maxlength="20" autocomplete="nickname" spellcheck="false" value="${esc(o.name ?? "")}" />
        <label>Your color</label>
        ${swatches(o.color ?? SEAT_COLORS[0])}
        ${o.joining ? `<p class="ct-gate-note ct-gate-tight">If someone at the table already has it, you'll get a free one and can change it after.</p>` : ""}
        <button class="ct-act ct-act-ink" type="submit">${o.joining ? "Join table" : "Host table"}</button>
      </form>
      ${o.joining ? `<p class="ct-gate-note">The others at the table see this name by your seat.</p>`
        : `<p class="ct-gate-note">Next you'll get a link to send to the people you're playing with. <button type="button" class="ct-gate-back" data-back>Back</button></p>`}`);
    const input = card.querySelector("input"), go = card.querySelector("[type=submit]");
    let color = o.color ?? SEAT_COLORS[0];
    wireSwatches(card, (c) => { color = c; });
    const sync = () => { go.disabled = !input.value.trim(); };
    input.addEventListener("input", sync); sync();
    card.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (name) o.done(name, color);
    });
    card.querySelector("[data-back]")?.addEventListener("click", () => openGate({ ...o, name: input.value, color, step: "start" }));
    input.focus(); input.select();
  } else if (o.step === "connecting") {
    show(`<h1 id="ct-gate-title">Finding the table…</h1>
      <p>Connecting to the host. This usually takes a few seconds.</p><div class="ct-dots" aria-hidden="true"><i></i><i></i><i></i></div>`);
  } else if (o.step === "unreachable") {
    show(`<h1 id="ct-gate-title">Can't reach this table</h1>
      <p>The host needs to have the table open in their browser. Check that they do, or ask them to send the link again.</p>
      <button class="ct-act ct-act-ink" data-go>Try again</button>`);
    card.querySelector("[data-go]").addEventListener("click", o.retry);
  } else if (o.step === "full") {
    show(`<h1 id="ct-gate-title">This table is full</h1>
      <p>Six people are already sitting at it.</p>
      <button class="ct-act ct-act-ink" data-go>Host your own table</button>`);
    card.querySelector("[data-go]").addEventListener("click", o.host);
  } else if (o.step === "kicked") {
    show(`<h1 id="ct-gate-title">You were removed from the table</h1>
      <p>The host took you off this table. You can host one of your own.</p>
      <button class="ct-act ct-act-ink" data-go>Host your own table</button>`);
    card.querySelector("[data-go]").addEventListener("click", o.host);
  } else if (o.step === "lost") {
    show(`<h1 id="ct-gate-title">The host left</h1>
      <p>A table stays open only while its host has it open. If they come back, reload this page to sit down again.</p>
      <button class="ct-act" data-retry>Reload</button>
      <button class="ct-act ct-act-ink" data-go>Host your own table</button>`);
    card.querySelector("[data-retry]").addEventListener("click", () => location.reload());
    card.querySelector("[data-go]").addEventListener("click", o.host);
  }
}

export function closeGate() { el?.remove(); el = null; }
