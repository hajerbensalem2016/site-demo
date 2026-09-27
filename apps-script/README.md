# Apps Script — démo « Automatisation de workflow » (gratuit)

Le formulaire de `demos/automatisation` appelle `POST /api/automatisation` (Vercel), qui transmet au script
`automatisation.gs` : ligne ajoutée dans Google Sheets, email de présentation FIXE envoyé au visiteur,
copie complète envoyée à Hajer. Gmail gratuit : 100 emails / jour max (le script se limite à 40).

## Installation (10 minutes, une seule fois)

1. **Google Sheets** : créer une feuille vide nommée « Leads démo site ».
2. Dans la feuille : **Extensions → Apps Script**. Effacer le code présent, coller tout `automatisation.gs`, enregistrer (icône disquette).
3. En haut, choisir la fonction **`autoriser`** puis **Exécuter** → « Examiner les autorisations » → choisir son compte
   → « Paramètres avancés » → « Accéder au projet (non sécurisé) » → **Autoriser**.
   (Message normal : c'est son propre script, non vérifié par Google.)
4. **Déployer → Nouveau déploiement** → type **Application Web** :
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde**
   → **Déployer** → copier l'**URL de l'application Web** (`https://script.google.com/macros/s/…/exec`).
5. **Vercel** → projet `site-demo` → Settings → Environment Variables → ajouter
   `APPS_SCRIPT_URL` = l'URL copiée (Production) → Save → Deployments → **Redeploy**.

L'URL reste secrète (jamais dans le code public) : seul `/api/automatisation`, limité par IP, peut déclencher le script.

## Modifier le texte de l'email

Modifier `EMAILS` dans le script **et** `mail_subject` / `mail_body` dans `demos/automatisation/index.html`
(l'aperçu affiché aux visiteurs), puis dans Apps Script : **Déployer → Gérer les déploiements → modifier → Nouvelle version**.
