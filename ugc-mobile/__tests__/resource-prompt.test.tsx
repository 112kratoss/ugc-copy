import React from 'react';
import renderer from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Text: (props: Record<string, unknown>) => React.createElement('text', props),
  View: (props: Record<string, unknown>) => React.createElement('view', props),
  Pressable: (props: Record<string, unknown>) => React.createElement('pressable', props),
}));
import { ResourcePrompt } from '../components/resource-prompt';

it('copies the full prompt from its collapsed preview and expands selectable text', async () => {
  const text = 'A long source prompt with details. '.repeat(25);
  const onCopy = vi.fn();
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => { tree = renderer.create(<ResourcePrompt text={text} onCopy={onCopy} />); });
  expect(tree.root.findAllByProps({ selectable: true })[0].props.numberOfLines).toBe(5);
  await renderer.act(async () => { tree.root.findAllByProps({ accessibilityLabel: 'Copy prompt' })[0].props.onPress(); });
  expect(onCopy).toHaveBeenCalledExactlyOnceWith(text);
  await renderer.act(async () => { tree.root.findAllByProps({ accessibilityLabel: 'Show full prompt' })[0].props.onPress(); });
  expect(tree.root.findAllByProps({ selectable: true })[0].props.numberOfLines).toBeUndefined();
  expect(tree.root.findAllByProps({ accessibilityLabel: 'Collapse prompt' })[0].props.accessibilityState.expanded).toBe(true);
  renderer.act(() => tree.unmount());
});

// The reader swipes to the next post's prompt; the previous one's expansion
// must not carry over onto it.
it('collapses again when a different prompt takes its place', async () => {
  const first = 'A long source prompt with details. '.repeat(25);
  const second = 'An entirely different long prompt. '.repeat(25);
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => { tree = renderer.create(<ResourcePrompt text={first} />); });
  await renderer.act(async () => { tree.root.findAllByProps({ accessibilityLabel: 'Show full prompt' })[0].props.onPress(); });
  expect(tree.root.findAllByProps({ selectable: true })[0].props.numberOfLines).toBeUndefined();

  await renderer.act(async () => { tree.update(<ResourcePrompt text={second} />); });
  expect(tree.root.findAllByProps({ selectable: true })[0].props.numberOfLines).toBe(5);
  expect(tree.root.findAllByProps({ selectable: true })[0].props.children).toBe(second);
  renderer.act(() => tree.unmount());
});
