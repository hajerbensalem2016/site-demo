'use strict';
/* ============================================================
   POST /api/rapport — démo « Rapport automatique »
   Requête  : { lang: "fr"|"en", ca: number, depenses: number, clients: number,
                // mode avancé (tous optionnels) :
                precedent?: { ca, depenses, clients },   // mois précédent -> évolutions
                objectif?: number,                        // objectif de CA du mois -> taux d'atteinte
                historique?: number[],                    // CA des mois précédents (du plus ancien au plus récent, 11 max)
                secteur?: "ecommerce"|"services"|"restauration"|"artisanat"|"autre" }
   Réponse  : { rapport_markdown, indicateurs }
   Tous les indicateurs (marge, taux, panier moyen, évolutions, atteinte d'objectif, tendance)
   sont calculés ici, en JavaScript, puis fournis au modèle : l'IA rédige, elle ne calcule pas.
   `indicateurs` renvoie ces mêmes chiffres au navigateur, qui dessine les graphiques.
   Clés API : variables d'environnement uniquement (voir _lib/llm.js).
   ============================================================ */

const { createHandler, requireNumber, InputError, consigneLangue } = require('./_lib/http');
const llm = require('./_lib/llm');

const SECTEURS = {
  ecommerce: { fr: 'e-commerce', en: 'e-commerce' },
  services: { fr: 'services aux entreprises', en: 'business services' },
  restauration: { fr: 'restauration', en: 'food & hospitality' },
  artisanat: { fr: 'artisanat / BTP', en: 'trades / construction' },
  autre: { fr: 'autre', en: 'other' }
};

function fmtMoney(n, lang) {
  return new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}
function fmtPct(n, lang, signe) {
  const s = (Math.round(n * 10) / 10).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB') + (lang === 'fr' ? ' %' : '%');
  return signe && n > 0 ? '+' + s : s;
}
function fmtInt(n, lang) {
  return new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-GB').format(n);
}
function evol(cur, prev) { return prev > 0 ? ((cur - prev) / prev) * 100 : null; }

function kpis(ca, dep, cli) {
  const marge = ca - dep;
  return { ca: ca, depenses: dep, clients: cli, marge: marge, taux: ca > 0 ? (marge / ca) * 100 : 0, panier: cli > 0 ? ca / cli : 0, cout: cli > 0 ? dep / cli : 0 };
}

function optNumber(v, name, max) {
  if (v === undefined || v === null || v === '') return null;
  return requireNumber(v, { name: name, max: max });
}

/** Lit et valide les champs du mode avancé ; renvoie null si aucun n'est fourni. */
function lireAvance(body) {
  const p = body.precedent && typeof body.precedent === 'object' ? body.precedent : {};
  const prec = {
    ca: optNumber(p.ca, 'precedent.ca'),
    depenses: optNumber(p.depenses, 'precedent.depenses'),
    clients: optNumber(p.clients, 'precedent.clients', 1e9)
  };
  const objectif = optNumber(body.objectif, 'objectif');
  let historique = [];
  if (body.historique !== undefined && body.historique !== null && body.historique !== '') {
    if (!Array.isArray(body.historique) || body.historique.length > 11) throw new InputError('invalid_input', 'historique');
    historique = body.historique.map(function (v, i) { return requireNumber(v, { name: 'historique[' + i + ']' }); });
  }
  const secteur = SECTEURS[body.secteur] ? body.secteur : null;
  const aPrec = prec.ca !== null || prec.depenses !== null || prec.clients !== null;
  if (!aPrec && objectif === null && !historique.length && !secteur) return null;
  return { prec: aPrec ? prec : null, objectif: objectif, historique: historique, secteur: secteur };
}

