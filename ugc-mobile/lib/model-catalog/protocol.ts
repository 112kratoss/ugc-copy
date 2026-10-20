/** Dependency-free transport shared by the web server, browser and native client. */
export type ModelCatalogKind = 'image' | 'video' | 'motion';
export type ModelCatalogPlatform = 'web' | 'mobile';
export type ModelCatalogSummary = {
  id: string;
  kind: ModelCatalogKind;
  displayName: string;
  description: string;
  badge: string | null;
  recommended: boolean;
  sortOrder: number;
};
export type ModelCatalogCurrent = {
  transportVersion: 1;
  descriptorSchemaVersion: 3;
  revision: string;
  defaults: Record<ModelCatalogKind, string | null>;
  counts: Record<ModelCatalogKind, number>;
};
export type ModelCatalogPage = {
  transportVersion: 1;
  revision: string;
  models: ModelCatalogSummary[];
  nextCursor: string | null;
};
export type ModelCatalogDetails<T = unknown> = {
  transportVersion: 1;
  descriptorSchemaVersion: 3;
  revision: string;
  models: T[];
  missingIds: string[];
};
export const MODEL_CATALOG_BUDGETS = {
  current: 2048,
  models: 16384,
  detail: 16384,
  details: 131072,
} as const;
/**
 * Model IDs and revisions share one character set on every route, cursor and
 * client, so an ID that a client would send is one the server will accept.
 */
export const MODEL_CATALOG_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
export const MODEL_CATALOG_REVISION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export function isModelCatalogKind(value: unknown): value is ModelCatalogKind {
  return value === 'image' || value === 'video' || value === 'motion';
}
export function isModelCatalogPlatform(
  value: unknown,
): value is ModelCatalogPlatform {
  return value === 'web' || value === 'mobile';
}
export function isModelCatalogId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_CATALOG_ID_PATTERN.test(value);
}
export function isModelCatalogRevision(value: unknown): value is string {
  return (
    typeof value === 'string' && MODEL_CATALOG_REVISION_PATTERN.test(value)
  );
}
export type CatalogConditionPrimitive = string | number | boolean;
export type CatalogConditionOperator =
  | 'equals'
  | 'notEquals'
  | 'in'
  | 'notIn'
  | 'greaterThan'
  | 'greaterThanOrEqual';
export type CatalogConditionLike = {
  source: 'setting' | 'inputCount';
  key: string;
  operator: CatalogConditionOperator;
  value: CatalogConditionPrimitive | CatalogConditionPrimitive[];
};
/**
 * One operator table for the server runtime, the native app and the web
 * pickers, so a control that the server applies is the control the UI shows.
 */
export function catalogConditionMatches(
  operator: CatalogConditionOperator,
  actual: unknown,
  expected: CatalogConditionPrimitive | CatalogConditionPrimitive[],
): boolean {
  switch (operator) {
    case 'equals':
      return actual === expected;
    case 'notEquals':
      return actual !== expected;
    case 'in':
      return (
        Array.isArray(expected) &&
        expected.includes(actual as CatalogConditionPrimitive)
      );
    case 'notIn':
      return (
        Array.isArray(expected) &&
        !expected.includes(actual as CatalogConditionPrimitive)
      );
    case 'greaterThan':
      return (
        typeof actual === 'number' &&
        typeof expected === 'number' &&
        actual > expected
      );
    case 'greaterThanOrEqual':
      return (
        typeof actual === 'number' &&
        typeof expected === 'number' &&
        actual >= expected
      );
    default:
      return false;
  }
}
export function catalogConditionsMatch(
  conditions: readonly CatalogConditionLike[] | undefined,
  settings: Record<string, CatalogConditionPrimitive | undefined>,
  inputCounts: Record<string, number> = {},
): boolean {
  return (conditions ?? []).every((condition) =>
    catalogConditionMatches(
      condition.operator,
      condition.source === 'setting'
        ? settings[condition.key]
        : (inputCounts[condition.key] ?? 0),
      condition.value,
    ),
  );
}
export function parseModelCatalogCurrent(value: unknown): ModelCatalogCurrent {
  const v = value as ModelCatalogCurrent;
  if (
    !v ||
    v.transportVersion !== 1 ||
    v.descriptorSchemaVersion !== 3 ||
    typeof v.revision !== 'string' ||
    !v.revision ||
    !v.defaults ||
    !v.counts ||
    !(['image', 'video', 'motion'] as const).every(
      (kind) =>
        (v.defaults[kind] === null || typeof v.defaults[kind] === 'string') &&
        Number.isInteger(v.counts[kind]) &&
        v.counts[kind] >= 0,
    )
  ) {
    throw new Error('Invalid model catalog revision.');
  }
  return v;
}
/**
 * What both creators draw. The server's catalog build is held to these lists
 * (`src/__tests__/model-catalog-client-parity.test.ts`), the native parser accepts
 * exactly them and drops a descriptor that uses anything else
 * (`ugc-mobile/__tests__/model-catalog-client-parity.test.ts`), and the web creator's
 * affordances answer for every input mode named here. A capability one client cannot
 * render therefore cannot be published at all: teach both clients first, then add it
 * here, then release the descriptor that uses it.
 */
