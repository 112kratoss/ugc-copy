import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  approveTemplateRunStep,
  normalizeTemplate,
  normalizeTemplateRun,
  retryTemplateRunStep,
  startTemplateRun,
} from '@/app/components/templates/api';
import {
  getTemplateImageDimensionError,
  getTemplateRunErrorCopy,
  validateTemplateInputFileMetadata,
} from '@/app/components/templates/TemplateRunClient';
import {
  TemplateCard,
  TemplateRunStepCard,
  TemplateRunStepper,
  TemplateSlotUpload,
} from '@/app/components/templates/TemplatePrimitives';
import { shouldPollTemplateRun, type MediaTemplate, type TemplateRunStep } from '@/app/components/templates/types';

const template: MediaTemplate = {
  id: 'template-1',
  slug: 'rider-transformation',
  name: 'Rider transformation',
  description: 'Turn a portrait and vehicle into a cinematic transformation.',
  category: 'Transformation',
  videoUrl: 'https://cdn.example.com/demo.mp4',
  thumbnailUrl: 'https://cdn.example.com/demo.jpg',
  creatorUserId: 'creator-1',
  creator: { id: 'creator-1', username: 'athul', displayName: 'Athul', avatarUrl: null },
  inputSlots: [
    { key: 'subject', kind: 'image', label: 'Your photo', required: true },
    { key: 'reference', kind: 'image', label: 'Your vehicle', required: true },
  ],
  outputKind: 'video',
  status: 'active',
  useCount: 23,
  estimatedTotalCredits: 14,
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
};

