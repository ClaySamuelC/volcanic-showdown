// Hero ability implementations. Each hero exposes attack/q/w/e/r plus optional recast/onTick hooks.
import { HEROES, ARENA } from '../shared/heroes.js';

function debuffBlocked(sim, p) {
  return !p?.effects || sim.spellImmune(p) || sim.isGhost(p);
}

function addSlow(sim, p, amount, duration, tag) {
  if (debuffBlocked(sim, p)) return;
  if (tag) {
    const ex = p.effects.find((e) => e.type === 'slow' && e.tag === tag);
    if (ex) { ex.until = Math.max(ex.until, sim.time + duration); ex.amount = amount; return; }
  }
  p.effects.push({ type: 'slow', amount, until: sim.time + duration, tag });
}

function addDecaySlow(sim, p, from, to, duration, tag) {
  if (debuffBlocked(sim, p)) return;
  const data = { amount: from, from, to, start: sim.time, dur: duration };
  const ex = tag && p.effects.find((e) => e.type === 'slow' && e.tag === tag);
  if (ex) { Object.assign(ex, data); ex.until = sim.time + duration; return; }
  p.effects.push({ type: 'slow', until: sim.time + duration, tag, ...data });
}

function consumeEmpower(sim, p) {
  const e = sim.getEffect(p, 'empower');
  if (!e) return { bonus: 0, knockback: false };
  sim.removeEffect(p, 'empower');
  return { bonus: e.bonus || 0, knockback: !!e.knockback };
}

function harmCone(sim, p, dx, dz, range, halfAngle, amount, source) {
  for (const z of sim.objectsInCone(p, dx, dz, range, halfAngle)) sim.damageObject(z, amount, source);
}

function harmRadius(sim, x, z, r, amount, source) {
  for (const o of sim.objectsInRadius(x, z, r)) sim.damageObject(o, amount, source);
}

function harmPacks(sim, x, z, r, amount, source) {
  if (amount <= 0) return;
  for (const o of sim.objectsInRadius(x, z, r)) {
    if (o.kind === 'healthpack') sim.damageObject(o, amount, source);
  }
}

function tickPackDamage(sim, z, dt, dps, owner) {
  if (dps <= 0) return;
  z.packAcc = (z.packAcc || 0) + dps * dt;
  while (z.packAcc >= 1) {
    z.packAcc -= 1;
    harmPacks(sim, z.x, z.z, z.r, 1, owner);
  }
}

function clampToRange(p, aim, range) {
  const dx = aim[0] - p.x, dz = aim[1] - p.z;
  const d = Math.hypot(dx, dz);
  if (d <= range) return aim;
  return [p.x + (dx / d) * range, p.z + (dz / d) * range];
}

function fireProjectile(sim, p, aim, spec) {
  const origin = spec.origin || p;
  const [dx, dz] = sim.dirTo(origin, aim);
  if (!spec.silent) p.facing = Math.atan2(dz, dx);
  const proj = sim.addProjectile({
    kind: spec.kind,
    owner: p.id,
    x: spec.arc ? spec.arc.p0[0] : origin.x + dx * (spec.offset ?? 0.6),
    z: spec.arc ? spec.arc.p0[1] : origin.z + dz * (spec.offset ?? 0.6),
    dx, dz,
    speed: spec.speed,
    remaining: spec.range,
    r: spec.r,
    pierce: !!spec.pierce,
    ghost: !!spec.ghost,
    basic: !!spec.basic,
    guided: !!spec.guided,
    flame: !!spec.flame,
    arc: spec.arc || null,
    onHit: spec.onHit,
    onHitObject: spec.onHitObject,
    objectDamage: spec.objectDamage,
    onExpire: spec.onExpire,
    onTick: spec.onTick,
    onDie: spec.onDie,
  });
  if (spec.arc) proj.remaining = spec.arc.len;
  return proj;
}

export function quadPoint(p0, p1, p2, t) {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

function bezierLen(p0, p1, p2) {
  let len = 0;
  let prev = p0;
  for (let i = 1; i <= 16; i++) {
    const pt = quadPoint(p0, p1, p2, i / 16);
    len += Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
    prev = pt;
  }
  return len;
}

// The click sets direction only. Drag left or right of that line bends the path.
// A curved throw is scaled so the rock still travels the same distance as a straight one.
export function throwCurve(x, z, facing, aim, curve, range, curveCap = 6) {
  let dx = aim[0] - x, dz = aim[1] - z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.35) {
    dx = Math.cos(facing);
    dz = Math.sin(facing);
  } else {
    dx /= dist;
    dz /= dist;
  }
  const [endX, endZ] = clampArena(x + dx * range, z + dz * range, 0.4);
  const ex = endX - x, ez = endZ - z;
  const budget = Math.max(0.5, Math.hypot(ex, ez));
  const ux = ex / budget, uz = ez / budget;
  const cx = curve?.[0] || 0, cz = curve?.[1] || 0;
  const bend = Math.max(-curveCap, Math.min(curveCap, cx * -uz + cz * ux));
  const px = -uz, pz = ux;
  const p0 = [x, z];
  let p1 = [x + ux * budget * 0.5 + px * bend * 2, z + uz * budget * 0.5 + pz * bend * 2];
  let p2 = [x + ux * budget, z + uz * budget];
  const raw = bezierLen(p0, p1, p2);
  const scale = raw > 1e-4 ? budget / raw : 1;
  p1 = [x + (p1[0] - x) * scale, z + (p1[1] - z) * scale];
  p2 = [x + (p2[0] - x) * scale, z + (p2[1] - z) * scale];
  return { p0, p1, p2, target: p2, len: Math.max(0.5, bezierLen(p0, p1, p2)) };
}

