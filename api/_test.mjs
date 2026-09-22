/* ============================================================
   api/_test.mjs — tests locaux des fonctions serverless, sans serveur
   Lancer :  cd site-demo && node api/_test.mjs
   - Sans clé API : CORS/OPTIONS, méthode, validation des entrées (FR/EN),
     limitation par IP, extraction JSON, réponse 503 « no_provider ».
   - Avec GEMINI_API_KEY (ou GROQ_API_KEY) dans l'environnement : un appel
     réel par route, vérification que la sortie est un JSON valide au bon format.
   Le fichier commence par « _ » : Vercel ne le déploie pas comme fonction.
   ============================================================ */
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const chat = require('./chat.js');
const agentEmail = require('./agent-email.js');
const rapport = require('./rapport.js');
const http = require('./_lib/http.js');
const llm = require('./_lib/llm.js');
const ratelimit = require('./_lib/ratelimit.js');

/* ---------- mini harnais ---------- */
let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  OK   ' + label); }
  else { failed++; console.log('  FAIL ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 300) : '')); }
}
function section(t) { console.log('\n' + t); }

let ipCounter = 0;
function freshIp() { ipCounter++; return '10.0.' + Math.floor(ipCounter / 250) + '.' + (ipCounter % 250); }

/** Simule req/res Node : le corps est fourni soit via req.body (comme Vercel), soit en flux. */
function call(handler, { method = 'POST', body, rawBody, headers = {}, ip } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.headers = Object.assign({ 'x-forwarded-for': ip || freshIp(), 'content-type': 'application/json' }, headers);
    req.socket = { remoteAddress: '127.0.0.1' };
    if (body !== undefined) req.body = body;
    req.destroy = () => {};

    const res = { statusCode: 200, headers: {}, body: '' };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.end = (chunk) => {
      if (chunk) res.body += chunk;
      let json = null;
      try { json = res.body ? JSON.parse(res.body) : null; } catch (e) { json = { __invalid_json: res.body }; }
      resolve({ status: res.statusCode, headers: res.headers, json });
    };

    Promise.resolve().then(() => handler(req, res)).catch(reject);
    if (rawBody !== undefined) {
      setImmediate(() => { req.emit('data', Buffer.from(rawBody, 'utf8')); req.emit('end'); });
    }
  });
}

/* ---------- 1. OPTIONS / CORS / méthode ---------- */
section('1. CORS, OPTIONS et méthode');
{
  const r = await call(chat, { method: 'OPTIONS' });
  ok(r.status === 204, 'OPTIONS -> 204', r.status);
  ok(r.headers['access-control-allow-origin'] === '*', 'OPTIONS -> Access-Control-Allow-Origin: * (ALLOWED_ORIGIN non défini)', r.headers);
  ok(/POST/.test(r.headers['access-control-allow-methods'] || ''), 'OPTIONS -> Allow-Methods contient POST');
  ok(/Content-Type/.test(r.headers['access-control-allow-headers'] || ''), 'OPTIONS -> Allow-Headers contient Content-Type');

  const g = await call(chat, { method: 'GET' });
  ok(g.status === 405 && g.json && g.json.error === 'method_not_allowed', 'GET -> 405 method_not_allowed', g.json);
  ok(g.headers['access-control-allow-origin'] === '*', '405 porte les en-têtes CORS');

  const saved = process.env.ALLOWED_ORIGIN;
  process.env.ALLOWED_ORIGIN = 'https://demo.example.com';
  const a = await call(chat, { method: 'OPTIONS', headers: { origin: 'https://demo.example.com' } });
  ok(a.headers['access-control-allow-origin'] === 'https://demo.example.com', 'ALLOWED_ORIGIN : origine autorisée renvoyée', a.headers);
  const b = await call(chat, { method: 'OPTIONS', headers: { origin: 'https://evil.example.org' } });
  ok(b.headers['access-control-allow-origin'] === undefined, 'ALLOWED_ORIGIN : origine inconnue -> pas d\'en-tête Allow-Origin', b.headers);
  if (saved === undefined) delete process.env.ALLOWED_ORIGIN; else process.env.ALLOWED_ORIGIN = saved;
}

