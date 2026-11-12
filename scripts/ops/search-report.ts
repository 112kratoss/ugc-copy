import { pathToFileURL } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import {
  fetchSearchQueryReport,
  formatSearchQueryReport,
  type SearchQueryReportRow,
} from '../../src/lib/search-query-report';

const USAGE = `
Magicbooklet search report (service role, read only)

Usage:
  npm run ops:search-report -- [--days 7] [--limit 50] [--json]

Reads public.search_query_events through search_query_report: per final query
(typing steps within 15 seconds collapse into the query they led to), how many
distinct visitor-days searched it and how many of those found nothing in any
kind, zero-result searches first. The log is anonymous and kept 90 days.

  --days   window in days, 1 to 90 (default 7)
  --limit  rows, 1 to 1000 (default 50)
  --json   print the rows as JSON

Environment:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY
`.trim();

export function parseSearchReportArguments(args: string[]) {
  let days = 7;
  let limit = 50;
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--json') json = true;
    else if (token === '--help') help = true;
    else if (token === '--days' || token === '--limit') {
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value)) throw new Error(`${token} needs a whole number.`);
      index += 1;
      if (token === '--days') days = Number(value);
      else limit = Number(value);
    } else {
      throw new Error(`Unexpected argument: ${token}`);
    }
  }
  if (days < 1 || days > 90) throw new Error('--days must be between 1 and 90.');
  if (limit < 1 || limit > 1000) throw new Error('--limit must be between 1 and 1000.');
  return { days, limit, json, help };
}

export async function runSearchReport(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  print: (text: string) => void = console.log,
) {
  const { days, limit, json, help } = parseSearchReportArguments(args);
  if (help) {
    print(USAGE);
    return;
  }
  const supabaseUrl = environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const rows: SearchQueryReportRow[] = await fetchSearchQueryReport(supabase, { days, limit });
  print(json ? JSON.stringify(rows, null, 2) : formatSearchQueryReport(rows, { days }));
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runSearchReport(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
