// Authoritative arena simulation. Runs on the server only.
import { ARENA, HEROES, HERO_IDS } from '../shared/heroes.js';
import { DEBUG } from '../shared/debug.js';
import { HERO_IMPL, quadPoint } from './heroes.js';

const KNOCK_DECAY = 6; // knockback velocity decays by e^-6 per second
const PATROL_HALF = 6.35; // half-side of the square walked around the middle
const PATROL_SPEED = 5.5; // units per second along the square

const LAYOUT = 1.3; // prop and spawn positions, matching the larger island
const PILLAR_REACH = 9.6; // distance from the center to each pillar
const PILLAR_STEP = PILLAR_REACH / Math.SQRT2; // corner of a square at that distance
const CORNER_ROCK = 7 * LAYOUT; // just outside the pillar square so the two don't overlap
export const PROPS = [
  { id: 'p1', x: CORNER_ROCK, z: CORNER_ROCK, r: 0.9, kind: 'boulder' },
  { id: 'p2', x: -CORNER_ROCK, z: CORNER_ROCK, r: 0.9, kind: 'boulder' },
  { id: 'p3', x: CORNER_ROCK, z: -CORNER_ROCK, r: 0.9, kind: 'boulder' },
  { id: 'p4', x: -CORNER_ROCK, z: -CORNER_ROCK, r: 0.9, kind: 'boulder' },
  { id: 'c1', x: PILLAR_STEP, z: PILLAR_STEP, r: 0.9, kind: 'pillar', permanent: true },
  { id: 'c2', x: -PILLAR_STEP, z: PILLAR_STEP, r: 0.9, kind: 'pillar', permanent: true },
  { id: 'c3', x: PILLAR_STEP, z: -PILLAR_STEP, r: 0.9, kind: 'pillar', permanent: true },
  { id: 'c4', x: -PILLAR_STEP, z: -PILLAR_STEP, r: 0.9, kind: 'pillar', permanent: true },
  { id: 'p5', x: 0, z: 10.5 * LAYOUT, r: 1.4, kind: 'boulder' },
  { id: 'p6', x: 0, z: -10.5 * LAYOUT, r: 1.4, kind: 'boulder' },
  { id: 'p7', x: 8 * LAYOUT, z: -9.5 * LAYOUT, r: 0.8, kind: 'boulder' },
  { id: 'p8', x: -8 * LAYOUT, z: 9.5 * LAYOUT, r: 0.8, kind: 'boulder' },
  { id: 'p9', x: 12.5 * LAYOUT, z: 5.5 * LAYOUT, r: 0.7, kind: 'boulder' },
  { id: 'p10', x: -12.5 * LAYOUT, z: -5.5 * LAYOUT, r: 0.7, kind: 'boulder' },
  { id: 'p17', x: 11 * LAYOUT, z: -2 * LAYOUT, r: 0.65, kind: 'boulder' },
  { id: 'p18', x: -11 * LAYOUT, z: 2 * LAYOUT, r: 0.65, kind: 'boulder' },
];

const SPAWNS = [
  { x: -12 * LAYOUT, z: 0, facing: 0 },
  { x: 12 * LAYOUT, z: 0, facing: Math.PI },
];

