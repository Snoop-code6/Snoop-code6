import express from 'express';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearSessionCookie, createSession, deleteSession, hashPassword, hashToken, newToken,
  parseCookies, SESSION_COOKIE, sessionCookie, userFromToken, verifyPassword,
} from './auth.js';
import { transaction } from './db.js';
import { digestEmail, inviteEmail, resetEmail } from './emails.js';
import { mentionRegex } from '../public/markdown.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const RESET_TTL_MS = 24 * 3600 * 1000;
const SSO_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const SSO_COOKIE = 'makora_sso';
const DIGEST_DELAY_MS = Number(process.env.EMAIL_DIGEST_DELAY_MIN ?? 15) * 60 * 1000;
const DIGEST_MIN_INTERVAL_MS = 3600 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGE_SIZE = 50;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 20) * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const ORPHAN_TTL_MS = 24 * 3600 * 1000;
const MAX_REACTIONS_PER_MESSAGE = 20;
// Un emoji (avec ses variantes : couleur de peau, drapeaux, séquences ZWJ), et rien d'autre.
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f]*$/u;
const EVERYONE = 'tous';
const VERSION_SESSION_MS = 10 * 60 * 1000;
const MAX_VERSIONS_PER_PAGE = 200;
// Seules ces images sont affichées dans la page ; tout le reste est proposé en téléchargement.
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

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

const toUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: !u.deactivated_at });
const THREAD_STATS = `
  (SELECT COUNT(*) FROM messages r WHERE r.parent_id = m.id) AS reply_count,
  (SELECT MAX(r.created_at) FROM messages r WHERE r.parent_id = m.id) AS last_reply_at`;

const toAttachment =(a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size });
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

