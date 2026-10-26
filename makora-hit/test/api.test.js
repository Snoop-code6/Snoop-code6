import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';
import { renderMarkdown } from '../public/markdown.js';

let srv;
let base;

// Faux service push : on garde ce qui aurait été envoyé aux téléphones.
const pushed = [];
const fakePush = {
  publicKey: 'cle-publique-de-test',
  async send(subscription, payload) {
    if (subscription.endpoint.includes('expire')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    pushed.push({ endpoint: subscription.endpoint, payload });
  },
};

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', push: fakePush });
  base = `http://127.0.0.1:${srv.port}`;
});

after(() => srv.close());

// Petit client HTTP qui garde son cookie de session, comme un navigateur.
function client() {
  let cookie = '';
  const call = async (method, path, body, headers = { 'X-Makora': '1' }) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { ...headers, ...(body && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = res.status === 204 ? null : await res.json();
    return { status: res.status, data };
  };
  return { call, get cookie() { return cookie; } };
}

function socket(cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Cookie: cookie } });
  const events = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw);
    events.push(ev);
    for (const w of [...waiters]) {
      if (w.match(ev)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(ev);
      }
    }
  });
  return {
    ws,
    events,
    opened: new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); }),
    next(match) {
      const found = events.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}

const admin = client();
const bob = client();
const carol = client();

describe('comptes', () => {
  test('le premier inscrit devient administrateur sans invitation', async () => {
    assert.deepEqual((await admin.call('GET', '/setup')).data, { needsSetup: true });
    const res = await admin.call('POST', '/auth/register', { email: 'Alice@pme.fr', name: 'Alice Martin', password: 'motdepasse1' });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.role, 'admin');
    assert.equal(res.data.user.email, 'alice@pme.fr');
    assert.deepEqual((await admin.call('GET', '/setup')).data, { needsSetup: false });
  });

  test('les suivants ont besoin d’une invitation à usage unique', async () => {
    const refused = await bob.call('POST', '/auth/register', { email: 'bob@pme.fr', name: 'Bob', password: 'motdepasse2' });
    assert.equal(refused.status, 403);

    const { data: { token } } = await admin.call('POST', '/invites');
    assert.equal((await bob.call('GET', `/invites/${token}`)).data.valid, true);
    const ok = await bob.call('POST', '/auth/register', { email: 'bob@pme.fr', name: 'Bob Durand', password: 'motdepasse2', invite: token });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.user.role, 'member');

    const reused = await carol.call('POST', '/auth/register', { email: 'carol@pme.fr', name: 'Carol', password: 'motdepasse3', invite: token });
    assert.equal(reused.status, 403);

    const { data: second } = await admin.call('POST', '/invites');
    assert.equal((await carol.call('POST', '/auth/register', { email: 'carol@pme.fr', name: 'Carol Petit', password: 'motdepasse3', invite: second.token })).status, 201);
  });

  test('seul un administrateur peut inviter', async () => {
    assert.equal((await bob.call('POST', '/invites')).status, 403);
  });

  test('connexion, mauvais mot de passe et déconnexion', async () => {
    const tmp = client();
    assert.equal((await tmp.call('POST', '/auth/login', { email: 'bob@pme.fr', password: 'faux-mot-de-passe' })).status, 401);
    assert.equal((await tmp.call('POST', '/auth/login', { email: 'BOB@pme.fr', password: 'motdepasse2' })).status, 200);
    assert.equal((await tmp.call('GET', '/me')).data.user.name, 'Bob Durand');
    assert.equal((await tmp.call('POST', '/auth/logout')).status, 204);
    assert.equal((await tmp.call('GET', '/me')).status, 401);
  });

  test('les écritures sans l’en-tête anti-CSRF sont refusées', async () => {
    const res = await admin.call('POST', '/channels', { name: 'pirate' }, {});
    assert.equal(res.status, 403);
  });
});

describe('canaux et messages', () => {
  let general;

  test('tout le monde rejoint #general automatiquement', async () => {
    const { data } = await bob.call('GET', '/channels');
    general = data.channels.find((c) => c.name === 'general');
    assert.ok(general?.joined);
  });

  test('un message est diffusé en temps réel et compte comme non lu', async () => {
    const ws = socket(carol.cookie);
    await ws.opened;
    const { status, data } = await admin.call('POST', `/channels/${general.id}/messages`, { body: 'Bonjour **équipe** !' });
    assert.equal(status, 201);
    const ev = await ws.next((e) => e.type === 'message:new');
    assert.equal(ev.message.id, data.message.id);
    ws.ws.close();

    const carolChannels = (await carol.call('GET', '/channels')).data.channels;
    assert.equal(carolChannels.find((c) => c.id === general.id).unread, 1);
    await carol.call('POST', `/channels/${general.id}/read`, { messageId: data.message.id });
    const after = (await carol.call('GET', '/channels')).data.channels;
    assert.equal(after.find((c) => c.id === general.id).unread, 0);
  });

  test('création de canal, nom normalisé et doublon refusé', async () => {
    const { status, data } = await bob.call('POST', '/channels', { name: 'Projet Alpha', topic: 'Lancement' });
    assert.equal(status, 201);
    assert.equal(data.channel.name, 'projet-alpha');
    assert.equal((await bob.call('POST', '/channels', { name: 'projet-alpha' })).status, 409);
    assert.equal((await bob.call('POST', '/channels', { name: '<script>' })).status, 400);
  });

  test('modifier et supprimer : auteur ou administrateur uniquement', async () => {
    const { data: { message } } = await bob.call('POST', `/channels/${general.id}/messages`, { body: 'brouillon' });
    assert.equal((await carol.call('PATCH', `/messages/${message.id}`, { body: 'hack' })).status, 403);
    const edited = await bob.call('PATCH', `/messages/${message.id}`, { body: 'version finale' });
    assert.equal(edited.data.message.body, 'version finale');
    assert.ok(edited.data.message.editedAt);
    assert.equal((await carol.call('DELETE', `/messages/${message.id}`)).status, 403);
    assert.equal((await admin.call('DELETE', `/messages/${message.id}`)).status, 204);
  });

  test('pagination des messages', async () => {
    const { data: { channel } } = await admin.call('POST', '/channels', { name: 'bavard' });
    for (let i = 0; i < 55; i++) await admin.call('POST', `/channels/${channel.id}/messages`, { body: `msg ${i}` });
    const first = (await admin.call('GET', `/channels/${channel.id}/messages`)).data;
    assert.equal(first.messages.length, 50);
    assert.equal(first.hasMore, true);
    assert.equal(first.messages.at(-1).body, 'msg 54');
    const older = (await admin.call('GET', `/channels/${channel.id}/messages?before=${first.messages[0].id}`)).data;
    assert.equal(older.messages.length, 5);
    assert.equal(older.hasMore, false);
    assert.equal(older.messages[0].body, 'msg 0');
  });

  test('les messages privés restent privés', async () => {
    const bobId = (await bob.call('GET', '/me')).data.user.id;
    const { data: { channel } } = await admin.call('POST', '/dms', { userId: bobId });
    assert.equal(channel.isDm, true);
    assert.equal(channel.dmUserId, bobId);
    // Même conversation si Bob l'ouvre de son côté.
    const adminId = (await admin.call('GET', '/me')).data.user.id;
    assert.equal((await bob.call('POST', '/dms', { userId: adminId })).data.channel.id, channel.id);

    const carolWs = socket(carol.cookie);
    const bobWs = socket(bob.cookie);
    await Promise.all([carolWs.opened, bobWs.opened]);
    await admin.call('POST', `/channels/${channel.id}/messages`, { body: 'salaire confidentiel' });
    await bobWs.next((e) => e.type === 'message:new' && e.message.channelId === channel.id);
    assert.ok(!carolWs.events.some((e) => e.type === 'message:new' && e.message.channelId === channel.id));
    carolWs.ws.close();
    bobWs.ws.close();

    assert.equal((await carol.call('GET', `/channels/${channel.id}/messages`)).status, 404);
    assert.equal((await carol.call('POST', `/channels/${channel.id}/messages`, { body: 'intrus' })).status, 404);
    assert.ok(!(await carol.call('GET', '/channels')).data.channels.some((c) => c.id === channel.id));
    const search = (await carol.call('GET', '/search?q=confidentiel')).data;
    assert.equal(search.messages.length, 0);
    assert.equal((await bob.call('GET', '/search?q=confidentiel')).data.messages.length, 1);
  });
});

