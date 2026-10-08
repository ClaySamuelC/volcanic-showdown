import { HEROES, HERO_IDS, ARENA } from '../shared/heroes.js';
import { DIFFICULTIES } from '../game/ai.js';
import { Net } from './net.js';
import { LocalGame } from './local.js';
import { Renderer } from './render.js';
import { Input } from './input.js';

const $ = (sel) => document.querySelector(sel);
const screens = { menu: $('#screen-menu'), practice: $('#screen-practice'), lobby: $('#screen-lobby'), end: $('#screen-end') };
const hud = $('#hud');

const mpNet = new Net();
const local = new LocalGame();
let net = mpNet; // active transport: mpNet for lobbies, local for practice
const renderer = new Renderer($('#game'));
const input = new Input($('#game'), renderer);

const state = {
  screen: 'menu',
  mode: 'multiplayer', // or 'practice'
  lobby: null,
  myHero: null,
  match: null,
  lastSnap: null,
  announceUntil: 0,
  lastPhase: null,
  lastRound: 0,
  practice: { hero: localStorage.getItem('vs-practice-hero') || null, botHero: 'random', difficulty: localStorage.getItem('vs-difficulty') || 'normal' },
};

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('hidden', k !== name);
  hud.classList.toggle('hidden', name !== 'game');
  input.enabled = name === 'game';
  state.screen = name;
}

function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
}

function announce(html, ms = 2000) {
  const el = $('#announce');
  el.innerHTML = html;
  el.classList.remove('hidden');
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  state.announceUntil = performance.now() + ms;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function playerName() { const n = $('#name').value.trim(); localStorage.setItem('vs-name', n); return n; }

// ------------------------------------------------------------------- menu
$('#name').value = localStorage.getItem('vs-name') || '';
$('#server-url').value = localStorage.getItem('vs-server') || Net.defaultUrl();
if (!Net.defaultUrl()) $('#server-details').open = true;

async function ensureConnected() {
  const url = $('#server-url').value.trim();
  localStorage.setItem('vs-server', url);
  $('#menu-error').textContent = '';
  try {
    await mpNet.connect(url);
    return true;
  } catch (e) {
    $('#menu-error').textContent = url ? `${e.message}. Is the game server running?` : 'Enter a multiplayer server URL (or use Practice vs AI).';
    $('#server-details').open = true;
    return false;
  }
}

$('#btn-create').onclick = async () => {
  const name = playerName();
  if (!(await ensureConnected())) return;
  net = mpNet; state.mode = 'multiplayer';
  net.send({ t: 'create', name });
};
$('#btn-join').onclick = async () => {
  const name = playerName();
  const code = $('#code').value.trim();
  if (!/^\d{3}$/.test(code)) { $('#menu-error').textContent = 'Enter the 3-digit lobby code.'; return; }
  if (!(await ensureConnected())) return;
  net = mpNet; state.mode = 'multiplayer';
  net.send({ t: 'join', name, code });
};
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
$('#code').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 3); });

$('#btn-practice').onclick = () => { playerName(); show('practice'); };

// --------------------------------------------------------------- practice
function buildPracticeScreen() {
  buildHeroGrid($('#practice-hero-grid'), (id) => {
    state.practice.hero = id;
    localStorage.setItem('vs-practice-hero', id);
    showHeroDetail(id, $('#practice-hero-grid'), $('#practice-hero-detail'));
    $('#btn-practice-start').disabled = false;
  });
  if (state.practice.hero && HEROES[state.practice.hero]) {
    showHeroDetail(state.practice.hero, $('#practice-hero-grid'), $('#practice-hero-detail'));
    $('#btn-practice-start').disabled = false;
  }
  const botRow = $('#bot-hero');
  const opts = [['random', 'Random'], ...HERO_IDS.map((id) => [id, HEROES[id].name])];
  for (const [id, label] of opts) {
    const c = document.createElement('button');
    c.className = 'chip' + (state.practice.botHero === id ? ' selected' : '');
    c.textContent = label;
    c.onclick = () => { state.practice.botHero = id; botRow.querySelectorAll('.chip').forEach((x) => x.classList.toggle('selected', x === c)); };
    botRow.appendChild(c);
  }
  const diffRow = $('#bot-difficulty');
  for (const d of DIFFICULTIES) {
    const c = document.createElement('button');
    c.className = 'chip' + (state.practice.difficulty === d ? ' selected' : '');
    c.textContent = d[0].toUpperCase() + d.slice(1);
    c.onclick = () => { state.practice.difficulty = d; localStorage.setItem('vs-difficulty', d); diffRow.querySelectorAll('.chip').forEach((x) => x.classList.toggle('selected', x === c)); };
    diffRow.appendChild(c);
  }
}
$('#btn-practice-back').onclick = () => show('menu');
$('#btn-practice-start').onclick = () => {
  if (!state.practice.hero) return;
  if (mpNet.connected) mpNet.send({ t: 'leave' });
  net = local; state.mode = 'practice';
  local.send({ t: 'practice', hero: state.practice.hero, botHero: state.practice.botHero, difficulty: state.practice.difficulty, name: $('#name').value.trim() || 'You' });
};

