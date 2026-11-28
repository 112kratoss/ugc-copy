#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'ildfmhozpibwiopeavfg';
const REVENUECAT_WEBHOOK_URL = process.env.REVENUECAT_WEBHOOK_URL
  || 'https://magicbooklet.com/api/mobile/commerce/revenuecat-webhook';
const DEFAULT_AUTH_DB_POOL_PERCENT = Number(process.env.SUPABASE_AUTH_DB_POOL_PERCENT || 17);
// The iPhone app's bundle id (ugc-mobile/app.json): Apple refuses the web flow with it as client.
const IOS_BUNDLE_ID = process.env.IOS_BUNDLE_ID || 'com.magicbooklet.mobile';
const SITE_AUTH_CALLBACK_URL = 'https://magicbooklet.com/auth/callback';
// The site's address when NEXT_PUBLIC_SITE_URL is not given, as in src/lib/seo.ts.
const DEFAULT_SITE_URL = 'https://magicbooklet.com';
// A return path nobody registers: Apple must refuse it, or the deletion probe cannot see a refusal.
const UNREGISTERED_RETURN_PATH = '/external-gates-unregistered-return';
// Where Supabase asks Google and Apple to return: the project's custom domain's
// callback since 2026-11-28 (the runbook's "Custom auth domain"). Set
// SUPABASE_AUTH_CALLBACK_URL to check another, as `https://<ref>.supabase.co/auth/v1/callback`
// after `supabase domains delete`, or a new domain's before `supabase domains activate`.
const SUPABASE_AUTH_CALLBACK_URL = process.env.SUPABASE_AUTH_CALLBACK_URL?.trim()
  || 'https://auth.magicbooklet.com/auth/v1/callback';
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
    // The monthly Apple secret workflow runs this unattended; a hung read must not eat its job.
    signal: AbortSignal.timeout(30_000),
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
    throw new Error(`Apple web sign-in probe failed: Apple is asked to return to ${target.searchParams.get('redirect_uri')}, not ${expectedCallback} (SUPABASE_AUTH_CALLBACK_URL names the callback expected; the runbook's "Custom auth domain" says which).`);
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

/**
 * Supabase's answer to a press of Continue with <provider> on the website,
 * asked at the project's own address (which every client still calls) unless
 * another origin is given: the redirect to the provider, unread. With no PKCE
 * challenge Supabase writes nothing for it.
 */
async function fetchSupabaseAuthorizeRedirect(provider, origin = `https://${PROJECT_REF}.supabase.co`) {
  const url = new URL('/auth/v1/authorize', origin);
  url.searchParams.set('provider', provider);
  url.searchParams.set('redirect_to', SITE_AUTH_CALLBACK_URL);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const location = response.headers.get('location');
  const body = location ? '' : await response.text();
  return { status: response.status, location, body };
}

/**
 * Every sign-in comes back through the callback's host, so a provider that
 * takes the callback is no help while that host does not answer for the
 * project: its DNS records gone, its certificate lapsed (Node's fetch checks
 * it), or Supabase not serving the domain. Asked the same question at its
 * authorize route, the host must answer as the project's address does.
 * Returns the host's origin.
 */
async function assertCallbackHostAnswers({ provider, clientId, assertRedirect, label }) {
  const origin = new URL(SUPABASE_AUTH_CALLBACK_URL).origin;
  try {
    const hostClientId = assertRedirect(await fetchSupabaseAuthorizeRedirect(provider, origin));
    if (hostClientId !== clientId) {
      throw new Error(`it names the client ${hostClientId}, not ${clientId}`);
    }
  } catch (error) {
    const reason = error?.cause?.code || error?.cause?.message
      || String(error instanceof Error ? error.message : error).replace(/^.*? probe failed: /, '');
    throw new Error(`${label} probe failed: the callback's host ${origin} does not answer as the project's address does (${reason}). The runbook's "Custom auth domain" lists its DNS records.`);
  }
  return origin;
}

