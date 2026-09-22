'use strict';
/* ============================================================
   _lib/http.js — socle commun des fonctions serverless /api/*
   - CORS (ALLOWED_ORIGIN : liste d'origines séparées par des virgules, "*" par défaut)
   - réponse aux pré-requêtes OPTIONS (204)
   - lecture du corps JSON (Vercel fournit req.body ; sinon lecture du flux)
   - limitation par IP (voir ratelimit.js) : 20 requêtes / heure par défaut
   - messages d'erreur bilingues FR / EN, format { ok:false, error, message }
   Aucune clé API ici.
   ============================================================ */

const ratelimit = require('./ratelimit');

const MAX_INPUT_CHARS = 4000;

const MESSAGES = {
  fr: {
    method_not_allowed: 'Méthode non autorisée : cette route accepte uniquement POST.',
    rate_limited: 'Trop de requêtes depuis votre adresse (20 par heure maximum pour cette démo). Réessayez un peu plus tard.',
    bad_json: 'Corps de requête invalide : un objet JSON est attendu.',
    too_long: 'Texte trop long : ' + MAX_INPUT_CHARS + ' caractères maximum.',
    invalid_input: 'Données d\'entrée invalides.',
    no_provider: 'Aucune clé API configurée côté serveur (GEMINI_API_KEY ou GROQ_API_KEY).',
    llm_unavailable: 'Le service d\'IA est momentanément indisponible (quota gratuit atteint ou panne). Réessayez dans une minute.',
    bad_model_output: 'L\'IA a renvoyé une réponse inexploitable. Réessayez.',
    internal: 'Erreur interne. Réessayez dans un instant.'
  },
  en: {
    method_not_allowed: 'Method not allowed: this route only accepts POST.',
    rate_limited: 'Too many requests from your address (20 per hour maximum for this demo). Please try again a bit later.',
    bad_json: 'Invalid request body: a JSON object is expected.',
    too_long: 'Text too long: ' + MAX_INPUT_CHARS + ' characters maximum.',
    invalid_input: 'Invalid input data.',
    no_provider: 'No API key configured on the server (GEMINI_API_KEY or GROQ_API_KEY).',
    llm_unavailable: 'The AI service is temporarily unavailable (free quota reached or outage). Please try again in a minute.',
    bad_model_output: 'The AI returned an unusable answer. Please try again.',
    internal: 'Internal error. Please try again in a moment.'
  }
};

/** Normalise le paramètre `lang` envoyé par le front ("fr" par défaut). */
function pickLang(v) {
  return String(v || '').toLowerCase().slice(0, 2) === 'en' ? 'en' : 'fr';
}

/** Message d'erreur dans la langue du visiteur. */
function msg(code, lang) {
  const d = MESSAGES[pickLang(lang)];
  return d[code] || d.internal;
}

/* ---------- CORS ---------- */
function allowedOrigins() {
  return String(process.env.ALLOWED_ORIGIN || '*')
    .split(',')
    .map(function (s) { return s.trim().replace(/\/$/, ''); })
    .filter(Boolean);
}

/** En-têtes CORS : "*" en dev, sinon renvoie l'origine appelante si elle est autorisée. */
function corsHeaders(req) {
  const list = allowedOrigins();
  const origin = String((req.headers && (req.headers.origin || req.headers.Origin)) || '').replace(/\/$/, '');
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (list.indexOf('*') !== -1) h['Access-Control-Allow-Origin'] = '*';
  else if (origin && list.indexOf(origin) !== -1) h['Access-Control-Allow-Origin'] = origin;
  /* origine non autorisée : pas d'en-tête -> le navigateur bloque la lecture de la réponse */
  return h;
}

/* ---------- réponses ---------- */
function sendJson(res, status, payload, extraHeaders) {
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extraHeaders || {});
  res.statusCode = status;
  Object.keys(headers).forEach(function (k) { res.setHeader(k, headers[k]); });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, code, lang, extraHeaders) {
  return sendJson(res, status, { ok: false, error: code, message: msg(code, lang) }, extraHeaders);
}

/** Erreur de validation à lever depuis un handler : `throw new InputError('too_long')`. */
class InputError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'InputError';
    this.code = code || 'invalid_input';
    this.detail = detail;
  }
}

