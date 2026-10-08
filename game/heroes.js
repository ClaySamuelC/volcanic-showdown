// Hero ability implementations. Each hero exposes attack/q/w/e/r plus optional recast/onTick hooks.
import { HEROES, ARENA } from '../shared/heroes.js';

function addSlow(sim, p, amount, duration, tag) {
  if (tag) {
    const ex = p.effects.find((e) => e.type === 'slow' && e.tag === tag);
    if (ex) { ex.until = Math.max(ex.until, sim.time + duration); ex.amount = amount; return; }
  }
  p.effects.push({ type: 'slow', amount, until: sim.time + duration, tag });
}

function consumeEmpower(sim, p) {
  const e = sim.getEffect(p, 'empower');
  if (!e) return { bonus: 0, knockback: false };
  sim.removeEffect(p, 'empower');
  return { bonus: e.bonus || 0, knockback: !!e.knockback };
}

function clampToRange(p, aim, range) {
  const dx = aim[0] - p.x, dz = aim[1] - p.z;
  const d = Math.hypot(dx, dz);
  if (d <= range) return aim;
  return [p.x + (dx / d) * range, p.z + (dz / d) * range];
}

function fireProjectile(sim, p, aim, spec) {
  const [dx, dz] = sim.dirTo(p, aim);
  p.facing = Math.atan2(dz, dx);
  return sim.addProjectile({
    kind: spec.kind,
    owner: p.id,
    x: p.x + dx * (spec.offset ?? 0.6),
    z: p.z + dz * (spec.offset ?? 0.6),
    dx, dz,
    speed: spec.speed,
    remaining: spec.range,
    r: spec.r,
    pierce: !!spec.pierce,
    ghost: !!spec.ghost,
    onHit: spec.onHit,
    onExpire: spec.onExpire,
    onTick: spec.onTick,
  });
}

// ---------------------------------------------------------------- Minotaur
const minotaur = {
  attack(sim, p, aim) {
    const hero = HEROES.minotaur;
    const atk = hero.attack;
    const [dx, dz] = sim.dirTo(p, aim);
    p.facing = Math.atan2(dz, dx);
    const targets = sim.enemiesInCone(p, dx, dz, atk.range, atk.halfAngle);
    let bonus = 0;
    if (targets.length) bonus = consumeEmpower(sim, p).bonus;
    for (const t of targets) sim.damage(t, atk.damage + bonus, p);
    p.cd.attack = sim.hasEffect(p, 'fire') ? atk.cooldown * 0.75 : atk.cooldown;
    sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range: atk.range, angle: atk.halfAngle, color: bonus ? '#ffd166' : '#ffb27a', big: false });
  },

  q(sim, p, aim) {
    const fire = sim.hasEffect(p, 'fire');
    sim.startCast(p, 'q', fire ? 0.18 : 0.36, aim, () => {
      const [dx, dz] = sim.dirTo(p, aim);
      p.facing = Math.atan2(dz, dx);
      const range = 3.2, half = 1.05;
      const targets = sim.enemiesInCone(p, dx, dz, range, half);
      const bonus = targets.length ? consumeEmpower(sim, p).bonus : 0;
      const burning = sim.hasEffect(p, 'fire');
      for (const t of targets) {
        sim.damage(t, 2 + bonus, p);
        sim.knock(t, t.x - p.x, t.z - p.z, 1.5);
        addSlow(sim, t, 0.5, 2);
        if (burning) sim.addEffect(t, 'burn', 2, { dps: 1 });
      }
      sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range, angle: half, color: burning ? '#ff6a1a' : '#ffcf8a', big: true });
    });
    return true;
  },

  w(sim, p, aim) {
    const fire = sim.hasEffect(p, 'fire');
    const [dx, dz] = sim.dirTo(p, aim);
    const dist = fire ? 12 : 6;
    const speed = fire ? 34 : 17;
    p.cd.q = Math.max(0, p.cd.q - 3);
    const state = { lastFireX: p.x, lastFireZ: p.z };
    sim.startDash(p, dx, dz, dist, speed, 'charge', {
      onTick(sim, p) {
        for (const e of sim.enemiesInRadius(p.x, p.z, 0.9, p)) {
          // shove them ahead of the charge
          e.kx = p.dash.dx * speed * 0.95 + (e.x - p.x) * 2;
          e.kz = p.dash.dz * speed * 0.95 + (e.z - p.z) * 2;
          if (!p.dash.touched) { p.dash.touched = true; sim.emit({ e: 'text', x: e.x, z: e.z, text: 'SHOVED', color: '#ffb27a' }); }
        }
        if (sim.hasEffect(p, 'fire') && Math.hypot(p.x - state.lastFireX, p.z - state.lastFireZ) >= 0.9) {
          state.lastFireX = p.x; state.lastFireZ = p.z;
          sim.addZone({
            kind: 'fire', owner: p.id, x: p.x, z: p.z, r: 0.95, until: sim.time + 3,
            onTick(sim, z) {
              for (const e of sim.enemiesInRadius(z.x, z.z, z.r, sim.players[z.owner])) {
                sim.addEffect(e, 'burn', 0.3, { dps: 1 });
              }
            },
          });
        }
      },
    });
    sim.emit({ e: 'dash', pid: p.id, kind: 'charge', fire });
    return true;
  },

  e(sim, p, aim) {
    sim.startCast(p, 'e', 0.5, aim, () => {
      sim.purge(p);
      if (sim.hasEffect(p, 'fire')) {
        const radius = 3;
        for (const t of sim.enemiesInRadius(p.x, p.z, radius, p)) sim.damage(t, 2, p, { kind: 'fire' });
        sim.addEffect(p, 'empower', 5, { bonus: 4 });
        sim.emit({ e: 'explode', x: p.x, z: p.z, r: radius, color: '#ff5a1a' });
        sim.damage(p, 2, p, { kind: 'fire' });
      } else {
        sim.grantShield(p, 3, 5);
        sim.addEffect(p, 'empower', 5, { bonus: 2 });
        sim.emit({ e: 'roar', pid: p.id, x: p.x, z: p.z });
      }
    });
    return true;
  },

  r(sim, p) {
    p.cd.w = 0;
    sim.addEffect(p, 'fire', 11);
    sim.emit({ e: 'ult', pid: p.id, x: p.x, z: p.z, hero: 'minotaur' });
    return true;
  },
};

