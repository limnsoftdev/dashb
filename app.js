import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, deleteUser
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, writeBatch, collection, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig, BUSINESSES_COLLECTION, USERNAME_EMAIL_DOMAIN } from './firebase-config.js';

var SHEET_ID = '1NqfazF8ryvyNUSCuHY3ONUSG6DvNimc1eUCVtKLaHMU';
var CSV_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/export?format=csv';
var AUTO_REFRESH_STALE_MS = 60000;
var NOTE_SAVE_DELAY_MS = 700;

var STATUSES = [
  { value: '', label: 'No status' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'follow-up', label: 'Follow up' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' }
];

var state = {
  view: 'leads',
  profile: null,
  leads: [],
  notes: {},
  businesses: [],
  bizLoaded: false,
  searchTerm: '',
  filter: 'all',
  sort: 'name-asc',
  openIds: new Set(),
  openBizIds: new Set(),
  lastLoaded: null,
  loading: true
};

var unsubscribers = [];
var pendingNoteSaves = {};
var signingUp = false;
var verifiedCode = null;

function $(id) { return document.getElementById(id); }

var els = {
  authScreen: $('authScreen'),
  authBoot: $('authBoot'),
  loginForm: $('loginForm'),
  codeForm: $('codeForm'),
  signupForm: $('signupForm'),
  app: $('app'),
  whoami: $('whoami'),
  signOutBtn: $('signOutBtn'),
  tabs: Array.prototype.slice.call(document.querySelectorAll('.tab')),
  leadsView: $('leadsView'),
  leadFilters: $('leadFilters'),
  bizView: $('bizView'),
  bizSkeleton: $('bizSkeleton'),
  bizList: $('bizList'),
  bizEmpty: $('bizEmpty'),
  bizError: $('bizError'),
  bizErrorMessage: $('bizErrorMessage'),
  searchInput: $('searchInput'),
  sortSelect: $('sortSelect'),
  refreshBtn: $('refreshBtn'),
  retryBtn: $('retryBtn'),
  leadsList: $('leadsList'),
  skeletonState: $('skeletonState'),
  emptyState: $('emptyState'),
  errorState: $('errorState'),
  errorMessage: $('errorMessage'),
  countSummary: $('countSummary'),
  lastUpdated: $('lastUpdated'),
  chips: Array.prototype.slice.call(document.querySelectorAll('.chip')),
  headSortBtns: Array.prototype.slice.call(document.querySelectorAll('.list-head .sortable'))
};

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Firebase ───
var configured = !/^PASTE_/.test(firebaseConfig.apiKey);
var auth = null;
var db = null;
if (configured) {
  var fbApp = initializeApp(firebaseConfig);
  auth = getAuth(fbApp);
  db = getFirestore(fbApp);
}

function usernameToEmail(username) { return username + '@' + USERNAME_EMAIL_DOMAIN; }
function normalizeUsername(v) { return v.trim().toLowerCase(); }

// ─── Auth screens ───
function showAuthForm(which) {
  els.app.hidden = true;
  els.authScreen.hidden = false;
  els.authBoot.hidden = true;
  els.loginForm.hidden = which !== 'login';
  els.codeForm.hidden = which !== 'code';
  els.signupForm.hidden = which !== 'signup';
  ['loginError', 'codeError', 'signupError'].forEach(function (id) { $(id).textContent = ''; });
  var focusTarget = { login: 'loginUsername', code: 'inviteCode', signup: 'signupUsername' }[which];
  if (focusTarget) $(focusTarget).focus();
}

function setBusy(form, busy) {
  var btn = form.querySelector('.primary-btn');
  btn.disabled = busy;
}

function authErrorMessage(err) {
  var code = err && err.code;
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found' || code === 'auth/invalid-email') return 'Wrong username or password.';
  if (code === 'auth/email-already-in-use') return 'That username is taken. Try another.';
  if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a minute and try again.';
  if (code === 'auth/network-request-failed') return "You're offline. Reconnect and try again.";
  if (code === 'auth/operation-not-allowed') return 'Email/password sign-in is not enabled in Firebase yet.';
  if (code === 'permission-denied') return 'That invite code is no longer valid.';
  return 'Something went wrong. Try again.';
}

document.querySelectorAll('[data-goto]').forEach(function (btn) {
  btn.addEventListener('click', function () { showAuthForm(btn.dataset.goto); });
});

els.loginForm.addEventListener('submit', function (e) {
  e.preventDefault();
  var username = normalizeUsername($('loginUsername').value);
  var password = $('loginPassword').value;
  if (!username || !password) { $('loginError').textContent = 'Enter your username and password.'; return; }
  setBusy(els.loginForm, true);
  signInWithEmailAndPassword(auth, usernameToEmail(username), password)
    .catch(function (err) { $('loginError').textContent = authErrorMessage(err); })
    .finally(function () { setBusy(els.loginForm, false); });
});

els.codeForm.addEventListener('submit', function (e) {
  e.preventDefault();
  var code = $('inviteCode').value.trim();
  if (!code || code.indexOf('/') !== -1) { $('codeError').textContent = 'Enter a valid invite code.'; return; }
  setBusy(els.codeForm, true);
  getDoc(doc(db, 'inviteCodes', code))
    .then(function (snap) {
      if (!snap.exists()) { $('codeError').textContent = "That code isn't valid."; return; }
      verifiedCode = code;
      showAuthForm('signup');
    })
    .catch(function (err) {
      $('codeError').textContent = err && err.code === 'unavailable'
        ? "You're offline. Reconnect and try again."
        : "Couldn't check the code right now. Try again in a minute.";
    })
    .finally(function () { setBusy(els.codeForm, false); });
});

els.signupForm.addEventListener('submit', function (e) {
  e.preventDefault();
  var err = $('signupError');
  var username = normalizeUsername($('signupUsername').value);
  var password = $('signupPassword').value;
  if (!/^[a-z0-9_]{3,20}$/.test(username)) { err.textContent = 'Username must be 3–20 letters, numbers or underscores.'; return; }
  if (password.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
  if (password !== $('signupConfirm').value) { err.textContent = "Passwords don't match."; return; }
  if (!verifiedCode) { showAuthForm('code'); return; }

  setBusy(els.signupForm, true);
  signingUp = true;
  var createdUser = null;
  createUserWithEmailAndPassword(auth, usernameToEmail(username), password)
    .then(function (cred) {
      createdUser = cred.user;
      var batch = writeBatch(db);
      batch.set(doc(db, 'users', createdUser.uid), { username: username, inviteCode: verifiedCode, createdAt: serverTimestamp() });
      batch.set(doc(db, 'usernames', username), { uid: createdUser.uid });
      return batch.commit();
    })
    .then(function () {
      signingUp = false;
      enterApp({ uid: createdUser.uid, username: username });
    })
    .catch(function (e2) {
      var msg = authErrorMessage(e2);
      // Profile write was refused (e.g. code revoked mid-signup): don't leave an orphan login behind.
      var cleanup = createdUser ? deleteUser(createdUser).catch(function () { return signOut(auth); }) : Promise.resolve();
      return cleanup.finally(function () {
        signingUp = false;
        showAuthForm('signup');
        err.textContent = msg;
      });
    })
    .finally(function () { setBusy(els.signupForm, false); });
});

els.signOutBtn.addEventListener('click', function () { signOut(auth); });

if (!configured) {
  els.authBoot.textContent = 'Firebase isn’t set up yet. Paste your web config into firebase-config.js.';
} else {
  onAuthStateChanged(auth, function (user) {
    if (signingUp) return; // signup handler finishes (or rolls back) the flow
    if (!user) { leaveApp(); showAuthForm('login'); return; }
    getDoc(doc(db, 'users', user.uid))
      .then(function (snap) {
        if (!snap.exists()) throw new Error('NO_PROFILE');
        enterApp({ uid: user.uid, username: snap.data().username });
      })
      .catch(function () {
        signOut(auth).then(function () {
          showAuthForm('login');
          $('loginError').textContent = "This account isn't activated. Sign up with an invite code.";
        });
      });
  });
}

// ─── App shell ───
function enterApp(profile) {
  if (state.profile && state.profile.uid === profile.uid) return;
  state.profile = profile;
  els.whoami.textContent = profile.username;
  els.authScreen.hidden = true;
  els.app.hidden = false;
  $('loginPassword').value = '';
  $('signupPassword').value = '';
  $('signupConfirm').value = '';

  unsubscribers.push(onSnapshot(collection(db, 'leadNotes'), function (snap) {
    snap.docChanges().forEach(function (ch) {
      if (ch.type === 'removed') delete state.notes[ch.doc.id];
      else state.notes[ch.doc.id] = ch.doc.data();
      patchLeadNotes(ch.doc.id);
    });
  }));

  unsubscribers.push(onSnapshot(collection(db, BUSINESSES_COLLECTION), function (snap) {
    state.businesses = snap.docs.map(function (d) { return toBusiness(d.id, d.data()); });
    state.bizLoaded = true;
    if (state.view === 'businesses') renderBusinesses();
  }, function (err) {
    state.bizLoaded = true;
    els.bizErrorMessage.textContent = err.code === 'permission-denied'
      ? 'Access denied. Check that firestore.rules is published and the collection name in firebase-config.js is right.'
      : 'Something went wrong loading businesses.';
    showBizState('error');
  }));

  loadLeads();
}

function leaveApp() {
  unsubscribers.forEach(function (u) { u(); });
  unsubscribers = [];
  Object.keys(pendingNoteSaves).forEach(function (k) { clearTimeout(pendingNoteSaves[k]); });
  pendingNoteSaves = {};
  state.profile = null;
  state.notes = {};
  state.businesses = [];
  state.bizLoaded = false;
  state.leads = [];
  els.leadsList.innerHTML = '';
  els.bizList.innerHTML = '';
}

els.tabs.forEach(function (tab) {
  tab.addEventListener('click', function () { setView(tab.dataset.view); });
});

function setView(view) {
  state.view = view;
  els.tabs.forEach(function (t) { t.setAttribute('aria-selected', t.dataset.view === view); });
  els.leadsView.hidden = view !== 'leads';
  els.bizView.hidden = view !== 'businesses';
  els.leadFilters.hidden = view !== 'leads';
  els.refreshBtn.hidden = view !== 'leads';
  els.lastUpdated.hidden = view !== 'leads';
  if (view === 'leads') render(); else renderBusinesses();
}

// ─── CSV parsing (handles quoted fields, embedded commas/newlines) ───
function parseCSV(text) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // skip
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return !(r.length === 1 && r[0] === ''); });
}

