// Keeping everyone's table the same.
//
// The host's browser holds the one true table. Every change (a table action from table.mjs)
// goes to the host, which applies them in the order they arrive and sends each one to
// everybody. Applying the same actions in the same order gives the same table everywhere.
//
// A player doesn't wait for the round trip to see their own change: it's applied at once on
// top of the last table the host confirmed, and set aside when the host's copy comes back (or
// dropped if the host refused it).
//
// Both sessions look the same to the page:
//   session.state            the table to draw
//   session.seat             the seat you're sitting in
//   session.dispatch(action, fx)   fx: how to animate it (passed along to everyone)
//   session.undo(), session.canUndo()   take back your own last change, if nobody moved since
import { apply, MAX_SEATS } from "./table.mjs";

const HISTORY = 300;

// me: { player, name, color }; hooks: { onChange(state, fx), onRoster(players), save(state) }
export function hostSession(net, state, me, hooks) {
  const past = [];                 // [{ state, by }] before each change, newest last
  const peers = new Map();         // peer id → player id
  const seatOf = (player) => state.seats.find((s) => s.player === player)?.id ?? null;

  function commit(action, by, fx = null, id = null, from = null) {
    let next;
    try { next = apply(state, action); } catch {
      if (from) net.send("reject", { id }, from);
      return false;
    }
    past.push({ state, by });
    if (past.length > HISTORY) past.shift();
    state = next;
    hooks.save(state);
    net.send("applied", { action, by, id, fx });
    hooks.onChange(state, fx, by);
    return true;
  }

  function online() { return [me.player, ...new Set(peers.values())]; }
  function roster() { const list = online(); net.send("roster", list); hooks.onRoster(list); }

  function undoBy(seat) {
    if (!seat || past.at(-1)?.by !== seat) return;
    state = past.pop().state;
    hooks.save(state);
    net.send("reset", { state, lastBy: past.at(-1)?.by ?? null });
    hooks.onChange(state, null, null);
  }

  // someone arrives: find them their seat (the one they had, an empty one, or a new one)
  net.on("hello", ({ player, name, color }, peer) => {
    peers.set(peer, player);
    let seat = seatOf(player) ?? state.seats.find((s) => !s.player)?.id;
    if (!seat && state.seats.length < MAX_SEATS) {
      commit({ type: "setSeats", n: state.seats.length + 1 }, null);
      seat = state.seats.at(-1).id;
    }
    if (seat) commit({ type: "sit", seat, player, name, color }, null);
    net.send("welcome", { state, seat: seat ?? null, lastBy: past.at(-1)?.by ?? null }, peer);
    roster();
  });
  net.on("act", ({ id, action, fx }, peer) => {
    const player = peers.get(peer);
    if (player) commit(action, seatOf(player), fx, id, peer);
  });
  net.on("undo", (_, peer) => undoBy(seatOf(peers.get(peer))));
  net.onLeave((peer) => { if (peers.delete(peer)) roster(); });

  return {
    isHost: true,
    get state() { return state; },
    get seat() { return seatOf(me.player); },
    dispatch(action, fx) { commit(action, seatOf(me.player), fx); },
    undo() { undoBy(seatOf(me.player)); },
    canUndo() { const s = seatOf(me.player); return !!s && past.at(-1)?.by === s; },
    online,
    // start over from this table, with no history (tests)
    replace(next) {
      past.length = 0; state = next; hooks.save(state);
      net.send("reset", { state, lastBy: null });
      hooks.onChange(state, { instant: true }, null);
    },
  };
}

// hooks: { onChange(state, fx, by), onWelcome(seat), onRoster(players), onLost() }
export function clientSession(net, me, hooks) {
  let confirmed = null, pending = [], shown = null;
  let host = null, seat = null, lastBy = null, counter = 0;

  // your changes the host hasn't confirmed yet, replayed on top of what it has
  function rebuild() {
    let s = confirmed;
    pending = pending.filter((p) => {
      try { s = apply(s, p.action); return true; } catch { return false; }
    });
    shown = s;
  }
  const hello = (peer) => net.send("hello", { player: me.player, name: me.name, color: me.color }, peer);

  net.onJoin(hello);
  net.on("welcome", (m, peer) => {
    host = peer; confirmed = m.state; seat = m.seat; lastBy = m.lastBy; pending = [];
    rebuild();
    hooks.onWelcome(seat);
    hooks.onChange(shown, { instant: true }, null);
  });
  net.on("applied", (m, peer) => {
    if (peer !== host || !confirmed) return;
    try { confirmed = apply(confirmed, m.action); } catch { hello(host); return; } // out of step: start over
    const mine = pending.some((p) => p.id === m.id);
    pending = pending.filter((p) => p.id !== m.id);
    lastBy = m.by;
    rebuild();
    // your own change already played its animation when you made it
    hooks.onChange(shown, mine ? null : m.fx, m.by);
  });
  net.on("reject", (m) => { pending = pending.filter((p) => p.id !== m.id); rebuild(); hooks.onChange(shown, null, null); });
  net.on("reset", (m, peer) => {
    if (peer !== host) return;
    confirmed = m.state; lastBy = m.lastBy; pending = [];
    rebuild();
    hooks.onChange(shown, null, null);
  });
  net.on("roster", (list, peer) => { if (peer === host) hooks.onRoster(list); });
  net.onLeave((peer) => { if (peer === host) hooks.onLost(); });

  return {
    isHost: false,
    get state() { return shown; },
    get seat() { return seat; },
    get connected() { return !!confirmed; },
    dispatch(action, fx) {
      if (!confirmed) return;
      const id = `${me.player}:${counter++}`;
      pending.push({ id, action });
      rebuild();
      hooks.onChange(shown, fx, seat);
      net.send("act", { id, action, fx }, host);
    },
    undo() { if (this.canUndo()) net.send("undo", {}, host); },
    canUndo() { return !!seat && lastBy === seat && !pending.length; },
  };
}