// push : { publicKey, send(subscription, payload) } ; absent, les notifications push sont désactivées.
// mailer : { send({ to, subject, text, html }) } ; les emails demandent aussi publicUrl (adresse publique
// de l'application), car les liens qu'ils contiennent ne doivent jamais dépendre de la requête reçue.
// oidc : connexion via Google Workspace / Microsoft 365 (voir oidc.js).
export function createApp({ db, hub, uploadDir: dir, push = null, mailer = null, publicUrl = null, oidc = null }) {
  const mail = mailer && publicUrl ? mailer : null;
  const appUrl = publicUrl?.replace(/\/$/, '');
  const uploadDir = resolve(dir);
  mkdirSync(uploadDir, { recursive: true });
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
    users: db.prepare('SELECT id, email, name, role, deactivated_at FROM users ORDER BY name COLLATE NOCASE'),
    activeUsers: db.prepare('SELECT id, email, name, role FROM users WHERE deactivated_at IS NULL ORDER BY name COLLATE NOCASE'),
    adminUsers: db.prepare('SELECT id, email, name, role, deactivated_at, created_at FROM users ORDER BY name COLLATE NOCASE'),
    fullUser: db.prepare('SELECT * FROM users WHERE id = ?'),
    activeAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND deactivated_at IS NULL"),
    setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    setActive: db.prepare('UPDATE users SET deactivated_at = ? WHERE id = ?'),
    setName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    deleteSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?'),
    deleteUserPushSubscriptions: db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?'),
    insertReset: db.prepare('INSERT INTO password_resets (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'),
    reset: db.prepare(`SELECT r.*, u.name, u.deactivated_at FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = ?`),
    useReset: db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL'),
    pendingInvites: db.prepare(`SELECT token, created_by, created_at, expires_at, email FROM invites
      WHERE used_by IS NULL AND expires_at > ? ORDER BY created_at DESC`),
    deleteInvite: db.prepare('DELETE FROM invites WHERE token = ? AND used_by IS NULL'),
    userName: db.prepare('SELECT name FROM users WHERE id = ?'),
    userById: db.prepare('SELECT id FROM users WHERE id = ? AND deactivated_at IS NULL'),
    invite: db.prepare('SELECT * FROM invites WHERE token = ?'),
    insertInvite: db.prepare('INSERT INTO invites (token, created_by, created_at, expires_at, email) VALUES (?, ?, ?, ?, ?)'),
    lastResetFor: db.prepare('SELECT MAX(created_at) AS at FROM password_resets WHERE user_id = ?'),
    insertSsoAttempt: db.prepare('INSERT INTO sso_attempts (state, nonce, verifier, created_at) VALUES (?, ?, ?, ?)'),
    takeSsoAttempt: db.prepare('DELETE FROM sso_attempts WHERE state = ? RETURNING *'),
    purgeSsoAttempts: db.prepare('DELETE FROM sso_attempts WHERE created_at < ?'),
    setEmailNotifications: db.prepare('UPDATE users SET email_notifications = ? WHERE id = ?'),
    digestCandidates: db.prepare(`SELECT n.*, m.body, m.channel_id, m.parent_id, pg.title AS page_title,
        (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachment_count
      FROM notifications n LEFT JOIN messages m ON m.id = n.message_id LEFT JOIN pages pg ON pg.id = n.page_id
      JOIN users u ON u.id = n.user_id
      WHERE n.read_at IS NULL AND n.emailed_at IS NULL AND n.created_at <= ?
        AND u.deactivated_at IS NULL AND u.email_notifications = 1
        AND (u.last_digest_at IS NULL OR u.last_digest_at <= ?)
      ORDER BY n.user_id, n.id`),
    markEmailed: db.prepare('UPDATE notifications SET emailed_at = ? WHERE id IN (SELECT value FROM json_each(?))'),
    setLastDigest: db.prepare('UPDATE users SET last_digest_at = ? WHERE id = ?'),
    useInvite: db.prepare('UPDATE invites SET used_by = ? WHERE token = ? AND used_by IS NULL'),
    channel: db.prepare('SELECT * FROM channels WHERE id = ?'),
    channelByName: db.prepare('SELECT * FROM channels WHERE name = ?'),
    insertChannel: db.prepare('INSERT INTO channels (name, topic, is_dm, created_by, created_at, is_private) VALUES (?, ?, ?, ?, ?, ?)'),
    member: db.prepare('SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?'),
    members: db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?'),
    join: db.prepare(`INSERT INTO channel_members (channel_id, user_id, last_read_id)
      VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = ?))
      ON CONFLICT DO NOTHING`),
    leave: db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?'),
    markRead: db.prepare('UPDATE channel_members SET last_read_id = MAX(last_read_id, ?) WHERE channel_id = ? AND user_id = ?'),
    channelsFor: db.prepare(`
      SELECT c.id, c.name, c.topic, c.is_dm, c.is_private, c.created_by, m.user_id IS NOT NULL AS joined, m.notify,
        (SELECT COUNT(*) FROM channel_members x WHERE x.channel_id = c.id) AS member_count,
        CASE WHEN m.user_id IS NULL THEN 0 ELSE (
          SELECT COUNT(*) FROM messages x
          WHERE x.channel_id = c.id AND x.parent_id IS NULL AND x.id > m.last_read_id AND x.user_id IS NOT ?
        ) END AS unread
      FROM channels c
      LEFT JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
      WHERE (c.is_dm = 0 AND c.is_private = 0) OR m.user_id IS NOT NULL
      ORDER BY c.is_dm, c.name`),
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?'),
    lastVersion: db.prepare('SELECT * FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT 1'),
    insertVersion: db.prepare(`INSERT INTO page_versions (page_id, version, title, content, edited_by, restored_from, started_at, saved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    extendVersion: db.prepare('UPDATE page_versions SET version = ?, title = ?, content = ?, saved_at = ? WHERE id = ?'),
    pruneVersions: db.prepare(`DELETE FROM page_versions WHERE page_id = ?1 AND id NOT IN (
      SELECT id FROM page_versions WHERE page_id = ?1 ORDER BY id DESC LIMIT ?2)`),
    versions: db.prepare(`SELECT id, version, title, edited_by, restored_from, started_at, saved_at, length(content) AS length
      FROM page_versions WHERE page_id = ? ORDER BY id DESC`),
    pageVersion: db.prepare('SELECT * FROM page_versions WHERE id = ? AND page_id = ?'),
    pushSubscriptions: db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?'),
    savePushSubscription: db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`),
    deletePushSubscription: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
    deleteUserPushSubscription: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?'),
    messagesBefore: db.prepare(`SELECT m.*, ${THREAD_STATS} FROM messages m
      WHERE m.channel_id = ? AND m.parent_id IS NULL AND m.id < ? ORDER BY m.id DESC LIMIT ?`),
    message: db.prepare(`SELECT m.*, ${THREAD_STATS} FROM messages m WHERE m.id = ?`),
    replies: db.prepare('SELECT * FROM messages WHERE parent_id = ? ORDER BY id LIMIT 1000'),
    insertMessage: db.prepare('INSERT INTO messages (channel_id, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?)'),
    updateMessage: db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?'),
    deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
    insertAttachment: db.prepare(`INSERT INTO attachments (channel_id, user_id, name, mime, size, storage_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    attachment: db.prepare('SELECT * FROM attachments WHERE id = ?'),
    linkAttachment: db.prepare(`UPDATE attachments SET message_id = ?
      WHERE id = ? AND user_id = ? AND channel_id = ? AND message_id IS NULL`),
    attachmentsFor: db.prepare(`SELECT * FROM attachments
      WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY id`),
    attachmentsOfTree: db.prepare(`SELECT storage_key FROM attachments
      WHERE message_id = ?1 OR message_id IN (SELECT id FROM messages WHERE parent_id = ?1)`),
    orphanAttachments: db.prepare('SELECT id, storage_key FROM attachments WHERE message_id IS NULL AND created_at < ?'),
    deleteAttachment: db.prepare('DELETE FROM attachments WHERE id = ?'),
    reactionsFor: db.prepare(`SELECT message_id, emoji, user_id FROM reactions
      WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`),
    reaction: db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
    reactionKinds: db.prepare('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ? AND emoji != ?'),
    addReaction: db.prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)'),
    removeReaction: db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
    threadParticipants: db.prepare('SELECT DISTINCT user_id FROM messages WHERE (id = ?1 OR parent_id = ?1) AND user_id IS NOT NULL'),
    insertNotification: db.prepare(`INSERT INTO notifications (user_id, kind, actor_id, message_id, emoji, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    insertPageNotification: db.prepare(`INSERT INTO notifications (user_id, kind, actor_id, page_id, excerpt, created_at)
      VALUES (?, 'page_mention', ?, ?, ?, ?)`),
    unreadPageMention: db.prepare(`SELECT 1 FROM notifications
      WHERE user_id = ? AND page_id = ? AND kind = 'page_mention' AND read_at IS NULL`),
    allPagesAccess: db.prepare('SELECT id, parent_id, access, created_by FROM pages'),
    allPageMembers: db.prepare('SELECT page_id, user_id, role FROM page_members'),
    pageMembers: db.prepare('SELECT user_id, role FROM page_members WHERE page_id = ?'),
    clearPageMembers: db.prepare('DELETE FROM page_members WHERE page_id = ?'),
    insertPageMember: db.prepare('INSERT INTO page_members (page_id, user_id, role) VALUES (?, ?, ?)'),
    setPageAccess: db.prepare('UPDATE pages SET access = ? WHERE id = ?'),
    removeReactionNotification: db.prepare(`DELETE FROM notifications
      WHERE kind = 'reaction' AND actor_id = ? AND message_id = ? AND emoji = ?`),
    notification: db.prepare(`SELECT n.*, m.body, m.channel_id, m.parent_id, pg.title AS page_title,
        (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachment_count
      FROM notifications n LEFT JOIN messages m ON m.id = n.message_id LEFT JOIN pages pg ON pg.id = n.page_id WHERE n.id = ?`),
    notifications: db.prepare(`SELECT n.*, m.body, m.channel_id, m.parent_id, pg.title AS page_title,
        (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachment_count
      FROM notifications n LEFT JOIN messages m ON m.id = n.message_id LEFT JOIN pages pg ON pg.id = n.page_id
      WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 50`),
    unreadNotifications: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL'),
    readNotifications: db.prepare(`UPDATE notifications SET read_at = ?
      WHERE user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))`),
    readAllNotifications: db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL'),
    pages: db.prepare('SELECT id, parent_id, title, updated_at, access FROM pages ORDER BY created_at, id'),
    page: db.prepare('SELECT * FROM pages WHERE id = ?'),
    insertPage: db.prepare(`INSERT INTO pages (parent_id, title, content, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    updatePage: db.prepare(`UPDATE pages SET parent_id = ?, title = ?, content = ?, version = version + 1,
      updated_by = ?, updated_at = ? WHERE id = ? AND version = ?`),
    deletePage: db.prepare('DELETE FROM pages WHERE id = ?'),
    setNotify: db.prepare('UPDATE channel_members SET notify = ? WHERE channel_id = ? AND user_id = ?'),
    membersWithNotify: db.prepare('SELECT user_id, notify FROM channel_members WHERE channel_id = ?'),
    insertPageFile: db.prepare(`INSERT INTO page_files (page_id, user_id, name, mime, size, storage_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    pageFile: db.prepare('SELECT * FROM page_files WHERE id = ?'),
    pageFiles: db.prepare('SELECT * FROM page_files WHERE page_id = ? ORDER BY id'),
    deletePageFile: db.prepare('DELETE FROM page_files WHERE id = ?'),
    // Fichiers d'une page et de toutes ses sous-pages (supprimés avec elles).
    pageTreeFiles: db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ?1 UNION ALL SELECT p.id FROM pages p JOIN tree ON p.parent_id = tree.id)
      SELECT storage_key FROM page_files WHERE page_id IN (SELECT id FROM tree)`),
    searchMessages: db.prepare(`
      SELECT m.* FROM messages m
      JOIN channels c ON c.id = m.channel_id
      LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
      WHERE m.body LIKE ? ESCAPE '\\' AND ((c.is_dm = 0 AND c.is_private = 0) OR cm.user_id IS NOT NULL)
      ORDER BY m.id DESC LIMIT 30`),
    searchPages: db.prepare(`
      SELECT id, parent_id, title, content, updated_at FROM pages
      WHERE title LIKE ?1 ESCAPE '\\' OR content LIKE ?1 ESCAPE '\\'
      ORDER BY updated_at DESC LIMIT 200`),
  };

  // --- Helpers d'accès -------------------------------------------------------

  function readableChannel(id, user) {
    const channel = q.channel.get(id);
    if (!channel) fail(404, 'Canal introuvable.');
    if (isRestricted(channel) && !q.member.get(id, user.id)) fail(404, 'Canal introuvable.');
    return channel;
  }

  function dmPartner(channel, userId) {
    const [, a, b] = channel.name.split(':').map(Number);
    return a === userId ? b : a;
  }

  // Conversations privées et canaux privés : réservés à leurs membres.
  const isRestricted = (channel) => Boolean(channel.is_dm || channel.is_private);

  function toChannel(c, userId) {
    return {
      id: c.id, name: c.name, topic: c.topic, isDm: Boolean(c.is_dm), isPrivate: Boolean(c.is_private),
      createdBy: c.created_by, memberCount: c.member_count ?? q.memberCount.get(c.id).n,
      dmUserId: c.is_dm ? dmPartner(c, userId) : null,
      joined: Boolean(c.joined), unread: c.unread ?? 0, notify: c.notify ?? null,
    };
  }

  // Un message d'un canal public est visible par tous, celui d'une conversation privée par ses membres.
  function emitToChannel(channel, event) {
    if (isRestricted(channel)) hub.sendTo(memberIds(channel.id), event);
    else hub.broadcast(event);
  }

  // Regroupe les réactions par emoji : [{ emoji, userIds }], dans l'ordre d'apparition.
  function reactionsByMessage(ids) {
    const byMessage = new Map();
    if (!ids.length) return byMessage;
    for (const r of q.reactionsFor.all(JSON.stringify(ids))) {
      if (!byMessage.has(r.message_id)) byMessage.set(r.message_id, []);
      const list = byMessage.get(r.message_id);
      let entry = list.find((e) => e.emoji === r.emoji);
      if (!entry) list.push(entry = { emoji: r.emoji, userIds: [] });
      entry.userIds.push(r.user_id);
    }
    return byMessage;
  }

  const memberIds = (channelId) => q.members.all(channelId).map((r) => r.user_id);

  // Transforme des lignes de la table messages en objets d'API, pièces jointes et réactions comprises.
  function toMessages(rows) {
    const byMessage = new Map();
    const ids = rows.map((r) => r.id);
    if (rows.length) {
      for (const a of q.attachmentsFor.all(JSON.stringify(ids))) {
        if (!byMessage.has(a.message_id)) byMessage.set(a.message_id, []);
        byMessage.get(a.message_id).push(toAttachment(a));
      }
    }
    const reactions = reactionsByMessage(ids);
    return rows.map((m) => ({
      id: m.id, channelId: m.channel_id, userId: m.user_id, parentId: m.parent_id, body: m.body,
      createdAt: m.created_at, editedAt: m.edited_at,
      replyCount: m.reply_count ?? 0, lastReplyAt: m.last_reply_at ?? null,
      attachments: byMessage.get(m.id) ?? [],
      reactions: reactions.get(m.id) ?? [],
    }));
  }

  const toMessage = (row) => toMessages([row])[0];

  // --- Notifications -------------------------------------------------------

  function toNotification(n) {
    const base = { id: n.id, kind: n.kind, actorId: n.actor_id, emoji: n.emoji, createdAt: n.created_at, read: Boolean(n.read_at) };
    if (n.page_id) return { ...base, pageId: n.page_id, pageTitle: n.page_title ?? '', excerpt: n.excerpt ?? '' };
    const excerpt = (n.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return {
      ...base, messageId: n.message_id, channelId: n.channel_id, parentId: n.parent_id,
      excerpt: excerpt || (n.attachment_count ? '📎 Pièce jointe' : ''),
    };
  }

  const notificationUrl = (n) => (n.pageId ? `/#/p/${n.pageId}` : messageUrl(n.channelId, n.parentId));

  function deliver(userId, id) {
    const notification = toNotification(q.notification.get(id));
    hub.sendTo([userId], { type: 'notification:new', notification });
    pushTo(userId, {
      title: notificationTitle(notification),
      body: notification.excerpt,
      url: notificationUrl(notification),
      tag: `notification-${id}`,
    });
  }

  // Une notification de page n'est montrée que si la personne a (encore) accès à la page.
  function visibleNotifications(rows, userId) {
    const index = rows.some((r) => r.page_id) ? pageAccessIndex() : null;
    const user = { id: userId };
    return rows.filter((r) => !r.page_id || index.rights(r.page_id, user).view);
  }

  function notify(userId, kind, actorId, messageId, emoji = null) {
    deliver(userId, q.insertNotification.run(userId, kind, actorId, messageId, emoji, Date.now()).lastInsertRowid);
  }

  const userNameOf = (id) => q.userName.get(id)?.name ?? 'Quelqu’un';
  const messageUrl = (channelId, parentId) => (parentId ? `/#/c/${channelId}/t/${parentId}` : `/#/c/${channelId}`);

  function channelLabel(channel) {
    if (!channel) return '';
    if (channel.is_dm) return 'en message privé';
    return `dans ${channel.is_private ? '🔒' : '#'}${channel.name}`;
  }

  function notificationTitle(n) {
    const who = userNameOf(n.actorId);
    if (n.kind === 'page_mention') return `${who} vous a mentionné dans la page « ${n.pageTitle || 'Sans titre'} »`;
    const where = channelLabel(q.channel.get(n.channelId));
    if (n.kind === 'mention') return `${who} vous a mentionné ${where}`;
    if (n.kind === 'reply') return `${who} a répondu dans un fil ${where}`;
    return `${who} a réagi ${n.emoji} à votre message`;
  }

  // Les push ne partent que vers les personnes qui n'ont aucun onglet au premier plan :
  // sinon elles voient déjà la notification dans l'application.
  function pushTo(userId, payload) {
    if (!push || hub.isActive(userId)) return;
    for (const sub of q.pushSubscriptions.all(userId)) {
      Promise.resolve()
        .then(() => push.send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload))
        .catch((err) => {
          // 404 / 410 : l'abonnement n'existe plus côté navigateur.
          if (err?.statusCode === 404 || err?.statusCode === 410) q.deletePushSubscription.run(sub.endpoint);
          else console.warn('Échec de l’envoi push :', err?.message ?? err);
        });
    }
  }

  function canRead(channel, userId) {
    return !isRestricted(channel) || Boolean(q.member.get(channel.id, userId));
  }

  // Réglage effectif d'un membre : 'all', 'mentions' ou 'none'.
  const notifyLevel = (channel, notify) => notify ?? (channel.is_dm ? 'all' : 'mentions');

  // Une seule notification par personne et par message : la mention l'emporte sur la réponse dans un fil.
  // Un canal muet ne notifie plus @tous ni les réponses, mais une mention directe passe toujours.
  function notifyForMessage(message, channel, author) {
    const levels = new Map(q.membersWithNotify.all(channel.id).map((m) => [m.user_id, notifyLevel(channel, m.notify)]));
    const targets = new Map();
    const users = q.activeUsers.all();
    const names = [...users.map((u) => u.name), EVERYONE];
    for (const match of message.body.matchAll(mentionRegex(names))) {
      const name = match[2].toLowerCase();
      if (name === EVERYONE) {
        for (const [id, level] of levels) if (level !== 'none') targets.set(id, 'mention');
      } else {
        for (const u of users) if (u.name.toLowerCase() === name) targets.set(u.id, 'mention');
      }
    }
    if (message.parentId) {
      for (const { user_id: id } of q.threadParticipants.all(message.parentId)) {
        if (!targets.has(id) && levels.get(id) !== 'none') targets.set(id, 'reply');
      }
    }
    targets.delete(author.id);
    for (const [userId, kind] of targets) {
      if (canRead(channel, userId)) notify(userId, kind, author.id, message.id);
    }
    // Réglage « tous les messages » (par défaut pour les messages privés) : un push même sans mention.
    // Les réponses dans un fil n'en déclenchent pas, sauf pour ceux qui y participent (déjà notifiés).
    if (message.parentId) return;
    for (const [userId, level] of levels) {
      if (level !== 'all' || userId === author.id || targets.has(userId)) continue;
      pushTo(userId, {
        title: channel.is_dm ? author.name : `${author.name} ${channelLabel(channel)}`,
        body: message.body.replace(/\s+/g, ' ').slice(0, 160) || '📎 Pièce jointe',
        url: messageUrl(channel.id, null),
        tag: `channel-${channel.id}`,
      });
    }
  }

  function removeFiles(keys) {
    for (const key of keys) rmSync(join(uploadDir, key), { force: true });
  }

  // Supprime les fichiers envoyés mais jamais publiés dans un message.
  function cleanupOrphans() {
    for (const a of q.orphanAttachments.all(Date.now() - ORPHAN_TTL_MS)) {
      q.deleteAttachment.run(a.id);
      removeFiles([a.storage_key]);
    }
  }
  cleanupOrphans();
  setInterval(cleanupOrphans, 3600 * 1000).unref();

  function login(req, res, userId) {
    const { token, expiresAt } = createSession(db, userId);
    res.append('Set-Cookie', sessionCookie(token, expiresAt, req.secure));
  }

  // --- Comptes ---------------------------------------------------------------

  api.get('/setup', (req, res) => {
    res.json({ needsSetup: q.userCount.get().n === 0, sso: oidc ? { label: oidc.label } : null, email: Boolean(mail) });
  });

  // Envoi « au mieux » : un email qui échoue ne doit pas faire échouer l'action demandée.
  async function sendMail(to, content) {
    try {
      await mail.send({ to, ...content });
      return true;
    } catch (err) {
      console.warn(`Échec de l’envoi d’email à ${to} :`, err.message);
      return false;
    }
  }

  function createAccount({ email, name, passwordHash, role }) {
    const now = Date.now();
    const id = Number(q.insertUser.run(email, name, passwordHash, role, now).lastInsertRowid);
    let general = q.channelByName.get('general');
    if (!general) {
      const cid = q.insertChannel.run('general', 'Annonces et discussions de toute l’équipe', 0, id, now, 0).lastInsertRowid;
      general = q.channel.get(cid);
      q.insertPage.run(null, 'Bienvenue sur MAKORA HIT', WELCOME_PAGE, id, id, now, now);
    }
    q.join.run(general.id, id, general.id);
    return id;
  }

  api.get('/invites/:token', (req, res) => {
    const invite = q.invite.get(req.params.token);
    const valid = Boolean(invite && !invite.used_by && invite.expires_at > Date.now());
    res.json({ valid, email: valid ? invite.email ?? null : null });
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
      // Une invitation envoyée à une adresse précise ne sert qu'à cette adresse.
      if (invite?.email && invite.email !== email) fail(403, `Cette invitation est réservée à ${invite.email}.`);
      if (q.userByEmail.get(email)) fail(409, 'Un compte existe déjà avec cet email.');

      const role = first ? 'admin' : 'member';
      const id = createAccount({ email, name, passwordHash: hashPassword(password), role });
      if (invite) q.useInvite.run(id, invite.token);
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
    if (user.deactivated_at) fail(403, 'Ce compte a été désactivé. Contactez votre administrateur.');
    limiter.succeeded(key);
    login(req, res, user.id);
    res.json({ user: toUser(user) });
  });

  // --- Réinitialisation du mot de passe (lien créé par un administrateur) -----

  function validPassword(password) {
    if (typeof password !== 'string' || password.length < 8) fail(400, 'Le mot de passe doit faire au moins 8 caractères.');
    if (password.length > 200) fail(400, 'Mot de passe trop long.');
    return password;
  }

  function usableReset(token) {
    const reset = q.reset.get(hashToken(String(token ?? '')));
    if (!reset || reset.used_at || reset.expires_at < Date.now() || reset.deactivated_at) return null;
    return reset;
  }

  function createResetLink(userId, createdBy) {
    const token = newToken();
    const now = Date.now();
    q.insertReset.run(hashToken(token), userId, createdBy, now, now + RESET_TTL_MS);
    return { token, expiresAt: now + RESET_TTL_MS };
  }

  // Réponse identique que le compte existe ou non, pour ne pas révéler qui a un compte.
  api.post('/auth/forgot', (req, res) => {
    if (!mail) fail(404, 'La réinitialisation par email n’est pas configurée sur ce serveur.');
    const key = `forgot:${req.ip}`;
    limiter.check(key);
    limiter.failed(key); // chaque demande compte, réussie ou non
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const user = q.userByEmail.get(email);
    const recent = user && (q.lastResetFor.get(user.id).at ?? 0) > Date.now() - 2 * 60 * 1000;
    if (user && !user.deactivated_at && !recent) {
      const { token, expiresAt } = createResetLink(user.id, null);
      sendMail(user.email, resetEmail({ name: user.name, link: `${appUrl}/#/reset/${token}`, expiresAt, requested: true }));
    }
    res.status(204).end();
  });

  // --- Connexion via Google Workspace / Microsoft 365 -------------------------

  const ssoFail = (res, code) => res.redirect(303, `/#/login-error/${code}`);

  api.get('/auth/sso', async (req, res) => {
    if (!oidc) return res.status(404).json({ error: 'Connexion SSO non configurée.' });
    try {
      q.purgeSsoAttempts.run(Date.now() - SSO_ATTEMPT_TTL_MS);
      const attempt = oidc.newAttempt();
      q.insertSsoAttempt.run(attempt.state, attempt.nonce, attempt.verifier, Date.now());
      // Le cookie lie la tentative à ce navigateur (empêche de faire connecter quelqu'un à son insu).
      res.set('Set-Cookie', `${SSO_COOKIE}=${attempt.state}; Path=/api/auth/sso; HttpOnly; SameSite=Lax; Max-Age=600${req.secure ? '; Secure' : ''}`);
      res.redirect(303, await oidc.authorizationUrl(attempt));
    } catch (err) {
      console.warn('SSO indisponible :', err.message);
      ssoFail(res, 'provider');
    }
  });

  api.get('/auth/sso/callback', async (req, res) => {
    if (!oidc) return res.status(404).json({ error: 'Connexion SSO non configurée.' });
    res.append('Set-Cookie', `${SSO_COOKIE}=; Path=/api/auth/sso; HttpOnly; SameSite=Lax; Max-Age=0`);
    if (req.query.error) return ssoFail(res, 'cancelled');
    const state = String(req.query.state ?? '');
    const attempt = state && parseCookies(req.headers.cookie)[SSO_COOKIE] === state ? q.takeSsoAttempt.get(state) : null;
    if (!attempt || attempt.created_at < Date.now() - SSO_ATTEMPT_TTL_MS) return ssoFail(res, 'expired');

    let identity;
    try {
      identity = await oidc.complete({ code: String(req.query.code ?? ''), verifier: attempt.verifier, nonce: attempt.nonce });
    } catch (err) {
      console.warn('Échec de la connexion SSO :', err.message);
      return ssoFail(res, err.code === 'email' ? 'email' : 'provider');
    }

    let user = q.userByEmail.get(identity.email);
    if (user?.deactivated_at) return ssoFail(res, 'deactivated');
    if (!user) {
      // Le premier compte (administrateur) se crée avec un mot de passe.
      if (q.userCount.get().n === 0) return ssoFail(res, 'setup');
      if (!identity.domainAllowed) return ssoFail(res, 'not_allowed');
      // Pas de mot de passe : « sso$ » n'est pas un format reconnu, la connexion par mot de passe est impossible.
      const id = transaction(db, () => createAccount({ email: identity.email, name: identity.name, passwordHash: 'sso$', role: 'member' }));
      user = q.fullUser.get(id);
      hub.broadcast({ type: 'user:new', user: toUser(user) });
    }
    login(req, res, user.id);
    res.redirect(303, '/#/');
  });

  api.get('/reset/:token', (req, res) => {
    const reset = usableReset(req.params.token);
    res.json({ valid: Boolean(reset), name: reset?.name ?? null });
  });

  api.post('/auth/reset', (req, res) => {
    const password = validPassword(req.body?.password);
    const reset = usableReset(req.body?.token);
    if (!reset) fail(400, 'Ce lien de réinitialisation est invalide, déjà utilisé ou expiré.');
    transaction(db, () => {
      if (q.useReset.run(Date.now(), reset.token_hash).changes === 0) fail(400, 'Ce lien a déjà été utilisé.');
      q.setPassword.run(hashPassword(password), reset.user_id);
      // Toutes les sessions ouvertes avec l'ancien mot de passe sont fermées.
      q.deleteSessions.run(reset.user_id);
    });
    hub.disconnect(reset.user_id);
    login(req, res, reset.user_id);
    res.json({ user: toUser(q.fullUser.get(reset.user_id)) });
  });

  api.post('/auth/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) deleteSession(db, token);
    res.set('Set-Cookie', clearSessionCookie()).status(204).end();
  });

  api.use(requireUser);

  api.get('/me', (req, res) => {
    const full = q.fullUser.get(req.user.id);
    res.json({
      user: { ...req.user, hasPassword: full.password_hash.startsWith('scrypt$'), emailNotifications: Boolean(full.email_notifications) },
      limits: { maxUploadBytes: MAX_UPLOAD_BYTES, maxAttachments: MAX_ATTACHMENTS },
      features: { email: Boolean(mail), sso: oidc ? oidc.label : null },
    });
  });

  // --- Mon compte ----------------------------------------------------------

  const broadcastUser = (id) => hub.broadcast({ type: 'user:updated', user: toUser(q.fullUser.get(id)) });

  api.patch('/me', (req, res) => {
    const b = req.body ?? {};
    if (b.emailNotifications !== undefined) {
      if (typeof b.emailNotifications !== 'boolean') fail(400, 'Préférence invalide.');
      q.setEmailNotifications.run(b.emailNotifications ? 1 : 0, req.user.id);
    }
    if (b.name !== undefined) {
      q.setName.run(text(b.name, 'nom', { min: 1, max: 80 }), req.user.id);
      broadcastUser(req.user.id);
    }
    const full = q.fullUser.get(req.user.id);
    res.json({ user: { ...toUser(full), emailNotifications: Boolean(full.email_notifications) } });
  });

  api.post('/me/password', (req, res) => {
    const user = q.fullUser.get(req.user.id);
    if (!user.password_hash.startsWith('scrypt$')) fail(400, 'Ce compte se connecte via SSO et n’a pas de mot de passe.');
    if (!verifyPassword(String(req.body?.current ?? ''), user.password_hash)) fail(400, 'Mot de passe actuel incorrect.');
    const password = validPassword(req.body?.password);
    q.setPassword.run(hashPassword(password), user.id);
    // Les autres appareils sont déconnectés ; la session en cours est conservée.
    q.deleteOtherSessions.run(user.id, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.status(204).end();
  });

  // --- Administration ------------------------------------------------------

  api.get('/admin/users', requireAdmin, (req, res) => {
    res.json({
      users: q.adminUsers.all().map((u) => ({ ...toUser(u), createdAt: u.created_at, deactivatedAt: u.deactivated_at })),
      online: hub.online(),
    });
  });

  api.patch('/admin/users/:id', requireAdmin, (req, res) => {
    const user = q.fullUser.get(intParam(req.params.id));
    if (!user) fail(404, 'Utilisateur introuvable.');
    const { role, active } = req.body ?? {};
    if (role !== undefined && !['admin', 'member'].includes(role)) fail(400, 'Rôle invalide.');
    if (active !== undefined && typeof active !== 'boolean') fail(400, 'Statut invalide.');
    if (user.id === req.user.id && (role === 'member' || active === false)) {
      fail(400, 'Vous ne pouvez pas retirer vos propres droits ni désactiver votre compte.');
    }
    transaction(db, () => {
      if (role !== undefined) q.setRole.run(role, user.id);
      if (active !== undefined) q.setActive.run(active ? null : (user.deactivated_at ?? Date.now()), user.id);
      // Il doit toujours rester au moins un administrateur actif.
      if (q.activeAdmins.get().n === 0) fail(400, 'Il doit rester au moins un administrateur actif.');
      if (active === false) {
        q.deleteSessions.run(user.id);
        q.deleteUserPushSubscriptions.run(user.id);
      }
    });
    if (active === false) hub.disconnect(user.id);
    broadcastUser(user.id);
    res.json({ user: toUser(q.fullUser.get(user.id)) });
  });

  api.post('/admin/users/:id/reset', requireAdmin, async (req, res) => {
    const user = q.fullUser.get(intParam(req.params.id));
    if (!user) fail(404, 'Utilisateur introuvable.');
    if (user.deactivated_at) fail(400, 'Réactivez d’abord ce compte.');
    const { token, expiresAt } = createResetLink(user.id, req.user.id);
    const emailed = req.body?.send === true && mail
      ? await sendMail(user.email, resetEmail({ name: user.name, link: `${appUrl}/#/reset/${token}`, expiresAt, requested: false }))
      : false;
    res.status(201).json({ token, expiresAt, emailed });
  });

  api.get('/admin/invites', requireAdmin, (req, res) => {
    res.json({
      invites: q.pendingInvites.all(Date.now()).map((i) => ({
        token: i.token, createdBy: i.created_by, createdAt: i.created_at, expiresAt: i.expires_at, email: i.email,
      })),
    });
  });

  api.delete('/admin/invites/:token', requireAdmin, (req, res) => {
    if (q.deleteInvite.run(req.params.token).changes === 0) fail(404, 'Invitation introuvable ou déjà utilisée.');
    res.status(204).end();
  });

  api.get('/users', (req, res) => {
    res.json({ users: q.users.all().map(toUser), online: hub.online() });
  });

  api.post('/invites', requireAdmin, async (req, res) => {
    let email = null;
    if (req.body?.email) {
      email = text(req.body.email, 'email', { min: 3, max: 200 }).toLowerCase();
      if (!EMAIL_RE.test(email)) fail(400, 'Adresse email invalide.');
      if (q.userByEmail.get(email)) fail(409, 'Cette personne a déjà un compte.');
    }
    const token = newToken();
    const now = Date.now();
    const expiresAt = now + INVITE_TTL_MS;
    q.insertInvite.run(token, req.user.id, now, expiresAt, email);
    const emailed = email && mail && req.body?.send !== false
      ? await sendMail(email, inviteEmail({ inviter: req.user.name, link: `${appUrl}/#/invite/${token}`, expiresAt }))
      : false;
    res.status(201).json({ token, expiresAt, email, emailed });
  });

  // --- Résumé par email des notifications restées non lues ------------------

  async function runEmailDigest(now = Date.now()) {
    if (!mail) return 0;
    const rows = q.digestCandidates.all(now - DIGEST_DELAY_MS, now - DIGEST_MIN_INTERVAL_MS);
    const byUser = Map.groupBy(rows, (r) => r.user_id);
    let sent = 0;
    for (const [userId, all] of byUser) {
      // Quelqu'un qui a l'application sous les yeux n'a pas besoin d'email.
      if (hub.isActive(userId)) continue;
      const list = visibleNotifications(all, userId);
      if (!list.length) continue;
      const user = q.fullUser.get(userId);
      const items = list.slice(-10).reverse().map((row) => {
        const n = toNotification(row);
        return { title: notificationTitle(n), excerpt: n.excerpt, url: `${appUrl}${notificationUrl(n)}` };
      });
      const ok = await sendMail(user.email, digestEmail({
        name: user.name, items, more: list.length - items.length, appUrl: `${appUrl}/`, settingsUrl: `${appUrl}/`,
      }));
      if (!ok) continue;
      q.markEmailed.run(now, JSON.stringify(list.map((r) => r.id)));
      q.setLastDigest.run(now, userId);
      sent += 1;
    }
    return sent;
  }
  app.locals.runEmailDigest = runEmailDigest;
  if (mail) setInterval(() => runEmailDigest().catch((err) => console.warn('Résumé email :', err.message)), 5 * 60 * 1000).unref();

  // --- Canaux et messages ----------------------------------------------------

  api.get('/channels', (req, res) => {
    const rows = q.channelsFor.all(req.user.id, req.user.id);
    res.json({ channels: rows.map((c) => toChannel(c, req.user.id)) });
  });

  function validUserIds(ids) {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every(Number.isInteger)) fail(400, 'Liste de personnes invalide.');
    for (const id of ids) if (!q.userById.get(id)) fail(400, 'Personne introuvable.');
    return [...new Set(ids)];
  }

  api.post('/channels', (req, res) => {
    const name = text(req.body?.name, 'nom', { min: 1, max: 40 }).toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) fail(400, 'Nom de canal : lettres minuscules, chiffres, - et _ uniquement.');
    const topic = text(req.body?.topic ?? '', 'sujet', { max: 200 });
    const isPrivate = req.body?.isPrivate === true;
    const members = [...new Set([req.user.id, ...validUserIds(req.body?.memberIds)])];
    if (q.channelByName.get(name)) fail(409, 'Ce canal existe déjà.');
    const channel = transaction(db, () => {
      const id = Number(q.insertChannel.run(name, topic, 0, req.user.id, Date.now(), isPrivate ? 1 : 0).lastInsertRowid);
      for (const userId of members) q.join.run(id, userId, id);
      return q.channel.get(id);
    });
    const joined = toChannel({ ...channel, joined: 1, unread: 0 }, req.user.id);
    hub.sendTo(members.filter((id) => id !== req.user.id), { type: 'channel:joined', channel: joined });
    if (!isPrivate) {
      hub.broadcast({ type: 'channel:new', channel: { ...joined, joined: false } }, { except: members });
    }
    res.status(201).json({ channel: joined });
  });

  api.get('/channels/:id/members', (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    res.json({ members: memberIds(channel.id), createdBy: channel.created_by });
  });

  // Ajouter des personnes : réservé aux membres du canal.
  api.post('/channels/:id/members', (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    if (channel.is_dm) fail(400, 'Impossible d’ajouter quelqu’un à une conversation privée à deux.');
    if (!q.member.get(channel.id, req.user.id)) fail(403, 'Rejoignez le canal pour y ajouter des personnes.');
    const before = new Set(memberIds(channel.id));
    const added = validUserIds(req.body?.userIds).filter((id) => !before.has(id));
    transaction(db, () => { for (const id of added) q.join.run(channel.id, id, channel.id); });
    const memberCount = q.memberCount.get(channel.id).n;
    hub.sendTo(added, { type: 'channel:joined', channel: toChannel({ ...channel, joined: 1, unread: 0 }, null) });
    emitToChannel(channel, { type: 'channel:members', channelId: channel.id, memberCount });
    res.json({ members: memberIds(channel.id), added });
  });

  function removeMember(channel, userId) {
    q.leave.run(channel.id, userId);
    hub.sendTo([userId], { type: 'channel:removed', channelId: channel.id, isPrivate: Boolean(channel.is_private) });
    emitToChannel(channel, { type: 'channel:members', channelId: channel.id, memberCount: q.memberCount.get(channel.id).n });
  }

  // Retirer quelqu'un : la personne elle-même, le créateur du canal ou un administrateur.
  api.delete('/channels/:id/members/:userId', (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    const userId = intParam(req.params.userId);
    if (channel.is_dm) fail(400, 'Impossible de quitter une conversation privée.');
    if (userId !== req.user.id && channel.created_by !== req.user.id && req.user.role !== 'admin') {
      fail(403, 'Seuls le créateur du canal et les administrateurs peuvent retirer quelqu’un.');
    }
    if (!q.member.get(channel.id, userId)) fail(404, 'Cette personne n’est pas membre du canal.');
    removeMember(channel, userId);
    res.status(204).end();
  });

  api.post('/channels/:id/join', (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    q.join.run(channel.id, req.user.id, channel.id);
    res.status(204).end();
  });

  api.post('/channels/:id/leave', (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    if (channel.is_dm) fail(400, 'Impossible de quitter une conversation privée.');
    removeMember(channel, req.user.id);
    res.status(204).end();
  });

  api.put('/channels/:id/notify', (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    const level = req.body?.level;
    if (![null, 'all', 'mentions', 'none'].includes(level)) fail(400, 'Réglage invalide.');
    if (!q.member.get(channel.id, req.user.id)) fail(403, 'Rejoignez le canal pour régler ses notifications.');
    q.setNotify.run(level, channel.id, req.user.id);
    res.json({ notify: level, level: notifyLevel(channel, level) });
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
        const id = Number(q.insertChannel.run(name, '', 1, req.user.id, Date.now(), 0).lastInsertRowid);
        q.join.run(id, a, id);
        q.join.run(id, b, id);
        return q.channel.get(id);
      });
      hub.sendTo([otherId], { type: 'channel:joined', channel: toChannel({ ...channel, joined: 1 }, otherId) });
    }
    res.json({ channel: toChannel({ ...channel, joined: 1 }, req.user.id) });
  });

  api.get('/channels/:id/messages', (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = q.messagesBefore.all(channel.id, before, PAGE_SIZE + 1);
    const hasMore = rows.length > PAGE_SIZE;
    res.json({ messages: toMessages(rows.slice(0, PAGE_SIZE).reverse()), hasMore });
  });

  api.post('/channels/:id/messages', (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    const ids = req.body?.attachmentIds ?? [];
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || !ids.every(Number.isInteger)) {
      fail(400, `${MAX_ATTACHMENTS} pièces jointes maximum par message.`);
    }
    const body = text(req.body?.body ?? '', 'message', { min: ids.length ? 0 : 1, max: 4000 });

    let parentId = null;
    if (req.body?.parentId != null) {
      const parent = q.message.get(Number(req.body.parentId));
      if (!parent || parent.channel_id !== channel.id) fail(404, 'Message d’origine introuvable.');
      // Un seul niveau de fil : répondre à une réponse revient à répondre au message d'origine.
      parentId = parent.parent_id ?? parent.id;
    }

    const message = transaction(db, () => {
      q.join.run(channel.id, req.user.id, channel.id);
      const id = q.insertMessage.run(channel.id, req.user.id, parentId, body, Date.now()).lastInsertRowid;
      for (const attachmentId of ids) {
        if (q.linkAttachment.run(id, attachmentId, req.user.id, channel.id).changes === 0) {
          fail(400, 'Pièce jointe invalide ou déjà publiée.');
        }
      }
      if (!parentId) q.markRead.run(id, channel.id, req.user.id);
      return toMessage(q.message.get(id));
    });
    emitToChannel(channel, { type: 'message:new', message });
    notifyForMessage(message, channel, req.user);
    res.status(201).json({ message });
  });

  // Ajoute la réaction si elle n'y est pas, la retire sinon.
  api.post('/messages/:id/reactions', (req, res) => {
    const message = q.message.get(intParam(req.params.id));
    if (!message) fail(404, 'Message introuvable.');
    const channel = readableChannel(message.channel_id, req.user);
    const emoji = String(req.body?.emoji ?? '');
    if (emoji.length > 32 || !EMOJI.test(emoji)) fail(400, 'Réaction invalide.');

    let added = false;
    transaction(db, () => {
      if (q.reaction.get(message.id, req.user.id, emoji)) {
        q.removeReaction.run(message.id, req.user.id, emoji);
        q.removeReactionNotification.run(req.user.id, message.id, emoji);
      } else {
        if (q.reactionKinds.get(message.id, emoji).n >= MAX_REACTIONS_PER_MESSAGE) fail(400, 'Trop de réactions différentes sur ce message.');
        q.addReaction.run(message.id, req.user.id, emoji, Date.now());
        added = true;
      }
    });
    const reactions = reactionsByMessage([message.id]).get(message.id) ?? [];
    emitToChannel(channel, {
      type: 'message:reactions', messageId: message.id, channelId: channel.id, parentId: message.parent_id, reactions,
    });
    if (added && message.user_id && message.user_id !== req.user.id && canRead(channel, message.user_id)) {
      notify(message.user_id, 'reaction', req.user.id, message.id, emoji);
    }
    res.json({ reactions });
  });

  api.get('/push/key', (req, res) => {
    res.json({ publicKey: push?.publicKey ?? null });
  });

  api.post('/push/subscribe', (req, res) => {
    if (!push) fail(503, 'Les notifications push ne sont pas configurées sur ce serveur.');
    const sub = req.body?.subscription;
    const endpoint = String(sub?.endpoint ?? '');
    let url;
    try { url = new URL(endpoint); } catch { url = null; }
    if (url?.protocol !== 'https:' || endpoint.length > 1000) fail(400, 'Abonnement invalide.');
    const { p256dh, auth } = sub.keys ?? {};
    if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) fail(400, 'Abonnement invalide.');
    q.savePushSubscription.run(req.user.id, endpoint, p256dh, auth, Date.now());
    res.status(204).end();
  });

  api.post('/push/unsubscribe', (req, res) => {
    q.deleteUserPushSubscription.run(String(req.body?.endpoint ?? ''), req.user.id);
    res.status(204).end();
  });

  api.get('/notifications', (req, res) => {
    res.json({
      notifications: visibleNotifications(q.notifications.all(req.user.id), req.user.id).map(toNotification),
      unread: q.unreadNotifications.get(req.user.id).n,
    });
  });

  // Sans liste d'identifiants, tout est marqué comme lu.
  api.post('/notifications/read', (req, res) => {
    const ids = req.body?.ids;
    if (ids === undefined) q.readAllNotifications.run(Date.now(), req.user.id);
    else if (Array.isArray(ids) && ids.every(Number.isInteger)) q.readNotifications.run(Date.now(), req.user.id, JSON.stringify(ids));
    else fail(400, 'Liste de notifications invalide.');
    res.json({ unread: q.unreadNotifications.get(req.user.id).n });
  });

  api.get('/messages/:id/replies', (req, res) => {
    const root = q.message.get(intParam(req.params.id));
    if (!root || root.parent_id) fail(404, 'Fil introuvable.');
    readableChannel(root.channel_id, req.user);
    res.json({ message: toMessage(root), replies: toMessages(q.replies.all(root.id)) });
  });

  const rawUpload = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

  // Le fichier arrive brut dans le corps de la requête ; son nom et son type sont dans les en-têtes.
  // Il est enregistré sous un nom aléatoire ; renvoie ses métadonnées.
  function storeUpload(req) {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) fail(400, 'Fichier vide.');
    let name;
    try {
      name = decodeURIComponent(req.get('X-Filename') ?? '');
    } catch {
      name = '';
    }
    name = name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 200) || 'fichier';
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(req.get('X-File-Type') ?? '')
      ? req.get('X-File-Type').toLowerCase()
      : 'application/octet-stream';
    const key = newToken();
    writeFileSync(join(uploadDir, key), req.body);
    return { name, mime, size: req.body.length, key };
  }

  // Seules les images sûres s'affichent ; tout le reste est forcé en téléchargement, dans un bac à sable.
  function serveFile(res, file) {
    const inline = INLINE_IMAGES.has(file.mime);
    res.set({
      'Content-Type': inline ? file.mime : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=86400',
    });
    res.sendFile(join(uploadDir, file.storage_key), { cacheControl: false }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Fichier introuvable.' });
    });
  }

  api.post('/channels/:id/attachments', rawUpload, (req, res) => {
    const channel = readableChannel(intParam(req.params.id), req.user);
    const f = storeUpload(req);
    const id = q.insertAttachment.run(channel.id, req.user.id, f.name, f.mime, f.size, f.key, Date.now()).lastInsertRowid;
    res.status(201).json({ attachment: toAttachment(q.attachment.get(id)) });
  });

  api.get('/attachments/:id', (req, res) => {
    const a = q.attachment.get(intParam(req.params.id));
    if (!a) fail(404, 'Fichier introuvable.');
    readableChannel(a.channel_id, req.user);
    // Tant qu'il n'est pas publié, un fichier n'est visible que de la personne qui l'a envoyé.
    if (!a.message_id && a.user_id !== req.user.id) fail(404, 'Fichier introuvable.');
    serveFile(res, a);
  });

  // --- Fichiers des pages (les pages sont visibles de toute l'équipe) ---------

  const toPageFile = (f) => ({ id: f.id, pageId: f.page_id, userId: f.user_id, name: f.name, mime: f.mime, size: f.size, createdAt: f.created_at });

  api.post('/pages/:id/files', rawUpload, (req, res) => {
    const page = editablePage(req.params.id, req.user);
    const f = storeUpload(req);
    const id = q.insertPageFile.run(page.id, req.user.id, f.name, f.mime, f.size, f.key, Date.now()).lastInsertRowid;
    const file = toPageFile(q.pageFile.get(id));
    emitPage(page.id, { type: 'page:files', pageId: page.id });
    res.status(201).json({ file, url: `/api/page-files/${id}` });
  });

  api.get('/pages/:id/files', (req, res) => {
    const page = readablePage(req.params.id, req.user);
    res.json({ files: q.pageFiles.all(page.id).map(toPageFile) });
  });

  api.get('/page-files/:id', (req, res) => {
    const file = q.pageFile.get(intParam(req.params.id));
    if (!file || !pageAccessIndex().rights(file.page_id, req.user).view) fail(404, 'Fichier introuvable.');
    serveFile(res, file);
  });

  api.delete('/page-files/:id', (req, res) => {
    const file = q.pageFile.get(intParam(req.params.id));
    if (!file || !pageAccessIndex().rights(file.page_id, req.user).view) fail(404, 'Fichier introuvable.');
    if (file.user_id !== req.user.id && req.user.role !== 'admin') fail(403, 'Seul l’auteur du fichier ou un administrateur peut le supprimer.');
    q.deletePageFile.run(file.id);
    removeFiles([file.storage_key]);
    emitPage(file.page_id, { type: 'page:files', pageId: file.page_id });
    res.status(204).end();
  });

  api.patch('/messages/:id', (req, res) => {
    const message = q.message.get(intParam(req.params.id));
    if (!message) fail(404, 'Message introuvable.');
    if (message.user_id !== req.user.id) fail(403, 'Vous ne pouvez modifier que vos messages.');
    const hasFiles = q.attachmentsFor.all(JSON.stringify([message.id])).length > 0;
    const body = text(req.body?.body, 'message', { min: hasFiles ? 0 : 1, max: 4000 });
    q.updateMessage.run(body, Date.now(), message.id);
    const updated = toMessage(q.message.get(message.id));
    emitToChannel(q.channel.get(message.channel_id), { type: 'message:updated', message: updated });
    res.json({ message: updated });
  });

  api.delete('/messages/:id', (req, res) => {
    const message = q.message.get(intParam(req.params.id));
    if (!message) fail(404, 'Message introuvable.');
    if (message.user_id !== req.user.id && req.user.role !== 'admin') fail(403, 'Vous ne pouvez supprimer que vos messages.');
    const files = q.attachmentsOfTree.all(message.id).map((a) => a.storage_key);
    q.deleteMessage.run(message.id);
    removeFiles(files);
    emitToChannel(q.channel.get(message.channel_id), {
      type: 'message:deleted', messageId: message.id, channelId: message.channel_id, parentId: message.parent_id,
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

  // --- Accès aux pages ------------------------------------------------------
  // Le réglage d'une page s'applique à toutes ses sous-pages, sauf à celles qui ont leur propre réglage.
  // Le créateur de la page qui porte le réglage y a toujours accès en modification.
  // Comme pour les canaux privés, un administrateur ne voit pas une page privée dont il n'est pas membre.

  function pageAccessIndex() {
    const pages = new Map(q.allPagesAccess.all().map((p) => [p.id, p]));
    const members = new Map();
    for (const m of q.allPageMembers.all()) {
      if (!members.has(m.page_id)) members.set(m.page_id, new Map());
      members.get(m.page_id).set(m.user_id, m.role);
    }
    const source = (id) => {
      for (let p = pages.get(id); p; p = pages.get(p.parent_id)) if (p.access) return p;
      return null;
    };
    return {
      source,
      rights(id, user) {
        if (!pages.has(id)) return { view: false, edit: false };
        const src = source(id);
        if (!src || src.access === 'edit') return { view: true, edit: true };
        const role = src.created_by === user.id ? 'edit' : members.get(src.id)?.get(user.id);
        return { view: src.access === 'view' || Boolean(role), edit: role === 'edit' };
      },
    };
  }

  function readablePage(rawId, user) {
    const page = q.page.get(intParam(rawId));
    if (!page || !pageAccessIndex().rights(page.id, user).view) fail(404, 'Page introuvable.');
    return page;
  }

  function editablePage(rawId, user) {
    const page = readablePage(rawId, user);
    if (!pageAccessIndex().rights(page.id, user).edit) fail(403, 'Vous pouvez lire cette page mais pas la modifier.');
    return page;
  }

  // Seul le créateur de la page (ou un administrateur qui la voit) règle ses accès.
  const canManagePage = (page, user) => page.created_by === user.id || user.role === 'admin';

  function pageViewers(pageId) {
    const index = pageAccessIndex();
    return q.activeUsers.all().filter((u) => index.rights(pageId, u).view).map((u) => u.id);
  }

  // Les événements d'une page ne partent que vers ceux qui peuvent la voir (titre compris).
  function emitPage(pageId, event) {
    hub.sendTo(pageViewers(pageId), event);
  }

  function pageSummaryFor(p, index, user) {
    const src = index.source(p.id);
    return {
      id: p.id, parentId: p.parent_id, title: p.title, updatedAt: p.updated_at,
      restricted: Boolean(src && src.access !== 'edit'), canEdit: index.rights(p.id, user).edit,
    };
  }
  // Résumé diffusé à tous ceux qui voient la page (les droits de modification, propres à chacun, n'y figurent pas).
  function pageSummary(p) {
    const src = pageAccessIndex().source(p.id);
    return { id: p.id, parentId: p.parent_id, title: p.title, updatedAt: p.updated_at, restricted: Boolean(src && src.access !== 'edit') };
  }

  function pageDetails(page, user) {
    const index = pageAccessIndex();
    const src = index.source(page.id);
    return {
      ...toPage(page),
      access: page.access ?? null,
      restricted: Boolean(src && src.access !== 'edit'),
      canEdit: index.rights(page.id, user).edit,
      canManage: canManagePage(page, user),
    };
  }

  // Mentions ajoutées par une modification : on compte les « @Nom » avant et après.
  function newPageMentions(before, after, authorId) {
    const users = q.activeUsers.all();
    const names = users.map((u) => u.name);
    if (!names.length) return [];
    const count = (textValue) => {
      const counts = new Map();
      for (const m of textValue.matchAll(mentionRegex(names))) {
        const name = m[2].toLowerCase();
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return counts;
    };
    const was = count(before);
    const now = count(after);
    return users.filter((u) => u.id !== authorId && (now.get(u.name.toLowerCase()) ?? 0) > (was.get(u.name.toLowerCase()) ?? 0));
  }

  // Notifie les personnes nouvellement mentionnées qui ont accès à la page ; renvoie celles qui n'y ont pas accès.
  function notifyPageMentions(page, before, author) {
    const mentioned = newPageMentions(before, page.content, author.id);
    if (!mentioned.length) return [];
    const index = pageAccessIndex();
    const withoutAccess = [];
    for (const user of mentioned) {
      if (!index.rights(page.id, user).view) {
        withoutAccess.push(user.name);
        continue;
      }
      // Pas de doublon tant que la précédente mention de cette page n'a pas été lue.
      if (q.unreadPageMention.get(user.id, page.id)) continue;
      const line = page.content.split('\n').find((l) => l.toLowerCase().includes(`@${user.name.toLowerCase()}`)) ?? '';
      const excerptText = line.replace(/\s+/g, ' ').trim().slice(0, 160);
      deliver(user.id, q.insertPageNotification.run(user.id, author.id, page.id, excerptText, Date.now()).lastInsertRowid);
    }
    return withoutAccess;
  }

  api.get('/pages', (req, res) => {
    const index = pageAccessIndex();
    res.json({
      pages: q.pages.all().filter((p) => index.rights(p.id, req.user).view).map((p) => pageSummaryFor(p, index, req.user)),
    });
  });

  api.post('/pages', (req, res) => {
    const parentId = checkParent(req.body?.parentId, null);
    if (parentId) editablePage(parentId, req.user);
    const title = text(req.body?.title ?? '', 'titre', { max: 200 });
    const now = Date.now();
    const id = q.insertPage.run(parentId, title, '', req.user.id, req.user.id, now, now).lastInsertRowid;
    const page = q.page.get(id);
    emitPage(page.id, { type: 'page:changed', page: pageSummary(page), by: req.user.id });
    res.status(201).json({ page: pageDetails(page, req.user) });
  });

  api.get('/pages/:id', (req, res) => {
    res.json({ page: pageDetails(readablePage(req.params.id, req.user), req.user) });
  });

  api.get('/pages/:id/access', (req, res) => {
    const page = readablePage(req.params.id, req.user);
    const src = pageAccessIndex().source(page.id);
    res.json({
      access: page.access ?? null,
      effective: src?.access ?? 'edit',
      inheritedFrom: src && src.id !== page.id ? { id: src.id, title: q.page.get(src.id).title } : null,
      owner: (src ?? page).created_by,
      members: q.pageMembers.all((src ?? page).id).map((m) => ({ userId: m.user_id, role: m.role })),
      canManage: canManagePage(page, req.user),
    });
  });

  api.put('/pages/:id/access', (req, res) => {
    const page = readablePage(req.params.id, req.user);
    if (!canManagePage(page, req.user)) fail(403, 'Seuls l’auteur de la page et les administrateurs peuvent régler ses accès.');
    const access = req.body?.access ?? null;
    if (![null, 'edit', 'view', 'private'].includes(access)) fail(400, 'Réglage d’accès invalide.');
    const members = req.body?.members ?? [];
    if (!Array.isArray(members) || members.length > 500) fail(400, 'Liste de personnes invalide.');
    for (const m of members) {
      if (!Number.isInteger(m?.userId) || !['edit', 'view'].includes(m.role) || !q.userById.get(m.userId)) {
        fail(400, 'Liste de personnes invalide.');
      }
    }
    transaction(db, () => {
      q.setPageAccess.run(access, page.id);
      q.clearPageMembers.run(page.id);
      if (access === 'view' || access === 'private') {
        for (const m of new Map(members.map((x) => [x.userId, x])).values()) q.insertPageMember.run(page.id, m.userId, m.role);
      }
      // On ne se retire jamais l'accès à soi-même par erreur.
      const rights = pageAccessIndex().rights(page.id, req.user);
      if (!rights.edit) fail(400, 'Ajoutez-vous à la liste avec le droit de modifier, sinon vous perdriez l’accès à cette page.');
    });
    // Certains gagnent ou perdent l'accès : chacun recharge la liste des pages qu'il peut voir.
    hub.broadcast({ type: 'pages:refresh' });
    res.json({ page: pageDetails(q.page.get(page.id), req.user) });
  });

  api.patch('/pages/:id', (req, res) => {
    const page = editablePage(req.params.id, req.user);
    const b = req.body ?? {};
    const title = b.title === undefined ? page.title : text(b.title, 'titre', { max: 200 });
    const content = b.content === undefined ? page.content : b.content;
    if (typeof content !== 'string' || content.length > 200_000) fail(400, 'Contenu invalide ou trop long.');
    const parentId = b.parentId === undefined ? page.parent_id : checkParent(b.parentId, page.id);
    if (parentId !== page.parent_id && parentId) editablePage(parentId, req.user);
    // Verrou optimiste : si quelqu'un a enregistré entre-temps, on refuse plutôt que d'écraser son travail.
    const version = Number(b.version);
    if (version !== page.version) fail(409, 'Cette page a été modifiée par quelqu’un d’autre.');
    const updated = transaction(db, () => {
      const result = q.updatePage.run(parentId, title, content, req.user.id, Date.now(), page.id, version);
      if (result.changes === 0) fail(409, 'Cette page a été modifiée par quelqu’un d’autre.');
      const after = q.page.get(page.id);
      if (after.title !== page.title || after.content !== page.content) recordVersion(page, after, req.user.id);
      return after;
    });
    if (parentId !== page.parent_id) hub.broadcast({ type: 'pages:refresh' });
    else emitPage(updated.id, { type: 'page:changed', page: pageSummary(updated), version: updated.version, by: req.user.id });
    const mentionedWithoutAccess = notifyPageMentions(updated, page.content, req.user);
    res.json({ page: pageDetails(updated, req.user), mentionedWithoutAccess });
  });

  // Enregistre l'état « after » dans l'historique. Les enregistrements d'une même personne à moins
  // de 10 minutes d'intervalle sont regroupés en une seule version.
  function recordVersion(before, after, userId, { restoredFrom = null } = {}) {
    const now = Date.now();
    let forceNew = restoredFrom !== null;
    // Page antérieure à l'historique : on conserve d'abord son contenu d'origine.
    if (!q.lastVersion.get(before.id) && before.content) {
      q.insertVersion.run(before.id, before.version, before.title, before.content, before.updated_by, null, before.updated_at, before.updated_at);
      forceNew = true;
    }
    const last = q.lastVersion.get(before.id);
    if (!forceNew && last && last.edited_by === userId && last.restored_from === null && now - last.started_at < VERSION_SESSION_MS) {
      q.extendVersion.run(after.version, after.title, after.content, now, last.id);
    } else {
      q.insertVersion.run(after.id, after.version, after.title, after.content, userId, restoredFrom, now, now);
    }
    q.pruneVersions.run(after.id, MAX_VERSIONS_PER_PAGE);
  }

  const toVersion = (v) => ({
    id: v.id, version: v.version, title: v.title, editedBy: v.edited_by, restoredFrom: v.restored_from,
    startedAt: v.started_at, savedAt: v.saved_at, length: v.length ?? v.content.length,
    ...(v.content !== undefined && { content: v.content }),
  });

  api.get('/pages/:id/versions', (req, res) => {
    const page = readablePage(req.params.id, req.user);
    res.json({ versions: q.versions.all(page.id).map(toVersion), current: page.version });
  });

  api.get('/pages/:id/versions/:versionId', (req, res) => {
    const page = readablePage(req.params.id, req.user);
    const v = q.pageVersion.get(intParam(req.params.versionId), page.id);
    if (!v) fail(404, 'Version introuvable.');
    res.json({ version: toVersion(v) });
  });

  api.post('/pages/:id/versions/:versionId/restore', (req, res) => {
    const page = editablePage(req.params.id, req.user);
    const snapshot = q.pageVersion.get(intParam(req.params.versionId), page.id);
    if (!snapshot) fail(404, 'Version introuvable.');
    if (Number(req.body?.version) !== page.version) fail(409, 'Cette page a été modifiée par quelqu’un d’autre.');
    const updated = transaction(db, () => {
      const result = q.updatePage.run(page.parent_id, snapshot.title, snapshot.content, req.user.id, Date.now(), page.id, page.version);
      if (result.changes === 0) fail(409, 'Cette page a été modifiée par quelqu’un d’autre.');
      const after = q.page.get(page.id);
      recordVersion(page, after, req.user.id, { restoredFrom: snapshot.version });
      return after;
    });
    emitPage(updated.id, { type: 'page:changed', page: pageSummary(updated), version: updated.version, by: req.user.id });
    res.json({ page: pageDetails(updated, req.user) });
  });

  api.delete('/pages/:id', (req, res) => {
    const page = readablePage(req.params.id, req.user);
    if (page.created_by !== req.user.id && req.user.role !== 'admin') {
      fail(403, 'Seul l’auteur de la page ou un administrateur peut la supprimer.');
    }
    const files = q.pageTreeFiles.all(page.id).map((f) => f.storage_key);
    const viewers = pageViewers(page.id);
    q.deletePage.run(page.id);
    removeFiles(files);
    hub.sendTo(viewers, { type: 'page:deleted', pageId: page.id });
    res.status(204).end();
  });

  // --- Recherche -------------------------------------------------------------

  api.get('/search', (req, res) => {
    const term = String(req.query.q ?? '').trim();
    if (term.length < 2) return res.json({ messages: [], pages: [] });
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const messages = toMessages(q.searchMessages.all(req.user.id, like));
    const index = pageAccessIndex();
    const pages = q.searchPages.all(like).filter((p) => index.rights(p.id, req.user).view)
      .slice(0, 20).map((p) => ({ ...pageSummary(p), excerpt: excerpt(p.content, term) }));
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