/* ---------- 2. Validation des entrées, messages bilingues ---------- */
section('2. Validation des entrées (FR / EN)');
{
  const r1 = await call(chat, { rawBody: '{ pas du json' });
  ok(r1.status === 400 && r1.json.error === 'bad_json', 'corps non JSON -> 400 bad_json', r1.json);
  ok(r1.json.message === http.MESSAGES.fr.bad_json, 'message d\'erreur en français par défaut', r1.json);

  const r2 = await call(chat, { body: { lang: 'en' } });
  ok(r2.status === 400 && r2.json.error === 'invalid_input', 'chat sans messages -> 400 invalid_input', r2.json);
  ok(r2.json.message === http.MESSAGES.en.invalid_input, 'message d\'erreur en anglais quand lang = "en"', r2.json);

  const r3 = await call(chat, { body: { lang: 'fr', messages: [{ role: 'system', content: 'x' }] } });
  ok(r3.status === 400, 'chat avec rôle interdit -> 400', r3.json);

  const r4 = await call(chat, { body: { lang: 'fr', messages: [{ role: 'assistant', content: 'Bonjour' }] } });
  ok(r4.status === 400, 'chat dont le dernier message n\'est pas "user" -> 400', r4.json);

  const r5 = await call(chat, { body: { lang: 'fr', messages: [{ role: 'user', content: 'a'.repeat(4001) }] } });
  ok(r5.status === 400 && r5.json.error === 'too_long', 'chat > 4000 caractères -> 400 too_long', r5.json);

  const e1 = await call(agentEmail, { body: { lang: 'fr', email: 'trop court' } });
  ok(e1.status === 400 && e1.json.error === 'invalid_input', 'agent-email trop court -> 400', e1.json);
  const e2 = await call(agentEmail, { body: { lang: 'en', email: 'x'.repeat(5000) } });
  ok(e2.status === 400 && e2.json.error === 'too_long' && e2.json.message === http.MESSAGES.en.too_long, 'agent-email > 4000 -> 400 too_long (EN)', e2.json);
  const e3 = await call(agentEmail, { body: { lang: 'fr', email: 12345 } });
  ok(e3.status === 400, 'agent-email non-string -> 400', e3.json);

  const p1 = await call(rapport, { body: { lang: 'fr', ca: -5, depenses: 10, clients: 3 } });
  ok(p1.status === 400 && p1.json.error === 'invalid_input', 'rapport ca négatif -> 400', p1.json);
  const p2 = await call(rapport, { body: { lang: 'fr', ca: 'abc', depenses: 10, clients: 3 } });
  ok(p2.status === 400, 'rapport ca non numérique -> 400', p2.json);
  const p3 = await call(rapport, { body: { lang: 'fr', ca: 100, depenses: 10 } });
  ok(p3.status === 400, 'rapport clients manquant -> 400', p3.json);
  const p4 = await call(rapport, { body: { lang: 'fr', ca: 1e15, depenses: 10, clients: 3 } });
  ok(p4.status === 400, 'rapport valeur absurde (1e15) -> 400', p4.json);

  const j = await call(chat, { rawBody: JSON.stringify({ lang: 'en', messages: [] }) });
  ok(j.status === 400 && j.json.message === http.MESSAGES.en.invalid_input, 'corps lu depuis le flux (sans req.body) -> même validation', j.json);
}

/* ---------- 3. Limitation par IP ---------- */
section('3. Limitation par IP (20 / heure)');
{
  const ip = '203.0.113.7';
  let last = null;
  for (let i = 0; i < 20; i++) last = await call(agentEmail, { ip, body: { lang: 'fr', email: 'x' } });
  ok(last.status === 400, '20 premières requêtes acceptées (ici refusées par la validation, pas par le quota)', last.status);
  ok(last.headers['x-ratelimit-remaining'] === '0', 'X-RateLimit-Remaining = 0 après la 20e', last.headers['x-ratelimit-remaining']);
  const r21 = await call(agentEmail, { ip, body: { lang: 'en', email: 'x' } });
  ok(r21.status === 429 && r21.json.error === 'rate_limited', '21e requête -> 429 rate_limited', r21.json);
  ok(r21.json.message === http.MESSAGES.en.rate_limited, '429 : message en anglais quand Accept-Language / lang = en', r21.json);
  ok(Number(r21.headers['retry-after']) > 0 && Number(r21.headers['retry-after']) <= 3600, '429 : en-tête Retry-After présent (<= 3600 s)', r21.headers['retry-after']);
  const shared = await call(chat, { ip, body: { lang: 'fr', messages: [] } });
  ok(shared.status === 429, 'le compteur est partagé entre les routes (chat bloqué aussi)', shared.status);
  const other = await call(chat, { ip: '203.0.113.8', body: { lang: 'fr', messages: [] } });
  ok(other.status === 400, 'une autre IP n\'est pas affectée', other.status);

  /* fenêtre glissante : test direct du module avec une horloge simulée */
  ratelimit.reset();
  const req = { headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' } };
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) ratelimit.check(req, { limit: 3, windowMs: 1000, now: t0 + i });
  const blocked = ratelimit.check(req, { limit: 3, windowMs: 1000, now: t0 + 500 });
  ok(!blocked.ok && blocked.retryAfter === 1, 'module : 4e appel bloqué, retryAfter = 1 s', blocked);
  const later = ratelimit.check(req, { limit: 3, windowMs: 1000, now: t0 + 1001 });
  ok(later.ok && later.remaining === 1, 'module : après la fenêtre, les anciennes requêtes expirent', later);
  ok(blocked.ip === '198.51.100.1', 'module : première IP de x-forwarded-for utilisée', blocked.ip);
  ratelimit.reset();
}

