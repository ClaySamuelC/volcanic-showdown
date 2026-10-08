// Authoritative arena simulation. Runs on the server only.
import { ARENA, HEROES } from '../shared/heroes.js';
import { HERO_IMPL } from './heroes.js';

const KNOCK_DECAY = 6; // knockback velocity decays by e^-6 per second

export const PROPS = [
  { x: 0, z: 0, r: 1.3, kind: 'boulder' },
  { x: 6, z: 6, r: 0.9, kind: 'pillar' },
  { x: -6, z: 6, r: 0.9, kind: 'pillar' },
  { x: 6, z: -6, r: 0.9, kind: 'pillar' },
  { x: -6, z: -6, r: 0.9, kind: 'pillar' },
  { x: 0, z: 10.5, r: 1.4, kind: 'boulder' },
  { x: 0, z: -10.5, r: 1.4, kind: 'boulder' },
  { x: 8, z: -9.5, r: 0.8, kind: 'boulder' },
  { x: -8, z: 9.5, r: 0.8, kind: 'boulder' },
  { x: 12.5, z: 5.5, r: 0.7, kind: 'stump' },
  { x: -12.5, z: -5.5, r: 0.7, kind: 'stump' },
];

const SPAWNS = [
  { x: -12, z: 0, facing: 0 },
  { x: 12, z: 0, facing: Math.PI },
];

const NEGATIVE_EFFECTS = new Set(['slow', 'root', 'stun', 'burn', 'soaked', 'vulnerable']);

export class Sim {
  constructor(playerDefs) {
    this.time = 0;
    this.nextId = 1;
    this.players = {};
    this.order = [];
    this.projectiles = [];
    this.zones = [];
    this.events = [];
    this.score = {};
    this.round = 0;
    this.phase = 'countdown';
    this.phaseUntil = 0;
    this.roundTime = 0;
    this.safeRadius = ARENA.radius;
    this.healthPackTimer = ARENA.healthPackInterval;
    this.matchWinner = null;
    this.roundWinner = null;

    playerDefs.forEach((def, i) => {
      const hero = HEROES[def.hero];
      const p = {
        id: def.id,
        name: def.name,
        hero: def.hero,
        slot: i,
        x: 0, z: 0, facing: 0,
        hp: hero.hp, maxHp: hero.hp,
        shield: 0, shieldUntil: 0,
        kx: 0, kz: 0,
        dash: null,
        cast: null,
        effects: [],
        cd: { attack: 0, q: 0, w: 0, e: 0, r: 0 },
        input: { mx: 0, mz: 0, ax: 1, az: 0, target: null },
        alive: true,
        state: {},
        flags: {},
      };
      this.players[def.id] = p;
      this.order.push(def.id);
      this.score[def.id] = 0;
    });

    this.startRound();
  }

  // ---------- helpers ----------
  id() { return this.nextId++; }
  emit(ev) { this.events.push(ev); }
  other(p) { return this.players[this.order.find((id) => id !== p.id)]; }
  enemiesOf(p) { return this.order.filter((id) => id !== p.id).map((id) => this.players[id]).filter((e) => e.alive); }

  dirTo(p, aim) {
    let dx = aim[0] - p.x, dz = aim[1] - p.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return [Math.cos(p.facing), Math.sin(p.facing)];
    return [dx / len, dz / len];
  }

  hasEffect(p, type) { return p.effects.some((e) => e.type === type); }
  getEffect(p, type) { return p.effects.find((e) => e.type === type); }
  addEffect(p, type, duration, data = {}) {
    const existing = this.getEffect(p, type);
    const until = this.time + duration;
    if (existing) {
      existing.until = Math.max(existing.until, until);
      Object.assign(existing, data);
      return existing;
    }
    const e = { type, until, ...data };
    p.effects.push(e);
    return e;
  }
  removeEffect(p, type) { p.effects = p.effects.filter((e) => e.type !== type); }
  purge(p) { p.effects = p.effects.filter((e) => !NEGATIVE_EFFECTS.has(e.type)); }