/** Indicateurs dérivés du mode avancé (évolutions, objectif, tendance), tous calculés ici. */
function calculAvance(k, av) {
  const out = {};
  if (av.prec) {
    const kp = kpis(av.prec.ca || 0, av.prec.depenses || 0, av.prec.clients || 0);
    out.precedent = kp;
    out.evolutions = {
      ca: av.prec.ca !== null ? evol(k.ca, kp.ca) : null,
      depenses: av.prec.depenses !== null ? evol(k.depenses, kp.depenses) : null,
      marge: av.prec.ca !== null && av.prec.depenses !== null && kp.marge > 0 ? evol(k.marge, kp.marge) : null,
      clients: av.prec.clients !== null ? evol(k.clients, kp.clients) : null,
      panier: av.prec.ca !== null && av.prec.clients ? evol(k.panier, kp.panier) : null
    };
    out.ecartTaux = av.prec.ca !== null && av.prec.depenses !== null ? k.taux - kp.taux : null;
  }
  if (av.objectif !== null && av.objectif > 0) out.atteinte = (k.ca / av.objectif) * 100;
  const serie = av.historique.concat(av.prec && av.prec.ca !== null && !av.historique.length ? [av.prec.ca] : []).concat([k.ca]);
  if (serie.length >= 3) {
    const n = serie.length, moy = serie.reduce(function (a, b) { return a + b; }, 0) / n;
    out.serie = serie;
    out.moyenne = moy;
    out.vsMoyenne = moy > 0 ? ((k.ca - moy) / moy) * 100 : null;
    out.meilleur = Math.max.apply(null, serie) === k.ca;
    out.croissanceTotale = serie[0] > 0 ? ((k.ca - serie[0]) / serie[0]) * 100 : null;
  } else if (serie.length === 2) {
    out.serie = serie;
  }
  return out;
}

function lignesAvance(lang, k, av, x) {
  const fr = lang === 'fr';
  const L = [];
  if (x.precedent) {
    const e = x.evolutions, pr = x.precedent;
    const row = function (label, cur, prev, ev) {
      return '| ' + label + ' | ' + cur + ' | ' + prev + ' | ' + (ev === null ? '—' : fmtPct(ev, lang, true)) + ' |';
    };
    L.push(fr ? 'Comparaison avec le mois précédent (tableau déjà prêt, à recopier tel quel) :' : 'Comparison with the previous month (ready-made table, copy as is):');
    L.push(fr ? '| Indicateur | Ce mois | Mois précédent | Évolution |' : '| Indicator | This month | Previous month | Change |');
    L.push('|---|---|---|---|');
    if (av.prec.ca !== null) L.push(row(fr ? 'Chiffre d\'affaires' : 'Revenue', fmtMoney(k.ca, lang), fmtMoney(pr.ca, lang), e.ca));
    if (av.prec.depenses !== null) L.push(row(fr ? 'Dépenses' : 'Expenses', fmtMoney(k.depenses, lang), fmtMoney(pr.depenses, lang), e.depenses));
    if (av.prec.ca !== null && av.prec.depenses !== null) L.push(row(fr ? 'Marge nette' : 'Net margin', fmtMoney(k.marge, lang), fmtMoney(pr.marge, lang), e.marge));
    if (av.prec.clients !== null) L.push(row(fr ? 'Clients' : 'Customers', fmtInt(k.clients, lang), fmtInt(pr.clients, lang), e.clients));
    if (e.panier !== null) L.push(row(fr ? 'Panier moyen' : 'Average basket', fmtMoney(k.panier, lang), fmtMoney(pr.panier, lang), e.panier));
    if (x.ecartTaux !== null) L.push((fr ? '- Écart de taux de marge : ' : '- Margin rate change: ') + (x.ecartTaux > 0 ? '+' : '') + (Math.round(x.ecartTaux * 10) / 10).toLocaleString(fr ? 'fr-FR' : 'en-GB') + (fr ? ' point(s)' : ' point(s)'));
  }
  if (x.atteinte !== undefined) L.push((fr ? '- Objectif de chiffre d\'affaires : ' : '- Revenue target: ') + fmtMoney(av.objectif, lang) + (fr ? ' ; atteint à ' : '; reached at ') + fmtPct(x.atteinte, lang) + (fr ? ' ; écart : ' : '; gap: ') + fmtMoney(k.ca - av.objectif, lang));
  if (x.moyenne !== undefined) {
    L.push((fr ? '- Tendance sur ' : '- Trend over ') + x.serie.length + (fr ? ' mois : CA moyen ' : ' months: average revenue ') + fmtMoney(x.moyenne, lang) +
      (x.vsMoyenne !== null ? (fr ? ' ; ce mois ' : '; this month ') + fmtPct(x.vsMoyenne, lang, true) + (fr ? ' vs la moyenne' : ' vs average') : '') +
      (x.croissanceTotale !== null ? (fr ? ' ; croissance depuis le premier mois : ' : '; growth since first month: ') + fmtPct(x.croissanceTotale, lang, true) : '') +
      (x.meilleur ? (fr ? ' ; meilleur mois de la période' : '; best month of the period') : ''));
  }
  if (av.secteur) L.push((fr ? '- Secteur : ' : '- Sector: ') + SECTEURS[av.secteur][lang]);
  return L;
}

