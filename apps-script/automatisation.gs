/* ============================================================
   Google Apps Script — démo « Automatisation de workflow »
   À coller dans : Google Sheet > Extensions > Apps Script (voir apps-script/README.md)

   Appelé UNIQUEMENT par la fonction Vercel /api/automatisation (l'URL du déploiement
   reste secrète, dans la variable d'environnement Vercel APPS_SCRIPT_URL).
   Pour chaque formulaire :
     1. ajoute une ligne dans la feuille « Leads » (date, nom, email, entreprise, besoin, langue, statut) ;
     2. envoie à l'adresse saisie un email de présentation FIXE (le visiteur ne peut rien y écrire :
        impossible d'utiliser la démo pour envoyer du spam) ;
     3. envoie au propriétaire du script une copie avec tout ce que le visiteur a écrit.
   Garde-fous : 1 email par adresse toutes les 6 h, 40 emails de présentation par jour au total.
   ============================================================ */

var SITE = 'https://hbsgo.vercel.app';
/* Identifiant de la Google Sheet (dans son adresse : /spreadsheets/d/<ID>/edit).
   Vide = la feuille à laquelle le script est rattaché (Extensions > Apps Script). */
var SHEET_ID = '';
var MAX_PAR_JOUR = 40;

var EMAILS = {
  fr: {
    sujet: 'Votre démo d\'automatisation vient de fonctionner — HBSGo',
    texte: [
      'Bonjour,',
      '',
      'Cet email vient d\'être envoyé automatiquement : vous avez rempli le formulaire de notre démo, et le workflow a enregistré votre demande puis déclenché cet envoi, sans aucune intervention humaine.',
      '',
      'C\'est exactement ce que nous pouvons mettre en place pour votre entreprise :',
      '- des agents IA qui trient vos emails et préparent les réponses ;',
      '- des automatisations entre vos outils (Gmail, Google Sheets, Notion, Airtable, Slack, CRM…) avec n8n, Make ou Zapier ;',
      '- des chatbots pour votre site et des agents vocaux qui répondent au téléphone ;',
      '- la collecte de données et la veille de prix automatiques ;',
      '- des rapports d\'activité générés et envoyés tout seuls.',
      '',
      'Testez toutes nos démos : ' + SITE,
      '',
      'Vous avez une tâche répétitive qui vous prend du temps ? Répondez simplement à cet email en la décrivant en quelques lignes : nous vous répondons par écrit avec une proposition claire et un prix fixe.',
      '',
      'L\'équipe HBSGo',
      '',
      '—',
      'Vous recevez cet email parce que cette adresse a été saisie dans le formulaire de démo de ' + SITE + '. Si ce n\'est pas vous, ignorez-le : aucun autre email ne vous sera envoyé.'
    ].join('\n')
  },
  en: {
    sujet: 'Your automation demo just worked — HBSGo',
    texte: [
      'Hello,',
      '',
      'This email was sent automatically: you filled in the form on our demo, and the workflow saved your request and triggered this email, with no human involved.',
      '',
      'This is exactly what we can set up for your business:',
      '- AI agents that sort your emails and draft the replies;',
      '- automations between your tools (Gmail, Google Sheets, Notion, Airtable, Slack, CRM…) with n8n, Make or Zapier;',
      '- website chatbots and voice agents that answer the phone;',
      '- automatic data collection and price monitoring;',
      '- activity reports generated and sent on their own.',
      '',
      'Try all our demos: ' + SITE,
      '',
      'Do you have a repetitive task that takes up your time? Just reply to this email and describe it in a few lines: we will answer in writing with a clear proposal and a fixed price.',
      '',
      'The HBSGo team',
      '',
      '—',
      'You are receiving this email because this address was entered in the demo form on ' + SITE + '. If this was not you, please ignore it: no other email will be sent.'
    ].join('\n')
  }
};

/* Accusé de réception FIXE pour la page Contact (le message du visiteur n'y est jamais recopié). */
var CONFIRMATIONS = {
  fr: {
    sujet: 'Votre message est bien reçu — HBSGo',
    texte: [
      'Bonjour,',
      '',
      'Merci pour votre message : il nous est bien parvenu. Nous l\'étudions et vous répondons par écrit rapidement, avec une proposition claire et un devis fixe.',
      '',
      'Si vous voulez ajouter une précision (outils utilisés, volumes, délais), répondez simplement à cet email.',
      '',
      'En attendant, vous pouvez tester nos démos : ' + SITE,
      '',
      'L\'équipe HBSGo',
      '',
      '—',
      'Vous recevez cet email parce que cette adresse a été saisie dans le formulaire de contact de ' + SITE + '. Si ce n\'est pas vous, ignorez-le.'
    ].join('\n')
  },
  en: {
    sujet: 'Your message has been received — HBSGo',
    texte: [
      'Hello,',
      '',
      'Thank you for your message: we have received it. We will review it and reply in writing shortly, with a clear proposal and a fixed price.',
      '',
      'If you would like to add details (tools you use, volumes, deadlines), just reply to this email.',
      '',
      'Meanwhile, feel free to try our demos: ' + SITE,
      '',
      'The HBSGo team',
      '',
      '—',
      'You are receiving this email because this address was entered in the contact form on ' + SITE + '. If this was not you, please ignore it.'
    ].join('\n')
  }
};

