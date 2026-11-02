#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'ildfmhozpibwiopeavfg';
const REVENUECAT_WEBHOOK_URL = process.env.REVENUECAT_WEBHOOK_URL
  || 'https://magicbooklet.com/api/mobile/commerce/revenuecat-webhook';
const DEFAULT_AUTH_DB_POOL_PERCENT = Number(process.env.SUPABASE_AUTH_DB_POOL_PERCENT || 17);
// The iPhone app's bundle id (ugc-mobile/app.json): Apple refuses the web flow with it as client.
const IOS_BUNDLE_ID = process.env.IOS_BUNDLE_ID || 'com.magicbooklet.mobile';
const SITE_AUTH_CALLBACK_URL = 'https://magicbooklet.com/auth/callback';
// Where Supabase asks Apple to return: its own callback, or a custom domain's once one is active.
const SUPABASE_AUTH_CALLBACK_URL = process.env.SUPABASE_AUTH_CALLBACK_URL
  || `https://${PROJECT_REF}.supabase.co/auth/v1/callback`;
const TARGET_LINTS = new Set([
  'auth_leaked_password_protection',
  'auth_db_connections_absolute',
]);

function parseJsonFromCliOutput(output) {
  const trimmed = String(output || '').trim();
  const firstObject = trimmed.indexOf('{');
  const firstArray = trimmed.indexOf('[');
  const starts = [firstObject, firstArray].filter((index) => index >= 0);
  if (starts.length === 0) {
    throw new Error('Could not find a JSON payload in command output.');
  }

  return JSON.parse(trimmed.slice(Math.min(...starts)));
}

function collectLintObjects(value, lints = []) {
  if (!value || typeof value !== 'object') {
    return lints;
  }

  if (typeof value.name === 'string' && typeof value.title === 'string') {
    lints.push(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectLintObjects(item, lints);
    }
    return lints;
  }

  for (const item of Object.values(value)) {
    collectLintObjects(item, lints);
  }
  return lints;
}

function relevantSupabaseGateLints(parsedAdvisorOutput) {
  return collectLintObjects(parsedAdvisorOutput).filter((lint) => TARGET_LINTS.has(lint.name));
}

function buildSupabaseAuthPatch(percent = DEFAULT_AUTH_DB_POOL_PERCENT) {
  if (!Number.isInteger(percent) || percent <= 0 || percent > 100) {
    throw new Error('SUPABASE_AUTH_DB_POOL_PERCENT must be an integer between 1 and 100.');
  }

  return {
    password_hibp_enabled: true,
    db_max_pool_size: percent,
    db_max_pool_size_unit: 'percent',
    // Guest checkout (App Review 5.1.1(v)). supabase/config.toml governs the
    // local stack only, so production would otherwise reject signInAnonymously()
    // and every first-launch mobile session would fail with the buyer seeing a
    // dead purchase screen. Migration 20260811100000 must be applied first — it
    // is what stops each anonymous row from minting 25 credits.
    external_anonymous_users_enabled: true,
  };
}

function redactedAuthFields(config) {
  return {
    password_hibp_enabled: config.password_hibp_enabled,
    db_max_pool_size: config.db_max_pool_size,
    db_max_pool_size_unit: config.db_max_pool_size_unit,
    external_anonymous_users_enabled: config.external_anonymous_users_enabled,
  };
}

function printSupabaseSummary(lints) {
  if (lints.length === 0) {
    console.log('Supabase Auth external gates: clear');
    return;
  }

  console.log('Supabase Auth external gates still open:');
  for (const lint of lints) {
    console.log(`- ${lint.name} [${lint.level}]: ${lint.title}`);
    if (lint.detail) {
      console.log(`  ${lint.detail}`);
    }
  }
}

function runSupabaseAdvisorCheck() {
  const result = spawnSync('npx', [
    '--yes',
    'supabase@2.107.0',
    'db',
    'advisors',
    '--linked',
    '--type',
    'all',
    '--level',
    'info',
    '--fail-on',
    'none',
    '--output-format',
    'json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Supabase advisor check failed: ${result.stderr || result.stdout}`);
  }

  const parsed = parseJsonFromCliOutput(result.stdout);
  const lints = relevantSupabaseGateLints(parsed);
  printSupabaseSummary(lints);
  return lints;
}

async function fetchAuthConfig(token) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Could not read Supabase Auth config: HTTP ${response.status}`);
  }

  return response.json();
}

async function patchAuthConfig(token, body) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Could not patch Supabase Auth config: HTTP ${response.status}`);
  }

  return response.json();
}

