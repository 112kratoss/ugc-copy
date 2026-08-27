// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UnlockRemixPrompt } from '../components/unlock-remix-prompt';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

const hapticsState = vi.hoisted(() => ({
  selectionAsync: vi.fn(),
}));

const routerState = vi.hoisted(() => ({
  push: vi.fn(),
}));

const authState = vi.hoisted(() => ({
  user: { id: 'user-123', email: 'creator@example.com' } as { id: string; email: string } | null,
  api: {
    unlockFreeBundle: vi.fn(),
    unlockBundleWithCredits: vi.fn(),
  },
}));

vi.mock('expo-haptics', () => hapticsState);

vi.mock('expo-router', () => ({
  router: routerState,
}));

vi.mock('lucide-react-native', () => ({
  ArrowLeft: (props: MockProps) => React.createElement('icon', props),
  ChevronLeft: (props: MockProps) => React.createElement('icon', props),
  Share: (props: MockProps) => React.createElement('icon', props),
  Share2: (props: MockProps) => React.createElement('icon', props),
  FileText: (props: MockProps) => React.createElement('icon', props),
  Lock: (props: MockProps) => React.createElement('icon', props),
  X: (props: MockProps) => React.createElement('icon', props),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Modal: ({ children, ...props }: MockProps) => React.createElement('modal', props, children),
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', {
      ...props,
      style: resolvePressableStyle(style),
    }, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

function lockedRemixItem(overrides: Partial<ImmersivePreviewItem> = {}): ImmersivePreviewItem {
  return {
    id: 'post-123',
    source: 'showcase-feed',
    sourceType: 'showcase',
    title: 'Paid remix post',
    displayText: 'Unlock this remix kit.',
    mediaUrl: null,
    mediaKind: null,
    mediaItems: [],
    creatorLabel: '@batman',
    creatorAvatar: null,
    badge: '$9',
    saveLabel: '0',
    commentLabel: '0',
    commentCount: 0,
    canComment: false,
    saveCount: 0,
    isSaved: false,
    canSave: true,
    canShare: true,
    sharePath: '/showcase/post-123',
    recreateTool: 'image',
    recreatePrompt: 'make a launch post',
    showcasePostId: 'post-123',
    generationId: 'gen-123',
    ownerPostId: null,
    linkedPostId: null,
    linkedPostTitle: null,
    linkedPostVisibility: null,
    archivedAt: null,
    visibility: 'public',
    availableActions: ['unlock-remix'],
    disabledActions: {},
    details: {
      title: 'Paid remix post',
      prompt: 'make a launch post',
      body: 'Unlock this remix kit.',
      categoryLabel: 'Image',
      sourceLabel: 'Feed',
      creatorLabel: '@batman',
      creatorAvatar: null,
      saveCount: 0,
      remixCount: 0,
      unlock: {
        postId: 'post-123',
        resourceId: 'asset-123',
        title: 'Paid remix kit',
        accessMode: 'paid',
        priceLabel: '$9',
        previewText: 'Reusable prompt and remix access.',
        allowRemix: true,
        resourceKinds: ['prompt', 'remix'],
      },
    },
    ...overrides,
  };
}

function findPressableByAccessibilityLabel(root: renderer.ReactTestInstance, accessibilityLabel: string) {
  const pressable = root.findAll(
    (node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === accessibilityLabel
  )[0];
  if (!pressable) {
    throw new Error(`No pressable with accessibility label "${accessibilityLabel}" was found`);
  }
  return pressable;
}

function renderPrompt(props: Partial<React.ComponentProps<typeof UnlockRemixPrompt>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const onClose = vi.fn();
  const onUnlocked = vi.fn();
  let tree: renderer.ReactTestRenderer | undefined;

  renderer.act(() => {
    tree = renderer.create(
      <QueryClientProvider client={queryClient}>
        <UnlockRemixPrompt
          bottomInset={0}
          item={lockedRemixItem()}
          onClose={onClose}
          onUnlocked={onUnlocked}
          visible
          {...props}
        />
      </QueryClientProvider>
    );
  });

  return { invalidateSpy, onClose, onUnlocked, tree: tree! };
}

describe('UnlockRemixPrompt', () => {
  beforeEach(() => {
    authState.user = { id: 'user-123', email: 'creator@example.com' };
    authState.api.unlockFreeBundle.mockReset();
    authState.api.unlockBundleWithCredits.mockReset();
    hapticsState.selectionAsync.mockReset();
    routerState.push.mockReset();
  });

  it('unlocks a paid resource and continues into remix', async () => {
    authState.api.unlockBundleWithCredits.mockResolvedValue({ success: true });
    hapticsState.selectionAsync.mockResolvedValue(undefined);
    const { invalidateSpy, onClose, onUnlocked, tree } = renderPrompt();

    await renderer.act(async () => {
      findPressableByAccessibilityLabel(tree.root, 'Unlock to remix').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(authState.api.unlockBundleWithCredits).toHaveBeenCalledWith('post-123');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['post-resource-bundle', 'post-123', 'asset-123'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['marketplace-resource', 'asset-123'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['marketplace-resources'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['showcase-feed'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['immersive-preview-source'] });
    expect(hapticsState.selectionAsync).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onUnlocked).toHaveBeenCalledWith(expect.objectContaining({ id: 'post-123' }));
  });

  it('sends signed-out users to auth and brings them back to where they were', () => {
    authState.user = null;
    const returnTo = '/viewer?source=showcase-feed&initialId=post-123';
    const { onClose, onUnlocked, tree } = renderPrompt({ authReturnTo: returnTo });

    renderer.act(() => {
      findPressableByAccessibilityLabel(tree.root, 'Sign in to unlock').props.onPress();
    });

    // Without the return path, signing in drops them at the tab root and the
    // unlock they came for is gone.
    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo } });
    expect(onClose).toHaveBeenCalled();
    expect(onUnlocked).not.toHaveBeenCalled();
  });
});
