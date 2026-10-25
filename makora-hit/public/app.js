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

async function api(method, path, body) {
  const headers = { 'X-Makora': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
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
  users: new Map(),
  online: new Set(),
  channels: new Map(),
  pages: new Map(),
  view: null,
  expanded: new Set(storage.get('makora.expanded', [])),
};

const userName = (id) => state.users.get(id)?.name ?? 'Utilisateur supprimé';
const channelTitle = (c) => (c.isDm ? userName(c.dmUserId) : `# ${c.name}`);
const pageTitle = (p) => p?.title?.trim() || 'Sans titre';

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
    const { user } = await api('GET', '/me');
    state.me = user;
    await startApp();
  } catch (err) {
    if (err.status === 401) await showAuth();
    else root.replaceChildren(h('div', { class: 'splash' }, `Impossible de charger l’application : ${err.message}`));
  }
}

async function showAuth() {
  const { needsSetup } = await api('GET', '/setup');
  const invite = location.hash.match(/^#\/invite\/([a-f0-9]+)$/)?.[1];
  let mode = 'login';
  let notice = '';
  if (needsSetup) mode = 'setup';
  else if (invite) {
    const { valid } = await api('GET', `/invites/${invite}`);
    if (valid) mode = 'register';
    else notice = 'Ce lien d’invitation est invalide ou a expiré. Demandez-en un nouveau à votre administrateur.';
  }

  const titles = {
    setup: ['Créer votre espace', 'Vous serez l’administrateur de l’espace MAKORA HIT de votre entreprise.'],
    register: ['Rejoindre l’équipe', 'Vous avez été invité·e. Créez votre compte pour commencer.'],
    login: ['Connexion', 'Retrouvez les discussions et documents de votre équipe.'],
  };
  const [title, subtitle] = titles[mode];
  const error = h('p', { class: 'form-error', role: 'alert' });
  const field = (label, name, type, extra = {}) => h('label', { class: 'field' },
    h('span', {}, label), h('input', { name, type, required: true, ...extra }));

  const form = h('form', { class: 'auth-card' },
    h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'MAKORA HIT'),
    h('h1', {}, title),
    h('p', { class: 'muted' }, subtitle),
    notice && h('p', { class: 'notice' }, notice),
    mode !== 'login' && field('Nom complet', 'name', 'text', { autocomplete: 'name', maxlength: 80 }),
    field('Email professionnel', 'email', 'email', { autocomplete: 'email' }),
    field('Mot de passe', 'password', 'password', {
      autocomplete: mode === 'login' ? 'current-password' : 'new-password',
      minlength: mode === 'login' ? undefined : 8,
    }),
    error,
    h('button', { class: 'btn primary block', type: 'submit' }, mode === 'login' ? 'Se connecter' : 'Créer mon compte'),
    mode === 'login' && h('p', { class: 'muted small' }, 'Pas de compte ? Demandez un lien d’invitation à votre administrateur.'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    error.textContent = '';
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register';
      const { user } = await api('POST', path, { ...data, invite });
      state.me = user;
      history.replaceState(null, '', location.pathname);
      await startApp();
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  });

  root.replaceChildren(h('div', { class: 'auth' }, form));
  form.querySelector('input')?.focus();
}

async function startApp() {
  const [{ users, online }, { channels }, { pages }] = await Promise.all([
    api('GET', '/users'), api('GET', '/channels'), api('GET', '/pages'),
  ]);
  state.users = new Map(users.map((u) => [u.id, u]));
  state.online = new Set(online);
  state.channels = new Map(channels.map((c) => [c.id, c]));
  state.pages = new Map(pages.map((p) => [p.id, p]));
  renderShell();
  connect();
  window.addEventListener('hashchange', route);
  route();
}

async function logout() {
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
    if (retry > 0) resync();
    retry = 0;
    document.body.classList.remove('offline');
  });
  socket.addEventListener('message', (e) => {
    try { onEvent(JSON.parse(e.data)); } catch (err) { console.error(err); }
  });
  socket.addEventListener('close', () => {
    document.body.classList.add('offline');
    const delay = Math.min(30_000, 1000 * 2 ** retry++);
    setTimeout(connect, delay);
  });
}