describe('pages', () => {
  let parent;

  test('la page de bienvenue existe', async () => {
    const { pages } = (await bob.call('GET', '/pages')).data;
    assert.ok(pages.some((p) => p.title === 'Bienvenue sur MAKORA HIT'));
  });

  test('créer une page et une sous-page', async () => {
    parent = (await bob.call('POST', '/pages', { title: 'Procédures' })).data.page;
    const child = (await bob.call('POST', '/pages', { title: 'Notes de frais', parentId: parent.id })).data.page;
    assert.equal(child.parentId, parent.id);
    assert.equal((await bob.call('POST', '/pages', { parentId: 99999 })).status, 400);
    // Une page ne peut pas devenir l'enfant de sa propre sous-page.
    const loop = await bob.call('PATCH', `/pages/${parent.id}`, { parentId: child.id, version: parent.version });
    assert.equal(loop.status, 400);
  });

  test('enregistrement avec verrou optimiste', async () => {
    const saved = await bob.call('PATCH', `/pages/${parent.id}`, { content: '# Règles\nJustificatif obligatoire.', version: 1 });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.page.version, 2);
    const stale = await carol.call('PATCH', `/pages/${parent.id}`, { content: 'écrase tout', version: 1 });
    assert.equal(stale.status, 409);
    assert.equal((await carol.call('GET', `/pages/${parent.id}`)).data.page.content, '# Règles\nJustificatif obligatoire.');
  });

  test('recherche dans les pages', async () => {
    const { pages } = (await carol.call('GET', '/search?q=justificatif')).data;
    assert.equal(pages.length, 1);
    assert.match(pages[0].excerpt, /Justificatif/);
    assert.equal((await carol.call('GET', '/search?q=%25')).data.pages.length, 0);
  });

  test('suppression : auteur ou admin, sous-pages comprises', async () => {
    assert.equal((await carol.call('DELETE', `/pages/${parent.id}`)).status, 403);
    assert.equal((await bob.call('DELETE', `/pages/${parent.id}`)).status, 204);
    const { pages } = (await bob.call('GET', '/pages')).data;
    assert.ok(!pages.some((p) => p.title === 'Notes de frais'));
  });
});

describe('temps réel', () => {
  test('connexion WebSocket refusée sans session ou depuis un autre site', async () => {
    const anon = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    await assert.rejects(new Promise((resolve, reject) => { anon.on('open', resolve); anon.on('error', reject); }));
    const foreign = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Cookie: bob.cookie, Origin: 'https://evil.example' } });
    await assert.rejects(new Promise((resolve, reject) => { foreign.on('open', resolve); foreign.on('error', reject); }));
  });

  test('présence en ligne', async () => {
    const ws = socket(bob.cookie);
    await ws.opened;
    const bobId = (await bob.call('GET', '/me')).data.user.id;
    const ev = await ws.next((e) => e.type === 'presence' && e.online.includes(bobId));
    assert.ok(ev);
    assert.ok((await admin.call('GET', '/users')).data.online.includes(bobId));
    ws.ws.close();
  });
});

