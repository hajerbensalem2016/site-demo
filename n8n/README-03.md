# 03 — Démo rapport : webhook → `/api/rapport` → email Gmail

Fichier : `03-demo-rapport.json` · Webhook : `POST /webhook/demo-rapport`.

La page *Rapport* du site appelle directement `/api/rapport` (fonction serverless Vercel). Ce workflow ajoute la suite « métier » : générer le rapport **et l'envoyer par email** au client, par exemple depuis un formulaire « Recevoir mon rapport par email », un bouton sur le site, ou un autre outil (Tally, Notion, Zapier…).

## Ce que fait le workflow

```
Demande de rapport (Webhook POST, CORS *)
  → Config et données (Set : siteUrl, email, ca, depenses, clients, lang)
  → Email valide ? (IF)
      ├─ oui → Générer le rapport (HTTP POST {siteUrl}/api/rapport)
      │        → Markdown vers HTML (nœud Markdown)
      │        → Fichier .md en pièce jointe (Convert to File → rapport-activite.md)
      │        → Envoyer le rapport (Gmail, HTML + pièce jointe)
      │        → Réponse OK → Répondre au site (200 + CORS)
      └─ non → Réponse erreur → Répondre erreur 400
```

Requête attendue :

```json
{ "email": "client@exemple.fr", "ca": 48200, "depenses": 31500, "clients": 37, "lang": "fr" }
```

`lang` est optionnel (`fr` par défaut, `en` accepté). Appel au site conforme au contrat `POST /api/rapport { lang, ca, depenses, clients }` → `{ rapport_markdown }`.

Réponse : `{ "ok": true, "message": "Rapport généré et envoyé par email à client@exemple.fr." }`.

## Credential à créer

| Nom dans n8n | Type | Nœud |
|---|---|---|
| `Gmail account` | Gmail OAuth2 API | Envoyer le rapport (Gmail) |

## Variables à remplacer

| Valeur | Nœud | Remplacer par |
|---|---|---|
| `TODO_SITE_URL` | Config et données → champ `siteUrl` | URL publique du site (ex. `https://mon-site.vercel.app`, sans `/` final) |
| Signature dans l'email | Envoyer le rapport → *Message* | Votre texte |

Prérequis : la route `/api/rapport` du site doit être déployée sur Vercel avec sa clé IA en variable d'environnement (voir `site-demo/README.md`). Sans elle, le nœud *Générer le rapport* renvoie une erreur 404/500.

## PDF

- Par défaut, le rapport est envoyé en **HTML dans le corps de l'email** (lisible partout, imprimable en PDF depuis Gmail : *Imprimer → Enregistrer en PDF*) avec le **fichier Markdown en pièce jointe**. Aucun service externe.
- Option gratuite pour un vrai PDF : ajouter, entre *Markdown vers HTML* et *Envoyer le rapport*, un nœud **HTTP Request** vers un convertisseur HTML→PDF auto-hébergé (par ex. l'image Docker gratuite [Gotenberg](https://gotenberg.dev/) : `POST http://gotenberg:3000/forms/chromium/convert/html`, corps *multipart* avec le HTML dans un fichier `index.html`, réponse binaire) puis joindre le binaire à la place du `.md`. Non inclus pour rester importable sans dépendance.

## Tester en 3 étapes

1. Importer, sélectionner le credential Gmail, remplacer `TODO_SITE_URL`, **Save**.
2. *Demande de rapport* → **Listen for test event**, envoyer la requête ci-dessous. Vérifier l'email reçu (rapport HTML + `rapport-activite.md`) et la réponse `{ ok: true }`.
3. Activer le workflow ; l'URL de production `https://<n8n>/webhook/demo-rapport` peut être appelée depuis n'importe quel formulaire ou outil.

## Exemple de requête

```bash
curl -X POST "http://localhost:5678/webhook-test/demo-rapport" \
  -H "Content-Type: application/json" \
  -d '{"email":"vous@exemple.fr","ca":48200,"depenses":31500,"clients":37,"lang":"fr"}'
```

PowerShell :

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:5678/webhook-test/demo-rapport" -ContentType "application/json; charset=utf-8" -Body '{"email":"vous@exemple.fr","ca":48200,"depenses":31500,"clients":37,"lang":"fr"}'
```

Le délai d'attente de l'appel `/api/rapport` est fixé à 60 s (génération IA).
