import type {
  MediaTemplateCreator,
  MediaTemplateDetail,
  MediaTemplateDetailResponse,
  MediaTemplateInputSlot,
  MediaTemplateListResponse,
  MediaTemplateSummary,
  TemplateRun,
  TemplateRunInput,
  TemplateRunResponse,
  TemplateRunResult,
  TemplateRunFailureCode,
  TemplateRunStatus,
  TemplateRunStep,
} from './types';
import { preserveStableSignedUrl } from './template-run-stable-media';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstValue(record: UnknownRecord, keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function stringValue(record: UnknownRecord, keys: string[], fallback = ''): string {
  const value = firstValue(record, keys);
  return typeof value === 'string' ? value : fallback;
}

function nullableString(record: UnknownRecord, keys: string[]): string | null {
  const value = firstValue(record, keys);
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberValue(record: UnknownRecord, keys: string[]): number | null {
  const value = firstValue(record, keys);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(record: UnknownRecord, keys: string[], fallback: boolean): boolean {
  const value = firstValue(record, keys);
  return typeof value === 'boolean' ? value : fallback;
}

function mediaKind(value: unknown, fallback: 'image' | 'video' = 'image') {
  return value === 'video' ? 'video' as const : value === 'image' ? 'image' as const : fallback;
}

const TEMPLATE_RUN_FAILURE_CODES = new Set<TemplateRunFailureCode>([
  'insufficient_credits',
  'invalid_input_media',
  'service_misconfigured',
  'provider_busy',
  'provider_unavailable',
  'provider_rejected',
]);

function failureCode(value: unknown): TemplateRunFailureCode | null {
  return typeof value === 'string' && TEMPLATE_RUN_FAILURE_CODES.has(value as TemplateRunFailureCode)
    ? value as TemplateRunFailureCode
    : null;
}

function normalizeCreator(value: unknown, fallback: UnknownRecord = {}): MediaTemplateCreator | null {
  const creator = asRecord(value);
  const id = stringValue(creator, ['id'], stringValue(fallback, ['creatorUserId', 'creator_user_id']));
  const username = nullableString(creator, ['username']);
  const displayName = nullableString(creator, ['displayName', 'display_name']);
  const avatarUrl = nullableString(creator, ['avatarUrl', 'avatar_url']);
  return id || username || displayName || avatarUrl ? { id, username, displayName, avatarUrl } : null;
}

function normalizeInputSlot(value: unknown, index: number): MediaTemplateInputSlot {
  const slot = asRecord(value);
  return {
    key: stringValue(slot, ['key', 'slotKey', 'slot_key'], `input_${index + 1}`),
    kind: mediaKind(firstValue(slot, ['kind', 'mediaKind', 'media_kind'])),
    label: stringValue(slot, ['label', 'name'], `Input ${index + 1}`),
    description: nullableString(slot, ['description', 'instructions', 'helpText', 'help_text']),
    required: booleanValue(slot, ['required'], true),
  };
}

function normalizeInputSlots(value: unknown): MediaTemplateInputSlot[] {
  return asArray(value).map(normalizeInputSlot);
}

function templateRecord(value: unknown): UnknownRecord {
  const record = asRecord(value);
  return asRecord(record.template ?? record.data ?? record);
}

export function normalizeMediaTemplate(value: unknown): MediaTemplateSummary {
  const template = templateRecord(value);
  const rawStatus = stringValue(template, ['status'], 'active');

  return {
    id: stringValue(template, ['id']),
    slug: stringValue(template, ['slug'], stringValue(template, ['id'])),
    name: stringValue(template, ['name', 'title'], 'Untitled template'),
    description: nullableString(template, ['description']),
    category: stringValue(template, ['category'], 'Creative'),
    videoUrl: nullableString(template, ['videoUrl', 'video_url', 'demoVideoUrl', 'demo_video_url']),
    thumbnailUrl: nullableString(template, ['thumbnailUrl', 'thumbnail_url']),
    creatorUserId: nullableString(template, ['creatorUserId', 'creator_user_id']),
    creator: normalizeCreator(template.creator, template),
    inputSlots: normalizeInputSlots(firstValue(template, ['inputSlots', 'input_slots'])),
    outputKind: mediaKind(firstValue(template, ['outputKind', 'output_kind']), 'video'),
    status: rawStatus === 'draft' || rawStatus === 'disabled' ? rawStatus : 'active',
    estimatedTotalCredits: numberValue(template, ['estimatedTotalCredits', 'estimated_total_credits']),
    useCount: numberValue(template, ['useCount', 'use_count']) ?? 0,
  };
}

export function normalizeMediaTemplateListResponse(value: unknown): MediaTemplateListResponse {
  const response = asRecord(value);
  const templates = asArray(firstValue(response, ['templates', 'items', 'data'])).map(normalizeMediaTemplate);
  // The server pages at 48; without the cursor the catalog stopped there.
  return { success: response.success !== false, templates, nextCursor: nullableString(response, ['nextCursor', 'next_cursor']) };
}

export function normalizeMediaTemplateDetailResponse(value: unknown): MediaTemplateDetailResponse {
  const response = asRecord(value);
  const rawTemplate = templateRecord(value);
  const template: MediaTemplateDetail = {
    ...normalizeMediaTemplate(rawTemplate),
    createdAt: nullableString(rawTemplate, ['createdAt', 'created_at']),
    updatedAt: nullableString(rawTemplate, ['updatedAt', 'updated_at']),
  };
  return { success: response.success !== false, template };
}

/**
 * A detail read that replaces the one on screen, keeping the demo's and the
 * poster's addresses while they point at the same files and have five minutes
 * left: every read signs both again, and the player and the image are keyed
 * on the address, so a refetch taken as it came restarted the clip.
 */
export function withStableTemplateMedia<Template extends Pick<MediaTemplateSummary, 'id' | 'videoUrl' | 'thumbnailUrl'>>(
  previous: Template | undefined,
  next: Template,
  nowMs = Date.now(),
  storageBaseUrl?: string,
): Template {
  if (!previous || previous.id !== next.id) return next;
  return {
    ...next,
    videoUrl: preserveStableSignedUrl(previous.videoUrl, next.videoUrl, nowMs, storageBaseUrl),
    thumbnailUrl: preserveStableSignedUrl(previous.thumbnailUrl, next.thumbnailUrl, nowMs, storageBaseUrl),
  };
}

/**
 * The post-content reasons a template can be reported for: the reasons a post
 * is reported for, less the two about a recipe, which a template does not have.
 */
export const TEMPLATE_REPORT_REASONS = [
  { label: 'Spam', value: 'spam' },
  { label: 'Stolen content', value: 'stolen_content' },
  { label: 'Unsafe content', value: 'unsafe_content' },
  { label: 'Something else', value: 'other' },
] as const;

export type TemplateReportReason = (typeof TEMPLATE_REPORT_REASONS)[number]['value'];

/** "1 use", "1,240 uses": the web's words on its card and detail. */
export function formatTemplateUseCount(count: number) {
  const uses = Math.max(0, Math.trunc(count));
  return `${uses.toLocaleString('en-US')} ${uses === 1 ? 'use' : 'uses'}`;
}

const SIGNED_STORAGE_PATH = '/storage/v1/object/sign/';

/**
 * The key a template's poster is cached under. Every read of the catalog signs
 * each poster again, so keyed on its address a picture was downloaded again
 * after each read; a signed Storage address without its query names the
 * stored file instead. A new version's poster is a new file (each is stored
 * under its version), so it still gets a key of its own.
 */
export function templatePosterCacheKey(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.includes(SIGNED_STORAGE_PATH)) return url;
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * Fresh poster links for the templates whose posters failed, read again four
 * at a time as the web does (`useTemplatePosterRecovery`). A template that
 * cannot be read is left out, and its card tries the link it already has.
 */
export async function renewTemplatePosters(
  templateIds: string[],
  readTemplate: (templateId: string) => Promise<Pick<MediaTemplateSummary, 'id' | 'thumbnailUrl'>>,
  concurrency = 4,
): Promise<Map<string, string | null>> {
  const queue = [...new Set(templateIds)];
  const renewed = new Map<string, string | null>();
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const templateId = queue.shift()!;
      try {
        const template = await readTemplate(templateId);
        if (template.id === templateId) renewed.set(templateId, template.thumbnailUrl);
      } catch {
        // Its card retries the link it had.
      }
    }
  }));
  return renewed;
}

