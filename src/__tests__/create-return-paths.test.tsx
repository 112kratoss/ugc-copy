import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CreateImagePage from '@/app/create-image/page';
import CreateMotionPage from '@/app/create-motion/page';
import CreateVideoPage from '@/app/create-video/page';
import NewPostPage from '@/app/post/new/page';

const state = vi.hoisted(() => ({
  hasAuthHint: false,
  clientProps: {} as Record<string, Record<string, unknown>>,
  mounts: {} as Record<string, number>,
}));

vi.mock('@/components/RouteAuthBoundary', () => ({
  RequireAuth: ({ children, returnTo }: { children: React.ReactNode; returnTo: string }) => (
    <div data-testid="auth-boundary" data-return-to={returnTo}>{children}</div>
  ),
  RequestHintedOptionalAuth: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="optional-auth">{children}</div>
  ),
  requestHasAuthHint: async () => state.hasAuthHint,
}));

vi.mock('@/lib/welcome-credit-program-server', () => ({
  loadWelcomeCreditAmount: async () => 25,
}));

vi.mock('@/app/create-image/CreateImageClient', async () => {
  const { useEffect } = await import('react');
  return {
    default: function CreateImageMock(props: Record<string, unknown>) {
      state.clientProps.image = props;
      useEffect(() => {
        state.mounts.image = (state.mounts.image ?? 0) + 1;
      }, []);
      return <div>Image creator</div>;
    },
  };
});

vi.mock('@/app/create-video/CreateVideoClient', async () => {
  const { useEffect } = await import('react');
  return {
    default: function CreateVideoMock(props: Record<string, unknown>) {
      state.clientProps.video = props;
      useEffect(() => {
        state.mounts.video = (state.mounts.video ?? 0) + 1;
      }, []);
      return <div>Video creator</div>;
    },
  };
});

vi.mock('@/app/create-motion/CreateMotionClient', async () => {
  const { useEffect } = await import('react');
  return {
    default: function CreateMotionMock(props: Record<string, unknown>) {
      state.clientProps.motion = props;
      useEffect(() => {
        state.mounts.motion = (state.mounts.motion ?? 0) + 1;
      }, []);
      return <div>Motion creator</div>;
    },
  };
});

vi.mock('@/app/post/new/NewPostClient', () => ({
  default: () => <div>Post composer</div>,
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: async () => ({ session: null, credits: null }),
  getServerPublicIdentity: () => null,
}));