  slowOf(p) {
    let s = 0;
    for (const e of p.effects) if (e.type === 'slow') s = Math.max(s, e.amount);
    return s;
  }
  canAct(p) { return p.alive && this.phase === 'fight' && !this.hasEffect(p, 'stun') && !p.cast; }
  canCast(p) { return p.alive && this.phase === 'fight' && !this.hasEffect(p, 'stun') && !p.cast && !p.dash; }

  // ---------- combat primitives ----------
  damage(target, amount, source, opts = {}) {
    if (!target.alive || amount <= 0) return 0;
    if (this.hasEffect(target, 'vulnerable')) {
      amount *= 2;
      this.removeEffect(target, 'vulnerable');
      this.emit({ e: 'text', x: target.x, z: target.z, text: 'CRIT', color: '#ffcc33' });
    }
    let absorbed = 0;
    if (target.shield > 0) {
      absorbed = Math.min(target.shield, amount);
      target.shield -= absorbed;
      amount -= absorbed;
      if (target.shield <= 0) this.onShieldBroken(target);
    }
    target.hp = Math.max(0, target.hp - amount);
    this.emit({ e: 'hit', pid: target.id, x: target.x, z: target.z, amount, absorbed, kind: opts.kind || 'hit' });
    if (target.hp <= 0) this.kill(target, source);
    return amount;
  }

  onShieldBroken(target) {
    if (this.hasEffect(target, 'shell')) {
      HERO_IMPL.tidebinder.burstShell(this, target);
    }
    target.shieldUntil = 0;
  }

  heal(target, amount) {
    const before = target.hp;
    target.hp = Math.min(target.maxHp, target.hp + amount);
    this.emit({ e: 'heal', pid: target.id, x: target.x, z: target.z, amount: target.hp - before });
  }

  grantShield(p, amount, duration) {
    p.shield = Math.max(p.shield, amount);
    p.shieldUntil = this.time + duration;
  }

  knock(target, dx, dz, distance) {
    const len = Math.hypot(dx, dz) || 1;
    target.kx += (dx / len) * distance * KNOCK_DECAY;
    target.kz += (dz / len) * distance * KNOCK_DECAY;
  }

  startDash(p, dx, dz, distance, speed, kind, data = {}) {
    const len = Math.hypot(dx, dz) || 1;
    p.dash = { dx: dx / len, dz: dz / len, speed, remaining: distance, kind, ...data };
    p.facing = Math.atan2(dz, dx);
  }

  startCast(p, key, duration, aim, fn) {
    const [dx, dz] = this.dirTo(p, aim);
    p.facing = Math.atan2(dz, dx);
    p.cast = { key, until: this.time + duration, aim, fn, started: this.time };
    this.emit({ e: 'cast', pid: p.id, key, duration });
  }

  kill(target, source) {
    target.alive = false;
    target.hp = 0;
    target.cast = null;
    target.dash = null;
    this.emit({ e: 'death', pid: target.id, x: target.x, z: target.z });
    if (this.phase === 'fight') {
      const alive = this.order.filter((id) => this.players[id].alive);
      this.endRound(alive.length === 1 ? alive[0] : null);
    }
  }

  enemiesInCone(p, dx, dz, range, halfAngle) {
    const out = [];
    for (const e of this.enemiesOf(p)) {
      const ex = e.x - p.x, ez = e.z - p.z;
      const d = Math.hypot(ex, ez);
      if (d > range + ARENA.playerRadius) continue;
      if (d < 0.01) { out.push(e); continue; }
      const cos = (ex * dx + ez * dz) / d;
      const ang = Math.acos(Math.max(-1, Math.min(1, cos)));
      // allow the target's radius to count toward the cone edge
      const slack = Math.atan2(ARENA.playerRadius, d);
      if (ang <= halfAngle + slack) out.push(e);
    }
    return out;
  }

  enemiesInRadius(x, z, r, exclude) {
    return this.order
      .map((id) => this.players[id])
      .filter((p) => p.alive && p !== exclude && Math.hypot(p.x - x, p.z - z) <= r + ARENA.playerRadius);
  }

  addProjectile(proj) {
    proj.id = this.id();
    proj.hit = new Set();
    this.projectiles.push(proj);
    return proj;
  }

  addZone(zone) {
    zone.id = this.id();
    this.zones.push(zone);
    return zone;
  }

