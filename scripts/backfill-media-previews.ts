import { createClient } from '@supabase/supabase-js';

import {
  hasRepairableMediaPreviews,
  repairMediaPreviews,
} from '../src/lib/media-preview-repair';
import {
  logBackfillExecutionMode,
  parseBackfillExecutionMode,
} from './backfill-execution-mode.mjs';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey);
const executionMode = parseBackfillExecutionMode({ supabaseUrl });
logBackfillExecutionMode(executionMode);
let totals = { attempted: 0, completed: 0, failed: 0 };

async function main() {
  if (executionMode.dryRun) {
    const hasRepairableRows = await hasRepairableMediaPreviews(supabase);
    console.log(hasRepairableRows
      ? 'Repairable media previews were found; no repair was attempted.'
      : 'No repairable media previews were found.');
    return;
  }

  for (let pass = 1; pass <= 100; pass += 1) {
    const summary = await repairMediaPreviews(supabase, { batchSize: 200 });
    totals = {
      attempted: totals.attempted + summary.attempted,
      completed: totals.completed + summary.completed,
      failed: totals.failed + summary.failed,
    };
    console.log(`[pass ${pass}]`, summary);
    if (summary.attempted === 0) break;
  }

  console.log('Media preview backfill complete:', totals);
  const [generationFailures, postFailures] = await Promise.all([
    supabase.from('generations').select('id', { count: 'exact', head: true }).eq('preview_status', 'failed').gte('preview_attempt_count', 3),
    supabase.from('post_media').select('id', { count: 'exact', head: true }).eq('preview_status', 'failed').gte('preview_attempt_count', 3),
  ]);
  if (generationFailures.error) throw generationFailures.error;
  if (postFailures.error) throw postFailures.error;
  const unresolved = (generationFailures.count ?? 0) + (postFailures.count ?? 0);
  console.log(`Unresolved after three attempts: ${unresolved}`);
  if (unresolved > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
