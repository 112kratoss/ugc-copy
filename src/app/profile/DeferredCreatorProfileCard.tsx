'use client';

import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

import { Button, StatusCallout } from '@/components/DesignSystem';
import type { EditableCreatorProfile } from '@/lib/profile';
import CreatorProfileCardFallback from './CreatorProfileCardFallback';

interface EditorProps {
  initialProfile: EditableCreatorProfile | null;
  loadError: string | null;
  collapseOptionalDetails?: boolean;
  hideIntro?: boolean;
}

interface DeferredCreatorProfileCardProps extends EditorProps {
  /**
   * What the page draws under the editor, drawn with the editor and never before it. The
   * placeholder is much shorter than the editor, and its height cannot be the editor's: that
   * depends on the account (a cover or none, the line under the handle) and on the editor's own
   * layout at each width. Drawn under the placeholder, Connected apps on /profile/edit stood at
   * y 830 of a 900px window, then the editor pushed it off the screen (live, 2026-11-17).
   */
  children?: ReactNode;
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

// React.lazy in a Suspense boundary of this file's own, not next/dynamic: dynamic draws its loading
// state in a boundary of its own, and what comes under the editor has to wait in the editor's.
const CreatorProfileCard = lazy(() => import('@/app/creations/CreatorProfileCard'));

/**
 * The editor's load can fail: a deploy rotated the chunk names while the tab was open, or the
 * connection was down as its code was asked for. React.lazy throws that to the nearest error
 * boundary, and `src/app` has none, so the page would give way to Next's generic
 * client-exception page, and with it what comes under the editor: Connected apps, the one place
 * to disconnect an agent. Kept here instead: a card says the editor did not load, with Try again,
 * and what comes under the editor is still drawn, under the card.
 *
 * Try again reloads the page, as Alerts' error card does: a reload fetches the chunk names of the
 * deployment that is live now. An in-place retry cannot work in production: after a deploy it asks
 * for the old name again, and Turbopack's runtime, which `next build` uses, keeps one loader per
 * chunk URL and hands a retry the same failed load (`chunkResolvers`). `next dev --webpack`, the
 * E2E server, retries, which is why a retry that renewed the lazy passed there (review of #841).
 */
class EditorBoundary extends Component<
  { editor: EditorProps; placeholder: ReactNode; children?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('Failed to load the profile editor:', error);
    // Caught here, it never reaches Next's own reportError, which is what Sentry hears: hand it
    // on as an uncaught one would be.
    window.reportError?.(error);
  }

  render() {
    const { editor, placeholder, children } = this.props;
    if (this.state.failed) {
      return (
        <>
          <StatusCallout
            tone="danger"
            title="The profile editor did not load."
            body="Try again reloads the page."
            action={(
              <Button variant="secondary" icon={RefreshCw} onClick={() => window.location.reload()}>
                Try again
              </Button>
            )}
          />
          {children}
        </>
      );
    }

    // The placeholder stays up until the editor can draw (the page was blank between the idle wait
    // and the code arriving), and whatever comes under the editor waits with it.
    return (
      <Suspense fallback={placeholder}>
        <CreatorProfileCard {...editor} />
        {children}
      </Suspense>
    );
  }
}

function useDeferredUntilIdle() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const idleWindow = window as IdleWindow;

    if (typeof idleWindow.requestIdleCallback === 'function') {
      const idleId = idleWindow.requestIdleCallback(() => setIsReady(true), {
        timeout: 1200,
      });

      return () => idleWindow.cancelIdleCallback?.(idleId);
    }

    const timeoutId = idleWindow.setTimeout(() => setIsReady(true), 650);
    return () => idleWindow.clearTimeout(timeoutId);
  }, []);

  return isReady;
}

export default function DeferredCreatorProfileCard({ children, ...editor }: DeferredCreatorProfileCardProps) {
  const isReady = useDeferredUntilIdle();
  const placeholder = <CreatorProfileCardFallback initialProfile={editor.initialProfile} loadError={editor.loadError} />;

  if (!isReady) {
    return placeholder;
  }

  return (
    <EditorBoundary editor={editor} placeholder={placeholder}>
      {children}
    </EditorBoundary>
  );
}