/** Where Supabase sends the website's Continue with Apple: Apple's authorize address and its client id. */
async function readSupabaseAppleRedirect() {
  const answer = await fetchSupabaseAuthorizeRedirect('apple');
  return { clientId: assertAppleWebAuthorizeRedirect(answer), location: answer.location };
}

/**
 * Where Supabase sends the website's Continue with Apple, and that the
 * callback's host answers. It does not ask Apple whether it takes the
 * callback: --probe-auth-callback-registrations does.
 */
export async function probeAppleWebSignIn() {
  const { clientId } = await readSupabaseAppleRedirect();
  const host = await assertCallbackHostAnswers({
    provider: 'apple',
    clientId,
    assertRedirect: assertAppleWebAuthorizeRedirect,
    label: 'Apple web sign-in',
  });
  console.log(`Apple web sign-in probe: Supabase sends Continue with Apple to Apple as ${clientId}, back to ${SUPABASE_AUTH_CALLBACK_URL}, and ${host} answers for the project`);

  const token = process.env.SUPABASE_MANAGEMENT_API_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    console.log(`Not checked without SUPABASE_MANAGEMENT_API_TOKEN: that ${IOS_BUNDLE_ID} is still in the Apple provider's Client IDs. Sign in with Apple in the iPhone app to check it.`);
    return;
  }
  assertAppleClientIdsKeepNative({ config: await fetchAuthConfig(token), webClientId: clientId });
  console.log(`Apple provider check: ${IOS_BUNDLE_ID} is still listed for the iPhone's native sign-in`);
}

/**
 * What Apple's authorize page says of a request, read from the page's
 * `boot_args` JSON (as it was on 2026-11-02): a request it takes carries its
 * sign-in form's settings (`direct.appleOAuth`); one it refuses carries the
 * refusal (`direct.errorCode`: `invalid_client` for a client it does not know,
 * `invalid_request` with "Invalid web redirect url." for a return URL it was
 * not given). A page that says neither throws rather than pass.
 */
function readAppleAuthorizePage({ status, html, url }) {
  const bootArgs = /<script[^>]*class="boot_args"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ''));
  let direct = null;
  try {
    direct = JSON.parse(bootArgs[1]).direct;
  } catch {
    // Read below as a page that says neither.
  }
  if (direct && typeof direct === 'object') {
    if (direct.errorCode) {
      return { refused: true, errorCode: String(direct.errorCode), errorMessage: String(direct.errorMessage || '') };
    }
    if (direct.appleOAuth && typeof direct.appleOAuth === 'object') return { refused: false };
  }
  throw new Error(`Apple's authorize page (HTTP ${status}) says neither that it takes the request nor that it refuses it; open ${url} in a browser to check it.`);
}

function siteUrlFromEnv() {
  return process.env.NEXT_PUBLIC_SITE_URL?.trim() || null;
}

/**
 * Where Apple returns the deletion page's Continue with Apple: /delete-account
 * on the site's address, which the site reads from NEXT_PUBLIC_SITE_URL
 * (src/lib/apple-web-reauthentication.ts, held equal for the same variable by
 * production-external-gates-script.test.ts).
 */
export function siteAppleDeletionReturnUrl(siteUrl = siteUrlFromEnv() ?? DEFAULT_SITE_URL) {
  return new URL('/delete-account', siteUrl).toString();
}

/**
 * Apple's authorize page as the deletion page opens it: no scope, the code in
 * the fragment, back to the deletion page.
 */
export function buildAppleDeletionAuthorizeUrl(clientId, returnUrl = siteAppleDeletionReturnUrl()) {
  const url = new URL('https://appleid.apple.com/auth/authorize');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: returnUrl,
    response_type: 'code',
    response_mode: 'fragment',
    state: 'external-gates-probe',
  }).toString();
  return url.toString();
}

async function fetchAppleAuthorizePage(url) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  return readAppleAuthorizePage({ status: response.status, html: await response.text(), url });
}

