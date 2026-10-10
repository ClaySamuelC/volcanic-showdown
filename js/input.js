// Keyboard + mouse input. Movement is right-click move-to. The cursor is only an aim point:
// left click attacks toward it, Q/W/E/R cast toward it. The hero does not face the cursor.
export class Input {
  constructor(canvas, renderer) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.keys = new Set();
    this.mouse = { x: 0, y: 0 };
    this.aim = [0, 0];
    this.moveTarget = null;
    this.onCast = null;
    this.onRelease = null;
    this.onVector = null;
    this.onMoveTarget = null;
    this.vectorCast = null;
    this.channelCast = null;
    this.enabled = false;
    this.attackHeld = false;
    this.vector = null;
    this.channeling = new Set();

    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
      const k = e.key.toLowerCase();
      if (e.repeat) return;
      this.keys.add(k);
      if (!this.enabled) return;
      if (['q', 'w', 'e', 'r'].includes(k)) {
        this.updateAim();
        if (this.vectorCast?.(k)) {
          if (this.vector?.key === k) this.clearVector();
          else {
            this.vector = { key: k, anchor: null, dragging: false };
            this.onVector?.('Click to set the throw direction. Drag left or right to curve it. Right click cancels.');
          }
          return;
        }
        if (this.vector) this.clearVector();
        if (this.channelCast?.(k)) this.channeling.add(k);
        this.onCast?.(k, this.aim.slice());
      }
      if (k === 's') this.onMoveTarget?.(null); // stop
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (!this.channeling.has(k)) return;
      this.channeling.delete(k);
      if (!this.enabled) return;
      this.updateAim();
      this.onRelease?.(k, this.aim.slice());
    });
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      this.updateAim();
      if (e.button === 2 && this.vector) {
        this.clearVector();
        return;
      }
      if (e.button === 0 && this.vector) {
        this.vector.anchor = this.aim.slice();
        this.vector.dragging = true;
        return;
      }
      if (e.button === 0 && this.vectorCast?.('attack')) {
        this.vector = { key: 'attack', anchor: this.aim.slice(), dragging: true };
        this.onVector?.('Drag left or right of that line to curve the throw. Right click cancels.');
        return;
      }
      if (e.button === 0) {
        this.attackHeld = true;
        this.onCast?.('attack', this.aim.slice());
      } else if (e.button === 2) {
        this.moveTarget = this.aim.slice();
        this.onMoveTarget?.(this.moveTarget);
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      this.attackHeld = false;
      if (!this.vector?.dragging) return;
      this.updateAim();
      const anchor = this.vector.anchor;
      const key = this.vector.key;
      const curve = [this.aim[0] - anchor[0], this.aim[1] - anchor[1]];
      this.clearVector();
      this.onCast?.(key, anchor, curve);
    });
  }

  clearVector() {
    this.vector = null;
    this.onVector?.(null);
  }

  updateAim() {
    const p = this.renderer.screenToGround(this.mouse.x, this.mouse.y);
    if (p) this.aim = [p.x, p.z];
  }
}
