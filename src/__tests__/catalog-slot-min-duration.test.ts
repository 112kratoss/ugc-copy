import { describe, expect, it } from 'vitest';

import { getVideoInputAffordances } from '@/lib/generation-model-affordances';
import {
  buildGenerationModelCatalog,
  type CatalogInputSlot,
  type GenerationModelDescriptor,
} from '@/lib/generation-model-catalog';
import { parsePublishedModelDescriptor } from '@/lib/generation-model-descriptor-parser';
import {
  referenceMediaLengthViolation,
  referenceMediaMinSeconds,
  type ReferenceMediaRole,
} from '@/lib/provider-input-limits';
import { catalogInputTooShort } from '../../ugc-mobile/lib/model-catalog/protocol';

/**
 * The shortest clip or track a slot takes (`minDurationSeconds`). Kie's kling-3.0/video refuses a
 * video element under 3 seconds. The server's start refused such a run before any hold
 * (provider-input-limits), but the creator learned it only once Generate was pressed. The catalog
 * publishes the start's own minimum on the slot, and both creators hold a run to it, in the start's
 * words, before Generate (the web's video page, the app's validateCatalogCreationDraft).
 */
describe('the shortest clip a slot takes', () => {
  const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2, includeUnavailable: true });
  const slotsOf = (model: GenerationModelDescriptor) => (model.inputModes ?? []).flatMap((mode) => mode.slots);
  const kling = catalog.models.find((model) => model.id === 'kling-3.0-video')!;
  const elements = slotsOf(kling).find((slot) => slot.key === 'videoElements')!;

  /** What the catalog start calls a file in this slot when it holds the file to its provider's shortest. */
  const roleOf = (model: GenerationModelDescriptor, slot: CatalogInputSlot): ReferenceMediaRole => (
    slot.kind === 'audio' ? 'audio' : model.kind === 'motion' ? 'motion' : slot.key === 'videoElements' ? 'element' : 'video'
  );

  it('publishes Kling 3.0’s video elements at the start’s own 3 seconds, on a slot whose files the start measures', () => {
    expect(elements).toMatchObject({ kind: 'video', durationMetadata: 'optional', minDurationSeconds: 3 });
    expect(referenceMediaMinSeconds('kling-3.0-video', 'element')).toBe(3);
    // This release publishes that one; the start's other minimums (Seedance's 2 s clips and
    // tracks, a motion performance's 3 s) stay the start's alone until a release publishes them.
    const published = catalog.models.flatMap((model) => slotsOf(model)
      .filter((slot) => slot.minDurationSeconds !== undefined)
      .map((slot) => [model.id, slot.key, slot.minDurationSeconds, referenceMediaMinSeconds(model.id, roleOf(model, slot))]));
    expect(published).toEqual([['kling-3.0-video', 'videoElements', 3, 3]]);
  });

  it('is read back from the published row, and a row whose minimum is no length is refused', () => {
    const row = { ...kling, schemaVersion: 2 };
    const read = (value: unknown) => parsePublishedModelDescriptor(value, 'kling-3.0-video', 2, { web: true, mobile: true });

    expect(slotsOf(read(row)).find((slot) => slot.key === 'videoElements')).toEqual(elements);
    for (const minDurationSeconds of [0, -3, '3', null, Number.NaN]) {
      const broken = structuredClone(row) as unknown as GenerationModelDescriptor;
      const slot = slotsOf(broken).find((candidate) => candidate.key === 'videoElements')!;
      (slot as unknown as Record<string, unknown>).minDurationSeconds = minDurationSeconds;
      expect(() => read(broken), String(minDurationSeconds)).toThrow();
    }
  });

  it('says what the start says, for the clip the start would refuse', () => {
    // As the creators send a clip: its name, and the length they read off the file.
    for (const [label, durationSeconds] of [['Video element 1', 2.96], ['Harbour wave', 1], ['beach.mov', 0.25]] as const) {
      const words = catalogInputTooShort(kling.displayName, elements, { label, durationSeconds });
      expect(words, label).toBe(referenceMediaLengthViolation('kling-3.0-video', [{ role: 'element', durationSeconds, label }]));
    }
    expect(catalogInputTooShort(kling.displayName, elements, { label: 'Harbour wave', durationSeconds: 1 }))
      .toBe('Kling 3.0 Cinematic video elements must be at least 3 seconds long. Harbour wave runs 1 second.');
    // Long enough, or a length nobody read: the start measures the file and decides.
    for (const durationSeconds of [3, 3.01, 12, null, undefined, 0, Number.NaN]) {
      expect(catalogInputTooShort(kling.displayName, elements, { label: 'Video element 1', durationSeconds }), String(durationSeconds)).toBeNull();
      expect(referenceMediaLengthViolation('kling-3.0-video', [{ role: 'element', durationSeconds, label: 'Video element 1' }])).toBeNull();
    }
    // A slot that publishes no minimum holds nothing.
    expect(catalogInputTooShort('Seedance 2', { label: 'Reference videos' }, { label: 'Clip', durationSeconds: 0.5 })).toBeNull();
  });

  it('reaches the web page through its affordances once the descriptor is in, and not before', () => {
    expect(getVideoInputAffordances(kling, 'kling-3.0-video').minimumLengths)
      .toEqual(new Map([['videoElements', { label: 'Video elements', minDurationSeconds: 3 }]]));
    // Before the catalog arrives the page keeps its tables, which hold no minimum.
    expect(getVideoInputAffordances(null, 'kling-3.0-video').minimumLengths.size).toBe(0);
    const seedance = catalog.models.find((model) => model.id === 'seedance-2')!;
    expect(getVideoInputAffordances(seedance, 'seedance-2', { referenceMode: 'elements' }).minimumLengths.size).toBe(0);
  });
});
