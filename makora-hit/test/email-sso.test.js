import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';
import { createOidc } from '../src/oidc.js';

const PUBLIC_URL = 'https://chat.example';

// --- Faux fournisseur d'identité OpenID Connect (rôle de Google / Microsoft) -------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 }); // clé d'un attaquant
const provider = {
  base: '',
  identity: null, // identité renvoyée à la prochaine connexion
  tamper: null, // 'signature' | 'audience' | 'nonce'
  codes: new Map(),
};

function signJwt(claims, key = privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'cle-1', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${body}.${sign('sha256', Buffer.from(`${header}.${body}`), key).toString('base64url')}`;
}

const idp = createServer(async (req, res) => {
  const url = new URL(req.url, provider.base);
  const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (url.pathname === '/.well-known/openid-configuration') {
    return json(200, {
      issuer: provider.base,
      authorization_endpoint: `${provider.base}/authorize`,
      token_endpoint: `${provider.base}/token`,
      jwks_uri: `${provider.base}/jwks`,
    });
  }
  if (url.pathname === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'cle-1', alg: 'RS256', use: 'sig' }] });
  if (url.pathname === '/authorize') {
    // La personne s'est authentifiée chez le fournisseur : retour vers l'application avec un code.
    const code = randomBytes(8).toString('hex');
    provider.codes.set(code, {
      nonce: url.searchParams.get('nonce'),
      challenge: url.searchParams.get('code_challenge'),
      redirect: url.searchParams.get('redirect_uri'),
      identity: provider.identity,
    });
    res.writeHead(302, { Location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}` });
    return res.end();
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const grant = provider.codes.get(form.get('code'));
    provider.codes.delete(form.get('code'));
    const verifierOk = grant && createHash('sha256').update(form.get('code_verifier')).digest('base64url') === grant.challenge;
    if (!grant || !verifierOk || form.get('client_secret') !== 'secret' || form.get('redirect_uri') !== grant.redirect) {
      return json(400, { error: 'invalid_grant' });
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: provider.base, aud: provider.tamper === 'audience' ? 'autre-appli' : 'makora', sub: grant.identity.email,
      iat: now, exp: now + 300, nonce: provider.tamper === 'nonce' ? 'ancien-nonce' : grant.nonce, ...grant.identity,
    };
    return json(200, { id_token: signJwt(claims, provider.tamper === 'signature' ? rogue.privateKey : privateKey), token_type: 'Bearer' });
  }
  json(404, {});
});

// --- Application avec email et SSO -------------------------------------------------------

const sent = [];
const fakeMailer = { async send(message) { sent.push(message); } };
let srv;
let base;

before(async () => {
  await new Promise((r) => idp.listen(0, '127.0.0.1', r));
  provider.base = `http://127.0.0.1:${idp.address().port}`;
  srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    push: null,
    mailer: fakeMailer,
    publicUrl: PUBLIC_URL,
    oidc: createOidc({
      issuer: provider.base, clientId: 'makora', clientSecret: 'secret',
      redirectUri: `${PUBLIC_URL}/api/auth/sso/callback`, label: 'Google', allowedDomains: ['pme.fr'],
    }),
  });
  base = `http://127.0.0.1:${srv.port}`;
});

after(async () => {
  await srv.close();
  idp.close();
});

function client() {
  let cookie = '';
  const call = async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'X-Makora': '1', ...(body && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }), ...extraHeaders },
      body: body && JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) if (c.startsWith('makora_session=')) cookie = c.split(';')[0];
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  };
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

// Parcours complet d'une connexion SSO, comme le ferait le navigateur. Renvoie l'adresse finale.
async function ssoLogin(who, { dropCookie = false } = {}) {
  const start = await fetch(`${base}/api/auth/sso`, { redirect: 'manual' });
  assert.equal(start.status, 303);
  const ssoCookie = start.headers.getSetCookie().find((c) => c.startsWith('makora_sso=')).split(';')[0];
  const atIdp = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const back = new URL(atIdp.headers.get('location'));
  assert.equal(back.origin, PUBLIC_URL);
  const callback = await fetch(`${base}${back.pathname}${back.search}`, {
    redirect: 'manual', headers: dropCookie ? {} : { Cookie: ssoCookie },
  });
  for (const c of callback.headers.getSetCookie()) if (c.startsWith('makora_session=')) who.cookie = c.split(';')[0];
  return callback.headers.get('location');
}

