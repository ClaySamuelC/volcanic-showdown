// Practice-mode bot. Drives a Sim player through the same setInput/cast API a human client uses.
import { HEROES } from '../shared/heroes.js';

const DIFFICULTY = {
  dummy:  { dummy: true },
  easy:   { react: 1.15, aimError: 2.8, abilityChance: 0.16, decide: 0.9, dodge: false, lead: 0, strafe: 0.05, attackGap: 1.85, ult: 0.04, timid: true },
  normal: { react: 0.30, aimError: 0.9, abilityChance: 0.85, decide: 0.22, dodge: true, lead: 0.7, strafe: 0.8 },
  hard:   { react: 0.14, aimError: 0.25, abilityChance: 1.0, decide: 0.12, dodge: true, lead: 1.0, strafe: 1.0 },
};

const PREF_RANGE = { minotaur: 1.4, groundskeeper: 5.0, tidebinder: 6.5, fuck: 7.0, python: 4.2, monk: 2.0, illusionist: 6.2, stone: 1.6, shock: 2.1 };
const ATTACK_RANGE = { minotaur: 2.5, groundskeeper: 6.3, tidebinder: 8.3, fuck: 8.5, python: 7.4, monk: 5.5, illusionist: 7.2, stone: 2.4, shock: 2.5 };
const BASIC_PROJECTILES = new Set(['bolt', 'brine', 'orb', 'dart', 'spark']);

function isMelee(hero) { return hero === 'minotaur' || hero === 'stone' || hero === 'shock'; }

function norm(x, z) { const l = Math.hypot(x, z) || 1; return [x / l, z / l]; }

export class BotController {
  constructor(sim, pid, difficulty = 'normal') {
    this.sim = sim;
    this.pid = pid;
    this.cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal;
    this.decideTimer = 0;
    this.strafeSign = 1;
    this.aimErr = [0, 0];
    this.lastEnemyPos = null;
    this.enemyVel = [0, 0];
    this.nextAttackAt = 0;
    this.nextAbilityAt = 0;
    this.mode = 'engage';
    this.tetherAt = 0;
    this.lastRound = 0;
  }

  get me() { return this.sim.players[this.pid]; }
  get enemy() { return this.sim.other(this.me); }

