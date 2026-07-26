import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('production release workflow', () => {
  it('prevents the Git integration from bypassing staged verification', () => {
    const vercelConfig = JSON.parse(read('vercel.json'));
    const workflow = read('.github/workflows/production-release.yml');

    expect(vercelConfig.git?.deploymentEnabled).toBe(false);
    expect(workflow).toContain('--skip-domain');
    expect(workflow).toContain('/api/ops/backend-health');
    expect(workflow).toContain('vercel@57.0.0 promote');
    expect(workflow).toContain('vercel@57.0.0 curl');
    expect(workflow).not.toContain(
      'vercel@57.0.0 --token="${VERCEL_TOKEN}" curl',
    );
    expect(workflow).toContain(
      '--deployment "${DEPLOYMENT_URL}" \\\n            -- \\',
    );
    expect(workflow).toContain("['ok', 'warning'].includes(body.status)");
    expect(workflow).toContain('Staged backend health warnings:');
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain(
      'node .github/scripts/apply-supabase-migrations.mjs',
    );
    expect(workflow).not.toContain('SUPABASE_DB_PASSWORD');

    const migrationRunner = read(
      '.github/scripts/apply-supabase-migrations.mjs',
    );
    expect(migrationRunner).toContain('/database/migrations');
    expect(migrationRunner).toContain("await request('POST'");
    expect(migrationRunner).toContain('out-of-order migration');
  });
});