// ---------------------------------------------------------------- Minotaur
const minotaur = {
  attack(sim, p, aim) {
    const hero = HEROES.minotaur;
    const atk = hero.attack;
    const [dx, dz] = sim.dirTo(p, aim);
    p.facing = Math.atan2(dz, dx);
    const targets = sim.enemiesInCone(p, dx, dz, atk.range, atk.halfAngle);
    const objs = sim.objectsInCone(p, dx, dz, atk.range, atk.halfAngle);
    let bonus = 0;
    if (targets.length || objs.length) bonus = consumeEmpower(sim, p).bonus;
    for (const t of targets) {
      if (sim.tryDodge(t)) continue;
      sim.damage(t, atk.damage + bonus, p, { basic: true });
    }
    harmCone(sim, p, dx, dz, atk.range, atk.halfAngle, atk.damage + bonus, p);
    p.cd.attack = sim.hasEffect(p, 'fire') ? atk.cooldown * atk.fireCooldownScale : atk.cooldown;
    sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range: atk.range, angle: atk.halfAngle, color: bonus ? '#ffd166' : '#ffb27a', big: false });
  },

  q(sim, p, aim) {
    const a = HEROES.minotaur.abilities.q;
    const fire = sim.hasEffect(p, 'fire');
    sim.startCast(p, 'q', fire ? a.fireWindup : a.windup, aim, () => {
      const [dx, dz] = sim.dirTo(p, aim);
      p.facing = Math.atan2(dz, dx);
      const targets = sim.enemiesInCone(p, dx, dz, a.range, a.halfAngle);
      const objs = sim.objectsInCone(p, dx, dz, a.range, a.halfAngle);
      const bonus = targets.length || objs.length ? consumeEmpower(sim, p).bonus : 0;
      const burning = sim.hasEffect(p, 'fire');
      for (const t of targets) {
        sim.damage(t, a.damage + bonus, p);
        sim.knock(t, t.x - p.x, t.z - p.z, a.knockback);
        addSlow(sim, t, a.slow, a.slowTime);
        if (burning) sim.addEffect(t, 'burn', a.burnTime, { dps: a.burnDps });
      }
      harmCone(sim, p, dx, dz, a.range, a.halfAngle, a.damage + bonus, p);
      const patrol = sim.patrolInCone(p, dx, dz, a.range, a.halfAngle);
      if (patrol) {
        sim.knock(patrol, patrol.x - p.x, patrol.z - p.z, a.knockback);
        addSlow(sim, patrol, a.slow, a.slowTime);
      }
      sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range: a.range, angle: a.halfAngle, color: burning ? '#ff6a1a' : '#ffcf8a', big: true });
    });
    return true;
  },

  w(sim, p, aim) {
    const a = HEROES.minotaur.abilities.w;
    const fire = sim.hasEffect(p, 'fire');
    const [dx, dz] = sim.dirTo(p, aim);
    const dist = fire ? a.fireDistance : a.distance;
    const speed = fire ? a.fireSpeed : a.speed;
    p.cd.q = Math.max(0, p.cd.q - a.cleaveRefund);
    const state = { lastFireX: p.x, lastFireZ: p.z };
    sim.startDash(p, dx, dz, dist, speed, 'charge', {
      smash: true,
      onTick(sim, p) {
        if (!p.dash.stunnedIds) p.dash.stunnedIds = new Set();
        for (const e of sim.enemiesInRadius(p.x, p.z, a.shoveRadius, p)) {
          if (sim.spellImmune(e)) continue;
          // shove them ahead of the charge
          e.kx = p.dash.dx * speed * 0.95 + (e.x - p.x) * 2;
          e.kz = p.dash.dz * speed * 0.95 + (e.z - p.z) * 2;
          if (!p.dash.stunnedIds.has(e.id)) {
            p.dash.stunnedIds.add(e.id);
            sim.addEffect(e, 'stun', a.stunTime);
            sim.emit({ e: 'text', x: e.x, z: e.z, text: 'SHOVED', color: '#ffb27a' });
          }
        }
        const patrol = sim.patrolInRadius(p.x, p.z, a.shoveRadius);
        if (patrol) {
          patrol.kx = p.dash.dx * speed * 0.95 + (patrol.x - p.x) * 2;
          patrol.kz = p.dash.dz * speed * 0.95 + (patrol.z - p.z) * 2;
        }
        if (sim.hasEffect(p, 'fire') && Math.hypot(p.x - state.lastFireX, p.z - state.lastFireZ) >= a.fireSpacing) {
          state.lastFireX = p.x; state.lastFireZ = p.z;
          sim.addZone({
            kind: 'fire', owner: p.id, x: p.x, z: p.z, r: a.fireRadius, until: sim.time + a.fireTime,
            onTick(sim, z, dt) {
              const owner = sim.players[z.owner];
              for (const e of sim.enemiesInRadius(z.x, z.z, z.r, owner)) {
                sim.addEffect(e, 'burn', 0.3, { dps: a.fireDps });
              }
              tickPackDamage(sim, z, dt, a.fireDps, owner);
            },
          });
        }
      },
    });
    sim.emit({ e: 'dash', pid: p.id, kind: 'charge', fire });
    return true;
  },

  e(sim, p, aim) {
    const a = HEROES.minotaur.abilities.e;
    sim.startCast(p, 'e', a.windup, aim, () => {
      if (sim.hasEffect(p, 'fire')) {
        for (const t of sim.enemiesInRadius(p.x, p.z, a.fireRadius, p)) sim.damage(t, a.fireDamage, p, { kind: 'fire' });
        harmRadius(sim, p.x, p.z, a.fireRadius, a.fireDamage, p);
        sim.addEffect(p, 'empower', a.empowerTime, { bonus: a.fireEmpower });
        sim.emit({ e: 'explode', x: p.x, z: p.z, r: a.fireRadius, color: '#ff5a1a' });
        sim.damage(p, a.fireSelfDamage, p, { kind: 'fire', nonlethal: true });
      } else {
        sim.grantShield(p, a.shield, a.shieldTime);
        sim.addEffect(p, 'empower', a.empowerTime, { bonus: a.empower });
        sim.emit({ e: 'roar', pid: p.id, x: p.x, z: p.z });
      }
    });
    return true;
  },

  r(sim, p) {
    sim.purge(p);
    p.cd.w = 0;
    sim.addEffect(p, 'fire', HEROES.minotaur.abilities.r.duration);
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
      kind: 'bolt', speed: atk.speed, range: atk.range, r: atk.radius, basic: true,
      onHit(sim, pr, t) {
        const emp = consumeEmpower(sim, p);
        sim.damage(t, atk.damage + emp.bonus, p, { basic: true });
        if (emp.knockback) sim.knock(t, pr.dx, pr.dz, atk.empowerKnockback, { basic: true });
      },
      onHitObject(sim, pr, z) {
        const emp = consumeEmpower(sim, p);
        sim.damageObject(z, atk.damage + emp.bonus, p);
        if (z.patrol && emp.knockback) sim.knock(z, pr.dx, pr.dz, atk.empowerKnockback);
      },
    });
    p.cd.attack = atk.cooldown;
    sim.emit({ e: 'shoot', pid: p.id });
  },

  recast(sim, p, key) {
    if (key !== 'q' || !p.state.tether) return false;
    if (!p.alive || sim.stunned(p)) return true;
    const a = HEROES.groundskeeper.abilities.q;
    const th = p.state.tether;
    if (th.type === 'target') {
      const t = sim.players[th.pid];
      if (t && t.alive && !sim.spellImmune(t) && !sim.isGhost(t)) {
        const dx = p.x - t.x, dz = p.z - t.z;
        const d = Math.hypot(dx, dz);
        const travel = Math.max(d * 0.75, a.selfPullDistance);
        const dist = Math.max(0, Math.min(travel, d - 1.1));
        t.kx = 0; t.kz = 0;
        if (dist > 0.05) {
          sim.startDash(t, dx, dz, dist, a.pullSpeed, 'pulled', {
            stopWhen: (sim, victim) => Math.hypot(victim.x - p.x, victim.z - p.z) < 1.15,
          });
        }
        sim.emit({ e: 'pull', from: p.id, to: t.id });
      }
    } else {
      const dx = th.x - p.x, dz = th.z - p.z;
      const d = Math.hypot(dx, dz);
      const dist = Math.max(d * 0.75, a.selfPullDistance);
      p.kx = 0; p.kz = 0;
      if (d > 0.05) sim.startDash(p, dx, dz, dist, a.pullSpeed, 'pull');
      sim.emit({ e: 'pull', from: p.id, to: null, x: th.x, z: th.z });
    }
    clearTether(sim, p);
    return true;
  },

  q(sim, p, aim) {
    const a = HEROES.groundskeeper.abilities.q;
    clearTether(sim, p);
    const makeTether = (tether, x, z) => {
      p.state.tether = tether;
      p.flags.qRecast = true;
      p.state.tetherZone = sim.addZone({
        kind: 'tether', owner: p.id, x, z, r: 0.2, until: sim.time + a.tetherTime, pid: tether.pid || null,
        onTick(sim, zone) {
          if (tether.pid) { const t = sim.players[tether.pid]; zone.x = t.x; zone.z = t.z; }
        },
        onExpire() { if (p.state.tether === tether) clearTether(sim, p); },
      });
    };
    fireProjectile(sim, p, aim, {
      kind: 'tetherbolt', speed: a.speed, range: a.range, r: a.radius,
      onHit(sim, pr, t) {
        sim.damage(t, a.damage, p);
        sim.knock(t, pr.dx, pr.dz, a.knockback);
        if (t.alive) makeTether({ type: 'target', pid: t.id }, t.x, t.z);
      },
      onHitObject(sim, pr, z) {
        if (z.kind === 'healthpack' || z.kind === 'keg') {
          sim.damageObject(z, a.damage, p);
          return;
        }
        if (z.patrol) {
          sim.damageObject(z, a.damage, p);
          sim.knock(z, pr.dx, pr.dz, a.knockback);
        }
        pr.anchored = true;
        makeTether({ type: 'ground', x: z.x, z: z.z }, z.x, z.z);
      },
      onExpire(sim, pr) {
        if (pr.anchored || sim.phase !== 'fight') return;
        const x = pr.x, z = pr.z;
        makeTether({ type: 'ground', x, z }, x, z);
      },
    });
    sim.emit({ e: 'shoot', pid: p.id });
    return true;
  },

  w(sim, p, aim) {
    const a = HEROES.groundskeeper.abilities.w;
    const [dx, dz] = sim.dirTo(p, aim);
    sim.startDash(p, dx, dz, a.distance, a.speed, 'roll');
    sim.addEffect(p, 'empower', a.empowerTime, { bonus: a.empower, knockback: true });
    sim.emit({ e: 'dash', pid: p.id, kind: 'roll' });
    return true;
  },

  e(sim, p, aim) {
    const [dx, dz] = sim.dirTo(p, aim);
    let x = p.x + dx * 1.1, z = p.z + dz * 1.1;
    if (sim.blockedByProp(x, z, 0.3) || Math.hypot(x, z) > ARENA.wallRadius - 0.5) { x = p.x; z = p.z; }
    sim.addZone({
      kind: 'trap', owner: p.id, x, z, r: HEROES.groundskeeper.abilities.e.radius, armedAt: sim.time + HEROES.groundskeeper.abilities.e.armTime, until: sim.time + HEROES.groundskeeper.abilities.e.duration,
      onTick(sim, zone) {
        if (sim.time < zone.armedAt) return;
        const owner = sim.players[zone.owner];
        const victims = sim.enemiesInRadius(zone.x, zone.z, zone.r, owner);
        if (!victims.length) return;
        for (const v of victims) {
          if (sim.spellImmune(v)) continue;
          v.dash = null; v.kx = 0; v.kz = 0;
          sim.addEffect(v, 'root', HEROES.groundskeeper.abilities.e.rootTime);
          sim.addEffect(v, 'vulnerable', HEROES.groundskeeper.abilities.e.vulnerableTime);
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
    const a = HEROES.groundskeeper.abilities.r;
    sim.startCast(p, 'r', a.windup, aim, () => {
      const [dx, dz] = sim.dirTo(p, aim);
      p.facing = Math.atan2(dz, dx);
      for (const t of sim.enemiesInCone(p, dx, dz, a.range, a.halfAngle)) {
        sim.damage(t, a.damage, p);
        addSlow(sim, t, a.slow, a.slowTime);
      }
      harmCone(sim, p, dx, dz, a.range, a.halfAngle, a.damage, p);
      const patrol = sim.patrolInCone(p, dx, dz, a.range, a.halfAngle);
      if (patrol) addSlow(sim, patrol, a.slow, a.slowTime);
      sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range: a.range, angle: a.halfAngle, color: '#ff3b3b', big: true });
    });
    return true;
  },
};

// -------------------------------------------------------------- Tidebinder
const tidebinder = {
  attack(sim, p, aim) {
    const atk = HEROES.tidebinder.attack;
    fireProjectile(sim, p, aim, {
      kind: 'brine', speed: atk.speed, range: atk.range, r: atk.radius, objectDamage: atk.damage, basic: true,
      onHit(sim, pr, t) { sim.damage(t, atk.damage, p, { basic: true }); },
    });
    p.cd.attack = atk.cooldown;
    sim.emit({ e: 'shoot', pid: p.id });
  },

  q(sim, p, aim) {
    const a = HEROES.tidebinder.abilities.q;
    fireProjectile(sim, p, aim, {
      kind: 'wave', speed: a.speed, range: a.range, r: a.radius, pierce: true, offset: 1.0,
      onHit(sim, pr, t) {
        sim.damage(t, a.damage, p);
        sim.knock(t, pr.dx, pr.dz, a.knockback);
        sim.addEffect(t, 'soaked', a.soakedTime);
      },
      onHitObject(sim, pr, z) {
        sim.damageObject(z, a.damage, p);
        if (z.patrol) sim.knock(z, pr.dx, pr.dz, a.knockback);
      },
    });
    sim.emit({ e: 'cast', pid: p.id, key: 'q', duration: 0 });
    return true;
  },

  w(sim, p, aim) {
    const a = HEROES.tidebinder.abilities.w;
    const target = clampToRange(p, aim, a.castRange);
    sim.addZone({
      kind: 'undertow', owner: p.id, x: target[0], z: target[1], r: a.radius, armedAt: sim.time + a.delay, until: sim.time + a.duration,
      onTick(sim, zone, dt) {
        if (sim.time < zone.armedAt) return;
        const owner = sim.players[zone.owner];
        const inside = sim.enemiesInRadius(zone.x, zone.z, zone.r, owner).filter((e) => !sim.spellImmune(e));
        if (!zone.erupted) {
          zone.erupted = true;
          sim.emit({ e: 'explode', x: zone.x, z: zone.z, r: zone.r, color: '#3fa9ff' });
          for (const e of inside) {
            if (sim.hasEffect(e, 'soaked')) {
              sim.removeEffect(e, 'soaked');
              sim.damage(e, a.soakedDamage, owner, { kind: 'water' });
              sim.emit({ e: 'text', x: e.x, z: e.z, text: 'WRUNG OUT', color: '#8fe3ff' });
            }
          }
          harmPacks(sim, zone.x, zone.z, zone.r, a.soakedDamage, owner);
        }
        for (const e of inside) {
          if (e.dash) continue;
          const dx = zone.x - e.x, dz = zone.z - e.z;
          const d = Math.hypot(dx, dz);
          if (d > 0.1) {
            const step = Math.min(d, a.pullSpeed * dt);
            e.x += (dx / d) * step; e.z += (dz / d) * step;
          }
          addSlow(sim, e, a.slow, a.slowTime, 'undertow');
        }
        const patrol = sim.patrolInRadius(zone.x, zone.z, zone.r);
        if (patrol) {
          const px = zone.x - patrol.x, pz = zone.z - patrol.z;
          const pd = Math.hypot(px, pz);
          if (pd > 0.1) {
            const step = Math.min(pd, a.pullSpeed * dt);
            patrol.x += (px / pd) * step; patrol.z += (pz / pd) * step;
          }
          addSlow(sim, patrol, a.slow, a.slowTime, 'undertow');
        }
      },
    });
    sim.emit({ e: 'cast', pid: p.id, key: 'w', duration: 0 });
    return true;
  },

  e(sim, p) {
    const a = HEROES.tidebinder.abilities.e;
    sim.grantShield(p, a.shield, a.duration);
    sim.addEffect(p, 'shell', a.duration);
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
    const a = HEROES.tidebinder.abilities.e;
    for (const t of sim.enemiesInRadius(p.x, p.z, a.burstRadius, p)) {
      sim.damage(t, a.burstDamage, p, { kind: 'water' });
      sim.knock(t, t.x - p.x, t.z - p.z, a.burstKnockback);
    }
    const patrol = sim.patrolInRadius(p.x, p.z, a.burstRadius);
    if (patrol) sim.knock(patrol, patrol.x - p.x, patrol.z - p.z, a.burstKnockback);
    harmRadius(sim, p.x, p.z, a.burstRadius, a.burstDamage, p);
    sim.emit({ e: 'explode', x: p.x, z: p.z, r: a.burstRadius, color: '#8fe3ff' });
  },

  recast(sim, p, key) {
    if (key !== 'e' || !sim.hasEffect(p, 'shell')) return false;
    tidebinder.burstShell(sim, p);
    return true;
  },

  r(sim, p, aim) {
    const a = HEROES.tidebinder.abilities.r;
    sim.startCast(p, 'r', a.windup, aim, () => {
      fireProjectile(sim, p, aim, {
        kind: 'tsunami', speed: a.speed, range: a.range, r: a.radius, pierce: true, ghost: true, offset: 1.5, objectDamage: a.damage,
        onHit(sim, pr, t) {
          sim.damage(t, a.damage, p, { kind: 'water' });
          if (sim.hasEffect(t, 'soaked')) {
            sim.removeEffect(t, 'soaked');
            sim.addEffect(t, 'stun', a.stunTime);
            sim.emit({ e: 'text', x: t.x, z: t.z, text: 'STUNNED', color: '#8fe3ff' });
          }
        },
        onTick(sim, pr) {
          const owner = sim.players[pr.owner];
          for (const e of sim.enemiesInRadius(pr.x, pr.z, pr.r * 0.9, owner)) {
            if (e.dash || sim.spellImmune(e)) continue;
            e.kx = pr.dx * a.speed * 1.05;
            e.kz = pr.dz * a.speed * 1.05;
          }
          const patrol = sim.patrolInRadius(pr.x, pr.z, pr.r * 0.9);
          if (patrol) {
            patrol.kx = pr.dx * a.speed * 1.05;
            patrol.kz = pr.dz * a.speed * 1.05;
          }
        },
      });
      sim.emit({ e: 'ult', pid: p.id, x: p.x, z: p.z, hero: 'tidebinder' });
    });
    return true;
  },
};

// ------------------------------------------------------------------ Fuck
function clearForbes(sim, p, proj) {
  if (proj && p.state.orb !== proj) return;
  p.state.orb = null;
  p.flags.qRecast = false;
}

const fuck = {
  attack(sim, p, aim) {
    const atk = HEROES.fuck.attack;
    fireProjectile(sim, p, aim, {
      kind: 'orb', speed: atk.speed, range: atk.range, r: atk.radius, objectDamage: atk.damage, basic: true,
      onHit(sim, pr, t) { sim.damage(t, atk.damage, p, { basic: true }); },
    });
    p.cd.attack = atk.cooldown;
    sim.emit({ e: 'shoot', pid: p.id });
  },

  recast(sim, p, key) {
    if (key !== 'q' || !p.state.orb || p.state.orb.dead) return false;
    const pr = p.state.orb;
    const max = ARENA.wallRadius - ARENA.playerRadius;
    let x = pr.x, z = pr.z;
    const d = Math.hypot(x, z);
    if (d > max) { x *= max / d; z *= max / d; }
    p.x = x; p.z = z;
    p.kx = 0; p.kz = 0;
    p.dash = null;
    pr.dead = true;
    clearForbes(sim, p, pr);
    sim.emit({ e: 'text', x: p.x, z: p.z, text: 'RIFT', color: '#e7b4ff' });
    sim.emit({ e: 'explode', x: p.x, z: p.z, r: 1.2, color: '#e7b4ff' });
    return true;
  },

  q(sim, p, aim) {
    const a = HEROES.fuck.abilities.q;
    clearForbes(sim, p);
    const proj = fireProjectile(sim, p, aim, {
      kind: 'forbes', speed: a.speed, range: a.range, r: a.radius, pierce: true, ghost: true,
      onHit(sim, pr, t) { sim.damage(t, a.damage, p); },
      onHitObject(sim, pr, z) {
        sim.damageObject(z, a.damage, p);
      },
      onExpire(sim, pr) { clearForbes(sim, p, pr); },
    });
    p.state.orb = proj;
    p.flags.qRecast = true;
    sim.emit({ e: 'shoot', pid: p.id });
    return true;
  },

  w(sim, p, aim) {
    const a = HEROES.fuck.abilities.w;
    for (const t of sim.enemiesInRadius(p.x, p.z, a.radius, p)) {
      sim.damage(t, a.damage, p);
      sim.knock(t, t.x - p.x, t.z - p.z, a.knockback);
      sim.addEffect(t, 'silence', a.silence);
    }
    const burstPatrol = sim.patrolInRadius(p.x, p.z, a.radius);
    if (burstPatrol) sim.knock(burstPatrol, burstPatrol.x - p.x, burstPatrol.z - p.z, a.knockback);
    harmRadius(sim, p.x, p.z, a.radius, a.damage, p);
    sim.emit({ e: 'explode', x: p.x, z: p.z, r: a.radius, color: '#c084fc' });
    const [dx, dz] = sim.dirTo(p, aim);
    const clear = (d) => {
      const x = p.x + dx * d, z = p.z + dz * d;
      return Math.hypot(x, z) <= ARENA.wallRadius - ARENA.playerRadius && !sim.blockedByProp(x, z, ARENA.playerRadius);
    };
    let land = clear(a.blink) ? a.blink : 0;
    if (!land) {
      for (let d = a.blink - 0.15; d >= 0.2; d -= 0.15) {
        if (clear(d)) { land = d; break; }
      }
    }
    if (land > 0) {
      p.x += dx * land;
      p.z += dz * land;
      p.kx = 0;
      p.kz = 0;
      p.facing = Math.atan2(dz, dx);
      sim.emit({ e: 'explode', x: p.x, z: p.z, r: 0.8, color: '#e7b4ff' });
    }
    return true;
  },

  e(sim, p) {
    const a = HEROES.fuck.abilities.e;
    p.input.target = null;
    p.input.mx = 0;
    p.input.mz = 0;
    p.kx = 0;
    p.kz = 0;
    p.pendingAttack = null;
    p.attackBuffer = null;
    sim.addEffect(p, 'phase', a.duration);
    sim.emit({ e: 'text', x: p.x, z: p.z, text: 'PHASE', color: '#e7b4ff' });
    sim.emit({ e: 'explode', x: p.x, z: p.z, r: 1.4, color: '#e7b4ff' });
    return true;
  },

  r(sim, p, aim) {
    const a = HEROES.fuck.abilities.r;
    const target = clampToRange(p, aim, a.castRange);
    sim.addZone({
      kind: 'leash', owner: p.id, x: target[0], z: target[1], r: a.radius, until: sim.time + a.duration, pid: null,
      onTick(sim, zone) {
        const owner = sim.players[zone.owner];
        if (!zone.pid) {
          const near = sim.enemiesInRadius(zone.x, zone.z, a.grab, owner).filter((t) => !sim.spellImmune(t));
          if (!near.length) return;
          near.sort((u, v) => Math.hypot(u.x - zone.x, u.z - zone.z) - Math.hypot(v.x - zone.x, v.z - zone.z));
          const t = near[0];
          zone.pid = t.id;
          sim.damage(t, a.damage, owner);
          sim.addEffect(t, 'stun', a.miniStun);
          sim.emit({ e: 'text', x: t.x, z: t.z, text: 'LATCHED', color: '#e7b4ff' });
        }
        const t = sim.players[zone.pid];
        if (!t || !t.alive) { zone.dead = true; return; }
        if (sim.hasEffect(t, 'phase') || sim.hasEffect(t, 'perch')) return;
        if (sim.spellImmune(t)) { sim.removeEffect(t, 'leash'); zone.dead = true; return; }
        zone.tx = t.x; zone.tz = t.z;
        sim.addEffect(t, 'leash', Math.max(0.2, zone.until - sim.time));
        if (Math.hypot(t.x - zone.x, t.z - zone.z) > a.radius + ARENA.playerRadius) {
          sim.damage(t, a.breakDamage, owner);
          sim.addEffect(t, 'stun', a.breakStun);
          sim.removeEffect(t, 'leash');
          sim.emit({ e: 'text', x: t.x, z: t.z, text: 'SNAPPED', color: '#ff7ad9' });
          zone.dead = true;
        }
      },
      onExpire(sim, zone) {
        const t = sim.players[zone.pid];
        if (t) sim.removeEffect(t, 'leash');
      },
    });
    sim.emit({ e: 'ult', pid: p.id, x: target[0], z: target[1], hero: 'fuck' });
    return true;
  },
};

// ---------------------------------------------------------------- Python
function injectVenom(sim, p) {
  const a = HEROES.python.abilities.q;
  let best = null, bestD = Infinity;
  for (const t of sim.enemiesInRadius(p.x, p.z, a.radius, p)) {
    const d = Math.hypot(t.x - p.x, t.z - p.z);
    if (d < bestD) { best = t; bestD = d; }
  }
  harmPacks(sim, p.x, p.z, a.radius, a.damage, p);
  if (!best) {
    const patrol = sim.patrolInRadius(p.x, p.z, a.radius);
    if (patrol) addDecaySlow(sim, patrol, a.slowFrom, a.slowTo, a.slowTime, 'venom');
    return;
  }
  sim.damage(best, a.damage, p, { kind: 'poison' });
  addDecaySlow(sim, best, a.slowFrom, a.slowTo, a.slowTime, 'venom');
  extendPoison(sim, p, best);
  const patrol = sim.patrolInRadius(p.x, p.z, a.radius);
  if (patrol) addDecaySlow(sim, patrol, a.slowFrom, a.slowTo, a.slowTime, 'venom');
  sim.emit({ e: 'text', x: best.x, z: best.z, text: 'VENOM', color: '#9be05a' });
}

function poisonLimit() {
  const passive = HEROES.python.abilities.e;
  return passive.stacks * passive.interval;
}

function applyPoison(sim, owner, target) {
  if (debuffBlocked(sim, target)) return null;
  const passive = HEROES.python.abilities.e;
  const cap = sim.time + poisonLimit();
  const existing = target.effects.find((fx) => fx.type === 'poison' && fx.source === owner.id);
  const until = Math.min(cap, Math.max(existing?.until || 0, sim.time + passive.duration));
  if (existing) {
    existing.until = until;
    existing.interval = passive.interval;
    existing.tickDamage = passive.damage;
    existing.stacks = passive.stacks;
    return existing;
  }
  const e = {
    type: 'poison', until, source: owner.id, acc: 0,
    interval: passive.interval, tickDamage: passive.damage, stacks: passive.stacks,
  };
  target.effects.push(e);
  return e;
}

function extendPoison(sim, owner, target) {
  if (debuffBlocked(sim, target)) return;
  const poison = target.effects.find((fx) => fx.type === 'poison' && fx.source === owner.id);
  if (!poison) return;
  const passive = HEROES.python.abilities.e;
  poison.until = Math.min(sim.time + poisonLimit(), poison.until + passive.extend);
  poison.interval = passive.interval;
  poison.stacks = passive.stacks;
}

function whipSquare(p, a) {
  const halfF = a.length / 2;
  const halfS = a.width / 2;
  const along = halfF - a.behind;
  const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
  return { x: p.x + fx * along, z: p.z + fz * along, facing: p.facing, halfF, halfS };
}

const python = {
  attack(sim, p, aim) {
    const atk = HEROES.python.attack;
    const passive = HEROES.python.abilities.e;
    fireProjectile(sim, p, aim, {
      kind: 'dart', speed: atk.speed, range: atk.range, r: atk.radius, objectDamage: atk.damage, basic: true,
      onHit(sim, pr, t) {
        sim.damage(t, atk.damage, p, { kind: 'poison', basic: true });
        if (p.cd.e > 0) return;
        p.cd.e = sim.freeCooldowns ? 0 : passive.cooldown;
        p.flags.poisonReady = p.cd.e <= 0;
        if (!t.alive || !applyPoison(sim, p, t)) return;
        sim.emit({ e: 'text', x: t.x, z: t.z, text: 'POISON', color: '#7dce4a' });
      },
    });
    p.cd.attack = atk.cooldown;
    sim.emit({ e: 'shoot', pid: p.id });
  },

  onTick(sim, p) {
    p.flags.poisonReady = p.alive && p.cd.e <= 0;
  },

  q(sim, p, aim) {
    const a = HEROES.python.abilities.q;
    const target = clampToRange(p, aim, a.distance);
    const dx = target[0] - p.x, dz = target[1] - p.z;
    const dist = Math.hypot(dx, dz);
    const showR = a.radius + ARENA.playerRadius;
    if (dist < 0.35) {
      injectVenom(sim, p);
    } else {
      sim.startDash(p, dx, dz, dist, a.speed, 'leap', { over: true, onEnd: injectVenom });
    }
    sim.addZone({
      kind: 'bite', owner: p.id, x: target[0], z: target[1], r: showR,
      until: sim.time + (dist < 0.35 ? 0.2 : dist / a.speed),
      onTick(sim, zone) {
        const owner = sim.players[zone.owner];
        if (owner?.dash?.kind !== 'leap') return;
        zone.x = owner.x + owner.dash.dx * owner.dash.remaining;
        zone.z = owner.z + owner.dash.dz * owner.dash.remaining;
        zone.until = sim.time + owner.dash.remaining / owner.dash.speed + 0.05;
      },
    });
    sim.emit({ e: 'dash', pid: p.id, kind: 'leap' });
    return true;
  },

  w(sim, p, aim) {
    const a = HEROES.python.abilities.w;
    sim.startCast(p, 'w', a.windup, aim, () => {
      const box = whipSquare(p, a);
      const fx = Math.cos(box.facing), fz = Math.sin(box.facing);
      for (const t of sim.enemiesInSquare(box.x, box.z, box.facing, box.halfF, box.halfS, p)) {
        sim.damage(t, a.damage, p);
        sim.knock(t, fx, fz, a.knockback);
        extendPoison(sim, p, t);
      }
      for (const o of sim.objectsInSquare(box.x, box.z, box.facing, box.halfF, box.halfS)) sim.damageObject(o, a.damage, p);
      const patrol = sim.patrolInSquare(box.x, box.z, box.facing, box.halfF, box.halfS);
      if (patrol) sim.knock(patrol, fx, fz, a.knockback);
      sim.addEffect(p, 'haste', a.hasteTime, { amount: a.haste, turn: a.turn });
      sim.emit({ e: 'swing', pid: p.id, x: box.x, z: box.z, f: box.facing, range: box.halfF, angle: Math.PI, color: '#c6f25a', big: true });
    });
    const box = whipSquare(p, a);
    sim.addZone({
      kind: 'whip', owner: p.id, x: box.x, z: box.z, r: box.halfF, w: box.halfS, f: box.facing,
      until: sim.time + a.windup,
      onTick(sim, zone) {
        const owner = sim.players[zone.owner];
        if (!owner?.cast || owner.cast.key !== 'w') { zone.dead = true; return; }
        const next = whipSquare(owner, a);
        zone.x = next.x; zone.z = next.z; zone.f = next.facing;
        zone.until = owner.cast.until;
      },
    });
    return true;
  },

  e() { return false; },

  r(sim, p, aim) {
    const a = HEROES.python.abilities.r;
    const target = clampToRange(p, aim, a.castRange);
    sim.addZone({
      kind: 'cloud', owner: p.id, x: target[0], z: target[1], r: a.radius, until: sim.time + a.duration,
      onTick(sim, zone) {
        const owner = sim.players[zone.owner];
        for (const e of sim.enemiesInRadius(zone.x, zone.z, zone.r, owner)) {
          sim.addEffect(e, 'silence', 0.3);
          addSlow(sim, e, a.slow, 0.35, 'cloud');
        }
        const patrol = sim.patrolInRadius(zone.x, zone.z, zone.r);
        if (patrol) addSlow(sim, patrol, a.slow, 0.35, 'cloud');
      },
    });
    sim.emit({ e: 'ult', pid: p.id, x: target[0], z: target[1], hero: 'python' });
    return true;
  },
};

function aheadBox(p, length, width) {
  const halfF = length / 2;
  const halfS = width / 2;
  const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
  return { x: p.x + fx * halfF, z: p.z + fz * halfF, facing: p.facing, halfF, halfS, fx, fz };
}

function startPoleJump(sim, p, aim, onEnd, radius) {
  const a = HEROES.monk.abilities.w;
  const target = clampToRange(p, aim, a.castRange);
  const dx = target[0] - p.x, dz = target[1] - p.z;
  const dist = Math.hypot(dx, dz);
  p.pendingAttack = null;
  p.attackBuffer = null;
  if (dist < 0.3) {
    if (dist > 0.01) p.facing = Math.atan2(dz, dx);
    onEnd(sim, p);
  } else {
    sim.startDash(p, dx, dz, dist, a.speed, 'pole', { over: true, onEnd });
  }
  const travel = dist < 0.3 ? 0.15 : dist / a.speed;
  sim.addZone({
    kind: 'pole', owner: p.id, x: target[0], z: target[1], r: radius,
    until: sim.time + travel + 0.12,
    onTick(sim, zone) {
      const owner = sim.players[zone.owner];
      if (owner?.dash?.kind !== 'pole') return;
      zone.x = owner.x + owner.dash.dx * owner.dash.remaining;
      zone.z = owner.z + owner.dash.dz * owner.dash.remaining;
      zone.until = sim.time + owner.dash.remaining / owner.dash.speed + 0.12;
    },
  });
}

function sitOnPole(sim, p) {
  if (!p.alive) return;
  const a = HEROES.monk.abilities.w;
  p.kx = 0;
  p.kz = 0;
  p.pendingAttack = null;
  p.attackBuffer = null;
  sim.addEffect(p, 'perch', a.perchTime);
  p.flags.wRecast = true;
  p.state.perchAt = sim.time;
  sim.emit({ e: 'text', x: p.x, z: p.z, text: 'PERCH', color: '#f0d78c' });
}

function poleStrike(sim, p) {
  if (!p.alive) return;
  const a = HEROES.monk.abilities.w;
  for (const t of sim.enemiesInRadius(p.x, p.z, a.strikeRadius, p)) {
    sim.damage(t, a.damage, p);
    addSlow(sim, t, a.slow, a.slowTime, 'pole');
  }
  harmRadius(sim, p.x, p.z, a.strikeRadius, a.damage, p);
  const patrol = sim.patrolInRadius(p.x, p.z, a.strikeRadius);
  if (patrol) addSlow(sim, patrol, a.slow, a.slowTime, 'pole');
  sim.emit({ e: 'explode', x: p.x, z: p.z, r: a.strikeRadius, color: '#f0d78c' });
  sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range: a.strikeRadius, angle: Math.PI, color: '#f0d78c', big: true });
}

