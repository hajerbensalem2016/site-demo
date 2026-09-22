# Workflows n8n du site de démos (100 % gratuit)

Cinq workflows n8n importables tels quels, qui alimentent les démos du site (`site-demo/`) et deux automatisations Gmail. Aucune clé ni identifiant n'est stocké dans les fichiers : les credentials sont référencés **par nom** et créés une fois dans n8n.

| Fichier | Rôle | Déclencheur | Services (gratuits) |
|---|---|---|---|
| `01-demo-automatisation.json` | Formulaire du site → ligne Google Sheets → email de bienvenue → réponse au site | Webhook `POST /webhook/demo-automatisation` | Google Sheets, Gmail (Slack optionnel) |
| `02-demo-crm.json` | Formulaire du site → scoring 0-100 → fiche Airtable → réponse au site (avec `score`) | Webhook `POST /webhook/demo-crm` | Airtable |
| `03-demo-rapport.json` | Webhook → `/api/rapport` du site → Markdown → HTML → email Gmail + pièce jointe `.md` | Webhook `POST /webhook/demo-rapport` | Gmail, site Vercel |
| `04-agent-email-gmail.json` | Emails non lus → `/api/agent-email` du site → brouillon de réponse + label | Toutes les 15 min | Gmail, site Vercel |
| `05-veille-quotidienne.json` | Résultats du scraper (Google Sheet ou `data/prix.json`) → résumé HTML par email | Chaque matin 8 h | Google Sheets ou HTTP, Gmail |

Chaque workflow a son guide détaillé : `README-01.md` … `README-05.md` (variables à remplacer, credentials, test en 3 étapes, exemple `curl`).

Versions de nœuds utilisées (vérifiées sur les sources n8n en septembre 2026, importables dans n8n 1.x récent) : Webhook 2.1, Respond to Webhook 1.4, Edit Fields (Set) 3.4, IF 2.2, Code 2, Google Sheets 4.5, Gmail 2.1, Airtable 2.1, HTTP Request 4.2, Schedule Trigger 1.2, Markdown 1, Convert to File 1.1.

---

## 1. Installer n8n gratuitement

### Option A — Docker sur votre PC (recommandé pour tester)

Installer [Docker Desktop](https://www.docker.com/products/docker-desktop/) (gratuit), puis dans PowerShell :

```powershell
docker run -it --rm --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n -e GENERIC_TIMEZONE="Europe/Paris" -e TZ="Europe/Paris" n8nio/n8n
```

Ouvrir http://localhost:5678 et créer le compte propriétaire (local, gratuit). Le volume `n8n_data` conserve workflows et credentials entre deux lancements.

### Option B — Render (niveau gratuit, n8n accessible en permanence sur Internet)

1. https://render.com → *New → Web Service* → *Deploy an existing image* → image `n8nio/n8n`, plan **Free**.
2. Variables d'environnement : `N8N_PORT=5678`, `N8N_PROTOCOL=https`, `N8N_HOST=<nom>.onrender.com`, `WEBHOOK_URL=https://<nom>.onrender.com/`, `GENERIC_TIMEZONE=Europe/Paris`, `N8N_ENCRYPTION_KEY=<une longue chaîne aléatoire>`.
3. Limites du plan gratuit : le service **s'endort après 15 min d'inactivité** (premier appel ≈ 30-60 s, le site affiche alors le mode hors ligne ; le deuxième clic passe) et **le disque n'est pas persistant** (SQLite perdu à chaque redéploiement). Pour conserver les données, brancher une base Postgres gratuite (Neon ou Supabase) avec `DB_TYPE=postgresdb`, `DB_POSTGRESDB_HOST`, `DB_POSTGRESDB_DATABASE`, `DB_POSTGRESDB_USER`, `DB_POSTGRESDB_PASSWORD`, `DB_POSTGRESDB_PORT=5432`, `DB_POSTGRESDB_SSL_ENABLED=true`. Sinon, ré-importer les JSON après un redéploiement.

Les workflows planifiés (04 et 05) ne tournent que si n8n est allumé : sur un PC éteint, rien ne se passe. Render (ou un autre hébergement) est préférable pour ces deux-là.

---

## 2. Obtenir une URL de webhook publique gratuite (pour les tests)

Le site est hébergé sur Vercel : il doit pouvoir joindre n8n depuis Internet. `http://localhost:5678` n'est pas accessible depuis le site en ligne (il l'est seulement quand vous ouvrez le site en local, `python -m http.server 8080`).

