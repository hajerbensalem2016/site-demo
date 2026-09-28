// Traduit les textes du site (dictionnaires PAGE_I18N des pages + dictionnaire commun d'app.js)
// de l'anglais vers l'arabe, l'allemand et l'espagnol, avec Groq (gratuit).
//
//   GROQ_API_KEY=... node scripts/traduire.mjs            -> ajoute les langues manquantes
//   GROQ_API_KEY=... node scripts/traduire.mjs --force    -> retraduit tout
//
// Les clés, les variables {n}, les retours à la ligne et les noms de marques sont conservés.
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const LANGS = { ar: 'Modern Standard Arabic', de: 'German', es: 'Spanish (neutral, understood in Spain and Latin America)' };
const FORCE = process.argv.includes('--force');
const KEY = process.env.GROQ_API_KEY;
if (!KEY) { console.error('GROQ_API_KEY manquante'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function traduire(dict, langue) {
  const entrees = Object.entries(dict);
  const out = {};
  for (let i = 0; i < entrees.length; i += 25) {
    const lot = Object.fromEntries(entrees.slice(i, i + 25));
    const prompt = [
      `Translate the VALUES of this JSON object from English to ${LANGS[langue]} for a professional business website (automation, AI, web and mobile development agency named HBSGo).`,
      'Rules: return ONLY a JSON object with exactly the same keys. Keep placeholders like {n}, {max}, {s}, {d}, {v}, {e}, {k}, {email}, {year}, {date}, {source}, {total} unchanged.',
      'Keep line breaks (\\n), bullets, symbols (→ ▲ ▼ ✓ ⚠ · — …), URLs, email addresses and brand/product names unchanged: HBSGo, n8n, Make, Zapier, Google Sheets, Gmail, Outlook, Slack, Notion, Airtable, HubSpot, GoHighLevel, Stripe, Shopify, WhatsApp, Vapi, Retell, ElevenLabs, Twilio, Loom, Claude, OpenAI, Groq, Gemini, Python, JavaScript, CRM, PDF, CSV, Excel.',
      'Use a natural, concise, professional tone. Address the visitor politely (German: "Sie"; Spanish: "usted").',
      JSON.stringify(lot)
    ].join('\n');
    for (let essai = 0; ; essai++) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
        body: JSON.stringify({ model: 'openai/gpt-oss-120b', temperature: 0.2, max_tokens: 6000, reasoning_effort: 'low', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] })
      });
      if (r.status === 429 && essai < 8) { await sleep(8000 * (essai + 1)); continue; }
      const j = await r.json();
      if (!r.ok) throw new Error('Groq ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
      const res = JSON.parse(j.choices[0].message.content);
      for (const k of Object.keys(lot)) {
        if (typeof res[k] !== 'string') throw new Error('clé manquante ' + k);
        const vars = (lot[k].match(/\{[a-z_]+\}/g) || []).sort().join();
        const vars2 = (res[k].match(/\{[a-z_]+\}/g) || []).sort().join();
        if (vars !== vars2) throw new Error('variables modifiées pour ' + k + ' : ' + vars + ' / ' + vars2);
        out[k] = res[k];
      }
      break;
    }
    await sleep(2500);
  }
  return out;
}

function lireObjet(src, debut, fin) {
  const a = src.indexOf(debut);
  if (a < 0) return null;
  const b = src.indexOf(fin, a);
  const code = src.slice(a + debut.length - 1, b + fin.indexOf('}') + 1); /* de "{" à "}" */
  return { a, b: b + fin.length, obj: Function('return (' + code + ')')() };
}

async function traiterDict(nom, obj) {
  for (const l of Object.keys(LANGS)) {
    if (obj[l] && !FORCE) { console.log('  ' + nom + ' : ' + l + ' déjà présent'); continue; }
    process.stdout.write('  ' + nom + ' : ' + l + '…');
    obj[l] = await traduire(obj.en, l);
    console.log(' ok (' + Object.keys(obj[l]).length + ' textes)');
  }
  return obj;
}

const pages = ['index.html', 'contact/index.html'].concat(fs.readdirSync(path.join(ROOT, 'demos')).map((d) => 'demos/' + d + '/index.html'));
for (const p of pages) {
  const f = path.join(ROOT, p);
  let src = fs.readFileSync(f, 'utf8');
  const r = lireObjet(src, 'window.PAGE_I18N = {', '};');
  if (!r) { console.log(p + ' : pas de textes'); continue; }
  console.log(p);
  const obj = await traiterDict(p, r.obj);
  src = src.slice(0, r.a) + 'window.PAGE_I18N = ' + JSON.stringify(obj, null, 2).replace(/\n/g, '\n    ') + ';' + src.slice(r.b);
  fs.writeFileSync(f, src);
}

/* dictionnaire commun d'app.js : var i18n = { fr: {...}, en: {...} }; */
{
  const f = path.join(ROOT, 'app.js');
  let src = fs.readFileSync(f, 'utf8');
  const r = lireObjet(src, 'var i18n = {', '\n  };');
  console.log('app.js');
  const obj = await traiterDict('app.js', r.obj);
  src = src.slice(0, r.a) + 'var i18n = ' + JSON.stringify(obj, null, 2).replace(/\n/g, '\n  ') + ';' + src.slice(r.b);
  fs.writeFileSync(f, src);
}
console.log('terminé');