var COLUMN_MAP = {
  'business name': 'name',
  'phone': 'phone',
  'budget': 'budget',
  'authority': 'authority',
  'need': 'need',
  'timeline': 'timeline',
  'best time to call': 'bestTime',
  'call summary': 'summary'
};

// Stable across sheet re-sorts so notes stay attached to the right lead.
function leadKey(name, phone) {
  var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unnamed';
  var digits = phone.replace(/\D/g, '');
  return digits ? slug + '-' + digits : slug;
}

function rowsToLeads(rows) {
  if (!rows.length) return [];
  var header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
  var idx = {};
  header.forEach(function (h, i) { if (COLUMN_MAP[h]) idx[COLUMN_MAP[h]] = i; });
  if (idx.name === undefined) throw new Error('BAD_FORMAT');

  return rows.slice(1)
    .filter(function (r) { return r.some(function (c) { return c.trim() !== ''; }); })
    .map(function (r, i) {
      function get(key) { return idx[key] !== undefined ? (r[idx[key]] || '').trim() : ''; }
      var name = get('name');
      var phone = get('phone');
      var budget = get('budget'), authority = get('authority'), need = get('need'), timeline = get('timeline');
      return {
        id: 'lead-' + i,
        key: leadKey(name, phone),
        name: name || 'Unnamed lead',
        phone: phone,
        budget: budget,
        authority: authority,
        need: need,
        timeline: timeline,
        bestTime: get('bestTime'),
        summary: get('summary'),
        qualified: !!(budget && authority && need && timeline)
      };
    });
}