// ---------------------------------------------------------- Groundskeeper
function clearTether(sim, p) {
  if (p.state.tetherZone) sim.removeZone(p.state.tetherZone);
  p.state.tether = null;
  p.state.tetherZone = null;
  p.flags.qRecast = false;
}

const groundskeeper = {
  attack(sim, p, aim) {
    const atk = HEROES.groundskeeper.attack;
    fireProjectile(sim, p, aim, {
      kind: 'bolt', speed: atk.speed, range: atk.range, r: 0.25,
      onHit(sim, pr, t) {
        const emp = consumeEmpower(sim, p);
        sim.damage(t, atk.damage + emp.bonus, p);
        if (emp.knockback) sim.knock(t, pr.dx, pr.dz, 2.5);
      },
    });
    p.cd.attack = atk.cooldown;
    sim.emit({ e: 'shoot', pid: p.id });
  },

  recast(sim, p, key) {
    if (key !== 'q' || !p.state.tether) return false;
    if (!p.alive || sim.hasEffect(p, 'stun')) return true;
    const th = p.state.tether;
    if (th.type === 'target') {
      const t = sim.players[th.pid];
      if (t && t.alive) {
        const dx = p.x - t.x, dz = p.z - t.z;
        const d = Math.hypot(dx, dz);
        const dist = Math.max(0, Math.min(6, d - 1.1));
        t.kx = 0; t.kz = 0;
        sim.startDash(t, dx, dz, dist, 24, 'pulled', {
          stopWhen: (sim, t) => Math.hypot(t.x - p.x, t.z - p.z) < 1.2,
        });
        sim.emit({ e: 'pull', from: p.id, to: t.id });
      }
    } else {
      const dx = th.x - p.x, dz = th.z - p.z;
      const d = Math.hypot(dx, dz);
      const dist = Math.max(0, Math.min(7, d - 0.3));
      p.kx = 0; p.kz = 0;
      sim.startDash(p, dx, dz, dist, 24, 'pull');
      sim.emit({ e: 'pull', from: p.id, to: null, x: th.x, z: th.z });
    }
    clearTether(sim, p);
    return true;
  },

  q(sim, p, aim) {
    clearTether(sim, p);
    const makeTether = (tether, x, z) => {
      p.state.tether = tether;
      p.flags.qRecast = true;
      p.state.tetherZone = sim.addZone({
        kind: 'tether', owner: p.id, x, z, r: 0.2, until: sim.time + 3, pid: tether.pid || null,
        onTick(sim, zone) {
          if (tether.pid) { const t = sim.players[tether.pid]; zone.x = t.x; zone.z = t.z; }
        },
        onExpire() { if (p.state.tether === tether) clearTether(sim, p); },
      });
    };
    fireProjectile(sim, p, aim, {
      kind: 'tetherbolt', speed: 20, range: 9, r: 0.3,
      onHit(sim, pr, t) {
        sim.damage(t, 2, p);
        sim.knock(t, pr.dx, pr.dz, 2.5);
        if (t.alive) makeTether({ type: 'target', pid: t.id }, t.x, t.z);
      },
      onExpire(sim, pr, reason) {
        if (sim.phase !== 'fight') return;
        const x = pr.x, z = pr.z;
        makeTether({ type: 'ground', x, z }, x, z);
      },
    });
    sim.emit({ e: 'shoot', pid: p.id });
    return true;
  },

  w(sim, p, aim) {
    const [dx, dz] = sim.dirTo(p, aim);
    sim.startDash(p, dx, dz, 4, 14, 'roll');
    sim.addEffect(p, 'empower', 4, { bonus: 1, knockback: true });
    sim.emit({ e: 'dash', pid: p.id, kind: 'roll' });
    return true;
  },

  e(sim, p, aim) {
    const [dx, dz] = sim.dirTo(p, aim);
    let x = p.x + dx * 1.1, z = p.z + dz * 1.1;
    if (sim.blockedByProp(x, z, 0.3) || Math.hypot(x, z) > ARENA.wallRadius - 0.5) { x = p.x; z = p.z; }
    sim.addZone({
      kind: 'trap', owner: p.id, x, z, r: 0.65, armedAt: sim.time + 1, until: sim.time + 30,
      onTick(sim, zone) {
        if (sim.time < zone.armedAt) return;
        const owner = sim.players[zone.owner];
        const victims = sim.enemiesInRadius(zone.x, zone.z, zone.r, owner);
        if (!victims.length) return;
        for (const v of victims) {
          v.dash = null; v.kx = 0; v.kz = 0;
          sim.addEffect(v, 'root', 2);
          sim.addEffect(v, 'vulnerable', 10);
          sim.emit({ e: 'text', x: v.x, z: v.z, text: 'TRAPPED', color: '#d9c38a' });
        }
        zone.dead = true;
        sim.emit({ e: 'trap', x: zone.x, z: zone.z });
      },
    });
    sim.emit({ e: 'place', pid: p.id, x, z });
    return true;
  },

  r(sim, p, aim) {
    sim.startCast(p, 'r', 0.5, aim, () => {
      const [dx, dz] = sim.dirTo(p, aim);
      p.facing = Math.atan2(dz, dx);
      const range = 2.4, half = 0.8;
      for (const t of sim.enemiesInCone(p, dx, dz, range, half)) {
        sim.damage(t, 4, p);
        addSlow(sim, t, 0.5, 3);
      }
      sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range, angle: half, color: '#ff3b3b', big: true });
    });
    return true;
  },
};

