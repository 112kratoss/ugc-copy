/**
 * Android: the ••• button stays the app's own, and a press opens Material 3's
 * dropdown anchored to it, which grows out of the button's corner the way the
 * platform's overflow menus do. `lib/native-menu.ts` explains the arrangement;
 * the iOS menu is `native-menu.ios.tsx`.
 *
 * The dropdown's host is mounted only while the menu is open or closing, so a
 * feed of cards pays nothing for the menus nobody opened.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { NativeMenuProps } from '@/components/native-menu-types';
import { toAndroidColor } from '@/lib/android-color';
import { useResolvedColorScheme } from '@/lib/appearance';
import { hasNativeMenuItems, nativeMenuRows, type NativeMenuAction } from '@/lib/native-menu';
import { isNativeMenuAvailable } from '@/lib/native-menu-available';
import { appTheme, themes } from '@/lib/theme';

export type { NativeMenuProps, NativeMenuTrigger } from '@/components/native-menu-types';

/** Longer than Material's menu exit (75 ms), so the host outlives the animation. */
const MENU_EXIT_MS = 250;

type ComposeModules = {
  ui: typeof import('@expo/ui/jetpack-compose');
  modifiers: typeof import('@expo/ui/jetpack-compose/modifiers');
};

let compose: ComposeModules | undefined;

/**
 * Required on first use rather than imported: the package requires its native
 * views as it loads, and a binary without them must never evaluate it.
 */
function loadCompose(): ComposeModules {
  compose ??= {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ui: require('@expo/ui/jetpack-compose') as typeof import('@expo/ui/jetpack-compose'),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    modifiers: require('@expo/ui/jetpack-compose/modifiers') as typeof import('@expo/ui/jetpack-compose/modifiers'),
  };
  return compose;
}

export function NativeMenu(props: NativeMenuProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), MENU_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  if (!isNativeMenuAvailable() || !hasNativeMenuItems(props.model)) {
    return <View style={props.style}>{props.renderButton(props.onFallbackPress)}</View>;
  }

  const openMenu = () => {
    setMounted(true);
    setOpen(true);
  };

  return (
    <View style={props.style}>
      {props.renderButton(openMenu)}
      {mounted ? (
        <MaterialDropdown
          open={open}
          props={props}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}

function MaterialDropdown({ open, props, onDismiss }: { open: boolean; props: NativeMenuProps; onDismiss: () => void }) {
  // A menu is app UI: it follows the app's scheme even from the reel, which
  // stays dark (see `AppSchemeScope`). Android parses each colour itself, so
  // every one goes through `toAndroidColor`.
  const { colors } = themes[useResolvedColorScheme()];
  const { ui, modifiers } = loadCompose();
  const { Column, DropdownMenu, DropdownMenuItem, Host, HorizontalDivider, Text } = ui;

  const choose = (action: NativeMenuAction) => {
    onDismiss();
    action.onSelect();
  };

  return (
    // The dropdown anchors to its host, which covers the button exactly; the
    // host takes no touches, so the button underneath keeps them. The popup is
    // a window of its own and takes its own.
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Host style={StyleSheet.absoluteFill}>
        <DropdownMenu
          expanded={open}
          onDismissRequest={onDismiss}
          color={toAndroidColor(colors.panel)}
          modifiers={[modifiers.fillMaxSize()]}
        >
          <DropdownMenu.Items>
            {nativeMenuRows(props.model).map((row) => {
              if (row.kind === 'divider') return <HorizontalDivider key={row.id} color={toAndroidColor(colors.border)} />;
              const { action } = row;
              const labelColor = action.disabled
                ? colors.faint
                : action.destructive
                  ? colors.danger
                  : colors.text;
              return (
                <DropdownMenuItem
                  key={action.id}
                  enabled={!action.disabled}
                  onClick={() => choose(action)}
                >
                  <DropdownMenuItem.Text>
                    <Column>
                      <Text color={toAndroidColor(labelColor)} style={{ fontSize: appTheme.type.body.fontSize }}>
                        {action.checked ? `✓  ${action.label}` : action.label}
                      </Text>
                      {action.subtitle ? (
                        <Text color={toAndroidColor(colors.muted)} style={{ fontSize: appTheme.type.caption.fontSize }}>
                          {action.subtitle}
                        </Text>
                      ) : null}
                    </Column>
                  </DropdownMenuItem.Text>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenu.Items>
        </DropdownMenu>
      </Host>
    </View>
  );
}
