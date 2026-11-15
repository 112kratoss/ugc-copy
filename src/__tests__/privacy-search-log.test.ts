import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const strip = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

/** The newest definition of the retention sweep: where the search log's two windows are set. */
function newestSweep(): string {
  const defining = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => strip(readFileSync(path.join(MIGRATIONS, name), 'utf8')))
    .filter((sql) => sql.includes('CREATE OR REPLACE FUNCTION public.prune_operational_backend_data('));
  return defining.at(-1) ?? '';
}

/**
 * The Privacy Policy's sentence about the search log, and the code that makes it true. The owner
 * approved the wording with the feature (2026-11-15): change the sentence and the sweep together.
 */
describe('the privacy policy says what the search log keeps', () => {
  it('names the opened results beside the search terms, the daily code and the 90 days', () => {
    const page = readFileSync(path.join(process.cwd(), 'src/app/privacy/page.tsx'), 'utf8');
    expect(page).toContain(
      'Search terms you enter, and which results you open from them, are logged without your account identifier or network address, '
      + 'under a pseudonymous code that changes every day and cannot be recomputed after 48 hours, and are deleted after 90 days.',
    );
  });

  it('is held by the sweep: both tables pruned at 90 days, the day keys at 48 hours', () => {
    const sweep = newestSweep();
    expect(sweep).toContain('v_search_query_retention_days CONSTANT integer := 90');
    expect(sweep).toContain("v_search_day_key_retention CONSTANT interval := interval '48 hours'");
    for (const table of ['search_query_events', 'search_result_opens']) {
      expect(sweep, table).toContain(`FROM public.${table} WHERE created_at < v_now - make_interval(days => v_search_query_retention_days)`);
    }
    expect(sweep).toContain("WHERE keys.day::timestamp AT TIME ZONE 'UTC' < v_now - v_search_day_key_retention");
  });

  it('is held by the tables: neither has a column for an account, an address or a device', () => {
    const all = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()
      .map((name) => strip(readFileSync(path.join(MIGRATIONS, name), 'utf8'))).join(' ');
    for (const table of ['search_query_events', 'search_result_opens']) {
      const create = all.slice(all.indexOf(`CREATE TABLE public.${table} (`));
      const columns = create.slice(0, create.indexOf(' );'));
      expect(columns, table).not.toMatch(/user_id|ip_address|network|user_agent|device|references auth\.users/iu);
      const added = [...all.matchAll(new RegExp(`ALTER TABLE public\\.${table} ((?:ADD COLUMN [^;]+))`, 'gu'))].map((match) => match[1]).join(' ');
      expect(added, table).not.toMatch(/user_id|ip_address|network|user_agent|device|references auth\.users/iu);
    }
  });
});