function prompt(lang, k, av, x) {
  const fr = lang === 'fr';
  const date = new Date().toLocaleDateString(fr ? 'fr-FR' : 'en-GB', { month: 'long', year: 'numeric' });
  const sante = k.taux >= 30 ? (fr ? 'excellente' : 'excellent') : k.taux >= 15 ? (fr ? 'saine' : 'healthy') : (fr ? 'fragile' : 'fragile');
  const avance = av ? lignesAvance(lang, k, av, x) : [];
  const L = fr ? [
    'Tu es un analyste financier qui rédige des rapports d\'activité courts pour des petites entreprises. Rédige en français, ton professionnel et concret.',
    'Réponds UNIQUEMENT en Markdown simple (titres #, ##, gras **, listes - ou 1., tableau | a | b |). Pas de bloc de code, pas de texte avant le premier titre, pas d\'emoji.',
    'Utilise EXACTEMENT les chiffres fournis (déjà formatés) sans les recalculer ni en inventer d\'autres. N\'annonce aucun gain de temps ni aucun chiffre qui ne figure pas ci-dessous.',
    '',
    'Structure imposée :',
    '# Rapport d\'activité — ' + date,
    '## Synthèse (un paragraphe de 3 à 5 phrases : chiffre d\'affaires, dépenses, marge, clients, panier moyen, verdict de rentabilité « ' + sante + ' »' + (av ? ', et ce qui a changé par rapport au mois précédent, à l\'objectif et à la tendance si ces données sont fournies' : '') + ')',
    '## Indicateurs clés (tableau à 2 colonnes « Indicateur | Valeur » avec les 7 lignes ci-dessous, dans cet ordre)'
  ] : [
    'You are a financial analyst who writes short activity reports for small businesses. Write in English, professional and concrete tone.',
    'Answer ONLY in simple Markdown (headings #, ##, bold **, lists - or 1., table | a | b |). No code block, no text before the first heading, no emoji.',
    'Use EXACTLY the figures provided (already formatted); never recalculate or invent other numbers. Do not claim any time saved or any figure not listed below.',
    '',
    'Required structure:',
    '# Activity report — ' + date,
    '## Summary (one paragraph of 3 to 5 sentences: revenue, expenses, margin, customers, average basket, profitability verdict "' + sante + '"' + (av ? ', and what changed vs the previous month, the target and the trend when provided' : '') + ')',
    '## Key indicators (2-column table "Indicator | Value" with the 7 rows below, in this order)'
  ];
  if (av && x.precedent) L.push(fr ? '## Évolution sur un mois (recopie le tableau de comparaison fourni, puis 2 phrases qui expliquent les écarts les plus importants)' : '## Month-over-month (copy the comparison table provided, then 2 sentences explaining the largest changes)');
  if (av && (x.atteinte !== undefined || x.moyenne !== undefined)) L.push(fr ? '## Objectif et tendance (2 à 3 phrases avec les chiffres fournis)' : '## Target and trend (2 to 3 sentences using the figures provided)');
  L.push(fr
    ? '## Recommandations (3 recommandations numérotées, 1 à 2 phrases chacune, concrètes et adaptées aux chiffres' + (av && av.secteur ? ' et au secteur' : '') + ', dont une sur l\'automatisation d\'une tâche répétitive ; AUCUN pourcentage, objectif chiffré ou gain inventé : ne cite que des chiffres fournis ci-dessous)'
    : '## Recommendations (3 numbered recommendations, 1 to 2 sentences each, concrete and tailored to the figures' + (av && av.secteur ? ' and the sector' : '') + ', including one about automating a repetitive task; NO invented percentage, numeric target or gain: only quote figures listed below)');
  L.push(fr
    ? '## Prochaine étape (1 à 2 phrases : ce rapport peut être généré et envoyé automatiquement chaque semaine ou chaque mois — Google Sheets → n8n → IA → PDF → email — sans aucune saisie)'
    : '## Next step (1 to 2 sentences: this report can be generated and sent automatically every week or month — Google Sheets → n8n → AI → PDF → email — with no manual entry)');
  L.push('', fr ? 'Chiffres à utiliser :' : 'Figures to use:');
  L.push(
    (fr ? '- Chiffre d\'affaires : ' : '- Revenue: ') + fmtMoney(k.ca, lang),
    (fr ? '- Dépenses : ' : '- Expenses: ') + fmtMoney(k.depenses, lang),
    (fr ? '- Marge nette : ' : '- Net margin: ') + fmtMoney(k.marge, lang),
    (fr ? '- Taux de marge : ' : '- Margin rate: ') + fmtPct(k.taux, lang),
    (fr ? '- Clients actifs : ' : '- Active customers: ') + fmtInt(k.clients, lang),
    (fr ? '- Panier moyen : ' : '- Average basket: ') + fmtMoney(k.panier, lang),
    (fr ? '- Coût par client : ' : '- Cost per customer: ') + fmtMoney(k.cout, lang)
  );
  if (avance.length) L.push('', fr ? 'Données du mode avancé :' : 'Advanced mode data:', ...avance);
  return L.join('\n');
}

