#!/usr/bin/env node
// Live checks use disposable identities and inert notification/token fixtures.
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
const recoveryDir = mkdtempSync(path.join(tmpdir(), 'magicbooklet-notification-check-'));
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
async function api(identity, route, body, method = 'POST') {
  const response = await fetch(new URL(route, base), {
    method,
    headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, body: await response.json() };
}
async function identity(suffix) {
  const email = `notification-check-${nonce}-${suffix}@example.invalid`;
  const password = `${randomBytes(32).toString('base64url')}!Aa9`;
  const user = success(await admin.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { notification_boundary_check: nonce },
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
    app_metadata: { notification_boundary_check: nonce },
  }), 'Tag guest fixture');
  return { id: session.user.id, client, token: session.access_token };
}
const tables = ['mobile_notifications', 'mobile_notification_preferences', 'mobile_push_tokens'];
try {
  const owner = await identity('owner');
  const other = await identity('other');
  const guest = await guestIdentity();
  const notifications = new Map();
  for (const who of [owner, other, guest]) {
    // SQL inserts do not invoke the notification delivery service. Tokens remain
    // inactive, preferences disable push, and no delivery job is created.
    success(await admin.from('mobile_notification_preferences').insert({ user_id: who.id, push_enabled: false }), 'Seed preferences');
    success(await admin.from('mobile_push_tokens').insert({ user_id: who.id,
      expo_push_token: `audit-inert-${nonce}-${who.id}`, platform: 'ios', is_active: false }), 'Seed inert token');
    const id = randomUUID(); notifications.set(who.id, id);
    success(await admin.from('mobile_notifications').insert({ id, user_id: who.id,
      type: 'generation_succeeded', category: 'generation', title: 'Disposable audit fixture', body: 'No push delivery' }), 'Seed inbox');
  }
  for (const table of tables) {
    const own = success(await owner.client.from(table).select('user_id'), 'Owner read');
    check(`${table}: reads only own fixture`, own.map(x => x.user_id), [owner.id]);
    const foreign = success(await other.client.from(table).select('user_id').eq('user_id', owner.id), 'Foreign read');
    check(`${table}: foreign row hidden`, foreign.length, 0);
    const changed = success(await other.client.from(table).update(
      table === 'mobile_notifications' ? { is_read: true } : { updated_at: new Date().toISOString() }
    ).eq('user_id', owner.id).select('user_id'), 'Foreign update');
    check(`${table}: foreign update changes nothing`, changed.length, 0);
    const guestRows = success(await guest.client.from(table).select('user_id'), 'Guest read');
    check(`${table}: guest own rows hidden`, guestRows.length, 0);
    const guestChanged = success(await guest.client.from(table).update(
      table === 'mobile_notifications' ? { is_read: true } : { updated_at: new Date().toISOString() }
    ).eq('user_id', guest.id).select('user_id'), 'Guest update');
    check(`${table}: guest update changes nothing`, guestChanged.length, 0);
  }
  check('guest direct token registration denied', (await guest.client.from('mobile_push_tokens').insert({
    user_id: guest.id, expo_push_token: `audit-new-${nonce}`, platform: 'ios', is_active: false,
  })).error?.code, '42501');
  check('guest direct preferences upsert denied', (await guest.client.from('mobile_notification_preferences')
    .upsert({ user_id: guest.id, social_enabled: false }, { onConflict: 'user_id' })).error?.code, '42501');
  check('owner cannot forge notification content', (await owner.client.from('mobile_notifications')
    .update({ title: 'Forbidden edit' }).eq('id', notifications.get(owner.id))).error?.code, '42501');

  const root = '/api/mobile/notifications';
  check('registered preferences API works', (await api(owner, `${root}/preferences`, undefined, 'GET')).status, 200);
  check('registered preferences update works', (await api(owner, `${root}/preferences`, { socialEnabled: false }, 'PATCH')).status, 200);
  const inbox = await api(owner, root, undefined, 'GET');
  check('registered inbox API works', inbox.status, 200);
  check('inbox contains only own notification', inbox.body.notifications.map(x => x.id), [notifications.get(owner.id)]);
  check('mark-read API works', (await api(owner, `${root}/read`, { ids: [notifications.get(owner.id), notifications.get(other.id)] })).status, 200);
  const otherNotification = success(await admin.from('mobile_notifications').select('is_read').eq('id', notifications.get(other.id)).single(), 'Check foreign notification');
  check('mark-read API leaves foreign notification unchanged', otherNotification.is_read, false);
  const ownNotification = success(await admin.from('mobile_notifications').select('is_read').eq('id', notifications.get(owner.id)).single(), 'Check owner notification');
  check('mark-read API updates own notification', ownNotification.is_read, true);
  check('registered mark-all-read API works', (await api(owner, `${root}/read-all`, {})).status, 200);
  // A random token is not assigned to a device; push is disabled for this
  // fixture account, and unregister immediately deactivates this registration.
  const testToken = `ExponentPushToken[audit${nonce}]`;
  check('registered token API works', (await api(owner, `${root}/register`, {
    expoPushToken: testToken, platform: 'ios', deviceId: `audit-${nonce}`,
  })).status, 200);
  check('registered unregister API works', (await api(owner, `${root}/unregister`, { expoPushToken: testToken })).status, 200);
  const token = success(await admin.from('mobile_push_tokens').select('is_active').eq('user_id', owner.id).eq('expo_push_token', testToken).single(), 'Check unregistered token');
  check('unregister deactivates token', token.is_active, false);
  for (const [route, body, method] of [
    [root, undefined, 'GET'], [`${root}/preferences`, undefined, 'GET'],
    [`${root}/preferences`, { pushEnabled: true }, 'PATCH'],
    [`${root}/register`, { expoPushToken: `ExponentPushToken[auditguest${nonce}]`, platform: 'ios' }, 'POST'],
  ]) {
    const result = await api(guest, route, body, method);
    check(`guest API denied: ${method} ${route}`, [401, 403].includes(result.status), true);
  }
  success(await admin.auth.admin.signOut(owner.token, 'global'), 'Revoke fixture session');
  for (const table of tables) {
    const rows = success(await owner.client.from(table).select('user_id'), 'Revoked read');
    check(`${table}: revoked owner cannot read`, rows.length, 0);
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), project, passed }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Notification boundary verification failed');
  process.exitCode = 1;
} finally {
  let failed = false;
  for (const id of fixtures.users) {
    const result = await admin.auth.admin.deleteUser(id);
    if (result.error && result.error.status !== 404) failed = true;
  }
  if (failed) {
    console.error(`Cleanup incomplete; private recovery file: ${recoveryDir}/fixtures.json`);
    process.exitCode = 1;
  } else {
    rmSync(recoveryDir, { recursive: true });
    console.log(`Removed all ${fixtures.users.length} identities and their notification/token fixtures.`);
  }
}
