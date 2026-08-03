import { describe, expect, it } from 'vitest';

import {
  RECLAIM_AFTER_HOURS,
  SIGNED_UPLOAD_EXPIRES_IN_SECONDS,
  getUploadIntentAgeHours,
  resolveUploadIntentReclaim,
  type UnclearedUploadIntent,
} from '@/lib/media-upload-reclaim';

const NOW = new Date('2026-08-03T12:00:00.000Z');

function intentAgedHours(hours: number, overrides: Partial<UnclearedUploadIntent> = {}): UnclearedUploadIntent {
  return {
    storagePath: 'user-1/00000000-0000-0000-0000-000000000000-media.jpg',
    kind: 'image',
    declaredBytes: 1024,
    createdAt: new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString(),
    consumedBy: null,
    objectExists: true,
    ...overrides,
  };
}

describe('upload intent reclaim policy', () => {
  it('keeps uploaded objects until the reclaim window elapses', () => {
    expect(resolveUploadIntentReclaim(intentAgedHours(0), NOW).action).toBe('keep');
    expect(resolveUploadIntentReclaim(intentAgedHours(RECLAIM_AFTER_HOURS - 1), NOW).action).toBe('keep');
  });

  it('reclaims uploaded objects once they are older than the window', () => {
    const decision = resolveUploadIntentReclaim(intentAgedHours(RECLAIM_AFTER_HOURS), NOW);
    expect(decision.action).toBe('reclaim');
    expect(decision.reason).toContain(String(RECLAIM_AFTER_HOURS));
  });

  it('names the consumer in the reason so the sweep log distinguishes the two leaks', () => {
    // A generation input was copied into generation_inputs and left behind on
    // purpose; an unclaimed one is an abandoned composer draft. Same action,
    // very different thing to see spiking in production.
    expect(
      resolveUploadIntentReclaim(
        intentAgedHours(RECLAIM_AFTER_HOURS, { consumedBy: 'generation_input' }),
        NOW,
      ).reason,
    ).toContain('generation_input');
    expect(
      resolveUploadIntentReclaim(intentAgedHours(RECLAIM_AFTER_HOURS), NOW).reason,
    ).toContain('unclaimed');
  });

  it('drops rows for intents whose signed URL expired without an upload', () => {
    const expiredHours = SIGNED_UPLOAD_EXPIRES_IN_SECONDS / 3600;
    expect(
      resolveUploadIntentReclaim(intentAgedHours(expiredHours, { objectExists: false }), NOW),
    ).toEqual({ action: 'drop-row', reason: 'signed_url_expired_without_upload' });
  });

  it('leaves an unwritten object alone while its signed URL is still usable', () => {
    const decision = resolveUploadIntentReclaim(intentAgedHours(1, { objectExists: false }), NOW);
    expect(decision).toEqual({ action: 'keep', reason: 'signed_url_still_valid' });
  });

  it('never reclaims storage for an intent that was never uploaded', () => {
    // The row is garbage, but there are no bytes behind it -- a 'reclaim' here
    // would send the sweep to delete an object that does not exist.
    for (const hours of [0, 1, RECLAIM_AFTER_HOURS, RECLAIM_AFTER_HOURS * 10]) {
      expect(
        resolveUploadIntentReclaim(intentAgedHours(hours, { objectExists: false }), NOW).action,
      ).not.toBe('reclaim');
    }
  });

  it('treats every media kind the same way', () => {
    const kinds: UnclearedUploadIntent['kind'][] = ['image', 'video', 'audio'];
    const decisions = kinds.map((kind) => resolveUploadIntentReclaim(
      intentAgedHours(RECLAIM_AFTER_HOURS, { kind }),
      NOW,
    ).action);
    expect(new Set(decisions).size).toBe(1);
  });

  it('reports a zero age rather than NaN for an unparseable timestamp', () => {
    const intent = intentAgedHours(0, { createdAt: 'not-a-timestamp' });
    expect(getUploadIntentAgeHours(intent, NOW)).toBe(0);
    expect(resolveUploadIntentReclaim(intent, NOW).action).toBe('keep');
  });
});
