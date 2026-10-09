/**
 * Off the phones — the test runner, and the web — a ••• button does what it
 * did before menus: `onFallbackPress` opens the caller's sheet. The iOS menu is
 * `native-menu.ios.tsx` and Android's is `native-menu.android.tsx`;
 * `lib/native-menu.ts` explains the arrangement.
 */
import { View } from 'react-native';

import type { NativeMenuProps } from '@/components/native-menu-types';

export type { NativeMenuProps, NativeMenuTrigger } from '@/components/native-menu-types';

export function NativeMenu({ onFallbackPress, renderButton, style }: NativeMenuProps) {
  return <View style={style}>{renderButton(onFallbackPress)}</View>;
}
