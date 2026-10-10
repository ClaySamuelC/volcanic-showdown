import { HEROES, HERO_IDS, ARENA, abilityOnKey } from '../shared/heroes.js';
import { DEBUG } from '../shared/debug.js';
import { DIFFICULTIES } from '../game/ai.js';
import { Net } from './net.js';
import { PeerLobby } from './peer.js';
import { LocalGame } from './local.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { getVolumes, setMusicVolume, setSfxVolume, setMusicEnabled, toggleMusic, attackHit } from './audio.js';

const $ = (sel) => document.querySelector(sel);
const screens = { menu: $('#screen-menu'), practice: $('#screen-practice'), lobby: $('#screen-lobby'), end: $('#screen-end') };
const hud = $('#hud');

const mpNet = new Net();
const peerNet = new PeerLobby();
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
  homeDummy: false,
};

let altHeld = false;
let tipCtx = null;
let detailCtx = null;

function refreshAltText() {
  if (detailCtx?.el?.isConnected) showHeroDetail(detailCtx.id, detailCtx.grid, detailCtx.el);
  if (tipCtx) showAbilityTip(tipCtx.slot, tipCtx.hero, tipCtx.key);
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Alt' || e.repeat) return;
  e.preventDefault();
  altHeld = true;
  refreshAltText();
});
window.addEventListener('keyup', (e) => {
  if (e.key !== 'Alt') return;
  altHeld = false;
  refreshAltText();
});
window.addEventListener('blur', () => {
  if (!altHeld) return;
  altHeld = false;
  refreshAltText();
});

function show(name) {
  state.screen = name;
  const dock = name === 'game' && state.homeDummy;
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', k !== name && !(dock && k === 'menu'));
    if (k === 'menu') el.classList.toggle('dock', dock);
  }
  hud.classList.toggle('hidden', name !== 'game');
  $('#screen-options').classList.add('hidden');
  input.enabled = name === 'game';
}

function returnHome() {
  if (!DEBUG.startInDummy) { show('menu'); return; }
  if (state.homeDummy && local.sim && state.screen !== 'game') { show('game'); return; }
  const saved = state.practice.hero;
  const hero = saved === 'random' || HEROES[saved] ? saved : HERO_IDS[0];
  if (mpNet.connected) mpNet.send({ t: 'leave' });
  peerNet.close();
  net = local;
  state.mode = 'practice';
  state.homeDummy = true;
  local.send({
    t: 'practice',
    hero,
    botHero: 'random',
    difficulty: 'dummy',
    name: $('#name').value.trim() || 'You',
  });
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

async function openMultiplayer(kind, code) {
  const name = playerName();
  $('#menu-error').textContent = '';
  if (local.sim) local.send({ t: 'leave' });
  state.homeDummy = false;
  const url = Net.defaultUrl();
  if (url) {
    try {
      await mpNet.connect(url);
      net = mpNet;
      state.mode = 'multiplayer';
      net.send(kind === 'create' ? { t: 'create', name } : { t: 'join', name, code });
      return;
    } catch {
      mpNet.disconnect();
    }
  }
  net = peerNet;
  state.mode = 'multiplayer';
  if (kind === 'create') await peerNet.host(name);
  else await peerNet.join(name, code);
}

async function withMenuBusy(btn, label, fn) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { await fn(); }
  catch (e) {
    $('#menu-error').textContent = e.message || 'Could not open a lobby.';
    if (DEBUG.startInDummy) returnHome();
  }
  finally { btn.disabled = false; btn.textContent = prev; }
}

$('#btn-create').onclick = () => withMenuBusy($('#btn-create'), 'Creating…', () => openMultiplayer('create'));
$('#btn-join').onclick = () => {
  const code = $('#code').value.trim();
  if (!/^\d{3}$/.test(code)) { $('#menu-error').textContent = 'Enter the 3-digit lobby code.'; return; }
  withMenuBusy($('#btn-join'), 'Joining…', () => openMultiplayer('join', code));
};
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
$('#code').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 3); });

$('#btn-practice').onclick = () => { playerName(); show('practice'); };

