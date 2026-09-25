import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('react-native', () => ({
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

import { LetterboxBands } from '../components/letterbox-bands';
import { LETTERBOX_SEAM_OVERLAP } from '../lib/letterbox';
import { mediaColors } from '../lib/theme';

function render(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  return tree;
}

function bands(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => node.type === 'view').map((node) => node.props.style);
}

describe('LetterboxBands', () => {
  it('fills the bands above and below a landscape picture with plain black, reaching under it', () => {
    // A portrait frame around a 2:1 picture: 100-point bands above and below.
    const styles = bands(render(<LetterboxBands frame={{ width: 400, height: 400 }} aspectRatio={2} />));

    expect(styles).toEqual([
      { position: 'absolute', left: 0, top: 0, width: 400, height: 100 + LETTERBOX_SEAM_OVERLAP, backgroundColor: mediaColors.mediaGround },
      {
        position: 'absolute',
        left: 0,
        top: 300 - LETTERBOX_SEAM_OVERLAP,
        width: 400,
        height: 100 + LETTERBOX_SEAM_OVERLAP,
        backgroundColor: mediaColors.mediaGround,
      },
    ]);
    expect(mediaColors.mediaGround).toBe('#000000');
  });

  it('fills the bands either side of a narrow picture the same way', () => {
    const styles = bands(render(<LetterboxBands frame={{ width: 800, height: 400 }} aspectRatio={1} />));

    expect(styles.map(({ left, width }) => ({ left, width }))).toEqual([
      { left: 0, width: 200 + LETTERBOX_SEAM_OVERLAP },
      { left: 600 - LETTERBOX_SEAM_OVERLAP, width: 200 + LETTERBOX_SEAM_OVERLAP },
    ]);
    for (const style of styles) expect(style.backgroundColor).toBe(mediaColors.mediaGround);
  });

  it('loads, blurs and shades nothing: every band is one plain view', () => {
    const tree = render(<LetterboxBands frame={{ width: 400, height: 800 }} aspectRatio={2} />);

    expect(tree.root.findAll((node) => node.type !== 'view' && typeof node.type === 'string')).toHaveLength(0);
    for (const node of tree.root.findAll((candidate) => candidate.type === 'view')) {
      expect(node.props.children).toBeUndefined();
      expect(node.props.style.experimental_backgroundImage).toBeUndefined();
      expect(node.props.pointerEvents).toBe('none');
    }
  });

  it('draws nothing for a picture of unknown shape, one that fills the frame, or an empty frame', () => {
    expect(render(<LetterboxBands frame={{ width: 400, height: 800 }} aspectRatio={null} />).toJSON()).toBeNull();
    expect(render(<LetterboxBands frame={{ width: 400, height: 800 }} aspectRatio={0.5} />).toJSON()).toBeNull();
    expect(render(<LetterboxBands frame={{ width: 0, height: 800 }} aspectRatio={2} />).toJSON()).toBeNull();
  });
});
