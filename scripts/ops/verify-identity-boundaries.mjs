#!/usr/bin/env node
// Explicitly creates two disposable identities. Never changes an existing user,
// starts paid work, or sends signup mail. Cleanup targets only IDs created here.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';

const { values } = parseArgs({ options: {
  confirm: { type: 'boolean', default: false },
  'project-ref': { type: 'string' },
  'base-url': { type: 'string' },
} });
assert(values.confirm, 'Use --confirm to create and remove disposable test accounts.');
const project = values['project-ref'];
assert(project && /^[a-z0-9]+$/.test(project), 'An explicit --project-ref is required.');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
assert(url && new URL(url).hostname === `${project}.supabase.co`, 'Supabase URL must match --project-ref.');
const base = new URL(values['base-url']);
assert(base.protocol === 'https:', '--base-url must be HTTPS.');
const clientKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(clientKey && serviceKey, 'Client and service credentials are required.');
const authOptions = { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false };
const admin = createClient(url, serviceKey, { auth: authOptions });
const authClient = () => createClient(url, clientKey, { auth: authOptions });
const scoped = (token) => createClient(url, clientKey, {
  auth: authOptions, global: { headers: { Authorization: `Bearer ${token}` } },
});
const nonce = randomBytes(8).toString('hex');
const recoveryDir = mkdtempSync(path.join(tmpdir(), 'magicbooklet-identity-check-'));
const created = [];
let checks = 0;
function remember(user, kind) {
  assert(user?.id, `Missing ${kind} fixture ID`);
  created.push({ id: user.id, kind });
  writeFileSync(path.join(recoveryDir, 'created-users.json'), JSON.stringify({ project, created }), { mode: 0o600 });
}
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
  console.log(`PASS ${label}`);
}
function requireSuccess(result, label) {
  assert(!result.error, `${label} failed (${result.error?.code ?? result.error?.status ?? 'upstream error'})`);
  return result.data;
}
async function profileRows(token, id) {
  return requireSuccess(await scoped(token).from('profiles').select('id').eq('id', id), 'Profile read');
}
async function api(token, pathname, method = 'GET', body) {
  const response = await fetch(new URL(pathname, base), {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.json() };
}
try {
  const guest = requireSuccess(await authClient().auth.signInAnonymously(), 'Guest signup');
  remember(guest.user, 'guest');
  const guestToken = guest.session.access_token;
  check('guest can read its profile directly', (await profileRows(guestToken, guest.user.id)).length, 1);
  check('guest can read its profile through the API', (await api(guestToken, '/api/profile')).status, 200);
  const guestUpdate = requireSuccess(await scoped(guestToken).from('profiles')
    .update({ bio: `identity-check-${nonce}` }).eq('id', guest.user.id).select('id'), 'Guest update probe');
  check('guest creator-profile update is denied by RLS', guestUpdate.length, 0);

  const email = `identity-check-${nonce}@example.invalid`;
  const password = `${randomBytes(32).toString('base64url')}!Aa9`;
  const registered = requireSuccess(await admin.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { identity_boundary_check: nonce },
  }), 'Create registered fixture');
  remember(registered.user, 'registered');
  const signIn = async () => requireSuccess(
    await authClient().auth.signInWithPassword({ email, password }), 'Fixture sign-in',
  ).session.access_token;
  let token = await signIn();
  const ownerUpdate = requireSuccess(await scoped(token).from('profiles')
    .update({ bio: `identity-check-${nonce}` }).eq('id', registered.user.id).select('id'), 'Owner update probe');
  check('registered owner can update its profile', ownerUpdate.length, 1);
  check('guest cannot read another profile', (await profileRows(guestToken, registered.user.id)).length, 0);

  requireSuccess(await admin.auth.admin.updateUserById(registered.user.id, { ban_duration: '1h' }), 'Ban fixture');
  check('banned fixture loses direct profile access', (await profileRows(token, registered.user.id)).length, 0);
  check('banned fixture loses API access', (await api(token, '/api/profile')).status, 401);
  requireSuccess(await admin.auth.admin.updateUserById(registered.user.id, { ban_duration: 'none' }), 'Unban fixture');
  token = await signIn();
  requireSuccess(await admin.auth.admin.signOut(token, 'global'), 'Revoke fixture session');
  check('revoked token loses direct profile access before expiry', (await profileRows(token, registered.user.id)).length, 0);
  check('revoked token loses API access', (await api(token, '/api/profile')).status, 401);

  token = await signIn();
  const prepared = await api(guestToken, '/api/account/merge/prepare', 'POST', {});
  check('guest prepares a merge ticket', prepared.status, 200);
  assert(typeof prepared.body.ticket === 'string', 'Merge ticket missing');
  const merged = await api(token, '/api/account/merge', 'POST', { ticket: prepared.body.ticket });
  check('disposable guest merges through the API', merged.body.status, 'merged');
  check('fixture merge transfers zero real credits', merged.body.creditsMoved, 0);
  check('merged guest loses direct profile access', (await profileRows(guestToken, guest.user.id)).length, 0);
  check('merged guest loses API access', (await api(guestToken, '/api/profile')).body.code, 'SESSION_MERGED');
  const replay = await api(token, '/api/account/merge', 'POST', { ticket: prepared.body.ticket });
  check('merge ticket replay remains idempotent', replay.body.status, 'already_merged');

  requireSuccess(await admin.from('profiles').update({ identity_state: 'deleting' })
    .eq('id', registered.user.id), 'Set fixture deletion state');
  check('deleting fixture loses direct profile access', (await profileRows(token, registered.user.id)).length, 0);
  check('deleting fixture loses API access', (await api(token, '/api/profile')).body.code, 'ACCOUNT_DELETING');
  console.log(`Identity checks passed: ${checks}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Identity verification failed');
  process.exitCode = 1;
} finally {
  // Guest first avoids detaching a merged identity when its target is removed.
  let cleanupFailed = false;
  for (const user of created) {
    try {
      requireSuccess(await admin.auth.admin.deleteUser(user.id), `Remove ${user.kind} fixture`);
    } catch {
      cleanupFailed = true;
      console.error(`Fixture cleanup failed; recovery IDs are in ${recoveryDir}/created-users.json`);
      break;
    }
  }
  if (cleanupFailed) process.exitCode = 1;
  else {
    rmSync(recoveryDir, { recursive: true });
    console.log(`Removed all ${created.length} disposable identities.`);
  }
}
