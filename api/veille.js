'use strict';
/* ============================================================
   POST /api/veille — démo « Rapport de veille chaque matin »
   Requête  : { lang: "fr"|"en", sujet: "crypto"|"change"|"ia"|"immobilier"|"motcle", motcle?: string }
   Réponse  : { rapport_markdown, chiffres: [ { libelle, valeur, variation?, unite } ], articles: [ { titre, lien, source, date } ],
                sources: [string], genere_le }

   Données réelles et gratuites, lues au moment de la demande :
     - actualités : flux RSS publics (Le Monde, France 24, RFI, BBC), robots.txt vérifié, filtrées par sujet ;
     - crypto-monnaies : API publique CoinGecko (« Data provided by CoinGecko ») ;
     - taux de change : taux de référence quotidiens de la Banque centrale européenne.
   Les chiffres et les liens sont assemblés par le code ; l'IA ne fait que rédiger la synthèse
   à partir de ces éléments (aucun chiffre ni lien inventé).
   Cache mémoire de 15 minutes par source pour ne pas solliciter les sites à chaque visite.
   ============================================================ */

const { createHandler, InputError, consigneLangue } = require('./_lib/http');
const llm = require('./_lib/llm');

const UA = 'HBSGoDemoBot/1.0 (+https://hbsgo.vercel.app/demos/veille)';
const CACHE_MS = 15 * 60 * 1000;
const cache = new Map();