  removeZone(zone) {
    const i = this.zones.indexOf(zone);
    if (i >= 0) this.zones.splice(i, 1);
  }

  blockedByProp(x, z, r = 0) {
    return PROPS.some((pr) => Math.hypot(pr.x - x, pr.z - z) < pr.r + r);
  }

  // True when a straight line between two points crosses a prop (used by the AI; projectiles step instead).
  lineBlocked(x1, z1, x2, z2, pad = 0.2) {
    const dx = x2 - x1, dz = z2 - z1;
    const len2 = dx * dx + dz * dz || 1;
    for (const pr of PROPS) {
      const t = Math.max(0, Math.min(1, ((pr.x - x1) * dx + (pr.z - z1) * dz) / len2));
      const cx = x1 + dx * t, cz = z1 + dz * t;
      if (Math.hypot(pr.x - cx, pr.z - cz) < pr.r + pad) return true;
    }
    return false;
  }

  // ---------- input ----------
  setInput(pid, input) {
    const p = this.players[pid];
    if (!p) return;
    if (Array.isArray(input.move)) {
      let [mx, mz] = input.move;
      const len = Math.hypot(mx, mz);
      if (len > 1) { mx /= len; mz /= len; }
      p.input.mx = mx || 0;
      p.input.mz = mz || 0;
    }
    if (Array.isArray(input.aim)) {
      p.input.ax = input.aim[0];
      p.input.az = input.aim[1];
    }
    if ('target' in input) {
      p.input.target = Array.isArray(input.target) ? [input.target[0], input.target[1]] : null;
    }
  }

  cast(pid, key, aim) {
    const p = this.players[pid];
    if (!p || !p.alive || this.phase !== 'fight') return;
    if (!Array.isArray(aim) || aim.length !== 2) aim = [p.input.ax, p.input.az];
    aim = [Number(aim[0]) || 0, Number(aim[1]) || 0];
    const impl = HERO_IMPL[p.hero];
    if (!impl) return;
    if (key === 'attack') {
      if (!this.canAct(p) || p.cd.attack > 0 || p.dash) return;
      impl.attack(this, p, aim);
      return;
    }
    if (!['q', 'w', 'e', 'r'].includes(key)) return;
    // Recast variants (tether pull, shell burst) are handled by the hero impl even while on cooldown.
    if (impl.recast && impl.recast(this, p, key, aim)) return;
    if (p.cd[key] > 0) return;
    if (!this.canCast(p)) return;
    const ok = impl[key](this, p, aim);
    if (ok !== false) {
      p.cd[key] = HEROES[p.hero].abilities[key].cooldown;
      p.input.target = null;
    }
  }

  // ---------- rounds ----------
  startRound() {
    this.round += 1;
    this.phase = 'countdown';
    this.phaseUntil = this.time + ARENA.countdown;
    this.roundTime = 0;
    this.safeRadius = ARENA.radius;
    this.projectiles = [];
    this.zones = [];
    this.healthPackTimer = ARENA.healthPackInterval;
    this.roundWinner = null;
    this.order.forEach((id, i) => {
      const p = this.players[id];
      const hero = HEROES[p.hero];
      const s = SPAWNS[i % SPAWNS.length];
      p.x = s.x; p.z = s.z; p.facing = s.facing;
      p.hp = hero.hp; p.maxHp = hero.hp;
      p.shield = 0; p.shieldUntil = 0;
      p.kx = 0; p.kz = 0;
      p.dash = null; p.cast = null;
      p.effects = [];
      p.alive = true;
      p.state = {};
      p.flags = {};
      p.input.target = null;
      p.cd = { attack: 0, q: 0, w: 0, e: 0, r: hero.abilities.r.cooldown };
    });
    this.emit({ e: 'round', round: this.round });
  }

  endRound(winnerId) {
    if (this.phase !== 'fight') return;
    this.phase = 'roundend';
    this.phaseUntil = this.time + ARENA.roundEndDelay;
    this.roundWinner = winnerId;
    if (winnerId) this.score[winnerId] += 1;
    for (const id of this.order) { const p = this.players[id]; p.cast = null; p.dash = null; }
    this.emit({ e: 'roundend', winner: winnerId, score: { ...this.score } });
    const champ = this.order.find((id) => this.score[id] >= ARENA.roundsToWin);
    if (champ) {
      this.matchWinner = champ;
    }
  }

