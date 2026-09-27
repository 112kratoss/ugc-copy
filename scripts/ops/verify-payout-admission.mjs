#!/usr/bin/env node
// Payout admission checks with disposable zero-balance identities.
// Successful financial transitions are tested only by the rollback SQL probe.
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
assert(values.confirm, 'Use --confirm to create and remove disposable fixtures.');
const project = values['project-ref'];
assert(project && /^[a-z0-9]+$/.test(project), 'An explicit --project-ref is required.');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
assert(url && new URL(url).hostname === `${project}.supabase.co`, 'URL must match --project-ref.');
const base = new URL(values['base-url']);
assert(base.protocol === 'https:', '--base-url must use HTTPS.');
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(key && serviceKey, 'Client and service credentials are required.');
const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
const admin = createClient(url, serviceKey, options);
const nonce = randomBytes(8).toString('hex');
const recoveryDir = mkdtempSync(path.join(tmpdir(), 'magicbooklet-payout-check-'));
const fixtures = { project, users: [] };
let passed = 0;
function remember() {
  writeFileSync(path.join(recoveryDir, 'fixtures.json'), JSON.stringify(fixtures), { mode: 0o600 });
}
function success(result, label) {
  assert(!result.error, `${label} failed (${result.error?.code ?? result.error?.status ?? 'upstream error'})`);
  return result.data;
}
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  passed++;
  console.log(`PASS ${label}`);
}
async function identity(suffix) {
  const email = `payout-check-${nonce}-${suffix}@example.invalid`;
  const password = `${randomBytes(32).toString('base64url')}!Aa9`;
  const user = success(await admin.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { payout_boundary_check: nonce },
  }), 'Create identity').user;
  fixtures.users.push(user.id); remember();
  const client = createClient(url, key, options);
  const session = success(await client.auth.signInWithPassword({ email, password }), 'Fixture sign-in').session;
  return { id: user.id, client, token: session.access_token };
}
async function guestIdentity() {
  const client = createClient(url, key, options);
  const session = success(await client.auth.signInAnonymously(), 'Guest sign-in').session;
  fixtures.users.push(session.user.id); remember();
  success(await admin.auth.admin.updateUserById(session.user.id, {
    app_metadata: { payout_boundary_check: nonce },
  }), 'Tag guest fixture');
  return { id: session.user.id, client, token: session.access_token };
}
const tables = ['creator_payout_requests', 'creator_resource_wallets'];
async function post(who, route, body, expected, code) {
  const response = await fetch(new URL(route, base), { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  check(`${route}: expected admission`, response.status, expected);
  if (code) check(`${route}: business rejection`, (await response.json()).code, code);
}
try {
  const owner = await identity('owner'); const guest = await guestIdentity();
  const anon = createClient(url, key, options);
  for (const client of [owner.client, guest.client, anon]) {
    check('payout request RPC is service-only', (await client.rpc('request_creator_payout', {
      p_user_id: owner.id, p_payout_method: 'upi', p_payout_details: 'audit@example.invalid',
    })).error?.code, '42501');
    check('payout resolution RPC is service-only', (await client.rpc('resolve_creator_payout_request', {
      p_request_id: owner.id, p_reviewer_id: owner.id, p_action: null,
    })).error?.code, '42501');
  }
  await post(owner, '/api/creator/payouts', { payoutMethod: 'invalid', payoutDetails: 'audit@example.invalid' }, 400);
  await post(owner, '/api/creator/payouts', { payoutMethod: 'upi', payoutDetails: '' }, 400);
  await post(owner, '/api/creator/payouts', { payoutMethod: 'upi', payoutDetails: 'audit@example.invalid' }, 400, 'BELOW_MINIMUM');
  await post(guest, '/api/creator/payouts', { payoutMethod: 'upi', payoutDetails: 'audit@example.invalid' }, 403);
  await post(null, '/api/creator/payouts', {}, 401);
  await post(owner, '/api/admin/payouts', { requestId: owner.id, action: 'mark_paid' }, 401);
  await post(null, '/api/admin/payouts', { requestId: owner.id, action: null }, 401);
  success(await admin.auth.admin.signOut(owner.token, 'global'), 'Revoke fixture');
  await post(owner, '/api/creator/payouts', { payoutMethod: 'upi', payoutDetails: 'audit@example.invalid' }, 401);
  for (const table of tables) check(`${table}: no financial rows created`, success(await admin.from(table)
    .select('user_id').in('user_id', fixtures.users), 'Financial absence'), []);
  console.log(JSON.stringify({ at: new Date().toISOString(), project, passed, fixtures }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Payout check failed');
  process.exitCode = 1;
} finally {
  let failed = false;
  // Do not detach or erase an unexpected payout record. Preserve its identity
  // and recovery file for investigation if any financial row was created.
  for (const table of tables) {
    if (!fixtures.users.length) continue;
    const result = await admin.from(table).select('user_id').in('user_id', fixtures.users);
    if (result.error || result.data.length) failed = true;
  }
  if (fixtures.users.length && (await admin.from('backend_rate_limits').delete().in('subject_key', fixtures.users)).error) failed = true;
  if (!failed) for (const id of fixtures.users) {
    const result = await admin.auth.admin.deleteUser(id);
    if (result.error && result.error.status !== 404) failed = true;
  }
  if (failed) {
    console.error(`Cleanup incomplete; private recovery file: ${recoveryDir}/fixtures.json`);
    process.exitCode = 1;
  } else {
    rmSync(recoveryDir, { recursive: true });
    console.log(`Removed ${fixtures.users.length} identities; no payout records created.`);
  }
}
