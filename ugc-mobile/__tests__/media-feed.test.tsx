import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeState = vi.hoisted(() => ({
  params: {
    source: 'profile-creations',
    initialId: 'gen-4',
  },
}));

vi.mock('expo-router', () => ({
  Redirect: (props: Record<string, unknown>) => React.createElement('redirect', props),
  useLocalSearchParams: () => routeState.params,
}));

import MediaFeedScreen from '../app/media-feed';

describe('legacy MediaFeedScreen route', () => {
  beforeEach(() => {
    routeState.params = {
      source: 'profile-creations',
      initialId: 'gen-4',
    };
  });

  it('redirects old media-feed links into the immersive viewer', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaFeedScreen />);
    });

    const redirect = tree!.root.find((node) => String(node.type) === 'redirect');
    expect(redirect.props.href).toEqual({
      pathname: '/viewer',
      params: {
        source: 'profile-creations',
        initialId: 'gen-4',
      },
    });
  });
});
