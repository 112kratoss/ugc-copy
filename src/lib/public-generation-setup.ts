import { logBackendError, logBackendWarning } from '@/lib/backend-logger';
import {
  GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  type CatalogCondition,
  type CatalogControl,
  type CatalogPrimitive,
  type GenerationModelDescriptor,
} from '@/lib/generation-model-catalog';
import { resolveGenerationAppModelId } from '@/lib/generation-model-attribution';
import { loadPublishedGenerationModelCatalog } from '@/lib/generation-model-catalog-store';
import {
  generationModelConditionMatches,
  type GenerationModelOperationalConfig,
} from '@/lib/generation-model-runtime';
import { isTemplateResultGeneration, type TemplateRunLink } from '@/lib/template-result';
import {
  GENERATION_SETUP_LABELS,
  GENERATION_SETUP_SWITCH,
  type GenerationSetupEntry,
} from '../../ugc-mobile/lib/generation-setup/generation-setup';

/**
 * A creation's settings as its post shows them to everyone (owner, 2026-11-03):
 * under Made with on the web's post page, and in the app's post Details, which
 * read them off the post's card (feed pages and the read by id carry them from
 * the read that hydrates the card). The words are the shared module's, so both
 * clients draw the same line.
 *
 * The line names only what the creator chose (#675's review, 2026-11-03): a
 * setting shows where the run's model, as the published catalog lists it now
 * (the catalog the starts resolve), offered a choice for it in that run (a
 * control with two options or more at the run's other settings, a range, or a
 * switch such as sound), with the value the run stored. A model with one
 * resolution or one format shows neither, one with no sound switch says nothing
 * of sound, and a setting the run's request left out (a picture that gave the
 * result its shape) shows nothing. A run whose model the catalog no longer
 * lists shows no line: what its controls offered can no longer be told.
 *
 * Less what the post already says or a recipe still sells: the model, which
 * Made with names, and the inputs, which a locked recipe's preview counts by
 * kind. A template's result shows none: its settings and model are the template
 * author's (`template-result.ts`).
 */

/** The columns a creation's line is read from beside its settings, and whether it is a template's result. */
export const PUBLIC_GENERATION_SETUP_COLUMNS = 'model, template_run_id, template_run_step_id';

/**
 * Each setting the line reads, as a path into the creation's workflow_settings,
 * so a read selects these and never the whole record, whose prompts, inputs and
 * outputs no line needs. `->` keeps each value as the record holds it, so the
 * line reads from the paths exactly what it would from the whole record.
 */
const SETTING_PATHS = [
  ['model', 'model'],
  ['aspect_ratio', 'aspectRatio'],
  ['resolution', 'resolution'],
  ['quality_mode', 'qualityMode'],
  ['output_format', 'outputFormat'],
  ['google_search', 'googleSearch'],
  ['mode', 'mode'],
  ['duration', 'duration'],
  ['sound', 'sound'],
  ['fixed_lens', 'fixedLens'],
  ['multi_prompts', 'multiPrompts'],
  ['shots', 'shots'],
  ['character_orientation', 'characterOrientation'],
  ['reference_mode', 'referenceMode'],
  ['start_frame', 'startFrame'],
  ['end_frame', 'endFrame'],
] as const;

/** Lists a rule only counts to two of (none, one, several), read as their first two entries. */
const COUNTED_LISTS = [
  ['elements', 'elements'],
  ['reference_image_urls', 'referenceImageUrls'],
] as const;

/**
 * The roles of the run's inputs, which say whether a picture gave the result
 * its shape: the starts keep a creator's frames and pictures as the run's inputs
 * (`generation_input_media`), and in its settings only a remix's. Embedded by the
 * input's own creation (its `source_generation_id` names another), role alone.
 */
const INPUT_ROLES_EMBED = 'setup_inputs:generation_input_media!generation_input_media_generation_id_fkey(role)';

/** The settings paths, aliased, to select beside the columns (`PUBLIC_GENERATION_SETUP_COLUMNS`). */
export const PUBLIC_GENERATION_SETUP_PATHS = [
  ...SETTING_PATHS.map(([alias, key]) => `setup_${alias}:workflow_settings->${key}`),
  ...COUNTED_LISTS.flatMap(([alias, key]) => [0, 1].map((index) => `setup_${alias}_${index}:workflow_settings->${key}->${index}`)),
  INPUT_ROLES_EMBED,
].join(', ');

