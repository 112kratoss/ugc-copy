/* eslint-disable @typescript-eslint/no-require-imports -- real process-death fixture. */
const { readFileSync } = require('node:fs');
const { createClient } = require('@supabase/supabase-js');
const { executeInitialAccountDeletion, processAccountDeletionCleanup } = require('../lib/account-deletion-service.ts');
const config = JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG, 'utf8'));
if (!['localhost', '127.0.0.1'].includes(new URL(config.API_URL).hostname)) throw Error('Local API required');
if (!/^[a-f0-9-]{36}$/.test(process.env.AUDIT_OWNER_ID || '')) throw Error('Fixture identity required');
let authDeletes = 0;
const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (init?.method === 'DELETE' && new URL(String(input)).pathname.startsWith('/auth/v1/admin/users/') && response.ok) authDeletes++;
    const path = new URL(String(input)).pathname;
    const checkpoint = process.env.AUDIT_STOP_PHASE;
    const reached = checkpoint === 'copy-committed'
      ? path === '/storage/v1/object/copy' && init?.method === 'POST'
      : checkpoint === 'auth-deleted' && path === '/auth/v1/admin/users/' + process.env.AUDIT_OWNER_ID && init?.method === 'DELETE';
    if (reached) {
      if (!response.ok) throw Error('Checkpoint action failed');
      process.send?.({ stage: checkpoint });
      await new Promise(resolve => { if (process.env.AUDIT_ALLOW_RESUME === '1') process.once('message', message => { if (message === 'resume') resolve(); }); });
    }
    return response;
  } },
});
const execution = process.env.AUDIT_WORKER_MODE === 'cleanup'
  ? processAccountDeletionCleanup({ admin, workerId: 'audit-delete-child-' + process.env.AUDIT_OWNER_ID, limit: 1, leaseSeconds: 30 })
  : executeInitialAccountDeletion({ admin, userId: process.env.AUDIT_OWNER_ID });
execution
  .then(summary => {
    if (process.env.AUDIT_ALLOW_RESUME === '1') process.send?.({ stage: 'completed', summary, authDeletes }, () => process.disconnect());
    else process.send?.({ stage: 'unexpected-completion' });
  })
  .catch(() => { process.send?.({ stage: 'unexpected-failure' }); process.exitCode = 1; process.disconnect?.(); });