// ------------------------------------------------------------------- Monk
const monk = {
  attack(sim, p, aim) {
    const atk = HEROES.monk.attack;
    const step = p.state.combo || 0;
    const [dx, dz] = sim.dirTo(p, aim);
    p.facing = Math.atan2(dz, dx);
    if (step === 0) {
      for (const t of sim.enemiesInRadius(p.x, p.z, atk.sweepRange, p)) {
        if (sim.tryDodge(t)) continue;
        sim.damage(t, atk.damage, p, { basic: true });
      }
      harmRadius(sim, p.x, p.z, atk.sweepRange, atk.damage, p);
      sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range: atk.sweepRange, angle: Math.PI, color: '#f0d78c', big: false });
    } else if (step === 1) {
      for (const t of sim.enemiesInCone(p, dx, dz, atk.doubleRange, atk.doubleHalfAngle)) {
        if (sim.tryDodge(t)) continue;
        sim.damage(t, atk.doubleDamage, p, { basic: true });
      }
      harmCone(sim, p, dx, dz, atk.doubleRange, atk.doubleHalfAngle, atk.doubleDamage, p);
      sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range: atk.doubleRange, angle: atk.doubleHalfAngle, color: '#ffe7a3', big: true });
      sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing + 0.4, range: atk.doubleRange * 0.92, angle: atk.doubleHalfAngle, color: '#fff6d0', big: false });
    } else {
      const box = aheadBox(p, atk.lineRange, atk.lineWidth);
      for (const t of sim.enemiesInSquare(box.x, box.z, box.facing, box.halfF, box.halfS, p)) {
        if (sim.tryDodge(t)) continue;
        sim.damage(t, atk.damage, p, { basic: true });
        sim.knock(t, box.fx, box.fz, atk.knockback, { basic: true });
      }
      for (const o of sim.objectsInSquare(box.x, box.z, box.facing, box.halfF, box.halfS)) sim.damageObject(o, atk.damage, p);
      const patrol = sim.patrolInSquare(box.x, box.z, box.facing, box.halfF, box.halfS);
      if (patrol) sim.knock(patrol, box.fx, box.fz, atk.knockback, { basic: true });
      const arc = Math.max(0.14, Math.atan2(atk.lineWidth, atk.lineRange));
      sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range: atk.lineRange, angle: arc, color: '#fff1c2', big: true });
    }
    p.state.swing = { step, start: sim.time, until: sim.time + 0.42 };
    p.state.combo = (step + 1) % 3;
    p.flags.combo = p.state.combo;
    p.cd.attack = atk.cooldown;
  },

  onTick(sim, p) {
    p.flags.combo = p.state.combo || 0;
    const sw = p.state.swing;
    const winding = p.cast && p.cast.key === 'attack';
    if (sw && sim.time >= sw.until) p.state.swing = null;
    if (sw && sim.time < sw.until && !winding) {
      const dur = Math.max(0.05, sw.until - sw.start);
      p.flags.pose = sw.step;
      p.flags.poseT = Math.max(0, Math.min(1, (sim.time - sw.start) / dur));
    } else {
      p.flags.pose = undefined;
      p.flags.poseT = undefined;
    }
    if (sim.hasEffect(p, 'perch') && sim.stunned(p)) sim.removeEffect(p, 'perch');
    if (p.flags.wRecast && !sim.hasEffect(p, 'perch')) p.flags.wRecast = false;
  },

  q(sim, p, aim) {
    const a = HEROES.monk.abilities.q;
    const [dx, dz] = sim.dirTo(p, aim);
    p.facing = Math.atan2(dz, dx);
    for (const t of sim.enemiesInCone(p, dx, dz, a.range, a.halfAngle)) {
      sim.damage(t, a.damage, p);
      if (!t.alive) continue;
      sim.knock(t, t.x - p.x, t.z - p.z, a.knockback);
      const rooted = sim.addEffect(t, 'root', a.rootTime);
      sim.addEffect(t, 'prone', a.rootTime);
      if (rooted) sim.emit({ e: 'text', x: t.x, z: t.z, text: 'PRONE', color: '#e7c98a' });
    }
    harmCone(sim, p, dx, dz, a.range, a.halfAngle, a.damage, p);
    const patrol = sim.patrolInCone(p, dx, dz, a.range, a.halfAngle);
    if (patrol) sim.knock(patrol, patrol.x - p.x, patrol.z - p.z, a.knockback);
    sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range: a.range, angle: a.halfAngle, color: '#e7c98a', big: true });
    p.state.swing = { step: 3, start: sim.time, until: sim.time + 0.4 };
    return true;
  },

  w(sim, p, aim) {
    const a = HEROES.monk.abilities.w;
    startPoleJump(sim, p, aim, sitOnPole, 0.9);
    sim.emit({ e: 'dash', pid: p.id, kind: 'pole' });
    return true;
  },

  recast(sim, p, key, aim) {
    if (key !== 'w' || !sim.hasEffect(p, 'perch')) return false;
    if (!p.alive || sim.stunned(p) || sim.hasEffect(p, 'silence')) return true;
    sim.removeEffect(p, 'perch');
    p.flags.wRecast = false;
    startPoleJump(sim, p, aim, poleStrike, HEROES.monk.abilities.w.strikeRadius);
    sim.emit({ e: 'dash', pid: p.id, kind: 'pole' });
    return true;
  },

  e(sim, p) {
    const a = HEROES.monk.abilities.e;
    sim.addEffect(p, 'dodge', a.duration, { heal: a.heal });
    sim.emit({ e: 'text', x: p.x, z: p.z, text: 'STEP ASIDE', color: '#f0d78c' });
    return true;
  },

  r(sim, p) {
    const a = HEROES.monk.abilities.r;
    sim.purge(p);
    p.cd.q = 0;
    p.cd.w = 0;
    p.cd.e = 0;
    sim.addEffect(p, 'spellImmune', a.duration);
    sim.addEffect(p, 'attackSpeed', a.duration, { amount: a.attackSpeed });
    sim.emit({ e: 'ult', pid: p.id, x: p.x, z: p.z, hero: 'monk' });
    return true;
  },
};

