'use strict';
/* ============================================================
   POST /api/automatisation — démo « Automatisation de workflow »
   Requête  : { lang: "fr"|"en", source?: "demo"|"contact", nom, email?, telephone?, entreprise?, besoin? }
              (démo : email obligatoire ; page Contact : email OU téléphone, besoin obligatoire)
   Réponse  : { ok: true, envoye: boolean, message }

   Valide le formulaire puis le transmet au Google Apps Script de Hajer
   (URL secrète dans la variable d'environnement Vercel APPS_SCRIPT_URL, voir apps-script/README.md),
   qui ajoute la ligne dans Google Sheets, envoie l'email de présentation FIXE au visiteur
   et une copie complète à Hajer.
   Limitation : 5 envois par heure et par IP (en plus des 5 tests / jour côté navigateur
   et des plafonds du script : 1 email par adresse toutes les 6 h, 40 par jour).
   ============================================================ */

const { createHandler, InputError } = require('./_lib/http');
const { LlmError } = require('./_lib/llm');

function texte(v, max, obligatoire) {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim() : '';
  if (obligatoire && s.length < 2) throw new InputError('invalid_input');
  if (s.length > max) throw new InputError('too_long');
  return s;
}

module.exports = createHandler('automatisation', async function ({ body, lang }) {
  const source = body.source === 'contact' ? 'contact' : 'demo';
  const nom = texte(body.nom, 80, true);
  const email = texte(body.email, 120, false).toLowerCase();
  const telephone = texte(body.telephone, 25, false);
  if (email && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i.test(email)) throw new InputError('invalid_input');
  if (telephone && !/^[+()\d\s.-]{8,25}$/.test(telephone)) throw new InputError('invalid_input');
  /* démo : email obligatoire (c'est lui qui reçoit l'email) ; contact : email OU téléphone */
  if (!email && (source === 'demo' || !telephone)) throw new InputError('invalid_input');
  const entreprise = texte(body.entreprise, 80, false);
  const besoin = texte(body.besoin, 600, source === 'contact');

  const url = process.env.APPS_SCRIPT_URL;
  if (!url || !/^https:\/\/script\.google\.com\//.test(url)) throw new LlmError('no_provider', 'APPS_SCRIPT_URL absente');

  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 25000);
  let data;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, /* text/plain : pas de pré-requête côté Google */
      body: JSON.stringify({ source: source, lang: lang, nom: nom, email: email, telephone: telephone, entreprise: entreprise, besoin: besoin }),
      redirect: 'follow',
      signal: ctrl.signal
    });
    data = await r.json();
  } catch (e) {
    throw new LlmError('all_failed', 'Apps Script injoignable : ' + (e && e.message));
  } finally {
    clearTimeout(timer);
  }
  if (!data || data.ok !== true) {
    if (data && data.error === 'invalid_input') throw new InputError('invalid_input');
    throw new LlmError('all_failed', 'Apps Script : ' + JSON.stringify(data).slice(0, 200));
  }

  if (source === 'contact') {
    return { ok: true, envoye: !!data.envoye, message: lang === 'fr' ? 'Message envoyé à Hajer.' : 'Message sent to Hajer.' };
  }
  const message = data.envoye
    ? (lang === 'fr' ? 'Email de présentation envoyé à ' + email + ' : vérifiez votre boîte (et les spams).' : 'Presentation email sent to ' + email + ': check your inbox (and spam folder).')
    : (lang === 'fr' ? 'Demande enregistrée. Un email a déjà été envoyé récemment à cette adresse : pas de renvoi, pour éviter le spam.' : 'Request saved. An email was already sent to this address recently: not resent, to avoid spam.');
  return { ok: true, envoye: !!data.envoye, message: message };
}, { limit: 5 });
