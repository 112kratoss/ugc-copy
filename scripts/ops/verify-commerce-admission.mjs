#!/usr/bin/env node
// Invalid-auth commerce probes: no credentials, purchases or provider calls.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { 'base-url': { type: 'string' } } });
const base = new URL(values['base-url']);
assert.equal(base.protocol, 'https:', '--base-url must use HTTPS');
const fixture='e85c0000-0000-4000-8000-000000000003';
const routes=[
'/api/marketplace/order','/api/marketplace/verify',
`/api/marketplace/assets/${fixture}/unlock-with-credits`,
`/api/posts/${fixture}/resource-bundle/order`,
`/api/posts/${fixture}/resource-bundle/verify`,
`/api/posts/${fixture}/resource-bundle/file-url`,
`/api/posts/${fixture}/resource-bundle/unlock-free`,
`/api/posts/${fixture}/resource-bundle/unlock-with-credits`,
];
for(const route of routes){
 const r=await fetch(new URL(route,base),{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer commerce-audit-invalid'},body:'{}',signal:AbortSignal.timeout(20000),redirect:'error'});
 await r.arrayBuffer();assert.equal(r.status,401,route);assert.match(r.headers.get('cache-control')??'',/no-store/,route);console.log('PASS',route);
}
console.log(JSON.stringify({passed:routes.length*2,checkedAt:new Date().toISOString()}));