const options = $('#screen-options');
function openOptions() {
  options.classList.remove('hidden');
  input.enabled = false;
}
function closeOptions() {
  options.classList.add('hidden');
  input.enabled = state.screen === 'game';
}
function bindVolume(inputEl, valueEl, apply, preview) {
  const paint = () => { valueEl.textContent = inputEl.value; };
  inputEl.addEventListener('input', () => {
    paint();
    apply(Number(inputEl.value) / 100);
    if (preview) preview();
  });
  paint();
}
const vols = getVolumes();
$('#vol-music').value = String(Math.round(vols.music * 100));
$('#vol-sfx').value = String(Math.round(vols.sfx * 100));
$('#music-enabled').checked = vols.enabled;
bindVolume($('#vol-music'), $('#vol-music-val'), setMusicVolume);
bindVolume($('#vol-sfx'), $('#vol-sfx-val'), setSfxVolume);
$('#vol-sfx').addEventListener('change', () => attackHit(false));
$('#music-enabled').addEventListener('change', () => setMusicEnabled($('#music-enabled').checked));
$('#btn-options').onclick = openOptions;
$('#btn-practice-options').onclick = openOptions;
$('#btn-lobby-options').onclick = openOptions;
$('#btn-hud-options').onclick = openOptions;
$('#btn-options-back').onclick = closeOptions;

function typingTarget(el) {
  if (!el || !el.tagName) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el.type || 'text').toLowerCase();
  return type !== 'checkbox' && type !== 'range' && type !== 'button';
}

function showMusicNotice(on) {
  const el = $('#music-notice');
  el.textContent = on ? 'Music on' : 'Music off';
  el.classList.remove('hidden');
  clearTimeout(showMusicNotice.timer);
  showMusicNotice.timer = setTimeout(() => el.classList.add('hidden'), 1600);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (options.classList.contains('hidden')) openOptions();
    else closeOptions();
    return;
  }
  if (e.repeat || e.key.toLowerCase() !== 'm' || typingTarget(e.target)) return;
  const on = toggleMusic();
  $('#music-enabled').checked = on;
  showMusicNotice(on);
});

