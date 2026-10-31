import { describe, expect, it } from 'vitest';

import { motionRunClipSlot } from '@/lib/creator-run-inputs';
import { getVideoInputAffordances } from '@/lib/generation-model-affordances';
import {
  buildGenerationModelCatalog,
  type CatalogInputSlot,
  type GenerationModelDescriptor,
} from '@/lib/generation-model-catalog';
import { parsePublishedModelDescriptor } from '@/lib/generation-model-descriptor-parser';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';
import {
  referenceMediaLengthViolation,
  referenceMediaMinSeconds,
  referenceMediaRole,
} from '@/lib/provider-input-limits';
import { durationBoundInputSlots } from '@/lib/unified-generation-start-service';
import {
  CREATOR_LENGTH_READING_SLACK_SECONDS,
  catalogInputTooShort,
} from '../../ugc-mobile/lib/model-catalog/protocol';
import { PRODUCTION_KLING_3_MOTION_MODES } from './fixtures/production-motion-descriptors';

/**
 * The shortest clip or track a slot takes (`minDurationSeconds`). Kie refuses a Kling 3.0 video
 * element under 3 seconds, a Seedance 2 or MiniMax H3 clip or track under 2, a Wan clip or track
 * under 1 and a Kling motion-control clip under 3. The server's start refused such a run before any
 * hold (provider-input-limits), but the creator learned it only once Generate was pressed. The
 * catalog publishes the start's own minimum on the slot, and the creators hold a run to it, in the
 * start's words, before Generate (the web's video and motion pages, the app's
 * validateCatalogCreationDraft).
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
  const operations = new Map(buildCodeGenerationModelOperations().map((operation) => [operation.modelId, operation]));
  /** A clip or track slot whose files the start measures before it judges them (`durationBoundInputSlots`). */
  const measured = (model: GenerationModelDescriptor, slot: CatalogInputSlot) => (
    (slot.kind === 'video' || slot.kind === 'audio') && durationBoundInputSlots(model, operations.get(model.id)!).has(slot.key)
  );
  /** Every slot that publishes a shortest clip or track, with its model. */
  const published = catalog.models.flatMap((model) => slotsOf(model)
    .filter((slot) => slot.minDurationSeconds !== undefined)
    .map((slot) => ({ model, slot, minimum: slot.minDurationSeconds! })));

  it('publishes Kling 3.0’s video elements at the start’s own 3 seconds, on a slot whose files the start measures', () => {
    expect(elements).toMatchObject({ kind: 'video', durationMetadata: 'optional', minDurationSeconds: 3 });
    expect(referenceMediaMinSeconds('kling-3.0-video', 'element')).toBe(3);
  });

  it('publishes on every slot whose files the start measures the shortest it takes there, and on no other slot', () => {
    for (const model of catalog.models) {
      for (const slot of slotsOf(model).filter((candidate) => measured(model, candidate))) {
        expect(slot.minDurationSeconds, `${model.id} ${slot.key}`).toBe(referenceMediaMinSeconds(model.id, roleOf(model, slot)));
      }
    }
    expect(published.filter(({ model, slot }) => !measured(model, slot))).toEqual([]);
    // Kie's documented minimums, as provider-input-limits.ts records them with their sources.
    expect(published.map(({ model, slot, minimum }) => `${model.id} ${slot.key} ${minimum}`).sort()).toEqual([
      'kling-2.6 referenceVideo 3',
      'kling-3.0 referenceVideo 3',
      'kling-3.0-video videoElements 3',
      'minimax-h3 audioReferences 2',
      'minimax-h3 videoReferences 2',
      'seedance-2 audioReferences 2',
      'seedance-2 videoReferences 2',
      'seedance-2-5 audioReferences 2',
      'seedance-2-5 videoReferences 2',
      'seedance-2-fast audioReferences 2',
      'seedance-2-fast videoReferences 2',
      'seedance-2-mini audioReferences 2',
      'seedance-2-mini videoReferences 2',
      'wan-2.7 audioReferences 1',
      'wan-3.0 audioReferences 1',
      'wan-3.0 videoReferences 1',
      'wan-3.0-prime audioReferences 1',
      'wan-3.0-prime videoReferences 1',
    ]);
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
    // Seedance 2's clips and tracks, in the references run that sends them.
    const seedance = catalog.models.find((model) => model.id === 'seedance-2')!;
    const seedanceSlot = (key: string) => slotsOf(seedance).find((slot) => slot.key === key)!;
    expect(getVideoInputAffordances(seedance, 'seedance-2', { referenceMode: 'elements' }).minimumLengths)
      .toEqual(new Map([['videoReferences', seedanceSlot('videoReferences')], ['audioReferences', seedanceSlot('audioReferences')]]));
    expect(getVideoInputAffordances(seedance, 'seedance-2', { referenceMode: 'frames' }).minimumLengths.size).toBe(0);
  });

  it('reaches the motion pages through the slot a motion run sends its clip in', () => {
    // The motion pages place the clip with the shared motion rule (planMotionRunInputs), and read the
    // slot it lands in. Production's Kling 3.0 motion keeps the plain reference slots of the
    // compatibility release, which publish no minimum: the start judges its clips, as before.
    for (const id of ['kling-2.6', 'kling-3.0']) {
      const motion = catalog.models.find((model) => model.id === id)!;
      expect(motionRunClipSlot(motion, {}), id).toMatchObject({ key: 'referenceVideo', label: 'Reference video', minDurationSeconds: 3 });
    }
    expect(motionRunClipSlot({ inputModes: PRODUCTION_KLING_3_MOTION_MODES }, {})).toMatchObject({ key: 'videoReferences' });
    expect(motionRunClipSlot({ inputModes: PRODUCTION_KLING_3_MOTION_MODES }, {})?.minDurationSeconds).toBeUndefined();
    expect(motionRunClipSlot(null, {})).toBeNull();
  });
});
