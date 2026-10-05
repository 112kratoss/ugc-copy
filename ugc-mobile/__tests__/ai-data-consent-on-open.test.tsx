// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { readFileSync } from 'node:fs';
import path from 'node:path';

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const consent = vi.hoisted(() => ({ askAiDataConsentOnOpen: vi.fn() }));
// What the navigator reports: the screen is in view, or mounted behind another.
const focus = vi.hoisted(() => ({ focused: true }));

vi.mock('@/lib/ai-data-consent', () => consent);

vi.mock('@react-navigation/native', async () => {
  const react = await import('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      react.useEffect(() => (focus.focused ? effect() : undefined), [effect]);
    },
  };
});

import { AiDataConsentOnOpen } from '../components/ai-data-consent-on-open';

const mobileRoot = path.resolve(__dirname, '..');

function source(relativePath: string) {
  return readFileSync(path.join(mobileRoot, relativePath), 'utf8');
}

beforeEach(() => {
  consent.askAiDataConsentOnOpen.mockReset();
  focus.focused = true;
});

describe('AiDataConsentOnOpen', () => {
  it('puts the question when its screen comes into view', async () => {
    await act(async () => {
      renderer.create(React.createElement(AiDataConsentOnOpen));
    });

    expect(consent.askAiDataConsentOnOpen).toHaveBeenCalledTimes(1);
  });

  it('asks nothing while its screen is mounted but not in view', async () => {
    focus.focused = false;

    await act(async () => {
      renderer.create(React.createElement(AiDataConsentOnOpen));
    });

    expect(consent.askAiDataConsentOnOpen).not.toHaveBeenCalled();
  });

  it('draws nothing of its own', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(AiDataConsentOnOpen));
    });

    expect(tree.toJSON()).toBeNull();
  });
});

// The three screens that send a prompt or media to an AI service. Each asks on
// opening, after the community rules, so the question never waits on a balance.
describe('the screens that ask on opening', () => {
  it.each([
    ['the Create tab', 'app/(tabs)/creator.tsx', '<MediaCreationScreen'],
    ['a creation tool', 'app/create/[tool].tsx', '<MediaCreationScreen'],
    ['a template', 'app/templates/[slug].tsx', '<MediaTemplateDetailScreen'],
  ])('%s asks inside the rules gate, ahead of the screen itself', (_name, file, screen) => {
    const text = source(file);
    const gateOpens = text.indexOf('<ContentPolicyGate');
    const asks = text.indexOf('<AiDataConsentOnOpen />');
    const screenStarts = text.indexOf(screen);
    const gateCloses = text.indexOf('</ContentPolicyGate>');

    expect(gateOpens).toBeGreaterThan(-1);
    expect(asks).toBeGreaterThan(gateOpens);
    expect(screenStarts).toBeGreaterThan(asks);
    expect(gateCloses).toBeGreaterThan(screenStarts);
  });

  it('leaves the post composer alone, which sends nothing to an AI service', () => {
    expect(source('app/post/new.tsx')).not.toContain('AiDataConsentOnOpen');
  });
});
