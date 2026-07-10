import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import CreateImagePage from '@/app/create-image/page';
import CreateMotionPage from '@/app/create-motion/page';
import CreateVideoPage from '@/app/create-video/page';

vi.mock('@/app/components/RouteAuthBoundary', () => ({
  RequireAuth: ({ children, returnTo }: { children: React.ReactNode; returnTo: string }) => (
    <div data-testid="auth-boundary" data-return-to={returnTo}>{children}</div>
  ),
}));

vi.mock('@/app/create-image/CreateImageClient', () => ({
  default: () => <div>Image creator</div>,
}));

vi.mock('@/app/create-video/CreateVideoClient', () => ({
  default: () => <div>Video creator</div>,
}));

vi.mock('@/app/create-motion/CreateMotionClient', () => ({
  default: () => <div>Motion creator</div>,
}));

describe('creator auth return paths', () => {
  it('preserves image model and recipe parameters through sign-in', async () => {
    render(await CreateImagePage({
      searchParams: Promise.resolve({
        model: 'gpt-image-2',
        prompt: 'product hero',
        aspectRatio: '4:5',
      }),
    }));

    expect(screen.getByTestId('auth-boundary')).toHaveAttribute(
      'data-return-to',
      '/create-image?prompt=product+hero&model=gpt-image-2&aspectRatio=4%3A5'
    );
  });

  it('preserves video duration and model through sign-in', async () => {
    render(await CreateVideoPage({
      searchParams: Promise.resolve({
        model: 'grok-imagine-video',
        duration: '10',
      }),
    }));

    expect(screen.getByTestId('auth-boundary')).toHaveAttribute(
      'data-return-to',
      '/create-video?model=grok-imagine-video&duration=10'
    );
  });

  it('preserves motion remix context through sign-in', async () => {
    render(await CreateMotionPage({
      searchParams: Promise.resolve({ remix: 'generation-1', model: 'kling-3.0' }),
    }));

    expect(screen.getByTestId('auth-boundary')).toHaveAttribute(
      'data-return-to',
      '/create-motion?remix=generation-1&model=kling-3.0'
    );
  });
});
