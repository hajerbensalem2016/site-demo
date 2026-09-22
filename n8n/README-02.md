# 02 — Démo CRM : lead → scoring → Airtable

Fichier : `02-demo-crm.json` · Webhook : `POST /webhook/demo-crm` · Alimente `config.js → webhookCrm`.

## Ce que fait le workflow

```
Formulaire CRM du site (Webhook POST, CORS *)
  → Scorer le lead (Code : score 0-100 + priorité Chaud / Tiède / Froid)
  → Email valide ? (IF)
      ├─ oui → Créer la fiche Airtable (record create, typecast)
      │        → Réponse OK (Set { ok, message, score })
      │        → Répondre au site (200 + en-têtes CORS)
      └─ non → Réponse erreur → Répondre erreur 400
```

Contrat respecté : requête `{ nom, email, entreprise, besoin }`, réponse `{ "ok": true, "message": "Lead ajouté au CRM Airtable — score 72/100 (Chaud).", "score": 72 }`. Le site affiche le `score` renvoyé (sinon il en calcule un localement).

Règles de scoring (nœud *Scorer le lead*, modifiables) : base 10 ; email professionnel (domaine non générique) +25 ; entreprise renseignée +20 ; besoin > 20 caractères +10, > 80 caractères +5 ; mots-clés (`automatis`, `crm`, `devis`, `factur`, `chatbot`, `urgent`, `n8n`, `notion`, `airtable`…) +4 à +10 chacun ; plafonné à 100. Priorité : ≥ 70 Chaud, ≥ 40 Tiède, sinon Froid.

## Credential à créer

| Nom dans n8n | Type | Nœud |
|---|---|---|
| `Airtable Personal Access Token account` | Airtable Personal Access Token API | Créer la fiche Airtable |

Jeton gratuit : https://airtable.com/create/tokens → scopes `data.records:read`, `data.records:write`, `schema.bases:read` → accès à la base de la démo.

## Variables à remplacer

| Valeur | Nœud | Remplacer par |
|---|---|---|
| `appTODOBASEID` | Créer la fiche Airtable → *Base* (mode *By ID*) | ID de la base (`app…`), visible dans l'URL `https://airtable.com/app…/tbl…` |
| `tblTODOTABLEID` | Créer la fiche Airtable → *Table* (mode *By ID*) | ID de la table (`tbl…`) |

Vous pouvez aussi passer les deux champs en mode *From list* et choisir la base/table dans la liste une fois le credential sélectionné.

Préparer la base Airtable (gratuite) — une table `Leads` avec ces champs :

| Champ | Type Airtable |
|---|---|
| Nom | Single line text (champ principal) |
| Email | Email |
| Entreprise | Single line text |
| Besoin | Long text |
| Score | Number (entier) |
| Priorité | Single select (`Chaud`, `Tiède`, `Froid`) ou texte |
| Date | Date (avec heure) ou texte |
| Source | Single line text |

L'option *typecast* est activée : Airtable convertit les valeurs (nombre, date, option de liste) automatiquement. Pour la démo, partager une vue kanban (groupée par *Priorité*) → *Share view → Embed* → `config.js → airtableEmbed`.

Variante Notion : remplacer le nœud Airtable par un nœud **Notion** (*Database Page → Create*, credential *Notion API* gratuit, base partagée avec l'intégration) en mappant les mêmes propriétés ; le reste du workflow ne change pas.

## Tester en 3 étapes

1. Importer, sélectionner le credential, remplacer les IDs de base et de table, **Save**.
2. *Formulaire CRM du site* → **Listen for test event**, envoyer la requête ci-dessous sur `/webhook-test/demo-crm`. Vérifier la fiche dans Airtable et la réponse `{ ok: true, score }`.
3. Activer, copier `https://<n8n>/webhook/demo-crm` dans `config.js → webhookCrm`, redéployer, tester depuis la page *CRM Notion / Airtable*.

## Exemple de requête

```bash
curl -X POST "http://localhost:5678/webhook-test/demo-crm" \
  -H "Content-Type: application/json" \
  -d '{"nom":"Karim Benali","email":"karim@benali-conseil.fr","entreprise":"Benali Conseil","besoin":"Mettre en place un CRM et automatiser les relances de devis, c est urgent"}'
```

PowerShell :

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:5678/webhook-test/demo-crm" -ContentType "application/json; charset=utf-8" -Body '{"nom":"Karim Benali","email":"karim@benali-conseil.fr","entreprise":"Benali Conseil","besoin":"Mettre en place un CRM et automatiser les relances de devis, c est urgent"}'
```

Réponse attendue :

```json
{ "ok": true, "message": "Lead ajouté au CRM Airtable — score 100/100 (Chaud).", "score": 100 }
```
