# Volcanic Showdown

Isometric 1v1 fantasy arena built with three.js, inspired by the Dota 2 mod *Crumbling Island Arena*.
Fight a best-of-7 on a circular island surrounded by lava that closes in as each round goes on, either
against an AI opponent in your browser or against another player through a lobby with a 3-digit code.

## Play

**Practice vs AI** runs entirely in the browser (no server needed) and is hosted on GitHub Pages.
Pick your hero, the bot's hero and a difficulty, and go.

**Multiplayer** needs the Node game server from this repo running somewhere both players can reach:

```bash
npm install
npm start          # http://localhost:3000
```

Open the address in two browser windows (or on two machines). One player clicks **Create lobby** and shares
the 3-digit code; the other enters it under **Join with code**. Both pick a hero and press **Ready**.

If you open the GitHub Pages build instead, expand **Multiplayer server** on the menu and enter the
WebSocket URL of your server (for example `wss://your-host.example.com`). Pages is served over HTTPS, so the
server must be reachable over `wss://` (any host that terminates TLS in front of the Node process works).

## Controls

| Input | Action |
| --- | --- |
| Right click / arrow keys | Move |
| Mouse | Free aim |
| Left click (hold to repeat) | Basic attack toward the cursor |
| Q / W / E | Basic abilities, aimed at the cursor |
| R | Ultimate (starts each round on cooldown) |
| S | Stop moving |

## Rules

- 12 health per hero. Health packs spawn every 12s (max 2 on the field) and heal 3.
- After 45 seconds the lava begins closing in; standing in it deals 2 damage per second.
- A round ends when a hero dies, or at 2:00 when the hero with more health wins (ties replay the round).
- First to 4 round wins takes the match.

## Heroes

**Minotaur** – fire-forged brute with a great-axe. Cleave (Q), Charge (W), Rage of the Minotaur (E),
Fiery Heart (R) resets Charge and empowers all basic abilities for 11s.

**Groundskeeper** – crafty ranger with a short-ranged crossbow. Tethered Bolt (Q, recast to pull),
Roll (W), Bear Trap (E), Cut Throat (R).

**Tidebinder** – sea-witch who bends the tide. Riptide (Q) soaks and carries enemies, Undertow (W) drags
them into a whirlpool and wrings out Soaked targets, Tidal Shell (E) is a burstable shield, and Tsunami (R)
sends a towering wave across the arena that carries anything it hits and stuns Soaked enemies.

All tuning numbers live in `shared/heroes.js`; ability behaviour lives in `game/heroes.js`; the bot lives in
`game/ai.js`.

## Architecture

- `game/` – the authoritative simulation and the practice bot. Plain ES modules with no dependencies, so the
  same code runs on the server for multiplayer and in the browser for practice.
- `server/` – Express static host + `ws` WebSocket server for lobbies. Clients send movement/aim/cast intents
  at 20Hz, the server ticks at 30Hz and broadcasts snapshots at 20Hz.
- `public/` – three.js client with an orthographic isometric camera, snapshot interpolation and a DOM HUD.
  `public/js/local.js` drives the simulation locally for practice mode using the same message interface.
- `shared/` – hero data and arena constants used by everything.
- `scripts/build-pages.mjs` – assembles the static client into `dist/`; `.github/workflows/pages.yml`
  deploys it to GitHub Pages on every push to `main`.
