import { pathToFileURL } from 'node:url';

import { createClient } from '@supabase/supabase-js';

const USAGE = `
Magicbooklet typeahead coverage (service role, read only)

Usage:
  npm run ops:search-coverage -- [--no-catalog] [--json]

Asks search_suggestions, the one call behind GET /api/search/suggest, for a
fixed list of typed prefixes (model and tool names, the forms people squash
or split them into, styles, subjects, creator names, typos, two-word starts)
as a visitor with no account, and prints per prefix how many creators, models
and tools, and completions came back, then how many prefixes got at least one
row and at least three. A prefix that answers nothing is listed with the
reason the list expects, or as unexplained.

Meant for a replay stack seeded with scripts/ops/search-coverage-seed.sql, so
two builds are compared on the same rows (runbook, "Typeahead coverage"). It
only reads, so it also runs against any database the key reaches.

  --no-catalog  ask as a client from before catalog=1 (no known name from two
                characters, none with no posts, no one-mistake reading)
  --json        print the rows and the totals as JSON

Environment:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY
`.trim();

export type SearchCoverageKind = 'name' | 'form' | 'style' | 'subject' | 'creator' | 'typo' | 'two words' | 'nothing';

export type SearchCoveragePrefix = {
  kind: SearchCoverageKind;
  text: string;
  /** Why this prefix is expected to answer nothing on the seed, when it is. */
  empty?: string;
};

const prefixes = (kind: SearchCoverageKind, texts: string[]): SearchCoveragePrefix[] => texts.map((text) => ({ kind, text }));

/**
 * What people type, fixed so two runs compare. Model and tool names are the
 * catalog's and the source-tools list's; styles, subjects and creator names
 * are the seed's.
 */
export const SEARCH_COVERAGE_PREFIXES: SearchCoveragePrefix[] = [
  ...prefixes('name', [
    'see', 'nano', 'kli', 'veo', 'gpt', 'flux', 'mid', 'midj', 'run', 'leo',
    'ideo', 'fire', 'kre', 'sdxl',
  ]),
  ...prefixes('form', ['nanobanana', 'nano-banana', 'nano banana p', 'gptimage', 'kling3', 'veo 3', 'gen4', 'flux2']),
  ...prefixes('style', ['cin', 'neon', 'vint', 'ani', 'cyber', 'water', 'noir', 'past']),
  ...prefixes('subject', ['por', 'land', 'drag', 'rob', 'cat', 'samu', 'astro', 'light']),
  ...prefixes('creator', ['may', 'lun', 'ari', 'noa', '@lu', 'oka', 'stud', 'tanaka']),
  ...prefixes('typo', ['seedence', 'klnig', 'midjurney', 'nanobanna', 'runwya', 'portrt', 'cinematc', 'dragn']),
  ...prefixes('two words', ['cinematic po', 'neon ci', 'vintage por', 'anime wa', 'golden dr', 'kling 2', 'nano ban', 'maya ok']),
  { kind: 'nothing', text: 'zzzq', empty: 'no content: nothing holds it' },
  { kind: 'nothing', text: 'qx', empty: 'no content: nothing holds it' },
  { kind: 'nothing', text: 'pixel fo', empty: 'rule: a made-up tool one creator alone names is not offered' },
];

export type SearchCoverageRow = SearchCoveragePrefix & {
  creators: number;
  entities: number;
  completions: number;
  total: number;
};

export type SearchCoverageTotals = {
  prefixes: number;
  answered: number;
  answeredWithThree: number;
  empty: SearchCoverageRow[];
};

export function parseSearchCoverageArguments(args: string[]) {
  let catalog = true;
  let json = false;
  let help = false;
  for (const token of args) {
    if (token === '--no-catalog') catalog = false;
    else if (token === '--json') json = true;
    else if (token === '--help') help = true;
    else throw new Error(`Unexpected argument: ${token}`);
  }
  return { catalog, json, help };
}

const listLength = (value: unknown) => (Array.isArray(value) ? value.length : 0);

/** One prefix's row from the answer of search_suggestions. */
export function searchCoverageRow(prefix: SearchCoveragePrefix, answer: unknown): SearchCoverageRow {
  const lists = answer && typeof answer === 'object' ? answer as Record<string, unknown> : {};
  const creators = listLength(lists.creators);
  const entities = listLength(lists.entities);
  const completions = listLength(lists.completions);
  return { ...prefix, creators, entities, completions, total: creators + entities + completions };
}

