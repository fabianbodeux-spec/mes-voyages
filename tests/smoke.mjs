#!/usr/bin/env node
/**
 * CrewiGO — Smoke Tests automatisés
 * Tests les endpoints critiques contre le serveur local ou prod.
 *
 * Usage :  node tests/smoke.js [--base http://localhost:3000]
 * Prérequis : le serveur doit être démarré avant de lancer ce script.
 *
 * Node ≥ 18 requis (fetch natif).
 */

'use strict';

const BASE = (() => {
  const idx = process.argv.indexOf('--base');
  return idx !== -1 ? process.argv[idx + 1] : 'http://localhost:3000';
})();

let passed = 0;
let failed = 0;
let skipped = 0;
const errors = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function test(label, fn) {
  try {
    await fn();
    console.log(`  ✅  ${label}`);
    passed++;
  } catch (err) {
    if (err.__skip) {
      console.log(`  ⏭️   ${label} (ignoré : ${err.message})`);
      skipped++;
    } else {
      console.error(`  ❌  ${label}`);
      console.error(`       ${err.message}`);
      errors.push({ label, message: err.message });
      failed++;
    }
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion échouée');
}

function skip(msg) {
  const e = new Error(msg);
  e.__skip = true;
  throw e;
}

async function get(path, opts = {}) {
  return fetch(`${BASE}${path}`, opts);
}

async function post(path, body, opts = {}) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(body),
    ...opts,
  });
}

// ─── Détecter le mode (local vs cloud) ───────────────────────────────────────
// En mode local, authMiddleware authentifie toujours (premier user de users.json).
// Les tests d'auth sont donc inapplicables en mode local.

const meRes = await get('/api/auth/me');
const IS_LOCAL_MODE = meRes.status === 200;
console.log(`\nCrewiGO Smoke Tests — ${BASE}`);
console.log(`Mode : ${IS_LOCAL_MODE ? 'LOCAL (auth bypass actif)' : 'CLOUD (JWT requis)'}\n`);

// ── 1. Pages HTML fondamentales ───────────────────────────────────────────────
console.log('📄 Pages HTML');

