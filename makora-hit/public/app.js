import { renderMarkdown } from './markdown.js';

// --- Outils -------------------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'value') el.value = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// Pour replaceChildren, qui afficherait « null » ou « false » en texte : on retire ces valeurs.
const nodes = (...items) => items.flat().filter((item) => item != null && item !== false);

async function api(method, path, body) {
  const headers = { 'X-Makora': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return parseResponse(await fetch(`/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function uploadFile(channelId, file) {
  return parseResponse(await fetch(`/api/channels/${channelId}/attachments`, {
    method: 'POST',
    headers: {
      'X-Makora': '1',
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
      'X-File-Type': file.type || 'application/octet-stream',
    },
    body: file,
  }));
}

async function parseResponse(res) {
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error ?? `Erreur ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, kind = 'error') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}

const report = (err) => toast(err.message ?? String(err));

const storage = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
  },
};

const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} Mo`;
}

function relativeTime(ts) {
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  if (new Date(ts).toDateString() === new Date().toDateString()) return `aujourd’hui à ${timeFmt.format(ts)}`;
  return dateTimeFmt.format(ts);
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Aujourd’hui';
  if (d.toDateString() === yesterday.toDateString()) return 'Hier';
  return dayFmt.format(d);
}

// --- État ---------------------------------------------------------------------

const state = {
  me: null,
  limits: { maxUploadBytes: 20 * 1024 * 1024, maxAttachments: 10 },
  features: { email: false, sso: null },
  users: new Map(),
  online: new Set(),
  channels: new Map(),
  pages: new Map(),
  view: null,
  expanded: new Set(storage.get('makora.expanded', [])),
  notifications: [],
  notifUnread: 0,
};

const userName = (id) => state.users.get(id)?.name ?? 'Utilisateur supprimé';
const activeColleagues = () => [...state.users.values()].filter((u) => u.id !== state.me.id && u.active !== false);
const channelTitle = (c) => (c.isDm ? userName(c.dmUserId) : `${c.isPrivate ? '🔒' : '#'} ${c.name}`);
const channelRef = (c) => (c.isPrivate ? `🔒${c.name}` : `#${c.name}`);
// Réglage effectif : 'all', 'mentions' ou 'none' (muet).
const notifyLevel = (c) => c.notify ?? (c.isDm ? 'all' : 'mentions');
const isMuted = (c) => notifyLevel(c) === 'none';
const pageTitle = (p) => p?.title?.trim() || 'Sans titre';
const EVERYONE = 'tous';

// Rendu Markdown des messages, avec mise en évidence des @mentions connues.
const md = (text) => renderMarkdown(text, {
  mentions: [...[...state.users.values()].map((u) => u.name), EVERYONE],
  me: state.me.name,
});

function avatar(userId, size = '') {
  const name = userName(userId);
  const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const el = h('span', { class: `avatar ${size}`, 'aria-hidden': 'true' }, initials || '?');
  el.style.setProperty('--hue', String(((userId ?? 0) * 67) % 360));
  return el;
}

function presenceDot(userId) {
  return h('span', { class: `dot${state.online.has(userId) ? ' on' : ''}`, title: state.online.has(userId) ? 'En ligne' : 'Hors ligne' });
}

// --- Démarrage et authentification --------------------------------------------

const root = document.getElementById('app');

async function boot() {
  try {
    await startApp();
  } catch (err) {
    if (err.status === 401) {
      await showAuth();
    } else if (!err.status) {
      // Pas de réseau : l'interface vient du cache, on réessaie dès que la connexion revient.
      root.replaceChildren(h('div', { class: 'splash' }, h('div', { class: 'center' },
        h('p', {}, h('strong', {}, 'Vous êtes hors ligne.')),
        h('p', { class: 'muted' }, 'MAKORA HIT se reconnectera automatiquement dès le retour du réseau.'))));
      window.addEventListener('online', boot, { once: true });
      setTimeout(boot, 10_000);
    } else {
      root.replaceChildren(h('div', { class: 'splash' }, `Impossible de charger l’application : ${err.message}`));
    }
  }
}

// Un lien d'invitation ou de réinitialisation ouvert dans un onglet resté sur l'écran de connexion.
window.addEventListener('hashchange', () => {
  if (!state.started && /^#\/(invite|reset|login-error)\//.test(location.hash)) showAuth().catch(report);
});

const SSO_ERRORS = {
  cancelled: 'Connexion annulée.',
  expired: 'La connexion a expiré ou a été ouverte dans un autre navigateur. Réessayez.',
  provider: 'Le fournisseur d’identité n’a pas pu confirmer votre connexion. Réessayez, ou contactez votre administrateur.',
  email: 'Votre fournisseur d’identité n’a pas confirmé votre adresse email.',
  not_allowed: 'Votre adresse ne fait pas partie des domaines autorisés. Demandez une invitation à votre administrateur.',
  deactivated: 'Ce compte a été désactivé. Contactez votre administrateur.',
  setup: 'L’espace n’est pas encore créé : l’administrateur doit d’abord créer son compte avec un mot de passe.',
};

async function showAuth(forcedMode) {
  const setup = await api('GET', '/setup');
  const invite = location.hash.match(/^#\/invite\/([a-f0-9]+)$/)?.[1];
  const resetToken = location.hash.match(/^#\/reset\/([a-f0-9]+)$/)?.[1];
  const ssoError = location.hash.match(/^#\/login-error\/(\w+)$/)?.[1];
  let mode = forcedMode ?? 'login';
  let notice = ssoError ? SSO_ERRORS[ssoError] ?? SSO_ERRORS.provider : '';
  let resetName = '';
  let inviteEmail = null;
  if (setup.needsSetup) mode = 'setup';
  else if (resetToken) {
    const { valid, name } = await api('GET', `/reset/${resetToken}`);
    if (valid) { mode = 'reset'; resetName = name; }
    else notice = 'Ce lien de réinitialisation est invalide, déjà utilisé ou expiré. Demandez-en un nouveau.';
  } else if (invite) {
    const { valid, email } = await api('GET', `/invites/${invite}`);
    if (valid) { mode = 'register'; inviteEmail = email; }
    else notice = 'Ce lien d’invitation est invalide ou a expiré. Demandez-en un nouveau à votre administrateur.';
  }

  const titles = {
    setup: ['Créer votre espace', 'Vous serez l’administrateur de l’espace MAKORA HIT de votre entreprise.'],
    register: ['Rejoindre l’équipe', 'Vous avez été invité·e. Créez votre compte pour commencer.'],
    login: ['Connexion', 'Retrouvez les discussions et documents de votre équipe.'],
    reset: ['Nouveau mot de passe', `Bonjour ${resetName}, choisissez votre nouveau mot de passe.`],
    forgot: ['Mot de passe oublié', 'Indiquez votre adresse : vous recevrez un lien pour choisir un nouveau mot de passe.'],
  };
  const [title, subtitle] = titles[mode];
  const error = h('p', { class: 'form-error', role: 'alert' });
  const field = (label, name, type, extra = {}) => h('label', { class: 'field' },
    h('span', {}, label), h('input', { name, type, required: true, ...extra }));
  const link = (label, onclick) => h('button', { type: 'button', class: 'link', onclick }, label);
  const ssoButton = setup.sso && (mode === 'login' || mode === 'register') && h('div', { class: 'stack tight' },
    h('a', { class: 'btn block sso', href: '/api/auth/sso' }, `Se connecter avec ${setup.sso.label}`),
    h('div', { class: 'or' }, h('span', {}, 'ou')));

  const form = h('form', { class: 'auth-card' },
    h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'MAKORA HIT'),
    h('h1', {}, title),
    h('p', { class: 'muted' }, subtitle),
    notice && h('p', { class: 'notice' }, notice),
    ssoButton,
    (mode === 'setup' || mode === 'register') && field('Nom complet', 'name', 'text', { autocomplete: 'name', maxlength: 80 }),
    mode !== 'reset' && field('Email professionnel', 'email', 'email', {
      autocomplete: 'email', value: inviteEmail ?? undefined, readonly: Boolean(inviteEmail),
    }),
    mode !== 'forgot' && field(mode === 'reset' ? 'Nouveau mot de passe (8 caractères minimum)' : 'Mot de passe', 'password', 'password', {
      autocomplete: mode === 'login' ? 'current-password' : 'new-password',
      minlength: mode === 'login' ? undefined : 8,
    }),
    error,
    h('button', { class: 'btn primary block', type: 'submit' },
      { login: 'Se connecter', reset: 'Enregistrer et me connecter', forgot: 'Recevoir le lien' }[mode] ?? 'Créer mon compte'),
    mode === 'login' && (setup.email
      ? h('p', { class: 'small' }, link('Mot de passe oublié ?', () => showAuth('forgot')))
      : h('p', { class: 'muted small' }, 'Mot de passe oublié ? Votre administrateur peut vous envoyer un lien de réinitialisation.')),
    mode === 'login' && h('p', { class: 'muted small' }, 'Pas de compte ? Demandez une invitation à votre administrateur.'),
    mode === 'forgot' && h('p', { class: 'small' }, link('← Retour à la connexion', () => showAuth('login'))),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    error.textContent = '';
    try {
      if (mode === 'forgot') {
        await api('POST', '/auth/forgot', { email: data.email });
        form.replaceChildren(form.firstChild, h('h1', {}, 'Vérifiez vos emails'),
          h('p', {}, 'Si un compte existe pour ', h('strong', {}, data.email), ', un lien pour choisir un nouveau mot de passe vient d’être envoyé. Il est valable 24 heures.'),
          h('p', { class: 'small' }, link('← Retour à la connexion', () => showAuth('login'))));
        return;
      }
      const path = { login: '/auth/login', reset: '/auth/reset' }[mode] ?? '/auth/register';
      await api('POST', path, { ...data, invite, token: resetToken });
      history.replaceState(null, '', location.pathname);
      await startApp();
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  });

  if (ssoError) history.replaceState(null, '', location.pathname);
  root.replaceChildren(h('div', { class: 'auth' }, form));
  form.querySelector('input:not([readonly])')?.focus();
}

async function startApp() {
  if (state.started) return;
  // La session d'abord : sans elle, inutile de lancer les autres requêtes.
  const me = await api('GET', '/me');
  const [{ users, online }, { channels }, { pages }, activity] = await Promise.all([
    api('GET', '/users'), api('GET', '/channels'), api('GET', '/pages'), api('GET', '/notifications'),
  ]);
  Object.assign(state, { me: me.user, limits: me.limits, features: me.features });
  state.users = new Map(users.map((u) => [u.id, u]));
  state.online = new Set(online);
  state.channels = new Map(channels.map((c) => [c.id, c]));
  state.pages = new Map(pages.map((p) => [p.id, p]));
  state.notifications = activity.notifications;
  state.notifUnread = activity.unread;
  if (state.started) return;
  state.started = true;
  renderShell();
  connect();
  syncPush();
  window.addEventListener('hashchange', route);
  route();
}

async function logout() {
  // Cet appareil ne doit plus recevoir les notifications de ce compte.
  await disablePush().catch(() => {});
  await api('POST', '/auth/logout').catch(() => {});
  location.reload();
}

// --- Temps réel ----------------------------------------------------------------

let socket = null;
let retry = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.addEventListener('open', () => {
    sendVisibility();
    if (retry > 0) resync();
    retry = 0;
    document.body.classList.remove('offline');
  });
  socket.addEventListener('message', (e) => {
    try { onEvent(JSON.parse(e.data)); } catch (err) { console.error(err); }
  });
  socket.addEventListener('close', (e) => {
    // 4001 : session fermée par le serveur (compte désactivé, mot de passe réinitialisé).
    if (e.code === 4001) {
      location.reload();
      return;
    }
    document.body.classList.add('offline');
    const delay = Math.min(30_000, 1000 * 2 ** retry++);
    setTimeout(connect, delay);
  });
}

// Après une coupure, on recharge ce qui a pu changer pendant qu'on était hors ligne.
async function resync() {
  try {
    const [{ users }, { channels }, { pages }, activity] = await Promise.all([
      api('GET', '/users'), api('GET', '/channels'), api('GET', '/pages'), api('GET', '/notifications'),
    ]);
    state.users = new Map(users.map((u) => [u.id, u]));
    state.channels = new Map(channels.map((c) => [c.id, c]));
    state.pages = new Map(pages.map((p) => [p.id, p]));
    state.notifications = activity.notifications;
    state.notifUnread = activity.unread;
    renderSidebar();
    const v = state.view;
    if (v?.kind === 'channel') reloadMessages(v);
    if (v?.kind === 'activity') renderActivity(v);
  } catch (err) {
    if (err.status === 401) location.reload();
  }
}

function onEvent(ev) {
  const v = state.view;
  switch (ev.type) {
    case 'presence':
      state.online = new Set(ev.online);
      renderSidebar();
      if (v?.kind === 'channel') renderChannelHeader(v);
      break;
    case 'user:updated': {
      state.users.set(ev.user.id, ev.user);
      if (ev.user.id === state.me.id) {
        const roleChanged = ev.user.role !== state.me.role;
        Object.assign(state.me, { name: ev.user.name, role: ev.user.role });
        renderMe();
        if (roleChanged) {
          toast(ev.user.role === 'admin' ? 'Vous êtes maintenant administrateur.' : 'Vous n’êtes plus administrateur.', 'info');
          if (v?.kind === 'admin' && ev.user.role !== 'admin') location.hash = '';
        }
      }
      renderSidebar();
      if (v?.kind === 'admin') loadAdmin(v);
      else if (v?.kind === 'channel') rerender(v);
      break;
    }
    case 'user:new':
      state.users.set(ev.user.id, ev.user);
      break;
    case 'channel:new':
      if (!state.channels.has(ev.channel.id)) state.channels.set(ev.channel.id, ev.channel);
      renderSidebar();
      break;
    case 'channel:joined': {
      const known = state.channels.get(ev.channel.id);
      state.channels.set(ev.channel.id, { ...known, ...ev.channel, joined: true, unread: known?.unread ?? 0 });
      if (!known?.joined && !ev.channel.isDm) toast(`Vous avez été ajouté·e à ${channelRef(ev.channel)}.`, 'info');
      renderSidebar();
      break;
    }
    case 'channel:removed': {
      const c = state.channels.get(ev.channelId);
      if (!c) break;
      if (ev.isPrivate) state.channels.delete(ev.channelId);
      else Object.assign(c, { joined: false, unread: 0 });
      renderSidebar();
      if (ev.isPrivate && v?.kind === 'channel' && v.id === ev.channelId) {
        toast(`Vous ne faites plus partie de ${channelRef(c)}.`, 'info');
        location.hash = '';
      } else if (v?.kind === 'channel' && v.id === ev.channelId) {
        renderChannelHeader(v);
      }
      break;
    }
    case 'channel:members': {
      const c = state.channels.get(ev.channelId);
      if (c) c.memberCount = ev.memberCount;
      if (v?.kind === 'channel' && v.id === ev.channelId) renderChannelHeader(v);
      break;
    }
    case 'message:new': {
      const m = ev.message;
      const channel = state.channels.get(m.channelId);
      if (!channel) {
        resync();
        break;
      }
      if (notifyLevel(channel) === 'all' && channel.joined && !m.parentId && m.userId !== state.me.id) {
        desktopNotify(channel.isDm ? userName(m.userId) : `${userName(m.userId)} dans ${channelRef(channel)}`,
          m.body || '📎 Pièce jointe', `#/c/${m.channelId}`);
      }
      if (m.parentId) {
        if (v?.kind === 'channel' && v.id === m.channelId) addReply(v, m);
      } else if (v?.kind === 'channel' && v.id === m.channelId) {
        if (!v.messages.some((x) => x.id === m.id)) v.messages.push(m);
        renderMessages(v);
        if (document.visibilityState === 'visible') markRead(v);
      } else if (channel.joined && m.userId !== state.me.id) {
        channel.unread += 1;
        renderSidebar();
      }
      break;
    }
    case 'message:updated':
    case 'message:deleted':
      if (v?.kind === 'channel' && v.id === (ev.message?.channelId ?? ev.channelId)) {
        if (ev.type === 'message:deleted') removeMessage(v, ev.messageId, ev.parentId);
        else replaceMessage(v, ev.message);
      }
      if (ev.type === 'message:deleted') forgetNotifications(ev.messageId);
      break;
    case 'message:reactions':
      if (v?.kind === 'channel' && v.id === ev.channelId) applyReactions(v, ev.messageId, ev.reactions);
      break;
    case 'notification:new':
      onNotification(ev.notification);
      break;
    case 'page:changed':
      state.pages.set(ev.page.id, ev.page);
      renderSidebar();
      if (v?.kind === 'page' && v.id === ev.page.id && ev.by !== state.me.id) onRemotePageChange(v, ev);
      break;
    case 'page:files':
      if (v?.kind === 'page' && v.id === ev.pageId) loadPageFiles(v);
      break;
    case 'page:deleted': {
      const removed = new Set([ev.pageId, ...descendants(ev.pageId)]);
      for (const id of removed) state.pages.delete(id);
      renderSidebar();
      if (v?.kind === 'page' && removed.has(v.id)) {
        toast('Cette page vient d’être supprimée.', 'info');
        location.hash = '';
      }
      break;
    }
    default:
      break;
  }
}

function sendVisibility() {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'visibility', visible: document.visibilityState === 'visible' }));
  }
}

