#!/usr/bin/env node
// Real JWT checks for client RPC admission. Only disposable empty canvases.
// Successful worker creation is tested exclusively by the rollback SQL probe.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
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
const recoveryDir = mkdtempSync(path.join(tmpdir(), 'magicbooklet-rpc-check-'));
const fixtures = { project, users: [], canvases: [] };
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
  const email = `rpc-check-${nonce}-${suffix}@example.invalid`;
  const password = `${randomBytes(32).toString('base64url')}!Aa9`;
  const user = success(await admin.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { rpc_boundary_check: nonce },
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
    app_metadata: { rpc_boundary_check: nonce },
  }), 'Tag guest fixture');
  return { id: session.user.id, client, token: session.access_token };
}
const identities = ['current_identity_admission', 'current_identity_state',
  'current_identity_is_active', 'current_identity_is_registered'];
function args(who, kind, extra = {}) {
  return { p_canvas_id: who.canvas, p_user_id: who.id, p_start_node_id: 'audit-no-provider',
    p_mode: 'node', p_catalog_revision: null, p_graph_snapshot: {},
    p_idempotency_key: `audit-${nonce}-${kind}`, ...extra,
    ...(kind === 'initialize' ? { p_step_skeleton: [{ nodeId: 'audit-no-provider' }] } : {}),
  };
}
async function denied(who, kind, parameters, code, message) {
  const result = await who.client.rpc(`${kind}_workflow_canvas_run`, parameters);
  check(`${kind}: rejection SQLSTATE`, result.error?.code, code);
  if (message) check(`${kind}: rejection reason`, result.error?.message, message);
}
try {
  const owner = await identity('owner'); const other = await identity('other');
  const guest = await guestIdentity(); const anon = createClient(url, key, options);
  for (const who of [owner, other]) {
    who.canvas = randomUUID(); fixtures.canvases.push(who.canvas); remember();
    success(await admin.from('workflow_canvases').insert({ id: who.canvas, user_id: who.id,
      title: `RPC audit ${nonce}`, graph: { version: 1, nodes: [], edges: [] } }), 'Empty canvas');
  }
  for (const who of [owner, other, guest]) {
    const state = success(await who.client.rpc('current_identity_admission'), 'Identity admission');
    check('admission reports own live identity',
      { state: state.state, banned: state.banned, session: state.session_valid },
      { state: 'active', banned: false, session: true });
    check('identity lifecycle RPC', success(await who.client.rpc('current_identity_state'), 'State'), 'active');
    check('identity activity RPC', success(await who.client.rpc('current_identity_is_active'), 'Active'), true);
    check('registration uses auth identity', success(await who.client.rpc('current_identity_is_registered'), 'Registered'), who !== guest);
  }
  for (const name of identities) check(`${name}: anonymous execution denied`, (await anon.rpc(name)).error?.code, '42501');
  for (const kind of ['initialize', 'start']) {
    await denied(owner, kind, args(other, kind), 'P0001', 'cannot start a workflow run for another user');
    await denied(owner, kind, args(owner, kind, { p_canvas_id: other.canvas }), 'P0001', 'workflow canvas not found for this user');
    await denied({ client: anon }, kind, args(owner, kind), '42501');
  }
  // Fill only this disposable owner's real API bucket. No jobs or provider work.
  // Stay well away from the fixed-window edge before asserting denial.
  let budget;
  for (let i = 0; i < 20; i++) budget = success(await admin.rpc('check_backend_rate_limit', {
    p_scope: 'workflow-run:start', p_subject_key: owner.id, p_limit: 20, p_window_seconds: 600,
  }), 'Fixture quota');
  assert(Date.parse(budget.resetAt) - Date.now() > 30000, 'Too close to quota reset; rerun after the window boundary.');
  for (const kind of ['initialize', 'start']) await denied(owner, kind, args(owner, kind), 'P0001',
    kind === 'initialize' ? 'workflow run rate limit exceeded' : 'legacy workflow run rate limit exceeded');
  success(await admin.auth.admin.updateUserById(other.id, { ban_duration: '1h' }), 'Ban fixture');
  check('banned identity RPC is inactive', success(await other.client.rpc('current_identity_is_active'), 'Banned active'), false);
  for (const kind of ['initialize', 'start']) await denied(other, kind, args(other, kind), '42501', 'Active identity required');
  success(await admin.auth.admin.signOut(owner.token, 'global'), 'Revoke fixture');
  check('revoked identity RPC is inactive', success(await owner.client.rpc('current_identity_is_active'), 'Revoked active'), false);
  for (const kind of ['initialize', 'start']) await denied(owner, kind, args(owner, kind), '42501', 'Active identity required');
  check('no workflow runs committed', success(await admin.from('workflow_canvas_runs')
    .select('id').in('canvas_id', fixtures.canvases), 'Run absence'), []);
  check('no worker jobs committed', success(await admin.from('workflow_run_step_jobs')
    .select('id').in('canvas_id', fixtures.canvases), 'Job absence'), []);
  console.log(JSON.stringify({ at: new Date().toISOString(), project, passed, fixtures }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'RPC verification failed');
  process.exitCode = 1;
} finally {
  let failed = false;
  // An unexpected accepted call contains an empty graph, but remove any worker
  // ticket first, then the disposable canvas and its cascading run records.
  for (const [table, column, ids] of [
    ['workflow_run_step_jobs', 'canvas_id', fixtures.canvases],
    ['workflow_canvases', 'id', fixtures.canvases],
    ['backend_rate_limits', 'subject_key', fixtures.users],
  ]) if (ids.length && (await admin.from(table).delete().in(column, ids)).error) failed = true;
  if (!failed) for (const id of fixtures.users) {
    const result = await admin.auth.admin.deleteUser(id);
    if (result.error && result.error.status !== 404) failed = true;
  }
  if (failed) {
    console.error(`Cleanup incomplete; private recovery file: ${recoveryDir}/fixtures.json`);
    process.exitCode = 1;
  } else {
    rmSync(recoveryDir, { recursive: true });
    console.log(`Removed ${fixtures.users.length} identities and all RPC fixtures.`);
  }
}
