// Practice mode: runs the authoritative Sim in the browser against a bot, exposing the same
// on()/send()/id surface as the WebSocket Net so the rest of the client does not care which it talks to.
import { Sim, PROPS } from '../game/sim.js';
import { BotController } from '../game/ai.js';
import { HEROES, ARENA, HERO_IDS } from '../shared/heroes.js';

const TICK_HZ = 30;
const SNAPSHOT_HZ = 20;

export class LocalGame {
  constructor() {
    this.handlers = {};
    this.id = 'me';
    this.sim = null;
    this.bot = null;
    this.timer = null;
    this.connected = true;
  }

  on(type, fn) { (this.handlers[type] ||= []).push(fn); }
  fire(type, msg) { for (const fn of this.handlers[type] || []) fn(msg); }

  send(msg) {
    switch (msg.t) {
      case 'practice': this.start(msg); break;
      case 'input': if (this.sim) this.sim.setInput('me', msg); break;
      case 'cast': if (this.sim) this.sim.cast('me', msg.key, msg.aim); break;
      case 'leave': this.stop(); this.fire('left', {}); break;
      default: break;
    }
  }

  start({ hero, botHero, difficulty, name }) {
    this.stop();
    const bh = HEROES[botHero] ? botHero : HERO_IDS[Math.floor(Math.random() * HERO_IDS.length)];
    const players = [
      { id: 'me', name: name || 'You', hero },
      { id: 'bot', name: `Bot (${difficulty || 'normal'})`, hero: bh },
    ];
    this.sim = new Sim(players);
    this.bot = new BotController(this.sim, 'bot', difficulty);
    this.fire('start', { t: 'start', code: null, props: PROPS, arena: ARENA, players });
    this.last = performance.now();
    this.snapAcc = 0;
    this.timer = setInterval(() => this.loop(), 1000 / TICK_HZ);
  }

  loop() {
    if (!this.sim) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.bot.tick(dt);
    this.sim.tick(dt);
    this.snapAcc += dt;
    if (this.snapAcc >= 1 / SNAPSHOT_HZ) {
      this.snapAcc = 0;
      this.fire('state', this.sim.snapshot());
    }
    if (this.sim.phase === 'matchend') {
      const winner = this.sim.matchWinner, score = { ...this.sim.score };
      this.stop();
      setTimeout(() => this.fire('matchover', { t: 'matchover', winner, score }), 50);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sim = null;
    this.bot = null;
  }
}
