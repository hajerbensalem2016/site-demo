'use strict';
/* ============================================================
   POST /api/rapport — démo « Rapport automatique »
   Requête  : { lang: "fr"|"en", ca: number, depenses: number, clients: number }
   Réponse  : { rapport_markdown }
   Les indicateurs (marge, taux, panier moyen, coût par client) sont
   calculés ici, en JavaScript, puis fournis au modèle : l'IA rédige,
   elle ne calcule pas (zéro erreur d'arithmétique dans le rapport).
   Clés API : variables d'environnement uniquement (voir _lib/llm.js).
   ============================================================ */

const { createHandler, requireNumber } = require('./_lib/http');
const llm = require('./_lib/llm');

function fmtMoney(n, lang) {
  return new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}
function fmtPct(n, lang) {
  return (Math.round(n * 10) / 10).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB') + (lang === 'fr' ? ' %' : '%');
}
function fmtInt(n, lang) {
  return new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-GB').format(n);
}

function kpis(ca, dep, cli, lang) {
  const marge = ca - dep;
  const taux = ca > 0 ? (marge / ca) * 100 : 0;
  const panier = cli > 0 ? ca / cli : 0;
  const cout = cli > 0 ? dep / cli : 0;
  const sante = taux >= 30 ? (lang === 'fr' ? 'excellente' : 'excellent') : taux >= 15 ? (lang === 'fr' ? 'saine' : 'healthy') : (lang === 'fr' ? 'fragile' : 'fragile');
  const date = new Date().toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', { month: 'long', year: 'numeric' });
  return { marge: marge, taux: taux, panier: panier, cout: cout, sante: sante, date: date };
}

function prompt(lang, ca, dep, cli, k) {
  if (lang === 'fr') {
    return [
      'Tu es un analyste financier qui rédige des rapports d\'activité courts pour des petites entreprises. Rédige en français, ton professionnel et concret.',
      'Réponds UNIQUEMENT en Markdown simple (titres #, ##, gras **, listes - ou 1., tableau | a | b |). Pas de bloc de code, pas de texte avant le premier titre, pas d\'emoji.',
      'Utilise EXACTEMENT les chiffres fournis (déjà formatés) sans les recalculer ni en inventer d\'autres.',
      '',
      'Structure imposée :',
      '# Rapport d\'activité — ' + k.date,
      '## Synthèse (un paragraphe de 3 à 4 phrases : chiffre d\'affaires, dépenses, marge, nombre de clients, panier moyen, verdict de rentabilité « ' + k.sante + ' »)',
      '## Indicateurs clés (tableau à 2 colonnes « Indicateur | Valeur » avec les 7 lignes ci-dessous, dans cet ordre)',
      '## Recommandations (3 recommandations numérotées, chacune en 1 à 2 phrases, adaptées au taux de marge et au panier moyen, dont une sur l\'automatisation des tâches répétitives)',
      '## Prochaine étape (2 phrases : ce rapport peut être généré et envoyé automatiquement chaque semaine — Google Sheets → n8n → IA → PDF → email + Slack — temps gagné estimé **3 heures par semaine**)',
      '',
      'Chiffres à utiliser :',
      '- Chiffre d\'affaires : ' + fmtMoney(ca, lang),
      '- Dépenses : ' + fmtMoney(dep, lang),
      '- Marge nette : ' + fmtMoney(k.marge, lang),
      '- Taux de marge : ' + fmtPct(k.taux, lang),
      '- Clients actifs : ' + fmtInt(cli, lang),
      '- Panier moyen : ' + fmtMoney(k.panier, lang),
      '- Coût par client : ' + fmtMoney(k.cout, lang)
    ].join('\n');
  }
  return [
    'You are a financial analyst who writes short activity reports for small businesses. Write in English, professional and concrete tone.',
    'Answer ONLY in simple Markdown (headings #, ##, bold **, lists - or 1., table | a | b |). No code block, no text before the first heading, no emoji.',
    'Use EXACTLY the figures provided (already formatted); never recalculate or invent other numbers.',
    '',
    'Required structure:',
    '# Activity report — ' + k.date,
    '## Summary (one paragraph of 3 to 4 sentences: revenue, expenses, margin, number of customers, average basket, profitability verdict "' + k.sante + '")',
    '## Key indicators (2-column table "Indicator | Value" with the 7 rows below, in this order)',
    '## Recommendations (3 numbered recommendations, 1 to 2 sentences each, tailored to the margin rate and average basket, including one about automating repetitive tasks)',
    '## Next step (2 sentences: this report can be generated and sent automatically every week — Google Sheets → n8n → AI → PDF → email + Slack — estimated time saved **3 hours per week**)',
    '',
    'Figures to use:',
    '- Revenue: ' + fmtMoney(ca, lang),
    '- Expenses: ' + fmtMoney(dep, lang),
    '- Net margin: ' + fmtMoney(k.marge, lang),
    '- Margin rate: ' + fmtPct(k.taux, lang),
    '- Active customers: ' + fmtInt(cli, lang),
    '- Average basket: ' + fmtMoney(k.panier, lang),
    '- Cost per customer: ' + fmtMoney(k.cout, lang)
  ].join('\n');
}

module.exports = createHandler('rapport', async function ({ body, lang }) {
  const ca = requireNumber(body.ca, { name: 'ca' });
  const dep = requireNumber(body.depenses, { name: 'depenses' });
  const cli = Math.round(requireNumber(body.clients, { name: 'clients', max: 1e9 }));
  const k = kpis(ca, dep, cli, lang);

  const out = await llm.complete({
    system: prompt(lang, ca, dep, cli, k),
    messages: [{ role: 'user', content: lang === 'fr' ? 'Rédige le rapport maintenant.' : 'Write the report now.' }],
    maxTokens: 1200
  });

  let md = llm.stripThinking(out.text);
  const fence = md.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  if (fence) md = fence[1].trim();
  const firstTitle = md.indexOf('# ');
  if (firstTitle > 0) md = md.slice(firstTitle);
  if (!/^#\s/.test(md)) md = '# ' + (lang === 'fr' ? 'Rapport d\'activité — ' : 'Activity report — ') + k.date + '\n\n' + md;
  if (md.length < 80) throw new llm.LlmError('bad_model_output', 'rapport trop court');

  return { rapport_markdown: md, __meta: { provider: out.provider, model: out.model } };
});
