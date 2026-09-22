# 01 — Démo automatisation : formulaire → Google Sheets → email de bienvenue

Fichier : `01-demo-automatisation.json` · Webhook : `POST /webhook/demo-automatisation` · Alimente `config.js → webhookAutomatisation`.

## Ce que fait le workflow

```
Formulaire du site (Webhook POST, CORS *)
  → Normaliser le lead (Set : nom, email, entreprise, besoin, date, source)
  → Email valide ? (IF, regex)
      ├─ oui → Ajouter dans Google Sheets (append, onglet "Leads")
      │        → Email de bienvenue (Gmail, HTML)
      │        → Prévenir Slack (HTTP Request, DÉSACTIVÉ, optionnel)
      │        → Réponse OK (Set { ok: true, message })
      │        → Répondre au site (Respond to Webhook 200 + en-têtes CORS)
      └─ non → Réponse erreur → Répondre erreur 400 ({ ok: false, message })
```

Contrat respecté : requête `{ nom, email, entreprise, besoin }`, réponse `{ "ok": true, "message": "Lead enregistré dans Google Sheets, email de bienvenue envoyé à …" }`. Les requêtes `OPTIONS` reçoivent `204` avec `Access-Control-Allow-Origin: *`.

## Credentials à créer

| Nom dans n8n | Type | Nœud |
|---|---|---|
| `Google Sheets account` | Google Sheets OAuth2 API | Ajouter dans Google Sheets |
| `Gmail account` | Gmail OAuth2 API | Email de bienvenue (Gmail) |

Procédure Google Cloud (gratuite) dans `README.md` § 4.

## Variables à remplacer

| Valeur | Nœud | Remplacer par |
|---|---|---|
| `TODO_GOOGLE_SHEET_ID` | Ajouter dans Google Sheets → *Document* | L'ID de l'URL `https://docs.google.com/spreadsheets/d/<ID>/edit` |
| `Leads` | Ajouter dans Google Sheets → *Sheet* | Nom de l'onglet (garder `Leads` ou adapter) |
| `TODO_SLACK_WEBHOOK_URL` | Prévenir Slack (optionnel) | URL d'un *Incoming Webhook* Slack (gratuit) ; puis activer le nœud (clic droit → *Enable*) |
| Signature « Hajer » dans l'email | Email de bienvenue → *Message* | Votre texte |

Préparer le Google Sheet : créer une feuille, renommer l'onglet `Leads`, et mettre en ligne 1 exactement :

```
Nom | Email | Entreprise | Besoin | Date | Source
```

Pour afficher la feuille dans la démo : *Fichier → Partager → Publier sur le web* → coller l'URL dans `config.js → sheetEmbed`.

## Tester en 3 étapes

1. Importer le JSON, sélectionner les deux credentials, remplacer `TODO_GOOGLE_SHEET_ID`, **Save**.
2. Cliquer sur le nœud *Formulaire du site* → **Listen for test event**, puis envoyer la requête ci-dessous sur l'URL **de test** (`/webhook-test/…`). Vérifier : une ligne dans le Sheet, un email reçu, la réponse JSON `{ ok: true }`.
3. Activer le workflow (**Active**), copier l'URL de **production** (`https://<n8n>/webhook/demo-automatisation`) dans `config.js → webhookAutomatisation`, redéployer le site et tester depuis la page *Automatisation*.

## Exemple de requête

```bash
curl -X POST "http://localhost:5678/webhook-test/demo-automatisation" \
  -H "Content-Type: application/json" \
  -d '{"nom":"Marie Dupont","email":"marie@dupont.fr","entreprise":"Dupont & Fils","besoin":"Automatiser l'"'"'envoi de nos devis"}'
```

PowerShell :

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:5678/webhook-test/demo-automatisation" -ContentType "application/json; charset=utf-8" -Body '{"nom":"Marie Dupont","email":"marie@dupont.fr","entreprise":"Dupont & Fils","besoin":"Automatiser l''envoi de nos devis"}'
```

Réponse attendue :

```json
{ "ok": true, "message": "Lead enregistré dans Google Sheets, email de bienvenue envoyé à marie@dupont.fr." }
```

## Notes

- Si Google Sheets ou Gmail échoue, l'exécution s'arrête en erreur et le site reçoit un `500` : il bascule alors sur la simulation locale (bandeau « hors ligne »). Consulter *Executions* dans n8n pour la cause.
- Le nœud Slack est désactivé : n8n laisse passer les données à travers un nœud désactivé, la chaîne fonctionne donc sans Slack.
- Quota Gmail gratuit : ~500 emails/jour, largement suffisant (le site limite à 5 tests/jour par visiteur).