  tick(dt) {
    const sim = this.sim;
    const me = this.me, en = this.enemy;
    if (sim.round !== this.lastRound) { this.lastRound = sim.round; this.nextAttackAt = sim.time + 1; this.nextAbilityAt = sim.time + 1.2; }
    if (this.cfg.dummy) {
      if (sim.phase === 'fight' && en.alive) sim.setInput(this.pid, { move: [0, 0], aim: [en.x, en.z], target: null });
      return;
    }
    if (sim.phase !== 'fight' || !me.alive || !en.alive) return;
    if (sim.hasEffect(me, 'phase') || sim.hasEffect(me, 'storm')) {
      sim.setInput(this.pid, { move: [0, 0], aim: [en.x, en.z] });
      return;
    }

    // enemy velocity estimate
    if (this.lastEnemyPos) {
      const vx = (en.x - this.lastEnemyPos[0]) / dt, vz = (en.z - this.lastEnemyPos[1]) / dt;
      this.enemyVel = [this.enemyVel[0] * 0.7 + vx * 0.3, this.enemyVel[1] * 0.7 + vz * 0.3];
    }
    this.lastEnemyPos = [en.x, en.z];

    const d = Math.hypot(en.x - me.x, en.z - me.z);
    if (sim.hasEffect(me, 'perch')) {
      sim.setInput(this.pid, { move: [0, 0], aim: [en.x, en.z] });
      const since = sim.time - (me.state.perchAt ?? sim.time);
      const left = (sim.getEffect(me, 'perch')?.until ?? sim.time) - sim.time;
      const close = d <= HEROES.monk.abilities.w.strikeRadius + 0.4;
      if (sim.time >= this.nextAbilityAt && (close || left < 0.45 || since >= 1.1)) {
        sim.cast(this.pid, 'w', this.predict(0.15));
        this.nextAbilityAt = sim.time + this.cfg.react + 0.1;
      }
      return;
    }
    const [tx, tz] = norm(en.x - me.x, en.z - me.z);
    const hero = HEROES[me.hero];

    if (me.hero === 'stone' && me.cast?.key === 'w') {
      sim.setInput(this.pid, { move: [0, 0], aim: this.predict(0.15) });
      const elapsed = sim.time - me.cast.started;
      const want = d < 2.5 ? 1.05 : 0.45;
      if (elapsed >= want) sim.release(this.pid, 'w', this.predict(0.1));
      return;
    }

    this.decideTimer -= dt;
    if (this.decideTimer <= 0) {
      this.decideTimer = this.cfg.decide;
      this.decide(d);
    }

    const move = this.computeMove(d, tx, tz);
    const pack = this.mode === 'pack' ? this.nearestPack() : null;
    const aim = pack ? [pack.x, pack.z] : this.predict(hero.attack.speed ? d / hero.attack.speed : 0);
    sim.setInput(this.pid, { move, aim });

    const reach = this.attackRange();
    const sweep = me.hero === 'monk' && (me.state.combo || 0) === 0;
    const gap = this.cfg.attackGap ?? this.cfg.react * 0.5;
    const timidFar = this.cfg.timid && d > reach + 0.3;
    if (!timidFar && pack && sim.time >= this.nextAttackAt && me.cd.attack <= 0 && !me.cast && !me.dash && pack.dist <= reach + 0.4) {
      sim.cast(this.pid, 'attack', [pack.x, pack.z]);
      this.nextAttackAt = sim.time + gap;
    } else if (!timidFar && sim.time >= this.nextAttackAt && me.cd.attack <= 0 && d <= reach * (this.cfg.timid ? 0.82 : 1) && !me.cast && !me.dash) {
      if (isMelee(me.hero) || sweep || !sim.lineBlocked(me.x, me.z, en.x, en.z)) {
        sim.cast(this.pid, 'attack', aim);
        this.nextAttackAt = sim.time + gap;
      }
    }

    if (sim.time >= this.nextAbilityAt && !me.cast) {
      const used = this.useAbilities(d, tx, tz);
      if (used) this.nextAbilityAt = sim.time + this.cfg.react + 0.1;
    }
  }

  decide(d) {
    if (Math.random() < 0.3) this.strafeSign *= -1;
    const e = this.cfg.aimError;
    this.aimErr = [(Math.random() - 0.5) * 2 * e, (Math.random() - 0.5) * 2 * e];
    const me = this.me;
    const pack = this.nearestPack();
    const melee = isMelee(me.hero);
    const cheapPack = pack && pack.dist < (melee ? 4 : 7) && pack.dist < pack.enemyDist && !this.cfg.timid;
    if (pack && (me.hp <= 3 || (!this.cfg.timid && me.hp <= 6) || (me.hp <= 9 && cheapPack))) this.mode = 'pack';
    else if (this.cfg.timid) this.mode = Math.random() < 0.62 ? 'idle' : 'engage';
    else if (me.hp <= 3 && this.enemy.hp > me.hp && !isMelee(me.hero)) this.mode = 'kite';
    else this.mode = 'engage';
  }

  nearestPack() {
    const me = this.me, en = this.enemy;
    let best = null;
    for (const z of this.sim.zones) {
      if (z.kind !== 'healthpack') continue;
      const dist = Math.hypot(z.x - me.x, z.z - me.z);
      if (!best || dist < best.dist) best = { x: z.x, z: z.z, dist, enemyDist: Math.hypot(z.x - en.x, z.z - en.z) };
    }
    return best;
  }

  predict(travelTime) {
    const en = this.enemy;
    const t = Math.min(0.6, travelTime) * this.cfg.lead;
    return [en.x + this.enemyVel[0] * t + this.aimErr[0], en.z + this.enemyVel[1] * t + this.aimErr[1]];
  }

