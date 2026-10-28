import { describe, expect, it } from 'vitest';

import { motionSettingsSummary, videoRunShortSummary, videoSettingsSummary } from '../../ugc-mobile/lib/creator-settings-summary/creator-settings-summary';

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

  // The redesigned creator's chip (owner, 2026-10-28): "480P · 9:16 · 5s · Sound off".
  it('says whether the run makes sound, on a model that can switch it', () => {
    expect(videoSettingsSummary({ modeLabel: '', resolution: '480p', aspectRatio: '9:16', durationSeconds: 5, sound: false }))
      .toBe('480P · 9:16 · 5s · Sound off');
    expect(videoSettingsSummary({ modeLabel: '', resolution: '480p', aspectRatio: '9:16', durationSeconds: 5, sound: true }))
      .toBe('480P · 9:16 · 5s · Sound on');
    expect(videoSettingsSummary({ modeLabel: '', resolution: '720p', aspectRatio: '16:9', durationSeconds: 5, sound: null }))
      .toBe('720P · 16:9 · 5s');
  });

  it('keeps the resolution and length alone for a narrow chip and a model row', () => {
    expect(videoRunShortSummary({ modeLabel: '', resolution: '480p', durationSeconds: 5 })).toBe('480P · 5s');
    expect(videoRunShortSummary({ modeLabel: 'Pro (1080p, High Quality)', resolution: '', durationSeconds: 10 })).toBe('1080P · 10s');
    expect(videoRunShortSummary({ modeLabel: 'Fast', resolution: '', durationSeconds: 8 })).toBe('8s');
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