### Tunnel n8n intégré (le plus simple)

```powershell
docker run -it --rm --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n -e GENERIC_TIMEZONE="Europe/Paris" n8nio/n8n start --tunnel
```

n8n affiche une URL du type `https://xxxx.hooks.n8n.cloud/` et l'utilise automatiquement dans les URLs de webhook. Réservé aux tests (URL qui change à chaque démarrage, aucune garantie de disponibilité).

### ngrok (gratuit)

```powershell
# 1) n8n en local (option A), puis dans un autre terminal :
ngrok http 5678
# 2) relancer n8n en lui indiquant l'URL publique affichée par ngrok :
docker run -it --rm --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n -e WEBHOOK_URL="https://xxxx.ngrok-free.app/" -e GENERIC_TIMEZONE="Europe/Paris" n8nio/n8n
```

`WEBHOOK_URL` sert à n8n pour afficher les bonnes URLs de webhook et de callback OAuth. Avec le plan gratuit ngrok, l'URL change à chaque lancement (un domaine statique gratuit est proposé dans le tableau de bord ngrok).

---

## 3. Importer les workflows

1. n8n → *Workflows* → bouton **⋯ / Import from File** (ou *Create Workflow* → menu ⋯ → *Import from File*).
2. Choisir le fichier JSON. Le workflow s'ouvre avec une note jaune qui rappelle les valeurs à remplacer.
3. Ouvrir chaque nœud marqué d'un triangle d'alerte et sélectionner le credential (créé à l'étape 4).
4. Remplacer les valeurs `TODO_…` (voir tableau ci-dessous).
5. **Save**, puis pour les webhooks : tester avec l'URL *Test* (bouton *Listen for test event*), et enfin activer le workflow (**Active**) pour obtenir l'URL de **production** `https://<n8n>/webhook/<chemin>`.

Ordre d'import conseillé : **01 → 02 → 03 → 05 → 04** (les trois webhooks d'abord pour brancher le site, puis la veille, puis l'agent email qui demande la création d'un label Gmail).

| Variable | Où | Workflows |
|---|---|---|
| `TODO_GOOGLE_SHEET_ID` | ID dans l'URL du Google Sheet (`https://docs.google.com/spreadsheets/d/<ID>/edit`) | 01, 05 |
| `appTODOBASEID`, `tblTODOTABLEID` | IDs Airtable (URL `https://airtable.com/app…/tbl…/…`) | 02 |
| `TODO_SITE_URL` | URL publique du site Vercel, sans `/` final (ex. `https://mon-site.vercel.app`) | 03, 04, 05 |
| `TODO_EMAIL_DESTINATAIRE` | Adresse qui reçoit la veille | 05 |
| `TODO_SLACK_WEBHOOK_URL` | Webhook entrant Slack (optionnel, nœud désactivé) | 01 |

---

## 4. Créer les credentials (une seule fois)

n8n → *Credentials* → *Add credential*. Les noms ci-dessous sont ceux référencés dans les JSON ; n8n retrouve le credential par son nom à l'import, sinon sélectionnez-le à la main dans chaque nœud.

### `Gmail account` et `Google Sheets account` (OAuth2 Google, gratuit)

1. https://console.cloud.google.com → créer un projet (ex. `n8n-demos`).
2. *APIs & Services → Library* : activer **Gmail API**, **Google Sheets API** et **Google Drive API** (nécessaire au sélecteur de fichiers du nœud Sheets).
3. *OAuth consent screen* : type **External**, remplir nom + email, puis **ajouter votre adresse Gmail dans *Test users*** (sans cela, Google bloque la connexion avec « application non vérifiée »).
4. *Credentials → Create credentials → OAuth client ID → Web application*. Dans n8n, ouvrir *Add credential → Gmail OAuth2 API* : copier l'**OAuth Redirect URL** affichée et la coller dans *Authorized redirect URIs* côté Google. Créer, puis copier *Client ID* et *Client secret* dans n8n → *Sign in with Google*.
5. Répéter avec *Google Sheets OAuth2 API* (même client ID/secret, même URL de redirection).