  attackRange() {
    const me = this.me;
    if (me.hero === 'shock' && me.flags?.dash) return HEROES.shock.attack.range * HEROES.shock.abilities.e.rangeScale + 0.25;
    if (me.hero !== 'monk') return ATTACK_RANGE[me.hero];
    const atk = HEROES.monk.attack;
    const step = me.state.combo || 0;
    if (step === 1) return atk.doubleRange + 0.35;
    if (step === 2) return atk.lineRange + 0.2;
    return atk.sweepRange + 0.45;
  }

  incomingProjectile(ignoreBasic = false) {
    const me = this.me;
    for (const pr of this.sim.projectiles) {
      if (pr.owner === this.pid) continue;
      if (ignoreBasic && BASIC_PROJECTILES.has(pr.kind)) continue;
      const rx = me.x - pr.x, rz = me.z - pr.z;
      const along = rx * pr.dx + rz * pr.dz;
      if (along < 0 || along > pr.speed * 0.7) continue;
      const perp = Math.abs(rx * -pr.dz + rz * pr.dx);
      if (perp < pr.r + 1.0) return pr;
    }
    return null;
  }

  computeMove(d, tx, tz) {
    const sim = this.sim, me = this.me, en = this.enemy;
    let mx = 0, mz = 0;
    const pref = PREF_RANGE[me.hero];

    if (this.mode === 'pack') {
      const pack = this.nearestPack();
      if (pack) { [mx, mz] = norm(pack.x - me.x, pack.z - me.z); }
      else this.mode = 'engage';
    }
    if (this.mode === 'idle') return [0, 0];
    if (this.mode === 'kite') {
      mx = -tx; mz = -tz;
    } else if (this.mode === 'engage') {
      if (this.cfg.timid) {
        if (d > pref + 4) { mx = tx; mz = tz; }
      } else {
        let radial = 0;
        if (d > pref + 1.0) radial = 1;
        else if (d < pref - 1.0) radial = -1;
        const tangential = isMelee(me.hero) ? (radial > 0 ? 0 : 0.5 * this.strafeSign) : this.cfg.strafe * this.strafeSign * 0.8;
        mx = tx * radial + (-tz) * tangential;
        mz = tz * radial + tx * tangential;
        if (!isMelee(me.hero) && sim.lineBlocked(me.x, me.z, en.x, en.z)) { mx += -tz * this.strafeSign; mz += tx * this.strafeSign; }
      }
    }

    // dodge projectiles (melee only sidesteps ability projectiles, and never when already closing in)
    if (this.cfg.dodge && !(isMelee(me.hero) && d < 3.5)) {
      const pr = this.incomingProjectile(isMelee(me.hero));
      if (pr) {
        const side = ((me.x - pr.x) * -pr.dz + (me.z - pr.z) * pr.dx) >= 0 ? 1 : -1;
        mx += -pr.dz * side * 2; mz += pr.dx * side * 2;
      }
    }

    // stay out of lava
    const dc = Math.hypot(me.x, me.z);
    if (dc > sim.safeRadius - 1.6) {
      const w = Math.min(3, (dc - (sim.safeRadius - 1.6)) * 2 + 1);
      mx += (-me.x / dc) * w; mz += (-me.z / dc) * w;
    }

    // steer around props
    const [nx, nz] = norm(mx, mz);
    if (Math.hypot(mx, mz) > 0.01) {
      const ax = me.x + nx * 1.3, az = me.z + nz * 1.3;
      if (sim.blockedByProp(ax, az, 0.6)) {
        const s = this.strafeSign;
        mx = -nz * s; mz = nx * s;
      }
    }
    if (Math.hypot(mx, mz) < 0.01) return [0, 0];
    return norm(mx, mz);
  }

