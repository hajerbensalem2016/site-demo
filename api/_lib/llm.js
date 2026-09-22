'use strict';
/* ============================================================
   _lib/llm.js — appel unifié Gemini (gratuit) / Groq (secours)
   - fetch natif, aucune dépendance npm
   - clés lues dans process.env : GEMINI_API_KEY, GROQ_API_KEY (jamais en dur)
   - bascule automatique : chaque modèle de chaque fournisseur est essayé
     dans l'ordre ; un 429 (quota), un 5xx, un dépassement de délai ou une
     erreur réseau passe au suivant. Un modèle en 429 est mis en "repos"
     (cooldown) pour ne pas le re-solliciter inutilement.
   - Variables optionnelles :
       LLM_PROVIDERS  ordre des fournisseurs, défaut "gemini,groq"
       GEMINI_MODELS  liste séparée par des virgules, défaut ci-dessous
       GROQ_MODELS    idem
       LLM_TIMEOUT_MS délai par appel (défaut 12000), LLM_DEADLINE_MS budget total (défaut 22000)
   ============================================================ */

/* Modèles "Free of charge" sur ai.google.dev/gemini-api/docs/pricing (vérifié le 22/09/2026).
   flash-lite en premier : quota journalier gratuit le plus généreux et réponses rapides. */
const DEFAULT_GEMINI_MODELS = 'gemini-2.5-flash-lite,gemini-3.5-flash-lite,gemini-2.5-flash';
/* Groq niveau gratuit (llama-3.x retirés du free tier le 16/08/2026) */
const DEFAULT_GROQ_MODELS = 'openai/gpt-oss-20b,openai/gpt-oss-120b';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const COOLDOWN_DEFAULT_MS = 60 * 1000;
const COOLDOWN_MAX_MS = 10 * 60 * 1000;

/** "provider:model" -> horodatage (ms) jusqu'auquel on évite ce modèle */
const cooldown = new Map();

class LlmError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'LlmError';
    this.code = code;
    this.details = details;
  }
}

function list(envName, fallback) {
  return String(process.env[envName] || fallback).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function providersConfigured() {
  const order = list('LLM_PROVIDERS', 'gemini,groq');
  const out = [];
  order.forEach(function (p) {
    if (p === 'gemini' && process.env.GEMINI_API_KEY) out.push({ name: 'gemini', key: process.env.GEMINI_API_KEY, models: list('GEMINI_MODELS', DEFAULT_GEMINI_MODELS) });
    if (p === 'groq' && process.env.GROQ_API_KEY) out.push({ name: 'groq', key: process.env.GROQ_API_KEY, models: list('GROQ_MODELS', DEFAULT_GROQ_MODELS) });
  });
  return out;
}

/* ---------- utilitaires ---------- */
async function fetchJson(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  try {
    const res = await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 500) } }
    return { status: res.status, headers: res.headers, data: data };
  } catch (err) {
    if (err && err.name === 'AbortError') throw new LlmError('timeout', 'timeout after ' + timeoutMs + ' ms');
    throw new LlmError('network', String(err && err.message || err));
  } finally {
    clearTimeout(timer);
  }
}

function retryAfterMs(headers) {
  try {
    const v = headers && headers.get && headers.get('retry-after');
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) return Math.min(n * 1000, COOLDOWN_MAX_MS);
  } catch (e) { /* ignore */ }
  return COOLDOWN_DEFAULT_MS;
}

function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Extrait un objet JSON d'une réponse de modèle (gère les ```json … ``` et le texte autour). */
function parseJson(text) {
  let s = stripThinking(text);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (e) { /* on tente l'extraction */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* échec */ }
  }
  throw new LlmError('bad_model_output', 'réponse non JSON : ' + s.slice(0, 120));
}

/* ---------- fournisseurs ---------- */
async function callGemini(key, model, p, timeoutMs) {
  const generationConfig = { maxOutputTokens: p.maxTokens };
  if (p.json) generationConfig.responseMimeType = 'application/json';
  /* Les 2.5 raisonnent par défaut et consomment maxOutputTokens : on coupe la "réflexion" pour une démo rapide. */
  if (/^gemini-2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const body = {
    systemInstruction: { parts: [{ text: p.system }] },
    contents: p.messages.map(function (m) {
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
    }),
    generationConfig: generationConfig
  };
  const r = await fetchJson(GEMINI_URL + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body)
  }, timeoutMs);

  if (r.status !== 200) {
    const m = r.data && r.data.error && r.data.error.message;
    throw Object.assign(new LlmError('http_' + r.status, 'Gemini ' + model + ' HTTP ' + r.status + (m ? ' : ' + m : '')), { status: r.status, headers: r.headers });
  }
  const cand = r.data && r.data.candidates && r.data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.filter(function (x) { return !x.thought && typeof x.text === 'string'; }).map(function (x) { return x.text; }).join('').trim();
  if (!text) {
    const reason = (cand && cand.finishReason) || (r.data && r.data.promptFeedback && r.data.promptFeedback.blockReason) || 'empty';
    throw new LlmError('empty', 'Gemini ' + model + ' réponse vide (' + reason + ')');
  }
  return text;
}