/* Feuille de destination : celle de SHEET_ID si elle est accessible, sinon une feuille créée
   automatiquement dans le compte du propriétaire (son identifiant est mémorisé ensuite). */
function feuilleLeads_() {
  var props = PropertiesService.getScriptProperties();
  var ids = [props.getProperty('SHEET_ID'), SHEET_ID].filter(function (x) { return x; });
  for (var i = 0; i < ids.length; i++) {
    try { return SpreadsheetApp.openById(ids[i]); } catch (e) { /* feuille introuvable : on essaie la suivante */ }
  }
  try { var active = SpreadsheetApp.getActiveSpreadsheet(); if (active) return active; } catch (e) { /* script autonome */ }
  var ss = SpreadsheetApp.create('Leads site HBSGo');
  props.setProperty('SHEET_ID', ss.getId());
  return ss;
}

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
    var source = d.source === 'contact' ? 'contact' : 'demo';
    var email = String(d.email || '').trim().toLowerCase().slice(0, 120);
    var telephone = String(d.telephone || '').replace(/[^+()\d\s.-]/g, '').trim().slice(0, 25);
    if (email && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i.test(email)) return reponse({ ok: false, error: 'invalid_input' });
    if (!email && (source === 'demo' || !telephone)) return reponse({ ok: false, error: 'invalid_input' });
    var nom = propre(d.nom, 80), entreprise = propre(d.entreprise, 80), besoin = propre(d.besoin, 600);

    var props = PropertiesService.getScriptProperties();
    var cache = CacheService.getScriptCache();
    var jour = Utilities.formatDate(new Date(), 'Europe/Paris', 'yyyy-MM-dd');
    var compteur = Number(props.getProperty('envois_' + jour) || 0);

    var statut;
    if (!email) statut = 'pas d\'email (à rappeler par téléphone)';
    else {
      var cle = 'deja_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email));
      if (cache.get(cle)) statut = 'déjà envoyé récemment (non renvoyé)';
      else if (compteur >= MAX_PAR_JOUR) statut = 'plafond du jour atteint (non envoyé)';
      else {
        var modele = (source === 'contact' ? CONFIRMATIONS : EMAILS)[lang];
        MailApp.sendEmail({ to: email, subject: modele.sujet, body: modele.texte, name: 'HBSGo' });
        cache.put(cle, '1', 21600);
        props.setProperty('envois_' + jour, String(compteur + 1));
        statut = 'email envoyé';
      }
    }

    var ss = feuilleLeads_();
    var feuille = ss.getSheetByName('Leads') || ss.insertSheet('Leads');
    if (feuille.getLastRow() === 0) feuille.appendRow(['Date', 'Source', 'Nom', 'Email', 'Téléphone', 'Entreprise', 'Besoin', 'Langue', 'Statut']);
    feuille.appendRow([new Date(), source === 'contact' ? 'Page Contact' : 'Démo automatisation', nom, email, propre(telephone, 25), entreprise, besoin, lang, statut]);

    var moi = Session.getEffectiveUser().getEmail();
    var notif = {
      to: moi,
      subject: (source === 'contact' ? '[Site] Nouveau message de ' : '[Démo site] Nouveau contact : ') + (nom || email || telephone),
      body: 'Source : ' + (source === 'contact' ? 'page Contact' : 'démo automatisation') + '\nNom : ' + nom + '\nEmail : ' + (email || '—') + '\nTéléphone : ' + (telephone || '—') +
        '\nEntreprise : ' + entreprise + '\nBesoin :\n' + besoin + '\n\nLangue : ' + lang + '\nStatut : ' + statut + '\nFeuille : ' + ss.getUrl()
    };
    if (email) notif.replyTo = email;
    MailApp.sendEmail(notif);

    return reponse({ ok: true, envoye: statut === 'email envoyé', statut: statut });
  } catch (err) {
    return reponse({ ok: false, error: 'internal', detail: String(err).slice(0, 200) });
  } finally {
    lock.releaseLock();
  }
}

/* À lancer une fois à la main (bouton « Exécuter ») pour autoriser Gmail et Sheets. */
function autoriser() {
  var ss = feuilleLeads_();
  Logger.log('Feuille : ' + ss.getName());
  MailApp.getRemainingDailyQuota();
  Logger.log('Autorisations OK. Emails encore disponibles aujourd\'hui : ' + MailApp.getRemainingDailyQuota());
}
