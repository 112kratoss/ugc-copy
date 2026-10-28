import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CreateImagePage from '@/app/create-image/page';
import CreateMotionPage from '@/app/create-motion/page';
import CreateVideoPage from '@/app/create-video/page';
import NewPostPage from '@/app/post/new/page';

const state = vi.hoisted(() => ({
  hasAuthHint: false,
  clientProps: {} as Record<string, Record<string, unknown>>,
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

vi.mock('@/app/create-image/CreateImageClient', () => ({
  default: (props: Record<string, unknown>) => {
    state.clientProps.image = props;
    return <div>Image creator</div>;
  },
}));

vi.mock('@/app/create-video/CreateVideoClient', () => ({
  default: (props: Record<string, unknown>) => {
    state.clientProps.video = props;
    return <div>Video creator</div>;
  },
}));

vi.mock('@/app/create-motion/CreateMotionClient', () => ({
  default: (props: Record<string, unknown>) => {
    state.clientProps.motion = props;
    return <div>Motion creator</div>;
  },
}));

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

  it('passes the post-auth welcome flag and a well-formed invite outcome to the creator', async () => {
    state.hasAuthHint = true;
    render(await CreateVideoPage({ searchParams: Promise.resolve({ prompt: 'boat', welcome: '1', referral: 'applied' }) }));
    expect(state.clientProps.video).toMatchObject({ welcome: { referral: 'applied' } });
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