/**
 * A creation as its line is built from: its model, the settings its run stored, the roles of its
 * inputs, and whether it is a template's result. Its kind (image, video, motion) is its model's,
 * as the catalog lists it.
 */
export type PublicGenerationSetupRow = TemplateRunLink & {
  model?: string | null;
  workflow_settings?: unknown;
  /** The roles of the run's inputs (`generation_input_media`): `start_frame`, `reference_image`… */
  input_roles?: readonly string[] | null;
};

/** A row read with `PUBLIC_GENERATION_SETUP_PATHS`, its settings put back under the names the run stored them by. */
export function readPublicGenerationSetupRow(answered: object): PublicGenerationSetupRow {
  const row = answered as Record<string, unknown>;
  const settings: Record<string, unknown> = {};
  for (const [alias, key] of SETTING_PATHS) {
    const value = row[`setup_${alias}`];
    if (value !== null && value !== undefined) settings[key] = value;
  }
  for (const [alias, key] of COUNTED_LISTS) {
    const entries = [row[`setup_${alias}_0`], row[`setup_${alias}_1`]].filter((value) => value !== null && value !== undefined);
    if (entries.length > 0) settings[key] = entries;
  }
  const inputs = Array.isArray(row.setup_inputs) ? row.setup_inputs : [];
  return {
    model: typeof row.model === 'string' ? row.model : null,
    template_run_id: typeof row.template_run_id === 'string' ? row.template_run_id : null,
    template_run_step_id: typeof row.template_run_step_id === 'string' ? row.template_run_step_id : null,
    workflow_settings: settings,
    input_roles: inputs.flatMap((input) => (isRecord(input) && typeof input.role === 'string' ? [input.role] : [])),
  };
}

/**
 * A refusal of the query's shape: PostgREST's parsing (PGRST1xx) or its schema cache (PGRST2xx, a
 * relationship it cannot find or tell apart), or SQL class 42 (a column or operator it does not know).
 */
function isRefusedSelect(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  return code.startsWith('PGRST1') || code.startsWith('PGRST2') || code.startsWith('42');
}

/**
 * Reads generations with the settings paths beside `columns`, and, should the
 * database refuse the paths, again with `columns` alone: the columns serve the
 * post (its model, its poster, whether it is a template's result) whatever
 * becomes of its line, which then is unknown (`withSetup: false`).
 */
export async function selectWithGenerationSetup<Answer extends { data: unknown; error: unknown }>(
  columns: string,
  read: (select: string) => PromiseLike<Answer>,
): Promise<Answer & { withSetup: boolean }> {
  const answer = await read(`${columns}, ${PUBLIC_GENERATION_SETUP_PATHS}`);
  if (!answer.error || !isRefusedSelect(answer.error)) return { ...answer, withSetup: true };
  logBackendWarning('public_generation_setup_paths_refused', { error: answer.error });
  return { ...(await read(columns)), withSetup: false };
}

type CatalogOperation = Pick<GenerationModelOperationalConfig, 'providerModelMap' | 'validationConfig'>;

/** What the line reads of the published catalog: each model's descriptor and the option rules its quote applies. */
export type PublicGenerationSetupCatalog = {
  models: ReadonlyMap<string, { descriptor: GenerationModelDescriptor; rules: readonly unknown[] }>;
  /** A model by the provider's id an older run kept in its place (`generations.model`), where one model has it. */
  byProviderId: ReadonlyMap<string, string>;
};

export function toPublicGenerationSetupCatalog(snapshot: {
  catalog: { models: readonly GenerationModelDescriptor[] };
  operations: ReadonlyMap<string, CatalogOperation>;
}): PublicGenerationSetupCatalog {
  const models = new Map(snapshot.catalog.models.map((descriptor) => {
    const rules = snapshot.operations.get(descriptor.id)?.validationConfig.rules;
    return [descriptor.id, { descriptor, rules: Array.isArray(rules) ? rules : [] }] as const;
  }));
  const providerOwners = new Map<string, Set<string>>();
  for (const [modelId, operation] of snapshot.operations) {
    if (!models.has(modelId)) continue;
    for (const providerId of Object.values(operation.providerModelMap ?? {})) {
      providerOwners.set(providerId, (providerOwners.get(providerId) ?? new Set()).add(modelId));
    }
  }
  const byProviderId = new Map<string, string>();
  for (const [providerId, owners] of providerOwners) {
    if (owners.size === 1) byProviderId.set(providerId, [...owners][0]!);
  }
  return { models, byProviderId };
}

