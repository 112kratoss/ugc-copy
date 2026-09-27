#!/usr/bin/env node
// Invalid webhook/unauthenticated checkout probes. No credentials, provider
// requests, purchases, or fixture writes. Requires an explicit HTTPS origin.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'base-url': { type: 'string' } } });
const base = new URL(values['base-url']);
assert(base.protocol === 'https:', '--base-url must use HTTPS.');
const cases = [
  ['Razorpay requires signature', '/api/razorpay/webhook', {}, '{}', 400],
  ['Razorpay rejects forged signature', '/api/razorpay/webhook', { 'x-razorpay-signature': '0'.repeat(64) }, '{}', 400],
  ['Razorpay authenticates before parsing', '/api/razorpay/webhook', { 'x-razorpay-signature': 'invalid' }, '{', 400],
  ['Razorpay bounds request body', '/api/razorpay/webhook', {}, 'x'.repeat(256 * 1024 + 1), 413],
  ['RevenueCat requires authorization', '/api/mobile/commerce/revenuecat-webhook', {}, '{}', 401],
  ['RevenueCat rejects forged authorization', '/api/mobile/commerce/revenuecat-webhook', { authorization: 'Bearer audit-invalid-token' }, '{}', 401],
  ['RevenueCat authenticates before parsing', '/api/mobile/commerce/revenuecat-webhook', {}, '{', 401],
  ['Checkout requires signed-in identity', '/api/razorpay/order', {}, JSON.stringify({ planId: 'starter' }), 401],
  ['Verification rejects missing payment evidence', '/api/razorpay/verify', {}, '{}', 400],
];
let passed = 0;
for (const [label, route, headers, body, status] of cases) {
  const response = await fetch(new URL(route, base), {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
    signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  await response.arrayBuffer();
  assert.equal(response.status, status, label);
  passed++;
  assert.match(response.headers.get('cache-control') ?? '', /no-store/, `${label}: private response`);
  passed++;
  console.log(`PASS ${label}`);
}
console.log(JSON.stringify({ base: base.origin, checkedAt: new Date().toISOString(), passed }));
