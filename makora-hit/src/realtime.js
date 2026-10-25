import { WebSocketServer } from 'ws';
import { parseCookies, SESSION_COOKIE, userFromToken } from './auth.js';

// Garde la liste des connexions WebSocket ouvertes par utilisateur
// et pousse les événements aux bonnes personnes.
export function createHub() {
  const sockets = new Map(); // userId -> Set<WebSocket>

  function send(ws, event) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  }

  const hub = {
    add(userId, ws) {
      const wasOffline = !sockets.has(userId);
      if (wasOffline) sockets.set(userId, new Set());
      sockets.get(userId).add(ws);
      if (wasOffline) hub.broadcast({ type: 'presence', online: hub.online() });
    },
    remove(userId, ws) {
      const set = sockets.get(userId);
      if (!set) return;
      set.delete(ws);
      if (set.size === 0) {
        sockets.delete(userId);
        hub.broadcast({ type: 'presence', online: hub.online() });
      }
    },
    online() {
      return [...sockets.keys()];
    },
    sendTo(userIds, event) {
      for (const id of userIds) {
        for (const ws of sockets.get(id) ?? []) send(ws, event);
      }
    },
    broadcast(event) {
      for (const set of sockets.values()) {
        for (const ws of set) send(ws, event);
      }
    },
    closeAll() {
      for (const set of sockets.values()) {
        for (const ws of set) ws.terminate();
      }
      sockets.clear();
    },
  };
  return hub;
}

export function attachWebSocket(server, { db, hub }) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    // Refuse les connexions ouvertes depuis un autre site (le cookie serait envoyé quand même).
    const sameOrigin = !origin || new URL(origin).host === req.headers.host;
    const user = userFromToken(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (url.pathname !== '/ws' || !sameOrigin || !user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => hub.remove(user.id, ws));
      hub.add(user.id, ws);
      ws.send(JSON.stringify({ type: 'presence', online: hub.online() }));
    });
  });

  // Coupe les connexions mortes (wifi coupé, portable en veille...).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}