document.addEventListener('visibilitychange', () => {
  sendVisibility();
  if (document.visibilityState === 'visible' && state.view?.kind === 'channel') markRead(state.view);
});

// --- Structure générale ------------------------------------------------------------

let els = {};

function renderShell() {
  els = {
    channels: h('ul', { class: 'nav-list' }),
    dms: h('ul', { class: 'nav-list' }),
    pages: h('ul', { class: 'nav-list tree' }),
    main: h('main', { class: 'main' }),
  };
  const search = h('input', { type: 'search', placeholder: 'Rechercher…', 'aria-label': 'Rechercher', name: 'q' });
  const section = (title, list, onAdd, addLabel) => h('section', { class: 'nav-section' },
    h('div', { class: 'nav-title' }, h('span', {}, title),
      h('button', { class: 'icon-btn', title: addLabel, 'aria-label': addLabel, onclick: onAdd }, '+')),
    list);

  const me = state.me;
  els.shell = h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'MAKORA HIT'),
      h('form', {
        class: 'search',
        onsubmit: (e) => {
          e.preventDefault();
          if (search.value.trim()) location.hash = `#/search/${encodeURIComponent(search.value.trim())}`;
        },
      }, search),
      h('nav', { class: 'nav' },
        els.activity = h('div', { class: 'nav-top' }),
        section('Canaux', els.channels, openChannelDialog, 'Créer ou rejoindre un canal'),
        section('Messages privés', els.dms, openDmDialog, 'Nouveau message privé'),
        section('Pages', els.pages, () => createPage(null), 'Nouvelle page')),
      els.me = h('button', { class: 'me', onclick: openAccountDialog, title: 'Mon compte' })),
    h('div', { class: 'backdrop', onclick: closeNav }),
    els.main,
  );
  root.replaceChildren(els.shell);
  renderMe();
  renderSidebar();
}

function renderMe() {
  const me = state.me;
  els.me.replaceChildren(
    avatar(me.id),
    h('span', { class: 'me-info' }, h('strong', {}, me.name), h('span', { class: 'muted small' }, me.role === 'admin' ? 'Administrateur' : 'Membre')),
    h('span', { class: 'me-gear', 'aria-hidden': 'true' }, '⚙'));
}

const toggleNav = () => els.shell.classList.toggle('nav-open');
const closeNav = () => els.shell.classList.remove('nav-open');

function navButton() {
  return h('button', { class: 'icon-btn nav-toggle', 'aria-label': 'Menu', onclick: toggleNav }, '☰');
}

function renderSidebar() {
  if (!els.channels) return;
  const v = state.view;
  const active = (kind, id) => v?.kind === kind && v.id === id;
  const all = [...state.channels.values()];

  // Un canal muet reste accessible mais n'affiche plus de compteur.
  const channelItem = (c, label) => h('li', {},
    h('a', {
      href: `#/c/${c.id}`,
      class: `nav-item${active('channel', c.id) ? ' active' : ''}${c.unread && !isMuted(c) ? ' unread' : ''}${isMuted(c) ? ' muted-channel' : ''}`,
    },
    label,
    isMuted(c) && h('span', { class: 'muted-icon', title: 'Notifications désactivées' }, '🔕'),
    c.unread > 0 && !isMuted(c) && h('span', { class: 'badge' }, c.unread > 99 ? '99+' : c.unread)));

  els.channels.replaceChildren(...all.filter((c) => !c.isDm && c.joined)
    .map((c) => channelItem(c, h('span', { class: 'label' }, h('span', { class: 'hash' }, c.isPrivate ? '🔒' : '#'), c.name))));

  els.dms.replaceChildren(...all.filter((c) => c.isDm)
    .sort((a, b) => userName(a.dmUserId).localeCompare(userName(b.dmUserId)))
    .map((c) => channelItem(c, h('span', { class: 'label' }, presenceDot(c.dmUserId), userName(c.dmUserId),
      state.users.get(c.dmUserId)?.active === false && h('span', { class: 'muted small' }, ' (désactivé)')))));
  if (!els.dms.children.length) els.dms.append(h('li', { class: 'muted small empty' }, 'Aucune conversation'));

  const children = groupPages();
  const branch = (parentId, depth) => (children.get(parentId) ?? []).map((p) => {
    const kids = children.get(p.id) ?? [];
    const open = state.expanded.has(p.id);
    const item = h('li', {},
      h('div', { class: `nav-item page-item${active('page', p.id) ? ' active' : ''}` },
        h('button', {
          class: `caret${kids.length ? '' : ' hidden'}${open ? ' open' : ''}`,
          'aria-label': open ? 'Replier' : 'Déplier',
          onclick: () => toggleExpanded(p.id),
        }, '▸'),
        h('a', { href: `#/p/${p.id}`, class: 'label' }, pageTitle(p)),
        h('button', { class: 'icon-btn add-sub', title: 'Ajouter une sous-page', 'aria-label': 'Ajouter une sous-page', onclick: () => createPage(p.id) }, '+')));
    item.firstChild.style.paddingLeft = `${4 + depth * 14}px`;
    if (open && kids.length) item.append(h('ul', { class: 'nav-list' }, branch(p.id, depth + 1)));
    return item;
  });
  els.pages.replaceChildren(...branch(null, 0));
  if (!els.pages.children.length) els.pages.append(h('li', { class: 'muted small empty' }, 'Aucune page'));

  els.activity.replaceChildren(...nodes(h('a', { href: '#/activity', class: `nav-item${v?.kind === 'activity' ? ' active' : ''}${state.notifUnread ? ' unread' : ''}` },
    h('span', { class: 'label' }, h('span', { 'aria-hidden': 'true' }, '🔔'), 'Activité'),
    state.notifUnread > 0 && h('span', { class: 'badge' }, state.notifUnread > 99 ? '99+' : state.notifUnread)),
  installPrompt && h('button', { class: 'nav-item install', onclick: () => installButton()?.click() }, h('span', { class: 'label' }, '📲 Installer l’application'))));

  const unread = all.reduce((n, c) => n + (c.joined && !isMuted(c) ? c.unread : 0), 0) + state.notifUnread;
  document.title = `${unread ? `(${unread}) ` : ''}MAKORA HIT`;
}

function groupPages() {
  const children = new Map();
  for (const p of state.pages.values()) {
    const key = p.parentId ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(p);
  }
  return children;
}

function descendants(id) {
  const children = groupPages();
  const out = [];
  const walk = (pid) => (children.get(pid) ?? []).forEach((p) => { out.push(p.id); walk(p.id); });
  walk(id);
  return out;
}

function toggleExpanded(id, force) {
  const open = force ?? !state.expanded.has(id);
  if (open) state.expanded.add(id);
  else state.expanded.delete(id);
  storage.set('makora.expanded', [...state.expanded]);
  renderSidebar();
}

// --- Navigation ------------------------------------------------------------

