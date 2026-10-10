import * as THREE from 'three';
import { HEROES, ARENA } from '../shared/heroes.js';
import { throwCurve, quadPoint } from '../game/heroes.js';
import { attackHit, attackShot, attackSwing } from './audio.js';

const ISO_YAW = Math.PI / 4;
const ISO_PITCH = Math.atan(1 / Math.SQRT2); // classic isometric elevation ~35.26°
const VIEW_HEIGHT = 22.1; // world units visible vertically, matched to the larger island
const INTERP_DELAY = 0.1; // seconds behind server for smooth interpolation

// ------------------------------------------------------------------ shaders
const islandShader = {
  uniforms: {
    uSafeR: { value: 14 },
    uRadius: { value: 14 },
    uTime: { value: 0 },
  },
  vertexShader: `
    varying vec3 vPos;
    varying vec3 vNormal;
    void main() {
      vPos = (modelMatrix * vec4(position, 1.0)).xyz;
      vNormal = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float uSafeR;
    uniform float uRadius;
    uniform float uTime;
    varying vec3 vPos;
    varying vec3 vNormal;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
    }
    void main() {
      float d = length(vPos.xz);
      float n = noise(vPos.xz * 1.5) * 0.6 + noise(vPos.xz * 6.0) * 0.4;
      vec3 stone = mix(vec3(0.33, 0.31, 0.30), vec3(0.47, 0.44, 0.40), n);
      // subtle grid of cracks
      float crack = smoothstep(0.92, 1.0, noise(vPos.xz * 3.0 + 7.0));
      stone = mix(stone, vec3(0.18, 0.15, 0.14), crack * 0.6);
      // lava outside safe radius
      float flow = noise(vPos.xz * 1.2 + vec2(uTime * 0.25, -uTime * 0.18)) * 0.6 + noise(vPos.xz * 4.0 - uTime * 0.4) * 0.4;
      vec3 lava = mix(vec3(0.55, 0.08, 0.02), vec3(1.0, 0.55, 0.1), smoothstep(0.35, 0.8, flow));
      lava += vec3(1.0, 0.8, 0.3) * smoothstep(0.75, 0.95, flow) * 0.6;
      float edge = smoothstep(uSafeR - 0.35, uSafeR + 0.05, d);
      vec3 col = mix(stone, lava, edge);
      // glowing rim exactly at the boundary
      float rim = 1.0 - smoothstep(0.0, 0.35, abs(d - uSafeR));
      col += vec3(1.0, 0.6, 0.2) * rim * (0.6 + 0.4 * sin(uTime * 6.0));
      // basic lighting on stone only
      float light = 0.75 + 0.25 * max(0.0, dot(vNormal, normalize(vec3(0.5, 1.0, 0.3))));
      col = mix(col * light, col, edge);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// Calm backdrop: dark basalt with a soft warm glow hugging the island so the arena stays the focus.
const backdropShader = {
  uniforms: { uTime: { value: 0 }, uRadius: { value: 17 } },
  vertexShader: `
    varying vec3 vPos;
    void main() { vPos = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform float uTime; uniform float uRadius; varying vec3 vPos;
    void main() {
      float d = length(vPos.xz);
      vec3 base = vec3(0.07, 0.05, 0.06);
      vec3 glow = vec3(0.55, 0.16, 0.05);
      float g = 1.0 - smoothstep(uRadius, uRadius + 9.0, d);
      g *= 0.85 + 0.15 * sin(uTime * 1.2);
      vec3 col = mix(base, glow, g * 0.75);
      col *= 1.0 - smoothstep(35.0, 70.0, d) * 0.7;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// ------------------------------------------------------------- text sprites
function makeTextSprite(text, color = '#fff', size = 48) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = `900 ${size}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, 128, 64);
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3, 1.5, 1);
  sprite.renderOrder = 20;
  return sprite;
}

function makeIconSprite(draw, scale = 0.7) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  draw(canvas.getContext('2d'));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(scale, scale, 1);
  sprite.renderOrder = 16;
  sprite.visible = false;
  return sprite;
}

function drawSilenceX(ctx) {
  ctx.strokeStyle = '#ff3355';
  ctx.lineWidth = 18;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(24, 24); ctx.lineTo(104, 104);
  ctx.moveTo(104, 24); ctx.lineTo(24, 104);
  ctx.stroke();
}

function drawPoison(ctx) {
  ctx.fillStyle = '#7dce4a';
  ctx.beginPath(); ctx.arc(64, 46, 22, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(40, 86, 14, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(88, 90, 12, 0, Math.PI * 2); ctx.fill();
}

function drawVenomReady(ctx) {
  ctx.strokeStyle = '#e8ff9a';
  ctx.lineWidth = 10;
  ctx.beginPath(); ctx.arc(64, 64, 46, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#c6f25a';
  ctx.beginPath(); ctx.arc(64, 58, 16, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(64, 78); ctx.lineTo(50, 104); ctx.lineTo(78, 104); ctx.closePath();
  ctx.fill();
}

function poseMonkStaff(staff, step, t, windup) {
  const u = Math.max(0, Math.min(1, t || 0));
  if (step === 0) {
    const ang = windup ? -0.8 + u * 1.4 : u * Math.PI * 2;
    staff.position.set(Math.cos(ang) * 0.58, 1.18, Math.sin(ang) * 0.58);
    staff.rotation.set(0, ang, Math.PI / 2);
  } else if (step === 1) {
    const chops = windup ? u * 0.35 : (u < 0.5 ? u * 2 : (u - 0.5) * 2);
    const swing = Math.sin(chops * Math.PI);
    staff.position.set(0.36, 1.42 - swing * 0.42, 0.02);
    staff.rotation.set(0.15, 0, -0.2 - swing * 1.45);
  } else if (step === 2) {
    const jab = windup ? -0.4 * (1 - u) : Math.sin(u * Math.PI) * 0.62;
    staff.position.set(0.78 + jab, 1.18, 0);
    staff.rotation.set(0, 0, -Math.PI / 2);
  } else {
    const ang = windup ? -0.9 : -1.15 + u * 2.3;
    staff.position.set(0.2 + Math.cos(ang) * 0.28, 0.48, Math.sin(ang) * 0.5);
    staff.rotation.set(1.25, 0, ang);
  }
}

function restMonkStaff(staff) {
  const rest = staff.userData.rest;
  if (!rest) return;
  staff.position.set(rest.x, rest.y, rest.z);
  staff.rotation.set(rest.rx, rest.ry, rest.rz);
}

class NamePlate {
  constructor(name, color) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256; this.canvas.height = 80;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthTest: false }));
    this.sprite.scale.set(3.2, 1.0, 1);
    this.sprite.renderOrder = 15;
    this.name = name;
    this.color = color;
    this.last = '';
  }
  update(hp, maxHp, shield, isMe) {
    const key = `${hp}|${maxHp}|${shield}|${isMe}`;
    if (key === this.last) return;
    this.last = key;
    const c = this.ctx, W = 256, H = 80;
    c.clearRect(0, 0, W, H);
    c.font = '700 22px "Segoe UI", system-ui, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = isMe ? '#ffd27a' : '#ffffff';
    c.strokeStyle = 'rgba(0,0,0,.8)'; c.lineWidth = 5;
    c.strokeText(this.name, W / 2, 18); c.fillText(this.name, W / 2, 18);
    // segmented health bar
    const bx = 18, by = 40, bw = W - 36, bh = 22;
    c.fillStyle = 'rgba(0,0,0,.75)';
    c.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
    const seg = bw / maxHp;
    for (let i = 0; i < maxHp; i++) {
      c.fillStyle = i < hp ? (isMe ? '#4fd36b' : '#e8453c') : '#3a2a2a';
      c.fillRect(bx + i * seg + 1, by, seg - 2, bh);
    }
    if (shield > 0) {
      c.fillStyle = 'rgba(140,210,255,.9)';
      for (let i = 0; i < shield; i++) c.fillRect(bx + i * seg + 1, by + bh - 6, seg - 2, 6);
    }
    this.tex.needsUpdate = true;
  }
}

// --------------------------------------------------------------- hero meshes
const mats = {};
function mat(color, opts = {}) {
  const key = `${color}|${JSON.stringify(opts)}`;
  if (!mats[key]) mats[key] = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...opts });
  return mats[key];
}

function buildRabbit() {
  const g = new THREE.Group();
  const fur = mat(0xe7e0d4);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), fur);
  body.scale.set(1.35, 0.85, 1.05);
  body.position.y = 0.32;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 10), fur);
  head.position.set(0.28, 0.48, 0);
  g.add(head);
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.28, 4, 6), mat(0xf7f1e6));
    ear.position.set(0.3, 0.78, s * 0.07);
    ear.rotation.z = -0.15;
    g.add(ear);
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), fur);
    foot.scale.set(1.4, 0.6, 1);
    foot.position.set(0.12, 0.08, s * 0.12);
    g.add(foot);
  }
  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), mat(0xfffaf3));
  tail.position.set(-0.32, 0.34, 0);
  g.add(tail);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x2a241c });
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), eyeMat);
    eye.position.set(0.42, 0.52, s * 0.06);
    g.add(eye);
  }
  return g;
}

function asGhost(group) {
  group.traverse((o) => {
    if (!o.isMesh || o.userData.keep) return;
    o.material = new THREE.MeshBasicMaterial({ color: 0xc5c8ce, transparent: true, opacity: 0.45, depthWrite: false });
    o.castShadow = false;
  });
}

function lightningBall() {
  const g = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xfff6c2 }),
  );
  core.position.y = 1.05;
  core.userData.keep = true;
  g.add(core);
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x8fd4ff, transparent: true, opacity: 0.38, depthWrite: false }),
  );
  shell.position.y = 1.05;
  shell.userData.keep = true;
  g.add(shell);
  for (let i = 0; i < 6; i++) {
    const bolt = new THREE.Mesh(
      new THREE.ConeGeometry(0.045, 0.85, 4),
      new THREE.MeshBasicMaterial({ color: i % 2 ? 0xfff1a8 : 0xd7f3ff }),
    );
    bolt.position.y = 1.05;
    bolt.userData.keep = true;
    bolt.userData.i = i;
    g.add(bolt);
  }
  g.userData.core = core;
  g.userData.shell = shell;
  return g;
}

function tickLightning(ball, time, lift = 0) {
  if (!ball) return;
  ball.position.y = Math.max(0, lift) * 2.8;
  const pulse = 1 + Math.sin(time * 28) * 0.08;
  if (ball.userData.core) ball.userData.core.scale.setScalar(pulse);
  if (ball.userData.shell) ball.userData.shell.scale.setScalar(1.05 + Math.sin(time * 18) * 0.12);
  ball.children.forEach((bolt) => {
    if (bolt.userData.i == null) return;
    const ang = time * 9 + bolt.userData.i;
    bolt.position.set(Math.cos(ang) * 0.15, 1.05, Math.sin(ang) * 0.15);
    bolt.rotation.z = Math.sin(time * 20 + bolt.userData.i) * 0.8;
    bolt.rotation.x = Math.cos(time * 17 + bolt.userData.i) * 0.8;
  });
}

function buildHero(heroId) {
  const def = HEROES[heroId];
  const g = new THREE.Group();
  g.userData.heroId = heroId;
  const body = new THREE.Group();
  g.add(body);
  g.userData.body = body;
  const skin = mat(def.color);
  const accent = mat(def.accent, { emissive: def.accent, emissiveIntensity: 0.25 });

  if (heroId === 'minotaur') {
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 1.1), skin);
    torso.position.y = 1.1; body.add(torso);
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.8), mat(0x3b2a22));
    hips.position.y = 0.45; body.add(hips);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.55, 0.5), mat(0x6b2f22));
    head.position.set(0.25, 1.9, 0); body.add(head);
    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.35), mat(0x4a2016));
    snout.position.set(0.55, 1.8, 0); body.add(snout);
    for (const s of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.6, 8), mat(0xe8dcc0));
      horn.position.set(0.2, 2.15, s * 0.35); horn.rotation.z = -0.3; horn.rotation.x = s * -0.9;
      body.add(horn);
    }
    const axe = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.0, 8), mat(0x4a3220));
    axe.add(handle);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 0.9), mat(0xb8b8c0, { metalness: 0.6, roughness: 0.35 }));
    blade.position.y = 0.7; axe.add(blade);
    axe.position.set(0.55, 1.0, -0.65); axe.rotation.z = -0.4;
    body.add(axe);
    g.userData.weapon = axe;
    const flames = new THREE.Group();
    flames.visible = false;
    const flameColors = [0xff4d00, 0xff8a1a, 0xffd166, 0xff2a00];
    // Sit outside the body so the isometric camera sees them above the head and shoulders.
    const spots = [
      [0.15, 2.55, 0, 0.38, 1.35],
      [0.55, 2.15, 0.15, 0.28, 1.05],
      [-0.45, 2.05, -0.1, 0.26, 0.95],
      [0.7, 1.55, 0.35, 0.22, 0.8],
      [-0.65, 1.45, 0.2, 0.22, 0.75],
      [0.2, 1.9, -0.55, 0.2, 0.7],
    ];
    for (let i = 0; i < spots.length; i++) {
      const [x, y, z, radius, height] = spots[i];
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(radius, height, 7),
        new THREE.MeshBasicMaterial({
          color: flameColors[i % flameColors.length],
          transparent: true,
          opacity: 0.92,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      flame.renderOrder = 6;
      flame.position.set(x, y, z);
      flame.userData.baseY = y;
      flame.userData.baseH = height;
      flames.add(flame);
    }
    const fireLight = new THREE.PointLight(0xff6a1a, 0, 7, 1.6);
    fireLight.position.y = 1.4;
    flames.add(fireLight);
    g.add(flames);
    g.userData.flames = flames;
    g.userData.fireLight = fireLight;
  } else if (heroId === 'groundskeeper') {
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.7, 6, 12), skin);
    torso.position.y = 1.0; body.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 14), mat(0xd9a579));
    head.position.y = 1.7; body.add(head);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.05, 16), mat(0x4a3a24));
    brim.position.y = 1.9; body.add(brim);
    const hat = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.5, 12), mat(0x4a3a24));
    hat.position.y = 2.15; body.add(hat);
    const quiver = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.7, 8), mat(0x6b4b2a));
    quiver.position.set(-0.35, 1.2, 0.2); quiver.rotation.x = 0.3; body.add(quiver);
    const bow = new THREE.Group();
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, 0.1), mat(0x5a4028));
    bow.add(stock);
    const limb = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.9), mat(0x8a6a3a));
    limb.position.x = 0.3; bow.add(limb);
    bow.position.set(0.5, 1.15, -0.25);
    body.add(bow);
    g.userData.weapon = bow;
  } else if (heroId === 'tidebinder') {
    const robe = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.4, 14), skin);
    robe.position.y = 0.7; body.add(robe);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.4, 6, 12), skin);
    torso.position.y = 1.35; body.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 14, 14), mat(0xbfe6ea));
    head.position.y = 1.85; body.add(head);
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.6, 12), mat(0x1f4f85));
    hood.position.y = 2.1; body.add(hood);
    const staff = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 8), mat(0x2b3a4a));
    staff.add(pole);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 14), new THREE.MeshStandardMaterial({ color: 0x8fe3ff, emissive: 0x3fa9ff, emissiveIntensity: 1.2, roughness: 0.2 }));
    orb.position.y = 1.2; staff.add(orb);
    staff.position.set(0.45, 1.0, -0.5);
    body.add(staff);
    g.userData.weapon = staff;
  } else if (heroId === 'fuck') {
    const scale = mat(0x4a2068, { roughness: 0.4, metalness: 0.12 });
    const flesh = mat(0xf3d7ff);
    const hornMat = mat(0xf6e2ff, { emissive: 0xc084fc, emissiveIntensity: 0.4 });
    const membrane = new THREE.MeshBasicMaterial({ color: 0xe7b4ff, transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false });
    const membraneDeep = new THREE.MeshBasicMaterial({ color: 0x8a3ec4, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });

    const wisp = new THREE.Mesh(
      new THREE.ConeGeometry(0.46, 0.95, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false }),
    );
    wisp.position.y = 0.48; body.add(wisp);

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.38, 5, 10), scale);
    torso.position.y = 1.12; body.add(torso);
    const chest = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 12), skin);
    chest.scale.set(0.85, 0.75, 0.7); chest.position.set(0.04, 1.22, 0); body.add(chest);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 14), flesh);
    head.position.set(0.08, 1.58, 0); body.add(head);
    const snout = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.26, 7), flesh);
    snout.rotation.z = -Math.PI / 2; snout.position.set(0.3, 1.54, 0); body.add(snout);
    for (const s of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.34, 6), hornMat);
      horn.position.set(0.02, 1.78, s * 0.09);
      horn.rotation.z = -0.45; horn.rotation.x = s * -0.4;
      body.add(horn);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), new THREE.MeshBasicMaterial({ color: 0xfff3a0 }));
      eye.position.set(0.18, 1.62, s * 0.07); body.add(eye);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.2, 4, 6), scale);
      arm.position.set(0.1, 1.12, s * 0.18); arm.rotation.z = s * 0.9; body.add(arm);
    }

    const tail = new THREE.Group();
    const seg1 = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.42, 4, 6), scale);
    seg1.rotation.z = 1.15; seg1.position.set(-0.22, 0.82, 0); tail.add(seg1);
    const seg2 = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.36, 4, 6), skin);
    seg2.rotation.z = 1.7; seg2.position.set(-0.5, 0.52, 0); tail.add(seg2);
    const spade = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.26, 4), accent);
    spade.rotation.z = Math.PI / 2; spade.position.set(-0.76, 0.36, 0); tail.add(spade);
    body.add(tail);
    g.userData.tail = tail;

    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0);
    wingShape.bezierCurveTo(0.4, 0.55, 0.95, 0.72, 1.28, 0.4);
    wingShape.lineTo(1.05, 0.1);
    wingShape.lineTo(1.18, -0.1);
    wingShape.lineTo(0.72, -0.02);
    wingShape.lineTo(0.88, -0.34);
    wingShape.lineTo(0.12, -0.1);
    wingShape.closePath();
    const wingGeo = new THREE.ShapeGeometry(wingShape);
    const wings = [];
    const wingSpecs = [
      { side: 1, y: 1.32, scale: 1, mat: membrane },
      { side: -1, y: 1.32, scale: 1, mat: membrane },
      { side: 1, y: 1.18, scale: 0.58, mat: membraneDeep },
      { side: -1, y: 1.18, scale: 0.58, mat: membraneDeep },
    ];
    for (const spec of wingSpecs) {
      const pivot = new THREE.Group();
      pivot.position.set(0.02, spec.y, 0);
      const mesh = new THREE.Mesh(wingGeo, spec.mat);
      mesh.scale.set(spec.scale, spec.scale, spec.scale);
      mesh.rotation.y = spec.side > 0 ? -Math.PI / 2 : Math.PI / 2;
      pivot.add(mesh);
      pivot.userData.side = spec.side;
      body.add(pivot);
      wings.push(pivot);
    }
    g.userData.wings = wings;
    g.userData.hover = true;

    const motes = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const mote = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), new THREE.MeshBasicMaterial({ color: i % 2 ? 0xfff3a0 : 0xf6e7ff }));
      mote.userData.phase = i * 1.2;
      mote.userData.radius = 0.42 + (i % 3) * 0.1;
      motes.add(mote);
    }
    body.add(motes);
    g.userData.motes = motes;

    const claw = new THREE.Group();
    const spark = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 10), new THREE.MeshBasicMaterial({ color: 0xffe6ff }));
    spark.position.set(0.28, 0, 0); claw.add(spark);
    claw.position.set(0.2, 1.18, 0.22);
    body.add(claw);
    g.userData.weapon = claw;
  } else if (heroId === 'python') {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.16, 8, 16), skin);
    coil.rotation.x = Math.PI / 2; coil.position.y = 0.28; body.add(coil);
    const bodySeg = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.7, 6, 12), skin);
    bodySeg.position.y = 1.05; body.add(bodySeg);
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.55, 4), mat(0x3f9a48));
    hood.position.y = 1.75; hood.rotation.y = Math.PI / 4; body.add(hood);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), skin);
    head.position.set(0.12, 1.7, 0); body.add(head);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffe14a }));
      eye.position.set(0.28, 1.76, s * 0.08); body.add(eye);
    }
    const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.9, 4, 8), accent);
    tail.position.set(-0.35, 0.45, 0.15); tail.rotation.z = 1.1; body.add(tail);
    g.userData.weapon = tail;
  } else if (heroId === 'monk') {
    const cloth = mat(0xf0e2c4);
    const wood = mat(0x6b4423);
    const brass = mat(0xc9a227, { metalness: 0.5, roughness: 0.35 });
    const robe = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.15, 12), skin);
    robe.position.y = 0.62; body.add(robe);
    const sash = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.045, 6, 14), accent);
    sash.rotation.x = Math.PI / 2; sash.position.y = 0.95; body.add(sash);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.32, 5, 10), cloth);
    torso.position.y = 1.28; body.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 14), mat(0xe6c2a0));
    head.position.y = 1.78; body.add(head);
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), mat(0x2a211c));
    knot.position.y = 2.02; body.add(knot);
    for (const s of [-1, 1]) {
      const wrap = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.22, 4, 6), accent);
      wrap.position.set(0.05, 1.15, s * 0.28);
      wrap.rotation.z = s * 1.1;
      body.add(wrap);
    }
    const staff = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 2.05, 8), wood);
    staff.add(pole);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.025, 6, 12), brass);
    ring.rotation.y = Math.PI / 2; ring.position.y = 0.85; staff.add(ring);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), brass);
    cap.position.y = 1.08; staff.add(cap);
    staff.position.set(0.42, 1.05, -0.28);
    staff.rotation.z = -0.35;
    staff.userData.rest = { x: 0.42, y: 1.05, z: -0.28, rx: 0, ry: 0, rz: -0.35 };
    body.add(staff);
    g.userData.weapon = staff;

    const shine = new THREE.PointLight(0xffffff, 0, 7);
    shine.position.y = 1.45;
    g.add(shine);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 18, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
    );
    halo.position.y = 1.15;
    halo.visible = false;
    g.add(halo);
    g.userData.shine = shine;
    g.userData.halo = halo;

    const perchStaff = new THREE.Group();
    const perchPole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 2.35, 8), wood);
    perchPole.position.y = 1.18; perchStaff.add(perchPole);
    const perchCap = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), brass);
    perchCap.position.y = 2.38; perchStaff.add(perchCap);
    perchStaff.visible = false;
    g.add(perchStaff);
    g.userData.perchStaff = perchStaff;
  } else if (heroId === 'illusionist') {
    const cloth = mat(0x14161c);
    const shirt = mat(0xf4f1ea);
    const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.7, 10), cloth);
    legs.position.y = 0.4; body.add(legs);
    const jacket = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.55, 6, 12), cloth);
    jacket.position.y = 1.15; body.add(jacket);
    const shirtMesh = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.42, 0.12), shirt);
    shirtMesh.position.set(0.08, 1.22, 0); body.add(shirtMesh);
    const bow = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.06), mat(0x8e1d3a));
    bow.position.set(0.16, 1.42, 0); body.add(bow);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 14), mat(0xe6c2a0));
    head.position.set(0.06, 1.78, 0); body.add(head);
    const mustache = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.06), mat(0x2a2118));
    mustache.position.set(0.26, 1.7, 0); body.add(mustache);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.045, 16), cloth);
    brim.position.y = 2.02; body.add(brim);
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.42, 14), cloth);
    hat.position.y = 2.24; body.add(hat);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.06, 14), accent);
    band.position.y = 2.08; body.add(band);
    const wand = new THREE.Group();
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 1.15, 8), mat(0x4a3424));
    stick.rotation.z = Math.PI / 2; wand.add(stick);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 10), new THREE.MeshBasicMaterial({ color: 0xf6e7ff }));
    tip.position.x = 0.62; wand.add(tip);
    wand.position.set(0.45, 1.15, -0.2);
    body.add(wand);
    g.userData.weapon = wand;
  } else if (heroId === 'stone') {
    const rock = mat(0xc47a45, { roughness: 0.92 });
    const rockDark = mat(0x8d4e2e, { roughness: 0.95 });
    const torso = new THREE.Mesh(new THREE.DodecahedronGeometry(0.48, 0), rock);
    torso.scale.set(1.15, 1.25, 0.95);
    torso.position.y = 1.15; body.add(torso);
    const hip = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.28, 0.42), rockDark);
    hip.position.y = 0.62; body.add(hip);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.38, 4, 8), rock);
      leg.position.set(0.02, 0.32, s * 0.18); body.add(leg);
      const arm = new THREE.Mesh(new THREE.DodecahedronGeometry(0.16, 0), rock);
      arm.scale.set(1.1, 1.8, 1);
      arm.position.set(0.08, 1.15, s * 0.48); body.add(arm);
      const fist = new THREE.Mesh(new THREE.DodecahedronGeometry(0.12, 0), rockDark);
      fist.position.set(0.28, 1.05, s * 0.52); body.add(fist);
    }
    const head = new THREE.Mesh(new THREE.DodecahedronGeometry(0.28, 0), rock);
    head.position.set(0.08, 1.78, 0); body.add(head);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.08), rockDark);
    brow.position.set(0.28, 1.84, 0); body.add(brow);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x1c2744));
    cap.position.set(-0.02, 1.98, 0); body.add(cap);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.045, 14), mat(0x1c2744));
    brim.scale.set(1.35, 1, 1);
    brim.position.set(-0.28, 1.96, 0); body.add(brim);
    const held = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.32, 0),
      new THREE.MeshStandardMaterial({ color: 0x8a5a3a, roughness: 0.9, emissive: 0x000000 }),
    );
    held.position.set(0.72, 1.48, 0.05);
    held.visible = false;
    body.add(held);
    g.userData.heldRock = held;
    const fists = new THREE.Group();
    fists.position.set(0.35, 1.05, 0);
    body.add(fists);
    g.userData.weapon = fists;
  } else if (heroId === 'shock') {
    const cloth = mat(0x2a62c9);
    const pants = mat(0xf3efe4);
    const hair = mat(0xc42332);
    const skinTone = mat(0xf0c2a0);
    const leather = mat(0x5a3a24);
    const steel = mat(0xd5dde6, { metalness: 0.65, roughness: 0.28 });

    for (const s of [-1, 1]) {
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.16), leather);
      boot.position.set(0.02, 0.1, s * 0.14);
      body.add(boot);
    }
    const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.55, 10), pants);
    legs.position.y = 0.42; body.add(legs);
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.045, 6, 14), leather);
    belt.rotation.x = Math.PI / 2; belt.position.y = 0.72; body.add(belt);
    const tunic = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.42, 6, 12), cloth);
    tunic.position.y = 1.12; body.add(tunic);
    const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.38, 0.42, 10), cloth);
    skirt.position.y = 0.78; body.add(skirt);
    const collar = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.22), pants);
    collar.position.set(0.12, 1.42, 0); body.add(collar);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 14), skinTone);
    head.position.set(0.04, 1.72, 0); body.add(head);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 6, 14), hair);
    band.rotation.y = Math.PI / 2; band.rotation.z = Math.PI / 2;
    band.position.set(0.02, 1.84, 0); body.add(band);
    const scarf = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.1), hair);
    scarf.position.set(-0.22, 1.48, 0); body.add(scarf);

    const spikes = new THREE.Group();
    const spikeSpec = [
      [0.05, 0.62, 0, -0.55],
      [-0.02, 0.5, 0.14, -0.25],
      [-0.02, 0.5, -0.14, -0.25],
      [-0.12, 0.4, 0.08, 0.45],
      [-0.12, 0.4, -0.08, 0.45],
      [0.12, 0.32, 0, -1.15],
    ];
    for (const [x, h, z, tilt] of spikeSpec) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.07, h, 6), hair);
      spike.position.set(x, 1.92 + h * 0.35, z);
      spike.rotation.z = tilt;
      spikes.add(spike);
    }
    body.add(spikes);
    g.userData.hair = spikes;

    const sword = new THREE.Group();
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.32, 8), leather);
    grip.rotation.z = Math.PI / 2; grip.position.x = 0.08; sword.add(grip);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.28), mat(0xe6c14a, { metalness: 0.6, roughness: 0.3 }));
    guard.position.x = 0.26; sword.add(guard);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.05, 0.1), steel);
    blade.position.x = 0.64; sword.add(blade);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.16, 4), steel);
    tip.rotation.z = -Math.PI / 2; tip.position.x = 1.08; sword.add(tip);
    sword.position.set(0.18, 0.95, 0.32);
    sword.rotation.z = -0.35;
    body.add(sword);
    g.userData.weapon = sword;

    const blurMat = new THREE.MeshBasicMaterial({ color: 0xfff6c8, transparent: true, opacity: 0.72, depthWrite: false });
    const orbit = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const whirl = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.05, 0.22), blurMat);
      whirl.position.set(Math.cos(i * Math.PI / 2) * 0.15, (i - 1.5) * 0.12, Math.sin(i * Math.PI / 2) * 0.15);
      whirl.rotation.y = i * Math.PI / 2;
      orbit.add(whirl);
    }
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.15, 1.7, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    core.position.y = 0.15;
    orbit.add(core);
    orbit.position.y = 1.05;
    orbit.visible = false;
    g.add(orbit);
    g.userData.orbit = orbit;

    const funnel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 1.45, 2.35, 18, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xdff6ff, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }),
    );
    funnel.position.y = 1.15;
    funnel.visible = false;
    g.add(funnel);
    g.userData.funnel = funnel;

    const dust = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 1.55, 28),
      new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    );
    dust.rotation.x = -Math.PI / 2;
    dust.position.y = 0.07;
    dust.visible = false;
    g.add(dust);
    g.userData.dust = dust;

    const ball = lightningBall();
    ball.visible = false;
    g.add(ball);
    g.userData.stormBall = ball;
  }

  body.traverse((m) => { if (m.isMesh) { m.castShadow = true; } });
  if (g.userData.wings) {
    for (const w of g.userData.wings) w.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  }

  // ground ring (team color)
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 32), new THREE.MeshBasicMaterial({ color: def.accent, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
  g.add(ring);
  g.userData.ring = ring;

  // facing arrow
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 3), new THREE.MeshBasicMaterial({ color: def.accent, transparent: true, opacity: 0.9 }));
  arrow.rotation.z = -Math.PI / 2; arrow.position.set(0.95, 0.05, 0);
  g.add(arrow);
  g.userData.arrow = arrow;

  // attack windup wedge, in front of the hero (local +X)
  const wind = new THREE.Mesh(
    new THREE.CircleGeometry(2.2, 18, -0.5, 1.0),
    new THREE.MeshBasicMaterial({ color: def.accent, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }),
  );
  wind.rotation.x = -Math.PI / 2;
  wind.position.y = 0.07;
  wind.visible = false;
  wind.renderOrder = 4;
  g.add(wind);
  g.userData.windup = wind;
  if (g.userData.weapon) g.userData.weapon.userData.baseZ = g.userData.weapon.rotation.z;

  // shield bubble
  const bubble = new THREE.Mesh(new THREE.SphereGeometry(1.1, 20, 20), new THREE.MeshStandardMaterial({ color: 0x8fd6ff, transparent: true, opacity: 0.3, roughness: 0.1, emissive: 0x3fa9ff, emissiveIntensity: 0.3 }));
  bubble.position.y = 1.1; bubble.visible = false; g.add(bubble);
  g.userData.bubble = bubble;

  // status rings
  const rootRing = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.06, 8, 24), mat(0x6b4b2a));
  rootRing.rotation.x = Math.PI / 2; rootRing.position.y = 0.1; rootRing.visible = false; g.add(rootRing);
  g.userData.rootRing = rootRing;
  const stunStars = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.05, 6, 16), new THREE.MeshBasicMaterial({ color: 0xffee66 }));
  stunStars.rotation.x = Math.PI / 2; stunStars.position.y = 2.5; stunStars.visible = false; g.add(stunStars);
  g.userData.stun = stunStars;
  const vulnMark = new THREE.Mesh(new THREE.OctahedronGeometry(0.2), new THREE.MeshBasicMaterial({ color: 0xffcc33 }));
  vulnMark.position.y = 2.7; vulnMark.visible = false; g.add(vulnMark);
  g.userData.vuln = vulnMark;
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.8, 8), new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.85 }));
  flame.position.y = 2.4; flame.visible = false; g.add(flame);
  g.userData.flame = flame;
  const fireAura = new THREE.Mesh(new THREE.RingGeometry(0.75, 1.15, 32), new THREE.MeshBasicMaterial({ color: 0xff5a1a, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
  fireAura.rotation.x = -Math.PI / 2; fireAura.position.y = 0.04; fireAura.visible = false; g.add(fireAura);
  g.userData.fireAura = fireAura;
  const soakMark = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), new THREE.MeshBasicMaterial({ color: 0x3fa9ff }));
  soakMark.position.y = 2.5; soakMark.visible = false; g.add(soakMark);
  g.userData.soak = soakMark;
  const empower = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.35, 16), new THREE.MeshBasicMaterial({ color: 0xffd166, side: THREE.DoubleSide }));
  empower.position.y = 2.3; empower.visible = false; g.add(empower);
  g.userData.empower = empower;
  const silence = makeIconSprite(drawSilenceX, 0.78);
  silence.position.y = 2.15; g.add(silence);
  g.userData.silence = silence;
  const poisons = [];
  for (let i = 0; i < 3; i++) {
    const poison = makeIconSprite(drawPoison, 0.5);
    poison.position.y = 2.45;
    g.add(poison);
    poisons.push(poison);
  }
  g.userData.poisons = poisons;
  const venomReady = makeIconSprite(drawVenomReady, 0.48);
  venomReady.position.set(-0.55, 2.7, 0);
  g.add(venomReady);
  g.userData.venomReady = venomReady;
  const hasteRing = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.95, 24), new THREE.MeshBasicMaterial({ color: 0x58d68d, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  hasteRing.rotation.x = -Math.PI / 2; hasteRing.position.y = 0.05; hasteRing.visible = false; g.add(hasteRing);
  g.userData.haste = hasteRing;
  const dodgeRing = new THREE.Mesh(new THREE.RingGeometry(0.86, 1.08, 28), new THREE.MeshBasicMaterial({ color: 0xfff6d0, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  dodgeRing.rotation.x = -Math.PI / 2; dodgeRing.position.y = 0.08; dodgeRing.visible = false; g.add(dodgeRing);
  g.userData.dodge = dodgeRing;
  const aside = new THREE.Group();
  const asideGhost = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 0.72, 5, 10),
    new THREE.MeshBasicMaterial({ color: 0xfff6d0, transparent: true, opacity: 0.4, depthWrite: false }),
  );
  asideGhost.position.y = 1.15;
  aside.add(asideGhost);
  const asideMark = new THREE.Mesh(
    new THREE.ConeGeometry(0.14, 0.32, 3),
    new THREE.MeshBasicMaterial({ color: 0xfff1a8 }),
  );
  asideMark.rotation.z = -Math.PI / 2;
  asideMark.position.set(-0.85, 1.25, 0);
  aside.add(asideMark);
  aside.visible = false;
  g.add(aside);
  g.userData.aside = aside;
  g.userData.asideGhost = asideGhost;
  const ward = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.04, 8, 28), new THREE.MeshBasicMaterial({ color: 0xf0d78c, transparent: true, opacity: 0.9 }));
  ward.rotation.x = Math.PI / 2; ward.position.y = 1.25; ward.visible = false; g.add(ward);
  g.userData.ward = ward;
  const leashMark = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.05, 6, 16), new THREE.MeshBasicMaterial({ color: 0xff7ad9 }));
  leashMark.rotation.x = Math.PI / 2; leashMark.position.y = 1.55; leashMark.visible = false; g.add(leashMark);
  g.userData.leash = leashMark;
  const phase = new THREE.Group();
  const phaseDisc = new THREE.Mesh(
    new THREE.CircleGeometry(1.15, 32),
    new THREE.MeshBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }),
  );
  phaseDisc.rotation.x = -Math.PI / 2; phaseDisc.position.y = 0.04; phase.add(phaseDisc);
  const phaseRings = [];
  for (let i = 0; i < 3; i++) {
    const inner = 0.32 + i * 0.28;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(inner, inner + 0.055, 40),
      new THREE.MeshBasicMaterial({
        color: i === 1 ? 0xfff3a0 : 0xe7b4ff,
        transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06 + i * 0.015;
    phase.add(ring);
    phaseRings.push(ring);
  }
  const phaseMotes = [];
  for (let i = 0; i < 8; i++) {
    const mote = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xf7e9ff, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    mote.userData.ang = (i / 8) * Math.PI * 2;
    phase.add(mote);
    phaseMotes.push(mote);
  }
  phase.visible = false;
  g.add(phase);
  g.userData.phase = phase;
  g.userData.phaseDisc = phaseDisc;
  g.userData.phaseRings = phaseRings;
  g.userData.phaseMotes = phaseMotes;

  const rabbit = buildRabbit();
  rabbit.visible = false;
  g.add(rabbit);
  g.userData.rabbit = rabbit;

  const plate = new NamePlate('', def.accent);
  plate.sprite.position.y = 3.2;
  g.add(plate.sprite);
  g.userData.plate = plate;

  return g;
}

// ---------------------------------------------------------------- renderer
function hpBar(width, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 160; canvas.height = 28;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(width, width * (28 / 160), 1);
  sprite.renderOrder = 14;
  const g = new THREE.Group();
  g.add(sprite);
  g.userData.bar = { canvas, ctx: canvas.getContext('2d'), tex, color: '#' + color.toString(16).padStart(6, '0'), last: '' };
  return g;
}

function setHpBar(bar, hp, maxHp) {
  if (!bar || !maxHp) return;
  bar.visible = hp > 0;
  const plate = bar.userData.bar;
  const key = `${hp}|${maxHp}`;
  if (plate.last === key) return;
  plate.last = key;
  const c = plate.ctx, W = 160, H = 28;
  c.clearRect(0, 0, W, H);
  c.fillStyle = 'rgba(0,0,0,.75)';
  c.fillRect(2, 4, W - 4, H - 8);
  const seg = (W - 8) / maxHp;
  for (let i = 0; i < maxHp; i++) {
    c.fillStyle = i < hp ? plate.color : '#3a2a2a';
    c.fillRect(4 + i * seg + 1, 6, Math.max(1, seg - 2), H - 12);
  }
  plate.tex.needsUpdate = true;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d0a0f);

    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.camFollow = new THREE.Vector3(0, 0, 0);
    this.shake = 0;
    this.clock = new THREE.Clock();
    this.time = 0;

    this.heroMeshes = {};
    this.projMeshes = new Map();
    this.zoneMeshes = new Map();
    this.fx = [];
    this.snapshots = [];
    this.myId = null;
    this.playersMeta = {};
    this.lastSnap = null;
    this.ready = false;

    this.setupLights();
    this.setupArena();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.throwArc = new THREE.Group();
    this.throwArc.visible = false;
    const arcLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xffb27a }),
    );
    const land = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.52, 24),
      new THREE.MeshBasicMaterial({ color: 0xffb27a, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    );
    land.rotation.x = -Math.PI / 2;
    land.position.y = 0.08;
    const target = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.3, 20),
      new THREE.MeshBasicMaterial({ color: 0xfff4c2, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
    );
    target.rotation.x = -Math.PI / 2;
    target.position.y = 0.07;
    this.throwArc.add(arcLine);
    this.throwArc.add(land);
    this.throwArc.add(target);
    this.throwArc.userData.line = arcLine;
    this.throwArc.userData.land = land;
    this.throwArc.userData.target = target;
    this.scene.add(this.throwArc);
    this.updateCamera(0);
  }

  showThrowArc(x, z, facing, anchor, cursor) {
    if (x == null || !anchor || !cursor) { this.throwArc.visible = false; return; }
    const a = HEROES.stone.abilities.w;
    const arc = throwCurve(x, z, facing, anchor, [cursor[0] - anchor[0], cursor[1] - anchor[1]], a.range, a.curveCap);
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const p = quadPoint(arc.p0, arc.p1, arc.p2, i / 16);
      pts.push(new THREE.Vector3(p[0], 0.12, p[1]));
    }
    this.throwArc.userData.line.geometry.dispose();
    this.throwArc.userData.line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.throwArc.userData.land.position.set(arc.p2[0], 0.08, arc.p2[1]);
    const target = arc.target || arc.p2;
    const off = Math.hypot(arc.p2[0] - target[0], arc.p2[1] - target[1]);
    this.throwArc.userData.target.position.set(target[0], 0.07, target[1]);
    this.throwArc.userData.target.visible = off > 0.3;
    this.throwArc.visible = true;
  }

  setupLights() {
    const hemi = new THREE.HemisphereLight(0xffe0c0, 0x401008, 0.9);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.6);
    sun.position.set(18, 30, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = ARENA.wallRadius + 6;
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s; sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 80;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    this.sun = sun;
    const lavaLight = new THREE.PointLight(0xff5a1a, 1.2, 60, 1.2);
    lavaLight.position.set(0, 2, 0);
    this.scene.add(lavaLight);
    this.lavaLight = lavaLight;
  }

  setupArena() {
    const R = ARENA.wallRadius;
    // calm backdrop plane
    this.lavaMat = new THREE.ShaderMaterial(backdropShader);
    this.lavaMat.uniforms.uRadius.value = R;
    const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), this.lavaMat);
    backdrop.rotation.x = -Math.PI / 2; backdrop.position.y = -1.2;
    this.scene.add(backdrop);

    // island
    this.islandMat = new THREE.ShaderMaterial(islandShader);
    this.islandMat.uniforms.uRadius.value = ARENA.radius;
    this.islandMat.uniforms.uSafeR.value = ARENA.radius;
    const top = new THREE.Mesh(new THREE.CircleGeometry(R, 96), this.islandMat);
    top.rotation.x = -Math.PI / 2; top.position.y = 0;
    top.receiveShadow = true;
    this.scene.add(top);
    const side = new THREE.Mesh(new THREE.CylinderGeometry(R, R - 1.4, 1.6, 96, 1, true), mat(0x2b2220));
    side.position.y = -0.8;
    this.scene.add(side);
    // shadow catcher (ShaderMaterial does not receive shadows) – a subtle translucent disc
    const catcher = new THREE.Mesh(new THREE.CircleGeometry(R, 96), new THREE.ShadowMaterial({ opacity: 0.35 }));
    catcher.rotation.x = -Math.PI / 2; catcher.position.y = 0.01; catcher.receiveShadow = true;
    this.scene.add(catcher);

    this.propGroup = new THREE.Group();
    this.scene.add(this.propGroup);
  }

  setProps(props) {
    this.propGroup.clear();
    this.propMeshes = new Map();
    for (const p of props) this.createProp(p);
  }

  createProp(p) {
    let m;
    if (p.kind === 'pillar') {
      m = new THREE.Group();
      const col = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.85, p.r, 3.2, 10), mat(0x4a4046));
      col.position.y = 1.6; m.add(col);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 1.05, p.r * 0.9, 0.35, 10), mat(0x5a5056));
      cap.position.y = 3.3; m.add(cap);
      const ember = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 10), new THREE.MeshBasicMaterial({ color: 0xff8a2a }));
      ember.position.y = 3.6; m.add(ember);
    } else if (p.kind === 'stump') {
      m = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.8, p.r, 1.0, 9), mat(0x3a2a1a));
      m.position.y = 0.5;
    } else if (p.kind === 'patrol') {
      m = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r * 0.85, 0.18, 12), mat(0x6a5030));
      base.position.y = 0.1; m.add(base);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1.55, 8), mat(0x8a5a32));
      post.position.y = 0.9; m.add(post);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.36, 12, 12), mat(0xc4552a));
      head.position.y = 1.8; m.add(head);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.1, 0.12), mat(0x6b4a2a));
      arm.position.y = 1.4; m.add(arm);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.045, 6, 20), new THREE.MeshBasicMaterial({ color: 0xe7b4ff }));
      band.rotation.x = Math.PI / 2; band.position.y = 0.16; m.add(band);
    } else if (p.kind === 'shed' || p.kind === 'meteor') {
      m = new THREE.Group();
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(p.r, 0), mat(p.kind === 'meteor' ? 0x6a3a28 : 0x8a5a3a, { roughness: 0.95 }));
      rock.position.y = p.r * 0.85;
      m.add(rock);
      if (p.kind === 'meteor') {
        const flame = new THREE.Mesh(new THREE.ConeGeometry(p.r * 0.55, p.r * 1.1, 7), new THREE.MeshBasicMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.85 }));
        flame.position.y = p.r * 1.7;
        m.add(flame);
        m.userData.flame = flame;
      }
    } else {
      m = new THREE.Mesh(new THREE.DodecahedronGeometry(p.r * 1.15, 0), mat(0x55504e));
      m.position.y = p.r * 0.55;
      m.rotation.set(Math.random() * 0.4, Math.random() * Math.PI, Math.random() * 0.3);
    }
    const root = new THREE.Group();
    root.add(m);
    const bar = hpBar(Math.max(1.7, p.r * 2.1), p.kind === 'patrol' ? 0xe7b4ff : 0xd9c38a);
    bar.position.y = p.kind === 'pillar' ? 3.95 : p.kind === 'stump' ? 1.3 : p.kind === 'patrol' ? 2.35 : p.r * 1.7;
    root.add(bar);
    if (p.permanent) bar.visible = false;
    root.userData.hpBar = bar;
    root.userData.kind = p.kind;
    root.userData.permanent = !!p.permanent;
    root.position.set(p.x, 0, p.z);
    root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.propGroup.add(root);
    if (p.id) this.propMeshes.set(p.id, root);
    return root;
  }

  swapHero(id, heroId) {
    const prev = this.heroMeshes[id];
    const name = prev?.userData?.plate?.name || this.playersMeta[id]?.name || '';
    const g = buildHero(heroId);
    g.userData.plate.name = name;
    if (prev) {
      g.position.copy(prev.position);
      g.rotation.copy(prev.rotation);
      this.scene.remove(prev);
    }
    this.heroMeshes[id] = g;
    this.scene.add(g);
    if (this.playersMeta[id]) this.playersMeta[id].hero = heroId;
    return g;
  }

  startMatch(players, myId) {
    this.myId = myId;
    this.playersMeta = {};
    for (const id of Object.keys(this.heroMeshes)) { this.scene.remove(this.heroMeshes[id]); }
    this.heroMeshes = {};
    this.clearEntities();
    for (const p of players) {
      this.playersMeta[p.id] = p;
      const g = buildHero(p.hero);
      g.userData.plate.name = p.name;
      this.heroMeshes[p.id] = g;
      this.scene.add(g);
    }
    this.snapshots = [];
    this.lastSnap = null;
    this.ready = true;
  }

  clearEntities() {
    for (const m of this.projMeshes.values()) this.scene.remove(m);
    for (const m of this.zoneMeshes.values()) this.scene.remove(m);
    for (const f of this.fx) this.scene.remove(f.obj);
    this.projMeshes.clear(); this.zoneMeshes.clear(); this.fx = [];
  }

  endMatch() {
    this.ready = false;
    this.clearEntities();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.left = -VIEW_HEIGHT * aspect / 2;
    this.camera.right = VIEW_HEIGHT * aspect / 2;
    this.camera.top = VIEW_HEIGHT / 2;
    this.camera.bottom = -VIEW_HEIGHT / 2;
    this.camera.updateProjectionMatrix();
  }

  updateCamera(dt) {
    this.camFollow.lerp(this.camTarget, 1 - Math.exp(-dt * 6));
    const dist = 60;
    const dir = new THREE.Vector3(Math.cos(ISO_PITCH) * Math.sin(ISO_YAW), Math.sin(ISO_PITCH), Math.cos(ISO_PITCH) * Math.cos(ISO_YAW));
    const pos = this.camFollow.clone().addScaledVector(dir, dist);
    if (this.shake > 0) {
      pos.x += (Math.random() - 0.5) * this.shake;
      pos.z += (Math.random() - 0.5) * this.shake;
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }
    this.camera.position.copy(pos);
    this.camera.lookAt(this.camFollow);
    this.camera.updateMatrixWorld();
  }

  screenToGround(sx, sy) {
    const ndc = new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, out) ? out : null;
  }

  cameraAxes() {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0; forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    return { forward, right };
  }

  // --------------------------------------------------------- snapshots
  pushSnapshot(snap) {
    snap.recv = performance.now() / 1000;
    this.snapshots.push(snap);
    if (this.snapshots.length > 30) this.snapshots.shift();
    this.lastSnap = snap;
    for (const ev of snap.ev) this.handleEvent(ev, snap);
  }

  interpolated() {
    const now = performance.now() / 1000 - INTERP_DELAY;
    const s = this.snapshots;
    if (s.length === 0) return null;
    if (s.length === 1 || now >= s[s.length - 1].recv) return { a: s[s.length - 1], b: s[s.length - 1], t: 0 };
    for (let i = s.length - 2; i >= 0; i--) {
      if (now >= s[i].recv) {
        const span = s[i + 1].recv - s[i].recv || 1;
        return { a: s[i], b: s[i + 1], t: Math.min(1, (now - s[i].recv) / span) };
      }
    }
    return { a: s[0], b: s[0], t: 0 };
  }

  // ------------------------------------------------------------ events
  handleEvent(ev, snap) {
    switch (ev.e) {
      case 'swing': this.fxSwing(ev); attackSwing(); break;
      case 'shoot': attackShot(); break;
      case 'hit': {
        if (ev.absorbed && !ev.amount) this.floatText(ev.x, ev.z, 'BLOCK', '#8fd6ff');
        else if (ev.amount) this.floatText(ev.x, ev.z, `-${ev.amount}`, ev.kind === 'burn' || ev.kind === 'fire' || ev.kind === 'lava' ? '#ff8a3a' : ev.kind === 'poison' ? '#7dce4a' : ev.kind === 'water' ? '#8fe3ff' : ev.kind === 'shock' ? '#ffe56a' : '#ff4d4d');
        this.fxBurst(ev.x, ev.z, 0.5, ev.kind === 'water' ? 0x3fa9ff : 0xff4d4d, 0.25);
        if (ev.pid === this.myId) this.shake = Math.max(this.shake, 0.4 + ev.amount * 0.15);
        if (ev.amount && ev.kind !== 'lava' && ev.kind !== 'burn') attackHit(ev.amount >= 3);
        break;
      }
      case 'heal': if (ev.amount) this.floatText(ev.x, ev.z, `+${ev.amount}`, '#58d68d'); break;
      case 'text': this.floatText(ev.x, ev.z, ev.text, ev.color || '#fff'); break;
      case 'explode': this.fxRing(ev.x, ev.z, ev.r, new THREE.Color(ev.color || '#ff5a1a'), 0.45); this.shake = Math.max(this.shake, 0.6); break;
      case 'roar': this.fxRing(ev.x, ev.z, 2.2, new THREE.Color('#ffd166'), 0.5); break;
      case 'ult': {
        const ultColor = { minotaur: '#ff5a1a', tidebinder: '#8fe3ff', fuck: '#e7b4ff', python: '#9be05a', monk: '#f0d78c', illusionist: '#d7a6ff', stone: '#ff6a1a', shock: '#ffe56a' }[ev.hero] || '#8fe3ff';
        this.fxRing(ev.x, ev.z, 3.5, new THREE.Color(ultColor), 0.7); this.shake = Math.max(this.shake, 0.8); break;
      }
      case 'death': this.fxRing(ev.x, ev.z, 2.5, new THREE.Color('#ffffff'), 0.8); this.shake = 1.2; break;
      case 'pickup': this.fxRing(ev.x, ev.z, 1.2, new THREE.Color('#58d68d'), 0.4); break;
      case 'propbreak': this.fxBurst(ev.x, ev.z, 0.8, 0xb8a090, 0.35); break;
      case 'trap': this.fxBurst(ev.x, ev.z, 1.0, 0xd9c38a, 0.4); break;
      case 'shed': {
        for (let i = 0; i < 8; i++) {
          const chip = new THREE.Mesh(new THREE.DodecahedronGeometry(0.08 + Math.random() * 0.06, 0), mat(0x8a5a3a));
          chip.position.set(ev.x, 1.2, ev.z);
          this.scene.add(chip);
          this.fx.push({ obj: chip, life: 0.45, max: 0.45, kind: 'chip', vx: (Math.random() - 0.5) * 3, vz: (Math.random() - 0.5) * 3, vy: 2 + Math.random() });
        }
        break;
      }
      case 'cast': {
        const m = this.heroMeshes[ev.pid];
        if (m && ev.duration > 0) this.fxCastCircle(m, ev.duration, ev.key);
        break;
      }
      default: break;
    }
  }

  floatText(x, z, text, color) {
    const s = makeTextSprite(text, color, 56);
    s.position.set(x, 2.6, z);
    this.scene.add(s);
    this.fx.push({ obj: s, life: 0.9, max: 0.9, kind: 'text', vy: 2.2 });
  }

  fxSwing(ev) {
    const geo = new THREE.CircleGeometry(ev.range, 24, -ev.f - ev.angle, ev.angle * 2);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(ev.color), transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(ev.x, 0.08, ev.z);
    this.scene.add(m);
    this.fx.push({ obj: m, life: ev.big ? 0.35 : 0.22, max: ev.big ? 0.35 : 0.22, kind: 'fade' });
  }

  fxRing(x, z, r, color, dur) {
    const m = new THREE.Mesh(new THREE.RingGeometry(r * 0.85, r, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.1, z);
    m.scale.setScalar(0.2);
    this.scene.add(m);
    this.fx.push({ obj: m, life: dur, max: dur, kind: 'ring' });
  }

  fxBurst(x, z, r, color, dur) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 12), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false }));
    m.position.set(x, 1.2, z);
    this.scene.add(m);
    this.fx.push({ obj: m, life: dur, max: dur, kind: 'burst' });
  }

  fxCastCircle(heroMesh, duration, key) {
    const color = key === 'r' ? 0xff4de0 : 0xffd166;
    const m = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.06;
    heroMesh.add(m);
    this.fx.push({ obj: m, life: duration, max: duration, kind: 'castring', parent: heroMesh });
  }

  // ------------------------------------------------------- entity meshes
  makeProjMesh(p) {
    let m;
    const owner = this.playersMeta[p.o];
    const color = owner ? HEROES[owner.hero].accent : 0xffffff;
    if (p.k === 'bolt' || p.k === 'tetherbolt') {
      m = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6), mat(p.k === 'tetherbolt' ? 0xd9c38a : 0x8a6a3a));
      shaft.rotation.z = Math.PI / 2; m.add(shaft);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.25, 6), mat(0xcccccc, { metalness: 0.6 }));
      tip.rotation.z = -Math.PI / 2; tip.position.x = 0.55; m.add(tip);
      if (p.k === 'tetherbolt') {
        const rope = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xd9c38a }));
        this.scene.add(rope);
        m.userData.rope = rope;
      }
    } else if (p.k === 'orb' || p.k === 'forbes') {
      const r = p.k === 'forbes' ? 0.42 : 0.26;
      m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 14), new THREE.MeshStandardMaterial({ color: 0xe7b4ff, emissive: 0xc084fc, emissiveIntensity: p.k === 'forbes' ? 1.3 : 0.8, roughness: 0.15 }));
    } else if (p.k === 'dart') {
      m = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.7, 6), mat(0x3f6a28));
      shaft.rotation.z = Math.PI / 2; m.add(shaft);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 6), new THREE.MeshBasicMaterial({ color: 0xc6f25a }));
      tip.rotation.z = -Math.PI / 2; tip.position.x = 0.42; m.add(tip);
    } else if (p.k === 'spark') {
      m = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 10), new THREE.MeshBasicMaterial({ color: 0xf6e7ff }));
    } else if (p.k === 'magebolt') {
      m = new THREE.Group();
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 12), new THREE.MeshStandardMaterial({ color: 0xb45cff, emissive: 0x7a2cff, emissiveIntensity: 0.8, roughness: 0.2 }));
      m.add(core);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 10), new THREE.MeshBasicMaterial({ color: 0xd7a6ff, transparent: true, opacity: 0.35, depthWrite: false }));
      m.add(glow);
      m.userData.core = core;
      m.userData.glow = glow;
    } else if (p.k === 'keg') {
      m = new THREE.Group();
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.44, 0.72, 10), mat(0x6b3a1f));
      barrel.position.y = 0.36; m.add(barrel);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.1, 10), mat(0x2a2a2e, { metalness: 0.7, roughness: 0.4 }));
      band.position.y = 0.36; m.add(band);
      const spark = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffcc66 }));
      spark.position.y = 0.78; m.add(spark);
    } else if (p.k === 'stone' || p.k === 'firestone') {
      m = new THREE.Group();
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(p.r || 0.45, 0), mat(p.k === 'firestone' || p.flame ? 0x6a3a28 : 0x8a5a3a, { roughness: 0.95 }));
      m.add(rock);
      if (p.k === 'firestone' || p.flame) {
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.55, 7), new THREE.MeshBasicMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.9 }));
        flame.position.y = 0.45;
        m.add(flame);
        m.userData.flame = flame;
      }
    } else if (p.k === 'brine') {
      m = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 12), new THREE.MeshStandardMaterial({ color: 0x8fe3ff, emissive: 0x3fa9ff, emissiveIntensity: 0.9, roughness: 0.2 }));
    } else if (p.k === 'wave') {
      m = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 2.6, 12, 1, false, 0, Math.PI), new THREE.MeshStandardMaterial({ color: 0x4fb8ff, emissive: 0x1f6fbf, emissiveIntensity: 0.6, transparent: true, opacity: 0.75, roughness: 0.1, side: THREE.DoubleSide }));
      m.rotation.x = Math.PI / 2; m.rotation.y = Math.PI / 2;
      const grp = new THREE.Group(); grp.add(m); m.position.y = 0.6; m = grp;
    } else if (p.k === 'tsunami') {
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 2.4, 6.0, 16, 1, false, 0, Math.PI), new THREE.MeshStandardMaterial({ color: 0x3fa9ff, emissive: 0x1f5fbf, emissiveIntensity: 0.8, transparent: true, opacity: 0.7, roughness: 0.05, side: THREE.DoubleSide }));
      wall.rotation.x = Math.PI / 2; wall.rotation.y = Math.PI / 2; wall.position.y = 1.5;
      const foam = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.35, 8, 24, Math.PI), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
      foam.rotation.set(Math.PI / 2, 0, Math.PI / 2); foam.position.set(0.4, 2.9, 0);
      m = new THREE.Group(); m.add(wall); m.add(foam);
    } else {
      m = new THREE.Mesh(new THREE.SphereGeometry(p.r, 10, 10), new THREE.MeshBasicMaterial({ color }));
    }
    m.position.set(p.x, 1.0, p.z);
    m.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.scene.add(m);
    return m;
  }

  makeZoneMesh(z) {
    let m;
    if (z.k === 'fire') {
      m = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(z.r, 20), new THREE.MeshBasicMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.7, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2; disc.position.y = 0.05; m.add(disc);
      for (let i = 0; i < 4; i++) {
        const f = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.7, 6), new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffb347 : 0xff5a1a, transparent: true, opacity: 0.85 }));
        const a = (i / 4) * Math.PI * 2;
        f.position.set(Math.cos(a) * z.r * 0.45, 0.4, Math.sin(a) * z.r * 0.45);
        m.add(f);
      }
    } else if (z.k === 'trap') {
      m = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(z.r, z.r, 0.12, 12), mat(0x2a2a2e, { metalness: 0.7, roughness: 0.4 }));
      base.position.y = 0.06; m.add(base);
      for (const s of [-1, 1]) {
        const jaw = new THREE.Mesh(new THREE.TorusGeometry(z.r * 0.8, 0.06, 6, 12, Math.PI), mat(0x8a8a90, { metalness: 0.8, roughness: 0.3 }));
        jaw.rotation.x = -Math.PI / 2; jaw.rotation.z = s > 0 ? 0 : Math.PI; jaw.position.y = 0.15;
        m.add(jaw);
      }
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff3030 }));
      light.position.y = 0.2; m.add(light);
      m.userData.light = light;
    } else if (z.k === 'undertow') {
      m = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(z.r * 0.9, z.r, 40), new THREE.MeshBasicMaterial({ color: 0x3fa9ff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06; m.add(ring);
      const swirl = new THREE.Mesh(new THREE.RingGeometry(0.2, z.r * 0.85, 40, 1, 0, Math.PI * 1.5), new THREE.MeshBasicMaterial({ color: 0x8fe3ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
      swirl.rotation.x = -Math.PI / 2; swirl.position.y = 0.07; swirl.visible = false; m.add(swirl);
      m.userData.swirl = swirl; m.userData.ring = ring;
    } else if (z.k === 'tether') {
      m = new THREE.Group();
      const stake = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 6), mat(0xd9c38a));
      stake.position.y = 0.25; m.add(stake);
      const rope = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xd9c38a }));
      this.scene.add(rope);
      m.userData.rope = rope;
    } else if (z.k === 'leash') {
      m = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(z.r * 0.92, z.r, 40), new THREE.MeshBasicMaterial({ color: 0xe7b4ff, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06; m.add(ring);
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 10), new THREE.MeshBasicMaterial({ color: 0xff7ad9 }));
      core.position.y = 0.35; m.add(core);
      const rope = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xe7b4ff }));
      this.scene.add(rope);
      m.userData.rope = rope;
    } else if (z.k === 'whip') {
      m = new THREE.Group();
      const halfL = z.r;
      const halfW = z.w ?? z.r;
      const disc = new THREE.Mesh(new THREE.PlaneGeometry(halfL * 2, halfW * 2), new THREE.MeshBasicMaterial({ color: 0xc6f25a, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
      disc.rotation.x = -Math.PI / 2; disc.position.y = 0.06; m.add(disc);
      const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-halfL, 0.08, -halfW), new THREE.Vector3(halfL, 0.08, -halfW),
        new THREE.Vector3(halfL, 0.08, halfW), new THREE.Vector3(-halfL, 0.08, halfW),
      ]), new THREE.LineBasicMaterial({ color: 0xe8ff9a, transparent: true }));
      m.add(edge);
      m.userData.disc = disc;
      m.userData.ring = edge;
      m.rotation.y = -(z.f || 0);
    } else if (z.k === 'pole') {
      m = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(z.r, 28), new THREE.MeshBasicMaterial({ color: 0xf0d78c, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
      disc.rotation.x = -Math.PI / 2; disc.position.y = 0.06; m.add(disc);
      const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(0.2, z.r * 0.82), z.r, 32), new THREE.MeshBasicMaterial({ color: 0xfff1c2, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08; m.add(ring);
      m.userData.disc = disc;
      m.userData.ring = ring;
    } else if (z.k === 'bite') {
      m = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(z.r, 28), new THREE.MeshBasicMaterial({ color: 0x9be05a, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide }));
      disc.rotation.x = -Math.PI / 2; disc.position.y = 0.06; m.add(disc);
      const ring = new THREE.Mesh(new THREE.RingGeometry(z.r * 0.82, z.r, 32), new THREE.MeshBasicMaterial({ color: 0xe8ff9a, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08; m.add(ring);
      m.userData.disc = disc;
      m.userData.ring = ring;
    } else if (z.k === 'cloud') {
      m = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(z.r, 32), new THREE.MeshBasicMaterial({ color: 0x3f8a32, transparent: true, opacity: 0.35, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2; disc.position.y = 0.05; m.add(disc);
      for (let i = 0; i < 7; i++) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(0.55 + (i % 3) * 0.15, 10, 10), new THREE.MeshBasicMaterial({ color: i % 2 ? 0x9be05a : 0x2f6a38, transparent: true, opacity: 0.35, depthWrite: false }));
        const a = (i / 7) * Math.PI * 2;
        puff.position.set(Math.cos(a) * z.r * 0.55, 0.7, Math.sin(a) * z.r * 0.55);
        m.add(puff);
      }
    } else if (z.k === 'healthpack') {
      m = new THREE.Group();
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.22, 0.22), new THREE.MeshStandardMaterial({ color: 0x58d68d, emissive: 0x2a8a4a, emissiveIntensity: 0.8 }));
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.7), new THREE.MeshStandardMaterial({ color: 0x58d68d, emissive: 0x2a8a4a, emissiveIntensity: 0.8 }));
      a.position.y = 0.85; b.position.y = 0.85; m.add(a); m.add(b);
      const glow = new THREE.Mesh(new THREE.CircleGeometry(1.5, 24), new THREE.MeshBasicMaterial({ color: 0x58d68d, transparent: true, opacity: 0.35, depthWrite: false }));
      glow.rotation.x = -Math.PI / 2; glow.position.y = 0.05; m.add(glow);
      m.userData.hpBar = hpBar(1.8, 0x58d68d);
      m.userData.hpBar.position.y = 1.35;
      m.add(m.userData.hpBar);
    } else if (z.k === 'strike') {
      m = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(z.r, 28), new THREE.MeshBasicMaterial({ color: 0xffe56a, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
      disc.rotation.x = -Math.PI / 2; disc.position.y = 0.05; m.add(disc);
      const ring = new THREE.Mesh(new THREE.RingGeometry(z.r * 0.78, z.r, 32), new THREE.MeshBasicMaterial({ color: 0xfff6c2, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08; m.add(ring);
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.14, 1.4, 6), new THREE.MeshBasicMaterial({ color: 0xfff1a8 }));
      bolt.position.y = 4; m.add(bolt);
      m.userData.bolt = bolt;
      m.userData.ring = ring;
      m.userData.disc = disc;
    } else if (z.k === 'luminaire') {
      m = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(z.r, 32), new THREE.MeshBasicMaterial({ color: 0x8fd4ff, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
      disc.rotation.x = -Math.PI / 2; disc.position.y = 0.05; m.add(disc);
      const ring = new THREE.Mesh(new THREE.RingGeometry(z.r * 0.86, z.r, 40), new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08; m.add(ring);
      m.userData.baseR = z.r;
      m.userData.ring = ring;
      m.userData.disc = disc;
    } else if (z.k === 'echo') {
      m = buildHero('shock');
      asGhost(m);
      if (m.userData.ring) m.userData.ring.visible = false;
      if (m.userData.arrow) m.userData.arrow.visible = false;
      if (m.userData.plate) m.userData.plate.sprite.visible = false;
      if (m.userData.windup) m.userData.windup.visible = false;
      if (m.userData.stormBall) m.userData.stormBall.visible = false;
      m.rotation.y = -(z.f || 0);
    } else if (z.k === 'ghost') {
      m = buildHero('illusionist');
      asGhost(m);
      if (m.userData.ring) m.userData.ring.visible = false;
      if (m.userData.arrow) m.userData.arrow.visible = false;
      if (m.userData.plate) m.userData.plate.sprite.visible = false;
      if (m.userData.windup) m.userData.windup.visible = false;
      m.rotation.y = -(z.f || 0);
    } else if (z.k === 'hat') {
      m = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(z.r, 32), new THREE.MeshBasicMaterial({ color: 0xb45cff, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
      disc.rotation.x = -Math.PI / 2; disc.position.y = 0.05; m.add(disc);
      const ring = new THREE.Mesh(new THREE.RingGeometry(z.r * 0.86, z.r, 36), new THREE.MeshBasicMaterial({ color: 0xf4efe4, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08; m.add(ring);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.05, 12), mat(0x14161c));
      brim.position.y = 0.35; m.add(brim);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.32, 12), mat(0x14161c));
      top.position.y = 0.52; m.add(top);
      m.userData.ring = ring;
      m.userData.disc = disc;
    } else if (z.k === 'disco') {
      m = new THREE.Group();
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), new THREE.MeshStandardMaterial({ color: 0xd9dde8, metalness: 0.85, roughness: 0.15, emissive: 0x6655aa, emissiveIntensity: 0.4 }));
      ball.position.y = 3.35; m.add(ball);
      const colors = [0xff4fd8, 0x7af0ff, 0xfff36a, 0xb45cff];
      for (let i = 0; i < 4; i++) {
        const beam = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.4, 5), new THREE.MeshBasicMaterial({ color: colors[i], transparent: true, opacity: 0.28, depthWrite: false }));
        beam.position.y = 2.5;
        beam.rotation.z = (i / 4) * Math.PI * 2;
        m.add(beam);
      }
      const ring = new THREE.Mesh(new THREE.RingGeometry(z.r * 0.9, z.r, 40), new THREE.MeshBasicMaterial({ color: 0xd7a6ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06; m.add(ring);
      m.userData.ball = ball;
      m.userData.ring = ring;
    } else if (z.k === 'meteor') {
      m = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(z.r, 36), new THREE.MeshBasicMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
      disc.rotation.x = -Math.PI / 2; disc.position.y = 0.05; m.add(disc);
      const ring = new THREE.Mesh(new THREE.RingGeometry(z.r * 0.9, z.r, 40), new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08; m.add(ring);
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7, 0), mat(0x6a3a28, { roughness: 0.8 }));
      rock.position.y = 8; m.add(rock);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.3, 8), new THREE.MeshBasicMaterial({ color: 0xff5a1a, transparent: true, opacity: 0.8 }));
      flame.position.y = 8.8; m.add(flame);
      m.userData.rock = rock;
      m.userData.flame = flame;
      m.userData.ring = ring;
    } else if (z.k === 'keg') {
      m = new THREE.Group();
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.44, 0.72, 10), mat(0x6b3a1f));
      barrel.position.y = 0.4; m.add(barrel);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.1, 10), mat(0x2a2a2e, { metalness: 0.7, roughness: 0.4 }));
      band.position.y = 0.42; m.add(band);
      const spark = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffcc66 }));
      spark.position.y = 0.85; m.add(spark);
      m.userData.spark = spark;
      m.userData.hpBar = hpBar(1.5, 0xff8a1a);
      m.userData.hpBar.position.y = 1.05;
      m.add(m.userData.hpBar);
    } else {
      m = new THREE.Mesh(new THREE.CircleGeometry(z.r, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 }));
      m.rotation.x = -Math.PI / 2;
    }
    m.position.set(z.x, 0, z.z);
    this.scene.add(m);
    return m;
  }

  removeObj(m) {
    this.scene.remove(m);
    if (m.userData.rope) this.scene.remove(m.userData.rope);
  }

  // ---------------------------------------------------------------- frame
  frame() {
    const dt = Math.min(0.1, this.clock.getDelta());
    this.time += dt;
    this.islandMat.uniforms.uTime.value = this.time;
    this.lavaMat.uniforms.uTime.value = this.time;
    this.lavaLight.intensity = 1.0 + Math.sin(this.time * 3) * 0.25;

    const interp = this.ready ? this.interpolated() : null;
    if (interp) this.applySnapshot(interp, dt);

    // transient fx
    for (const f of this.fx) {
      f.life -= dt;
      const k = Math.max(0, f.life / f.max);
      if (f.kind === 'fade') { f.obj.material.opacity = 0.75 * k; }
      else if (f.kind === 'ring') { f.obj.scale.setScalar(0.2 + (1 - k) * 0.8 + 0.2); f.obj.material.opacity = k; }
      else if (f.kind === 'burst') { f.obj.scale.setScalar(1 + (1 - k)); f.obj.material.opacity = 0.8 * k; }
      else if (f.kind === 'text') { f.obj.position.y += f.vy * dt; f.obj.material.opacity = Math.min(1, k * 2); }
      else if (f.kind === 'chip') {
        f.obj.position.x += f.vx * dt; f.obj.position.z += f.vz * dt; f.obj.position.y += f.vy * dt;
        f.vy -= 9 * dt;
        f.obj.scale.setScalar(Math.max(0.2, k));
      }
      else if (f.kind === 'castring') { f.obj.scale.setScalar(1.6 - 0.6 * (1 - k)); }
      if (f.life <= 0) { (f.parent || this.scene).remove(f.obj); }
    }
    this.fx = this.fx.filter((f) => f.life > 0);

    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  }

  applySnapshot({ a, b, t }, dt) {
    const snap = b;
    this.islandMat.uniforms.uSafeR.value = a.safeR + (b.safeR - a.safeR) * t;
    if (b.props && this.propMeshes) {
      const seenProps = new Set();
      for (const p of b.props) {
        seenProps.add(p.id);
        let m = this.propMeshes.get(p.id);
        if (!m && p.kind) m = this.createProp(p);
        if (!m) continue;
        const up = p.alive !== false && p.hp > 0;
        m.visible = up;
        if (p.permanent || m.userData.permanent) {
          if (m.userData.hpBar) m.userData.hpBar.visible = false;
        } else setHpBar(m.userData.hpBar, p.hp, p.maxHp || ARENA.propHp);
        if (p.x != null && p.z != null) {
          const pa = (a.props || []).find((q) => q.id === p.id) || p;
          const x = (pa.x ?? p.x) + (p.x - (pa.x ?? p.x)) * t;
          const z = (pa.z ?? p.z) + (p.z - (pa.z ?? p.z)) * t;
          m.position.set(x, 0, z);
          if (p.patrol) {
            const dx = p.x - (pa.x ?? p.x), dz = p.z - (pa.z ?? p.z);
            if (Math.abs(dx) + Math.abs(dz) > 0.0001) m.rotation.y = -Math.atan2(dz, dx);
          }
        }
        if (m.userData.flame) {
          m.userData.flame.scale.y = 0.75 + Math.sin(this.time * 16) * 0.25;
          m.userData.flame.rotation.y = this.time * 3;
        }
      }
      for (const [id, mesh] of this.propMeshes) {
        if (!seenProps.has(id)) { this.propGroup.remove(mesh); this.propMeshes.delete(id); }
      }
    }

    // players
    for (const pb of b.players) {
      const pa = a.players.find((p) => p.id === pb.id) || pb;
      let m = this.heroMeshes[pb.id];
      if (!m) continue;
      if (m.userData.heroId !== pb.hero) m = this.swapHero(pb.id, pb.hero);
      const x = pa.x + (pb.x - pa.x) * t, z = pa.z + (pb.z - pa.z) * t;
      let f = pb.f;
      // shortest-arc facing interpolation
      let df = pb.f - pa.f; while (df > Math.PI) df -= Math.PI * 2; while (df < -Math.PI) df += Math.PI * 2;
      f = pa.f + df * t;
      m.position.set(x, 0, z);
      m.rotation.y = -f;
      const u = m.userData;
      const moving = Math.hypot(pb.x - pa.x, pb.z - pa.z) > 0.01;
      const body = u.body;
      if (!pb.alive) {
        body.rotation.z = THREE.MathUtils.lerp(body.rotation.z, -Math.PI / 2, 1 - Math.exp(-dt * 8));
        body.position.y = THREE.MathUtils.lerp(body.position.y, 0.4, 1 - Math.exp(-dt * 8));
        m.children.forEach((c) => { if (c !== body && c !== u.plate.sprite) c.visible = false; });
        u.plate.sprite.visible = true;
      } else {
        if (u.wasDead) { m.children.forEach((c) => { c.visible = true; }); }
        body.rotation.z = 0;
        body.position.y = moving ? Math.abs(Math.sin(this.time * 12)) * 0.12 : 0;
        if (u.hover) body.position.y += 0.38 + Math.sin(this.time * 2.2) * 0.07;
        if (u.wings) {
          u.wings.forEach((w, i) => {
            const flap = Math.sin(this.time * (i < 2 ? 9 : 11) + (i < 2 ? 0 : 0.45)) * (i < 2 ? 0.5 : 0.32);
            w.rotation.x = flap * w.userData.side;
          });
        }
        if (u.tail) u.tail.rotation.y = Math.sin(this.time * 2.5) * 0.35;
        if (u.motes) {
          u.motes.children.forEach((c) => {
            const ang = this.time * 1.8 + c.userData.phase;
            c.position.set(Math.cos(ang) * c.userData.radius, 1.15 + Math.sin(ang * 1.6) * 0.22, Math.sin(ang) * c.userData.radius * 0.65);
          });
        }
        if (pb.dash === 'roll') body.rotation.z = -this.time * 14 % (Math.PI * 2);
        else if (pb.dash === 'wind' || pb.dash === 'slash') body.rotation.z = -0.85;
        else if (pb.dash) body.rotation.z = -0.35;
        if (u.hair && moving) u.hair.rotation.z = Math.sin(this.time * 16) * 0.06;
        else if (u.hair) u.hair.rotation.z = 0;
        if (pb.cast) body.scale.setScalar(1 + 0.08 * Math.sin(pb.cast.t * Math.PI));
        else body.scale.setScalar(1);
        u.ring.visible = true;
      }
      const attackCast = pb.alive && pb.cast && pb.cast.key === 'attack';
      if (u.windup) {
        u.windup.visible = attackCast;
        if (attackCast) {
          u.windup.scale.setScalar(0.3 + 0.7 * pb.cast.t);
          u.windup.material.opacity = 0.2 + 0.55 * pb.cast.t;
        }
      }
      if (u.weapon && pb.hero === 'monk' && pb.alive) {
        const winding = pb.cast && pb.cast.key === 'attack';
        const striking = pb.flags?.pose != null;
        if (winding) poseMonkStaff(u.weapon, pb.flags?.combo || 0, pb.cast.t, true);
        else if (striking) poseMonkStaff(u.weapon, pb.flags.pose, pb.flags.poseT || 0, false);
        else restMonkStaff(u.weapon);
        if (winding && (pb.flags?.combo || 0) === 2) body.rotation.z = -0.25 * pb.cast.t;
        else if (striking && pb.flags.pose === 0) body.rotation.y = (pb.flags.poseT || 0) * Math.PI * 2;
        else if (striking && pb.flags.pose === 2) body.rotation.z = -0.45 * Math.sin((pb.flags.poseT || 0) * Math.PI);
        else if (striking && pb.flags.pose === 3) body.rotation.z = -0.55;
        else if (!pb.dash && !(pb.fx || []).includes('prone')) body.rotation.y = 0;
      } else if (u.weapon) {
        const base = u.weapon.userData.baseZ || 0;
        u.weapon.rotation.z = attackCast ? base - (1 - pb.cast.t) * 0.9 : base;
      }
      const fx = pb.fx || [];
      const perched = pb.alive && fx.includes('perch');
      const bun = pb.alive && fx.includes('rabbit');
      if (u.rabbit) {
        u.rabbit.visible = bun;
        if (bun) {
          const hop = Math.abs(Math.sin(this.time * 3.4));
          u.rabbit.position.y = hop * 0.32;
          u.rabbit.rotation.z = Math.sin(this.time * 3.4) * 0.12;
        }
      }
      if (u.heldRock) {
        const hold = pb.flags?.holding;
        u.heldRock.visible = pb.alive && !!hold;
        if (hold) {
          u.heldRock.position.y = 1.48 + Math.sin(this.time * 3.2) * 0.05;
          u.heldRock.rotation.y = this.time * 0.7;
        }
        if (hold === 'flame') {
          u.heldRock.material.color.setHex(0x6a3a28);
          u.heldRock.material.emissive.setHex(0xff4a00);
          u.heldRock.material.emissiveIntensity = 0.8;
        } else if (u.heldRock.material.emissive) {
          u.heldRock.material.color.setHex(0x8a5a3a);
          u.heldRock.material.emissive.setHex(0x000000);
          u.heldRock.material.emissiveIntensity = 0;
        }
      }
      if (pb.alive && pb.dash === 'pole') body.position.y = 1.55;
      if (perched) {
        body.position.y = 2.25 + Math.sin(this.time * 3) * 0.04;
        body.rotation.z = 0.12;
      }
      if (pb.alive && fx.includes('prone')) {
        body.rotation.z = -1.15;
        body.position.y = 0.2;
      }
      if (u.perchStaff) u.perchStaff.visible = perched;
      if (u.weapon && u.perchStaff && pb.alive) u.weapon.visible = !perched;
      u.bubble.visible = pb.alive && pb.sh > 0;
      if (u.bubble.visible) u.bubble.material.opacity = 0.25 + 0.1 * Math.sin(this.time * 6);
      u.rootRing.visible = pb.alive && (fx.includes('root') || fx.includes('prone'));
      u.stun.visible = pb.alive && (fx.includes('stun') || fx.includes('prone'));
      if (u.stun.visible) u.stun.rotation.z = this.time * 4;
      u.vuln.visible = pb.alive && fx.includes('vulnerable');
      if (u.vuln.visible) { u.vuln.rotation.y = this.time * 3; u.vuln.position.y = 2.7 + Math.sin(this.time * 5) * 0.1; }
      u.flame.visible = pb.alive && fx.includes('burn');
      if (u.flame.visible) u.flame.scale.set(1, 0.8 + Math.random() * 0.4, 1);
      const fiery = pb.alive && fx.includes('fire');
      u.fireAura.visible = fiery;
      if (u.fireAura.visible) { u.fireAura.rotation.z = this.time * 2; u.fireAura.material.opacity = 0.55 + 0.25 * Math.sin(this.time * 8); }
      if (u.flames) {
        u.flames.visible = fiery;
        if (fiery) {
          u.flames.children.forEach((c, i) => {
            if (!c.isMesh) return;
            const flicker = 0.72 + Math.sin(this.time * 16 + i * 1.7) * 0.28 + (Math.random() - 0.5) * 0.08;
            c.scale.set(1, Math.max(0.35, flicker), 1);
            c.position.y = c.userData.baseY + Math.sin(this.time * 11 + i) * 0.06;
          });
          u.fireLight.intensity = 1.6 + Math.sin(this.time * 18) * 0.5;
        }
      }
      u.soak.visible = pb.alive && fx.includes('soaked');
      if (u.soak.visible) u.soak.position.y = 2.5 + Math.sin(this.time * 6) * 0.15;
      u.empower.visible = pb.alive && fx.includes('empower');
      if (u.empower.visible) { u.empower.rotation.y = this.time * 5; }
      u.silence.visible = pb.alive && fx.includes('silence');
      if (u.silence.visible) u.silence.position.y = 2.15 + Math.sin(this.time * 4) * 0.06;
      const poisonN = pb.alive ? (pb.ps || 0) : 0;
      if (u.poisons) {
        u.poisons.forEach((icon, i) => {
          icon.visible = i < poisonN;
          if (i < poisonN) {
            icon.position.x = (i - (poisonN - 1) / 2) * 0.42;
            icon.position.y = 2.45 + Math.sin(this.time * 5 + i) * 0.08;
          }
        });
      }
      if (u.venomReady) {
        u.venomReady.visible = pb.alive && !!pb.flags?.poisonReady;
        if (u.venomReady.visible) u.venomReady.position.y = 2.7 + Math.sin(this.time * 6) * 0.07;
      }
      u.haste.visible = pb.alive && fx.includes('haste');
      if (u.haste.visible) { u.haste.rotation.z = this.time * 4; u.haste.material.opacity = 0.55 + 0.3 * Math.sin(this.time * 10); }
      if (u.dodge) {
        u.dodge.visible = pb.alive && fx.includes('dodge');
        if (u.dodge.visible) { u.dodge.rotation.z = -this.time * 3; u.dodge.material.opacity = 0.55 + 0.4 * Math.sin(this.time * 8); }
      }
      if (u.aside) {
        const stepping = pb.alive && fx.includes('dodge');
        u.aside.visible = stepping;
        if (stepping) {
          u.aside.position.x = Math.sin(this.time * 8) * 0.42;
          u.aside.position.z = 0.2;
          if (u.asideGhost) u.asideGhost.material.opacity = 0.25 + 0.3 * (0.5 + 0.5 * Math.sin(this.time * 11));
        }
      }
      if (u.halo) {
        const shining = pb.alive && fx.includes('spellImmune');
        u.halo.visible = shining;
        if (u.shine) u.shine.intensity = shining ? 5.5 + Math.sin(this.time * 16) * 1.4 : 0;
        if (shining) {
          u.halo.material.opacity = 0.34 + 0.2 * Math.sin(this.time * 14);
          u.halo.scale.setScalar(1.02 + Math.sin(this.time * 12) * 0.05);
        }
      }
      if (u.ward) {
        u.ward.visible = pb.alive && fx.includes('spellImmune');
        if (u.ward.visible) { u.ward.rotation.z = this.time * 1.6; u.ward.material.opacity = 0.55 + 0.3 * Math.sin(this.time * 6); }
      }
      u.leash.visible = pb.alive && fx.includes('leash');
      if (u.leash.visible) u.leash.rotation.z = this.time * 3;
      const phased = pb.alive && fx.includes('phase');
      const stormed = pb.alive && fx.includes('storm');
      u.body.visible = !phased && !bun && !stormed;
      if (u.arrow) u.arrow.visible = pb.alive && !phased && !stormed;
      u.ring.visible = pb.alive && !phased;
      u.plate.sprite.visible = !phased;
      u.phase.visible = phased;
      if (u.stormBall) {
        u.stormBall.visible = stormed;
        if (stormed) tickLightning(u.stormBall, this.time, pb.flags?.lift || 0);
        else u.stormBall.position.y = 0;
      }
      if (u.orbit) {
        const spinning = pb.alive && pb.flags?.blade != null;
        u.orbit.visible = spinning;
        if (u.funnel) u.funnel.visible = spinning;
        if (u.dust) u.dust.visible = spinning;
        if (spinning) {
          u.orbit.rotation.y = this.time * 22;
          if (u.funnel) {
            u.funnel.rotation.y = -this.time * 9;
            u.funnel.scale.set(1, 0.92 + Math.sin(this.time * 18) * 0.08, 1);
          }
          if (u.dust) {
            u.dust.rotation.z = this.time * 6;
            u.dust.scale.setScalar(0.85 + Math.sin(this.time * 14) * 0.12);
          }
          body.rotation.y = this.time * 26;
        }
        if (u.weapon) u.weapon.visible = !spinning && !perched;
      }
      if (phased) {
        for (const key of ['bubble', 'rootRing', 'stun', 'vuln', 'flame', 'fireAura', 'soak', 'empower', 'silence', 'haste', 'leash', 'windup', 'venomReady', 'dodge', 'ward']) {
          if (u[key]) u[key].visible = false;
        }
        if (u.poisons) u.poisons.forEach((icon) => { icon.visible = false; });
        if (u.flames) u.flames.visible = false;
        u.phaseRings.forEach((ring, i) => {
          ring.rotation.z = this.time * (0.7 + i * 0.4) * (i % 2 ? -1 : 1);
          ring.scale.setScalar(0.92 + Math.sin(this.time * 3 + i) * 0.08);
          ring.material.opacity = 0.28 + 0.45 * (0.5 + 0.5 * Math.sin(this.time * 5 + i));
        });
        u.phaseMotes.forEach((mote) => {
          const ang = this.time * 1.7 + mote.userData.ang;
          const rad = 0.72 + Math.sin(this.time * 3 + mote.userData.ang) * 0.16;
          mote.position.set(Math.cos(ang) * rad, 0.22 + Math.sin(this.time * 4 + mote.userData.ang) * 0.16, Math.sin(ang) * rad);
        });
        if (u.phaseDisc) u.phaseDisc.material.opacity = 0.14 + 0.1 * Math.sin(this.time * 4);
      }
      u.wasDead = !pb.alive;
      // slowed: ground ring turns purple
      const ringColor = fx.includes('slow') ? 0x7a6aff
        : (fx.includes('perch') || fx.includes('spellImmune')) ? 0xf0d78c
        : fx.includes('dodge') ? 0xfff4c2
        : fx.includes('storm') ? 0xf0d24a
        : fx.includes('phase') ? 0xe7b4ff
        : fx.includes('haste') ? 0x58d68d
        : HEROES[pb.hero].accent;
      u.ring.material.color.set(ringColor);
      u.plate.update(pb.hp, pb.maxHp, pb.sh, pb.id === this.myId);
      u.plate.sprite.position.y = perched ? 5.15 : 3.2;

      if (pb.id === this.myId) this.camTarget.set(x, 0, z);
    }

    // projectiles
    const seenP = new Set();
    for (const pb of b.proj) {
      seenP.add(pb.id);
      let m = this.projMeshes.get(pb.id);
      if (!m) { m = this.makeProjMesh(pb); this.projMeshes.set(pb.id, m); }
      const pa = a.proj.find((p) => p.id === pb.id) || pb;
      const x = pa.x + (pb.x - pa.x) * t, z = pa.z + (pb.z - pa.z) * t;
      m.position.x = x; m.position.z = z;
      m.position.y = pb.k === 'wave' || pb.k === 'tsunami' ? 0 : pb.k === 'keg' ? 0.15 : 1.0;
      m.rotation.y = -Math.atan2(pb.dz, pb.dx);
      if (pb.k === 'magebolt') {
        const hot = (pb.tr || 0) >= 3;
        if (m.userData.core) m.userData.core.material.emissiveIntensity = hot ? 2.4 : 0.75;
        if (m.userData.glow) {
          m.userData.glow.material.opacity = hot ? 0.7 : 0.32;
          m.userData.glow.scale.setScalar(hot ? 1.45 : 1);
        }
        const last = m.userData.trail;
        if (!last || Math.hypot(x - last.x, z - last.z) > (hot ? 0.16 : 0.28)) {
          const puff = new THREE.Mesh(
            new THREE.SphereGeometry(hot ? 0.12 : 0.07, 6, 6),
            new THREE.MeshBasicMaterial({ color: hot ? 0xf2d6ff : 0xb45cff, transparent: true, opacity: 0.8, depthWrite: false }),
          );
          puff.position.set(x, hot ? 1.15 : 1.0, z);
          this.scene.add(puff);
          this.fx.push({ obj: puff, life: hot ? 0.45 : 0.32, max: hot ? 0.45 : 0.32, kind: 'fade' });
          m.userData.trail = { x, z };
        }
      }
      if (pb.k === 'firestone' && m.userData.flame) {
        m.userData.flame.scale.y = 0.7 + Math.sin(this.time * 18) * 0.3;
        const last = m.userData.trail;
        if (!last || Math.hypot(x - last.x, z - last.z) > 0.3) {
          const puff = new THREE.Mesh(
            new THREE.SphereGeometry(0.1, 6, 6),
            new THREE.MeshBasicMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.75, depthWrite: false }),
          );
          puff.position.set(x, 0.8, z);
          this.scene.add(puff);
          this.fx.push({ obj: puff, life: 0.35, max: 0.35, kind: 'fade' });
          m.userData.trail = { x, z };
        }
      }
      if (pb.k === 'dart') {
        const last = m.userData.trail;
        if (!last || Math.hypot(x - last.x, z - last.z) > 0.28) {
          const puff = new THREE.Mesh(
            new THREE.SphereGeometry(0.07, 6, 6),
            new THREE.MeshBasicMaterial({ color: 0xc6f25a, transparent: true, opacity: 0.75, depthWrite: false }),
          );
          puff.position.set(x, 1.0, z);
          this.scene.add(puff);
          this.fx.push({ obj: puff, life: 0.32, max: 0.32, kind: 'fade' });
          m.userData.trail = { x, z };
        }
      }
      if (pb.k === 'brine') m.position.y = 1.0 + Math.sin(this.time * 20) * 0.05;
      if (m.userData.rope) {
        const owner = this.heroMeshes[pb.o];
        if (owner) {
          const pts = m.userData.rope.geometry.attributes.position;
          pts.setXYZ(0, owner.position.x, 1.2, owner.position.z);
          pts.setXYZ(1, x, 1.0, z);
          pts.needsUpdate = true;
        }
      }
    }
    for (const [id, m] of this.projMeshes) if (!seenP.has(id)) { this.removeObj(m); this.projMeshes.delete(id); }

    // zones
    const seenZ = new Set();
    for (const zb of b.zones) {
      seenZ.add(zb.id);
      let m = this.zoneMeshes.get(zb.id);
      if (!m) { m = this.makeZoneMesh(zb); this.zoneMeshes.set(zb.id, m); }
      m.position.x = zb.x; m.position.z = zb.z;
      if (zb.k === 'fire') {
        m.children.forEach((c, i) => { if (i > 0) { c.scale.y = 0.7 + Math.sin(this.time * 15 + i) * 0.3; c.rotation.y = this.time * 2; } });
        m.children[0].material.opacity = Math.min(0.7, (zb.left ?? 1) * 0.6);
      } else if (zb.k === 'trap') {
        const own = zb.o === this.myId; // enemy traps stay visible but fade once armed
        m.userData.light.visible = zb.armed && (Math.floor(this.time * 4) % 2 === 0);
        m.children.forEach((c) => { if (c.material && c !== m.userData.light) { c.material.transparent = true; c.material.opacity = own ? 1 : (zb.armed ? 0.55 : 0.9); } });
      } else if (zb.k === 'undertow') {
        m.userData.swirl.visible = !!zb.armed;
        m.userData.swirl.rotation.z = -this.time * 6;
        m.userData.ring.material.opacity = zb.armed ? 0.8 : 0.35 + 0.25 * Math.sin(this.time * 10);
      } else if (zb.k === 'tether') {
        const owner = this.heroMeshes[zb.o];
        if (owner) {
          const pts = m.userData.rope.geometry.attributes.position;
          pts.setXYZ(0, owner.position.x, 1.2, owner.position.z);
          pts.setXYZ(1, zb.x, zb.pid ? 1.0 : 0.2, zb.z);
          pts.needsUpdate = true;
        }
        m.children[0].visible = !zb.pid;
      } else if (zb.k === 'leash') {
        const pts = m.userData.rope.geometry.attributes.position;
        pts.setXYZ(0, zb.x, 0.4, zb.z);
        pts.setXYZ(1, zb.tx ?? zb.x, zb.pid ? 1.1 : 0.4, zb.tz ?? zb.z);
        pts.needsUpdate = true;
        m.userData.rope.visible = !!zb.pid;
      } else if (zb.k === 'whip' || zb.k === 'bite' || zb.k === 'pole') {
        const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.time * 10));
        if (zb.k === 'whip' && zb.f != null) m.rotation.y = -zb.f;
        if (m.userData.disc) m.userData.disc.material.opacity = 0.16 + 0.18 * pulse;
        if (m.userData.ring) {
          m.userData.ring.material.opacity = 0.55 + 0.4 * pulse;
          m.userData.ring.scale.setScalar(0.96 + 0.06 * pulse);
        }
      } else if (zb.k === 'strike') {
        const delay = HEROES.shock.abilities.q.delay;
        const fall = 1 - Math.max(0, Math.min(1, (zb.left || 0) / delay));
        if (m.userData.bolt) m.userData.bolt.position.y = 0.7 + (1 - fall) * 5.2;
        if (m.userData.ring) m.userData.ring.material.opacity = 0.45 + 0.5 * fall;
        if (m.userData.disc) m.userData.disc.material.opacity = 0.12 + 0.25 * fall;
      } else if (zb.k === 'luminaire') {
        const base = m.userData.baseR || zb.r || 1;
        m.scale.setScalar(Math.max(0.2, zb.r / base));
        if (m.userData.ring) m.userData.ring.material.opacity = 0.45 + 0.4 * Math.sin(this.time * 16);
      } else if (zb.k === 'echo') {
        m.rotation.y = -(zb.f || 0);
        const storm = !!zb.storm;
        if (m.userData.body) m.userData.body.visible = !storm;
        if (m.userData.stormBall) {
          m.userData.stormBall.visible = storm;
          if (storm) tickLightning(m.userData.stormBall, this.time, zb.lift || 0);
          else m.userData.stormBall.position.y = 0;
        }
        if (m.userData.orbit) {
          const spinning = zb.blade != null;
          m.userData.orbit.visible = spinning;
          if (m.userData.funnel) m.userData.funnel.visible = spinning;
          if (m.userData.dust) m.userData.dust.visible = spinning;
          if (spinning) {
            m.userData.orbit.rotation.y = this.time * 22;
            if (m.userData.funnel) m.userData.funnel.rotation.y = -this.time * 9;
            if (m.userData.body) m.userData.body.rotation.y = this.time * 26;
          }
          if (m.userData.weapon) m.userData.weapon.visible = !spinning;
        }
        const bob = Math.sin(this.time * 2.4) * 0.06;
        if (m.userData.body && !storm) m.userData.body.position.y = bob;
      } else if (zb.k === 'ghost') {
        m.rotation.y = -(zb.f || 0);
        const bob = Math.sin(this.time * 2.2) * 0.08;
        if (m.userData.body) m.userData.body.position.y = bob;
      } else if (zb.k === 'hat') {
        const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.time * 8));
        if (m.userData.ring) m.userData.ring.material.opacity = 0.45 + 0.5 * pulse;
        if (m.userData.disc) m.userData.disc.material.opacity = 0.16 + 0.16 * pulse;
      } else if (zb.k === 'disco') {
        if (m.userData.ball) m.userData.ball.rotation.y = this.time * 2.4;
        m.children.forEach((c, i) => { if (i > 0 && i < 5) c.rotation.y = this.time * (1.5 + i * 0.2); });
        if (m.userData.ring) m.userData.ring.material.opacity = 0.3 + 0.25 * Math.sin(this.time * 6);
      } else if (zb.k === 'meteor') {
        const spec = HEROES.stone.abilities.r;
        const t = Math.max(0, Math.min(1, (zb.left || 0) / spec.delay));
        const dist = t * spec.approach;
        const height = 0.9 + t * spec.approachHeight;
        const ang = zb.f || 0;
        const bx = -Math.cos(ang);
        const bz = -Math.sin(ang);
        if (m.userData.rock) {
          m.userData.rock.position.set(bx * dist, height, bz * dist);
          m.userData.rock.rotation.y = this.time * 3;
          m.userData.rock.rotation.z = bx * 0.6;
        }
        if (m.userData.flame) {
          m.userData.flame.position.set(bx * (dist + 0.9), height + 0.45, bz * (dist + 0.9));
          m.userData.flame.rotation.z = -bx * 1.1;
          m.userData.flame.rotation.x = bz * 1.1;
          m.userData.flame.scale.y = 0.85 + Math.sin(this.time * 20) * 0.25;
        }
        if (m.userData.ring) m.userData.ring.material.opacity = 0.55 + 0.35 * Math.sin(this.time * 10);
      } else if (zb.k === 'cloud') {
        m.children.forEach((c, i) => { if (i > 0) c.position.y = 0.55 + Math.sin(this.time * 2 + i) * 0.2; });
      } else if (zb.k === 'healthpack') {
        m.rotation.y = this.time * 1.5;
        m.children[0].position.y = m.children[1].position.y = 0.85 + Math.sin(this.time * 3) * 0.12;
        setHpBar(m.userData.hpBar, zb.hp, zb.maxHp);
      } else if (zb.k === 'keg') {
        setHpBar(m.userData.hpBar, zb.hp, zb.maxHp);
        if (m.userData.spark) {
          m.userData.spark.visible = true;
          m.userData.spark.material.color.set(zb.fuse ? 0xff2200 : 0xffcc66);
          m.userData.spark.scale.setScalar(zb.fuse ? 1.6 + Math.sin(this.time * 30) * 0.4 : 1);
        }
      }
    }
    for (const [id, m] of this.zoneMeshes) if (!seenZ.has(id)) { this.removeObj(m); this.zoneMeshes.delete(id); }
  }
}
