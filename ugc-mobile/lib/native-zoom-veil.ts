import type { Animated } from 'react-native';

type Opacity = Animated.AnimatedInterpolation<number>;
let binding: Opacity | null = null;
let active = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function bindNativeZoomVeil(opacity: Opacity) {
  binding = opacity;
  return () => {
    if (binding !== opacity) return;
    binding = null;
    active = false;
    notify();
  };
}

export function activateNativeZoomVeil() {
  if (!binding) return false;
  active = true;
  notify();
  return true;
}

export function resetNativeZoomVeil() {
  active = false;
  notify();
}

export function getNativeZoomVeilOpacity() {
  return active ? binding : null;
}

export function subscribeToNativeZoomVeil(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
