// The table's history: every change, one line each, newest first, in a panel that opens from the
// clock button at the top right. The host can rewind to any line (the later ones stay, crossed
// out) and restore forward again, the way my chips sketch does it; the next new change drops the
// crossed-out lines. Undo, for anyone at the table, is a rewind of one line.
import { chipTotal } from "./table.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => Number(n).toLocaleString("en-US");

// a line's parts as HTML: players in their color (by their name now, if they're still here),
// amounts in gold, cards with their suit's color
export function partsHTML(parts, state) {
  return parts.map((x) => {
    if (typeof x === "string") return esc(x);
    if (x.a != null) return `<b class="ct-h-amt">${fmt(x.a)}</b>`;
    if (x.card) return `<b class="ct-h-card${/[♥♦]/.test(x.card) ? " ct-h-red" : ""}">${esc(x.card)}</b>`;
    if (x.r === "p") {
      const seat = x.id ? state?.seats.find((s) => s.player === x.id) : null;
      return `<b style="color:${seat?.color ?? x.c ?? "inherit"}">${esc(seat?.name ?? x.n)}</b>`;
    }
    if (x.r === "pot") return `<b>${esc(state?.bank?.pots.find((p) => p.id === x.id)?.name ?? x.n)}</b>`;
    return "";
  }).join("");
}

// ctx: { session(), state() }
export function createHistory(ctx, button) {
  let panel = null, limit = 40;
  const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "");

  function render() {
    if (!panel) return;
    const s = ctx.session(), log = s?.log ?? [], h = log.findIndex((e) => e.id === s?.head);
    const host = !!s?.isHost, from = Math.max(0, log.length - limit);
    const btn = (e, i) => !host || i === h ? "" : `<button class="ct-h-go" data-goto="${esc(e.id)}">${i < h ? "rewind to here" : "restore to here"}</button>`;
    const list = log.slice(from).map((e, k) => {
      const i = from + k;
      return `<li class="${i > h ? "ct-h-rewound" : ""}${i === h ? " ct-h-head" : ""}"><span class="ct-h-t">${time(e.ts)}</span><span class="ct-h-x">${partsHTML(e.parts, ctx.state())}</span>${btn(e, i)}</li>`;
    }).reverse().join("");
    const bank = ctx.state()?.bank;
    panel.querySelector("[data-list]").innerHTML = list
      ? list + (log.length > limit ? `<li><button class="ct-h-more" data-more>Show more</button></li>` : "")
      : `<li class="ct-h-empty">Nothing has happened at this table yet.</li>`;
    panel.querySelector("[data-foot]").textContent = [
      host ? "Rewind takes the whole table back, cards and chips; restore brings it forward again." : "The host can rewind the table to any line.",
      bank ? `${fmt(chipTotal(ctx.state()))} chips on the table.` : "",
    ].filter(Boolean).join(" ");
  }

  function open() {
    if (panel) return close();
    panel = document.createElement("div");
    panel.className = "ct-history";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "History");
    panel.innerHTML = `<div class="ct-sheet-head"><h3>History</h3><button class="ct-x" data-close aria-label="Close">×</button></div>
      <ol class="ct-h-list" data-list></ol><p class="ct-h-foot" data-foot></p>`;
    document.body.appendChild(panel);
    button.setAttribute("aria-expanded", "true");
    panel.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return close();
      if (e.target.closest("[data-more]")) { limit += 60; render(); return; }
      const go = e.target.closest("[data-goto]");
      if (go) ctx.session()?.goto(go.dataset.goto);
    });
    setTimeout(() => addEventListener("pointerdown", away));
    render();
  }
  function close() {
    panel?.remove(); panel = null;
    button.setAttribute("aria-expanded", "false");
    removeEventListener("pointerdown", away);
  }
  // a press anywhere else closes it (but not one on the table's own controls, like undo)
  function away(e) { if (panel && !panel.contains(e.target) && !button.contains(e.target) && !e.target.closest?.(".ct-bar")) close(); }
  button.addEventListener("click", open);
  addEventListener("keydown", (e) => { if (e.key === "Escape" && panel) close(); });
  return { render, open, close, get isOpen() { return !!panel; } };
}
