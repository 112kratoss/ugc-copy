// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UnlockRemixPrompt } from '../components/unlock-remix-prompt';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import { readRecipeUnlockedNotice } from '../lib/recipe-unlocked-notice';

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
  credits: 5000 as number | null,
  marketplaceSpendableCredits: 5000 as number | null,
  updateCredits: vi.fn(),
}));

const dialogState = vi.hoisted(() => ({ showConfirmDialog: vi.fn() }));

const PROMOTIONAL_SHORTFALL = "You need 900 more credits. Welcome and referral credits can't be spent on recipes.";

/** What the auth context does with a balance it is handed (`updateCredits` in lib/auth.tsx). */
function applyCredits(credits: number | null, options?: { marketplaceSpendableCredits?: number | null }) {
  authState.credits = credits;
  if (options?.marketplaceSpendableCredits !== undefined) {
    authState.marketplaceSpendableCredits = options.marketplaceSpendableCredits;
  }
}

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
  // lib/haptics.ts reads Platform to pick the Android route; without it the
  // strict mock throws, fire() swallows that, and the haptic below never fires.
  Platform: { OS: 'ios' },
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

// The sheet is an RN Modal, so it asks through the dialog, which draws above it.
vi.mock('@/lib/dialog', () => dialogState);

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
    badge: '900 credits',
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
    resource: {
      resourceId: 'asset-123',
      postId: 'post-123',
      title: 'Paid remix kit',
      accessMode: 'paid',
      priceUsdCents: 900,
      previewText: 'Reusable prompt and remix access.',
      allowRemix: true,
      resourceKinds: ['prompt', 'remix'],
    },
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
        priceLabel: '900 credits',
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

