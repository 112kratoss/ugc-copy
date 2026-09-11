import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildFailedGenerationStatusPayload,
  buildLockedGenerationStatusPayload,
} from '@/lib/generation-status-lock';

/**
 * A generation settled by the webhook is already terminal by the time the
 * client polls, so these two builders -- not the live provider branch -- are
 * what a creator actually reads a failure from. Both hardcoded `error: null`,
 * which is why a stored reason never reached the screen.
 */
describe('failure reason in stored generation status payloads', () => {
  const failedRow = {
    status: 'failed',
    category: 'video',
    model: 'seedance-2',
    created_at: '2026-09-02T11:57:20.000Z',
    completed_at: '2026-09-02T11:57:30.000Z',
    error_message: 'This model would not accept the reference image.',
  };

  it('returns the stored reason for a terminal failure', () => {
    expect(buildFailedGenerationStatusPayload(failedRow)).toMatchObject({
      status: 'failed',
      output: null,
      error: 'This model would not accept the reference image.',
    });
  });

  it('returns the stored reason when the status lock is held', () => {
    expect(buildLockedGenerationStatusPayload(failedRow, null)).toMatchObject({
      status: 'failed',
      error: 'This model would not accept the reference image.',
    });
  });

  it('falls back to null when nothing was recorded', () => {
    for (const stored of [null, undefined, '', '   ']) {
      expect(
        buildFailedGenerationStatusPayload({ ...failedRow, error_message: stored }).error,
      ).toBeNull();
    }
  });

  it('never attaches a reason to a generation that is still running', () => {
    // A stale reason on a live row would be worse than silence: the row is not
    // failed, so anything stored against it must not be reported as a failure.
    const runningRow = {
      ...failedRow,
      status: 'processing',
      completed_at: null,
    };

    const payload = buildLockedGenerationStatusPayload(runningRow, null);
    expect(payload.status).not.toBe('failed');
    expect(payload.error).toBeNull();
  });

  it('selects error_message in every status service that builds these payloads', () => {
    // The builders can only report what the row carries, and the select lists
    // did not previously fetch the column.
    for (const service of [
      'video-generation-status-service.ts',
      'image-generation-status-service.ts',
      'motion-generation-status-service.ts',
    ]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), 'src/lib', service), 'utf8');
      const select = source.match(/_STATUS_GENERATION_SELECT = '([^']+)'/);

      expect(select, service).not.toBeNull();
      expect(select?.[1].split(',').map((column) => column.trim()), service).toContain(
        'error_message',
      );
    }
  });
});
