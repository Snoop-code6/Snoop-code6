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
  created_at    INTEGER NOT NULL
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
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Met à niveau les bases créées par une version précédente.
function migrate(db) {
  const columns = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!columns.includes('parent_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN parent_id INTEGER REFERENCES messages(id) ON DELETE CASCADE');
  }
  db.exec('CREATE INDEX IF NOT EXISTS messages_parent ON messages(parent_id)');
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