// ------------------------------------------------------------ Illusionist
function livingGhost(p) {
  const g = p.state.ghost;
  return g && !g.dead ? g : null;
}

function clearGhost(p, zone) {
  if (!p || (zone && p.state.ghost !== zone)) return;
  p.state.ghost = null;
  p.state.swaps = 0;
  p.flags.wRecast = false;
  p.flags.swaps = 0;
}

function syncBolts(sim, p) {
  p.flags.qRecast = sim.projectiles.some((pr) => pr.guided && pr.owner === p.id && !pr.dead && !pr.redirected);
}

function launchSpark(sim, p, from, aim, silent) {
  const atk = HEROES.illusionist.attack;
  fireProjectile(sim, p, aim, {
    origin: from, silent, kind: 'spark', speed: atk.speed, range: atk.range, r: atk.radius,
    objectDamage: atk.damage, basic: true,
    onHit(sim, pr, t) { sim.damage(t, atk.damage, p, { basic: true }); },
  });
}

function launchBolt(sim, p, from, aim, silent) {
  const a = HEROES.illusionist.abilities.q;
  fireProjectile(sim, p, aim, {
    origin: from, silent, kind: 'magebolt', guided: true,
    speed: a.speed, range: a.range, r: a.radius, objectDamage: a.damage,
    onHit(sim, pr, t) {
      const bonus = (pr.traveled || 0) >= a.minRange ? a.bonus : 0;
      sim.damage(t, a.damage + bonus, p);
      addSlow(sim, t, a.slow, a.slowTime, 'bolt');
    },
    onExpire() { syncBolts(sim, p); },
  });
  syncBolts(sim, p);
}