const admin = client();

describe('connexion SSO', () => {
  test('la demande envoyée au fournisseur utilise PKCE, un state et un nonce', async () => {
    const res = await fetch(`${base}/api/auth/sso`, { redirect: 'manual' });
    const url = new URL(res.headers.get('location'));
    assert.equal(url.origin + url.pathname, `${provider.base}/authorize`);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), `${PUBLIC_URL}/api/auth/sso/callback`);
    assert.ok(url.searchParams.get('state').length >= 32);
    assert.ok(url.searchParams.get('nonce').length >= 32);
    assert.match(res.headers.get('set-cookie'), /makora_sso=.*HttpOnly/);
  });

  test('le compte administrateur se crée d’abord avec un mot de passe', async () => {
    provider.identity = { email: 'alice@pme.fr', email_verified: true, name: 'Alice Martin' };
    assert.equal(await ssoLogin(client()), '/#/login-error/setup');
    assert.deepEqual((await admin.call('GET', '/setup')).data, { needsSetup: true, sso: { label: 'Google' }, email: true });
    await admin.call('POST', '/auth/register', { email: 'alice@pme.fr', name: 'Alice Martin', password: 'motdepasse1' });
  });

  test('un compte existant se connecte via SSO', async () => {
    const who = client();
    assert.equal(await ssoLogin(who), '/#/');
    const me = (await who.call('GET', '/me')).data;
    assert.equal(me.user.email, 'alice@pme.fr');
    assert.equal(me.user.role, 'admin');
    assert.equal(me.features.sso, 'Google');
  });

  test('une personne du domaine autorisé obtient un compte automatiquement', async () => {
    provider.identity = { email: 'Bob@PME.fr', email_verified: true, name: 'Bob Durand' };
    const bob = client();
    assert.equal(await ssoLogin(bob), '/#/');
    const me = (await bob.call('GET', '/me')).data.user;
    assert.equal(me.email, 'bob@pme.fr');
    assert.equal(me.role, 'member');
    assert.equal(me.hasPassword, false);
    // Pas de mot de passe : ni connexion classique, ni changement de mot de passe.
    assert.equal((await client().call('POST', '/auth/login', { email: 'bob@pme.fr', password: 'sso$' })).status, 401);
    assert.equal((await bob.call('POST', '/me/password', { current: '', password: 'nouveau-mdp' })).status, 400);
    const channels = (await bob.call('GET', '/channels')).data.channels;
    assert.ok(channels.find((c) => c.name === 'general').joined);
  });

  test('refusée hors du domaine autorisé', async () => {
    provider.identity = { email: 'pirate@gmail.com', email_verified: true, name: 'Pirate' };
    assert.equal(await ssoLogin(client()), '/#/login-error/not_allowed');
  });

  test('refusée si le fournisseur ne confirme pas l’adresse email', async () => {
    provider.identity = { email: 'carol@pme.fr', email_verified: false, name: 'Carol' };
    assert.equal(await ssoLogin(client()), '/#/login-error/email');
  });

  test('refusée sans le cookie de ce navigateur (connexion forcée à l’insu)', async () => {
    provider.identity = { email: 'alice@pme.fr', email_verified: true };
    const who = client();
    assert.equal(await ssoLogin(who, { dropCookie: true }), '/#/login-error/expired');
    assert.equal(who.cookie, '');
  });

  for (const [tamper, label] of [['signature', 'signé par une autre clé'], ['audience', 'destiné à une autre application'], ['nonce', 'rejoué']]) {
    test(`jeton ${label} refusé`, async () => {
      provider.identity = { email: 'alice@pme.fr', email_verified: true };
      provider.tamper = tamper;
      const who = client();
      try {
        assert.equal(await ssoLogin(who), '/#/login-error/provider');
        assert.equal(who.cookie, '');
      } finally {
        provider.tamper = null;
      }
    });
  }

  test('compte désactivé refusé', async () => {
    const bobId = (await admin.call('GET', '/admin/users')).data.users.find((u) => u.email === 'bob@pme.fr').id;
    await admin.call('PATCH', `/admin/users/${bobId}`, { active: false });
    provider.identity = { email: 'bob@pme.fr', email_verified: true };
    assert.equal(await ssoLogin(client()), '/#/login-error/deactivated');
    await admin.call('PATCH', `/admin/users/${bobId}`, { active: true });
  });
});

