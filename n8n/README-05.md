# 05 — Veille quotidienne : résultats du scraper → résumé par email

Fichier : `05-veille-quotidienne.json` · Déclencheur : chaque matin à 8 h (Europe/Paris).

## Ce que fait le workflow

```
Chaque matin à 8h
  → Config (Set : source, sheetId, sheetTab, jsonUrl, destinataire, titre)
  → Source Google Sheets ? (IF source == "sheet")
      ├─ oui → Lire la feuille des prix (Google Sheets → Read, onglet "Prix")
      └─ non → Lire le JSON du site (HTTP GET {siteUrl}/data/prix.json)
  → Résumer la veille (Code : nb d'offres, prix min / moyen / max, top 5 moins chers, top 3 mieux notés → HTML)
  → Envoyer le résumé (Gmail, HTML)
```

Format des lignes attendu (celui produit par le script Python de scraping et par `data/prix.json` du site) : `titre`, `prix` (nombre, `,` ou `.` acceptés), `lien`, `note` (sur 5). Les en-têtes `Titre / Prix / Lien / Note` ou `title / price / url / rating` sont aussi reconnus. Les lignes sans titre ou sans prix sont ignorées ; si aucune ligne n'est exploitable, un email « aucune donnée » est envoyé.

## Credentials à créer

| Nom dans n8n | Type | Nœud |
|---|---|---|
| `Google Sheets account` | Google Sheets OAuth2 API | Lire la feuille des prix (seulement si `source = sheet`) |
| `Gmail account` | Gmail OAuth2 API | Envoyer le résumé (Gmail) |

## Variables à remplacer (nœud *Config*)

| Champ | Valeur par défaut | À faire |
|---|---|---|
| `source` | `sheet` | `sheet` = Google Sheet rempli par le scraper ; `json` = fichier `data/prix.json` publié avec le site |
| `sheetId` | `TODO_GOOGLE_SHEET_ID` | ID de l'URL `https://docs.google.com/spreadsheets/d/<ID>/edit` |
| `sheetTab` | `Prix` | Nom de l'onglet, ligne 1 = `titre | prix | lien | note` (colonne `date` optionnelle) |
| `jsonUrl` | `TODO_SITE_URL/data/prix.json` | URL publique du JSON (ex. `https://mon-site.vercel.app/data/prix.json`) ou toute autre URL renvoyant un tableau JSON |
| `destinataire` | `TODO_EMAIL_DESTINATAIRE` | Adresse qui reçoit le résumé (plusieurs adresses séparées par des virgules) |
| `titre` | `Veille prix quotidienne` | Titre de l'email |

Changer l'heure : nœud *Chaque matin à 8h* → *Trigger at Hour*. Le fuseau `Europe/Paris` est défini dans les paramètres du workflow.

## Tester en 3 étapes

1. Importer, sélectionner les credentials, remplir le nœud *Config* (`destinataire` au minimum ; pour un test immédiat sans Google Sheet, mettre `source = json` et `jsonUrl` sur l'URL du site, ou même sur le JSON local si le site tourne en local et n8n sur le même PC : `http://host.docker.internal:8080/data/prix.json`), **Save**.
2. Cliquer **Execute workflow** : l'email de synthèse arrive en quelques secondes (prix min/moyen/max, top 5, mieux notés).
3. Activer le workflow (**Active**) : envoi automatique chaque matin à 8 h tant que n8n tourne (Render conseillé).

## Exemple de requête

Pas de webhook : la source est lue par n8n. Pour vérifier que la source JSON est bien accessible :

```bash
curl -s "https://<votre-site>.vercel.app/data/prix.json" | head -c 400
```

Pour alimenter le Google Sheet depuis le script Python de scraping, écrire les colonnes `titre, prix, lien, note, date` dans l'onglet `Prix` (ou réutiliser le nœud *Ajouter dans Google Sheets* du workflow 01 comme modèle d'append).

## Idées d'extension (gratuites)

- Ajouter un seuil : dans *Résumer la veille*, comparer avec la veille précédente stockée dans un second onglet et n'envoyer que si un prix a baissé de plus de X %.
- Envoyer aussi sur Slack/Discord via un nœud HTTP Request (webhook entrant gratuit).