function route() {
  const prev = state.view;
  if (prev?.kind === 'page' && prev.dirty) savePage(prev);
  closeNav();

  const hash = location.hash;
  let m;
  if ((m = hash.match(/^#\/c\/(\d+)(?:\/t\/(\d+))?$/))) {
    const id = Number(m[1]);
    const threadId = m[2] ? Number(m[2]) : null;
    if (prev?.kind === 'channel' && prev.id === id) showThread(prev, threadId);
    else openChannel(id, threadId);
  }
  else if ((m = hash.match(/^#\/p\/(\d+)$/))) openPage(Number(m[1]));
  else if ((m = hash.match(/^#\/search\/(.+)$/))) openSearch(decodeURIComponent(m[1]));
  else if (hash === '#/activity') openActivity();
  else if (hash === '#/admin' && state.me.role === 'admin') openAdmin();
  else if (hash.startsWith('#/reset/') || hash.startsWith('#/invite/')) {
    toast('Ce lien est destiné à une personne non connectée. Déconnectez-vous pour l’utiliser.', 'info');
    location.replace('#/');
  }
  else {
    const home = [...state.channels.values()].find((c) => c.name === 'general' && c.joined)
      ?? [...state.channels.values()].find((c) => c.joined);
    if (home) location.replace(`#/c/${home.id}`);
    else showEmpty();
  }
}

function showEmpty() {
  state.view = { kind: 'empty' };
  renderSidebar();
  els.main.replaceChildren(h('header', { class: 'main-head' }, navButton()),
    h('div', { class: 'empty-state' }, h('h2', {}, 'Bienvenue 👋'), h('p', { class: 'muted' }, 'Rejoignez un canal ou ouvrez une page pour commencer.')));
}

// --- Canaux ---------------------------------------------------------------

async function openChannel(id, threadId = null) {
  let channel = state.channels.get(id);
  if (!channel) {
    await resync();
    channel = state.channels.get(id);
  }
  if (!channel) {
    toast('Canal introuvable.');
    location.hash = '';
    return;
  }
  const v = {
    kind: 'channel', id, messages: [], hasMore: false, editingId: null, loading: true, thread: null, seen: new Set(),
  };
  state.view = v;
  renderSidebar();

  v.head = h('header', { class: 'main-head' });
  v.list = h('div', { class: 'messages', role: 'log' });
  v.composer = renderComposer(v);
  v.threadEl = h('aside', { class: 'thread', 'aria-label': 'Fil de discussion' });
  v.wrap = h('div', { class: 'channel-wrap' }, h('div', { class: 'channel-col' }, v.list, v.composer), v.threadEl);
  els.main.replaceChildren(v.head, v.wrap);
  renderChannelHeader(v);
  renderMessages(v);
  await reloadMessages(v);
  if (threadId) openThread(v, threadId);
  else v.composer.querySelector('textarea')?.focus();
}

async function reloadMessages(v) {
  try {
    const data = await api('GET', `/channels/${v.id}/messages`);
    if (state.view !== v) return;
    v.messages = data.messages;
    v.hasMore = data.hasMore;
    v.loading = false;
    renderMessages(v);
    markRead(v);
    readNotificationsWhere((n) => n.channelId === v.id && !n.parentId);
    if (v.thread) loadThread(v, v.thread);
  } catch (err) {
    report(err);
  }
}

async function loadOlder(v) {
  const first = v.messages[0];
  if (!first) return;
  try {
    const data = await api('GET', `/channels/${v.id}/messages?before=${first.id}`);
    if (state.view !== v) return;
    const height = v.list.scrollHeight;
    v.messages = [...data.messages, ...v.messages];
    v.hasMore = data.hasMore;
    renderMessages(v, { keepScroll: true });
    v.list.scrollTop += v.list.scrollHeight - height;
  } catch (err) {
    report(err);
  }
}

function markRead(v) {
  const channel = state.channels.get(v.id);
  const last = v.messages.at(-1);
  if (!channel?.joined || !last) return;
  if (channel.unread) {
    channel.unread = 0;
    renderSidebar();
  }
  if (last.id > (v.readUpTo ?? 0)) {
    v.readUpTo = last.id;
    api('POST', `/channels/${v.id}/read`, { messageId: last.id }).catch(() => {});
  }
}

function renderChannelHeader(v) {
  const c = state.channels.get(v.id);
  if (!c) return;
  const actions = [];
  if (c.joined) {
    const icons = { all: '🔔', mentions: '@', none: '🔕' };
    actions.push(h('button', {
      class: 'btn small', title: 'Notifications de ce canal', 'aria-label': 'Notifications de ce canal', onclick: () => openNotifyDialog(c),
    }, icons[notifyLevel(c)]));
  }
  if (!c.isDm) {
    actions.push(h('button', {
      class: 'btn small', title: 'Membres du canal', 'aria-label': `${c.memberCount} membres`, onclick: () => openMembersDialog(c),
    }, `👥 ${c.memberCount ?? ''}`));
    actions.push(c.joined
      ? h('button', { class: 'btn small', onclick: () => leaveChannel(c) }, 'Quitter')
      : h('button', { class: 'btn small primary', onclick: () => joinChannel(c) }, 'Rejoindre'));
  }
  v.head.replaceChildren(
    navButton(),
    h('div', { class: 'head-title' },
      h('h1', {}, c.isDm ? [presenceDot(c.dmUserId), ' ', userName(c.dmUserId)] : channelTitle(c)),
      h('span', { class: 'muted small' }, c.isDm ? (state.online.has(c.dmUserId) ? 'En ligne' : 'Hors ligne') : c.topic)),
    h('div', { class: 'head-actions' }, actions));
}

async function joinChannel(c) {
  try {
    await api('POST', `/channels/${c.id}/join`);
    c.joined = true;
    c.unread = 0;
    renderSidebar();
    if (state.view?.id === c.id) renderChannelHeader(state.view);
  } catch (err) { report(err); }
}

async function leaveChannel(c) {
  if (c.isPrivate && !confirm(`Quitter ${channelRef(c)} ? Il faudra qu’un membre vous rajoute pour y revenir.`)) return;
  try {
    await api('POST', `/channels/${c.id}/leave`);
    if (c.isPrivate) state.channels.delete(c.id);
    else Object.assign(c, { joined: false, unread: 0 });
    location.hash = '';
  } catch (err) { report(err); }
}

// --- Mise à jour des messages affichés (canal + fil ouvert) ---------------------

function rerender(v) {
  renderMessages(v, { keepScroll: true });
  if (v.thread?.replies) renderThread(v, { keepScroll: true });
}

function addReply(v, m) {
  if (v.seen.has(m.id)) return;
  v.seen.add(m.id);
  const root = v.messages.find((x) => x.id === m.parentId);
  if (root) {
    root.replyCount += 1;
    root.lastReplyAt = m.createdAt;
    renderMessages(v, { keepScroll: true });
  }
  const t = v.thread;
  if (t?.rootId !== m.parentId) return;
  if (t.replies) {
    t.replies.push(m);
    t.root.replyCount += 1;
    renderThread(v);
  } else {
    // Le fil est encore en cours de chargement : on garde la réponse pour ne pas la perdre.
    t.early.push(m);
  }
}

function replaceMessage(v, message) {
  const swap = (m) => (m.id === message.id ? { ...message, replyCount: m.replyCount, lastReplyAt: m.lastReplyAt } : m);
  v.messages = v.messages.map(swap);
  const t = v.thread;
  if (t?.replies) {
    t.root = swap(t.root);
    t.replies = t.replies.map(swap);
  }
  rerender(v);
}

function removeMessage(v, id, parentId) {
  v.messages = v.messages.filter((m) => m.id !== id);
  if (parentId) {
    const root = v.messages.find((m) => m.id === parentId);
    if (root) root.replyCount = Math.max(0, root.replyCount - 1);
  }
  const t = v.thread;
  if (t?.rootId === id) {
    toast('Le message d’origine de ce fil a été supprimé.', 'info');
    location.hash = `#/c/${v.id}`;
  } else if (t?.replies && parentId === t.rootId) {
    t.replies = t.replies.filter((m) => m.id !== id);
    t.root.replyCount = Math.max(0, t.root.replyCount - 1);
  }
  rerender(v);
}

// --- Liste des messages ---------------------------------------------------

function messageNodes(v, messages, { inThread = false } = {}) {
  const nodes = [];
  let prev = null;
  for (const m of messages) {
    if (!inThread && (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString())) {
      nodes.push(h('div', { class: 'day' }, h('span', {}, dayLabel(m.createdAt))));
      prev = null;
    }
    const grouped = prev && prev.userId === m.userId && m.createdAt - prev.createdAt < 5 * 60_000 && !prev.replyCount;
    nodes.push(renderMessage(v, m, { grouped, inThread }));
    prev = m;
  }
  return nodes;
}

function renderMessages(v, { keepScroll = false } = {}) {
  const list = v.list;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const nodes = [];
  if (v.loading) nodes.push(h('p', { class: 'muted center' }, 'Chargement…'));
  if (v.hasMore) nodes.push(h('button', { class: 'btn small load-more', onclick: () => loadOlder(v) }, 'Charger les messages précédents'));
  if (!v.loading && !v.messages.length) {
    const c = state.channels.get(v.id);
    nodes.push(h('div', { class: 'empty-state' },
      h('h2', {}, c.isDm ? `Votre conversation avec ${userName(c.dmUserId)}` : `Bienvenue dans ${channelRef(c)}`),
      h('p', { class: 'muted' }, 'Aucun message pour l’instant. Lancez la discussion !')));
  }
  nodes.push(...messageNodes(v, v.messages));
  list.replaceChildren(...nodes);
  if (!keepScroll && (atBottom || !v.scrolled)) {
    list.scrollTop = list.scrollHeight;
    v.scrolled = v.messages.length > 0;
  }
}

const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function fileIcon(a) {
  if (a.mime.startsWith('image/')) return '🖼';
  if (a.mime === 'application/pdf') return '📕';
  if (/sheet|excel|csv/.test(a.mime)) return '📊';
  if (/word|document|text/.test(a.mime)) return '📝';
  if (/zip|compressed|tar/.test(a.mime)) return '🗜';
  return '📎';
}

function renderAttachments(list) {
  if (!list?.length) return null;
  return h('div', { class: 'attachments' }, list.map((a) => {
    const url = `/api/attachments/${a.id}`;
    return INLINE_IMAGES.has(a.mime)
      ? h('a', { class: 'att-image', href: url, target: '_blank', rel: 'noopener', title: a.name },
        h('img', { src: url, alt: a.name, loading: 'lazy' }))
      : h('a', { class: 'att-file', href: url, download: a.name, title: `Télécharger ${a.name}` },
        h('span', { class: 'att-icon', 'aria-hidden': 'true' }, fileIcon(a)),
        h('span', { class: 'att-info' }, h('strong', {}, a.name), h('span', { class: 'muted small' }, formatSize(a.size))));
  }));
}

function renderMessage(v, m, { grouped = false, inThread = false } = {}) {
  const mine = m.userId === state.me.id;
  const canDelete = mine || state.me.role === 'admin';
  const canReply = !inThread && !m.parentId;
  const editing = v.editingId === m.id;
  let body;
  if (editing) {
    const input = h('textarea', { class: 'edit-input', value: m.body, rows: 2 });
    const save = async () => {
      const text = input.value.trim();
      if (!text && !m.attachments.length) return;
      try {
        await api('PATCH', `/messages/${m.id}`, { body: text });
        v.editingId = null;
        rerender(v);
      } catch (err) { report(err); }
    };
    const cancel = () => { v.editingId = null; rerender(v); };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      if (e.key === 'Escape') cancel();
    });
    body = h('div', { class: 'edit' }, input,
      h('div', { class: 'edit-actions' },
        h('button', { class: 'btn small', onclick: cancel }, 'Annuler'),
        h('button', { class: 'btn small primary', onclick: save }, 'Enregistrer')));
    queueMicrotask(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  } else if (m.body) {
    body = h('div', { class: 'md', html: md(m.body) });
  }

  const openIt = () => { location.hash = `#/c/${v.id}/t/${m.id}`; };
  const replies = !inThread && m.replyCount > 0 && h('button', { class: 'thread-link', onclick: openIt },
    h('strong', {}, `${m.replyCount} réponse${m.replyCount > 1 ? 's' : ''}`),
    m.lastReplyAt && h('span', { class: 'muted' }, ` · dernière ${relativeTime(m.lastReplyAt)}`));

  const pick = (e) => openEmojiPicker(e.currentTarget, (emoji) => toggleReaction(m, emoji));
  const reactions = !editing && m.reactions?.length > 0 && h('div', { class: 'reactions' },
    m.reactions.map((r) => {
      const reacted = r.userIds.includes(state.me.id);
      return h('button', {
        class: `reaction${reacted ? ' mine' : ''}`,
        title: `${r.userIds.map(userName).join(', ')} : ${r.emoji}`,
        'aria-pressed': reacted ? 'true' : 'false',
        onclick: () => toggleReaction(m, r.emoji),
      }, h('span', { class: 'reaction-emoji' }, r.emoji), h('span', {}, r.userIds.length));
    }),
    h('button', { class: 'reaction add', title: 'Ajouter une réaction', 'aria-label': 'Ajouter une réaction', onclick: pick }, '+'));

  const actions = !editing && [
    h('button', { class: 'icon-btn', title: 'Réagir', 'aria-label': 'Réagir', onclick: pick }, '😊'),
    canReply && h('button', { class: 'icon-btn', title: 'Répondre dans un fil', 'aria-label': 'Répondre dans un fil', onclick: openIt }, '💬'),
    mine && h('button', { class: 'icon-btn', title: 'Modifier', 'aria-label': 'Modifier', onclick: () => { v.editingId = m.id; rerender(v); } }, '✎'),
    canDelete && h('button', { class: 'icon-btn', title: 'Supprimer', 'aria-label': 'Supprimer', onclick: () => deleteMessage(m) }, '🗑'),
  ].filter(Boolean);

  return h('article', { class: `message${grouped ? ' grouped' : ''}${v.thread?.rootId === m.id && !inThread ? ' highlighted' : ''}` },
    grouped ? h('span', { class: 'gutter-time muted' }, timeFmt.format(m.createdAt)) : avatar(m.userId),
    h('div', { class: 'message-body' },
      !grouped && h('div', { class: 'message-meta' },
        h('strong', {}, userName(m.userId)),
        h('time', { class: 'muted small', datetime: new Date(m.createdAt).toISOString(), title: dateTimeFmt.format(m.createdAt) }, timeFmt.format(m.createdAt))),
      body,
      !editing && renderAttachments(m.attachments),
      m.editedAt && !editing && h('span', { class: 'muted small' }, '(modifié)'),
      reactions,
      replies),
    actions?.length > 0 && h('div', { class: 'message-actions' }, actions));
}

async function deleteMessage(m) {
  const extra = m.replyCount ? ` Ses ${m.replyCount} réponse${m.replyCount > 1 ? 's' : ''} seront aussi supprimées.` : '';
  if (!confirm(`Supprimer ce message ?${extra}`)) return;
  try { await api('DELETE', `/messages/${m.id}`); } catch (err) { report(err); }
}

// --- Fils de discussion ------------------------------------------------------

function showThread(v, threadId) {
  if (!threadId) closeThread(v);
  else if (v.thread?.rootId !== threadId) openThread(v, threadId);
}

function openThread(v, rootId) {
  const t = { rootId, root: null, replies: null, early: [] };
  v.thread = t;
  t.list = h('div', { class: 'thread-list' }, h('p', { class: 'muted center' }, 'Chargement…'));
  t.composer = renderComposer(v, { parentId: rootId });
  const c = state.channels.get(v.id);
  v.threadEl.replaceChildren(
    h('header', { class: 'thread-head' },
      h('div', {}, h('h2', {}, 'Fil de discussion'), h('span', { class: 'muted small' }, channelTitle(c))),
      h('button', { class: 'icon-btn', 'aria-label': 'Fermer le fil', title: 'Fermer', onclick: () => { location.hash = `#/c/${v.id}`; } }, '×')),
    t.list,
    t.composer);
  v.wrap.classList.add('with-thread');
  renderMessages(v, { keepScroll: true });
  loadThread(v, t);
}

async function loadThread(v, t) {
  try {
    const { message, replies } = await api('GET', `/messages/${t.rootId}/replies`);
    if (v.thread !== t) return;
    const missing = t.early.filter((m) => !replies.some((r) => r.id === m.id));
    t.root = { ...message, replyCount: message.replyCount + missing.length };
    t.replies = [...replies, ...missing].sort((x, y) => x.id - y.id);
    for (const r of replies) v.seen.add(r.id);
    renderThread(v);
    readNotificationsWhere((n) => n.parentId === t.rootId || n.messageId === t.rootId);
    t.composer.querySelector('textarea')?.focus();
  } catch (err) {
    if (v.thread !== t) return;
    report(err);
    location.hash = `#/c/${v.id}`;
  }
}

function closeThread(v) {
  if (!v.thread) return;
  v.thread = null;
  v.wrap.classList.remove('with-thread');
  v.threadEl.replaceChildren();
  renderMessages(v, { keepScroll: true });
}

function renderThread(v, { keepScroll = false } = {}) {
  const t = v.thread;
  const list = t.list;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const count = t.replies.length;
  list.replaceChildren(
    renderMessage(v, t.root, { inThread: true }),
    h('div', { class: 'day' }, h('span', {}, count ? `${count} réponse${count > 1 ? 's' : ''}` : 'Aucune réponse')),
    ...messageNodes(v, t.replies, { inThread: true }));
  if (!keepScroll && (atBottom || !t.scrolled)) {
    list.scrollTop = list.scrollHeight;
    t.scrolled = true;
  }
}

// --- Zone de saisie (canal ou fil), avec pièces jointes ------------------------

function renderComposer(v, { parentId = null } = {}) {
  const c = state.channels.get(v.id);
  const pending = []; // { file, id, status: 'uploading' | 'done' | 'error' }
  const chips = h('div', { class: 'chips' });
  const input = h('textarea', {
    rows: 1,
    placeholder: parentId ? 'Répondre dans le fil…' : `Écrire ${c.isDm ? `à ${userName(c.dmUserId)}` : `dans ${channelRef(c)}`}`,
    'aria-label': parentId ? 'Réponse' : 'Message',
  });
  const fileInput = h('input', {
    type: 'file', multiple: true, hidden: true,
    onchange: (e) => { addFiles(e.target.files); e.target.value = ''; },
  });

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  };
  const mentions = mentionPicker(input);

  function renderChips() {
    chips.replaceChildren(...pending.map((item) => h('div', { class: `chip ${item.status}` },
      h('span', { class: 'att-icon', 'aria-hidden': 'true' }, fileIcon({ mime: item.file.type || '' })),
      h('span', { class: 'chip-name' }, item.file.name),
      h('span', { class: 'muted small' }, item.status === 'uploading' ? 'envoi…' : item.status === 'error' ? 'échec' : formatSize(item.file.size)),
      h('button', {
        type: 'button', class: 'icon-btn', 'aria-label': `Retirer ${item.file.name}`,
        onclick: () => { pending.splice(pending.indexOf(item), 1); renderChips(); },
      }, '×'))));
    chips.hidden = pending.length === 0;
  }

  async function addFiles(files) {
    for (const file of files) {
      if (pending.length >= state.limits.maxAttachments) {
        toast(`${state.limits.maxAttachments} fichiers maximum par message.`);
        break;
      }
      if (file.size > state.limits.maxUploadBytes) {
        toast(`« ${file.name} » est trop volumineux (${formatSize(state.limits.maxUploadBytes)} maximum).`);
        continue;
      }
      if (file.size === 0) {
        toast(`« ${file.name} » est vide.`);
        continue;
      }
      const item = { file, status: 'uploading' };
      pending.push(item);
      uploadFile(v.id, file)
        .then(({ attachment }) => { item.id = attachment.id; item.status = 'done'; })
        .catch((err) => { item.status = 'error'; report(err); })
        .finally(renderChips);
    }
    renderChips();
    input.focus();
  }

  const send = async () => {
    const text = input.value.trim();
    if (pending.some((p) => p.status === 'uploading')) {
      toast('Patientez, les fichiers sont en cours d’envoi.', 'info');
      return;
    }
    const files = pending.filter((p) => p.status === 'done');
    if (!text && !files.length) return;
    const sent = pending.splice(0);
    input.value = '';
    autosize();
    renderChips();
    try {
      const { message } = await api('POST', `/channels/${v.id}/messages`, {
        body: text, parentId, attachmentIds: files.map((p) => p.id),
      });
      if (!c.joined) {
        c.joined = true;
        renderSidebar();
        renderChannelHeader(v);
      }
      if (state.view !== v) return;
      if (parentId) {
        addReply(v, message);
        v.thread?.list && (v.thread.list.scrollTop = v.thread.list.scrollHeight);
      } else {
        if (!v.messages.some((x) => x.id === message.id)) {
          v.messages.push(message);
          renderMessages(v);
        }
        v.list.scrollTop = v.list.scrollHeight;
      }
    } catch (err) {
      input.value = text;
      pending.push(...sent);
      autosize();
      renderChips();
      report(err);
    }
  };

  input.addEventListener('input', () => { autosize(); mentions.update(); });
  input.addEventListener('keydown', (e) => {
    if (mentions.handleKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('paste', (e) => {
    if (e.clipboardData?.files.length) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  });

  const form = h('form', { class: `composer${parentId ? ' in-thread' : ''}`, onsubmit: (e) => { e.preventDefault(); send(); } },
    chips,
    mentions.el,
    h('div', { class: 'composer-row' },
      h('button', {
        type: 'button', class: 'icon-btn attach', title: 'Joindre des fichiers', 'aria-label': 'Joindre des fichiers',
        onclick: () => fileInput.click(),
      }, '📎'),
      input,
      h('button', { class: 'btn primary', type: 'submit' }, 'Envoyer')),
    !parentId && h('p', { class: 'muted small hint' }, '**gras**, *italique*, `code`, - liste · Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne · glissez un fichier pour le joindre'),
    fileInput);
  renderChips();

  // Glisser-déposer de fichiers sur la zone de saisie.
  form.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    form.classList.add('dragging');
  });
  form.addEventListener('dragleave', (e) => {
    if (!form.contains(e.relatedTarget)) form.classList.remove('dragging');
  });
  form.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    form.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });
  return form;
}

// --- Fenêtres ----------------------------------------------------------------

function dialog(title, ...content) {
  const dlg = h('dialog', { class: 'dialog' },
    h('div', { class: 'dialog-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => dlg.close() }, '×')),
    ...content);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function openChannelDialog() {
  const error = h('p', { class: 'form-error', role: 'alert' });
  const people = peoplePicker(activeColleagues());
  const form = h('form', { class: 'stack' },
    h('label', { class: 'field' }, h('span', {}, 'Nom du canal'),
      h('input', { name: 'name', required: true, maxlength: 40, placeholder: 'ex. commercial, projet-alpha' })),
    h('label', { class: 'field' }, h('span', {}, 'Sujet (facultatif)'),
      h('input', { name: 'topic', maxlength: 200, placeholder: 'À quoi sert ce canal ?' })),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', name: 'isPrivate' }),
      h('span', {}, h('strong', {}, '🔒 Canal privé'),
        h('span', { class: 'muted small block' }, 'Visible uniquement par ses membres, qui peuvent y ajouter d’autres personnes.'))),
    h('div', { class: 'field' }, h('span', {}, 'Ajouter des personnes (facultatif)'), people.el),
    error,
    h('button', { class: 'btn primary', type: 'submit' }, 'Créer le canal'));

  const others = [...state.channels.values()].filter((c) => !c.isDm && !c.joined);
  const dlg = dialog('Canaux', form,
    others.length > 0 && h('div', { class: 'stack' },
      h('h3', {}, 'Rejoindre un canal existant'),
      h('ul', { class: 'pick-list' }, others.map((c) => h('li', {},
        h('div', {}, h('strong', {}, `# ${c.name}`), c.topic && h('div', { class: 'muted small' }, c.topic)),
        h('button', {
          class: 'btn small',
          onclick: async () => { await joinChannel(c); dlg.close(); location.hash = `#/c/${c.id}`; },
        }, 'Rejoindre'))))));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = new FormData(form);
      const { channel } = await api('POST', '/channels', {
        name: data.get('name'), topic: data.get('topic'), isPrivate: data.get('isPrivate') === 'on', memberIds: people.selected(),
      });
      state.channels.set(channel.id, channel);
      dlg.close();
      location.hash = `#/c/${channel.id}`;
    } catch (err) {
      error.textContent = err.message;
    }
  });
  form.querySelector('input').focus();
}

function openDmDialog() {
  const people = activeColleagues();
  const dlg = dialog('Nouveau message privé',
    people.length
      ? h('ul', { class: 'pick-list' }, people.map((u) => h('li', {},
        h('div', { class: 'person' }, avatar(u.id), h('div', {}, h('strong', {}, presenceDot(u.id), ' ', u.name), h('div', { class: 'muted small' }, u.email))),
        h('button', { class: 'btn small primary', onclick: () => { dlg.close(); openDm(u.id); } }, 'Écrire'))))
      : h('p', { class: 'muted' }, state.me.role === 'admin'
        ? 'Vous êtes seul pour l’instant. Invitez vos collègues avec le bouton « Inviter ».'
        : 'Personne d’autre dans l’espace pour l’instant.'));
  return dlg;
}

async function openDm(userId) {
  try {
    const { channel } = await api('POST', '/dms', { userId });
    if (!state.channels.has(channel.id)) state.channels.set(channel.id, channel);
    location.hash = `#/c/${channel.id}`;
  } catch (err) { report(err); }
}

// Invitation : avec une adresse, le lien est réservé à cette personne (et lui est envoyé si les emails sont configurés).
function createInvite() {
  const error = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'stack' },
    h('label', { class: 'field' },
      h('span', {}, state.features.email ? 'Adresse email de la personne' : 'Adresse email (facultatif)'),
      h('input', { name: 'email', type: 'email', required: state.features.email, placeholder: 'prenom.nom@entreprise.fr', autocomplete: 'off' })),
    h('p', { class: 'muted small' }, state.features.email
      ? 'Elle recevra un email avec un lien pour créer son compte (usage unique, valable 7 jours).'
      : 'Le lien sera réservé à cette adresse. Laissez vide pour un lien utilisable par n’importe qui (une seule fois).'),
    error,
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn primary', type: 'submit' }, state.features.email ? 'Envoyer l’invitation' : 'Créer le lien'),
      state.features.email && h('button', { class: 'btn', type: 'button', onclick: () => submit(true) }, 'Juste créer un lien')));
  const dlg = dialog('Inviter un collègue', form);

  async function submit(linkOnly = false) {
    error.textContent = '';
    const email = new FormData(form).get('email').trim();
    try {
      const res = await api('POST', '/invites', { email: email || undefined, send: !linkOnly });
      dlg.close();
      if (res.emailed) {
        toast(`Invitation envoyée à ${res.email}.`, 'info');
      } else {
        showLink('Lien d’invitation', `${res.email ? `Réservé à ${res.email}. ` : ''}Envoyez ce lien à la personne à inviter. Il ne peut servir qu’une fois et expire le `,
          `${location.origin}/#/invite/${res.token}`, res.expiresAt);
        if (res.email && state.features.email) toast('L’email n’a pas pu être envoyé : transmettez le lien vous-même.');
      }
      if (state.view?.kind === 'admin') loadAdmin(state.view);
    } catch (err) { error.textContent = err.message; }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  form.querySelector('input').focus();
}

function showLink(title, intro, link, expiresAt) {
  const input = h('input', { value: link, readonly: true, class: 'mono', 'aria-label': 'Lien à envoyer' });
  dialog(title,
    h('p', {}, intro, h('strong', {}, dateTimeFmt.format(expiresAt)), '.'),
    h('div', { class: 'row' }, input,
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(link);
            toast('Lien copié.', 'info');
          } catch {
            input.select();
          }
        },
      }, 'Copier')));
  input.select();
}

