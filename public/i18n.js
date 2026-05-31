/**
 * CrewiGO — i18n  (FR default, EN supported)
 * Usage :
 *   t('key')          → translated string in current locale
 *   t('key', {n: 3})  → with variable interpolation {{n}}
 *   i18n.setLang('en')
 *   i18n.lang         → 'fr' | 'en'
 *
 * DOM elements with data-i18n="key" are auto-translated on setLang().
 * Elements with data-i18n-placeholder="key" get their placeholder translated.
 * Elements with data-i18n-title="key" get their title/aria-label translated.
 */

(function(window) {
  'use strict';

  // ─── Translation dictionaries ─────────────────────────────────────────────
  const LOCALES = {
    fr: {
      // Navigation
      'nav.hub':        'Hub',
      'nav.roadmap':    'Road Map',
      'nav.budget':     'CrewiCash',
      'nav.chat':       'CrewiChat',
      'nav.pics':       'CrewiPics',

      // App chrome
      'app.title':              'CrewiGO — Voyages entre amis',
      'app.tagline':            'Roam together.',
      'btn.settings':           'Paramètres',
      'btn.logout':             'Déconnexion',
      'btn.lang':               '🇬🇧 EN',

      // Auth
      'auth.login.title':       'Connexion',
      'auth.register.title':    'Inscription',
      'auth.register.h2':       'Crée ton compte',
      'auth.email':             'Email',
      'auth.password':          'Mot de passe',
      'auth.name':              'Prénom',
      'auth.btn.login':         'Se connecter',
      'auth.btn.register':      'Créer mon compte',
      'auth.switch.to_register':'Pas encore de compte ? S\'inscrire',
      'auth.switch.to_register_link': 'Créer un compte',
      'auth.switch.to_login':   'Déjà un compte ? Se connecter',
      'auth.switch.to_login_link': 'Se connecter',
      'auth.forgot':            'Mot de passe oublié ?',
      'auth.error.invalid':     'Email ou mot de passe incorrect',
      'auth.error.email_taken': 'Cet email est déjà utilisé',

      // Empty state
      'empty.title':    'Ton prochain trip te manque.',
      'empty.subtitle': 'Crée-le en 30 secondes.',
      'empty.btn.create': 'Lancer mon premier trip',
      'empty.join.label': 'Tu as reçu un lien d\'invitation ?',
      'empty.join.placeholder': 'Colle le lien ici…',
      'empty.join.btn': 'Rejoindre →',

      // Onboarding
      'ob.slide1.title':  'Lance ton trip\nen 30 secondes',
      'ob.slide1.body':   'Dates, destination, compagnons de route — crée ton voyage en quelques taps et partage-le instantanément avec tout le groupe.',
      'ob.slide2.title':  'Invite ton crew\nd\'un lien',
      'ob.slide2.body':   'Partage un lien magique — chaque membre accède au programme, aux réservations, au budget et aux photos. Sans inscription requise.',
      'ob.slide3.title':  'Tout en un endroit,\nmême hors ligne',
      'ob.slide3.body':   'Road Map, dépenses partagées, chat, photos — une seule app pour tout gérer, accessible sans réseau une fois installée.',
      'ob.skip':          'Passer',
      'ob.next':          'Suivant →',
      'ob.start':         'Lancer mon premier trip 🚀',

      // Hub (accueil) tab
      'hub.participants':       'Participants',
      'hub.btn.participant_view': 'Vue participant',
      'hub.btn.add_participant':  '+ Ajouter',

      // Common actions
      'btn.save':    'Enregistrer',
      'btn.cancel':  'Annuler',
      'btn.delete':  'Supprimer',
      'btn.add':     'Ajouter',
      'btn.close':   'Fermer',
      'btn.share':   'Partager',
      'btn.copy':    'Copier',
      'btn.edit':    'Modifier',
      'btn.confirm': 'Confirmer',
      'btn.send':    'Envoyer',
      'btn.create':  'Créer',
      'btn.back':    '← Retour',
      'btn.next':    'Suivant →',
      'btn.finish':  'Terminer',
      'btn.ok':      'OK',

      // Menu voyage
      'menu.share_trip':      'Partager le trip',
      'menu.share_trip.sub':  'Générer un lien pour le crew',
      'menu.join_voyage':     'Rejoindre le voyage',
      'menu.join_voyage.sub': 'Participer en tant qu\'organisateur',
      'menu.edit_voyage':     'Modifier le voyage',
      'menu.export_pdf':      'Exporter en PDF',
      'menu.delete_voyage':   'Supprimer le voyage',
      'menu.delete_voyage.sub': 'Action irréversible',

      // Toast messages
      'toast.copied':         '✅ Lien copié !',
      'toast.saved':          '✅ Enregistré',
      'toast.deleted':        '🗑️ Supprimé',
      'toast.error_network':  '❌ Erreur réseau',
      'toast.error_server':   '❌ Erreur serveur',
      'toast.offline':        '📶 Hors ligne — les modifications seront synchronisées à la reconnexion',

      // Statuses
      'status.ongoing':   'En cours',
      'status.upcoming':  'À venir',
      'status.past':      'Terminé',
      'status.planning':  'En préparation',

      // Road Map tab
      'roadmap.tab':              'Road Map',
      'roadmap.reservations':     'Réservations',
      'roadmap.documents':        'Documents',
      'roadmap.tasks':            'Préparation',
      'roadmap.btn.add_resa':     'Ajouter',
      'roadmap.btn.import_email': 'Importer email',
      'roadmap.btn.export_pdf':   'Exporter PDF',

      // Budget tab
      'budget.tab':       'Budget',
      'budget.expenses':  'Dépenses',
      'budget.balance':   'Soldes',
      'budget.total':     'Total',
      'budget.per_person': 'Par personne',
      'budget.add_expense': 'Ajouter une dépense',
      'budget.settled':   'Remboursé',
      'budget.owes':      'doit',
      'budget.to':        'à',

      // Chat tab
      'chat.placeholder': 'Écrire un message en tant qu\'organisateur…',
      'chat.private_msg': 'Message privé',
      'chat.general':     'Discussion générale',

      // Share modal
      'share.title':      '🔗 Partager le voyage',
      'share.desc':       'Partage ce lien ou montre le QR code à tes compagnons de voyage. Ils pourront voir les réservations et l\'agenda.',
      'share.btn.copy':   'Copier le lien',
      'share.btn.share':  'Partager',
      'share.btn.revoke': 'Nouveau lien',

      // Participant modal
      'participant.add_title':  'Ajouter un participant',
      'participant.edit_title': 'Modifier le participant',
      'participant.name':       'Prénom',
      'participant.color':      'Couleur',

      // Errors
      'error.404':        'Page introuvable',
      'error.network':    'Erreur réseau — vérifie ta connexion',
      'error.permission': 'Accès refusé',
    },

    en: {
      // Navigation
      'nav.hub':        'Hub',
      'nav.roadmap':    'Road Map',
      'nav.budget':     'CrewiCash',
      'nav.chat':       'CrewiChat',
      'nav.pics':       'CrewiPics',

      // App chrome
      'app.title':              'CrewiGO — Group Travel',
      'app.tagline':            'Roam together.',
      'btn.settings':           'Settings',
      'btn.logout':             'Log out',
      'btn.lang':               '🇫🇷 FR',

      // Auth
      'auth.login.title':       'Sign in',
      'auth.register.title':    'Sign up',
      'auth.register.h2':       'Create your account',
      'auth.email':             'Email',
      'auth.password':          'Password',
      'auth.name':              'First name',
      'auth.btn.login':         'Sign in',
      'auth.btn.register':      'Create account',
      'auth.switch.to_register':'No account yet? Sign up',
      'auth.switch.to_register_link': 'Create account',
      'auth.switch.to_login':   'Already have an account? Sign in',
      'auth.switch.to_login_link': 'Sign in',
      'auth.forgot':            'Forgot password?',
      'auth.error.invalid':     'Incorrect email or password',
      'auth.error.email_taken': 'This email is already in use',

      // Empty state
      'empty.title':    'Your next trip is waiting.',
      'empty.subtitle': 'Create it in 30 seconds.',
      'empty.btn.create': 'Start my first trip',
      'empty.join.label': 'Received an invitation link?',
      'empty.join.placeholder': 'Paste the link here…',
      'empty.join.btn': 'Join →',

      // Onboarding
      'ob.slide1.title':  'Start your trip\nin 30 seconds',
      'ob.slide1.body':   'Dates, destination, travel buddies — create your trip in a few taps and share it instantly with the whole group.',
      'ob.slide2.title':  'Invite your crew\nwith one link',
      'ob.slide2.body':   'Share a magic link — every member gets access to the schedule, bookings, budget and photos. No sign-up required.',
      'ob.slide3.title':  'Everything in one place,\neven offline',
      'ob.slide3.body':   'Road Map, shared expenses, chat, photos — one app to manage it all, accessible without network once installed.',
      'ob.skip':          'Skip',
      'ob.next':          'Next →',
      'ob.start':         'Start my first trip 🚀',

      // Hub tab
      'hub.participants':       'Crew',
      'hub.btn.participant_view': 'Participant view',
      'hub.btn.add_participant':  '+ Add',

      // Common actions
      'btn.save':    'Save',
      'btn.cancel':  'Cancel',
      'btn.delete':  'Delete',
      'btn.add':     'Add',
      'btn.close':   'Close',
      'btn.share':   'Share',
      'btn.copy':    'Copy',
      'btn.edit':    'Edit',
      'btn.confirm': 'Confirm',
      'btn.send':    'Send',
      'btn.create':  'Create',
      'btn.back':    '← Back',
      'btn.next':    'Next →',
      'btn.finish':  'Done',
      'btn.ok':      'OK',

      // Menu voyage
      'menu.share_trip':      'Share trip',
      'menu.share_trip.sub':  'Generate a link for the crew',
      'menu.join_voyage':     'Join the trip',
      'menu.join_voyage.sub': 'Participate as organiser',
      'menu.edit_voyage':     'Edit trip',
      'menu.export_pdf':      'Export to PDF',
      'menu.delete_voyage':   'Delete trip',
      'menu.delete_voyage.sub': 'Irreversible action',

      // Toast messages
      'toast.copied':         '✅ Link copied!',
      'toast.saved':          '✅ Saved',
      'toast.deleted':        '🗑️ Deleted',
      'toast.error_network':  '❌ Network error',
      'toast.error_server':   '❌ Server error',
      'toast.offline':        '📶 Offline — changes will sync on reconnect',

      // Statuses
      'status.ongoing':   'Ongoing',
      'status.upcoming':  'Upcoming',
      'status.past':      'Past',
      'status.planning':  'Planning',

      // Road Map tab
      'roadmap.tab':              'Road Map',
      'roadmap.reservations':     'Bookings',
      'roadmap.documents':        'Documents',
      'roadmap.tasks':            'Preparation',
      'roadmap.btn.add_resa':     'Add',
      'roadmap.btn.import_email': 'Import email',
      'roadmap.btn.export_pdf':   'Export PDF',

      // Budget tab
      'budget.tab':       'Budget',
      'budget.expenses':  'Expenses',
      'budget.balance':   'Balances',
      'budget.total':     'Total',
      'budget.per_person': 'Per person',
      'budget.add_expense': 'Add expense',
      'budget.settled':   'Settled',
      'budget.owes':      'owes',
      'budget.to':        'to',

      // Chat tab
      'chat.placeholder': 'Write a message as organiser…',
      'chat.private_msg': 'Private message',
      'chat.general':     'General chat',

      // Share modal
      'share.title':      '🔗 Share trip',
      'share.desc':       'Share this link or show the QR code to your travel companions. They\'ll be able to see bookings and the schedule.',
      'share.btn.copy':   'Copy link',
      'share.btn.share':  'Share',
      'share.btn.revoke': 'New link',

      // Participant modal
      'participant.add_title':  'Add participant',
      'participant.edit_title': 'Edit participant',
      'participant.name':       'First name',
      'participant.color':      'Colour',

      // Errors
      'error.404':        'Page not found',
      'error.network':    'Network error — check your connection',
      'error.permission': 'Access denied',
    }
  };

  // ─── State ────────────────────────────────────────────────────────────────
  const LS_KEY = 'crewigo_lang';

  function _detectLang() {
    try {
      const stored = localStorage.getItem(LS_KEY);
      if (stored && LOCALES[stored]) return stored;
    } catch {}
    // Browser language detection
    const bl = (navigator.language || 'fr').split('-')[0].toLowerCase();
    return LOCALES[bl] ? bl : 'fr';
  }

  let _lang = _detectLang();

  // ─── Core API ─────────────────────────────────────────────────────────────

  /**
   * Translate a key. Missing keys fall back to 'fr', then return the key itself.
   * Supports {{variable}} interpolation.
   * @param {string} key
   * @param {Object} [vars]  e.g. { count: 3 }
   */
  function t(key, vars) {
    let str = (LOCALES[_lang] && LOCALES[_lang][key])
           || (LOCALES['fr']  && LOCALES['fr'][key])
           || key;
    if (vars) {
      str = str.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? vars[k] : _));
    }
    return str;
  }

  /** Switch to a new locale and re-render all data-i18n elements. */
  function setLang(lang) {
    if (!LOCALES[lang]) return;
    _lang = lang;
    try { localStorage.setItem(LS_KEY, lang); } catch {}
    document.documentElement.lang = lang;
    _applyAll();
    // Notify any listeners
    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
    // Feedback toast (via global toast() if available)
    const label = lang === 'en' ? '🌐 Language: English' : '🌐 Langue : Français';
    if (typeof window.toast === 'function') window.toast(label);
  }

  /** Toggle between fr and en. */
  function toggleLang() {
    setLang(_lang === 'fr' ? 'en' : 'fr');
  }

  // ─── DOM application ─────────────────────────────────────────────────────

  /**
   * Apply translations to all [data-i18n], [data-i18n-placeholder],
   * [data-i18n-title], [data-i18n-aria] elements in the document.
   */
  function _applyAll(root) {
    const ctx = root || document;
    ctx.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      if (key) el.textContent = t(key);
    });
    ctx.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.dataset.i18nPlaceholder;
      if (key) el.placeholder = t(key);
    });
    ctx.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.dataset.i18nTitle;
      if (key) {
        el.title = t(key);
        if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', t(key));
      }
    });
    ctx.querySelectorAll('[data-i18n-html]').forEach(el => {
      const key = el.dataset.i18nHtml;
      if (key) el.innerHTML = t(key);
    });
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  window.t      = t;
  window.i18n   = { t, setLang, toggleLang, get lang() { return _lang; }, apply: _applyAll };

  // Auto-apply once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => _applyAll());
  } else {
    _applyAll();
  }

})(window);