describe('markdown', () => {
  test('le HTML saisi est échappé', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **gras**');
    assert.ok(!html.includes('<img'));
    assert.match(html, /&lt;img/);
    assert.match(html, /<strong>gras<\/strong>/);
  });

  test('les liens javascript: ne sont pas rendus', () => {
    const html = renderMarkdown('[clic](javascript:alert(1)) [ok](https://pme.fr/a?b=1&c=2)');
    assert.ok(!html.includes('href="javascript'));
    assert.match(html, /href="https:\/\/pme\.fr\/a\?b=1&amp;c=2"/);
  });

  test('pas d’injection d’attribut via un lien', () => {
    const html = renderMarkdown('[x](https://a.fr/"onmouseover="alert(1))');
    assert.ok(!/href="[^"]*"onmouseover/.test(html));
  });

  test('mentions : seuls les noms connus sont mis en évidence', () => {
    const opts = { mentions: ['Alice Martin', 'Bob', 'tous'], me: 'Bob' };
    const html = renderMarkdown('@alice martin et @Bob, @tous ! @inconnu mail a@b.fr <@Bob>', opts);
    assert.match(html, /<span class="mention">@alice martin<\/span>/);
    assert.match(html, /<span class="mention mention-self">@Bob<\/span>,/);
    assert.match(html, /<span class="mention">@tous<\/span>/);
    assert.ok(!html.includes('@inconnu</span>'));
    assert.ok(!html.includes('a<span'));
    assert.ok(!html.includes('<@'));
  });

  test('blocs : titres, listes, tâches, code', () => {
    const html = renderMarkdown('# Titre\n- un\n- [x] fait\n1. premier\n```\n<b>code</b>\n```');
    assert.match(html, /<h1>Titre<\/h1>/);
    assert.match(html, /<li>un<\/li>/);
    assert.match(html, /class="task done"/);
    assert.match(html, /<ol><li>premier<\/li><\/ol>/);
    assert.match(html, /<pre><code>&lt;b&gt;code&lt;\/b&gt;<\/code><\/pre>/);
  });
});

