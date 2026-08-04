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
    expect(workflow).toContain('for attempt in $(seq 1 12)');
    expect(workflow).toContain('within 60 seconds of promotion');
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

  it('authorizes a manual configuration redeploy only for green current main', () => {
    const workflow = read('.github/workflows/production-release.yml');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('expected_abandoned_reclaim_effective:');
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain(
      "github.event.workflow_run.head_branch == 'main'",
    );
    expect(workflow).toContain('ref: main');
    expect(workflow).toContain('git ls-remote origin refs/heads/main');
    expect(workflow).toContain(
      'actions/workflows/quality.yml/runs?branch=main&event=push&head_sha=${release_sha}&status=completed',
    );
    expect(workflow).toContain('select(.conclusion == "success")');
    expect(workflow).toContain(
      'RELEASE_SHA: ${{ needs.authorize.outputs.release_sha }}',
    );
    expect(workflow).not.toMatch(/^\s+ref:\s*\$\{\{\s*inputs\./m);
  });

  it('checks the declared reclaim policy on the staged deployment before promotion', () => {
    const workflow = read('.github/workflows/production-release.yml');
    const healthCheck = workflow.indexOf(
      'body.reclaimPolicy?.abandonedReclaimEffective',
    );
    const promotion = workflow.indexOf('vercel@57.0.0 promote');

    expect(workflow).toContain(
      "EXPECTED_ABANDONED_RECLAIM_EFFECTIVE: ${{ inputs.expected_abandoned_reclaim_effective || '' }}",
    );
    expect(workflow).toContain("typeof effective !== 'boolean'");
    expect(workflow).toContain('String(effective) !== expectedReclaim');
    expect(healthCheck).toBeGreaterThan(-1);
    expect(promotion).toBeGreaterThan(healthCheck);
  });

  it('documents that every Vercel environment edit needs a verified redeploy', () => {
    const runbook = read('docs/production-deployment-runbook.md');

    expect(runbook).toContain('configuration-only redeployment');
    expect(runbook).toContain('environment edit alone does');
    expect(runbook).toContain('Removing the variable without redeploying');
    expect(runbook).toContain('`expected_abandoned_reclaim_effective=true`');
    expect(runbook).toContain('`expected_abandoned_reclaim_effective=false`');
  });
});