/**
 * Apple's answer to the deletion page's Continue with Apple, before
 * NEXT_PUBLIC_APPLE_SERVICES_ID turns it on: the Services ID must take
 * /delete-account on the site's address as a return URL. Two controls go
 * first, so a pass means something: Apple takes Supabase's own sign-in request,
 * and refuses a return URL nobody registered on the same host. Given
 * NEXT_PUBLIC_APPLE_SERVICES_ID, the value Vercel holds, it must be the
 * Services ID Supabase asks Apple as; given NEXT_PUBLIC_SITE_URL, Vercel's
 * value, the return URL is on that address.
 */
async function probeAppleWebDeletion() {
  const returnUrl = siteAppleDeletionReturnUrl();
  const unregisteredUrl = new URL(UNREGISTERED_RETURN_PATH, returnUrl).toString();
  const { clientId, location } = await readSupabaseAppleRedirect();
  const configured = process.env.NEXT_PUBLIC_APPLE_SERVICES_ID?.trim();
  if (configured && configured !== clientId) {
    throw new Error(`Apple web deletion probe failed: NEXT_PUBLIC_APPLE_SERVICES_ID is ${configured}, but Supabase's Continue with Apple asks Apple as ${clientId}; give both the one Services ID.`);
  }
  const signIn = await fetchAppleAuthorizePage(location);
  if (signIn.refused) {
    throw new Error(`Apple web deletion probe failed: Apple refuses even Supabase's sign-in request (${signIn.errorMessage} ${signIn.errorCode}); run --probe-apple-web-sign-in and the runbook's "Sign in with Apple on the web" first.`);
  }
  const unregistered = await fetchAppleAuthorizePage(buildAppleDeletionAuthorizeUrl(clientId, unregisteredUrl));
  if (!unregistered.refused) {
    throw new Error(`Apple web deletion probe failed: Apple took ${unregisteredUrl}, which nobody registered, so this probe cannot see its refusals.`);
  }
  const deletion = await fetchAppleAuthorizePage(buildAppleDeletionAuthorizeUrl(clientId, returnUrl));
  if (deletion.refused) {
    throw new Error(`Apple web deletion probe failed: Apple refuses ${returnUrl} for ${clientId}: ${deletion.errorMessage} (${deletion.errorCode}). Add it to the Services ID's Return URLs, with ${new URL(returnUrl).host} among its Domains.`);
  }
  console.log(`Apple web deletion probe: Apple takes ${returnUrl} as a return URL for ${clientId}`);
  if (!configured) {
    console.log(`Not checked without NEXT_PUBLIC_APPLE_SERVICES_ID: that Vercel holds ${clientId}. Run again with the variable set to Vercel's value.`);
  }
  if (!siteUrlFromEnv()) {
    console.log(`Not checked without NEXT_PUBLIC_SITE_URL: that the site's address is ${DEFAULT_SITE_URL}. Run again with the variable set to Vercel's value.`);
  }
}

/**
 * Where Supabase sends Continue with Google, on the website and in both apps
 * (they open the same address): Google's authorize page, for an OAuth client,
 * returning to Supabase's callback. Google's account page names that
 * callback's site ("to continue to magicbooklet.com" since the custom domain).
 */
function assertGoogleWebAuthorizeRedirect({
  status,
  location,
  body,
  expectedCallback = SUPABASE_AUTH_CALLBACK_URL,
}) {
  if (status < 300 || status > 399 || !location) {
    throw new Error(`Google sign-in probe failed: expected a redirect to Google, got HTTP ${status}${body ? `: ${String(body).slice(0, 200)}` : ''}.`);
  }
  const target = new URL(location);
  if (target.origin !== 'https://accounts.google.com' || !target.pathname.startsWith('/o/oauth2/')) {
    throw new Error(`Google sign-in probe failed: redirected to ${target.origin}${target.pathname}, not Google's authorize page.`);
  }
  const clientId = target.searchParams.get('client_id') || '';
  if (!clientId) {
    throw new Error('Google sign-in probe failed: the redirect names no client_id.');
  }
  if (target.searchParams.get('redirect_uri') !== expectedCallback) {
    throw new Error(`Google sign-in probe failed: Google is asked to return to ${target.searchParams.get('redirect_uri')}, not ${expectedCallback} (SUPABASE_AUTH_CALLBACK_URL names the callback expected; the runbook's "Custom auth domain" says which).`);
  }
  return clientId;
}

