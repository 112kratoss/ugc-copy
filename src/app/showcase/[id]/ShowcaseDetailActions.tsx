'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';

import type { PostLifecyclePatch, PostLifecycleTarget } from '@/components/usePostLifecycle';
import type { PostVisibility } from '@/lib/post-lifecycle-client';

import { PostPagePartBoundary } from './PostPagePartBoundary';

/**
 * What the tools open onto, loaded with import() once the session check names the creator: never
 * for anyone else, and never in the server's HTML, which holds the row alone (review of #838).
 * Nothing stands in for it while it loads: the row is closed until the creator opens it. Loaded
 * here alone: Turbopack builds a `dynamic()` import and a plain import() of the same file into two
 * chunks holding the same modules, so a second, plain preload would fetch them twice.
 */
const ShowcaseOwnerToolsMenu = dynamic(() => import('./ShowcaseOwnerToolsMenu'), { ssr: false });

/**
 * In the tools' place when their load failed (`PostPagePartBoundary`): the lazy keeps the failure
 * until a reload, which fetches the chunk names of the deployment live now.
 */
function OwnerToolsDidNotLoad() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/8 px-5 pb-4 pt-3 sm:px-6">
      <p className="text-sm text-rose-200">The Owner tools did not load.</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="ui-focus-ring inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        Reload page
      </button>
    </div>
  );
}

/**
 * The creator's Owner tools, by what the page knows of who is looking (`ownership` in
 * `useShowcasePostViewer`): `ready` once the session check names the creator; `checking` while the
 * browser's session cookie names them and the check has not ended; `unread` in the server's HTML
 * and the render that hydrates it, shown only where the root element names the creator (the
 * page's rule for `data-post-owner-tools`). Until `ready` they are their row alone, inert: what it
 * opens onto (the edit links, the visibility menu, Archive and Delete) acts with the session, and
 * the server's HTML is every visitor's and every crawler's.
 */
export type ShowcaseOwnerTools = 'ready' | 'checking' | 'unread';

interface ShowcaseDetailActionsProps {
  postId: string;
  generationId: string | null;
  title: string;
  creatorUsername: string | null;
  visibility: 'public' | 'unlisted';
  /** Null for anyone but the post's creator. */
  ownerTools: ShowcaseOwnerTools | null;
  /** The creator's account, which marks `unread` tools for the page's rule. */
  ownerToolsMark?: string | null;
  hasResourceBundle: boolean;
  /** The owner's bundle, so lifecycle policy can see what a change affects. */
  bundle?: PostLifecycleTarget['bundle'];
}

export default function ShowcaseDetailActions({
  postId,
  generationId,
  title,
  creatorUsername,
  visibility,
  ownerTools,
  ownerToolsMark = null,
  hasResourceBundle,
  bundle = null,
}: ShowcaseDetailActionsProps) {
  // The page is server-rendered for the visibility it was opened at; this
  // mirror lets the menu move first and the refresh catch up.
  const [ownerVisibility, setOwnerVisibility] = useState<PostVisibility>(visibility);
  const [ownerBundleStatus, setOwnerBundleStatus] = useState(bundle?.status ?? null);

  const handleLifecyclePatch = useCallback((_patchedPostId: string, patch: PostLifecyclePatch) => {
    if (patch.visibility !== undefined) {
      setOwnerVisibility(patch.visibility);
    }
    if (patch.bundleStatus !== undefined) {
      setOwnerBundleStatus(patch.bundleStatus);
    }
  }, []);

  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        {creatorUsername ? (
          <Link
            href={`/creators/${creatorUsername}`}
            className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-semibold text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
          >
            View creator
          </Link>
        ) : null}

        <Link
          href="/create"
          className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/45 hover:bg-emerald-500/15"
        >
          <Sparkles className="h-4 w-4" />
          Create your own
        </Link>
      </div>

      {ownerTools ? (
        // Chrome-less: the rail card already draws the border, so a nested
        // card here would inset this row from every other one. Drawn as they
        // stay from the first frame, and inert while the session is checked:
        // closed, they cannot be opened, nor act without it. Their gap is their
        // own (`mt-4`): hidden in the server's HTML from anyone but the creator,
        // they must leave the buttons above as they are (a `space-y` parent
        // spaced the buttons from them even then).
        <details
          className="group -mx-5 -mb-5 mt-4 border-t border-white/8 sm:-mx-6 sm:-mb-6"
          inert={ownerTools !== 'ready'}
          data-post-owner-tools={ownerTools === 'unread' && ownerToolsMark ? ownerToolsMark : undefined}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3.5 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.03] sm:px-6 [&::-webkit-details-marker]:hidden">
            <span>Owner tools</span>
            <span className="text-xs font-medium text-zinc-500 group-open:hidden">Edit, visibility, archive</span>
            <span className="hidden text-xs font-medium text-zinc-500 group-open:inline">Hide tools</span>
          </summary>
          {/*
            * What the row opens onto comes with the session, never before: closed, the row draws
            * the same either way, and the server's HTML, every visitor's and every crawler's, held
            * the edit links, the menu and the actions on every post (review of #838).
            */}
          {ownerTools === 'ready' ? (
            <PostPagePartBoundary part="the Owner tools" fallback={<OwnerToolsDidNotLoad />}>
              <ShowcaseOwnerToolsMenu
                postId={postId}
                generationId={generationId}
                title={title}
                hasResourceBundle={hasResourceBundle}
                bundle={bundle && ownerBundleStatus ? { ...bundle, status: ownerBundleStatus } : bundle}
                ownerVisibility={ownerVisibility}
                onPatch={handleLifecyclePatch}
              />
            </PostPagePartBoundary>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