async function applySupabaseAuthPatch() {
  const token = process.env.SUPABASE_MANAGEMENT_API_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    throw new Error('Set SUPABASE_MANAGEMENT_API_TOKEN or SUPABASE_ACCESS_TOKEN before using --apply-supabase-auth.');
  }

  const patchBody = buildSupabaseAuthPatch();
  const before = await fetchAuthConfig(token);
  console.log('Current Supabase Auth production fields:');
  console.log(JSON.stringify(redactedAuthFields(before), null, 2));
  console.log('Applying narrow Supabase Auth production patch:');
  console.log(JSON.stringify(patchBody, null, 2));

  const after = await patchAuthConfig(token, patchBody);
  console.log('Updated Supabase Auth production fields:');
  console.log(JSON.stringify(redactedAuthFields(after), null, 2));
}

function buildRevenueCatProbePayload(now = Date.now()) {
  return {
    api_version: '1.0',
    event: {
      id: `external-gate-probe-${now}`,
      type: 'TEST',
      event_timestamp_ms: now,
    },
  };
}

function assertRevenueCatProbeSuccess({ status, cacheControl, body }) {
  if (status !== 200) {
    throw new Error(`RevenueCat webhook probe failed: expected HTTP 200, got HTTP ${status}.`);
  }
  if (!body || body.received !== true || body.ignored !== true) {
    throw new Error('RevenueCat webhook probe failed: expected an ignored test-event response.');
  }
  if (!String(cacheControl || '').includes('private') || !String(cacheControl || '').includes('no-store')) {
    throw new Error('RevenueCat webhook probe failed: expected private no-store cache headers.');
  }
}

async function probeRevenueCatWebhook() {
  const token = process.env.REVENUECAT_WEBHOOK_AUTH_TOKEN;
  if (!token) {
    throw new Error('Set REVENUECAT_WEBHOOK_AUTH_TOKEN before using --probe-revenuecat-webhook.');
  }

  const response = await fetch(REVENUECAT_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      'X-Request-ID': `revenuecat-external-gate-${Date.now()}`,
    },
    body: JSON.stringify(buildRevenueCatProbePayload()),
  });
  const cacheControl = response.headers.get('cache-control') || '';
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('RevenueCat webhook probe failed: response was not JSON.');
  }

  assertRevenueCatProbeSuccess({
    body,
    cacheControl,
    status: response.status,
  });
  console.log('RevenueCat webhook probe: accepted harmless signed TEST event');
  console.log(JSON.stringify({
    cacheControl,
    status: response.status,
    url: REVENUECAT_WEBHOOK_URL,
  }, null, 2));
}

/**
 * What Supabase answers the website's Continue with Apple with, read without a
 * token: a redirect to Apple's authorize page for the Services ID, the first
 * of the Apple provider's Client IDs, back to Supabase's own callback. Returns
 * that client id. Anything else is a step of the runbook's "Sign in with Apple
 * on the web" left undone (a JSON 400 "missing OAuth secret": no secret saved;
 * the bundle id as client: the Services ID not first in Client IDs). It cannot
 * see an expired secret, which fails only at the code exchange.
 */
function assertAppleWebAuthorizeRedirect({
  status,
  location,
  body,
  expectedCallback = SUPABASE_AUTH_CALLBACK_URL,
  bundleId = IOS_BUNDLE_ID,
}) {
  if (status < 300 || status > 399 || !location) {
    throw new Error(`Apple web sign-in probe failed: expected a redirect to Apple, got HTTP ${status}${body ? `: ${String(body).slice(0, 200)}` : ''}.`);
  }
  const target = new URL(location);
  if (target.origin !== 'https://appleid.apple.com' || target.pathname !== '/auth/authorize') {
    throw new Error(`Apple web sign-in probe failed: redirected to ${target.origin}${target.pathname}, not Apple's authorize page.`);
  }
  const clientId = target.searchParams.get('client_id') || '';
  if (!clientId) {
    throw new Error('Apple web sign-in probe failed: the redirect names no client_id.');
  }
  if (clientId === bundleId) {
    throw new Error(`Apple web sign-in probe failed: the client is the bundle id ${bundleId}; put the Services ID first in the Apple provider's Client IDs.`);
  }
  if (target.searchParams.get('redirect_uri') !== expectedCallback) {
    throw new Error(`Apple web sign-in probe failed: Apple is asked to return to ${target.searchParams.get('redirect_uri')}, not ${expectedCallback} (set SUPABASE_AUTH_CALLBACK_URL once a custom domain is active).`);
  }
  return clientId;
}