// --- Pages -----------------------------------------------------------------

async function createPage(parentId) {
  try {
    const { page } = await api('POST', '/pages', { title: '', parentId });
    state.pages.set(page.id, { id: page.id, parentId: page.parentId, title: page.title, updatedAt: page.updatedAt });
    if (parentId) toggleExpanded(parentId, true);
    pendingFocus = page.id;
    location.hash = `#/p/${page.id}`;
  } catch (err) { report(err); }
}

let pendingFocus = null;

async function openPage(id) {
  const v = { kind: 'page', id, page: null, dirty: false, saving: false, conflict: null, timer: null };
  state.view = v;
  renderSidebar();
  els.main.replaceChildren(h('header', { class: 'main-head' }, navButton()), h('p', { class: 'muted center' }, 'Chargement…'));
  try {
    const { page } = await api('GET', `/pages/${id}`);
    if (state.view !== v) return;
    v.page = page;
    v.title = page.title;
    v.content = page.content;
    v.mode = page.content.trim() && pendingFocus !== id ? 'read' : 'edit';
    // Déplie l'arborescence jusqu'à la page ouverte.
    for (let p = state.pages.get(page.parentId); p; p = state.pages.get(p.parentId)) state.expanded.add(p.id);
    renderSidebar();
    renderPage(v);
    if (pendingFocus === id) v.titleInput.focus();
    pendingFocus = null;
  } catch (err) {
    if (state.view !== v) return;
    report(err);
    location.hash = '';
  }
}

