import { Platform, StatusBar } from 'react-native';

const ANDROID_STATUS_BAR_FALLBACK = 24;
const ANDROID_NAV_BAR_FALLBACK = 48;
const MAX_TOP_SAFE_AREA = 64;
const MAX_BOTTOM_SAFE_AREA = 80;

function clampInset(value: number, max: number) {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), max) : 0;
}

export function resolvedTopInset(inset: number) {
  if (Platform.OS !== 'android') {
    return clampInset(inset, MAX_TOP_SAFE_AREA);
  }

  return clampInset(Math.max(inset, StatusBar.currentHeight ?? ANDROID_STATUS_BAR_FALLBACK), MAX_TOP_SAFE_AREA);
}

export function resolvedBottomInset(inset: number) {
  if (Platform.OS !== 'android') {
    return clampInset(inset, MAX_BOTTOM_SAFE_AREA);
  }

  return clampInset(Math.max(inset, ANDROID_NAV_BAR_FALLBACK), MAX_BOTTOM_SAFE_AREA);
}
