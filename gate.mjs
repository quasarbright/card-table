// The screens in front of the table: home (join with a code, open your own, your tables),
// putting your name in to join a friend's table, and what to do when a table can't be reached.
// A page of their own, over the table, the way my chips sketch does it.
import { SEAT_COLORS } from "./table.mjs";
import { faceSVG } from "./faces.mjs";

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

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const GEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
export const gearSVG = GEAR;

// four cards fanned over the wordmark: the deck's own art
const fan = () => `<div class="ct-fan" aria-hidden="true">${[["A", "S"], ["K", "H"], ["Q", "C"], ["J", "D"]].map(([r, s]) => faceSVG(r, s)).join("")}</div>`;
const hero = (sub = "") => `<div class="ct-hero">${sub ? fan() : ""}<h1 class="ct-wordmark" id="ct-gate-title">Card Table</h1>${sub ? `<p>${sub}</p>` : ""}</div>`;

// o.step: "home" | "name" | "connecting" | "unreachable" | "offline" | "full" | "kicked" | "lost"
// home: o.name, o.color, o.recent: [{ code, host, color, title }], o.open(name, color),
//   o.join(code), o.settings()
// name: o.code, o.name, o.color, o.done(name, color)
// the rest: o.code, o.retry(), o.home()
export function openGate(o) {
  if (!el) {
    el = document.createElement("div");
    el.className = "ct-gate";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "ct-gate-title");
    document.body.appendChild(el);
  }
  const show = (html, center = false) => {
    el.innerHTML = `${o.settings ? `<button class="ct-gear" data-settings title="Settings" aria-label="Settings">${GEAR}</button>` : ""}
      <div class="ct-screen${center ? " ct-center" : ""}">${html}</div>`;
    el.querySelector("[data-settings]")?.addEventListener("click", o.settings);
    el.scrollTop = 0;
  };
  const on = (sel, fn) => el.querySelector(sel)?.addEventListener("click", fn);

  if (o.step === "home") {
    const recent = o.recent ?? [];
    show(`${hero("A table and a deck of cards for any card game, with everyone at their own screen.")}
      <form class="ct-panel" data-code autocomplete="off" novalidate>
        <label class="ct-field" style="margin:0"><span>Join a table</span>
          <div class="ct-row">
            <input class="ct-text ct-code-in" name="code" placeholder="5-letter code" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="go" />
            <button class="ct-big" type="submit">Join</button>
          </div>
        </label>
        <div class="ct-err" data-err></div>
      </form>
      <div class="ct-or"><span>or open your own</span></div>
      <form class="ct-panel" data-open autocomplete="off">
        <label class="ct-field"><span>Your name</span><input id="ct-name" class="ct-text" maxlength="20" autocomplete="nickname" spellcheck="false" value="${esc(o.name)}" /></label>
        <div class="ct-field"><span class="ct-field-label">Your color</span>${swatches(o.color ?? SEAT_COLORS[0])}</div>
        <button class="ct-big" type="submit">Open a table</button>
      </form>
      ${recent.length ? `<div class="ct-recent"><h3>Your tables</h3>${recent.map((r) =>
        `<a href="#${esc(r.code)}"><span class="ct-dot" style="--seat:${esc(r.color || "#888")}"></span><span><b>${esc(r.code)}</b> · ${esc(r.title || "")}</span><small>${r.host ? "hosting" : "playing"}</small></a>`).join("")}</div>` : ""}
      <mike-footer></mike-footer>`);
    const codeForm = el.querySelector("[data-code]"), err = codeForm.querySelector("[data-err]");
    codeForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const raw = codeForm.code.value.trim();
      // a pasted link works too: what's after the #
      const c = (raw.includes("#") ? raw.slice(raw.lastIndexOf("#") + 1) : raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (c.length !== 5) { err.textContent = "Codes are 5 letters, like K7QXM."; codeForm.code.focus(); return; }
      o.join(c);
    });
    codeForm.code.addEventListener("input", (e) => {
      err.textContent = "";
      if (/^[a-z0-9]{5}$/i.test(e.target.value.trim())) codeForm.requestSubmit();
    });
    const openForm = el.querySelector("[data-open]"), input = openForm.querySelector("#ct-name"), go = openForm.querySelector("[type=submit]");
    let color = o.color ?? SEAT_COLORS[0];
    wireSwatches(openForm, (c) => { color = c; });
    const sync = () => { go.disabled = !input.value.trim(); };
    input.addEventListener("input", sync); sync();
    openForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (name) o.open(name, color);
    });
  } else if (o.step === "name") {
    show(`${hero(`Join table <b>${esc(o.code)}</b>. The others at the table see your name by your seat.`)}
      <form class="ct-panel" autocomplete="off">
        <label class="ct-field"><span>Your name</span><input id="ct-name" class="ct-text" maxlength="20" autocomplete="nickname" spellcheck="false" value="${esc(o.name)}" /></label>
        <div class="ct-field"><span class="ct-field-label">Pick a color</span>${swatches(o.color ?? SEAT_COLORS[0])}</div>
        <button class="ct-big" type="submit">Join table</button>
        <p style="margin:12px 0 0;font-size:.88rem">If someone at the table already has your color, you'll get a free one and can change it after.</p>
      </form>
      <button class="ct-soft" data-home>Back to your tables</button>`);
    const input = el.querySelector("#ct-name"), go = el.querySelector("[type=submit]");
    let color = o.color ?? SEAT_COLORS[0];
    wireSwatches(el, (c) => { color = c; });
    const sync = () => { go.disabled = !input.value.trim(); };
    input.addEventListener("input", sync); sync();
    el.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (name) o.done(name, color);
    });
    on("[data-home]", o.home);
    input.focus(); input.select();
  } else if (o.step === "connecting") {
    show(`${hero()}<div class="ct-spinner"></div><p style="color:var(--muted);font-weight:500">Finding table ${esc(o.code ?? "")}…</p>`, true);
  } else {
    const card = {
      unreachable: [`Can't reach table ${esc(o.code ?? "")}`, "The host needs to have the table open in their browser. Check that they do, or that the code is right.", "Try again", o.retry],
      offline: ["Can't get online", "The page couldn't download what it uses to connect players. Check your internet connection and try again.", "Try again", o.retry],
      full: ["This table is full", "Six people are already sitting at it.", null],
      kicked: ["You were removed from the table", "The host took you off this table.", null],
      lost: ["The host left", "A table stays open only while its host has it open. If they come back, reload this page to sit down again.", "Reload", () => location.reload()],
    }[o.step];
    show(`${hero()}<div class="ct-panel"><h2>${card[0]}</h2><p>${card[1]}</p>
      ${card[2] ? `<button class="ct-big" data-go>${card[2]}</button>` : ""}
      <button class="${card[2] ? "ct-soft" : "ct-big"}" data-home>Back to your tables</button></div>`, true);
    on("[data-go]", card[3]);
    on("[data-home]", o.home);
  }
}

