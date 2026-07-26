import fs from 'node:fs';
import path from 'node:path';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import ChildSafetyPage from '@/app/child-safety/page';
import { resolveChildSafetyContact } from '@/lib/child-safety-contact';
import { siteConfig } from '@/lib/seo';

function readProjectFile(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('moderation production readiness', () => {
  it('publishes actionable child-safety standards and the configured safety contact', () => {
    const previous = process.env.CHILD_SAFETY_CONTACT_EMAIL;
    process.env.CHILD_SAFETY_CONTACT_EMAIL = 'safety-team@example.com';

    try {
      const html = renderToString(<ChildSafetyPage />);

      expect(html).toContain('Child Safety Standards');
      expect(html).toContain('zero tolerance');
      expect(html).toContain('safety-team@example.com');
      expect(html).toContain('Do not download');
      expect(html).toContain('local emergency services');
      expect(html).toContain('legally required reports');
    } finally {
      if (previous === undefined) {
        delete process.env.CHILD_SAFETY_CONTACT_EMAIL;
      } else {
        process.env.CHILD_SAFETY_CONTACT_EMAIL = previous;
      }
    }
  });

  it('uses general support as a safe fallback for absent or invalid configuration', () => {
    expect(resolveChildSafetyContact({ NODE_ENV: 'test' })).toEqual({
      email: siteConfig.supportEmail,
      source: 'support-fallback',
    });
    expect(resolveChildSafetyContact({
      NODE_ENV: 'test',
      CHILD_SAFETY_CONTACT_EMAIL: 'not-an-email',
    })).toEqual({
      email: siteConfig.supportEmail,
      source: 'support-fallback',
    });
  });

  it('fails the external watchdog when required configuration is missing', () => {
    const workflow = readProjectFile('.github/workflows/backend-alert-watchdog.yml');

    expect(workflow).toContain('Watchdog not configured');
    expect(workflow).toContain('exit 1');
    expect(workflow).not.toContain('exit 0');
    expect(workflow).toContain('PRODUCTION_BASE_URL must be an absolute HTTPS origin');
  });

  it('documents staffed roles, measurable queue SLOs, and asset revocation verification', () => {
    const runbook = readProjectFile('docs/moderation-operations.md');

    expect(runbook).toContain('<assign safety owner>');
    expect(runbook).toContain('<assign primary moderator>');
    expect(runbook).toContain('MODERATION_QUEUE_AGE_WARNING');
    expect(runbook).toContain('within one hour');
    expect(runbook).toContain('within 24 hours');
    expect(runbook).toContain('Verify known URLs now return an authorization failure or not-found response');
    expect(runbook).toContain('Do not use real harmful content for the drill');
  });
});
