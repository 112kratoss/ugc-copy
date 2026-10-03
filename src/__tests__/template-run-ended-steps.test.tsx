import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TemplateRunClient from '@/components/templates/TemplateRunClient';

// One object for every render: an effect that depends on a value the hook
// returns would otherwise run again on each one.
const auth = vi.hoisted(() => ({
  session: { access_token: 'session-token' },
  credits: 92,
  isLoading: false,
  refreshSessionState: vi.fn(),
}));
const searchParams = vi.hoisted(() => new URLSearchParams());
const getTemplateRunMock = vi.hoisted(() => vi.fn());
const getTemplateMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ useSearchParams: () => searchParams }));
vi.mock('@/components/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('@/components/templates/api', () => ({
  approveTemplateRunStep: vi.fn(),
  cancelTemplateRun: vi.fn(),
  createClientIdempotencyKey: vi.fn(() => 'idempotency-key'),
  finalizeTemplateInputs: vi.fn(),
  getTemplate: getTemplateMock,
  getTemplateRun: getTemplateRunMock,
  retryTemplateRunStep: vi.fn(),
  signTemplateInput: vi.fn(),
  startTemplateRun: vi.fn(),
}));
vi.mock('@/components/PublishToShowcaseModal', () => ({ default: () => null }));
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

/** A run that got one step done, lost the next to the provider, and never reached the rest. */
function createRun(status: 'cancelled' | 'failed' | 'needs_attention', isTest = false) {
  const reached = status === 'needs_attention' ? 'queued' : 'cancelled';
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
      step('step-2', 'generation', 'Final image', { status: 'failed', errorMessage: 'The generation provider timed out.', canRetry: true }),
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

describe('the run page of a template run that has ended', () => {
  beforeEach(() => {
    getTemplateRunMock.mockReset();
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
});