// ------------------------------------------------------------------ lobby
function buildHeroGrid(grid, onPick) {
  grid.innerHTML = '';
  for (const id of HERO_IDS) {
    const h = HEROES[id];
    const card = document.createElement('div');
    card.className = 'hero-card';
    card.dataset.hero = id;
    const c = '#' + h.color.toString(16).padStart(6, '0');
    const a = '#' + h.accent.toString(16).padStart(6, '0');
    card.innerHTML = `<div class="swatch" style="background: linear-gradient(135deg, ${c}, ${a})"></div><h3>${h.name}</h3><p>${h.title}</p>`;
    card.onclick = () => onPick(id);
    grid.appendChild(card);
  }
}

function showHeroDetail(id, grid, el) {
  const h = HEROES[id];
  const ab = (key, a) => `<div class="ability"><b>${key.toUpperCase()} · ${a.name}</b><span class="cd">${a.cooldown}s</span><span class="d">${a.desc}</span>${a.fire ? `<span class="fire">${a.fire}</span>` : ''}</div>`;
  el.innerHTML =
    `<div class="ability"><b>LMB · ${h.attack.name}</b><span class="cd">${h.attack.cooldown}s</span><span class="d">${h.attack.desc}</span></div>` +
    ab('q', h.abilities.q) + ab('w', h.abilities.w) + ab('e', h.abilities.e) + ab('r', h.abilities.r);
  grid.querySelectorAll('.hero-card').forEach((c) => c.classList.toggle('selected', c.dataset.hero === id));
}

function renderLobby(lobby) {
  $('#lobby-code').textContent = lobby.code;
  const list = $('#lobby-players');
  list.innerHTML = '';
  for (let i = 0; i < 2; i++) {
    const p = lobby.players[i];
    const chip = document.createElement('div');
    if (!p) { chip.className = 'player-chip empty'; chip.innerHTML = `<span class="dot"></span><span class="who">Waiting for opponent… share code ${lobby.code}</span>`; }
    else {
      chip.className = 'player-chip' + (p.ready ? ' ready' : '');
      chip.innerHTML = `<span class="dot"></span><span class="who">${escapeHtml(p.name)}${p.id === mpNet.id ? ' (you)' : ''}${p.host ? ' · host' : ''}</span><span class="hero">${p.hero ? HEROES[p.hero].name : 'picking…'}${p.ready ? ' · ready' : ''}</span>`;
    }
    list.appendChild(chip);
  }
  const me = lobby.players.find((p) => p.id === mpNet.id);
  state.myHero = me?.hero || null;
  if (state.myHero) showHeroDetail(state.myHero, $('#hero-grid'), $('#hero-detail'));
  const btn = $('#btn-ready');
  btn.disabled = !state.myHero;
  btn.textContent = me?.ready ? 'Unready' : 'Ready';
  btn.classList.toggle('primary', !me?.ready);
}

$('#btn-ready').onclick = () => {
  const me = state.lobby?.players.find((p) => p.id === mpNet.id);
  mpNet.send({ t: 'ready', ready: !me?.ready });
};
$('#btn-leave').onclick = () => { mpNet.send({ t: 'leave' }); show('menu'); };
$('#btn-back').onclick = () => { show(state.mode === 'practice' ? 'practice' : 'lobby'); };
$('#btn-quit').onclick = () => {
  net.send({ t: 'leave' });
  renderer.endMatch();
  show(state.mode === 'practice' ? 'practice' : 'menu');
};

buildHeroGrid($('#hero-grid'), (id) => { mpNet.send({ t: 'pick', hero: id }); showHeroDetail(id, $('#hero-grid'), $('#hero-detail')); });
buildPracticeScreen();

