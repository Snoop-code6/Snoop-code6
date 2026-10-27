import webpush from 'web-push';

// Clés VAPID : celles de l'environnement si fournies, sinon générées une fois et conservées en base
// (en changer invaliderait tous les abonnements existants).
function vapidKeys(db) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const stored = get.get('vapid');
  if (stored) return JSON.parse(stored.value);
  const keys = webpush.generateVAPIDKeys();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('vapid', JSON.stringify(keys));
  return keys;
}

export function createPushSender(db) {
  const { publicKey, privateKey } = vapidKeys(db);
  const adminEmail = db.prepare("SELECT email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  return {
    publicKey,
    send(subscription, payload) {
      // Apple et Mozilla exigent un contact valide : VAPID_SUBJECT, sinon l'email du premier administrateur.
      const subject = process.env.VAPID_SUBJECT ?? `mailto:${adminEmail.get()?.email ?? 'admin@example.com'}`;
      return webpush.sendNotification(subscription, JSON.stringify(payload), {
        TTL: 24 * 3600,
        urgency: 'high',
        vapidDetails: { subject, publicKey, privateKey },
      });
    },
  };
}
