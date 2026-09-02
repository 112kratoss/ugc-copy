import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// A source sweep has no business booting react-native; `lib/action-sheet` only
// reaches for `Alert` on the no-host fallback path.
vi.mock('react-native', () => ({ Alert: { alert: () => undefined } }));

import { orderActionSheetActions } from '../lib/action-sheet';

const mobileRoot = path.resolve(__dirname, '..');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) files.push(...sourceFiles(absolutePath));
    else if (/\.tsx?$/.test(entry)) files.push(absolutePath);
  }
  return files;
}

const files = ['app', 'components', 'lib']
  .flatMap((root) => sourceFiles(path.join(mobileRoot, root)))
  .map((absolutePath) => ({
    name: path.relative(mobileRoot, absolutePath).replaceAll(path.sep, '/'),
    source: readFileSync(absolutePath, 'utf8'),
  }));

function file(name: string) {
  const match = files.find((entry) => entry.name === name);
  if (!match) throw new Error(`Missing ${name}`);
  return match.source;
}

/**
 * N2's rules, in the form a suite can hold. Sources: Modality, Sheets, Action
 * sheets, Alerts, Menus, Context menus, Gestures.
 */

/** Every `Alert.alert(...)` call in the tree, as source text. */
function alertCalls(source: string) {
  const calls: string[] = [];
  const pattern = /Alert\.alert\(/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    let depth = 0;
    for (let index = match.index + match[0].length - 1; index < source.length; index += 1) {
      const character = source[index];
      if (character === '(' || character === '[' || character === '{') depth += 1;
      else if (character === ')' || character === ']' || character === '}') {
        depth -= 1;
        if (depth === 0) {
          calls.push(source.slice(match.index, index + 1));
          break;
        }
      }
    }
  }

  return calls;
}

/** The button objects of one alert call, as source text. */
function alertButtons(call: string) {
  return call.match(/\{[^{}]*\btext:[^{}]*\}/g) ?? [];
}