/** How long a derived catalog serves before it is read again: the store's own release cache. */
const CATALOG_TTL_MS = 60 * 1000;
/** How long a failed read waits before the next, whatever the requests meanwhile. */
const CATALOG_RETRY_MS = 15 * 1000;

let catalogCache: { catalog: PublicGenerationSetupCatalog | null; readAt: number; retryAt: number } | null = null;
let catalogRead: Promise<PublicGenerationSetupCatalog | null> | null = null;
/** Counts the clears, so a read begun before one never writes after it. */
let catalogEpoch = 0;

function readPublicGenerationSetupCatalog(): Promise<PublicGenerationSetupCatalog | null> {
  const epoch = catalogEpoch;
  const read = catalogRead ?? loadPublishedGenerationModelCatalog({
    platform: 'web',
    schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  })
    .then((snapshot) => {
      const catalog = toPublicGenerationSetupCatalog(snapshot);
      if (epoch === catalogEpoch) catalogCache = { catalog, readAt: Date.now(), retryAt: 0 };
      return catalog;
    }, (error: unknown) => {
      logBackendError('failed_to_load_public_generation_setup_catalog', { error });
      // The last good copy goes on serving; without one there is no line until the next try.
      const kept = epoch === catalogEpoch ? catalogCache : null;
      if (epoch === catalogEpoch) {
        catalogCache = { catalog: kept?.catalog ?? null, readAt: kept?.readAt ?? 0, retryAt: Date.now() + CATALOG_RETRY_MS };
      }
      return kept?.catalog ?? null;
    })
    .finally(() => {
      if (epoch === catalogEpoch) catalogRead = null;
    });
  catalogRead = read;
  return read;
}

/**
 * The catalog the line is read against: the release the starts resolve
 * (`loadPublishedGenerationModelCatalog`), as the web lists it, which every
 * live model is on. Every card a feed page hydrates is built against it, so it
 * is derived once a minute, not per read (the store builds its code catalog and
 * projects the release on every call): an older copy serves while the next is
 * read, and a failed read is tried again after a wait, not by every request
 * meanwhile. Null where none could be read yet, and then no line is built (a
 * read leaves it out, as unknown).
 */
export async function loadPublicGenerationSetupCatalog(): Promise<PublicGenerationSetupCatalog | null> {
  const cache = catalogCache;
  if (!cache) return readPublicGenerationSetupCatalog();
  const now = Date.now();
  const due = now - cache.readAt >= CATALOG_TTL_MS && now >= cache.retryAt;
  if (cache.catalog) {
    if (due) void readPublicGenerationSetupCatalog();
    return cache.catalog;
  }
  return due ? readPublicGenerationSetupCatalog() : null;
}

/** Forgets the derived catalog, as `clearGenerationModelCatalogStoreCache` does the store's. */
export function clearPublicGenerationSetupCatalogCache(): void {
  catalogEpoch += 1;
  catalogCache = null;
  catalogRead = null;
}

type WorkflowSettings = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function settingText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** The run's settings as the catalog's conditions read them. */
function conditionSettings(settings: WorkflowSettings): Record<string, CatalogPrimitive> {
  const read: Record<string, CatalogPrimitive> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'string') read[key] = value.trim();
    else if (typeof value === 'number' || typeof value === 'boolean') read[key] = value;
  }
  return read;
}

// The run's inputs are not read here: a rule that counts them is read as for a run without
// them. None of today's narrows a setting to one value by its inputs.
const NO_INPUTS = { images: 0, videos: 0, audios: 0, preparedAudios: 0, characters: 0 };

/**
 * The control the model offered for `key` in this run, or null where it offered
 * none or no choice: a switch, a range, or two options or more once the quote's
 * option rules (`control-options`, GPT Image's 1K at its automatic ratio) are
 * read at the run's other settings.
 */
function offeredControl(
  model: { descriptor: GenerationModelDescriptor; rules: readonly unknown[] },
  key: string,
  settings: Record<string, CatalogPrimitive>,
): CatalogControl | null {
  const control = model.descriptor.controls.find((candidate) => candidate.key === key);
  if (!control) return null;
  if (control.conditions && !control.conditions.every((condition) => generationModelConditionMatches(condition, settings, NO_INPUTS))) {
    return null;
  }
  if (control.type === 'boolean') return control;
  if (control.type === 'integer') return control.max > control.min ? control : null;
  let values = control.options.map((option) => option.value);
  for (const rule of model.rules) {
    if (!isRecord(rule) || rule.type !== 'control-options' || rule.key !== key || !Array.isArray(rule.options)) continue;
    const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
    if (!conditions.every((condition) => isRecord(condition)
      && generationModelConditionMatches(condition as unknown as CatalogCondition, settings, NO_INPUTS))) continue;
    const allowed = new Set(rule.options.map(String));
    values = values.filter((value) => allowed.has(value));
  }
  return values.length > 1 ? control : null;
}

