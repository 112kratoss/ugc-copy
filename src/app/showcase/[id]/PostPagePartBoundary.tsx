'use client';

import { Component, type ReactNode } from 'react';

interface PostPagePartBoundaryProps {
  /** What failed, for the log: "the Owner tools". */
  part: string;
  /** What stands in the part's place once its load has failed. */
  fallback: ReactNode;
  children: ReactNode;
}

/**
 * A part of a post's page that loads with import() when it is drawn (`next/dynamic`): the not-found
 * notice a block draws, the invite hand-off bar, the creator's Owner tools. Its load can fail: a
 * deploy renamed the chunk while the page was open, or the connection dropped. `next/dynamic` is a
 * React.lazy in a Suspense with nothing to catch that, so the failure reached the showcase folder's
 * error.tsx, which put "Could not load Explore" in the place of the post, and its Retry met the same
 * failure at once: the lazy keeps it until a reload. Kept to the part here, as Alerts' signed-in half
 * keeps its own (`SignedInAlertsBoundary`): each use says what stands in its place.
 */
export class PostPagePartBoundary extends Component<PostPagePartBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`Failed to load ${this.props.part}:`, error);
    // Caught here, it never reaches Next's own reportError, which is what Sentry hears: hand it on,
    // as an uncaught one would be.
    window.reportError?.(error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