function renderPage(v) {
  const page = v.page;
  const crumbs = [];
  for (let p = state.pages.get(page.parentId); p; p = state.pages.get(p.parentId)) {
    crumbs.unshift(h('a', { href: `#/p/${p.id}` }, pageTitle(p)), h('span', { class: 'sep' }, '/'));
  }
  v.status = h('span', { class: 'muted small save-status' });
  const canDelete = page.createdBy === state.me.id || state.me.role === 'admin';

  v.titleInput = h('input', {
    class: 'page-title', value: v.title, placeholder: 'Sans titre', maxlength: 200, 'aria-label': 'Titre de la page',
    oninput: (e) => { v.title = e.target.value; changed(v); },
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        setMode(v, 'edit');
      }
    },
  });

  v.bodyEl = h('div', { class: 'page-body' });
  v.filesEl = h('div', {});
  v.banner = h('div', { class: 'banner', hidden: true });

  els.main.replaceChildren(
    h('header', { class: 'main-head' },
      navButton(),
      h('nav', { class: 'crumbs small' }, crumbs, h('span', {}, pageTitle({ title: v.title }))),
      h('div', { class: 'head-actions' },
        v.status,
        v.modeBtn = h('button', { class: 'btn small', onclick: () => setMode(v, v.mode === 'edit' ? 'read' : 'edit') }),
        h('button', { class: 'btn small', onclick: () => openHistory(v) }, 'Historique'),
        h('button', { class: 'btn small', onclick: () => createPage(page.id) }, '+ Sous-page'),
        canDelete && h('button', { class: 'btn small danger', onclick: () => deletePage(v) }, 'Supprimer'))),
    h('div', { class: 'page-scroll' },
      h('div', { class: 'page' },
        v.banner,
        v.titleInput,
        h('p', { class: 'muted small page-meta' }, `Modifié par ${userName(page.updatedBy)} · ${dateTimeFmt.format(page.updatedAt)}`),
        v.bodyEl,
        v.filesEl,
        renderSubpages(page.id))));
  setMode(v, v.mode);
  updateStatus(v);
}

function renderSubpages(id) {
  const kids = groupPages().get(id) ?? [];
  if (!kids.length) return null;
  return h('div', { class: 'subpages' }, h('h3', { class: 'small muted' }, 'Sous-pages'),
    h('ul', {}, kids.map((p) => h('li', {}, h('a', { href: `#/p/${p.id}` }, '📄 ', pageTitle(p))))));
}

function setMode(v, mode) {
  v.mode = mode;
  v.modeBtn.textContent = mode === 'edit' ? 'Aperçu' : 'Modifier';
  if (mode === 'edit') {
    loadPageFiles(v);
    const area = h('textarea', {
      class: 'page-editor', value: v.content, 'aria-label': 'Contenu de la page',
      placeholder: 'Écrivez ici… (Markdown : # Titre, **gras**, - liste, - [ ] tâche, ``` code ```)',
      oninput: (e) => { v.content = e.target.value; changed(v); autosize(); },
    });
    const autosize = () => {
      area.style.height = 'auto';
      area.style.height = `${Math.max(area.scrollHeight, 300)}px`;
    };
    const picker = h('input', {
      type: 'file', multiple: true, hidden: true,
      onchange: (e) => { addFilesToPage(v, area, [...e.target.files]); e.target.value = ''; },
    });
    area.addEventListener('paste', (e) => {
      if (e.clipboardData?.files.length) {
        e.preventDefault();
        addFilesToPage(v, area, [...e.clipboardData.files]);
      }
    });
    area.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); area.classList.add('dragging'); }
    });
    area.addEventListener('dragleave', () => area.classList.remove('dragging'));
    area.addEventListener('drop', (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      area.classList.remove('dragging');
      area.focus();
      addFilesToPage(v, area, [...e.dataTransfer.files]);
    });
    v.bodyEl.replaceChildren(
      h('div', { class: 'editor-toolbar' },
        h('button', { class: 'btn small', type: 'button', onclick: () => picker.click() }, '📎 Insérer une image ou un fichier'),
        h('span', { class: 'muted small' }, 'ou glissez-déposez, ou collez une capture d’écran'),
        picker),
      area);
    queueMicrotask(autosize);
    if (document.activeElement !== v.titleInput) area.focus();
  } else {
    const html = renderMarkdown(v.content);
    if (v.filesEl) loadPageFiles(v);
    v.bodyEl.replaceChildren(html
      ? h('div', { class: 'md page-md', html, ondblclick: () => setMode(v, 'edit') })
      : h('p', { class: 'muted' }, 'Page vide. Cliquez sur « Modifier » pour écrire.'));
  }
}

function changed(v) {
  v.dirty = true;
  updateStatus(v);
  clearTimeout(v.timer);
  v.timer = setTimeout(() => savePage(v), 800);
}

function updateStatus(v) {
  if (!v.status) return;
  v.status.textContent = v.conflict ? 'Conflit'
    : v.saving ? 'Enregistrement…'
      : v.dirty ? 'Modifications non enregistrées'
        : 'Enregistré';
}

async function savePage(v) {
  clearTimeout(v.timer);
  if (v.saving || !v.dirty || v.conflict) return;
  v.saving = true;
  v.dirty = false;
  updateStatus(v);
  try {
    const { page } = await api('PATCH', `/pages/${v.id}`, { title: v.title, content: v.content, version: v.page.version });
    v.page = page;
    const summary = state.pages.get(page.id);
    if (summary) summary.title = page.title;
    renderSidebar();
  } catch (err) {
    v.dirty = true;
    if (err.status === 409) showConflict(v, 'Quelqu’un a modifié cette page pendant que vous l’éditiez.');
    else report(err);
  } finally {
    v.saving = false;
    updateStatus(v);
    if (v.dirty && !v.conflict && state.view === v) v.timer = setTimeout(() => savePage(v), 2000);
  }
}

async function onRemotePageChange(v, ev) {
  if (!v.page || ev.version <= v.page.version) return;
  if (v.dirty || v.saving) {
    showConflict(v, `${userName(ev.by)} vient de modifier cette page.`);
    return;
  }
  try {
    const { page } = await api('GET', `/pages/${v.id}`);
    if (state.view !== v || v.dirty) return;
    v.page = page;
    v.title = page.title;
    v.content = page.content;
    renderPage(v);
  } catch (err) { report(err); }
}

function showConflict(v, message) {
  v.conflict = message;
  updateStatus(v);
  v.banner.hidden = false;
  v.banner.replaceChildren(
    h('span', {}, message, ' Vos modifications n’ont pas été enregistrées.'),
    h('button', {
      class: 'btn small',
      onclick: async () => {
        try { await navigator.clipboard.writeText(v.content); toast('Votre texte a été copié.', 'info'); } catch { report(new Error('Copie impossible.')); }
      },
    }, 'Copier mon texte'),
    h('button', {
      class: 'btn small primary',
      onclick: async () => {
        const { page } = await api('GET', `/pages/${v.id}`);
        Object.assign(v, { page, title: page.title, content: page.content, dirty: false, conflict: null });
        renderPage(v);
      },
    }, 'Charger la dernière version'));
}

async function deletePage(v) {
  const count = descendants(v.id).length;
  const extra = count ? ` et ses ${count} sous-page${count > 1 ? 's' : ''}` : '';
  if (!confirm(`Supprimer « ${pageTitle(v.page)} »${extra} ? Cette action est définitive.`)) return;
  try {
    clearTimeout(v.timer);
    v.dirty = false;
    await api('DELETE', `/pages/${v.id}`);
    state.pages.delete(v.id);
    for (const id of descendants(v.id)) state.pages.delete(id);
    location.hash = '';
  } catch (err) { report(err); }
}

window.addEventListener('beforeunload', (e) => {
  const v = state.view;
  if (v?.kind === 'page' && (v.dirty || v.saving)) {
    savePage(v);
    e.preventDefault();
  }
});

// --- Réactions ------------------------------------------------------------------

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '✅', '🔥', '😮', '😢', '👏', '🚀', '💡', '🤔', '👌', '☕'];

function applyReactions(v, messageId, reactions) {
  const update = (m) => (m && m.id === messageId ? { ...m, reactions } : m);
  v.messages = v.messages.map(update);
  if (v.thread?.replies) {
    v.thread.root = update(v.thread.root);
    v.thread.replies = v.thread.replies.map(update);
  }
  rerender(v);
}

async function toggleReaction(m, emoji) {
  try {
    const { reactions } = await api('POST', `/messages/${m.id}/reactions`, { emoji });
    if (state.view?.kind === 'channel' && state.view.id === m.channelId) applyReactions(state.view, m.id, reactions);
  } catch (err) { report(err); }
}

let closePicker = () => {};

function openEmojiPicker(anchor, onPick) {
  closePicker();
  const picker = h('div', { class: 'emoji-picker', role: 'dialog', 'aria-label': 'Choisir une réaction' },
    QUICK_EMOJIS.map((emoji) => h('button', {
      type: 'button', class: 'emoji', 'aria-label': emoji,
      onclick: () => { closePicker(); onPick(emoji); },
    }, emoji)));
  document.body.append(picker);

  const r = anchor.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: ph } = picker;
  const top = r.bottom + ph + 8 > innerHeight ? r.top - ph - 4 : r.bottom + 4;
  picker.style.top = `${Math.max(8, top)}px`;
  picker.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;
  picker.querySelector('button').focus();

  const outside = (e) => { if (!picker.contains(e.target)) closePicker(); };
  const onKey = (e) => { if (e.key === 'Escape') { closePicker(); anchor.focus(); } };
  closePicker = () => {
    picker.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey);
    closePicker = () => {};
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey);
}