async function flush() {
  await renderer.act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('UnlockRemixPrompt', () => {
  beforeEach(() => {
    authState.user = { id: 'user-123', email: 'creator@example.com' };
    authState.credits = 5000;
    authState.marketplaceSpendableCredits = 5000;
    authState.updateCredits.mockReset();
    authState.updateCredits.mockImplementation(applyCredits);
    authState.api.unlockFreeBundle.mockReset();
    authState.api.unlockBundleWithCredits.mockReset();
    dialogState.showConfirmDialog.mockReset();
    hapticsState.selectionAsync.mockReset();
    routerState.push.mockReset();
  });

  it('asks before spending, then unlocks the paid resource and continues into remix', async () => {
    authState.api.unlockBundleWithCredits.mockResolvedValue({ success: true, entitlement: 'post_resource_unlock', credits: 4100 });
    dialogState.showConfirmDialog.mockResolvedValue(true);
    hapticsState.selectionAsync.mockResolvedValue(undefined);
    const { invalidateSpy, onClose, onUnlocked, tree } = renderPrompt();

    renderer.act(() => {
      // The button says how many credits the confirmed spend takes.
      findPressableByAccessibilityLabel(tree.root, 'Unlock for 900 credits').props.onPress();
    });
    await flush();

    expect(dialogState.showConfirmDialog).toHaveBeenCalledWith({
      title: 'Unlock this recipe?',
      message: '900 credits will come off your balance.',
      confirmLabel: 'Unlock for 900 credits',
    });
    // With the price the buyer confirmed (S3).
    expect(authState.api.unlockBundleWithCredits).toHaveBeenCalledWith('post-123', 900);
    expect(authState.updateCredits).toHaveBeenCalledWith(4100);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['post-resource-bundle', 'post-123', 'asset-123'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['marketplace-resource', 'asset-123'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['viewer-unlocks'] });
    // Patched in place rather than refetched under the buyer.
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['showcase-feed'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['immersive-preview-source'] });
    expect(hapticsState.selectionAsync).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onUnlocked).toHaveBeenCalledWith(expect.objectContaining({ id: 'post-123' }));
  });

  it('spends nothing when the confirmation is declined', async () => {
    dialogState.showConfirmDialog.mockResolvedValue(false);
    const { onClose, onUnlocked, tree } = renderPrompt();

    renderer.act(() => {
      findPressableByAccessibilityLabel(tree.root, 'Unlock for 900 credits').props.onPress();
    });
    await flush();

    expect(authState.api.unlockBundleWithCredits).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('holds the spend and offers credits when the balance is short', () => {
    authState.credits = 100;
    authState.marketplaceSpendableCredits = 100;
    const { onClose, tree } = renderPrompt();

    const cta = findPressableByAccessibilityLabel(tree.root, 'Unlock for 900 credits');
    expect(cta.props.disabled).toBe(true);
    const texts = tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);
    expect(texts).toContain('You need 800 more credits.');

    renderer.act(() => {
      findPressableByAccessibilityLabel(tree.root, 'Get credits').props.onPress();
    });
    // The sheet steps aside first: it is a Modal over the screen pricing opens on.
    expect(onClose).toHaveBeenCalled();
    expect(routerState.push).toHaveBeenCalledWith('/pricing');
  });

  it('says why a total that covers the price cannot buy it', () => {
    // 1,200 credits, every one of them welcome or referral credits.
    authState.credits = 1200;
    authState.marketplaceSpendableCredits = 0;
    const { tree } = renderPrompt();

    expect(findPressableByAccessibilityLabel(tree.root, 'Unlock for 900 credits').props.disabled).toBe(true);
    const texts = tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);
    expect(texts).toContain(PROMOTIONAL_SHORTFALL);
    expect(findPressableByAccessibilityLabel(tree.root, 'Get credits')).toBeDefined();
  });

  it("says the server's shortfall when it refuses a post whose price the feed did not carry", async () => {
    // The sheet held 1,200 as spendable and no price, so it asked.
    authState.credits = 1200;
    authState.marketplaceSpendableCredits = 1200;
    dialogState.showConfirmDialog.mockResolvedValue(true);
    const refusal = 'Insufficient credits. This unlock costs 900 credits.';
    authState.api.unlockBundleWithCredits.mockRejectedValue(Object.assign(new Error(refusal), {
      status: 402,
      code: 'INSUFFICIENT_CREDITS',
      details: { error: refusal, code: 'INSUFFICIENT_CREDITS', creditCost: 900, remainingCredits: 1200, marketplaceSpendableCredits: 0 },
    }));
    const { onUnlocked, tree } = renderPrompt({ item: lockedRemixItem({ resource: undefined }) });

    renderer.act(() => {
      findPressableByAccessibilityLabel(tree.root, 'Unlock for 900 credits').props.onPress();
    });
    await flush();

    expect(authState.updateCredits).toHaveBeenCalledWith(1200, { marketplaceSpendableCredits: 0 });
    const texts = tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);
    expect(texts).toContain(PROMOTIONAL_SHORTFALL);
    expect(texts).not.toContain(refusal);
    expect(findPressableByAccessibilityLabel(tree.root, 'Unlock for 900 credits').props.disabled).toBe(true);
    expect(findPressableByAccessibilityLabel(tree.root, 'Get credits')).toBeDefined();
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('takes a free unlock without asking', async () => {
    authState.api.unlockFreeBundle.mockResolvedValue({ success: true, free: true, alreadyProcessed: false });
    const details = lockedRemixItem().details!;
    const { onUnlocked, tree } = renderPrompt({
      item: lockedRemixItem({ details: { ...details, unlock: { ...details.unlock!, accessMode: 'free', priceLabel: 'Free' } } }),
    });

    renderer.act(() => {
      findPressableByAccessibilityLabel(tree.root, 'Get free recipe').props.onPress();
    });
    await flush();

    expect(dialogState.showConfirmDialog).not.toHaveBeenCalled();
    expect(authState.api.unlockFreeBundle).toHaveBeenCalledWith('post-123');
    expect(onUnlocked).toHaveBeenCalled();
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

  // Recipe audit B-F10 / B-F20: the sheet spoke of "resources", and paying here
  // went on to the editor with nothing said about what else was bought.
  it('asks for the recipe in the glossary words', () => {
    const { tree } = renderPrompt();
    const texts = tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);

    expect(texts).toContain('Unlock the recipe to remix');
    expect(texts.some((text) => typeof text === 'string' && /resource/i.test(text))).toBe(false);
  });

  it('falls back to recipe words when the creator wrote no preview', () => {
    const details = lockedRemixItem().details!;
    const { tree } = renderPrompt({ item: lockedRemixItem({ details: { ...details, unlock: { ...details.unlock!, previewText: null } } }) });
    const texts = tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);

    expect(texts).toContain('Unlock the recipe behind this post, then remix it in the editor.');
  });

  it('still goes on to the editor once paid, with "Recipe unlocked" said over it', async () => {
    authState.api.unlockBundleWithCredits.mockResolvedValue({ success: true, entitlement: 'post_resource_unlock', credits: 4100 });
    dialogState.showConfirmDialog.mockResolvedValue(true);
    const before = readRecipeUnlockedNotice();
    const { onUnlocked, tree } = renderPrompt();

    renderer.act(() => {
      findPressableByAccessibilityLabel(tree.root, 'Unlock for 900 credits').props.onPress();
    });
    await flush();

    expect(onUnlocked).toHaveBeenCalledTimes(1);
    expect(readRecipeUnlockedNotice()).not.toBeNull();
    expect(readRecipeUnlockedNotice()).not.toBe(before);
  });

  it('shows the new price on its button when the server says the price moved', async () => {
    dialogState.showConfirmDialog.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    authState.api.unlockBundleWithCredits.mockRejectedValue(Object.assign(new Error('The price changed to 1200 credits.'), {
      status: 409,
      code: 'RESOURCE_PRICE_CHANGED',
      details: { success: false, code: 'RESOURCE_PRICE_CHANGED', error: 'The price changed to 1200 credits.', priceCredits: 1200 },
    }));
    const { onUnlocked, tree } = renderPrompt();

    renderer.act(() => {
      findPressableByAccessibilityLabel(tree.root, 'Unlock for 900 credits').props.onPress();
    });
    await flush();
    await flush();

    expect(onUnlocked).not.toHaveBeenCalled();
    expect(findPressableByAccessibilityLabel(tree.root, 'Unlock for 1,200 credits')).toBeDefined();
    const texts = tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);
    expect(texts).toEqual(expect.arrayContaining(['1,200 credits', 'The price changed to 1,200 credits.']));
  });
});