module.exports = createHandler('rapport', async function ({ body, lang, outLang }) {
  const ca = requireNumber(body.ca, { name: 'ca' });
  const dep = requireNumber(body.depenses, { name: 'depenses' });
  const cli = Math.round(requireNumber(body.clients, { name: 'clients', max: 1e9 }));
  const k = kpis(ca, dep, cli);
  const av = lireAvance(body);
  const x = av ? calculAvance(k, av) : {};

  const out = await llm.complete({
    system: prompt(lang, k, av, x) + consigneLangue(outLang),
    messages: [{ role: 'user', content: lang === 'fr' ? 'Rédige le rapport maintenant.' : 'Write the report now.' }],
    maxTokens: av ? 1800 : 1200
  });

  let md = llm.stripThinking(out.text);
  const fence = md.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  if (fence) md = fence[1].trim();
  const firstTitle = md.indexOf('# ');
  if (firstTitle > 0) md = md.slice(firstTitle);
  if (!/^#\s/.test(md)) md = '# ' + (lang === 'fr' ? 'Rapport d\'activité' : 'Activity report') + '\n\n' + md;
  if (md.length < 80) throw new llm.LlmError('bad_model_output', 'rapport trop court');

  return { rapport_markdown: md, indicateurs: Object.assign({ mois: k }, x), __meta: { provider: out.provider, model: out.model } };
});

module.exports._internals = { kpis, lireAvance, calculAvance, lignesAvance };
