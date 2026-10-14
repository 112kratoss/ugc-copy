(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style,
  }, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scrollview', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Kicker: ({ children, ...props }: MockProps) => React.createElement('text', { ...props, kicker: true }, children),
}));

import whatsNewContract from '../../contracts/whats-new-models-v1.json';
import { WhatsNewModelsStrip } from '../components/whats-new-models-strip';
import type { ModelCatalogKind, ModelCatalogSummary } from '../lib/model-catalog/protocol';
import { themes } from '../lib/theme';

const [newInTwoKinds, noneNew] = whatsNewContract.cases;

/** A case's models as the catalog session holds its pages: summaries, by sortOrder and then id. */
function pages(models: readonly { id: string; kind: string; badge: string | null; sortOrder: number; displayName: string }[]): ModelCatalogSummary[] {
  return models
    .map((model) => ({ ...model, kind: model.kind as ModelCatalogKind, description: `${model.displayName} test summary`, recommended: false }))
    .sort((left, right) => left.sortOrder - right.sortOrder || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function render(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  return tree;
}

const chips = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => String(node.type) === 'pressable');
const texts = (node: renderer.ReactTestInstance) => node.findAll((child) => String(child.type) === 'text').map((child) => child.props.children);

describe('the What’s new strip', () => {
  it('lists the fixture’s models in its order, each by name and kind, under its heading', () => {
    const onSelect = vi.fn();
    const tree = render(<WhatsNewModelsStrip models={pages(newInTwoKinds.models)} selectedModelId={null} onSelect={onSelect} />);

    expect(tree.root.find((node) => String(node.type) === 'text' && node.props.kicker).props.children).toBe('What’s new');
    expect(chips(tree).map((chip) => chip.props.accessibilityLabel)).toEqual(['Pixel Flash, Image', 'Orbit Max, Video', 'Aurora, Image', 'Orbit, Video']);
    expect(chips(tree).map(texts)).toEqual([['Pixel Flash', 'Image'], ['Orbit Max', 'Video'], ['Aurora', 'Image'], ['Orbit', 'Video']]);
    renderer.act(() => {
      for (const chip of chips(tree)) chip.props.onPress();
    });
    expect(onSelect.mock.calls.map(([model]) => model.id)).toEqual(newInTwoKinds.appStripIds);
    // The kind in its tool's accent, as the tool switcher marks the tab.
    const [image, video] = chips(tree).map((chip) => chip.findAll((child) => String(child.type) === 'text')[1].props.color);
    expect(image).toBe(themes.dark.colors.image);
    expect(video).toBe(themes.dark.colors.video);
    // One row that scrolls sideways, each chip a full-height target.
    expect(tree.root.find((node) => String(node.type) === 'scrollview').props.horizontal).toBe(true);
    expect(chips(tree).every((chip) => chip.props.style.minHeight >= 44)).toBe(true);
  });

  it('hands the tapped model to the screen', () => {
    const onSelect = vi.fn();
    const tree = render(<WhatsNewModelsStrip models={pages(newInTwoKinds.models)} selectedModelId={null} onSelect={onSelect} />);

    renderer.act(() => {
      chips(tree)[1].props.onPress();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'orbit-max', kind: 'video', displayName: 'Orbit Max' }));
  });

  it('marks the model the active tool already has, and no other', () => {
    const tree = render(<WhatsNewModelsStrip models={pages(newInTwoKinds.models)} selectedModelId="aurora" onSelect={vi.fn()} />);

    expect(chips(tree).map((chip) => chip.props.accessibilityState.selected)).toEqual([false, false, true, false]);
    expect(chips(tree)[2].props.style.borderColor).not.toBe(chips(tree)[0].props.style.borderColor);
  });

  it('turns the chip of a model still loading in place of its kind, and takes no press until it lands', () => {
    const tree = render(<WhatsNewModelsStrip models={pages(newInTwoKinds.models)} selectedModelId={null} pick={{ modelId: 'orbit-max', error: null }} onSelect={vi.fn()} />);

    const [, loading] = chips(tree);
    expect(loading.findAllByProps({ testID: 'whats-new-model-loading' })).not.toHaveLength(0);
    expect(texts(loading)).toEqual(['Orbit Max']);
    expect(loading.props.accessibilityState).toEqual({ selected: false, busy: true, disabled: true });
    expect(chips(tree).map((chip) => chip.props.disabled)).toEqual([true, true, true, true]);
    expect(tree.root.findAll((node) => node.props.accessibilityRole === 'alert')).toHaveLength(0);
  });

  it('says why a pick from the strip did not land, under the row, and lets its chip try again', () => {
    const onSelect = vi.fn();
    const tree = render(<WhatsNewModelsStrip models={pages(newInTwoKinds.models)} selectedModelId={null} pick={{ modelId: 'orbit-max', error: 'Could not load model settings.' }} onSelect={onSelect} />);

    expect(tree.root.find((node) => String(node.type) === 'text' && node.props.accessibilityRole === 'alert').props.children).toBe('Could not load model settings.');
    expect(tree.root.findAllByProps({ testID: 'whats-new-model-loading' })).toHaveLength(0);
    expect(chips(tree).every((chip) => !chip.props.disabled)).toBe(true);
    renderer.act(() => {
      chips(tree)[1].props.onPress();
    });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'orbit-max' }));

    // A failed pick of a model the strip does not list is the picker's to say.
    const elsewhere = render(<WhatsNewModelsStrip models={pages(newInTwoKinds.models)} selectedModelId={null} pick={{ modelId: 'kite-3', error: 'Could not load model settings.' }} onSelect={vi.fn()} />);
    expect(elsewhere.root.findAll((node) => node.props.accessibilityRole === 'alert')).toHaveLength(0);
  });

  it('draws nothing when no model carries New, or before any page has loaded', () => {
    expect(render(<WhatsNewModelsStrip models={pages(noneNew.models)} selectedModelId={null} onSelect={vi.fn()} />).toJSON()).toBeNull();
    expect(render(<WhatsNewModelsStrip models={[]} selectedModelId={null} onSelect={vi.fn()} />).toJSON()).toBeNull();
  });
});
