// Instantané cohérent de la base, même pendant que l'application tourne :
//   node src/backup.js            (ou : docker compose exec app node src/backup.js)
// Les pièces jointes (UPLOAD_DIR) ne changent jamais une fois envoyées : une simple copie suffit.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dbFile = process.env.DB_FILE ?? fileURLToPath(new URL('../data/makora.db', import.meta.url));
const dir = process.env.BACKUP_DIR ?? join(dbFile, '..', 'backups');
const keep = Number(process.env.BACKUP_KEEP ?? 14);

mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const target = join(dir, `makora-${stamp}.db`);
const db = new DatabaseSync(dbFile, { readOnly: true });
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();

// On ne garde que les sauvegardes les plus récentes.
const old = readdirSync(dir).filter((f) => /^makora-.*\.db$/.test(f)).sort().slice(0, -keep);
for (const file of old) rmSync(join(dir, file));
console.log(`Sauvegarde créée : ${target}`);