Astuce : l'URL de redirection dépend de l'adresse de n8n (localhost, tunnel, Render). Vous pouvez ajouter plusieurs URIs autorisés dans Google Cloud.

### `Airtable Personal Access Token account`

https://airtable.com/create/tokens → *Create token* : scopes `data.records:read`, `data.records:write`, `schema.bases:read`, accès à la base de la démo. Coller le jeton dans n8n → *Airtable Personal Access Token API*.

---

## 5. Brancher le site (`site-demo/config.js`)

Une fois les workflows **activés**, copier les URLs de production :

```js
webhookAutomatisation: "https://<n8n>/webhook/demo-automatisation",
webhookCrm:            "https://<n8n>/webhook/demo-crm",
```

(`webhookScraping` est fourni par le workflow/script de scraping ; le contrat attendu est `POST { cible }` → `{ ok, message, resultats? }` avec les mêmes en-têtes CORS.)

Redéployer le site (`npx vercel --prod`). Tant qu'une valeur reste `TODO_…`, la démo affiche une simulation locale.

### CORS

Le site (domaine Vercel) appelle n8n (autre domaine) depuis le navigateur. Deux mécanismes sont en place :

- Nœud **Webhook** → *Options → Allowed Origins (CORS)* = `*` : n8n répond **204** aux requêtes préflight `OPTIONS` et ajoute `Access-Control-Allow-Origin`.
- Nœud **Respond to Webhook** : en-têtes explicites `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Content-Type`, `Access-Control-Allow-Methods: POST, OPTIONS` sur la réponse JSON.

Vérification du préflight :

```bash
curl -i -X OPTIONS "https://<n8n>/webhook/demo-automatisation" -H "Origin: https://mon-site.vercel.app" -H "Access-Control-Request-Method: POST"
```

Réponse attendue : `HTTP/1.1 204` avec `Access-Control-Allow-Origin`.

---

## 6. Tester un webhook depuis le terminal

PowerShell :

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:5678/webhook-test/demo-automatisation" -ContentType "application/json; charset=utf-8" -Body '{"nom":"Marie Dupont","email":"marie@dupont.fr","entreprise":"Dupont & Fils","besoin":"Automatiser l''envoi de nos devis"}'
```

bash / Git Bash :

```bash
curl -X POST "http://localhost:5678/webhook-test/demo-automatisation" -H "Content-Type: application/json" -d '{"nom":"Marie Dupont","email":"marie@dupont.fr","entreprise":"Dupont & Fils","besoin":"Automatiser l'"'"'envoi de nos devis"}'
```

`webhook-test/…` fonctionne seulement après avoir cliqué *Listen for test event* dans l'éditeur (une exécution) ; `webhook/…` fonctionne en continu quand le workflow est **Active**.

---

## 7. Problèmes fréquents

| Symptôme | Cause / solution |
|---|---|
| `404 webhook … not registered` | Le workflow n'est pas actif (URL de production) ou vous n'avez pas cliqué *Listen for test event* (URL de test). |
| Le site affiche « mode démo hors ligne » | L'URL dans `config.js` est encore `TODO_…`, la réponse n'est pas `{ ok: true }`, le workflow a planté (voir *Executions*), ou Render était endormi (réessayer). |
| Erreur CORS dans la console du navigateur | Vérifier *Allowed Origins (CORS)* = `*` sur le nœud Webhook et que le nœud *Respond to Webhook* est bien celui qui répond (`responseMode: responseNode`). |
| Google : « Accès bloqué : application non vérifiée » | Ajouter votre adresse dans *Test users* de l'écran de consentement OAuth. |
| Google Sheets : `Unable to parse range` / colonne introuvable | L'onglet n'existe pas ou la première ligne ne contient pas exactement les en-têtes attendus. |
| Airtable : `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` | Mauvais ID de base/table, ou jeton sans accès à cette base / sans scope `data.records:write`. |
| Gmail : label introuvable (workflow 04) | Créer le label dans Gmail avec exactement le nom du nœud *Config* (`IA-traite`). |
| Rien ne se passe pour 04 / 05 | Le workflow doit être **Active** et n8n doit tourner à l'heure prévue. |
