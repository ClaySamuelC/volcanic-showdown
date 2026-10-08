import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { LobbyManager } from './lobby.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(root, 'public')));
app.use('/shared', express.static(path.join(root, 'shared')));
app.use('/game', express.static(path.join(root, 'game')));
app.use('/vendor/three', express.static(path.join(root, 'node_modules', 'three')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const lobbies = new LobbyManager();

let nextClientId = 1;

function sanitizeName(name) {
  const s = String(name || '').replace(/[^\w \-'!]/g, '').trim().slice(0, 16);
  return s || `Player${Math.floor(Math.random() * 900 + 100)}`;
}

wss.on('connection', (ws) => {
  const client = {
    id: `p${nextClientId++}`,
    name: 'Player',
    ws,
    lobby: null,
    hero: null,
    ready: false,
    send(msg) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
    sendRaw(str) { if (ws.readyState === ws.OPEN) ws.send(str); },
  };
  client.send({ t: 'hello', id: client.id });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'create':
        if (client.lobby) client.lobby.remove(client);
        client.name = sanitizeName(msg.name);
        lobbies.create(client);
        break;
      case 'join':
        if (client.lobby) client.lobby.remove(client);
        client.name = sanitizeName(msg.name);
        lobbies.join(client, String(msg.code || '').trim());
        break;
      case 'leave':
        if (client.lobby) client.lobby.remove(client);
        client.send({ t: 'left' });
        break;
      case 'pick':
        if (client.lobby) client.lobby.pick(client, msg.hero);
        break;
      case 'ready':
        if (client.lobby) client.lobby.setReady(client, msg.ready !== false);
        break;
      case 'input':
        if (client.lobby) client.lobby.onInput(client, msg);
        break;
      case 'cast':
        if (client.lobby) client.lobby.onCast(client, msg);
        break;
      case 'ping':
        client.send({ t: 'pong', ts: msg.ts });
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (client.lobby) client.lobby.remove(client);
  });
});

server.listen(PORT, () => {
  console.log(`Volcanic Showdown running at http://localhost:${PORT}`);
});
