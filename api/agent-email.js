'use strict';
/* ============================================================
   POST /api/agent-email — démo « Agent email IA »
   Requête  : { lang: "fr"|"en", email: "texte brut de l'email" }
   Réponse  : { categorie, urgence, resume, reponse_proposee }
     urgence : "haute" | "moyenne" | "basse" (fr)  /  "high" | "medium" | "low" (en)
   Clés API : variables d'environnement uniquement (voir _lib/llm.js).
   ============================================================ */

const { createHandler, requireString, MAX_INPUT_CHARS } = require('./_lib/http');
const llm = require('./_lib/llm');

const URGENCY = {
  fr: { high: 'haute', medium: 'moyenne', low: 'basse' },
  en: { high: 'high', medium: 'medium', low: 'low' }
};

const PROMPTS = {
  fr: [
    'Tu es l\'agent email d\'une petite entreprise. On te donne un email reçu ; tu dois le classer, évaluer son urgence, le résumer et rédiger la réponse que l\'entreprise pourrait envoyer.',
    'Réponds UNIQUEMENT par un objet JSON valide, sans texte autour ni bloc de code, avec exactement ces clés :',
    '{ "categorie": string, "urgence": "haute" | "moyenne" | "basse", "resume": string, "reponse_proposee": string }',
    '- categorie : une des valeurs suivantes : "Facturation", "Réclamation / SAV", "Demande commerciale", "Prise de rendez-vous", "Candidature", "Marketing / Spam", "Demande d\'information" (choisis la plus proche).',
    '- urgence : "haute" si le client attend une action immédiate ou exprime une gêne forte, "basse" si aucune action n\'est attendue (newsletter, spam, remerciement), "moyenne" sinon.',
    '- resume : une seule phrase en français (30 mots maximum) qui dit qui écrit, ce qu\'il veut et les détails clés (numéro de commande, date, montant).',
    '- reponse_proposee : réponse complète en français, polie et concrète, prête à envoyer : formule d\'appel, 2 à 4 phrases qui répondent au besoin ou annoncent la prochaine étape, formule de politesse et signature (« Hajer » si l\'email lui est adressé, sinon « L\'équipe »). Sépare les paragraphes par des lignes vides. Pour un spam ou une newsletter, écris : "(Aucune réponse nécessaire — email archivé automatiquement.)".',
    'N\'invente pas d\'engagement précis (remboursement, montant, date ferme) qui n\'est pas déductible de l\'email : propose plutôt une vérification et un délai de réponse.'
  ],
  en: [
    'You are the email agent of a small business. You are given an incoming email; you must classify it, rate its urgency, summarise it and draft the reply the business could send.',
    'Answer ONLY with a valid JSON object, no surrounding text and no code block, with exactly these keys:',
    '{ "categorie": string, "urgence": "high" | "medium" | "low", "resume": string, "reponse_proposee": string }',
    '- categorie: one of "Billing", "Complaint / Support", "Sales inquiry", "Meeting request", "Job application", "Marketing / Spam", "Information request" (pick the closest).',
    '- urgence: "high" if the sender expects immediate action or expresses strong frustration, "low" if no action is expected (newsletter, spam, thank-you note), "medium" otherwise.',
    '- resume: one single English sentence (30 words maximum) saying who writes, what they want and the key details (order number, date, amount).',
    '- reponse_proposee: full English reply, polite and concrete, ready to send: greeting, 2 to 4 sentences that answer the need or announce the next step, closing line and signature ("Hajer" if the email is addressed to her, otherwise "The team"). Separate paragraphs with blank lines. For spam or a newsletter write: "(No reply needed — email archived automatically.)".',
    'Do not invent precise commitments (refund, amount, firm date) that cannot be inferred from the email: offer a check and a response deadline instead.'
  ]
};

function normalizeUrgency(v, lang) {
  const s = String(v || '').toLowerCase();
  const map = URGENCY[lang];
  if (/haute|high|urgent|élevée|elevee|critique/.test(s)) return map.high;
  if (/basse|low|faible|none|aucune/.test(s)) return map.low;
  return map.medium;
}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
}

module.exports = createHandler('agent-email', async function ({ body, lang }) {
  const email = requireString(body.email, { name: 'email', min: 20, max: MAX_INPUT_CHARS });

  const out = await llm.complete({
    system: PROMPTS[lang].join('\n'),
    messages: [{ role: 'user', content: (lang === 'fr' ? 'Email reçu :\n\n' : 'Incoming email:\n\n') + email }],
    json: true,
    maxTokens: 700
  });

  const data = llm.parseJson(out.text);
  const result = {
    categorie: clean(data.categorie, 80) || (lang === 'fr' ? 'Demande d\'information' : 'Information request'),
    urgence: normalizeUrgency(data.urgence, lang),
    resume: clean(data.resume, 500),
    reponse_proposee: clean(data.reponse_proposee, 3000)
  };
  if (!result.resume || !result.reponse_proposee) throw new llm.LlmError('bad_model_output', 'champs manquants');
  result.__meta = { provider: out.provider, model: out.model };
  return result;
});
