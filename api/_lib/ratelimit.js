'use strict';
/* ============================================================
   _lib/ratelimit.js — limitation par adresse IP, en mémoire
   - 20 requêtes / heure / IP par défaut (RATE_LIMIT_PER_HOUR pour ajuster)
   - fenêtre glissante : on garde les horodatages des requêtes récentes
   - suffisant pour une démo : le compteur vit dans l'instance de la
     fonction (Vercel Fluid compute réutilise l'instance ; un démarrage
     à froid remet le compteur à zéro — acceptable ici).
   ============================================================ */

const DEFAULT_LIMIT = (function () {
  const n = parseInt(process.env.RATE_LIMIT_PER_HOUR || '', 10);
  return n > 0 ? n : 20;
})();
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_IPS = 5000;

/** ip -> tableau d'horodatages (ms) des requêtes dans la fenêtre */
const buckets = new Map();

/** Adresse IP du client (Vercel place l'IP réelle dans x-forwarded-for). */
function clientIp(req) {
  const h = (req && req.headers) || {};
  const xff = h['x-forwarded-for'];
  if (xff) {
    const first = String(Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
    if (first) return first;
  }
  if (h['x-real-ip']) return String(h['x-real-ip']).trim();
  if (h['x-vercel-forwarded-for']) return String(h['x-vercel-forwarded-for']).split(',')[0].trim();
  const sock = req && (req.socket || req.connection);
  return (sock && sock.remoteAddress) || 'unknown';
}

/** Évacue les IP inactives quand la table grossit trop. */
function evict(now, windowMs) {
  if (buckets.size <= MAX_TRACKED_IPS) return;
  for (const [ip, times] of buckets) {
    if (!times.length || times[times.length - 1] + windowMs <= now) buckets.delete(ip);
  }
  /* toujours trop plein : on retire les plus anciennes entrées (ordre d'insertion de Map) */
  while (buckets.size > MAX_TRACKED_IPS) {
    buckets.delete(buckets.keys().next().value);
  }
}

/**
 * check(req, { limit, windowMs, now })
 * -> { ok, limit, remaining, retryAfter (s), ip }
 * Consomme une unité si ok === true.
 */
function check(req, options) {
  const o = options || {};
  const limit = o.limit > 0 ? o.limit : DEFAULT_LIMIT;
  const windowMs = o.windowMs > 0 ? o.windowMs : DEFAULT_WINDOW_MS;
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const ip = clientIp(req);

  let times = buckets.get(ip) || [];
  times = times.filter(function (t) { return t + windowMs > now; });

  if (times.length >= limit) {
    buckets.set(ip, times);
    const retryAfter = Math.max(1, Math.ceil((times[0] + windowMs - now) / 1000));
    return { ok: false, limit: limit, remaining: 0, retryAfter: retryAfter, ip: ip };
  }

  times.push(now);
  buckets.delete(ip); /* ré-insère en fin : les IP actives sont les dernières évincées */
  buckets.set(ip, times);
  evict(now, windowMs);
  return { ok: true, limit: limit, remaining: limit - times.length, retryAfter: 0, ip: ip };
}

/** Remise à zéro (tests). */
function reset() { buckets.clear(); }

module.exports = { check: check, reset: reset, clientIp: clientIp, DEFAULT_LIMIT: DEFAULT_LIMIT, DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS };
