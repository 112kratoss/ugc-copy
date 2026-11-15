import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  SEARCH_COVERAGE_PREFIXES,
  fetchSearchCoverage,
  formatSearchCoverage,
  parseSearchCoverageArguments,
  runSearchCoverage,
  searchCoverageRow,
  summarizeSearchCoverage,
} from '../../scripts/ops/search-coverage';

// `npm run ops:search-coverage`: the fixed list of typed prefixes the typeahead
// is held to, asked of search_suggestions on a seeded replay stack.

const answer = (creators: number, entities: number, completions: number) => ({
  creators: Array.from({ length: creators }, () => ({})),
  entities: Array.from({ length: entities }, () => ({})),
  completions: Array.from({ length: completions }, () => ({})),
});

describe('the typed prefixes', () => {
  it('is a fixed list of about sixty, each once, of every kind people type', () => {
    const texts = SEARCH_COVERAGE_PREFIXES.map((prefix) => prefix.text);
    expect(texts.length).toBeGreaterThanOrEqual(55);
    expect(texts.length).toBeLessThanOrEqual(70);
    expect(new Set(texts).size).toBe(texts.length);
    expect(Array.from(new Set(SEARCH_COVERAGE_PREFIXES.map((prefix) => prefix.kind)))).toEqual([
      'name', 'form', 'style', 'subject', 'creator', 'typo', 'two words', 'nothing',
    ]);
    // Typed as people type: lowercase, trimmed, within what the route takes.
    for (const text of texts) {
      expect(text, text).toBe(text.trim().toLowerCase());
      expect(text.length, text).toBeGreaterThanOrEqual(2);
    }
    // The owner's example and the forms search understands are in it.
    for (const text of ['see', 'nanobanana', 'nano-banana', 'gptimage', 'kling3', 'veo 3', 'seedence', 'klnig']) {
      expect(texts, text).toContain(text);
    }
    // Only a prefix expected to answer nothing says why.
    for (const prefix of SEARCH_COVERAGE_PREFIXES) {
      expect(prefix.empty !== undefined, prefix.text).toBe(prefix.kind === 'nothing');
    }
  });

  it('is seeded for: the seed file holds the tools and words the list types', () => {
    const seed = readFileSync(join(process.cwd(), 'scripts/ops/search-coverage-seed.sql'), 'utf8');
    for (const held of ["'seedance-2', 7)", "'krea', NULL, NULL, 8)", "'pixel-forge', 'Forge One', 'forge-one', 9)", "'cinematic'", "'portrait'", "'Maya'", "'Okafor'"]) {
      expect(seed, held).toContain(held);
    }
    // It refuses a database that holds posts, and is one transaction.
    expect(seed).toContain('IF EXISTS (SELECT 1 FROM public.posts) THEN');
    expect(seed).toMatch(/^BEGIN;$/m);
    expect(seed.trim()).toMatch(/COMMIT;$/);
    // It runs on a build from before the phrases too.
    expect(seed).toContain("IF to_regprocedure('public.rebuild_search_phrases()') IS NOT NULL THEN");
  });
});

describe('the coverage read', () => {
  it('takes its two flags and nothing else', () => {
    expect(parseSearchCoverageArguments([])).toEqual({ catalog: true, json: false, help: false });
    expect(parseSearchCoverageArguments(['--no-catalog', '--json'])).toEqual({ catalog: false, json: true, help: false });
    expect(() => parseSearchCoverageArguments(['--apply'])).toThrow('Unexpected argument: --apply');
  });

  it('counts each list of an answer, and nothing for an answer it cannot read', () => {
    const prefix = { kind: 'name' as const, text: 'see' };
    expect(searchCoverageRow(prefix, answer(1, 4, 2))).toEqual({ ...prefix, creators: 1, entities: 4, completions: 2, total: 7 });
    expect(searchCoverageRow(prefix, null).total).toBe(0);
    expect(searchCoverageRow(prefix, { creators: 'x' }).total).toBe(0);
  });

  it('asks the one call the route makes, as a visitor, a handle as a handle', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: answer(0, 1, 0), error: null });
    const { rows, catalogSupported } = await fetchSearchCoverage({ rpc }, { catalog: true }, [
      { kind: 'name', text: 'see' },
      { kind: 'creator', text: '@lu' },
    ]);
    expect(catalogSupported).toBe(true);
    expect(rows.map((row) => row.total)).toEqual([1, 1]);
    expect(rpc.mock.calls).toEqual([
      ['search_suggestions', { p_query: 'see', p_viewer_user_id: null, p_handles_only: false, p_creator_limit: 5, p_completion_limit: 6, p_catalog: true }],
      ['search_suggestions', { p_query: 'lu', p_viewer_user_id: null, p_handles_only: true, p_creator_limit: 5, p_completion_limit: 6, p_catalog: true }],
    ]);
  });

  it('asks a database from before the catalog with the five parameters it has, and says so', async () => {
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => ('p_catalog' in args
      ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
      : { data: answer(0, 0, 1), error: null }));
    const { rows, catalogSupported } = await fetchSearchCoverage({ rpc }, { catalog: true }, [
      { kind: 'name', text: 'see' },
      { kind: 'style', text: 'cin' },
    ]);
    expect(catalogSupported).toBe(false);
    expect(rows.map((row) => row.total)).toEqual([1, 1]);
    // The parameter is tried once, not for every prefix.
    expect(rpc.mock.calls.filter(([, args]) => 'p_catalog' in args)).toHaveLength(1);
    expect(formatSearchCoverage(rows, { catalog: true, catalogSupported })).toContain('has no p_catalog');
  });

  it('fails on any other error, naming the prefix', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } });
    await expect(fetchSearchCoverage({ rpc }, { catalog: true }, [{ kind: 'name', text: 'see' }]))
      .rejects.toThrow('search_suggestions failed for "see": permission denied');
  });

  it('totals the prefixes with a row and with three, and lists the ones with none and why', () => {
    const rows = [
      searchCoverageRow({ kind: 'name', text: 'see' }, answer(0, 4, 0)),
      searchCoverageRow({ kind: 'style', text: 'cin' }, answer(0, 0, 2)),
      searchCoverageRow({ kind: 'typo', text: 'dragn' }, answer(0, 0, 0)),
      searchCoverageRow({ kind: 'nothing', text: 'zzzq', empty: 'no content: nothing holds it' }, answer(0, 0, 0)),
    ];
    expect(summarizeSearchCoverage(rows)).toMatchObject({ prefixes: 4, answered: 2, answeredWithThree: 1 });
    const text = formatSearchCoverage(rows, { catalog: true, catalogSupported: true });
    expect(text).toContain('2 of 4 prefixes got at least one row; 1 got at least three.');
    expect(text).toContain('Answered nothing (2):');
    expect(text).toMatch(/dragn\s+unexplained/);
    expect(text).toMatch(/zzzq\s+no content: nothing holds it/);
  });

  it('needs a database to ask, and prints its usage without one', async () => {
    const print = vi.fn();
    await runSearchCoverage(['--help'], {} as NodeJS.ProcessEnv, print);
    expect(print.mock.calls[0][0]).toContain('npm run ops:search-coverage');
    await expect(runSearchCoverage([], {} as NodeJS.ProcessEnv, print)).rejects.toThrow('SUPABASE_SERVICE_ROLE_KEY are required');
    const scripts = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['ops:search-coverage']).toBe('tsx --env-file-if-exists=.env.local scripts/ops/search-coverage.ts');
  });
});
