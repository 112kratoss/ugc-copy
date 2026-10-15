import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canAffordTemplateCredits,
  canPublishTemplateRunResult,
  canRetryTemplateRunStep,
  createTemplateRunIdempotencyKey,
  formatTemplateUseCount,
  hasAllTemplateInputs,
  isSafeTemplateResultUrl,
  isTemplateRunPolling,
  isTemplateRunStepAwaitingApproval,
  isTemplateRunStepStalled,
  normalizeMediaTemplateDetailResponse,
  normalizeMediaTemplateListResponse,
  normalizeTemplateRunResponse,
  prioritizeTemplateRunSteps,
  renewTemplatePosters,
  TEMPLATE_REPORT_REASONS,
  templatePosterCacheKey,
  templateRunActionErrorMessage,
  templateRunLinkedPost,
  templateRunStepNeedsNewRun,
  templateRunStepNeedsReplacementInput,
  templateRunProgress,
  templateRunStageLabel,
  templateRunStepOutcome,
  templateRunStepPlaceholderLabel,
  templateRunStepPlaceholderMark,
  templateRunStepStatusLabel,
  withRenewedTemplatePosters,
  withStableTemplateMedia,
} from '../lib/media-templates';
import type { TemplateRunFailureCode, TemplateRunStatus, TemplateRunStep } from '../lib/types';

const templateFixture = {
  id: 'template-1',
  slug: 'campaign-builder',
  name: 'Campaign builder',
  description: 'Turn a product image and reference clip into a campaign video.',
  category: 'Campaign',
  videoUrl: '/storage/demo.mp4',
  thumbnailUrl: '/storage/cover.jpg',
  creatorUserId: 'creator-1',
  creator: { id: 'creator-1', username: 'maya', displayName: 'Maya', avatarUrl: '/avatars/maya.jpg' },
  inputSlots: [
    { key: 'product', kind: 'image', label: 'Product', description: 'Use a clear product image.', required: true },
    { key: 'motion', kind: 'video', label: 'Reference clip', description: 'Use a short movement reference.', required: true },
  ],
  outputKind: 'video',
  status: 'active',
  useCount: 42,
  estimatedTotalCredits: 12,
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T01:00:00.000Z',
};

