#!/usr/bin/env node
// Live checks use only disposable identities, private posts and draft listings.
// No public content, provider work, payments or existing-account writes.
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
const recoveryDir = mkdtempSync(path.join(tmpdir(), 'magicbooklet-social-check-'));
const fixtures = { project, users: [], posts: [], generations: [] };
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
async function api(identity, route, body) {
  const response = await fetch(new URL(route, base), {
    method: 'POST',
    headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, body: await response.json() };
}
async function identity(suffix) {
  const email = `social-check-${nonce}-${suffix}@example.invalid`;
  const password = `${randomBytes(32).toString('base64url')}!Aa9`;
  const user = success(await admin.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { social_boundary_check: nonce },
  }), 'Create identity').user;
  fixtures.users.push(user.id); remember();
  const client = createClient(url, key, options);
  const session = success(await client.auth.signInWithPassword({ email, password }), 'Fixture sign-in').session;
  return { id: user.id, client, token: session.access_token };
}
try {
  const owner = await identity('owner');
  const other = await identity('other');
  const post = randomUUID();
  const generation = randomUUID();
  fixtures.posts.push(post); fixtures.generations.push(generation); remember();
  success(await admin.from('posts').insert({
    id: post, user_id: other.id, visibility: 'private', category: 'text',
    source_kind: 'external', post_format: 'text', body: 'Disposable audit fixture',
  }), 'Create private fixture');
  success(await admin.from('generations').insert({
    id: generation, user_id: other.id, model: 'audit-social-no-provider',
    status: 'succeeded', is_public: false,
  }), 'Create inert generation');
  const payloads = {
    post_saves: { user_id: owner.id, post_id: post },
    showcase_saves: { user_id: owner.id, generation_id: generation },
    post_save_events: { user_id: owner.id, post_id: post, requested_state: true, result_state: true },
    post_deletion_audits: { owner_user_id: owner.id, post_id: post, visibility: 'private', source_kind: 'external' },
  };
  for (const [table, payload] of Object.entries(payloads)) {
    check(`${table}: direct forged insert denied`,
      (await owner.client.from(table).insert(payload)).error?.code, '42501');
    const row = success(await admin.from(table).insert(payload).select('id').single(), 'Service fixture write');
    const own = success(await owner.client.from(table).select('id').eq('id', row.id), 'Owner read');
    check(`${table}: owner read works`, own.length, 1);
    const foreign = success(await other.client.from(table).select('id').eq('id', row.id), 'Foreign read');
    check(`${table}: foreign read denied`, foreign.length, 0);
    check(`${table}: direct delete denied`,
      (await owner.client.from(table).delete().eq('id', row.id)).error?.code, '42501');
  }
  const privateSave = await api(owner, '/api/showcase/save', { postId: post, shouldSave: true });
  check('save API rejects private foreign posts', privateSave.status, 404);
  const draft = { type: 'guide', status: 'draft', title: `Audit fixture ${nonce}`,
    guideMarkdown: 'Disposable draft content', priceUsdCents: 0 };
  const created = await api(owner, '/api/marketplace/assets', draft);
  check('marketplace draft creation succeeds', created.status, 200);
  assert(created.body.assetId, 'Missing fixture asset ID');
  const updated = await api(owner, '/api/marketplace/assets', {
    ...draft, assetId: created.body.assetId, guideMarkdown: 'Updated fixture draft',
  });
  check('marketplace owner edit succeeds', updated.status, 200);
  const foreignEdit = await api(other, '/api/marketplace/assets', {
    ...draft, assetId: created.body.assetId, guideMarkdown: 'Forbidden edit',
  });
  check('marketplace foreign edit is rejected', foreignEdit.status, 404);
  const content = success(await admin.from('marketplace_asset_content').select('guide_markdown')
    .eq('asset_id', created.body.assetId).single(), 'Verify content');
  check('foreign attempt left owner content intact', content.guide_markdown, 'Updated fixture draft');
  for (const who of [owner, other]) {
    check('marketplace content direct read denied',
      (await who.client.from('marketplace_asset_content').select('asset_id')
        .eq('asset_id', created.body.assetId)).error?.code, '42501');
    check('marketplace content direct mutation denied',
      (await who.client.from('marketplace_asset_content').update({ guide_markdown: 'Forbidden' })
        .eq('asset_id', created.body.assetId)).error?.code, '42501');
  }
  success(await admin.auth.admin.signOut(owner.token, 'global'), 'Revoke fixture session');
  for (const table of Object.keys(payloads)) {
    const rows = success(await owner.client.from(table).select('id'), 'Revoked read');
    check(`${table}: revoked session denied`, rows.length, 0);
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), project, passed }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Social boundary verification failed');
  process.exitCode = 1;
} finally {
  let failed = false;
  if (fixtures.users.length) {
    const result = await admin.from('marketplace_assets').delete().in('seller_user_id', fixtures.users);
    if (result.error) failed = true;
  }
  for (const [table, ids] of [['posts', fixtures.posts], ['generations', fixtures.generations]]) {
    if (!ids.length) continue;
    if ((await admin.from(table).delete().in('id', ids)).error) failed = true;
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
    console.log(`Removed all ${fixtures.users.length} identities and their private/draft fixtures.`);
  }
}
