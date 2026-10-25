import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';
import { renderMarkdown } from '../public/markdown.js';

let srv;
let base;

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1' });
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

  test('blocs : titres, listes, tâches, code', () => {
    const html = renderMarkdown('# Titre\n- un\n- [x] fait\n1. premier\n```\n<b>code</b>\n```');
    assert.match(html, /<h1>Titre<\/h1>/);
    assert.match(html, /<li>un<\/li>/);
    assert.match(html, /class="task done"/);
    assert.match(html, /<ol><li>premier<\/li><\/ol>/);
    assert.match(html, /<pre><code>&lt;b&gt;code&lt;\/b&gt;<\/code><\/pre>/);
  });
});