export const CLIENT_RENDERED_CONTROL_TYPES = ['choice', 'boolean', 'integer'] as const;
export const CLIENT_RENDERED_INPUT_MODE_KEYS = [
  'prompt-only',
  'references',
  'frames',
  'video-elements',
  'subjects',
  'prepared-assets',
  'motion-inputs',
] as const;
export const CLIENT_RENDERED_INPUT_SLOT_KINDS = [
  'image',
  'video',
  'audio',
  'character',
  'preparedVoice',
] as const;
export const CLIENT_RENDERED_INPUT_SLOT_ROLES = [
  'reference',
  'startFrame',
  'endFrame',
] as const;
export const CLIENT_RENDERED_INPUT_CONSTRAINT_TYPES = [
  'total-count',
  'weighted-count',
  'combined-duration',
] as const;
/**
 * A named subject is several pictures of one person or thing that the provider
 * fuses into one identity, mentioned in the prompt as `@handle`. They travel in the
 * `subjectImages` slot, one asset per picture, grouped by a shared handle. The
 * server refuses a group outside this range (Kling O3's contract, live-verified
 * 2026-08-24), so both creators hold a subject to it before anything is sent.
 */
export const SUBJECT_IMAGES_SLOT_KEY = 'subjectImages';
export const SUBJECT_IMAGES_PER_NAME = { min: 2, max: 4 } as const;
/**
 * How many subjects a run takes, from its slot. The slot is sized for that many
 * subjects of the most pictures each, so a descriptor published before `maxNamed`
 * existed still answers 3 for a slot of 12, which is the count the server enforces.
 */
export function subjectsPerRun(slot: { max: number; maxNamed?: number }): number {
  const fromSlot = slot.maxNamed ?? Math.floor(slot.max / SUBJECT_IMAGES_PER_NAME.max);
  return Math.max(0, Math.min(fromSlot, slot.max));
}
/**
 * The setting values a descriptor's input modes are gated on, by setting key. A mode
 * is a shape the model takes whether or not a control lists it: Kling O3's subjects
 * mode was published on 2026-08-24 beside an Input mode control naming frames and
 * references only, and both the server's quote and the native draft turned a subjects
 * run back into frames until each learned to read the modes through this.
 */