  // ---------- main tick ----------
  tick(dt) {
    this.time += dt;

    if (this.phase === 'countdown') {
      if (this.time >= this.phaseUntil) this.phase = 'fight';
    } else if (this.phase === 'roundend') {
      if (this.time >= this.phaseUntil) {
        if (this.matchWinner) {
          this.phase = 'matchend';
          this.emit({ e: 'matchend', winner: this.matchWinner, score: { ...this.score } });
        } else {
          this.startRound();
        }
      }
    }

    if (this.phase === 'fight') {
      this.roundTime += dt;
      this.updateArena(dt);
      this.updateHealthPacks(dt);
    }

    for (const id of this.order) this.updatePlayer(this.players[id], dt);
    if (this.phase === 'fight' || this.phase === 'roundend') {
      this.updateProjectiles(dt);
      this.updateZones(dt);
    }
    this.resolveCollisions();

    if (this.phase === 'fight' && this.roundTime >= ARENA.roundTimeLimit) {
      const [a, b] = this.order.map((id) => this.players[id]);
      if (a.hp > b.hp) this.endRound(a.id);
      else if (b.hp > a.hp) this.endRound(b.id);
      else this.endRound(null);
    }
  }

  updateArena(dt) {
    const t = this.roundTime - ARENA.shrinkStart;
    if (t > 0) {
      const f = Math.min(1, t / ARENA.shrinkDuration);
      this.safeRadius = ARENA.radius - (ARENA.radius - ARENA.minRadius) * f;
    }
    for (const id of this.order) {
      const p = this.players[id];
      if (!p.alive) continue;
      const d = Math.hypot(p.x, p.z);
      if (d > this.safeRadius) {
        p.state.lavaAcc = (p.state.lavaAcc || 0) + ARENA.lavaDps * dt;
        if (p.state.lavaAcc >= 1) {
          p.state.lavaAcc -= 1;
          this.damage(p, 1, null, { kind: 'lava' });
        }
      }
    }
  }

  updateHealthPacks(dt) {
    this.healthPackTimer -= dt;
    const packs = this.zones.filter((z) => z.kind === 'healthpack');
    if (this.healthPackTimer <= 0 && packs.length < ARENA.healthPackMax) {
      this.healthPackTimer = ARENA.healthPackInterval;
      for (let tries = 0; tries < 30; tries++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * (this.safeRadius - 1.5);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (this.blockedByProp(x, z, 1.0)) continue;
        if (this.order.some((id) => Math.hypot(this.players[id].x - x, this.players[id].z - z) < 3)) continue;
        this.addZone({ kind: 'healthpack', x, z, r: 0.5, until: Infinity, owner: null });
        this.emit({ e: 'packspawn', x, z });
        break;
      }
    }
  }

