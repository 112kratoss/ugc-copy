import {
  catalogConditionsMatch,
  SUBJECT_IMAGES_SLOT_KEY,
  type CatalogConditionLike,
  type CatalogConditionPrimitive,
  type CLIENT_RENDERED_INPUT_SLOT_KINDS,
  type CLIENT_RENDERED_INPUT_SLOT_ROLES,
} from '../../ugc-mobile/lib/model-catalog/protocol';

/**
 * The inputs a web creator's run sends, worked out before any file is uploaded: each
 * with the slot it goes in, its kind and the length the run reports for it, and what
 * in the draft it comes from. A creator asks for the run's price with these
 * (`catalogRunQuoteInput`) and posts the run from them, so its price is the server's
 * own quote of the run it starts: the server quotes a run again from the inputs it is
 * sent, every input counted by its kind, and charges or refuses that quote.
 *
 * The video creator counted its inputs by the part each plays instead. Wan 2.7's start
 * frame, sent beside five reference pictures or five clips, was left out of an
 * 80-credit quote with Generate on, and the start refused the run for its sixth image
 * (2026-10-18). The native creator was fixed the same way the day before.
 */

/** What a video draft holds, by the kind of item each slot is filled from. */
export type VideoRunMedia = {
  imageReference: unknown;
  reference: { durationSeconds?: number | null };
  videoElement: unknown;
  subjectImage: unknown;
};

export type VideoRunSubject<M extends VideoRunMedia> = {
  displayName: string;
  handle: string;
  images: readonly M['subjectImage'][];
};

export type VideoRunInput<M extends VideoRunMedia> =
  | { slot: 'imageReferences'; kind: 'image'; element: M['imageReference'] }
  | { slot: 'videoReferences'; kind: 'video'; durationSeconds: number | null; reference: M['reference'] }
  | { slot: 'audioReferences'; kind: 'audio'; durationSeconds: number | null; reference: M['reference'] }
  | { slot: 'videoElements'; kind: 'video'; element: M['videoElement'] }
  | { slot: typeof SUBJECT_IMAGES_SLOT_KEY; kind: 'image'; subject: VideoRunSubject<M>; image: M['subjectImage'] }
  | { slot: 'startFrame'; kind: 'image' }
  | { slot: 'endFrame'; kind: 'image' }
  | { slot: 'preparedVoices'; kind: 'preparedVoice'; assetId: string }
  | { slot: 'characters'; kind: 'character'; assetId: string };

export type VideoRunDraft<M extends VideoRunMedia> = {
  /** The run's shape, read off what it carries (`getVideoRunAffordances`). */
  activeReferenceMode: 'frames' | 'elements';
  /** A start frame goes beside the references (Wan 2.7's r2v endpoint takes `first_frame`). */
  combinesFrameWithReferences: boolean;
  /** Whether the model takes an end frame in this run. */
  takesEndFrame: boolean;
  isMultiShot: boolean;
  /** The references of each kind the run carries; a kind on standby is passed empty. */
  imageReferences: readonly M['imageReference'][];
  videoReferences: readonly M['reference'][];
  audioReferences: readonly M['reference'][];
  /** Kling 3.0's named video elements, a slot of their own beside either shape. */
  videoElements: readonly M['videoElement'][];
  /** Named subjects (Kling O3), when the run is in that shape. */
  subjects: readonly VideoRunSubject<M>[];
  hasStartFrame: boolean;
  hasEndFrame: boolean;
  /** Gemini Omni's prepared voices and characters, which stand beside either shape. */
  preparedVoiceIds: readonly string[];
  characterIds: readonly string[];
};

/**
 * The inputs of a video run, in the order the run sends them. Named subjects replace
 * frames and references; a multi-shot run sends its shots and no image reference, and
 * no end frame, which its page does not show; a start frame goes in a frames run, or
 * beside the references of a model that combines them.
 */
