import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  user: null as { id: string; email?: string | null } | null,
  isLoading: false,
}));

const paramsState = vi.hoisted(() => ({
  params: {} as { tab?: string; postId?: string },
}));

const dashboardPropsState = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/components/profile-dashboard', () => ({
  ProfileDashboard: (props: Record<string, unknown>) => {
    dashboardPropsState.props = props;
    return React.createElement('profile-dashboard', props);
  },
}));

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => React.createElement('redirect', { href }),
  useLocalSearchParams: () => paramsState.params,
}));

import ProfileScreen from '../app/(tabs)/profile';
import { DEFAULT_PROFILE_MEDIA_TAB } from '../lib/profile-view-model';

describe('profile screen', () => {
  beforeEach(() => {
    authState.user = null;
    authState.isLoading = false;
    paramsState.params = {};
    dashboardPropsState.props = null;
  });

  it('waits for auth before choosing a route', () => {
    authState.isLoading = true;

    let tree: { toJSON: () => unknown } | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileScreen />);
    });

    expect(tree!.toJSON()).toBeNull();
  });

  it('renders a signed-out profile state without an abrupt redirect', () => {
    let tree: { toJSON: () => unknown } | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileScreen />);
    });

    expect(tree!.toJSON()).toMatchObject({ type: 'profile-dashboard' });
  });

  it('renders the profile dashboard for signed-in users', () => {
    authState.user = { id: 'user-1', email: 'user@example.com' };

    let tree: { toJSON: () => unknown } | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileScreen />);
    });

    expect(tree!.toJSON()).toMatchObject({ type: 'profile-dashboard' });
  });

  it('passes normalized Posts tab params into the profile dashboard', () => {
    authState.user = { id: 'user-1', email: 'user@example.com' };
    paramsState.params = { tab: 'posts', postId: 'post-123' };

    renderer.act(() => {
      renderer.create(<ProfileScreen />);
    });

    expect(dashboardPropsState.props).toMatchObject({
      initialTab: 'Posts',
      highlightedPostId: 'post-123',
    });
  });

  it('defaults an unknown profile tab param to the screen\'s own default', () => {
    authState.user = { id: 'user-1', email: 'user@example.com' };
    paramsState.params = { tab: 'wat', postId: 'post-123' };

    renderer.act(() => {
      renderer.create(<ProfileScreen />);
    });

    expect(dashboardPropsState.props).toMatchObject({
      initialTab: DEFAULT_PROFILE_MEDIA_TAB,
      highlightedPostId: 'post-123',
    });
  });

  it('still honours an explicit saved tab param', () => {
    authState.user = { id: 'user-1', email: 'user@example.com' };
    paramsState.params = { tab: 'saved' };

    renderer.act(() => {
      renderer.create(<ProfileScreen />);
    });

    expect(dashboardPropsState.props).toMatchObject({ initialTab: 'Saved' });
  });
});
