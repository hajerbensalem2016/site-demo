# Scripts Python des démos (scraping, veille, KPI)

Trois scripts Python 3.11+, exécutés **gratuitement** par GitHub Actions (2 000 min/mois offertes), qui écrivent leurs résultats en JSON dans `site-demo/data/`. Le site statique lit ces fichiers ; aucun serveur Python n'est nécessaire.

| Script | Rôle | Entrée | Sortie (`data/`) |
|---|---|---|---|
| `scrape_prix.py` | Démo scraping : titre, prix, lien, note | [books.toscrape.com](https://books.toscrape.com) (site d'entraînement public, conçu pour le scraping) ; `--cible` = catégorie, mot-clé ou URL du site | `prix.json` (tableau `{ titre, prix, lien, note }`, lu par `demos/scraping/`) + `prix_meta.json` |
| `veille_annonces.py` | Démo veille : détecte les nouveautés d'un flux RSS/Atom public depuis la dernière exécution | flux `--flux` ou variable `FLUX_RSS` (défaut : `https://hnrss.org/newest?q=automation&points=20`) | `annonces.json` (nouveautés + 30 dernières entrées) + `veille_etat.json` (identifiants déjà vus) |
| `rapport_kpi.py` | Démo rapport : KPI à partir d'un CSV de ventes | `data/ventes_exemple.csv` ou `--csv fichier.csv` | `kpi.json` (`ca`, `depenses`, `clients`, marge, panier moyen, top produits, CA par mois) |

`commun.py` regroupe ce qui est partagé : session HTTP identifiée (User-Agent explicite), **respect de `robots.txt`**, **délai de 2 s minimum entre deux requêtes** vers un même site, écriture JSON, publication optionnelle dans un Google Sheet.

Règles respectées : sources publiques qui tolèrent la collecte, pas de connexion à un compte, pas de contournement anti-bot, `scrape_prix.py` refuse toute URL hors du domaine autorisé (`books.toscrape.com`) et retombe sur le catalogue. Aucun secret dans le code.

## Lancer en local

```bash
cd site-demo/scripts
python -m venv .venv && source .venv/bin/activate     # Windows : .venv\Scripts\activate
pip install -r requirements.txt

python scrape_prix.py --cible Travel        # ~5 s (2 s de délai entre pages)
python veille_annonces.py                   # 1re exécution : mémorise, ne signale rien
python rapport_kpi.py                       # utilise data/ventes_exemple.csv

pytest -q                                   # tests hors ligne (fixtures HTML / RSS locales)
```

Chaque script accepte `--help`, `--sortie <fichier>` et `-v`. Codes de retour : `0` succès, `1` erreur (réseau, robots.txt, CSV invalide), `2` aucune donnée (les fichiers existants sont alors conservés).

Note sur les prix : books.toscrape.com affiche des prix en livres sterling ; le site formate en euros. `--taux 1.17` applique une conversion si besoin (`prix_meta.json` garde la trace de la devise source et du taux appliqué).

## Deux modes pour la page scraping du site

### Mode 1 — fichier quotidien (gratuit, zéro configuration)

Le workflow `.github/workflows/scraping.yml` tourne chaque jour à 05:00 UTC (07:00 Paris en été), exécute les tests puis les trois scripts, et **commite les JSON modifiés dans `data/`**. Vercel (ou GitHub Pages) redéploie automatiquement : la page scraping affiche la dernière collecte, sans rien d'autre à brancher. Le bouton « Lancer une mise à jour » reste en simulation locale tant que `webhookScraping` vaut `TODO_…` dans `config.js`.

### Mode 2 — à la demande depuis la page (webhook n8n → `workflow_dispatch`)

La page envoie `POST { "cible": "…" }` à `webhookScraping` (config.js). Le workflow n8n :

1. **Webhook** (POST, CORS activé : *Allowed Origins* = `*` ou le domaine Vercel).
2. **HTTP Request** vers l'API GitHub :
   - `POST https://api.github.com/repos/<OWNER>/<REPO>/actions/workflows/scraping.yml/dispatches`
   - En-têtes : `Authorization: Bearer {{ $credentials.githubToken }}` (credential n8n de type *Header Auth*, jamais en clair), `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`
   - Corps JSON : `{ "ref": "main", "inputs": { "cible": "{{ $json.body.cible || '' }}", "scripts": "prix" } }`
   - GitHub répond `204` (rien dans le corps).
3. **Respond to Webhook** : `{ "ok": true, "message": "Collecte lancée, résultats en ligne dans 2 à 3 minutes." }`.

Variante « résultat immédiat » : après l'étape 2, ajouter un nœud **Wait** (90 s) puis un **HTTP Request** GET sur `https://raw.githubusercontent.com/<OWNER>/<REPO>/main/<chemin>/data/prix.json` et renvoyer `{ "ok": true, "message": "…", "resultats": <tableau> }` — la page remplace alors le tableau affiché (délai maximum côté front : 60 s ; pour dépasser, répondre d'abord `ok` puis laisser le redéploiement mettre à jour la page).