/* ---------- corps de requête ---------- */
async function readRawBody(req, limitBytes) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limitBytes) { reject(new InputError('too_long')); try { req.destroy(); } catch (e) { /* ignore */ } return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

/** Retourne un objet JSON (jamais null) ou lève InputError('bad_json' | 'too_long'). */
async function readJsonBody(req) {
  let body;
  try {
    body = req.body; /* getter Vercel : peut lever si JSON malformé */
  } catch (e) {
    throw new InputError('bad_json');
  }
  if (body === undefined && typeof req.on === 'function') {
    const raw = await readRawBody(req, 64 * 1024); /* 64 Ko : bien au-delà des 4 000 caractères utiles */
    body = raw.trim() ? raw : null;
  }
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { throw new InputError('bad_json'); }
  }
  if (Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString('utf8')); } catch (e) { throw new InputError('bad_json'); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('bad_json');
  return body;
}

/* ---------- fabrique de handler ---------- */
/**
 * createHandler(name, fn)
 * fn({ body, lang, req, res }) doit renvoyer l'objet JSON de succès.
 * Gère : OPTIONS, méthode, limitation par IP, corps JSON, erreurs bilingues.
 */
function createHandler(name, fn, options) {
  const opts = options || {};
  return async function handler(req, res) {
    const cors = corsHeaders(req);
    const method = String(req.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
      res.end();
      return;
    }

    /* langue : d'abord le corps (lu plus bas), en attendant l'en-tête Accept-Language */
    let lang = pickLang(String((req.headers && req.headers['accept-language']) || 'fr'));

    if (method !== 'POST') {
      return sendError(res, 405, 'method_not_allowed', lang, Object.assign({ 'Allow': 'POST, OPTIONS' }, cors));
    }

    /* limitation par IP AVANT toute lecture du corps : un abuseur qui envoie du bruit est aussi freiné */
    const rl = ratelimit.check(req, { limit: opts.limit, windowMs: opts.windowMs });
    const rlHeaders = {
      'X-RateLimit-Limit': String(rl.limit),
      'X-RateLimit-Remaining': String(rl.remaining)
    };
    if (!rl.ok) {
      /* on lit quand même le corps (64 Ko max) uniquement pour répondre dans la langue du visiteur */
      try { lang = pickLang((await readJsonBody(req)).lang); } catch (e) { /* corps absent ou invalide : langue par défaut */ }
      return sendError(res, 429, 'rate_limited', lang, Object.assign({ 'Retry-After': String(rl.retryAfter) }, rlHeaders, cors));
    }

    try {
      const body = await readJsonBody(req);
      lang = pickLang(body.lang);
      const result = await fn({ body: body, lang: lang, req: req, res: res });
      const extra = Object.assign({}, rlHeaders, cors);
      if (result && result.__meta) {
        if (result.__meta.provider) extra['X-LLM-Provider'] = String(result.__meta.provider);
        if (result.__meta.model) extra['X-LLM-Model'] = String(result.__meta.model);
        delete result.__meta;
      }
      return sendJson(res, 200, result, extra);
    } catch (err) {
      const extra = Object.assign({}, rlHeaders, cors);
      if (err && err.name === 'InputError') {
        return sendError(res, 400, err.code, lang, extra);
      }
      if (err && err.name === 'LlmError') {
        if (err.code === 'no_provider') return sendError(res, 503, 'no_provider', lang, extra);
        if (err.code === 'bad_model_output') return sendError(res, 502, 'bad_model_output', lang, extra);
        console.error('[' + name + '] LLM indisponible :', err.details || err.message);
        return sendError(res, 503, 'llm_unavailable', lang, Object.assign({ 'Retry-After': '60' }, extra));
      }
      console.error('[' + name + '] erreur interne :', err && err.stack ? err.stack : err);
      return sendError(res, 500, 'internal', lang, extra);
    }
  };
}

/* ---------- validateurs réutilisables ---------- */
function requireString(v, opts) {
  const o = opts || {};
  if (typeof v !== 'string') throw new InputError('invalid_input', o.name);
  const s = v.replace(/\r\n/g, '\n').trim();
  if (s.length < (o.min || 1)) throw new InputError('invalid_input', o.name);
  if (s.length > (o.max || MAX_INPUT_CHARS)) throw new InputError('too_long', o.name);
  return s;
}

function requireNumber(v, opts) {
  const o = opts || {};
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new InputError('invalid_input', o.name);
  if (n < (o.min !== undefined ? o.min : 0)) throw new InputError('invalid_input', o.name);
  if (n > (o.max !== undefined ? o.max : 1e12)) throw new InputError('invalid_input', o.name);
  return n;
}

module.exports = {
  MAX_INPUT_CHARS: MAX_INPUT_CHARS,
  MESSAGES: MESSAGES,
  InputError: InputError,
  pickLang: pickLang,
  msg: msg,
  corsHeaders: corsHeaders,
  sendJson: sendJson,
  sendError: sendError,
  readJsonBody: readJsonBody,
  createHandler: createHandler,
  requireString: requireString,
  requireNumber: requireNumber
};
