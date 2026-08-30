import { createClient } from '@supabase/supabase-js';

import {
  ACCOUNT_IDENTITY_FINGERPRINT_TABLE,
  deriveAccountIdentityFingerprints,
  recordClaimedIdentityFingerprints,
} from '../src/lib/account-identity-fingerprint';
import { parseBackfillExecutionMode, logBackfillExecutionMode } from './backfill-execution-mode.mjs';

/**
 * Records identity fingerprints for credit grants that predate the durable
 * claim ledger (20260829120000). Without this, the accounts that claimed
 * before the ledger existed could delete and re-claim once each.
 *
 * Read-only unless --execute --project-ref=<ref> is given.
 *
 * The digests must match what the production runtime derives, so run this with
 * the same secret resolution: either ACCOUNT_IDENTITY_FINGERPRINT_SECRET set to
 * the production value, or (fallback) the production SUPABASE_SERVICE_ROLE_KEY,
 * which .env.local already carries when pointed at production.
 */

export async function runWelcomeCreditFingerprintBackfill(
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
  console.log(`Fingerprint secret: ${environment.ACCOUNT_IDENTITY_FINGERPRINT_SECRET?.trim()
    ? 'dedicated ACCOUNT_IDENTITY_FINGERPRINT_SECRET'
    : 'derived from SUPABASE_SERVICE_ROLE_KEY (fallback)'} — must match the production runtime.`);
  logBackfillExecutionMode(mode);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });

  const { data: grants, error: grantsError } = await supabase
    .from('credit_grants')
    .select('user_id,program_key');
  if (grantsError) throw grantsError;

  const userIds = [...new Set((grants ?? []).map((row) => String(row.user_id)))];
  console.log(`\nCredit grants: ${grants?.length ?? 0} across ${userIds.length} users`);

  // Plan pass: derive per-user digests (never printed — only counted) and check
  // which are already recorded, so the dry run states exactly what --execute
  // would insert.
  let plannedRows = 0;
  let alreadyRecorded = 0;
  for (const userId of userIds) {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data?.user) {
      console.log(`  ${userId}: auth user missing or unreadable — skipped (${error?.message ?? 'no user'})`);
      continue;
    }
    const fingerprints = deriveAccountIdentityFingerprints(data.user);
    const programs = new Set(
      (grants ?? []).filter((row) => String(row.user_id) === userId).map((row) => String(row.program_key)),
    );
    if (fingerprints.length === 0) {
      console.log(`  ${userId}: no identity signals derivable — nothing to record`);
      continue;
    }
    for (const programKey of programs) {
      const { data: existing, error: existingError } = await supabase
        .from(ACCOUNT_IDENTITY_FINGERPRINT_TABLE)
        .select('fingerprint')
        .eq('program_key', programKey)
        .in('fingerprint', fingerprints);
      if (existingError) throw existingError;
      const existingCount = existing?.length ?? 0;
      alreadyRecorded += existingCount;
      plannedRows += fingerprints.length - existingCount;
    }
    console.log(`  ${userId}: ${fingerprints.length} fingerprint(s) across ${programs.size} program(s)`);
  }
  console.log(`\nAlready recorded: ${alreadyRecorded}; rows to insert: ${plannedRows}`);

  if (mode.dryRun) {
    console.log('\nDry run only. Re-run with --execute --project-ref=<ref> to record.');
    return;
  }

  const result = await recordClaimedIdentityFingerprints(supabase, userIds, 'backfill');
  console.log(`\nRecorded fingerprints for ${result.usersWithGrants} user(s); ${result.fingerprintRows} row(s) written (duplicates ignored).`);
}

const isMain = process.argv[1]
  ? import.meta.url === new URL(`file://${process.argv[1]}`).href
  : false;

if (isMain) {
  runWelcomeCreditFingerprintBackfill().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
