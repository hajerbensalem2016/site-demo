# 04 — Agent email Gmail : brouillons de réponse rédigés par l'IA

Fichier : `04-agent-email-gmail.json` · Déclencheur : toutes les 15 minutes (Schedule Trigger).

## Ce que fait le workflow

```
Toutes les 15 minutes
  → Config (Set : siteUrl, labelName, maxEmails, lang)
  → Lister les labels Gmail (Label → Get Many)
  → Trouver le label (Code : nom → ID, erreur claire si absent)
  → Emails non lus (Gmail → Get Many, non simplifié, filtre : is:unread -label:<labelName> -in:sent -in:drafts newer_than:7d, max 10)
  → Préparer le texte (Code : expéditeur, objet, texte brut ≤ 6 000 caractères)
  → Expéditeur valide ? (IF)
  → Analyser via /api/agent-email (HTTP POST {siteUrl}/api/agent-email { lang, email })
  → Fusionner analyse et email (Code : catégorie, urgence, résumé, réponse)
  → Créer le brouillon de réponse (Gmail → Draft → Create, dans le fil, à l'expéditeur)
  → Ajouter le label (Gmail → Message → Add Label)
```

Pour chaque email non lu qui n'a pas encore le label, l'agent crée un **brouillon** dans le même fil, adressé à l'expéditeur, avec en tête :

```
[Analyse IA — catégorie : Réclamation / SAV | urgence : haute]
Résumé : Client sans nouvelles de sa commande #48213 depuis 10 jours.
--- Supprimez ce bloc avant d'envoyer ---

Bonjour, …(réponse proposée)…
```

Puis il pose le label (`IA-traite`) sur l'email : il n'est plus retraité au passage suivant, même s'il reste non lu. **Rien n'est envoyé automatiquement** : vous relisez le brouillon dans Gmail, supprimez le bloc d'analyse, et envoyez.

Appel au site conforme au contrat `POST /api/agent-email { lang, email }` → `{ categorie, urgence, resume, reponse_proposee }` (`urgence` FR ou EN acceptée).

## Credential à créer

| Nom dans n8n | Type | Nœuds |
|---|---|---|
| `Gmail account` | Gmail OAuth2 API | Lister les labels, Emails non lus, Créer le brouillon, Ajouter le label |

## Variables à remplacer (nœud *Config*)

| Champ | Valeur par défaut | À faire |
|---|---|---|
| `siteUrl` | `TODO_SITE_URL` | URL publique du site (sans `/` final) où `/api/agent-email` est déployé |
| `labelName` | `IA-traite` | Créer ce label dans Gmail : *Paramètres → Libellés → Nouveau libellé* (nom sans accent ni espace pour que le filtre `-label:` fonctionne) |
| `maxEmails` | `10` | Nombre max d'emails traités par passage |
| `lang` | `fr` | Langue des réponses (`fr` ou `en`) |

Pour changer la fréquence : nœud *Toutes les 15 minutes* → *Minutes Between Triggers*. Pour ne traiter qu'une boîte de réception filtrée, ajouter `label:INBOX` ou `from:@mondomaine.fr` dans le filtre `q` du nœud *Emails non lus*.

## Tester en 3 étapes

1. Importer, sélectionner le credential Gmail sur les 4 nœuds Gmail, remplacer `TODO_SITE_URL`, créer le label `IA-traite` dans Gmail, **Save**.
2. Envoyez-vous un email de test (ou laissez un email non lu), puis cliquez **Execute workflow** (exécution manuelle immédiate, sans attendre 15 min). Vérifier dans Gmail : un brouillon dans le fil + le label posé.
3. Activer le workflow (**Active**) : il tourne toutes les 15 minutes tant que n8n est allumé (Render ou PC allumé).

## Exemple de requête

Ce workflow n'a pas de webhook. Pour tester l'API qu'il utilise :

```bash
curl -X POST "https://<votre-site>.vercel.app/api/agent-email" \
  -H "Content-Type: application/json" \
  -d '{"lang":"fr","email":"Objet : Commande #48213\n\nBonjour, j ai commandé le casque ANC Pro il y a 10 jours et je n ai aucune nouvelle. C est un cadeau pour samedi. Merci de me tenir informé."}'
```

## Notes et limites

- Coût : zéro côté n8n/Gmail ; chaque email consomme un appel IA sur `/api/agent-email` (limité par IP côté serveur). `maxEmails` borne le volume.
- Les emails sans expéditeur valide (notifications sans adresse) sont ignorés par le nœud *Expéditeur valide ?*.
- Si `/api/agent-email` est indisponible, l'exécution échoue et l'email sera retenté au passage suivant (le label n'est posé qu'après la création du brouillon).
- Le texte envoyé à l'IA est tronqué à 6 000 caractères et débarrassé du HTML.
