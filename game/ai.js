// Practice-mode bot. Drives a Sim player through the same setInput/cast API a human client uses.
import { HEROES } from '../shared/heroes.js';

const DIFFICULTY = {
  easy:   { react: 0.55, aimError: 1.4, abilityChance: 0.45, decide: 0.35, dodge: false, lead: 0.4, strafe: 0.4 },
  normal: { react: 0.30, aimError: 0.9, abilityChance: 0.85, decide: 0.22, dodge: true, lead: 0.7, strafe: 0.8 },
  hard:   { react: 0.14, aimError: 0.25, abilityChance: 1.0, decide: 0.12, dodge: true, lead: 1.0, strafe: 1.0 },
};

const PREF_RANGE = { minotaur: 1.4, groundskeeper: 5.0, tidebinder: 6.5 };
const ATTACK_RANGE = { minotaur: 2.5, groundskeeper: 6.3, tidebinder: 8.3 };
const BASIC_PROJECTILES = new Set(['bolt', 'brine']);

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
    if (sim.phase !== 'fight' || !me.alive || !en.alive) return;

    // enemy velocity estimate
    if (this.lastEnemyPos) {
      const vx = (en.x - this.lastEnemyPos[0]) / dt, vz = (en.z - this.lastEnemyPos[1]) / dt;
      this.enemyVel = [this.enemyVel[0] * 0.7 + vx * 0.3, this.enemyVel[1] * 0.7 + vz * 0.3];
    }
    this.lastEnemyPos = [en.x, en.z];

    const d = Math.hypot(en.x - me.x, en.z - me.z);
    const [tx, tz] = norm(en.x - me.x, en.z - me.z);
    const hero = HEROES[me.hero];

    this.decideTimer -= dt;
    if (this.decideTimer <= 0) {
      this.decideTimer = this.cfg.decide;
      this.decide(d);
    }

    const move = this.computeMove(d, tx, tz);
    const aim = this.predict(hero.attack.speed ? d / hero.attack.speed : 0);
    sim.setInput(this.pid, { move, aim });

    // basic attack
    if (sim.time >= this.nextAttackAt && me.cd.attack <= 0 && d <= ATTACK_RANGE[me.hero] && !me.cast && !me.dash) {
      if (me.hero === 'minotaur' || !sim.lineBlocked(me.x, me.z, en.x, en.z)) {
        sim.cast(this.pid, 'attack', aim);
        this.nextAttackAt = sim.time + this.cfg.react * 0.5;
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
    const melee = me.hero === 'minotaur';
    const cheapPack = pack && pack.dist < (melee ? 4 : 7) && pack.dist < pack.enemyDist;
    if (pack && (me.hp <= 6 || (me.hp <= 9 && cheapPack))) this.mode = 'pack';
    else if (me.hp <= 3 && this.enemy.hp > me.hp && me.hero !== 'minotaur') this.mode = 'kite';
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
    if (this.mode === 'kite') {
      mx = -tx; mz = -tz;
    } else if (this.mode === 'engage') {
      let radial = 0;
      if (d > pref + 1.0) radial = 1;
      else if (d < pref - 1.0) radial = -1;
      // melee chases in a straight line; ranged heroes circle
      const tangential = me.hero === 'minotaur' ? (radial > 0 ? 0 : 0.5 * this.strafeSign) : this.cfg.strafe * this.strafeSign * 0.8;
      mx = tx * radial + (-tz) * tangential;
      mz = tz * radial + tx * tangential;
      // ranged heroes step sideways to regain line of sight
      if (me.hero !== 'minotaur' && sim.lineBlocked(me.x, me.z, en.x, en.z)) { mx += -tz * this.strafeSign; mz += tx * this.strafeSign; }
    }

    // dodge projectiles (melee only sidesteps ability projectiles, and never when already closing in)
    if (this.cfg.dodge && !(me.hero === 'minotaur' && d < 3.5)) {
      const pr = this.incomingProjectile(me.hero === 'minotaur');
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
    const los = !sim.lineBlocked(me.x, me.z, en.x, en.z);
    const cast = (key, aim) => { sim.cast(this.pid, key, aim); return true; };
    const ahead = (t) => { const p = this.predict(t); return p; };

    if (me.hero === 'minotaur') {
      const fire = sim.hasEffect(me, 'fire');
      if (me.cd.r <= 0 && d < 10 && roll()) return cast('r', [en.x, en.z]);
      // shield up while closing the gap, or purge when debuffed
      const debuffed = me.effects.some((e) => ['slow', 'root', 'burn', 'soaked'].includes(e.type));
      if (me.cd.e <= 0 && roll() && ((fire && d < 2.6) || (!fire && (me.hp <= 11 || debuffed) && d < 8))) return cast('e', [en.x, en.z]);
      if (me.cd.q <= 0 && d < 3.6 && roll()) return cast('q', ahead(0.35));
      if (me.cd.w <= 0 && !me.dash && d > 2.2 && d < (fire ? 11.5 : 7.5) && los && roll()) return cast('w', ahead(0.3));
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
      if (me.cd.r <= 0 && d < 2.3 && roll()) return cast('r', [en.x, en.z]);
      if (me.cd.w <= 0 && !me.dash && roll()) {
        if (d < 2.6 && me.cd.r > 0) return cast('w', [me.x - tx * 4, me.z - tz * 4]);
        if (d > 9) return cast('w', [en.x, en.z]);
      }
      if (me.cd.e <= 0 && d < 5.5 && d > 1.5 && roll()) return cast('e', [en.x, en.z]);
      if (me.cd.q <= 0 && !me.state.tether && d > 2.5 && d < 8.5 && los && roll()) return cast('q', ahead(d / 20));
      return false;
    }

    // tidebinder
    const soaked = sim.hasEffect(en, 'soaked');
    if (sim.hasEffect(me, 'shell') && d < 2.3) return cast('e', [en.x, en.z]);
    if (me.cd.r <= 0 && d < 12 && los && (soaked || en.hp <= 6 || me.hp <= 5) && roll()) return cast('r', ahead(0.8 + d / 10));
    if (me.cd.e <= 0 && roll() && (d < 3 || (this.cfg.dodge && this.incomingProjectile()) || me.hp <= 4)) return cast('e', [en.x, en.z]);
    if (me.cd.w <= 0 && d < 8 && (soaked || d < 6) && roll()) return cast('w', ahead(0.55));
    if (me.cd.q <= 0 && d < 7.5 && los && roll()) return cast('q', ahead(d / 12));
    return false;
  }
}

export const DIFFICULTIES = Object.keys(DIFFICULTY);