/** The video models whose start frame gives an image-to-video clip its shape: their request then sends no ratio. */
const FRAME_SHAPED_VIDEO_MODELS = new Set([
  'kling-3.0-turbo', 'kling-o3', 'minimax-h3', 'wan-2.7', 'wan-3.0', 'wan-3.0-prime', 'pixverse-v6', 'happyhorse-1.1',
  'grok-imagine-video', 'grok-imagine-video-1.5',
]);

/**
 * What the run's request left out although the model offers it, which the
 * catalog cannot say: a picture the run starts from gives the result its shape,
 * so the ratio the creator had picked never reached the provider. Read off each
 * start's request (generation-services.ts, held there by
 * generation-services.test.ts): Grok Imagine's edit sends the pictures alone,
 * without ratio or quality; the frame-shaped video models send no ratio from a
 * frames run, Kling O3 from a single-shot one only; Grok Imagine Video reads no
 * ratio from a single picture, and 1.5 none beside its start frame.
 *
 * A creator's frames and pictures are told by the run's inputs (`inputRoles`),
 * which every start keeps; a remix's frames and named pictures are in its
 * settings as well.
 */
function settingsTheRequestLeftOut(
  modelId: string,
  settings: WorkflowSettings,
  inputRoles: ReadonlySet<string>,
): ReadonlySet<string> {
  if (modelId === 'grok-imagine-image') {
    const fromPictures = listLength(settings.elements) > 0 || inputRoles.has('reference_image');
    return new Set(fromPictures ? ['aspectRatio', 'qualityMode'] : []);
  }
  if (!FRAME_SHAPED_VIDEO_MODELS.has(modelId)) return new Set();
  const keptStartFrame = isRecord(settings.startFrame) || inputRoles.has('start_frame');
  const keptEndFrame = isRecord(settings.endFrame) || inputRoles.has('end_frame');
  const framesRun = (keptStartFrame || keptEndFrame)
    && settings.referenceMode !== 'references'
    && settings.referenceMode !== 'elements';
  const multiShot = listLength(settings.multiPrompts) > 0 || listLength(settings.shots) > 0;
  const onePicture = listLength(settings.referenceImageUrls) === 1;
  const shaped = modelId === 'grok-imagine-video-1.5'
    ? keptStartFrame || onePicture
    : modelId === 'grok-imagine-video'
      ? framesRun || onePicture
      : modelId === 'kling-o3'
        ? framesRun && !multiShot
        : framesRun;
  return new Set(shaped ? ['aspectRatio'] : []);
}

function entry(label: string, value: string | null): GenerationSetupEntry[] {
  return value ? [{ label, value }] : [];
}

/** "9:16", or "Auto" however the model spells it ("auto", "Auto"). */
function aspectRatioValue(value: unknown): string | null {
  const ratio = settingText(value);
  return ratio && ratio.toLowerCase() === 'auto' ? 'Auto' : ratio;
}

/** "1K", "720P": as the creators' settings chip writes a resolution. */
function resolutionValue(value: unknown): string | null {
  return settingText(value)?.toUpperCase() ?? null;
}

function secondsValue(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? `${value}s` : null;
}

