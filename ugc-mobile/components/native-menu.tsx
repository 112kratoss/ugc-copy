/**
 * Where Expo UI does not run — the test runner, and the web — a ••• button does
 * what it did before native menus: `onFallbackPress` opens the caller's sheet.
 * The native menus are `native-menu.ios.tsx` and `native-menu.android.tsx`;
 * `lib/native-menu.ts` explains the arrangement.
 */
import { View } from 'react-native';

import type { NativeMenuProps } from '@/components/native-menu-types';

export type { NativeMenuProps, NativeMenuTrigger } from '@/components/native-menu-types';

export function NativeMenu({ onFallbackPress, renderButton, style }: NativeMenuProps) {
  return <View style={style}>{renderButton(onFallbackPress)}</View>;
}
