import { describe, expect, it } from 'vitest';

import { motionSettingsSummary, videoSettingsSummary } from '../../ugc-mobile/lib/creator-settings-summary/creator-settings-summary';

/**
 * The chip's words, which the web creators and the app's creator bar read from one module
 * (the app's reading of its draft into them: ugc-mobile/__tests__/creator-parameter-summary.test.ts).
 */
describe('the video settings chip', () => {
  it('reads the resolution, the ratio and the length', () => {
    expect(videoSettingsSummary({ modeLabel: '', resolution: '720p', aspectRatio: '16:9', durationSeconds: 5 }))
      .toBe('720P · 16:9 · 5s');
  });

  it('takes the resolution a mode names over the resolution setting', () => {
    expect(videoSettingsSummary({ modeLabel: 'Pro 1080p', resolution: '720p', aspectRatio: '9:16', durationSeconds: 10 }))
      .toBe('1080P · 9:16 · 10s');
    expect(videoSettingsSummary({ modeLabel: 'Quality (4K)', resolution: '', aspectRatio: '16:9', durationSeconds: 8 }))
      .toBe('4K · 16:9 · 8s');
  });

  it('leaves the resolution out for a model that sets none', () => {
    expect(videoSettingsSummary({ modeLabel: 'Fast', resolution: '', aspectRatio: '1:1', durationSeconds: 6 }))
      .toBe('1:1 · 6s');
  });
});

describe('the motion settings chip', () => {
  it('reads the quality and the reference video\'s length, rounded up', () => {
    expect(motionSettingsSummary({ quality: '720p', referenceSeconds: 7.2 })).toBe('720P · 8s');
    expect(motionSettingsSummary({ quality: '1080p', referenceSeconds: 12 })).toBe('1080P · 12s');
  });

  it('asks for the motion until there is a reference video', () => {
    expect(motionSettingsSummary({ quality: '720p', referenceSeconds: 0 })).toBe('720P · Add motion');
    expect(motionSettingsSummary({ quality: '720p', referenceSeconds: null })).toBe('720P · Add motion');
  });
});