describe('emails', () => {
  const last = () => sent.at(-1);
  const linkIn = (message) => message.text.match(/https:\/\/chat\.example\/#\/\S+/)[0];

  test('invitation envoyée par email, réservée à cette adresse', async () => {
    sent.length = 0;
    const res = await admin.call('POST', '/invites', { email: 'Carol@pme.fr' });
    assert.equal(res.data.emailed, true);
    assert.equal(last().to, 'carol@pme.fr');
    assert.match(last().subject, /Alice Martin vous invite/);
    const link = linkIn(last());
    assert.equal(link, `${PUBLIC_URL}/#/invite/${res.data.token}`);
    assert.match(last().html, /Créer mon compte/);

    assert.deepEqual((await client().call('GET', `/invites/${res.data.token}`)).data, { valid: true, email: 'carol@pme.fr' });
    const wrong = await client().call('POST', '/auth/register', { email: 'autre@pme.fr', name: 'X', password: 'motdepasse1', invite: res.data.token });
    assert.equal(wrong.status, 403);
    const ok = await client().call('POST', '/auth/register', { email: 'carol@pme.fr', name: 'Carol Petit', password: 'motdepasse3', invite: res.data.token });
    assert.equal(ok.status, 201);
    assert.equal((await admin.call('POST', '/invites', { email: 'carol@pme.fr' })).status, 409);
  });

  test('mot de passe oublié : même réponse que le compte existe ou non', async () => {
    sent.length = 0;
    assert.equal((await client().call('POST', '/auth/forgot', { email: 'inconnu@pme.fr' })).status, 204);
    assert.equal(sent.length, 0);
    // L'en-tête Host d'un attaquant n'influence jamais le lien envoyé.
    assert.equal((await client().call('POST', '/auth/forgot', { email: 'carol@pme.fr' }, { 'X-Forwarded-Host': 'evil.example' })).status, 204);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 1);
    const link = linkIn(last());
    assert.ok(link.startsWith(`${PUBLIC_URL}/#/reset/`));
    assert.match(last().text, /Vous avez demandé/);

    // Pas de second email dans les 2 minutes (évite d'inonder la boîte de quelqu'un).
    await client().call('POST', '/auth/forgot', { email: 'carol@pme.fr' });
    assert.equal(sent.length, 1);

    const token = link.split('/').pop();
    const carol = client();
    assert.equal((await carol.call('POST', '/auth/reset', { token, password: 'nouveau-mdp-carol' })).status, 200);
    assert.equal((await client().call('POST', '/auth/login', { email: 'carol@pme.fr', password: 'nouveau-mdp-carol' })).status, 200);
  });

  test('lien de réinitialisation envoyé par l’administrateur', async () => {
    sent.length = 0;
    const carolId = (await admin.call('GET', '/admin/users')).data.users.find((u) => u.email === 'carol@pme.fr').id;
    const res = await admin.call('POST', `/admin/users/${carolId}/reset`, { send: true });
    assert.equal(res.data.emailed, true);
    assert.match(last().text, /Votre administrateur/);
    assert.equal(linkIn(last()), `${PUBLIC_URL}/#/reset/${res.data.token}`);
  });

  describe('résumé des notifications non lues', () => {
    let carol;
    let general;
    const later = () => Date.now() + 16 * 60 * 1000;

    before(async () => {
      carol = client();
      await carol.call('POST', '/auth/login', { email: 'carol@pme.fr', password: 'nouveau-mdp-carol' });
      general = (await admin.call('GET', '/channels')).data.channels.find((c) => c.name === 'general');
    });

    test('envoyé après 15 minutes sans lecture, une seule fois', async () => {
      sent.length = 0;
      await admin.call('POST', `/channels/${general.id}/messages`, { body: '@Carol Petit peux-tu valider le devis ?' });
      assert.equal(await srv.app.locals.runEmailDigest(Date.now()), 0); // trop tôt
      assert.equal(await srv.app.locals.runEmailDigest(later()), 1);
      assert.equal(last().to, 'carol@pme.fr');
      assert.equal(last().subject, '1 notification non lue sur MAKORA HIT');
      assert.match(last().text, /Alice Martin vous a mentionné dans #general : « @Carol Petit peux-tu valider le devis \? »/);
      assert.match(last().text, new RegExp(`${PUBLIC_URL}/#/c/${general.id}`));
      assert.equal(await srv.app.locals.runEmailDigest(later()), 0); // déjà envoyé
    });

    test('pas plus d’un résumé par heure', async () => {
      sent.length = 0;
      await admin.call('POST', `/channels/${general.id}/messages`, { body: '@Carol Petit et celui-ci ?' });
      assert.equal(await srv.app.locals.runEmailDigest(later()), 0);
      // Le résumé précédent est daté de « maintenant + 16 min » : le suivant est permis une heure plus tard.
    assert.equal(await srv.app.locals.runEmailDigest(Date.now() + 77 * 60 * 1000), 1);
    });

    test('rien si la notification a été lue, si la personne a l’application ouverte, ou si elle a désactivé ces emails', async () => {
      sent.length = 0;
      srv.db.prepare('UPDATE users SET last_digest_at = NULL').run();
      await admin.call('POST', `/channels/${general.id}/messages`, { body: '@Carol Petit lu tout de suite' });
      await carol.call('POST', '/notifications/read', {});
      assert.equal(await srv.app.locals.runEmailDigest(later()), 0);

      await admin.call('POST', `/channels/${general.id}/messages`, { body: '@Carol Petit application ouverte' });
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Cookie: carol.cookie } });
      await new Promise((r) => ws.on('open', r));
      assert.equal(await srv.app.locals.runEmailDigest(later()), 0);
      ws.close();
      await new Promise((r) => setTimeout(r, 50));

      assert.equal((await carol.call('PATCH', '/me', { emailNotifications: false })).data.user.emailNotifications, false);
      assert.equal(await srv.app.locals.runEmailDigest(later()), 0);
      await carol.call('PATCH', '/me', { emailNotifications: true });
      assert.equal(await srv.app.locals.runEmailDigest(later()), 1);
      assert.equal(sent.length, 1);
    });
  });
});