describe('creator auth return paths', () => {
  beforeEach(() => {
    state.hasAuthHint = false;
    state.clientProps = {};
    state.mounts = {};
  });

  it('carries the remix pair through sign-in on every media tool', async () => {
    const remixParams = { remix: 'gen-1', remixPost: 'post-1' };

    render(await CreateImagePage({ searchParams: Promise.resolve(remixParams) }));
    expect(screen.getByTestId('auth-boundary')).toHaveAttribute(
      'data-return-to',
      '/create-image?remix=gen-1&remixPost=post-1'
    );
    cleanup();

    render(await CreateVideoPage({ searchParams: Promise.resolve(remixParams) }));
    expect(screen.getByTestId('auth-boundary')).toHaveAttribute(
      'data-return-to',
      '/create-video?remix=gen-1&remixPost=post-1'
    );
    cleanup();

    render(await CreateMotionPage({ searchParams: Promise.resolve(remixParams) }));
    expect(screen.getByTestId('auth-boundary')).toHaveAttribute(
      'data-return-to',
      '/create-motion?remix=gen-1&remixPost=post-1'
    );
  });

  // A Remix on a creator's own start posts stays on its route, where the router keeps the client.
  it('starts each creator afresh for a new remix, and keeps it for the same one', async () => {
    const remix = (id: string) => Promise.resolve({ remix: `gen-${id}`, remixPost: `post-${id}` });
    for (const [kind, Page] of [['image', CreateImagePage], ['video', CreateVideoPage], ['motion', CreateMotionPage]] as const) {
      const view = render(await Page({ searchParams: remix('1') }));
      view.rerender(await Page({ searchParams: remix('1') }));
      expect(state.mounts[kind]).toBe(1);
      view.rerender(await Page({ searchParams: remix('2') }));
      expect(state.mounts[kind]).toBe(2);
      cleanup();
    }
  });

  it('lets a signed-out visitor use every creator, told what signing up gives', async () => {
    render(await CreateImagePage({
      searchParams: Promise.resolve({ model: 'gpt-image-2', prompt: 'product hero', aspectRatio: '4:5' }),
    }));
    expect(screen.queryByTestId('auth-boundary')).not.toBeInTheDocument();
    expect(screen.getByTestId('optional-auth')).toHaveTextContent('Image creator');
    expect(state.clientProps.image).toMatchObject({
      prefill: { model: 'gpt-image-2', prompt: 'product hero', aspectRatio: '4:5' },
      visitorWelcomeCredits: 25,
      welcome: null,
    });
    cleanup();

    render(await CreateVideoPage({ searchParams: Promise.resolve({ model: 'grok-imagine-video', duration: '10' }) }));
    expect(screen.queryByTestId('auth-boundary')).not.toBeInTheDocument();
    expect(state.clientProps.video).toMatchObject({
      prefill: { model: 'grok-imagine-video', duration: '10' },
      visitorWelcomeCredits: 25,
    });
    cleanup();

    render(await CreateMotionPage({ searchParams: Promise.resolve({ prompt: 'Dance', model: 'kling-3.0' }) }));
    expect(screen.queryByTestId('auth-boundary')).not.toBeInTheDocument();
    // A lapsed session still signs in again on this page's own link.
    expect(state.clientProps.motion).toMatchObject({
      returnTo: '/create-motion?prompt=Dance&model=kling-3.0',
      visitorWelcomeCredits: 25,
    });
  });

  it('reads the welcome amount only for a request without a sign-in cookie', async () => {
    state.hasAuthHint = true;
    render(await CreateVideoPage({ searchParams: Promise.resolve({}) }));
    expect(state.clientProps.video).toMatchObject({ visitorWelcomeCredits: null });
  });

  it('passes the post-auth welcome flag, a well-formed invite outcome and the hand-over nonce to the creator', async () => {
    state.hasAuthHint = true;
    render(await CreateVideoPage({
      searchParams: Promise.resolve({ handover: 'nonce-1234-abcd', welcome: '1', referral: 'applied' }),
    }));
    expect(state.clientProps.video).toMatchObject({ welcome: { referral: 'applied' }, handoverNonce: 'nonce-1234-abcd' });
    cleanup();

    render(await CreateVideoPage({ searchParams: Promise.resolve({ handover: 'not a nonce!' }) }));
    expect(state.clientProps.video).toMatchObject({ welcome: null, handoverNonce: null });
    cleanup();

    render(await CreateImagePage({ searchParams: Promise.resolve({ welcome: '1', referral: 'Not a status!' }) }));
    expect(state.clientProps.image).toMatchObject({ welcome: { referral: null } });
    cleanup();

    render(await CreateMotionPage({ searchParams: Promise.resolve({ referral: 'applied' }) }));
    expect(state.clientProps.motion).toMatchObject({ welcome: null });
  });

  it('preserves allowlisted composer context through sign-in', async () => {
    render(await NewPostPage({
      searchParams: Promise.resolve({
        generationId: 'generation-1',
        publishIntent: 'paid-generation',
        resourceMode: 'paid',
        focus: 'price',
        from: 'creations',
        unsafe: 'ignored',
      }),
    }));

    expect(screen.getByTestId('auth-boundary')).toHaveAttribute(
      'data-return-to',
      '/post/new?generationId=generation-1&publishIntent=paid-generation&resourceMode=paid&focus=price&from=creations'
    );
  });
});
