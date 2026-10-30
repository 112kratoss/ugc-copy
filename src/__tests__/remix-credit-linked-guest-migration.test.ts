import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readMigration(name: string) {
  return readFileSync(path.join(process.cwd(), 'supabase/migrations', name), 'utf8');
}

function functionText(sql: string, start: string) {
  const from = sql.indexOf(start);
  return sql.slice(from, sql.indexOf('$$;', from) + 3);
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

const OWNER_MATCH = /AND \(\s+p\.user_id = source\.user_id\s+OR EXISTS \(\s+SELECT 1\s+FROM public\.profiles AS owner\s+WHERE owner\.id = source\.user_id\s+AND owner\.merged_into_user_id = p\.user_id\s+\)\s+\)/;

/**
 * The behaviour is asserted by pgTAP (completed_post_remixes_linked_guest.test.sql).
 * This pins the migration's shape: the post match is the only change to the
 * remix credit, and it is the linked-guest rule the exposure trigger applies.
 */
describe('remix credit follows linked guest creations', () => {
  const sql = readMigration('20261030022210_remix_credit_follows_linked_guest_creations.sql');
  const replaced = functionText(sql, 'CREATE OR REPLACE FUNCTION public.record_completed_post_remix()');
  const original = functionText(
    readMigration('20260830123000_completed_post_remixes.sql'),
    'CREATE FUNCTION public.record_completed_post_remix()',
  );

  it('credits the post of a creation its owner made as a guest since linked to them', () => {
    expect(replaced).toMatch(OWNER_MATCH);
  });

  it('changes nothing else in the remix credit', () => {
    const withExactMatch = replaced.replace(OWNER_MATCH, 'AND p.user_id = source.user_id');
    expect(normalize(withExactMatch)).toBe(
      normalize(original.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')),
    );
  });

  // No trigger, grant or count is touched: CREATE OR REPLACE keeps the
  // trigger and grants, and production had no such remix to catch up on.
  it('runs nothing but the replacement and its revoke', () => {
    const outside = sql.replace(replaced, '').replace(/^--.*$/gm, '').trim();
    expect(outside).toBe(
      'REVOKE ALL ON FUNCTION public.record_completed_post_remix() FROM PUBLIC, anon, authenticated;',
    );
  });
});