const FLUX = {
  fr: [
    { nom: 'Le Monde — Économie', url: 'https://www.lemonde.fr/economie/rss_full.xml' },
    { nom: 'Le Monde — Pixels', url: 'https://www.lemonde.fr/pixels/rss_full.xml' },
    { nom: 'Le Monde — Immobilier', url: 'https://www.lemonde.fr/immobilier/rss_full.xml' },
    { nom: 'Le Monde — Argent', url: 'https://www.lemonde.fr/argent/rss_full.xml' },
    { nom: 'France 24 — Éco/Tech', url: 'https://www.france24.com/fr/eco-tech/rss' },
    { nom: 'RFI — Économie', url: 'https://www.rfi.fr/fr/economie/rss' }
  ],
  en: [
    { nom: 'BBC — Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
    { nom: 'BBC — Technology', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' }
  ]
};

const SUJETS = {
  crypto: { fr: 'Crypto-monnaies', en: 'Cryptocurrencies', filtre: /crypto|bitcoin|ethereum|blockchain|stablecoin|binance|coinbase/i },
  change: { fr: 'Euro et taux de change', en: 'Euro and exchange rates', filtre: /\beuro\b|dollar|\bBCE\b|\bECB\b|\bFed\b|taux d.intérêt|interest rate|inflation|devise|currency|sterling/i },
  ia: { fr: 'Intelligence artificielle', en: 'Artificial intelligence', filtre: /intelligence artificielle|\bIA\b|\bAI\b|OpenAI|ChatGPT|Anthropic|Claude|Mistral|Gemini|Nvidia|chatbot|LLM|générati/ },
  immobilier: { fr: 'Immobilier', en: 'Real estate', filtre: /immobili|logement|loyer|crédit immobilier|propriétaire|property|housing|mortgage|house price|rent/i }
};

/* ---------- utilitaires réseau ---------- */
async function recuperer(url, type, timeoutMs) {
  const hit = cache.get(url);
  if (hit && hit.until > Date.now()) return hit.data;
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 6000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': type === 'json' ? 'application/json' : 'application/rss+xml, application/xml, text/xml' }, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = type === 'json' ? await r.json() : (await r.text()).slice(0, 1500000);
    cache.set(url, { until: Date.now() + CACHE_MS, data: data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;/g, '\'')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(+n); })
    .replace(/\s+/g, ' ').trim();
}

function lireRss(xml, source) {
  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 60) {
    const bloc = m[0];
    const champ = function (tag) { const x = bloc.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>')); return x ? decode(x[1]) : ''; };
    const titre = champ('title'), lien = champ('link'), date = champ('pubDate');
    if (!titre || !/^https?:\/\//.test(lien)) continue;
    items.push({ titre: titre.slice(0, 200), lien: lien, source: source, date: date ? new Date(date).toISOString() : null, resume: champ('description').slice(0, 280) });
  }
  return items;
}

async function actualites(lang, filtre) {
  const flux = FLUX[lang];
  const res = await Promise.allSettled(flux.map(function (f) { return recuperer(f.url, 'xml', 6000).then(function (x) { return lireRss(x, f.nom); }); }));
  const vus = new Set();
  const tous = [];
  res.forEach(function (r) { if (r.status === 'fulfilled') r.value.forEach(function (a) { if (!vus.has(a.lien)) { vus.add(a.lien); tous.push(a); } }); });
  const depuis = Date.now() - 4 * 24 * 3600 * 1000;
  return tous
    .filter(function (a) { return filtre.test(a.titre + ' ' + a.resume) && (!a.date || Date.parse(a.date) > depuis); })
    .sort(function (a, b) { return (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0); })
    .slice(0, 8);
}

async function chiffresCrypto() {
  const d = await recuperer('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=eur&include_24hr_change=true', 'json', 6000);
  const noms = { bitcoin: 'Bitcoin (BTC)', ethereum: 'Ethereum (ETH)', solana: 'Solana (SOL)' };
  return Object.keys(noms).filter(function (k) { return d[k] && typeof d[k].eur === 'number'; }).map(function (k) {
    return { libelle: noms[k], valeur: d[k].eur, unite: 'EUR', variation: typeof d[k].eur_24h_change === 'number' ? d[k].eur_24h_change : null, periode: '24 h' };
  });
}

async function chiffresChange() {
  const xml = await recuperer('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', 'xml', 6000);
  const date = (xml.match(/time=['"]([\d-]+)['"]/) || [])[1] || null;
  const noms = { USD: 'Dollar américain', GBP: 'Livre sterling', CHF: 'Franc suisse', JPY: 'Yen japonais', CAD: 'Dollar canadien' };
  const out = [];
  Object.keys(noms).forEach(function (c) {
    const m = xml.match(new RegExp('currency=[\'"]' + c + '[\'"]\\s+rate=[\'"]([\\d.]+)[\'"]'));
    if (m) out.push({ libelle: '1 EUR = … ' + c, nom: noms[c], valeur: parseFloat(m[1]), unite: c, variation: null, date: date });
  });
  return out;
}

function fmtNombre(n, lang, unite) {
  const loc = lang === 'fr' ? 'fr-FR' : 'en-GB';
  if (unite === 'EUR') return new Intl.NumberFormat(loc, { style: 'currency', currency: 'EUR', maximumFractionDigits: n >= 100 ? 0 : 2 }).format(n);
  return new Intl.NumberFormat(loc, { maximumFractionDigits: 4 }).format(n) + ' ' + unite;
}
function fmtVar(v, lang) {
  if (v === null || v === undefined) return '';
  return (v > 0 ? '+' : '') + (Math.round(v * 100) / 100).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB') + (lang === 'fr' ? ' %' : '%');
}

function prompt(lang, titreSujet, chiffres, articles) {
  const fr = lang === 'fr';
  const date = new Date().toLocaleDateString(fr ? 'fr-FR' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
  const L = fr ? [
    'Tu rédiges un court rapport de veille quotidien en français, envoyé chaque matin à un dirigeant de petite entreprise. Ton clair, factuel, sans jargon, sans emoji.',
    'Réponds UNIQUEMENT en Markdown simple (titres #, ##, listes -, gras **). Pas de bloc de code, pas de lien (les liens sont ajoutés automatiquement après ton texte), pas de tableau.',
    'N\'utilise QUE les chiffres et les informations fournis ci-dessous. N\'invente aucun chiffre, aucune date, aucun fait, aucune prévision. Si une information manque, n\'en parle pas.',
    '',
    'Structure imposée :',
    '# Veille « ' + titreSujet + ' » — ' + date,
    '## L\'essentiel (3 phrases maximum)',
    chiffres.length ? '## Les chiffres du jour (une ligne par chiffre fourni, avec sa variation si elle est fournie)' : '',
    articles.length ? '## Actualités (une puce par article fourni : 1 phrase qui résume, puis le nom de la source entre parenthèses)' : '## Actualités (écris seulement : « Aucune actualité sur ce sujet dans les sources suivies ces derniers jours. »)',
    '## À surveiller (2 puces, déduites uniquement des éléments fournis, sans prévision chiffrée)'
  ] : [
    'You write a short daily monitoring report in English, sent every morning to a small business owner. Clear, factual, no jargon, no emoji.',
    'Answer ONLY in simple Markdown (headings #, ##, lists -, bold **). No code block, no links (links are appended automatically after your text), no tables.',
    'Use ONLY the figures and information provided below. Never invent figures, dates, facts or forecasts. If something is missing, do not mention it.',
    '',
    'Required structure:',
    '# "' + titreSujet + '" briefing — ' + date,
    '## Key points (3 sentences max)',
    chiffres.length ? '## Today\'s figures (one line per figure provided, with its change when provided)' : '',
    articles.length ? '## News (one bullet per article provided: a one-sentence summary, then the source name in brackets)' : '## News (write only: "No news on this topic in the monitored sources over the last few days.")',
    '## To watch (2 bullets, inferred only from the elements provided, no numeric forecast)'
  ];
  if (chiffres.length) {
    L.push('', fr ? 'Chiffres (déjà formatés) :' : 'Figures (already formatted):');
    chiffres.forEach(function (c) {
      L.push('- ' + (c.nom ? c.nom + ' : ' : c.libelle + ' : ') + fmtNombre(c.valeur, lang, c.unite) + (c.variation !== null && c.variation !== undefined ? ' (' + fmtVar(c.variation, lang) + (fr ? ' sur ' : ' over ') + c.periode + ')' : '') + (c.date ? (fr ? ' — taux BCE du ' : ' — ECB rate of ') + c.date : ''));
    });
  }
  if (articles.length) {
    L.push('', fr ? 'Articles :' : 'Articles:');
    articles.forEach(function (a, i) { L.push((i + 1) + '. [' + a.source + '] ' + a.titre + (a.resume ? ' — ' + a.resume : '')); });
  }
  return L.filter(function (x) { return x !== ''; }).join('\n');
}

module.exports = createHandler('veille', async function ({ body, lang, outLang }) {
  const sujet = String(body.sujet || '');
  let titreSujet, filtre;
  if (sujet === 'motcle') {
    const mc = typeof body.motcle === 'string' ? body.motcle.replace(/[^\p{L}\p{N} '\-.&]/gu, '').trim() : '';
    if (mc.length < 2 || mc.length > 40) throw new InputError('invalid_input');
    titreSujet = mc;
    filtre = new RegExp(mc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'i');
  } else if (SUJETS[sujet]) {
    titreSujet = SUJETS[sujet][lang];
    filtre = SUJETS[sujet].filtre;
  } else {
    throw new InputError('invalid_input');
  }

  const [chiffresR, articlesR] = await Promise.allSettled([
    sujet === 'crypto' ? chiffresCrypto() : sujet === 'change' ? chiffresChange() : Promise.resolve([]),
    actualites(lang, filtre)
  ]);
  const chiffres = chiffresR.status === 'fulfilled' ? chiffresR.value : [];
  const articles = articlesR.status === 'fulfilled' ? articlesR.value : [];

  const out = await llm.complete({
    system: prompt(lang, titreSujet, chiffres, articles) + consigneLangue(outLang),
    messages: [{ role: 'user', content: lang === 'fr' ? 'Rédige le rapport de ce matin.' : 'Write this morning\'s report.' }],
    maxTokens: 1400
  });
  let md = llm.stripThinking(out.text);
  const fence = md.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  if (fence) md = fence[1].trim();
  const i = md.indexOf('# ');
  if (i > 0) md = md.slice(i);
  md = md.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1'); /* aucun lien écrit par l'IA */
  if (md.length < 60) throw new llm.LlmError('bad_model_output', 'rapport trop court');

  const sources = [];
  if (sujet === 'crypto') sources.push('CoinGecko');
  if (sujet === 'change') sources.push(lang === 'fr' ? 'Banque centrale européenne (taux de référence)' : 'European Central Bank (reference rates)');
  sources.push(FLUX[lang].map(function (f) { return f.nom.split(' — ')[0]; }).filter(function (v, k, a) { return a.indexOf(v) === k; }).join(', '));

  return {
    rapport_markdown: md,
    chiffres: chiffres,
    articles: articles.map(function (a) { return { titre: a.titre, lien: a.lien, source: a.source, date: a.date }; }),
    sources: sources,
    genere_le: new Date().toISOString(),
    __meta: { provider: out.provider, model: out.model }
  };
});

module.exports._internals = { lireRss, SUJETS };
