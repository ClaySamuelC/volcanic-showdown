// Browser-hosted lobbies. The player who clicks Create lobby runs the same Lobby as the Node
// server and the other player connects straight to them. No server URL to type in.
import { Lobby } from '../game/lobby.js';

const PREFIX = 'volcanic-showdown-';

function sanitizeName(name) {
  const s = String(name || '').replace(/[^\w \-'!]/g, '').trim().slice(0, 16);
  return s || `Player${Math.floor(Math.random() * 900 + 100)}`;
}

function loadPeerJs() {
  if (window.Peer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/peerjs/peerjs.min.js';
    s.onload = () => (window.Peer ? resolve() : reject(new Error('Could not open a lobby.')));
    s.onerror = () => reject(new Error('Could not open a lobby.'));
    document.head.appendChild(s);
  });
}

export class PeerLobby {
  constructor() {
    this.handlers = {};
    this.id = null;
    this.connected = false;
    this.peer = null;
    this.conn = null;
    this.lobby = null;
    this.me = null;
    this.guest = null;
    this.role = null;
  }

  on(type, fn) { (this.handlers[type] ||= []).push(fn); }
  fire(type, msg) { for (const fn of this.handlers[type] || []) fn(msg); }

  send(msg) {
    if (this.role === 'guest') {
      if (this.conn?.open) this.conn.send(msg);
      if (msg.t === 'leave') { this.fire('left', {}); this.close(); }
      return;
    }
    if (!this.me || !this.lobby) return;
    this.apply(this.me, msg);
  }

  apply(client, msg) {
    if (!this.lobby) return;
    switch (msg.t) {
      case 'pick': this.lobby.pick(client, msg.hero); break;
      case 'ready': this.lobby.setReady(client, msg.ready !== false); break;
      case 'input': this.lobby.onInput(client, msg); break;
      case 'cast': this.lobby.onCast(client, msg); break;
      case 'release': this.lobby.onRelease(client, msg); break;
      case 'leave': this.lobby.remove(client); break;
      default: break;
    }
  }

  async host(name) {
    this.close();
    await loadPeerJs();
    const code = await this.openHost();
    this.role = 'host';
    this.id = 'host';
    this.connected = true;
    this.me = this.localClient(name);
    this.lobby = new Lobby(code, { destroy: () => this.close() });
    this.lobby.add(this.me);
    this.peer.on('connection', (conn) => this.accept(conn));
  }

  async join(name, code) {
    this.close();
    await loadPeerJs();
    await this.openGuest(code);
    this.role = 'guest';
    this.id = 'guest';
    this.connected = true;
    this.conn.on('data', (msg) => {
      if (msg && typeof msg.t === 'string') this.fire(msg.t, msg);
    });
    this.conn.on('close', () => {
      if (!this.connected) return;
      this.connected = false;
      this.fire('close', {});
    });
    this.conn.send({ t: 'join', name: sanitizeName(name) });
  }

  localClient(name) {
    const self = this;
    return {
      id: 'host',
      name: sanitizeName(name),
      hero: null,
      ready: false,
      send(msg) { self.fire(msg.t, msg); },
      sendRaw(str) { self.fire(JSON.parse(str).t, JSON.parse(str)); },
    };
  }

  accept(conn) {
    const reject = (msg) => {
      const send = () => { try { conn.send({ t: 'error', msg }); } catch { /* already gone */ } conn.close(); };
      if (conn.open) send();
      else conn.on('open', send);
    };
    if (this.guest || (this.lobby && this.lobby.clients.length >= 2)) { reject('That lobby is full.'); return; }
    conn.on('data', (msg) => {
      if (!msg || typeof msg.t !== 'string') return;
      if (!this.guest) {
        if (msg.t !== 'join') return;
        if (!this.lobby || this.lobby.sim) { reject('That match already started.'); return; }
        const guest = {
          id: 'guest',
          name: sanitizeName(msg.name),
          hero: null,
          ready: false,
          send(m) { if (conn.open) conn.send(m); },
          sendRaw(str) { if (conn.open) conn.send(JSON.parse(str)); },
        };
        this.guest = guest;
        this.conn = conn;
        this.lobby.add(guest);
        return;
      }
      this.apply(this.guest, msg);
    });
    conn.on('close', () => {
      const g = this.guest;
      if (!g || this.conn !== conn) return;
      this.guest = null;
      this.conn = null;
      if (this.lobby) this.lobby.remove(g);
    });
  }

  openHost() {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        if (n > 6) { reject(new Error('Could not open a lobby. Try again.')); return; }
        const code = String(100 + Math.floor(Math.random() * 900));
        const peer = new window.Peer(PREFIX + code, { debug: 0 });
        let settled = false;
        peer.on('open', () => {
          if (settled) return;
          settled = true;
          this.peer = peer;
          resolve(code);
        });
        peer.on('error', (err) => {
          if (!settled) {
            settled = true;
            try { peer.destroy(); } catch { /* already dead */ }
            if (err?.type === 'unavailable-id') attempt(n + 1);
            else reject(new Error('Could not open a lobby.'));
            return;
          }
          if (err?.type === 'network' || err?.type === 'socket-closed' || err?.type === 'server-error') {
            this.connected = false;
            this.fire('close', {});
          }
        });
      };
      attempt(0);
    });
  }

  openGuest(code) {
    return new Promise((resolve, reject) => {
      const peer = new window.Peer({ debug: 0 });
      let settled = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { peer.destroy(); } catch { /* already dead */ }
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail('No lobby with that code.'), 8000);
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        this.peer = peer;
        this.conn = conn;
        conn.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        });
        conn.on('error', () => fail('No lobby with that code.'));
      });
      peer.on('error', (err) => {
        if (err?.type === 'peer-unavailable') fail('No lobby with that code.');
        else fail('Could not reach that lobby.');
      });
    });
  }

  close() {
    this.connected = false;
    const lobby = this.lobby;
    this.lobby = null;
    this.me = null;
    this.guest = null;
    if (lobby) lobby.stop();
    const conn = this.conn;
    const peer = this.peer;
    this.conn = null;
    this.peer = null;
    this.role = null;
    try { conn?.close(); } catch { /* already closed */ }
    try { peer?.destroy(); } catch { /* already destroyed */ }
  }
}
