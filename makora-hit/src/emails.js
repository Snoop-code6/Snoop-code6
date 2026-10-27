// Modèles des emails envoyés par MAKORA HIT (version texte + version HTML simple).

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const dateFmt = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'long', timeStyle: 'short', timeZone: process.env.TZ || 'Europe/Paris',
});

function layout(title, bodyHtml) {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f6f7f9;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1c1e26">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="font-weight:700;letter-spacing:.04em;margin-bottom:16px"><span style="display:inline-block;background:#4f46e5;color:#fff;border-radius:6px;padding:2px 7px;margin-right:6px">M</span>MAKORA HIT</div>
<div style="background:#fff;border:1px solid #e4e6ec;border-radius:12px;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
${bodyHtml}
</div>
<p style="color:#6b7080;font-size:12px;margin-top:16px">Cet email a été envoyé automatiquement par l’outil de communication interne de votre entreprise.</p>
</div></body></html>`;
}

const button = (url, label) => `<p style="margin:20px 0"><a href="${esc(url)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600">${esc(label)}</a></p>
<p style="color:#6b7080;font-size:13px">Ou copiez ce lien dans votre navigateur :<br><span style="word-break:break-all">${esc(url)}</span></p>`;

export function inviteEmail({ inviter, link, expiresAt }) {
  const subject = `${inviter} vous invite sur MAKORA HIT`;
  const text = `Bonjour,

${inviter} vous invite à rejoindre l'espace de travail de votre équipe sur MAKORA HIT (messagerie et documents partagés).

Créez votre compte avec ce lien (valable jusqu'au ${dateFmt.format(expiresAt)}, utilisable une seule fois) :
${link}
`;
  const html = layout('Vous êtes invité·e à rejoindre l’équipe', `
<p><strong>${esc(inviter)}</strong> vous invite à rejoindre l’espace de travail de votre équipe : messagerie et documents partagés.</p>
${button(link, 'Créer mon compte')}
<p style="color:#6b7080;font-size:13px">Lien valable jusqu’au ${esc(dateFmt.format(expiresAt))}, utilisable une seule fois.</p>`);
  return { subject, text, html };
}

export function resetEmail({ name, link, expiresAt, requested }) {
  const subject = 'Réinitialisation de votre mot de passe MAKORA HIT';
  const why = requested
    ? 'Vous avez demandé à réinitialiser votre mot de passe.'
    : 'Votre administrateur vous a envoyé un lien pour choisir un nouveau mot de passe.';
  const text = `Bonjour ${name},

${why}

Choisissez un nouveau mot de passe avec ce lien (valable jusqu'au ${dateFmt.format(expiresAt)}, utilisable une seule fois) :
${link}

Si vous n'êtes pas à l'origine de cette demande, ignorez cet email : votre mot de passe actuel reste valable.
`;
  const html = layout('Nouveau mot de passe', `
<p>Bonjour ${esc(name)},</p>
<p>${esc(why)}</p>
${button(link, 'Choisir un nouveau mot de passe')}
<p style="color:#6b7080;font-size:13px">Lien valable jusqu’au ${esc(dateFmt.format(expiresAt))}, utilisable une seule fois. Si vous n’êtes pas à l’origine de cette demande, ignorez cet email : votre mot de passe actuel reste valable.</p>`);
  return { subject, text, html };
}

export function digestEmail({ name, items, more, appUrl, settingsUrl }) {
  const count = items.length + more;
  const subject = count > 1 ? `${count} notifications non lues sur MAKORA HIT` : `1 notification non lue sur MAKORA HIT`;
  const lines = items.map((i) => `• ${i.title}${i.excerpt ? ` : « ${i.excerpt} »` : ''}\n  ${i.url}`).join('\n\n');
  const text = `Bonjour ${name},

Vous avez manqué ceci :

${lines}${more ? `\n\n… et ${more} autre${more > 1 ? 's' : ''}.` : ''}

Ouvrir MAKORA HIT : ${appUrl}
Pour ne plus recevoir ces emails : Mon compte → Notifications par email (${settingsUrl}).
`;
  const html = layout('Vous avez manqué ceci', `
<p>Bonjour ${esc(name)},</p>
${items.map((i) => `<div style="border-left:3px solid #4f46e5;padding:4px 0 4px 12px;margin:12px 0">
<a href="${esc(i.url)}" style="color:#1c1e26;font-weight:600;text-decoration:none">${esc(i.title)}</a>
${i.excerpt ? `<div style="color:#6b7080;font-size:14px;margin-top:2px">${esc(i.excerpt)}</div>` : ''}</div>`).join('')}
${more ? `<p style="color:#6b7080">… et ${more} autre${more > 1 ? 's' : ''}.</p>` : ''}
${button(appUrl, 'Ouvrir MAKORA HIT')}
<p style="color:#6b7080;font-size:12px">Pour ne plus recevoir ces emails : Mon compte → Notifications par email.</p>`);
  return { subject, text, html };
}