/**
 * The Apple provider's Client IDs, read from the Auth config: the web client
 * first, and the bundle id still among them, or every native iPhone sign-in
 * fails Supabase's audience check. The redirect alone cannot show the second.
 */
function assertAppleClientIdsKeepNative({ config, webClientId, bundleId = IOS_BUNDLE_ID }) {
  const listed = [config.external_apple_client_id, config.external_apple_additional_client_ids]
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  if (listed[0] !== webClientId) {
    throw new Error(`Apple provider check failed: Client IDs start with ${listed[0] || 'nothing'}, not ${webClientId}.`);
  }
  if (!listed.includes(bundleId)) {
    throw new Error(`Apple provider check failed: the bundle id ${bundleId} is missing from Client IDs, so the iPhone app's Sign in with Apple fails.`);
  }
}

async function probeAppleWebSignIn() {
  const url = new URL(`https://${PROJECT_REF}.supabase.co/auth/v1/authorize`);
  url.searchParams.set('provider', 'apple');
  url.searchParams.set('redirect_to', SITE_AUTH_CALLBACK_URL);
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location');
  const body = location ? '' : await response.text();
  const clientId = assertAppleWebAuthorizeRedirect({ status: response.status, location, body });
  console.log(`Apple web sign-in probe: Supabase sends Continue with Apple to Apple as ${clientId}`);

  const token = process.env.SUPABASE_MANAGEMENT_API_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    console.log(`Not checked without SUPABASE_MANAGEMENT_API_TOKEN: that ${IOS_BUNDLE_ID} is still in the Apple provider's Client IDs. Sign in with Apple in the iPhone app to check it.`);
    return;
  }
  assertAppleClientIdsKeepNative({ config: await fetchAuthConfig(token), webClientId: clientId });
  console.log(`Apple provider check: ${IOS_BUNDLE_ID} is still listed for the iPhone's native sign-in`);
}

function printUsage() {
  console.log(`Usage:
  node scripts/ops/production-external-gates.mjs [--check]
  node scripts/ops/production-external-gates.mjs --print-supabase-auth-patch
  SUPABASE_MANAGEMENT_API_TOKEN=... node scripts/ops/production-external-gates.mjs --apply-supabase-auth
  REVENUECAT_WEBHOOK_AUTH_TOKEN='Bearer ...' node scripts/ops/production-external-gates.mjs --probe-revenuecat-webhook
  node scripts/ops/production-external-gates.mjs --probe-apple-web-sign-in

Default: --check

The Supabase Auth patch is intentionally narrow:
${JSON.stringify(buildSupabaseAuthPatch(), null, 2)}

RevenueCat provider delivery remains a dashboard gate: send a signed test webhook for
integration whintgr1689ecfb68 to ${REVENUECAT_WEBHOOK_URL}, then verify Vercel
production logs accepted it. Use --probe-revenuecat-webhook to verify the deployed
endpoint accepts the same configured authorization header before or after the provider
dashboard test.`);
}

