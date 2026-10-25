import express from 'express';
import { fileURLToPath } from 'node:url';
import {
  clearSessionCookie, createSession, deleteSession, hashPassword, newToken,
  parseCookies, SESSION_COOKIE, sessionCookie, userFromToken, verifyPassword,
} from './auth.js';
import { transaction } from './db.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const PAGE_SIZE = 50;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => { throw new HttpError(status, message); };

function text(value, field, { min = 0, max }) {
  if (typeof value !== 'string') fail(400, `Champ « ${field} » manquant.`);
  const v = value.trim();
  if (v.length < min) fail(400, `Champ « ${field} » trop court (${min} caractères minimum).`);
  if (v.length > max) fail(400, `Champ « ${field} » trop long (${max} caractères maximum).`);
  return v;
}

function intParam(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(404, 'Introuvable.');
  return n;
}

const toUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const toMessage = (m) => ({
  id: m.id, channelId: m.channel_id, userId: m.user_id, body: m.body,
  createdAt: m.created_at, editedAt: m.edited_at,
});
const toPage = (p) => ({
  id: p.id, parentId: p.parent_id, title: p.title, content: p.content, version: p.version,
  createdBy: p.created_by, updatedBy: p.updated_by, createdAt: p.created_at, updatedAt: p.updated_at,
});

// Limite simple des tentatives de connexion, en mémoire, par adresse IP.
function loginLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const attempts = new Map();
  return {
    check(key) {
      const now = Date.now();
      const entry = attempts.get(key);
      if (entry && entry.reset > now && entry.count >= max) {
        fail(429, 'Trop de tentatives, réessayez dans quelques minutes.');
      }
    },
    failed(key) {
      const now = Date.now();
      const entry = attempts.get(key);
      if (!entry || entry.reset <= now) attempts.set(key, { count: 1, reset: now + windowMs });
      else entry.count += 1;
    },
    succeeded(key) {
      attempts.delete(key);
    },
  };
}