describe('template web primitives', () => {
  it('shows the public manifest summary and total estimate on a catalog card', () => {
    render(<TemplateCard template={template} />);

    expect(screen.getByText('Rider transformation')).toBeInTheDocument();
    expect(screen.getByText('Athul')).toBeInTheDocument();
    expect(screen.getByText('2 images')).toBeInTheDocument();
    expect(screen.getByText('23 uses')).toBeInTheDocument();
    expect(screen.getByText('14 credits')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/templates/rider-transformation');
  });

  it('accepts the media kind declared by a dynamic input slot', () => {
    const onChange = vi.fn();
    render(
      <TemplateSlotUpload
        slot={{ key: 'clip', kind: 'video', label: 'Reference clip', description: 'Use a short clip.', required: true }}
        file={null}
        previewUrl={null}
        stored={false}
        onChange={onChange}
      />
    );

    const file = new File(['video'], 'reference.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByLabelText('Choose video'), { target: { files: [file] } });

    expect(onChange).toHaveBeenCalledWith(file);
    expect(screen.getByText('Use a short clip.')).toBeInTheDocument();
    expect(screen.getByText('MP4, WebM or MOV · up to 100 MB')).toBeInTheDocument();
  });

  it('shows a file-specific upload error beside the affected slot', () => {
    render(
      <TemplateSlotUpload
        slot={{ key: 'subject', kind: 'image', label: 'Your photo', required: true }}
        file={null}
        previewUrl={null}
        stored={false}
        error="This image is 92 × 92 px. Choose one that is at least 256 × 256 px so generation can use it reliably."
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('92 × 92 px');
    expect(screen.getByText('JPEG, PNG or WebP · at least 256 × 256 px · up to 30 MB')).toBeInTheDocument();
    expect(screen.getByLabelText('Choose image')).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps approval and costed retry available on an approval step', () => {
    const onApprove = vi.fn();
    const onRetry = vi.fn();
    const step: TemplateRunStep = {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'approval',
      mediaKind: 'image',
      status: 'awaiting_approval',
      label: 'Review portrait',
      outputUrl: 'https://cdn.example.com/portrait.jpg',
      errorMessage: null,
      failureCode: null,
      canRetry: true,
      estimatedRetryCredits: 2,
    };
    render(<TemplateRunStepCard step={step} availableCredits={10} onApprove={onApprove} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve & continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry step · 2 credits' }));

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.getByText('Create a new version of this step?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps failed-step details and retry recovery visible without a media result', () => {
    const onRetry = vi.fn();
    const step: TemplateRunStep = {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'generation',
      mediaKind: 'image',
      status: 'failed',
      label: 'Final image',
      outputUrl: null,
      errorMessage: 'The generation provider timed out.',
      failureCode: 'provider_unavailable',
      canRetry: true,
      estimatedRetryCredits: 8,
    };

    render(<TemplateRunStepCard step={step} availableCredits={20} onApprove={vi.fn()} onRetry={onRetry} />);

    expect(screen.getByText('No result was created')).toBeInTheDocument();
    expect(screen.getByText('The generation provider timed out.')).toBeInTheDocument();
    expect(screen.getByText(/Earlier completed steps are safe/)).toBeInTheDocument();
    expect(screen.getByText('8 credits')).toBeInTheDocument();
    expect(screen.getByText('20 credits')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry step · 8 credits' })).toBeInTheDocument();
  });

  it('explains configuration failures without blaming inputs or implying the failed attempt was charged', () => {
    const step: TemplateRunStep = {
      id: '34343434-3434-4434-8434-343434343434',
      kind: 'generation',
      mediaKind: 'image',
      status: 'failed',
      label: 'Final image',
      outputUrl: null,
      errorMessage: 'Generation setup is incomplete. No credits were charged for this attempt. Ask an administrator to finish the service setup before retrying.',
      failureCode: 'service_misconfigured',
      canRetry: true,
      estimatedRetryCredits: 8,
    };

    render(<TemplateRunStepCard step={step} availableCredits={20} onApprove={vi.fn()} onRetry={vi.fn()} />);

    expect(screen.getByText('Generation setup needs attention')).toBeInTheDocument();
    expect(screen.getByText(/No credits were charged for this attempt/)).toBeInTheDocument();
    expect(screen.getAllByText(/Ask an administrator to finish the service setup/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Retry after setup · 8 credits' })).toBeInTheDocument();
    expect(screen.queryByText('This generation did not finish')).not.toBeInTheDocument();
  });

  it('sends an underfunded retry to pricing instead of offering a charge that will fail', () => {
    const step: TemplateRunStep = {
      id: '44444444-4444-4444-8444-444444444444',
      kind: 'generation',
      mediaKind: 'image',
      status: 'failed',
      label: 'Final image',
      outputUrl: null,
      errorMessage: null,
      failureCode: null,
      canRetry: true,
      estimatedRetryCredits: 8,
    };

    render(<TemplateRunStepCard step={step} availableCredits={3} onApprove={vi.fn()} onRetry={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /Retry step/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add 5 credits to retry' })).toHaveAttribute('href', '/pricing');
  });

  it('does not offer retry on a terminal run and sends the creator back to the canvas', () => {
    const step: TemplateRunStep = {
      id: '77777777-7777-4777-8777-777777777777',
      kind: 'generation',
      mediaKind: 'image',
      status: 'failed',
      label: 'Final image',
      outputUrl: null,
      errorMessage: 'This generation step could not be started.',
      failureCode: null,
      canRetry: true,
      estimatedRetryCredits: 8,
    };

    render(
      <TemplateRunStepCard
        step={step}
        availableCredits={20}
        retryEnabled={false}
        restartHref="/create-workflow?template=template-1"
        restartLabel="Back to workflow canvas"
        onApprove={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: /Retry step/ })).not.toBeInTheDocument();
    expect(screen.getByText(/This run has ended/)).toBeInTheDocument();
    expect(screen.getByText('This step cannot be retried')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to workflow canvas' })).toHaveAttribute(
      'href',
      '/create-workflow?template=template-1'
    );
  });

  it('does not offer a paid retry when the input itself must be replaced', () => {
    const step: TemplateRunStep = {
      id: '66666666-6666-4666-8666-666666666666',
      kind: 'generation',
      mediaKind: 'image',
      status: 'failed',
      label: 'Final image',
      outputUrl: null,
      errorMessage: 'The request could not be completed.',
      failureCode: 'invalid_input_media',
      canRetry: true,
      estimatedRetryCredits: 8,
    };

    render(
      <TemplateRunStepCard
        step={step}
        availableCredits={20}
        restartHref="/create-workflow?template=template-1"
        restartLabel="Back to workflow canvas"
        onApprove={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: /Retry step/ })).not.toBeInTheDocument();
    expect(screen.getByText('Use a new input to continue')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to workflow canvas' })).toHaveAttribute(
      'href',
      '/create-workflow?template=template-1'
    );
  });

  it('renders progress from the run-provided step list', () => {
    render(
      <TemplateRunStepper
        status="processing"
        steps={[
          { id: 'step-1', kind: 'generation', mediaKind: 'image', status: 'succeeded', label: 'Portrait', outputUrl: '/one.jpg', errorMessage: null, failureCode: null, canRetry: false, estimatedRetryCredits: null },
          { id: 'step-2', kind: 'generation', mediaKind: 'video', status: 'processing', label: 'Animate', outputUrl: null, errorMessage: null, failureCode: null, canRetry: false, estimatedRetryCredits: null },
        ]}
      />
    );

    expect(screen.getByRole('progressbar', { name: 'Template progress' })).toHaveAttribute('aria-valuemax', '3');
    expect(screen.getByText('Current: Animate')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Template progress' })).toHaveAttribute(
      'aria-valuetext',
      '2 of 3 steps complete. Current step: Animate'
    );
  });

  it('turns technical action failures into actionable recovery copy', () => {
    expect(getTemplateRunErrorCopy('Insufficient credits: 8 required.')).toEqual({
      title: 'Not enough credits',
      body: expect.stringContaining('Your uploads and completed steps are still saved.'),
    });
    expect(getTemplateRunErrorCopy('Network request failed.')).toEqual({
      title: 'Connection interrupted',
      body: expect.stringContaining('Check your connection'),
    });
  });

  it('rejects unsupported, oversized, and undersized image inputs before upload', () => {
    const unsupported = new File(['image'], 'portrait.heic', { type: 'image/heic' });
    expect(validateTemplateInputFileMetadata(unsupported, 'image')).toBe('Choose a JPEG, PNG, or WebP image.');

    const oversized = new File(['image'], 'portrait.jpg', { type: 'image/jpeg' });
    Object.defineProperty(oversized, 'size', { value: 30 * 1024 * 1024 + 1 });
    expect(validateTemplateInputFileMetadata(oversized, 'image')).toBe('Choose an image up to 30 MB.');

    const oversizedVideo = new File(['video'], 'reference.mp4', { type: 'video/mp4' });
    Object.defineProperty(oversizedVideo, 'size', { value: 100 * 1024 * 1024 + 1 });
    expect(validateTemplateInputFileMetadata(oversizedVideo, 'video')).toBe('Choose a video up to 100 MB.');

    expect(getTemplateImageDimensionError(92, 92)).toContain('at least 256 × 256 px');
    expect(getTemplateImageDimensionError(256, 256)).toBeNull();
  });
});

describe('template web normalization', () => {
  it('prefers the graph-backed public manifest and strips private authoring fields', () => {
    const normalized = normalizeTemplate({
      template: {
        ...template,
        graph: { nodes: [{ id: 'private-node' }] },
        prompt: 'private prompt',
      },
    });

    expect(normalized).toMatchObject({ outputKind: 'video', estimatedTotalCredits: 14 });
    expect(normalized.inputSlots[0]).toMatchObject({ kind: 'image', required: true });
    expect(normalized).not.toHaveProperty('graph');
    expect(normalized).not.toHaveProperty('prompt');
  });

  it('normalizes public run steps and result without exposing graph node ids', () => {
    const normalized = normalizeTemplateRun({
      run: {
        id: 'run-1',
        templateId: 'template-1',
        status: 'awaiting_approval',
        inputSlots: template.inputSlots,
        steps: [{
          id: '22222222-2222-4222-8222-222222222222',
          graphNodeId: 'private-node-id',
          kind: 'approval',
          mediaKind: 'image',
          status: 'awaiting_approval',
          label: 'Review result',
          outputUrl: '/result.jpg',
          failureCode: 'invalid_input_media',
          canRetry: true,
          estimatedRetryCredits: 3,
        }],
        result: null,
        estimatedRemainingCredits: 8,
        creditsUsed: 4,
      },
    });

    expect(normalized.steps[0]).toEqual(expect.objectContaining({
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'approval',
      failureCode: 'invalid_input_media',
      estimatedRetryCredits: 3,
    }));
    expect(normalized.steps[0]).not.toHaveProperty('graphNodeId');
    expect(normalized.estimatedRemainingCredits).toBe(8);
  });

  it('preserves only the canonical final generation id needed for result actions', () => {
    const normalized = normalizeTemplateRun({
      run: {
        id: 'run-complete',
        templateId: 'template-1',
        status: 'succeeded',
        inputSlots: [],
        inputs: {},
        steps: [],
        result: {
          generationId: 'generation-final-1',
          kind: 'image',
          url: '/result.jpg',
          graphNodeId: 'private-output-node',
        },
      },
    });

    expect(normalized.result).toEqual({
      generationId: 'generation-final-1',
      kind: 'image',
      url: '/result.jpg',
    });
  });

  it('polls only active work and stops on attention or terminal states', () => {
    const makeRun = (status: 'processing' | 'needs_attention' | 'failed') => normalizeTemplateRun({
      run: {
        id: `run-${status}`,
        templateId: 'template-1',
        status,
        inputSlots: [],
        inputs: {},
        steps: [{
          id: '55555555-5555-4555-8555-555555555555',
          kind: 'generation',
          mediaKind: 'image',
          status: status === 'processing' ? 'processing' : 'failed',
          label: 'Final image',
        }],
        result: null,
      },
    });

    expect(shouldPollTemplateRun(makeRun('processing'))).toBe(true);
    expect(shouldPollTemplateRun(makeRun('needs_attention'))).toBe(false);
    expect(shouldPollTemplateRun(makeRun('failed'))).toBe(false);
  });
});

describe('template web run API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses generic start and public run-step UUID endpoints', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      run: { id: 'run-1', templateId: 'template-1', status: 'processing', inputSlots: [], inputs: {}, steps: [], result: null },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);

    await startTemplateRun('run-1', 'token-1', 'start-key');
    await retryTemplateRunStep({ runId: 'run-1', stepId: 'step-retry', token: 'token-1', idempotencyKey: 'retry-key' });
    await approveTemplateRunStep({ runId: 'run-1', stepId: 'step-approval', token: 'token-1', idempotencyKey: 'approve-key' });

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/template-runs/run-1/start',
      '/api/template-runs/run-1/steps/step-retry/retry',
      '/api/template-runs/run-1/approval-steps/step-approval/approve',
    ]);
    expect((fetcher.mock.calls[0][1]?.headers as Headers).get('Idempotency-Key')).toBe('start-key');
    expect((fetcher.mock.calls[2][1]?.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });
});