/* ---------- 4. Extraction JSON des réponses de modèle ---------- */
section('4. Extraction JSON (llm.parseJson)');
{
  ok(llm.parseJson('{"a":1}').a === 1, 'JSON brut');
  ok(llm.parseJson('Voici :\n```json\n{"a":2}\n```\nmerci').a === 2, 'JSON dans un bloc ```json');
  ok(llm.parseJson('<think>blabla</think> texte {"a":3, "b":"}"} fin').b === '}', 'JSON entouré de texte et de <think>');
  let threw = false;
  try { llm.parseJson('pas de json ici'); } catch (e) { threw = e.name === 'LlmError' && e.code === 'bad_model_output'; }
  ok(threw, 'texte sans JSON -> LlmError bad_model_output');
}

/* ---------- 5. Sans clé : 503 no_provider ; avec clé : appels réels ---------- */
const hasKey = !!(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY);
const VALID = {
  chat: { lang: 'fr', messages: [{ role: 'assistant', content: 'Bonjour ! Je suis l\'assistant de l\'agence.' }, { role: 'user', content: 'Quels services proposez-vous et à quel prix ?' }] },
  email: { lang: 'en', email: 'Hi,\n\nI ordered the ANC Pro headphones 10 days ago (order #48213) and still have not received them. Tracking has not moved since Tuesday. This is urgent, it is a gift for Saturday. What can you do?\n\nRegards,\nMark Dell' },
  rapport: { lang: 'fr', ca: 48200, depenses: 31500, clients: 37 }
};

if (!hasKey) {
  section('5. Aucune clé API dans l\'environnement -> les routes répondent 503 no_provider');
  const providers = llm.providersConfigured();
  ok(providers.length === 0, 'llm.providersConfigured() vide', providers);
  for (const [name, h, body] of [['chat', chat, VALID.chat], ['agent-email', agentEmail, VALID.email], ['rapport', rapport, VALID.rapport]]) {
    const r = await call(h, { body });
    ok(r.status === 503 && r.json.error === 'no_provider', name + ' valide sans clé -> 503 no_provider (le front bascule en mode hors ligne)', r.json);
  }
  console.log('\n  (Définissez GEMINI_API_KEY ou GROQ_API_KEY pour tester les appels réels.)');
} else {
  section('5. Appels réels (' + llm.providersConfigured().map(p => p.name).join(' > ') + ')');
  const c = await call(chat, { body: VALID.chat });
  ok(c.status === 200 && typeof c.json.reply === 'string' && c.json.reply.length > 10, 'chat -> 200 { reply } via ' + c.headers['x-llm-provider'] + '/' + c.headers['x-llm-model'], c.json);
  if (c.json && c.json.reply) console.log('       reply: ' + c.json.reply.slice(0, 200).replace(/\n/g, ' '));

  const e = await call(agentEmail, { body: VALID.email });
  ok(e.status === 200 && e.json.categorie && ['high', 'medium', 'low'].includes(e.json.urgence) && e.json.resume && e.json.reponse_proposee,
    'agent-email (en) -> 200 { categorie, urgence, resume, reponse_proposee } via ' + e.headers['x-llm-provider'] + '/' + e.headers['x-llm-model'], e.json);
  if (e.json && e.json.categorie) console.log('       ' + e.json.categorie + ' / ' + e.json.urgence + ' / ' + String(e.json.resume).slice(0, 120));

  const efr = await call(agentEmail, { body: { lang: 'fr', email: 'Bonjour Hajer,\n\nSuite à notre échange sur Malt, seriez-vous disponible jeudi ou vendredi après-midi pour un appel de 15 minutes ? Pas d\'urgence, la semaine prochaine me va aussi.\n\nBonne journée,\nKarim' } });
  ok(efr.status === 200 && ['haute', 'moyenne', 'basse'].includes(efr.json.urgence), 'agent-email (fr) -> urgence en français', efr.json);
  if (efr.json && efr.json.categorie) console.log('       ' + efr.json.categorie + ' / ' + efr.json.urgence + ' / ' + String(efr.json.resume).slice(0, 120));

  const p = await call(rapport, { body: VALID.rapport });
  ok(p.status === 200 && typeof p.json.rapport_markdown === 'string' && /^#\s/.test(p.json.rapport_markdown) && /\|/.test(p.json.rapport_markdown),
    'rapport -> 200 { rapport_markdown } avec titre et tableau via ' + p.headers['x-llm-provider'] + '/' + p.headers['x-llm-model'], p.json);
  if (p.json && p.json.rapport_markdown) console.log('       ' + p.json.rapport_markdown.split('\n').slice(0, 3).join(' | '));
}

