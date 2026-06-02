import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  user: null as { id: string; email?: string | null } | null,
  isLoading: false,
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/components/profile-dashboard', () => ({
  ProfileDashboard: () => React.createElement('profile-dashboard'),
}));

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => React.createElement('redirect', { href }),
}));

import ProfileScreen from '../app/(tabs)/profile';

describe('profile screen', () => {
  beforeEach(() => {
    authState.user = null;
    authState.isLoading = false;
  });

  it('waits for auth before choosing a route', () => {
    authState.isLoading = true;

    let tree: { toJSON: () => unknown } | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileScreen />);
    });

    expect(tree!.toJSON()).toBeNull();
  });

  it('redirects signed-out users to auth', () => {
    let tree: { toJSON: () => unknown } | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileScreen />);
    });

    expect(tree!.toJSON()).toMatchObject({ type: 'redirect', props: { href: '/auth' } });
  });

  it('renders the profile dashboard for signed-in users', () => {
    authState.user = { id: 'user-1', email: 'user@example.com' };

    let tree: { toJSON: () => unknown } | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileScreen />);
    });

    expect(tree!.toJSON()).toMatchObject({ type: 'profile-dashboard' });
  });
});
