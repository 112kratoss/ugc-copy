import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import {
  confirmOrphanRemovals,
  formatOrphanList,
  listStorageOrphans,
  ORPHAN_MIN_AGE_MS,
  parseOrphanList,
} from '../../src/lib/storage-orphans';
import { STORAGE_BUCKET_IDS } from '../../src/lib/storage-buckets';

const USAGE = `
Magicbooklet stored objects nothing names (service role only)

Usage:
  npm run ops:storage-orphans -- list [--out <file>] [--buckets a,b] [--min-age-days 7] [--include-expired-uploads]
  npm run ops:storage-orphans -- --confirm <list-file> [--include-expired-uploads]

list (the default, reads only) writes a reviewable list (bucket, path, size, age,
reason) of every object no content row names, by its name or, for a derived file,
its base. It leaves out objects younger than seven days, objects upload
bookkeeping still tracks, the recipe-copy sweep's folders and retained buyer
copies. Expired staged uploads (what MEDIA_UPLOAD_RECLAIM_ABANDONED gates) are
listed only with --include-expired-uploads, under reason expired_upload.

--confirm removes exactly the objects of a reviewed list, through the Storage
API, checking each again right before its removal (the same object, its age, the
exclusions, every row naming it). Delete lines from the list to keep objects.
It refuses a list made for another project or more than three days ago.

Environment:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY
`.trim();

type ParsedArguments = {
  command: string | null;
  flags: Map<string, string | true>;
};

const BOOLEAN_FLAGS = new Set(['--include-expired-uploads', '--help']);

export function parseArguments(args: string[]): ParsedArguments {
  const tokens = [...args];
  const command = tokens[0] && !tokens[0].startsWith('--') ? tokens.shift() ?? null : null;
  const flags = new Map<string, string | true>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    if (BOOLEAN_FLAGS.has(token)) {
      flags.set(token, true);
      continue;
    }
    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
    flags.set(token, value);
    index += 1;
  }

  return { command, flags };
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function runStorageOrphans(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  { now = () => new Date() }: { now?: () => Date } = {},
) {
  const { command, flags } = parseArguments(args);
  if (command === 'help' || flags.has('--help')) {
    console.log(USAGE);
    return;
  }
  const confirmFile = stringFlag(flags, '--confirm');
  if (command && command !== 'list') throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  if (command === 'list' && confirmFile) throw new Error('list reads only: run --confirm on its own.');

  const supabaseUrl = environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }
  const projectHost = new URL(supabaseUrl).host;
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const includeExpiredUploads = flags.get('--include-expired-uploads') === true;

  if (confirmFile) {
    const list = parseOrphanList(readFileSync(confirmFile, 'utf8'));
    console.log(`Checking and removing ${list.entries.length} object(s) listed for ${list.projectHost} at ${list.listedAt.toISOString()}.`);
    const counts = await confirmOrphanRemovals(supabase, list, {
      projectHost,
      clock: () => now().getTime(),
      includeExpiredUploads,
      onResult: (entry, outcome) => console.log(`${outcome}\t${entry.bucket}\t${entry.path}`),
    });
    console.log(JSON.stringify(counts));
    return;
  }

  const bucketsFlag = stringFlag(flags, '--buckets');
  const buckets = bucketsFlag ? bucketsFlag.split(',').map((bucket) => bucket.trim()) : [...STORAGE_BUCKET_IDS];
  const unknown = buckets.filter((bucket) => !(STORAGE_BUCKET_IDS as readonly string[]).includes(bucket));
  if (unknown.length > 0) throw new Error(`Unknown bucket(s): ${unknown.join(', ')}`);
  const minAgeDaysFlag = stringFlag(flags, '--min-age-days');
  if (minAgeDaysFlag !== undefined && !/^\d+$/.test(minAgeDaysFlag)) throw new Error('--min-age-days must be a whole number.');
  const minAgeMs = Math.max(ORPHAN_MIN_AGE_MS, Number(minAgeDaysFlag ?? 0) * 24 * 60 * 60 * 1000);

  const listedAt = now();
  const listing = await listStorageOrphans(supabase, {
    clock: () => now().getTime(),
    minAgeMs,
    buckets,
    includeExpiredUploads,
    onProgress: (message) => console.error(message),
  });
  const outFile = stringFlag(flags, '--out') ?? `storage-orphans-${listedAt.toISOString().replace(/[:.]/g, '-')}.tsv`;
  writeFileSync(outFile, formatOrphanList(listing, { projectHost, listedAt }), { flag: 'wx' });

  const byBucket = new Map<string, { objects: number; bytes: number }>();
  for (const entry of listing.orphans) {
    const key = `${entry.bucket} (${entry.reason})`;
    const total = byBucket.get(key) ?? { objects: 0, bytes: 0 };
    total.objects += 1;
    total.bytes += entry.sizeBytes ?? 0;
    byBucket.set(key, total);
  }
  console.log(`Read ${listing.scannedObjects} object(s) and ${listing.scannedRows} row(s) of ${listing.scannedTables} table(s).`);
  console.log(`Left out: ${JSON.stringify(listing.kept)}`);
  console.table(Object.fromEntries(byBucket));
  console.log(`Wrote ${listing.orphans.length} object(s) to ${outFile}. Review it, then: npm run ops:storage-orphans -- --confirm ${outFile}`);
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runStorageOrphans(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