function selfTest() {
  const sampleOutput = `Initialising login role...
[
  {
    "name": "auth_leaked_password_protection",
    "title": "Leaked Password Protection Disabled",
    "level": "WARN",
    "detail": "Leaked password protection is currently disabled."
  },
  {
    "name": "auth_db_connections_absolute",
    "title": "Auth DB Connection Strategy is not Percentage",
    "level": "INFO",
    "detail": "Your project's Auth server is configured to use at most 10 connections."
  },
  {
    "name": "unused_index",
    "title": "Unused index",
    "level": "INFO"
  }
]`;

  const parsed = parseJsonFromCliOutput(sampleOutput);
  const lints = relevantSupabaseGateLints(parsed);
  assert.equal(lints.length, 2);
  assert.deepEqual(buildSupabaseAuthPatch(17), {
    password_hibp_enabled: true,
    db_max_pool_size: 17,
    db_max_pool_size_unit: 'percent',
    external_anonymous_users_enabled: true,
  });
  assert.throws(() => buildSupabaseAuthPatch(0), /between 1 and 100/);
  assert.deepEqual(buildRevenueCatProbePayload(123), {
    api_version: '1.0',
    event: {
      id: 'external-gate-probe-123',
      type: 'TEST',
      event_timestamp_ms: 123,
    },
  });
  assert.doesNotThrow(() => assertRevenueCatProbeSuccess({
    body: { received: true, ignored: true },
    cacheControl: 'private, no-store',
    status: 200,
  }));
  assert.throws(() => assertRevenueCatProbeSuccess({
    body: { error: 'Unauthorized.' },
    cacheControl: 'private, no-store',
    status: 401,
  }), /expected HTTP 200/);
  const appleAuthorize = (clientId, redirectUri = 'https://ref.supabase.co/auth/v1/callback') => (
    `https://appleid.apple.com/auth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_mode=form_post&response_type=code&scope=email+name&state=x`
  );
  const appleProbe = { expectedCallback: 'https://ref.supabase.co/auth/v1/callback', bundleId: 'com.example.app' };
  assert.equal(assertAppleWebAuthorizeRedirect({
    ...appleProbe,
    status: 302,
    location: appleAuthorize('com.example.app.web'),
  }), 'com.example.app.web');
  // Production before the runbook's steps: the Apple provider serves only the app's native sign-in.
  assert.throws(() => assertAppleWebAuthorizeRedirect({
    ...appleProbe,
    status: 400,
    location: null,
    body: '{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: missing OAuth secret"}',
  }), /got HTTP 400: .*missing OAuth secret/);
  assert.throws(() => assertAppleWebAuthorizeRedirect({
    ...appleProbe,
    status: 302,
    location: appleAuthorize('com.example.app'),
  }), /Services ID first/);
  assert.throws(() => assertAppleWebAuthorizeRedirect({
    ...appleProbe,
    status: 302,
    location: appleAuthorize('com.example.app.web', 'https://auth.example.com/auth/v1/callback'),
  }), /not https:\/\/ref\.supabase\.co\/auth\/v1\/callback/);
  assert.throws(() => assertAppleWebAuthorizeRedirect({
    ...appleProbe,
    status: 302,
    location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
  }), /not Apple's authorize page/);
  // A custom domain, once active, is what Supabase sends Apple back to.
  assert.equal(assertAppleWebAuthorizeRedirect({
    ...appleProbe,
    expectedCallback: 'https://auth.example.com/auth/v1/callback',
    status: 302,
    location: appleAuthorize('com.example.app.web', 'https://auth.example.com/auth/v1/callback'),
  }), 'com.example.app.web');
  const clientIds = (external_apple_client_id, extra = {}) => ({
    config: { external_apple_client_id, ...extra },
    webClientId: 'com.example.app.web',
    bundleId: 'com.example.app',
  });
  assert.doesNotThrow(() => assertAppleClientIdsKeepNative(clientIds('com.example.app.web, com.example.app')));
  assert.doesNotThrow(() => assertAppleClientIdsKeepNative(clientIds('com.example.app.web', {
    external_apple_additional_client_ids: 'com.example.app',
  })));
  // The bundle id replaced by the Services ID: the redirect still looks right, the app's sign-in does not.
  assert.throws(() => assertAppleClientIdsKeepNative(clientIds('com.example.app.web')), /bundle id com\.example\.app is missing/);
  assert.throws(() => assertAppleClientIdsKeepNative(clientIds('com.example.app,com.example.app.web')), /start with com\.example\.app,? not/);
  console.log('production-external-gates self-test passed');
}

async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has('--self-test')) {
    selfTest();
    return;
  }
  if (args.has('--help') || args.has('-h')) {
    printUsage();
    return;
  }
  if (args.has('--print-supabase-auth-patch')) {
    console.log(JSON.stringify(buildSupabaseAuthPatch(), null, 2));
    return;
  }
  if (args.has('--apply-supabase-auth')) {
    await applySupabaseAuthPatch();
    runSupabaseAdvisorCheck();
    return;
  }
  if (args.has('--probe-revenuecat-webhook')) {
    await probeRevenueCatWebhook();
    return;
  }
  if (args.has('--probe-apple-web-sign-in')) {
    await probeAppleWebSignIn();
    return;
  }

  runSupabaseAdvisorCheck();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
