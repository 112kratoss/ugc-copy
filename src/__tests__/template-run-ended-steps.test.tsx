import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TemplateApiError } from '@/components/templates/api';
import TemplateRunClient from '@/components/templates/TemplateRunClient';

// One object for every render: an effect that depends on a value the hook
// returns would otherwise run again on each one.
const auth = vi.hoisted(() => ({
  session: { access_token: 'session-token' },
  credits: 92,
  isLoading: false,
  refreshSessionState: vi.fn(),
}));
const getTemplateRunMock = vi.hoisted(() => vi.fn());
const getTemplateMock = vi.hoisted(() => vi.fn());
const actions = vi.hoisted(() => ({
  approveTemplateRunStep: vi.fn(),
  cancelTemplateRun: vi.fn(),
  retryTemplateRunStep: vi.fn(),
  requestConfirmation: vi.fn(),
}));

vi.mock('@/components/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('@/components/feedback-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/feedback-state')>()),
  requestConfirmation: actions.requestConfirmation,
}));
vi.mock('@/components/templates/api', async (importOriginal) => ({
  TemplateApiError: (await importOriginal<typeof import('@/components/templates/api')>()).TemplateApiError,
  approveTemplateRunStep: actions.approveTemplateRunStep,
  cancelTemplateRun: actions.cancelTemplateRun,
  createClientIdempotencyKey: vi.fn(() => 'idempotency-key'),
  finalizeTemplateInputs: vi.fn(),
  getTemplate: getTemplateMock,
  getTemplateRun: getTemplateRunMock,
  retryTemplateRunStep: actions.retryTemplateRunStep,
  signTemplateInput: vi.fn(),
  startTemplateRun: vi.fn(),
}));
vi.mock('@/components/templates/TemplateRunMedia', () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));

type StepOverrides = { status?: string; outputUrl?: string | null; errorMessage?: string | null; canRetry?: boolean };

function step(id: string, kind: 'generation' | 'approval', label: string, overrides: StepOverrides = {}) {
  return {
    id,
    kind,
    mediaKind: 'image',
    status: 'cancelled',
    label,
    outputUrl: null,
    errorMessage: null,
    failureCode: null,
    canRetry: false,
    estimatedRetryCredits: kind === 'approval' ? 0 : 8,
    ...overrides,
  };
}

type RunStatus = 'cancelled' | 'failed' | 'needs_attention' | 'awaiting_approval' | 'queued' | 'processing';

/**
 * A run that got one step done, lost the next to the provider, and never
 * reached the rest. `secondStep` changes the step that failed.
 */
function createRun(status: RunStatus, isTest = false, secondStep: StepOverrides = {}) {
  const reached = status === 'cancelled' || status === 'failed' ? 'cancelled' : 'queued';
  return {
    id: 'run-1',
    templateId: 'template-1',
    templateTitle: 'Rider transformation',
    userId: 'user-1',
    status,
    inputSlots: [],
    inputs: {},
    steps: [
      step('step-1', 'generation', 'Opening image', { status: 'succeeded', outputUrl: 'https://cdn.example.com/opening.jpg' }),
      step('step-2', 'generation', 'Final image', {
        status: 'failed',
        errorMessage: 'The generation provider timed out.',
        canRetry: true,
        ...secondStep,
      }),
      step('step-3', 'approval', 'Review final image', { status: reached }),
      step('step-4', 'generation', 'Final video', { status: reached }),
    ],
    result: null,
    estimatedTotalCredits: 24,
    estimatedRemainingCredits: 16,
    creditsUsed: 8,
    errorMessage: status === 'failed' ? 'This run stopped because of a problem on our side.' : null,
    isTest,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:01:00.000Z',
  };
}

async function renderRun(run: ReturnType<typeof createRun>) {
  getTemplateRunMock.mockResolvedValue(run);
  render(<TemplateRunClient runId="run-1" />);
  await screen.findByRole('heading', { name: 'Rider transformation' });
  return within(screen.getByRole('region', { name: /this run|step/i }));
}

beforeEach(() => {
  getTemplateRunMock.mockReset();
  actions.approveTemplateRunStep.mockReset();
  actions.cancelTemplateRun.mockReset();
  actions.retryTemplateRunStep.mockReset();
  actions.requestConfirmation.mockReset();
  auth.refreshSessionState.mockClear();
  getTemplateMock.mockResolvedValue({
    id: 'template-1',
    slug: 'rider-transformation',
    name: 'Rider transformation',
    description: null,
    category: 'Transformation',
    videoUrl: null,
    thumbnailUrl: null,
    creatorUserId: 'creator-1',
    creator: null,
    inputSlots: [],
    outputKind: 'video',
    status: 'active',
    useCount: 1,
    estimatedTotalCredits: 24,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
  });
});