// ---------------------------------------------------------------- network
function onStart(msg) {
  state.match = msg;
  renderer.setProps(msg.props);
  renderer.startMatch(msg.players, net.id);
  buildHud(msg);
  state.lastPhase = null; state.lastRound = 0;
  show('game');
}
function onState(msg) {
  if (state.screen !== 'game') return;
  state.lastSnap = msg;
  renderer.pushSnapshot(msg);
  updateHud(msg);
}
function onMatchOver(msg) {
  renderer.endMatch();
  const won = msg.winner === net.id;
  $('#end-title').textContent = won ? 'Victory' : 'Defeat';
  $('#end-title').style.color = won ? '#ffb347' : '#ff4d4d';
  const names = state.match.players;
  $('#end-score').textContent = names.map((p) => `${p.name}: ${msg.score[p.id]}`).join('   ·   ');
  $('#btn-back').textContent = state.mode === 'practice' ? 'Play again' : 'Back to lobby';
  show('end');
}

for (const transport of [mpNet, local]) {
  transport.on('start', (m) => { if (transport === net) onStart(m); });
  transport.on('state', (m) => { if (transport === net) onState(m); });
  transport.on('matchover', (m) => { if (transport === net) onMatchOver(m); });
}

mpNet.on('lobby', (msg) => {
  state.lobby = msg;
  $('#lobby-error').textContent = '';
  $('#menu-error').textContent = '';
  if (state.screen === 'menu' || state.screen === 'practice') show('lobby');
  renderLobby(msg);
});
mpNet.on('error', (msg) => {
  if (state.screen === 'menu') $('#menu-error').textContent = msg.msg;
  else if (state.screen === 'lobby') $('#lobby-error').textContent = msg.msg;
  else toast(msg.msg);
});
mpNet.on('left', () => { if (state.mode === 'multiplayer' && state.screen !== 'menu') show('menu'); });
mpNet.on('opponentLeft', () => {
  renderer.endMatch();
  toast('Your opponent left the match.', 4000);
  show('lobby');
});
mpNet.on('close', () => {
  if (state.mode !== 'multiplayer') return;
  renderer.endMatch();
  toast('Connection to the server was lost.', 4000);
  show('menu');
});

// -------------------------------------------------------------------- HUD
function buildHud(match) {
  const me = match.players.find((p) => p.id === net.id);
  const them = match.players.find((p) => p.id !== net.id);
  $('#score-left .name').textContent = me.name;
  $('#score-right .name').textContent = them.name;
  for (const side of ['#score-left', '#score-right']) {
    const pips = $(`${side} .pips`);
    pips.innerHTML = '';
    for (let i = 0; i < ARENA.roundsToWin; i++) { const d = document.createElement('span'); d.className = 'pip'; pips.appendChild(d); }
  }
  const hero = HEROES[me.hero];
  const slots = $('#abilities');
  slots.innerHTML = '';
  const defs = [
    ['LMB', 'a', hero.attack.name],
    ['Q', 'q', hero.abilities.q.name],
    ['W', 'w', hero.abilities.w.name],
    ['E', 'e', hero.abilities.e.name],
    ['R', 'r', hero.abilities.r.name],
  ];
  for (const [label, key, name] of defs) {
    const s = document.createElement('div');
    s.className = 'slot' + (key === 'r' ? ' ult' : '');
    s.dataset.key = key;
    s.innerHTML = `<span class="key">${label}</span><div class="cool"></div><div class="cdnum"></div><div class="nm">${name}</div>`;
    slots.appendChild(s);
  }
}