function telHref(phone) {
  var digits = phone.replace(/[^\d+]/g, '');
  return 'tel:' + digits;
}

// ─── Fetch ───
function loadLeads() {
  state.loading = true;
  toggleStates('loading');
  fetch(CSV_URL, { cache: 'no-store' })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP_' + res.status);
      return res.text();
    })
    .then(function (text) {
      if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('NOT_PUBLIC');
      var rows = parseCSV(text);
      var leads = rowsToLeads(rows);
      state.leads = leads;
      state.lastLoaded = new Date();
      state.loading = false;
      toggleStates(leads.length ? 'ready' : 'empty-source');
      render();
      updateLastUpdated();
    })
    .catch(function (err) {
      state.loading = false;
      showError(err);
    });
}

function showError(err) {
  var msg = 'Something went wrong fetching the sheet.';
  if (err && err.message === 'NOT_PUBLIC') {
    msg = "This sheet isn't publicly viewable. In Google Sheets, set sharing to “Anyone with the link – Viewer” and reload.";
  } else if (err && /^HTTP_/.test(err.message)) {
    msg = 'The sheet request failed (' + err.message.replace('HTTP_', 'status ') + '). Check the sheet ID and try again.';
  } else if (err && err.message === 'BAD_FORMAT') {
    msg = "Couldn't find a “Business Name” column. Check the sheet's header row matches expectations.";
  } else if (!navigator.onLine) {
    msg = "You're offline. Reconnect and try again.";
  }
  els.errorMessage.textContent = msg;
  toggleStates('error');
}

