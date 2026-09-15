import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MEDIA_DIAGNOSTICS_EVENTS_PER_REPORT,
  MEDIA_DIAGNOSTICS_REPORT_DELAY_MS,
  MEDIA_DIAGNOSTICS_REPORT_SPACING_MS,
  MEDIA_DIAGNOSTICS_REPORTS_PER_SESSION,
  clearMediaDiagnosticsForTests,
  recordMediaDiagnostic,
  setMediaDiagnosticsReporter,
  type MediaDiagnosticsReport,
} from '../lib/media-diagnostics';

const app = () => ({ version: '0.1.4', build: '71', update: '0558882d' });

function stall(subject: string, attempt = 0) {
  recordMediaDiagnostic({ kind: 'image', event: 'stall', surface: 'profile-grid', subject, attempt, stage: 'no-response' });
}

function reporterSpy() {
  return vi.fn(async (_report: MediaDiagnosticsReport) => undefined);
}

describe('sampled media diagnostics reports', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearMediaDiagnosticsForTests();
  });

  afterEach(() => {
    clearMediaDiagnosticsForTests();
    vi.useRealTimers();
  });

  it('gathers a burst of stalls into one report after a short delay', () => {
    const send = reporterSpy();
    setMediaDiagnosticsReporter({ send, app });

    stall('a');
    stall('b');
    stall('c');
    vi.advanceTimersByTime(MEDIA_DIAGNOSTICS_REPORT_DELAY_MS - 1);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ app: app(), events: [{ event: 'stall' }, { event: 'stall' }, { event: 'stall' }] });
  });

  it('leaves routine errors and recoveries out', () => {
    const send = reporterSpy();
    setMediaDiagnosticsReporter({ send, app });

    recordMediaDiagnostic({ kind: 'image', event: 'error', surface: 'viewer', subject: 'a', attempt: 0, stage: 'load' });
    recordMediaDiagnostic({ kind: 'image', event: 'recovered', surface: 'viewer', subject: 'a', attempt: 1 });
    vi.advanceTimersByTime(MEDIA_DIAGNOSTICS_REPORT_SPACING_MS);

    expect(send).not.toHaveBeenCalled();
  });

  it('waits out the spacing after one report before sending the next', () => {
    const send = reporterSpy();
    setMediaDiagnosticsReporter({ send, app });

    stall('first');
    vi.advanceTimersByTime(MEDIA_DIAGNOSTICS_REPORT_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);

    stall('second');
    vi.advanceTimersByTime(MEDIA_DIAGNOSTICS_REPORT_SPACING_MS - 1);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never repeats an event and stops at the session cap', () => {
    const send = reporterSpy();
    setMediaDiagnosticsReporter({ send, app });

    for (let round = 0; round < MEDIA_DIAGNOSTICS_REPORTS_PER_SESSION + 2; round += 1) {
      stall(`media-${round}`);
      vi.advanceTimersByTime(MEDIA_DIAGNOSTICS_REPORT_SPACING_MS);
    }

    expect(send).toHaveBeenCalledTimes(MEDIA_DIAGNOSTICS_REPORTS_PER_SESSION);
    const subjects = send.mock.calls.flatMap(([report]) => report.events.map((entry) => entry.subject));
    expect(new Set(subjects).size).toBe(subjects.length);
  });

  it('bounds a report and clamps attempt counts to what the backend accepts', () => {
    const send = reporterSpy();
    setMediaDiagnosticsReporter({ send, app });

    for (let index = 0; index < MEDIA_DIAGNOSTICS_EVENTS_PER_REPORT + 5; index += 1) stall(`media-${index}`, 14);
    vi.advanceTimersByTime(MEDIA_DIAGNOSTICS_REPORT_DELAY_MS);

    const [report] = send.mock.calls[0];
    expect(report.events).toHaveLength(MEDIA_DIAGNOSTICS_EVENTS_PER_REPORT);
    expect(report.events.every((entry) => entry.attempt === 10)).toBe(true);
  });

  it('drops a report that fails instead of retrying it', async () => {
    const send = vi.fn(async (_report: MediaDiagnosticsReport) => {
      throw new Error('Network request failed.');
    });
    setMediaDiagnosticsReporter({ send, app });

    stall('a');
    vi.advanceTimersByTime(MEDIA_DIAGNOSTICS_REPORT_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(MEDIA_DIAGNOSTICS_REPORT_SPACING_MS * 2);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports stalls recorded before the reporter existed, once it registers', () => {
    stall('early');
    const send = reporterSpy();
    setMediaDiagnosticsReporter({ send, app });

    vi.advanceTimersByTime(MEDIA_DIAGNOSTICS_REPORT_DELAY_MS);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].events).toHaveLength(1);
  });

  it('stops once unregistered', () => {
    const send = reporterSpy();
    const unregister = setMediaDiagnosticsReporter({ send, app });

    stall('a');
    unregister();
    vi.advanceTimersByTime(MEDIA_DIAGNOSTICS_REPORT_DELAY_MS * 2);

    expect(send).not.toHaveBeenCalled();
  });
});