export function planVideoRunInputs<M extends VideoRunMedia>(draft: VideoRunDraft<M>): VideoRunInput<M>[] {
  const subjectsRun = draft.subjects.length > 0;
  const referencesRun = !subjectsRun && draft.activeReferenceMode === 'elements';
  const framesRun = !subjectsRun && draft.activeReferenceMode === 'frames';
  const inputs: VideoRunInput<M>[] = [];
  if (referencesRun && !draft.isMultiShot) {
    for (const element of draft.imageReferences) inputs.push({ slot: 'imageReferences', kind: 'image', element });
  }
  if (referencesRun) {
    for (const reference of draft.videoReferences) {
      inputs.push({ slot: 'videoReferences', kind: 'video', durationSeconds: reference.durationSeconds ?? null, reference });
    }
    for (const reference of draft.audioReferences) {
      inputs.push({ slot: 'audioReferences', kind: 'audio', durationSeconds: reference.durationSeconds ?? null, reference });
    }
  }
  for (const element of draft.videoElements) inputs.push({ slot: 'videoElements', kind: 'video', element });
  for (const subject of draft.subjects) {
    for (const image of subject.images) inputs.push({ slot: SUBJECT_IMAGES_SLOT_KEY, kind: 'image', subject, image });
  }
  if (draft.hasStartFrame && (framesRun || (referencesRun && draft.combinesFrameWithReferences))) {
    inputs.push({ slot: 'startFrame', kind: 'image' });
  }
  if (draft.hasEndFrame && framesRun && draft.takesEndFrame && !draft.isMultiShot) {
    inputs.push({ slot: 'endFrame', kind: 'image' });
  }
  for (const assetId of draft.preparedVoiceIds) inputs.push({ slot: 'preparedVoices', kind: 'preparedVoice', assetId });
  for (const assetId of draft.characterIds) inputs.push({ slot: 'characters', kind: 'character', assetId });
  return inputs;
}

export type ImageRunInput<Element> = { slot: 'imageReferences'; kind: 'image'; element: Element };

/**
 * The pictures an image run sends: as many as the model takes, in grid order. The rest
 * stay on the grid, unsent, and the price is not theirs either: the quote counted every
 * picture on the grid while the run sent the first `maxImages`.
 */
export function planImageRunInputs<Element>(elements: readonly Element[], maxImages: number): ImageRunInput<Element>[] {
  return elements
    .slice(0, Math.max(0, maxImages))
    .map((element) => ({ slot: 'imageReferences', kind: 'image', element }));
}

/** Where a motion run's inputs can go, as its model's descriptor publishes it. */
export type MotionRunDescriptor = {
  inputModes?: readonly {
    conditions?: readonly CatalogConditionLike[];
    slots: readonly {
      key: string;
      kind: (typeof CLIENT_RENDERED_INPUT_SLOT_KINDS)[number];
      role: (typeof CLIENT_RENDERED_INPUT_SLOT_ROLES)[number];
      min?: number;
      max?: number;
      conditions?: readonly CatalogConditionLike[];
    }[];
  }[];
};

export type MotionRunInputs = readonly [{ slot: string; kind: 'image' }, { slot: string; kind: 'video' }];

/**
 * The inputs a motion run sends, in this order: the character to animate and the clip whose
 * movement it takes, each in a reference slot its model's descriptor opens for its kind with
 * the run's settings (one the run must fill, or else the first that takes an input). The
 * start quotes a run with each input in its slot and refuses a slot the model does not
 * declare: production published Kling 3.0 motion with `imageReferences` and
 * `videoReferences`, and refused every web Kling 3.0 run while this page sent
 * `characterImage` and `referenceVideo` to every model (2026-10-19). The app reads the same
 * slots, and puts each input in every open slot of its kind; for a motion model with one
 * slot of each, as every published one has, the two send the same run. A descriptor that
 * opens no such slot keeps `characterImage` and `referenceVideo`, and its quote says why the
 * run cannot start. No length goes with the clip: the start measures it and, when the
 * measured length costs more than the price shown, sends the creator back to quote with it.
 */
export function planMotionRunInputs(
  descriptor: MotionRunDescriptor | null | undefined,
  settings: Record<string, CatalogConditionPrimitive | undefined>,
): MotionRunInputs {
  const modes = descriptor?.inputModes ?? [];
  const isReference = (slot: (typeof modes)[number]['slots'][number]) => (
    slot.role === 'reference' && (slot.kind === 'image' || slot.kind === 'video')
  );
  // The counts a mode's or slot's conditions read: the run's kind totals, as the server
  // reads them, and one input in each reference slot, as the app counts a motion draft,
  // whose frame slots hold nothing.
  const inputCounts: Record<string, number> = { images: 1, videos: 1 };
  for (const slot of modes.flatMap((mode) => mode.slots)) {
    if (isReference(slot)) inputCounts[slot.key] = 1;
  }
  const open = modes
    .filter((mode) => catalogConditionsMatch(mode.conditions, settings, inputCounts))
    .flatMap((mode) => mode.slots)
    .filter((slot) => (
      isReference(slot)
      && (slot.max ?? 1) > 0
      && catalogConditionsMatch(slot.conditions, settings, inputCounts)
    ));
  const slotFor = (kind: 'image' | 'video') => {
    const ofKind = open.filter((slot) => slot.kind === kind);
    return (ofKind.find((slot) => (slot.min ?? 0) > 0) ?? ofKind[0])?.key;
  };
  return [
    { slot: slotFor('image') ?? 'characterImage', kind: 'image' },
    { slot: slotFor('video') ?? 'referenceVideo', kind: 'video' },
  ];
}
