import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261126173053_agent_oauth_drop_supabase_import.sql', 'utf8');
const statements = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .trim();

describe('agent_oauth_drop_supabase_import migration', () => {
  it('drops the cutover import of Supabase Auth clients by its exact signature, and does nothing else', () => {
    expect(statements).toBe('drop function if exists public.agent_oauth_import_supabase_clients(text[]);');
  });

  it('leaves the tables and the other agent_oauth functions alone', () => {
    expect(statements).not.toMatch(/\btable\b|agent_oauth_(?!import_supabase_clients)/iu);
  });
});
