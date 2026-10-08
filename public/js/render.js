import * as THREE from 'three';
import { HEROES, ARENA } from '../shared/heroes.js';

const ISO_YAW = Math.PI / 4;
const ISO_PITCH = Math.atan(1 / Math.SQRT2); // classic isometric elevation ~35.26°
const VIEW_HEIGHT = 17; // world units visible vertically (smaller = more zoomed in)
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

function buildHero(heroId) {
  const def = HEROES[heroId];
  const g = new THREE.Group();
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
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 12), new THREE.MeshBasicMaterial({ color: 0xff6a1a }));
    glow.position.set(0.45, 1.25, 0); glow.visible = false; body.add(glow);
    g.userData.fireGlow = glow;
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
  } else {
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
  }

  body.traverse((m) => { if (m.isMesh) { m.castShadow = true; } });

  // ground ring (team color)
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 32), new THREE.MeshBasicMaterial({ color: def.accent, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
  g.add(ring);
  g.userData.ring = ring;

  // facing arrow
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 3), new THREE.MeshBasicMaterial({ color: def.accent, transparent: true, opacity: 0.9 }));
  arrow.rotation.z = -Math.PI / 2; arrow.position.set(0.95, 0.05, 0);
  g.add(arrow);

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

  const plate = new NamePlate('', def.accent);
  plate.sprite.position.y = 3.2;
  g.add(plate.sprite);
  g.userData.plate = plate;

  return g;
}