/** A choice by the name the model's catalog entry gives it ("Standard (720p)", "Fast"), else as stored, capitalised. */
function optionValue(control: CatalogControl, stored: unknown): string | null {
  const value = settingText(stored);
  if (!value) return null;
  const label = control.type === 'choice'
    ? control.options.find((option) => option.value === value)?.label ?? value
    : value;
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

/** The motion creator's own words for the two orientations (`CreateMotionClient`). */
function characterOrientationValue(value: unknown): string | null {
  const orientation = settingText(value);
  if (orientation === 'video') return 'Follow video';
  if (orientation === 'image') return 'Favor image';
  return orientation;
}

/**
 * The settings a creation's post shows, in the order the creators set them:
 * image, its aspect ratio, resolution, quality, output format and Google Search
 * grounding where it was on ("9:16 · 1K · JPG"); video, its aspect ratio, mode,
 * resolution, length, sound, camera and shots ("16:9 · Fast · 1080P"); motion,
 * its length, render mode and character orientation. Each only where the run's
 * model offered a choice for it (see above). None for a template's result, no
 * creation, or a model the catalog no longer lists.
 */
export function buildPublicGenerationSetup(
  generation: PublicGenerationSetupRow | null | undefined,
  catalog: PublicGenerationSetupCatalog,
): GenerationSetupEntry[] {
  if (!generation || isTemplateResultGeneration(generation)) return [];

  const settings: WorkflowSettings = isRecord(generation.workflow_settings) ? generation.workflow_settings : {};
  const modelId = resolveGenerationAppModelId(generation);
  const model = modelId
    ? catalog.models.get(modelId) ?? catalog.models.get(catalog.byProviderId.get(modelId) ?? '')
    : undefined;
  if (!model) return [];

  const choices = conditionSettings(settings);
  const leftOut = settingsTheRequestLeftOut(model.descriptor.id, settings, new Set(generation.input_roles ?? []));
  const offered = (key: string) => (leftOut.has(key) ? null : offeredControl(model, key, choices));
  const LABELS = GENERATION_SETUP_LABELS;

  if (model.descriptor.kind === 'image') {
    const quality = offered('qualityMode');
    return [
      ...entry(LABELS.aspectRatio, offered('aspectRatio') ? aspectRatioValue(settings.aspectRatio) : null),
      ...entry(LABELS.resolution, offered('resolution') ? resolutionValue(settings.resolution) : null),
      ...(quality ? entry(quality.label.trim() || LABELS.quality, optionValue(quality, settings.qualityMode)) : []),
      ...entry(LABELS.outputFormat, offered('outputFormat') ? settingText(settings.outputFormat)?.toUpperCase() ?? null : null),
      // Only where it was on: "off" would read on every post of a model that offers it, and say nothing.
      ...entry(LABELS.googleSearch, offered('googleSearch') && settings.googleSearch === true ? GENERATION_SETUP_SWITCH.on : null),
    ];
  }

  if (model.descriptor.kind === 'video') {
    const mode = offered('mode');
    const shots = Math.max(listLength(settings.multiPrompts), listLength(settings.shots));
    return [
      ...entry(LABELS.aspectRatio, offered('aspectRatio') ? aspectRatioValue(settings.aspectRatio) : null),
      ...(mode ? entry(LABELS.mode, optionValue(mode, settings.mode)) : []),
      ...entry(LABELS.resolution, offered('resolution') ? resolutionValue(settings.resolution) : null),
      ...entry(LABELS.duration, offered('duration') ? secondsValue(settings.duration) : null),
      ...entry(LABELS.sound, offered('sound') && typeof settings.sound === 'boolean'
        ? (settings.sound ? GENERATION_SETUP_SWITCH.on : GENERATION_SETUP_SWITCH.off)
        : null),
      ...entry(LABELS.camera, offered('fixedLens') && settings.fixedLens === true ? 'Fixed lens' : null),
      ...entry(LABELS.shots, offered('isMultiShot') && shots > 0 ? String(shots) : null),
    ];
  }

  return [
    ...entry(LABELS.duration, offered('duration') ? secondsValue(settings.duration) : null),
    // The legacy start records its render mode as `mode`, the catalog path as `resolution`.
    ...entry(LABELS.renderMode, offered('resolution') ? resolutionValue(settingText(settings.mode) ?? settings.resolution) : null),
    ...entry(LABELS.characterOrientation, offered('characterOrientation') ? characterOrientationValue(settings.characterOrientation) : null),
  ];
}

/**
 * The line a post carries, decided here for every read (feed cards, the read by
 * id, the web's post page): none for a written post or an upload, its
 * creation's where it was made from one (`creation`, none for a template's
 * result), and nothing at all where the creation or the catalog could not be
 * read, so a client never keeps an unknown line as none. A post under its NSFW
 * cover carries none: `coverNsfwContent` clears it with the rest it hides.
 */
export function publicPostGenerationSetup(
  post: { postFormat: string | null | undefined; generationId: string | null | undefined },
  creation: GenerationSetupEntry[] | undefined,
): GenerationSetupEntry[] | undefined {
  if (post.postFormat === 'text' || !post.generationId) return [];
  return creation;
}
