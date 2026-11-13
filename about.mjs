// The about modal's diagram: one small two-player table, drawn twice by the real view, once
// from each seat. A short script of real actions plays on a loop.
import { newTable, apply } from "./table.mjs";
import { createView } from "./view.mjs";

const STEPS = [
  [null, "A face-down deck. Nobody can see any card."],
  [() => ({ type: "deal", pile: "deck", count: 3, seats: ["s0", "s1"] }),
    "Three cards dealt to each player. You see your own hand and the backs of theirs."],
  [(s) => ({ type: "moveCards", cards: [s.piles.deck.cards.at(-1)], to: { newPile: { id: "c", x: 640, y: 470, rot: 0 } } }),
    "A card goes face down on the table."],
  [() => ({ type: "setPrivate", cards: [cardIn("c")], seat: "s1" }),
    "Player 2 looks at it. It tips toward them, and only they see its face."],
  [() => ({ type: "flip", cards: [cardIn("c")] }),
    "Turned face up, it lies flat and everyone sees it."],
  [(s) => ({ type: "flip", cards: [s.hands.s0[1]] }),
    "Player 1 shows everyone a card from their hand."],
];
let state, cardIn;

export function startAboutDiagram() {
  let views = [], timer = null, step = 0, caption = null;
  const run = () => {
    if (step === 0) state = newTable(2);
    cardIn = (pile) => state.piles[pile].cards.at(-1);
    const [make, text] = STEPS[step];
    if (make) state = apply(state, make(state));
    for (const v of views) v.render(state, { instant: step === 0 });
    if (caption) caption.textContent = text;
    step = (step + 1) % STEPS.length;
    timer = setTimeout(run, step === 0 ? 3200 : 2200);
  };
  document.addEventListener("cohesion-modal-open", (e) => {
    if (!e.detail.className?.includes("cohesion-about")) return;
    const el = e.detail.el;
    caption = el.querySelector("#ct-about-caption");
    views = [...el.querySelectorAll(".ct-mini")].map((m) => createView(m, { viewer: m.dataset.seat, interactive: false }));
    requestAnimationFrame(() => {
      for (const v of views) v.layout();
      step = 0;
      run();
    });
  });
  document.addEventListener("cohesion-modal-close", (e) => {
    if (!e.detail.className?.includes("cohesion-about")) return;
    clearTimeout(timer); views = [];
  });
}
