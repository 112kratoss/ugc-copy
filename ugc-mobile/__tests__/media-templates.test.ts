import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canAffordTemplateCredits,
  canPublishTemplateRunResult,
  canRetryTemplateRunStep,
  createTemplateRunIdempotencyKey,
  hasAllTemplateInputs,
  isSafeTemplateResultUrl,
  isTemplateRunPolling,
  isTemplateRunStepAwaitingApproval,
  normalizeMediaTemplateDetailResponse,
  normalizeMediaTemplateListResponse,
  normalizeTemplateRunResponse,
  prioritizeTemplateRunSteps,
  templateRunStepNeedsReplacementInput,
  templateRunProgress,
  templateRunStageLabel,
  templateRunStepOutcome,
  templateRunStepPlaceholderLabel,
  templateRunStepStatusLabel,
  totalTemplateEstimate,
} from '../lib/media-templates';
import type { TemplateRunStatus, TemplateRunStep } from '../lib/types';

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
    expect(totalTemplateEstimate(list.templates[0])).toBe(12);
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

    expect(prioritizeTemplateRunSteps(run.steps).map((step) => step.id)).toEqual(['failed', 'queued', 'complete']);
    expect(run.steps[2].failureCode).toBe('invalid_input_media');
    expect(templateRunStepNeedsReplacementInput(run.steps[2])).toBe(true);
    expect(canRetryTemplateRunStep('needs_attention', run.steps[2])).toBe(false);
    expect(canRetryTemplateRunStep('failed', { ...run.steps[2], failureCode: 'provider_busy' })).toBe(false);
    expect(canRetryTemplateRunStep('needs_attention', { ...run.steps[2], failureCode: 'provider_busy' })).toBe(true);
  });

  describe('a step of a run that has ended', () => {
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
      for (const wording of ['Needs attention', 'Not finished', 'This step can be retried', 'Waiting for output', 'No output']) {
        expect(screen, wording).not.toContain(wording);
      }
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