/** The loaded catalog pages with the renewed poster links in place; every other field as the list read it. */
export function withRenewedTemplatePosters<Data extends { pages: MediaTemplateListResponse[] }>(
  data: Data | undefined,
  renewed: Map<string, string | null>,
): Data | undefined {
  if (!data || renewed.size === 0) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      templates: page.templates.map((template) => (
        renewed.has(template.id) ? { ...template, thumbnailUrl: renewed.get(template.id) ?? null } : template
      )),
    })),
  };
}

function normalizeRunStatus(value: unknown): TemplateRunStatus {
  if (value === 'generating_frames' || value === 'generating_video' || value === 'running') return 'processing';
  if (value === 'generating_keyframes') return 'processing';
  if (value === 'awaiting_frame_approval') return 'awaiting_approval';
  if (
    value === 'collecting_inputs'
    || value === 'queued'
    || value === 'processing'
    || value === 'awaiting_approval'
    || value === 'succeeded'
    || value === 'needs_attention'
    || value === 'failed'
    || value === 'cancelled'
  ) return value;
  return 'needs_attention';
}

function normalizeRunInput(value: unknown, index: number): TemplateRunInput {
  const input = asRecord(value);
  return {
    slotKey: stringValue(input, ['slotKey', 'slot_key', 'key'], `input_${index + 1}`),
    status: stringValue(input, ['status'], 'uploaded'),
    previewUrl: nullableString(input, ['previewUrl', 'preview_url', 'signedUrl', 'signed_url']),
    fileName: nullableString(input, ['fileName', 'file_name']),
  };
}

