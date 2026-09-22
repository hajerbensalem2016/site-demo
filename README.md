# Site de démos interactives — Hajer, Automatisation & IA

Site vitrine 100 % gratuit (HTML / CSS / JavaScript purs, sans framework) qui permet aux clients Upwork et Malt de **tester eux-mêmes** chaque service avant de prendre contact : agent email IA, automatisation n8n, chatbot, agent vocal, scraping, CRM Notion/Airtable, rapport automatique.

- Bilingue FR / EN (bouton en haut, langue mémorisée en `localStorage`).
- Mode clair / sombre automatique (`prefers-color-scheme`) + bouton de bascule.
- 5 tests gratuits par démo et par jour (compteur `localStorage`, message clair quand la limite est atteinte).
- **Aucune clé API dans le front** : les appels IA passent par des fonctions serverless Vercel `/api/*.js` ; les webhooks n8n et embeds sont des URLs publiques dans `config.js`.
- **Mode démo hors ligne** : tant qu'un backend ou un webhook n'est pas configuré (valeur `TODO_…`) ou qu'un appel échoue, chaque démo affiche une simulation locale avec un bandeau, pour que le site reste présentable.

## Structure

```
site-demo/
  index.html                 accueil : promesse, 7 cartes de démos, méthode, appel à l'action
  style.css                  styles communs (variables CSS, clair/sombre, mobile)
  app.js                     i18n, thème, limite de tests, helpers fetch, en-tête/pied de page, Loom, CTA
  config.js                  URLs publiques configurables (webhooks, Loom, embeds, Vapi, Upwork, Malt)
  vercel.json                configuration Vercel (URLs propres, en-têtes)
  data/prix.json             données d'exemple de la démo scraping (8 lignes), réécrit chaque jour par l'Action
  data/kpi.json              KPI calculés par scripts/rapport_kpi.py depuis data/ventes_exemple.csv
  scripts/                   scripts Python (scraping, veille RSS, KPI) + tests pytest, voir scripts/README.md
  .github/workflows/scraping.yml  GitHub Action quotidienne + workflow_dispatch qui commite les JSON dans data/
  demos/
    agent-email/index.html   colle un email -> catégorie, urgence, résumé, réponse rédigée   (POST /api/agent-email)
    automatisation/index.html formulaire -> Google Sheets + email + Slack via webhook n8n    (webhookAutomatisation)
    chatbot/index.html       chatbot maison (widget)                                        (POST /api/chat)
    agent-vocal/index.html   appel via widget Vapi (clé publique) ou transcription simulée + vidéo Loom
    scraping/index.html      tableau filtrable depuis data/prix.json + bouton mise à jour   (webhookScraping)
    crm-notion/index.html    formulaire lead -> scoring + kanban + embed Airtable/Notion     (webhookCrm)
    rapport/index.html       3 chiffres -> rapport Markdown rendu, export .md / impression PDF (POST /api/rapport)
  api/                       fonctions serverless Vercel (Node.js, fetch natif, zéro dépendance npm)
    chat.js                  POST /api/chat        chatbot (assistant de l'agence, 6 derniers messages)
    agent-email.js           POST /api/agent-email email brut -> { categorie, urgence, resume, reponse_proposee }
    rapport.js               POST /api/rapport     chiffres -> { rapport_markdown }
    _lib/llm.js              appel unifié Gemini (gratuit) -> Groq (secours), bascule automatique
    _lib/ratelimit.js        20 requêtes / heure / IP (compteur en mémoire)
    _lib/http.js             CORS, OPTIONS, lecture du corps, erreurs bilingues FR/EN
    _test.mjs                tests locaux : node api/_test.mjs   (les fichiers « _ » ne sont pas déployés comme fonctions)
  n8n/                       5 workflows n8n importables (JSON, sans identifiant) + README-01…05.md + README.md (n8n gratuit, import, CORS)
    01-demo-automatisation   webhook -> Google Sheets -> Gmail -> réponse au site        (webhookAutomatisation)
    02-demo-crm              webhook -> scoring -> Airtable -> réponse { ok, message, score } (webhookCrm)
    03-demo-rapport          webhook -> /api/rapport -> Markdown -> email Gmail + .md
    04-agent-email-gmail     toutes les 15 min : Gmail non lus -> /api/agent-email -> brouillon + label
    05-veille-quotidienne    chaque matin : Google Sheet ou data/prix.json -> résumé Gmail
```

