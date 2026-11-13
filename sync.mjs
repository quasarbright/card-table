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
//   session.undo(), session.canUndo()   take back the table's last change, whoever made it
import { apply, MAX_SEATS } from "./table.mjs";

const HISTORY = 300;
// who sits where isn't part of the game: undo never takes it back, and it's written into
// every earlier table too, so undoing past someone's arrival keeps them seated
const SEATING = new Set(["sit", "stand", "setSeats", "setPlayer"]);

// People who join start out watching. The host can give them a seat, ask a seated player to
// watch instead, or send someone away for good (while this table is open).
//
// me: { player, name, color }; hooks: { onChange(state, fx), onRoster({ online, watchers }), save(state) }
export function hostSession(net, state, me, hooks) {
  const past = [];                 // [{ state, by }] before each change, newest last
  const peers = new Map();         // peer id → player id
  const people = new Map([[me.player, { name: me.name, color: me.color }]]); // player → name, color
  const banned = new Set();
  const seatOf = (player) => state.seats.find((s) => s.player === player)?.id ?? null;

  function commit(action, by, fx = null, id = null, from = null) {
    let next;
    try { next = apply(state, action); } catch {
      if (from) net.send("reject", { id }, from);
      return false;
    }
    if (SEATING.has(action.type)) {
      for (const p of past) { try { p.state = apply(p.state, action); } catch {} }
    } else {
      past.push({ state, by });
      if (past.length > HISTORY) past.shift();
    }
    state = next;
    hooks.save(state);
    net.send("applied", { action, by, id, fx, depth: past.length });
    hooks.onChange(state, fx, by);
    return true;
  }

  function online() { return [me.player, ...new Set(peers.values())]; }
  // who's connected, and who of them is watching rather than sitting
  function roster() {
    const list = online();
    const r = { online: list, watchers: list.filter((p) => !seatOf(p)).map((p) => ({ player: p, ...people.get(p) })) };
    net.send("roster", r); hooks.onRoster(r);
  }
  // a seat for someone: an empty one, or a new one if there's room
  function seatPlayer(player) {
    if (seatOf(player) || !people.has(player)) return;
    let seat = state.seats.find((s) => !s.player)?.id;
    if (!seat && state.seats.length < MAX_SEATS) {
      commit({ type: "setSeats", n: state.seats.length + 1 }, null);
      seat = state.seats.at(-1).id;
    }
    if (!seat) return;
    const { name, color } = people.get(player);
    commit({ type: "sit", seat, player, name, color }, null);
    roster();
  }
  // their seat stays, empty, with whatever is in its hand
  function unseat(player) {
    const seat = seatOf(player);
    if (!seat || player === me.player) return;
    commit({ type: "stand", seat }, null);
    roster();
  }
  function kick(player) {
    if (player === me.player) return;
    unseat(player);
    banned.add(player);
    for (const [peer, p] of peers) if (p === player) { net.send("kicked", {}, peer); peers.delete(peer); }
    roster();
  }

  function undo() {
    if (!past.length) return;
    state = past.pop().state;
    hooks.save(state);
    net.send("reset", { state, depth: past.length });
    hooks.onChange(state, null, null);
  }

  // someone arrives: back in the seat they had, or watching
  net.on("hello", ({ player, name, color }, peer) => {
    if (banned.has(player)) { net.send("kicked", {}, peer); return; }
    peers.set(peer, player);
    people.set(player, { name, color });
    net.send("welcome", { state, depth: past.length }, peer);
    roster();
  });
  // only people with a seat touch the table
  net.on("act", ({ id, action, fx }, peer) => {
    const seat = seatOf(peers.get(peer));
    if (seat) commit(action, seat, fx, id, peer);
    else net.send("reject", { id }, peer);
  });
  net.on("undo", (_, peer) => { if (seatOf(peers.get(peer))) undo(); });
  net.onLeave((peer) => { if (peers.delete(peer)) roster(); });

  return {
    isHost: true,
    get state() { return state; },
    get seat() { return seatOf(me.player); },
    dispatch(action, fx) { commit(action, seatOf(me.player), fx); },
    undo,
    canUndo() { return past.length > 0; },
    online, seatPlayer, unseat, kick,
    canSeat: () => state.seats.some((s) => !s.player) || state.seats.length < MAX_SEATS,
    // start over from this table, with no history (tests)
    replace(next) {
      past.length = 0; state = next; hooks.save(state);
      net.send("reset", { state, depth: 0 });
      hooks.onChange(state, { instant: true }, null);
    },
  };
}

// hooks: { onChange(state, fx, by), onWelcome(), onRoster({ online, watchers }), onLost(), onKicked() }
export function clientSession(net, me, hooks) {
  let confirmed = null, pending = [], shown = null;
  let host = null, depth = 0, counter = 0; // depth: how many changes the host can undo
  const mySeat = () => shown?.seats.find((s) => s.player === me.player)?.id ?? null;

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
    host = peer; confirmed = m.state; depth = m.depth; pending = [];
    rebuild();
    hooks.onWelcome();
    hooks.onChange(shown, { instant: true }, null);
  });
  net.on("applied", (m, peer) => {
    if (peer !== host || !confirmed) return;
    try { confirmed = apply(confirmed, m.action); } catch { hello(host); return; } // out of step: start over
    const mine = pending.some((p) => p.id === m.id);
    pending = pending.filter((p) => p.id !== m.id);
    depth = m.depth;
    rebuild();
    // your own change already played its animation when you made it
    hooks.onChange(shown, mine ? null : m.fx, m.by);
  });
  net.on("reject", (m) => { pending = pending.filter((p) => p.id !== m.id); rebuild(); hooks.onChange(shown, null, null); });
  net.on("reset", (m, peer) => {
    if (peer !== host) return;
    confirmed = m.state; depth = m.depth; pending = [];
    rebuild();
    hooks.onChange(shown, null, null);
  });
  net.on("roster", (r, peer) => { if (peer === host) hooks.onRoster(r); });
  net.on("kicked", (_, peer) => { if (!host || peer === host) { host = null; net.leave(); hooks.onKicked(); } });
  net.onLeave((peer) => { if (peer === host) hooks.onLost(); });

  return {
    isHost: false,
    get state() { return shown; },
    get seat() { return mySeat(); },
    get connected() { return !!confirmed; },
    dispatch(action, fx) {
      if (!confirmed || !mySeat()) return;
      const id = `${me.player}:${counter++}`;
      pending.push({ id, action });
      rebuild();
      hooks.onChange(shown, fx, mySeat());
      net.send("act", { id, action, fx }, host);
    },
    undo() { if (this.canUndo()) net.send("undo", {}, host); },
    canUndo() { return !!mySeat() && depth > 0 && !pending.length; },
  };
}
