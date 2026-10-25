// Rendu Markdown minimal et sûr : tout le HTML saisi est échappé avant mise en forme,
// et seuls les liens http(s), mailto et internes (#/...) sont autorisés.

const escapeHtml = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const SAFE_URL = /^(https?:\/\/|mailto:|#\/)/i;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionCache = new Map();

// « @Prénom Nom » ou « @tous », précédé d'un début de ligne ou d'un caractère non alphanumérique.
// Utilisé aussi par le serveur pour savoir qui notifier.
export function mentionRegex(names) {
  const key = names.join('\u0001');
  if (!mentionCache.has(key)) {
    const alternatives = [...names].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
    mentionCache.set(key, new RegExp(`(^|[^\\p{L}\\p{N}_])@(${alternatives})(?![\\p{L}\\p{N}_])`, 'giu'));
  }
  const re = mentionCache.get(key);
  re.lastIndex = 0;
  return re;
}

function inline(raw, opts) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  let s = raw.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => (SAFE_URL.test(url)
    ? keep(`<a href="${escapeHtml(url)}"${url.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"'}>${escapeHtml(label)}</a>`)
    : m));
  if (opts.mentions?.length) {
    s = s.replace(mentionRegex(opts.mentions), (m, before, name) => {
      const self = opts.me && name.toLowerCase() === opts.me.toLowerCase();
      return before + keep(`<span class="mention${self ? ' mention-self' : ''}">@${escapeHtml(name)}</span>`);
    });
  }
  s = s.replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (url) => keep(
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`,
  ));

  s = escapeHtml(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

// opts.mentions : noms à mettre en évidence après un « @ » ; opts.me : nom de la personne connectée.
export function renderMarkdown(source = '', opts = {}) {
  const fmt = (text) => inline(text, opts);
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let list = null; // { tag, items }

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(fmt).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`);
    list = null;
  };
  const flush = () => { flushParagraph(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flush();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flush();
      out.push(`<h${m[1].length}>${fmt(m[2])}</h${m[1].length}>`);
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      out.push('<hr>');
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flush();
      out.push(`<blockquote>${fmt(m[1])}</blockquote>`);
    } else if ((m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/))) {
      flushParagraph();
      if (list?.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      const checked = m[1] !== ' ';
      list.items.push(`<li class="task${checked ? ' done' : ''}"><input type="checkbox" disabled${checked ? ' checked' : ''}> ${fmt(m[2])}</li>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushParagraph();
      if (list?.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(`<li>${fmt(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushParagraph();
      if (list?.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(`<li>${fmt(m[1])}</li>`);
    } else if (line.trim() === '') {
      flush();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flush();
  return out.join('\n');
}
