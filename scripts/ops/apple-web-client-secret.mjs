#!/usr/bin/env node
// Mints the client secret that Supabase's Apple provider needs for the website's
// Continue with Apple: an ES256 JWT signed with a Sign in with Apple key, issued
// by the team for the Services ID. Apple refuses one that lives longer than six
// months, so this one lives 180 days; every web Apple sign-in fails once it
// ends, so mint the next one before then (the runbook's "Sign in with Apple on
// the web"). It is signed here, so the key file never goes into a web page.
//
//   node scripts/ops/apple-web-client-secret.mjs --p8 ~/AuthKey_ABC123DEFG.p8 \
//     --key-id ABC123DEFG --team-id TEAMID1234 --client-id <services id>
//
// The secret is put on the clipboard with pbcopy, or written with --out <new
// file> (mode 600). It never goes to stdout, so it cannot land on a screen, in a
// log or in a transcript. Its expiry goes to stderr. Nothing can check it before a
// real web sign-in: Apple's token endpoint answers a made-up code with invalid_grant
// and its revoke endpoint with 200 whoever signed the secret (tried 2026-11-02), so
// the live check after the deploy is the check, and a refused secret shows in the
// logs as /auth/callback's auth_callback_provider_error.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair, importPKCS8, SignJWT } from 'jose';

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const LIFETIME_DAYS = 180;
// Apple's ceiling for a client secret's lifetime: six months, in seconds.
const APPLE_MAX_LIFETIME_SECONDS = 15_777_000;

/** A key file as Apple gives it, or as one line with literal \n, the form the env keeps it in. */
function normalizePrivateKey(text) {
  return text.replace(/\\n/g, '\n').trim();
}

async function mintAppleClientSecret({ privateKeyPem, keyId, teamId, clientId, now = new Date() }) {
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const expiresAt = issuedAt + LIFETIME_DAYS * 24 * 60 * 60;
  assert.ok(expiresAt - issuedAt <= APPLE_MAX_LIFETIME_SECONDS, 'lifetime exceeds Apple’s six months');
  const signingKey = await importPKCS8(normalizePrivateKey(privateKeyPem), 'ES256');
  const secret = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId)
    .setSubject(clientId)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(signingKey);
  return { secret, expiresAt: new Date(expiresAt * 1_000) };
}

function readArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
    if (name === '--self-test') {
      values.selfTest = true;
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

async function selfTest() {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const pem = await exportPKCS8(privateKey);
  const now = new Date('2026-11-02T00:00:00Z');
  const minted = (privateKeyPem) => mintAppleClientSecret({
    privateKeyPem,
    keyId: 'KEY1234567',
    teamId: 'TEAM123456',
    clientId: 'com.example.app.web',
    now,
  });
  const { secret, expiresAt } = await minted(pem);
  assert.deepEqual(decodeProtectedHeader(secret), { alg: 'ES256', kid: 'KEY1234567' });
  const claims = decodeJwt(secret);
  assert.equal(claims.iss, 'TEAM123456');
  assert.equal(claims.sub, 'com.example.app.web');
  assert.equal(claims.aud, APPLE_AUDIENCE);
  assert.equal(claims.iat, now.getTime() / 1_000);
  assert.equal(claims.exp, now.getTime() / 1_000 + 180 * 24 * 60 * 60);
  assert.equal(expiresAt.toISOString(), '2027-05-01T00:00:00.000Z');
  // The env's one-line form of the same key signs too.
  const oneLine = pem.trim().split('\n').join('\\n');
  assert.equal(decodeJwt((await minted(oneLine)).secret).sub, 'com.example.app.web');
  await assert.rejects(() => minted('not a key'));
  console.log('apple-web-client-secret self-test passed');
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.selfTest) {
    await selfTest();
    return;
  }
  for (const name of ['p8', 'key-id', 'team-id', 'client-id']) {
    if (!args[name]) throw new Error(`Missing --${name}. See the comment at the top of this script.`);
  }
  const clientId = args['client-id'];
  const { secret, expiresAt } = await mintAppleClientSecret({
    privateKeyPem: fs.readFileSync(args.p8, 'utf8'),
    keyId: args['key-id'],
    teamId: args['team-id'],
    clientId,
  });
  const where = deliverSecret(secret, args.out);
  console.error(`Client secret for ${clientId} minted; it is ${where}. It expires ${expiresAt.toISOString()}: mint the next one before then.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