describe('the run page of a template run that has ended', () => {
  it.each(['cancelled', 'failed'] as const)('describes the steps of a %s run and offers the new run once', async (status) => {
    const steps = await renderRun(createRun(status));

    expect(steps.getByRole('heading', { name: 'What happened in this run' })).toBeInTheDocument();
    expect(steps.getByText('Complete')).toBeInTheDocument();
    expect(steps.getByText('Failed')).toBeInTheDocument();
    expect(steps.getAllByText('Not finished')).toHaveLength(2);
    expect(steps.queryByText('Needs attention')).not.toBeInTheDocument();
    expect(steps.queryByText(/still saved/)).not.toBeInTheDocument();
    // No card offers anything to press: the run cannot be retried, approved or
    // restarted from one of its steps.
    expect(steps.queryByRole('button')).not.toBeInTheDocument();
    expect(steps.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Start again' })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'Start a new run' })).not.toBeInTheDocument();
    // The template arrives after the run, and its slug then replaces the id in the link.
    await waitFor(() => expect(screen.getByRole('link', { name: 'Start again' }))
      .toHaveAttribute('href', '/templates/rider-transformation/create'));
  });

  it('sends the creator of a test run back to the canvas from the page, not from each step', async () => {
    const steps = await renderRun(createRun('failed', true));

    expect(steps.getAllByText('Not finished')).toHaveLength(2);
    expect(steps.queryByRole('link')).not.toBeInTheDocument();
    // The header's back control and the closing panel.
    expect(screen.getAllByRole('link', { name: 'Back to workflow canvas' })).toHaveLength(2);
  });

  it('keeps the retry on the steps of a run that can still continue', async () => {
    const steps = await renderRun(createRun('needs_attention'));

    expect(steps.getByRole('heading', { name: 'Continue from the step that needs you' })).toBeInTheDocument();
    expect(steps.getByText('Needs attention')).toBeInTheDocument();
    expect(steps.queryByText('Not finished')).not.toBeInTheDocument();
    expect(steps.queryByText('Failed')).not.toBeInTheDocument();
    expect(steps.getByText('Your uploads and completed steps are still saved.')).toBeInTheDocument();
    expect(steps.getByRole('button', { name: 'Retry step · 8 credits' })).toBeInTheDocument();
  });

  it('offers the retry of a step whose retry never got going, and that retry sets the run going', async () => {
    // The retry wrote its attempt, but the write that sets the run going was lost.
    const stalled = createRun('needs_attention', false, { status: 'queued', errorMessage: null, canRetry: true });
    actions.retryTemplateRunStep.mockResolvedValue({ ...stalled, status: 'queued' });
    const steps = await renderRun(stalled);

    const card = within(steps.getByRole('heading', { name: 'Final image' }).closest('article')!);
    expect(card.getByText('Needs attention')).toBeInTheDocument();
    expect(card.getAllByText('This step did not start')).toHaveLength(2);
    expect(card.queryByText('Creating your result…')).not.toBeInTheDocument();
    // The steps after it wait on it, and offer nothing.
    expect(steps.getAllByRole('button', { name: 'Retry step · 8 credits' })).toHaveLength(1);

    fireEvent.click(card.getByRole('button', { name: 'Retry step · 8 credits' }));
    fireEvent.click(steps.getByRole('button', { name: 'Confirm retry' }));

    expect(await screen.findByText('Your run is queued.')).toBeInTheDocument();
    expect(actions.retryTemplateRunStep).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      stepId: 'step-2',
      token: 'session-token',
    }));
  });
});