/**
 * What Google says of an authorize request, read from where it sends a
 * browser with no Google session (as it was on 2026-11-28): its sign-in page
 * (`/v3/signin/identifier`) when it takes the client and the return URL, its
 * error page (`/signin/oauth/error`) when the return URL is not one of the
 * client's (redirect_uri_mismatch) or it does not know the client. Anything
 * else throws rather than pass.
 */
function readGoogleAuthorizeAnswer({ status, location }) {
  if (status >= 300 && status <= 399 && location) {
    const target = new URL(location, 'https://accounts.google.com');
    if (target.origin === 'https://accounts.google.com') {
      if (target.pathname.startsWith('/signin/oauth/error')) return { refused: true };
      if (/^\/(v3\/signin\/(?!rejected)|ServiceLogin)/.test(target.pathname)) return { refused: false };
    }
  }
  throw new Error(`Google's authorize page (HTTP ${status}${location ? `, to ${String(location).split('?')[0]}` : ''}) says neither that it takes the request nor that it refuses it.`);
}

/** Google's authorize page for a client and a return URL, as Supabase opens it. */
function buildGoogleAuthorizeUrl(clientId, returnUrl) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: returnUrl,
    response_type: 'code',
    scope: 'email profile',
    state: 'external-gates-probe',
  }).toString();
  return url.toString();
}

/** Apple's authorize page for the web sign-in, as Supabase opens it: the code posted back to the return URL. */
function buildAppleSignInAuthorizeUrl(clientId, returnUrl) {
  const url = new URL('https://appleid.apple.com/auth/authorize');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: returnUrl,
    response_mode: 'form_post',
    response_type: 'code',
    scope: 'email name',
    state: 'external-gates-probe',
  }).toString();
  return url.toString();
}

async function fetchGoogleAuthorizeAnswer(url) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  return readGoogleAuthorizeAnswer({ status: response.status, location: response.headers.get('location') });
}

/**
 * Supabase's own request to Google with only its return URL changed, so a
 * control differs from the real request in nothing else.
 */
function withRedirectUri(authorizeUrl, returnUrl) {
  const url = new URL(authorizeUrl);
  url.searchParams.set('redirect_uri', returnUrl);
  return url.toString();
}

/**
 * Continue with Google: Supabase sends Google back to SUPABASE_AUTH_CALLBACK_URL,
 * and Google takes it for the client. The same request with a return URL
 * nobody registered on the same host goes first and must be refused, so a pass
 * means the probe can see a refusal. Google's answer is read without a Google
 * session, so nothing signs in. The callback's host must answer too.
 */
export async function probeGoogleWebSignIn() {
  const answer = await fetchSupabaseAuthorizeRedirect('google');
  const clientId = assertGoogleWebAuthorizeRedirect(answer);
  const host = await assertCallbackHostAnswers({
    provider: 'google',
    clientId,
    assertRedirect: assertGoogleWebAuthorizeRedirect,
    label: 'Google sign-in',
  });
  const unregisteredUrl = new URL(UNREGISTERED_RETURN_PATH, SUPABASE_AUTH_CALLBACK_URL).toString();
  if (!(await fetchGoogleAuthorizeAnswer(withRedirectUri(answer.location, unregisteredUrl))).refused) {
    throw new Error(`Google sign-in probe failed: Google took ${unregisteredUrl}, which nobody registered, so this probe cannot see its refusals.`);
  }
  if ((await fetchGoogleAuthorizeAnswer(answer.location)).refused) {
    throw new Error(`Google sign-in probe failed: Google refuses ${SUPABASE_AUTH_CALLBACK_URL} for ${clientId}. Add it to the OAuth client's Authorized redirect URIs (Google Cloud project magicbooklet).`);
  }
  console.log(`Google sign-in probe: Supabase sends Continue with Google to Google as ${clientId}, back to ${SUPABASE_AUTH_CALLBACK_URL}, Google takes it, and ${host} answers for the project`);
}

