(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const { device } = vi.hoisted(() => ({ device: { fontScale: 1 } }));

vi.mock('react-native', () => ({
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 320, height: 640, fontScale: device.fontScale }),
}));

import { TextPostPlate } from '../components/text-post-plate';

function render(props: Partial<React.ComponentProps<typeof TextPostPlate>> = {}) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(<TextPostPlate testID="plate" content={{ title: null, body: 'Writing' }} bodyLines={5} size="feature" {...props} />);
  });
  const laidOut = (height: number) => renderer.act(() => {
    const plate = tree.root.find((node) => String(node.type) === 'view' && node.props.testID === 'plate');
    (plate.props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { height } } });
  });
  const lines = (text: string) => tree.root
    .find((node) => String(node.type) === 'text' && node.props.children === text).props.numberOfLines as number;
  return { laidOut, lines };
}

describe('TextPostPlate', () => {
  beforeEach(() => {
    device.fontScale = 1;
  });

  it('draws the caller\'s count until it has been laid out', () => {
    expect(render().lines('Writing')).toBe(5);
  });

  // Review of #774: search drew five lines whatever the frame; on a 320pt
  // phone the frame is about 123pt tall and the first of five was cut through.
  it('counts whole lines from its own height once it has one', () => {
    const plate = render();
    plate.laidOut(123);
    // 123 less 14 above and below is 95: four 20pt lines.
    expect(plate.lines('Writing')).toBe(4);
    plate.laidOut(160);
    expect(plate.lines('Writing')).toBe(6);
  });

  it('gives fewer lines at a larger text size, up to the size its type stops at', () => {
    device.fontScale = 1.3;
    const large = render();
    large.laidOut(160);
    // 132 at 26pt a line.
    expect(large.lines('Writing')).toBe(5);
    device.fontScale = 2;
    const largest = render();
    largest.laidOut(160);
    expect(largest.lines('Writing')).toBe(5);
  });

  it('leaves a title over writing its one line, in a tile', () => {
    const tile = render({ size: 'tile', content: { title: 'Name', body: 'Writing' }, paddingTop: 46, paddingBottom: 38, bodyLines: 9 });
    tile.laidOut(153);
    // 153 less 84 for the corner marks and 20 for the title is 49: three 16pt lines.
    expect(tile.lines('Name')).toBe(1);
    expect(tile.lines('Writing')).toBe(3);
  });
});