function normalizeRunInputs(value: unknown): TemplateRunInput[] {
  if (Array.isArray(value)) return value.map(normalizeRunInput);
  return Object.entries(asRecord(value)).map(([slotKey, item], index) => {
    const input = asRecord(item);
    return normalizeRunInput({ slotKey, status: 'uploaded', ...input }, index);
  });
}

function normalizeStep(value: unknown, index: number): TemplateRunStep | null {
  const step = asRecord(value);
  const id = stringValue(step, ['id', 'stepId', 'step_id']);
  if (!id) return null;
  const kind = stringValue(step, ['kind', 'stepKind', 'step_kind']) === 'approval' ? 'approval' : 'generation';
  return {
    id,
    kind,
    mediaKind: mediaKind(firstValue(step, ['mediaKind', 'media_kind', 'outputKind', 'output_kind'])),
    status: stringValue(step, ['status'], 'queued'),
    label: stringValue(step, ['label', 'name'], `${kind === 'approval' ? 'Review' : 'Generation'} ${index + 1}`),
    outputUrl: nullableString(step, ['outputUrl', 'output_url']),
    ...(step.renditionUrl !== undefined ? { renditionUrl: nullableString(step, ['renditionUrl']) } : {}),
    ...(step.previewUrl !== undefined ? { previewUrl: nullableString(step, ['previewUrl']) } : {}),
    errorMessage: nullableString(step, ['errorMessage', 'error_message', 'error']),
    failureCode: failureCode(firstValue(step, ['failureCode', 'failure_code', 'errorCode', 'error_code'])),
    canRetry: booleanValue(step, ['canRetry', 'can_retry'], false),
    estimatedRetryCredits: numberValue(step, ['estimatedRetryCredits', 'estimated_retry_credits']),
  };
}