describe('cancelling a run from its page', () => {
  it('asks first, says what the person keeps, and refreshes the balance after', async () => {
    actions.requestConfirmation.mockResolvedValue(true);
    actions.cancelTemplateRun.mockResolvedValue(createRun('cancelled'));
    await renderRun(createRun('needs_attention'));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));

    expect(await screen.findByRole('heading', { name: 'What happened in this run' })).toBeInTheDocument();
    expect(actions.requestConfirmation).toHaveBeenCalledWith({
      title: 'Cancel this run?',
      message: 'Finished steps stay in your library. A step that is already generating keeps its credits.',
      confirmLabel: 'Cancel run',
      cancelLabel: 'Keep creating',
      tone: 'danger',
    });
    expect(actions.cancelTemplateRun).toHaveBeenCalledWith('run-1', 'session-token');
    expect(auth.refreshSessionState).toHaveBeenCalledTimes(1);
  });

  it('leaves the run alone when the person keeps creating', async () => {
    actions.requestConfirmation.mockResolvedValue(false);
    await renderRun(createRun('needs_attention'));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));

    await waitFor(() => expect(actions.requestConfirmation).toHaveBeenCalledTimes(1));
    expect(actions.cancelTemplateRun).not.toHaveBeenCalled();
    expect(auth.refreshSessionState).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeEnabled();
  });
});

/** Both images are done and the checkpoint waits on the final one. */
function awaitingReview() {
  const run = createRun('awaiting_approval', false, {
    status: 'succeeded',
    errorMessage: null,
    canRetry: false,
    outputUrl: 'https://cdn.example.com/final.jpg',
  });
  run.steps[2] = step('step-3', 'approval', 'Review final image', {
    status: 'awaiting_approval',
    outputUrl: 'https://cdn.example.com/final.jpg',
    canRetry: true,
  });
  return run;
}

/** The same run once the review was approved somewhere else. */
function approvedElsewhere() {
  const run = awaitingReview();
  run.status = 'processing';
  run.steps[2] = { ...run.steps[2], status: 'succeeded' };
  run.steps[3] = { ...run.steps[3], status: 'processing' };
  return run;
}

describe('an action the server refuses', () => {
  it('reads the run again after an approval refused because the run ended, and says only that', async () => {
    getTemplateRunMock.mockResolvedValueOnce(awaitingReview()).mockResolvedValueOnce(createRun('cancelled'));
    actions.approveTemplateRunStep.mockRejectedValue(
      new TemplateApiError('This run has ended. Start a new run to try the template again.', 409, 'RUN_TERMINAL'),
    );
    render(<TemplateRunClient runId="run-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Approve & continue' }));

    expect(await screen.findByRole('heading', { name: 'What happened in this run' })).toBeInTheDocument();
    expect(screen.getByText('This run has ended. Start a new run to try the template again.')).toBeInTheDocument();
    expect(screen.queryByText(/Your saved inputs/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve & continue' })).not.toBeInTheDocument();
    expect(getTemplateRunMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['APPROVAL_NOT_READY', 409, 'This checkpoint is not waiting for approval.', 'This step was already handled. The run has been refreshed.'],
    ['STALE_STEP_ATTEMPT', 409, 'This checkpoint was already handled.', 'This step was already handled. The run has been refreshed.'],
    ['STEP_NOT_FOUND', 404, 'Template run step not found.', 'That step is no longer part of this run.'],
  ] as const)('reads the run again after a %s refusal and says where the step stands', async (code, status, message, copy) => {
    getTemplateRunMock.mockResolvedValueOnce(awaitingReview()).mockResolvedValueOnce(approvedElsewhere());
    actions.approveTemplateRunStep.mockRejectedValue(new TemplateApiError(message, status, code));
    render(<TemplateRunClient runId="run-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Approve & continue' }));

    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(await screen.findByText('Your workflow is running.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve & continue' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Your saved inputs/)).not.toBeInTheDocument();
    expect(getTemplateRunMock).toHaveBeenCalledTimes(2);
  });
});

describe('a run the page could not read', () => {
  it('offers Retry, and shows the run once it can be read', async () => {
    getTemplateRunMock
      .mockRejectedValueOnce(new TemplateApiError('The request could not be completed.', 503, null))
      .mockResolvedValueOnce(createRun('failed'));
    render(<TemplateRunClient runId="run-1" />);

    expect(await screen.findByText('Run unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'Rider transformation' })).toBeInTheDocument();
    expect(screen.queryByText('Run unavailable')).not.toBeInTheDocument();
    expect(getTemplateRunMock).toHaveBeenCalledTimes(2);
  });

  it('offers no Retry for a run that is not there', async () => {
    getTemplateRunMock.mockRejectedValue(new TemplateApiError('Template run not found.', 404, 'RUN_NOT_FOUND'));
    render(<TemplateRunClient runId="run-1" />);

    expect(await screen.findByText('Template run not found.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to templates' })).toHaveAttribute('href', '/templates');
  });
});
