import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(process.cwd(), 'supabase', 'migrations');
const migrationName = '20261015190650_settle_merged_guest_work_against_account.sql';
const migration = readMigration(migrationName);

function readMigration(name: string) {
  return readFileSync(join(migrationsDirectory, name), 'utf8');
}

/** One function's CREATE OR REPLACE statement, through its closing dollar quote. */
function functionDefinition(sql: string, name: string) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not defined`).toBeGreaterThanOrEqual(0);
  const tag = /\bAS (\$[a-z_]*\$)/.exec(sql.slice(start));
  if (!tag) throw new Error(`${name} has no dollar-quoted body`);
  const bodyStart = start + tag.index + tag[0].length;
  const end = sql.indexOf(`${tag[1]};`, bodyStart);
  expect(end, `${name} body is not closed`).toBeGreaterThan(bodyStart);
  return sql.slice(start, end + tag[1].length + 1);
}

/** Every statement that reads, locks or writes public.profiles. */
function profileStatements(definition: string) {
  return definition.match(/\b(?:SELECT|UPDATE)\b[^;]*?\bpublic\.profiles\b[^;]*;/g) ?? [];
}

// Each function, the migration holding its latest body before this one, and
// the stored or passed-in user id that body locked and charged.
const redefined = [
  {
    name: 'start_template_generation',
    previous: '20260712063730_canonical_template_studio_results.sql',
    storedUserId: 'p_user_id',
  },
  {
    name: 'reserve_generation_promotional_credits',
    previous: '20260712123000_invite_and_earn_referrals.sql',
    storedUserId: 'NEW.user_id',
  },
  {
    name: 'settle_generation_start_failed',
    previous: '20260809120000_generation_submission_unknown.sql',
    storedUserId: 'v_generation.user_id',
  },
  {
    name: 'settle_template_generation_start_failed',
    previous: '20260711201026_settle_template_generation_start_failures.sql',
    storedUserId: 'v_generation.user_id',
  },
  {
    name: 'settle_ai_usage_event',
    previous: '20260714110000_atomic_ai_usage_settlement.sql',
    storedUserId: 'v_event.user_id',
  },
] as const;

/**
 * A body with its comments, the account variable's declaration and its one
 * assignment taken out — what is left must be the previous body.
 */
function withoutAccountResolution(definition: string, storedUserId: string) {
  return definition
    .replace(`  v_account_id := public.canonical_account_id(${storedUserId});\n\n`, '')
    .split('\n')
    .filter((line) => !/^\s*--/.test(line) && line !== '  v_account_id uuid;')
    .join('\n');
}

describe('merged guest late settlement migration', () => {
  it('resolves every profile each function locks, reads, charges or refunds through canonical_account_id', () => {
    for (const { name, storedUserId } of redefined) {
      const definition = functionDefinition(migration, name);
      expect(definition).toContain('  v_account_id uuid;\n');
      expect(definition).toContain(`  v_account_id := public.canonical_account_id(${storedUserId});\n`);

      const statements = profileStatements(definition);
      expect(statements.length, `${name} touches no profile`).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement, `${name}: ${statement}`).toMatch(/\bWHERE id = v_account_id\b/);
      }
    }
  });

  it('starts from the latest body of each function and changes nothing else', () => {
    const earlierMigrations = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql') && name < migrationName)
      .sort();

    for (const { name, previous, storedUserId } of redefined) {
      const definers = earlierMigrations.filter((file) => (
        readMigration(file).includes(`CREATE OR REPLACE FUNCTION public.${name}(`)
      ));
      expect(definers.at(-1), `${name} was redefined after ${previous}`).toBe(previous);

      const previousDefinition = functionDefinition(readMigration(previous), name);
      const expected = withoutAccountResolution(previousDefinition, storedUserId)
        .split(`WHERE id = ${storedUserId}`)
        .join('WHERE id = v_account_id');
      // Only profile statements named the stored id with `WHERE id =`; the
      // run, step and generation lookups use other columns.
      expect(profileStatements(previousDefinition).every((statement) => (
        statement.includes(`WHERE id = ${storedUserId}`)
      ))).toBe(true);
      expect(previousDefinition.split(`WHERE id = ${storedUserId}`).length - 1)
        .toBe(profileStatements(previousDefinition).length);

      expect(withoutAccountResolution(functionDefinition(migration, name), storedUserId)).toBe(expected);
    }
  });

  it('keeps a template run and its generations on the id the run was started under', () => {
    const definition = functionDefinition(migration, 'start_template_generation');
    expect(definition).toContain('IF NOT FOUND OR v_run.user_id <> p_user_id THEN');
    expect(definition).toContain('      AND user_id = p_user_id\n      AND template_run_id = p_template_run_id');
    expect(definition).toContain('    WHERE user_id = p_user_id\n      AND client_request_key_hash = p_client_request_key_hash');
    expect(definition).toMatch(/VALUES \(\n {4}p_user_id,\n {4}btrim\(p_model\),/);
  });

  it('leaves write-only settlement to the forwarding trigger, which must stay in place', () => {
    // settle_generation_failed and the promotional restore triggers write a
    // delta by the stored id and read nothing back, so the merge's trigger on
    // profiles already moves their writes to the account. They are deliberately
    // not redefined here, which makes the trigger load-bearing for them.
    for (const name of [
      'settle_generation_failed',
      'restore_generation_promotional_credits',
      'restore_ai_usage_promotional_credits',
      'forward_linked_account_credit_change',
      'canonical_account_id',
    ]) {
      expect(migration).not.toContain(`FUNCTION public.${name}(`);
    }

    const allMigrations = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map(readMigration)
      .join('\n');
    expect(allMigrations.match(/DROP TRIGGER IF EXISTS profiles_forward_linked_credit_change ON public\.profiles;/g))
      .toHaveLength(1);
    expect(allMigrations.match(/CREATE TRIGGER profiles_forward_linked_credit_change\nBEFORE UPDATE ON public\.profiles\nFOR EACH ROW EXECUTE FUNCTION public\.forward_linked_account_credit_change\(\);/g))
      .toHaveLength(1);
  });

  it('restates every grant as it was', () => {
    expect(migration).toContain([
      'REVOKE ALL ON FUNCTION public.start_template_generation(',
      '  uuid, uuid, uuid, integer, text, text, integer, text, uuid, text',
      ') FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.start_template_generation(',
      '  uuid, uuid, uuid, integer, text, text, integer, text, uuid, text',
      ') TO service_role;',
    ].join('\n'));
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.reserve_generation_promotional_credits() FROM PUBLIC, anon, authenticated;',
    );
    expect(migration).not.toContain('GRANT EXECUTE ON FUNCTION public.reserve_generation_promotional_credits()');
    for (const signature of [
      'settle_generation_start_failed(uuid, text)',
      'settle_ai_usage_event(uuid, text, text, jsonb, text)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC;`);
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM anon;`);
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
    }
    expect(migration).toContain([
      'REVOKE ALL ON FUNCTION public.settle_template_generation_start_failed(uuid, text)',
      '  FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.settle_template_generation_start_failed(uuid, text)',
      '  TO service_role;',
    ].join('\n'));
  });
});
