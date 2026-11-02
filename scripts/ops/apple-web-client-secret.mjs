#!/usr/bin/env node
// Mints the client secret that Supabase's Apple provider needs for the website's
// Continue with Apple: an ES256 JWT signed with a Sign in with Apple key, issued
// by the team for the Services ID. Apple refuses one that lives longer than six
// months, so this one lives 180 days; every web Apple sign-in fails once it
// ends, so mint the next one before then (the runbook's "Sign in with Apple on
// the web"). It is signed here, so the key file never goes into a web page.
//
//   node scripts/ops/apple-web-client-secret.mjs --p8 ~/AuthKey_ABC123DEFG.p8 \
//     --key-id ABC123DEFG --team-id TEAMID1234 --client-id <services id> | pbcopy
//
// The secret goes to stdout, and only into a pipe: on a terminal it refuses, so
// the value never lands on a screen or in a transcript. Its expiry goes to stderr.
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair, importPKCS8, SignJWT } from 'jose';

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const LIFETIME_DAYS = 180;
// Apple's ceiling for a client secret's lifetime: six months, in seconds.
const APPLE_MAX_LIFETIME_SECONDS = 15_777_000;

async function mintAppleClientSecret({ privateKeyPem, keyId, teamId, clientId, now = new Date() }) {
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const expiresAt = issuedAt + LIFETIME_DAYS * 24 * 60 * 60;
  assert.ok(expiresAt - issuedAt <= APPLE_MAX_LIFETIME_SECONDS, 'lifetime exceeds Apple’s six months');
  const signingKey = await importPKCS8(privateKeyPem, 'ES256');
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

async function selfTest() {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const now = new Date('2026-11-02T00:00:00Z');
  const { secret, expiresAt } = await mintAppleClientSecret({
    privateKeyPem: await exportPKCS8(privateKey),
    keyId: 'KEY1234567',
    teamId: 'TEAM123456',
    clientId: 'com.example.app.web',
    now,
  });
  assert.deepEqual(decodeProtectedHeader(secret), { alg: 'ES256', kid: 'KEY1234567' });
  const claims = decodeJwt(secret);
  assert.equal(claims.iss, 'TEAM123456');
  assert.equal(claims.sub, 'com.example.app.web');
  assert.equal(claims.aud, APPLE_AUDIENCE);
  assert.equal(claims.iat, now.getTime() / 1_000);
  assert.equal(claims.exp, now.getTime() / 1_000 + 180 * 24 * 60 * 60);
  assert.equal(expiresAt.toISOString(), '2027-05-01T00:00:00.000Z');
  await assert.rejects(() => mintAppleClientSecret({
    privateKeyPem: 'not a key', keyId: 'K', teamId: 'T', clientId: 'C', now,
  }));
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
  if (process.stdout.isTTY) {
    throw new Error('Refusing to print the secret on a terminal: pipe it, for example into pbcopy.');
  }
  const { secret, expiresAt } = await mintAppleClientSecret({
    privateKeyPem: fs.readFileSync(args.p8, 'utf8'),
    keyId: args['key-id'],
    teamId: args['team-id'],
    clientId: args['client-id'],
  });
  process.stdout.write(secret);
  console.error(`Apple client secret for ${args['client-id']} minted; it expires ${expiresAt.toISOString()}. Mint the next one before then.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