await test('GET / → 200 HTML (landing)', async () => {
  const res = await get('/');
  assert(res.status === 200, `Status ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  assert(ct.includes('text/html'), `Content-Type: ${ct}`);
});

await test('GET /app → 200 HTML', async () => {
  const res = await get('/app');
  assert(res.status === 200, `Status ${res.status}`);
  const body = await res.text();
  assert(body.includes('<html'), 'Pas de balise <html>');
});

await test('GET /app → CSP header présent et script-src sans unsafe-inline', async () => {
  const res = await get('/app');
  const csp = res.headers.get('content-security-policy') || '';
  assert(csp.length > 0, 'CSP header absent');
  const scriptSrcMatch = csp.match(/script-src\s+([^;]+)/i);
  if (scriptSrcMatch) {
    assert(
      !scriptSrcMatch[1].includes("'unsafe-inline'"),
      "script-src contient encore 'unsafe-inline' — nonce CSP non appliqué"
    );
  }
});

await test('GET /app → nonce CSP cohérent entre header et HTML', async () => {
  const res = await get('/app');
  const body = await res.text();
  const csp  = res.headers.get('content-security-policy') || '';
  const nonceMatch = csp.match(/'nonce-([A-Za-z0-9+/=]+)'/);
  assert(nonceMatch, 'Nonce absent du header CSP');
  assert(body.includes(`nonce="${nonceMatch[1]}"`), `Nonce "${nonceMatch[1]}" absent du HTML inline <script>`);
});

await test('GET /offline.html → 200', async () => {
  const res = await get('/offline.html');
  assert(res.status === 200, `Status ${res.status}`);
});

await test('GET /sw.js → 200 JS avec Cache-Control: no-store', async () => {
  const res = await get('/sw.js');
  assert(res.status === 200, `Status ${res.status}`);
  const cc = res.headers.get('cache-control') || '';
  assert(cc.includes('no-store'), `Cache-Control: ${cc}`);
});

await test('GET /manifest.json → 200 JSON valide', async () => {
  const res = await get('/manifest.json');
  assert(res.status === 200, `Status ${res.status}`);
  const data = await res.json();
  assert(data.name && data.start_url, 'manifest.json invalide (name ou start_url manquant)');
});

// ── 2. API Auth ───────────────────────────────────────────────────────────────
console.log('\n🔐 Auth API');

await test('GET /api/auth/me sans token → 401 (cloud) ou 200 (local)', async () => {
  const res = await get('/api/auth/me');
  if (IS_LOCAL_MODE) {
    assert(res.status === 200, `Status ${res.status}`);
  } else {
    assert(res.status === 401, `Status attendu 401, reçu ${res.status}`);
  }
});

await test('POST /api/auth/login sans body → 400 ou 401', async () => {
  const res = await post('/api/auth/login', {});
  assert([400, 401, 422].includes(res.status), `Status inattendu: ${res.status}`);
  const data = await res.json();
  assert(data.error || data.message || data.errors, 'Pas de message d\'erreur');
});

await test('POST /api/auth/login avec mauvais mot de passe → 401', async () => {
  const res = await post('/api/auth/login', { email: 'nope@example.com', password: 'wrongpassword_xyz' });
  assert(res.status === 401, `Status attendu 401, reçu ${res.status}`);
});

// ── 3. API Voyages ────────────────────────────────────────────────────────────
console.log('\n🗺️  API Voyages');

await test('GET /api/voyages → 200 (local) ou 401 (cloud)', async () => {
  const res = await get('/api/voyages');
  if (IS_LOCAL_MODE) {
    assert(res.status === 200, `Status ${res.status} — local mode should allow access`);
    const data = await res.json();
    assert(Array.isArray(data), 'Devrait retourner un tableau');
  } else {
    assert(res.status === 401, `Status ${res.status}`);
  }
});

await test('POST /api/voyages sans body valide → 400 ou 401', async () => {
  const res = await post('/api/voyages', {});
  if (IS_LOCAL_MODE) {
    assert([400, 422].includes(res.status), `Status ${res.status} — champ nom obligatoire`);
  } else {
    assert(res.status === 401, `Status ${res.status}`);
  }
});

// ── 4. Pages partage (public) ─────────────────────────────────────────────────
console.log('\n👥 Pages Partage');

await test('GET /share/token-invalide → HTML 200 (SPA)', async () => {
  const res = await get('/share/invalidtokentest');
  assert([200, 404].includes(res.status), `Status inattendu: ${res.status}`);
  if (res.status === 200) {
    const ct = res.headers.get('content-type') || '';
    assert(ct.includes('text/html'), `Content-Type: ${ct}`);
  }
});

await test('GET /api/partage/token-invalide → 404 JSON', async () => {
  const res = await get('/api/partage/invalidtokenxxxxxxxxx');
  assert([404, 400].includes(res.status), `Status inattendu: ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  assert(ct.includes('application/json'), `Content-Type attendu JSON, reçu: ${ct}`);
});

await test('POST /api/voyages/:id/join-as-participant sans body → 400', async () => {
  const res = await post('/api/voyages/999999/join-as-participant', {});
  assert([400, 404].includes(res.status), `Status inattendu: ${res.status}`);
});

// ── 5. API Push (public/protégé) ──────────────────────────────────────────────
console.log('\n📱 Push API');

await test('GET /api/push/vapid-key → 200 JSON (clé publique ou désactivé)', async () => {
  const res = await get('/api/push/vapid-key');
  assert(res.status === 200, `Status ${res.status}`);
  const data = await res.json();
  // Soit une vraie clé, soit un flag désactivé
  assert(data.publicKey !== undefined || data.enabled === false || data.disabled, 'Réponse inattendue');
});

await test('POST /api/push/subscribe/:voyageId sans auth → 401 (cloud) ou 400/200 (local)', async () => {
  const res = await post('/api/push/subscribe/999', {
    endpoint: 'https://example.com/push',
    keys: { p256dh: 'test', auth: 'test' }
  });
  if (IS_LOCAL_MODE) {
    assert([400, 200, 404].includes(res.status), `Status inattendu: ${res.status}`);
  } else {
    assert(res.status === 401, `Status ${res.status}`);
  }
});

// ── 6. Nouvelles fonctionnalités ─────────────────────────────────────────────
console.log('\n🆕 Nouvelles fonctionnalités');

await test('GET /api/stats/public → 200 JSON avec voyages', async () => {
  const res = await get('/api/stats/public');
  assert(res.status === 200, `Status ${res.status}`);
  const data = await res.json();
  assert(typeof data.voyages === 'number', `Champ voyages manquant ou non numérique: ${JSON.stringify(data)}`);
  assert(typeof data.participants === 'number', `Champ participants manquant: ${JSON.stringify(data)}`);
});

await test('GET /api/qr sans auth → 401 (cloud) ou 400 (local)', async () => {
  const res = await get('/api/qr?url=/partage/test123456');
  if (IS_LOCAL_MODE) {
    // En mode local, authMiddleware laisse passer → 400 car URL invalide (pas de token valide)
    assert([400, 200].includes(res.status), `Status inattendu: ${res.status}`);
  } else {
    assert(res.status === 401, `Status attendu 401, reçu ${res.status}`);
  }
});

await test('GET /api/qr avec URL non autorisée → 400', async () => {
  const res = await get('/api/qr?url=https://evil.com/malicious');
  // Soit 401 (non auth), soit 400 (URL refusée)
  assert([400, 401].includes(res.status), `Status inattendu: ${res.status}`);
});

await test('GET /offline.html → HTML avec "Vous êtes hors ligne"', async () => {
  const res = await get('/offline.html');
  assert(res.status === 200, `Status ${res.status}`);
  const body = await res.text();
  assert(body.includes('hors ligne') || body.includes('offline'), 'Texte "hors ligne" absent');
  assert(body.includes('CrewiGO') || body.includes('Crewi'), 'Logo CrewiGO absent');
});

// ── 7. Sécurité ───────────────────────────────────────────────────────────────
console.log('\n🔒 Sécurité');

await test('Headers sécurité présents (X-Frame-Options ou frame-ancestors)', async () => {
  const res = await get('/');
  const xfo = res.headers.get('x-frame-options');
  const csp = res.headers.get('content-security-policy') || '';
  assert(xfo || csp.includes('frame-src') || csp.includes('frame-ancestors'),
    'Ni X-Frame-Options ni frame-src dans la CSP');
});

await test('X-Content-Type-Options: nosniff', async () => {
  const res = await get('/');
  const xcto = res.headers.get('x-content-type-options');
  assert(xcto === 'nosniff', `X-Content-Type-Options: ${xcto}`);
});

await test('Path traversal bloqué', async () => {
  const res = await get('/%2F..%2Fpackage.json');
  assert([400, 404, 403].includes(res.status), `Status inattendu: ${res.status}`);
});

await test('Route inconnue → 404', async () => {
  const res = await get('/this-route-does-not-exist-xyz');
  assert(res.status === 404, `Status attendu 404, reçu ${res.status}`);
});

// ─── Résumé ──────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(52));
const total = passed + failed + skipped;
console.log(`  Résultat : ${passed} ✅  /  ${failed} ❌  /  ${skipped} ⏭️   /  ${total} tests`);
if (errors.length > 0) {
  console.log('\nÉchecs :');
  errors.forEach(e => console.log(`  • ${e.label}\n    ${e.message}`));
}
console.log('');

process.exit(failed > 0 ? 1 : 0);