export function summarizeSearchCoverage(rows: SearchCoverageRow[]): SearchCoverageTotals {
  return {
    prefixes: rows.length,
    answered: rows.filter((row) => row.total >= 1).length,
    answeredWithThree: rows.filter((row) => row.total >= 3).length,
    empty: rows.filter((row) => row.total === 0),
  };
}

export function formatSearchCoverage(rows: SearchCoverageRow[], options: { catalog: boolean; catalogSupported: boolean }): string {
  const totals = summarizeSearchCoverage(rows);
  const width = Math.max(...rows.map((row) => row.text.length), 'prefix'.length);
  const line = (kind: string, text: string, creators: string, entities: string, completions: string, total: string) =>
    `${kind.padEnd(10)} ${text.padEnd(width)}  ${creators.padStart(8)} ${entities.padStart(8)} ${completions.padStart(11)} ${total.padStart(5)}`;
  const asked = options.catalog
    ? options.catalogSupported
      ? 'asked with the catalog (catalog=1)'
      : 'asked without the catalog: this database’s search_suggestions has no p_catalog'
    : 'asked without the catalog (--no-catalog)';
  return [
    `Typeahead coverage, ${asked}`,
    '',
    line('kind', 'prefix', 'creators', 'entities', 'completions', 'rows'),
    ...rows.map((row) => line(row.kind, row.text, String(row.creators), String(row.entities), String(row.completions), String(row.total))),
    '',
    `${totals.answered} of ${totals.prefixes} prefixes got at least one row; ${totals.answeredWithThree} got at least three.`,
    totals.empty.length === 0
      ? 'No prefix answered nothing.'
      : `Answered nothing (${totals.empty.length}):`,
    ...totals.empty.map((row) => `  ${row.text.padEnd(width)}  ${row.empty ?? 'unexplained'}`),
  ].join('\n');
}

type RpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
};

/** Every prefix asked of search_suggestions, in the list's order. */
export async function fetchSearchCoverage(
  client: RpcClient,
  options: { catalog: boolean },
  list: SearchCoveragePrefix[] = SEARCH_COVERAGE_PREFIXES,
): Promise<{ rows: SearchCoverageRow[]; catalogSupported: boolean }> {
  let withCatalog = options.catalog;
  let catalogSupported = true;
  const rows: SearchCoverageRow[] = [];
  for (const prefix of list) {
    const handlesOnly = prefix.text.startsWith('@');
    const args = (catalog: boolean) => ({
      p_query: handlesOnly ? prefix.text.slice(1) : prefix.text,
      p_viewer_user_id: null,
      p_handles_only: handlesOnly,
      p_creator_limit: 5,
      p_completion_limit: 6,
      ...(catalog ? { p_catalog: true } : {}),
    });
    let { data, error } = await client.rpc('search_suggestions', args(withCatalog));
    // A database from before the catalog has the five-parameter function only.
    if (error && withCatalog && error.code === 'PGRST202') {
      withCatalog = false;
      catalogSupported = false;
      ({ data, error } = await client.rpc('search_suggestions', args(false)));
    }
    if (error) throw new Error(`search_suggestions failed for "${prefix.text}": ${error.message}`);
    rows.push(searchCoverageRow(prefix, data));
  }
  return { rows, catalogSupported };
}

export async function runSearchCoverage(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  print: (text: string) => void = console.log,
) {
  const { catalog, json, help } = parseSearchCoverageArguments(args);
  if (help) {
    print(USAGE);
    return;
  }
  const url = environment.SUPABASE_URL ?? environment.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required.');
  }
  const client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { rows, catalogSupported } = await fetchSearchCoverage(client, { catalog });
  if (json) {
    const { empty, ...totals } = summarizeSearchCoverage(rows);
    print(JSON.stringify({ catalog: catalog && catalogSupported, rows, totals: { ...totals, empty: empty.map((row) => row.text) } }, null, 2));
    return;
  }
  print(formatSearchCoverage(rows, { catalog, catalogSupported }));
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runSearchCoverage(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
