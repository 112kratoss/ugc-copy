import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260901090000_fix_post_delete_trigger_privileges.sql',
), 'utf8');

describe('post delete trigger privilege migration', () => {
  const triggerFunctions = [
    'public.reject_sold_post_delete()',
    'public.protect_sold_post_resource_bundle_content()',
  ];

  it.each(triggerFunctions)('runs %s with its trusted owner and a locked search path', (signature) => {
    expect(migration).toContain(`ALTER FUNCTION ${signature}\n  OWNER TO postgres;`);
    expect(migration).toContain(`ALTER FUNCTION ${signature}\n  SECURITY DEFINER;`);
    expect(migration).toContain(`ALTER FUNCTION ${signature}\n  SET search_path = '';`);
  });

  it.each(triggerFunctions)('keeps application roles from invoking %s directly', (signature) => {
    expect(migration).toContain(
      `REVOKE ALL ON FUNCTION ${signature}\n  FROM PUBLIC, anon, authenticated, service_role;`,
    );
  });

  it('does not grant service_role access to the auth schema', () => {
    expect(migration).not.toMatch(/GRANT[\s\S]*auth\.users/i);
  });
});
