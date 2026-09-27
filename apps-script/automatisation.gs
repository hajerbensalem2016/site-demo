/* ============================================================
   Google Apps Script — démo « Automatisation de workflow »
   À coller dans : Google Sheet > Extensions > Apps Script (voir apps-script/README.md)

   Appelé UNIQUEMENT par la fonction Vercel /api/automatisation (l'URL du déploiement
   reste secrète, dans la variable d'environnement Vercel APPS_SCRIPT_URL).
   Pour chaque formulaire :
     1. ajoute une ligne dans la feuille « Leads » (date, nom, email, entreprise, besoin, langue, statut) ;
     2. envoie à l'adresse saisie un email de présentation FIXE (le visiteur ne peut rien y écrire :
        impossible d'utiliser la démo pour envoyer du spam) ;
     3. envoie à Hajer une copie avec tout ce que le visiteur a écrit.
   Garde-fous : 1 email par adresse toutes les 6 h, 40 emails de présentation par jour au total.
   ============================================================ */

var SITE = 'https://site-demo-hbs16.vercel.app';
var MAX_PAR_JOUR = 40;

var EMAILS = {
  fr: {
    sujet: 'Votre démo d\'automatisation vient de fonctionner — Hajer, Automatisation & IA',
    texte: [
      'Bonjour,',
      '',
      'Cet email vient d\'être envoyé automatiquement : vous avez rempli le formulaire de ma démo, et le workflow a enregistré votre demande puis déclenché cet envoi, sans aucune intervention humaine.',
      '',
      'C\'est exactement ce que je peux mettre en place pour votre entreprise :',
      '- des agents IA qui trient vos emails et préparent les réponses ;',
      '- des automatisations entre vos outils (Gmail, Google Sheets, Notion, Airtable, Slack, CRM…) avec n8n, Make ou Zapier ;',
      '- des chatbots pour votre site et des agents vocaux qui répondent au téléphone ;',
      '- la collecte de données et la veille de prix automatiques ;',
      '- des rapports d\'activité générés et envoyés tout seuls.',
      '',
      'Testez toutes mes démos : ' + SITE,
      '',
      'Vous avez une tâche répétitive qui vous prend du temps ? Répondez simplement à cet email en la décrivant en quelques lignes : je vous réponds par écrit avec une proposition claire et un prix fixe.',
      '',
      'Hajer',
      'Automatisation & IA',
      '',
      '—',
      'Vous recevez cet email parce que cette adresse a été saisie dans le formulaire de démo de ' + SITE + '. Si ce n\'est pas vous, ignorez-le : aucun autre email ne vous sera envoyé.'
    ].join('\n')
  },
  en: {
    sujet: 'Your automation demo just worked — Hajer, Automation & AI',
    texte: [
      'Hello,',
      '',
      'This email was sent automatically: you filled in the form on my demo, and the workflow saved your request and triggered this email, with no human involved.',
      '',
      'This is exactly what I can set up for your business:',
      '- AI agents that sort your emails and draft the replies;',
      '- automations between your tools (Gmail, Google Sheets, Notion, Airtable, Slack, CRM…) with n8n, Make or Zapier;',
      '- website chatbots and voice agents that answer the phone;',
      '- automatic data collection and price monitoring;',
      '- activity reports generated and sent on their own.',
      '',
      'Try all my demos: ' + SITE,
      '',
      'Do you have a repetitive task that takes up your time? Just reply to this email and describe it in a few lines: I will answer in writing with a clear proposal and a fixed price.',
      '',
      'Hajer',
      'Automation & AI',
      '',
      '—',
      'You are receiving this email because this address was entered in the demo form on ' + SITE + '. If this was not you, please ignore it: no other email will be sent.'
    ].join('\n')
  }
};

function propre(v, max) {
  var s = String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? '\'' + s : s; /* empêche l'injection de formules dans la feuille */
}

function reponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var d = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var lang = d.lang === 'en' ? 'en' : 'fr';
    var email = String(d.email || '').trim().toLowerCase().slice(0, 120);
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i.test(email)) return reponse({ ok: false, error: 'invalid_input' });
    var nom = propre(d.nom, 80), entreprise = propre(d.entreprise, 80), besoin = propre(d.besoin, 600);

    var props = PropertiesService.getScriptProperties();
    var cache = CacheService.getScriptCache();
    var jour = Utilities.formatDate(new Date(), 'Europe/Paris', 'yyyy-MM-dd');
    var compteur = Number(props.getProperty('envois_' + jour) || 0);
    var cle = 'deja_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email));

    var statut;
    if (cache.get(cle)) statut = 'déjà envoyé récemment (non renvoyé)';
    else if (compteur >= MAX_PAR_JOUR) statut = 'plafond du jour atteint (non envoyé)';
    else {
      MailApp.sendEmail({ to: email, subject: EMAILS[lang].sujet, body: EMAILS[lang].texte, name: 'Hajer — Automatisation & IA' });
      cache.put(cle, '1', 21600);
      props.setProperty('envois_' + jour, String(compteur + 1));
      statut = 'email de présentation envoyé';
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var feuille = ss.getSheetByName('Leads') || ss.insertSheet('Leads');
    if (feuille.getLastRow() === 0) feuille.appendRow(['Date', 'Nom', 'Email', 'Entreprise', 'Besoin', 'Langue', 'Statut']);
    feuille.appendRow([new Date(), nom, email, entreprise, besoin, lang, statut]);

    var moi = Session.getEffectiveUser().getEmail();
    MailApp.sendEmail({
      to: moi,
      subject: '[Démo site] Nouveau contact : ' + (nom || email),
      body: 'Nom : ' + nom + '\nEmail : ' + email + '\nEntreprise : ' + entreprise + '\nBesoin :\n' + besoin + '\n\nLangue : ' + lang + '\nStatut : ' + statut + '\nFeuille : ' + ss.getUrl(),
      replyTo: email
    });

    return reponse({ ok: true, envoye: statut === 'email de présentation envoyé', statut: statut });
  } catch (err) {
    return reponse({ ok: false, error: 'internal', detail: String(err).slice(0, 200) });
  } finally {
    lock.releaseLock();
  }
}

/* À lancer une fois à la main (bouton « Exécuter ») pour autoriser Gmail et Sheets. */
function autoriser() {
  SpreadsheetApp.getActiveSpreadsheet();
  MailApp.getRemainingDailyQuota();
  Logger.log('Autorisations OK. Emails encore disponibles aujourd\'hui : ' + MailApp.getRemainingDailyQuota());
}