function toggleStates(mode) {
  els.skeletonState.hidden = mode !== 'loading';
  els.errorState.hidden = mode !== 'error';
  els.leadsList.hidden = !(mode === 'ready' || mode === 'filtered-empty');
  els.emptyState.hidden = mode !== 'empty-source' && mode !== 'filtered-empty';
  if (mode === 'empty-source') {
    els.emptyState.querySelector('h2').textContent = 'No leads yet';
    els.emptyState.querySelector('p').textContent = 'The sheet is connected but has no rows.';
  } else if (mode === 'filtered-empty') {
    els.emptyState.querySelector('h2').textContent = 'No leads found';
    els.emptyState.querySelector('p').textContent = 'Try a different search or filter.';
  }
}

// ─── Filtering / sorting ───
var sortFns = {
  'name-asc': function (a, b) { return a.name.localeCompare(b.name); },
  'name-desc': function (a, b) { return b.name.localeCompare(a.name); },
  'qualified-first': function (a, b) { return (b.qualified - a.qualified) || a.name.localeCompare(b.name); },
  'timeline': function (a, b) { return (a.timeline || '￿').localeCompare(b.timeline || '￿'); }
};

function getVisibleLeads() {
  var term = state.searchTerm.trim().toLowerCase();
  var list = state.leads.filter(function (l) {
    if (term && l.name.toLowerCase().indexOf(term) === -1) return false;
    if (state.filter === 'qualified' && !l.qualified) return false;
    if (state.filter === 'unqualified' && l.qualified) return false;
    return true;
  });
  list.sort(sortFns[state.sort]);
  return list;
}