const illusionist = {
  attack(sim, p, aim) {
    launchSpark(sim, p, p, aim, false);
    const ghost = livingGhost(p);
    if (ghost) launchSpark(sim, p, ghost, aim, true);
    p.cd.attack = HEROES.illusionist.attack.cooldown;
    sim.emit({ e: 'shoot', pid: p.id });
  },

  onTick(sim, p) {
    syncBolts(sim, p);
    const ghost = p.state.ghost;
    if (!ghost) return;
    if (ghost.dead || !p.alive) { clearGhost(p, ghost); return; }
    p.flags.wRecast = (p.state.swaps || 0) > 0;
    p.flags.swaps = p.state.swaps || 0;
  },

  recast(sim, p, key, aim) {
    if (key === 'q') {
      const bolts = sim.projectiles.filter((pr) => pr.guided && pr.owner === p.id && !pr.dead && !pr.redirected);
      if (!bolts.length) return false;
      const a = HEROES.illusionist.abilities.q;
      for (const pr of bolts) {
        const [dx, dz] = sim.dirTo({ x: pr.x, z: pr.z, facing: Math.atan2(pr.dz, pr.dx) }, aim);
        pr.dx = dx;
        pr.dz = dz;
        pr.arc = null;
        pr.redirected = true;
        if (!pr.boosted) { pr.speed *= a.speedBoost; pr.boosted = true; }
        const dist = Math.hypot(aim[0] - pr.x, aim[1] - pr.z);
        pr.remaining = Math.min(a.range, Math.max(pr.remaining, dist));
      }
      syncBolts(sim, p);
      sim.emit({ e: 'text', x: p.x, z: p.z, text: 'BOLT', color: '#d7a6ff' });
      return true;
    }
    if (key !== 'w') return false;
    const ghost = livingGhost(p);
    if (!ghost || (p.state.swaps || 0) <= 0) return false;
    if (sim.stunned(p) || sim.hasEffect(p, 'silence') || sim.hasEffect(p, 'rabbit')) return true;
    const x = p.x, z = p.z;
    p.x = ghost.x;
    p.z = ghost.z;
    p.kx = 0;
    p.kz = 0;
    p.dash = null;
    ghost.x = x;
    ghost.z = z;
    p.state.swaps -= 1;
    p.flags.swaps = p.state.swaps;
    p.flags.wRecast = p.state.swaps > 0;
    sim.emit({ e: 'text', x: p.x, z: p.z, text: 'SWAP', color: '#d7d7de' });
    sim.emit({ e: 'explode', x: p.x, z: p.z, r: 1.1, color: '#c5c8ce' });
    sim.emit({ e: 'explode', x: ghost.x, z: ghost.z, r: 1.1, color: '#c5c8ce' });
    return true;
  },

  q(sim, p, aim) {
    launchBolt(sim, p, p, aim, false);
    const ghost = livingGhost(p);
    if (ghost) launchBolt(sim, p, ghost, aim, true);
    sim.emit({ e: 'shoot', pid: p.id });
    return true;
  },

  w(sim, p, aim) {
    const a = HEROES.illusionist.abilities.w;
    const spot = clampToRange(p, aim, a.castRange);
    if (p.state.ghost) p.state.ghost.dead = true;
    clearGhost(p);
    const zone = sim.addZone({
      kind: 'ghost', owner: p.id, x: spot[0], z: spot[1], f: p.facing, r: 0.8,
      until: sim.time + a.duration, facing: p.facing,
      onTick(sim, z) {
        const owner = sim.players[z.owner];
        if (!owner?.alive) { clearGhost(owner, z); z.dead = true; return; }
        const [dx, dz] = sim.dirTo(z, [owner.input.ax, owner.input.az]);
        z.f = Math.atan2(dz, dx);
        z.facing = z.f;
      },
      onExpire(sim, z) { clearGhost(sim.players[z.owner], z); },
    });
    p.state.ghost = zone;
    p.state.swaps = a.swaps;
    p.flags.wRecast = true;
    p.flags.swaps = a.swaps;
    sim.emit({ e: 'text', x: spot[0], z: spot[1], text: 'GHOST', color: '#d7d7de' });
    return true;
  },

  e(sim, p, aim) {
    const a = HEROES.illusionist.abilities.e;
    const spot = clampToRange(p, aim, a.castRange);
    sim.addZone({
      kind: 'hat', owner: p.id, x: spot[0], z: spot[1], r: a.radius, until: sim.time + a.delay,
      onExpire(sim, z) {
        const owner = sim.players[z.owner];
        for (const id of sim.order) {
          const t = sim.players[id];
          if (!t.alive || sim.isGhost(t)) continue;
          if (Math.hypot(t.x - z.x, t.z - z.z) > z.r + ARENA.playerRadius) continue;
          const applied = sim.addEffect(t, 'rabbit', a.duration, { slow: a.slow });
          if (!applied) continue;
          t.pendingAttack = null;
          t.attackBuffer = null;
          if (t.cast) { t.cast = null; sim.emit({ e: 'interrupt', pid: t.id }); }
          sim.emit({ e: 'text', x: t.x, z: t.z, text: 'RABBIT', color: '#f4efe4' });
        }
        sim.emit({ e: 'explode', x: z.x, z: z.z, r: z.r, color: '#f4efe4' });
      },
    });
    sim.emit({ e: 'text', x: spot[0], z: spot[1], text: 'HAT', color: '#b45cff' });
    return true;
  },

  r(sim, p) {
    const a = HEROES.illusionist.abilities.r;
    sim.addZone({
      kind: 'disco', owner: p.id, x: p.x, z: p.z, r: a.radius, until: sim.time + a.duration, acc: 0, pulses: 0,
      onTick(sim, z, dt) {
        const owner = sim.players[z.owner];
        if (!owner?.alive) { z.dead = true; return; }
        z.x = owner.x;
        z.z = owner.z;
        z.acc = (z.acc || 0) + dt;
        while (z.acc >= a.interval && z.pulses < a.duration / a.interval) {
          z.acc -= a.interval;
          z.pulses += 1;
          for (const e of sim.enemiesInRadius(z.x, z.z, z.r, owner)) sim.damage(e, a.damage, owner);
          harmPacks(sim, z.x, z.z, z.r, a.damage, owner);
          sim.emit({ e: 'explode', x: z.x, z: z.z, r: z.r * 0.55, color: z.pulses % 2 ? '#ff4fd8' : '#7af0ff' });
        }
      },
      onExpire(sim) {
        for (const id of sim.order) {
          const t = sim.players[id];
          if (!t.alive) continue;
          t.effects = t.effects.filter((e) => e.type !== 'root');
          t.effects.push({ type: 'root', until: sim.time + a.root });
          sim.emit({ e: 'text', x: t.x, z: t.z, text: 'ROOTED', color: '#ffd166' });
        }
      },
    });
    sim.addEffect(p, 'disco', a.duration);
    sim.emit({ e: 'ult', pid: p.id, x: p.x, z: p.z, hero: 'illusionist' });
    return true;
  },
};

// ----------------------------------------------------------------- Stone
function clampArena(x, z, pad) {
  const max = ARENA.wallRadius - pad;
  const d = Math.hypot(x, z);
  if (d > max && d > 1e-4) return [x * max / d, z * max / d];
  return [x, z];
}

function closestInFront(p, items, reach, halfS) {
  const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
  let best = null, bestD = Infinity;
  for (const it of items) {
    if (!it || it.dead) continue;
    const dx = it.x - p.x, dz = it.z - p.z;
    const along = dx * fx + dz * fz;
    const side = Math.abs(dx * -fz + dz * fx);
    const rad = it.r || ARENA.playerRadius;
    if (along < 0.2 || along > reach + rad) continue;
    if (side > halfS + rad * 0.45) continue;
    const d = Math.hypot(dx, dz);
    if (d < bestD) { best = it; bestD = d; }
  }
  return best;
}

const CARRIABLE = new Set(['boulder', 'shed', 'meteor']);

function nearestRock(sim, p, reach) {
  let best = null, bestD = Infinity;
  for (const it of sim.livingProps()) {
    if (it.permanent || !CARRIABLE.has(it.kind)) continue;
    const d = Math.hypot(it.x - p.x, it.z - p.z);
    if (d > reach + (it.r || 0)) continue;
    if (d < bestD) { best = it; bestD = d; }
  }
  return best;
}

function grabStone(sim, p) {
  const a = HEROES.stone.abilities.w;
  const found = nearestRock(sim, p, a.pickupRange);
  if (!found) return null;
  sim.props = sim.props.filter((pr) => pr !== found);
  const flame = !!found.flame || found.kind === 'meteor';
  sim.emit({ e: 'text', x: found.x, z: found.z, text: flame ? 'FLAME' : 'STONE', color: flame ? '#ff8a1a' : '#d9c38a' });
  return { flame, hp: found.hp, maxHp: found.maxHp };
}

// New rocks are pushed out of the health-pack spot. A rock that rolls or is kicked in is left where it lands.
function outsidePack(x, z, pad) {
  const min = ARENA.centerClear + pad;
  const d = Math.hypot(x, z);
  if (d >= min) return [x, z];
  if (d < 1e-4) return [min, 0];
  return [(x / d) * min, (z / d) * min];
}

