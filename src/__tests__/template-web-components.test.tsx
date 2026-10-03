import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  approveTemplateRunStep,
  normalizeTemplate,
  normalizeTemplateRun,
  retryTemplateRunStep,
  startTemplateRun,
} from '@/components/templates/api';
import {
  getTemplateImageDimensionError,
  getTemplateRunErrorCopy,
  validateTemplateInputFileMetadata,
} from '@/components/templates/TemplateRunClient';
import {
  TemplateCard,
  TemplateRunStepCard,
  TemplateRunStepper,
  TemplateSlotUpload,
} from '@/components/templates/TemplatePrimitives';
import { isStepCutShort, shouldPollTemplateRun, type MediaTemplate, type TemplateRunStep } from '@/components/templates/types';

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

    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('No result was created')).toBeInTheDocument();
    // True while the run can continue: its uploads are deleted when it ends.
    expect(screen.getByText('Your uploads and completed steps are still saved.')).toBeInTheDocument();
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

  it('keeps the restart on a step that cannot be retried while the run can continue', () => {
    const step: TemplateRunStep = {
      id: '78787878-7878-4878-8878-787878787878',
      kind: 'generation',
      mediaKind: 'image',
      status: 'failed',
      label: 'Final image',
      outputUrl: null,
      errorMessage: 'This template was published against a model catalog that is no longer available.',
      failureCode: 'provider_rejected',
      canRetry: false,
      estimatedRetryCredits: 8,
    };

    render(
      <TemplateRunStepCard
        step={step}
        availableCredits={20}
        runStatus="needs_attention"
        restartHref="/create-workflow?template=template-1"
        restartLabel="Back to workflow canvas"
        onApprove={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry step/ })).not.toBeInTheDocument();
    expect(screen.getByText('This step cannot be retried')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to workflow canvas' })).toHaveAttribute(
      'href',
      '/create-workflow?template=template-1'
    );
  });

  describe('a step of a run that has ended', () => {
    const endedStep = (overrides: Partial<TemplateRunStep> = {}): TemplateRunStep => ({
      id: '77777777-7777-4777-8777-777777777777',
      kind: 'generation',
      mediaKind: 'image',
      status: 'cancelled',
      label: 'Final image',
      outputUrl: null,
      errorMessage: null,
      failureCode: null,
      canRetry: false,
      estimatedRetryCredits: 8,
      ...overrides,
    });
    // The page hands every card the way to a new run, whether the run has ended or not.
    const renderCard = (step: TemplateRunStep, runStatus: 'cancelled' | 'failed') => render(
      <TemplateRunStepCard
        step={step}
        availableCredits={20}
        runStatus={runStatus}
        restartHref="/templates/rider-transformation/create"
        onApprove={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    const expectNothingToActOn = () => {
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
      expect(screen.queryByText(/still saved/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Retry this step/)).not.toBeInTheDocument();
      expect(screen.queryByText('This step cannot be retried')).not.toBeInTheDocument();
      expect(screen.getByText(/This run has ended/)).toBeInTheDocument();
    };

    it('says a step the person cancelled before it ran was not finished, and raises no alert', () => {
      renderCard(endedStep(), 'cancelled');

      expect(screen.getByText('Not finished')).toBeInTheDocument();
      expect(screen.getByText('No result was created')).toBeInTheDocument();
      expect(screen.getByText('This generation did not finish')).toBeInTheDocument();
      expect(screen.getByText('The run was cancelled before this step finished.')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expectNothingToActOn();
    });

    it('keeps the note of a step we stopped, and says the run stopped when there is none', () => {
      const note = 'This step was still generating when the run stopped, so its credits stay spent.';
      const { unmount } = renderCard(endedStep({ errorMessage: note }), 'failed');

      expect(screen.getByText('Not finished')).toBeInTheDocument();
      expect(screen.getByText('This generation did not finish')).toBeInTheDocument();
      expect(screen.getByText(note)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expectNothingToActOn();
      unmount();

      // A step the server did not get to cancel keeps the status it had.
      renderCard(endedStep({ status: 'queued' }), 'failed');
      expect(screen.getByText('Not finished')).toBeInTheDocument();
      expect(screen.getByText('The run stopped before this step finished.')).toBeInTheDocument();
      expectNothingToActOn();
    });

    it('does not call a review step a generation', () => {
      const review = endedStep({ kind: 'approval', label: 'Review portrait' });
      const { container, unmount } = renderCard(review, 'cancelled');

      expect(screen.getByText('Not finished')).toBeInTheDocument();
      expect(screen.getByText('Nothing to review')).toBeInTheDocument();
      expect(screen.getByText('This review was not completed')).toBeInTheDocument();
      expect(screen.queryByText('No result was created')).not.toBeInTheDocument();
      expect(container).not.toHaveTextContent(/generation/i);
      expectNothingToActOn();
      unmount();

      // The picture that was waiting for the person's review is still shown.
      renderCard({ ...review, status: 'awaiting_approval', outputUrl: 'https://cdn.example.com/portrait.jpg', canRetry: true }, 'cancelled');
      expect(screen.getByRole('img', { name: 'Review portrait' })).toHaveAttribute('src', 'https://cdn.example.com/portrait.jpg');
      expect(screen.getByText('Not finished')).toBeInTheDocument();
      expect(screen.getByText('This review was not completed')).toBeInTheDocument();
      expect(screen.queryByText('Nothing to review')).not.toBeInTheDocument();
      expectNothingToActOn();
    });

    it('says a step that had failed by itself failed, with its own message as an alert', () => {
      const failed = endedStep({
        status: 'failed',
        errorMessage: 'This generation step could not be started.',
        failureCode: 'provider_unavailable',
        canRetry: true,
      });
      const { unmount } = renderCard(failed, 'cancelled');

      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.queryByText('Not finished')).not.toBeInTheDocument();
      expect(screen.getByText('No result was created')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('This generation did not finish');
      expect(screen.getByRole('alert')).toHaveTextContent('This generation step could not be started.');
      expectNothingToActOn();
      unmount();

      // With no message of its own it still does not suggest a retry.
      const withoutMessage = renderCard({ ...failed, errorMessage: null }, 'failed');
      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('The generation service did not return a usable result.');
      expectNothingToActOn();
      withoutMessage.unmount();

      // A review step that failed is not called a generation either.
      const { container } = renderCard({
        ...failed,
        kind: 'approval',
        label: 'Review portrait',
        errorMessage: 'This step is missing a required workflow input.',
      }, 'failed');
      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.getByText('Nothing to review')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('This review was not completed');
      expect(container).not.toHaveTextContent(/generation/i);
      expectNothingToActOn();
    });

    it('leaves the restart of an upload that must be replaced to the page', () => {
      renderCard(endedStep({
        status: 'failed',
        errorMessage: 'The generation model could not read one of the uploads. Start a new run with a clear JPEG, PNG, or WebP image at least 256×256 px.',
        failureCode: 'invalid_input_media',
        canRetry: true,
      }), 'failed');

      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('could not read one of the uploads');
      expect(screen.queryByText('Use a new input to continue')).not.toBeInTheDocument();
      expectNothingToActOn();
    });
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

  it('draws the progress of a run that has ended without a current step, and only a failure in red', () => {
    const step = (id: string, status: string, label: string): TemplateRunStep => ({
      id, kind: 'generation', mediaKind: 'image', status, label, outputUrl: null, errorMessage: null, failureCode: null, canRetry: false, estimatedRetryCredits: null,
    });
    const steps = [
      step('step-1', 'succeeded', 'Portrait'),
      step('step-2', 'failed', 'Scene'),
      step('step-3', 'cancelled', 'Animate'),
      // A step the server did not get to cancel.
      step('step-4', 'queued', 'Final cut'),
    ];
    const { unmount } = render(<TemplateRunStepper status="cancelled" steps={steps} />);

    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Template progress' })).toHaveAttribute('aria-valuetext', '2 of 5 steps complete');
    expect(screen.getByTitle('Portrait')).toHaveClass('bg-emerald-400');
    expect(screen.getByTitle('Scene')).toHaveClass('bg-rose-400');
    for (const label of ['Animate', 'Final cut']) {
      expect(screen.getByTitle(label), label).toHaveClass('bg-white/10');
      expect(screen.getByTitle(label), label).not.toHaveClass('bg-rose-400');
      expect(screen.getByTitle(label), label).not.toHaveClass('bg-sky-400');
    }
    unmount();

    // While the run can continue, the same failure is where it stands.
    render(<TemplateRunStepper status="needs_attention" steps={steps} />);
    expect(screen.getByText('Current: Scene')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Template progress' })).toHaveAttribute(
      'aria-valuetext',
      '2 of 5 steps complete. Current step: Scene'
    );
    expect(screen.getByTitle('Scene')).toHaveClass('bg-rose-400');
    expect(screen.getByTitle('Final cut')).toHaveClass('bg-sky-400');
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

  it('counts a step as cut short only when its run has ended and it neither finished nor failed', () => {
    const step = (status: string): TemplateRunStep => ({
      id: '56565656-5656-4565-8565-565656565656',
      kind: 'generation',
      mediaKind: 'image',
      status,
      label: 'Final image',
      outputUrl: null,
      errorMessage: null,
      failureCode: null,
      canRetry: false,
      estimatedRetryCredits: null,
    });

    for (const runStatus of ['cancelled', 'failed'] as const) {
      // `cancelled` is what the server stores; the rest are steps it did not get to.
      for (const status of ['cancelled', 'queued', 'processing', 'awaiting_approval']) {
        expect(isStepCutShort(runStatus, step(status)), `${status} step of a ${runStatus} run`).toBe(true);
      }
      for (const status of ['failed', 'error', 'succeeded', 'approved']) {
        expect(isStepCutShort(runStatus, step(status)), `${status} step of a ${runStatus} run`).toBe(false);
      }
    }
    for (const runStatus of ['queued', 'processing', 'awaiting_approval', 'needs_attention', undefined] as const) {
      expect(isStepCutShort(runStatus, step('cancelled')), `cancelled step of a ${runStatus} run`).toBe(false);
      expect(isStepCutShort(runStatus, step('queued')), `queued step of a ${runStatus} run`).toBe(false);
    }
  });
});

describe('template web run API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses generic start and public run-step UUID endpoints', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
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