export function createApp({ db, hub }) {
  const app = express();
  const limiter = loginLimiter();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.static(PUBLIC_DIR));

  const api = express.Router();
  app.use('/api', api);
  api.use(express.json({ limit: '1mb' }));

  // Protection CSRF : toute écriture doit porter un en-tête que seul notre propre front envoie.
  api.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Makora') !== '1') {
      return res.status(403).json({ error: 'Requête refusée.' });
    }
    req.user = userFromToken(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    next();
  });

  const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Non connecté.' }));
  const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Réservé aux administrateurs.' }));

  const q = {
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insertUser: db.prepare('INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'),
    users: db.prepare('SELECT id, email, name, role FROM users ORDER BY name COLLATE NOCASE'),
    userById: db.prepare('SELECT id FROM users WHERE id = ?'),
    invite: db.prepare('SELECT * FROM invites WHERE token = ?'),
    insertInvite: db.prepare('INSERT INTO invites (token, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    useInvite: db.prepare('UPDATE invites SET used_by = ? WHERE token = ? AND used_by IS NULL'),
    channel: db.prepare('SELECT * FROM channels WHERE id = ?'),
    channelByName: db.prepare('SELECT * FROM channels WHERE name = ?'),
    insertChannel: db.prepare('INSERT INTO channels (name, topic, is_dm, created_by, created_at) VALUES (?, ?, ?, ?, ?)'),
    member: db.prepare('SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?'),
    members: db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?'),
    join: db.prepare(`INSERT INTO channel_members (channel_id, user_id, last_read_id)
      VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = ?))
      ON CONFLICT DO NOTHING`),
    leave: db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?'),
    markRead: db.prepare('UPDATE channel_members SET last_read_id = MAX(last_read_id, ?) WHERE channel_id = ? AND user_id = ?'),
    channelsFor: db.prepare(`
      SELECT c.id, c.name, c.topic, c.is_dm, m.user_id IS NOT NULL AS joined,
        CASE WHEN m.user_id IS NULL THEN 0 ELSE (
          SELECT COUNT(*) FROM messages x
          WHERE x.channel_id = c.id AND x.id > m.last_read_id AND x.user_id IS NOT ?
        ) END AS unread
      FROM channels c
      LEFT JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
      WHERE c.is_dm = 0 OR m.user_id IS NOT NULL
      ORDER BY c.is_dm, c.name`),
    messagesBefore: db.prepare('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?'),
    message: db.prepare('SELECT * FROM messages WHERE id = ?'),
    insertMessage: db.prepare('INSERT INTO messages (channel_id, user_id, body, created_at) VALUES (?, ?, ?, ?)'),
    updateMessage: db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?'),
    deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
    pages: db.prepare('SELECT id, parent_id, title, updated_at FROM pages ORDER BY created_at, id'),
    page: db.prepare('SELECT * FROM pages WHERE id = ?'),
    insertPage: db.prepare(`INSERT INTO pages (parent_id, title, content, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    updatePage: db.prepare(`UPDATE pages SET parent_id = ?, title = ?, content = ?, version = version + 1,
      updated_by = ?, updated_at = ? WHERE id = ? AND version = ?`),
    deletePage: db.prepare('DELETE FROM pages WHERE id = ?'),
    searchMessages: db.prepare(`
      SELECT m.* FROM messages m
      JOIN channels c ON c.id = m.channel_id
      LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
      WHERE m.body LIKE ? ESCAPE '\\' AND (c.is_dm = 0 OR cm.user_id IS NOT NULL)
      ORDER BY m.id DESC LIMIT 30`),
    searchPages: db.prepare(`
      SELECT id, parent_id, title, content, updated_at FROM pages
      WHERE title LIKE ?1 ESCAPE '\\' OR content LIKE ?1 ESCAPE '\\'
      ORDER BY updated_at DESC LIMIT 20`),
  };

  // --- Helpers d'accès -------------------------------------------------------

  function readableChannel(id, user) {
    const channel = q.channel.get(id);
    if (!channel) fail(404, 'Canal introuvable.');
    if (channel.is_dm && !q.member.get(id, user.id)) fail(404, 'Canal introuvable.');
    return channel;
  }

  function dmPartner(channel, userId) {
    const [, a, b] = channel.name.split(':').map(Number);
    return a === userId ? b : a;
  }

  function toChannel(c, userId) {
    return {
      id: c.id, name: c.name, topic: c.topic, isDm: Boolean(c.is_dm),
      dmUserId: c.is_dm ? dmPartner(c, userId) : null,
      joined: Boolean(c.joined), unread: c.unread ?? 0,
    };
  }

  // Un message d'un canal public est visible par tous, celui d'une conversation privée par ses membres.
  function emitToChannel(channel, event) {
    if (channel.is_dm) hub.sendTo(q.members.all(channel.id).map((r) => r.user_id), event);
    else hub.broadcast(event);
  }

  function login(req, res, userId) {
    const { token, expiresAt } = createSession(db, userId);
    res.set('Set-Cookie', sessionCookie(token, expiresAt, req.secure));
  }

  // --- Comptes ---------------------------------------------------------------

  api.get('/setup', (req, res) => {
    res.json({ needsSetup: q.userCount.get().n === 0 });
  });

  api.get('/invites/:token', (req, res) => {
    const invite = q.invite.get(req.params.token);
    res.json({ valid: Boolean(invite && !invite.used_by && invite.expires_at > Date.now()) });
  });

  api.post('/auth/register', (req, res) => {
    const email = text(req.body?.email, 'email', { min: 3, max: 200 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Adresse email invalide.');
    const name = text(req.body?.name, 'nom', { min: 1, max: 80 });
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 8) fail(400, 'Le mot de passe doit faire au moins 8 caractères.');
    if (password.length > 200) fail(400, 'Mot de passe trop long.');

    const user = transaction(db, () => {
      const first = q.userCount.get().n === 0;
      let invite = null;
      if (!first) {
        invite = q.invite.get(String(req.body?.invite ?? ''));
        if (!invite || invite.used_by || invite.expires_at < Date.now()) fail(403, 'Invitation invalide ou expirée.');
      }
      if (q.userByEmail.get(email)) fail(409, 'Un compte existe déjà avec cet email.');

      const now = Date.now();
      const role = first ? 'admin' : 'member';
      const id = Number(q.insertUser.run(email, name, hashPassword(password), role, now).lastInsertRowid);
      if (invite) q.useInvite.run(id, invite.token);

      let general = q.channelByName.get('general');
      if (!general) {
        const cid = q.insertChannel.run('general', 'Annonces et discussions de toute l’équipe', 0, id, now).lastInsertRowid;
        general = q.channel.get(cid);
        q.insertPage.run(null, 'Bienvenue sur MAKORA HIT', WELCOME_PAGE, id, id, now, now);
      }
      q.join.run(general.id, id, general.id);
      return { id, email, name, role };
    });

    login(req, res, user.id);
    hub.broadcast({ type: 'user:new', user: toUser(user) });
    res.status(201).json({ user });
  });

  api.post('/auth/login', (req, res) => {
    const key = req.ip;
    limiter.check(key);
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const user = q.userByEmail.get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      limiter.failed(key);
      fail(401, 'Email ou mot de passe incorrect.');
    }
    limiter.succeeded(key);
    login(req, res, user.id);
    res.json({ user: toUser(user) });
  });

  api.post('/auth/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) deleteSession(db, token);
    res.set('Set-Cookie', clearSessionCookie()).status(204).end();
  });

  api.use(requireUser);

  api.get('/me', (req, res) => res.json({ user: req.user }));

  api.get('/users', (req, res) => {
    res.json({ users: q.users.all().map(toUser), online: hub.online() });
  });

  api.post('/invites', requireAdmin, (req, res) => {
    const token = newToken();
    const now = Date.now();
    q.insertInvite.run(token, req.user.id, now, now + INVITE_TTL_MS);
    res.status(201).json({ token, expiresAt: now + INVITE_TTL_MS });
  });

  // --- Canaux et messages ----------------------------------------------------

  api.get('/channels', (req, res) => {
    const rows = q.channelsFor.all(req.user.id, req.user.id);
    res.json({ channels: rows.map((c) => toChannel(c, req.user.id)) });
  });

  api.post('/channels', (req, res) => {
    const name = text(req.body?.name, 'nom', { min: 1, max: 40 }).toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) fail(400, 'Nom de canal : lettres minuscules, chiffres, - et _ uniquement.');
    const topic = text(req.body?.topic ?? '', 'sujet', { max: 200 });
    if (q.channelByName.get(name)) fail(409, 'Ce canal existe déjà.');
    const id = Number(q.insertChannel.run(name, topic, 0, req.user.id, Date.now()).lastInsertRowid);
    q.join.run(id, req.user.id, id);
    const channel = { ...q.channel.get(id), joined: 0, unread: 0 };
    hub.broadcast({ type: 'channel:new', channel: toChannel(channel, req.user.id) });
    res.status(201).json({ channel: toChannel({ ...channel, joined: 1 }, req.user.id) });
  });

  api.post('/channels/:id/join', (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    q.join.run(channel.id, req.user.id, channel.id);
    res.status(204).end();
  });

  api.post('/channels/:id/leave', (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    if (channel.is_dm) fail(400, 'Impossible de quitter une conversation privée.');
    q.leave.run(channel.id, req.user.id);
    res.status(204).end();
  });

  api.post('/channels/:id/read', (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    q.markRead.run(Number(req.body?.messageId) || 0, channel.id, req.user.id);
    res.status(204).end();
  });

  api.post('/dms', (req, res) => {
    const otherId = Number(req.body?.userId);
    if (!q.userById.get(otherId)) fail(404, 'Utilisateur introuvable.');
    if (otherId === req.user.id) fail(400, 'Impossible de s’écrire à soi-même.');
    const [a, b] = [req.user.id, otherId].sort((x, y) => x - y);
    const name = `dm:${a}:${b}`;
    let channel = q.channelByName.get(name);
    if (!channel) {
      channel = transaction(db, () => {
        const id = Number(q.insertChannel.run(name, '', 1, req.user.id, Date.now()).lastInsertRowid);
        q.join.run(id, a, id);
        q.join.run(id, b, id);
        return q.channel.get(id);
      });
      hub.sendTo([otherId], { type: 'channel:new', channel: toChannel({ ...channel, joined: 1 }, otherId) });
    }
    res.json({ channel: toChannel({ ...channel, joined: 1 }, req.user.id) });
  });

  api.get('/channels/:id/messages', (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = q.messagesBefore.all(channel.id, before, PAGE_SIZE + 1);
    const hasMore = rows.length > PAGE_SIZE;
    res.json({ messages: rows.slice(0, PAGE_SIZE).reverse().map(toMessage), hasMore });
  });

  api.post('/channels/:id/messages', (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    const body = text(req.body?.body, 'message', { min: 1, max: 4000 });
    const message = transaction(db, () => {
      q.join.run(channel.id, req.user.id, channel.id);
      const id = q.insertMessage.run(channel.id, req.user.id, body, Date.now()).lastInsertRowid;
      q.markRead.run(id, channel.id, req.user.id);
      return toMessage(q.message.get(id));
    });
    emitToChannel(channel, { type: 'message:new', message });
    res.status(201).json({ message });
  });

  api.patch('/messages/:id', (req, res) => {
    const message = q.message.get(intParam(req.params.id));
    if (!message) fail(404, 'Message introuvable.');
    if (message.user_id !== req.user.id) fail(403, 'Vous ne pouvez modifier que vos messages.');
    const body = text(req.body?.body, 'message', { min: 1, max: 4000 });
    q.updateMessage.run(body, Date.now(), message.id);
    const updated = toMessage(q.message.get(message.id));
    emitToChannel(q.channel.get(message.channel_id), { type: 'message:updated', message: updated });
    res.json({ message: updated });
  });

  api.delete('/messages/:id', (req, res) => {
    const message = q.message.get(intParam(req.params.id));
    if (!message) fail(404, 'Message introuvable.');
    if (message.user_id !== req.user.id && req.user.role !== 'admin') fail(403, 'Vous ne pouvez supprimer que vos messages.');
    q.deleteMessage.run(message.id);
    emitToChannel(q.channel.get(message.channel_id), {
      type: 'message:deleted', messageId: message.id, channelId: message.channel_id,
    });
    res.status(204).end();
  });

  // --- Pages (wiki) ----------------------------------------------------------

  function checkParent(parentId, pageId) {
    if (parentId == null) return null;
    let cursor = q.page.get(Number(parentId));
    if (!cursor) fail(400, 'Page parente introuvable.');
    const id = cursor.id;
    // Empêche de ranger une page dans une de ses propres sous-pages.
    while (cursor) {
      if (cursor.id === pageId) fail(400, 'Une page ne peut pas être rangée dans ses sous-pages.');
      cursor = cursor.parent_id ? q.page.get(cursor.parent_id) : null;
    }
    return id;
  }

  const pageSummary = (p) => ({ id: p.id, parentId: p.parent_id, title: p.title, updatedAt: p.updated_at });

  api.get('/pages', (req, res) => {
    res.json({ pages: q.pages.all().map(pageSummary) });
  });

  api.post('/pages', (req, res) => {
    const parentId = checkParent(req.body?.parentId, null);
    const title = text(req.body?.title ?? '', 'titre', { max: 200 });
    const now = Date.now();
    const id = q.insertPage.run(parentId, title, '', req.user.id, req.user.id, now, now).lastInsertRowid;
    const page = q.page.get(id);
    hub.broadcast({ type: 'page:changed', page: pageSummary(page), by: req.user.id });
    res.status(201).json({ page: toPage(page) });
  });

  api.get('/pages/:id', (req, res) => {
    const page = q.page.get(intParam(req.params.id));
    if (!page) fail(404, 'Page introuvable.');
    res.json({ page: toPage(page) });
  });

  api.patch('/pages/:id', (req, res) => {
    const page = q.page.get(intParam(req.params.id));
    if (!page) fail(404, 'Page introuvable.');
    const b = req.body ?? {};
    const title = b.title === undefined ? page.title : text(b.title, 'titre', { max: 200 });
    const content = b.content === undefined ? page.content : b.content;
    if (typeof content !== 'string' || content.length > 200_000) fail(400, 'Contenu invalide ou trop long.');
    const parentId = b.parentId === undefined ? page.parent_id : checkParent(b.parentId, page.id);
    // Verrou optimiste : si quelqu'un a enregistré entre-temps, on refuse plutôt que d'écraser son travail.
    const version = Number(b.version);
    if (version !== page.version) fail(409, 'Cette page a été modifiée par quelqu’un d’autre.');
    const result = q.updatePage.run(parentId, title, content, req.user.id, Date.now(), page.id, version);
    if (result.changes === 0) fail(409, 'Cette page a été modifiée par quelqu’un d’autre.');
    const updated = q.page.get(page.id);
    hub.broadcast({ type: 'page:changed', page: pageSummary(updated), version: updated.version, by: req.user.id });
    res.json({ page: toPage(updated) });
  });

  api.delete('/pages/:id', (req, res) => {
    const page = q.page.get(intParam(req.params.id));
    if (!page) fail(404, 'Page introuvable.');
    if (page.created_by !== req.user.id && req.user.role !== 'admin') {
      fail(403, 'Seul l’auteur de la page ou un administrateur peut la supprimer.');
    }
    q.deletePage.run(page.id);
    hub.broadcast({ type: 'page:deleted', pageId: page.id });
    res.status(204).end();
  });

  // --- Recherche -------------------------------------------------------------

  api.get('/search', (req, res) => {
    const term = String(req.query.q ?? '').trim();
    if (term.length < 2) return res.json({ messages: [], pages: [] });
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const messages = q.searchMessages.all(req.user.id, like).map(toMessage);
    const pages = q.searchPages.all(like).map((p) => ({ ...pageSummary(p), excerpt: excerpt(p.content, term) }));
    res.json({ messages, pages });
  });

  api.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Contenu trop volumineux.' });
    console.error(err);
    res.status(500).json({ error: 'Erreur interne.' });
  });

  return app;
}

function excerpt(content, term) {
  const i = content.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return content.slice(0, 140);
  const start = Math.max(0, i - 60);
  return (start > 0 ? '…' : '') + content.slice(start, i + term.length + 80).replace(/\s+/g, ' ');
}

const WELCOME_PAGE = `Bienvenue dans l'espace de travail de votre équipe 👋

## Messagerie
- Discutez dans les **canaux** (colonne de gauche), créez-en avec le bouton **+**.
- Cliquez sur un collègue pour lui écrire en **message privé**.
- \`Entrée\` envoie, \`Maj + Entrée\` ajoute une ligne.

## Pages
- Les pages servent de wiki : procédures, comptes rendus, onboarding...
- Elles s'écrivent en Markdown et s'enregistrent automatiquement.
- Créez des **sous-pages** pour organiser vos documents.

## À faire
- [ ] Inviter mon équipe (menu en bas à gauche → Inviter)
- [ ] Créer les premiers canaux
- [ ] Rédiger la page « Qui fait quoi »
`;