function spawnRock(sim, x, z, flame) {
  const roll = HEROES.stone.abilities.e;
  const r = HEROES.stone.abilities.r;
  const radius = flame ? r.stoneRadius : roll.rockRadius;
  let [cx, cz] = outsidePack(...clampArena(x, z, radius), radius);
  for (let n = 0; n < 6; n++) {
    const blocked = sim.props.some((p) => p.alive !== false && Math.hypot(p.x - cx, p.z - cz) < (p.r || 0) + radius);
    if (!blocked) break;
    const ang = Math.atan2(cz, cx) + 0.65;
    const dist = Math.max(Math.hypot(cx, cz), ARENA.centerClear + radius);
    cx = Math.cos(ang) * dist;
    cz = Math.sin(ang) * dist;
  }
  [cx, cz] = clampArena(cx, cz, radius);
  const prop = {
    id: `rock${sim.id()}`,
    x: cx, z: cz,
    r: flame ? r.stoneRadius : roll.rockRadius,
    kind: flame ? 'meteor' : 'shed',
    flame: !!flame,
    temp: true,
    hp: flame ? r.stoneHp : roll.rockHp,
    maxHp: flame ? r.stoneHp : roll.rockHp,
    alive: true,
    kx: 0, kz: 0,
  };
  sim.props.push(prop);
  return prop;
}

function flameTrail(sim, pr) {
  const a = HEROES.stone.abilities.r;
  if (pr.lastFire && Math.hypot(pr.x - pr.lastFire[0], pr.z - pr.lastFire[1]) < 0.85) return;
  pr.lastFire = [pr.x, pr.z];
  sim.addZone({
    kind: 'fire', owner: pr.owner, x: pr.x, z: pr.z, r: 0.95, until: sim.time + a.trailTime,
    onTick(sim, z, dt) {
      const owner = sim.players[z.owner];
      for (const e of sim.enemiesInRadius(z.x, z.z, z.r, owner)) sim.addEffect(e, 'burn', 0.35, { dps: a.trailDps });
      tickPackDamage(sim, z, dt, a.trailDps, owner);
    },
  });
}

function applyThrow(sim, pr, target) {
  if (!target?.alive) return;
  if (!pr.struck) pr.struck = new Set();
  if (pr.struck.has(target.id)) return;
  pr.struck.add(target.id);
  const owner = sim.players[pr.owner];
  const a = HEROES.stone.abilities.w;
  const bonus = pr.flame ? HEROES.stone.abilities.r.bonus : 0;
  sim.damage(target, a.damage + bonus, owner);
  sim.addEffect(target, 'stun', a.stun);
  addSlow(sim, target, a.slow, a.stun + a.slowTime, 'throw');
}

function stoneImpact(sim, pr, target) {
  if (target) { applyThrow(sim, pr, target); return; }
  const owner = sim.players[pr.owner];
  for (const e of sim.enemiesInRadius(pr.x, pr.z, pr.r, owner)) applyThrow(sim, pr, e);
}

function kickPower(elapsed) {
  const a = HEROES.stone.abilities.q;
  const t = Math.max(0, Math.min(1, elapsed / a.channel));
  return {
    t,
    damage: a.damage,
    dist: a.distance,
    speed: a.speed,
    reach: a.minReach + t * (a.maxReach - a.minReach),
  };
}

function kickSlow(sim, target) {
  const a = HEROES.stone.abilities.q;
  addSlow(sim, target, a.slow, a.slowTime, 'kick');
}

function kickBlast(sim, pr) {
  if (!pr.kick || pr.kickDone) return;
  pr.kickDone = true;
  const src = sim.players[pr.kick.owner];
  const dmg = pr.kick.damage;
  const splash = pr.kick.splash;
  for (const id of sim.order) {
    const e = sim.players[id];
    if (!e.alive || e.id === pr.kick.owner || pr.hit.has(e.id)) continue;
    if (Math.hypot(e.x - pr.x, e.z - pr.z) <= splash + ARENA.playerRadius) {
      sim.damage(e, dmg, src);
      kickSlow(sim, e);
    }
  }
  harmRadius(sim, pr.x, pr.z, splash, dmg, src);
}

function launchKickedKeg(sim, p, keg, power) {
  const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
  const saved = {
    r: keg.r,
    hp: keg.hp,
    maxHp: keg.maxHp,
    fusing: !!keg.fusing,
    fuseLeft: keg.fusing ? Math.max(0.05, keg.until - sim.time) : 0,
    killer: keg.killer || null,
  };
  sim.removeZone(keg);
  sim.addProjectile({
    kind: 'keg',
    owner: p.id,
    x: keg.x, z: keg.z,
    dx: fx, dz: fz,
    speed: power.speed,
    remaining: power.dist,
    r: keg.r,
    pierce: true,
    flyover: true,
    kick: { damage: power.damage, splash: HEROES.stone.abilities.q.splash, owner: p.id },
    onDie(sim, pr) {
      const [cx, cz] = clampArena(pr.x, pr.z, saved.r);
      pr.x = cx;
      pr.z = cz;
      kickBlast(sim, pr);
      const zone = sim.addZone({
        kind: 'keg', x: cx, z: cz, r: saved.r,
        hp: saved.hp, maxHp: saved.maxHp,
        until: saved.fusing ? sim.time + saved.fuseLeft : Infinity,
        owner: null,
        fusing: saved.fusing,
        killer: saved.killer,
      });
      if (saved.fusing) zone.onExpire = (s, z) => s.explodeKeg(z);
      sim.damageObject(zone, power.damage, p);
    },
  });
}

function launchKickedProp(sim, p, prop, power) {
  const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
  const dmg = power.damage + (prop.flame ? HEROES.stone.abilities.r.bonus : 0);
  const objectDamage = prop.flame || prop.kind === 'meteor' ? HEROES.stone.abilities.r.chip : power.damage;
  sim.props = sim.props.filter((pr) => pr !== prop);
  sim.addProjectile({
    kind: prop.flame ? 'firestone' : 'stone',
    owner: p.id,
    x: prop.x, z: prop.z,
    dx: fx, dz: fz,
    speed: power.speed,
    remaining: power.dist,
    r: prop.r,
    pierce: true,
    flyover: true,
    flame: !!prop.flame,
    kick: { damage: dmg, splash: HEROES.stone.abilities.q.splash, owner: p.id },
    onTick: prop.flame ? flameTrail : null,
    onDie(sim, pr) {
      prop.x = pr.x;
      prop.z = pr.z;
      const [cx, cz] = clampArena(prop.x, prop.z, prop.r);
      prop.x = cx; prop.z = cz;
      prop.alive = true;
      const meteor = prop.flame || prop.kind === 'meteor';
      if (!meteor && !sim.props.includes(prop)) sim.props.push(prop);
      kickBlast(sim, pr);
      if (meteor && !sim.props.includes(prop)) sim.props.push(prop);
      sim.damageObject(prop, objectDamage, p);
    },
  });
}

function releaseKick(sim, p, elapsed) {
  if (!p.alive) return;
  const a = HEROES.stone.abilities.q;
  const power = kickPower(elapsed);
  const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
  const hero = closestInFront(p, sim.enemiesOf(p).filter((e) => !sim.isGhost(e)), power.reach, a.halfWidth);
  if (hero) {
    const dmg = power.damage;
    sim.startDash(hero, fx, fz, power.dist, power.speed, 'kicked', {
      onEnd(sim, t) {
        sim.damage(t, dmg, p);
        kickSlow(sim, t);
        for (const id of sim.order) {
          const e = sim.players[id];
          if (!e.alive || e === t) continue;
          if (Math.hypot(e.x - t.x, e.z - t.z) <= a.splash + ARENA.playerRadius) {
            sim.damage(e, dmg, p);
            kickSlow(sim, e);
          }
        }
        harmRadius(sim, t.x, t.z, a.splash, dmg, p);
      },
    });
    hero.cast = null;
    hero.pendingAttack = null;
    sim.emit({ e: 'text', x: hero.x, z: hero.z, text: 'KICK', color: '#ffb27a' });
    return;
  }
  const shot = closestInFront(p, sim.projectiles.filter((pr) => !pr.dead), power.reach, a.halfWidth);
  if (shot) {
    const prevTick = shot.onTick;
    const prevDie = shot.onDie;
    shot.owner = p.id;
    shot.hit = new Set();
    shot.dx = fx;
    shot.dz = fz;
    shot.arc = null;
    shot.speed = power.speed;
    shot.remaining = power.dist;
    shot.kick = { damage: power.damage + (shot.flame ? HEROES.stone.abilities.r.bonus : 0), splash: a.splash, owner: p.id };
    shot.kickDone = false;
    if (shot.flame) shot.meteorChip = (shot.meteorChip || 0) + 1;
    shot.onTick = (sim, pr, dt) => {
      if (prevTick) prevTick(sim, pr, dt);
      if (pr.flame) flameTrail(sim, pr);
    };
    shot.onDie = (sim, pr) => {
      kickBlast(sim, pr);
      if (prevDie) prevDie(sim, pr);
    };
    sim.emit({ e: 'text', x: shot.x, z: shot.z, text: 'KICK', color: '#ffb27a' });
    return;
  }
  const obstacles = sim.livingProps().filter((pr) => !pr.permanent);
  const kegs = sim.zones.filter((z) => z.kind === 'keg' && !z.dead && z.hp > 0);
  const obstacle = closestInFront(p, obstacles.concat(kegs), power.reach, a.halfWidth);
  if (obstacle) {
    if (obstacle.kind === 'keg') launchKickedKeg(sim, p, obstacle, power);
    else launchKickedProp(sim, p, obstacle, power);
    sim.emit({ e: 'text', x: obstacle.x, z: obstacle.z, text: 'KICK', color: '#ffb27a' });
    return;
  }
  sim.emit({ e: 'text', x: p.x, z: p.z, text: 'WHIFF', color: '#d9c38a' });
}