Token GitHub à créer pour n8n : *Settings → Developer settings → Fine-grained tokens*, limité au dépôt, permissions **Actions : Read and write** (et *Metadata : Read*, ajouté automatiquement). Le stocker dans un **credential n8n**, jamais dans `config.js` ni dans le front.

Le déclenchement manuel fonctionne aussi depuis GitHub : onglet **Actions → Collecte des démos → Run workflow** (champs `cible` et `scripts`).

## Activer l'Action GitHub

1. Pousser le dépôt sur GitHub. Deux dispositions sont prises en charge (le workflow détecte le bon dossier) :
   - **racine = `site-demo/`** (recommandé pour Vercel / GitHub Pages) : le fichier est à `.github/workflows/scraping.yml`, les données à `data/`.
   - **racine = projet parent** : déplacer `site-demo/.github/` à la racine du dépôt (`mv site-demo/.github .github`), GitHub ne lit les workflows qu'à la racine. Le workflow travaille alors dans `site-demo/`.
2. **Settings → Actions → General → Workflow permissions** : cocher **Read and write permissions** (nécessaire pour que le bot commite dans `data/`).
3. Onglet **Actions** : si les workflows sont désactivés sur le dépôt, cliquer *I understand my workflows, go ahead and enable them*. Lancer une première exécution avec **Run workflow** pour vérifier.
4. Sur un dépôt inactif depuis 60 jours, GitHub suspend les crons : une visite dans l'onglet Actions ou un commit les réactive.

Les commits automatiques contiennent `[skip ci]` pour ne pas relancer d'autres workflows GitHub ; Vercel, lui, redéploie normalement (désactivable dans *Settings → Git → Ignored Build Step* si besoin).

## Secrets et variables à configurer (tous optionnels)

Dans **Settings → Secrets and variables → Actions** :

| Nom | Type | Rôle |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Secret | Contenu complet du JSON du compte de service Google (Sheets API activée). Si présent, le workflow installe `gspread` et chaque script écrit aussi ses résultats dans le Google Sheet (onglets `prix`, `veille`, `kpi_mois`). |
| `GOOGLE_SHEET_ID` | Secret | ID du Google Sheet (partie de l'URL entre `/d/` et `/edit`). Partager le Sheet avec l'email du compte de service, puis *Fichier → Partager → Publier sur le web* pour l'embed public `sheetEmbed` de `config.js`. |
| `FLUX_RSS` | Variable (*Variables*, pas *Secrets*) | URL du flux RSS/Atom à surveiller par `veille_annonces.py`. Sans valeur : flux par défaut. |

Côté n8n (mode 2 uniquement) : un credential contenant le **token GitHub fine-grained** (Actions : write). Côté site : `webhookScraping` dans `config.js` = URL de production du webhook n8n.

Aucun secret n'est requis pour le mode 1 : `GITHUB_TOKEN` est fourni automatiquement à l'Action pour le commit.

## Tests

`tests/test_scripts.py` (pytest) couvre les trois scripts sans aucun appel réseau : fixtures HTML de books.toscrape.com (`tests/fixtures/books_page*.html`), flux RSS 2.0 et Atom (`flux_rss.xml`, `flux_atom.xml`), CSV en mémoire, et une garde qui fait échouer tout test tentant une vraie requête HTTP. Le workflow exécute `pytest -q` avant chaque collecte.