// -------------------------------------------------------------- Tidebinder
const tidebinder = {
  attack(sim, p, aim) {
    const atk = HEROES.tidebinder.attack;
    fireProjectile(sim, p, aim, {
      kind: 'brine', speed: atk.speed, range: atk.range, r: 0.28,
      onHit(sim, pr, t) { sim.damage(t, atk.damage, p); },
    });
    p.cd.attack = atk.cooldown;
    sim.emit({ e: 'shoot', pid: p.id });
  },

  q(sim, p, aim) {
    fireProjectile(sim, p, aim, {
      kind: 'wave', speed: 12, range: 8, r: 1.3, pierce: true, offset: 1.0,
      onHit(sim, pr, t) {
        sim.damage(t, 2, p);
        sim.knock(t, pr.dx, pr.dz, 2);
        sim.addEffect(t, 'soaked', 4);
      },
    });
    sim.emit({ e: 'cast', pid: p.id, key: 'q', duration: 0 });
    return true;
  },

  w(sim, p, aim) {
    const target = clampToRange(p, aim, 8);
    sim.addZone({
      kind: 'undertow', owner: p.id, x: target[0], z: target[1], r: 2.4, armedAt: sim.time + 0.5, until: sim.time + 2.0,
      onTick(sim, zone, dt) {
        if (sim.time < zone.armedAt) return;
        const owner = sim.players[zone.owner];
        const inside = sim.enemiesInRadius(zone.x, zone.z, zone.r, owner);
        if (!zone.erupted) {
          zone.erupted = true;
          sim.emit({ e: 'explode', x: zone.x, z: zone.z, r: zone.r, color: '#3fa9ff' });
          for (const e of inside) {
            if (sim.hasEffect(e, 'soaked')) {
              sim.removeEffect(e, 'soaked');
              sim.damage(e, 2, owner, { kind: 'water' });
              sim.emit({ e: 'text', x: e.x, z: e.z, text: 'WRUNG OUT', color: '#8fe3ff' });
            }
          }
        }
        for (const e of inside) {
          if (e.dash) continue;
          const dx = zone.x - e.x, dz = zone.z - e.z;
          const d = Math.hypot(dx, dz);
          if (d > 0.1) {
            const step = Math.min(d, 4.5 * dt);
            e.x += (dx / d) * step; e.z += (dz / d) * step;
          }
          addSlow(sim, e, 0.4, 1.5, 'undertow');
        }
      },
    });
    sim.emit({ e: 'cast', pid: p.id, key: 'w', duration: 0 });
    return true;
  },

  e(sim, p) {
    sim.grantShield(p, 3, 2.5);
    sim.addEffect(p, 'shell', 2.5);
    p.flags.eRecast = true;
    sim.emit({ e: 'shell', pid: p.id });
    return true;
  },

  burstShell(sim, p) {
    if (!sim.hasEffect(p, 'shell')) return;
    sim.removeEffect(p, 'shell');
    p.flags.eRecast = false;
    p.shield = 0;
    p.shieldUntil = 0;
    const radius = 2.5;
    for (const t of sim.enemiesInRadius(p.x, p.z, radius, p)) {
      sim.damage(t, 1, p, { kind: 'water' });
      sim.knock(t, t.x - p.x, t.z - p.z, 3);
    }
    sim.emit({ e: 'explode', x: p.x, z: p.z, r: radius, color: '#8fe3ff' });
  },

  recast(sim, p, key) {
    if (key !== 'e' || !sim.hasEffect(p, 'shell')) return false;
    tidebinder.burstShell(sim, p);
    return true;
  },

  r(sim, p, aim) {
    sim.startCast(p, 'r', 0.8, aim, () => {
      const speed = 10;
      fireProjectile(sim, p, aim, {
        kind: 'tsunami', speed, range: 18, r: 3.0, pierce: true, ghost: true, offset: 1.5,
        onHit(sim, pr, t) {
          sim.damage(t, 4, p, { kind: 'water' });
          if (sim.hasEffect(t, 'soaked')) {
            sim.removeEffect(t, 'soaked');
            sim.addEffect(t, 'stun', 1);
            sim.emit({ e: 'text', x: t.x, z: t.z, text: 'STUNNED', color: '#8fe3ff' });
          }
        },
        onTick(sim, pr) {
          const owner = sim.players[pr.owner];
          for (const e of sim.enemiesInRadius(pr.x, pr.z, pr.r * 0.9, owner)) {
            if (e.dash) continue;
            e.kx = pr.dx * speed * 1.05;
            e.kz = pr.dz * speed * 1.05;
          }
        },
      });
      sim.emit({ e: 'ult', pid: p.id, x: p.x, z: p.z, hero: 'tidebinder' });
    });
    return true;
  },
};

export const HERO_IMPL = { minotaur, groundskeeper, tidebinder };
