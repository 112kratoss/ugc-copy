#!/usr/bin/env node
// Mints the client secret that Supabase's Apple provider needs for the website's
// Continue with Apple: an ES256 JWT signed with a Sign in with Apple key, issued
// by the team for the Services ID. Apple refuses one that lives longer than six
// months, so this one lives 180 days (the runbook's "Sign in with Apple on the
// web"). It signs with Node's own crypto, so no third-party code runs beside the
// key, and the key never goes into a web page.
//
// .github/workflows/apple-web-client-secret.yml applies a new one to Supabase every month:
//
//   APPLE_SIGN_IN_PRIVATE_KEY=… SUPABASE_MANAGEMENT_API_TOKEN=… node scripts/ops/apple-web-client-secret.mjs \
//     --apply-supabase --key-id ABC123DEFG --key-sha256 <public key SHA-256> --team-id TEAMID1234 --client-id <services id>
//
// By hand, onto the clipboard with pbcopy, or into a new file with --out (mode 600):
//
//   node scripts/ops/apple-web-client-secret.mjs --p8 ~/AuthKey_ABC123DEFG.p8 \
//     --key-id ABC123DEFG --team-id TEAMID1234 --client-id <services id>
//
// The secret never goes to stdout or into a log. Every run prints the key's
// public SHA-256, the pin the workflow holds the key to.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import fs from 'node:fs';

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const LIFETIME_DAYS = 180;
// Apple's ceiling for a client secret's lifetime: six months, in seconds.
const APPLE_MAX_LIFETIME_SECONDS = 15_777_000;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'ildfmhozpibwiopeavfg';
const REQUEST_TIMEOUT_MS = 30_000;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/** A key file as Apple gives it, or as one line with literal \n, the form env values keep it in. */
function normalizePrivateKey(text) {
  return text.replace(/\\n/g, '\n').trim();
}

/** The key, P-256 as every Sign in with Apple key is, with its public half and that half's SHA-256. */
function loadKey(privateKeyPem) {
  const key = createPrivateKey(normalizePrivateKey(privateKeyPem));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('The key is not a P-256 key, which every Sign in with Apple key is.');
  }
  const publicKey = createPublicKey(key);
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return { key, publicKey, fingerprint };
}

function mintAppleClientSecret({ key, keyId, teamId, clientId, now = new Date() }) {
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const expiresAt = issuedAt + LIFETIME_DAYS * 24 * 60 * 60;
  assert.ok(expiresAt - issuedAt <= APPLE_MAX_LIFETIME_SECONDS, 'lifetime exceeds Apple’s six months');
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: issuedAt, exp: expiresAt, aud: APPLE_AUDIENCE, sub: clientId }));
  // JWS wants the signature as r‖s (IEEE P1363), not DER.
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return { secret: `${header}.${claims}.${base64url(signature)}`, expiresAt: new Date(expiresAt * 1_000) };
}

/** The parts of a JWT-shaped value, or null for anything else, such as a field Supabase masks. */
function readJwt(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString()),
      claims: JSON.parse(Buffer.from(parts[1], 'base64url').toString()),
      signedPart: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], 'base64url'),
    };
  } catch {
    return null;
  }
}

/**
 * The secret in Supabase, when Supabase shows it, must have been signed by this key for
 * this key id, team and Services ID: else the key in hand is not the one that has been
 * working (a wrong file put in as the key, or a rotation, which installs once with
 * --rotate). Says whether the live secret could be read.
 */
function assertContinuesLiveSecret(liveSecret, { publicKey, keyId, teamId, clientId }) {
  const live = readJwt(liveSecret);
  if (!live) return false;
  let sameKey = false;
  try {
    sameKey = verify('sha256', Buffer.from(live.signedPart), { key: publicKey, dsaEncoding: 'ieee-p1363' }, live.signature);
  } catch {
    sameKey = false;
  }
  if (!sameKey || live.header.kid !== keyId || live.claims.iss !== teamId || live.claims.sub !== clientId) {
    throw new Error('The secret in Supabase was not signed by this key for this key id, team and Services ID. Nothing was installed. After a key rotation, apply once with --rotate (the runbook says how).');
  }
  return true;
}

