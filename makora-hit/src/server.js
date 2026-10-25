import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { attachWebSocket, createHub } from './realtime.js';

export function startServer({ port = 3000, host, dbFile = ':memory:', uploadDir } = {}) {
  const db = openDb(dbFile);
  const hub = createHub();
  const dir = uploadDir ?? mkdtempSync(join(tmpdir(), 'makora-uploads-'));
  const server = createServer(createApp({ db, hub, uploadDir: dir }));
  const wss = attachWebSocket(server, { db, hub });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        server,
        db,
        hub,
        uploadDir: dir,
        port: server.address().port,
        async close() {
          hub.closeAll();
          wss.close();
          await new Promise((r) => server.close(r));
          db.close();
          if (!uploadDir) rmSync(dir, { recursive: true, force: true });
        },
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const dbFile = process.env.DB_FILE ?? fileURLToPath(new URL('../data/makora.db', import.meta.url));
  const uploadDir = process.env.UPLOAD_DIR ?? fileURLToPath(new URL('../data/uploads', import.meta.url));
  const { close } = await startServer({ port, host: process.env.HOST, dbFile, uploadDir });
  console.log(`MAKORA HIT est lancé sur http://localhost:${port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await close();
      process.exit(0);
    });
  }
}
