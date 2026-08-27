import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CREATE_MENU_ACTIONS, getCreateMenuActionHref } from '../lib/create-menu-view-model';

/**
 * S8's rules, in the form a suite can hold. Sources: Menus, Generative AI,
 * Machine learning (Limitations), Icons — plus N1's tab-bar ruling and the
 * divergence ledger's DV5/DV6, which this surface is the only instance of.
 */

const mobileRoot = path.resolve(__dirname, '..');
const read = (name: string) => readFileSync(path.join(mobileRoot, name), 'utf8');

const screen = read('components/media-creation-screen.tsx');
const menu = read('components/magic-create-menu.tsx');

describe('S8 — the create menu', () => {
  // Menus: "label a menu item that initiates an action using a verb or verb
  // phrase"; "use title-style capitalization"; "remove articles like a, an,
  // and the"; "prefer listing important or frequently used menu items first".
  it('labels both items with a bare verb, most important first', () => {
    expect(CREATE_MENU_ACTIONS.map((action) => action.label)).toEqual(['Create', 'Post']);
    for (const action of CREATE_MENU_ACTIONS) {
      expect(action.label).toMatch(/^[A-Z][a-z]+$/);
      expect(action.label).not.toMatch(/\b(a|an|the)\b/i);
    }
  });

  it('sends each item to the surface its body promises', () => {
    expect(getCreateMenuActionHref('create')).toBe('/(tabs)/creator');
    expect(getCreateMenuActionHref('post')).toBe('/post/new');
  });

  // Menus/Icons: "provide icons for all menu items in a group, or none of them."
  it('gives every item an icon, on the ramp', () => {
    expect(menu).toContain('const Icon = isCreate ? Sparkles : FilePlus2;');
    expect(menu).toContain('<Icon size={appTheme.icon.feature} color={foreground} />');
    expect(menu).not.toMatch(/size=\{2[0-9]\}/);
  });

  it('keeps the way out that N2 gave it', () => {
    // A menu dismisses by tapping outside; this one also has a grabber with a
    // real drag and a Close button, and answers Android's back key.
    expect(menu).toContain('useSheetDismissDrag({ onDismiss: onClose })');
    expect(menu).toContain('<SheetGrabber drag={drag} />');
    expect(menu).toContain('accessibilityLabel="Close create menu"');
    expect(menu).toContain("BackHandler.addEventListener('hardwareBackPress'");
  });
});

describe('S8 — what a first-time creator is told', () => {
  // Generative AI: "Set clear expectations about what your AI-powered feature
  // can and can't do ... let people know up front, show them how to get good
  // results." Onboarding's last act lands here with guided=1.
  it('is reached from onboarding in guided mode', () => {
    const onboarding = read('app/onboarding.tsx');
    expect(onboarding).toContain("pathname: '/(tabs)/creator'");
    expect(onboarding).toContain("guided: '1'");
  });

  it('states the cost promise and how to write a prompt, on both live branches', () => {
    expect(screen).toContain('function GuidedCreatorHint()');
    expect(screen).toContain('Nothing spends credits until you press Generate.');
    // Both composer branches — the image one and the video/motion one — mount it.
    expect((screen.match(/<GuidedCreatorHint \/>/g) ?? []).length).toBe(2);
  });

  it('pairs the hint with the starters rather than replacing them', () => {
    expect((screen.match(/<GuidedPromptChips /g) ?? []).length).toBe(2);
    for (const match of screen.matchAll(/<GuidedCreatorHint \/>\s*\n\s*<GuidedPromptChips /g)) {
      expect(match[0]).toContain('GuidedPromptChips');
    }
    expect(screen).toMatch(/<GuidedCreatorHint \/>\s*\n\s*<GuidedPromptChips /);
  });

  it('shows a starter rather than its first third', () => {
    const chips = screen.slice(screen.indexOf('function GuidedPromptChips('), screen.indexOf('function SlimCreatorBanner('));
    expect(chips).toContain('numberOfLines={2}');
    expect(chips).not.toContain('numberOfLines={1}');
  });
});