function legacyStep(value: unknown, label: string, kind: 'image' | 'video'): TemplateRunStep | null {
  const generation = asRecord(value);
  const id = stringValue(generation, ['id']);
  if (!id) return null;
  const status = stringValue(generation, ['status'], 'queued');
  return {
    id,
    kind: 'generation',
    mediaKind: kind,
    status,
    label,
    outputUrl: nullableString(generation, ['outputUrl', 'output_url']),
    errorMessage: nullableString(generation, ['errorMessage', 'error_message', 'error']),
    failureCode: failureCode(firstValue(generation, ['failureCode', 'failure_code', 'errorCode', 'error_code'])),
    canRetry: status === 'failed' || status === 'error',
    estimatedRetryCredits: numberValue(generation, ['estimatedRetryCredits', 'estimated_retry_credits', 'cost']),
  };
}

function normalizeSteps(run: UnknownRecord): TemplateRunStep[] {
  const steps = firstValue(run, ['steps', 'runSteps', 'run_steps']);
  if (Array.isArray(steps)) return steps.map(normalizeStep).filter((step): step is TemplateRunStep => Boolean(step));
  return [
    legacyStep(firstValue(run, ['startFrameGeneration', 'start_frame_generation']), 'Starting frame', 'image'),
    legacyStep(firstValue(run, ['finalFrameGeneration', 'final_frame_generation']), 'Final frame', 'image'),
    legacyStep(firstValue(run, ['videoGeneration', 'video_generation']), 'Final video', 'video'),
  ].filter((step): step is TemplateRunStep => Boolean(step));
}

/** The post a run's result was published as. The server reads an archived post as private: no link to it would open. */
export interface TemplateRunLinkedPost {
  id: string;
  visibility: 'public' | 'unlisted' | 'private';
}

function normalizeLinkedPost(value: unknown): TemplateRunLinkedPost | null {
  const post = asRecord(value);
  const id = nullableString(post, ['id']);
  if (!id) return null;
  // Read as private when unknown, so nothing is ever published over a post that exists.
  const visibility = post.visibility === 'public' || post.visibility === 'unlisted' ? post.visibility : 'private';
  return { id, visibility };
}

