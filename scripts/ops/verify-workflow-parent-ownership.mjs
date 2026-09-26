#!/usr/bin/env node
// Creates only disposable identities and inert workflow/media records.
// No provider work, emails, payments, or existing-account changes.
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
} });
assert(values.confirm, 'Use --confirm to create and remove disposable fixtures.');
const project = values['project-ref'];
assert(project && /^[a-z0-9]+$/.test(project), 'An explicit --project-ref is required.');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
assert(url && new URL(url).hostname === `${project}.supabase.co`, 'URL must match --project-ref.');
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(key && serviceKey, 'Client and service credentials are required.');
const authOptions = { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false };
const client = () => createClient(url, key, { auth: authOptions });
const admin = createClient(url, serviceKey, { auth: authOptions });
const nonce = randomBytes(8).toString('hex');
const recoveryDir = mkdtempSync(path.join(tmpdir(), 'magicbooklet-workflow-check-'));
const fixtures = { project, users: [], canvases: [], generations: [] };
const checks = [];
function saveRecovery() {
  writeFileSync(path.join(recoveryDir, 'fixtures.json'), JSON.stringify(fixtures), { mode: 0o600 });
}
function success(result, label) {
  assert(!result.error, `${label} failed (${result.error?.code ?? result.error?.status ?? 'upstream error'})`);
  return result.data;
}
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  checks.push(label);
  console.log(`PASS ${label}`);
}
async function fixture(suffix) {
  const email = `workflow-check-${nonce}-${suffix}@example.invalid`;
  const password = `${randomBytes(32).toString('base64url')}!Aa9`;
  const user = success(await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    app_metadata: { workflow_boundary_check: nonce },
  }), 'Create fixture').user;
  fixtures.users.push(user.id); saveRecovery();
  const auth = client();
  const session = success(await auth.auth.signInWithPassword({ email, password }), 'Sign in fixture').session;
  const canvas = randomUUID();
  fixtures.canvases.push(canvas); saveRecovery();
  success(await auth.from('workflow_canvases').insert({
    id: canvas, user_id: user.id, title: `Audit fixture ${nonce}`,
    graph: { version: 1, nodes: [], edges: [] },
  }), 'Create fixture canvas');
  const generation = randomUUID();
  fixtures.generations.push(generation); saveRecovery();
  success(await admin.from('generations').insert({
    id: generation, user_id: user.id, model: 'audit-fixture-no-provider',
    status: 'succeeded', is_public: false,
  }), 'Create inert generation fixture');
  const proposal = success(await auth.from('workflow_canvas_assistant_proposals').insert({
    canvas_id: canvas, user_id: user.id, summary: 'Audit fixture', proposed_graph: {},
  }).select('id').single(), 'Create fixture proposal').id;
  return { id: user.id, auth, token: session.access_token, canvas, generation, proposal };
}
try {
  const owner = await fixture('owner');
  const other = await fixture('other');
  const rows = [
    ['workflow_canvas_history', { title: 'Audit fixture', graph: {}, kind: 'draft' }],
    ['workflow_canvas_runs', { start_node_id: 'audit-no-work', mode: 'node', status: 'succeeded' }],
    ['workflow_canvas_assistant_proposals', { summary: 'Audit fixture', proposed_graph: {} }],
    ['workflow_canvas_assistant_messages', { role: 'user', content: 'Audit fixture' }],
  ];
  let ownRun;
  let ownMessage;
  for (const [table, payload] of rows) {
    const row = success(await owner.auth.from(table).insert({
      ...payload, user_id: owner.id, canvas_id: owner.canvas,
    }).select('id').single(), `${table} valid insert`);
    check(`${table}: valid own insert works`, Boolean(row.id), true);
    if (table === 'workflow_canvas_runs') ownRun = row.id;
    if (table === 'workflow_canvas_assistant_messages') ownMessage = row.id;
    const denied = await owner.auth.from(table).insert({
      ...payload, user_id: owner.id, canvas_id: other.canvas,
    });
    check(`${table}: foreign parent insert denied`, denied.error?.code, '42501');
    const foreignRead = success(await other.auth.from(table).select('id').eq('id', row.id), 'Foreign read');
    check(`${table}: another user cannot read row`, foreignRead.length, 0);
    if (table !== 'workflow_canvas_history') {
      const moved = await owner.auth.from(table).update({ canvas_id: other.canvas }).eq('id', row.id);
      check(`${table}: foreign parent update denied`, moved.error?.code, '42501');
    }
  }
  const linked = success(await owner.auth.from('workflow_canvas_assistant_messages').update({
    proposal_id: owner.proposal,
  }).eq('id', ownMessage).select('proposal_id').single(), 'Link own proposal');
  check('own proposal link works', linked.proposal_id, owner.proposal);
  check('foreign proposal link denied', (await owner.auth.from('workflow_canvas_assistant_messages')
    .update({ proposal_id: other.proposal }).eq('id', ownMessage)).error?.code, '42501');
  const step = success(await owner.auth.from('workflow_canvas_run_steps').insert({
    run_id: ownRun, node_id: 'audit-no-work', status: 'succeeded', generation_id: owner.generation,
  }).select('id').single(), 'Create valid step');
  check('own generation link works', Boolean(step.id), true);
  check('foreign generation insert denied', (await owner.auth.from('workflow_canvas_run_steps').insert({
    run_id: ownRun, node_id: 'audit-foreign', status: 'succeeded', generation_id: other.generation,
  })).error?.code, '42501');
  check('foreign generation update denied', (await owner.auth.from('workflow_canvas_run_steps')
    .update({ generation_id: other.generation }).eq('id', step.id)).error?.code, '42501');
  success(await admin.auth.admin.signOut(owner.token, 'global'), 'Revoke fixture session');
  for (const [table] of rows) {
    const result = success(await owner.auth.from(table).select('id').eq('user_id', owner.id), 'Revoked read');
    check(`${table}: revoked session read denied`, result.length, 0);
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), project, passed: checks.length }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Workflow verification failed');
  process.exitCode = 1;
} finally {
  // Explicit child roots first: auth deletion need not cascade every domain.
  let cleanupFailed = false;
  for (const [table, ids] of [
    ['workflow_canvases', fixtures.canvases], ['generations', fixtures.generations],
  ]) {
    if (!ids.length) continue;
    const result = await admin.from(table).delete().in('id', ids);
    if (result.error) cleanupFailed = true;
  }
  if (!cleanupFailed) {
    for (const id of fixtures.users) {
      const result = await admin.auth.admin.deleteUser(id);
      if (result.error && result.error.status !== 404) cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    console.error(`Fixture cleanup incomplete. Private recovery file: ${recoveryDir}/fixtures.json`);
    process.exitCode = 1;
  } else {
    rmSync(recoveryDir, { recursive: true });
    console.log(`Removed all ${fixtures.users.length} disposable identities and their workflow/media fixtures.`);
  }
}
