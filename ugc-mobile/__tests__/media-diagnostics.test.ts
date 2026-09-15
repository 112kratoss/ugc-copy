import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearMediaDiagnosticsForTests,
  describeImageError,
  formatMediaDiagnosticsReport,
  hashMediaSubject,
  readMediaDiagnostics,
  recordMediaDiagnostic,
  summarizeMediaDiagnostics,
} from '../lib/media-diagnostics';

describe('media diagnostics', () => {
  beforeEach(() => {
    clearMediaDiagnosticsForTests();
  });

  it('names media by a stable hash, never by their address', () => {
    const address = 'https://storage.example/object/sign/generated_images/owner/a.webp?token=abc';
    recordMediaDiagnostic({ kind: 'image', event: 'stall', surface: 'viewer', subject: address, attempt: 0 });

    const [entry] = readMediaDiagnostics().events;
    expect(entry.subject).toBe(hashMediaSubject(address));
    expect(entry.subject).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(readMediaDiagnostics())).not.toContain('token=abc');
  });

  it('keeps only the most recent events', () => {
    for (let index = 0; index < 250; index += 1) {
      recordMediaDiagnostic({ kind: 'image', event: 'error', surface: 'feed', subject: `media-${index}`, attempt: 0 });
    }

    const { events } = readMediaDiagnostics();
    expect(events).toHaveLength(200);
    expect(events[0].subject).toBe(hashMediaSubject('media-50'));
  });

  it('keeps an error\'s status code and drops the rest of its text', () => {
    expect(describeImageError({ error: 'HTTP 403 for https://storage.example/a.webp?token=abc' }))
      .toEqual({ stage: 'http', status: 403 });
    expect(describeImageError({ error: 'Failed to decode image' })).toEqual({ stage: 'decode' });
    expect(describeImageError(undefined)).toEqual({ stage: 'load' });
  });

  it('formats a report that can be pasted into a support message', () => {
    recordMediaDiagnostic({ kind: 'image', event: 'stall', surface: 'profile-grid', subject: 'a', attempt: 0, stage: 'no-response' });
    recordMediaDiagnostic({ kind: 'image', event: 'recovered', surface: 'profile-grid', subject: 'a', attempt: 1 });
    const diagnostics = readMediaDiagnostics();

    const report = formatMediaDiagnosticsReport({
      versionLabel: 'Version 0.1.4 (71) · update 0558882d',
      diagnostics,
      now: Date.parse('2026-09-16T12:00:00.000Z'),
    });

    expect(summarizeMediaDiagnostics(diagnostics.events)).toEqual({ total: 2, stalls: 1, failures: 0, recoveries: 1 });
    expect(report).toContain('Version 0.1.4 (71) · update 0558882d');
    expect(report).toContain('Events 2 · stalls 1 · failures 0 · recoveries 1');
    expect(report).toContain(`image stall profile-grid ${hashMediaSubject('a')} attempt 0 no-response`);
  });
});