// ---------------------------------------------------------------- renderer
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
    this.updateCamera(0);
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
    for (const p of props) {
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
      } else {
        m = new THREE.Mesh(new THREE.DodecahedronGeometry(p.r * 1.15, 0), mat(0x55504e));
        m.position.y = p.r * 0.55;
        m.rotation.set(Math.random() * 0.4, Math.random() * Math.PI, Math.random() * 0.3);
      }
      m.position.x = p.x; m.position.z = p.z;
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.propGroup.add(m);
    }
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
      case 'swing': this.fxSwing(ev); break;
      case 'hit': {
        if (ev.absorbed && !ev.amount) this.floatText(ev.x, ev.z, 'BLOCK', '#8fd6ff');
        else if (ev.amount) this.floatText(ev.x, ev.z, `-${ev.amount}`, ev.kind === 'burn' || ev.kind === 'fire' || ev.kind === 'lava' ? '#ff8a3a' : ev.kind === 'water' ? '#8fe3ff' : '#ff4d4d');
        this.fxBurst(ev.x, ev.z, 0.5, ev.kind === 'water' ? 0x3fa9ff : 0xff4d4d, 0.25);
        if (ev.pid === this.myId) this.shake = Math.max(this.shake, 0.4 + ev.amount * 0.15);
        break;
      }
      case 'heal': if (ev.amount) this.floatText(ev.x, ev.z, `+${ev.amount}`, '#58d68d'); break;
      case 'text': this.floatText(ev.x, ev.z, ev.text, ev.color || '#fff'); break;
      case 'explode': this.fxRing(ev.x, ev.z, ev.r, new THREE.Color(ev.color || '#ff5a1a'), 0.45); this.shake = Math.max(this.shake, 0.6); break;
      case 'roar': this.fxRing(ev.x, ev.z, 2.2, new THREE.Color('#ffd166'), 0.5); break;
      case 'ult': this.fxRing(ev.x, ev.z, 3.5, new THREE.Color(ev.hero === 'minotaur' ? '#ff5a1a' : '#8fe3ff'), 0.7); this.shake = Math.max(this.shake, 0.8); break;
      case 'death': this.fxRing(ev.x, ev.z, 2.5, new THREE.Color('#ffffff'), 0.8); this.shake = 1.2; break;
      case 'pickup': this.fxRing(ev.x, ev.z, 1.2, new THREE.Color('#58d68d'), 0.4); break;
      case 'trap': this.fxBurst(ev.x, ev.z, 1.0, 0xd9c38a, 0.4); break;
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
    } else if (z.k === 'healthpack') {
      m = new THREE.Group();
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.22, 0.22), new THREE.MeshStandardMaterial({ color: 0x58d68d, emissive: 0x2a8a4a, emissiveIntensity: 0.8 }));
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.7), new THREE.MeshStandardMaterial({ color: 0x58d68d, emissive: 0x2a8a4a, emissiveIntensity: 0.8 }));
      a.position.y = 0.6; b.position.y = 0.6; m.add(a); m.add(b);
      const glow = new THREE.Mesh(new THREE.CircleGeometry(0.7, 20), new THREE.MeshBasicMaterial({ color: 0x58d68d, transparent: true, opacity: 0.35, depthWrite: false }));
      glow.rotation.x = -Math.PI / 2; glow.position.y = 0.04; m.add(glow);
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

    // players
    for (const pb of b.players) {
      const pa = a.players.find((p) => p.id === pb.id) || pb;
      const m = this.heroMeshes[pb.id];
      if (!m) continue;
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
        if (pb.dash) body.rotation.z = pb.dash === 'roll' ? -this.time * 14 % (Math.PI * 2) : -0.35;
        if (pb.cast) body.scale.setScalar(1 + 0.08 * Math.sin(pb.cast.t * Math.PI));
        else body.scale.setScalar(1);
        u.ring.visible = true;
      }
      const fx = pb.fx || [];
      u.bubble.visible = pb.alive && pb.sh > 0;
      if (u.bubble.visible) u.bubble.material.opacity = 0.25 + 0.1 * Math.sin(this.time * 6);
      u.rootRing.visible = pb.alive && fx.includes('root');
      u.stun.visible = pb.alive && fx.includes('stun');
      if (u.stun.visible) u.stun.rotation.z = this.time * 4;
      u.vuln.visible = pb.alive && fx.includes('vulnerable');
      if (u.vuln.visible) { u.vuln.rotation.y = this.time * 3; u.vuln.position.y = 2.7 + Math.sin(this.time * 5) * 0.1; }
      u.flame.visible = pb.alive && fx.includes('burn');
      if (u.flame.visible) u.flame.scale.set(1, 0.8 + Math.random() * 0.4, 1);
      u.fireAura.visible = pb.alive && fx.includes('fire');
      if (u.fireGlow) u.fireGlow.visible = u.fireAura.visible;
      if (u.fireAura.visible) { u.fireAura.rotation.z = this.time * 2; u.fireAura.material.opacity = 0.45 + 0.2 * Math.sin(this.time * 8); }
      u.soak.visible = pb.alive && fx.includes('soaked');
      if (u.soak.visible) u.soak.position.y = 2.5 + Math.sin(this.time * 6) * 0.15;
      u.empower.visible = pb.alive && fx.includes('empower');
      if (u.empower.visible) { u.empower.rotation.y = this.time * 5; }
      u.wasDead = !pb.alive;
      // slowed: ground ring turns purple
      u.ring.material.color.set(fx.includes('slow') ? 0x7a6aff : HEROES[pb.hero].accent);
      u.plate.update(pb.hp, pb.maxHp, pb.sh, pb.id === this.myId);
      u.plate.sprite.position.y = 3.2;

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
      m.position.y = pb.k === 'wave' || pb.k === 'tsunami' ? 0 : 1.0;
      m.rotation.y = -Math.atan2(pb.dz, pb.dx);
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
      } else if (zb.k === 'healthpack') {
        m.rotation.y = this.time * 1.5;
        m.children[0].position.y = m.children[1].position.y = 0.6 + Math.sin(this.time * 3) * 0.12;
      }
    }
    for (const [id, m] of this.zoneMeshes) if (!seenZ.has(id)) { this.removeObj(m); this.zoneMeshes.delete(id); }
  }
}