  useAbilities(d, tx, tz) {
    const sim = this.sim, me = this.me, en = this.enemy;
    const roll = () => Math.random() < this.cfg.abilityChance;
    const ultOk = this.cfg.ult == null || Math.random() < this.cfg.ult;
    const los = !sim.lineBlocked(me.x, me.z, en.x, en.z);
    const cast = (key, aim, curve) => { sim.cast(this.pid, key, aim, curve); return true; };
    const ahead = (t) => { const p = this.predict(t); return p; };

    if (me.hero === 'minotaur') {
      const fire = sim.hasEffect(me, 'fire');
      if (me.cd.r <= 0 && ultOk && d < 10 && roll()) return cast('r', [en.x, en.z]);
      if (me.cd.e <= 0 && roll() && ((fire && d < 2.6) || (!fire && me.hp <= 11 && d < 8))) return cast('e', [en.x, en.z]);
      if (me.cd.q <= 0 && d < 3.6 && roll()) return cast('q', ahead(0.35));
      if (me.cd.w <= 0 && !me.dash && d > 2.2 && d < (fire ? 11.5 : 7.5) && roll()) return cast('w', ahead(0.3));
      return false;
    }

    if (me.hero === 'groundskeeper') {
      if (me.state.tether) {
        if (!this.tetherAt) this.tetherAt = sim.time;
        if (sim.time - this.tetherAt > 0.35) {
          this.tetherAt = 0;
          const th = me.state.tether;
          if (th.type === 'target' && (d > 3.5 || me.cd.r <= 0)) return cast('q', [en.x, en.z]);
          if (th.type === 'ground' && (me.hp <= 5 || d < 2.5)) return cast('q', [th.x, th.z]);
        }
      } else this.tetherAt = 0;
      if (me.cd.r <= 0 && ultOk && d < 2.3 && roll()) return cast('r', [en.x, en.z]);
      if (me.cd.w <= 0 && !me.dash && roll()) {
        if (d < 2.6 && me.cd.r > 0) return cast('w', [me.x - tx * 4, me.z - tz * 4]);
        if (d > 9) return cast('w', [en.x, en.z]);
      }
      if (me.cd.e <= 0 && d < 5.5 && d > 1.5 && roll()) return cast('e', [en.x, en.z]);
      if (me.cd.q <= 0 && !me.state.tether && d > 2.5 && d < 8.5 && los && roll()) return cast('q', ahead(d / 20));
      return false;
    }

    if (me.hero === 'fuck') {
      if (me.state.orb && !me.state.orb.dead) {
        const pr = me.state.orb;
        const orbD = Math.hypot(pr.x - en.x, pr.z - en.z);
        const away = Math.hypot(pr.x - me.x, pr.z - me.z);
        if ((me.hp <= 4 && orbD > d + 1.5) || (orbD < 2.2 && d > 3.5) || away > 6) return cast('q', [pr.x, pr.z]);
      }
      if (me.cd.r <= 0 && ultOk && d < 9 && los && roll()) return cast('r', ahead(0.25));
      if (me.cd.e <= 0 && roll() && (me.hp <= 4 || (this.cfg.dodge && this.incomingProjectile()))) return cast('e', [me.x, me.z]);
      if (me.cd.w <= 0 && d < 2.6 && roll()) return cast('w', [en.x, en.z]);
      if (me.cd.q <= 0 && !me.state.orb && d < 14 && los && roll()) return cast('q', ahead(d / 11));
      return false;
    }

    if (me.hero === 'python') {
      if (me.cd.r <= 0 && ultOk && d < 8.5 && roll()) return cast('r', ahead(0.3));
      if (me.cd.q <= 0 && !me.dash && d > 2.2 && d < 7.2 && roll()) return cast('q', ahead(0.25));
      if (me.cd.w <= 0 && d < (HEROES.python.abilities.w.length - HEROES.python.abilities.w.behind + 0.5) && roll()) return cast('w', ahead(0.35));
      return false;
    }

    if (me.hero === 'monk') {
      const kit = HEROES.monk.abilities;
      const threatened = me.hp <= 6 || en.cast || (d < 2.6 && (en.hero === 'minotaur' || en.hero === 'monk')) || (this.cfg.dodge && this.incomingProjectile());
      if (me.cd.r <= 0 && ultOk && d < 7 && roll()) return cast('r', [en.x, en.z]);
      if (me.cd.e <= 0 && threatened && roll()) return cast('e', [me.x, me.z]);
      if (me.cd.q <= 0 && d < kit.q.range + 0.3 && roll()) return cast('q', ahead(0.12));
      if (me.cd.w <= 0 && !me.dash && roll()) {
        if (me.hp <= 4 && d < 4) return cast('w', [me.x - tx * 6, me.z - tz * 6]);
        if (d > 3.4 && d < kit.w.castRange) return cast('w', ahead(0.2));
      }
      return false;
    }

    if (me.hero === 'illusionist') {
      const bolt = sim.projectiles.find((pr) => pr.guided && pr.owner === me.id && !pr.dead && !pr.redirected && (pr.traveled || 0) > 1.2);
      if (bolt) return cast('q', ahead(0.3));
      const ghost = me.state.ghost;
      if (ghost && !ghost.dead && (me.state.swaps || 0) > 0) {
        const gd = Math.hypot(ghost.x - en.x, ghost.z - en.z);
        if (me.hp <= 4 || gd + 1.2 < d) return cast('w', [ghost.x, ghost.z]);
      }
      if (me.cd.r <= 0 && ultOk && d < 5.2 && roll()) return cast('r', [en.x, en.z]);
      if (me.cd.e <= 0 && d < 8.5 && !sim.hasEffect(en, 'rabbit') && roll()) return cast('e', ahead(0.35));
      if (me.cd.w <= 0 && !ghost && d < 9 && roll()) return cast('w', ahead(0.2));
      if (me.cd.q <= 0 && !me.flags?.qRecast && d < 14 && los && roll()) return cast('q', ahead(d / 6.5));
      return false;
    }

    if (me.hero === 'shock') {
      const kit = HEROES.shock.abilities;
      if (sim.hasEffect(me, 'storm')) return false;
      if (me.cd.r <= 0 && ultOk && d < 8 && roll()) return cast('r', [en.x, en.z]);
      if (me.cd.e <= 0 && (d < kit.e.endRadius + 0.3 || me.hp <= 4) && roll()) return cast('e', [me.x, me.z]);
      if (me.cd.q <= 0 && d < kit.q.castRange && los && roll()) return cast('q', ahead(kit.q.delay));
      if (me.cd.w <= 0 && !me.dash && d > 1.3 && d < kit.w.distance + 0.4 && roll()) return cast('w', ahead(0.12));
      return false;
    }

    if (me.hero === 'stone') {
      if (me.flags?.holding) {
        const side = this.strafeSign;
        const [px, pz] = norm(-(en.z - me.z), en.x - me.x);
        return cast('attack', ahead(0.25), [px * 2.2 * side, pz * 2.2 * side]);
      }
      if (me.cd.r <= 0 && ultOk && d < 11 && roll()) return cast('r', ahead(0.45));
      if (me.cd.q <= 0 && d < HEROES.stone.abilities.q.maxReach && roll()) return cast('q', [en.x, en.z]);
      if (me.cd.e <= 0 && d > 2.2 && d < 8 && roll()) return cast('e', ahead(0.3));
      const rockNear = sim.livingProps().some((pr) => !pr.permanent && (pr.kind === 'boulder' || pr.kind === 'shed' || pr.kind === 'meteor') && Math.hypot(pr.x - me.x, pr.z - me.z) <= HEROES.stone.abilities.w.pickupRange + pr.r);
      if (me.cd.w <= 0 && rockNear && roll()) return cast('w', [en.x, en.z]);
      return false;
    }

    // tidebinder
    const soaked = sim.hasEffect(en, 'soaked');
    if (sim.hasEffect(me, 'shell') && d < 2.3) return cast('e', [en.x, en.z]);
    if (me.cd.r <= 0 && ultOk && d < 12 && los && (soaked || en.hp <= 6 || me.hp <= 5) && roll()) return cast('r', ahead(0.8 + d / 10));
    if (me.cd.e <= 0 && roll() && (d < 3 || (this.cfg.dodge && this.incomingProjectile()) || me.hp <= 4)) return cast('e', [en.x, en.z]);
    if (me.cd.w <= 0 && d < 8 && (soaked || d < 6) && roll()) return cast('w', ahead(0.55));
    if (me.cd.q <= 0 && d < 7.5 && los && roll()) return cast('q', ahead(d / 12));
    return false;
  }
}

export const DIFFICULTIES = Object.keys(DIFFICULTY);
