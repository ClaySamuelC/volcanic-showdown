// Thin WebSocket wrapper with a configurable server URL, lazy connect and a simple message bus.
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.id = null;
    this.connected = false;
    this.url = null;
  }

  static defaultUrl() {
    // When served by the Node server, same origin works. On static hosts (GitHub Pages) a server URL is required.
    if (location.protocol === 'file:' || /github\.io$/.test(location.hostname)) return '';
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  }

  // Resolves once connected (and the server has said hello), rejects if the socket fails before that.
  connect(url) {
    url = (url || '').trim();
    if (!url) return Promise.reject(new Error('No multiplayer server configured.'));
    if (!/^wss?:\/\//.test(url)) url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + url.replace(/^https?:\/\//, '');
    if (this.connected && this.url === url) return Promise.resolve();
    this.disconnect();
    this.url = url;
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      this.ws = ws;
      ws.onopen = () => { this.connected = true; this.fire('open'); };
      ws.onerror = () => { if (!settled) { settled = true; reject(new Error(`Could not reach ${url}`)); } };
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        this.id = null;
        if (!settled) { settled = true; reject(new Error(`Could not reach ${url}`)); }
        if (was) this.fire('close');
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'hello') { this.id = msg.id; if (!settled) { settled = true; resolve(); } }
        this.fire(msg.t, msg);
      };
    });
  }

  disconnect() {
    if (this.ws) { this.ws.onclose = null; this.ws.onerror = null; this.ws.close(); }
    this.ws = null;
    this.connected = false;
    this.id = null;
  }

  on(type, fn) { (this.handlers[type] ||= []).push(fn); }
  fire(type, msg) { for (const fn of this.handlers[type] || []) fn(msg); }

  send(msg) {
    if (this.connected) this.ws.send(JSON.stringify(msg));
  }
}
