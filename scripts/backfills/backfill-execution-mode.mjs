/** @param {string[]} argv */
function readProjectRefArgument(argv) {
  const inline = argv.find((argument) => argument.startsWith('--project-ref='));
  if (inline) return inline.slice('--project-ref='.length).trim();

  const index = argv.indexOf('--project-ref');
  return index >= 0 ? String(argv[index + 1] ?? '').trim() : '';
}

/** @param {string | undefined} supabaseUrl */
export function getSupabaseProjectRef(supabaseUrl) {
  try {
    const hostname = new URL(supabaseUrl).hostname.toLowerCase();
    const match = hostname.match(/^([a-z0-9-]+)\.supabase\.co$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   argv?: string[];
 *   supabaseUrl?: string;
 *   environmentProjectRef?: string;
 * }} [options]
 */
export function parseBackfillExecutionMode({
  argv = process.argv.slice(2),
  supabaseUrl,
  environmentProjectRef = process.env.SUPABASE_PROJECT_REF,
} = {}) {
  const execute = argv.includes('--execute');
  const explicitDryRun = argv.includes('--dry-run');

  if (execute && explicitDryRun) {
    throw new Error('Choose either --execute or --dry-run, not both.');
  }

  if (!execute) {
    return { dryRun: true, execute: false, projectRef: null };
  }

  const suppliedProjectRef = readProjectRefArgument(argv);
  if (!suppliedProjectRef) {
    throw new Error('Mutating a backfill requires --execute --project-ref=<supabase-project-ref>.');
  }

  const expectedProjectRef = environmentProjectRef?.trim() || getSupabaseProjectRef(supabaseUrl);
  if (!expectedProjectRef) {
    throw new Error('Unable to verify the target project. Set SUPABASE_PROJECT_REF before using --execute.');
  }

  if (suppliedProjectRef !== expectedProjectRef) {
    throw new Error(`Target project confirmation did not match ${expectedProjectRef}.`);
  }

  return { dryRun: false, execute: true, projectRef: expectedProjectRef };
}

/** @param {{ dryRun: boolean; execute: boolean; projectRef: string | null }} mode */
export function logBackfillExecutionMode(mode) {
  if (mode.dryRun) {
    console.log('DRY RUN: no records or storage objects will be changed.');
    console.log('To execute, pass --execute --project-ref=<supabase-project-ref>.');
    return;
  }

  console.log(`EXECUTE: mutations are enabled for confirmed project ${mode.projectRef}.`);
}