function fmtTime(s) { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function fmtScore(snap, me, them) { return `${snap.score[me.id]} – ${snap.score[them.id]}`; }

function updateHud(snap) {
  const me = snap.players.find((p) => p.id === net.id);
  const them = snap.players.find((p) => p.id !== net.id);
  if (!me) return;
  const hero = HEROES[me.hero];

  const left = $('#score-left .pips').children, right = $('#score-right .pips').children;
  for (let i = 0; i < left.length; i++) left[i].classList.toggle('on', i < snap.score[me.id]);
  for (let i = 0; i < right.length; i++) right[right.length - 1 - i].classList.toggle('on', i < snap.score[them.id]);
  $('#round-label').textContent = `Round ${snap.round}`;
  const timer = $('#round-timer');
  const remaining = ARENA.roundTimeLimit - snap.roundTime;
  timer.textContent = fmtTime(remaining);
  timer.classList.toggle('danger', remaining <= 15);
  $('#lava-warning').classList.toggle('hidden', !(snap.phase === 'fight' && snap.roundTime >= ARENA.shrinkStart && snap.roundTime < ARENA.shrinkStart + 4));

  $('#hp-fill').style.width = `${(me.hp / me.maxHp) * 100}%`;
  $('#shield-fill').style.width = `${Math.min(me.sh, me.maxHp) / me.maxHp * 100}%`;
  $('#hp-text').textContent = `${me.hp} / ${me.maxHp}${me.sh ? `  (+${me.sh} shield)` : ''}`;

  const maxes = { a: hero.attack.cooldown, q: hero.abilities.q.cooldown, w: hero.abilities.w.cooldown, e: hero.abilities.e.cooldown, r: hero.abilities.r.cooldown };
  for (const slot of $('#abilities').children) {
    const key = slot.dataset.key;
    const cd = me.cd[key];
    const frac = maxes[key] ? cd / maxes[key] : 0;
    slot.querySelector('.cool').style.height = `${Math.min(1, frac) * 100}%`;
    slot.querySelector('.cdnum').textContent = cd > 0 && key !== 'a' ? Math.ceil(cd) : '';
    const recast = (key === 'q' && me.flags?.qRecast) || (key === 'e' && me.flags?.eRecast);
    slot.classList.toggle('recast', !!recast);
    slot.classList.toggle('ready', cd <= 0);
    if (recast) slot.querySelector('.cdnum').textContent = key === 'q' ? 'PULL' : 'BURST';
  }

  const badges = [];
  const map = { slow: ['Slowed', 'bad'], root: ['Rooted', 'bad'], stun: ['Stunned', 'bad'], burn: ['Burning', 'bad'], soaked: ['Soaked', 'bad'], vulnerable: ['Vulnerable', 'bad'], empower: ['Empowered', 'good'], fire: ['Fiery Heart', 'good'], shell: ['Tidal Shell', 'good'] };
  for (const f of me.fx || []) if (map[f]) badges.push(`<span class="badge ${map[f][1]}">${map[f][0]}</span>`);
  if (Math.hypot(me.x, me.z) > snap.safeR && me.alive) badges.push('<span class="badge bad">In lava</span>');
  $('#status').innerHTML = badges.join('');

  if (snap.phase !== state.lastPhase || snap.round !== state.lastRound) {
    if (snap.phase === 'countdown') announce(`Round ${snap.round}<small>${me.hero === them.hero ? 'Mirror match' : `${hero.name} vs ${HEROES[them.hero].name}`}</small>`, ARENA.countdown * 1000);
    if (snap.phase === 'fight') announce('Fight!', 900);
    if (snap.phase === 'roundend') {
      const w = snap.roundWinner;
      announce(w === null ? 'Draw<small>Round will be replayed</small>' : w === me.id ? 'Round won<small>' + fmtScore(snap, me, them) + '</small>' : 'Round lost<small>' + fmtScore(snap, me, them) + '</small>', ARENA.roundEndDelay * 1000);
    }
    state.lastPhase = snap.phase; state.lastRound = snap.round;
  } else if (snap.phase === 'countdown') {
    const n = Math.ceil(snap.phaseT);
    $('#announce').innerHTML = `${n > 0 ? n : 'Fight!'}<small>Round ${snap.round}</small>`;
  }
  if (performance.now() > state.announceUntil) $('#announce').classList.add('hidden');
}

// ---------------------------------------------------------------- input loop
input.onCast = (key, aim) => net.send({ t: 'cast', key, aim });
input.onMoveTarget = (target) => { input.moveTarget = target; net.send({ t: 'input', target }); };

let lastInputSend = 0;
let lastMove = [0, 0];
let lastAttack = 0;
function tick() {
  requestAnimationFrame(tick);
  if (state.screen === 'game') {
    input.updateAim();
    const move = input.moveVector();
    const now = performance.now();
    if (now - lastInputSend > 50) {
      lastInputSend = now;
      const msg = { t: 'input', move, aim: input.aim };
      if (move[0] !== lastMove[0] || move[1] !== lastMove[1]) {
        if (Math.hypot(move[0], move[1]) > 0) { input.moveTarget = null; msg.target = null; }
        lastMove = move;
      }
      net.send(msg);
    }
    if (input.attackHeld && now - lastAttack > 120) { lastAttack = now; net.send({ t: 'cast', key: 'attack', aim: input.aim }); }
  }
  renderer.frame();
}
requestAnimationFrame(tick);
