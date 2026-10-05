/* eslint-disable @typescript-eslint/no-require-imports -- real process-death fixture. */
const { readFileSync } = require('node:fs');
const { createClient } = require('@supabase/supabase-js');
const { BACKEND_JOBS_BY_NAME } = require('../lib/backend-jobs.ts');
const { runBackendAlertDeliveryJob } = require('../lib/backend-job-executions.ts');
const config = JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG, 'utf8'));
for (const url of [config.API_URL, process.env.BACKEND_ALERT_DELIVERY_URL]) {
  if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw Error('Local endpoints required');
}
// Exercise real expiry after process death without a fourteen-minute fixture.
// Only this disposable child's registry object changes; production remains 840s.
BACKEND_JOBS_BY_NAME['backend-alert-delivery'].lockTtlSeconds = 2;
const serviceClient = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
runBackendAlertDeliveryJob({ serviceClient, requestId: process.env.AUDIT_REQUEST_ID })
  .then(() => process.send?.({ stage: 'unexpected-completion' }))
  .catch(() => { process.send?.({ stage: 'unexpected-failure' }); process.exitCode = 1; });
