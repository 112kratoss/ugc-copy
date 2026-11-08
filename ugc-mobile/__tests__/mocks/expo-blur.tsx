import React from 'react';

/**
 * Test double for `expo-blur`, which vitest cannot parse from its published source. The
 * email sign-in form blurs the wall behind it on iOS (`app/auth.tsx`); the view renders as
 * a host `blur-view` element with its props intact.
 */
type MockProps = Record<string, unknown> & { children?: React.ReactNode };

export function BlurView({ children, ...props }: MockProps) {
  return React.createElement('blur-view', props, children);
}
