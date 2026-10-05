import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { leaveTouchToNativeView, touchBelongsToNativeView } from '../lib/native-touch-owner';
import { createResponderHost, HostView, type RendererBuild, type ResponderHost } from './mocks/react-native-responder-host';

type TouchEvent = Parameters<typeof touchBelongsToNativeView>[0];

/**
 * A touch on a player's own controls, taken through React Native's responder
 * system itself: the renderer that ships, over a stand-in native side.
 *
 * On Android, expo-video's view tells JS when a touch on it begins. For a
 * touch on the seek bar it never says that the touch ended: Media3's time bar
 * asks its parents not to intercept, and the view reports from its intercept
 * hook. Whatever took that touch-down for JS is then left holding it, and
 * React asks nothing below a holder about the next touch. Inside a Modal the
 * taker was React Native's own Modal host, which takes every touch-down that
 * reaches it: after a drag of the seek bar the next press on a button of the
 * sheet did nothing, and the one after it worked (Pixel 9a emulator,
 * 2026-10-05; the same in the result sheet and the lightbox). On a page the
 * taker was the scroll view, while the keyboard was up.
 */
describe.each<RendererBuild>(['production', 'development'])('a touch on a native player, in React Native’s %s renderer', (build) => {
  let host: ResponderHost | undefined;
  afterEach(() => {
    host?.unmount();
    host = undefined;
  });

  /** A Modal's host over a sheet's panel, which holds a player and a close button. */
  function mountSheet(player: object, panel: object = {}) {
    const answered: string[] = [];
    const mounted = createResponderHost(build);
    host = mounted;
    mounted.mount(
      // React Native's Modal: `onStartShouldSetResponder={this._shouldSetResponder}`, which always says yes.
      <HostView testID="modal-host" onStartShouldSetResponder={() => true}>
        <HostView testID="panel" {...panel}>
          <HostView testID="player" {...player} />
          {/* A button: it takes the touch that lands on it, and answers when the finger lifts. */}
          <HostView testID="close" onStartShouldSetResponder={() => true} onResponderRelease={() => answered.push('close')} />
        </HostView>
      </HostView>,
    );
    const press = (testID: string) => {
      mounted.touch('start', testID);
      mounted.touch('end', testID);
    };
    return { host: mounted, answered, press };
  }

  it('loses the next press when the player only declines its touch: the Modal’s host is left holding it', () => {
    const sheet = mountSheet({ onStartShouldSetResponder: () => false });
    // A drag of the seek bar, as JS hears it: a start, and nothing after.
    sheet.host.touch('start', 'player');
    expect(sheet.host.responder()).toBe('modal-host');

    sheet.press('close');
    expect(sheet.answered).toEqual([]);
    // That press's end let the holder go, so the second one is heard.
    sheet.press('close');
    expect(sheet.answered).toEqual(['close']);
  });

  it('leaves nothing holding the touch once the player stops the question at itself, so the next press is heard', () => {
    const sheet = mountSheet({ onStartShouldSetResponder: leaveTouchToNativeView });
    sheet.host.touch('start', 'player');
    expect(sheet.host.responder()).toBeNull();

    sheet.press('close');
    expect(sheet.answered).toEqual(['close']);
  });

  it('stops only the question: the touch itself is still told to the views above', () => {
    const heard: string[] = [];
    const sheet = mountSheet(
      { onStartShouldSetResponder: leaveTouchToNativeView },
      // A scroll view counts the fingers on it this way, and the workspace menu watches for its edge swipe.
      { onTouchStart: () => heard.push('start'), onTouchEnd: () => heard.push('end') },
    );
    sheet.host.touch('start', 'player');
    sheet.host.touch('end', 'player');
    expect(heard).toEqual(['start', 'end']);
  });

  it('still has the views above asked about that touch at each move, and lets them know it for the player’s', () => {
    const asked: boolean[] = [];
    const sheet = mountSheet(
      { onStartShouldSetResponder: leaveTouchToNativeView },
      {
        onMoveShouldSetResponderCapture: (event: TouchEvent) => {
          asked.push(touchBelongsToNativeView(event));
          return false;
        },
      },
    );
    sheet.host.touch('start', 'player');
    sheet.host.touch('move', 'player', { y: 12 });
    sheet.host.touch('end', 'player');
    expect(asked).toEqual([true]);

    // A touch that begins on something else in the panel is not the player's.
    sheet.host.touch('start', 'close');
    sheet.host.touch('move', 'close', { y: 12 });
    sheet.host.touch('end', 'close');
    expect(asked).toEqual([true, false]);
  });
});