// --- Autocomplétion des @mentions ------------------------------------------------

function mentionPicker(input) {
  const el = h('ul', { class: 'mention-picker', role: 'listbox', hidden: true });
  let items = [];
  let index = 0;
  let start = -1;

  function candidates(query) {
    const q = query.toLowerCase();
    const people = [...state.users.values()]
      .filter((u) => u.id !== state.me.id && u.active !== false)
      .filter((u) => u.name.toLowerCase().startsWith(q) || u.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)))
      .slice(0, 6)
      .map((u) => ({ value: u.name, label: u.name, id: u.id }));
    if (EVERYONE.startsWith(q)) people.push({ value: EVERYONE, label: '@tous', hint: 'prévenir tout le canal' });
    return people;
  }

  function hide() {
    el.hidden = true;
    items = [];
  }

  function render() {
    el.replaceChildren(...items.map((item, i) => h('li', {
      role: 'option', class: i === index ? 'active' : '', 'aria-selected': i === index ? 'true' : 'false',
      onpointerdown: (e) => { e.preventDefault(); choose(i); },
    },
    item.id ? avatar(item.id, 'tiny') : h('span', { class: 'avatar tiny' }, '@'),
    h('span', {}, item.label),
    item.hint && h('span', { class: 'muted small' }, item.hint))));
    el.hidden = items.length === 0;
  }

  function choose(i) {
    const item = items[i];
    const caret = input.selectionStart;
    const before = input.value.slice(0, start);
    const after = input.value.slice(caret);
    const insert = `@${item.value} `;
    input.value = before + insert + after;
    const pos = before.length + insert.length;
    input.setSelectionRange(pos, pos);
    input.dispatchEvent(new Event('input'));
    hide();
    input.focus();
  }

  function update() {
    const caret = input.selectionStart;
    const text = input.value.slice(0, caret);
    const match = text.match(/(?:^|[^\p{L}\p{N}_])@([^@\n]{0,30})$/u);
    if (!match || /\s{2}|^\s/.test(match[1])) return hide();
    start = caret - match[1].length - 1;
    items = candidates(match[1]);
    index = 0;
    render();
  }

  function handleKey(e) {
    if (el.hidden) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
    } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      choose(index);
    } else if (e.key === 'Escape') {
      hide();
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  }

  input.addEventListener('blur', hide);
  return { el, update, handleKey };
}

// --- Notifications ------------------------------------------------------------

function notificationText(n, { withEmoji = true } = {}) {
  const who = userName(n.actorId);
  const c = state.channels.get(n.channelId);
  const where = c ? (c.isDm ? 'en message privé' : `dans ${channelRef(c)}`) : '';
  if (n.kind === 'mention') return `${who} vous a mentionné ${where}`;
  if (n.kind === 'reply') return `${who} a répondu dans un fil ${where}`;
  return `${who} a réagi${withEmoji ? ` ${n.emoji}` : ''} à votre message ${where}`;
}

const notificationHash = (n) => (n.parentId ? `#/c/${n.channelId}/t/${n.parentId}` : `#/c/${n.channelId}`);

// La notification concerne-t-elle ce que la personne a sous les yeux en ce moment ?
function isOnScreen(n) {
  const v = state.view;
  if (document.visibilityState !== 'visible' || v?.kind !== 'channel' || v.id !== n.channelId) return false;
  return n.parentId ? v.thread?.rootId === n.parentId : true;
}

function onNotification(n) {
  if (state.notifications.some((x) => x.id === n.id)) return;
  state.notifications.unshift(n);
  state.notifications.length = Math.min(state.notifications.length, 50);
  if (isOnScreen(n)) {
    n.read = true;
    api('POST', '/notifications/read', { ids: [n.id] }).catch(() => {});
  } else {
    state.notifUnread += 1;
    const channel = state.channels.get(n.channelId);
    // Les messages privés font déjà l'objet d'une notification de bureau à part.
    if (!channel?.isDm || n.kind === 'reaction') desktopNotify(notificationText(n), n.excerpt, notificationHash(n));
  }
  renderSidebar();
  if (state.view?.kind === 'activity') renderActivity(state.view);
}

function forgetNotifications(messageId) {
  const gone = state.notifications.filter((n) => n.messageId === messageId);
  if (!gone.length) return;
  state.notifications = state.notifications.filter((n) => n.messageId !== messageId);
  state.notifUnread = Math.max(0, state.notifUnread - gone.filter((n) => !n.read).length);
  renderSidebar();
  if (state.view?.kind === 'activity') renderActivity(state.view);
}

async function readNotificationsWhere(match) {
  const ids = state.notifications.filter((n) => !n.read && match(n)).map((n) => n.id);
  if (!ids.length) return;
  for (const n of state.notifications) if (ids.includes(n.id)) n.read = true;
  state.notifUnread = Math.max(0, state.notifUnread - ids.length);
  renderSidebar();
  try {
    const { unread } = await api('POST', '/notifications/read', { ids });
    state.notifUnread = unread;
    renderSidebar();
  } catch (err) { report(err); }
}

async function readAllNotifications() {
  try {
    await api('POST', '/notifications/read', {});
    for (const n of state.notifications) n.read = true;
    state.notifUnread = 0;
    renderSidebar();
    if (state.view?.kind === 'activity') renderActivity(state.view);
  } catch (err) { report(err); }
}

const desktopSupported = 'Notification' in window;
const desktopEnabled = () => desktopSupported && Notification.permission === 'granted' && storage.get('makora.desktop', true);

// Notification affichée par la page elle-même, quand l'onglet est ouvert mais pas regardé.
// Si cet appareil reçoit les push, le serveur s'en charge déjà : on évite les doublons.
async function desktopNotify(title, body, hash) {
  if (!desktopEnabled() || pushActive || (document.visibilityState === 'visible' && document.hasFocus())) return;
  const options = { body: body.slice(0, 200), icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', tag: hash, data: { url: `/${hash}` } };
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) {
      await registration.showNotification(title, options);
      return;
    }
    const n = new Notification(title, options);
    n.onclick = () => {
      window.focus();
      location.hash = hash;
      n.close();
    };
  } catch {
    // Notifications indisponibles dans ce contexte : on n'insiste pas.
  }
}

function openActivity() {
  const v = { kind: 'activity' };
  state.view = v;
  renderSidebar();
  v.head = h('header', { class: 'main-head' });
  v.list = h('div', { class: 'activity' });
  els.main.replaceChildren(v.head, h('div', { class: 'page-scroll' }, v.list));
  renderActivity(v);
}

function renderActivity(v) {
  v.head.replaceChildren(
    navButton(),
    h('div', { class: 'head-title' }, h('h1', {}, 'Activité'),
      h('span', { class: 'muted small' }, 'Mentions, réponses à vos fils et réactions à vos messages')),
    h('div', { class: 'head-actions' },
      deviceNotificationsControl(v),
      installButton(),
      state.notifUnread > 0 && h('button', { class: 'btn small', onclick: readAllNotifications }, 'Tout marquer comme lu')));

  const tip = iosInstallTip();
  if (!state.notifications.length) {
    v.list.replaceChildren(tip ?? '', h('div', { class: 'empty-state' }, h('h2', {}, 'Rien de neuf 🌤'),
      h('p', { class: 'muted' }, 'Vous verrez ici quand quelqu’un vous mentionne, répond à un de vos fils ou réagit à vos messages.')));
    return;
  }
  v.list.replaceChildren(tip ?? '', ...state.notifications.map((n) => h('a', {
    class: `activity-item${n.read ? '' : ' unread'}`,
    href: notificationHash(n),
    onclick: () => { if (!n.read) readNotificationsWhere((x) => x.id === n.id); },
  },
  avatar(n.actorId),
  h('div', { class: 'activity-body' },
    h('div', {}, h('span', { class: 'activity-kind', 'aria-hidden': 'true' }, n.kind === 'mention' ? '@' : n.kind === 'reply' ? '💬' : n.emoji), ' ',
      h('strong', {}, notificationText(n, { withEmoji: false }))),
    n.excerpt && h('div', { class: 'md muted', html: md(n.excerpt) }),
    h('time', { class: 'muted small', datetime: new Date(n.createdAt).toISOString() }, relativeTime(n.createdAt))),
  !n.read && h('span', { class: 'unread-dot', title: 'Non lu' }))));
}

// --- Membres des canaux ----------------------------------------------------------

// Liste de personnes à cocher, avec filtre par nom.
function peoplePicker(people) {
  const chosen = new Set();
  const list = h('ul', { class: 'pick-list people-pick' });
  const filter = h('input', { type: 'search', placeholder: 'Filtrer par nom…', 'aria-label': 'Filtrer les personnes', class: 'filter' });
  const render = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = people.filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    list.replaceChildren(...shown.map((u) => h('li', {},
      h('label', { class: 'person check' },
        h('input', {
          type: 'checkbox', checked: chosen.has(u.id),
          onchange: (e) => { if (e.target.checked) chosen.add(u.id); else chosen.delete(u.id); },
        }),
        avatar(u.id, 'tiny'), h('span', {}, u.name), presenceDot(u.id)))));
    if (!shown.length) list.append(h('li', { class: 'muted small' }, people.length ? 'Personne ne correspond.' : 'Tout le monde est déjà là.'));
  };
  filter.addEventListener('input', render);
  render();
  return {
    el: h('div', { class: 'stack tight' }, people.length > 6 && filter, list),
    selected: () => [...chosen],
  };
}

async function openMembersDialog(c) {
  let data;
  try {
    data = await api('GET', `/channels/${c.id}/members`);
  } catch (err) {
    report(err);
    return;
  }
  const body = h('div', { class: 'stack' });
  const dlg = dialog(`Membres de ${channelRef(c)}`, body);
  const canRemove = c.createdBy === state.me.id || state.me.role === 'admin';

  const render = () => {
    const members = data.members
      .map((id) => state.users.get(id) ?? { id, name: userName(id), email: '' })
      .sort((a, b) => a.name.localeCompare(b.name));
    const isMember = data.members.includes(state.me.id);
    const outsiders = [...state.users.values()].filter((u) => !data.members.includes(u.id) && u.active !== false);
    const picker = peoplePicker(outsiders);

    body.replaceChildren(...nodes(
      h('p', { class: 'muted small' }, c.isPrivate
        ? '🔒 Canal privé : seuls ses membres le voient et peuvent y ajouter des personnes.'
        : 'Canal public : tout le monde peut le rejoindre.'),
      h('ul', { class: 'pick-list' }, members.map((u) => h('li', {},
        h('div', { class: 'person' }, avatar(u.id), h('div', {},
          h('strong', {}, presenceDot(u.id), ' ', u.name, u.id === state.me.id ? ' (vous)' : ''),
          h('div', { class: 'muted small' }, u.id === data.createdBy ? 'Créateur du canal' : u.email))),
        u.id === state.me.id
          ? h('button', { class: 'btn small', onclick: () => { dlg.close(); leaveChannel(c); } }, 'Quitter')
          : canRemove && h('button', {
            class: 'btn small danger',
            onclick: async () => {
              if (!confirm(`Retirer ${u.name} de ${channelRef(c)} ?`)) return;
              try {
                await api('DELETE', `/channels/${c.id}/members/${u.id}`);
                data.members = data.members.filter((id) => id !== u.id);
                render();
              } catch (err) { report(err); }
            },
          }, 'Retirer')))),
      isMember && outsiders.length > 0 && h('div', { class: 'stack' },
        h('h3', {}, 'Ajouter des personnes'),
        picker.el,
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            const userIds = picker.selected();
            if (!userIds.length) return;
            try {
              const res = await api('POST', `/channels/${c.id}/members`, { userIds });
              data.members = res.members;
              c.memberCount = res.members.length;
              toast(`${res.added.length} personne${res.added.length > 1 ? 's' : ''} ajoutée${res.added.length > 1 ? 's' : ''}.`, 'info');
              render();
            } catch (err) { report(err); }
          },
        }, 'Ajouter')),
      !isMember && !c.isPrivate && h('p', { class: 'muted small' }, 'Rejoignez le canal pour pouvoir y ajouter des personnes.')));
  };
  render();
}

// --- Historique des pages --------------------------------------------------------

// Différence ligne à ligne (plus longue sous-séquence commune) entre deux textes.
function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) return null;
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ type: 'del', text: a[i++] });
    else out.push({ type: 'add', text: b[j++] });
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