/**
 * Before `supabase domains activate` (or `delete`): whether Google and Apple
 * already take SUPABASE_AUTH_CALLBACK_URL, the callback Supabase will send them
 * to, for the clients Supabase uses today. Activation sends every sign-in
 * there at once, so a provider that refuses it would fail them all. A return
 * URL nobody registered on the same host must be refused by each first. It
 * does not ask the callback's host, which answers only once its domain is active.
 */
export async function probeAuthCallbackRegistrations() {
  const callback = SUPABASE_AUTH_CALLBACK_URL;
  const unregisteredUrl = new URL(UNREGISTERED_RETURN_PATH, callback).toString();
  const clientOf = async (provider) => {
    const { status, location, body } = await fetchSupabaseAuthorizeRedirect(provider);
    const clientId = location ? new URL(location).searchParams.get('client_id') : null;
    if (!clientId) {
      throw new Error(`Callback registration probe failed: Supabase's Continue with ${provider} names no client (HTTP ${status}${body ? `: ${String(body).slice(0, 200)}` : ''}).`);
    }
    return clientId;
  };
  const failures = [];

  const googleClient = await clientOf('google');
  if (!(await fetchGoogleAuthorizeAnswer(buildGoogleAuthorizeUrl(googleClient, unregisteredUrl))).refused) {
    throw new Error(`Callback registration probe failed: Google took ${unregisteredUrl}, which nobody registered, so this probe cannot see its refusals.`);
  }
  if ((await fetchGoogleAuthorizeAnswer(buildGoogleAuthorizeUrl(googleClient, callback))).refused) {
    failures.push(`Google refuses ${callback} for ${googleClient}: add it to the OAuth client's Authorized redirect URIs (Google Cloud project magicbooklet), keeping the others.`);
  } else {
    console.log(`Google takes ${callback} for ${googleClient}`);
  }

  const appleClient = await clientOf('apple');
  const appleUnregistered = await fetchAppleAuthorizePage(buildAppleSignInAuthorizeUrl(appleClient, unregisteredUrl));
  if (!appleUnregistered.refused) {
    throw new Error(`Callback registration probe failed: Apple took ${unregisteredUrl}, which nobody registered, so this probe cannot see its refusals.`);
  }
  const apple = await fetchAppleAuthorizePage(buildAppleSignInAuthorizeUrl(appleClient, callback));
  if (apple.refused) {
    failures.push(`Apple refuses ${callback} for ${appleClient}: ${apple.errorMessage} (${apple.errorCode}). Add it to the Services ID's Return URLs, with ${new URL(callback).host} among its Domains.`);
  } else {
    console.log(`Apple takes ${callback} for ${appleClient}`);
  }

  if (failures.length > 0) {
    throw new Error(`Callback registration probe failed:\n- ${failures.join('\n- ')}`);
  }
  console.log(`Callback registration probe: both providers take ${callback}`);
}

