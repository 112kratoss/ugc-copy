import { describe, expect, it } from 'vitest';

import {
  cheapestCost,
  fitSettingsToControls,
  groupModelsByBalance,
  optionPriceLabel,
  referenceKeepWords,
  resolutionRank,
  samePriceForEach,
  type FitControl,
} from '../../ugc-mobile/lib/creator-run-fit/creator-run-fit';

/**
 * The fitting rule both creators read (ugc-mobile/lib/creator-run-fit/). The controls
 * below are production's, as release mini-default-video-20261028 publishes them.
 */
const choice = (key: string, values: string[], defaultValue = values[0]): FitControl => ({
  key, type: 'choice', defaultValue, options: values.map((value) => ({ value })),
});
const ratios = choice('aspectRatio', ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']);
const MINI: FitControl[] = [
  ratios,
  choice('resolution', ['480p', '720p']),
  { key: 'duration', type: 'integer', defaultValue: 5, min: 4, max: 15, step: 1 },
  { key: 'sound', type: 'boolean', defaultValue: false },
  choice('referenceMode', ['frames', 'elements']),
];
const SEEDANCE_15_PRO: FitControl[] = [
  choice('aspectRatio', ['1:1', '21:9', '4:3', '3:4', '16:9', '9:16']),
  choice('resolution', ['480p', '720p', '1080p']),
  choice('duration', ['4', '8', '12']),
  { key: 'sound', type: 'boolean', defaultValue: false },
  { key: 'fixedLens', type: 'boolean', defaultValue: false },
  choice('referenceMode', ['frames', 'elements']),
];
const MINIMAX_H3: FitControl[] = [
  choice('aspectRatio', ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']),
  choice('resolution', ['768P', '2K']),
  { key: 'duration', type: 'integer', defaultValue: 6, min: 4, max: 15, step: 1 },
  choice('referenceMode', ['frames', 'elements']),
];
const HAILUO: FitControl[] = [
  choice('aspectRatio', ['Auto']),
  choice('mode', ['standard', 'pro']),
  choice('resolution', ['768P', '1080P']),
  choice('duration', ['6', '10']),
];
const GROK: FitControl[] = [
  choice('aspectRatio', ['2:3', '3:2', '1:1', '9:16', '16:9']),
  choice('mode', ['normal', 'fun']),
  choice('resolution', ['480p', '720p']),
  { key: 'duration', type: 'integer', defaultValue: 6, min: 6, max: 30, step: 1 },
  choice('referenceMode', ['frames', 'elements']),
];

const miniRun = { aspectRatio: '9:16', resolution: '480p', duration: 5, sound: false, referenceMode: 'elements' };

describe('the settings a model opens on', () => {
  it('keeps every setting of the run that the model offers', () => {
    expect(fitSettingsToControls(MINI, miniRun)).toEqual(miniRun);
    expect(fitSettingsToControls(MINI, { ...miniRun, sound: true, resolution: '720p', duration: 12 }))
      .toEqual({ ...miniRun, sound: true, resolution: '720p', duration: 12 });
  });

  it('moves a length the model offers as a list to the nearest, the shorter of two as near', () => {
    const lengthOn = (duration: number) => fitSettingsToControls(SEEDANCE_15_PRO, { ...miniRun, duration }).duration;
    expect(lengthOn(5)).toBe('4');
    expect(lengthOn(6)).toBe('4');
    expect(lengthOn(10)).toBe('8');
    expect(lengthOn(15)).toBe('12');
    expect(lengthOn(8)).toBe('8');
  });

  it('holds a length inside the range a model takes', () => {
    expect(fitSettingsToControls(MINI, { duration: 2 }).duration).toBe(4);
    expect(fitSettingsToControls(MINI, { duration: 30 }).duration).toBe(15);
    expect(fitSettingsToControls(GROK, { duration: 5 }).duration).toBe(6);
    expect(fitSettingsToControls(MINI, { duration: '7' }).duration).toBe(7);
  });

  it('moves a resolution the model lacks to its nearest, the lower of two as near', () => {
    expect(fitSettingsToControls(MINIMAX_H3, { resolution: '480p' }).resolution).toBe('768P');
    expect(fitSettingsToControls(MINI, { resolution: '1080p' }).resolution).toBe('720p');
    expect(fitSettingsToControls(HAILUO, { resolution: '720p' }).resolution).toBe('768P');
    expect(fitSettingsToControls(MINIMAX_H3, { resolution: '4k' }).resolution).toBe('2K');
  });

  it('gives any other setting the model lacks its own default, and leaves out what the model has not', () => {
    const onHailuo = fitSettingsToControls(HAILUO, { ...miniRun, mode: 'fun' });
    expect(onHailuo).toEqual({ aspectRatio: 'Auto', mode: 'standard', resolution: '768P', duration: '6' });
    expect(fitSettingsToControls(GROK, { ...miniRun, mode: 'fun' }).mode).toBe('fun');
    expect(fitSettingsToControls(GROK, { aspectRatio: '4:3' }).aspectRatio).toBe('2:3');
    expect(fitSettingsToControls(MINI, { ...miniRun, fixedLens: true })).not.toHaveProperty('fixedLens');
  });

  it('carries sound and a fixed lens to a model that offers them, and defaults the rest', () => {
    expect(fitSettingsToControls(SEEDANCE_15_PRO, { sound: true, fixedLens: true })).toMatchObject({ sound: true, fixedLens: true });
    expect(fitSettingsToControls(SEEDANCE_15_PRO, {})).toMatchObject({ sound: false, fixedLens: false, duration: '4' });
  });

  it('orders resolutions by height', () => {
    expect([resolutionRank('480p'), resolutionRank('768P'), resolutionRank('2K'), resolutionRank('4k'), resolutionRank('Auto')])
      .toEqual([480, 768, 2000, 4000, null]);
  });
});

describe('the model list split by the balance', () => {
  const row = (id: string, cost: number | null) => ({ id, cost, item: id });
  const models = [
    row('seedance-1.5-pro', 7), row('seedance-2', 76), row('seedance-2-fast', 59), row('seedance-2-mini', 19),
    row('hailuo-2.3', null), row('grok-imagine-video', 15), row('seedance-2-5', 140), row('minimax-h3', 48),
  ];
  const ids = (list: ReadonlyArray<{ id: string }>) => list.map((model) => model.id);

  it('puts the model in use first among those the balance covers, then the cheapest', () => {
    const split = groupModelsByBalance(models, 22, 'seedance-2-mini');
    expect(ids(split.fits)).toEqual(['seedance-2-mini', 'seedance-1.5-pro', 'grok-imagine-video']);
    expect(ids(split.needsMore)).toEqual(['minimax-h3', 'seedance-2-fast', 'seedance-2', 'seedance-2-5']);
    expect(ids(split.unpriced)).toEqual(['hailuo-2.3']);
  });

  it('counts a run that costs the whole balance as fitting, and files the model in use by its price when it does not', () => {
    const split = groupModelsByBalance(models, 19, 'seedance-2-5');
    expect(ids(split.fits)).toEqual(['seedance-1.5-pro', 'grok-imagine-video', 'seedance-2-mini']);
    expect(ids(split.needsMore).at(-1)).toBe('seedance-2-5');
  });
});

describe('prices read against the balance', () => {
  it('marks an option that costs more than the balance by how much', () => {
    expect(optionPriceLabel(16, 22)).toEqual({ text: '16', over: null });
    expect(optionPriceLabel(22, 22)).toEqual({ text: '22', over: null });
    expect(optionPriceLabel(23, 22)).toEqual({ text: '23 · +1', over: 1 });
    expect(optionPriceLabel(57, null)).toEqual({ text: '57', over: null });
  });

  it('finds the cheapest known price, the one a balance short of every run is under', () => {
    expect(cheapestCost([19, null, 7])).toBe(7);
    expect(cheapestCost([null])).toBeNull();
  });

  it('tells a setting whose options all cost the same, every price known', () => {
    expect(samePriceForEach([19, 19, 19])).toBe(true);
    expect(samePriceForEach([19, 23])).toBe(false);
    expect(samePriceForEach([19, null])).toBe(false);
    expect(samePriceForEach([19])).toBe(false);
  });

  it('says what a model keeps of the run\'s references', () => {
    expect(referenceKeepWords(0, 0)).toBeNull();
    expect(referenceKeepWords(2, 2)).toEqual({ words: 'Keeps your 2 references', keepsAll: true });
    expect(referenceKeepWords(1, 5)).toEqual({ words: 'Keeps your reference', keepsAll: true });
    expect(referenceKeepWords(3, 1)).toEqual({ words: 'Keeps 1 of your 3 references', keepsAll: false });
    expect(referenceKeepWords(2, 0)).toEqual({ words: 'Drops your references', keepsAll: false });
    expect(referenceKeepWords(1, 0)).toEqual({ words: 'Drops your reference', keepsAll: false });
    expect(referenceKeepWords(2, 2, 'frame')).toEqual({ words: 'Keeps your 2 frames', keepsAll: true });
    expect(referenceKeepWords(2, 1, 'frame')).toEqual({ words: 'Keeps 1 of your 2 frames', keepsAll: false });
  });
});
