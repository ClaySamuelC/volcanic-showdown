// Looping arena music plus short synthesized hits. Playback starts on the first click or key.
import { DEBUG } from '../shared/debug.js';

const music = new Audio('music/arena-music.mp3');
music.loop = true;

const STORE = 'vs-audio';
const PREVIOUS_MUSIC_DEFAULT = 0.42;
let musicVolume = DEBUG.musicVolume;
let sfxVolume = 1;
let musicEnabled = true;
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
  if (Number.isFinite(saved.music) && saved.music !== PREVIOUS_MUSIC_DEFAULT) musicVolume = clamp(saved.music);
  if (Number.isFinite(saved.sfx)) sfxVolume = clamp(saved.sfx);
  if (typeof saved.enabled === 'boolean') musicEnabled = saved.enabled;
} catch { /* keep defaults */ }
music.volume = musicVolume;

let ctx = null;
let noise = null;
let unlocked = false;
let musicOn = false;

function clamp(v) { return Math.min(1, Math.max(0, v)); }

function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ music: musicVolume, sfx: sfxVolume, enabled: musicEnabled })); }
  catch { /* private mode */ }
}

export function getVolumes() {
  return { music: musicVolume, sfx: sfxVolume, enabled: musicEnabled };
}

export function isMusicEnabled() { return musicEnabled; }

export function setMusicEnabled(on) {
  musicEnabled = !!on;
  if (!musicEnabled) {
    music.pause();
    musicOn = false;
  } else if (unlocked) {
    startMusic();
  }
  save();
}

export function toggleMusic() {
  setMusicEnabled(!musicEnabled);
  return musicEnabled;
}

export function setMusicVolume(v) {
  musicVolume = clamp(v);
  music.volume = musicVolume;
  if (musicVolume <= 0 || !musicEnabled) {
    music.pause();
    musicOn = false;
  } else if (unlocked && !musicOn) {
    startMusic();
  }
  save();
}

export function setSfxVolume(v) {
  sfxVolume = clamp(v);
  save();
}

function context() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function noiseBuffer() {
  const c = context();
  if (noise) return noise;
  const len = Math.floor(c.sampleRate * 0.12);
  noise = c.createBuffer(1, len, c.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

function burst(seconds, freq, volume) {
  volume *= sfxVolume;
  if (volume < 0.001) return;
  const c = context();
  const src = c.createBufferSource();
  src.buffer = noiseBuffer();
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(freq, c.currentTime);
  const gain = c.createGain();
  gain.gain.setValueAtTime(volume, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + seconds);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(c.destination);
  src.start();
  src.stop(c.currentTime + seconds);
}

function thump(freq, seconds, volume) {
  volume *= sfxVolume;
  if (volume < 0.001) return;
  const c = context();
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, c.currentTime);
  osc.frequency.exponentialRampToValueAtTime(48, c.currentTime + seconds);
  const gain = c.createGain();
  gain.gain.setValueAtTime(volume, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + seconds);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + seconds);
}

export function startMusic() {
  unlocked = true;
  context();
  if (musicOn || !musicEnabled || musicVolume <= 0) return;
  const pending = music.play();
  if (pending && pending.then) pending.then(() => { musicOn = true; }).catch(() => {});
  else musicOn = true;
}

export function attackSwing() {
  if (!unlocked) return;
  burst(0.09, 1800, 0.12);
}

export function attackShot() {
  if (!unlocked) return;
  burst(0.05, 2400, 0.1);
  thump(220, 0.05, 0.08);
}

export function attackHit(heavy = false) {
  if (!unlocked) return;
  burst(heavy ? 0.12 : 0.07, heavy ? 700 : 1100, heavy ? 0.28 : 0.2);
  thump(heavy ? 90 : 130, heavy ? 0.14 : 0.08, heavy ? 0.28 : 0.18);
}

function unlock(e) {
  const key = e && e.key;
  if (key === 'Escape' || (key && key.toLowerCase() === 'm')) return;
  startMusic();
}
document.addEventListener('pointerdown', unlock);
document.addEventListener('keydown', unlock);