export function modeGatedSettingValues(
  inputModes: readonly { conditions?: readonly CatalogConditionLike[] }[] | undefined,
): Map<string, Set<string>> {
  const values = new Map<string, Set<string>>();
  for (const mode of inputModes ?? []) {
    for (const condition of mode.conditions ?? []) {
      if (
        condition.source !== 'setting' ||
        condition.operator !== 'equals' ||
        typeof condition.value !== 'string'
      )
        continue;
      const named = values.get(condition.key) ?? new Set<string>();
      named.add(condition.value);
      values.set(condition.key, named);
    }
  }
  return values;
}
/** Where a motion run's inputs can go: the input modes its model's descriptor publishes. */
export type CatalogMotionInputsDescriptor = {
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
/**
 * The slots of the `motion-inputs` mode, where every motion run sent its inputs before
 * descriptors named their own. A run whose descriptor opens no slot for an input still
 * sends it here, and its quote says why the run cannot start.
 */
export const MOTION_INPUTS_FALLBACK_SLOTS = {
  image: 'characterImage',
  video: 'referenceVideo',
} as const;
/**
 * The slots a motion run sends its two inputs in: the character to animate in an image
 * slot and the clip whose movement it takes in a video slot, each a reference slot its
 * model's descriptor opens with the run's settings, one the run must fill (`min > 0`)
 * first, and never one that takes nothing (`max: 0`). The start quotes a run with each
 * input in its slot and refuses a slot the model does not declare: production published
 * Kling 3.0 motion with `imageReferences` and `videoReferences`, and refused every web
 * Kling 3.0 run while the web page sent `characterImage` and `referenceVideo` to every
 * model (2026-10-19). Mode and slot conditions read the run's kind totals, as the server
 * does, and one input in each reference slot, as the app counts a motion draft (frame
 * slots hold nothing). The web motion page and the workflow runner's catalog motion step
 * both place their inputs with this; the app puts each input in every open slot of its
 * kind, which sends the same run for a model with one slot of each, as every published
 * motion model has.
 */
export function catalogMotionInputSlots(
  descriptor: CatalogMotionInputsDescriptor | null | undefined,
  settings: Record<string, CatalogConditionPrimitive | undefined>,
): { image: string; video: string } {
  const modes = descriptor?.inputModes ?? [];
  const isReference = (slot: (typeof modes)[number]['slots'][number]) =>
    slot.role === 'reference' && (slot.kind === 'image' || slot.kind === 'video');
  const inputCounts: Record<string, number> = { images: 1, videos: 1 };
  for (const slot of modes.flatMap((mode) => mode.slots)) {
    if (isReference(slot)) inputCounts[slot.key] = 1;
  }
  const open = modes
    .filter((mode) => catalogConditionsMatch(mode.conditions, settings, inputCounts))
    .flatMap((mode) => mode.slots)
    .filter(
      (slot) =>
        isReference(slot) &&
        (slot.max ?? 1) > 0 &&
        catalogConditionsMatch(slot.conditions, settings, inputCounts),
    );
  const slotFor = (kind: 'image' | 'video') => {
    const ofKind = open.filter((slot) => slot.kind === kind);
    return (ofKind.find((slot) => (slot.min ?? 0) > 0) ?? ofKind[0])?.key;
  };
  return {
    image: slotFor('image') ?? MOTION_INPUTS_FALLBACK_SLOTS.image,
    video: slotFor('video') ?? MOTION_INPUTS_FALLBACK_SLOTS.video,
  };
}
/** One input a run sends, as far as its price reads it. */
export type CatalogRunInputFact = {
  slot: string;
  kind: (typeof CLIENT_RENDERED_INPUT_SLOT_KINDS)[number];
  durationSeconds?: number | null;
};
export type CatalogRunInputFacts = {
  inputCounts: {
    images: number;
    videos: number;
    audios: number;
    preparedAudios: number;
    characters: number;
  };
  inputMetadata: {
    slots: Record<string, { count: number; durationsSeconds?: number[] }>;
    referenceVideoDurationsSeconds: number[];
  };
};
/** A length the run's JSON body carries: JSON has no NaN or Infinity, and sends them as null. */
function sentLength(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
/**
 * What a quote is told about a run's inputs, read off the inputs the run sends:
 * how many of each kind, each slot's count and lengths, and every video's
 * length. Counted by the part each input plays instead, a Wan 2.7 start frame
 * sent beside five reference pictures was left out of an 80-credit quote, and
 * the server, whose rules count it, refused the run for its sixth image.
 */
export function catalogRunInputFacts(
  inputs: readonly CatalogRunInputFact[],
): CatalogRunInputFacts {
  // Slot names reach the server in request bodies: counted in a plain object, a
  // name such as `constructor` read the built-in it shadows and wrote onto it.
  const slots = new Map<string, { count: number; durationsSeconds?: number[] }>();
  for (const input of inputs) {
    const slot = slots.get(input.slot) ?? { count: 0 };
    slot.count += 1;
    if (sentLength(input.durationSeconds)) {
      slot.durationsSeconds = [
        ...(slot.durationsSeconds ?? []),
        input.durationSeconds,
      ];
    }
    slots.set(input.slot, slot);
  }
  const counted = (kind: CatalogRunInputFact['kind']) =>
    inputs.filter((input) => input.kind === kind).length;
  return {
    inputCounts: {
      images: counted('image'),
      videos: counted('video'),
      audios: counted('audio'),
      preparedAudios: counted('preparedVoice'),
      characters: counted('character'),
    },
    inputMetadata: {
      slots: Object.fromEntries(slots),
      referenceVideoDurationsSeconds: inputs.flatMap((input) =>
        input.kind === 'video' && sentLength(input.durationSeconds)
          ? [input.durationSeconds]
          : [],
      ),
    },
  };
}
/**
 * A run's quote: what it makes, on which model and catalog revision, with its
 * settings and the facts of the inputs it sends. The server quotes a run with
 * this when it starts it, and the native creator asks for the run's price with
 * it, so the price a creator sees is the price the start charges, or the refusal
 * it gives.
 */
export function catalogRunQuoteInput<Kind extends string, Settings>(run: {
  kind: Kind;
  modelId: string;
  catalogRevision: string;
  settings: Settings;
  inputs: readonly CatalogRunInputFact[];
}) {
  return {
    schemaVersion: 2 as const,
    kind: run.kind,
    modelId: run.modelId,
    settings: run.settings,
    ...catalogRunInputFacts(run.inputs),
    catalogRevision: run.catalogRevision,
  };
}
/**
 * A run as a creator sends it to start: with the price the creator was shown
 * (`expectedCostCredits`) when that price is a ready quote of this very run, one
 * asked with the run's own quote input (`catalogRunQuoteInput`; a quote state's
 * `key` is that request as JSON). The start prices the run again, charges its own
 * price up to that one, and refuses a run it prices above it (`cost_changed`)
 * before any credits are held. Without such a quote the run goes without a price,
 * and the start charges its own as it always has. Only a whole number of credits,
 * zero or more, is ever sent: the start refuses the whole run for any other. Both
 * creators send their runs through this, so they agree on when a price goes.
 */
export function catalogRunWithShownCost<
  Run extends {
    kind: string;
    modelId: string;
    catalogRevision: string;
    settings: unknown;
    inputs?: readonly CatalogRunInputFact[];
    expectedCostCredits?: number;
  },
>(
  run: Run,
  quote: { key: string | null; status: string; cost: number | null | undefined },
): Run {
  const { cost } = quote;
  const shownForThisRun =
    quote.status === 'ready' &&
    typeof cost === 'number' &&
    Number.isSafeInteger(cost) &&
    cost >= 0 &&
    quote.key ===
      JSON.stringify(catalogRunQuoteInput({ ...run, inputs: run.inputs ?? [] }));
  return shownForThisRun ? { ...run, expectedCostCredits: cost } : run;
}
export function parseModelCatalogPage(
  value: unknown,
  revision: string,
): ModelCatalogPage {
  const v = value as ModelCatalogPage;
  if (
    !v ||
    v.transportVersion !== 1 ||
    v.revision !== revision ||
    !Array.isArray(v.models) ||
    v.models.length > 50 ||
    !(v.nextCursor === null || typeof v.nextCursor === 'string') ||
    !v.models.every(
      (m) =>
        m &&
        typeof m.id === 'string' &&
        isModelCatalogKind(m.kind) &&
        typeof m.displayName === 'string' &&
        typeof m.description === 'string' &&
        (m.badge === null || typeof m.badge === 'string') &&
        typeof m.recommended === 'boolean' &&
        Number.isFinite(m.sortOrder),
    )
  ) {
    throw new Error('Invalid model catalog page.');
  }
  return v;
}

/**
 * The longest prompt the generation route accepts; the route and both
 * composers' inputs read this one value. The web image composer allowed
 * 20,000 and the app's inputs had no limit, so the server refused after the
 * references had already uploaded.
 */
export const GENERATION_PROMPT_MAX_LENGTH = 10000;

/**
 * The longest motion prompt: Kie documents 2,500 characters for both motion-control
 * models (docs/model-api-references/kling2.6_motion_control.md and the Kling 3.0
 * page), so a longer one was held, sent and refused by the provider. Every motion
 * start, the motion composers' inputs and their counters read this one value;
 * image and video prompts keep GENERATION_PROMPT_MAX_LENGTH.
 */
export const MOTION_PROMPT_MAX_LENGTH = 2500;

/**
 * What one prompt enhancement debits. The enhancement service charges this
 * value and every Enhance button, on the web and in the app, prints it, so the
 * price a creator sees is the price taken. The app's buttons showed none.
 */
export const PROMPT_ENHANCEMENT_COST_CREDITS: number = 2;