// ─── Lead notes (shared via Firestore) ───
function statusLabel(value) {
  for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].value === value) return STATUSES[i].label;
  return '';
}

function formatWhen(ts) {
  if (!ts || !ts.toDate) return '';
  return ts.toDate().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function notesMetaText(note) {
  if (!note || !note.updatedBy) return '';
  var when = formatWhen(note.updatedAt);
  return 'Last edited by ' + note.updatedBy + (when ? ' · ' + when : '');
}

function notesHtml(l) {
  var note = state.notes[l.key] || {};
  var options = STATUSES.map(function (s) {
    return '<option value="' + s.value + '"' + (s.value === (note.status || '') ? ' selected' : '') + '>' + s.label + '</option>';
  }).join('');
  return (
    '<div class="lead-notes">' +
      '<label><span class="field-label">Status</span>' +
        '<select class="text-input note-status" data-key="' + escapeHtml(l.key) + '">' + options + '</select></label>' +
      '<label><span class="field-label">Notes</span>' +
        '<textarea class="text-input note-text" data-key="' + escapeHtml(l.key) + '" placeholder="Add notes for the team…">' + escapeHtml(note.notes || '') + '</textarea></label>' +
      '<div class="notes-meta" data-key="' + escapeHtml(l.key) + '">' + escapeHtml(notesMetaText(note)) + '</div>' +
    '</div>'
  );
}

function statusPillHtml(l) {
  var s = (state.notes[l.key] || {}).status || '';
  return '<span class="status-pill" data-key="' + escapeHtml(l.key) + '" data-s="' + escapeHtml(s) + '"' + (s ? '' : ' hidden') + '>' + escapeHtml(statusLabel(s)) + '</span>';
}

function byKey(selector, key) {
  return els.leadsList.querySelectorAll(selector + '[data-key="' + CSS.escape(key) + '"]');
}

// Update in place so a remote edit doesn't wipe what someone is typing.
function patchLeadNotes(key) {
  var note = state.notes[key] || {};
  byKey('.note-status', key).forEach(function (el) {
    if (document.activeElement !== el) el.value = note.status || '';
  });
  byKey('.note-text', key).forEach(function (el) {
    if (document.activeElement !== el && !pendingNoteSaves[key]) el.value = note.notes || '';
  });
  byKey('.notes-meta', key).forEach(function (el) { el.textContent = notesMetaText(note); });
  byKey('.status-pill', key).forEach(function (el) {
    var s = note.status || '';
    el.dataset.s = s;
    el.textContent = statusLabel(s);
    el.hidden = !s;
  });
}

function saveNote(key) {
  clearTimeout(pendingNoteSaves[key]);
  delete pendingNoteSaves[key];
  var statusEl = byKey('.note-status', key)[0];
  var textEl = byKey('.note-text', key)[0];
  if (!statusEl || !textEl || !state.profile) return;
  var metaEl = byKey('.notes-meta', key)[0];
  if (metaEl) metaEl.textContent = 'Saving…';
  setDoc(doc(db, 'leadNotes', key), {
    status: statusEl.value,
    notes: textEl.value,
    updatedBy: state.profile.username,
    updatedAt: serverTimestamp()
  }, { merge: true }).catch(function () {
    if (metaEl) metaEl.textContent = "Couldn't save. Check your connection.";
  });
}

function flushNoteSaves() {
  Object.keys(pendingNoteSaves).forEach(saveNote);
}

els.leadsList.addEventListener('input', function (e) {
  if (!e.target.classList.contains('note-text')) return;
  var key = e.target.dataset.key;
  clearTimeout(pendingNoteSaves[key]);
  pendingNoteSaves[key] = setTimeout(function () { saveNote(key); }, NOTE_SAVE_DELAY_MS);
});
els.leadsList.addEventListener('change', function (e) {
  if (e.target.classList.contains('note-status')) saveNote(e.target.dataset.key);
});
els.leadsList.addEventListener('focusout', function (e) {
  if (e.target.classList.contains('note-text') && pendingNoteSaves[e.target.dataset.key]) saveNote(e.target.dataset.key);
});

// ─── Render ───
function leadRowHtml(l) {
  var open = state.openIds.has(l.key);
  var qIcon = l.qualified
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>';

  function val(v) { return v ? escapeHtml(v) : '<span class="empty">—</span>'; }

  return (
    '<article class="lead" data-open="' + open + '">' +
      '<div class="lead-row">' +
        '<button class="lead-toggle" aria-expanded="' + open + '" aria-controls="detail-' + l.id + '" data-id="' + escapeHtml(l.key) + '">' +
          '<span class="status-dot" data-q="' + l.qualified + '" title="' + (l.qualified ? 'Qualified' : 'Incomplete') + '">' + qIcon + '</span>' +
          '<span class="lead-name">' + escapeHtml(l.name) + '</span>' +
          statusPillHtml(l) +
          '<svg class="lead-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"><path d="m6 9 6 6 6-6"/></svg>' +
        '</button>' +
        '<div class="lead-meta">' +
          (l.phone
            ? '<a class="lead-phone" href="' + telHref(l.phone) + '">' + escapeHtml(l.phone) + '</a>'
            : '<span class="empty">No phone</span>') +
          '<span class="meta-sep">·</span>' +
          '<span class="lead-timeline">' + val(l.timeline) + '</span>' +
          '<span class="meta-sep">·</span>' +
          '<span class="lead-besttime">' + val(l.bestTime) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="lead-detail" id="detail-' + l.id + '" role="region">' +
        '<div class="lead-detail-inner"><div class="lead-detail-content">' +
          '<div class="detail-grid">' +
            '<div class="detail-item"><span class="detail-label">Budget</span><span class="detail-value' + (l.budget ? '' : ' empty') + '">' + val(l.budget) + '</span></div>' +
            '<div class="detail-item"><span class="detail-label">Authority</span><span class="detail-value' + (l.authority ? '' : ' empty') + '">' + val(l.authority) + '</span></div>' +
            '<div class="detail-item"><span class="detail-label">Need</span><span class="detail-value' + (l.need ? '' : ' empty') + '">' + val(l.need) + '</span></div>' +
            '<div class="detail-item"><span class="detail-label">Timeline</span><span class="detail-value' + (l.timeline ? '' : ' empty') + '">' + val(l.timeline) + '</span></div>' +
          '</div>' +
          '<div class="call-summary">' +
            '<span class="detail-label">Call Summary</span>' +
            '<p class="' + (l.summary ? '' : 'empty') + '">' + (l.summary ? escapeHtml(l.summary) : 'No summary recorded.') + '</p>' +
          '</div>' +
          notesHtml(l) +
          (l.phone
            ? '<a class="call-btn" href="' + telHref(l.phone) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>Call ' + escapeHtml(l.name) + '</a>'
            : '') +
        '</div></div>' +
      '</div>' +
    '</article>'
  );
}

function render() {
  if (state.view !== 'leads') return;
  if (state.loading) { els.countSummary.textContent = 'Loading…'; return; }
  flushNoteSaves();
  var visible = getVisibleLeads();
  els.leadsList.innerHTML = visible.map(leadRowHtml).join('');
  if (state.leads.length) toggleStates(visible.length ? 'ready' : 'filtered-empty');

  var total = state.leads.length;
  var qualifiedCount = state.leads.filter(function (l) { return l.qualified; }).length;
  if (visible.length === total) {
    els.countSummary.textContent = total + (total === 1 ? ' lead' : ' leads') + ' · ' + qualifiedCount + ' qualified';
  } else {
    els.countSummary.textContent = visible.length + ' of ' + total + ' shown';
  }
}

function updateLastUpdated() {
  if (!state.lastLoaded) return;
  var secs = Math.round((Date.now() - state.lastLoaded.getTime()) / 1000);
  var text;
  if (secs < 10) text = 'Updated just now';
  else if (secs < 60) text = 'Updated ' + secs + 's ago';
  else if (secs < 3600) text = 'Updated ' + Math.round(secs / 60) + 'm ago';
  else text = 'Updated ' + state.lastLoaded.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  els.lastUpdated.textContent = text;
}
setInterval(updateLastUpdated, 15000);

// ─── Businesses (Firestore) ───
var NAME_FIELDS = ['name', 'businessName', 'business_name', 'Business Name', 'company', 'companyName', 'title'];

function toBusiness(id, data) {
  var nameField = null;
  for (var i = 0; i < NAME_FIELDS.length; i++) {
    if (typeof data[NAME_FIELDS[i]] === 'string' && data[NAME_FIELDS[i]].trim()) { nameField = NAME_FIELDS[i]; break; }
  }
  var fields = Object.keys(data)
    .filter(function (k) { return k !== nameField; })
    .sort(function (a, b) { return a.localeCompare(b); })
    .map(function (k) { return { key: k, value: data[k] }; });
  var name = nameField ? data[nameField].trim() : id;
  var searchText = (name + ' ' + fields.map(function (f) { return formatPlain(f.value); }).join(' ')).toLowerCase();
  return { id: id, name: name, fields: fields, searchText: searchText };
}

function formatPlain(v) {
  if (v == null) return '';
  if (v.toDate) return v.toDate().toLocaleString();
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

function humanizeKey(k) {
  return k.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, function (c) { return c.toUpperCase(); });
}

function fieldValueHtml(key, v) {
  var text = formatPlain(v);
  if (!text) return '<span class="empty">—</span>';
  if (typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim())) {
    return '<a href="' + escapeHtml(v.trim()) + '" target="_blank" rel="noopener">' + escapeHtml(v.trim()) + '</a>';
  }
  if (typeof v === 'string' && /phone/i.test(key) && /\d/.test(v)) {
    return '<a href="' + escapeHtml(telHref(v)) + '">' + escapeHtml(v) + '</a>';
  }
  return escapeHtml(text);
}

