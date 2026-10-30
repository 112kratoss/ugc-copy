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
  referenceMediaRole,
} from '@/lib/provider-input-limits';
import {
  CREATOR_LENGTH_READING_SLACK_SECONDS,
  catalogInputTooShort,
} from '../../ugc-mobile/lib/model-catalog/protocol';

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
  const roleOf = (model: GenerationModelDescriptor, slot: CatalogInputSlot) => (
    referenceMediaRole(model.kind, slot.key, slot.kind as 'video' | 'audio')
  );
  /** Every slot that publishes a shortest clip or track, with its model. */
  const published = catalog.models.flatMap((model) => slotsOf(model)
    .filter((slot) => slot.minDurationSeconds !== undefined)
    .map((slot) => ({ model, slot, minimum: slot.minDurationSeconds! })));

  it('publishes Kling 3.0’s video elements at the start’s own 3 seconds, on a slot whose files the start measures', () => {
    expect(elements).toMatchObject({ kind: 'video', durationMetadata: 'optional', minDurationSeconds: 3 });
    expect(referenceMediaMinSeconds('kling-3.0-video', 'element')).toBe(3);
    // This release publishes that one; the start's other minimums (Seedance's 2 s clips and
    // tracks, a motion performance's 3 s) stay the start's alone until a release publishes them.
    expect(published.map(({ model, slot, minimum }) => [model.id, slot.key, minimum, referenceMediaMinSeconds(model.id, roleOf(model, slot))]))
      .toEqual([['kling-3.0-video', 'videoElements', 3, 3]]);
  });

  it('is read back from the published row, and one that is no length is left out of it', () => {
    const row = { ...kling, schemaVersion: 2 };
    const read = (value: unknown) => parsePublishedModelDescriptor(value, 'kling-3.0-video', 2, { web: true, mobile: true });

    expect(slotsOf(read(row)).find((slot) => slot.key === 'videoElements')).toEqual(elements);
    // Refusing the row would take every model's quotes and starts down with it; the minimum only
    // lets the creators speak before Generate, and the start holds the clip to its own.
    const withoutMinimum: CatalogInputSlot = { ...elements };
    delete withoutMinimum.minDurationSeconds;
    for (const minDurationSeconds of [0, -3, '3', null, Number.NaN]) {
      const broken = structuredClone(row) as unknown as GenerationModelDescriptor;
      const slot = slotsOf(broken).find((candidate) => candidate.key === 'videoElements')!;
      (slot as unknown as Record<string, unknown>).minDurationSeconds = minDurationSeconds;
      expect(slotsOf(read(broken)).find((candidate) => candidate.key === 'videoElements'), String(minDurationSeconds))
        .toEqual(withoutMinimum);
    }
  });

  it('holds only a clip the start refuses, in the start’s words, for every slot that publishes a minimum', () => {
    // As the creators send a clip: its name, and the length they read off the file.
    const start = (model: GenerationModelDescriptor, slot: CatalogInputSlot, label: string, durationSeconds: number | null | undefined) => (
      referenceMediaLengthViolation(model.id, [{ role: roleOf(model, slot), durationSeconds, label }])
    );
    for (const { model, slot, minimum } of published) {
      for (let tenths = 1; tenths <= minimum * 10 + 5; tenths += 1) {
        for (const durationSeconds of [tenths / 10, tenths / 10 - 0.004, tenths / 10 + 0.04]) {
          const label = 'Harbour wave';
          const creators = catalogInputTooShort(model.displayName, slot, { label, durationSeconds });
          const refused = start(model, slot, label, durationSeconds);
          const context = `${model.id} ${slot.key} ${durationSeconds}`;
          // Held only where the start refuses, and then in the same words.
          if (creators !== null) expect(creators, context).toBe(refused);
          // Past the slack the creators hold every clip the start refuses: no clip it would refuse goes unsaid.
          if (durationSeconds < minimum - CREATOR_LENGTH_READING_SLACK_SECONDS) expect(creators, context).toBe(refused);
          // A clip the start would take, or one just short of it that a reading a frame off could make
          // long enough, goes: the start judges it before any hold.
          if (durationSeconds >= minimum - CREATOR_LENGTH_READING_SLACK_SECONDS) expect(creators, context).toBeNull();
        }
      }
    }
    expect(catalogInputTooShort(kling.displayName, elements, { label: 'Harbour wave', durationSeconds: 1 }))
      .toBe('Kling 3.0 Cinematic video elements must be at least 3 seconds long. Harbour wave runs 1 second.');
    // A length nobody read: the start measures the file and decides.
    for (const durationSeconds of [null, undefined, 0, -1, Number.NaN]) {
      expect(catalogInputTooShort(kling.displayName, elements, { label: 'Video element 1', durationSeconds }), String(durationSeconds)).toBeNull();
    }
    // A slot that publishes no minimum holds nothing.
    expect(catalogInputTooShort('Seedance 2', { label: 'Reference videos' }, { label: 'Clip', durationSeconds: 0.5 })).toBeNull();
  });

  it('reaches the web page through its affordances once the descriptor is in, and not before', () => {
    expect(getVideoInputAffordances(kling, 'kling-3.0-video').minimumLengths).toEqual(new Map([['videoElements', elements]]));
    // Before the catalog arrives the page keeps its tables, which hold no minimum.
    expect(getVideoInputAffordances(null, 'kling-3.0-video').minimumLengths.size).toBe(0);
    const seedance = catalog.models.find((model) => model.id === 'seedance-2')!;
    expect(getVideoInputAffordances(seedance, 'seedance-2', { referenceMode: 'elements' }).minimumLengths.size).toBe(0);
  });
});
