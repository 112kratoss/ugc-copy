/* eslint-disable @typescript-eslint/no-require-imports -- actual process-death fixture. */
const { readFileSync } = require('node:fs');
const { createClient } = require('@supabase/supabase-js');
const { maintainFeedPersonalization } = require('../lib/feed-maintenance.ts');
const config = JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG, 'utf8'));
if (!['localhost', '127.0.0.1'].includes(new URL(config.API_URL).hostname)) throw Error('Local API required');
const client = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (new URL(String(input)).pathname === '/rest/v1/rpc/' + process.env.AUDIT_STOP_PHASE) {
      if (!response.ok) throw Error('Checkpoint RPC failed');
      process.send?.({ stage: 'rpc-committed' }); await new Promise(() => {});
    }
    return response;
  } },
});
maintainFeedPersonalization(client, { now: new Date('1805-01-02T00:00:00Z'), invalidateFeedCache: () => {} })
  .catch(() => { process.send?.({ stage: 'unexpected-failure' }); process.exitCode = 1; });
