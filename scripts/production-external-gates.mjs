#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'ildfmhozpibwiopeavfg';
const REVENUECAT_WEBHOOK_URL = process.env.REVENUECAT_WEBHOOK_URL
  || 'https://magicbooklet.com/api/mobile/commerce/revenuecat-webhook';
const DEFAULT_AUTH_DB_POOL_PERCENT = Number(process.env.SUPABASE_AUTH_DB_POOL_PERCENT || 17);
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

function printUsage() {
  console.log(`Usage:
  node scripts/production-external-gates.mjs [--check]
  node scripts/production-external-gates.mjs --print-supabase-auth-patch
  SUPABASE_MANAGEMENT_API_TOKEN=... node scripts/production-external-gates.mjs --apply-supabase-auth
  REVENUECAT_WEBHOOK_AUTH_TOKEN='Bearer ...' node scripts/production-external-gates.mjs --probe-revenuecat-webhook

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

  runSupabaseAdvisorCheck();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
