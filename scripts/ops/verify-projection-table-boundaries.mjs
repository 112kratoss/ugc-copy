#!/usr/bin/env node
// Live checks use disposable identities and inert projection fixtures.
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
const recoveryDir = mkdtempSync(path.join(tmpdir(), 'magicbooklet-projection-check-'));
const fixtures = { project, users: [], generations: [], templates: [], tools: [], models: [] };
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
  const email = `projection-check-${nonce}-${suffix}@example.invalid`;
  const password = `${randomBytes(32).toString('base64url')}!Aa9`;
  const user = success(await admin.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { projection_boundary_check: nonce },
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
    app_metadata: { projection_boundary_check: nonce },
  }), 'Tag guest fixture');
  return { id: session.user.id, client, token: session.access_token };
}
const privateTables = ['generations', 'generation_input_media', 'ai_usage_events'];
try {
  const owner = await identity('owner');
  const other = await identity('other');
  const guest = await guestIdentity();
  const anon = createClient(url, key, options);
  const generations = new Map();
  for (const who of [owner, other, guest]) {
    const generation = randomUUID(); const template = randomUUID();
    fixtures.generations.push(generation); fixtures.templates.push(template); remember();
    generations.set(who.id, generation);
    success(await admin.from('generations').insert({ id: generation, user_id: who.id,
      model: 'audit-projection-no-provider', status: 'succeeded', is_public: false,
      prompt: 'Disposable private prompt' }), 'Seed private generation');
    success(await admin.from('generation_input_media').insert({ generation_id: generation,
      user_id: who.id, media_type: 'image', role: 'reference', storage_path: `audit-projection/${nonce}/${who.id}` }), 'Seed input metadata');
    success(await admin.from('ai_usage_events').insert({ user_id: who.id,
      feature: `audit-projection-${nonce}`, provider: 'inert', model: 'no-provider', status: 'succeeded', cost: 0 }), 'Seed usage');
    success(await admin.from('templates').insert({ id: template, name: `Audit projection ${nonce}`,
      creator_user_id: who.id, status: 'draft', is_active: false }), 'Seed draft');
  }
  // A mismatched child proves the policy also checks the parent's owner.
  const mismatch = randomUUID();
  success(await admin.from('generation_input_media').insert({ id: mismatch,
    generation_id: generations.get(other.id), user_id: owner.id, media_type: 'image',
    role: 'reference', storage_path: `audit-projection/${nonce}/mismatch` }), 'Seed mismatched child');
  const tool = randomUUID(); const model = randomUUID();
  fixtures.tools.push(tool); fixtures.models.push(model); remember();
  success(await admin.from('source_tools').insert({ id: tool, slug: `audit-projection-${nonce}`,
    label: 'Inactive audit fixture', is_active: false }), 'Seed inactive tool');
  success(await admin.from('source_tool_models').insert({ id: model, source_tool_id: tool,
    slug: `audit-projection-${nonce}`, label: 'Inactive audit fixture', is_active: false }), 'Seed inactive model');

  for (const who of [owner, other, guest]) {
    for (const table of privateTables) {
      const rows = success(await who.client.from(table).select('id,user_id').in('user_id', fixtures.users), 'Private projection');
      check(`${table}: ${who === guest ? 'guest' : who === owner ? 'owner' : 'other'} sees only own row`, rows.map(x => x.user_id), [who.id]);
    }
    const drafts = success(await who.client.from('templates').select('id,creator_user_id').in('id', fixtures.templates), 'Draft read');
    check('template drafts are owner-scoped', drafts.map(x => x.creator_user_id), [who.id]);
    for (const [table, column] of [['generations', 'prompt'], ['generations', 'output_url'],
      ['generations', 'actual_cost'], ['templates', 'source_canvas_id'], ['templates', 'draft_catalog_revision']]) {
      check(`${table}.${column}: excluded from direct projection`,
        (await who.client.from(table).select(column).limit(0)).error?.code, '42501');
    }
  }
  for (const table of privateTables) {
    check(`${table}: unauthenticated read denied`, (await anon.from(table).select('id').limit(0)).error?.code, '42501');
  }
  check('anonymous callers cannot read draft fixtures',
    success(await anon.from('templates').select('id').in('id', fixtures.templates), 'Anon drafts').length, 0);
  for (const [table, id] of [['source_tools', tool], ['source_tool_models', model]]) {
    for (const client of [anon, owner.client, guest.client]) {
      check(`${table}: inactive fixture hidden`, success(await client.from(table).select('id').eq('id', id), 'Inactive catalog').length, 0);
    }
    const forgedId = randomUUID();
    (table === 'source_tools' ? fixtures.tools : fixtures.models).push(forgedId); remember();
    check(`${table}: direct catalog insert denied`, (await owner.client.from(table).insert({
      id: forgedId, ...(table === 'source_tool_models' ? { source_tool_id: tool } : {}),
      slug: `audit-forged-${nonce}`, label: 'Forbidden', is_active: false,
    })).error?.code, '42501');
    check(`${table}: direct update changes no fixture`, success(await owner.client.from(table)
      .update({ label: 'Forbidden' }).eq('id', id).select('id'), 'Catalog update').length, 0);
    check(`${table}: direct delete removes no fixture`, success(await owner.client.from(table)
      .delete().eq('id', id).select('id'), 'Catalog delete').length, 0);
  }
  for (const [table, columns] of [['source_tools','id,is_active'], ['source_tool_models','id,is_active'], ['templates','id,status,is_active']]) {
    const rows = success(await anon.from(table).select(columns).limit(10), 'Public read');
    check(`${table}: public read returns only active rows`, rows.every(x => x.is_active && (!('status' in x) || x.status === 'active')), true);
  }
  // An ID-scoped empty read proves the public follow relation is readable
  // without creating a public social action or reading customer relationships.
  check('public follow projection is readable', success(await anon.from('follows')
    .select('follower_id,following_id').eq('follower_id', owner.id), 'Public follows').length, 0);
  check('direct follow creation denied', (await owner.client.from('follows')
    .insert({ follower_id: owner.id, following_id: other.id })).error?.code, '42501');
  check('direct generation update denied', (await owner.client.from('generations')
    .update({ status: 'failed' }).eq('id', generations.get(owner.id))).error?.code, '42501');
  check('direct input-media update denied', (await owner.client.from('generation_input_media')
    .update({ label: 'Forbidden' }).eq('user_id', owner.id)).error?.code, '42501');
  check('direct template update denied', (await owner.client.from('templates')
    .update({ name: 'Forbidden' }).in('id', fixtures.templates)).error?.code, '42501');
  check('direct usage insert denied', (await owner.client.from('ai_usage_events')
    .insert({ user_id: owner.id, feature: `audit-projection-${nonce}`, provider: 'inert', model: 'no-provider' })).error?.code, '42501');
  check('direct usage update changes no row', success(await owner.client.from('ai_usage_events')
    .update({ cost: 99 }).eq('user_id', owner.id).select('id'), 'Usage update').length, 0);
  check('direct usage deletion changes no row', success(await owner.client.from('ai_usage_events')
    .delete().eq('user_id', owner.id).select('id'), 'Usage deletion').length, 0);
  success(await admin.auth.admin.updateUserById(other.id, { ban_duration: '1h' }), 'Ban fixture');
  for (const table of privateTables) {
    check(`${table}: banned identity denied`, success(await other.client.from(table)
      .select('id').in('user_id', fixtures.users), 'Banned read').length, 0);
  }
  success(await admin.auth.admin.signOut(owner.token, 'global'), 'Revoke fixture');
  for (const table of privateTables) {
    check(`${table}: revoked identity denied`, success(await owner.client.from(table)
      .select('id').in('user_id', fixtures.users), 'Revoked read').length, 0);
  }
  check('revoked owner loses draft access', success(await owner.client.from('templates')
    .select('id').in('id', fixtures.templates), 'Revoked draft read').length, 0);
  console.log(JSON.stringify({ at: new Date().toISOString(), project, passed }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Projection verification failed');
  process.exitCode = 1;
} finally {
  let failed = false;
  // Delete scoped data before auth identities: usage events need explicit
  // cleanup, and template creator deletion otherwise only nulls the owner.
  for (const [table, column, ids] of [
    ['ai_usage_events','user_id',fixtures.users], ['generation_input_media','user_id',fixtures.users],
    ['templates','id',fixtures.templates], ['generations','id',fixtures.generations],
    ['source_tool_models','id',fixtures.models], ['source_tools','id',fixtures.tools],
  ]) {
    if (ids.length && (await admin.from(table).delete().in(column, ids)).error) failed = true;
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
    console.log(`Removed all ${fixtures.users.length} identities and projection fixtures.`);
  }
}