  updatePlayer(p, dt) {
    if (!p.alive) return;
    const hero = HEROES[p.hero];

    if (this.phase === 'fight') {
      for (const k of Object.keys(p.cd)) if (p.cd[k] > 0) p.cd[k] = Math.max(0, p.cd[k] - dt);
    }
    if (p.shield > 0 && p.shieldUntil && this.time >= p.shieldUntil) {
      p.shield = 0;
      this.onShieldBroken(p);
    }

    // Status effects
    const stunned = this.hasEffect(p, 'stun');
    for (const e of p.effects) {
      if (e.type === 'burn') {
        e.acc = (e.acc || 0) + e.dps * dt;
        if (e.acc >= 1) { e.acc -= 1; this.damage(p, 1, null, { kind: 'burn' }); }
      }
    }
    p.effects = p.effects.filter((e) => this.time < e.until);
    if (!p.alive) return;

    if (stunned && p.cast) {
      this.emit({ e: 'interrupt', pid: p.id });
      p.cast = null;
    }

    // Wind-up casts
    if (p.cast && this.time >= p.cast.until) {
      const c = p.cast;
      p.cast = null;
      c.fn(c.aim);
      if (!p.alive) return;
    }

    const impl = HERO_IMPL[p.hero];
    if (impl.onTick) impl.onTick(this, p, dt);

    // Facing follows the aim point when not locked by a dash/cast
    if (!p.dash && !p.cast && !stunned) {
      const dx = p.input.ax - p.x, dz = p.input.az - p.z;
      if (Math.hypot(dx, dz) > 0.05) p.facing = Math.atan2(dz, dx);
    }

    // Movement
    if (p.dash) {
      const step = Math.min(p.dash.speed * dt, p.dash.remaining);
      const nx = p.x + p.dash.dx * step, nz = p.z + p.dash.dz * step;
      const blocked = this.blockedByProp(nx, nz, ARENA.playerRadius) || Math.hypot(nx, nz) > ARENA.wallRadius - ARENA.playerRadius;
      if (blocked) {
        p.dash.remaining = 0;
      } else {
        p.x = nx; p.z = nz;
        p.dash.remaining -= step;
      }
      if (p.dash.onTick) p.dash.onTick(this, p, dt);
      if (p.dash.remaining <= 1e-4 || (p.dash.stopWhen && p.dash.stopWhen(this, p))) {
        const d = p.dash;
        p.dash = null;
        if (d.onEnd) d.onEnd(this, p);
      }
    } else if (this.phase === 'fight' && !stunned && !p.cast && !this.hasEffect(p, 'root')) {
      let mx = p.input.mx, mz = p.input.mz;
      if (Math.hypot(mx, mz) < 0.01 && p.input.target) {
        const tx = p.input.target[0] - p.x, tz = p.input.target[1] - p.z;
        const d = Math.hypot(tx, tz);
        if (d < 0.15) p.input.target = null;
        else { mx = tx / d; mz = tz / d; }
      } else if (Math.hypot(mx, mz) >= 0.01) {
        p.input.target = null;
      }
      let speed = hero.speed * (1 - this.slowOf(p));
      if (this.hasEffect(p, 'haste')) speed *= 1 + (this.getEffect(p, 'haste').amount || 0);
      p.x += mx * speed * dt;
      p.z += mz * speed * dt;
    }

    // Knockback
    if (Math.abs(p.kx) > 0.01 || Math.abs(p.kz) > 0.01) {
      p.x += p.kx * dt;
      p.z += p.kz * dt;
      const decay = Math.exp(-KNOCK_DECAY * dt);
      p.kx *= decay; p.kz *= decay;
      if (Math.hypot(p.kx, p.kz) < 0.15) { p.kx = 0; p.kz = 0; }
    }
  }

  resolveCollisions() {
    const R = ARENA.playerRadius;
    const ps = this.order.map((id) => this.players[id]).filter((p) => p.alive);
    for (const p of ps) {
      for (const pr of PROPS) {
        const dx = p.x - pr.x, dz = p.z - pr.z;
        const d = Math.hypot(dx, dz);
        const min = pr.r + R;
        if (d < min) {
          if (d < 1e-4) { p.x = pr.x + min; continue; }
          p.x = pr.x + (dx / d) * min;
          p.z = pr.z + (dz / d) * min;
        }
      }
      const d = Math.hypot(p.x, p.z);
      const max = ARENA.wallRadius - R;
      if (d > max) { p.x *= max / d; p.z *= max / d; }
    }
    if (ps.length === 2) {
      const [a, b] = ps;
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      const min = R * 2;
      if (d < min) {
        const nx = d < 1e-4 ? 1 : dx / d, nz = d < 1e-4 ? 0 : dz / d;
        const push = (min - d) / 2;
        a.x -= nx * push; a.z -= nz * push;
        b.x += nx * push; b.z += nz * push;
      }
    }
  }

