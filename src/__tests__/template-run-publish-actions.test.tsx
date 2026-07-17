import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TemplateRunClient from '@/app/components/templates/TemplateRunClient';

const testState = vi.hoisted(() => ({
  isTest: false,
}));

const getTemplateRunMock = vi.hoisted(() => vi.fn());
const getTemplateMock = vi.hoisted(() => vi.fn());
const publishModalMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: { access_token: 'session-token' },
    credits: 92,
    isLoading: false,
    refreshSessionState: vi.fn(),
  }),
}));

vi.mock('@/app/components/templates/api', () => ({
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

vi.mock('@/app/components/PublishToShowcaseModal', () => ({
  default: (props: {
    isOpen: boolean;
    generationId: string | null;
    mediaOnly?: boolean;
    showPaidShortcut?: boolean;
    onPublished?: (payload: {
      visibility: 'public';
      postId: string;
      showcasePath: string;
      ownerPath: string;
    }) => void;
  }) => {
    publishModalMock(props);
    return props.isOpen ? (
      <button
        type="button"
        onClick={() => props.onPublished?.({
          visibility: 'public',
          postId: 'post-template-1',
          showcasePath: '/showcase/post-template-1',
          ownerPath: '/post/post-template-1/edit',
        })}
      >
        Confirm template publish
      </button>
    ) : null;
  },
}));

function createRun() {
  return {
    id: 'run-1',
    templateId: 'template-1',
    templateTitle: 'Rider transformation',
    userId: 'user-1',
    status: 'succeeded',
    inputSlots: [],
    inputs: {},
    steps: [],
    result: {
      kind: 'image',
      url: 'https://cdn.example.com/result.jpg',
      generationId: 'template-result-1',
    },
    estimatedTotalCredits: 8,
    estimatedRemainingCredits: 0,
    creditsUsed: 8,
    errorMessage: null,
    isTest: testState.isTest,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:01:00.000Z',
  };
}

describe('template run publish actions', () => {
  beforeEach(() => {
    testState.isTest = false;
    publishModalMock.mockClear();
    getTemplateRunMock.mockImplementation(async () => createRun());
    getTemplateMock.mockResolvedValue({
      id: 'template-1',
      slug: 'rider-transformation',
      name: 'Rider transformation',
      description: 'Create a cinematic transformation.',
      category: 'Transformation',
      videoUrl: null,
      thumbnailUrl: null,
      creatorUserId: 'creator-1',
      creator: null,
      inputSlots: [],
      outputKind: 'image',
      status: 'active',
      useCount: 1,
      estimatedTotalCredits: 8,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    });
  });

  it('makes Showcase publishing primary and keeps a stable post link after success', async () => {
    const share = vi.fn(async () => undefined);
    const originalShare = navigator.share;
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    render(<TemplateRunClient runId="run-1" />);

    const publishButton = await screen.findByRole('button', { name: 'Publish to Showcase' });
    fireEvent.click(publishButton);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm template publish' }));

    expect(await screen.findByText('Published to Showcase')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View in Showcase' })).toHaveAttribute(
      'href',
      '/showcase/post-template-1',
    );
    expect(screen.queryByRole('button', { name: 'Publish to Showcase' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Share Showcase post' }));
    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({
      url: new URL('/showcase/post-template-1', window.location.origin).toString(),
    })));
    expect(publishModalMock).toHaveBeenCalledWith(expect.objectContaining({
      generationId: 'template-result-1',
      mediaOnly: true,
      showPaidShortcut: false,
    }));
    Object.defineProperty(navigator, 'share', { configurable: true, value: originalShare });
  });

  it('keeps creator test results canvas-only', async () => {
    testState.isTest = true;
    render(<TemplateRunClient runId="test-run-1" />);

    expect((await screen.findAllByRole('link', { name: 'Back to workflow canvas' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Publish to Showcase' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(publishModalMock).not.toHaveBeenCalledWith(expect.objectContaining({ isOpen: true }));
    });
  });
});
