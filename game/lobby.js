// Lobby + match orchestration. One Lobby holds up to two players and, once both are ready, a running Sim.
import { Sim, PROPS } from '../game/sim.js';
import { HEROES, ARENA } from '../shared/heroes.js';

const TICK_HZ = 30;
const SNAPSHOT_HZ = 20;

export class LobbyManager {
  constructor() {
    this.lobbies = new Map(); // code -> Lobby
  }

  generateCode() {
    if (this.lobbies.size >= 900) return null;
    for (let i = 0; i < 2000; i++) {
      const code = String(100 + Math.floor(Math.random() * 900));
      if (!this.lobbies.has(code)) return code;
    }
    return null;
  }

  create(client) {
    const code = this.generateCode();
    if (!code) { client.send({ t: 'error', msg: 'Server is full, try again later.' }); return null; }
    const lobby = new Lobby(code, this);
    this.lobbies.set(code, lobby);
    lobby.add(client);
    return lobby;
  }

  join(client, code) {
    const lobby = this.lobbies.get(String(code));
    if (!lobby) { client.send({ t: 'error', msg: `No lobby with code ${code}.` }); return null; }
    if (lobby.clients.length >= 2) { client.send({ t: 'error', msg: 'That lobby is full.' }); return null; }
    if (lobby.sim) { client.send({ t: 'error', msg: 'That match already started.' }); return null; }
    lobby.add(client);
    return lobby;
  }

  destroy(lobby) {
    lobby.stop();
    this.lobbies.delete(lobby.code);
  }
}

export class Lobby {
  constructor(code, manager) {
    this.code = code;
    this.manager = manager;
    this.clients = [];
    this.sim = null;
    this.timer = null;
    this.snapshotAcc = 0;
    this.lastTick = 0;
  }

  add(client) {
    client.lobby = this;
    client.hero = client.hero || null;
    client.ready = false;
    this.clients.push(client);
    this.broadcastLobby();
  }

  remove(client) {
    const i = this.clients.indexOf(client);
    if (i >= 0) this.clients.splice(i, 1);
    client.lobby = null;
    client.ready = false;
    if (this.sim) {
      // Opponent left mid-match: remaining player wins by forfeit.
      this.stop();
      this.broadcast({ t: 'opponentLeft' });
      this.sim = null;
      for (const c of this.clients) c.ready = false;
    }
    if (this.clients.length === 0) this.manager.destroy(this);
    else this.broadcastLobby();
  }

  broadcast(msg) {
    const str = JSON.stringify(msg);
    for (const c of this.clients) c.sendRaw(str);
  }

  broadcastLobby() {
    this.broadcast({
      t: 'lobby',
      code: this.code,
      players: this.clients.map((c) => ({ id: c.id, name: c.name, hero: c.hero, ready: c.ready, host: c === this.clients[0] })),
    });
  }

  pick(client, hero) {
    if (this.sim) return;
    if (hero !== 'random' && !HEROES[hero]) return;
    client.hero = hero;
    client.ready = false;
    this.broadcastLobby();
  }

  setReady(client, ready) {
    if (this.sim) return;
    if (!client.hero) { client.send({ t: 'error', msg: 'Pick a hero first.' }); return; }
    client.ready = !!ready;
    this.broadcastLobby();
    if (this.clients.length === 2 && this.clients.every((c) => c.ready && c.hero)) this.start();
  }

  start() {
    this.sim = new Sim(this.clients.map((c) => ({ id: c.id, name: c.name, hero: c.hero })));
    this.broadcast({
      t: 'start',
      code: this.code,
      props: PROPS,
      arena: ARENA,
      players: this.sim.order.map((id) => {
        const p = this.sim.players[id];
        return { id: p.id, name: p.name, hero: p.hero, pick: p.heroPick === 'random' ? 'random' : undefined };
      }),
    });
    this.lastTick = performance.now();
    this.snapshotAcc = 0;
    this.timer = setInterval(() => this.loop(), 1000 / TICK_HZ);
  }

  loop() {
    if (!this.sim) return;
    const now = performance.now();
    let dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    dt = Math.min(dt, 0.1);
    this.sim.tick(dt);
    this.snapshotAcc += dt;
    if (this.snapshotAcc >= 1 / SNAPSHOT_HZ) {
      this.snapshotAcc = 0;
      this.broadcast(this.sim.snapshot());
    }
    if (this.sim.phase === 'matchend') {
      // Leave the final snapshot visible, then return everyone to the lobby.
      const winner = this.sim.matchWinner;
      const score = { ...this.sim.score };
      this.stop();
      this.sim = null;
      setTimeout(() => {
        if (!this.clients.length) return;
        this.broadcast({ t: 'matchover', winner, score });
        for (const c of this.clients) c.ready = false;
        this.broadcastLobby();
      }, 50);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onInput(client, msg) {
    if (!this.sim) return;
    this.sim.setInput(client.id, msg);
  }

  onCast(client, msg) {
    if (!this.sim) return;
    this.sim.cast(client.id, msg.key, msg.aim, msg.curve);
  }

  onRelease(client, msg) {
    if (!this.sim) return;
    this.sim.release(client.id, msg.key, msg.aim);
  }
}