Chaque page de démo contient : titre + bénéfice (heures gagnées / semaine), zone de test, emplacement vidéo Loom (`TODO_LOOM`), « Comment ça marche » en 3 étapes, bloc « Vous voulez ça pour votre entreprise ? » (boutons Upwork / Malt), lien retour.

## Déployer en 5 minutes sur Vercel (gratuit)

### Option A — depuis le terminal (Vercel CLI)

```bash
cd site-demo
npx vercel login          # une seule fois, compte gratuit "Hobby"
npx vercel --prod         # répondre "Y" pour créer le projet, garder les valeurs par défaut
```

Vercel affiche l'URL publique (`https://<projet>.vercel.app`). Chaque nouveau `npx vercel --prod` redéploie.

### Option B — depuis GitHub (déploiement automatique à chaque push)

1. Créer un dépôt GitHub et y pousser le contenu de `site-demo/` (le dossier doit être la racine du dépôt, ou indiquer `site-demo` comme *Root Directory* dans Vercel).
2. Sur https://vercel.com → *Add New Project* → importer le dépôt → *Framework Preset : Other* → *Deploy*.
3. Dans *Settings → Environment Variables*, ajouter la clé secrète utilisée par `/api/*.js` : `GEMINI_API_KEY` (gratuite, voir la section « Backend IA »). Elle n'est jamais exposée au navigateur.

### Alternative : GitHub Pages

Le site statique fonctionne aussi sur GitHub Pages (Settings → Pages → branche `main`, dossier `/`). Les routes `/api/*` n'existent pas sur GitHub Pages : les démos IA resteront en « mode démo hors ligne » (simulation locale). Les webhooks n8n et le widget Vapi fonctionnent normalement.

## Tester en local

```bash
cd site-demo
python -m http.server 8080
# puis ouvrir http://localhost:8080/
```

Sans backend, toutes les démos basculent automatiquement en mode hors ligne (bandeau orange).

Pour tester les routes `/api/*` en local avec l'IA :

```bash
cd site-demo
node api/_test.mjs                      # tests sans clé (validation, CORS, limitation, bascule simulée)
GEMINI_API_KEY=... node api/_test.mjs   # ajoute un appel réel par route (PowerShell : $env:GEMINI_API_KEY="..."; node api/_test.mjs)
npx vercel dev                          # site + fonctions sur http://localhost:3000 (lit les variables de .env.local — ne jamais committer ce fichier)
```

## Configuration (`config.js`)

Toutes les valeurs commençant par `TODO_` sont à remplacer. Tant qu'elles restent à `TODO_`, la démo correspondante affiche une simulation locale.

| Clé | Rôle | Fourni par |
|---|---|---|
| `webhookAutomatisation` | URL du webhook n8n « formulaire → Sheets + email + Slack » | agent constructeur-workflows-n8n |
| `webhookCrm` | URL du webhook n8n « lead → CRM Notion/Airtable » | agent constructeur-workflows-n8n |
| `webhookScraping` | URL du webhook n8n qui lance le script Python de collecte | agent constructeur-workflows-n8n / scripts Python |
| `vapiPublicKey`, `vapiAssistantId` | Clé **publique** Vapi + ID de l'assistant (widget d'appel navigateur) | Hajer (compte Vapi gratuit) |
| `loom.*` | URLs d'embed Loom (`https://www.loom.com/embed/<id>`) pour chaque démo | Hajer |
| `sheetEmbed` | URL d'un Google Sheet publié sur le web (démo automatisation) | Hajer |
| `airtableEmbed` | URL d'une vue Airtable / page Notion partagée (démo CRM) | Hajer |
| `upwork`, `malt` | Liens vers les profils | Hajer |
| `maxTestsPerDay` | Limite de tests par démo et par jour (5) | — |

## Backend IA (`api/`, 100 % gratuit)

Les trois démos IA tournent sur des fonctions serverless Vercel en Node.js (`api/chat.js`, `api/agent-email.js`, `api/rapport.js`), sans aucune dépendance npm. Le modèle est appelé via `api/_lib/llm.js` : **Google Gemini en premier (niveau gratuit), Groq en secours**, avec bascule automatique — chaque modèle de la liste est essayé dans l'ordre ; un `429` (quota atteint), un `5xx`, un délai dépassé ou une erreur réseau passe au suivant, et un modèle en `429` est mis « en repos » (durée du `Retry-After`, 60 s par défaut) pour ne pas être re-sollicité inutilement. Si tout échoue, la route répond `503` et le front affiche sa simulation locale (bandeau hors ligne) : le site reste présentable quoi qu'il arrive.