describe('media template view model', () => {
  it('normalizes the public manifest without exposing graph or prompt data', () => {
    const fixture = { ...templateFixture, graph: { nodes: [{ id: 'private' }] }, prompt: 'private' };
    const list = normalizeMediaTemplateListResponse({ templates: [fixture] });
    const detail = normalizeMediaTemplateDetailResponse({ template: fixture });

    expect(list.templates[0]).toMatchObject({
      id: 'template-1',
      name: 'Campaign builder',
      outputKind: 'video',
      estimatedTotalCredits: 12,
      inputSlots: [
        { key: 'product', kind: 'image', required: true },
        { key: 'motion', kind: 'video', required: true },
      ],
    });
    expect(detail.template.createdAt).toBe('2026-07-11T00:00:00.000Z');
    expect(detail.template).not.toHaveProperty('graph');
    expect(detail.template).not.toHaveProperty('prompt');
  });

  it('normalizes arbitrary public run steps, remaining cost, and final result', () => {
    const response = normalizeTemplateRunResponse({
      run: {
        id: 'run-1',
        templateId: 'template-1',
        templateTitle: 'Campaign builder',
        status: 'awaiting_approval',
        inputSlots: templateFixture.inputSlots,
        inputs: [
          { slotKey: 'product', storagePath: 'template_inputs/product.jpg' },
          { slotKey: 'motion', storagePath: 'template_inputs/motion.mp4' },
        ],
        steps: [
          { id: 'step-1', kind: 'generation', mediaKind: 'image', status: 'succeeded', label: 'Product scene', outputUrl: '/generated/scene.jpg' },
          { id: 'step-2', graphNodeId: 'private-node', kind: 'approval', mediaKind: 'image', status: 'awaiting_approval', label: 'Review scene', outputUrl: '/generated/scene.jpg', canRetry: true, estimatedRetryCredits: 2 },
        ],
        result: null,
        estimatedTotalCredits: 12,
        estimatedRemainingCredits: 8,
        creditsUsed: 4,
      },
    });

    expect(response.run.steps).toHaveLength(2);
    expect(response.run.steps[1]).toMatchObject({ id: 'step-2', kind: 'approval', estimatedRetryCredits: 2 });
    expect(response.run.steps[1]).not.toHaveProperty('graphNodeId');
    expect(isTemplateRunStepAwaitingApproval(response.run.steps[1])).toBe(true);
    expect(hasAllTemplateInputs(response.run)).toBe(true);
    expect(response.run.estimatedRemainingCredits).toBe(8);
    expect(response.run.creditsUsed).toBe(4);
    expect(templateRunProgress(response.run)).toEqual({ complete: 2, total: 3 });
  });

  it('maps generic polling and status copy', () => {
    expect(isTemplateRunPolling('queued')).toBe(true);
    expect(isTemplateRunPolling('processing')).toBe(true);
    expect(isTemplateRunPolling('awaiting_approval')).toBe(false);
    expect(templateRunStageLabel({ status: 'succeeded', result: { generationId: 'gen-1', kind: 'image', url: '/result.png' } })).toBe('Your image is ready');
  });

  it('preserves only the canonical result generation id for feed publishing', () => {
    const canonical = normalizeTemplateRunResponse({
      run: {
        id: 'run-canonical',
        templateId: 'template-1',
        status: 'succeeded',
        inputSlots: [],
        inputs: {},
        steps: [{ id: 'step-private', status: 'succeeded', outputUrl: '/result.png' }],
        result: { generationId: 'gen-canonical', kind: 'image', url: '/result.png' },
        isTest: false,
      },
    }).run;
    const legacy = normalizeTemplateRunResponse({
      run: {
        id: 'run-legacy',
        templateId: 'template-1',
        status: 'succeeded',
        inputSlots: [],
        inputs: {},
        videoGeneration: { id: 'not-a-canonical-id', status: 'succeeded', outputUrl: '/result.mp4' },
      },
    }).run;

    expect(canonical.result).toMatchObject({ generationId: 'gen-canonical', url: '/result.png' });
    expect(canPublishTemplateRunResult(canonical)).toBe(true);
    expect(canPublishTemplateRunResult({ ...canonical, isTest: true })).toBe(false);
    expect(legacy.result).toMatchObject({ generationId: null, url: '/result.mp4' });
    expect(canPublishTemplateRunResult(legacy)).toBe(false);
  });

  describe('the post a result was published as', () => {
    const succeeded = (result: Record<string, unknown>) => normalizeTemplateRunResponse({
      run: {
        id: 'run-posted',
        templateId: 'template-1',
        status: 'succeeded',
        inputSlots: [],
        inputs: {},
        steps: [],
        result: { generationId: 'gen-posted', kind: 'video', url: 'https://cdn.example.com/result.mp4', ...result },
        isTest: false,
      },
    }).run;

    it('reads it from the result, and never offers to publish over it', () => {
      for (const visibility of ['public', 'unlisted', 'private'] as const) {
        const run = succeeded({ linkedPost: { id: 'post-1', visibility } });
        expect(templateRunLinkedPost(run.result)).toEqual({ id: 'post-1', visibility });
        expect(canPublishTemplateRunResult(run)).toBe(false);
      }
    });

    it('offers Publish for a result with no post, from a read that names none or an older one that leaves it out', () => {
      const none = succeeded({ linkedPost: null });
      const older = succeeded({});

      expect(templateRunLinkedPost(none.result)).toBeNull();
      expect(canPublishTemplateRunResult(none)).toBe(true);
      expect(older.result).not.toHaveProperty('linkedPost');
      expect(templateRunLinkedPost(older.result)).toBeNull();
      expect(canPublishTemplateRunResult(older)).toBe(true);
      expect(templateRunLinkedPost(null)).toBeNull();
    });

    it('reads a visibility it does not know as private, and a post without an id as none', () => {
      expect(templateRunLinkedPost(succeeded({ linkedPost: { id: 'post-1', visibility: 'followers' } }).result))
        .toEqual({ id: 'post-1', visibility: 'private' });
      expect(templateRunLinkedPost(succeeded({ linkedPost: { visibility: 'public' } }).result)).toBeNull();
    });
  });

  it('says where the run stands after a refused action, by its code', () => {
    expect(templateRunActionErrorMessage('This run has ended. Start a new run to try the template again.', 'RUN_TERMINAL'))
      .toBe('This run has ended. Start a new run to try the template again.');
    expect(templateRunActionErrorMessage('Template run step not found.', 'STEP_NOT_FOUND'))
      .toBe('That step is no longer part of this run.');
    for (const code of ['STALE_STEP_ATTEMPT', 'APPROVAL_ALREADY_HANDLED', 'APPROVAL_NOT_READY', 'STEP_NOT_RETRYABLE']) {
      expect(templateRunActionErrorMessage('This checkpoint is not waiting for approval.', code), code)
        .toBe('This step was already handled. The run has been refreshed.');
    }
    // The checkpoint retry's own codes come with this message.
    expect(templateRunActionErrorMessage('This checkpoint was already handled. Refresh the run before retrying.', 'RETRY_ALREADY_STARTED'))
      .toBe('This step was already handled. The run has been refreshed.');
    // Anything else keeps the server's words.
    expect(templateRunActionErrorMessage('Insufficient credits.', 'INSUFFICIENT_CREDITS')).toBe('Insufficient credits.');
    expect(templateRunActionErrorMessage('Network request failed. Please check your connection and try again.', null))
      .toBe('Network request failed. Please check your connection and try again.');
  });

  it('gates known credit shortfalls and accepts only safe result links', () => {
    expect(canAffordTemplateCredits(7, 8)).toBe(false);
    expect(canAffordTemplateCredits(8, 8)).toBe(true);
    expect(canAffordTemplateCredits(null, 8)).toBe(true);
    expect(isSafeTemplateResultUrl('https://cdn.example.com/result.png')).toBe(true);
    expect(isSafeTemplateResultUrl('http://localhost:3000/result.png')).toBe(true);
    expect(isSafeTemplateResultUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeTemplateResultUrl('/relative/result.png')).toBe(false);
  });

  it('puts action-needed steps first and requires a new run for invalid media', () => {
    const run = normalizeTemplateRunResponse({
      run: {
        id: 'run-actions',
        templateId: 'template-1',
        status: 'needs_attention',
        inputSlots: [],
        inputs: {},
        steps: [
          { id: 'complete', status: 'succeeded', label: 'Done' },
          { id: 'queued', status: 'queued', label: 'Later' },
          { id: 'failed', status: 'failed', label: 'Fix first', failureCode: 'invalid_input_media', canRetry: true },
        ],
      },
    }).run;

    expect(prioritizeTemplateRunSteps(run.steps, run.status).map((step) => step.id)).toEqual(['failed', 'queued', 'complete']);
    expect(run.steps[2].failureCode).toBe('invalid_input_media');
    expect(templateRunStepNeedsReplacementInput(run.steps[2])).toBe(true);
    expect(canRetryTemplateRunStep('needs_attention', run.steps[2])).toBe(false);
    expect(canRetryTemplateRunStep('failed', { ...run.steps[2], failureCode: 'provider_busy' })).toBe(false);
    expect(canRetryTemplateRunStep('needs_attention', { ...run.steps[2], failureCode: 'provider_busy' })).toBe(true);
  });

  const step = (overrides: Partial<TemplateRunStep> = {}): TemplateRunStep => ({
    id: 'step',
    kind: 'generation',
    mediaKind: 'image',
    status: 'cancelled',
    label: 'Final image',
    outputUrl: null,
    errorMessage: null,
    failureCode: null,
    canRetry: false,
    estimatedRetryCredits: 12,
    ...overrides,
  });

  describe('a step of a run that has ended', () => {
    const describeStep = (runStatus: TemplateRunStatus, value: TemplateRunStep) => ({
      outcome: templateRunStepOutcome(runStatus, value),
      pill: templateRunStepStatusLabel(runStatus, value),
      box: templateRunStepPlaceholderLabel(runStatus, value),
    });

    it.each(['cancelled', 'failed'] as const)('reads as not finished when a %s run cut it short', (runStatus) => {
      // What the server stores for a step that was queued, was waiting for the
      // person's review, or was still generating when the run ended.
      expect(describeStep(runStatus, step())).toEqual({ outcome: 'not_finished', pill: 'Not finished', box: 'No output' });
      expect(describeStep(runStatus, step({ kind: 'approval', label: 'Review final image' })))
        .toEqual({ outcome: 'not_finished', pill: 'Not finished', box: 'No output' });
      expect(describeStep(runStatus, step({ errorMessage: 'This step was not finished because the run stopped.' })).pill)
        .toBe('Not finished');
    });

    it('reads as failed when it had failed by itself before the run ended', () => {
      const failed = step({ status: 'failed', errorMessage: 'The generation provider is temporarily unavailable.', failureCode: 'provider_unavailable', canRetry: true });

      expect(describeStep('cancelled', failed)).toEqual({ outcome: 'failed', pill: 'Failed', box: 'No output' });
      expect(describeStep('failed', { ...failed, status: 'error' })).toEqual({ outcome: 'failed', pill: 'Failed', box: 'No output' });
      // The retry it could have had is gone with the run.
      expect(canRetryTemplateRunStep('cancelled', failed)).toBe(false);
    });

    it('never promises a retry, a review or more waiting', () => {
      // Steps the server did not get to cancel keep the status they had.
      const leftovers = [
        step({ status: 'queued' }),
        step({ status: 'processing' }),
        step({ kind: 'approval', status: 'awaiting_approval', outputUrl: '/generated/scene.jpg', canRetry: true }),
        step({ status: 'failed', failureCode: 'invalid_input_media', canRetry: true }),
        step({ status: 'failed', failureCode: 'service_misconfigured', canRetry: true }),
      ];
      for (const runStatus of ['cancelled', 'failed'] as const) {
        for (const leftover of leftovers) {
          const described = describeStep(runStatus, leftover);
          expect(['failed', 'not_finished']).toContain(described.outcome);
          expect(['Failed', 'Not finished']).toContain(described.pill);
          expect(described.box).toBe('No output');
        }
      }
    });

    it('keeps the wording of a finished step', () => {
      expect(describeStep('cancelled', step({ status: 'succeeded', outputUrl: '/generated/scene.jpg' })).pill).toBe('Complete');
      expect(describeStep('failed', step({ kind: 'approval', status: 'succeeded', outputUrl: '/generated/scene.jpg' })).pill).toBe('Approved');
      expect(describeStep('succeeded', step({ status: 'succeeded' })).outcome).toBe('complete');
    });

    it('is where the run screen takes its words from', () => {
      // A source assertion, as active-generations-invalidation.test.ts makes of
      // the same screen: rendering it would boot the native chain for two strings.
      const screen = readFileSync(path.resolve(__dirname, '../components/media-template-screens.tsx'), 'utf8');

      expect(screen).toContain('templateRunStepStatusLabel(runStatus, step)');
      expect(screen).toContain('templateRunStepPlaceholderLabel(runStatus, step)');
      for (const wording of ['Needs attention', 'Not finished', 'This step can be retried', 'This step cannot be retried', 'This step did not start', 'Waiting for output', 'No output']) {
        expect(screen, wording).not.toContain(wording);
      }
      // The mark over those words and the way out of a step that cannot go on
      // are answers of the same helpers: decided in the screen from "it failed",
      // they promised a retry the step did not have.
      expect(screen).toContain('templateRunStepPlaceholderMark(runStatus, step)');
      expect(screen).toContain('templateRunStepNeedsNewRun(runStatus, step)');
      // The retry mark is drawn for that answer, and the way out is a button on the card.
      expect(screen).toContain("mark === 'retry' ? <RefreshCw");
      expect(screen).toMatch(/needsNewRun\) \? \(\s*<SecondaryButton/);
      // Whether a step can be approved is the outcome's answer too: asking the
      // step alone would offer it on a run that has ended.
      expect(screen).toContain("outcome === 'review'");
      expect(screen).not.toContain('isTemplateRunStepAwaitingApproval');
    });

    it('leaves a run that can still continue as it was', () => {
      const failed = step({ status: 'failed', failureCode: 'provider_unavailable', canRetry: true });

      expect(describeStep('needs_attention', failed)).toEqual({ outcome: 'needs_attention', pill: 'Needs attention', box: 'This step can be retried' });
      expect(describeStep('needs_attention', { ...failed, failureCode: 'invalid_input_media' }).box).toBe('This upload needs to be replaced');
      expect(describeStep('needs_attention', { ...failed, failureCode: 'service_misconfigured' }).box).toBe('Service setup must be completed first');
      expect(describeStep('awaiting_approval', step({ kind: 'approval', status: 'awaiting_approval', outputUrl: '/generated/scene.jpg' })))
        .toMatchObject({ outcome: 'review', pill: 'Review' });
      expect(describeStep('processing', step({ status: 'processing' }))).toEqual({ outcome: 'in_progress', pill: 'processing', box: 'Waiting for output' });
      expect(describeStep('queued', step({ status: 'queued' }))).toEqual({ outcome: 'in_progress', pill: 'queued', box: 'Waiting for output' });
      expect(describeStep('processing', step({ kind: 'approval', status: 'awaiting_approval' })).box).toBe('Waiting for output');
    });
  });

  describe('a failed step of a run that can still continue', () => {
    const card = (runStatus: TemplateRunStatus, value: TemplateRunStep) => ({
      box: templateRunStepPlaceholderLabel(runStatus, value),
      mark: templateRunStepPlaceholderMark(runStatus, value),
      retry: canRetryTemplateRunStep(runStatus, value),
      newRun: templateRunStepNeedsNewRun(runStatus, value),
    });
    const failed = (overrides: Partial<TemplateRunStep> = {}) => step({ status: 'failed', canRetry: true, ...overrides });

    it('does not promise a retry to a step that cannot have one', () => {
      // What the worker writes on a step whose pinned catalog release is gone:
      // failed for good, in a run it leaves at needs_attention.
      const catalogGone = failed({
        failureCode: 'provider_rejected',
        canRetry: false,
        errorMessage: 'This template was published against a model catalog that is no longer available. It cannot generate until its creator republishes it.',
      });
      // A review step the template does not let people retry, failed for want of its input.
      const review = failed({ kind: 'approval', canRetry: false, errorMessage: 'This step is missing a required workflow input.' });

      for (const value of [catalogGone, review]) {
        expect(card('needs_attention', value)).toEqual({
          box: 'This step cannot be retried', mark: 'warning', retry: false, newRun: true,
        });
      }
      // The pill is the one every failed step of such a run has.
      expect(templateRunStepStatusLabel('needs_attention', catalogGone)).toBe('Needs attention');
    });

    it('keeps the retry mark, and only the retry, on a step that can be retried', () => {
      expect(card('needs_attention', failed({ failureCode: 'provider_unavailable' })))
        .toEqual({ box: 'This step can be retried', mark: 'retry', retry: true, newRun: false });
      expect(card('needs_attention', failed({ failureCode: 'service_misconfigured' })))
        .toEqual({ box: 'Service setup must be completed first', mark: 'retry', retry: true, newRun: false });
    });

    it('never advises a retry the step cannot have', () => {
      expect(card('needs_attention', failed({ failureCode: 'service_misconfigured', canRetry: false })))
        .toEqual({ box: 'This step cannot be retried', mark: 'warning', retry: false, newRun: true });
    });

    it('leaves a step whose upload must be replaced to its own way out', () => {
      // "Start with new inputs" is its button. It cannot be retried, so the retry mark is not its mark.
      for (const canRetry of [true, false]) {
        expect(card('needs_attention', failed({ failureCode: 'invalid_input_media', canRetry })))
          .toEqual({ box: 'This upload needs to be replaced', mark: 'warning', retry: false, newRun: false });
      }
    });

    it('gives every failed step exactly one way forward, and promises a retry only where there is one', () => {
      const runStatuses: TemplateRunStatus[] = [
        'collecting_inputs', 'queued', 'processing', 'awaiting_approval', 'needs_attention', 'succeeded', 'failed', 'cancelled',
      ];
      const failureCodes: (TemplateRunFailureCode | null)[] = [
        null, 'insufficient_credits', 'invalid_input_media', 'service_misconfigured', 'provider_busy', 'provider_unavailable', 'provider_rejected',
      ];
      let stuck = 0;
      for (const runStatus of runStatuses) {
        for (const kind of ['generation', 'approval'] as const) {
          for (const status of ['queued', 'processing', 'awaiting_approval', 'succeeded', 'failed', 'error', 'cancelled']) {
            for (const failureCode of failureCodes) {
              for (const canRetry of [true, false]) {
                const value = step({ kind, status, failureCode, canRetry });
                const described = card(runStatus, value);
                const context = JSON.stringify({ runStatus, kind, status, failureCode, canRetry });

                const promisesRetry = described.mark === 'retry'
                  || ['This step can be retried', 'Service setup must be completed first'].includes(described.box);
                if (promisesRetry) expect(described.retry, context).toBe(true);
                expect(described.box === 'This step cannot be retried', context).toBe(described.newRun);

                if (templateRunStepOutcome(runStatus, value) === 'needs_attention') {
                  const waysForward = [described.retry, templateRunStepNeedsReplacementInput(value), described.newRun];
                  expect(waysForward.filter(Boolean), context).toHaveLength(1);
                  if (described.newRun) stuck += 1;
                } else {
                  // A step that is waiting, under review or done needs no way out,
                  // and a run that has ended offers the new run once, under its steps.
                  expect(described.newRun, context).toBe(false);
                }
              }
            }
          }
        }
      }
      // The sweep reached the steps this is about.
      expect(stuck).toBeGreaterThan(0);
    });
  });

  describe('a retry that never started', () => {
    // What a fresh read shows after a retry by hand whose run was never set going
    // again: the new attempt, queued, which the server marks canRetry.
    const stranded = step({ id: 'video-attempt-2', mediaKind: 'video', label: 'Final video', status: 'queued', canRetry: true, estimatedRetryCredits: 30 });

    it.each(['needs_attention', 'awaiting_approval'] as const)('can be retried, and says so, in a %s run', (runStatus) => {
      expect(isTemplateRunStepStalled(runStatus, stranded)).toBe(true);
      expect(templateRunStepOutcome(runStatus, stranded)).toBe('needs_attention');
      expect(templateRunStepStatusLabel(runStatus, stranded)).toBe('Needs attention');
      expect(templateRunStepPlaceholderLabel(runStatus, stranded)).toBe('This step did not start');
      expect(templateRunStepPlaceholderMark(runStatus, stranded)).toBe('retry');
      expect(canRetryTemplateRunStep(runStatus, stranded)).toBe(true);
      expect(templateRunStepNeedsNewRun(runStatus, stranded)).toBe(false);
    });

    it('comes first, as the one step that can move the run on', () => {
      const steps = [
        step({ id: 'opening', status: 'succeeded' }),
        step({ id: 'review', kind: 'approval', status: 'queued' }),
        stranded,
      ];
      expect(prioritizeTemplateRunSteps(steps, 'needs_attention').map((value) => value.id)).toEqual(['video-attempt-2', 'review', 'opening']);
    });

    it('leaves every other queued step waiting', () => {
      // The worker's busy wait carries its own note and no retry; a step behind
      // a review was never tried; a review is not a generation; a polled run starts its own steps.
      const waiting = [
        ['needs_attention', { ...stranded, canRetry: false }],
        ['awaiting_approval', { ...stranded, canRetry: false }],
        ['needs_attention', { ...stranded, kind: 'approval' as const }],
        ['processing', stranded],
        ['queued', stranded],
      ] as const;
      for (const [runStatus, value] of waiting) {
        const context = JSON.stringify({ runStatus, kind: value.kind, canRetry: value.canRetry });
        expect(isTemplateRunStepStalled(runStatus, value), context).toBe(false);
        expect(templateRunStepOutcome(runStatus, value), context).toBe('in_progress');
        expect(canRetryTemplateRunStep(runStatus, value), context).toBe(false);
      }
      // A run that has ended starts nothing again.
      expect(isTemplateRunStepStalled('cancelled', stranded)).toBe(false);
      expect(templateRunStepOutcome('cancelled', stranded)).toBe('not_finished');
      expect(canRetryTemplateRunStep('cancelled', stranded)).toBe(false);
    });
  });

  it('creates bounded action-specific idempotency keys', () => {
    expect(createTemplateRunIdempotencyKey('test-template')).toMatch(/^test-template:[a-zA-Z0-9-]+$/);
  });

  it('keeps legacy fixed-generation responses usable only as a normalization fallback', () => {
    const response = normalizeTemplateRunResponse({
      run: {
        id: 'legacy-run',
        templateId: 'template-1',
        status: 'needs_attention',
        inputSlots: [{ key: 'person', label: 'Portrait' }],
        finalFrameGeneration: {
          id: 'legacy-generation',
          status: 'failed',
          errorMessage: 'Provider safety check failed.',
          cost: 2,
        },
        errorMessage: 'The final frame was rejected.',
      },
    });

    expect(response.run.inputSlots[0]).toMatchObject({ kind: 'image', required: true });
    expect(response.run.steps[0]).toMatchObject({ id: 'legacy-generation', status: 'failed', estimatedRetryCredits: 2 });
    expect(response.run.errorMessage).toBe('The final frame was rejected.');
  });
});

