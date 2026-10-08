// Hero roster shared between server (simulation) and client (UI text, colors).
// Numbers here are the single source of truth for tuning.

export const ARENA = {
  radius: 17,          // playable island radius
  wallRadius: 17.6,    // hard boundary
  shrinkStart: 45,     // seconds into the round when lava starts closing in
  shrinkDuration: 60,  // seconds to shrink from full radius to minRadius
  minRadius: 4.5,
  lavaDps: 2,          // damage per second while standing in lava
  roundTimeLimit: 120, // hard cap: higher HP wins
  roundsToWin: 4,      // best of 7
  playerRadius: 0.55,
  healthPackHeal: 3,
  healthPackInterval: 12,
  healthPackMax: 2,
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
    speed: 6.0,
    attack: {
      name: 'Axe Swing',
      desc: 'Fast melee cleave in a short arc for 1 damage.',
      cooldown: 0.5,
      damage: 1,
      range: 2.3,
      halfAngle: 0.95,
    },
    abilities: {
      q: {
        name: 'Cleave',
        cooldown: 7,
        desc: 'Swing the great-axe in a cone, dealing 2 damage, knocking back and slowing by 50% for 2s.',
        fire: 'Fire mode: swings twice as fast and ignites targets for 1 damage/sec over 2s.',
      },
      w: {
        name: 'Charge',
        cooldown: 10,
        desc: 'Charge in the target direction, shoving anyone in the path. Lowers Cleave cooldown by 3s.',
        fire: 'Fire mode: twice as far, twice as fast, and leaves a burning trail (1 dmg/sec, 3s).',
      },
      e: {
        name: 'Rage of the Minotaur',
        cooldown: 12,
        desc: 'Roar for 0.5s: gain 3 shields for 5s, purge debuffs, and your next attack deals +2 damage.',
        fire: 'Fire mode: explode instead of shielding, dealing 2 damage to everyone nearby (you included). Next attack deals +4.',
      },
      r: {
        name: 'Fiery Heart',
        cooldown: 45,
        desc: 'Reset Charge and enter fire mode for 11s, empowering every basic ability.',
      },
    },
  },

  groundskeeper: {
    id: 'groundskeeper',
    name: 'Groundskeeper',
    title: 'Crafty ranger with a short-ranged crossbow',
    color: 0x4f7a3a,
    accent: 0xd9c38a,
    hp: 12,
    speed: 5.5,
    attack: {
      name: 'Crossbow Bolt',
      desc: 'Short-ranged bolt for 1 damage.',
      cooldown: 0.75,
      damage: 1,
      range: 7,
      speed: 17,
    },
    abilities: {
      q: {
        name: 'Tethered Bolt',
        cooldown: 9,
        desc: 'Fire a roped bolt that deals 2 damage and knocks back. For 3s, press again to pull the target toward you. On a miss the rope anchors to the ground and pressing again pulls you to it.',
      },
      w: {
        name: 'Roll',
        cooldown: 8,
        desc: 'Roll in the target direction. Your next attack deals +1 damage and knocks back.',
      },
      e: {
        name: 'Bear Trap',
        cooldown: 12,
        desc: 'Drop a trap in front of you. Arms after 1s. Victims are rooted for 2s and take double damage from the next hit.',
      },
      r: {
        name: 'Cut Throat',
        cooldown: 25,
        desc: 'Wind up for 0.5s, then slash with a knife for 4 damage, slowing by 50% for 3s.',
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
    speed: 5.1,
    attack: {
      name: 'Brine Bolt',
      desc: 'Medium-ranged bolt of water for 1 damage.',
      cooldown: 0.85,
      damage: 1,
      range: 8,
      speed: 15,
    },
    abilities: {
      q: {
        name: 'Riptide',
        cooldown: 7,
        desc: 'Send a wide wave that passes through enemies, dealing 2 damage, carrying them along its path and leaving them Soaked for 4s.',
      },
      w: {
        name: 'Undertow',
        cooldown: 10,
        desc: 'After 0.5s a whirlpool erupts at the target point, dragging enemies toward its center and slowing them by 40% for 1.5s. Soaked enemies are wrung out for 2 bonus damage.',
      },
      e: {
        name: 'Tidal Shell',
        cooldown: 12,
        desc: 'Encase yourself in a bubble granting 3 shields for 2.5s. Press again or let it expire to burst it, dealing 1 damage and knocking back nearby enemies.',
      },
      r: {
        name: 'Tsunami',
        cooldown: 40,
        desc: 'Wind up for 0.8s, then unleash a towering wave across the arena that deals 4 damage and carries enemies with it. Soaked enemies are also stunned for 1s.',
      },
    },
  },
};

export const HERO_IDS = Object.keys(HEROES);