export function normalizeTemplateRunResponse(value: unknown): TemplateRunResponse {
  const response = asRecord(value);
  const run = asRecord(response.run ?? response.data ?? value);
  const snapshot = asRecord(firstValue(run, ['templateSnapshot', 'template_snapshot']));
  const template = asRecord(run.template);
  const result = asRecord(run.result);
  const canonicalResultUrl = nullableString(result, ['url', 'outputUrl', 'output_url']);
  const canonicalGenerationId = nullableString(result, ['generationId', 'generation_id']);
  const legacyVideo = asRecord(firstValue(run, ['videoGeneration', 'video_generation']));
  const legacyVideoStatus = stringValue(legacyVideo, ['status']).toLowerCase();
  const legacyVideoUrl = ['succeeded', 'completed', 'success'].includes(legacyVideoStatus)
    ? nullableString(legacyVideo, ['outputUrl', 'output_url'])
    : null;
  const resultUrl = canonicalResultUrl ?? legacyVideoUrl;

  const normalizedRun: TemplateRun = {
    id: stringValue(run, ['id']),
    templateId: stringValue(run, ['templateId', 'template_id'], stringValue(template, ['id'])),
    templateSlug: stringValue(run, ['templateSlug', 'template_slug'], stringValue(template, ['slug'])),
    templateTitle: stringValue(run, ['templateTitle', 'template_title'], stringValue(template, ['name', 'title'], 'Template creation')),
    templateCreator: normalizeCreator(run.templateCreator ?? run.template_creator ?? template.creator, template),
    status: normalizeRunStatus(run.status),
    inputSlots: normalizeInputSlots(
      firstValue(run, ['inputSlots', 'input_slots'])
      ?? firstValue(snapshot, ['inputSlots', 'input_slots'])
      ?? firstValue(template, ['inputSlots', 'input_slots'])
    ),
    inputs: normalizeRunInputs(firstValue(run, ['inputs', 'runInputs', 'run_inputs'])),
    steps: normalizeSteps(run),
    result: resultUrl ? {
      // Legacy run shapes can still provide a result URL, but only the
      // backend's canonical result object is allowed to supply an id used for
      // publishing. Step and prediction ids are deliberately ignored.
      generationId: canonicalResultUrl ? canonicalGenerationId : null,
      kind: mediaKind(firstValue(result, ['kind', 'mediaKind', 'media_kind']), legacyVideoUrl ? 'video' : 'image'),
      url: resultUrl,
      ...(result.renditionUrl !== undefined ? { renditionUrl: nullableString(result, ['renditionUrl']) } : {}),
      ...(result.previewUrl !== undefined ? { previewUrl: nullableString(result, ['previewUrl']) } : {}),
      ...(result.linkedPost !== undefined ? { linkedPost: normalizeLinkedPost(result.linkedPost) } : {}),
    } : null,
    estimatedTotalCredits: numberValue(run, ['estimatedTotalCredits', 'estimated_total_credits']),
    estimatedRemainingCredits: numberValue(run, ['estimatedRemainingCredits', 'estimated_remaining_credits'])
      ?? numberValue(run, ['estimatedVideoCredits', 'estimated_video_credits']),
    creditsUsed: numberValue(run, ['creditsUsed', 'credits_used']) ?? 0,
    errorMessage: nullableString(run, ['errorMessage', 'error_message', 'error']),
    isTest: booleanValue(run, ['isTest', 'is_test'], false),
    createdAt: nullableString(run, ['createdAt', 'created_at']),
    updatedAt: nullableString(run, ['updatedAt', 'updated_at']),
  };
  return { success: response.success !== false, run: normalizedRun };
}

/**
 * The post a run's result was published as, or null. The shared run type in
 * `types.ts` has no field for it, so it is read back from the result the
 * normalizer above wrote it on.
 */
export function templateRunLinkedPost(result: TemplateRunResult | null | undefined): TemplateRunLinkedPost | null {
  return result && 'linkedPost' in result ? normalizeLinkedPost(result.linkedPost) : null;
}

export function hasAllTemplateInputs(run: TemplateRun) {
  const uploaded = new Set(run.inputs.filter((input) => input.status !== 'missing').map((input) => input.slotKey));
  return run.inputSlots.filter((slot) => slot.required).every((slot) => uploaded.has(slot.key));
}

export function isTemplateRunPolling(status: TemplateRunStatus) {
  return status === 'queued' || status === 'processing';
}