function printUsage() {
  console.log(`Usage:
  node scripts/ops/production-external-gates.mjs [--check]
  node scripts/ops/production-external-gates.mjs --print-supabase-auth-patch
  SUPABASE_MANAGEMENT_API_TOKEN=... node scripts/ops/production-external-gates.mjs --apply-supabase-auth
  REVENUECAT_WEBHOOK_AUTH_TOKEN='Bearer ...' node scripts/ops/production-external-gates.mjs --probe-revenuecat-webhook
  node scripts/ops/production-external-gates.mjs --probe-apple-web-sign-in
  NEXT_PUBLIC_APPLE_SERVICES_ID=... node scripts/ops/production-external-gates.mjs --probe-apple-web-deletion
  node scripts/ops/production-external-gates.mjs --probe-google-sign-in
  SUPABASE_AUTH_CALLBACK_URL=https://<host>/auth/v1/callback node scripts/ops/production-external-gates.mjs --probe-auth-callback-registrations

The sign-in probes expect Supabase to send Google and Apple back to
${SUPABASE_AUTH_CALLBACK_URL}
(SUPABASE_AUTH_CALLBACK_URL overrides it). --probe-auth-callback-registrations
asks both providers whether they take that callback, whatever Supabase sends
them today: run it before \`supabase domains activate\` or \`delete\`.

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
  const applePage = (direct) => `<html><script type="application/json" class="boot_args">
    ${JSON.stringify({ direct, additional: { formStyle: 'eyebrow' } })}
</script></html>`;
  const page = (direct, status = 200) => ({ status, html: applePage(direct), url: 'https://appleid.apple.com/auth/authorize?client_id=x' });
  // Apple's pages as they were on 2026-11-02: Supabase's request, a client it does not know, a return URL it was not given.
  assert.deepEqual(readAppleAuthorizePage(page({ appleOAuth: { requestor: {} }, step: 'signin', urlContext: '' })), { refused: false });
  assert.deepEqual(readAppleAuthorizePage(page({ urlContext: '', errorMessage: 'Invalid client.', errorCode: 'invalid_client' })), {
    refused: true,
    errorCode: 'invalid_client',
    errorMessage: 'Invalid client.',
  });
  assert.deepEqual(readAppleAuthorizePage(page({ urlContext: '', errorMessage: 'Invalid web redirect url.', errorCode: 'invalid_request' })), {
    refused: true,
    errorCode: 'invalid_request',
    errorMessage: 'Invalid web redirect url.',
  });
  // A page that says neither proves nothing, so the probe stops and says where to look.
  const saysNeither = /says neither .* open https:\/\/appleid\.apple\.com\/auth\/authorize\?client_id=x/;
  assert.throws(() => readAppleAuthorizePage(page({ urlContext: '' })), saysNeither);
  assert.throws(() => readAppleAuthorizePage({ ...page(null, 503), html: '<html>Service Unavailable</html>' }), /HTTP 503\) says neither/);
  // Apple's verdict under another key: the page no longer says either.
  assert.throws(() => readAppleAuthorizePage({ ...page(null), html: applePage({ appleOAuth: {} }).replace('"direct"', '"moved"') }), saysNeither);
  assert.deepEqual(
    Object.fromEntries(new URL(buildAppleDeletionAuthorizeUrl('com.example.app.web', 'https://site.example/delete-account')).searchParams),
    {
      client_id: 'com.example.app.web',
      redirect_uri: 'https://site.example/delete-account',
      response_type: 'code',
      response_mode: 'fragment',
      state: 'external-gates-probe',
    },
  );
  const googleAuthorize = (clientId, redirectUri) => (
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_to=https%3A%2F%2Fsite.example%2Fauth%2Fcallback&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=email+profile&state=x`
  );
  const googleProbe = { expectedCallback: 'https://auth.example.com/auth/v1/callback' };
  // Supabase's redirect as it was on 2026-11-28, once the custom domain was active.
  assert.equal(assertGoogleWebAuthorizeRedirect({
    ...googleProbe,
    status: 302,
    location: googleAuthorize('123-abc.apps.googleusercontent.com', 'https://auth.example.com/auth/v1/callback'),
  }), '123-abc.apps.googleusercontent.com');
  // Before activation, or after `supabase domains delete`: the project's own callback.
  assert.throws(() => assertGoogleWebAuthorizeRedirect({
    ...googleProbe,
    status: 302,
    location: googleAuthorize('123-abc.apps.googleusercontent.com', 'https://ref.supabase.co/auth/v1/callback'),
  }), /return to https:\/\/ref\.supabase\.co\/auth\/v1\/callback, not https:\/\/auth\.example\.com/);
  assert.throws(() => assertGoogleWebAuthorizeRedirect({
    ...googleProbe,
    status: 400,
    location: null,
    body: '{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider is not enabled"}',
  }), /got HTTP 400: .*provider is not enabled/);
  assert.throws(() => assertGoogleWebAuthorizeRedirect({
    ...googleProbe,
    status: 302,
    location: 'https://appleid.apple.com/auth/authorize?client_id=x',
  }), /not Google's authorize page/);
  assert.throws(() => assertGoogleWebAuthorizeRedirect({
    ...googleProbe,
    status: 302,
    location: 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fauth.example.com%2Fauth%2Fv1%2Fcallback',
  }), /names no client_id/);
  // Google's answers without a session, as they were on 2026-11-28: a registered return URL, then an unregistered one or an unknown client.
  assert.deepEqual(readGoogleAuthorizeAnswer({ status: 302, location: 'https://accounts.google.com/v3/signin/identifier?opparams=x&flowName=GeneralOAuthFlow' }), { refused: false });
  assert.deepEqual(readGoogleAuthorizeAnswer({ status: 302, location: 'https://accounts.google.com/signin/oauth/error?authError=x&client_id=y' }), { refused: true });
  // A page that says neither proves nothing.
  assert.throws(() => readGoogleAuthorizeAnswer({ status: 200, location: null }), /HTTP 200\) says neither/);
  assert.throws(() => readGoogleAuthorizeAnswer({ status: 302, location: 'https://example.com/v3/signin/identifier' }), /says neither/);
  // Another of Google's pages (a refusal of the caller, say) is neither, not a pass.
  assert.throws(() => readGoogleAuthorizeAnswer({ status: 302, location: 'https://accounts.google.com/signin/rejected?rrk=1' }), /says neither/);
  assert.throws(() => readGoogleAuthorizeAnswer({ status: 302, location: 'https://accounts.google.com/v3/signin/rejected?rrk=1' }), /says neither/);
  // A Location relative to Google's own host, and the older sign-in page.
  assert.deepEqual(readGoogleAuthorizeAnswer({ status: 302, location: '/v3/signin/identifier?opparams=x' }), { refused: false });
  assert.deepEqual(readGoogleAuthorizeAnswer({ status: 302, location: '/signin/oauth/error?authError=x' }), { refused: true });
  assert.deepEqual(readGoogleAuthorizeAnswer({ status: 302, location: 'https://accounts.google.com/ServiceLogin?continue=x' }), { refused: false });
  // A look-alike host is neither.
  assert.throws(() => readGoogleAuthorizeAnswer({ status: 302, location: 'https://accounts.google.com.example/v3/signin/identifier' }), /says neither/);
  assert.deepEqual(
    Object.fromEntries(new URL(buildGoogleAuthorizeUrl('123-abc.apps.googleusercontent.com', 'https://auth.example.com/auth/v1/callback')).searchParams),
    {
      client_id: '123-abc.apps.googleusercontent.com',
      redirect_uri: 'https://auth.example.com/auth/v1/callback',
      response_type: 'code',
      scope: 'email profile',
      state: 'external-gates-probe',
    },
  );
  // The sign-in probe's control is Supabase's own request with only the return URL changed.
  const supabaseGoogleRequest = googleAuthorize('123-abc.apps.googleusercontent.com', 'https://auth.example.com/auth/v1/callback');
  assert.deepEqual(
    Object.fromEntries(new URL(withRedirectUri(supabaseGoogleRequest, 'https://auth.example.com/external-gates-unregistered-return')).searchParams),
    {
      ...Object.fromEntries(new URL(supabaseGoogleRequest).searchParams),
      redirect_uri: 'https://auth.example.com/external-gates-unregistered-return',
    },
  );
  assert.deepEqual(
    Object.fromEntries(new URL(buildAppleSignInAuthorizeUrl('com.example.app.web', 'https://auth.example.com/auth/v1/callback')).searchParams),
    {
      client_id: 'com.example.app.web',
      redirect_uri: 'https://auth.example.com/auth/v1/callback',
      response_mode: 'form_post',
      response_type: 'code',
      scope: 'email name',
      state: 'external-gates-probe',
    },
  );
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
  if (args.has('--probe-apple-web-deletion')) {
    await probeAppleWebDeletion();
    return;
  }
  if (args.has('--probe-google-sign-in')) {
    await probeGoogleWebSignIn();
    return;
  }
  if (args.has('--probe-auth-callback-registrations')) {
    await probeAuthCallbackRegistrations();
    return;
  }

  runSupabaseAdvisorCheck();
}

// Run as a command, not when a test imports the builders above. Node runs a
// script by its real path, so a path through a symlink (macOS's /tmp is one)
// is compared as the file it names.
function isRunAsCommand() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isRunAsCommand()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
