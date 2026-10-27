import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at    INTEGER NOT NULL,
  deactivated_at INTEGER,
  email_notifications INTEGER NOT NULL DEFAULT 1,
  last_digest_at INTEGER
);

-- Liens de réinitialisation de mot de passe créés par un administrateur (seule l'empreinte est stockée).
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  token      TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Un canal est soit public (is_dm = 0), soit une conversation privée entre deux personnes.
CREATE TABLE IF NOT EXISTS channels (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  topic      TEXT NOT NULL DEFAULT '',
  is_dm      INTEGER NOT NULL DEFAULT 0,
  is_private INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  parent_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at  INTEGER
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);

-- Un fichier est d'abord envoyé seul (message_id NULL), puis rattaché au message qui le publie.
CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY,
  message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

-- Fil « Activité » : mentions, réponses dans les fils suivis, réactions à ses messages,
-- mentions dans les pages. Chaque notification porte sur un message OU sur une page.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('mention', 'reply', 'reaction', 'page_mention')),
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  page_id    INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  emoji      TEXT,
  excerpt    TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER,
  emailed_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id);

CREATE TABLE IF NOT EXISTS pages (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_parent ON pages(parent_id);

-- Historique des pages : une version par session d'écriture (les enregistrements automatiques
-- successifs d'une même personne sont regroupés).
CREATE TABLE IF NOT EXISTS page_versions (
  id         INTEGER PRIMARY KEY,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  edited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  restored_from INTEGER,
  started_at INTEGER NOT NULL,
  saved_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS page_versions_page ON page_versions(page_id, id);

-- Fichiers insérés dans les pages (images affichées, autres fichiers à télécharger).
CREATE TABLE IF NOT EXISTS page_files (
  id          INTEGER PRIMARY KEY,
  page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS page_files_page ON page_files(page_id);

-- Personnes autorisées sur une page à accès restreint (voir pages.access).
CREATE TABLE IF NOT EXISTS page_members (
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('edit', 'view')),
  PRIMARY KEY (page_id, user_id)
);

-- Abonnements aux notifications push (un par appareil).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Connexions SSO en cours (le temps de l'aller-retour chez le fournisseur d'identité).
CREATE TABLE IF NOT EXISTS sso_attempts (
  state      TEXT PRIMARY KEY,
  nonce      TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function addColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Les notifications d'avant les mentions dans les pages exigeaient un message : on reconstruit la table
// (SQLite ne sait pas modifier une contrainte existante).
function upgradeNotifications(db) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get();
  if (sql.includes('page_mention')) return;
  db.exec('PRAGMA foreign_keys = OFF');
  transaction(db, () => {
    db.exec(`CREATE TABLE notifications_new (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('mention', 'reply', 'reaction', 'page_mention')),
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
      emoji TEXT, excerpt TEXT, created_at INTEGER NOT NULL, read_at INTEGER, emailed_at INTEGER)`);
    db.exec(`INSERT INTO notifications_new (id, user_id, kind, actor_id, message_id, emoji, created_at, read_at, emailed_at)
      SELECT id, user_id, kind, actor_id, message_id, emoji, created_at, read_at, emailed_at FROM notifications`);
    db.exec('DROP TABLE notifications');
    db.exec('ALTER TABLE notifications_new RENAME TO notifications');
    db.exec('CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id)');
  });
  db.exec('PRAGMA foreign_keys = ON');
}

// Met à niveau les bases créées par une version précédente.
function migrate(db) {
  const columns = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!columns.includes('parent_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN parent_id INTEGER REFERENCES messages(id) ON DELETE CASCADE');
  }
  db.exec('CREATE INDEX IF NOT EXISTS messages_parent ON messages(parent_id)');

  addColumn(db, 'users', 'deactivated_at', 'INTEGER');
  addColumn(db, 'users', 'email_notifications', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'users', 'last_digest_at', 'INTEGER');
  addColumn(db, 'invites', 'email', 'TEXT');
  addColumn(db, 'notifications', 'emailed_at', 'INTEGER');
  // Accès d'une page : NULL = comme la page parente (ou toute l'équipe en haut de l'arbre),
  // 'edit' = toute l'équipe modifie, 'view' = toute l'équipe lit, 'private' = personnes choisies.
  addColumn(db, 'pages', 'access', 'TEXT');
  upgradeNotifications(db);
  // Préférence de notification par canal : NULL = réglage par défaut (tout pour les messages privés,
  // mentions pour les canaux), 'all', 'mentions' ou 'none' (muet).
  addColumn(db, 'channel_members', 'notify', 'TEXT');

  const channelColumns = db.prepare('PRAGMA table_info(channels)').all().map((c) => c.name);
  if (!channelColumns.includes('is_private')) {
    db.exec('ALTER TABLE channels ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0');
  }
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