export function closeGate() { el?.remove(); el = null; }

// the settings sheet: each tab its own player, for trying a table alone on one computer
export function openSettings({ tabsArePlayers, slot, onToggle }) {
  const back = document.createElement("div");
  back.className = "ct-sheet-back";
  back.innerHTML = `<div class="ct-sheet" role="dialog" aria-modal="true" aria-label="Settings">
    <div class="ct-sheet-head"><h3>Settings</h3><button class="ct-x" data-x aria-label="Close">×</button></div>
    <button class="ct-switch-row" role="switch" aria-checked="${tabsArePlayers}" data-tabs>
      <span><b>Each tab is a different player</b><small>For trying out a table alone on one computer. When it's off, every tab in this browser is you.</small></span>
      <span class="ct-switch"></span>
    </button>
    ${tabsArePlayers ? `<p class="ct-sheet-note">This tab is ${slot ? `player tab ${slot + 1}` : "your main tab"}.</p>` : ""}
  </div>`;
  document.body.appendChild(back);
  const close = () => { back.remove(); removeEventListener("keydown", esc_); };
  const esc_ = (e) => { if (e.key === "Escape") close(); };
  addEventListener("keydown", esc_);
  back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-x]")) close(); });
  back.querySelector("[data-tabs]").addEventListener("click", (e) => {
    const b = e.currentTarget, next = b.getAttribute("aria-checked") !== "true";
    b.setAttribute("aria-checked", next);
    onToggle(next);
  });
}
