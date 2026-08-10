import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const adapter = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/media-template-route-adapter-service.ts'),
  'utf8',
);
const service = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/template-run-service.ts'),
  'utf8',
);

describe('template run durable execution contract', () => {
  it('keeps GET on the pure owned-read service', () => {
    const handler = adapter.slice(
      adapter.indexOf('export function createTemplateRunRouteHandlers'),
      adapter.indexOf('export function createTemplateRunInputSignRouteHandlers'),
    );
    expect(handler).toContain('getTemplateRun({');
    expect(handler).not.toContain('syncTemplateRun');
    expect(service).toMatch(/export async function getTemplateRun[\s\S]*?loadRunState/);
  });

  it('schedules starts, approvals and retries through the durable processor', () => {
    expect(adapter.match(/scheduleTemplateRunDrain\(/g)?.length).toBeGreaterThanOrEqual(4);
    expect(adapter).toContain('processTemplateRunJobs({');
  });
});