const NEGATIVE_EFFECTS = new Set(['slow', 'root', 'prone', 'stun', 'burn', 'soaked', 'vulnerable', 'silence', 'poison', 'leash', 'rabbit']);

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
    this.kegTimer = ARENA.kegInterval;
    this.propTimer = ARENA.propReset;
    this.freeCooldowns = false;
    this.propsDisabled = false;
    this.patrolDist = 0;
    this.matchWinner = null;
    this.roundWinner = null;

    playerDefs.forEach((def, i) => {
      const picked = def.hero === 'random' ? 'random' : def.hero;
      const hero = HEROES[picked] || HEROES[HERO_IDS[0]];
      const p = {
        id: def.id,
        name: def.name,
        heroPick: picked,
        hero: HEROES[picked] ? picked : null,
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
        dummy: !!def.dummy,
        moveLock: 0,
        pendingAttack: null,
        attackBuffer: null,
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
  stunned(p) { return this.hasEffect(p, 'stun') || this.hasEffect(p, 'prone'); }
  isGhost(p) { return !!(p?.effects && (this.hasEffect(p, 'phase') || this.hasEffect(p, 'perch') || this.hasEffect(p, 'storm'))); }
  spellImmune(p) { return !!(p?.effects && this.hasEffect(p, 'spellImmune')); }
  rooted(p) { return this.hasEffect(p, 'root') || this.hasEffect(p, 'prone'); }
  poisonHeld(p, poison) {
    if (!p || !poison || this.isGhost(p)) return false;
    return this.zones.some((z) => (
      z.kind === 'cloud' && !z.dead && this.time < z.until
      && (!poison.source || z.owner === poison.source)
      && Math.hypot(p.x - z.x, p.z - z.z) <= z.r + ARENA.playerRadius
    ));
  }

  poisonStacks(p) {
    const e = p.effects.find((fx) => fx.type === 'poison');
    if (!e) return 0;
    const interval = e.interval || 1;
    const left = e.until - this.time;
    if (left <= 0) return 0;
    const max = e.stacks || 3;
    return Math.min(max, Math.max(1, Math.ceil((left - 1e-6) / interval)));
  }
  addEffect(p, type, duration, data = {}) {
    if (NEGATIVE_EFFECTS.has(type) && (this.spellImmune(p) || this.isGhost(p))) return null;
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
    for (const e of p.effects) {
      if (e.type === 'slow') s = Math.max(s, e.amount);
      else if (e.type === 'rabbit') s = Math.max(s, e.slow ?? 0.62);
    }
    return s;
  }
  canAct(p) { return p.alive && this.phase === 'fight' && !this.stunned(p) && !this.hasEffect(p, 'phase') && !this.hasEffect(p, 'storm') && !this.hasEffect(p, 'rabbit') && !p.cast; }
  canCast(p) {
    return p.alive && this.phase === 'fight' && !this.stunned(p) && !this.hasEffect(p, 'silence')
      && !this.hasEffect(p, 'phase') && !this.hasEffect(p, 'storm') && !this.hasEffect(p, 'rabbit') && !p.cast && !p.dash;
  }

  // ---------- combat primitives ----------
  tryDodge(target) {
    if (!target?.alive || !target.effects) return false;
    const dodge = this.getEffect(target, 'dodge');
    if (!dodge) return false;
    this.removeEffect(target, 'dodge');
    this.heal(target, dodge.heal || 0);
    this.emit({ e: 'text', x: target.x, z: target.z, text: 'DODGE', color: '#f0d78c' });
    return true;
  }

  damage(target, amount, source, opts = {}) {
    if (!target?.alive || amount <= 0) return 0;
    if (this.isGhost(target)) return 0;
    if (this.spellImmune(target) && !opts.basic && !opts.environment) {
      if (opts.kind !== 'burn' && opts.kind !== 'poison') {
        this.emit({ e: 'text', x: target.x, z: target.z, text: 'IMMUNE', color: '#f0d78c' });
      }
      return 0;
    }
    if (this.hasEffect(target, 'vulnerable')) {
      amount *= 2;
      this.removeEffect(target, 'vulnerable');
      this.emit({ e: 'text', x: target.x, z: target.z, text: 'CRIT', color: '#ffcc33' });
    }
    let absorbed = 0;
    if (target.shield > 0 && !opts.ignoreShield) {
      absorbed = Math.min(target.shield, amount);
      target.shield -= absorbed;
      amount -= absorbed;
      if (target.shield <= 0) this.onShieldBroken(target);
    }
    if (opts.nonlethal) amount = Math.min(amount, Math.max(0, target.hp - 1));
    if (target.dummy) {
      target.hp -= amount;
      this.emit({ e: 'hit', pid: target.id, x: target.x, z: target.z, amount, absorbed, kind: opts.kind || 'hit' });
      if (target.hp <= 0) this.downDummy(target);
      return amount;
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

  knock(target, dx, dz, distance, opts = {}) {
    if (!target || target.kx == null) return;
    if (target.effects && this.isGhost(target)) return;
    if (target.effects && this.spellImmune(target) && !opts.basic) return;
    const len = Math.hypot(dx, dz) || 1;
    target.kx += (dx / len) * distance * KNOCK_DECAY;
    target.kz += (dz / len) * distance * KNOCK_DECAY;
  }

  // Shortest signed angle from `from` to `to`, in radians.
  angleDiff(from, to) {
    let d = to - from;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // Dota turn rate: degrees per second is turnRate * 900 (0.6 → 540°/s).
  // Returns true once the hero is facing `desired`.
  turnToward(p, desired, dt) {
    let rate = HEROES[p.hero].turnRate ?? 0.6;
    const haste = this.getEffect(p, 'haste');
    if (haste?.turn) rate *= 1 + haste.turn;
    const maxStep = rate * 900 * (Math.PI / 180) * dt;
    const diff = this.angleDiff(p.facing, desired);
    if (Math.abs(diff) <= maxStep) { p.facing = desired; return true; }
    p.facing += Math.sign(diff) * maxStep;
    return false;
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

  downDummy(target) {
    target.alive = false;
    target.hp = 0;
    target.cast = null;
    target.dash = null;
    target.kx = 0;
    target.kz = 0;
    target.pendingAttack = null;
    target.attackBuffer = null;
    target.effects = [];
    target.respawnAt = this.time + 0.5;
    this.emit({ e: 'death', pid: target.id, x: target.x, z: target.z });
  }

  respawnDummy(p) {
    const homeX = p.homeX ?? 0;
    const homeZ = p.homeZ ?? 2.05;
    p.alive = true;
    p.hp = p.maxHp;
    p.shield = 0;
    p.shieldUntil = 0;
    p.x = homeX;
    p.z = homeZ;
    p.facing = Math.PI;
    p.kx = 0;
    p.kz = 0;
    p.dash = null;
    p.cast = null;
    p.effects = [];
    p.state = {};
    p.flags = {};
    p.pendingAttack = null;
    p.attackBuffer = null;
    p.input.target = null;
    p.respawnAt = 0;
    this.emit({ e: 'text', x: p.x, z: p.z, text: 'RESPAWN', color: '#d9c38a' });
  }

  kill(target, source) {
    target.alive = false;
    target.hp = 0;
    target.cast = null;
    target.dash = null;
    target.pendingAttack = null;
    target.attackBuffer = null;
    this.emit({ e: 'death', pid: target.id, x: target.x, z: target.z });
    if (this.phase === 'fight') {
      const alive = this.order.filter((id) => this.players[id].alive);
      this.endRound(alive.length === 1 ? alive[0] : null);
    }
  }

  enemiesInCone(p, dx, dz, range, halfAngle) {
    const out = [];
    for (const e of this.enemiesOf(p)) {
      if (this.isGhost(e)) continue;
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
      .filter((p) => p.alive && p !== exclude && !this.isGhost(p) && Math.hypot(p.x - x, p.z - z) <= r + ARENA.playerRadius);
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

  livingProps() { return (this.props || []).filter((p) => !p.disabled && p.alive && p.hp > 0); }

  livingPatrol() {
    return (this.props || []).find((p) => p.patrol && !p.disabled && p.alive && p.hp > 0) || null;
  }

  patrolInRadius(x, z, r) {
    const p = this.livingPatrol();
    if (!p) return null;
    return Math.hypot(p.x - x, p.z - z) <= r + p.r ? p : null;
  }

  patrolInCone(origin, dx, dz, range, halfAngle) {
    const p = this.livingPatrol();
    if (!p) return null;
    const ex = p.x - origin.x, ez = p.z - origin.z;
    const d = Math.hypot(ex, ez);
    if (d > range + p.r) return null;
    if (d < 0.01) return p;
    const len = Math.hypot(dx, dz) || 1;
    const cos = (ex * (dx / len) + ez * (dz / len)) / d;
    const ang = Math.acos(Math.max(-1, Math.min(1, cos)));
    if (ang <= halfAngle + Math.atan2(p.r, d)) return p;
    return null;
  }

  patrolInSquare(cx, cz, facing, halfF, halfS) {
    const p = this.livingPatrol();
    if (!p) return null;
    const { f, s } = this.squareLocal(p.x, p.z, cx, cz, facing);
    return Math.abs(f) <= halfF + p.r && Math.abs(s) <= halfS + p.r ? p : null;
  }

  blockedByProp(x, z, r = 0) {
    return this.livingProps().some((pr) => Math.hypot(pr.x - x, pr.z - z) < pr.r + r);
  }

  propsOnSegment(x1, z1, x2, z2, pad = 0) {
    const dx = x2 - x1, dz = z2 - z1;
    const len2 = dx * dx + dz * dz || 1;
    const out = [];
    for (const pr of this.livingProps()) {
      const t = Math.max(0, Math.min(1, ((pr.x - x1) * dx + (pr.z - z1) * dz) / len2));
      const cx = x1 + dx * t, cz = z1 + dz * t;
      if (Math.hypot(pr.x - cx, pr.z - cz) < pr.r + pad) out.push(pr);
    }
    return out;
  }

  squareLocal(x, z, cx, cz, facing) {
    const fx = Math.cos(facing), fz = Math.sin(facing);
    const dx = x - cx, dz = z - cz;
    return { f: dx * fx + dz * fz, s: dx * -fz + dz * fx };
  }

  enemiesInSquare(cx, cz, facing, halfF, halfS, exclude) {
    return this.order
      .map((id) => this.players[id])
      .filter((p) => {
        if (!p.alive || p === exclude || this.isGhost(p)) return false;
        const { f, s } = this.squareLocal(p.x, p.z, cx, cz, facing);
        return Math.abs(f) <= halfF + ARENA.playerRadius && Math.abs(s) <= halfS + ARENA.playerRadius;
      });
  }

  objectsInSquare(cx, cz, facing, halfF, halfS) {
    return this.destructibles().filter((o) => {
      const { f, s } = this.squareLocal(o.x, o.z, cx, cz, facing);
      return Math.abs(f) <= halfF + o.r && Math.abs(s) <= halfS + o.r;
    });
  }

  // True when a straight line between two points crosses a prop (used by the AI; projectiles step instead).
  lineBlocked(x1, z1, x2, z2, pad = 0.2) {
    const dx = x2 - x1, dz = z2 - z1;
    const len2 = dx * dx + dz * dz || 1;
    for (const pr of this.livingProps()) {
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
      if (len > 0.01) p.attackBuffer = null;
      if ((p.input.mx || p.input.mz) && this.hasEffect(p, 'phase')) this.removeEffect(p, 'phase');
    }
    if (Array.isArray(input.aim)) {
      p.input.ax = input.aim[0];
      p.input.az = input.aim[1];
    }
    if ('target' in input) {
      const next = Array.isArray(input.target) ? [input.target[0], input.target[1]] : null;
      if (next && this.hasEffect(p, 'phase')) this.removeEffect(p, 'phase');
      p.input.target = next;
      p.attackBuffer = null;
    }
    if (input.clearAttack) p.attackBuffer = null;
  }

  cast(pid, key, aim, curve) {
    const p = this.players[pid];
    if (!p || !p.alive || this.phase !== 'fight') return;
    if (!Array.isArray(aim) || aim.length < 2) aim = [p.input.ax, p.input.az];
    aim = [Number(aim[0]) || 0, Number(aim[1]) || 0];
    if (Array.isArray(curve) && curve.length >= 2) {
      const cx = Number(curve[0]) || 0;
      const cz = Number(curve[1]) || 0;
      curve = Math.hypot(cx, cz) <= 30 ? [cx, cz] : null;
    } else curve = null;
    const impl = HERO_IMPL[p.hero];
    if (!impl) return;
    if (this.hasEffect(p, 'rabbit')) return;
    if (key === 'attack') {
      if (p.state?.blade && this.time < p.state.blade.until) {
        p.pendingAttack = null;
        p.attackBuffer = null;
        return;
      }
      if (p.dash || this.stunned(p) || this.isGhost(p) || (p.cast && p.cast.key !== 'attack')) return;
      if (this.phase !== 'fight') return;
      if (p.state.held && impl.throwAttack && !this.hasEffect(p, 'rabbit')) {
        impl.throwAttack(this, p, aim, curve);
        p.attackBuffer = null;
        p.pendingAttack = null;
        return;
      }
      const attacking = p.pendingAttack || (p.cast && p.cast.key === 'attack');
      // One attack can wait in the queue. A later attack command replaces it; a move or ability clears it.
      if (attacking || p.cd.attack > 0) {
        p.attackBuffer = { x: aim[0], z: aim[1] };
        return;
      }
      p.attackBuffer = null;
      p.input.target = null;
      p.input.mx = 0;
      p.input.mz = 0;
      p.pendingAttack = { x: aim[0], z: aim[1] };
      return;
    }
    if (!['q', 'w', 'e', 'r'].includes(key)) return;
    if (this.stunned(p) || this.hasEffect(p, 'silence') || this.hasEffect(p, 'phase') || this.hasEffect(p, 'storm')) return;
    // Recast variants (tether pull, shell burst, orb warp, pole strike) are handled by the hero impl even while on cooldown.
    if (impl.recast && impl.recast(this, p, key, aim, curve)) {
      p.attackBuffer = null;
      return;
    }
    if (this.hasEffect(p, 'perch')) return;
    if (p.cd[key] > 0) return;
    if (!this.canCast(p)) return;
    const ok = impl[key](this, p, aim, curve);
    if (ok !== false) {
      p.cd[key] = this.freeCooldowns ? 0 : HEROES[p.hero].abilities[key].cooldown;
      p.input.target = null;
      p.attackBuffer = null;
    }
  }

  release(pid, key, aim) {
    const p = this.players[pid];
    if (!p || !p.alive || this.phase !== 'fight') return;
    if (!Array.isArray(aim) || aim.length < 2) aim = [p.input.ax, p.input.az];
    aim = [Number(aim[0]) || 0, Number(aim[1]) || 0];
    const impl = HERO_IMPL[p.hero];
    if (impl?.release) impl.release(this, p, key, aim);
  }

  sandbox(cmd) {
    if (!this.hasDummy()) return;
    if (typeof cmd.freeCooldowns === 'boolean') {
      this.freeCooldowns = cmd.freeCooldowns;
      if (this.freeCooldowns) this.refreshCooldowns({ keepAttack: true });
    }
    if (cmd.refresh) this.refreshCooldowns();
    if (typeof cmd.propsDisabled === 'boolean') this.setPropsDisabled(cmd.propsDisabled);
    if (cmd.reset) this.resetDummy();
    if (cmd.hero) {
      const id = this.order.find((pid) => !this.players[pid].dummy);
      if (id) this.setHero(id, cmd.hero);
    }
    if (cmd.botHero) {
      const id = this.order.find((pid) => this.players[pid].dummy);
      if (id) this.setHero(id, cmd.botHero);
    }
  }

  refreshCooldowns(opts = {}) {
    for (const id of this.order) {
      const p = this.players[id];
      for (const k of Object.keys(p.cd)) {
        if (opts.keepAttack && k === 'attack') continue;
        p.cd[k] = 0;
      }
    }
  }

  setPropsDisabled(disabled) {
    this.propsDisabled = !!disabled;
    for (const p of this.props || []) {
      if (p.patrol || p.permanent) continue;
      p.disabled = this.propsDisabled;
    }
  }

  rollHero(avoid) {
    const pool = HERO_IDS.filter((id) => id !== avoid);
    const choices = pool.length ? pool : HERO_IDS;
    return choices[Math.floor(Math.random() * choices.length)];
  }

  setHero(pid, heroId) {
    const p = this.players[pid];
    if (!p) return;
    if (heroId === 'random') {
      p.heroPick = 'random';
      heroId = this.rollHero(p.hero);
    } else if (HEROES[heroId]) {
      p.heroPick = heroId;
    }
    const hero = HEROES[heroId];
    if (!hero) return;
    p.hero = heroId;
    p.maxHp = hero.hp;
    p.hp = hero.hp;
    p.shield = 0;
    p.shieldUntil = 0;
    p.effects = [];
    p.cast = null;
    p.dash = null;
    p.kx = 0;
    p.kz = 0;
    p.pendingAttack = null;
    p.attackBuffer = null;
    if (p.state?.tempest?.zone) p.state.tempest.zone.dead = true;
    p.state = {};
    p.flags = {};
    p.cd = {
      attack: 0, q: 0, w: 0, e: 0,
      r: this.openingUltimateCooldown(),
    };
  }

  // ---------- rounds ----------
  resetDummy() {
    for (const id of this.order) {
      const p = this.players[id];
      if (!p.dummy) continue;
      p.respawnAt = 0;
      this.respawnDummy(p);
    }
    const patrol = (this.props || []).find((pr) => pr.patrol);
    if (patrol) {
      patrol.alive = true;
      patrol.hp = patrol.maxHp || DEBUG.patrolHp;
      patrol.kx = 0;
      patrol.kz = 0;
      patrol.effects = [];
      patrol.stuckT = 0;
      const pose = this.advancePatrolPose(patrol);
      patrol.x = pose.x;
      patrol.z = pose.z;
    }
  }

  startRound() {
    this.round += 1;
    if (this.hasDummy()) {
      this.phase = 'fight';
      this.phaseUntil = this.time;
    } else {
      this.phase = 'countdown';
      this.phaseUntil = this.time + ARENA.countdown;
    }
    this.roundTime = 0;
    this.safeRadius = ARENA.radius;
    this.projectiles = [];
    this.zones = [];
    this.resetProps();
    this.healthPackTimer = ARENA.healthPackInterval;
    this.kegTimer = ARENA.kegInterval;
    this.propTimer = ARENA.propReset;
    this.roundWinner = null;
    this.order.forEach((id, i) => {
      const p = this.players[id];
      if (p.heroPick === 'random') p.hero = this.rollHero(p.hero);
      const hero = HEROES[p.hero];
      const s = p.dummy ? { x: 0, z: 2.05, facing: Math.PI } : SPAWNS[i % SPAWNS.length];
      p.x = s.x; p.z = s.z; p.facing = s.facing;
      p.homeX = s.x; p.homeZ = s.z;
      p.hp = hero.hp; p.maxHp = hero.hp;
      p.shield = 0; p.shieldUntil = 0;
      p.kx = 0; p.kz = 0;
      p.dash = null; p.cast = null;
      p.effects = [];
      p.alive = true;
      p.state = {};
      p.flags = {};
      p.input.target = null;
      p.moveLock = 0;
      p.pendingAttack = null;
      p.attackBuffer = null;
      p.cd = { attack: 0, q: 0, w: 0, e: 0, r: this.openingUltimateCooldown() };
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
      this.updatePickups(dt);
    }
    this.updatePatrol(dt);

    for (const id of this.order) this.updatePlayer(this.players[id], dt);
    if (this.phase === 'fight' || this.phase === 'roundend') {
      this.updateProjectiles(dt);
      this.updateZones(dt);
    }
    this.resolveCollisions();
    this.updateDummies();

    if (this.phase === 'fight' && !this.hasDummy() && this.roundTime >= ARENA.roundTimeLimit) {
      const [a, b] = this.order.map((id) => this.players[id]);
      if (a.hp > b.hp) this.endRound(a.id);
      else if (b.hp > a.hp) this.endRound(b.id);
      else this.endRound(null);
    }
  }

  hasDummy() { return this.order.some((id) => this.players[id].dummy); }

  openingUltimateCooldown() {
    return this.freeCooldowns ? 0 : DEBUG.ultimateStartCooldown;
  }

  updateArena(dt) {
    const t = this.roundTime - ARENA.shrinkStart;
    if (!this.hasDummy() && t > 0) {
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
          this.damage(p, 1, null, { kind: 'lava', environment: true });
        }
      }
    }
  }

  resetProps() {
    this.props = PROPS.map((p) => ({
      ...p, hp: ARENA.propHp, maxHp: ARENA.propHp, alive: true, disabled: !!this.propsDisabled && !p.permanent,
    }));
    if (this.hasDummy()) this.addPatrol();
  }

  patrolClear(p, x, z) {
    if (Math.hypot(x, z) > ARENA.wallRadius - p.r) return false;
    for (const pr of this.livingProps()) {
      if (pr === p || pr.patrol) continue;
      if (Math.hypot(x - pr.x, z - pr.z) < pr.r + p.r + 0.12) return false;
    }
    return true;
  }

  advancePatrolPose(p) {
    const perim = PATROL_HALF * 8;
    for (let i = 0; i < 64; i++) {
      const pose = this.patrolPose(this.patrolDist || 0);
      if (!p || this.patrolClear(p, pose.x, pose.z)) return pose;
      this.patrolDist = (this.patrolDist || 0) + perim / 64;
    }
    return this.patrolPose(this.patrolDist || 0);
  }

  patrolPose(dist) {
    const half = PATROL_HALF;
    const side = half * 2;
    const perim = side * 4;
    let d = dist % perim;
    if (d < 0) d += perim;
    if (d < side) return { x: -half + d, z: -half };
    d -= side;
    if (d < side) return { x: half, z: -half + d };
    d -= side;
    if (d < side) return { x: half - d, z: half };
    d -= side;
    return { x: -half, z: half - d };
  }

  addPatrol() {
    const pose = this.advancePatrolPose({ r: 0.85 });
    this.props.push({
      id: 'patrol',
      x: pose.x,
      z: pose.z,
      r: 0.85,
      kind: 'patrol',
      patrol: true,
      hp: DEBUG.patrolHp,
      maxHp: DEBUG.patrolHp,
      alive: true,
      kx: 0,
      kz: 0,
      effects: [],
    });
  }

  updatePatrol(dt) {
    const p = (this.props || []).find((pr) => pr.patrol);
    if (!p) return;
    if (!p.alive) {
      p.kx = 0; p.kz = 0; p.effects = [];
      const pose = this.patrolPose(this.patrolDist || 0);
      p.x = pose.x; p.z = pose.z;
      return;
    }
    p.effects = p.effects || [];
    for (const e of p.effects) {
      if (e.type === 'slow' && e.from != null && e.dur) {
        const t = Math.min(1, Math.max(0, (this.time - e.start) / e.dur));
        e.amount = e.from + (e.to - e.from) * t;
      }
    }
    p.effects = p.effects.filter((e) => this.time < e.until);
    const speed = Math.max(0, PATROL_SPEED * (1 - this.slowOf(p)));
    const knocking = Math.hypot(p.kx || 0, p.kz || 0) > 0.2;
    if (knocking) {
      p.x += p.kx * dt;
      p.z += p.kz * dt;
      const decay = Math.exp(-KNOCK_DECAY * dt);
      p.kx *= decay; p.kz *= decay;
      if (Math.hypot(p.kx, p.kz) < 0.15) { p.kx = 0; p.kz = 0; }
    } else {
      const goal = this.advancePatrolPose(p);
      const dx = goal.x - p.x, dz = goal.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.2) {
        const step = Math.min(dist, speed * dt);
        const nx = p.x + (dx / dist) * step;
        const nz = p.z + (dz / dist) * step;
        if (this.patrolClear(p, nx, nz)) {
          p.x = nx;
          p.z = nz;
          p.stuckT = 0;
        } else {
          p.stuckT = (p.stuckT || 0) + dt;
          this.patrolDist = (this.patrolDist || 0) + Math.max(speed * dt, 0.35);
        }
        if ((p.stuckT || 0) > 0.28) {
          this.patrolDist = (this.patrolDist || 0) + speed * 0.5;
          p.stuckT = 0;
        }
      } else {
        p.stuckT = 0;
        this.patrolDist = (this.patrolDist || 0) + speed * dt;
        const pose = this.advancePatrolPose(p);
        if (Math.hypot(pose.x - p.x, pose.z - p.z) <= 0.45) {
          p.x = pose.x;
          p.z = pose.z;
        }
      }
    }
    const maxR = ARENA.wallRadius - p.r;
    const wall = Math.hypot(p.x, p.z);
    if (wall > maxR && wall > 1e-4) { p.x *= maxR / wall; p.z *= maxR / wall; }
    for (const pr of this.livingProps()) {
      if (pr === p) continue;
      const dx = p.x - pr.x, dz = p.z - pr.z;
      const dist = Math.hypot(dx, dz);
      const min = pr.r + p.r;
      if (dist < min) {
        if (dist < 1e-4) { p.x = pr.x + min; continue; }
        p.x = pr.x + (dx / dist) * min;
        p.z = pr.z + (dz / dist) * min;
      }
    }
  }

  destructibles() {
    const zones = this.zones.filter((z) => (z.kind === 'healthpack' || z.kind === 'keg') && z.hp > 0);
    return zones.concat(this.livingProps());
  }

  objectsInCone(p, dx, dz, range, halfAngle) {
    const out = [];
    for (const z of this.destructibles()) {
      const ex = z.x - p.x, ez = z.z - p.z;
      const d = Math.hypot(ex, ez);
      if (d > range + z.r) continue;
      if (d < 0.01) { out.push(z); continue; }
      const cos = (ex * dx + ez * dz) / d;
      const ang = Math.acos(Math.max(-1, Math.min(1, cos)));
      if (ang <= halfAngle + Math.atan2(z.r, d)) out.push(z);
    }
    return out;
  }

  objectsInRadius(x, z, r) {
    return this.destructibles().filter((o) => Math.hypot(o.x - x, o.z - z) <= r + o.r);
  }

  damageObject(z, amount, source) {
    if (!z || z.permanent || z.hp <= 0 || amount <= 0) return;
    if (z.patrol) {
      z.hp -= amount;
      this.emit({ e: 'hit', x: z.x, z: z.z, amount, kind: 'prop' });
      const max = z.maxHp || DEBUG.patrolHp;
      if (max > 0) {
        while (z.hp <= 0) z.hp += max;
      }
      z.alive = true;
      return;
    }
    z.hp -= amount;
    this.emit({ e: 'hit', x: z.x, z: z.z, amount, kind: z.kind === 'healthpack' ? 'pack' : z.kind === 'keg' ? 'keg' : 'prop' });
    if (z.hp > 0) return;
    z.hp = 0;
    if (z.kind === 'healthpack' || z.kind === 'keg') this.breakObject(z, source);
    else if (z.alive) {
      z.alive = false;
      this.emit({ e: 'propbreak', x: z.x, z: z.z, id: z.id });
    }
  }

  breakObject(z, source) {
    z.hp = 0;
    if (z.kind === 'healthpack') {
      z.dead = true;
      if (source?.alive) this.heal(source, ARENA.healthPackHeal);
      this.emit({ e: 'pickup', pid: source?.id, x: z.x, z: z.z });
      return;
    }
    if (z.kind === 'keg' && !z.fusing) {
      z.fusing = true;
      z.killer = source || null;
      z.until = this.time + ARENA.kegFuse;
      z.onExpire = (sim, zone) => sim.explodeKeg(zone);
      this.emit({ e: 'text', x: z.x, z: z.z, text: 'FUSE', color: '#ffb347' });
    }
  }

  explodeKeg(z) {
    this.emit({ e: 'explode', x: z.x, z: z.z, r: ARENA.kegBlast, color: '#ff8a1a' });
    const source = z.killer;
    for (const id of this.order) {
      const p = this.players[id];
      if (p.alive && Math.hypot(p.x - z.x, p.z - z.z) <= ARENA.kegBlast + ARENA.playerRadius) {
        this.damage(p, ARENA.kegDamage, source, { kind: 'fire', environment: true });
      }
    }
    for (const o of this.destructibles()) {
      if (Math.hypot(o.x - z.x, o.z - z.z) <= ARENA.kegBlast + o.r) this.damageObject(o, ARENA.kegDamage, source);
    }
  }

  updatePickups(dt) {
    this.healthPackTimer -= dt;
    if (this.healthPackTimer <= 0) {
      this.healthPackTimer = ARENA.healthPackInterval;
      const alive = this.zones.some((z) => z.kind === 'healthpack' && z.hp > 0);
      if (!alive) {
        this.addZone({
          kind: 'healthpack', x: 0, z: 0, r: ARENA.healthPackRadius,
          hp: ARENA.healthPackHp, maxHp: ARENA.healthPackHp, until: Infinity, owner: null,
        });
        this.emit({ e: 'packspawn', x: 0, z: 0 });
      }
    }
    this.kegTimer -= dt;
    if (this.kegTimer <= 0) {
      this.kegTimer = ARENA.kegInterval;
      this.zones = this.zones.filter((z) => z.kind !== 'keg' || z.fusing);
      for (let n = 0; n < ARENA.kegCount; n++) this.spawnKeg();
    }
    this.propTimer -= dt;
    if (this.propTimer <= 0) {
      this.propTimer = ARENA.propReset;
      for (const tmpl of PROPS) {
        if (this.props.some((p) => p.id === tmpl.id)) continue;
        this.props.push({
          ...tmpl,
          hp: ARENA.propHp,
          maxHp: ARENA.propHp,
          alive: true,
          disabled: !!this.propsDisabled && !tmpl.permanent,
        });
      }
      for (const p of this.props) {
        if (p.temp) continue;
        p.hp = p.maxHp;
        p.alive = true;
        if (p.patrol) { p.kx = 0; p.kz = 0; p.effects = []; }
      }
    }
  }

  spawnKeg() {
    for (let tries = 0; tries < 40; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = 4 + Math.random() * Math.max(0, this.safeRadius - 6);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (this.blockedByProp(x, z, 1.2)) continue;
      if (this.zones.some((o) => (o.kind === 'keg' || o.kind === 'healthpack') && Math.hypot(o.x - x, o.z - z) < 2.5)) continue;
      if (this.order.some((id) => Math.hypot(this.players[id].x - x, this.players[id].z - z) < 2.5)) continue;
      this.addZone({
        kind: 'keg', x, z, r: ARENA.kegRadius,
        hp: ARENA.kegHp, maxHp: ARENA.kegHp, until: Infinity, owner: null,
      });
      return;
    }
  }

  updatePlayer(p, dt) {
    if (!p.alive) return;
    const hero = HEROES[p.hero];

    if (this.phase === 'fight' || this.freeCooldowns) {
      for (const k of Object.keys(p.cd)) {
        if (k === 'attack') {
          if (this.phase === 'fight' && p.cd[k] > 0) {
            const haste = 1 + (this.getEffect(p, 'attackSpeed')?.amount || 0);
            p.cd[k] = Math.max(0, p.cd[k] - dt * haste);
          }
        } else if (this.freeCooldowns) p.cd[k] = 0;
        else if (p.cd[k] > 0) p.cd[k] = Math.max(0, p.cd[k] - dt);
      }
    }
    if (p.shield > 0 && p.shieldUntil && this.time >= p.shieldUntil) {
      p.shield = 0;
      this.onShieldBroken(p);
    }

    // Status effects
    const stunned = this.stunned(p);
    const phased = this.hasEffect(p, 'phase');
    const stormed = this.hasEffect(p, 'storm');
    const perched = this.hasEffect(p, 'perch');
    const rabbit = this.hasEffect(p, 'rabbit');
    for (const e of p.effects) {
      if (e.type === 'slow' && e.from != null && e.dur) {
        const t = Math.min(1, Math.max(0, (this.time - e.start) / e.dur));
        e.amount = e.from + (e.to - e.from) * t;
      }
      if (e.type === 'burn') {
        e.acc = (e.acc || 0) + (e.dps || 0) * dt;
        if (e.acc >= 1) { e.acc -= 1; this.damage(p, 1, null, { kind: 'burn' }); }
      }
      if (e.type === 'poison') {
        const interval = e.interval || 1;
        e.acc = (e.acc || 0) + dt;
        while (e.acc >= interval) {
          e.acc -= interval;
          this.damage(p, e.tickDamage || 1, null, { kind: 'poison' });
        }
        if (this.poisonHeld(p, e)) e.until += dt;
      }
    }
    p.effects = p.effects.filter((e) => this.time < e.until);
    if (!p.alive) return;

    if ((stunned || rabbit) && p.cast) {
      this.emit({ e: 'interrupt', pid: p.id });
      p.cast = null;
    }
    const spinning = p.state?.blade && this.time < p.state.blade.until;
    if (spinning) {
      p.pendingAttack = null;
      p.attackBuffer = null;
      if (p.cast?.key === 'attack') {
        this.emit({ e: 'interrupt', pid: p.id });
        p.cast = null;
      }
    }
    if (stunned || phased || stormed || perched || rabbit) { p.pendingAttack = null; p.attackBuffer = null; }
    if (p.attackBuffer && !p.pendingAttack && p.cd.attack <= 0 && !p.cast && !p.dash && !stunned && !phased && !stormed && !spinning && !perched && this.phase === 'fight') {
      p.pendingAttack = p.attackBuffer;
      p.attackBuffer = null;
      p.input.target = null;
      p.input.mx = 0;
      p.input.mz = 0;
    }

    if (p.pendingAttack && !p.cast && !p.dash) {
      const desired = Math.atan2(p.pendingAttack.z - p.z, p.pendingAttack.x - p.x);
      if (this.turnToward(p, desired, dt)) {
        const aim = [p.pendingAttack.x, p.pendingAttack.z];
        p.pendingAttack = null;
        let windup = HEROES[p.hero].attack.windup ?? 0.12;
        const attackSpeed = this.getEffect(p, 'attackSpeed');
        if (attackSpeed?.amount) windup /= 1 + attackSpeed.amount;
        this.startCast(p, 'attack', windup, aim, (firedAim) => {
          HERO_IMPL[p.hero].attack(this, p, firedAim);
        });
      }
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

    // Movement. Facing follows the move direction at the hero's turn rate, never the cursor.
    const attacking = p.pendingAttack || (p.cast && p.cast.key === 'attack');
    if (p.dash) {
      const step = Math.min(p.dash.speed * dt, p.dash.remaining);
      const nx = p.x + p.dash.dx * step, nz = p.z + p.dash.dz * step;
      const hitWall = Math.hypot(nx, nz) > ARENA.wallRadius - ARENA.playerRadius;
      if (p.dash.smash) {
        for (const pr of this.propsOnSegment(p.x, p.z, nx, nz, ARENA.playerRadius)) this.damageObject(pr, pr.hp, p);
      }
      const hitProp = !p.dash.over && !p.dash.smash && this.blockedByProp(nx, nz, ARENA.playerRadius);
      if (hitWall || hitProp) {
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
    } else if (this.phase === 'fight' && !attacking && !stunned && !phased && !stormed && !perched && !p.cast && !this.rooted(p)) {
      let mx = p.input.mx, mz = p.input.mz;
      if (Math.hypot(mx, mz) < 0.01 && p.input.target) {
        const tx = p.input.target[0] - p.x, tz = p.input.target[1] - p.z;
        const d = Math.hypot(tx, tz);
        if (d < 0.15) p.input.target = null;
        else { mx = tx / d; mz = tz / d; }
      } else if (Math.hypot(mx, mz) >= 0.01) {
        p.input.target = null;
      }
      if (Math.hypot(mx, mz) > 0.01) this.turnToward(p, Math.atan2(mz, mx), dt);
      let speed = hero.speed * (1 - this.slowOf(p));
      if (this.hasEffect(p, 'haste')) speed *= 1 + (this.getEffect(p, 'haste').amount || 0);
      p.x += mx * speed * dt;
      p.z += mz * speed * dt;
    }

    if (perched || stormed) {
      p.kx = 0; p.kz = 0;
    } else if (Math.abs(p.kx) > 0.01 || Math.abs(p.kz) > 0.01) {
      p.x += p.kx * dt;
      p.z += p.kz * dt;
      const decay = Math.exp(-KNOCK_DECAY * dt);
      p.kx *= decay; p.kz *= decay;
      if (Math.hypot(p.kx, p.kz) < 0.15) { p.kx = 0; p.kz = 0; }
    }
    if (this.freeCooldowns) {
      for (const k of Object.keys(p.cd)) if (k !== 'attack') p.cd[k] = 0;
    }
  }

  resolveCollisions() {
    const R = ARENA.playerRadius;
    const ps = this.order.map((id) => this.players[id]).filter((p) => p.alive && !this.hasEffect(p, 'perch'));
    for (const p of ps) {
      if (!p.dash?.over) {
        for (const pr of this.livingProps()) {
          const dx = p.x - pr.x, dz = p.z - pr.z;
          const d = Math.hypot(dx, dz);
          const min = pr.r + R;
          if (d < min) {
            if (d < 1e-4) { p.x = pr.x + min; continue; }
            p.x = pr.x + (dx / d) * min;
            p.z = pr.z + (dz / d) * min;
          }
        }
      }
      const d = Math.hypot(p.x, p.z);
      const max = ARENA.wallRadius - R;
      if (d > max) { p.x *= max / d; p.z *= max / d; }
    }
    if (ps.length === 2 && !ps.some((p) => p.dash?.pass || this.hasEffect(p, 'storm'))) {
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

  updateDummies() {
    if (!this.hasDummy()) return;
    for (const id of this.order) {
      const p = this.players[id];
      if (!p.dummy || p.alive || !p.respawnAt) continue;
      if (this.time >= p.respawnAt) this.respawnDummy(p);
    }
  }

  updateProjectiles(dt) {
    const R = ARENA.playerRadius;
    for (const pr of this.projectiles) {
      const step = pr.speed * dt;
      const sub = Math.max(1, Math.ceil(step / 0.3));
      for (let s = 0; s < sub && !pr.dead; s++) {
        const ds = Math.min(step / sub, pr.remaining);
        if (pr.arc) {
          pr.traveled = (pr.traveled || 0) + ds;
          const t = Math.min(1, pr.traveled / pr.arc.len);
          const [nx, nz] = quadPoint(pr.arc.p0, pr.arc.p1, pr.arc.p2, t);
          const vx = nx - pr.x, vz = nz - pr.z;
          const vl = Math.hypot(vx, vz);
          if (vl > 1e-5) { pr.dx = vx / vl; pr.dz = vz / vl; }
          pr.x = nx; pr.z = nz;
        } else {
          pr.x += pr.dx * ds;
          pr.z += pr.dz * ds;
          pr.traveled = (pr.traveled || 0) + ds;
        }
        pr.remaining -= ds;
        const owner = this.players[pr.owner];
        for (const z of this.destructibles()) {
          if (pr.hit.has(z.id)) continue;
          const pad = pr.r < 0.6 ? ARENA.projectilePadding : 0;
          if (Math.hypot(z.x - pr.x, z.z - pr.z) <= pr.r + z.r + pad) {
            pr.hit.add(z.id);
            if (pr.onHitObject) pr.onHitObject(this, pr, z);
            else if (pr.objectDamage) this.damageObject(z, pr.objectDamage, owner);
            if (!pr.pierce) { pr.dead = true; break; }
          }
        }
        if (pr.dead) break;
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
        if (pr.flyover) {
          if (pr.onTick) pr.onTick(this, pr, dt / sub);
          if (pr.remaining <= 1e-4 && !pr.dead) {
            pr.dead = true;
            if (pr.onExpire) pr.onExpire(this, pr, 'range');
          }
          continue;
        }
        for (const e of this.enemiesOf(owner)) {
          if (pr.hit.has(e.id) || this.isGhost(e)) continue;
          const pad = pr.r < 0.6 ? ARENA.projectilePadding : 0;
          if (Math.hypot(e.x - pr.x, e.z - pr.z) <= pr.r + R + pad) {
            if (!pr.basic && this.spellImmune(e)) {
              pr.hit.add(e.id);
              this.emit({ e: 'text', x: e.x, z: e.z, text: 'IMMUNE', color: '#f0d78c' });
              continue;
            }
            pr.hit.add(e.id);
            if (this.tryDodge(e)) {
              if (!pr.pierce) { pr.dead = true; break; }
              continue;
            }
            if (pr.onHit) pr.onHit(this, pr, e);
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
    this.projectiles = this.projectiles.filter((p) => {
      if (p.dead && p.onDie) p.onDie(this, p);
      return !p.dead;
    });
  }

  updateZones(dt) {
    for (const z of this.zones) {
      if (z.onTick) z.onTick(this, z, dt);
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
        pick: p.heroPick === 'random' ? 'random' : undefined,
        x: +p.x.toFixed(3), z: +p.z.toFixed(3), f: +p.facing.toFixed(3),
        hp: p.hp, maxHp: p.maxHp, sh: p.shield,
        cd: { a: +p.cd.attack.toFixed(2), q: +p.cd.q.toFixed(2), w: +p.cd.w.toFixed(2), e: +p.cd.e.toFixed(2), r: +p.cd.r.toFixed(2) },
        fx: p.effects.map((e) => e.type),
        ps: this.poisonStacks(p) || undefined,
        cast: p.cast ? { key: p.cast.key, t: +((this.time - p.cast.started) / (p.cast.until - p.cast.started)).toFixed(2) } : null,
        dash: p.dash ? p.dash.kind : null,
        alive: p.alive,
        dummy: p.dummy || undefined,
        flags: p.flags,
      };
    });
    const proj = this.projectiles.map((pr) => ({
      id: pr.id, k: pr.kind, x: +pr.x.toFixed(3), z: +pr.z.toFixed(3), r: pr.r,
      dx: +pr.dx.toFixed(3), dz: +pr.dz.toFixed(3), o: pr.owner,
      tr: pr.traveled ? +pr.traveled.toFixed(2) : undefined,
      flame: pr.flame || undefined,
    }));
    const zones = this.zones.map((z) => ({
      id: z.id, k: z.kind, x: +z.x.toFixed(3), z: +z.z.toFixed(3), r: z.r, o: z.owner,
      f: z.f != null ? +Number(z.f).toFixed(3) : undefined,
      w: z.w != null ? +Number(z.w).toFixed(3) : undefined,
      hp: z.hp, maxHp: z.maxHp, fuse: z.fusing || undefined,
      storm: z.storm || undefined,
      lift: z.lift != null ? +Number(z.lift).toFixed(3) : undefined,
      blade: z.blade != null ? +Number(z.blade).toFixed(3) : undefined,
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
      props: (this.props || []).map((p) => ({
        id: p.id, hp: p.hp, maxHp: p.maxHp, alive: !!(p.alive && !p.disabled),
        x: +p.x.toFixed(3), z: +p.z.toFixed(3), r: p.r, kind: p.kind,
        patrol: p.patrol || undefined,
        permanent: p.permanent || undefined,
      })),
      ev: this.events,
    };
    this.events = [];
    return snap;
  }
}
