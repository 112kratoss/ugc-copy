import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('react-native', () => ({
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  FileText: (props: MockProps) => React.createElement('file-icon', props),
}));

import { ResourceKindRow } from '../components/resource-kind-row';
import { appTheme } from '../lib/theme';
import { useAppTheme } from '../lib/theme-context';

function render(element: React.ReactElement) {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  return tree!;
}

function labels(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);
}

describe('ResourceKindRow', () => {
  it('names each kind once, in the shared words, and drops one it does not know', () => {
    const tree = render(<ResourceKindRow kinds={['prompt', 'files', 'prompt', 'hologram', 'remix']} />);
    expect(labels(tree)).toEqual(['Prompt', 'Files', 'Remix']);
    expect(tree.root.findAll((node) => String(node.type) === 'file-icon')[0]?.props.size).toBe(appTheme.icon.xs);
  });

  it('draws nothing for a recipe with no known kinds', () => {
    expect(render(<ResourceKindRow kinds={[]} />).toJSON()).toBeNull();
    expect(render(<ResourceKindRow kinds={['hologram']} />).toJSON()).toBeNull();
  });

  it('sets each chip off the surface it sits on', () => {
    let colors: ReturnType<typeof useAppTheme>['colors'] | undefined;
    function ReadTheme() {
      colors = useAppTheme().colors;
      return null;
    }
    render(<ReadTheme />);
    const chip = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => String(node.type) === 'view')[1];

    expect(chip(render(<ResourceKindRow kinds={['prompt']} on="surface" />))?.props.style.backgroundColor).toBe(colors?.surfaceStrong);
    expect(chip(render(<ResourceKindRow kinds={['prompt']} on="surfaceStrong" />))?.props.style.backgroundColor).toBe(colors?.surface);
  });
});
