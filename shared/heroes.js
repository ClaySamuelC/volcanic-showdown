// Hero roster. This file is the only place ability numbers live.
//
// To change a cooldown, damage, range, cone width, dash distance, or duration, edit the
// matching field below. game/heroes.js reads these fields; it does not hardcode them.
// `cooldown` is also what the lobby tooltip and the in-game cooldown sweep display.
// In `desc`, `fire`, and `detail`, write `{field}` to insert that ability's number, or `{field%}`
// for a 0–1 fraction shown as a percent. The tooltip fills these in, so the field is the only copy.
// `detail` is extra text shown only while Alt is held.
//
// Cone width is `halfAngle` in radians (the swing covers halfAngle to either side of
// where you aim). 0.78 is about a 90° cone.
//
// Cast times (seconds of windup before the ability fires). 0, or a missing key, means
// it fires immediately. `attack` is the basic attack. `qFire` is Minotaur's Cleave
// during Fiery Heart. Stone's Kick hold length is `channel` on that ability, not here.
export const CAST_TIMES = {
  minotaur: { attack: 0.14, q: 0.18, qFire: 0.09, e: 0.5 },
  groundskeeper: { attack: 0.12, r: 0.5 },
  tidebinder: { attack: 0.12, r: 0.8 },
  fuck: { attack: 0.1 },
  python: { attack: 0.1, w: 0.5 },
  monk: { attack: 0.12 },
  illusionist: { attack: 0.1 },
  stone: { attack: 0.12 },
  shock: { attack: 0.1 },
};

// Which ability sits on Q, W, E, and R. Each letter is the ability id in `abilities`
// below. Rearrange the four letters to move an ability to a different key.
// Groundskeeper lists Roll on Q and Tethered Bolt on W.
export const ABILITY_ORDER = {
  minotaur: ['q', 'w', 'e', 'r'],
  groundskeeper: ['w', 'q', 'e', 'r'],
  tidebinder: ['q', 'w', 'e', 'r'],
  fuck: ['q', 'w', 'e', 'r'],
  python: ['q', 'w', 'e', 'r'],
  monk: ['q', 'w', 'e', 'r'],
  illusionist: ['q', 'w', 'e', 'r'],
  stone: ['q', 'w', 'e', 'r'],
  shock: ['q', 'w', 'e', 'r'],
};

const ABILITY_KEYS = ['q', 'w', 'e', 'r'];

export function abilityOrder(heroId) {
  return ABILITY_ORDER[heroId] || ABILITY_KEYS;
}

export function abilityOnKey(heroId, key) {
  const idx = ABILITY_KEYS.indexOf(key);
  if (idx < 0) return key;
  return abilityOrder(heroId)[idx] || key;
}

