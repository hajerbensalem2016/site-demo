'use strict';
/* ============================================================
   POST /api/facture — démo « Photo de facture → tableau »
   Requête  : { lang: "fr"|"en", image: "data:image/jpeg;base64,…" }   (JPEG, PNG ou WebP, 3 Mo max)
   Réponse  : { document: { type_document, fournisseur, date, numero, lignes: [ { designation, quantite, prix_unitaire, montant } ],
                            total_ht, tva, total_ttc, devise },
                controle: { somme_lignes, ecart, coherent } }

   Un modèle de vision (Groq, gratuit : VISION_MODEL, défaut qwen/qwen3.8-27b) lit l'image et renvoie du JSON.
   Le contrôle de cohérence (somme des lignes vs total) est calculé ici, en JavaScript.
   L'image n'est ni stockée ni journalisée. Clé API : variable d'environnement GROQ_API_KEY.
   ============================================================ */

const { createHandler, InputError, consigneLangue } = require('./_lib/http');
const llm = require('./_lib/llm');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_IMAGE_CHARS = 3 * 1024 * 1024 * 4 / 3; /* ~3 Mo une fois décodée */

function prompt(lang) {
  return [
    'You read ONE photo of an invoice, receipt or quote and extract its data. Reply with ONLY a JSON object, no text around it:',
    '{"lisible": boolean, "type_document": "facture"|"ticket"|"devis"|"autre", "fournisseur": string|null, "date": "YYYY-MM-DD"|null, "numero": string|null,',
    ' "lignes": [{"designation": string, "quantite": number|null, "prix_unitaire": number|null, "montant": number|null}],',
    ' "total_ht": number|null, "tva": number|null, "total_ttc": number|null, "devise": "EUR"|"USD"|"GBP"|string|null}',
    'Rules: copy text exactly as printed (keep the original language). Numbers use a dot as decimal separator, no currency symbol.',
    'Never guess: if a value is not visible, use null. If the image is not an invoice/receipt/quote or is unreadable, set "lisible": false and leave the rest null/empty.',
    'At most 40 lines. "montant" is the line total as printed.',
    lang === 'fr' ? 'The user is French-speaking.' : 'The user is English-speaking.'
  ].join('\n');
}

function num(v) {
  if (typeof v === 'number') return isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[^\d.,-]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function txt(v, max) { return typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null; }

function nettoyer(d) {
  const lignes = (Array.isArray(d.lignes) ? d.lignes : []).slice(0, 40).map(function (l) {
    return l && typeof l === 'object' ? { designation: txt(l.designation, 120) || '—', quantite: num(l.quantite), prix_unitaire: num(l.prix_unitaire), montant: num(l.montant) } : null;
  }).filter(Boolean);
  const devise = typeof d.devise === 'string' && /^[A-Za-z]{3}$/.test(d.devise.trim()) ? d.devise.trim().toUpperCase() : null;
  const date = typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null;
  const types = ['facture', 'ticket', 'devis', 'autre'];
  return {
    lisible: d.lisible !== false,
    type_document: types.indexOf(d.type_document) !== -1 ? d.type_document : 'autre',
    fournisseur: txt(d.fournisseur, 120), date: date, numero: txt(d.numero, 60),
    lignes: lignes, total_ht: num(d.total_ht), tva: num(d.tva), total_ttc: num(d.total_ttc), devise: devise
  };
}

function controle(doc) {
  const montants = doc.lignes.map(function (l) { return l.montant; }).filter(function (m) { return m !== null; });
  if (!montants.length) return null;
  const somme = Math.round(montants.reduce(function (a, b) { return a + b; }, 0) * 100) / 100;
  const refs = [doc.total_ttc, doc.total_ht].filter(function (x) { return x !== null; });
  if (!refs.length) return { somme_lignes: somme, ecart: null, coherent: null };
  const ecarts = refs.map(function (r) { return Math.round((r - somme) * 100) / 100; });
  const meilleur = ecarts.reduce(function (a, b) { return Math.abs(b) < Math.abs(a) ? b : a; });
  return { somme_lignes: somme, ecart: meilleur, coherent: Math.abs(meilleur) <= 0.05 };
}

module.exports = createHandler('facture', async function ({ body, lang, outLang }) {
  const image = typeof body.image === 'string' ? body.image : '';
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) throw new InputError('invalid_input');
  if (image.length > MAX_IMAGE_CHARS) throw new InputError('too_long');

  const key = process.env.GROQ_API_KEY;
  if (!key) throw new llm.LlmError('no_provider', 'GROQ_API_KEY absente');
  const model = process.env.VISION_MODEL || 'qwen/qwen3.8-27b';

  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 25000);
  let r, data;
  try {
    r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: model, max_tokens: 2500, temperature: 0.1,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt(lang) + (consigneLangue(outLang) ? '\nThe reader speaks ' + outLang + ': keep the extracted text exactly as printed on the document, do not translate it.' : '') }, { type: 'image_url', image_url: { url: image } }] }]
      }),
      signal: ctrl.signal
    });
    data = await r.json().catch(function () { return null; });
  } catch (e) {
    throw new llm.LlmError('all_failed', 'vision injoignable : ' + (e && e.message));
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new llm.LlmError('all_failed', 'vision HTTP ' + r.status + ' ' + JSON.stringify(data && data.error || '').slice(0, 200));
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const doc = nettoyer(llm.parseJson(text || ''));
  return { document: doc, controle: doc.lisible ? controle(doc) : null, __meta: { provider: 'groq', model: model } };
}, { limit: 8 });

module.exports._internals = { nettoyer, controle, num };