const stone = {
  attack(sim, p, aim) {
    const atk = HEROES.stone.attack;
    const [dx, dz] = sim.dirTo(p, aim);
    p.facing = Math.atan2(dz, dx);
    for (const t of sim.enemiesInCone(p, dx, dz, atk.range, atk.halfAngle)) {
      if (sim.tryDodge(t)) continue;
      sim.damage(t, atk.damage, p, { basic: true });
    }
    harmCone(sim, p, dx, dz, atk.range, atk.halfAngle, atk.damage, p);
    p.cd.attack = atk.cooldown;
    sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range: atk.range, angle: atk.halfAngle, color: '#e7a06a', big: false });
  },

  onTick(sim, p, dt) {
    if (p.cast?.key === 'q') {
      const desired = Math.atan2(p.input.az - p.z, p.input.ax - p.x);
      sim.turnToward(p, desired, dt);
    }
    p.flags.holding = p.state.held ? (p.state.held.flame ? 'flame' : 'stone') : undefined;
  },

  throwAttack(sim, p, aim, curve) {
    const a = HEROES.stone.abilities.w;
    const held = p.state.held;
    p.state.held = null;
    p.flags.holding = undefined;
    const arc = throwCurve(p.x, p.z, p.facing, aim, curve, a.range, a.curveCap);
    const [dx, dz] = sim.dirTo(p, aim);
    p.facing = Math.atan2(dz, dx);
    const bonus = held.flame ? HEROES.stone.abilities.r.bonus : 0;
    const proj = fireProjectile(sim, p, aim, {
      kind: held.flame ? 'firestone' : 'stone',
      speed: a.speed,
      range: arc.len,
      r: a.radius,
      flame: held.flame,
      arc,
      offset: 0.9,
      onHit(sim, pr, t) { stoneImpact(sim, pr, t); },
      onHitObject(sim, pr, z) {
        if (z.kind === 'healthpack') sim.damageObject(z, a.damage + bonus, p);
      },
      onTick: held.flame ? flameTrail : null,
      onExpire(sim, pr) { stoneImpact(sim, pr, null); },
      onDie(sim, pr) {
        if (!pr.flame) return;
        const rock = spawnRock(sim, pr.x, pr.z, true);
        if (pr.meteorHp != null) rock.hp = pr.meteorHp;
        sim.damageObject(rock, (pr.meteorChip || 1) * HEROES.stone.abilities.r.chip, p);
      },
    });
    if (held.flame) {
      proj.meteorHp = held.hp ?? HEROES.stone.abilities.r.stoneHp;
      proj.meteorChip = 1;
    }
    sim.emit({ e: 'shoot', pid: p.id });
    return true;
  },

  q(sim, p, aim) {
    const a = HEROES.stone.abilities.q;
    sim.startCast(p, 'q', a.channel, aim, () => releaseKick(sim, p, a.channel));
    return true;
  },

  release(sim, p, key) {
    if (key !== 'q' || !p.cast || p.cast.key !== 'q') return false;
    const elapsed = sim.time - p.cast.started;
    p.cast = null;
    releaseKick(sim, p, elapsed);
    return true;
  },

  w(sim, p) {
    if (p.state.held) return false;
    const held = grabStone(sim, p);
    if (!held) {
      sim.emit({ e: 'text', x: p.x, z: p.z, text: 'NO ROCK', color: '#d9c38a' });
      return false;
    }
    p.state.held = held;
    p.pendingAttack = null;
    p.attackBuffer = null;
    p.flags.holding = held.flame ? 'flame' : 'stone';
    sim.emit({ e: 'text', x: p.x, z: p.z, text: 'GRAB', color: '#d9c38a' });
    return true;
  },

  e(sim, p, aim) {
    const a = HEROES.stone.abilities.e;
    const [dx, dz] = sim.dirTo(p, aim);
    const back = ARENA.playerRadius + a.rockRadius + 0.15;
    const side = a.rockRadius + 0.06;
    sim.startDash(p, dx, dz, a.distance, a.speed, 'roll', {
      onEnd(sim, roller) {
        const px = -dz, pz = dx;
        spawnRock(sim, roller.x - dx * back + px * side, roller.z - dz * back + pz * side, false);
        spawnRock(sim, roller.x - dx * back - px * side, roller.z - dz * back - pz * side, false);
        sim.emit({ e: 'shed', pid: roller.id, x: roller.x, z: roller.z });
        sim.emit({ e: 'text', x: roller.x, z: roller.z, text: "ROCK 'N ROLL", color: '#d9c38a' });
      },
    });
    sim.emit({ e: 'dash', pid: p.id, kind: 'roll' });
    return true;
  },

  r(sim, p, aim) {
    const a = HEROES.stone.abilities.r;
    const spot = clampToRange(p, aim, a.castRange);
    const [dx, dz] = sim.dirTo(p, spot);
    sim.addZone({
      kind: 'meteor', owner: p.id, x: spot[0], z: spot[1], r: a.radius, f: Math.atan2(dz, dx), until: sim.time + a.delay,
      onExpire(sim, z) {
        const owner = sim.players[z.owner];
        for (const e of sim.enemiesInRadius(z.x, z.z, z.r, owner)) {
          sim.damage(e, a.damage, owner, { kind: 'fire' });
          sim.addEffect(e, 'stun', a.stun);
        }
        harmRadius(sim, z.x, z.z, z.r, a.damage, owner);
        spawnRock(sim, z.x, z.z, true);
        sim.emit({ e: 'explode', x: z.x, z: z.z, r: z.r, color: '#ff6a1a' });
      },
    });
    sim.emit({ e: 'ult', pid: p.id, x: spot[0], z: spot[1], hero: 'stone' });
    return true;
  },
};

// ------------------------------------------------------------------- Shock
function shockCharge(p) {
  if (!p.state.charge) p.state.charge = { dash: false, slow: false, bolt: false, spin: false };
  return p.state.charge;
}

function syncShockFlags(sim, p) {
  const c = p.state.charge || {};
  p.flags.dash = c.dash || undefined;
  p.flags.slow = c.slow || undefined;
  p.flags.bolt = c.bolt || undefined;
  p.flags.spin = c.spin || undefined;
  p.flags.echo = p.state.tempest ? 1 : undefined;
  const blade = p.state.blade;
  p.flags.blade = blade && sim.time < blade.until ? blade.angle : undefined;
  const storm = sim.getEffect(p, 'storm');
  if (storm) {
    const dur = HEROES.shock.abilities.e.duration || 0.8;
    p.flags.lift = Math.max(0, Math.min(1, 1 - (storm.until - sim.time) / dur));
  } else p.flags.lift = undefined;
}

function noteEcho(sim, p, action) {
  const tempest = p.state.tempest;
  if (!tempest || p.echo || sim.time > tempest.until) return;
  tempest.actions.push({ t: sim.time, ...action });
}

function openDistance(sim, x, z, dx, dz, maxDist) {
  const wall = ARENA.wallRadius - ARENA.playerRadius;
  let lo = 0;
  for (let d = 0.3; d <= maxDist + 1e-4; d += 0.3) {
    const step = Math.min(d, maxDist);
    const nx = x + dx * step, nz = z + dz * step;
    if (Math.hypot(nx, nz) > wall) return lo;
    if (sim.blockedByProp(nx, nz, ARENA.playerRadius * 0.45)) return lo;
    lo = step;
  }
  return lo;
}

function spinFacing(target) {
  if (target.facing == null) return;
  target.facing += Math.PI;
  if (target.facing > Math.PI) target.facing -= Math.PI * 2;
}

function shockLine(x, z, facing, length, width) {
  const fx = Math.cos(facing), fz = Math.sin(facing);
  const len = Math.max(0.2, length);
  return {
    x: x + fx * len * 0.5,
    z: z + fz * len * 0.5,
    facing,
    halfF: len * 0.5,
    halfS: width * 0.5,
  };
}

function luminairePulse(sim, owner, x, z, radius, echo) {
  const a = HEROES.shock.abilities.e;
  let hit = false;
  for (const t of sim.enemiesInRadius(x, z, radius, owner)) {
    sim.damage(t, a.damage, owner, { kind: 'shock' });
    hit = true;
  }
  harmRadius(sim, x, z, radius, a.damage, owner);
  if (sim.patrolInRadius(x, z, radius)) hit = true;
  if (hit && !echo && !shockCharge(owner).dash) {
    shockCharge(owner).dash = true;
    syncShockFlags(sim, owner);
    sim.emit({ e: 'text', x: owner.x, z: owner.z, text: 'STORM SLASH', color: '#ffe56a' });
  }
  sim.emit({ e: 'explode', x, z, r: radius, color: '#ffe56a' });
  return hit;
}

function cwDelta(from, to) {
  let d = from - to;
  d %= Math.PI * 2;
  if (d < 0) d += Math.PI * 2;
  return d;
}

function startBlade(sim, owner, echo) {
  const a = HEROES.shock.abilities.q;
  const blade = {
    start: sim.time,
    until: sim.time + a.spinTime,
    origin: owner.facing,
    angle: owner.facing,
    turns: 0,
    rev: 0,
    hit: new Set(),
  };
  if (echo) {
    const tempest = owner.state.tempest;
    if (tempest) {
      const facing = tempest.zone?.f ?? owner.facing;
      blade.origin = facing;
      blade.angle = facing;
      tempest.blade = blade;
    }
    return;
  }
  owner.state.blade = blade;
  owner.pendingAttack = null;
  owner.attackBuffer = null;
  if (owner.cast?.key === 'attack') owner.cast = null;
  syncShockFlags(sim, owner);
  sim.emit({ e: 'text', x: owner.x, z: owner.z, text: 'CYCLONE', color: '#ffe56a' });
}

function sweepBlade(sim, owner, x, z, prevAng, span, hits) {
  if (span <= 1e-5) return;
  const reach = HEROES.shock.attack.range;
  const dmg = HEROES.shock.attack.damage;
  const full = span >= Math.PI * 2 - 1e-3;
  const touched = (tx, tz, extra) => {
    const dx = tx - x, dz = tz - z;
    const dist = Math.hypot(dx, dz);
    if (dist > reach + extra) return false;
    if (full || dist < 0.35) return true;
    return cwDelta(prevAng, Math.atan2(dz, dx)) <= span + 1e-3;
  };
  for (const e of sim.enemiesOf(owner)) {
    if (!e.alive || sim.isGhost(e) || hits.has(e.id)) continue;
    if (!touched(e.x, e.z, ARENA.playerRadius)) continue;
    hits.add(e.id);
    if (sim.tryDodge(e)) continue;
    sim.damage(e, dmg, owner, { basic: true });
  }
  for (const o of sim.destructibles()) {
    if (hits.has(o.id) || !touched(o.x, o.z, o.r || 0)) continue;
    hits.add(o.id);
    sim.damageObject(o, dmg, owner);
  }
}

function tickBlade(sim, owner, blade, x, z) {
  const a = HEROES.shock.abilities.q;
  if (!blade) return false;
  const elapsed = Math.min(a.spinTime, Math.max(0, sim.time - blade.start));
  const turns = (elapsed / a.spinTime) * a.revolutions;
  let t = blade.turns || 0;
  while (t < turns - 1e-6) {
    const segEnd = Math.min(turns, Math.floor(t) + 1);
    const rev = Math.min(a.revolutions - 1, Math.floor(t + 1e-6));
    if (blade.rev !== rev) {
      blade.rev = rev;
      blade.hit = new Set();
    }
    const prevAng = blade.origin - t * Math.PI * 2;
    sweepBlade(sim, owner, x, z, prevAng, (segEnd - t) * Math.PI * 2, blade.hit);
    t = segEnd;
  }
  blade.turns = turns;
  blade.angle = blade.origin - turns * Math.PI * 2;
  return sim.time < blade.until;
}

function dropStrike(sim, owner, x, z, echo) {
  const a = HEROES.shock.abilities.q;
  sim.addZone({
    kind: 'strike', owner: owner.id, x, z, r: a.radius, echo: !!echo,
    until: sim.time + a.delay,
    onExpire(sim, zone) {
      const src = sim.players[zone.owner];
      if (!src?.alive) return;
      let hit = false;
      for (const e of sim.enemiesInRadius(zone.x, zone.z, zone.r, src)) {
        sim.damage(e, a.damage, src, { kind: 'shock' });
        sim.addEffect(e, 'stun', a.stun);
        sim.emit({ e: 'text', x: e.x, z: e.z, text: 'STUN', color: '#ffe56a' });
        hit = true;
      }
      harmRadius(sim, zone.x, zone.z, zone.r, a.damage, src);
      const patrol = sim.patrolInRadius(zone.x, zone.z, zone.r);
      if (patrol) {
        sim.addEffect(patrol, 'stun', a.stun);
        hit = true;
      }
      if (hit && !zone.echo) {
        const charge = shockCharge(src);
        if (!charge.spin) {
          charge.spin = true;
          syncShockFlags(sim, src);
          sim.emit({ e: 'text', x: src.x, z: src.z, text: 'CYCLONE', color: '#ffe56a' });
        }
      }
      sim.emit({ e: 'explode', x: zone.x, z: zone.z, r: zone.r, color: '#fff1a8' });
    },
  });
}

function applyWind(sim, owner, x, z, facing, hits, echo) {
  const a = HEROES.shock.abilities.w;
  const box = shockLine(x, z, facing, 1.55, a.width);
  let struck = false;
  for (const t of sim.enemiesInSquare(box.x, box.z, box.facing, box.halfF, box.halfS, owner)) {
    if (hits.has(t.id)) continue;
    hits.add(t.id);
    sim.damage(t, a.damage, owner);
    spinFacing(t);
    sim.emit({ e: 'text', x: t.x, z: t.z, text: 'SPIN', color: '#d7f6ff' });
    struck = true;
  }
  for (const o of sim.objectsInSquare(box.x, box.z, box.facing, box.halfF, box.halfS)) {
    if (hits.has(o.id)) continue;
    hits.add(o.id);
    sim.damageObject(o, a.damage, owner);
    if (o.patrol) struck = true;
  }
  if (struck && !echo) {
    shockCharge(owner).slow = true;
    syncShockFlags(sim, owner);
  }
  return struck;
}