// --------------------------------------------------------------- practice
function buildPracticeScreen() {
  buildHeroGrid($('#practice-hero-grid'), (id) => {
    state.practice.hero = id;
    localStorage.setItem('vs-practice-hero', id);
    showHeroDetail(id, $('#practice-hero-grid'), $('#practice-hero-detail'));
    $('#btn-practice-start').disabled = false;
  });
  if (state.practice.hero === 'random' || HEROES[state.practice.hero]) {
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
$('#btn-practice-back').onclick = () => returnHome();
$('#btn-practice-start').onclick = () => {
  if (!state.practice.hero) return;
  if (mpNet.connected) mpNet.send({ t: 'leave' });
  peerNet.close();
  net = local; state.mode = 'practice';
  local.send({ t: 'practice', hero: state.practice.hero, botHero: state.practice.botHero, difficulty: state.practice.difficulty, name: $('#name').value.trim() || 'You' });
};

// ------------------------------------------------------------------ lobby
function heroName(id) {
  if (id === 'random') return 'Random';
  return id && HEROES[id] ? HEROES[id].name : 'picking…';
}

function buildHeroGrid(grid, onPick) {
  grid.innerHTML = '';
  const ids = ['random', ...HERO_IDS];
  for (const id of ids) {
    if (id === 'random') {
      const card = document.createElement('div');
      card.className = 'hero-card';
      card.dataset.hero = 'random';
      card.innerHTML = `<div class="swatch" style="background: repeating-linear-gradient(135deg, #ff7a2a, #ff7a2a 8px, #1b1620 8px, #1b1620 16px)"></div><h3>Random</h3><p>New hero each round</p>`;
      card.onclick = () => onPick('random');
      grid.appendChild(card);
      continue;
    }
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
  detailCtx = { id, grid, el };
  if (id === 'random') {
    el.innerHTML = `<div class="ability"><b>Random</b><span class="d">A different hero is chosen at the start of every round.</span></div>`;
    grid.querySelectorAll('.hero-card').forEach((c) => c.classList.toggle('selected', c.dataset.hero === 'random'));
    return;
  }
  const h = HEROES[id];
  const extra = (a) => {
    if (altHeld && a.detail) return `<span class="detail">${escapeHtml(a.detail)}</span>`;
    if (a.detail) return `<span class="hint">Hold Alt for details</span>`;
    return '';
  };
  const ab = (key, a) => `<div class="ability"><b>${key.toUpperCase()} · ${a.name}</b><span class="cd">${a.passive ? 'Passive' : `${a.cooldown}s`}</span><span class="d">${a.desc}</span>${extra(a)}${a.fire ? `<span class="fire">${a.fire}</span>` : ''}</div>`;
  const keys = ['q', 'w', 'e', 'r'];
  el.innerHTML =
    `<div class="ability"><b>LMB · ${h.attack.name}</b><span class="cd">${h.attack.cooldown}s</span><span class="d">${h.attack.desc}</span>${extra(h.attack)}</div>` +
    keys.map((key) => ab(key, h.abilities[abilityOnKey(id, key)])).join('');
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
      chip.innerHTML = `<span class="dot"></span><span class="who">${escapeHtml(p.name)}${p.id === net.id ? ' (you)' : ''}${p.host ? ' · host' : ''}</span><span class="hero">${heroName(p.hero)}${p.ready ? ' · ready' : ''}</span>`;
    }
    list.appendChild(chip);
  }
  const me = lobby.players.find((p) => p.id === net.id);
  state.myHero = me?.hero || null;
  if (state.myHero) showHeroDetail(state.myHero, $('#hero-grid'), $('#hero-detail'));
  const btn = $('#btn-ready');
  btn.disabled = !state.myHero;
  btn.textContent = me?.ready ? 'Unready' : 'Ready';
  btn.classList.toggle('primary', !me?.ready);
}

$('#btn-ready').onclick = () => {
  const me = state.lobby?.players.find((p) => p.id === net.id);
  net.send({ t: 'ready', ready: !me?.ready });
};
$('#btn-leave').onclick = () => { net.send({ t: 'leave' }); returnHome(); };
$('#btn-back').onclick = () => { show(state.mode === 'practice' ? 'practice' : 'lobby'); };
$('#btn-quit').onclick = () => {
  net.send({ t: 'leave' });
  renderer.endMatch();
  if (state.mode === 'practice' && !state.homeDummy) show('practice');
  else returnHome();
};

buildHeroGrid($('#hero-grid'), (id) => { net.send({ t: 'pick', hero: id }); showHeroDetail(id, $('#hero-grid'), $('#hero-detail')); });
buildPracticeScreen();

function sendSandbox(extra = {}) {
  if (net !== local) return;
  net.send({
    t: 'sandbox',
    freeCooldowns: $('#sand-free').checked,
    propsDisabled: $('#sand-props').checked,
    ...extra,
  });
}
  for (const id of ['sand-hero', 'sand-bot']) {
  const sel = document.getElementById(id);
  const randomOpt = document.createElement('option');
  randomOpt.value = 'random';
  randomOpt.textContent = 'Random';
  sel.appendChild(randomOpt);
  for (const hid of HERO_IDS) {
    const opt = document.createElement('option');
    opt.value = hid;
    opt.textContent = HEROES[hid].name;
    sel.appendChild(opt);
  }
}
$('#sand-free').addEventListener('change', () => sendSandbox());
$('#sand-props').addEventListener('change', () => sendSandbox());
$('#sand-refresh').addEventListener('click', () => sendSandbox({ refresh: true }));
$('#sand-reset').addEventListener('click', () => sendSandbox({ reset: true }));
$('#sand-hero').addEventListener('change', () => sendSandbox({ hero: $('#sand-hero').value }));
$('#sand-bot').addEventListener('change', () => sendSandbox({ botHero: $('#sand-bot').value }));

// ---------------------------------------------------------------- network
function onStart(msg) {
  state.match = msg;
  renderer.setProps(msg.props);
  renderer.startMatch(msg.players, net.id);
  buildHud(msg);
  state.lastPhase = null; state.lastRound = 0;
  const dummyMatch = msg.players.some((p) => p.dummy);
  state.homeDummy = dummyMatch;
  $('#sandbox').classList.toggle('hidden', !dummyMatch);
  if (dummyMatch) {
    $('#sand-free').checked = false;
    $('#sand-props').checked = false;
    const me = msg.players.find((p) => p.id === net.id);
    const them = msg.players.find((p) => p.id !== net.id);
    $('#sand-hero').value = me.pick === 'random' ? 'random' : me.hero;
    $('#sand-bot').value = them.pick === 'random' ? 'random' : them.hero;
  }
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

for (const transport of [mpNet, peerNet, local]) {
  transport.on('start', (m) => { if (transport === net) onStart(m); });
  transport.on('state', (m) => { if (transport === net) onState(m); });
  transport.on('matchover', (m) => { if (transport === net) onMatchOver(m); });
}

for (const transport of [mpNet, peerNet]) {
  transport.on('lobby', (msg) => {
    if (transport !== net) return;
    state.lobby = msg;
    $('#lobby-error').textContent = '';
    $('#menu-error').textContent = '';
    if (state.screen === 'menu' || state.screen === 'practice') show('lobby');
    renderLobby(msg);
  });
  transport.on('error', (msg) => {
    if (transport !== net) return;
    if (state.screen === 'menu') $('#menu-error').textContent = msg.msg;
    else if (state.screen === 'lobby') $('#lobby-error').textContent = msg.msg;
    else toast(msg.msg);
  });
  transport.on('left', () => { if (transport === net && state.mode === 'multiplayer' && state.screen !== 'menu') returnHome(); });
  transport.on('opponentLeft', () => {
    if (transport !== net) return;
    renderer.endMatch();
    toast('Your opponent left the match.', 4000);
    show('lobby');
  });
  transport.on('close', () => {
    if (transport !== net || state.mode !== 'multiplayer') return;
    renderer.endMatch();
    toast('Connection to the server was lost.', 4000);
    returnHome();
  });
}

// -------------------------------------------------------------------- HUD
function buildHud(match) {
  const me = match.players.find((p) => p.id === net.id);
  const them = match.players.find((p) => p.id !== net.id);
  state.hudHero = me.hero;
  state.themHero = them.hero;
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
  const defs = [['LMB', 'a', hero.attack.name]];
  for (const key of ['q', 'w', 'e', 'r']) {
    const id = abilityOnKey(hero.id, key);
    defs.push([key.toUpperCase(), id, hero.abilities[id].name]);
  }
  for (const [label, key, name] of defs) {
    const s = document.createElement('div');
    s.className = 'slot' + (key === 'r' ? ' ult' : '');
    s.dataset.key = key;
    s.innerHTML = `<span class="key">${label}</span><div class="cool"></div><div class="cdnum"></div><div class="nm">${name}</div>${key === 'a' ? '' : '<div class="sil-x">✕</div>'}`;
    s.addEventListener('mouseenter', () => showAbilityTip(s, hero, key));
    s.addEventListener('mouseleave', () => {
      if (tipCtx?.slot === s) tipCtx = null;
      $('#ability-tip').classList.add('hidden');
    });
    slots.appendChild(s);
  }
}

function showAbilityTip(slot, hero, key) {
  tipCtx = { slot, hero, key };
  const a = key === 'a' ? hero.attack : hero.abilities[key];
  const label = slot.querySelector('.key').textContent;
  const tip = $('#ability-tip');
  const detail = altHeld && a.detail
    ? `<p class="tip-detail">${escapeHtml(a.detail)}</p>`
    : (a.detail ? `<p class="tip-hint">Hold Alt for details</p>` : '');
  tip.innerHTML =
    `<div class="tip-head"><b>${label} · ${escapeHtml(a.name)}</b><span class="tip-cd">${a.passive ? 'Passive' : `${a.cooldown}s`}</span></div>` +
    `<p>${escapeHtml(a.desc)}</p>` +
    detail +
    (a.fire ? `<p class="tip-fire">${escapeHtml(a.fire)}</p>` : '');
  tip.classList.remove('hidden');
  const r = slot.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.left + r.width / 2 - width / 2));
  let top = r.top - height - 10;
  if (top < 8) top = Math.min(window.innerHeight - height - 8, r.bottom + 10);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.style.bottom = 'auto';
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
  const dummyMatch = snap.players.some((p) => p.dummy);
  $('#sandbox').classList.toggle('hidden', !dummyMatch);
  if (dummyMatch) {
    const myPick = me.pick === 'random' ? 'random' : me.hero;
    const theirPick = them.pick === 'random' ? 'random' : them.hero;
    if ($('#sand-hero').value !== myPick) $('#sand-hero').value = myPick;
    if ($('#sand-bot').value !== theirPick) $('#sand-bot').value = theirPick;
  }
  if (me.hero !== state.hudHero || them.hero !== state.themHero) {
    const mp = state.match.players.find((p) => p.id === me.id);
    const tp = state.match.players.find((p) => p.id === them.id);
    if (mp) mp.hero = me.hero;
    if (tp) tp.hero = them.hero;
    buildHud(state.match);
  }
  $('#round-label').textContent = `Round ${snap.round}`;
  const timer = $('#round-timer');
  timer.classList.toggle('hidden', dummyMatch);
  const remaining = ARENA.roundTimeLimit - snap.roundTime;
  timer.textContent = fmtTime(remaining);
  timer.classList.toggle('danger', !dummyMatch && remaining <= 15);
  $('#lava-warning').classList.toggle('hidden', dummyMatch || !(snap.phase === 'fight' && snap.roundTime >= ARENA.shrinkStart && snap.roundTime < ARENA.shrinkStart + 4));

  $('#hp-fill').style.width = `${(me.hp / me.maxHp) * 100}%`;
  $('#shield-fill').style.width = `${Math.min(me.sh, me.maxHp) / me.maxHp * 100}%`;
  $('#hp-text').textContent = `${me.hp} / ${me.maxHp}${me.sh ? `  (+${me.sh} shield)` : ''}`;

  const silenced = (me.fx || []).includes('silence');
  const maxes = { a: hero.attack.cooldown, q: hero.abilities.q.cooldown, w: hero.abilities.w.cooldown, e: hero.abilities.e.cooldown, r: hero.abilities.r.cooldown };
  const recastText = { fuck: { q: 'WARP' }, groundskeeper: { q: 'PULL' }, tidebinder: { e: 'BURST' }, monk: { w: 'STRIKE' }, illusionist: { q: 'BOLT', w: 'SWAP' } };
  for (const slot of $('#abilities').children) {
    const key = slot.dataset.key;
    const passive = key !== 'a' && hero.abilities[key].passive;
    const cd = me.cd[key];
    const frac = maxes[key] ? cd / maxes[key] : 0;
    slot.querySelector('.cool').style.height = `${Math.min(1, frac) * 100}%`;
    slot.querySelector('.cdnum').textContent = cd > 0 && key !== 'a' && !passive ? Math.ceil(cd) : '';
    const recast = (key === 'q' && me.flags?.qRecast) || (key === 'w' && me.flags?.wRecast) || (key === 'e' && me.flags?.eRecast);
    slot.classList.toggle('recast', !!recast);
    slot.classList.toggle('passive', !!passive);
    slot.classList.toggle('ready', cd <= 0 && !passive);
    slot.classList.toggle('silenced', silenced && key !== 'a' && !passive);
    if (recast) slot.querySelector('.cdnum').textContent = recastText[me.hero]?.[key] || '';
  }

  const badges = [];
  const map = {
    slow: ['Slowed', 'bad'], root: ['Rooted', 'bad'], stun: ['Stunned', 'bad'], burn: ['Burning', 'bad'], rabbit: ['Rabbit', 'bad'],
    soaked: ['Soaked', 'bad'], vulnerable: ['Vulnerable', 'bad'], silence: ['Silenced', 'bad'], poison: ['Poisoned', 'bad'],
    leash: ['Leashed', 'bad'], empower: ['Empowered', 'good'], fire: ['Fiery Heart', 'good'], shell: ['Tidal Shell', 'good'],
    haste: ['Hastened', 'good'], phase: ['Phased', 'good'], storm: ['Luminaire', 'good'],
    prone: ['Prone', 'bad'], perch: ['Perched', 'good'], dodge: ['Step Aside', 'good'], spellImmune: ['Still Mind', 'good'],
  };
  const seen = new Set();
  for (const f of me.fx || []) {
    if (!map[f]) continue;
    if (f === 'poison') {
      const n = me.ps || 1;
      for (let i = 0; i < n; i++) badges.push(`<span class="badge ${map[f][1]}">${map[f][0]}</span>`);
      continue;
    }
    if (seen.has(f)) continue;
    seen.add(f);
    badges.push(`<span class="badge ${map[f][1]}">${map[f][0]}</span>`);
  }
  if (me.hero === 'python' && me.alive && me.flags?.poisonReady) badges.push('<span class="badge good">Poison Dart</span>');
  if (me.hero === 'stone' && me.alive && me.flags?.holding) badges.push(`<span class="badge">${me.flags.holding === 'flame' ? 'Flame stone' : 'Stone in hand'}</span>`);
  if (me.hero === 'illusionist' && me.alive && me.flags?.swaps) badges.push(`<span class="badge">${me.flags.swaps} swap${me.flags.swaps > 1 ? 's' : ''}</span>`);
  if (me.hero === 'shock' && me.alive) {
    if (me.flags?.dash) badges.push('<span class="badge good">Storm Slash</span>');
    if (me.flags?.slow) badges.push('<span class="badge good">Gale Edge</span>');
    if (me.flags?.bolt) badges.push('<span class="badge good">Charged</span>');
    if (me.flags?.echo) badges.push('<span class="badge good">Tempest</span>');
    if (me.flags?.blade != null) badges.push('<span class="badge good">Cyclone</span>');
  }
  if (me.hero === 'monk' && me.alive) {
    const step = ['Sweep', 'Double', 'Line'][me.flags?.combo ?? 0] || 'Sweep';
    badges.push(`<span class="badge good">${step}</span>`);
  }
  if (Math.hypot(me.x, me.z) > snap.safeR && me.alive) badges.push('<span class="badge bad">In lava</span>');
  $('#status').innerHTML = badges.join('');
  if (!input.vector) {
    const hint = $('#aim-hint');
    if (me.hero === 'stone' && me.cast?.key === 'q') {
      hint.textContent = 'Release to kick. Hold to catch farther.';
      hint.classList.remove('hidden');
    } else if (me.hero === 'stone' && me.alive && me.flags?.holding) {
      hint.textContent = 'Left click sets the direction. Drag left or right to curve it.';
      hint.classList.remove('hidden');
    } else hint.classList.add('hidden');
  }

  if (snap.phase !== state.lastPhase || snap.round !== state.lastRound) {
    if (!dummyMatch && snap.phase === 'countdown') announce(`Round ${snap.round}<small>${me.hero === them.hero ? 'Mirror match' : `${hero.name} vs ${HEROES[them.hero].name}`}</small>`, ARENA.countdown * 1000);
    if (!dummyMatch && snap.phase === 'fight') announce('Fight!', 900);
    if (snap.phase === 'roundend') {
      const w = snap.roundWinner;
      announce(w === null ? 'Draw<small>Round will be replayed</small>' : w === me.id ? 'Round won<small>' + fmtScore(snap, me, them) + '</small>' : 'Round lost<small>' + fmtScore(snap, me, them) + '</small>', ARENA.roundEndDelay * 1000);
    }
    state.lastPhase = snap.phase; state.lastRound = snap.round;
  } else if (!dummyMatch && snap.phase === 'countdown') {
    const n = Math.ceil(snap.phaseT);
    $('#announce').innerHTML = `${n > 0 ? n : 'Fight!'}<small>Round ${snap.round}</small>`;
  }
  if (performance.now() > state.announceUntil) $('#announce').classList.add('hidden');
}