### 1. Obtenir la clé Gemini gratuite (2 minutes, sans carte bancaire)

1. Ouvrir https://aistudio.google.com avec un compte Google.
2. Menu *Get API key* → *Create API key* (créer un projet Google Cloud si demandé — il reste gratuit tant qu'aucune facturation n'est activée).
3. Copier la clé (`AIza…`). Ne jamais la coller dans `config.js`, dans une page HTML ni dans un dépôt Git.

Optionnel, en secours : créer une clé Groq gratuite sur https://console.groq.com → *API Keys* → *Create API Key* (`gsk_…`).

### 2. Ajouter la clé dans Vercel

- Tableau de bord : projet → *Settings* → *Environment Variables* → *Add* : **Key** `GEMINI_API_KEY`, **Value** la clé, environnements *Production*, *Preview* et *Development* cochés → *Save*. Puis *Deployments* → menu `…` du dernier déploiement → *Redeploy* (les variables ne sont lues qu'au déploiement).
- Ou en ligne de commande : `npx vercel env add GEMINI_API_KEY` (puis `npx vercel --prod`).
- En local avec `npx vercel dev` : `npx vercel env pull .env.local` (ou écrire `GEMINI_API_KEY=…` dans `.env.local`).

| Variable | Obligatoire | Rôle |
|---|---|---|
| `GEMINI_API_KEY` | oui (ou `GROQ_API_KEY`) | clé Google AI Studio, fournisseur principal |
| `GROQ_API_KEY` | non | clé Groq, fournisseur de secours si Gemini échoue ou dépasse son quota |
| `ALLOWED_ORIGIN` | recommandé en prod | origines autorisées (CORS), séparées par des virgules, ex. `https://mon-site.vercel.app` ; `*` par défaut (dev) |
| `LLM_PROVIDERS` | non | ordre des fournisseurs, défaut `gemini,groq` |
| `GEMINI_MODELS` | non | liste de modèles à essayer dans l'ordre, défaut `gemini-2.5-flash-lite,gemini-3.5-flash-lite,gemini-2.5-flash` |
| `GROQ_MODELS` | non | défaut `openai/gpt-oss-20b,openai/gpt-oss-120b` |
| `RATE_LIMIT_PER_HOUR` | non | requêtes par IP et par heure, défaut `20` |
| `LLM_TIMEOUT_MS` / `LLM_DEADLINE_MS` | non | délai par appel (12 000) / budget total par requête (22 000) |

### 3. Modèles gratuits et quotas constatés (vérifié le 22 septembre 2026)

**Gemini** — la page tarifs officielle (https://ai.google.dev/gemini-api/docs/pricing) marque « Free of charge » pour `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3.8-flash` et `gemini-3-flash-preview`. Google ne publie plus les chiffres du niveau gratuit dans la doc : les valeurs exactes de votre projet s'affichent dans **AI Studio → Rate limits** (https://aistudio.google.com/rate-limit) et « ne sont pas garanties ». Valeurs rapportées par plusieurs sources tierces en septembre 2026 (à confirmer dans AI Studio) :

| Modèle | Req./min | Req./jour | Tokens/min | Remarque |
|---|---|---|---|---|
| `gemini-2.5-flash-lite` | ~15 | ~1 000 | 250 000 | choix n°1 : rapide, quota journalier le plus large |
| `gemini-3.5-flash-lite` | ~15 | ~1 000 | 250 000 | GA le 21/07/2026, même profil |
| `gemini-2.5-flash` | ~10 | 250 à 1 500 selon les sources | 250 000 | plus « intelligent », quota journalier réduit en 2026 |
| `gemini-2.5-pro` | ~5 | 50 à 100 | 150 000 | non utilisé (trop lent / trop limité pour une démo) |

Les quotas journaliers se remettent à zéro à minuit, heure du Pacifique. Le niveau gratuit est permanent (pas un crédit d'essai) ; en contrepartie, Google peut utiliser les requêtes pour améliorer ses produits — ne pas y envoyer de données confidentielles (c'est un site de démo).

**Groq** (secours) — page officielle https://console.groq.com/docs/rate-limits, onglet *Free Plan* : `openai/gpt-oss-20b`, `openai/gpt-oss-120b` et `qwen/qwen3.8-27b` à **30 req./min, 1 000 req./jour, 8 000 tokens/min, 200 000 tokens/jour**. Les modèles `llama-3.1-8b-instant` et `llama-3.3-70b-versatile` ont quitté le niveau gratuit le 16 août 2026 (réservés aux comptes Enterprise).

Ordre de grandeur de consommation : un test de démo = 1 requête et 400 à 1 500 tokens. Avec la limite front (5 tests / démo / jour) et la limite serveur (20 requêtes / heure / IP), 1 000 requêtes par jour couvrent largement plus d'une centaine de visiteurs quotidiens.

### 4. Protections intégrées

- 20 requêtes par heure et par adresse IP (`429` + `Retry-After`), compteur partagé entre les trois routes.
- Entrée limitée à 4 000 caractères (`400 too_long`), historique du chat réduit aux 6 derniers messages, chiffres du rapport bornés.
- Réponses d'erreur bilingues au format `{ "ok": false, "error": "<code>", "message": "<texte FR ou EN selon lang>" }` — codes : `method_not_allowed`, `rate_limited`, `bad_json`, `too_long`, `invalid_input`, `no_provider`, `llm_unavailable`, `bad_model_output`, `internal`.
- `OPTIONS` → `204` avec les en-têtes CORS ; `ALLOWED_ORIGIN` restreint l'origine en production.
- Les en-têtes `X-LLM-Provider` / `X-LLM-Model` indiquent quel modèle a réellement répondu (pratique pour vérifier la bascule).
- Les indicateurs du rapport (marge, taux, panier moyen, coût par client) sont calculés en JavaScript avant l'appel : l'IA rédige, elle ne calcule pas.

## Contrats API

Le front appelle ces routes avec `fetch` (JSON, `Content-Type: application/json`). Le champ `lang` vaut `"fr"` ou `"en"` : la réponse doit être rédigée dans cette langue. En cas d'échec réseau ou de réponse HTTP non-2xx, le front affiche une simulation locale avec le bandeau « mode démo hors ligne ». Toute clé API (Gemini, Groq…) doit rester dans les variables d'environnement Vercel, jamais dans le front.

### 1. `POST /api/chat` — chatbot

Requête :
```json
{
  "lang": "fr",
  "messages": [
    { "role": "assistant", "content": "Bonjour ! Je suis l'assistant de l'agence…" },
    { "role": "user", "content": "Quels services proposez-vous ?" }
  ]
}
```
- `messages` : historique complet (12 derniers messages max), rôles `user` / `assistant`, ordre chronologique. Le premier message est le message d'accueil du bot.
- Le prompt système (rôle : assistant d'une agence d'automatisation qui présente les services, donne un ordre de tarif et propose un rendez-vous) est défini côté serveur.

Réponse `200` :
```json
{ "reply": "Nous construisons des agents IA, des automatisations n8n…" }
```

### 2. `POST /api/agent-email` — agent email

Requête :
```json
{ "lang": "fr", "email": "Bonjour, j'ai commandé le casque ANC Pro il y a 10 jours…" }
```

Réponse `200` :
```json
{
  "categorie": "Réclamation / SAV",
  "urgence": "haute",
  "resume": "Client sans nouvelles de sa commande #48213 depuis 10 jours, cadeau prévu samedi.",
  "reponse_proposee": "Bonjour,\n\nJe suis désolée pour ce retard…"
}
```
- `urgence` : `"haute" | "moyenne" | "basse"` en FR, `"high" | "medium" | "low"` en EN (le front reconnaît les deux).
- `categorie` : texte libre court (ex. Facturation, Réclamation / SAV, Demande commerciale, Prise de rendez-vous, Candidature, Marketing / Spam, Demande d'information).

### 3. `POST /api/rapport` — rapport d'activité

Requête :
```json
{ "lang": "fr", "ca": 48200, "depenses": 31500, "clients": 37 }
```
- Nombres positifs. `ca` = chiffre d'affaires (€), `depenses` (€), `clients` = nombre de clients.

Réponse `200` :
```json
{ "rapport_markdown": "# Rapport d'activité — septembre 2026\n\n## Synthèse\n…" }
```
- Markdown simple : titres `#`/`##`/`###`, gras `**`, listes `-` ou `1.`, tableaux `| a | b |`. Le front le rend en HTML, propose le téléchargement `.md` et l'impression PDF.

### 4. Webhooks n8n (automatisation et CRM)

Le front envoie `POST` (JSON) à l'URL `window.DEMO_CONFIG.webhookAutomatisation` ou `window.DEMO_CONFIG.webhookCrm`.

Requête :
```json
{ "nom": "Marie Dupont", "email": "marie@dupont.fr", "entreprise": "Dupont & Fils", "besoin": "Automatiser l'envoi de nos devis" }
```

Réponse `200` attendue :
```json
{ "ok": true, "message": "Lead enregistré, email de bienvenue envoyé." }
```
- Le webhook doit répondre avec les en-têtes CORS : `Access-Control-Allow-Origin: *` (ou le domaine Vercel), `Access-Control-Allow-Headers: Content-Type`, et répondre `204` aux requêtes `OPTIONS` (dans n8n : nœud Webhook → *Options → Allowed Origins (CORS)*).
- `webhookCrm` peut renvoyer en plus `"score": 72` (0–100) ; sinon le front calcule un score local.
- Si `ok` n'est pas `true` ou si l'appel échoue, le front affiche la simulation locale avec le bandeau hors ligne.

### 5. Démo scraping

- Au chargement, le front lit `data/prix.json` : tableau d'objets `{ "titre": string, "prix": number, "lien": string, "note": number }` (note sur 5). Le script Python de collecte peut réécrire ce fichier (commit + redéploiement) ou le front peut être pointé vers une autre URL.
- Bouton « Lancer une mise à jour » : `POST window.DEMO_CONFIG.webhookScraping` avec `{ "cible": "https://… ou ville (peut être vide)" }`. Réponse attendue `{ "ok": true, "message": "…", "resultats": [ { titre, prix, lien, note }, … ] }` ; `resultats` est optionnel (s'il est présent et non vide, il remplace le tableau affiché). Délai d'attente : 60 s. Mêmes exigences CORS que ci-dessus.

### 6. Démo agent vocal

- Si `vapiPublicKey` et `vapiAssistantId` sont définis : chargement du widget Vapi depuis le CDN (`https://cdn.jsdelivr.net/gh/VapiAI/html-script-tag@latest/dist/assets/index.js`) et appel navigateur via `window.vapiSDK.run({ apiKey, assistant })`. La clé publique Vapi est conçue pour être exposée côté client ; limiter l'assistant à 2 minutes par appel dans le tableau de bord Vapi pour protéger le crédit gratuit.
- Sinon : transcription simulée d'un appel type (aucun service payant) et vidéo Loom de remplacement (`loom.agentVocal`).

## Limite de tests

Clé `localStorage` : `demo_quota_<slug>_<AAAA-MM-JJ>` (slugs : `agent-email`, `automatisation`, `chatbot`, `agent-vocal`, `scraping`, `crm-notion`, `rapport`). Compteur incrémenté à chaque test ; à 5, les boutons sont désactivés et un message invite à revenir demain ou à contacter Hajer. Le compteur est côté navigateur : c'est une protection contre l'usage abusif involontaire, pas une sécurité — les routes `/api/*` doivent aussi limiter (par IP) côté serveur.

## TODO restants

- `TODO_WEBHOOK_AUTOMATISATION`, `TODO_WEBHOOK_CRM`, `TODO_WEBHOOK_SCRAPING` (config.js) — URLs n8n. Les deux premiers sont fournis par `n8n/01-demo-automatisation.json` et `n8n/02-demo-crm.json` une fois importés et activés (voir `n8n/README.md`).
- `TODO_VAPI_PUBLIC_KEY`, `TODO_VAPI_ASSISTANT_ID` (config.js) — widget d'appel.
- `TODO_LOOM_*` (config.js, 7 vidéos) — remplacer par `https://www.loom.com/embed/<id>`.
- `TODO_SHEET_EMBED`, `TODO_AIRTABLE_EMBED` (config.js) — embeds publics optionnels.
- `TODO_UPWORK`, `TODO_MALT` (config.js) — liens profils.
- `GEMINI_API_KEY` (Vercel → Settings → Environment Variables) — sans elle, les trois démos IA restent en mode hors ligne. Optionnel : `GROQ_API_KEY` (secours) et `ALLOWED_ORIGIN` (CORS restreint au domaine du site).
- Activer l'Action GitHub `scraping.yml` (Settings → Actions → Workflow permissions : *Read and write*) ; secrets optionnels `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEET_ID` et variable `FLUX_RSS` — voir `scripts/README.md`.