function resolveShockAttack(sim, p, aim, echo, mods) {
  const atk = HEROES.shock.attack;
  const w = HEROES.shock.abilities.w;
  const e = HEROES.shock.abilities.e;
  const used = mods || { dash: false, slow: false, bolt: false };
  if (!echo) {
    p.state.charge = { dash: false, slow: false, bolt: false, spin: false };
    syncShockFlags(sim, p);
  }
  if (used.spin) {
    startBlade(sim, echo ? (sim.players[p.id] || p) : p, !!echo);
    if (!echo) {
      p.cd.attack = atk.cooldown;
      noteEcho(sim, p, { kind: 'attack', x: p.x, z: p.z, f: p.facing, ax: aim[0], az: aim[1], charge: used });
    }
    return;
  }
  const [dx, dz] = sim.dirTo(p, aim);
  p.facing = Math.atan2(dz, dx);
  const reach = used.dash ? atk.range * e.rangeScale : atk.range;
  const dmg = atk.damage + (used.bolt ? e.bonus : 0);
  const originX = p.x, originZ = p.z;
  const self = sim.players[p.id] || p;
  let heroHit = false;
  if (used.dash) {
    const room = openDistance(sim, originX, originZ, dx, dz, reach);
    const travel = Math.max(0, room - 0.45);
    const box = shockLine(originX, originZ, p.facing, Math.max(atk.range, room), atk.lineWidth);
    for (const t of sim.enemiesInSquare(box.x, box.z, box.facing, box.halfF, box.halfS, self)) {
      if (sim.tryDodge(t)) continue;
      sim.damage(t, dmg, self, { basic: true, kind: used.bolt ? 'shock' : 'hit' });
      if (used.slow) addSlow(sim, t, w.slow, w.slowTime, 'gale');
      heroHit = true;
    }
    for (const o of sim.objectsInSquare(box.x, box.z, box.facing, box.halfF, box.halfS)) {
      sim.damageObject(o, dmg, self);
      if (o.patrol) {
        if (used.slow) addSlow(sim, o, w.slow, w.slowTime, 'gale');
        heroHit = true;
      }
    }
    if (!echo && travel > 0.12) sim.startDash(p, dx, dz, travel, atk.slashSpeed, 'slash', { pass: true });
    const arc = Math.max(0.12, Math.atan2(atk.lineWidth, Math.max(atk.range, room)));
    sim.emit({ e: 'swing', pid: p.id, x: originX, z: originZ, f: p.facing, range: Math.max(atk.range, room), angle: arc, color: used.bolt ? '#fff1a8' : '#ffe56a', big: true });
  } else {
    for (const t of sim.enemiesInCone(p, dx, dz, reach, atk.halfAngle)) {
      if (sim.tryDodge(t)) continue;
      sim.damage(t, dmg, self, { basic: true, kind: used.bolt ? 'shock' : 'hit' });
      if (used.slow) addSlow(sim, t, w.slow, w.slowTime, 'gale');
      heroHit = true;
    }
    harmCone(sim, p, dx, dz, reach, atk.halfAngle, dmg, self);
    const patrol = sim.patrolInCone(p, dx, dz, reach, atk.halfAngle);
    if (patrol) {
      if (used.slow) addSlow(sim, patrol, w.slow, w.slowTime, 'gale');
      heroHit = true;
    }
    sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range: reach, angle: atk.halfAngle, color: used.bolt ? '#fff1a8' : '#f4f7ff', big: !!used.bolt });
  }
  if (heroHit && used.slow && !echo) p.cd.w = Math.max(0, p.cd.w - w.refund);
  if (!echo) {
    p.cd.attack = atk.cooldown;
    noteEcho(sim, p, { kind: 'attack', x: originX, z: originZ, f: p.facing, ax: aim[0], az: aim[1], charge: used });
  }
}

function echoActor(owner, action) {
  return {
    id: owner.id,
    x: action.x,
    z: action.z,
    facing: action.f ?? owner.facing,
    alive: true,
    effects: [],
    echo: true,
    state: {},
    cd: {},
    hero: 'shock',
  };
}

function replayEcho(sim, owner, action) {
  if (!owner?.alive) return;
  if (action.kind === 'attack') {
    const actor = echoActor(owner, action);
    resolveShockAttack(sim, actor, [action.ax, action.az], true, action.charge || {});
    return;
  }
  if (action.kind === 'q') {
    dropStrike(sim, owner, action.x, action.z, true);
    return;
  }
  if (action.kind === 'e') {
    const a = HEROES.shock.abilities.e;
    luminairePulse(sim, owner, action.x, action.z, a.startRadius, true);
    sim.addZone({
      kind: 'luminaire', owner: owner.id, x: action.x, z: action.z, r: a.startRadius,
      until: sim.time + a.duration, echo: true,
      onTick(sim, zone) {
        const u = 1 - Math.max(0, (zone.until - sim.time) / a.duration);
        zone.r = a.startRadius + (a.endRadius - a.startRadius) * Math.min(1, Math.max(0, u));
      },
      onExpire(sim, zone) {
        const src = sim.players[zone.owner];
        if (!src?.alive) return;
        luminairePulse(sim, src, zone.x, zone.z, a.endRadius, true);
      },
    });
  }
}

function sampleAt(tempest, when) {
  let best = null;
  for (const s of tempest.samples) {
    if (s.t <= when) best = s;
    else break;
  }
  return best;
}

function clearTempest(sim, p) {
  const tempest = p?.state?.tempest;
  if (!tempest) return;
  if (tempest.zone) tempest.zone.dead = true;
  p.state.tempest = null;
  syncShockFlags(sim, p);
}

function tickTempest(sim, p) {
  const tempest = p.state.tempest;
  if (!tempest) return;
  if (!p.alive) { clearTempest(sim, p); return; }
  const a = HEROES.shock.abilities.r;
  if (sim.time <= tempest.until + a.delay) {
    tempest.samples.push({
      t: sim.time, x: p.x, z: p.z, f: p.facing,
      dash: p.dash?.kind || null,
      storm: sim.hasEffect(p, 'storm'),
      lift: p.flags.lift || 0,
    });
    const cutoff = sim.time - a.delay - 0.2;
    while (tempest.samples.length && tempest.samples[0].t < cutoff) tempest.samples.shift();
  }
  const past = sampleAt(tempest, sim.time - a.delay);
  if (tempest.zone && past) {
    tempest.zone.x = past.x;
    tempest.zone.z = past.z;
    tempest.zone.f = past.f;
    tempest.zone.storm = !!past.storm;
    tempest.zone.lift = past.storm ? (past.lift || 0) : undefined;
    if (tempest.blade && !tickBlade(sim, p, tempest.blade, tempest.zone.x, tempest.zone.z)) tempest.blade = null;
    tempest.zone.blade = tempest.blade && sim.time < tempest.blade.until ? tempest.blade.angle : undefined;
    if (past.dash === 'wind') {
      if (!tempest.windHits) tempest.windHits = new Set();
      applyWind(sim, p, past.x, past.z, past.f, tempest.windHits, true);
    } else tempest.windHits = null;
  }
  while (tempest.cursor < tempest.actions.length && tempest.actions[tempest.cursor].t + a.delay <= sim.time) {
    replayEcho(sim, p, tempest.actions[tempest.cursor]);
    tempest.cursor += 1;
  }
  if (sim.time > tempest.until + a.delay) clearTempest(sim, p);
}

const shock = {
  attack(sim, p, aim) {
    const charge = shockCharge(p);
    const mods = { dash: !!charge.dash, slow: !!charge.slow, bolt: !!charge.bolt, spin: !!charge.spin };
    resolveShockAttack(sim, p, aim, false, mods);
  },

  onTick(sim, p) {
    if (p.state.blade && !tickBlade(sim, p, p.state.blade, p.x, p.z)) p.state.blade = null;
    syncShockFlags(sim, p);
    tickTempest(sim, p);
  },

  q(sim, p, aim) {
    const a = HEROES.shock.abilities.q;
    const spot = clampToRange(p, aim, a.castRange);
    const [dx, dz] = sim.dirTo(p, spot);
    p.facing = Math.atan2(dz, dx);
    dropStrike(sim, p, spot[0], spot[1], false);
    noteEcho(sim, p, { kind: 'q', x: spot[0], z: spot[1] });
    return true;
  },

  w(sim, p, aim) {
    const a = HEROES.shock.abilities.w;
    const [dx, dz] = sim.dirTo(p, aim);
    const hits = new Set();
    sim.startDash(p, dx, dz, a.distance, a.speed, 'wind', {
      pass: true,
      onTick(sim, mover) { applyWind(sim, mover, mover.x, mover.z, mover.facing, hits, false); },
    });
    const arc = Math.max(0.14, Math.atan2(a.width, a.distance));
    sim.emit({ e: 'swing', pid: p.id, x: p.x, z: p.z, f: p.facing, range: a.distance, angle: arc, color: '#d7f6ff', big: true });
    sim.emit({ e: 'text', x: p.x, z: p.z, text: 'WIND', color: '#d7f6ff' });
    return true;
  },

  e(sim, p) {
    const a = HEROES.shock.abilities.e;
    luminairePulse(sim, p, p.x, p.z, a.startRadius, false);
    sim.addEffect(p, 'storm', a.duration);
    p.pendingAttack = null;
    p.attackBuffer = null;
    p.kx = 0;
    p.kz = 0;
    shockCharge(p).bolt = true;
    syncShockFlags(sim, p);
    sim.addZone({
      kind: 'luminaire', owner: p.id, x: p.x, z: p.z, r: a.startRadius,
      until: sim.time + a.duration,
      onTick(sim, zone) {
        const owner = sim.players[zone.owner];
        if (!owner?.alive) { zone.dead = true; return; }
        zone.x = owner.x;
        zone.z = owner.z;
        const u = 1 - Math.max(0, (zone.until - sim.time) / a.duration);
        zone.r = a.startRadius + (a.endRadius - a.startRadius) * Math.min(1, Math.max(0, u));
      },
      onExpire(sim, zone) {
        const owner = sim.players[zone.owner];
        if (!owner?.alive) return;
        luminairePulse(sim, owner, owner.x, owner.z, a.endRadius, false);
      },
    });
    noteEcho(sim, p, { kind: 'e', x: p.x, z: p.z });
    sim.emit({ e: 'text', x: p.x, z: p.z, text: 'LUMINAIRE', color: '#ffe56a' });
    return true;
  },

  r(sim, p) {
    const a = HEROES.shock.abilities.r;
    clearTempest(sim, p);
    const zone = sim.addZone({
      kind: 'echo', owner: p.id, x: p.x, z: p.z, f: p.facing, r: 0.8,
      until: sim.time + a.duration + a.delay,
    });
    p.state.tempest = {
      until: sim.time + a.duration,
      samples: [{ t: sim.time, x: p.x, z: p.z, f: p.facing, dash: null, storm: false }],
      actions: [],
      cursor: 0,
      windHits: null,
      zone,
    };
    syncShockFlags(sim, p);
    sim.emit({ e: 'ult', pid: p.id, x: p.x, z: p.z, hero: 'shock' });
    return true;
  },
};

export const HERO_IMPL = { minotaur, groundskeeper, tidebinder, fuck, python, monk, illusionist, stone, shock };