// Après une coupure, on recharge ce qui a pu changer pendant qu'on était hors ligne.
async function resync() {
  try {
    const [{ users }, { channels }, { pages }] = await Promise.all([
      api('GET', '/users'), api('GET', '/channels'), api('GET', '/pages'),
    ]);
    state.users = new Map(users.map((u) => [u.id, u]));
    state.channels = new Map(channels.map((c) => [c.id, c]));
    state.pages = new Map(pages.map((p) => [p.id, p]));
    renderSidebar();
    const v = state.view;
    if (v?.kind === 'channel') reloadMessages(v);
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
    case 'user:new':
      state.users.set(ev.user.id, ev.user);
      break;
    case 'channel:new':
      if (!state.channels.has(ev.channel.id)) state.channels.set(ev.channel.id, ev.channel);
      renderSidebar();
      break;
    case 'message:new': {
      const m = ev.message;
      const channel = state.channels.get(m.channelId);
      if (!channel) {
        resync();
        break;
      }
      if (v?.kind === 'channel' && v.id === m.channelId) {
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
        v.messages = ev.type === 'message:deleted'
          ? v.messages.filter((m) => m.id !== ev.messageId)
          : v.messages.map((m) => (m.id === ev.message.id ? ev.message : m));
        renderMessages(v, { keepScroll: true });
      }
      break;
    case 'page:changed':
      state.pages.set(ev.page.id, ev.page);
      renderSidebar();
      if (v?.kind === 'page' && v.id === ev.page.id && ev.by !== state.me.id) onRemotePageChange(v, ev);
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

document.addEventListener('visibilitychange', () => {
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
        section('Canaux', els.channels, openChannelDialog, 'Créer ou rejoindre un canal'),
        section('Messages privés', els.dms, openDmDialog, 'Nouveau message privé'),
        section('Pages', els.pages, () => createPage(null), 'Nouvelle page')),
      h('div', { class: 'me' },
        avatar(me.id),
        h('div', { class: 'me-info' }, h('strong', {}, me.name), h('span', { class: 'muted small' }, me.role === 'admin' ? 'Administrateur' : 'Membre')),
        me.role === 'admin' && h('button', { class: 'btn small', onclick: createInvite }, 'Inviter'),
        h('button', { class: 'btn small', title: 'Se déconnecter', onclick: logout }, 'Sortir'))),
    h('div', { class: 'backdrop', onclick: closeNav }),
    els.main,
  );
  root.replaceChildren(els.shell);
  renderSidebar();
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

  const channelItem = (c, label) => h('li', {},
    h('a', { href: `#/c/${c.id}`, class: `nav-item${active('channel', c.id) ? ' active' : ''}${c.unread ? ' unread' : ''}` },
      label,
      c.unread > 0 && h('span', { class: 'badge' }, c.unread > 99 ? '99+' : c.unread)));

  els.channels.replaceChildren(...all.filter((c) => !c.isDm && c.joined)
    .map((c) => channelItem(c, h('span', { class: 'label' }, h('span', { class: 'hash' }, '#'), c.name))));

  els.dms.replaceChildren(...all.filter((c) => c.isDm)
    .sort((a, b) => userName(a.dmUserId).localeCompare(userName(b.dmUserId)))
    .map((c) => channelItem(c, h('span', { class: 'label' }, presenceDot(c.dmUserId), userName(c.dmUserId)))));
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

  const unread = all.reduce((n, c) => n + (c.joined ? c.unread : 0), 0);
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
  if ((m = hash.match(/^#\/c\/(\d+)$/))) openChannel(Number(m[1]));
  else if ((m = hash.match(/^#\/p\/(\d+)$/))) openPage(Number(m[1]));
  else if ((m = hash.match(/^#\/search\/(.+)$/))) openSearch(decodeURIComponent(m[1]));
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

async function openChannel(id) {
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
  const v = { kind: 'channel', id, messages: [], hasMore: false, editingId: null, loading: true };
  state.view = v;
  renderSidebar();

  v.head = h('header', { class: 'main-head' });
  v.list = h('div', { class: 'messages', role: 'log' });
  v.composer = renderComposer(v);
  els.main.replaceChildren(v.head, v.list, v.composer);
  renderChannelHeader(v);
  renderMessages(v);
  await reloadMessages(v);
  v.composer.querySelector('textarea')?.focus();
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
  if (!c.isDm) {
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
  try {
    await api('POST', `/channels/${c.id}/leave`);
    c.joined = false;
    c.unread = 0;
    location.hash = '';
  } catch (err) { report(err); }
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
      h('h2', {}, c.isDm ? `Votre conversation avec ${userName(c.dmUserId)}` : `Bienvenue dans #${c.name}`),
      h('p', { class: 'muted' }, 'Aucun message pour l’instant. Lancez la discussion !')));
  }

  let prev = null;
  for (const m of v.messages) {
    if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) {
      nodes.push(h('div', { class: 'day' }, h('span', {}, dayLabel(m.createdAt))));
      prev = null;
    }
    const grouped = prev && prev.userId === m.userId && m.createdAt - prev.createdAt < 5 * 60_000;
    nodes.push(renderMessage(v, m, grouped));
    prev = m;
  }
  list.replaceChildren(...nodes);
  if (!keepScroll && (atBottom || !v.scrolled)) {
    list.scrollTop = list.scrollHeight;
    v.scrolled = v.messages.length > 0;
  }
}

function renderMessage(v, m, grouped) {
  const mine = m.userId === state.me.id;
  const canDelete = mine || state.me.role === 'admin';
  let body;
  if (v.editingId === m.id) {
    const input = h('textarea', { class: 'edit-input', value: m.body, rows: 2 });
    const save = async () => {
      const text = input.value.trim();
      if (!text) return;
      try {
        await api('PATCH', `/messages/${m.id}`, { body: text });
        v.editingId = null;
        renderMessages(v, { keepScroll: true });
      } catch (err) { report(err); }
    };
    const cancel = () => { v.editingId = null; renderMessages(v, { keepScroll: true }); };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      if (e.key === 'Escape') cancel();
    });
    body = h('div', { class: 'edit' }, input,
      h('div', { class: 'edit-actions' },
        h('button', { class: 'btn small', onclick: cancel }, 'Annuler'),
        h('button', { class: 'btn small primary', onclick: save }, 'Enregistrer')));
    queueMicrotask(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  } else {
    body = h('div', { class: 'md', html: renderMarkdown(m.body) });
  }

  return h('article', { class: `message${grouped ? ' grouped' : ''}` },
    grouped ? h('span', { class: 'gutter-time muted' }, timeFmt.format(m.createdAt)) : avatar(m.userId),
    h('div', { class: 'message-body' },
      !grouped && h('div', { class: 'message-meta' },
        h('strong', {}, userName(m.userId)),
        h('time', { class: 'muted small', datetime: new Date(m.createdAt).toISOString(), title: dateTimeFmt.format(m.createdAt) }, timeFmt.format(m.createdAt))),
      body,
      m.editedAt && v.editingId !== m.id && h('span', { class: 'muted small' }, '(modifié)')),
    v.editingId !== m.id && (mine || canDelete) && h('div', { class: 'message-actions' },
      mine && h('button', { class: 'icon-btn', title: 'Modifier', 'aria-label': 'Modifier', onclick: () => { v.editingId = m.id; renderMessages(v, { keepScroll: true }); } }, '✎'),
      canDelete && h('button', { class: 'icon-btn', title: 'Supprimer', 'aria-label': 'Supprimer', onclick: () => deleteMessage(m) }, '🗑')));
}

async function deleteMessage(m) {
  if (!confirm('Supprimer ce message ?')) return;
  try { await api('DELETE', `/messages/${m.id}`); } catch (err) { report(err); }
}

function renderComposer(v) {
  const c = state.channels.get(v.id);
  const input = h('textarea', {
    rows: 1,
    placeholder: `Écrire ${c.isDm ? `à ${userName(c.dmUserId)}` : `dans #${c.name}`}`,
    'aria-label': 'Message',
  });
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  };
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize();
    try {
      const { message } = await api('POST', `/channels/${v.id}/messages`, { body: text });
      if (!c.joined) {
        c.joined = true;
        renderSidebar();
        renderChannelHeader(v);
      }
      if (state.view === v && !v.messages.some((x) => x.id === message.id)) {
        v.messages.push(message);
        renderMessages(v);
      }
      v.list.scrollTop = v.list.scrollHeight;
    } catch (err) {
      input.value = text;
      autosize();
      report(err);
    }
  };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  return h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); send(); } },
    input,
    h('button', { class: 'btn primary', type: 'submit' }, 'Envoyer'),
    h('p', { class: 'muted small hint' }, '**gras**, *italique*, `code`, - liste · Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne'));
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
  const form = h('form', { class: 'stack' },
    h('label', { class: 'field' }, h('span', {}, 'Nom du canal'),
      h('input', { name: 'name', required: true, maxlength: 40, placeholder: 'ex. commercial, projet-alpha' })),
    h('label', { class: 'field' }, h('span', {}, 'Sujet (facultatif)'),
      h('input', { name: 'topic', maxlength: 200, placeholder: 'À quoi sert ce canal ?' })),
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
      const { channel } = await api('POST', '/channels', Object.fromEntries(new FormData(form)));
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
  const people = [...state.users.values()].filter((u) => u.id !== state.me.id);
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

async function createInvite() {
  try {
    const { token, expiresAt } = await api('POST', '/invites');
    const link = `${location.origin}/#/invite/${token}`;
    const input = h('input', { value: link, readonly: true, class: 'mono', 'aria-label': 'Lien d’invitation' });
    dialog('Inviter un collègue',
      h('p', {}, 'Envoyez ce lien à la personne à inviter. Il ne peut servir qu’une fois et expire le ',
        h('strong', {}, dateTimeFmt.format(expiresAt)), '.'),
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
  } catch (err) { report(err); }
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
  v.banner = h('div', { class: 'banner', hidden: true });

  els.main.replaceChildren(
    h('header', { class: 'main-head' },
      navButton(),
      h('nav', { class: 'crumbs small' }, crumbs, h('span', {}, pageTitle({ title: v.title }))),
      h('div', { class: 'head-actions' },
        v.status,
        v.modeBtn = h('button', { class: 'btn small', onclick: () => setMode(v, v.mode === 'edit' ? 'read' : 'edit') }),
        h('button', { class: 'btn small', onclick: () => createPage(page.id) }, '+ Sous-page'),
        canDelete && h('button', { class: 'btn small danger', onclick: () => deletePage(v) }, 'Supprimer'))),
    h('div', { class: 'page-scroll' },
      h('div', { class: 'page' },
        v.banner,
        v.titleInput,
        h('p', { class: 'muted small page-meta' }, `Modifié par ${userName(page.updatedBy)} · ${dateTimeFmt.format(page.updatedAt)}`),
        v.bodyEl,
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
    const area = h('textarea', {
      class: 'page-editor', value: v.content, 'aria-label': 'Contenu de la page',
      placeholder: 'Écrivez ici… (Markdown : # Titre, **gras**, - liste, - [ ] tâche, ``` code ```)',
      oninput: (e) => { v.content = e.target.value; changed(v); autosize(); },
    });
    const autosize = () => {
      area.style.height = 'auto';
      area.style.height = `${Math.max(area.scrollHeight, 300)}px`;
    };
    v.bodyEl.replaceChildren(area);
    queueMicrotask(autosize);
    if (document.activeElement !== v.titleInput) area.focus();
  } else {
    const html = renderMarkdown(v.content);
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
    results.replaceChildren(
      pages.length > 0 && h('section', {}, h('h2', {}, 'Pages'), pages.map((p) => h('a', { class: 'result', href: `#/p/${p.id}` },
        h('strong', {}, '📄 ', pageTitle(p)), h('p', { class: 'muted small' }, p.excerpt)))),
      messages.length > 0 && h('section', {}, h('h2', {}, 'Messages'), messages.map((m) => {
        const c = state.channels.get(m.channelId);
        return h('a', { class: 'result', href: `#/c/${m.channelId}` },
          h('div', { class: 'small' }, h('strong', {}, userName(m.userId)), ' dans ', c ? channelTitle(c) : 'un canal',
            ' · ', h('span', { class: 'muted' }, dateTimeFmt.format(m.createdAt))),
          h('div', { class: 'md', html: renderMarkdown(m.body) }));
      })));
  } catch (err) {
    report(err);
  }
}

boot();
