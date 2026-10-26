import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { createMailer } from './mailer.js';
import { createOidc } from './oidc.js';
import { createPushSender } from './push.js';
import { attachWebSocket, createHub } from './realtime.js';

export function startServer({
  port = 3000, host, dbFile = ':memory:', uploadDir, push, mailer = null, publicUrl = null, oidc = null,
} = {}) {
  const db = openDb(dbFile);
  const hub = createHub();
  const dir = uploadDir ?? mkdtempSync(join(tmpdir(), 'makora-uploads-'));
  const app = createApp({ db, hub, uploadDir: dir, push: push === undefined ? createPushSender(db) : push, mailer, publicUrl, oidc });
  const server = createServer(app);
  const wss = attachWebSocket(server, { db, hub });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        server,
        app,
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
  const env = process.env;
  const publicUrl = env.PUBLIC_URL?.replace(/\/$/, '') || null;
  const list = (value) => (value ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);

  const mailer = env.SMTP_URL ? createMailer({ url: env.SMTP_URL, from: env.MAIL_FROM ?? 'MAKORA HIT <no-reply@localhost>' }) : null;
  const oidc = env.OIDC_ISSUER && env.OIDC_CLIENT_ID && publicUrl ? createOidc({
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET ?? '',
    redirectUri: `${publicUrl}/api/auth/sso/callback`,
    label: env.OIDC_LABEL ?? 'SSO',
    allowedDomains: list(env.OIDC_ALLOWED_DOMAINS),
    trustEmail: env.OIDC_TRUST_EMAIL === 'true',
  }) : null;
  if ((env.SMTP_URL || env.OIDC_ISSUER) && !publicUrl) {
    console.warn('PUBLIC_URL manquant : les emails et la connexion SSO restent désactivés (ex. PUBLIC_URL=https://chat.mon-entreprise.fr).');
  }

  const { close } = await startServer({ port, host: env.HOST, dbFile, uploadDir, mailer, publicUrl, oidc });
  console.log(`MAKORA HIT est lancé sur http://localhost:${port}`);
  if (mailer && publicUrl) console.log('Emails : activés');
  if (oidc) console.log(`Connexion SSO : activée (${oidc.label})`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await close();
      process.exit(0);
    });
  }
}
