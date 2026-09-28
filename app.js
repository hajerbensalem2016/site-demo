/* ============================================================
   app.js — logique commune à toutes les pages
   - i18n FR/EN (objet `i18n`, langue mémorisée en localStorage)
   - thème clair/sombre (prefers-color-scheme + bouton)
   - limite de tests : 5 par démo et par jour (localStorage)
   - helpers fetch vers /api/* et webhooks, bandeau "mode démo hors ligne"
   - montage de l'en-tête, du pied de page, des vidéos Loom et des CTA
   Aucune clé API ici : tout secret vit côté serverless (/api/*.js).
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.DEMO_CONFIG || {};
  var MAX_TESTS = Number(CFG.maxTestsPerDay) > 0 ? Number(CFG.maxTestsPerDay) : 5;

  /* ---------- utilitaires ---------- */
  function isTodo(v) { return !v || /^TODO_/.test(String(v).trim()); }
  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, String(v)); } catch (e) { /* stockage indisponible */ } }
  };
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function root() { return (document.body && document.body.getAttribute('data-root')) || './'; }

  /* ---------- i18n ---------- */
  var i18n = {
    fr: {
      site_name: 'HBSGo',
      site_tag: 'Expert Automatisation & IA | n8n, Make, Zapier | Chatbots, Agents vocaux, CRM',
      nav_home: 'Accueil',
      nav_contact: 'Contactez-nous',
      footer_services: 'Services',
      footer_demos: 'Démos',
      cta_contact: 'Contactez-nous',
      theme_toggle: 'Changer de thème (clair / sombre)',
      back_home: '← Retour à l\'accueil',
      test_zone: 'Testez vous-même',
      tests_left: 'Tests gratuits restants aujourd\'hui : {n}/{max}',
      quota_reached: 'Vous avez utilisé vos {max} tests gratuits pour cette démo aujourd\'hui. Revenez demain, ou contactez-nous pour une démo complète sur vos propres données.',
      offline_banner: 'Mode démo hors ligne — le backend n\'est pas encore connecté : le résultat ci-dessous est une simulation locale, mais le rendu final sera identique.',
      loom_title: 'La démo en 60 secondes',
      loom_todo: 'Vidéo Loom à venir — remplacer la valeur TODO_LOOM dans config.js',
      how_title: 'Comment ça marche',
      cta_title: 'Vous voulez ça pour votre entreprise ?',
      cta_text: 'Décrivez votre besoin par écrit : nous vous répondons avec un cadrage clair et un devis fixe avant de commencer, et on fixe un échange seulement si c\'est utile. Vidéo explicative de chaque système livré et 14 jours de support offerts.',
      cta_upwork: 'Nous trouver sur Upwork',
      cta_malt: 'Nous trouver sur Malt',
      cta_todo: 'Lien à configurer dans config.js (TODO_UPWORK / TODO_MALT)',
      btn_run: 'Lancer le test',
      loading: 'Traitement en cours…',
      error_generic: 'Une erreur est survenue. Réessayez dans un instant.',
      footer_text: '© {year} HBSGo',
      footer_free: 'Automatisation · Intelligence artificielle · Sites et applications',
      yes: 'Oui', no: 'Non'
    },
    en: {
      site_name: 'HBSGo',
      site_tag: 'AI & Automation Expert | n8n, Make, Zapier | Chatbots, Voice Agents, CRM',
      nav_home: 'Home',
      nav_contact: 'Contact us',
      footer_services: 'Services',
      footer_demos: 'Demos',
      cta_contact: 'Contact us',
      theme_toggle: 'Toggle theme (light / dark)',
      back_home: '← Back to home',
      test_zone: 'Try it yourself',
      tests_left: 'Free tests left today: {n}/{max}',
      quota_reached: 'You have used your {max} free tests for this demo today. Come back tomorrow, or contact us for a full demo on your own data.',
      offline_banner: 'Offline demo mode — the backend is not connected yet: the result below is a local simulation, but the final output will look the same.',
      loom_title: 'The demo in 60 seconds',
      loom_todo: 'Loom video coming soon — replace the TODO_LOOM value in config.js',
      how_title: 'How it works',
      cta_title: 'Want this for your business?',
      cta_text: 'Describe your need in writing: we reply with a clear scope and a fixed price before starting, and we schedule a call only if useful. Video walkthrough of every system delivered and 14 days of free support.',
      cta_upwork: 'Find us on Upwork',
      cta_malt: 'Find us on Malt',
      cta_todo: 'Link to configure in config.js (TODO_UPWORK / TODO_MALT)',
      btn_run: 'Run the test',
      loading: 'Processing…',
      error_generic: 'Something went wrong. Please try again in a moment.',
      footer_text: '© {year} HBSGo',
      footer_free: 'Automation · Artificial intelligence · Websites and apps',
      yes: 'Yes', no: 'No'
    }
  };

  var lang = (function () {
    var saved = store.get('demo_lang');
    if (saved === 'fr' || saved === 'en') return saved;
    var nav = (navigator.language || 'fr').toLowerCase();
    return nav.indexOf('en') === 0 ? 'en' : 'fr';
  })();

  function dict(l) {
    var page = (window.PAGE_I18N || {})[l] || {};
    return Object.assign({}, i18n[l] || {}, page);
  }
  function t(key, vars) {
    var d = dict(lang);
    var s = d[key];
    if (s === undefined) s = (dict('fr')[key] !== undefined ? dict('fr')[key] : key);
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split('{' + k + '}').join(vars[k]); });
    return s;
  }
  function applyI18n(rootEl) {
    document.documentElement.setAttribute('lang', lang);
    qsa('[data-i18n]', rootEl).forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    qsa('[data-i18n-html]', rootEl).forEach(function (el) { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    qsa('[data-i18n-placeholder]', rootEl).forEach(function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
    qsa('[data-i18n-title]', rootEl).forEach(function (el) { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
    qsa('[data-i18n-aria]', rootEl).forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
    var titleKey = document.body && document.body.getAttribute('data-title-key');
    if (titleKey) document.title = t(titleKey) + ' · ' + t('site_name');
    qsa('.lang-switch button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-lang') === lang ? 'true' : 'false'); });
    qsa('#site-footer [data-year]').forEach(function (el) { el.textContent = t('footer_text', { year: new Date().getFullYear() }); });
  }
  function setLang(l) {
    if (l !== 'fr' && l !== 'en') return;
    lang = l;
    store.set('demo_lang', l);
    applyI18n();
    document.dispatchEvent(new CustomEvent('demo:lang', { detail: { lang: l } }));
  }

  /* ---------- thème ---------- */
  function currentTheme() {
    var forced = document.documentElement.getAttribute('data-theme');
    if (forced) return forced;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme(th) {
    if (th) document.documentElement.setAttribute('data-theme', th);
    var btn = qs('.theme-btn');
    if (btn) btn.innerHTML = currentTheme() === 'dark' ? ICON_SUN : ICON_MOON;
  }
  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    store.set('demo_theme', next);
    applyTheme(next);
  }
  var savedTheme = store.get('demo_theme');
  if (savedTheme === 'dark' || savedTheme === 'light') document.documentElement.setAttribute('data-theme', savedTheme);

  var ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  var ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4"/></svg>';
  var ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4m0 4h.01"/></svg>';
  var ICON_VIDEO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2z"/></svg>';

  /* ---------- quota : 5 tests / démo / jour ---------- */
  function quotaKey(slug) { return 'demo_quota_' + slug + '_' + todayKey(); }
  function quotaUsed(slug) { var n = parseInt(store.get(quotaKey(slug)) || '0', 10); return isNaN(n) ? 0 : n; }
  function quotaRemaining(slug) { return Math.max(0, MAX_TESTS - quotaUsed(slug)); }
  function renderQuota(slug) {
    qsa('[data-quota]').forEach(function (el) {
      var used = quotaUsed(slug), dots = '';
      for (var i = 0; i < MAX_TESTS; i++) dots += '<i class="' + (i < used ? 'used' : '') + '"></i>';
      el.innerHTML = '<span>' + escapeHtml(t('tests_left', { n: quotaRemaining(slug), max: MAX_TESTS })) + '</span><span class="quota-dots" aria-hidden="true">' + dots + '</span>';
    });
    var msg = qs('[data-quota-msg]');
    var exhausted = quotaRemaining(slug) <= 0;
    if (msg) msg.textContent = exhausted ? t('quota_reached', { max: MAX_TESTS }) : '';
    qsa('[data-run]').forEach(function (b) { b.disabled = exhausted; });
    return !exhausted;
  }
  /* Consomme un test ; renvoie false (et affiche le message) si la limite est atteinte. */
  function consumeQuota(slug) {
    if (quotaRemaining(slug) <= 0) { renderQuota(slug); return false; }
    store.set(quotaKey(slug), quotaUsed(slug) + 1);
    renderQuota(slug);
    return true;
  }

  /* ---------- appels réseau ---------- */
  function postJson(url, body, timeoutMs) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 25000) : null;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).catch(function (err) { if (timer) clearTimeout(timer); throw err; });
  }
  /* Route serverless Vercel : /api/<name>. Ajoute toujours { lang }. */
  function apiPost(name, body) {
    return postJson(root() + 'api/' + name, Object.assign({ lang: lang }, body || {}));
  }
  /* Bandeau "mode démo hors ligne" inséré au début d'un conteneur. */
  function offlineBanner(container, text) {
    qsa('.banner-offline', container).forEach(function (b) { b.remove(); });
    var div = document.createElement('div');
    div.className = 'banner banner-offline';
    div.setAttribute('role', 'status');
    div.innerHTML = ICON_WARN + '<span>' + escapeHtml(text || t('offline_banner')) + '</span>';
    container.insertBefore(div, container.firstChild);
    return div;
  }
  function errorBanner(container, text) {
    var div = document.createElement('div');
    div.className = 'banner banner-error';
    div.innerHTML = ICON_WARN + '<span>' + escapeHtml(text || t('error_generic')) + '</span>';
    container.appendChild(div);
    return div;
  }
  function setBusy(btn, busy) {
    if (!btn) return;
    if (busy) {
      btn.setAttribute('data-label', btn.innerHTML);
      btn.innerHTML = '<span class="spinner"></span> ' + escapeHtml(t('loading'));
      btn.disabled = true;
    } else {
      btn.innerHTML = btn.getAttribute('data-label') || btn.innerHTML;
      btn.disabled = false;
    }
  }

  /* ---------- markdown minimal (rapport) ---------- */
  function inline(md) {
    return escapeHtml(md)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');
  }
  function md2html(md) {
    var lines = String(md || '').replace(/\r/g, '').split('\n'), out = [], i = 0;
    while (i < lines.length) {
      var l = lines[i];
      if (/^\s*$/.test(l)) { i++; continue; }
      var h = l.match(/^(#{1,3})\s+(.*)$/);
      if (h) { out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
      if (/^\s*\|/.test(l)) {
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        var cells = function (r) { return r.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); }); };
        var head = cells(rows[0]);
        var body = rows.slice(1).filter(function (r) { return !/^\s*\|?\s*:?-{2,}/.test(r); });
        var html = '<div class="table-wrap"><table><thead><tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
        body.forEach(function (r) { html += '<tr>' + cells(r).map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>'; });
        out.push(html + '</tbody></table></div>');
        continue;
      }
      if (/^\s*[-*]\s+/.test(l)) {
        var items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push('<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>'); i++; }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\s*\d+\.\s+/.test(l)) {
        var oitems = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { oitems.push('<li>' + inline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>'); i++; }
        out.push('<ol>' + oitems.join('') + '</ol>');
        continue;
      }
      var para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,3})\s|^\s*\||^\s*[-*]\s|^\s*\d+\.\s/.test(lines[i])) { para.push(lines[i]); i++; }
      out.push('<p>' + inline(para.join(' ')) + '</p>');
    }
    return out.join('\n');
  }

  /* ---------- montage de la page ---------- */
  /* Logo HBSGo : lettre H + flèche (même dessin que logo.svg / favicon.svg) */
  var LOGO = '<svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="hbsg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3552d9"/><stop offset="1" stop-color="#0f9d8a"/></linearGradient></defs><path d="M8 50 V14 M8 32 H30 M30 14 V50" fill="none" stroke="url(#hbsg)" stroke-width="7" stroke-linecap="round"/><path d="M40 14 L56 32 L40 50" fill="none" stroke="#0f9d8a" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="brand-name">HBS<span class="go">Go</span></span>';
  function mountFavicon() {
    if (document.querySelector('link[rel="icon"]')) return;
    var l = document.createElement('link'); l.rel = 'icon'; l.type = 'image/svg+xml'; l.href = root() + 'favicon.svg';
    document.head.appendChild(l);
  }
  function mountHeader() {
    var header = qs('#site-header');
    if (!header) return;
    header.innerHTML =
      '<div class="container header-inner">' +
      '  <a class="brand" href="' + root() + '">' + LOGO + '</a>' +
      '  <div class="header-actions">' +
      '    <a class="btn btn-sm nav-contact" href="' + root() + 'contact" data-i18n="nav_contact"></a>' +
      '    <div class="lang-switch" role="group" aria-label="Langue / Language">' +
      '      <button type="button" data-lang="fr" aria-pressed="false">FR</button>' +
      '      <button type="button" data-lang="en" aria-pressed="false">EN</button>' +
      '    </div>' +
      '    <button type="button" class="theme-btn" data-i18n-aria="theme_toggle" data-i18n-title="theme_toggle"></button>' +
      '  </div>' +
      '</div>';
    qsa('.lang-switch button', header).forEach(function (b) { b.addEventListener('click', function () { setLang(b.getAttribute('data-lang')); }); });
    qs('.theme-btn', header).addEventListener('click', toggleTheme);
  }
  function mountFooter() {
    var footer = qs('#site-footer');
    if (!footer) return;
    footer.innerHTML =
      '<div class="container footer-inner">' +
      '  <div class="footer-brand"><a class="brand" href="' + root() + '">' + LOGO + '</a><p data-i18n="footer_free"></p></div>' +
      '  <nav class="footer-links"><a href="' + root() + '#services" data-i18n="footer_services"></a><a href="' + root() + '#demos" data-i18n="footer_demos"></a><a href="' + root() + 'contact" data-i18n="nav_contact"></a></nav>' +
      '</div>' +
      '<div class="container footer-bottom"><p data-year></p></div>';
  }
  function mountLoom() {
    qsa('[data-loom]').forEach(function (box) {
      var key = box.getAttribute('data-loom');
      var url = (CFG.loom || {})[key];
      box.innerHTML = '';
      if (!isTodo(url)) {
        var f = document.createElement('iframe');
        f.src = url; f.setAttribute('allowfullscreen', ''); f.setAttribute('loading', 'lazy'); f.title = 'Loom';
        box.appendChild(f);
      } else {
        /* TODO_LOOM (config.js -> loom.<clé>) : la section vidéo reste masquée tant qu'aucune vidéo n'est fournie */
        var section = box.closest('section');
        if (section) section.hidden = true;
      }
    });
  }
  function mountCta() {
    /* Bouton principal : page Contact (message transmis par email) */
    qsa('[data-cta] .btns').forEach(function (btns) {
      if (qs('[data-cta-contact]', btns)) return;
      var a = document.createElement('a');
      a.className = 'btn'; a.href = root() + 'contact';
      a.setAttribute('data-cta-contact', ''); a.setAttribute('data-i18n', 'cta_contact');
      btns.insertBefore(a, btns.firstChild);
    });
    /* Upwork / Malt : affichés seulement quand l'URL du profil est renseignée dans config.js */
    var pairs = [['[data-cta-upwork]', CFG.upwork], ['[data-cta-malt]', CFG.malt]];
    pairs.forEach(function (p) {
      qsa(p[0]).forEach(function (a) {
        if (isTodo(p[1])) { a.hidden = true; }
        else { a.classList.remove('btn'); a.className = 'btn btn-outline'; a.setAttribute('href', p[1]); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); }
      });
    });
  }
  function mountEmbed() {
    qsa('[data-embed]').forEach(function (box) {
      var url = CFG[box.getAttribute('data-embed')];
      if (!isTodo(url)) { box.innerHTML = '<iframe src="' + escapeHtml(url) + '" loading="lazy" title="embed"></iframe>'; box.removeAttribute('hidden'); }
      else { box.setAttribute('hidden', ''); }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    mountFavicon();
    mountHeader();
    mountFooter();
    mountLoom();
    mountCta();
    mountEmbed();
    applyTheme();
    applyI18n();
    var slug = document.body.getAttribute('data-demo');
    if (slug) renderQuota(slug);
    document.addEventListener('demo:lang', function () { if (slug) renderQuota(slug); });
    if (window.matchMedia) {
      try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (!store.get('demo_theme')) applyTheme(); }); } catch (e) { /* ancien navigateur */ }
    }
  });

  /* ---------- API publique pour les pages ---------- */
  window.Demo = {
    CFG: CFG, MAX_TESTS: MAX_TESTS, isTodo: isTodo,
    t: t, getLang: function () { return lang; }, setLang: setLang, applyI18n: applyI18n,
    qs: qs, qsa: qsa, escapeHtml: escapeHtml, sleep: sleep,
    quotaRemaining: quotaRemaining, consumeQuota: consumeQuota, renderQuota: renderQuota,
    apiPost: apiPost, postJson: postJson, offlineBanner: offlineBanner, errorBanner: errorBanner, setBusy: setBusy,
    md2html: md2html
  };
})();
