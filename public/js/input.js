// Keyboard + mouse input. Movement is right-click move-to (Dota style) or camera-relative arrow keys.
// The mouse is a free-aim cursor: left click attacks toward it, Q/W/E/R cast toward it.
export class Input {
  constructor(canvas, renderer) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.keys = new Set();
    this.mouse = { x: 0, y: 0 };
    this.aim = [0, 0];
    this.moveTarget = null;
    this.onCast = null;
    this.onMoveTarget = null;
    this.enabled = false;
    this.attackHeld = false;

    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      const k = e.key.toLowerCase();
      if (k.startsWith('arrow')) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(k);
      if (!this.enabled) return;
      if (['q', 'w', 'e', 'r'].includes(k)) {
        this.updateAim();
        this.onCast?.(k, this.aim.slice());
      }
      if (k === 's') this.onMoveTarget?.(null); // stop
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      this.updateAim();
      if (e.button === 0) {
        this.attackHeld = true;
        this.onCast?.('attack', this.aim.slice());
      } else if (e.button === 2) {
        this.moveTarget = this.aim.slice();
        this.onMoveTarget?.(this.moveTarget);
      }
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.attackHeld = false; });
  }

  updateAim() {
    const p = this.renderer.screenToGround(this.mouse.x, this.mouse.y);
    if (p) this.aim = [p.x, p.z];
  }

  // Arrow-key movement vector in world space, rotated so "up" moves up the screen.
  moveVector() {
    let sx = 0, sy = 0;
    if (this.keys.has('arrowup')) sy -= 1;
    if (this.keys.has('arrowdown')) sy += 1;
    if (this.keys.has('arrowleft')) sx -= 1;
    if (this.keys.has('arrowright')) sx += 1;
    if (sx === 0 && sy === 0) return [0, 0];
    const len = Math.hypot(sx, sy);
    sx /= len; sy /= len;
    const { right, forward } = this.renderer.cameraAxes();
    const x = right.x * sx + forward.x * -sy;
    const z = right.z * sx + forward.z * -sy;
    const l = Math.hypot(x, z) || 1;
    return [x / l, z / l];
  }
}
