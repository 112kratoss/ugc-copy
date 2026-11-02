#!/usr/bin/env node
// Mints the client secret that Supabase's Apple provider needs for the website's
// Continue with Apple: an ES256 JWT signed with a Sign in with Apple key, issued
// by the team for the Services ID. Apple refuses one that lives longer than six
// months, so this one lives 180 days; every web Apple sign-in fails once it
// ends (the runbook's "Sign in with Apple on the web"). It signs with Node's own
// crypto, so it runs with no npm install, and the key never goes into a web page.
//
// Every month .github/workflows/apple-web-client-secret.yml mints one and
// installs it in Supabase through the Management API:
//
//   APPLE_SIGN_IN_PRIVATE_KEY=… SUPABASE_ACCESS_TOKEN=… node scripts/ops/apple-web-client-secret.mjs \
//     --install-supabase --key-id ABC123DEFG --team-id TEAMID1234 --client-id <services id>
//
// By hand, onto the clipboard with pbcopy, or into a new file with --out (mode 600):
//
//   node scripts/ops/apple-web-client-secret.mjs --p8 ~/AuthKey_ABC123DEFG.p8 \
//     --key-id ABC123DEFG --team-id TEAMID1234 --client-id <services id>
//
// The secret never goes to stdout or into a log, and the Management API's answer,
// which echoes the Auth config with its secrets, is never read. Nothing can check
// a secret before a real web sign-in: Apple's token endpoint answers a made-up code
// with invalid_grant and its revoke endpoint with 200 whoever signed the secret
// (tried 2026-11-02), so a refused one shows only then, in production logs as
// /auth/callback's auth_callback_provider_error.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import fs from 'node:fs';

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const LIFETIME_DAYS = 180;
// Apple's ceiling for a client secret's lifetime: six months, in seconds.
const APPLE_MAX_LIFETIME_SECONDS = 15_777_000;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'ildfmhozpibwiopeavfg';
// The iPhone app's bundle id (ugc-mobile/app.json): its native sign-in needs it in Client IDs.
const IOS_BUNDLE_ID = process.env.IOS_BUNDLE_ID || 'com.magicbooklet.mobile';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/** A key file as Apple gives it, or as one line with literal \n, the form env values keep it in. */
function normalizePrivateKey(text) {
  return text.replace(/\\n/g, '\n').trim();
}

function mintAppleClientSecret({ privateKeyPem, keyId, teamId, clientId, now = new Date() }) {
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const expiresAt = issuedAt + LIFETIME_DAYS * 24 * 60 * 60;
  assert.ok(expiresAt - issuedAt <= APPLE_MAX_LIFETIME_SECONDS, 'lifetime exceeds Apple’s six months');
  const key = createPrivateKey(normalizePrivateKey(privateKeyPem));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('The key is not a P-256 key, which every Sign in with Apple key is.');
  }
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: issuedAt, exp: expiresAt, aud: APPLE_AUDIENCE, sub: clientId }));
  // JWS wants the signature as r‖s (IEEE P1363), not DER.
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return { secret: `${header}.${claims}.${base64url(signature)}`, expiresAt: new Date(expiresAt * 1_000) };
}

function clientIdsOf(config) {
  return [config.external_apple_client_id, config.external_apple_additional_client_ids]
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

/** A provider the secret would not fit is left alone: off, another client first, or the app's bundle id gone. */
function assertAppleProviderFits(config, { clientId, bundleId }) {
  if (config.external_apple_enabled !== true) {
    throw new Error('The Supabase Apple provider is off. Nothing was installed.');
  }
  const listed = clientIdsOf(config);
  if (listed[0] !== clientId) {
    throw new Error(`The Supabase Apple provider's Client IDs start with ${listed[0] || 'nothing'}, not ${clientId}. Nothing was installed.`);
  }
  if (!listed.includes(bundleId)) {
    throw new Error(`The bundle id ${bundleId} is missing from the Apple provider's Client IDs, so the iPhone app's Sign in with Apple fails. Nothing was installed.`);
  }
}

async function installInSupabase({ secret, clientId, token, projectRef = PROJECT_REF, bundleId = IOS_BUNDLE_ID, fetcher = fetch }) {
  const url = `https://api.supabase.com/v1/projects/${projectRef}/config/auth`;
  const headers = { Authorization: `Bearer ${token}` };
  const current = await fetcher(url, { headers });
  if (!current.ok) {
    throw new Error(`Could not read the Supabase Auth config: HTTP ${current.status}. Nothing was installed.`);
  }
  assertAppleProviderFits(await current.json(), { clientId, bundleId });
  const patched = await fetcher(url, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ external_apple_secret: secret }),
  });
  // The answer echoes the whole Auth config, secrets included: only its status is read.
  if (!patched.ok) {
    throw new Error(`Supabase refused the new Apple client secret: HTTP ${patched.status}. The old one stays.`);
  }
}

function readArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
    if (name === '--self-test' || name === '--install-supabase') {
      values[name === '--self-test' ? 'selfTest' : 'installSupabase'] = true;
      continue;
    }
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
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body });
    const { status, json } = answers[calls.length - 1];
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return { fetcher, calls };
}

async function selfTest() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const now = new Date('2026-11-02T00:00:00Z');
  const minted = (privateKeyPem) => mintAppleClientSecret({
    privateKeyPem,
    keyId: 'KEY1234567',
    teamId: 'TEAM123456',
    clientId: 'com.example.app.web',
    now,
  });
  const { secret, expiresAt } = minted(pem);
  const [header, claims, signature] = secret.split('.');
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'ES256', kid: 'KEY1234567' });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), {
    iss: 'TEAM123456',
    iat: now.getTime() / 1_000,
    exp: now.getTime() / 1_000 + 180 * 24 * 60 * 60,
    aud: APPLE_AUDIENCE,
    sub: 'com.example.app.web',
  });
  assert.equal(expiresAt.toISOString(), '2027-05-01T00:00:00.000Z');
  // The env's one-line form of the same key signs too.
  const oneLine = String(pem).trim().split('\n').join('\\n');
  assert.equal(minted(oneLine).secret.split('.')[1], claims);
  assert.throws(() => minted('not a key'));
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => minted(rsa), /not a P-256 key/);

  const provider = {
    external_apple_enabled: true,
    external_apple_client_id: 'com.example.app.web,com.example.app',
  };
  const install = (fetcher) => installInSupabase({
    secret, clientId: 'com.example.app.web', token: 'pat', projectRef: 'ref', bundleId: 'com.example.app', fetcher,
  });
  const fits = scriptedFetch([{ status: 200, json: provider }, { status: 200, json: { external_apple_secret: secret } }]);
  await install(fits.fetcher);
  assert.deepEqual(fits.calls.map(({ url, method }) => [url, method]), [
    ['https://api.supabase.com/v1/projects/ref/config/auth', 'GET'],
    ['https://api.supabase.com/v1/projects/ref/config/auth', 'PATCH'],
  ]);
  assert.equal(fits.calls[1].headers.Authorization, 'Bearer pat');
  assert.deepEqual(JSON.parse(fits.calls[1].body), { external_apple_secret: secret });
  // A provider the secret does not fit is read and left alone.
  for (const [config, message] of [
    [{ ...provider, external_apple_enabled: false }, /is off/],
    [{ ...provider, external_apple_client_id: 'com.example.app,com.example.app.web' }, /start with com\.example\.app, not/],
    [{ ...provider, external_apple_client_id: 'com.example.app.web' }, /bundle id com\.example\.app is missing/],
  ]) {
    const refused = scriptedFetch([{ status: 200, json: config }]);
    await assert.rejects(() => install(refused.fetcher), message);
    assert.equal(refused.calls.length, 1);
  }
  const unreadable = scriptedFetch([{ status: 401, json: {} }]);
  await assert.rejects(() => install(unreadable.fetcher), /HTTP 401\. Nothing was installed/);
  const refusedPatch = scriptedFetch([{ status: 200, json: provider }, { status: 500, json: { external_apple_secret: secret } }]);
  await assert.rejects(() => install(refusedPatch.fetcher), (error) => /HTTP 500/.test(error.message) && !error.message.includes(secret));
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
  const clientId = args['client-id'];
  const { secret, expiresAt } = mintAppleClientSecret({
    privateKeyPem,
    keyId: args['key-id'],
    teamId: args['team-id'],
    clientId,
  });
  if (args.installSupabase) {
    const token = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_MANAGEMENT_API_TOKEN;
    if (!token) throw new Error('Set SUPABASE_ACCESS_TOKEN to install the secret in Supabase.');
    await installInSupabase({ secret, clientId, token });
    console.log(`Installed a new Apple client secret for ${clientId} in Supabase project ${PROJECT_REF}; it expires ${expiresAt.toISOString()}.`);
    return;
  }
  const where = deliverSecret(secret, args.out);
  console.error(`Client secret for ${clientId} minted; it is ${where}. It expires ${expiresAt.toISOString()}: mint the next one before then.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