// Affiche les lignes modifiées avec 2 lignes de contexte ; les longues parties identiques sont repliées.
function renderDiff(lines) {
  if (!lines) return h('p', { class: 'muted' }, 'Page trop longue pour afficher les différences.');
  if (!lines.some((l) => l.type !== 'same')) return h('p', { class: 'muted' }, 'Identique à la version actuelle.');
  const keep = lines.map((l, i) => l.type !== 'same' || lines.slice(Math.max(0, i - 2), i + 3).some((x) => x.type !== 'same'));
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      let k = i;
      while (k < lines.length && !keep[k]) k++;
      rows.push(h('div', { class: 'diff-gap' }, `… ${k - i} ligne${k - i > 1 ? 's' : ''} identique${k - i > 1 ? 's' : ''} …`));
      i = k - 1;
      continue;
    }
    const l = lines[i];
    rows.push(h('div', { class: `diff-line ${l.type}` },
      h('span', { class: 'diff-sign', 'aria-hidden': 'true' }, l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '),
      h('span', {}, l.text || ' ')));
  }
  return h('div', { class: 'diff' }, rows);
}

async function openHistory(v) {
  if (v.dirty || v.saving) await savePage(v);
  if (v.conflict) {
    toast('Réglez d’abord le conflit de modification en cours.');
    return;
  }
  let data;
  try {
    data = await api('GET', `/pages/${v.id}/versions`);
  } catch (err) {
    report(err);
    return;
  }
  const list = h('ul', { class: 'version-list' });
  const preview = h('div', { class: 'version-preview' });
  const dlg = dialog(`Historique de « ${pageTitle(v.page)} »`, h('div', { class: 'history' }, list, preview));
  dlg.classList.add('wide');

  if (!data.versions.length) {
    list.replaceChildren(h('li', { class: 'muted small' }, 'Aucune version enregistrée pour l’instant.'));
    preview.replaceChildren(h('p', { class: 'muted' }, 'L’historique se remplit à chaque modification de la page. Les enregistrements d’une même personne à moins de 10 minutes d’intervalle sont regroupés.'));
    return;
  }

  let selected = null;
  let mode = 'diff';
  const isCurrent = (ver) => ver.version === data.current;

  async function select(ver) {
    selected = ver;
    renderList();
    preview.replaceChildren(h('p', { class: 'muted' }, 'Chargement…'));
    try {
      const full = (await api('GET', `/pages/${v.id}/versions/${ver.id}`)).version;
      if (selected !== ver) return;
      renderPreview(full);
    } catch (err) { report(err); }
  }

  function renderList() {
    list.replaceChildren(...data.versions.map((ver) => h('li', {},
      h('button', { class: `version${ver === selected ? ' active' : ''}`, onclick: () => select(ver) },
        avatar(ver.editedBy, 'tiny'),
        h('span', { class: 'version-info' },
          h('strong', {}, dateTimeFmt.format(ver.savedAt)),
          h('span', { class: 'muted small' }, userName(ver.editedBy),
            ver.restoredFrom ? ` · restauration de la v${ver.restoredFrom}` : '')),
        isCurrent(ver) && h('span', { class: 'tag' }, 'Actuelle')))));
  }

  function renderPreview(full) {
    const tabs = h('div', { class: 'tabs', role: 'tablist' },
      ['diff', 'read'].map((m) => h('button', {
        role: 'tab', class: `tab${mode === m ? ' active' : ''}`, 'aria-selected': mode === m ? 'true' : 'false',
        onclick: () => { mode = m; renderPreview(full); },
      }, m === 'diff' ? 'Changements' : 'Aperçu')));
    const content = mode === 'diff'
      ? h('div', {},
        h('p', { class: 'muted small legend' }, h('span', { class: 'diff-key del' }, '−'), ' dans cette version uniquement · ',
          h('span', { class: 'diff-key add' }, '+'), ' ajouté depuis'),
        full.title !== v.page.title && h('p', { class: 'small' }, 'Titre : ', h('del', {}, full.title || 'Sans titre'), ' → ', h('strong', {}, pageTitle(v.page))),
        renderDiff(diffLines(full.content, v.page.content)))
      : h('div', {}, h('h1', { class: 'version-title' }, full.title || 'Sans titre'),
        h('div', { class: 'md page-md', html: renderMarkdown(full.content) || '<p class="muted">Page vide.</p>' }));
    preview.replaceChildren(
      h('div', { class: 'version-head' }, tabs,
        isCurrent(full)
          ? h('span', { class: 'muted small' }, 'C’est la version actuelle.')
          : h('button', {
            class: 'btn small primary',
            onclick: async () => {
              if (!confirm('Restaurer cette version ? Le contenu actuel restera disponible dans l’historique.')) return;
              try {
                const { page } = await api('POST', `/pages/${v.id}/versions/${full.id}/restore`, { version: v.page.version });
                Object.assign(v, { page, title: page.title, content: page.content, dirty: false });
                const summary = state.pages.get(page.id);
                if (summary) summary.title = page.title;
                dlg.close();
                renderSidebar();
                renderPage(v);
                toast('Version restaurée.', 'info');
              } catch (err) { report(err); }
            },
          }, 'Restaurer cette version')),
      content);
  }

  renderList();
  select(data.versions.find((ver) => !isCurrent(ver)) ?? data.versions[0]);
}

// --- Application installable et notifications push ----------------------------

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && desktopSupported;
let pushActive = false;

function base64UrlToBytes(value) {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function subscribePush() {
  const { publicKey } = await api('GET', '/push/key');
  if (!publicKey) return false;
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
  }
  // Toujours renvoyé au serveur : l'abonnement est rattaché au compte connecté sur cet appareil.
  await api('POST', '/push/subscribe', { subscription: subscription.toJSON() });
  pushActive = true;
  return true;
}

async function disablePush() {
  const subscription = await currentSubscription();
  pushActive = false;
  if (!subscription) return;
  await api('POST', '/push/unsubscribe', { endpoint: subscription.endpoint }).catch(() => {});
  await subscription.unsubscribe();
}

// Au démarrage : si les notifications sont activées sur cet appareil, on (ré)associe l'abonnement au compte.
async function syncPush() {
  if (!pushSupported || Notification.permission !== 'granted' || !storage.get('makora.desktop', true)) return;
  try { await subscribePush(); } catch (err) { console.warn('Abonnement push impossible :', err); }
}

async function enableDeviceNotifications() {
  if (await Notification.requestPermission() !== 'granted') return;
  storage.set('makora.desktop', true);
  if (pushSupported) {
    try {
      if (!await subscribePush()) toast('Les notifications push ne sont pas configurées sur ce serveur.', 'info');
    } catch (err) {
      report(new Error(`Abonnement push impossible : ${err.message}`));
    }
  }
}

function deviceNotificationsControl(v) {
  if (!desktopSupported) return null;
  if (Notification.permission === 'denied') {
    return h('span', { class: 'muted small' }, 'Notifications bloquées dans les réglages du navigateur');
  }
  const on = Notification.permission === 'granted' && storage.get('makora.desktop', true);
  return h('button', {
    class: 'btn small', 'aria-pressed': on ? 'true' : 'false',
    title: pushSupported ? 'Notifications push, même application fermée' : 'Notifications quand l’onglet est ouvert en arrière-plan',
    onclick: async (e) => {
      e.currentTarget.disabled = true;
      if (on) {
        storage.set('makora.desktop', false);
        await disablePush().catch(report);
      } else {
        await enableDeviceNotifications();
      }
      renderActivity(v);
    },
  }, on ? '🔔 Notifications sur cet appareil : activées' : '🔕 Activer les notifications sur cet appareil');
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (state.view?.kind === 'activity') renderActivity(state.view);
  renderSidebar();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  renderSidebar();
});

function installButton() {
  if (!installPrompt) return null;
  return h('button', {
    class: 'btn small primary',
    onclick: async () => {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      renderSidebar();
      if (state.view?.kind === 'activity') renderActivity(state.view);
    },
  }, '📲 Installer l’application');
}

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Sur iPhone, les notifications push ne fonctionnent qu'une fois l'application ajoutée à l'écran d'accueil.
function iosInstallTip() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!ios || isStandalone()) return null;
  return h('div', { class: 'notice tip' }, '📲 Sur iPhone et iPad : touchez ', h('strong', {}, 'Partager'), ' puis ',
    h('strong', {}, 'Sur l’écran d’accueil'), ' pour installer MAKORA HIT et recevoir les notifications.');
}

// --- Mon compte -----------------------------------------------------------------

function openAccountDialog() {
  closeNav();
  const me = state.me;
  const nameError = h('p', { class: 'form-error', role: 'alert' });
  const nameForm = h('form', { class: 'stack' },
    h('label', { class: 'field' }, h('span', {}, 'Nom affiché'),
      h('input', { name: 'name', value: me.name, required: true, maxlength: 80, autocomplete: 'name' })),
    nameError,
    h('button', { class: 'btn', type: 'submit' }, 'Enregistrer le nom'));
  nameForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    nameError.textContent = '';
    try {
      const { user } = await api('PATCH', '/me', { name: new FormData(nameForm).get('name') });
      state.me.name = user.name;
      renderMe();
      toast('Nom mis à jour.', 'info');
    } catch (err) { nameError.textContent = err.message; }
  });

  const pwError = h('p', { class: 'form-error', role: 'alert' });
  const pwForm = h('form', { class: 'stack' },
    h('label', { class: 'field' }, h('span', {}, 'Mot de passe actuel'),
      h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
    h('label', { class: 'field' }, h('span', {}, 'Nouveau mot de passe (8 caractères minimum)'),
      h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
    pwError,
    h('button', { class: 'btn', type: 'submit' }, 'Changer le mot de passe'),
    h('p', { class: 'muted small' }, 'Vos autres appareils seront déconnectés.'));
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    pwError.textContent = '';
    const data = new FormData(pwForm);
    try {
      await api('POST', '/me/password', { current: data.get('current'), password: data.get('password') });
      pwForm.reset();
      toast('Mot de passe modifié.', 'info');
    } catch (err) { pwError.textContent = err.message; }
  });

  const dlg = dialog('Mon compte',
    h('div', { class: 'account-head' }, avatar(me.id), h('div', {},
      h('strong', {}, me.name), h('div', { class: 'muted small' }, me.email, ' · ', me.role === 'admin' ? 'Administrateur' : 'Membre'))),
    me.role === 'admin' && h('div', { class: 'row wrap' },
      h('button', { class: 'btn primary', onclick: () => { dlg.close(); location.hash = '#/admin'; } }, '🛠 Administration'),
      h('button', { class: 'btn', onclick: () => { dlg.close(); createInvite(); } }, 'Inviter un collègue')),
    h('h3', {}, 'Profil'), nameForm,
    h('h3', {}, 'Mot de passe'),
    me.hasPassword === false
      ? h('p', { class: 'muted small' }, `Vous vous connectez avec ${state.features.sso ?? 'votre compte d’entreprise'} : pas de mot de passe à gérer ici.`)
      : pwForm,
    state.features.email && h('h3', {}, 'Notifications par email'),
    state.features.email && h('label', { class: 'check' },
      h('input', {
        type: 'checkbox', checked: me.emailNotifications !== false,
        onchange: async (e) => {
          try {
            const { user } = await api('PATCH', '/me', { emailNotifications: e.target.checked });
            state.me.emailNotifications = user.emailNotifications;
            toast(user.emailNotifications ? 'Résumés par email activés.' : 'Résumés par email désactivés.', 'info');
          } catch (err) { e.target.checked = !e.target.checked; report(err); }
        },
      }),
      h('span', {}, 'Recevoir un email quand des mentions ou réponses restent non lues plus de 15 minutes',
        h('span', { class: 'muted small block' }, 'Au plus un email par heure, jamais quand l’application est ouverte.'))),
    h('hr'),
    h('button', { class: 'btn danger block', onclick: logout }, 'Se déconnecter'));
}

// --- Administration ---------------------------------------------------------------

function openAdmin() {
  const v = { kind: 'admin', users: [], invites: [] };
  state.view = v;
  renderSidebar();
  v.body = h('div', { class: 'admin' }, h('p', { class: 'muted' }, 'Chargement…'));
  els.main.replaceChildren(
    h('header', { class: 'main-head' }, navButton(),
      h('div', { class: 'head-title' }, h('h1', {}, '🛠 Administration'),
        h('span', { class: 'muted small' }, 'Comptes de l’équipe et invitations')),
      h('div', { class: 'head-actions' }, h('button', { class: 'btn small primary', onclick: createInvite }, '+ Inviter'))),
    h('div', { class: 'page-scroll' }, v.body));
  loadAdmin(v);
}

