import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PostResourceBundlePanel from '@/app/showcase/[id]/PostResourceBundlePanel';
import type { PostResourceBundleLockedPreview, PostResourceKind } from '@/lib/post-resource-bundles';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: null,
  }),
}));

const promptOnlyPreview: PostResourceBundleLockedPreview = {
  resourceKinds: ['prompt'],
  attachmentPreviews: [],
  hasPrompt: true,
  hasNotes: false,
  hasWorkflow: false,
  hasRemix: false,
  updatedAt: '2026-04-25T10:00:00.000Z',
};

function renderPanel(overrides: Partial<Parameters<typeof PostResourceBundlePanel>[0]> = {}) {
  const resourceKinds: PostResourceKind[] = ['prompt'];

  return render(
    <PostResourceBundlePanel
      postId="post-1"
      title="Prompt unlock"
      summary="Unlock the prompt attached to this post."
      previewText=""
      priceLabel="$0.00"
      priceNote={null}
      isFree
      viewerCanAccess={false}
      viewerIsOwner={false}
      resourceKinds={resourceKinds}
      lockedPreview={promptOnlyPreview}
      salesCount={0}
      initialResources={null}
      {...overrides}
    />
  );
}

describe('PostResourceBundlePanel', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('keeps locked prompt-only unlocks compact with one open action', () => {
    renderPanel();

    expect(screen.getAllByRole('button', { name: /open free unlock/i })).toHaveLength(1);
    expect(screen.getByText(/the prompt text stays locked until this unlock is opened/i)).toBeInTheDocument();
    expect(screen.queryByText(/labels and file types can be shown publicly/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/secret prompt/i)).not.toBeInTheDocument();
  });

  it('shows owner prompt access with buyer-facing context', () => {
    renderPanel({
      viewerIsOwner: true,
      initialResources: {
        promptText: 'secret prompt',
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
      },
    });

    expect(screen.getByText('secret prompt')).toBeInTheDocument();
    expect(screen.getByText(/owner preview\. buyers must unlock before seeing this/i)).toBeInTheDocument();
  });

  it('shows buyer trust terms without exposing locked content', () => {
    renderPanel({
      isFree: false,
      priceLabel: '₹189',
      priceNote: 'Charged in INR for buyers in India.',
    });

    expect(screen.getByText(/secure razorpay checkout with instant access after payment/i)).toBeInTheDocument();
    expect(screen.getByText(/digital unlocks are final sale/i)).toBeInTheDocument();
    expect(screen.getByText(/do not resell, redistribute, or claim the raw bundle as your own/i)).toBeInTheDocument();
    expect(screen.queryByText(/secret prompt/i)).not.toBeInTheDocument();
  });
});