describe('invitation sans envoi', () => {
  test('« juste créer un lien » réserve l’invitation sans envoyer d’email', async () => {
    sent.length = 0;
    const res = await admin.call('POST', '/invites', { email: 'dan@pme.fr', send: false });
    assert.equal(res.data.emailed, false);
    assert.equal(res.data.email, 'dan@pme.fr');
    assert.equal(sent.length, 0);
  });
});

describe('résumé email : mentions dans les pages', () => {
  test('une mention de page non lue part dans le résumé, avec le lien de la page', async () => {
    const carol = client();
    await carol.call('POST', '/auth/login', { email: 'carol@pme.fr', password: 'nouveau-mdp-carol' });
    await carol.call('POST', '/notifications/read', {});
    srv.db.prepare('UPDATE users SET last_digest_at = NULL').run();
    const page = (await admin.call('POST', '/pages', { title: 'Procédure achats', access: 'edit' })).data.page;
    await admin.call('PATCH', `/pages/${page.id}`, { content: 'Validation par @Carol Petit', version: page.version });
    sent.length = 0;
    assert.equal(await srv.app.locals.runEmailDigest(Date.now() + 16 * 60 * 1000), 1);
    assert.match(sent[0].text, /Alice Martin vous a mentionné dans la page « Procédure achats » : « Validation par @Carol Petit »/);
    assert.ok(sent[0].text.includes(`${PUBLIC_URL}/#/p/${page.id}`));
  });
});