async function loadAdmin(v) {
  try {
    const [{ users }, { invites }] = await Promise.all([api('GET', '/admin/users'), api('GET', '/admin/invites')]);
    if (state.view !== v) return;
    v.users = users;
    v.invites = invites;
    renderAdmin(v);
  } catch (err) {
    report(err);
    if (err.status === 403) location.hash = '';
  }
}

async function adminAction(v, request, success) {
  try {
    await request();
    if (success) toast(success, 'info');
  } catch (err) { report(err); }
  loadAdmin(v);
}

function renderAdmin(v) {
  const active = v.users.filter((u) => u.active);
  const admins = active.filter((u) => u.role === 'admin').length;

  const userRow = (u) => {
    const self = u.id === state.me.id;
    const actions = self ? [h('span', { class: 'muted small' }, 'C’est vous')] : [
      u.active && h('button', {
        class: 'btn small',
        onclick: () => adminAction(v, () => api('PATCH', `/admin/users/${u.id}`, { role: u.role === 'admin' ? 'member' : 'admin' }),
          u.role === 'admin' ? `${u.name} n’est plus administrateur.` : `${u.name} est maintenant administrateur.`),
      }, u.role === 'admin' ? 'Retirer les droits admin' : 'Nommer admin'),
      u.active && h('button', {
        class: 'btn small',
        onclick: async () => {
          try {
            const { token, expiresAt, emailed } = await api('POST', `/admin/users/${u.id}/reset`, { send: state.features.email });
            showLink(`Réinitialiser le mot de passe de ${u.name}`,
              `${emailed ? `Un email avec ce lien vient d’être envoyé à ${u.email}. ` : `Envoyez ce lien à ${u.name} : `}il·elle pourra choisir un nouveau mot de passe, et ses sessions ouvertes seront fermées. Lien à usage unique, valable jusqu’au `,
              `${location.origin}/#/reset/${token}`, expiresAt);
          } catch (err) { report(err); }
        },
      }, 'Lien de réinitialisation'),
      h('button', {
        class: `btn small${u.active ? ' danger' : ''}`,
        onclick: () => {
          if (u.active && !confirm(`Désactiver le compte de ${u.name} ? Il·elle sera déconnecté·e immédiatement et ne pourra plus se connecter. Ses messages restent visibles.`)) return;
          adminAction(v, () => api('PATCH', `/admin/users/${u.id}`, { active: !u.active }),
            u.active ? `Compte de ${u.name} désactivé.` : `Compte de ${u.name} réactivé.`);
        },
      }, u.active ? 'Désactiver' : 'Réactiver'),
    ];
    return h('li', { class: `admin-user${u.active ? '' : ' inactive'}` },
      h('div', { class: 'person' }, avatar(u.id), h('div', {},
        h('strong', {}, u.active && presenceDot(u.id), ' ', u.name,
          u.role === 'admin' && h('span', { class: 'tag' }, 'Admin'),
          !u.active && h('span', { class: 'tag muted-tag' }, 'Désactivé')),
        h('div', { class: 'muted small' }, u.email, ' · arrivé le ', dayFmt.format(u.createdAt)))),
      h('div', { class: 'admin-actions' }, actions));
  };

  v.body.replaceChildren(...nodes(
    h('section', {},
      h('h2', {}, `Membres (${active.length} actif${active.length > 1 ? 's' : ''}, ${admins} admin${admins > 1 ? 's' : ''})`),
      h('ul', { class: 'admin-list' }, v.users.map(userRow))),
    h('section', {},
      h('h2', {}, 'Invitations en attente'),
      v.invites.length
        ? h('ul', { class: 'admin-list' }, v.invites.map((i) => h('li', { class: 'admin-user' },
          h('div', {}, h('strong', {}, i.email ? `${i.email}` : `Lien ouvert à tous`, h('span', { class: 'muted' }, ` · invitation de ${userName(i.createdBy)}`)),
            h('div', { class: 'muted small' }, `créée le ${dateTimeFmt.format(i.createdAt)} · expire le ${dateTimeFmt.format(i.expiresAt)}`)),
          h('div', { class: 'admin-actions' },
            h('button', {
              class: 'btn small',
              onclick: () => showLink('Lien d’invitation', 'Lien à usage unique, valable jusqu’au ', `${location.origin}/#/invite/${i.token}`, i.expiresAt),
            }, 'Afficher le lien'),
            h('button', {
              class: 'btn small danger',
              onclick: () => adminAction(v, () => api('DELETE', `/admin/invites/${i.token}`), 'Invitation révoquée.'),
            }, 'Révoquer')))))
        : h('p', { class: 'muted' }, 'Aucune invitation en attente.')),
    h('section', {},
      h('h2', {}, 'Bon à savoir'),
      h('ul', { class: 'muted small tips' },
        h('li', {}, 'Un compte désactivé est déconnecté partout immédiatement ; ses messages et pages restent visibles.'),
        h('li', {}, 'Il reste toujours au moins un administrateur, et personne ne peut retirer ses propres droits.'),
        h('li', {}, 'Les administrateurs ne voient pas les canaux privés dont ils ne sont pas membres.')))));
}

// --- Réglage des notifications d'un canal --------------------------------------

function openNotifyDialog(c) {
  const defaultLabel = c.isDm ? 'Tous les messages' : 'Mentions uniquement';
  const options = [
    ['all', '🔔 Tous les messages', 'Une notification pour chaque nouveau message (hors réponses dans les fils).'],
    ['mentions', '@ Mentions uniquement', 'Quand on vous mentionne, qu’on écrit @tous ou qu’on répond dans un fil où vous participez.'],
    ['none', '🔕 Muet', 'Plus de compteur ni de notification, sauf si on vous mentionne directement.'],
  ];
  const current = notifyLevel(c);
  const dlg = dialog(`Notifications : ${c.isDm ? userName(c.dmUserId) : channelRef(c)}`,
    h('div', { class: 'stack', role: 'radiogroup' }, options.map(([level, label, help]) => h('label', { class: 'check option' },
      h('input', {
        type: 'radio', name: 'notify', value: level, checked: level === current,
        onchange: async () => {
          // Revenir au réglage par défaut plutôt que de le figer : il suit ainsi d'éventuelles évolutions.
          const isDefault = level === (c.isDm ? 'all' : 'mentions');
          try {
            const res = await api('PUT', `/channels/${c.id}/notify`, { level: isDefault ? null : level });
            c.notify = res.notify;
            renderSidebar();
            if (state.view?.kind === 'channel' && state.view.id === c.id) renderChannelHeader(state.view);
            dlg.close();
            toast(`${label.slice(2).trim()} pour ${c.isDm ? userName(c.dmUserId) : channelRef(c)}.`, 'info');
          } catch (err) { report(err); }
        },
      }),
      h('span', {}, h('strong', {}, label, level === (c.isDm ? 'all' : 'mentions') && h('span', { class: 'muted small' }, ' (par défaut)')),
        h('span', { class: 'muted small block' }, help))))),
    h('p', { class: 'muted small' }, `Par défaut : ${defaultLabel.toLowerCase()}. Les notifications push et par email suivent ce réglage.`));
}

// --- Fichiers dans les pages -----------------------------------------------------

async function uploadPageFile(pageId, file) {
  return parseResponse(await fetch(`/api/pages/${pageId}/files`, {
    method: 'POST',
    headers: {
      'X-Makora': '1',
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
      'X-File-Type': file.type || 'application/octet-stream',
    },
    body: file,
  }));
}

// Markdown inséré dans la page : les images s'affichent, les autres fichiers deviennent un lien.
function fileMarkdown(file, url) {
  const label = file.name.replace(/[[\]]/g, '');
  return INLINE_IMAGES.has(file.mime) ? `![${label}](${url})` : `[📎 ${label} (${formatSize(file.size)})](${url})`;
}

function insertIntoEditor(v, area, text, { replace } = {}) {
  if (replace !== undefined) {
    area.value = area.value.replace(replace, text);
  } else {
    const start = area.selectionStart ?? area.value.length;
    const before = area.value.slice(0, start);
    const pad = before && !before.endsWith('\n') ? '\n' : '';
    area.value = `${before}${pad}${text}\n${area.value.slice(area.selectionEnd ?? start)}`;
    const pos = before.length + pad.length + text.length + 1;
    area.setSelectionRange(pos, pos);
  }
  v.content = area.value;
  area.dispatchEvent(new Event('input'));
}

let uploadSeq = 0;

async function addFilesToPage(v, area, files) {
  for (const file of files) {
    if (file.size > state.limits.maxUploadBytes) {
      toast(`« ${file.name} » est trop volumineux (${formatSize(state.limits.maxUploadBytes)} maximum).`);
      continue;
    }
    // Repère temporaire à l'endroit du curseur, remplacé une fois le fichier envoyé.
    const marker = `⏳ Envoi de ${file.name}… [${++uploadSeq}]`;
    insertIntoEditor(v, area, marker);
    try {
      const res = await uploadPageFile(v.id, file);
      insertIntoEditor(v, area, fileMarkdown(res.file, res.url), { replace: marker });
    } catch (err) {
      insertIntoEditor(v, area, '', { replace: `${marker}\n` });
      report(err);
    }
  }
}

async function loadPageFiles(v) {
  if (!v.filesEl) return;
  try {
    const { files } = await api('GET', `/pages/${v.id}/files`);
    if (state.view !== v) return;
    v.filesEl.replaceChildren(...nodes(files.length > 0 && h('div', { class: 'subpages' },
      h('h3', { class: 'small muted' }, `Fichiers de la page (${files.length})`),
      h('ul', { class: 'file-list' }, files.map((f) => h('li', {},
        h('a', { href: `/api/page-files/${f.id}`, target: INLINE_IMAGES.has(f.mime) ? '_blank' : null, rel: 'noopener' },
          fileIcon(f), ' ', f.name),
        h('span', { class: 'muted small' }, ` ${formatSize(f.size)} · ${userName(f.userId)}`),
        v.mode === 'edit' && h('button', {
          class: 'icon-btn', title: 'Insérer dans la page', 'aria-label': `Insérer ${f.name} dans la page`,
          onclick: () => { const area = v.bodyEl.querySelector('textarea'); if (area) insertIntoEditor(v, area, fileMarkdown(f, `/api/page-files/${f.id}`)); },
        }, '↩'),
        (f.userId === state.me.id || state.me.role === 'admin') && h('button', {
          class: 'icon-btn', title: 'Supprimer le fichier', 'aria-label': `Supprimer ${f.name}`,
          onclick: async () => {
            if (!confirm(`Supprimer « ${f.name} » ? Les liens vers ce fichier dans la page ne fonctionneront plus.`)) return;
            try { await api('DELETE', `/page-files/${f.id}`); loadPageFiles(v); } catch (err) { report(err); }
          },
        }, '🗑')))))));
  } catch (err) { report(err); }
}

// --- Recherche --------------------------------------------------------------

async function openSearch(term) {
  const v = { kind: 'search', term };
  state.view = v;
  renderSidebar();
  const results = h('div', { class: 'search-results' }, h('p', { class: 'muted' }, 'Recherche…'));
  els.main.replaceChildren(
    h('header', { class: 'main-head' }, navButton(), h('div', { class: 'head-title' }, h('h1', {}, `Résultats pour « ${term} »`))),
    h('div', { class: 'page-scroll' }, results));
  try {
    const { messages, pages } = await api('GET', `/search?q=${encodeURIComponent(term)}`);
    if (state.view !== v) return;
    if (!messages.length && !pages.length) {
      results.replaceChildren(h('p', { class: 'muted' }, term.length < 2 ? 'Tapez au moins 2 caractères.' : 'Aucun résultat.'));
      return;
    }
    results.replaceChildren(...nodes(
      pages.length > 0 && h('section', {}, h('h2', {}, 'Pages'), pages.map((p) => h('a', { class: 'result', href: `#/p/${p.id}` },
        h('strong', {}, '📄 ', pageTitle(p)), h('p', { class: 'muted small' }, p.excerpt)))),
      messages.length > 0 && h('section', {}, h('h2', {}, 'Messages'), messages.map((m) => {
        const c = state.channels.get(m.channelId);
        return h('a', { class: 'result', href: m.parentId ? `#/c/${m.channelId}/t/${m.parentId}` : `#/c/${m.channelId}` },
          h('div', { class: 'small' }, h('strong', {}, userName(m.userId)), ' dans ', c ? channelTitle(c) : 'un canal',
            ' · ', h('span', { class: 'muted' }, dateTimeFmt.format(m.createdAt))),
          h('div', { class: 'md', html: md(m.body) }));
      }))));
  } catch (err) {
    report(err);
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker non enregistré :', err));
  // Clic sur une notification alors que l'application est déjà ouverte.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate') location.hash = new URL(e.data.url).hash;
  });
}

boot();
