#!/usr/bin/env node
// Live HTTP checks use disposable identities with empty financial histories.
// Populated-row isolation is covered by the rolled-back SQL companion.
// No payment, payout, ledger or wallet fixtures are committed.
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
const recoveryDir = mkdtempSync(path.join(tmpdir(), 'magicbooklet-financial-check-'));
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
  const email = `financial-check-${nonce}-${suffix}@example.invalid`;
  const password = `${randomBytes(32).toString('base64url')}!Aa9`;
  const user = success(await admin.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { financial_boundary_check: nonce },
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
    app_metadata: { financial_boundary_check: nonce },
  }), 'Tag guest fixture');
  return { id: session.user.id, client, token: session.access_token };
}
const tables = ['transactions', 'creator_resource_wallets', 'creator_resource_wallet_entries', 'creator_payout_requests'];
const updates = [{ credits: 99 }, { available_token_subunits: 999 },
  { creator_amount_token_subunits: 999 }, { status: 'paid' }];
async function payoutRead(who, status) {
  const response = await fetch(new URL('/api/creator/payouts', base), {
    headers: who ? { Authorization: `Bearer ${who.token}` } : {},
    signal: AbortSignal.timeout(30000),
  });
  check('payout GET admission', response.status, status);
  if (status === 200) {
    const body = await response.json();
    check('payout GET returns empty financial state', {
      available: body.availableTokenSubunits, held: body.heldTokenSubunits,
      earned: body.lifetimeEarnedTokenSubunits, paid: body.lifetimePaidOutTokenSubunits,
      history: body.history, pending: body.pendingRequest, canRequest: body.canRequest,
    }, { available: 0, held: 0, earned: 0, paid: 0, history: [], pending: null, canRequest: false });
    check('payout response is private and uncached',
      response.headers.get('cache-control')?.includes('no-store'), true);
  }
}
try {
  const owner = await identity('owner');
  const other = await identity('other');
  const guest = await guestIdentity();
  const anon = createClient(url, key, options);
  for (const who of [owner, other, guest]) {
    for (const [i, table] of tables.entries()) {
      check(`${table}: authenticated empty-history read`, success(await who.client.from(table)
        .select('user_id').in('user_id', fixtures.users), 'Scoped read'), []);
      check(`${table}: direct insert denied`, (await who.client.from(table)
        .insert({ user_id: who.id })).error?.code, '42501');
      check(`${table}: direct update denied`, (await who.client.from(table)
        .update(updates[i]).eq('user_id', who.id)).error?.code, '42501');
      check(`${table}: direct delete denied`, (await who.client.from(table)
        .delete().eq('user_id', who.id)).error?.code, '42501');
    }
  }
  for (const table of tables) check(`${table}: unauthenticated read denied`,
    (await anon.from(table).select('user_id').in('user_id', fixtures.users)).error?.code, '42501');
  await payoutRead(owner, 200);
  await payoutRead(other, 200);
  await payoutRead(guest, 403);
  await payoutRead(null, 401);
  success(await admin.auth.admin.updateUserById(other.id, { ban_duration: '1h' }), 'Ban fixture');
  await payoutRead(other, 401);
  success(await admin.auth.admin.signOut(owner.token, 'global'), 'Revoke fixture');
  await payoutRead(owner, 401);
  for (const who of [owner, other]) for (const table of tables) check(`${table}: revoked/banned scoped read empty`,
    success(await who.client.from(table).select('user_id').in('user_id', fixtures.users), 'Inactive read'), []);
  for (const table of tables) check(`${table}: no financial rows created`, success(await admin.from(table)
    .select('user_id').in('user_id', fixtures.users), 'Financial absence'), []);
  console.log(JSON.stringify({ at: new Date().toISOString(), project, passed, fixtureUserIds: fixtures.users }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Financial verification failed');
  process.exitCode = 1;
} finally {
  let failed = false;
  // Preserve identities for investigation if an unexpected financial row exists.
  // Deleting an identity could detach retention-protected payout records.
  for (const table of tables) {
    if (!fixtures.users.length) continue;
    const result = await admin.from(table).select('user_id').in('user_id', fixtures.users);
    if (result.error || result.data.length) failed = true;
  }
  if (!failed) for (const id of fixtures.users) {
    const result = await admin.auth.admin.deleteUser(id);
    if (result.error && result.error.status !== 404) failed = true;
  }
  if (failed) {
    console.error(`Cleanup incomplete; private recovery file: ${recoveryDir}/fixtures.json`);
    process.exitCode = 1;
  } else {
    rmSync(recoveryDir, { recursive: true });
    console.log(`Removed all ${fixtures.users.length} identities; no financial records created.`);
  }
}
