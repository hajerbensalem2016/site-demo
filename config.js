/* ============================================================
   config.js — configuration publique du site de démos
   ------------------------------------------------------------
   Ce fichier est chargé dans le navigateur : il ne doit contenir
   AUCUNE clé secrète. Seules des URLs publiques (webhooks n8n,
   embeds Airtable/Notion, vidéos Loom) et la clé PUBLIQUE Vapi.

   Toute valeur qui commence par "TODO_" est considérée comme
   non configurée : la démo bascule alors en "mode démo hors ligne"
   (simulation locale) pour rester présentable.
   ============================================================ */
window.DEMO_CONFIG = {
  /* --- Webhooks n8n (POST JSON) — construits par l'agent constructeur-workflows-n8n --- */
  webhookAutomatisation: "TODO_WEBHOOK_AUTOMATISATION", // body { nom, email, entreprise, besoin } -> { ok, message }
  webhookCrm:            "TODO_WEBHOOK_CRM",            // body { nom, email, entreprise, besoin } -> { ok, message }
  webhookScraping:       "TODO_WEBHOOK_SCRAPING",       // body { cible } -> { ok, message, resultats? }

  /* --- Agent vocal (Vapi) : clé PUBLIQUE uniquement --- */
  vapiPublicKey:   "TODO_VAPI_PUBLIC_KEY",
  vapiAssistantId: "TODO_VAPI_ASSISTANT_ID",

  /* --- Vidéos Loom de 60 s (URL d'embed : https://www.loom.com/embed/XXXX) --- */
  loom: {
    agentEmail:     "TODO_LOOM_AGENT_EMAIL",
    automatisation: "TODO_LOOM_AUTOMATISATION",
    chatbot:        "TODO_LOOM_CHATBOT",
    agentVocal:     "TODO_LOOM_AGENT_VOCAL",
    scraping:       "TODO_LOOM_SCRAPING",
    crmNotion:      "TODO_LOOM_CRM_NOTION",
    rapport:        "TODO_LOOM_RAPPORT"
  },

  /* --- Embeds publics (iframes) --- */
  sheetEmbed:    "TODO_SHEET_EMBED",    // Google Sheet publié sur le web (Fichier > Partager > Publier)
  airtableEmbed: "TODO_AIRTABLE_EMBED", // Vue Airtable partagée (https://airtable.com/embed/...)

  /* --- Liens de contact --- */
  upwork: "TODO_UPWORK",
  malt:   "TODO_MALT",

  /* --- Limite de tests gratuits par démo et par jour (compteur localStorage) --- */
  maxTestsPerDay: 5
};
