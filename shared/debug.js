// Global test knobs. Edit the numbers here, then reload the page.
// Hero ability stats stay in heroes.js. This file is only for match-wide debugging.

export const DEBUG = {
  // Every ultimate begins a round with this many seconds of cooldown,
  // instead of that hero's own ultimate cooldown. Using the ultimate afterward
  // still applies the cooldown written on the hero.
  ultimateStartCooldown: 25,

  // Music loudness from 0 to 1 when the page loads.
  musicVolume: 0.0,

  // Health of the patrolling training dummy.
  patrolHp: 8,

  // Open straight into a dummy match. The main menu stays on the left and the
  // match keeps running.
  startInDummy: true,
};
