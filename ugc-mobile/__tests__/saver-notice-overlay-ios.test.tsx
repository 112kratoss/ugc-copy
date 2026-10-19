(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import fs from 'node:fs';
import path from 'node:path';

import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native-screens', () => ({
  FullWindowOverlay: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => (
    React.createElement('full-window-overlay', props, children)
  ),
}));

// Named in full: vitest resolves `saver-notice-overlay` to the pass-through,
// so nothing else in the suite ever loads what iOS draws.
import { SaverNoticeOverlay as IOSSaverNoticeOverlay } from '@/components/saver-notice-overlay.ios';
import { SaverNoticeOverlay } from '@/components/saver-notice-overlay';

const componentsRoot = path.resolve(__dirname, '../components');

// Review 4 finding #14: the iOS half of review 3 #2's fix (the bar above any
// Modal opened over it, where iOS reports neither `blur` nor `inactive`)
// rests on this file alone.
describe('the saver notice overlay', () => {
  it('on iOS draws the notice in the full-window overlay, above presented Modals, as no VoiceOver modal', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<IOSSaverNoticeOverlay><notice-bar /></IOSSaverNoticeOverlay>);
    });

    const overlay = tree.root.find((node) => String(node.type) === 'full-window-overlay');
    // Review 4 finding #7: VoiceOver still reaches Back, Mute and the tab bar.
    expect(overlay.props.unstable_accessibilityContainerViewIsModal).toBe(false);
    expect(overlay.findAll((node) => String(node.type) === 'notice-bar')).toHaveLength(1);
    renderer.act(() => tree.unmount());
  });

  it('elsewhere draws it in place, the iOS file staying beside it under the name Metro looks for', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<SaverNoticeOverlay><notice-bar /></SaverNoticeOverlay>);
    });
    expect(tree.root.findAll((node) => String(node.type) === 'full-window-overlay')).toHaveLength(0);
    expect(tree.root.findAll((node) => String(node.type) === 'notice-bar')).toHaveLength(1);
    renderer.act(() => tree.unmount());

    expect(fs.existsSync(path.join(componentsRoot, 'saver-notice-overlay.ios.tsx'))).toBe(true);
    const bar = fs.readFileSync(path.join(componentsRoot, 'saver-notice-bar.tsx'), 'utf8');
    // The platform-resolved name, never one of the two files.
    expect(bar).toContain("from '@/components/saver-notice-overlay';");
    expect(bar).toMatch(/<SaverNoticeOverlay>[\s\S]*<NoticeCard/);
  });
});

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'notice-bar': Record<string, never>;
    }
  }
}