  updateProjectiles(dt) {
    const R = ARENA.playerRadius;
    for (const pr of this.projectiles) {
      const step = pr.speed * dt;
      const sub = Math.max(1, Math.ceil(step / 0.3));
      for (let s = 0; s < sub && !pr.dead; s++) {
        const ds = Math.min(step / sub, pr.remaining);
        pr.x += pr.dx * ds;
        pr.z += pr.dz * ds;
        pr.remaining -= ds;
        if (!pr.ghost && this.blockedByProp(pr.x, pr.z, pr.r * 0.5)) {
          pr.dead = true;
          if (pr.onExpire) pr.onExpire(this, pr, 'prop');
          break;
        }
        if (Math.hypot(pr.x, pr.z) > ARENA.wallRadius) {
          pr.dead = true;
          if (pr.onExpire) pr.onExpire(this, pr, 'wall');
          break;
        }
        const owner = this.players[pr.owner];
        for (const e of this.enemiesOf(owner)) {
          if (pr.hit.has(e.id)) continue;
          if (Math.hypot(e.x - pr.x, e.z - pr.z) <= pr.r + R) {
            pr.hit.add(e.id);
            pr.onHit(this, pr, e);
            if (!pr.pierce) { pr.dead = true; break; }
          }
        }
        if (pr.onTick) pr.onTick(this, pr, dt / sub);
        if (pr.remaining <= 1e-4 && !pr.dead) {
          pr.dead = true;
          if (pr.onExpire) pr.onExpire(this, pr, 'range');
        }
      }
    }
    this.projectiles = this.projectiles.filter((p) => !p.dead);
  }

  updateZones(dt) {
    for (const z of this.zones) {
      if (z.onTick) z.onTick(this, z, dt);
      if (z.kind === 'healthpack') {
        for (const id of this.order) {
          const p = this.players[id];
          if (p.alive && Math.hypot(p.x - z.x, p.z - z.z) <= z.r + ARENA.playerRadius) {
            this.heal(p, ARENA.healthPackHeal);
            z.dead = true;
            this.emit({ e: 'pickup', pid: p.id, x: z.x, z: z.z });
            break;
          }
        }
      }
      if (!z.dead && this.time >= z.until) {
        z.dead = true;
        if (z.onExpire) z.onExpire(this, z);
      }
    }
    this.zones = this.zones.filter((z) => !z.dead);
  }

  // ---------- snapshot ----------
  snapshot() {
    const players = this.order.map((id) => {
      const p = this.players[id];
      return {
        id: p.id,
        hero: p.hero,
        x: +p.x.toFixed(3), z: +p.z.toFixed(3), f: +p.facing.toFixed(3),
        hp: p.hp, maxHp: p.maxHp, sh: p.shield,
        cd: { a: +p.cd.attack.toFixed(2), q: +p.cd.q.toFixed(2), w: +p.cd.w.toFixed(2), e: +p.cd.e.toFixed(2), r: +p.cd.r.toFixed(2) },
        fx: p.effects.map((e) => e.type),
        cast: p.cast ? { key: p.cast.key, t: +((this.time - p.cast.started) / (p.cast.until - p.cast.started)).toFixed(2) } : null,
        dash: p.dash ? p.dash.kind : null,
        alive: p.alive,
        flags: p.flags,
      };
    });
    const proj = this.projectiles.map((pr) => ({ id: pr.id, k: pr.kind, x: +pr.x.toFixed(3), z: +pr.z.toFixed(3), r: pr.r, dx: +pr.dx.toFixed(3), dz: +pr.dz.toFixed(3), o: pr.owner }));
    const zones = this.zones.map((z) => ({
      id: z.id, k: z.kind, x: +z.x.toFixed(3), z: +z.z.toFixed(3), r: z.r, o: z.owner,
      armed: z.armedAt !== undefined ? this.time >= z.armedAt : undefined,
      left: isFinite(z.until) ? +(z.until - this.time).toFixed(2) : undefined,
      tx: z.tx, tz: z.tz, pid: z.pid,
    }));
    const snap = {
      t: 'state',
      time: +this.time.toFixed(3),
      phase: this.phase,
      phaseT: +(Math.max(0, this.phaseUntil - this.time)).toFixed(2),
      roundTime: +this.roundTime.toFixed(1),
      round: this.round,
      score: this.score,
      safeR: +this.safeRadius.toFixed(2),
      roundWinner: this.roundWinner,
      matchWinner: this.matchWinner,
      players, proj, zones,
      ev: this.events,
    };
    this.events = [];
    return snap;
  }
}