function bizRowHtml(b) {
  var open = state.openBizIds.has(b.id);
  return (
    '<article class="lead" data-open="' + open + '">' +
      '<div class="lead-row">' +
        '<button class="lead-toggle" aria-expanded="' + open + '" data-biz="' + escapeHtml(b.id) + '">' +
          '<span class="lead-name">' + escapeHtml(b.name) + '</span>' +
          '<svg class="lead-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"><path d="m6 9 6 6 6-6"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="lead-detail" role="region">' +
        '<div class="lead-detail-inner"><div class="lead-detail-content">' +
          '<div class="biz-fields">' +
            b.fields.map(function (f) {
              return '<div class="detail-item"><span class="detail-label">' + escapeHtml(humanizeKey(f.key)) + '</span>' +
                '<span class="detail-value">' + fieldValueHtml(f.key, f.value) + '</span></div>';
            }).join('') +
          '</div>' +
        '</div></div>' +
      '</div>' +
    '</article>'
  );
}

function showBizState(mode) {
  els.bizSkeleton.style.display = mode === 'loading' ? 'flex' : 'none';
  els.bizList.hidden = mode !== 'ready';
  els.bizEmpty.hidden = mode !== 'empty';
  els.bizError.hidden = mode !== 'error';
}

function renderBusinesses() {
  if (state.view !== 'businesses') return;
  if (!state.bizLoaded) { showBizState('loading'); els.countSummary.textContent = 'Loading…'; return; }
  if (!els.bizError.hidden) return;
  var term = state.searchTerm.trim().toLowerCase();
  var list = state.businesses
    .filter(function (b) { return !term || b.searchText.indexOf(term) !== -1; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
  els.bizList.innerHTML = list.map(bizRowHtml).join('');
  showBizState(list.length ? 'ready' : 'empty');
  var total = state.businesses.length;
  els.countSummary.textContent = list.length === total
    ? total + (total === 1 ? ' business' : ' businesses')
    : list.length + ' of ' + total + ' shown';
}

els.bizList.addEventListener('click', function (e) {
  var toggle = e.target.closest('.lead-toggle');
  if (!toggle) return;
  var id = toggle.dataset.biz;
  if (state.openBizIds.has(id)) state.openBizIds.delete(id); else state.openBizIds.add(id);
  var expanded = state.openBizIds.has(id);
  toggle.setAttribute('aria-expanded', expanded);
  toggle.closest('.lead').setAttribute('data-open', expanded);
});

// ─── Events ───
var searchDebounce;
els.searchInput.addEventListener('input', function (e) {
  clearTimeout(searchDebounce);
  var v = e.target.value;
  searchDebounce = setTimeout(function () {
    state.searchTerm = v;
    if (state.view === 'leads') render(); else renderBusinesses();
  }, 120);
});

els.chips.forEach(function (chip) {
  chip.addEventListener('click', function () {
    els.chips.forEach(function (c) { c.classList.remove('active'); });
    chip.classList.add('active');
    state.filter = chip.dataset.filter;
    render();
  });
});

els.sortSelect.addEventListener('change', function (e) {
  state.sort = e.target.value;
  syncHeadSortIndicators();
  render();
});

els.headSortBtns.forEach(function (btn) {
  btn.addEventListener('click', function () {
    els.sortSelect.value = btn.dataset.sort;
    state.sort = btn.dataset.sort;
    syncHeadSortIndicators();
    render();
  });
});

function syncHeadSortIndicators() {
  els.headSortBtns.forEach(function (btn) {
    btn.setAttribute('aria-sort', btn.dataset.sort === state.sort ? 'ascending' : 'none');
  });
}

els.leadsList.addEventListener('click', function (e) {
  var toggle = e.target.closest('.lead-toggle');
  if (!toggle) return;
  var id = toggle.dataset.id;
  if (state.openIds.has(id)) state.openIds.delete(id);
  else state.openIds.add(id);
  var expanded = state.openIds.has(id);
  toggle.setAttribute('aria-expanded', expanded);
  toggle.closest('.lead').setAttribute('data-open', expanded);
});

els.refreshBtn.addEventListener('click', function () {
  els.refreshBtn.classList.add('spinning');
  loadLeads();
  setTimeout(function () { els.refreshBtn.classList.remove('spinning'); }, 700);
});
els.retryBtn.addEventListener('click', loadLeads);

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && state.profile && state.lastLoaded &&
      Date.now() - state.lastLoaded.getTime() > AUTO_REFRESH_STALE_MS &&
      !document.activeElement.classList.contains('note-text')) {
    loadLeads();
  }
});

// ─── Real PNG home-screen icon, generated client-side (single-file, no assets) ───
function makeIcon(size) {
  var c = document.createElement('canvas');
  c.width = c.height = size;
  var ctx = c.getContext('2d');
  var r = size * 0.22;
  ctx.fillStyle = '#0a0906';
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(size, 0, size, size, r);
  ctx.arcTo(size, size, 0, size, r);
  ctx.arcTo(0, size, 0, 0, r);
  ctx.arcTo(0, 0, size, 0, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#f6f2e9';
  ctx.font = '800 ' + Math.round(size * 0.52) + 'px Syne, Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('L', size / 2, size * 0.56);
  return c.toDataURL('image/png');
}

function applyIcons() {
  try {
    $('appleIcon').href = makeIcon(180);
    $('favicon').href = makeIcon(64);
  } catch (e) { /* canvas unsupported: fall back to inline SVG already set */ }
}
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(applyIcons).catch(applyIcons);
} else {
  applyIcons();
}

syncHeadSortIndicators();
