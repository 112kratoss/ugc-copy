import { createClient } from '@supabase/supabase-js';

import {
  buildBacklogSeedPlan,
  buildStorageDriftReport,
  seedBacklogIntents,
  type BacklogCategory,
} from '../src/lib/media-upload-backlog-seed';
import { parseBackfillExecutionMode, logBackfillExecutionMode } from './backfill-execution-mode.mjs';

/**
 * Seeds `media_upload_intents` rows for staged uploads that predate the tracking
 * table, so the daily reclaim sweep can collect them.
 *
 * Read-only unless --execute --project-ref=<ref> is given.
 */

const CATEGORY_LABELS: Record<BacklogCategory, string> = {
  durable_copy_exists: 'durable copy exists (seeded consumed; collectable in 48h)',
  legacy_generation_reference: 'still read by a generation with no durable rows (guarded)',
  unreferenced: 'unreferenced (behind MEDIA_UPLOAD_RECLAIM_ABANDONED)',
};

function formatBytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function runMediaUploadIntentBackfill(
  argv: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
) {
  const supabaseUrl = environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }

  const mode = parseBackfillExecutionMode({ argv, supabaseUrl });
  // The repo hand-toggles .env.local between local and production, so the target
  // is always stated before anything is read or written.
  console.log(`Target: ${supabaseUrl}`);
  logBackfillExecutionMode(mode);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });

  const plan = await buildBacklogSeedPlan(supabase);
  console.log(`\nStaged objects already tracked: ${plan.alreadyTracked}`);
  console.log(`Staged objects to seed: ${plan.objects.length}`);
  for (const [category, label] of Object.entries(CATEGORY_LABELS) as Array<[BacklogCategory, string]>) {
    const count = plan.counts[category];
    console.log(`  ${count.objects.toString().padStart(4)} objects  ${formatBytes(count.bytes).padStart(9)}  ${label}`);
  }

  if (plan.unattributable.objects > 0) {
    // No intent row can exist for these: user_id is NOT NULL and references
    // auth.users, and their paths predate the {userId}/... layout. They are
    // reported rather than skipped quietly, because they are real bytes this
    // system will never collect on its own.
    console.log(`\n${plan.unattributable.objects} objects (${formatBytes(plan.unattributable.bytes)}) cannot be tracked:`);
    console.log('  their paths predate the {userId}/... layout, so no owner can be derived.');
    for (const path of plan.unattributable.samplePaths) {
      console.log(`    ${path}`);
    }
    if (plan.unattributable.objects > plan.unattributable.samplePaths.length) {
      console.log(`    ... and ${plan.unattributable.objects - plan.unattributable.samplePaths.length} more`);
    }
    console.log('  Verify they are unreferenced, then remove them manually if so.');
  }

  const drift = await buildStorageDriftReport(supabase);
  console.log('\nDurable copy drift (reported only, never repaired here):');
  console.log(`  ${drift.orphanedObjects.length} generation_inputs objects with no row`);
  console.log(`  ${drift.missingObjects.length} rows whose object is missing (these block account deletion)`);
  for (const path of drift.missingObjects.slice(0, 20)) {
    console.log(`    missing: ${path}`);
  }
  if (drift.missingObjects.length > 20) {
    console.log(`    ... and ${drift.missingObjects.length - 20} more`);
  }

  if (mode.dryRun) {
    console.log('\nDry run complete. No rows were written.');
    return;
  }

  const { inserted } = await seedBacklogIntents(supabase, plan.objects);
  console.log(`\nSeeded ${inserted} upload intent rows.`);
  console.log('The daily media-upload-reclaim job collects them once they pass the reclaim window.');
}

const isMain = process.argv[1]
  ? import.meta.url === new URL(`file://${process.argv[1]}`).href
  : false;

if (isMain) {
  runMediaUploadIntentBackfill().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
