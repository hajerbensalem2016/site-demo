'use strict';
/* ============================================================
   POST /api/scraping — démo « Scraping & veille de prix » en direct
   Requête  : { lang: "fr"|"en", url: "https://…" }
   Réponse  : { ok: true, source, url, methode: "json-ld"|"ia", resultats: [ { titre, prix, devise, note, lien } ], message }

   Le visiteur colle l'URL d'une page (catalogue, catégorie, fiche produit) :
     1. l'URL est vérifiée (http/https, ports 80/443, aucune adresse interne ou privée, redirections re-vérifiées) ;
     2. le fichier robots.txt du site est lu et respecté ;
     3. UNE seule page est téléchargée (1,5 Mo max, 8 s max), jamais le reste du site ;
     4. les produits sont extraits des données structurées (JSON-LD schema.org) si la page en publie,
        sinon l'IA (Groq / Gemini, voir _lib/llm.js) les lit dans le texte de la page.
   Limitation par IP : 20 requêtes / heure (voir _lib/ratelimit.js), plus 5 tests / jour côté navigateur.
   ============================================================ */

const dns = require('dns').promises;
const net = require('net');
const { createHandler, InputError } = require('./_lib/http');
const llm = require('./_lib/llm');

const USER_AGENT = 'HBSGoDemoBot/1.0 (+https://hbsgo.vercel.app/demos/scraping)';
const BOT_TOKEN = 'hbsgodemobot';
const MAX_PAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 256 * 1024;
const PAGE_TIMEOUT_MS = 8000;
const ROBOTS_TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 4;
const MAX_TEXT_CHARS = 9000;
const MAX_ITEMS = 30;
/* Grandes plateformes dont les conditions d'utilisation interdisent la collecte automatique : refusées d'office. */
const PLATEFORMES_INTERDITES = /(^|\.)(amazon|temu|shein|aliexpress|alibaba|ebay|leboncoin|vinted|facebook|instagram|linkedin|tiktok|x|twitter|booking|airbnb|zalando|cdiscount|fnac|walmart|etsy)\.[a-z.]+$/i;

/* ---------- 1. validation de l'URL (anti-SSRF) ---------- */
function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19));
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const s = ip.toLowerCase();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8');
}

function parsePublicUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { throw new InputError('invalid_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new InputError('invalid_url');
  if (u.username || u.password) throw new InputError('invalid_url');
  if (u.port && u.port !== '80' && u.port !== '443') throw new InputError('forbidden_host');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !net.isIP(host)) {
    throw new InputError('forbidden_host');
  }
  u.hash = '';
  return u;
}

async function assertPublicHost(u) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else {
    try { addrs = await dns.lookup(host, { all: true, verbatim: true }); } catch (e) { throw new InputError('fetch_failed'); }
  }
  if (!addrs.length || addrs.some(function (a) { return isPrivateIp(a.address); })) throw new InputError('forbidden_host');
}

/* ---------- 2. téléchargement borné (taille, durée, redirections re-vérifiées) ---------- */
async function readCapped(res, maxBytes) {
  if (!res.body || !res.body.getReader) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { try { await reader.cancel(); } catch (e) { /* ignore */ } break; }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(function (c) { return Buffer.from(c); })).toString('utf8');
}

async function safeFetch(startUrl, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, opts.timeoutMs);
  try {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicHost(url);
      let res;
      try {
        res = await fetch(url.href, {
          redirect: 'manual',
          signal: ctrl.signal,
          headers: { 'User-Agent': USER_AGENT, 'Accept': opts.accept, 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' }
        });
      } catch (e) {
        throw new InputError('fetch_failed');
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = parsePublicUrl(new URL(res.headers.get('location'), url).href);
        continue;
      }
      const text = await readCapped(res, opts.maxBytes);
      return { status: res.status, url: url, type: String(res.headers.get('content-type') || ''), text: text, headers: res.headers };
    }
    throw new InputError('fetch_failed');
  } catch (e) {
    if (e && e.name === 'InputError') throw e;
    throw new InputError('fetch_failed');
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 3. robots.txt ---------- */
function robotsRules(txt) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  String(txt).split(/\r?\n/).forEach(function (line) {
    const l = line.replace(/#.*/, '').trim();
    const m = l.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) return;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: val });
  });
  const mine = groups.filter(function (g) { return g.agents.some(function (a) { return a !== '*' && BOT_TOKEN.indexOf(a) === 0; }); });
  const chosen = mine.length ? mine : groups.filter(function (g) { return g.agents.indexOf('*') !== -1; });
  return [].concat.apply([], chosen.map(function (g) { return g.rules; }));
}