describe('HIG modality — sheets, alerts and the way out', () => {
  it('lets only the shared primitive draw a grabber', () => {
    // A pill without a gesture behind it promises a swipe the sheet does not
    // answer, which is how three of them shipped. Drawing one anywhere else
    // means the drag was not adopted with it.
    const rogue = files
      .filter((entry) => entry.name !== 'components/sheet-chrome.tsx')
      // An explicit narrow width immediately followed by a 4pt height: the
      // pill, and not a `flex: 1` progress segment of the same thickness.
      .filter((entry) => /width:\s*(?:3[0-9]|4[0-9])\s*,\s*height:\s*4\s*,/.test(entry.source))
      .map((entry) => entry.name);

    expect(rogue).toEqual([]);
  });

  it('never spreads pan handlers onto a Pressable', () => {
    // `Pressable` renders `{...restProps}` and then its own Pressability
    // handlers, so a spread `panHandlers` is overwritten and silently never
    // fires — which is how three sheets shipped a swipe that did nothing.
    const dead = files
      .filter((entry) => /<Pressable[\s\S]{0,200}?\{\.\.\.\w*[Pp]an\w*\.?panHandlers\}/.test(entry.source)
        || /<Pressable\s+\{\.\.\.\w+\.panHandlers\}/.test(entry.source))
      .map((entry) => entry.name);

    expect(dead).toEqual([]);
  });

  it('gives every grabber a drag, and every drag a moving panel', () => {
    const broken = files
      .filter((entry) => entry.name !== 'components/sheet-chrome.tsx')
      .filter((entry) => entry.source.includes('<SheetGrabber'))
      .filter((entry) => !entry.source.includes('useSheetDismissDrag')
        || !(entry.source.includes('.dragStyle') || entry.source.includes('.translateY')))
      .map((entry) => entry.name);

    expect(broken).toEqual([]);
  });

  it('lets the whole sheet answer the swipe, not only the pill', () => {
    // Sheets: "People expect to swipe vertically to dismiss a sheet." Nobody
    // aims for a 4pt strip; they pull the surface they are looking at. A sheet
    // that only answers on the grabber leaves the gesture dead everywhere it
    // is most likely to be tried.
    const pillOnly = files
      .filter((entry) => entry.name !== 'components/sheet-chrome.tsx')
      .filter((entry) => entry.source.includes('<SheetGrabber'))
      .filter((entry) => !entry.source.includes('.contentPanHandlers}'))
      .map((entry) => entry.name);

    expect(pillOnly).toEqual([]);
  });

  it('tells every drag when its sheet is shown', () => {
    // A drag leaves its offset where the finger let go, which is right for the
    // exit that follows and wrong for the next opening. Four sheets that stay
    // mounted while closed left `visible` out and reopened part-way down the
    // screen until a tap on the grabber sprang them back. The option is
    // required by type now; this keeps a cast or an `any` from quietly
    // reopening the hole.
    const silent = files.flatMap((entry) => [...entry.source.matchAll(/useSheetDismissDrag\(\{([^}]*)\}\)/g)]
      .filter((call) => !/\bvisible\b/.test(call[1]))
      .map(() => entry.name));

    expect(silent).toEqual([]);
  });

  it('keeps every alert within three buttons', () => {
    // Alerts: "alerts display a title, optional informative text, and up to
    // three buttons". A longer list is a menu, and belongs in an action sheet.
    const over = files.flatMap((entry) => alertCalls(entry.source)
      .filter((call) => alertButtons(call).length > 3)
      .map((call) => `${entry.name}: ${alertButtons(call).length} buttons`));

    expect(over).toEqual([]);
  });

  it('pairs every destructive alert action with a way out', () => {
    // Alerts: "If there's a destructive action, include a Cancel button to give
    // people a clear, safe way to avoid the action."
    const unsafe = files.flatMap((entry) => alertCalls(entry.source)
      .filter((call) => call.includes("style: 'destructive'") && !call.includes("style: 'cancel'"))
      .map(() => entry.name));

    expect(unsafe).toEqual([]);
  });

  it('mounts the action sheet host inside the overlay host', () => {
    // Without it `showActionSheet` degrades to the system dialog it replaced —
    // silently, and with Android's three-button cap back in force.
    const layout = file('app/_layout.tsx');
    const hostIndex = layout.indexOf('<ActionSheetHost />');
    const overlayOpen = layout.indexOf('<OverlayHost>');
    const overlayClose = layout.indexOf('</OverlayHost>');

    expect(hostIndex).toBeGreaterThan(overlayOpen);
    expect(hostIndex).toBeLessThan(overlayClose);
  });

  it('leads with destructive choices and keeps the caller order otherwise', () => {
    // Action sheets: "place these buttons at the top of the action sheet where
    // they tend to be most noticeable".
    const ordered = orderActionSheetActions([
      { label: 'Save draft' },
      { label: 'Discard', destructive: true },
      { label: 'Duplicate' },
    ]);

    expect(ordered.map((action) => action.label)).toEqual(['Discard', 'Save draft', 'Duplicate']);
  });

  it('claims Android back on every overlay-hosted surface', () => {
    // An overlay is an ordinary view; a Modal took the key natively and an
    // overlay has no such privilege, so a hosted sheet without this is a dead
    // end on Android (Modality: always an obvious way to dismiss).
    const unclaimed = files
      .filter((entry) => entry.name !== 'app/_layout.tsx')
      .filter((entry) => /<Overlay[\s>]/.test(entry.source))
      .filter((entry) => !entry.source.includes('useHardwareBack'))
      .map((entry) => entry.name);

    expect(unclaimed).toEqual([]);
  });

  it('dismisses every modal surface with the shared Close control', () => {
    // Toolbars: "Use the standard Back and Close buttons ... ensure you
    // consistently implement it throughout your app." A raw `X` on a control
    // labelled Close is the app drawing its own, at its own size.
    const rogue = files
      .filter((entry) => entry.name !== 'lib/platform-glyphs.ts')
      .flatMap((entry) => {
        const matches = entry.source.match(/accessibilityLabel="Close[^"]*"[\s\S]{0,600}?<(\w+)\s/g) ?? [];
        return matches
          .filter((block) => /<X\s/.test(block))
          .map(() => entry.name);
      });

    expect(rogue).toEqual([]);
  });

  it('never dismisses a modal route with a Back control', () => {
    // Sheets: "The Back button lets people navigate to a previous step in a
    // multi-step flow or to a parent view in a hierarchy. It isn't intended to
    // dismiss a sheet." Both of these arrived at a Back chevron on a view that
    // slides up from the bottom.
    const layout = file('app/_layout.tsx');
    // One entry per `<Stack.Screen …/>`, so a later screen's options cannot be
    // read as an earlier screen's.
    const modalRoutes = [...layout.matchAll(/<Stack\.Screen\b([\s\S]*?)\/>/g)]
      .filter((match) => /presentation: '(modal|fullScreenModal)'/.test(match[1]))
      .map((match) => match[1].match(/name="([^"]+)"/)?.[1] ?? '?');

    // Adding a modal route without settling its dismiss control fails here.
    expect(new Set(modalRoutes)).toEqual(new Set(['auth', 'edit-profile']));
    expect(file('app/auth.tsx')).not.toContain('BackGlyph');
    expect(file('components/edit-profile-screen.tsx')).not.toContain('BackGlyph');
    // The composer is a push by deliberate choice (DV7), but the step that
    // leaves it still closes with the shared Close control, not a bare glyph.
    expect(file('app/post/new.tsx')).toContain('<CloseGlyph');
  });

  it('pairs the sheet Done button with a Cancel, not a Back', () => {
    // Sheets: "If you provide a Done button, always pair it with a Cancel
    // button ... Relying solely on the Done button implies that completing the
    // task is the only way to exit the sheet."
    const editProfile = file('components/edit-profile-screen.tsx');

    expect(editProfile).toContain('accessibilityLabel="Cancel"');
    expect(editProfile).toContain('accessibilityLabel="Save profile"');
    expect(editProfile).toContain('<CloseGlyph');
  });

  it('asks every question through the app\u2019s own dialog, not the system one', () => {
    /**
     * `Alert.alert` is two surfaces wearing one name: iOS draws the dark card
     * with capsule buttons this app wants, Android draws Material's dialog —
     * square, left-aligned, upper-case buttons in the corner. Side by side the
     * builds stopped reading as the same product (Design principles:
     * "once you establish a behavior or appearance for an element, apply it
     * throughout"). `lib/dialog` owns that difference now, so a new call site
     * cannot reintroduce the generic box by reaching for `Alert` directly.
     */
    const callers = files
      .filter(({ source }) => /\bAlert\.alert\(/.test(source))
      .map(({ name }) => name);

    // `lib/action-sheet` keeps one: the degradation when no `ActionSheetHost`
    // is mounted, which only happens in a focused component test — and a sheet
    // can carry more buttons than a dialog has room for.
    expect(callers).toEqual(['lib/action-sheet.ts']);
  });

  it('mounts the one host every dialog is drawn by', () => {
    // Without it `showConfirmDialog` silently degrades to the system dialog on
    // Android, which is the thing this whole split exists to stop.
    const layout = file('app/_layout.tsx');
    expect(layout).toContain("import { DialogHost } from '@/components/dialog'");
    expect(layout).toContain('<DialogHost />');
  });

  it('leaves no menu or picker built out of an alert', () => {
    // The three that were: comment options, the visibility picker, and leaving
    // the composer with unsaved work.
    expect(file('components/comments-sheet.tsx')).not.toContain("Alert.alert('Comment options'");
    expect(file('lib/post-lifecycle.ts')).not.toContain("Alert.alert('Change visibility'");
    expect(file('lib/post-lifecycle.ts')).toContain('showActionSheet(');
    expect(file('app/post/new.tsx')).not.toContain("Alert.alert(\n      'Leave this post?'");
    expect(file('app/post/new.tsx')).toContain("title: 'Leave this post?'");
  });
});