// Fill `{field}` and `{field%}` in ability text from that ability's own numbers.
export function abilityText(ability, text) {
  if (!text || !ability) return text || '';
  return String(text).replace(/\{([A-Za-z0-9_]+)(%?)}/g, (full, key, pct) => {
    const v = ability[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return full;
    if (pct) return String(Math.round(v * 1000) / 10);
    return String(Math.round(v * 1000) / 1000);
  });
}

export const ARENA = {
  radius: 22.1,        // stone island; lava starts outside this
  wallRadius: 34,      // hard boundary. The ring outside `radius` is walkable lava.
  shrinkStart: 45,     // seconds into the round when lava starts closing in
  shrinkDuration: 30,  // seconds to shrink from full radius to minRadius
  minRadius: 5.85,
  lavaDps: 2,          // damage per second while standing in lava
  roundTimeLimit: 120, // hard cap: higher HP wins
  roundsToWin: 3,
  playerRadius: 0.55,
  projectilePadding: 0.45, // extra hit radius on thin ranged shots
  dummyLeash: 6,           // unused; the dummy stays where forced movement puts it until Reset
  healthPackHeal: 4,
  healthPackInterval: 20,
  healthPackHp: 5,
  healthPackRadius: 0.96, // was 1.6; hit box reduced by 40%
  centerClear: 3.2,        // new rocks cannot appear inside this radius; rocks already there stay
  kegInterval: 20,
  kegCount: 2,
  kegHp: 2,
  kegRadius: 0.55,
  kegFuse: 0.5,
  kegDamage: 2,
  kegBlast: 2.4,
  propHp: 5,
  propReset: 120,          // broken and damaged obstacles return to full health
  countdown: 3,
  roundEndDelay: 3.5,
};

export const HEROES = {
  minotaur: {
    id: 'minotaur',
    name: 'Minotaur',
    title: 'Fire-forged brute with a great-axe',
    color: 0xb3402a,
    accent: 0xffa030,
    hp: 12,
    speed: 7.0,
    turnRate: 1.17, // deg/sec = turnRate * 900. About 180° in 0.17s.
    attack: {
      name: 'Axe Swing',
      desc: 'Fast melee cleave in a short arc for {damage} damage.',
      cooldown: 0.7,
      damage: 1,
      range: 3.2,
      halfAngle: 0.78, // cone half-width; was 0.95
      fireCooldownScale: 0.75,
    },
    abilities: {
      q: {
        name: 'Cleave',
        cooldown: 5,
        desc: 'Swing the great-axe in a cone, dealing {damage} damage, knocking back and slowing by {slow%} for {slowTime}s.',
        fire: 'Fire mode: swings twice as fast and ignites targets for {burnDps} damage/sec over {burnTime}s.',
        range: 4.5,
        halfAngle: 0.88,
        damage: 2,
        knockback: 1.5,
        slow: 0.5,
        slowTime: 2,
        burnTime: 2,
        burnDps: 1,
      },
      w: {
        name: 'Charge',
        cooldown: 8,
        desc: 'Charge in the target direction. Anyone caught within {shoveRadius} is dragged along, finishes in front of you, and is knocked into the air for a {stunTime}s mini-stun. Obstacles in the way are destroyed. Lowers Cleave cooldown by {cleaveRefund}s.',
        fire: 'Fire mode: distance {fireDistance} at speed {fireSpeed}, and leaves a burning trail ({fireDps} dmg/sec, {fireTime}s).',
        distance: 10,
        fireDistance: 15,
        speed: 17,
        fireSpeed: 34,
        cleaveRefund: 3,
        shoveRadius: 2.6,
        fireSpacing: 0.9,
        fireRadius: 0.95,
        fireTime: 3,
        fireDps: 1,
        stunTime: 0.15,
      },
      e: {
        name: 'Rage of the Minotaur',
        cooldown: 10,
        desc: 'Roar for {windup}s: gain {shield} shields for {shieldTime}s, and your next attack deals +{empower} damage.',
        fire: 'Fire mode: explode instead of shielding, dealing {fireDamage} damage nearby. You take {fireSelfDamage}, and it cannot kill you. Next attack deals +{fireEmpower}.',
        shield: 3,
        shieldTime: 5,
        empower: 2,
        empowerTime: 5,
        fireRadius: 3,
        fireDamage: 2,
        fireSelfDamage: 1,
        fireEmpower: 4,
      },
      r: {
        name: 'Fiery Heart',
        cooldown: 42,
        desc: 'Purge debuffs, reset Charge, and enter fire mode for {duration}s, empowering every basic ability.',
        duration: 20,
      },
    },
  },

  groundskeeper: {
    id: 'groundskeeper',
    name: 'Groundskeeper',
    title: 'Crafty ranger with a short-ranged crossbow',
    color: 0x4f7a3a,
    accent: 0xd9c38a,
    hp: 11,
    speed: 7.5,
    turnRate: 1.3, // agile. About 180° in 0.15s.
    attack: {
      name: 'Crossbow Bolt',
      desc: 'Short-ranged bolt for {damage} damage.',
      cooldown: 0.75,
      damage: 1,
      range: 7,
      speed: 17,
      radius: 0.25,
      empowerKnockback: 2.5,
    },
    abilities: {
      q: {
        name: 'Tethered Bolt',
        cooldown: 7,
        desc: 'Fire a roped bolt that deals {damage} damage and knocks back. For {tetherTime}s, press again to pull. On a hero or the training dummy, the rope latches on. On a miss, or when it hits a rock, the rope anchors there and pressing again pulls you to it.',
        detail: 'The pull travels {pullPortion%} of the distance between you and the rope, or {selfPullDistance}, whichever is farther. A latched target is pulled toward you and stops in front of you. Pulling yourself can carry you past the anchor.',
        speed: 20,
        range: 9,
        radius: 0.3,
        damage: 2,
        knockback: 2.5,
        tetherTime: 3.5,
        selfPullDistance: 7,
        pullPortion: 0.75,
        pullSpeed: 24,
      },
      w: {
        name: 'Roll',
        cooldown: 3,
        desc: 'Roll in the target direction. Your next attack deals +{empower} damage and knocks back.',
        distance: 6.0,
        speed: 18,
        empower: 1,
        empowerTime: 4,
      },
      e: {
        name: 'Bear Trap',
        cooldown: 10,
        desc: 'Place a trap within {range}. It deals {damage} damage, arms after {armTime}s, and lasts {duration}s. Victims are rooted for {rootTime}s and take double damage from the next hit.',
        armTime: 1,
        duration: 30,
        radius: 0.75,
        range: 4.5,
        damage: 1,
        rootTime: 2,
        vulnerableTime: 10,
      },
      r: {
        name: 'Cut Throat',
        cooldown: 25,
        desc: 'Wind up for {windup}s, then slash with a knife for {damage} damage, slowing by {slow%} for {slowTime}s.',
        range: 3.5,
        halfAngle: 0.68,
        damage: 4,
        slow: 0.5,
        slowTime: 3,
      },
    },
  },

  tidebinder: {
    id: 'tidebinder',
    name: 'Tidebinder',
    title: 'Sea-witch who bends the tide itself',
    color: 0x2a6fb3,
    accent: 0x8fe3ff,
    hp: 12,
    speed: 7,
    turnRate: 1.17, // about 180° in 0.17s.
    attack: {
      name: 'Brine Bolt',
      desc: 'Medium-ranged bolt of water for {damage} damage.',
      cooldown: 0.85,
      damage: 1,
      range: 8,
      speed: 15,
      radius: 0.28,
    },
    abilities: {
      q: {
        name: 'Riptide',
        cooldown: 5,
        desc: 'Send a wide wave that passes through enemies, dealing {damage} damage, carrying them along its path and leaving them Soaked for {soakedTime}s.',
        speed: 12,
        range: 8,
        radius: 1.3,
        damage: 2,
        knockback: 3,
        soakedTime: 4,
      },
      w: {
        name: 'Undertow',
        cooldown: 8,
        desc: 'After {delay}s a whirlpool erupts at the target point, dragging enemies toward its center and slowing them by {slow%} for {slowTime}s. Soaked enemies are wrung out for {soakedDamage} bonus damage.',
        castRange: 8,
        delay: 0.5,
        duration: 3,
        radius: 2.4,
        pullSpeed: 4.5,
        slow: 0.4,
        slowTime: 1.5,
        soakedDamage: 2,
      },
      e: {
        name: 'Tidal Shell',
        cooldown: 8,
        desc: 'Encase yourself in a bubble granting {shield} shields for {duration}s. Press again or let it expire to burst it, dealing {burstDamage} damage and knocking back nearby enemies.',
        shield: 3,
        duration: 2.5,
        burstRadius: 2.5,
        burstDamage: 1,
        burstKnockback: 3,
      },
      r: {
        name: 'Tsunami',
        cooldown: 40,
        desc: 'Wind up for {windup}s, then unleash a towering wave across the arena that deals {damage} damage and carries enemies with it. Soaked enemies are also stunned for {stunTime}s.',
        speed: 10,
        range: 18,
        radius: 3,
        damage: 4,
        stunTime: 1,
      },
    },
  },

  fuck: {
    id: 'fuck',
    name: 'Fuck',
    title: 'Dragon faerie who slips between rifts',
    color: 0x6b3fa0,
    accent: 0xe7b4ff,
    hp: 11,
    speed: 7.4,
    turnRate: 1.25,
    attack: {
      name: 'Dream Orb',
      desc: 'Sends an orb out for {damage} damage.',
      cooldown: 0.7,
      damage: 1,
      range: 9,
      speed: 16,
      radius: 0.3,
    },
    abilities: {
      q: {
        name: 'Fillusory Forbes',
        cooldown: 7,
        desc: 'Shoot a long-range flying orb that passes through heroes, props, and powder kegs for {damage} damage. Press again while it is in the air to teleport to it.',
        speed: 15,
        range: 24,
        radius: 0.45,
        damage: 2,
      },
      w: {
        name: 'Feigning riFt',
        cooldown: 7,
        desc: 'Burst, knocking nearby enemies back and silencing them for {silence}s, dealing {damage} damage. You also blink {blink} units toward where you aimed.',
        radius: 4,
        blink: 3,
        damage: 2,
        knockback: 2.6,
        silence: 2.5,
      },
      e: {
        name: 'Fase shiFt',
        cooldown: 5,
        desc: 'Phase out for up to {duration} seconds. You vanish, leaving a wisp, and cannot be hit. Issuing a move command cancels it.',
        duration: 2,
      },
      r: {
        name: 'Dream Foil',
        cooldown: 40,
        desc: 'Create a leash at the target area. It latches onto a nearby enemy for {damage} damage and a {miniStun}s mini-stun. Leaving the leash deals {breakDamage} more damage and stuns for {breakStun}s. The leash lasts {duration} seconds.',
        castRange: 9,
        grab: 2.4,
        radius: 3.6,
        duration: 5,
        damage: 2,
        miniStun: 0.15,
        breakDamage: 2,
        breakStun: 1.5,
      },
    },
  },

  python: {
    id: 'python',
    name: 'Python',
    title: 'Venomous constrictor with a crushing tail',
    color: 0x2f7a3a,
    accent: 0xc6f25a,
    hp: 12,
    speed: 7.2,
    turnRate: 1.05,
    attack: {
      name: 'Poison Dart',
      desc: 'Shoots a poison dart for {damage} damage.',
      cooldown: 0.75,
      damage: 1,
      range: 8,
      speed: 18,
      radius: 0.16,
    },
    abilities: {
      q: {
        name: 'Venomous Bite',
        cooldown: 7,
        desc: 'Python leaps toward the target area, passing over obstacles. Landing on an enemy injects venom, deals {damage} damage and applies a decaying slow that starts at {slowFrom%} and fades to {slowTo%} over {slowTime} seconds.',
        distance: 7.5,
        speed: 22,
        radius: 1.8,
        damage: 2,
        slowFrom: 0.7,
        slowTo: 0.3,
        slowTime: 3,
      },
      w: {
        name: 'Whip',
        cooldown: 5,
        desc: 'After a {windup}s delay, Python knocks units in front of him back, dealing {damage} damage. He then gains {haste%} move speed and {turn%} turn rate for {hasteTime} second. The speed boost fades to {hasteTo%} over that time.',
        behind: 1,
        length: 7.6,
        width: 3.8,
        damage: 1,
        knockback: 3.2,
        haste: 1,
        hasteTo: 0.6,
        turn: 1,
        hasteTime: 1,
      },
      e: {
        name: 'Poison Darts',
        cooldown: 4,
        passive: true,
        desc: 'Passive. Every {cooldown} seconds, your next basic attack applies {duration} seconds of poison. Venomous Bite and Whip each add an additional {extend} seconds to poison duration (max {stacks} ticks). Poison deals {damage} damage every {interval} seconds.',
        duration: 4,
        interval: 2,
        damage: 1,
        extend: 2,
        stacks: 3,
      },
      r: {
        name: 'Constricting Cloud',
        cooldown: 35,
        desc: 'Cover the target area in a large cloud for {duration}s. Enemies inside are silenced and slowed by {slow%}. Poison duration on units inside does not decrease.',
        castRange: 9,
        radius: 5.5,
        duration: 4,
        slow: 0.3,
      },
    },
  },

  monk: {
    id: 'monk',
    name: 'Monk',
    title: 'Ascetic who fights with a bo staff',
    color: 0xd4893a,
    accent: 0xf3e2a0,
    hp: 11,
    speed: 7.4,
    turnRate: 1.32,
    attack: {
      name: 'Bo Staff',
      desc: 'Mid-range staff combo. A short sweep all around him, then a double strike for {doubleDamage} damage, then a longer line strike that knocks back slightly.',
      cooldown: 0.7,
      damage: 1,
      sweepRange: 2.3,
      doubleRange: 3.6,
      doubleHalfAngle: 0.48,
      doubleDamage: 2,
      lineRange: 5.5,
      lineWidth: 1.5,
      knockback: 1.15,
    },
    abilities: {
      q: {
        name: 'Leg Sweep',
        cooldown: 5,
        desc: 'Sweep the staff in front of him, knocking enemies prone for {rootTime}s. Prone heroes cannot move, attack, or cast. Deals {damage} damage.',
        range: 3.5,
        halfAngle: 1.02,
        damage: 1,
        knockback: 0.85,
        rootTime: 1,
      },
      w: {
        name: 'Pole Jump',
        cooldown: 6,
        desc: 'Jump to the target area and sit on his pole, immune from harm for up to {perchTime}s. Cast again to jump and strike, dealing {damage} damage and slowing by {slow%} for {slowTime}s.',
        castRange: 8,
        speed: 22,
        perchTime: 2,
        strikeRadius: 2.15,
        damage: 2,
        slow: 0.4,
        slowTime: 2,
      },
      e: {
        name: 'Step Aside',
        cooldown: 7,
        desc: 'For {duration}s, dodge the next projectile or attack, melee or ranged. A successful dodge heals {heal} HP.',
        duration: 2,
        heal: 2,
      },
      r: {
        name: 'Still Mind',
        cooldown: 40,
        desc: 'Become immune to spells and gain {attackSpeed%} attack speed for {duration}s. Refreshes the cooldown on his other abilities.',
        duration: 3,
        attackSpeed: 1,
      },
    },
  },

  illusionist: {
    id: 'illusionist',
    name: 'The Illusionist',
    title: 'A master magician',
    color: 0x1a1c24,
    accent: 0xb45cff,
    hp: 11,
    speed: 7.3,
    turnRate: 1.2,
    attack: {
      name: 'Wand Spark',
      desc: 'A quick spark from the wand for {damage} damage.',
      cooldown: 0.75,
      damage: 1,
      range: 7.5,
      speed: 18,
      radius: 0.22,
    },
    abilities: {
      q: {
        name: 'Bolt',
        cooldown: 4.5,
        desc: 'Shoot a long-ranged slow bolt toward the cursor for {damage} damage. Past {minRange} units it deals +{bonus} damage. Slows by {slow%} for {slowTime}s. Press again once to multiply its speed by {speedBoost} and steer it toward the cursor.',
        speed: 6.5,
        range: 18,
        radius: 0.34,
        damage: 2,
        bonus: 1,
        minRange: 3,
        slow: 0.3,
        slowTime: 2,
        speedBoost: 2,
      },
      w: {
        name: 'Ghost',
        cooldown: 11,
        desc: 'Drop a ghost at the target area for {duration}s. It copies your attacks and Bolts toward the cursor. Press again to swap places with it, up to {swaps} times.',
        castRange: 9,
        duration: 7,
        swaps: 2,
      },
      e: {
        name: 'Rabbit in a Hat',
        cooldown: 7,
        desc: 'Mark a circle. After {delay}s, anyone inside becomes a rabbit for {duration}s. Rabbits cannot attack or cast, and they are slowed by {slow%}.',
        castRange: 9,
        delay: 0.8,
        radius: 2.8,
        duration: 2.5,
        slow: 0.62,
      },
      r: {
        name: 'Optical Illusion',
        cooldown: 36,
        desc: 'Summon a disco ball for {duration}s. It deals {damage} damage every {interval}s to nearby enemies. When it ends, everyone in the arena is rooted for {root}s.',
        duration: 4,
        radius: 4.6,
        damage: 2,
        interval: 1,
        root: 2,
      },
    },
  },

  stone: {
    id: 'stone',
    name: 'Stone',
    title: 'A rocky guy',
    color: 0xc47a45,
    accent: 0x243e86,
    hp: 13,
    speed: 6.6,
    turnRate: 1.05,
    attack: {
      name: 'Rock Punch',
      desc: 'A standard melee punch for {damage} damage.',
      cooldown: 0.7,
      damage: 1,
      range: 3,
      halfAngle: 0.8,
    },
    abilities: {
      q: {
        name: 'Kick',
        cooldown: 7,
        desc: 'Hold to lengthen the catch in front of you, up to {channel}s, then release. The kick always deals {damage} damage, slows by {slow%} for {slowTime}s, and sends the hero, projectile, powder keg, or obstacle the full distance. A kicked projectile can hit the hero who fired it.',
        channel: 0.78,
        minReach: 2.6,
        maxReach: 6.5,
        halfWidth: 1.15,
        distance: 12,
        speed: 22,
        damage: 3,
        slow: 1,
        slowTime: 1.5,
        splash: 2.1,
      },
      w: {
        name: 'Grab',
        cooldown: 0.5,
        desc: 'Pick up a nearby rock and carry it. Your next attack throws it. The click sets the direction, and dragging left or right curves the throw. The rock always travels the same distance. On hit, deals {damage} damage, stuns for {stun}s, then slows by {slow%} for {slowTime}s.',
        pickupRange: 2.4,
        range: 16,
        speed: 25,
        radius: 0.48,
        damage: 2,
        stun: 0.5,
        slow: 0.5,
        slowTime: 1,
        curveCap: 6,
      },
      e: {
        name: "Rock 'n Roll",
        cooldown: 6,
        desc: 'Roll {distance} units and leave 2 rocks just behind you, side by side, so they wall off the path you rolled.',
        distance: 4.5,
        speed: 16,
        rockHp: 4,
        rockRadius: 0.72,
      },
      r: {
        name: 'Meteor',
        cooldown: 30,
        desc: 'After {delay}s, a flaming meteor crashes in at an angle for {damage} damage and a {stun}s stun. The flame stone deals +{bonus} damage and leaves a burning trail when it is kicked or thrown. Throwing or kicking it deals {chip} damage to the stone.',
        castRange: 13,
        delay: 1,
        radius: 3.7,
        damage: 4,
        stun: 1,
        bonus: 1,
        trailDps: 1,
        trailTime: 2.4,
        stoneHp: 8,
        stoneRadius: 0.9,
        chip: 2,
        approach: 9,
        approachHeight: 7.5,
      },
    },
  },

  shock: {
    id: 'shock',
    name: 'Shock',
    title: 'A storm warrior',
    color: 0x2a62c9,
    accent: 0xf0d24a,
    hp: 12,
    speed: 7.4,
    turnRate: 1.25,
    attack: {
      name: 'Sword Slash',
      desc: 'A sword slash for {damage} damage. Each spell charges the next slash.',
      cooldown: 0.7,
      damage: 1,
      range: 3,
      halfAngle: 0.68,
      slashSpeed: 32,
      lineWidth: 1.45,
    },
    abilities: {
      q: {
        name: 'Lightning Strike',
        cooldown: 4.5,
        desc: 'Mark a small area. After {delay}s, enemies inside are stunned for {stun}s and take {damage} damage. Hitting an enemy arms Cyclone.',
        castRange: 12,
        delay: 0.4,
        radius: 1.45,
        damage: 2,
        stun: 1,
      },
      cyclone: {
        name: 'Cyclone',
        desc: 'Armed by Lightning Strike. Your next attack spins {revolutions} clockwise revolutions over {spinTime}s. Each revolution strikes everyone within {radius} for {damage} damage. You cannot attack during the spin, but you can cast spells.',
        radius: 3,
        damage: 1,
        spinTime: 0.6,
        revolutions: 2,
      },
      w: {
        name: 'Wind Strike',
        cooldown: 4,
        desc: 'Lunge in a line, dealing {damage} damage and turning targets around. Hitting an enemy arms Gale Edge.',
        distance: 5.2,
        speed: 20,
        width: 1.15,
        damage: 1,
      },
      gale: {
        name: 'Gale Edge',
        desc: 'Armed by Wind Strike. Your next attack slows by {slow%} for {slowTime}s. If that attack hits, Wind Strike\'s cooldown drops by {refund}s.',
        slow: 0.75,
        slowTime: 0.4,
        refund: 2,
      },
      e: {
        name: 'Luminaire',
        cooldown: 6,
        desc: 'Become an untargetable ball of lightning for {duration}s. The orb rises as it channels. Deal {damage} damage in a small radius, then again when the burst expands. Your next attack is armed as Storm Slash.',
        duration: 0.8,
        startRadius: 1.35,
        endRadius: 3.5,
        damage: 2,
      },
      stormSlash: {
        name: 'Storm Slash',
        desc: 'Armed by Luminaire. Your next attack deals +{bonus} damage. If it hits an enemy, that attack reaches {rangeScale} times as far and carries you to the end of the slash.',
        bonus: 1,
        rangeScale: 3,
      },
      r: {
        name: 'Tempest',
        cooldown: 35,
        desc: 'Summon a ghost clone for {duration}s. It repeats your movement, attacks, and spells {delay}s later.',
        duration: 8,
        delay: 1.5,
      },
    },
  },
};

export const HERO_IDS = Object.keys(HEROES);

for (const id of HERO_IDS) {
  const times = CAST_TIMES[id] || {};
  HEROES[id].attack.windup = times.attack ?? 0;
  for (const key of ABILITY_KEYS) {
    const ability = HEROES[id].abilities[key];
    if (times[key] != null) ability.windup = times[key];
  }
  if (times.qFire != null) HEROES[id].abilities.q.fireWindup = times.qFire;
}
