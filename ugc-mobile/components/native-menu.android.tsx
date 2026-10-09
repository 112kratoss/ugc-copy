/**
 * Android: the ••• button stays the app's own, and a press opens the app's own
 * menu, grown out of that button (`components/anchored-menu.tsx`).
 * `lib/native-menu.ts` explains the arrangement; the iOS menu is
 * `native-menu.ios.tsx`.
 *
 * It was Material 3's dropdown through Expo UI until 2026-10-09. The binding in
 * the builds people hold (`@expo/ui` 55.0.17) passes that dropdown its fill
 * colour and nothing else: the popup keeps Material's 4dp corners, its shadow
 * and its motion, and a row is a line of text. The menus Material 3 Expressive
 * redrew are in the bundled Compose library but have no binding, so reaching
 * them takes native code and a store build. Drawn here instead, the menu ships
 * over the air and needs no native module at all, on any build.
 *
 * The menu is mounted only while it is open or closing, so a feed of cards
 * pays nothing for the menus nobody opened.
 */
import { useRef, useState } from 'react';
import { View } from 'react-native';

import { AnchoredMenu } from '@/components/anchored-menu';
import type { NativeMenuProps } from '@/components/native-menu-types';
import type { MenuRect } from '@/lib/anchored-menu-layout';
import { hasNativeMenuItems } from '@/lib/native-menu';

export type { NativeMenuProps, NativeMenuTrigger } from '@/components/native-menu-types';

export function NativeMenu(props: NativeMenuProps) {
  const buttonRef = useRef<View>(null);
  // The button's box as it was pressed. Set for as long as the menu is on
  // screen, which is a little longer than it is open: the exit plays first.
  const [anchor, setAnchor] = useState<MenuRect | null>(null);
  const [open, setOpen] = useState(false);

  if (!hasNativeMenuItems(props.model)) {
    return <View style={props.style}>{props.renderButton(props.onFallbackPress)}</View>;
  }

  const openMenu = () => {
    const button = buttonRef.current;
    if (!button?.measureInWindow) {
      props.onFallbackPress();
      return;
    }
    button.measureInWindow((x, y, width, height) => {
      // A box that cannot be read leaves nothing to grow a menu from: the
      // press opens the sheet it opened before menus rather than nothing.
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        props.onFallbackPress();
        return;
      }
      setAnchor({ x, y, width, height });
      setOpen(true);
    });
  };

  return (
    // Never flattened away: this view is what the press measures.
    <View ref={buttonRef} collapsable={false} style={props.style}>
      {props.renderButton(openMenu)}
      {anchor ? (
        <AnchoredMenu
          anchor={anchor}
          model={props.model}
          open={open}
          accessibilityLabel={props.accessibilityLabel}
          onDismiss={() => setOpen(false)}
          onExited={() => setAnchor(null)}
        />
      ) : null}
    </View>
  );
}
