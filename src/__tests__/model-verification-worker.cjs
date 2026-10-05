/* eslint-disable @typescript-eslint/no-require-imports -- actual process-death fixture. */
const { readFileSync } = require('node:fs');
const { createClient } = require('@supabase/supabase-js');
const { BACKEND_JOBS_BY_NAME } = require('../lib/backend-jobs.ts');
const { runGenerationModelVerificationBackendJob } = require('../lib/backend-job-executions.ts');
const config = JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG, 'utf8'));
for (const endpoint of [config.API_URL, process.env.AUDIT_PROVIDER_URL]) {
  if (!['localhost', '127.0.0.1'].includes(new URL(endpoint).hostname)) throw Error('Local endpoints required');
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname !== 'api.kie.ai') throw Error('Unexpected provider host');
  const response = await originalFetch(process.env.AUDIT_PROVIDER_URL + url.pathname, init);
  if (process.env.AUDIT_STOP_PHASE === 'provider-completed') {
    process.send?.({ stage: 'provider-completed' }); await new Promise(() => {});
  }
  return response;
};
// Only this disposable worker shortens the real SQL lease; production is 840s.
BACKEND_JOBS_BY_NAME['generation-model-verification'].lockTtlSeconds = 2;
const serviceClient = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const response = await originalFetch(input, init);
    if (new URL(String(input)).pathname.endsWith('/generation_model_provider_checks') && init?.method === 'POST') {
      if (!response.ok) throw Error('Snapshot did not commit');
      process.send?.({ stage: 'snapshot-committed' }); await new Promise(() => {});
    }
    return response;
  } },
});
runGenerationModelVerificationBackendJob({ serviceClient, requestId: process.env.AUDIT_REQUEST_ID, startedAtMs: new Date('2007-01-01T00:06:00Z').getTime() })
  .then(() => process.send?.({ stage: 'unexpected-completion' }))
  .catch(() => { process.send?.({ stage: 'unexpected-failure' }); process.exitCode = 1; });