// ---------------------------------------------------------------- input loop
function issueCast(key, aim, curve) {
  net.send(curve ? { t: 'cast', key, aim, curve } : { t: 'cast', key, aim });
}
function castKey(key) {
  if (key === 'attack') return key;
  const me = state.lastSnap?.players?.find((p) => p.id === net.id);
  return me ? abilityOnKey(me.hero, key) : key;
}
input.onCast = (key, aim, curve) => {
  if (key === 'attack') lastAttack = performance.now();
  issueCast(castKey(key), aim, curve);
};
input.onRelease = (key, aim) => net.send({ t: 'release', key: castKey(key), aim });
input.vectorCast = (key) => {
  const me = state.lastSnap?.players?.find((p) => p.id === net.id);
  return key === 'attack' && me?.hero === 'stone' && !!me.flags?.holding && !me.cast;
};
input.channelCast = (key) => {
  const me = state.lastSnap?.players?.find((p) => p.id === net.id);
  return castKey(key) === 'q' && me?.hero === 'stone';
};
input.onVector = (text) => {
  const hint = $('#aim-hint');
  if (!hint) return;
  if (!text) { hint.classList.add('hidden'); hint.textContent = ''; return; }
  hint.textContent = text;
  hint.classList.remove('hidden');
};
input.onMoveTarget = (target) => { input.moveTarget = target; net.send({ t: 'input', target }); };

let lastInputSend = 0;
let lastAttack = 0;
let attackWasHeld = false;
function tick() {
  requestAnimationFrame(tick);
  if (state.screen === 'game') {
    input.updateAim();
    const now = performance.now();
    if (now - lastInputSend > 50) {
      lastInputSend = now;
      net.send({ t: 'input', aim: input.aim });
    }
    if (input.attackHeld) {
      attackWasHeld = true;
      if (now - lastAttack > 320) { lastAttack = now; issueCast('attack', input.aim.slice()); }
    } else if (attackWasHeld) {
      attackWasHeld = false;
      net.send({ t: 'input', clearAttack: true });
    }
    if (input.vector?.anchor) {
      const me = state.lastSnap?.players?.find((p) => p.id === net.id);
      if (me) renderer.showThrowArc(me.x, me.z, me.f, input.vector.anchor, input.aim);
    } else renderer.showThrowArc(null);
  } else if (input.vector) input.clearVector();
  renderer.frame();
}
requestAnimationFrame(tick);
if (DEBUG.startInDummy) returnHome();