describe('pièces jointes', () => {
  async function upload(who, channelId, content, name, type) {
    const res = await fetch(`${base}/api/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: {
        'X-Makora': '1', Cookie: who.cookie, 'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(name), 'X-File-Type': type,
      },
      body: content,
    });
    return { status: res.status, data: await res.json() };
  }
  const download = (who, id) => fetch(`${base}/api/attachments/${id}`, { headers: { Cookie: who.cookie } });
  let general;

  before(async () => {
    general = (await bob.call('GET', '/channels')).data.channels.find((c) => c.name === 'general');
  });

  test('envoyer un fichier puis le publier dans un message', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const up = await upload(bob, general.id, png, 'capture écran.png', 'image/png');
    assert.equal(up.status, 201);
    assert.deepEqual(up.data.attachment, { id: up.data.attachment.id, name: 'capture écran.png', mime: 'image/png', size: 8 });

    // Avant publication, seul l'auteur peut le voir.
    assert.equal((await download(carol, up.data.attachment.id)).status, 404);

    const { status, data } = await bob.call('POST', `/channels/${general.id}/messages`, { body: '', attachmentIds: [up.data.attachment.id] });
    assert.equal(status, 201);
    assert.equal(data.message.attachments[0].name, 'capture écran.png');

    const res = await download(carol, up.data.attachment.id);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('content-disposition'), /^inline; filename\*=UTF-8''capture%20%C3%A9cran\.png$/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);

    const listed = (await carol.call('GET', `/channels/${general.id}/messages`)).data.messages;
    assert.equal(listed.find((m) => m.id === data.message.id).attachments.length, 1);

    // Un fichier déjà publié ne peut pas être rattaché à un second message.
    assert.equal((await bob.call('POST', `/channels/${general.id}/messages`, { body: 'x', attachmentIds: [up.data.attachment.id] })).status, 400);
  });

  test('les fichiers HTML ou SVG sont toujours téléchargés, jamais affichés', async () => {
    const up = await upload(bob, general.id, '<script>alert(1)</script>', 'piege.svg', 'image/svg+xml');
    await bob.call('POST', `/channels/${general.id}/messages`, { body: 'svg', attachmentIds: [up.data.attachment.id] });
    const res = await download(carol, up.data.attachment.id);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition'), /^attachment;/);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
  });

  test('on ne peut pas publier le fichier de quelqu’un d’autre', async () => {
    const up = await upload(bob, general.id, 'secret', 'a.txt', 'text/plain');
    assert.equal((await carol.call('POST', `/channels/${general.id}/messages`, { body: 'vol', attachmentIds: [up.data.attachment.id] })).status, 400);
  });

  test('les fichiers d’une conversation privée restent privés', async () => {
    const adminId = (await admin.call('GET', '/me')).data.user.id;
    const { data: { channel } } = await bob.call('POST', '/dms', { userId: adminId });
    const up = await upload(bob, channel.id, 'fiche de paie', 'paie.pdf', 'application/pdf');
    await bob.call('POST', `/channels/${channel.id}/messages`, { body: 'ci-joint', attachmentIds: [up.data.attachment.id] });
    assert.equal((await download(admin, up.data.attachment.id)).status, 200);
    assert.equal((await download(carol, up.data.attachment.id)).status, 404);
    assert.equal((await upload(carol, channel.id, 'x', 'x.txt', 'text/plain')).status, 404);
  });

  test('supprimer le message supprime le fichier', async () => {
    const up = await upload(bob, general.id, 'temp', 'temp.txt', 'text/plain');
    const { data } = await bob.call('POST', `/channels/${general.id}/messages`, { body: 'à supprimer', attachmentIds: [up.data.attachment.id] });
    const { readdirSync } = await import('node:fs');
    const before = readdirSync(srv.uploadDir).length;
    await bob.call('DELETE', `/messages/${data.message.id}`);
    assert.equal(readdirSync(srv.uploadDir).length, before - 1);
    assert.equal((await download(bob, up.data.attachment.id)).status, 404);
  });

  test('fichier vide refusé', async () => {
    assert.equal((await upload(bob, general.id, '', 'vide.txt', 'text/plain')).status, 400);
  });
});

describe('fils de discussion', () => {
  let general;
  let root;

  before(async () => {
    general = (await bob.call('GET', '/channels')).data.channels.find((c) => c.name === 'general');
    root = (await admin.call('POST', `/channels/${general.id}/messages`, { body: 'Qui vient à la réunion ?' })).data.message;
  });

  test('répondre dans un fil', async () => {
    const ws = socket(carol.cookie);
    await ws.opened;
    const reply = (await bob.call('POST', `/channels/${general.id}/messages`, { body: 'Moi !', parentId: root.id })).data.message;
    assert.equal(reply.parentId, root.id);
    const ev = await ws.next((e) => e.type === 'message:new' && e.message.id === reply.id);
    assert.equal(ev.message.parentId, root.id);
    ws.ws.close();

    // Répondre à une réponse reste dans le même fil.
    const nested = (await carol.call('POST', `/channels/${general.id}/messages`, { body: 'Moi aussi', parentId: reply.id })).data.message;
    assert.equal(nested.parentId, root.id);

    const thread = (await carol.call('GET', `/messages/${root.id}/replies`)).data;
    assert.equal(thread.message.replyCount, 2);
    assert.deepEqual(thread.replies.map((r) => r.body), ['Moi !', 'Moi aussi']);
  });

  test('les réponses n’apparaissent pas dans le canal mais le compteur oui', async () => {
    const { messages } = (await carol.call('GET', `/channels/${general.id}/messages`)).data;
    assert.ok(!messages.some((m) => m.parentId));
    const listed = messages.find((m) => m.id === root.id);
    assert.equal(listed.replyCount, 2);
    assert.ok(listed.lastReplyAt);
  });

  test('les réponses ne comptent pas comme non lues dans le canal', async () => {
    const before = (await admin.call('GET', '/channels')).data.channels.find((c) => c.id === general.id).unread;
    await bob.call('POST', `/channels/${general.id}/messages`, { body: 'encore une réponse', parentId: root.id });
    const after = (await admin.call('GET', '/channels')).data.channels.find((c) => c.id === general.id).unread;
    assert.equal(after, before);
  });

  test('impossible de répondre à un message d’un autre canal', async () => {
    const { data: { channel } } = await bob.call('POST', '/channels', { name: 'autre' });
    assert.equal((await bob.call('POST', `/channels/${channel.id}/messages`, { body: 'x', parentId: root.id })).status, 404);
  });

  test('un fil privé reste privé', async () => {
    const adminId = (await admin.call('GET', '/me')).data.user.id;
    const { data: { channel } } = await bob.call('POST', '/dms', { userId: adminId });
    const dmRoot = (await bob.call('POST', `/channels/${channel.id}/messages`, { body: 'privé' })).data.message;
    assert.equal((await carol.call('GET', `/messages/${dmRoot.id}/replies`)).status, 404);
  });

  test('supprimer le message d’origine supprime le fil', async () => {
    const id = root.id;
    assert.equal((await admin.call('DELETE', `/messages/${id}`)).status, 204);
    assert.equal((await admin.call('GET', `/messages/${id}/replies`)).status, 404);
    const search = (await admin.call('GET', '/search?q=Moi%20aussi')).data;
    assert.equal(search.messages.length, 0);
  });
});

describe('réactions', () => {
  let general;
  let msg;

  before(async () => {
    general = (await bob.call('GET', '/channels')).data.channels.find((c) => c.name === 'general');
    msg = (await bob.call('POST', `/channels/${general.id}/messages`, { body: 'On déjeune ensemble ?' })).data.message;
  });

  test('ajouter, cumuler puis retirer une réaction', async () => {
    const ws = socket(carol.cookie);
    await ws.opened;
    const first = await admin.call('POST', `/messages/${msg.id}/reactions`, { emoji: '👍' });
    assert.equal(first.status, 200);
    const ev = await ws.next((e) => e.type === 'message:reactions' && e.messageId === msg.id);
    assert.equal(ev.reactions[0].emoji, '👍');
    ws.ws.close();

    await carol.call('POST', `/messages/${msg.id}/reactions`, { emoji: '👍' });
    await carol.call('POST', `/messages/${msg.id}/reactions`, { emoji: '🍕' });
    const listed = (await bob.call('GET', `/channels/${general.id}/messages`)).data.messages.find((m) => m.id === msg.id);
    assert.deepEqual(listed.reactions.map((r) => [r.emoji, r.userIds.length]), [['👍', 2], ['🍕', 1]]);

    const removed = (await carol.call('POST', `/messages/${msg.id}/reactions`, { emoji: '🍕' })).data.reactions;
    assert.deepEqual(removed.map((r) => r.emoji), ['👍']);
  });

  test('emojis composés acceptés, texte refusé', async () => {
    assert.equal((await admin.call('POST', `/messages/${msg.id}/reactions`, { emoji: '👍🏽' })).status, 200);
    assert.equal((await admin.call('POST', `/messages/${msg.id}/reactions`, { emoji: '👨‍👩‍👧' })).status, 200);
    assert.equal((await admin.call('POST', `/messages/${msg.id}/reactions`, { emoji: '🇫🇷' })).status, 200);
    for (const bad of ['ok', '<b>', '', '👍 x', '1']) {
      assert.equal((await admin.call('POST', `/messages/${msg.id}/reactions`, { emoji: bad })).status, 400, bad);
    }
  });

  test('impossible de réagir à un message privé d’autrui', async () => {
    const bobId = (await bob.call('GET', '/me')).data.user.id;
    const { data: { channel } } = await admin.call('POST', '/dms', { userId: bobId });
    const dm = (await admin.call('POST', `/channels/${channel.id}/messages`, { body: 'entre nous' })).data.message;
    assert.equal((await carol.call('POST', `/messages/${dm.id}/reactions`, { emoji: '👀' })).status, 404);
  });
});

describe('notifications', () => {
  let general;
  const unread = async (who) => (await who.call('GET', '/notifications')).data;

  before(async () => {
    general = (await bob.call('GET', '/channels')).data.channels.find((c) => c.name === 'general');
    await admin.call('POST', '/notifications/read', {});
    await bob.call('POST', '/notifications/read', {});
    await carol.call('POST', '/notifications/read', {});
  });

  test('une @mention notifie la personne en temps réel', async () => {
    const ws = socket(carol.cookie);
    await ws.opened;
    const { data: { message } } = await bob.call('POST', `/channels/${general.id}/messages`, { body: 'Tu peux relire, @carol petit ?' });
    const ev = await ws.next((e) => e.type === 'notification:new');
    ws.ws.close();
    assert.equal(ev.notification.kind, 'mention');
    assert.equal(ev.notification.messageId, message.id);
    assert.equal(ev.notification.excerpt, 'Tu peux relire, @carol petit ?');
    const data = await unread(carol);
    assert.equal(data.unread, 1);
    assert.equal((await unread(admin)).unread, 0);
  });

  test('marquer comme lu', async () => {
    const { notifications } = await unread(carol);
    const res = await carol.call('POST', '/notifications/read', { ids: [notifications[0].id] });
    assert.equal(res.data.unread, 0);
    // On ne peut pas toucher aux notifications des autres.
    assert.equal((await bob.call('POST', '/notifications/read', { ids: 'tout' })).status, 400);
  });

  test('@tous notifie les membres du canal sauf l’auteur', async () => {
    await admin.call('POST', `/channels/${general.id}/messages`, { body: '@tous réunion à 14h' });
    assert.equal((await unread(bob)).notifications[0].kind, 'mention');
    assert.equal((await unread(carol)).notifications[0].kind, 'mention');
    assert.equal((await unread(admin)).unread, 0);
    await bob.call('POST', '/notifications/read', {});
    await carol.call('POST', '/notifications/read', {});
  });

  test('les participants d’un fil sont notifiés des réponses', async () => {
    const root = (await admin.call('POST', `/channels/${general.id}/messages`, { body: 'Idées pour le séminaire ?' })).data.message;
    await bob.call('POST', `/channels/${general.id}/messages`, { body: 'Le Pays basque !', parentId: root.id });
    let a = await unread(admin);
    assert.equal(a.unread, 1);
    assert.equal(a.notifications[0].kind, 'reply');
    assert.equal(a.notifications[0].parentId, root.id);
    assert.equal((await unread(carol)).unread, 0); // Carol ne participe pas au fil.

    // Bob participe désormais : il est notifié de la réponse de Carol, Alice aussi.
    await carol.call('POST', `/channels/${general.id}/messages`, { body: 'Plutôt la montagne', parentId: root.id });
    assert.equal((await unread(bob)).notifications[0].kind, 'reply');
    a = await unread(admin);
    assert.equal(a.unread, 2);

    // Une mention dans un fil compte comme mention, pas comme réponse en double.
    await carol.call('POST', `/channels/${general.id}/messages`, { body: '@Alice Martin tu tranches ?', parentId: root.id });
    a = await unread(admin);
    assert.equal(a.unread, 3);
    assert.equal(a.notifications[0].kind, 'mention');
    await admin.call('POST', '/notifications/read', {});
    await bob.call('POST', '/notifications/read', {});
  });

  test('une réaction notifie l’auteur, la retirer efface la notification', async () => {
    const msg = (await bob.call('POST', `/channels/${general.id}/messages`, { body: 'Rapport envoyé' })).data.message;
    await carol.call('POST', `/messages/${msg.id}/reactions`, { emoji: '🎉' });
    let b = await unread(bob);
    assert.equal(b.notifications[0].kind, 'reaction');
    assert.equal(b.notifications[0].emoji, '🎉');
    await carol.call('POST', `/messages/${msg.id}/reactions`, { emoji: '🎉' });
    b = await unread(bob);
    assert.equal(b.unread, 0);
    // Réagir à son propre message ne notifie personne.
    await bob.call('POST', `/messages/${msg.id}/reactions`, { emoji: '✅' });
    assert.equal((await unread(bob)).unread, 0);
  });

  test('pas de notification pour quelqu’un qui ne peut pas lire le message', async () => {
    const bobId = (await bob.call('GET', '/me')).data.user.id;
    const { data: { channel } } = await admin.call('POST', '/dms', { userId: bobId });
    await admin.call('POST', `/channels/${channel.id}/messages`, { body: 'Ne dis rien à @Carol Petit' });
    assert.equal((await unread(carol)).unread, 0);
  });

  test('supprimer le message supprime ses notifications', async () => {
    const msg = (await bob.call('POST', `/channels/${general.id}/messages`, { body: '@Carol Petit oups' })).data.message;
    assert.equal((await unread(carol)).unread, 1);
    await bob.call('DELETE', `/messages/${msg.id}`);
    assert.equal((await unread(carol)).unread, 0);
  });
});


describe('canaux privés', () => {
  let ids;
  let secret;

  before(async () => {
    ids = {
      admin: (await admin.call('GET', '/me')).data.user.id,
      bob: (await bob.call('GET', '/me')).data.user.id,
      carol: (await carol.call('GET', '/me')).data.user.id,
    };
  });

  test('créer un canal privé avec des membres', async () => {
    const bobWs = socket(bob.cookie);
    const carolWs = socket(carol.cookie);
    await Promise.all([bobWs.opened, carolWs.opened]);
    const { status, data } = await admin.call('POST', '/channels', { name: 'direction', isPrivate: true, memberIds: [ids.bob] });
    assert.equal(status, 201);
    secret = data.channel;
    assert.equal(secret.isPrivate, true);
    assert.equal(secret.memberCount, 2);
    const ev = await bobWs.next((e) => e.type === 'channel:joined' && e.channel.id === secret.id);
    assert.equal(ev.channel.joined, true);
    await admin.call('POST', `/channels/${secret.id}/messages`, { body: 'Budget confidentiel' });
    await bobWs.next((e) => e.type === 'message:new' && e.message.channelId === secret.id);
    assert.ok(!carolWs.events.some((e) => e.channel?.id === secret.id || e.message?.channelId === secret.id));
    bobWs.ws.close();
    carolWs.ws.close();
  });

  test('invisible et inaccessible pour les non-membres', async () => {
    assert.ok(!(await carol.call('GET', '/channels')).data.channels.some((c) => c.id === secret.id));
    assert.equal((await carol.call('GET', `/channels/${secret.id}/messages`)).status, 404);
    assert.equal((await carol.call('POST', `/channels/${secret.id}/join`)).status, 404);
    assert.equal((await carol.call('GET', `/channels/${secret.id}/members`)).status, 404);
    assert.equal((await carol.call('GET', '/search?q=Budget%20confidentiel')).data.messages.length, 0);
    assert.equal((await bob.call('GET', '/search?q=Budget%20confidentiel')).data.messages.length, 1);
  });

  test('un membre peut ajouter quelqu’un, qui voit alors l’historique', async () => {
    const res = await bob.call('POST', `/channels/${secret.id}/members`, { userIds: [ids.carol] });
    assert.deepEqual(res.data.added, [ids.carol]);
    assert.equal((await carol.call('GET', `/channels/${secret.id}/messages`)).data.messages[0].body, 'Budget confidentiel');
    const listed = (await carol.call('GET', '/channels')).data.channels.find((c) => c.id === secret.id);
    assert.equal(listed.memberCount, 3);
    assert.equal((await admin.call('POST', `/channels/${secret.id}/members`, { userIds: [999] })).status, 400);
  });

  test('seuls le créateur et les admins retirent quelqu’un', async () => {
    assert.equal((await carol.call('DELETE', `/channels/${secret.id}/members/${ids.bob}`)).status, 403);
    const carolWs = socket(carol.cookie);
    await carolWs.opened;
    assert.equal((await admin.call('DELETE', `/channels/${secret.id}/members/${ids.carol}`)).status, 204);
    await carolWs.next((e) => e.type === 'channel:removed' && e.channelId === secret.id);
    carolWs.ws.close();
    assert.equal((await carol.call('GET', `/channels/${secret.id}/messages`)).status, 404);
  });

  test('chacun peut quitter un canal privé', async () => {
    assert.equal((await bob.call('DELETE', `/channels/${secret.id}/members/${ids.bob}`)).status, 204);
    assert.deepEqual((await admin.call('GET', `/channels/${secret.id}/members`)).data.members, [ids.admin]);
  });

  test('pas de notification pour un non-membre mentionné', async () => {
    await carol.call('POST', '/notifications/read', {});
    await admin.call('POST', `/channels/${secret.id}/messages`, { body: '@Carol Petit ne doit pas savoir' });
    assert.equal((await carol.call('GET', '/notifications')).data.unread, 0);
  });

  test('ajouter des personnes à un canal public', async () => {
    const { data: { channel } } = await admin.call('POST', '/channels', { name: 'marketing', memberIds: [ids.carol] });
    assert.equal(channel.isPrivate, false);
    assert.ok((await carol.call('GET', '/channels')).data.channels.find((c) => c.id === channel.id).joined);
    const bobView = (await bob.call('GET', '/channels')).data.channels.find((c) => c.id === channel.id);
    assert.equal(bobView.joined, false);
    // Un non-membre d'un canal public ne peut pas y ajouter d'autres personnes.
    assert.equal((await bob.call('POST', `/channels/${channel.id}/members`, { userIds: [ids.bob] })).status, 403);
  });
});

describe('historique des pages', () => {
  let page;
  const save = (who, content, version) => who.call('PATCH', `/pages/${page.id}`, { content, version });

  before(async () => {
    page = (await bob.call('POST', '/pages', { title: 'Charte' })).data.page;
  });

  test('les enregistrements rapprochés d’une même personne forment une seule version', async () => {
    let v = (await save(bob, 'Brouillon 1', page.version)).data.page.version;
    v = (await save(bob, 'Brouillon 2', v)).data.page.version;
    v = (await save(bob, 'Version de Bob', v)).data.page.version;
    let list = (await bob.call('GET', `/pages/${page.id}/versions`)).data;
    assert.equal(list.versions.length, 1);
    assert.equal(list.current, v);

    // Quelqu'un d'autre écrit : nouvelle version.
    v = (await save(carol, 'Version de Carol', v)).data.page.version;
    list = (await bob.call('GET', `/pages/${page.id}/versions`)).data;
    assert.equal(list.versions.length, 2);
    assert.equal(list.versions[0].editedBy, (await carol.call('GET', '/me')).data.user.id);
    page.version = v;
  });

  test('consulter puis restaurer une version', async () => {
    const { versions } = (await bob.call('GET', `/pages/${page.id}/versions`)).data;
    const old = versions.at(-1);
    const detail = (await carol.call('GET', `/pages/${page.id}/versions/${old.id}`)).data.version;
    assert.equal(detail.content, 'Version de Bob');

    assert.equal((await carol.call('POST', `/pages/${page.id}/versions/${old.id}/restore`, { version: 1 })).status, 409);
    const restored = (await carol.call('POST', `/pages/${page.id}/versions/${old.id}/restore`, { version: page.version })).data.page;
    assert.equal(restored.content, 'Version de Bob');
    const after = (await bob.call('GET', `/pages/${page.id}/versions`)).data.versions;
    assert.equal(after.length, 3);
    assert.equal(after[0].restoredFrom, old.version);
    // Une restauration n'est jamais fusionnée avec les modifications suivantes.
    await save(carol, 'Version de Bob, corrigée', restored.version);
    assert.equal((await bob.call('GET', `/pages/${page.id}/versions`)).data.versions.length, 4);
  });

  test('une page existant avant l’historique garde son contenu d’origine', async () => {
    const legacy = (await admin.call('POST', '/pages', { title: 'Ancienne' })).data.page;
    srv.db.prepare("UPDATE pages SET content = 'Texte historique', version = 5 WHERE id = ?").run(legacy.id);
    await admin.call('PATCH', `/pages/${legacy.id}`, { content: 'Texte modifié', version: 5 });
    const versions = (await admin.call('GET', `/pages/${legacy.id}/versions`)).data.versions;
    assert.equal(versions.length, 2);
    const original = (await admin.call('GET', `/pages/${legacy.id}/versions/${versions[1].id}`)).data.version;
    assert.equal(original.content, 'Texte historique');
  });

  test('déplacer une page ne crée pas de version', async () => {
    const before = (await bob.call('GET', `/pages/${page.id}/versions`)).data;
    const parent = (await bob.call('POST', '/pages', { title: 'Dossier' })).data.page;
    await bob.call('PATCH', `/pages/${page.id}`, { parentId: parent.id, version: before.current });
    assert.equal((await bob.call('GET', `/pages/${page.id}/versions`)).data.versions.length, before.versions.length);
  });

  test('version d’une autre page introuvable', async () => {
    const other = (await bob.call('POST', '/pages', { title: 'Autre' })).data.page;
    const { versions } = (await bob.call('GET', `/pages/${page.id}/versions`)).data;
    assert.equal((await bob.call('GET', `/pages/${other.id}/versions/${versions[0].id}`)).status, 404);
  });
});

describe('notifications push', () => {
  let general;
  const subscribe = (who, endpoint) => who.call('POST', '/push/subscribe', {
    subscription: { endpoint, keys: { p256dh: 'BPUBLIC', auth: 'secret' } },
  });

  before(async () => {
    general = (await bob.call('GET', '/channels')).data.channels.find((c) => c.name === 'general');
    pushed.length = 0;
  });

  test('clé publique exposée et abonnement validé', async () => {
    assert.equal((await carol.call('GET', '/push/key')).data.publicKey, 'cle-publique-de-test');
    assert.equal((await subscribe(carol, 'http://pas-https.example/x')).status, 400);
    assert.equal((await subscribe(carol, 'https://push.example/carol-telephone')).status, 204);
  });

  test('une mention part en push quand la personne n’a aucun onglet ouvert', async () => {
    await bob.call('POST', `/channels/${general.id}/messages`, { body: 'Merci @Carol Petit pour le devis' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].endpoint, 'https://push.example/carol-telephone');
    assert.equal(pushed[0].payload.title, 'Bob Durand vous a mentionné dans #general');
    assert.equal(pushed[0].payload.body, 'Merci @Carol Petit pour le devis');
    assert.match(pushed[0].payload.url, new RegExp(`^/#/c/${general.id}$`));
  });

  test('pas de push si la personne a l’application ouverte', async () => {
    pushed.length = 0;
    const ws = socket(carol.cookie);
    await ws.opened;
    await bob.call('POST', `/channels/${general.id}/messages`, { body: '@Carol Petit tu es là ?' });
    await ws.next((e) => e.type === 'notification:new');
    ws.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pushed.length, 0);
  });

  test('un message privé part en push sans mention', async () => {
    pushed.length = 0;
    await new Promise((r) => setTimeout(r, 50)); // laisse le temps à la déconnexion précédente
    const carolId = (await carol.call('GET', '/me')).data.user.id;
    const { data: { channel } } = await bob.call('POST', '/dms', { userId: carolId });
    await bob.call('POST', `/channels/${channel.id}/messages`, { body: 'Tu as 5 minutes ?' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pushed.length, 1);
    assert.deepEqual(
      { title: pushed[0].payload.title, body: pushed[0].payload.body, url: pushed[0].payload.url },
      { title: 'Bob Durand', body: 'Tu as 5 minutes ?', url: `/#/c/${channel.id}` },
    );
  });

  test('un abonnement expiré est supprimé', async () => {
    await subscribe(carol, 'https://push.example/expire');
    pushed.length = 0;
    await bob.call('POST', `/channels/${general.id}/messages`, { body: '@Carol Petit encore moi' });
    await new Promise((r) => setTimeout(r, 50));
    const rows = srv.db.prepare('SELECT endpoint FROM push_subscriptions').all().map((r) => r.endpoint);
    assert.ok(!rows.includes('https://push.example/expire'));
    assert.ok(rows.includes('https://push.example/carol-telephone'));
  });

  test('désabonnement', async () => {
    await carol.call('POST', '/push/unsubscribe', { endpoint: 'https://push.example/carol-telephone' });
    pushed.length = 0;
    await bob.call('POST', `/channels/${general.id}/messages`, { body: '@Carol Petit dernier essai' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pushed.length, 0);
  });
});

describe('push et visibilité', () => {
  test('un onglet en arrière-plan n’empêche pas le push', async () => {
    const general = (await bob.call('GET', '/channels')).data.channels.find((c) => c.name === 'general');
    await carol.call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.example/carol-2', keys: { p256dh: 'B', auth: 'a' } } });
    const ws = socket(carol.cookie);
    await ws.opened;
    ws.ws.send(JSON.stringify({ type: 'visibility', visible: false }));
    await new Promise((r) => setTimeout(r, 50));
    pushed.length = 0;
    await bob.call('POST', `/channels/${general.id}/messages`, { body: '@Carol Petit réunion !' });
    await ws.next((e) => e.type === 'notification:new');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pushed.length, 1);

    // De retour au premier plan : plus de push.
    ws.ws.send(JSON.stringify({ type: 'visibility', visible: true }));
    await new Promise((r) => setTimeout(r, 50));
    pushed.length = 0;
    await bob.call('POST', `/channels/${general.id}/messages`, { body: '@Carol Petit c’est maintenant' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pushed.length, 0);
    ws.ws.close();
  });
});

describe('gestion des comptes', () => {
  let ids;
  // Client qui se connecte avec un mot de passe donné.
  const loginAs = async (email, password) => {
    const c = client();
    const res = await c.call('POST', '/auth/login', { email, password });
    return { c, status: res.status, data: res.data };
  };

  before(async () => {
    ids = {
      admin: (await admin.call('GET', '/me')).data.user.id,
      bob: (await bob.call('GET', '/me')).data.user.id,
      carol: (await carol.call('GET', '/me')).data.user.id,
    };
  });

  test('l’administration est réservée aux admins', async () => {
    assert.equal((await bob.call('GET', '/admin/users')).status, 403);
    assert.equal((await bob.call('PATCH', `/admin/users/${ids.carol}`, { role: 'admin' })).status, 403);
    const { users } = (await admin.call('GET', '/admin/users')).data;
    assert.equal(users.length, 3);
    assert.ok(users.every((u) => u.active && u.createdAt));
  });

  test('nommer puis retirer un administrateur', async () => {
    const ws = socket(carol.cookie);
    await ws.opened;
    const res = await admin.call('PATCH', `/admin/users/${ids.bob}`, { role: 'admin' });
    assert.equal(res.data.user.role, 'admin');
    const ev = await ws.next((e) => e.type === 'user:updated' && e.user.id === ids.bob);
    assert.equal(ev.user.role, 'admin');
    ws.ws.close();
    // Bob, désormais admin, a accès à l'administration.
    assert.equal((await bob.call('GET', '/admin/users')).status, 200);
    assert.equal((await bob.call('PATCH', `/admin/users/${ids.bob}`, { role: 'member' })).status, 400); // pas sur soi-même
    assert.equal((await admin.call('PATCH', `/admin/users/${ids.bob}`, { role: 'member' })).data.user.role, 'member');
    assert.equal((await admin.call('PATCH', `/admin/users/${ids.bob}`, { role: 'chef' })).status, 400);
  });

  test('impossible de se retirer ses propres droits ou de se désactiver', async () => {
    assert.equal((await admin.call('PATCH', `/admin/users/${ids.admin}`, { role: 'member' })).status, 400);
    assert.equal((await admin.call('PATCH', `/admin/users/${ids.admin}`, { active: false })).status, 400);
    assert.equal((await admin.call('GET', '/me')).data.user.role, 'admin');
  });

  test('désactiver un compte coupe ses sessions et l’empêche de se connecter', async () => {
    const carolSession = (await loginAs('carol@pme.fr', 'motdepasse3')).c;
    const ws = socket(carolSession.cookie);
    await ws.opened;
    const closed = new Promise((resolve) => ws.ws.on('close', resolve));
    await carolSession.call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.example/carol-desactivee', keys: { p256dh: 'B', auth: 'a' } } });

    assert.equal((await admin.call('PATCH', `/admin/users/${ids.carol}`, { active: false })).data.user.active, false);
    await closed;
    assert.equal((await carolSession.call('GET', '/me')).status, 401);
    const retry = await loginAs('carol@pme.fr', 'motdepasse3');
    assert.equal(retry.status, 403);
    assert.match(retry.data.error, /désactivé/);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(ids.carol).n, 0);

    // Plus de nouveau message privé ni d'ajout à un canal pour un compte désactivé.
    assert.equal((await bob.call('POST', '/dms', { userId: ids.carol })).status, 404);
    const general = (await bob.call('GET', '/channels')).data.channels.find((c) => c.name === 'general');
    assert.equal((await bob.call('POST', `/channels/${general.id}/members`, { userIds: [ids.carol] })).status, 400);
    // Son nom reste affiché sur ses anciens messages.
    const listed = (await bob.call('GET', '/users')).data.users.find((u) => u.id === ids.carol);
    assert.equal(listed.active, false);
    assert.equal(listed.name, 'Carol Petit');
  });

  test('réactiver un compte', async () => {
    await admin.call('PATCH', `/admin/users/${ids.carol}`, { active: true });
    const again = await loginAs('carol@pme.fr', 'motdepasse3');
    assert.equal(again.status, 200);
    carol.call = again.c.call; // le client « carol » des autres tests reprend la nouvelle session
    Object.defineProperty(carol, 'cookie', { get: () => again.c.cookie });
  });

  test('il reste toujours au moins un administrateur actif', async () => {
    // Comme on ne peut pas toucher à ses propres droits, l'admin qui agit reste toujours admin.
    await admin.call('PATCH', `/admin/users/${ids.bob}`, { role: 'admin' });
    assert.equal((await bob.call('PATCH', `/admin/users/${ids.admin}`, { role: 'member' })).status, 200);
    // Désormais Bob est le seul admin : Alice (simple membre) ne peut plus rien faire.
    assert.equal((await admin.call('PATCH', `/admin/users/${ids.bob}`, { role: 'member' })).status, 403);
    // Bob rend ses droits à Alice.
    await bob.call('PATCH', `/admin/users/${ids.admin}`, { role: 'admin' });
    await admin.call('PATCH', `/admin/users/${ids.bob}`, { role: 'member' });
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n, 1);
  });

  test('lien de réinitialisation à usage unique', async () => {
    const bobOther = (await loginAs('bob@pme.fr', 'motdepasse2')).c;
    const { token } = (await admin.call('POST', `/admin/users/${ids.bob}/reset`)).data;
    assert.equal(token.length, 64);
    // Seule l'empreinte du jeton est stockée.
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE token_hash = ?').get(token).n, 0);

    const anon = client();
    assert.deepEqual((await anon.call('GET', `/reset/${token}`)).data, { valid: true, name: 'Bob Durand' });
    assert.equal((await anon.call('POST', '/auth/reset', { token, password: 'court' })).status, 400);
    const ok = await anon.call('POST', '/auth/reset', { token, password: 'nouveau-mdp-bob' });
    assert.equal(ok.status, 200);
    assert.equal((await anon.call('GET', '/me')).data.user.id, ids.bob);
    assert.equal((await bobOther.call('GET', '/me')).status, 401); // anciennes sessions fermées
    assert.equal((await anon.call('POST', '/auth/reset', { token, password: 'encore-un-autre' })).status, 400);
    assert.equal((await anon.call('GET', `/reset/${token}`)).data.valid, false);
    assert.equal((await loginAs('bob@pme.fr', 'motdepasse2')).status, 401);
    const fresh = await loginAs('bob@pme.fr', 'nouveau-mdp-bob');
    assert.equal(fresh.status, 200);
    bob.call = fresh.c.call;
    Object.defineProperty(bob, 'cookie', { get: () => fresh.c.cookie });
  });

  test('changer son nom et son mot de passe', async () => {
    assert.equal((await carol.call('PATCH', '/me', { name: '  Carol Petit-Martin ' })).data.user.name, 'Carol Petit-Martin');
    assert.equal((await carol.call('PATCH', '/me', { name: '' })).status, 400);

    const other = (await loginAs('carol@pme.fr', 'motdepasse3')).c;
    assert.equal((await carol.call('POST', '/me/password', { current: 'mauvais', password: 'nouveau-mdp-carol' })).status, 400);
    assert.equal((await carol.call('POST', '/me/password', { current: 'motdepasse3', password: 'nouveau-mdp-carol' })).status, 204);
    assert.equal((await carol.call('GET', '/me')).status, 200); // la session en cours reste ouverte
    assert.equal((await other.call('GET', '/me')).status, 401); // les autres appareils sont déconnectés
    assert.equal((await loginAs('carol@pme.fr', 'nouveau-mdp-carol')).status, 200);
    await carol.call('PATCH', '/me', { name: 'Carol Petit' });
  });

  test('invitations en attente : liste et révocation', async () => {
    const { token } = (await admin.call('POST', '/invites')).data;
    const { invites } = (await admin.call('GET', '/admin/invites')).data;
    assert.ok(invites.some((i) => i.token === token));
    assert.equal((await bob.call('GET', '/admin/invites')).status, 403);
    assert.equal((await admin.call('DELETE', `/admin/invites/${token}`)).status, 204);
    assert.equal((await client().call('GET', `/invites/${token}`)).data.valid, false);
  });
});
