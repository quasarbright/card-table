// How players' browsers talk to each other. Two transports with the same shape:
//   trystero: real peer-to-peer (WebRTC data channels), introduced through public Nostr relays
//   local:    a BroadcastChannel between tabs of one browser, for tests (?net=local)
//
// connect(roomId, kind) → net, with
//   net.selfId                 this browser's id in the room
//   net.on(type, fn)           fn(data, fromPeer) for each message of that type
//   net.onJoin(fn), onLeave(fn)
//   net.start()                begin finding peers (after the handlers are in place); a promise
//   net.send(type, data, to?)  to one peer, or to everyone
//   net.leave()

const TRYSTERO = "https://cdn.jsdelivr.net/npm/trystero@0.26.0/+esm";
const APP_ID = "quasarbright-card-table";
// The Nostr relays that introduce players to each other. Trystero's built-in list includes some
// that are gone (they fill the console with failed connections). Each of these paired two
// browsers on its own when picked (2026-11); several big ones didn't (nos.lol, nostr.mom), and
// some refuse Trystero's messages. Every player has to use the same list.
const RELAYS = [
  "wss://relay.primal.net", "wss://relay.snort.social", "wss://cdn.satellite.earth",
  "wss://relay.nostr.blockhenge.com", "wss://relay.agentry.com", "wss://nostrcity-club.fly.dev",
];

export function connect(roomId, kind = "trystero") {
  return kind === "local" ? localNet(roomId) : trysteroNet(roomId);
}

function hub() {
  const handlers = new Map(), joins = [], leaves = [];
  return {
    handlers, joins, leaves,
    api: {
      on(type, fn) { handlers.set(type, fn); },
      onJoin(fn) { joins.push(fn); },
      onLeave(fn) { leaves.push(fn); },
    },
  };
}

function trysteroNet(roomId) {
  const h = hub();
  let room = null;
  const actions = new Map();
  const action = (type) => {
    if (!actions.has(type)) {
      const a = room.makeAction(type);
      a.onMessage = (data, { peerId }) => h.handlers.get(type)?.(data, peerId);
      actions.set(type, a);
    }
    return actions.get(type);
  };
  const net = {
    ...h.api,
    selfId: null,
    // rejects if the peer-to-peer library can't be downloaded (after one retry)
    async start() {
      const t = await import(TRYSTERO).catch(() => new Promise((r) => setTimeout(r, 1500)).then(() => import(TRYSTERO)));
      net.selfId = t.selfId;
      room = t.joinRoom({ appId: APP_ID, relayConfig: { urls: RELAYS } }, roomId);
      for (const type of h.handlers.keys()) action(type);
      room.onPeerJoin = (id) => h.joins.forEach((f) => f(id));
      room.onPeerLeave = (id) => h.leaves.forEach((f) => f(id));
    },
    send(type, data, to) {
      if (!room) return;
      action(type).send(data, to ? { target: to } : undefined);
    },
    leave() { room?.leave(); },
  };
  return net;
}

function localNet(roomId) {
  const h = hub();
  const id = Math.random().toString(36).slice(2, 10);
  const peers = new Map(); // peer id → when we last heard from it
  let ch = null, beat = 0;
  const post = (m) => ch?.postMessage({ ...m, from: id });
  const net = {
    ...h.api,
    selfId: id,
    async start() {
      ch = new BroadcastChannel(`card-table:${roomId}`);
      ch.onmessage = ({ data: m }) => {
        if (m.to && m.to !== id) return;
        if (m.kind === "here" || m.kind === "here-too" || m.kind === "beat") {
          const known = peers.has(m.from);
          peers.set(m.from, performance.now());
          if (!known) h.joins.forEach((f) => f(m.from));
          if (m.kind === "here") post({ kind: "here-too", to: m.from });
        } else if (m.kind === "bye") {
          if (peers.delete(m.from)) h.leaves.forEach((f) => f(m.from));
        } else if (m.kind === "msg") h.handlers.get(m.type)?.(m.data, m.from);
      };
      post({ kind: "here" });
      addEventListener("pagehide", () => post({ kind: "bye" }));
      // a closing tab can't always say goodbye: a peer that goes quiet has left
      beat = setInterval(() => {
        post({ kind: "beat" });
        const now = performance.now();
        for (const [peer, at] of peers) if (now - at > 3500) { peers.delete(peer); h.leaves.forEach((f) => f(peer)); }
      }, 1000);
    },
    send(type, data, to) { post({ kind: "msg", type, data, to }); },
    leave() { post({ kind: "bye" }); clearInterval(beat); ch?.close(); ch = null; },
  };
  return net;
}