async function callGroq(key, model, p, timeoutMs) {
  const body = {
    model: model,
    messages: [{ role: 'system', content: p.system }].concat(p.messages.map(function (m) { return { role: m.role, content: m.content }; })),
    max_tokens: p.maxTokens,
    temperature: p.json ? 0.2 : 0.5
  };
  if (/gpt-oss/.test(model)) body.reasoning_effort = 'low';
  if (p.json) body.response_format = { type: 'json_object' };

  const r = await fetchJson(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body)
  }, timeoutMs);

  if (r.status !== 200) {
    const m = r.data && r.data.error && (r.data.error.message || r.data.error);
    throw Object.assign(new LlmError('http_' + r.status, 'Groq ' + model + ' HTTP ' + r.status + (m ? ' : ' + JSON.stringify(m).slice(0, 200) : '')), { status: r.status, headers: r.headers });
  }
  const choice = r.data && r.data.choices && r.data.choices[0];
  const text = stripThinking(choice && choice.message && choice.message.content);
  if (!text) throw new LlmError('empty', 'Groq ' + model + ' réponse vide');
  return text;
}

const CALLERS = { gemini: callGemini, groq: callGroq };

/* ---------- point d'entrée ---------- */
/**
 * complete({ system, messages, json, maxTokens })
 *   messages : [{ role: "user"|"assistant", content }] — doit finir par un message user
 * -> { text, provider, model, attempts }
 * Lève LlmError('no_provider') si aucune clé, LlmError('all_failed') si tout a échoué.
 */
async function complete(params) {
  const p = {
    system: String(params.system || ''),
    messages: (params.messages || []).map(function (m) { return { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }; }),
    json: !!params.json,
    maxTokens: params.maxTokens > 0 ? params.maxTokens : 1024
  };
  const perCall = parseInt(process.env.LLM_TIMEOUT_MS || '', 10) > 0 ? parseInt(process.env.LLM_TIMEOUT_MS, 10) : 12000;
  const deadline = Date.now() + (parseInt(process.env.LLM_DEADLINE_MS || '', 10) > 0 ? parseInt(process.env.LLM_DEADLINE_MS, 10) : 22000);

  const providers = providersConfigured();
  if (!providers.length) throw new LlmError('no_provider', 'GEMINI_API_KEY / GROQ_API_KEY absentes');

  const attempts = [];
  for (const prov of providers) {
    for (const model of prov.models) {
      const id = prov.name + ':' + model;
      const until = cooldown.get(id) || 0;
      if (until > Date.now()) { attempts.push(id + ' : en repos (quota) ' + Math.ceil((until - Date.now()) / 1000) + ' s'); continue; }

      const remaining = deadline - Date.now();
      if (remaining < 1500) { attempts.push(id + ' : budget temps épuisé'); break; }

      try {
        const text = await CALLERS[prov.name](prov.key, model, p, Math.min(perCall, remaining));
        return { text: text, provider: prov.name, model: model, attempts: attempts };
      } catch (err) {
        const status = err && err.status;
        attempts.push(id + ' : ' + (err && err.message || err));
        if (status === 429) cooldown.set(id, Date.now() + retryAfterMs(err.headers));
        if (status === 401 || status === 403) break; /* clé invalide : inutile d'essayer les autres modèles de ce fournisseur */
        /* 400/404 (modèle inconnu ou paramètre refusé), 5xx, timeout, réseau, réponse vide : modèle suivant */
      }
    }
  }
  throw new LlmError('all_failed', 'tous les modèles ont échoué', attempts);
}

module.exports = {
  complete: complete,
  parseJson: parseJson,
  stripThinking: stripThinking,
  providersConfigured: providersConfigured,
  LlmError: LlmError,
  DEFAULT_GEMINI_MODELS: DEFAULT_GEMINI_MODELS,
  DEFAULT_GROQ_MODELS: DEFAULT_GROQ_MODELS,
  _cooldown: cooldown
};
