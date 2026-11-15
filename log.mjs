// What each change to the table says in the history: one short line, the way my chips sketch
// logs money. A line is a list of parts: plain strings, { r: "p", id, n, c } for a player (their
// name and color then), { r: "pot", id, n } for a pot, { a: n } for an amount, { card } for a card.
// A card is only named when everyone can see it; otherwise the line just counts cards, so the
// history never gives away a card someone is hiding.
import { locate, potOf } from "./table.mjs";

const SUIT = { S: "♠", H: "♥", D: "♦", C: "♣" };
export const cardName = (c) => `${c.rank}${SUIT[c.suit]}`;

const seatOf = (st, seatId) => st.seats.find((x) => x.id === seatId);
const playerRef = (st, playerId) => {
  const seat = st.seats.find((x) => x.player === playerId);
  return { r: "p", id: playerId, n: seat?.name ?? "someone", c: seat?.color };
};
const seatRef = (st, seatId) => {
  const seat = seatOf(st, seatId);
  return seat?.player ? playerRef(st, seat.player) : { r: "p", id: null, n: seat?.name ?? "someone", c: seat?.color };
};
const potRef = (st, id) => ({ r: "pot", id, n: potOf(st, id)?.name ?? "the pot" });
const stackRef = (st, ref) => (ref.k === "pot" ? potRef(st, ref.id) : playerRef(st, ref.id));
const amt = (a) => ({ a });
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// cards everyone can see after the change: face up, and not hidden in a hand
function shown(after, ids) {
  return ids.every((id) => {
    const c = after.cards[id], where = locate(after, id);
    return c?.faceUp && !(where?.hand && !after.shownHands?.[where.hand]);
  });
}
// the cards themselves when everyone can see them (and there are only a few), else how many
function cardsPart(after, ids, few = 3) {
  if (ids.length <= few && shown(after, ids)) {
    const out = [];
    ids.forEach((id, i) => { if (i) out.push(i === ids.length - 1 ? " and " : ", "); out.push({ card: cardName(after.cards[id]) }); });
    return out;
  }
  return [ids.length === 1 ? "a card" : plural(ids.length, "card")];
}

// the line for `action`, made by seat `by`, which turned `before` into `after`
export function describe(before, action, by, after) {
  const who = seatRef(before, by);
  const line = (...parts) => [who, ...parts];
  // a batch reads as its first real step (a drop and a flip, a move and a spread)
  if (action.type === "batch") {
    const main = action.actions.find((a) => !["setLook", "setMessy", "flip"].includes(a.type)) ?? action.actions[0];
    return main ? describe(before, main, by, after) : line(" changed the table");
  }
  switch (action.type) {
    case "moveCards": {
      const ids = action.cards, from = locate(before, ids[0]), to = action.to;
      if (to.hand) {
        if (from?.hand === to.hand) return line(" rearranged ", to.hand === by ? "their hand" : [seatRef(before, to.hand), "'s hand"]).flat();
        if (to.hand === by) return line(" took ", ...cardsPart(before, ids), from?.hand ? [" from ", seatRef(before, from.hand)] : []).flat();
        return line(" gave ", seatRef(before, to.hand), " ", ...cardsPart(after, ids)).flat();
      }
      const what = cardsPart(after, ids);
      if (from?.hand) return line(from.hand === by ? " played " : " took ", ...what, from.hand === by ? [] : [" from ", seatRef(before, from.hand)]).flat();
      if (to.pile && from?.pile === to.pile) return line(" rearranged a stack");
      return line(" moved ", ...what);
    }
    case "movePile": return line(" moved ", ids(before, action.pile));
    case "flip": {
      const up = action.cards.filter((id) => after.cards[id]?.faceUp);
      if (up.length === action.cards.length) return line(" turned over ", ...cardsPart(after, action.cards));
      if (!up.length) return line(" turned ", ...cardsPart(before, action.cards), " face down");
      return line(" turned over ", plural(action.cards.length, "card"));
    }
    case "flipPile": return line(" turned over ", ids(before, action.pile));
    case "setPrivate": return line(action.seat ? " peeked at a card" : " stopped peeking");
    case "shuffle": return line(" shuffled ", ids(before, action.pile));
    case "deal": return line(" dealt ", plural(action.count, "card"), " each");
    case "split": return line(" cut ", ids(before, action.pile), ` into ${action.parts.length}`);
    case "gather": return line(" gathered all the cards");
    case "setHandShown": return action.seat === by ? line(action.shown ? " showed their hand" : " picked their hand back up")
      : line(action.shown ? " showed " : " picked up ", seatRef(before, action.seat), "'s hand");
    case "setLook": return line(action.look === "spread" ? " spread out a stack" : action.look === "few" ? " fanned out a stack" : " squared up a stack");
    case "setMessy": return line(action.messy ? " fanned out a stack" : " squared up a stack");
    // chips, as my chips sketch says them
    case "startChips": return line(" handed out chips: ", amt(action.start), " each");
    case "endChips": return line(" removed all chips");
    case "transfer": {
      const own = action.from.k === "p" && action.from.id === seatOf(before, by)?.player;
      if (own) return line(action.to.k === "pot" ? " bet " : " gave ", amt(action.amount), " → ", stackRef(before, action.to));
      return line(" moved ", amt(action.amount), " from ", stackRef(before, action.from), " → ", stackRef(before, action.to));
    }
    case "award": {
      const p = potOf(before, action.pot), n = action.winners.length;
      const share = Math.floor((p?.chips ?? 0) / n), left = (p?.chips ?? 0) - share * n;
      const names = [];
      action.winners.forEach((id, i) => { if (i) names.push(i === n - 1 ? " & " : ", "); names.push(playerRef(before, id)); });
      return [potRef(before, action.pot), " → ", ...names, " ", amt(share), ...(n > 1 ? [" each"] : []), ...(left ? [` (${left} left in the pot)`] : [])];
    }
    case "refund": return [potRef(before, action.pot), " given back to whoever put chips in"];
    case "setChips": {
      const was = action.target.k === "pot" ? potOf(before, action.target.id)?.chips ?? 0 : before.bank?.chips[action.target.id] ?? 0;
      const d = action.amount - was;
      return line(" set ", stackRef(before, action.target), " to ", amt(action.amount), d ? ` (${d > 0 ? "+" : "−"}${Math.abs(d)})` : "");
    }
    case "giveAll": return line(" gave everyone ", amt(action.amount), " more");
    case "setStart": return line(" set new players' chips to ", amt(action.amount));
    case "addPot": return line(" added ", { r: "pot", id: action.id, n: potOf(after, action.id)?.name ?? "a pot" });
    case "renamePot": return line(" renamed a pot ", potRef(after, action.id));
    case "removePot": return line(" removed ", potRef(before, action.id));
    default: return line(" changed the table");
  }
}
// "a stack of 12" (or "the deck")
function ids(st, pileId) {
  const n = st.piles[pileId]?.cards.length ?? 0;
  return pileId === "deck" ? "the deck" : n === 1 ? "a card" : `a stack of ${n}`;
}

// money moved: the lines worth a note by the pot
export const MONEY = new Set(["transfer", "award", "refund", "setChips", "giveAll", "startChips"]);
export function isMoney(action) {
  if (action.type === "batch") return action.actions.some(isMoney);
  return MONEY.has(action.type);
}