/* ---------- 6. Bascule automatique Gemini -> Groq avec un fetch simulé (aucun appel réseau) ---------- */
if (!hasKey) {
  section('6. Bascule automatique (fetch simulé : Gemini 429 puis 500, Groq 200)');
  const realFetch = globalThis.fetch;
  const calls = [];
  const fake = (status, body, headers) => ({ status, headers: new Headers(headers || {}), text: async () => JSON.stringify(body) });
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (/generativelanguage/.test(url)) {
      if (/gemini-2\.5-flash-lite/.test(url)) return fake(429, { error: { message: 'quota exceeded' } }, { 'retry-after': '30' });
      return fake(500, { error: { message: 'boom' } });
    }
    if (/api\.groq\.com/.test(url)) {
      const sent = JSON.parse(init.body);
      return fake(200, { choices: [{ message: { content: '<think>hmm</think>{"reply":"ok from ' + sent.model + '"}' } }] });
    }
    return fake(404, {});
  };
  process.env.GEMINI_API_KEY = 'fake-gemini';
  process.env.GROQ_API_KEY = 'fake-groq';
  process.env.GEMINI_MODELS = 'gemini-2.5-flash-lite,gemini-2.5-flash';
  process.env.GROQ_MODELS = 'openai/gpt-oss-20b';
  try {
    const out = await llm.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], json: true });
    ok(out.provider === 'groq' && out.model === 'openai/gpt-oss-20b', 'après 2 échecs Gemini, la réponse vient de Groq', out);
    ok(llm.parseJson(out.text).reply === 'ok from openai/gpt-oss-20b', 'le <think> est retiré et le JSON extrait', out.text);
    ok(out.attempts.length === 2 && /429/.test(out.attempts[0]) && /500/.test(out.attempts[1]), '2 tentatives Gemini consignées (429 puis 500)', out.attempts);
    ok(calls.length === 3, '3 appels HTTP au total', calls);
    ok((llm._cooldown.get('gemini:gemini-2.5-flash-lite') || 0) > Date.now() + 20_000, 'le modèle en 429 est mis en repos (Retry-After 30 s)');

    calls.length = 0;
    const out2 = await llm.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    ok(out2.provider === 'groq' && /en repos/.test(out2.attempts[0]) && calls.length === 2, 'appel suivant : le modèle en repos est sauté sans requête réseau', out2.attempts);

    const r = await call(chat, { body: VALID.chat });
    ok(r.status === 200 && r.json.reply.length > 0 && r.headers['x-llm-provider'] === 'groq', 'route /api/chat de bout en bout via le fournisseur de secours', r.json);

    globalThis.fetch = async () => fake(503, { error: { message: 'down' } });
    const all = await call(rapport, { body: VALID.rapport });
    ok(all.status === 503 && all.json.error === 'llm_unavailable' && all.headers['retry-after'] === '60', 'tous les fournisseurs en panne -> 503 llm_unavailable (le front bascule hors ligne)', all.json);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY; delete process.env.GEMINI_MODELS; delete process.env.GROQ_MODELS;
    llm._cooldown.clear();
  }
}

/* ---------- bilan ---------- */
console.log('\n' + passed + ' tests réussis, ' + failed + ' échoués.');
process.exit(failed ? 1 : 0);