export function isTemplateRunTerminal(status: TemplateRunStatus) {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function isTemplateRunStepSuccessful(step: TemplateRunStep) {
  return ['succeeded', 'completed', 'success', 'approved'].includes(step.status.toLowerCase());
}

export function isTemplateRunStepFailed(step: TemplateRunStep) {
  return ['failed', 'error', 'cancelled'].includes(step.status.toLowerCase());
}

export function isTemplateRunStepAwaitingApproval(step: TemplateRunStep) {
  return step.kind === 'approval' && ['awaiting_approval', 'waiting_for_approval', 'ready'].includes(step.status.toLowerCase());
}

export function templateRunStepNeedsReplacementInput(step: TemplateRunStep) {
  return isTemplateRunStepFailed(step) && step.failureCode === 'invalid_input_media';
}

/**
 * The attempt a retry by hand left queued when the write that sets its run
 * going again was lost. Nothing starts it: the run waits on the person, and
 * retrying this attempt is what sets the run going. The server marks only such
 * a queued step `canRetry`. The web reads it the same way (`isStepStalled`).
 */
export function isTemplateRunStepStalled(runStatus: TemplateRunStatus, step: TemplateRunStep) {
  return step.kind === 'generation'
    && step.canRetry
    && step.status.toLowerCase() === 'queued'
    && (runStatus === 'needs_attention' || runStatus === 'awaiting_approval');
}

export function canRetryTemplateRunStep(status: TemplateRunStatus, step: TemplateRunStep) {
  return !isTemplateRunTerminal(status)
    && step.canRetry
    && !templateRunStepNeedsReplacementInput(step)
    && (isTemplateRunStepAwaitingApproval(step) || isTemplateRunStepFailed(step) || isTemplateRunStepStalled(status, step));
}

/**
 * What a step's card has to say. The first four belong to a run that can still
 * continue. Nothing on a run that has ended can be approved, retried or waited
 * for, so a step there is complete, failed, or not finished.
 */
export type TemplateRunStepOutcome =
  | 'complete'
  | 'review'
  | 'needs_attention'
  | 'in_progress'
  | 'failed'
  | 'not_finished';

export function templateRunStepOutcome(runStatus: TemplateRunStatus, step: TemplateRunStep): TemplateRunStepOutcome {
  if (isTemplateRunStepSuccessful(step)) return 'complete';
  if (isTemplateRunTerminal(runStatus)) {
    // The server stores the steps an ending run cut short as `cancelled`, the
    // status isTemplateRunStepFailed counts as a failure. A step that failed by
    // itself keeps `failed` and its own message.
    return ['failed', 'error'].includes(step.status.toLowerCase()) ? 'failed' : 'not_finished';
  }
  if (isTemplateRunStepAwaitingApproval(step)) return 'review';
  if (isTemplateRunStepFailed(step) || isTemplateRunStepStalled(runStatus, step)) return 'needs_attention';
  return 'in_progress';
}

/**
 * Whether nothing on a step's card can move it on although its run can still
 * continue: the step failed and the server refuses it a retry (the run's model
 * catalog release is gone, or the template does not let a review be retried).
 * A step whose upload must be replaced has its own way out.
 */
export function templateRunStepNeedsNewRun(runStatus: TemplateRunStatus, step: TemplateRunStep) {
  return templateRunStepOutcome(runStatus, step) === 'needs_attention'
    && !templateRunStepNeedsReplacementInput(step)
    && !canRetryTemplateRunStep(runStatus, step);
}

/** The text of the pill beside a step's name. */
export function templateRunStepStatusLabel(runStatus: TemplateRunStatus, step: TemplateRunStep) {
  switch (templateRunStepOutcome(runStatus, step)) {
    case 'complete': return step.kind === 'approval' ? 'Approved' : 'Complete';
    case 'review': return 'Review';
    case 'needs_attention': return 'Needs attention';
    case 'failed': return 'Failed';
    case 'not_finished': return 'Not finished';
    default: return step.status.replaceAll('_', ' ');
  }
}

/** The line in the box a step shows while it has no output to draw. */
export function templateRunStepPlaceholderLabel(runStatus: TemplateRunStatus, step: TemplateRunStep) {
  switch (templateRunStepOutcome(runStatus, step)) {
    case 'failed':
    case 'not_finished':
      return 'No output';
    case 'needs_attention':
      if (templateRunStepNeedsReplacementInput(step)) return 'This upload needs to be replaced';
      // Asked before the cause: every line below goes with a Retry button.
      if (templateRunStepNeedsNewRun(runStatus, step)) return 'This step cannot be retried';
      if (isTemplateRunStepStalled(runStatus, step)) return 'This step did not start';
      if (step.failureCode === 'service_misconfigured') return 'Service setup must be completed first';
      return 'This step can be retried';
    default:
      return 'Waiting for output';
  }
}

/** The mark drawn over that line. */
export type TemplateRunStepPlaceholderMark = 'waiting' | 'retry' | 'warning' | 'no_output';

export function templateRunStepPlaceholderMark(runStatus: TemplateRunStatus, step: TemplateRunStep): TemplateRunStepPlaceholderMark {
  switch (templateRunStepOutcome(runStatus, step)) {
    case 'not_finished': return 'no_output';
    case 'failed': return 'warning';
    // The retry mark is for a step that can be retried. A failed step is not
    // always one: the server can refuse it a retry, and so does a bad upload.
    case 'needs_attention': return canRetryTemplateRunStep(runStatus, step) ? 'retry' : 'warning';
    default: return 'waiting';
  }
}

export function prioritizeTemplateRunSteps(steps: TemplateRunStep[], runStatus: TemplateRunStatus) {
  const priority = (step: TemplateRunStep) => {
    if (isTemplateRunStepFailed(step) || isTemplateRunStepAwaitingApproval(step) || isTemplateRunStepStalled(runStatus, step)) return 0;
    if (!isTemplateRunStepSuccessful(step)) return 1;
    return 2;
  };
  return steps
    .map((step, index) => ({ step, index }))
    .sort((left, right) => priority(left.step) - priority(right.step) || left.index - right.index)
    .map(({ step }) => step);
}

export function templateRunStageLabel(run: Pick<TemplateRun, 'status' | 'result'>) {
  switch (run.status) {
    case 'collecting_inputs': return 'Add your inputs';
    case 'queued': return 'Workflow queued';
    case 'processing': return 'Workflow in progress';
    case 'awaiting_approval': return 'Review the next step';
    case 'succeeded': return `Your ${run.result?.kind || 'result'} is ready`;
    case 'failed': return 'Creation failed';
    case 'cancelled': return 'Creation cancelled';
    default: return 'A step needs attention';
  }
}

export function templateRunProgress(run: Pick<TemplateRun, 'status' | 'steps'>) {
  const total = run.steps.length + 1;
  const complete = (run.status === 'collecting_inputs' ? 0 : 1)
    + run.steps.filter(isTemplateRunStepSuccessful).length;
  return { complete, total };
}

export function canAffordTemplateCredits(balance: number | null, estimate: number | null) {
  return balance === null || estimate === null || balance >= estimate;
}

export function canPublishTemplateRunResult(
  run: Pick<TemplateRun, 'isTest' | 'result' | 'status'>
) {
  return run.status === 'succeeded'
    && !run.isTest
    && Boolean(run.result?.generationId?.trim())
    // Publishing again would write over the post already made from this result.
    && !templateRunLinkedPost(run.result);
}

// Refusals that mean the step moved on without this screen: on the web, or before a read.
const STEP_ALREADY_HANDLED_CODES = new Set([
  'STALE_STEP_ATTEMPT',
  'APPROVAL_ALREADY_HANDLED',
  'APPROVAL_NOT_READY',
  'STEP_NOT_RETRYABLE',
]);

/**
 * What a refused action says. The screen reads the run again after a refusal,
 * so these say where the run stands: trying the same action again would be
 * refused the same way. The web picks the same words (`getTemplateRunErrorCopy`).
 */
export function templateRunActionErrorMessage(message: string, code?: string | null): string {
  if (code === 'RUN_TERMINAL') return 'This run has ended. Start a new run to try the template again.';
  if (code === 'STEP_NOT_FOUND') return 'That step is no longer part of this run.';
  // The checkpoint retry sends codes of its own with "…already handled. Refresh the run before retrying."
  if ((code && STEP_ALREADY_HANDLED_CODES.has(code)) || /already handled/i.test(message)) {
    return 'This step was already handled. The run has been refreshed.';
  }
  return message;
}

export function isSafeTemplateResultUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function createTemplateRunIdempotencyKey(prefix = 'mobile-template-run') {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  const nonce = randomUUID
    ? randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${nonce}`;
}