function robotsAllows(rules, pathAndQuery) {
  let best = null;
  rules.forEach(function (r) {
    if (!r.path) return; /* "Disallow:" vide = tout est permis */
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(pathAndQuery)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  });
  return !best || best.allow;
}

async function checkRobots(u) {
  try {
    const r = await safeFetch(new URL('/robots.txt', u.origin), { timeoutMs: ROBOTS_TIMEOUT_MS, maxBytes: MAX_ROBOTS_BYTES, accept: 'text/plain,*/*' });
    if (r.status !== 200) return true; /* pas de robots.txt : collecte permise */
    return robotsAllows(robotsRules(r.text), u.pathname + u.search);
  } catch (e) {
    return true; /* robots.txt injoignable : on ne bloque pas la démo */
  }
}

/* ---------- 4. extraction ---------- */
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, '\'').replace(/&euro;/g, '€').replace(/&pound;/g, '£')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(+n); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCodePoint(parseInt(n, 16)); });
}

function toNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  let s = String(v).replace(/[^\d.,-]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

/** Produits publiés en JSON-LD (schema.org Product / ItemList) : fiable et sans IA. */
function jsonLdProducts(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  function visit(node) {
    if (!node || typeof node !== 'object' || out.length >= MAX_ITEMS) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const type = [].concat(node['@type'] || []).join(' ');
    if (/\bProduct\b/.test(type)) {
      const offers = [].concat(node.offers || [])[0] || {};
      const price = toNumber(offers.price !== undefined ? offers.price : offers.lowPrice);
      const rating = node.aggregateRating && toNumber(node.aggregateRating.ratingValue);
      const best = node.aggregateRating && toNumber(node.aggregateRating.bestRating);
      if (node.name && price !== null) {
        out.push({
          titre: String(node.name), prix: price, devise: offers.priceCurrency || null,
          note: rating !== null && rating !== undefined ? (best && best !== 5 ? rating * 5 / best : rating) : null,
          lien: node.url || offers.url || null
        });
      }
    }
    Object.keys(node).forEach(function (k) { if (k !== 'offers' && typeof node[k] === 'object') visit(node[k]); });
  }
  while ((m = re.exec(html))) {
    try { visit(JSON.parse(m[1].trim())); } catch (e) { /* JSON-LD invalide : ignoré */ }
  }
  return out;
}

/** Texte lisible de la page, avec les liens notés [→url] pour que l'IA puisse les rendre. */
function pageText(html) {
  let s = String(html)
    .replace(/<(script|style|noscript|svg|template|iframe|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, function (_, href, inner) {
      const txt = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return txt.length >= 3 ? ' ' + txt + ' [→' + href + '] ' : ' ' + txt + ' ';
    })
    .replace(/<img\s[^>]*alt=["']([^"']{3,})["'][^>]*>/gi, ' $1 ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d|\/article|\/section)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
  return s.slice(0, MAX_TEXT_CHARS);
}

function looksBlocked(r) {
  if ([401, 403, 429, 503].indexOf(r.status) !== -1) return true;
  if (r.headers.get('cf-mitigated')) return true;
  return /cf-browser-verification|challenge-platform|captcha|are you a robot|access denied|robot check|enable javascript and cookies/i.test(r.text.slice(0, 20000)) && r.text.length < 60000;
}

function extractionPrompt(lang, url) {
  return [
    'You extract structured product or listing data from the text of ONE web page (' + url + ').',
    'Return ONLY a JSON object: {"items":[{"titre":string,"prix":number,"devise":"EUR"|"USD"|"GBP"|string|null,"note":number|null,"lien":string|null}]}',
    'Rules:',
    '- One item per product, offer or listing that has a visible price. At most ' + MAX_ITEMS + ' items, in page order. Skip items without a price.',
    '- "titre": the product name as written on the page (short, no marketing text).',
    '- "prix": the current selling price as a plain number (dot decimal), no currency symbol. If both an old and a new price appear, take the new one.',
    '- "devise": ISO currency code deduced from the symbol (€ = EUR, $ = USD, £ = GBP), or null.',
    '- "note": customer rating converted to a 0-5 scale if shown, else null. Never invent a rating.',
    '- "lien": the URL written in [→...] right after the product name, if any, else null.',
    '- NEVER invent products, prices or links that are not in the text. If the page shows no priced product, return {"items":[]}.',
    lang === 'fr' ? 'Keep product names in their original language.' : 'Keep product names in their original language.'
  ].join('\n');
}

function cleanItems(items, baseUrl, host) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).map(function (it) {
    if (!it || typeof it !== 'object') return null;
    const titre = String(it.titre || it.name || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const prix = toNumber(it.prix);
    if (!titre || prix === null || prix <= 0 || prix > 1e7) return null;
    let note = toNumber(it.note);
    if (note !== null && (note < 0 || note > 5)) note = null;
    let lien = baseUrl.href;
    try {
      if (it.lien) {
        const l = new URL(String(it.lien), baseUrl);
        if (l.protocol === 'http:' || l.protocol === 'https:') lien = l.href;
      }
    } catch (e) { /* lien invalide : page source */ }
    const devise = /^[A-Z]{3}$/.test(String(it.devise || '').toUpperCase()) ? String(it.devise).toUpperCase() : null;
    const key = titre.toLowerCase() + '|' + prix;
    if (seen.has(key)) return null;
    seen.add(key);
    return { titre: titre + ' — ' + host, prix: Math.round(prix * 100) / 100, devise: devise, note: note === null ? null : Math.round(note * 10) / 10, lien: lien };
  }).filter(Boolean).slice(0, MAX_ITEMS);
}

module.exports = createHandler('scraping', async function ({ body, lang }) {
  const start = parsePublicUrl(body.url);
  if (String(body.url).length > 500) throw new InputError('invalid_url');
  if (PLATEFORMES_INTERDITES.test(start.hostname)) throw new InputError('site_blocked');

  if (!(await checkRobots(start))) throw new InputError('robots_disallowed');

  const page = await safeFetch(start, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: MAX_PAGE_BYTES, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' });
  if (looksBlocked(page)) throw new InputError('site_blocked');
  if (page.status >= 400) throw new InputError('fetch_failed');
  if (page.type && !/html|xml/i.test(page.type)) throw new InputError('not_html');
  if (page.url.href !== start.href && PLATEFORMES_INTERDITES.test(page.url.hostname)) throw new InputError('site_blocked');
  if (page.url.href !== start.href && !(await checkRobots(page.url))) throw new InputError('robots_disallowed');

  const host = page.url.hostname.replace(/^www\./, '');
  let methode = 'json-ld';
  let items = cleanItems(jsonLdProducts(page.text), page.url, host);
  let meta = {};

  if (items.length < 3) {
    const text = pageText(page.text);
    if (text.length < 80) throw new InputError('site_blocked'); /* page vide : site 100 % JavaScript ou anti-bot */
    const out = await llm.complete({
      system: extractionPrompt(lang, page.url.href),
      messages: [{ role: 'user', content: text }],
      json: true,
      maxTokens: 2500
    });
    const fromAi = cleanItems((llm.parseJson(out.text) || {}).items, page.url, host);
    if (fromAi.length > items.length) { items = fromAi; methode = 'ia'; }
    meta = { provider: out.provider, model: out.model };
  }

  const n = items.length;
  const message = n
    ? (lang === 'fr'
      ? n + ' produit' + (n > 1 ? 's' : '') + ' collecté' + (n > 1 ? 's' : '') + ' sur ' + host + (methode === 'ia' ? ' (extraction par IA).' : ' (données structurées de la page).')
      : n + ' product' + (n > 1 ? 's' : '') + ' collected from ' + host + (methode === 'ia' ? ' (AI extraction).' : ' (page structured data).'))
    : (lang === 'fr'
      ? 'Page lue, mais aucun produit avec un prix n\'a été trouvé sur ' + host + '. Essayez une page catalogue ou catégorie.'
      : 'Page read, but no priced product was found on ' + host + '. Try a catalogue or category page.');

  return { ok: true, source: host, url: page.url.href, methode: methode, resultats: items, message: message, __meta: meta };
});

/* exports pour les tests locaux (node api/_test.mjs) */
module.exports._internals = { parsePublicUrl, isPrivateIp, robotsRules, robotsAllows, jsonLdProducts, pageText, cleanItems, toNumber };
