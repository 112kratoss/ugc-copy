import { describe, expect, it } from 'vitest';

import {
  GENERATION_SETUP_LABELS,
  describeGenerationSetup,
  formatGenerationSetupLine,
  generationSetupTerm,
  readGenerationSetup,
} from '../lib/generation-setup/generation-setup';

/**
 * A creation's settings are a standard detail of its post (owner, 2026-11-03):
 * one quiet line under Made with, in the same words on the web's post page and
 * in the app's Details, which both draw it with this module.
 */
describe('the generation setup line', () => {
  it('reads an image run as the owner wrote it out', () => {
    const setup = [
      { label: 'Aspect ratio', value: '9:16' },
      { label: 'Resolution', value: '1K' },
      { label: 'Output format', value: 'JPG' },
      { label: 'Google Search grounding', value: 'Off' },
    ];
    expect(formatGenerationSetupLine(setup)).toBe('9:16 · 1K · JPG · Search grounding off');
  });

  it('names a switch and a count with what they are, and lets a value that names itself stand alone', () => {
    expect(generationSetupTerm({ label: GENERATION_SETUP_LABELS.sound, value: 'On' })).toBe('Sound on');
    expect(generationSetupTerm({ label: GENERATION_SETUP_LABELS.googleSearch, value: 'On' })).toBe('Search grounding on');
    expect(generationSetupTerm({ label: GENERATION_SETUP_LABELS.shots, value: '3' })).toBe('3 shots');
    expect(generationSetupTerm({ label: GENERATION_SETUP_LABELS.shots, value: '1' })).toBe('1 shot');
    expect(generationSetupTerm({ label: GENERATION_SETUP_LABELS.aspectRatio, value: 'Auto' })).toBe('Auto ratio');
    expect(generationSetupTerm({ label: GENERATION_SETUP_LABELS.duration, value: '5s' })).toBe('5s');
    expect(generationSetupTerm({ label: GENERATION_SETUP_LABELS.camera, value: 'Fixed lens' })).toBe('Fixed lens');
    expect(generationSetupTerm({ label: GENERATION_SETUP_LABELS.characterOrientation, value: 'Follow video' })).toBe('Follow video');
  });

  it('keeps a setting a newer server adds readable: its value, or its name beside a switch', () => {
    expect(generationSetupTerm({ label: 'Seed', value: '42' })).toBe('42');
    expect(generationSetupTerm({ label: 'Prompt magic', value: 'Off' })).toBe('Prompt magic off');
  });

  it('tells a screen reader each value by its name', () => {
    expect(describeGenerationSetup([
      { label: 'Aspect ratio', value: '16:9' },
      { label: 'Sound', value: 'On' },
    ])).toBe('Aspect ratio: 16:9, Sound: On');
  });

  it('reads the pairs an answer carries, and nothing from one that carries none', () => {
    expect(readGenerationSetup(undefined)).toBeUndefined();
    expect(readGenerationSetup(null)).toBeUndefined();
    expect(readGenerationSetup([])).toEqual([]);
    expect(readGenerationSetup([
      { label: ' Aspect ratio ', value: '9:16' },
      { label: 'Resolution', value: '' },
      { label: 7, value: 'x' },
      null,
      'Sound: On',
      { label: 'Sound', value: 'On' },
    ])).toEqual([
      { label: 'Aspect ratio', value: '9:16' },
      { label: 'Sound', value: 'On' },
    ]);
  });
});
