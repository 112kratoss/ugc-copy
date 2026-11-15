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

Reads public.search_query_events and public.search_result_opens through
search_query_report: per final query (typing steps within 15 seconds collapse
into the query they led to) and overall, how many distinct visitor-days
searched it, how many of those found nothing in any kind, how many came from
a client that reports opens (it says how the search was entered; an app before
its update does not), how many of those opened a result, how many of those
found something and opened nothing, the mean place of the results opened and
how the searches were entered (typed, a suggestion, a recent search...). Two tables: zero-result searches first, then the queries
most often left without an open. An opened result counts only while search
still shows it to the public. The log is anonymous and kept 90 days.

  --days   window in days, 1 to 90 (default 7)
  --limit  rows per table, 1 to 1000 (default 50)
  --json   print both tables' rows as JSON: { zeroResult, unopened }

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
  const [rows, unopenedRows]: SearchQueryReportRow[][] = await Promise.all([
    fetchSearchQueryReport(supabase, { days, limit, order: 'zero_result' }),
    fetchSearchQueryReport(supabase, { days, limit, order: 'unopened' }),
  ]);
  print(json
    ? JSON.stringify({ zeroResult: rows, unopened: unopenedRows }, null, 2)
    : formatSearchQueryReport(rows, { days, unopenedRows }));
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
