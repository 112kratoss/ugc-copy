'use client';

import { Component, type ReactNode } from 'react';

interface SignedInAlertsBoundaryProps {
  /** What stands where the half was once its load has failed. */
  fallback: ReactNode;
  children: ReactNode;
}

/**
 * The signed-in half loads with import() once a reader is known, and that load
 * can fail: a deploy rotated the chunk names while the tab was open and the
 * reader then signed in, or the connection was down at that moment. React.lazy
 * throws the failure to the nearest error boundary, and src/app has none, so
 * the reader got Next's generic client-exception page in place of the list.
 * This boundary keeps the failure to the half: the page draws its own error
 * card, whose Retry reloads the page and so fetches the current chunk names.
 */
export class SignedInAlertsBoundary extends Component<SignedInAlertsBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('Failed to load the signed-in half of Alerts:', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