/** A provider this secret does not fit is left alone: off, or another client first in Client IDs. */
function assertAppleProviderFits(config, { clientId }) {
  if (config.external_apple_enabled !== true) {
    throw new Error('The Supabase Apple provider is off. Nothing was installed.');
  }
  const first = String(config.external_apple_client_id || '').split(',')[0].trim();
  if (first !== clientId) {
    throw new Error(`The Supabase Apple provider's Client IDs start with ${first || 'nothing'}, not ${clientId}. Nothing was installed.`);
  }
}

async function applyToSupabase({
  secret,
  publicKey,
  keyId,
  teamId,
  clientId,
  token,
  rotate = false,
  projectRef = PROJECT_REF,
  fetcher = fetch,
  /** Told the moment Supabase accepts the update, before the read-back. */
  onApplied,
}) {
  const url = `https://api.supabase.com/v1/projects/${projectRef}/config/auth`;
  const headers = { Authorization: `Bearer ${token}` };
  /** A request, its failure named by which call it was and what it left behind. */
  const request = async (what, consequence, init = {}) => {
    let response;
    try {
      response = await fetcher(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new Error(`${what} failed (${error instanceof Error ? error.message : 'no answer'}). ${consequence}`);
    }
    if (!response.ok) throw new Error(`${what} failed: HTTP ${response.status}. ${consequence}`);
    return response;
  };
  const before = await (await request('Reading the Supabase Auth config', 'Nothing was installed.')).json();
  assertAppleProviderFits(before, { clientId });
  const liveSecretRead = rotate
    ? false
    : assertContinuesLiveSecret(before.external_apple_secret, { publicKey, keyId, teamId, clientId });
  // The answer echoes the whole Auth config, secrets included: only its status is read.
  await request('The update of the Apple client secret', 'The new secret may or may not be in place.', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ external_apple_secret: secret }),
  });
  onApplied?.();
  // Read back: a 2xx alone does not prove the field changed. A masked field cannot be compared.
  const after = await (await request('Reading the config back', 'Supabase accepted the new secret; whether it holds it is unknown.')).json();
  const stored = readJwt(after.external_apple_secret);
  if (stored && after.external_apple_secret !== secret) {
    throw new Error('Supabase answered the update but does not hold the new secret.');
  }
  return { liveSecretRead, storedSecretRead: Boolean(stored) };
}

// A mistyped option would drop its check without a word (say --key-sha for --key-sha256), so only these pass.
const FLAGS = { '--self-test': 'selfTest', '--apply-supabase': 'applySupabase', '--rotate': 'rotate' };
const OPTIONS = new Set(['--p8', '--key-id', '--key-sha256', '--team-id', '--client-id', '--out']);

function readArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (FLAGS[name]) {
      values[FLAGS[name]] = true;
      continue;
    }
    if (!OPTIONS.has(name)) throw new Error(`Unknown argument: ${name}. See the comment at the top of this script.`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value.`);
    values[name.slice(2)] = value;
    index += 1;
  }
  return values;
}

function deliverSecret(secret, outPath) {
  if (outPath) {
    // `wx`: a new file only, never over an existing one.
    fs.writeFileSync(outPath, secret, { mode: 0o600, flag: 'wx' });
    return `written to ${outPath}`;
  }
  const copied = spawnSync('pbcopy', { input: secret });
  if (copied.error || copied.status !== 0) {
    throw new Error('Could not put the secret on the clipboard (pbcopy); pass --out <new file> instead.');
  }
  return 'on the clipboard';
}

/** A fetch that answers from a script of responses and keeps what it was asked. */
function scriptedFetch(answers) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body, signal: init.signal });
    const { status, json } = answers[calls.length - 1];
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return { fetcher, calls };
}

async function selfTest() {
  const pemOf = (keyPair) => keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pem = pemOf(generateKeyPairSync('ec', { namedCurve: 'P-256' }));
  const now = new Date('2026-11-02T00:00:00Z');
  const loaded = loadKey(pem);
  const mint = (key, overrides = {}) => mintAppleClientSecret({
    key, keyId: 'KEY1234567', teamId: 'TEAM123456', clientId: 'com.example.app.web', now, ...overrides,
  });
  const { secret, expiresAt } = mint(loaded.key);
  const [header, claims, signature] = secret.split('.');
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: loaded.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'ES256', kid: 'KEY1234567' });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), {
    iss: 'TEAM123456',
    iat: now.getTime() / 1_000,
    exp: now.getTime() / 1_000 + 180 * 24 * 60 * 60,
    aud: APPLE_AUDIENCE,
    sub: 'com.example.app.web',
  });
  assert.equal(expiresAt.toISOString(), '2027-05-01T00:00:00.000Z');
  // The env's one-line form of the same key is the same key.
  assert.equal(loadKey(String(pem).trim().split('\n').join('\\n')).fingerprint, loaded.fingerprint);
  assert.match(loaded.fingerprint, /^[0-9a-f]{64}$/);
  assert.throws(() => loadKey('not a key'));
  assert.throws(() => loadKey(pemOf(generateKeyPairSync('ed25519'))), /not a P-256 key/);
  assert.throws(() => loadKey(pemOf(generateKeyPairSync('ec', { namedCurve: 'P-384' }))), /not a P-256 key/);

  const other = loadKey(pemOf(generateKeyPairSync('ec', { namedCurve: 'P-256' })));
  const provider = { external_apple_enabled: true, external_apple_client_id: 'com.example.app.web,com.example.app' };
  const live = mint(loaded.key, { now: new Date('2026-10-01T00:00:00Z') }).secret;
  const apply = (fetcher, options = {}) => applyToSupabase({
    secret, publicKey: loaded.publicKey, keyId: 'KEY1234567', teamId: 'TEAM123456', clientId: 'com.example.app.web',
    token: 'pat', projectRef: 'ref', fetcher, ...options,
  });
  const configUrl = 'https://api.supabase.com/v1/projects/ref/config/auth';

  // The renewal of a secret this key signed: read, update, read back.
  const renews = scriptedFetch([
    { status: 200, json: { ...provider, external_apple_secret: live } },
    { status: 200, json: {} },
    { status: 200, json: { ...provider, external_apple_secret: secret } },
  ]);
  assert.deepEqual(await apply(renews.fetcher), { liveSecretRead: true, storedSecretRead: true });
  assert.deepEqual(renews.calls.map(({ url, method }) => [url, method]), [[configUrl, 'GET'], [configUrl, 'PATCH'], [configUrl, 'GET']]);
  assert.equal(renews.calls[1].headers.Authorization, 'Bearer pat');
  assert.deepEqual(JSON.parse(renews.calls[1].body), { external_apple_secret: secret });
  assert.ok(renews.calls.every((call) => call.signal instanceof AbortSignal));

  // A masked field is no proof either way: the pin holds the key, nothing is compared.
  const masked = scriptedFetch([
    { status: 200, json: { ...provider, external_apple_secret: '********' } },
    { status: 200, json: {} },
    { status: 200, json: { ...provider, external_apple_secret: '********' } },
  ]);
  assert.deepEqual(await apply(masked.fetcher), { liveSecretRead: false, storedSecretRead: false });

  // Left alone, after one read: a provider the secret does not fit, and a live secret from another key or key id.
  for (const [config, message] of [
    [{ ...provider, external_apple_enabled: false }, /is off/],
    [{ ...provider, external_apple_client_id: 'com.example.app,com.example.app.web' }, /start with com\.example\.app, not/],
    [{ ...provider, external_apple_secret: mint(other.key).secret }, /not signed by this key/],
    [{ ...provider, external_apple_secret: mint(loaded.key, { keyId: 'OLDKEY0000' }).secret }, /not signed by this key/],
    [{ ...provider, external_apple_secret: mint(loaded.key, { teamId: 'TEAM999999' }).secret }, /not signed by this key/],
  ]) {
    const refused = scriptedFetch([{ status: 200, json: config }]);
    await assert.rejects(() => apply(refused.fetcher), message);
    assert.equal(refused.calls.length, 1);
  }
  // A rotation installs over a secret from the old key, once, on purpose.
  const rotation = scriptedFetch([
    { status: 200, json: { ...provider, external_apple_secret: mint(other.key).secret } },
    { status: 200, json: {} },
    { status: 200, json: { ...provider, external_apple_secret: secret } },
  ]);
  assert.deepEqual(await apply(rotation.fetcher, { rotate: true }), { liveSecretRead: false, storedSecretRead: true });

  const unreadable = scriptedFetch([{ status: 401, json: {} }]);
  await assert.rejects(() => apply(unreadable.fetcher), /HTTP 401\. Nothing was installed/);
  const offline = async () => {
    throw new Error('fetch failed');
  };
  await assert.rejects(() => apply(offline), /Reading the Supabase Auth config failed \(fetch failed\)\. Nothing was installed/);
  // Supabase took the update, then the read-back was lost: the notice has already said so once.
  let notices = 0;
  const lostReadBack = scriptedFetch([
    { status: 200, json: { ...provider, external_apple_secret: live } },
    { status: 200, json: {} },
    { status: 503, json: {} },
  ]);
  await assert.rejects(
    () => apply(lostReadBack.fetcher, { onApplied: () => { notices += 1; } }),
    /Reading the config back failed: HTTP 503\. Supabase accepted the new secret/,
  );
  assert.equal(notices, 1);
  const refusedPatch = scriptedFetch([{ status: 200, json: { ...provider, external_apple_secret: live } }, { status: 500, json: { external_apple_secret: secret } }]);
  await assert.rejects(
    () => apply(refusedPatch.fetcher, { onApplied: () => { notices += 1; } }),
    (error) => /HTTP 500/.test(error.message) && !error.message.includes(secret),
  );
  assert.equal(notices, 1);
  const notKept = scriptedFetch([
    { status: 200, json: { ...provider, external_apple_secret: live } },
    { status: 200, json: {} },
    { status: 200, json: { ...provider, external_apple_secret: live } },
  ]);
  await assert.rejects(() => apply(notKept.fetcher), /does not hold the new secret/);
  console.log('apple-web-client-secret self-test passed');
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.selfTest) {
    await selfTest();
    return;
  }
  for (const name of ['key-id', 'team-id', 'client-id']) {
    if (!args[name]) throw new Error(`Missing --${name}. See the comment at the top of this script.`);
  }
  const privateKeyPem = args.p8 ? fs.readFileSync(args.p8, 'utf8') : process.env.APPLE_SIGN_IN_PRIVATE_KEY;
  if (!privateKeyPem?.trim()) {
    throw new Error('Pass --p8 <key file>, or set APPLE_SIGN_IN_PRIVATE_KEY.');
  }
  const { key, publicKey, fingerprint } = loadKey(privateKeyPem);
  // Writing to production is held to the key's pin: APNs and App Store Connect keys are P-256 too.
  if (args.applySupabase && !args['key-sha256']) {
    throw new Error(`--apply-supabase needs --key-sha256 (this key's is ${fingerprint}). Nothing was minted.`);
  }
  if (args['key-sha256'] && args['key-sha256'].toLowerCase() !== fingerprint) {
    throw new Error(`The key's public SHA-256 is ${fingerprint}, not the pinned ${args['key-sha256']}: this is not the key for ${args['key-id']}. Nothing was minted.`);
  }
  const clientId = args['client-id'];
  const { secret, expiresAt } = mintAppleClientSecret({ key, keyId: args['key-id'], teamId: args['team-id'], clientId });
  if (args.applySupabase) {
    const token = process.env.SUPABASE_MANAGEMENT_API_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
    if (!token) throw new Error('Set SUPABASE_MANAGEMENT_API_TOKEN to apply the secret to Supabase.');
    const { liveSecretRead } = await applyToSupabase({
      secret, publicKey, keyId: args['key-id'], teamId: args['team-id'], clientId, token, rotate: args.rotate === true,
      // Printed at once, so the run's summary records it even if the read-back then fails.
      onApplied: () => console.log(`Supabase accepted a new Apple client secret for ${clientId}, expiring ${expiresAt.toISOString()}.`),
    });
    const continuity = args.rotate ? 'installed over the old key’s secret (--rotate)' : liveSecretRead ? 'the live one was this key’s' : 'Supabase masks the live one';
    console.log(`Applied a new Apple client secret for ${clientId} to Supabase project ${PROJECT_REF}, expiring ${expiresAt.toISOString()}; ${continuity}. Key SHA-256 ${fingerprint}.`);
    return;
  }
  const where = deliverSecret(secret, args.out);
  console.error(`Client secret for ${clientId} minted, ${where}, expiring ${expiresAt.toISOString()}. Key SHA-256 ${fingerprint}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