describe('catalog posters (01-5)', () => {
  const stored = 'https://project.supabase.co/storage/v1/object/sign/template_assets/template-1/version-2/poster.webp';

  it('caches a signed poster under its stored file, and any other link as it is', () => {
    expect(templatePosterCacheKey(`${stored}?token=first`)).toBe(stored);
    expect(templatePosterCacheKey(`${stored}?token=second`)).toBe(stored);
    // A new version's poster is a new file, so a new key.
    expect(templatePosterCacheKey(stored.replace('version-2', 'version-3') + '?token=third')).not.toBe(stored);
    // Only a signed Storage link has a token to drop; another link's query may be the picture.
    expect(templatePosterCacheKey('https://cdn.example.com/poster.webp?width=720')).toBe('https://cdn.example.com/poster.webp?width=720');
    expect(templatePosterCacheKey(null)).toBeNull();
  });

  it('reads the failed templates again four at a time, and leaves out one that cannot be read', async () => {
    let inFlight = 0;
    let mostInFlight = 0;
    const read = async (id: string) => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      if (id === 'gone') throw new Error('Template not found.');
      return { id, thumbnailUrl: `${stored}?token=${id}` };
    };

    const renewed = await renewTemplatePosters(['a', 'b', 'gone', 'c', 'd', 'e', 'a'], read);

    expect(mostInFlight).toBe(4);
    expect([...renewed.keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(renewed.get('c')).toBe(`${stored}?token=c`);
  });

  it('puts renewed links into the loaded pages and leaves every other field as the list read it', () => {
    const pages = {
      pages: [
        normalizeMediaTemplateListResponse({ templates: [{ id: 'a', name: 'A', thumbnailUrl: 'old-a' }, { id: 'b', name: 'B', thumbnailUrl: 'old-b' }], nextCursor: 'next' }),
        normalizeMediaTemplateListResponse({ templates: [{ id: 'c', name: 'C', thumbnailUrl: 'old-c' }] }),
      ],
      pageParams: [null, 'next'],
    };

    const updated = withRenewedTemplatePosters(pages, new Map([['b', 'new-b'], ['c', null]]));

    expect(updated?.pages.map((page) => page.templates.map((template) => template.thumbnailUrl))).toEqual([['old-a', 'new-b'], [null]]);
    expect(updated?.pages[0].nextCursor).toBe('next');
    expect(updated?.pageParams).toEqual([null, 'next']);
    expect(withRenewedTemplatePosters(pages, new Map())).toBe(pages);
  });
});

describe('a template’s page (01-3, 01-9)', () => {
  const STORAGE = 'https://project.supabase.co';
  const NOW = Date.parse('2026-10-15T12:00:00.000Z');
  /** A Storage link signed the way Supabase signs one, `exp` in seconds inside the token. */
  const signed = (path: string, expiresInMs: number, nonce: string) => {
    const claims = Buffer.from(JSON.stringify({ url: path, exp: Math.floor((NOW + expiresInMs) / 1000), nonce })).toString('base64url');
    return `${STORAGE}/storage/v1/object/sign/${path}?token=head.${claims}.signature`;
  };
  const HOUR = 60 * 60 * 1000;
  const template = (videoUrl: string | null, thumbnailUrl: string | null, id = 'template-1') => ({ id, videoUrl, thumbnailUrl });

  it('says “1 use” and “N uses”, as the web does', () => {
    expect(formatTemplateUseCount(1)).toBe('1 use');
    expect(formatTemplateUseCount(0)).toBe('0 uses');
    expect(formatTemplateUseCount(1240)).toBe('1,240 uses');
  });

  it('keeps the demo’s and the poster’s links on screen across a read that signs them again', () => {
    const shown = template(signed('template_assets/t/v/demo.mp4', 24 * HOUR, 'a'), signed('template_assets/t/v/poster.webp', 24 * HOUR, 'a'));
    const reread = template(signed('template_assets/t/v/demo.mp4', 24 * HOUR, 'b'), signed('template_assets/t/v/poster.webp', 24 * HOUR, 'b'));

    expect(withStableTemplateMedia(shown, reread, NOW, STORAGE)).toEqual(shown);
  });

  it('takes the new link for a new file, a link about to stop working, or another template', () => {
    const shown = template(signed('template_assets/t/v1/demo.mp4', 24 * HOUR, 'a'), signed('template_assets/t/v1/poster.webp', 4 * 60 * 1000, 'a'));
    const reread = template(signed('template_assets/t/v2/demo.mp4', 24 * HOUR, 'b'), signed('template_assets/t/v1/poster.webp', 24 * HOUR, 'b'));

    expect(withStableTemplateMedia(shown, reread, NOW, STORAGE)).toEqual(reread);
    expect(withStableTemplateMedia(shown, { ...shown, id: 'template-2' }, NOW, STORAGE).id).toBe('template-2');
    expect(withStableTemplateMedia(undefined, reread, NOW, STORAGE)).toBe(reread);
    expect(withStableTemplateMedia(shown, template(null, null), NOW, STORAGE)).toEqual(template(null, null));
  });

  it('offers the reasons the server takes for a template: a post’s, less the two about a recipe', () => {
    expect(TEMPLATE_REPORT_REASONS.map((reason) => reason.value)).toEqual(['spam', 'stolen_content', 'unsafe_content', 'other']);
  });
});
