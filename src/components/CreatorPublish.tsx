'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, CircleAlert, Download, Film, Globe, Image as ImageIcon, Loader2, Lock, Music, X } from 'lucide-react';
import clsx from 'clsx';

import PostCommentAvatar from '@/components/PostCommentAvatar';
import PublicIdentityFields from '@/components/PublicIdentityFields';
import PublicShareButton from '@/components/PublicShareButton';
import { CREATOR_BAR_PRIMARY_CLASS, CREATOR_NOTE_LINK_CLASS, creditsWords } from '@/components/CreatorColumn';
import { getAccentClasses, StatusCallout } from '@/components/DesignSystem';
import { usePublishCreation, type PublishCreationDraft, type PublishedCreation } from '@/components/usePublishCreation';
import { fetchCreationPublishDetails, type CreationPublishDetails } from '@/lib/creation-publish-details';
import { TITLE_MAX_LENGTH } from '@/lib/post-limits';
import { buildCreatorProfilePath, getCreatorDisplayName } from '@/lib/profile';
import type { GenerationShareSourceSurface } from '@/lib/share';
import { buildShowcaseDetailPath } from '@/lib/share';
import { openCreditTopUp } from '@/lib/credit-top-up';
// The posting defaults and their words, one copy with both composers (remix plan, phase 2).
import {
  ALLOW_REMIXES_DETAIL,
  ALLOW_REMIXES_LABEL,
  CREATION_INPUTS_ALL_REMOVED,
  CREATION_RECIPE_FILES_LINE,
  DEFAULT_PAID_RECIPE_PRICE_CREDITS,
  describePutRemovedInputsBack,
  PAID_RECIPE_RESALE_LINE,
  type GenerationReference,
  type OwnSourceRecipe,
} from '../../ugc-mobile/lib/creation-recipe/creation-recipe';

/**
 * Publishing on the canvas (the artboards Result and Posted, owner 2026-10-28): when a run is
 * done the canvas shows the result, its download and the publish form beside it, where the
 * Publish window used to open; once posted, the form gives way to what was posted and where
 * it went. On a phone a bar holds Publish at the foot of the window while the form's own
 * button is out of view. The form draws `usePublishCreation`; Studio and template runs open
 * the full composer instead.
 */

// ---------------------------------------------------------------------------------------------
// What the form starts from

/** After a failed read, how long the one more try waits; Publish waits with it. */
const DETAILS_RETRY_DELAY_MS = 1_500;

/**
 * The creation's publish details, read once its run is done (`fetchCreationPublishDetails`):
 * `undefined` while they are being read, null when they could not be, after one more try
 * (the post still goes, as the media alone), and keyed by the creation, so a later run never
 * shows an earlier one's.
 */
export function useCreationPublishDetails(
  generationId: string | null,
  accessToken: string | null | undefined,
): CreationPublishDetails | null | undefined {
  const [read, setRead] = useState<{ generationId: string; details: CreationPublishDetails | null } | null>(null);

  useEffect(() => {
    if (!generationId) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const readDetails = (triesLeft: number) => {
      void fetchCreationPublishDetails(generationId, accessToken, controller.signal).then((details) => {
        if (controller.signal.aborted) return;
        if (!details && accessToken && triesLeft > 0) {
          retry = setTimeout(() => readDetails(triesLeft - 1), DETAILS_RETRY_DELAY_MS);
          return;
        }
        // A token renewed meanwhile reads them again; a read that failed keeps what an earlier one found.
        setRead((current) => (current?.generationId === generationId && current.details && !details ? current : { generationId, details }));
      });
    };
    readDetails(1);
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [generationId, accessToken]);

  if (!generationId) return null;
  return read?.generationId === generationId ? read.details : undefined;
}

/** The post a remix was made from, as its credit names it: the title and the creator. */
export type RemixOriginal = {
  postId: string;
  title: string;
  creator: { id: string; username: string; name: string; avatar: string | null };
};

/** What the form learns of a remix's original (`useRemixOriginal`). */
export type RemixOriginalRead = {
  /** Someone else's post the remix was made from, credited in the form; null for one's own, or unread. */
  original: RemixOriginal | null;
  /**
   * The recipe of the creator's own post the creation remixed (owner, 2026-11-06, "Start Paid,
   * can switch"): a paid one starts the new post's recipe Paid at its price, which the creator may
   * make Free. Null where the creation is no remix of a post, where the original is someone else's
   * (whose terms the run carries, `remixRecipeMode`) or where it has no recipe. An original that
   * could not be read counts as paid at the starting price, so a recipe the creator sells never
   * goes out free by default. Undefined while it is read.
   */
  ownRecipe: OwnSourceRecipe | null | undefined;
};

const NOT_A_REMIX: RemixOriginalRead = { original: null, ownRecipe: null };

/** What an original that could not be read counts as: a recipe the creator sells starts paid. */
const UNREAD_ORIGINAL_RECIPE: OwnSourceRecipe = { accessMode: 'paid', priceCredits: DEFAULT_PAID_RECIPE_PRICE_CREDITS };

/** How long the original's read may take before it counts as unread (the recipe then starts paid). */
const REMIX_ORIGINAL_TIMEOUT_MS = 5_000;

type RemixOriginalPost = RemixOriginal & { recipe: 'free' | 'paid' | null; priceCredits: number };

/** The original as `/api/showcase/posts/[postId]` answers it, or null where it does not say who made it. */
function readRemixOriginalPost(payload: unknown): RemixOriginalPost | null {
  const item = (payload as { item?: { id?: unknown; title?: unknown; creator?: Record<string, unknown> | null; asset?: { accessMode?: unknown; priceUsdCents?: unknown } | null } } | null)?.item;
  const creator = item?.creator;
  if (!item || typeof item.id !== 'string' || !creator || typeof creator.id !== 'string' || typeof creator.username !== 'string' || !creator.username) {
    return null;
  }
  return {
    postId: item.id,
    title: typeof item.title === 'string' ? item.title.trim() : '',
    creator: {
      id: creator.id,
      username: creator.username,
      name: getCreatorDisplayName({ name: typeof creator.name === 'string' ? creator.name : null, username: creator.username }),
      avatar: typeof creator.avatar === 'string' && creator.avatar ? creator.avatar : null,
    },
    recipe: item.asset?.accessMode === 'paid' ? 'paid' : item.asset?.accessMode === 'free' ? 'free' : null,
    // A count of credits, as `price_usd_cents` stores it.
    priceCredits: typeof item.asset?.priceUsdCents === 'number' && Number.isFinite(item.asset.priceUsdCents)
      ? Math.round(item.asset.priceUsdCents)
      : 0,
  };
}

/**
 * The original of a remix opened from a post (`?remixPost=`), read from its public page
 * (`/api/showcase/posts/[postId]`) as soon as the page opens, so a finished run never waits
 * for it. Its credit and Follow are for someone else's post; the recipe of one's own sets where
 * the new post's recipe starts.
 */
export function useRemixOriginal(
  remixPostId: string | null | undefined,
  accessToken: string | null | undefined,
  viewerUserId: string | null | undefined,
): RemixOriginalRead {
  const [read, setRead] = useState<{ postId: string; post: RemixOriginalPost | null } | null>(null);

  useEffect(() => {
    if (!remixPostId || !accessToken) return;
    const controller = new AbortController();
    // Publish waits for this answer, so one that does not come in time counts as unread.
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REMIX_ORIGINAL_TIMEOUT_MS);
    const keep = (post: RemixOriginalPost | null) => {
      clearTimeout(timeout);
      if (controller.signal.aborted && !timedOut) return;
      // A token renewed meanwhile reads it again; a read that failed keeps what an earlier one found.
      setRead((current) => (current?.postId === remixPostId && current.post && !post ? current : { postId: remixPostId, post }));
    };
    void fetch(`/api/showcase/posts/${encodeURIComponent(remixPostId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    })
      .then(async (response) => keep(response.ok ? readRemixOriginalPost(await response.json()) : null))
      .catch(() => keep(null));
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [remixPostId, accessToken]);

  if (!remixPostId) return NOT_A_REMIX;
  if (read?.postId !== remixPostId) {
    // Without a session nothing is read, and a publish could not go either.
    return { original: null, ownRecipe: accessToken ? undefined : UNREAD_ORIGINAL_RECIPE };
  }
  const post = read.post;
  if (!post) return { original: null, ownRecipe: UNREAD_ORIGINAL_RECIPE };
  const own = post.creator.id === viewerUserId;
  return {
    original: own ? null : { postId: post.postId, title: post.title, creator: post.creator },
    ownRecipe: own && post.recipe ? { accessMode: post.recipe, priceCredits: post.priceCredits } : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Follow, from the credit

type FollowState = { key: string; following: boolean };

/**
 * Whether the viewer follows a creator, and the press that changes it, as the post page and
 * the reel ask it (`/api/profile/follow`): drawn once the answer is in, optimistic on press,
 * put back with a word when the server refuses. Kept per viewer and creator, so another
 * account's answer is never drawn.
 */
function useCreatorFollow(creatorId: string | null, accessToken: string | null | undefined, viewerUserId: string | null | undefined) {
  const [state, setState] = useState<FollowState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = creatorId ? `${viewerUserId ?? ''}:${creatorId}` : null;

  useEffect(() => {
    if (!creatorId || !key || !accessToken) return;
    const controller = new AbortController();
    void fetch(`/api/profile/follow?${new URLSearchParams({ followingId: creatorId })}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as { following?: unknown };
        if (!controller.signal.aborted) setState({ key, following: data.following === true });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [creatorId, key, accessToken]);

  const following = state && state.key === key ? state.following : null;

  const toggle = async () => {
    if (!creatorId || !key || !accessToken || following === null || pending) return;
    const next = !following;
    setState({ key, following: next });
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/profile/follow', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ followingId: creatorId, following: next }),
      });
      if (!response.ok) throw new Error('Failed to update follow state');
      const data = await response.json() as { following?: unknown };
      setState({ key, following: typeof data.following === 'boolean' ? data.following : next });
    } catch {
      setState({ key, following: !next });
      setError('Could not update follow. Try again.');
    } finally {
      setPending(false);
    }
  };

  return { following, pending, error, toggle };
}

type CreatorFollow = ReturnType<typeof useCreatorFollow>;

/**
 * The original, credited (owner, 2026-10-28, "Credit it in the form"): "Remix of “intense” by
 * @fluffy" with Follow, and that they were told. Their alert went out when the remix finished
 * (`notifyCompletedRemix`), not when it is posted, so the words never promise one at publish.
 */
function CreatorRemixCredit({
  original,
  follow,
  remixableRecipe = null,
}: {
  original: RemixOriginal;
  /** One per panel, so the form's answer is the one Posted draws (`useCreatorFollow`). */
  follow: CreatorFollow;
  /**
   * On Posted: the recipe this one went out with, free or paid, while remixes of it are allowed,
   * so remixes of this one go on; null for none, or remixes off (#711's review).
   */
  remixableRecipe?: 'free' | 'paid' | null;
}) {
  const handle = `@${original.creator.username}`;
  const profileHref = buildCreatorProfilePath(original.creator.username);
  return (
    <div className="flex items-center gap-3 rounded-ui-lg bg-[var(--ui-surface-2)] px-3 py-2.5">
      <PostCommentAvatar avatarUrl={original.creator.avatar} name={original.creator.name} size={32} />
      <div className="min-w-0 flex-1 text-xs leading-5 text-[var(--ui-text-muted)]">
        <p className="text-sm font-semibold leading-5 text-[var(--ui-text-primary)] [overflow-wrap:anywhere]">
          Remix of {original.title ? `“${original.title}”` : 'a post'} by{' '}
          <Link href={profileHref} className="ui-focus-ring rounded-lg underline-offset-4 hover:underline">{handle}</Link>
        </p>
        <p>
          {handle} was told when your remix finished.
          {remixableRecipe === 'free'
            ? ' Your recipe is free, so others can remix yours too.'
            : remixableRecipe === 'paid'
              ? ' Your recipe is paid: whoever buys it can remix yours too.'
              : ''}
        </p>
        {follow.error ? <p role="alert" className="text-[var(--ui-accent-danger)]">{follow.error}</p> : null}
      </div>
      {follow.following !== null ? (
        <button
          type="button"
          onClick={() => void follow.toggle()}
          disabled={follow.pending}
          aria-pressed={follow.following}
          aria-label={`${follow.following ? 'Following' : 'Follow'} ${handle}`}
          className="ui-button ui-button-secondary ui-focus-ring min-h-12 shrink-0 px-4 disabled:opacity-70"
        >
          {follow.following ? <Check aria-hidden className="h-4 w-4" /> : null}
          {follow.following ? 'Following' : 'Follow'}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The layout of Done

/**
 * The result and what to do with it: side by side where the canvas has room for both, one
 * under the other where it does not (the mock-up's round 4: the form squeezed to 76–236px
 * between 1120 and 1340px of window). A tall result fits beside the form from about 1340px
 * of window; a wide one, which beside the form would be a strip, only on a far wider canvas.
 */
export function CreatorDoneLayout({
  ratio,
  media,
  mediaFoot,
  panel,
}: {
  /**
   * The result's shape as the run asked for it (width / height), until the result's own is
   * read from its clip or picture; null where the run did not say (a motion clip takes its
   * reference's, "auto").
   */
  ratio: number | null;
  media: ReactNode;
  /** Under the result: Download, and the options' line. */
  mediaFoot?: ReactNode;
  panel: ReactNode;
}) {
  const mediaRef = useRef<HTMLDivElement>(null);
  const [ownRatio, setOwnRatio] = useState<number | null>(null);

  useEffect(() => {
    const cell = mediaRef.current;
    if (!cell) return;
    // Neither event bubbles, so they are heard on the way down.
    const read = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLVideoElement && target.videoWidth > 0 && target.videoHeight > 0) {
        setOwnRatio(target.videoWidth / target.videoHeight);
      } else if (target instanceof HTMLImageElement && target.naturalWidth > 0 && target.naturalHeight > 0) {
        setOwnRatio(target.naturalWidth / target.naturalHeight);
      }
    };
    cell.addEventListener('loadedmetadata', read, true);
    cell.addEventListener('load', read, true);
    return () => {
      cell.removeEventListener('loadedmetadata', read, true);
      cell.removeEventListener('load', read, true);
    };
  }, []);

  // Wider than tall, or not known: beside the form it would be a strip, so it stays above it longer.
  const wide = (ownRatio ?? ratio ?? 16 / 9) > 1.05;
  return (
    <div data-testid="creator-done-layout" data-shape={wide ? 'wide' : 'tall'} className="@container w-full min-w-0">
      <div
        className={clsx(
          'grid w-full grid-cols-1 items-start gap-5',
          wide
            ? '@min-[60rem]:grid-cols-[minmax(0,1fr)_minmax(22rem,26rem)]'
            : '@min-[37rem]:grid-cols-[minmax(12rem,18rem)_minmax(21rem,1fr)]',
        )}
      >
        <div ref={mediaRef} className="flex min-w-0 flex-col items-center gap-3">
          {media}
          {mediaFoot ? <div className="w-full">{mediaFoot}</div> : null}
        </div>
        <div className="min-w-0">{panel}</div>
      </div>
    </div>
  );
}

/**
 * Download under the result, as the artboard has it: the whole width, the file's own name;
 * `iconOnly` beside the phone bar's Publish, its words its name.
 */
export function CreatorDownloadButton({ href, fileName, label, newTab = false, iconOnly = false }: {
  href: string;
  fileName: string;
  label: string;
  newTab?: boolean;
  iconOnly?: boolean;
}) {
  return (
    <a
      href={href}
      download={fileName}
      {...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      aria-label={iconOnly ? label : undefined}
      className={clsx('ui-button ui-button-secondary ui-focus-ring', iconOnly ? 'h-12 w-12 shrink-0 p-0' : 'w-full')}
    >
      <Download aria-hidden className="h-4 w-4" />
      {iconOnly ? null : label}
    </a>
  );
}

// ---------------------------------------------------------------------------------------------
// The form

const FIELD_CLASS =
  'w-full rounded-ui-lg border border-[var(--ui-border-strong)] bg-[var(--ui-surface-inset)] px-4 py-3 text-sm text-[var(--ui-text-primary)] transition-colors placeholder:text-[var(--ui-text-faint)] focus:border-[var(--ui-focus)] focus:outline-none';

/** No file in the recipe: every one was removed from a creation with no prompt. */
const NO_RECIPE_FILES: readonly GenerationReference[] = [];

/**
 * A switch drawn as the artboard's, with its name and what it does beside it: unlike the
 * settings' `CreatorSettingSwitch`, whose whole row is its button, what it does stays out of
 * its name (it is its description), and it waits while a publish goes.
 */
function CreatorFormSwitch({ id, label, description, checked, disabled, onChange }: {
  id: string;
  label: string;
  description: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-sm font-semibold text-[var(--ui-text-primary)]">{label}</p>
        <p id={`${id}-description`} className="mt-1 text-xs leading-5 text-[var(--ui-text-muted)]">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        // The press area is a control's 48px; the track is drawn smaller inside it.
        className="ui-focus-ring -my-3 flex h-12 w-12 shrink-0 items-center justify-center rounded-full disabled:opacity-60"
      >
        <span
          aria-hidden
          className={clsx(
            'flex h-6 w-11 items-center rounded-full p-0.5 transition-colors duration-150',
            checked ? 'bg-[var(--ui-primary)]' : 'bg-[var(--ui-surface-3)] ring-1 ring-inset ring-[var(--ui-border-strong)]',
          )}
        >
          <span
            className={clsx(
              'h-5 w-5 rounded-full transition-transform duration-150 motion-reduce:transition-none',
              checked ? 'translate-x-5 bg-[var(--ui-primary-on)]' : 'translate-x-0 bg-[var(--ui-text-muted)]',
            )}
          />
        </span>
      </button>
    </div>
  );
}

/**
 * Whom a post goes out as. A profile that can post publicly says so ("Posting as Athul S ·
 * @athul-s"); a first post says what it will set, filled in from the sign-in, with Change to
 * edit both in place. A missing profile photo never stops a post: a name and a handle do.
 */
function CreatorPostingAs({ draft, accessToken, idPrefix }: { draft: PublishCreationDraft; accessToken: string | null | undefined; idPrefix: string }) {
  const [editing, setEditing] = useState(false);
  const hasIdentityErrors = Boolean(draft.identityErrors.displayName || draft.identityErrors.username);
  const showsFields = draft.needsPublicIdentity && (editing || hasIdentityErrors);
  const profile = draft.profile;

  if (draft.profileLoadState === 'idle' || draft.profileLoadState === 'loading') {
    return (
      <p aria-live="polite" className="flex min-h-12 items-center gap-2 text-sm text-[var(--ui-text-muted)]">
        <Loader2 aria-hidden className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        Checking your profile…
      </p>
    );
  }

  if (!draft.needsPublicIdentity) {
    const name = profile?.username ? getCreatorDisplayName(profile) : null;
    return (
      <div aria-live="polite" className="flex items-center gap-3 rounded-ui-lg border border-[var(--ui-border-subtle)] px-3 py-2.5">
        <PostCommentAvatar avatarUrl={profile?.avatarUrl ?? null} name={name ?? 'You'} size={28} />
        <p className="min-w-0 text-sm text-[var(--ui-text-secondary)] [overflow-wrap:anywhere]">
          {draft.profileLoadState === 'ready' && profile?.username
            ? <>Posting as <strong className="font-semibold text-[var(--ui-text-primary)]">{name}</strong> · @{profile.username}</>
            : 'Public posts show your name and handle.'}
        </p>
      </div>
    );
  }

  const name = draft.identity.displayName.trim();
  const handle = draft.identity.username.trim();
  return (
    <div className="rounded-ui-lg border border-[var(--ui-border-subtle)] px-3 py-2.5">
      <div className="flex items-center gap-3">
        <PostCommentAvatar avatarUrl={profile?.avatarUrl ?? null} name={name || 'You'} size={28} />
        <div className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
          <p className="font-semibold text-[var(--ui-text-primary)]">{name ? `Posting as ${name}` : 'Add your name'}</p>
          <p className="text-xs leading-5 text-[var(--ui-text-muted)]">
            {handle ? `@${handle} · ` : ''}your first post sets these
          </p>
        </div>
        {!showsFields ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="Change your name or handle"
            className="ui-button ui-button-ghost ui-focus-ring min-h-12 shrink-0 px-3"
          >
            Change
          </button>
        ) : null}
      </div>
      {showsFields ? (
        <div className="mt-3">
          <PublicIdentityFields
            idPrefix={idPrefix}
            value={draft.identity}
            errors={draft.identityErrors}
            disabled={draft.isPublishing}
            accessToken={accessToken}
            savedUsername={profile?.username}
            framed={false}
            stacked
            onChange={draft.setIdentity}
          />
        </div>
      ) : null}
    </div>
  );
}

/** "As Athul S · “Kung fu cats” · recipe shared": what the phone's bar says Publish will send. */
export function describePublishSummary({ name, title, recipeShared }: { name: string; title: string; recipeShared: boolean }): string {
  return [name ? `As ${name}` : null, title.trim() ? `“${title.trim()}”` : null, recipeShared ? 'recipe shared' : null]
    .filter(Boolean)
    .join(' · ');
}

/**
 * What a creation's recipe holds, under its heading (the artboard Result; owner, 2026-11-05: a
 * creation's post always carries its recipe, free unless the run remixed a paid one): the exact
 * prompt where the creation saved one (a motion run saves none, and is never told it shares one),
 * the files left in it, and its remix where allowed. Not the settings, which the post shows
 * everyone (owner, 2026-11-03).
 */
export function describeCreationRecipe({ accessMode, priceCredits, hasPrompt = true, fileCount, allowRemixes }: {
  accessMode: 'free' | 'paid';
  priceCredits: number;
  /** The creation saved a prompt. */
  hasPrompt?: boolean;
  fileCount: number;
  allowRemixes: boolean;
}): string {
  const files = fileCount > 0 ? `${fileCount} ${fileCount === 1 ? 'file' : 'files'}` : null;
  const parts = [hasPrompt ? 'The exact prompt' : null, files].filter((part): part is string => Boolean(part));
  const holds = parts.length === 0
    ? 'Its remix'
    : parts.length === 1
      ? parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1)
      : `${parts[0]} and ${parts[1]}`;
  const price = accessMode === 'paid' ? `, for ${creditsWords(priceCredits)}` : ', free';
  return `${holds}${price}${allowRemixes ? ', so others can remix it.' : '.'}`;
}

/**
 * The files a creation's recipe takes (owner, 2026-11-05: the creator's own uploads included), each
 * as a thumbnail with a remove button, and the line that says where they go. With every one removed
 * from a creation with no prompt, the post goes without a recipe (`allRemoved`), and the way to put
 * them back stays (#711's review).
 */
function CreatorRecipeFiles({ inputs, removedCount, disabled, allRemoved = false, onRemove, onRestoreAll }: {
  inputs: readonly GenerationReference[];
  removedCount: number;
  disabled: boolean;
  allRemoved?: boolean;
  onRemove: (inputId: string) => void;
  onRestoreAll: () => void;
}) {
  if (inputs.length === 0 && removedCount === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {inputs.length > 0 ? (
        <ul aria-label="Files in the recipe" className="flex flex-wrap gap-2">
          {inputs.map((input) => (
            <li key={input.id} className="relative">
              <div
                title={input.label}
                className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-muted)]"
              >
                {input.mediaKind === 'image' && input.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={input.url} alt={input.label} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                ) : input.mediaKind === 'video' ? (
                  <Film aria-hidden className="h-5 w-5" />
                ) : input.mediaKind === 'audio' ? (
                  <Music aria-hidden className="h-5 w-5" />
                ) : (
                  <ImageIcon aria-hidden className="h-5 w-5" />
                )}
              </div>
              {/* The press area is 32px over the thumbnail's corner; the mark inside is smaller. */}
              <button
                type="button"
                aria-label={`Remove ${input.label} from the recipe`}
                disabled={disabled}
                onClick={() => onRemove(input.id)}
                className="ui-focus-ring absolute -right-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full disabled:opacity-60"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full border border-[var(--ui-border-strong)] bg-[var(--ui-surface-1)] text-[var(--ui-text-primary)]">
                  <X aria-hidden className="h-3 w-3" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs leading-5 text-[var(--ui-text-muted)]">
        {inputs.length > 0 ? CREATION_RECIPE_FILES_LINE : allRemoved ? CREATION_INPUTS_ALL_REMOVED : 'No files go with this recipe.'}
        {removedCount > 0 ? (
          <>
            {' '}
            <button type="button" disabled={disabled} onClick={onRestoreAll} className={CREATOR_NOTE_LINK_CLASS}>
              {describePutRemovedInputsBack(removedCount)}
            </button>
          </>
        ) : null}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Posted

/**
 * After a post (the artboard Posted): that it is live and where, that its creator hears when
 * someone remixes it (the `post_remixed` alert) while remixes are allowed, the way to it and to
 * share it, and what the balance leaves for the next. It says the recipe as it went out, free or
 * paid, from what the publish sent (#711's review).
 */
function CreatorPosted({
  published,
  generationId,
  sourceSurface,
  accessToken,
  original,
  follow,
  next,
}: {
  published: PublishedCreation;
  generationId: string;
  sourceSurface: GenerationShareSourceSurface;
  accessToken: string | null | undefined;
  original: RemixOriginal | null;
  follow: CreatorFollow;
  next?: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // A private post has no public page: its owner's page of it, as the composer leads there.
  const postPath = published.showcasePath || published.ownerPath || buildShowcaseDetailPath(generationId);
  const isPublic = published.visibility !== 'private';
  const remixesAllowed = published.allowRemixes !== false;
  // The recipe others can remix this one from: one that went out live, while remixes are allowed.
  const remixableRecipe = remixesAllowed && published.resourceBundleStatus === 'published'
    && (published.recipeAccess === 'free' || published.recipeAccess === 'paid')
    ? published.recipeAccess
    : null;

  // The form it replaces had the focus (its Publish): it moves to what happened.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: false });
  }, []);

  return (
    <div className="flex flex-col gap-4 rounded-ui-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-5">
      <span aria-hidden className={clsx('flex h-11 w-11 items-center justify-center rounded-full border', getAccentClasses('workflow').iconWrap)}>
        <Check className="h-5 w-5" strokeWidth={2.5} />
      </span>
      <div role="status">
        <h3 ref={headingRef} tabIndex={-1} className="ui-focus-ring rounded-lg text-lg font-bold text-[var(--ui-text-primary)] outline-none">
          {isPublic ? 'Posted to the feed' : 'Saved as a private post'}
        </h3>
        <p className="mt-1 text-sm leading-6 text-[var(--ui-text-muted)] [overflow-wrap:anywhere]">
          {isPublic
            ? <>
                {published.title ? `“${published.title}”` : 'Your post'} is live on your profile and in Explore.
                {remixesAllowed ? ' You’ll get an alert when someone remixes yours.' : ''}
              </>
            : 'Only you can see it, on your profile.'}
        </p>
      </div>
      {original && isPublic ? <CreatorRemixCredit original={original} follow={follow} remixableRecipe={remixableRecipe} /> : null}
      <Link href={postPath} className="ui-button ui-button-primary ui-focus-ring w-full">
        View your post
      </Link>
      {isPublic ? (
        <PublicShareButton
          generationId={generationId}
          title={published.title}
          sourceSurface={sourceSurface}
          accessToken={accessToken}
          viewerIsOwner
          label="Share the link"
          className="ui-button ui-button-secondary ui-focus-ring w-full"
        />
      ) : null}
      {next ? <div className="text-center text-sm text-[var(--ui-text-muted)]">{next}</div> : null}
    </div>
  );
}

/**
 * Under Posted: the balance and the next thing it buys, "22 credits left: make another or top
 * up" where it covers this run again, and "3 credits left: top up" where it does not. Top up
 * sells credits on the page (`CreditTopUpSheet`); a short balance is offered no picture
 * instead (owner, 2026-11-02).
 */
export function CreatorPostedNext({ balance, runCost, onMakeAnother, topUpHref = '/pricing' }: {
  balance: number;
  /** What this run cost; null where it is not known. */
  runCost: number | null;
  onMakeAnother: () => void;
  /** The pricing page the sheet offers beside its packs: told on a remix the way back to it, as the bar's Top up is. */
  topUpHref?: string;
}) {
  const coversAnother = runCost !== null && balance >= runCost;
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
      <span>{creditsWords(balance)} left:</span>
      {coversAnother ? (
        <>
          <button type="button" onClick={onMakeAnother} className={CREATOR_NOTE_LINK_CLASS}>make another</button>
          <span>or</span>
        </>
      ) : null}
      <button
        type="button"
        onClick={() => openCreditTopUp(runCost !== null ? { cost: runCost, balance } : null, topUpHref)}
        className={CREATOR_NOTE_LINK_CLASS}
      >
        top up
      </button>
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// The panel: the form, or Posted, and the phone's bar

/**
 * The floating bottom navigation's room at the window's foot, in pixels: none where the shell
 * has none. The shell sets it on its own root, so it is measured inside the page, beside `inside`.
 */
function bottomNavSpacePx(inside: Element): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;height:var(--app-shell-bottom-nav-space,0px)';
  (inside.parentElement ?? document.body).appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return Math.round(height);
}

/**
 * "More options": the full composer on the same creation, carrying what the creator chose in the
 * form (#711's review): the saved inputs they took out (`leaveOut`, one each), "Allow remixes" off
 * (`allowRemixes=0`), and the recipe as it stands, free or paid at its price (`resourceMode`,
 * `price`). The page reads them as where a new post starts. Before the form knows its recipe
 * (`draft` null), the creation alone: the composer works the rest out itself.
 */
export function buildMoreOptionsHref(
  generationId: string,
  draft: Pick<PublishCreationDraft, 'removedInputIds' | 'allowRemixes' | 'recipeAccess' | 'paidPriceCredits'> | null,
): string {
  const params = new URLSearchParams({ generationId });
  if (draft) {
    draft.removedInputIds.forEach((inputId) => params.append('leaveOut', inputId));
    if (!draft.allowRemixes) params.set('allowRemixes', '0');
    if (draft.recipeAccess !== 'none') params.set('resourceMode', draft.recipeAccess);
    if (draft.recipeAccess === 'paid') params.set('price', String(draft.paidPriceCredits));
  }
  return `/post/new?${params}`;
}

/** Where the shell's bottom navigation goes away (`--app-shell-bottom-nav-space` turns 0). */
const BOTTOM_NAV_GONE_QUERY = '(min-width: 768px)';

/** Counts the window's crossings of the bottom navigation's breakpoint, so what it covers is measured again. */
function useBottomNavChanges(): number {
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(BOTTOM_NAV_GONE_QUERY);
    const changed = () => setChanges((count) => count + 1);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  return changes;
}

export interface CreatorPublishPanelProps {
  generationId: string;
  accessToken: string | null | undefined;
  /** Whose Follow the credit asks about. */
  viewerUserId: string | null | undefined;
  /** `undefined` while they are being read (`useCreationPublishDetails`). */
  details: CreationPublishDetails | null | undefined;
  /** The remix's original, credited, and the recipe of the creator's own (`useRemixOriginal`). */
  remix: RemixOriginalRead;
  sourceSurface: GenerationShareSourceSurface;
  /** What the creator's page keeps of a publish: Posted comes from it. */
  published: PublishedCreation | null;
  onPublished: (payload: PublishedCreation) => void;
  /** A publish is in flight, or no longer: the page's Generate waits for it (`useCreatorPublish`). */
  onPublishingChange?: (publishing: boolean) => void;
  /** For the phone's bar, beside its Publish. */
  download: { href: string; fileName: string; label: string; newTab?: boolean };
  /** Under Posted: the balance line (`CreatorPostedNext`). */
  next?: ReactNode;
}

/**
 * The publish form on the canvas, or Posted once it went. One draft serves the form's Publish
 * and the phone's bar alike (one handler), so the two can never send different posts.
 */
export function CreatorPublishPanel({
  generationId,
  accessToken,
  viewerUserId,
  details,
  remix,
  sourceSurface,
  published,
  onPublished,
  onPublishingChange,
  download,
  next,
}: CreatorPublishPanelProps) {
  const detailsRead = details !== undefined;
  const original = remix.original;
  // The recipe of the creator's own post the creation came from: the creation's details say, where
  // the server sends it, and the remix's original read otherwise (owner, 2026-11-06).
  const ownSourceRecipe = details?.ownSourceRecipe !== undefined ? details.ownSourceRecipe : remix.ownRecipe;
  const draft = usePublishCreation({
    active: !published,
    generationId,
    accessToken,
    defaultTitle: details?.title ?? '',
    creation: details?.creation ?? null,
    paywallPrefill: details?.paywallPrefill ?? null,
    inputs: details?.inputs,
    // A remix keeps its original recipe's terms: paid stays paid, free stays free (owner, 2026-11-05).
    remixRecipeMode: details?.remixRecipeMode ?? null,
    // A creation from the creator's own paid post starts paid, and may be made free (owner, 2026-11-06).
    ownSourceRecipe: ownSourceRecipe ?? null,
    remixOfTitle: original?.title ?? null,
    onPublished,
  });
  // One answer for the form's credit and Posted's, which follows it.
  const follow = useCreatorFollow(original?.creator.id ?? null, accessToken, viewerUserId);
  const formRef = useRef<HTMLFormElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [submitInView, setSubmitInView] = useState(true);
  const [columnBarInView, setColumnBarInView] = useState(false);
  const bottomNavChanges = useBottomNavChanges();
  // Counts the bar's presses that were refused: the focus then goes to the form's Publish.
  const [refusedBarPresses, setRefusedBarPresses] = useState(0);
  const id = useId();
  const headingId = `${id}-heading`;
  const recipeShared = draft.recipeAccess !== 'none';
  // The recipe and title are known before the first press, so Publish waits for them, and for the
  // original's answer where it says where the recipe starts: without it, a recipe the creator
  // sells could start free.
  const waiting = !detailsRead || (details !== null && ownSourceRecipe === undefined);
  const isPublishing = draft.isPublishing;

  useEffect(() => {
    onPublishingChange?.(isPublishing);
  }, [isPublishing, onPublishingChange]);
  useEffect(() => () => onPublishingChange?.(false), [onPublishingChange]);

  // The phone's bar shows only while the form's own Publish is out of view, and gives way to the
  // column's bar, Generate's, which waits at the page's end until the creation is posted. What
  // the floating bottom navigation covers is not in view.
  useEffect(() => {
    const target = submitRef.current;
    if (!target || typeof IntersectionObserver === 'undefined') return;
    const rootMargin = `0px 0px -${bottomNavSpacePx(target)}px 0px`;
    const submitObserver = new IntersectionObserver(([entry]) => setSubmitInView(entry.isIntersecting), { threshold: 0.5, rootMargin });
    submitObserver.observe(target);
    const columnBar = document.querySelector('[data-creator-bar]');
    const columnBarObserver = columnBar
      ? new IntersectionObserver(([entry]) => setColumnBarInView(entry.isIntersecting), { rootMargin })
      : null;
    if (columnBar) columnBarObserver?.observe(columnBar);
    return () => {
      submitObserver.disconnect();
      columnBarObserver?.disconnect();
    };
  }, [published, bottomNavChanges]);

  // Refused from the bar, the press brings the form into view and the bar goes with the focus
  // it held: it moves to the form's Publish, once that is no longer waiting on the publish.
  useEffect(() => {
    if (refusedBarPresses > 0) submitRef.current?.focus({ preventScroll: true });
  }, [refusedBarPresses]);

  if (published) {
    return (
      <CreatorPosted
        published={published}
        generationId={generationId}
        sourceSurface={sourceSurface}
        accessToken={accessToken}
        original={original}
        follow={follow}
        next={next}
      />
    );
  }

  /** The one handler: the form's Publish and the bar's. Refused, the form shows why. */
  const submit = async (fromBar: boolean) => {
    if (waiting) return;
    const ok = await draft.publish();
    if (!ok && formRef.current) {
      formRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (fromBar) setRefusedBarPresses((count) => count + 1);
    }
  };

  const name = draft.needsPublicIdentity
    ? draft.identity.displayName.trim()
    : (draft.profile?.username ? getCreatorDisplayName(draft.profile) : '');
  const handle = draft.needsPublicIdentity ? draft.identity.username.trim() : (draft.profile?.username ?? '');
  const showsBar = !submitInView && !columnBarInView;

  return (
    <>
      <form
        ref={formRef}
        aria-labelledby={headingId}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
        // Enter on a checkbox never publishes: Chrome's implicit submission presses Publish for
        // it, and "Mark as mature" ticked with Enter would post unmarked (the composer's #565).
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          const target = event.target;
          if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
            event.preventDefault();
          }
        }}
        className="flex flex-col gap-4 rounded-ui-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-5"
      >
        <div>
          <h3 id={headingId} className="text-lg font-bold text-[var(--ui-text-primary)]">Post it to the feed</h3>
          <p className="mt-1 text-sm leading-6 text-[var(--ui-text-muted)]">
            People can watch it, save it and remix it. It stays in your Studio either way.
          </p>
        </div>

        <div>
          <label htmlFor={`${id}-title`} className="mb-2 block text-sm font-semibold text-[var(--ui-text-primary)]">Title</label>
          <input
            ref={titleRef}
            id={`${id}-title`}
            type="text"
            value={draft.title}
            onChange={(event) => draft.setTitle(event.target.value)}
            placeholder="Give your creation a name"
            maxLength={TITLE_MAX_LENGTH}
            disabled={isPublishing}
            className={FIELD_CLASS}
          />
          {draft.titleSuggestionHint ? (
            <p className="mt-2 text-xs leading-5 text-[var(--ui-text-muted)]">{draft.titleSuggestionHint}</p>
          ) : null}
        </div>

        <CreatorPostingAs draft={draft} accessToken={accessToken} idPrefix={`${id}-identity`} />

        {draft.recipeAccess !== 'none' ? (
          <section aria-labelledby={`${id}-recipe-heading`} className="flex flex-col gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h4 id={`${id}-recipe-heading`} className="text-sm font-semibold text-[var(--ui-text-primary)]">
                  {draft.recipeAccess === 'paid' ? 'Paid recipe' : 'Free recipe'}
                </h4>
                {draft.recipeLock ? <Lock aria-hidden className="h-3.5 w-3.5 text-[var(--ui-text-muted)]" /> : null}
              </div>
              <p className="mt-1 text-xs leading-5 text-[var(--ui-text-muted)]">
                {describeCreationRecipe({
                  accessMode: draft.recipeAccess,
                  priceCredits: draft.paidPriceCredits,
                  hasPrompt: draft.hasPrompt,
                  fileCount: draft.includedInputs.length,
                  allowRemixes: draft.allowRemixes,
                })}
              </p>
              {draft.recipeLock ? (
                <p className="mt-1 text-xs leading-5 text-[var(--ui-text-muted)]">{draft.recipeLock.reason}</p>
              ) : null}
              {draft.recipeAccess === 'paid' ? (
                <p className="mt-1 text-xs leading-5 text-[var(--ui-text-muted)]">
                  {/* What buyers may do, only while they may remix it (#711's review). */}
                  {draft.allowRemixes ? `${PAID_RECIPE_RESALE_LINE} ` : ''}Another price is in More options.
                </p>
              ) : null}
            </div>
            <CreatorRecipeFiles
              inputs={draft.includedInputs}
              removedCount={draft.removedInputIds.length}
              disabled={isPublishing}
              onRemove={(inputId) => draft.setInputIncluded(inputId, false)}
              onRestoreAll={draft.restoreRemovedInputs}
            />
            {/* A recipe that starts paid from the creator's own post's is theirs to share free
                (owner, 2026-11-06, "Start Paid, can switch"): no lock, no reason. */}
            {draft.offersPaidChoice ? (
              <CreatorFormSwitch
                id={`${id}-sell`}
                label="Sell this recipe"
                description={ownSourceRecipe === UNREAD_ORIGINAL_RECIPE
                  ? 'Your original could not be checked, so this one starts paid. Turn it off to share it free.'
                  : 'Your own post’s recipe is paid, so this one starts paid too. Turn it off to share it free.'}
                checked={draft.recipeAccess === 'paid'}
                disabled={isPublishing}
                onChange={draft.setRecipePaid}
              />
            ) : null}
            <CreatorFormSwitch
              id={`${id}-remixes`}
              label={ALLOW_REMIXES_LABEL}
              description={ALLOW_REMIXES_DETAIL}
              checked={draft.allowRemixes}
              disabled={isPublishing}
              onChange={draft.setAllowRemixes}
            />
          </section>
        ) : draft.removedInputIds.length > 0 ? (
          // Every file removed from a creation with no prompt: the media goes alone, and the files can
          // come back (#711's review).
          <CreatorRecipeFiles
            inputs={NO_RECIPE_FILES}
            removedCount={draft.removedInputIds.length}
            disabled={isPublishing}
            allRemoved
            onRemove={() => undefined}
            onRestoreAll={draft.restoreRemovedInputs}
          />
        ) : detailsRead ? (
          <p className="text-xs leading-5 text-[var(--ui-text-muted)]">Publish the media now; you can add a recipe from the post later.</p>
        ) : null}

        <label className="flex min-h-12 items-center gap-3 text-sm text-[var(--ui-text-secondary)]">
          <input
            type="checkbox"
            checked={draft.isNsfw}
            disabled={isPublishing}
            onChange={(event) => draft.setIsNsfw(event.target.checked)}
            className="h-4 w-4 accent-[var(--ui-primary)]"
          />
          Mark as mature (NSFW)
        </label>

        {original ? <CreatorRemixCredit original={original} follow={follow} /> : null}

        {draft.formError ? (
          <StatusCallout tone="danger" title="Couldn’t publish" body={draft.formError} icon={CircleAlert} className="[overflow-wrap:anywhere]" />
        ) : null}

        {/* Beside the column the pane scrolls: there Publish rides its foot until the form is in
            view (the mock-up's round 4), on the form's own surface, a hairline above it; its offset
            takes back the canvas body's padding (`--creator-canvas-padding`), which a sticky box is
            inset by, so its foot is the pane's edge. It holds Publish alone: taller, it could not
            rise above the form's top where little of the form is in view, and its foot went under
            the pane's edge. On a phone the bar below stands in for it. */}
        <div className="relative -mx-5 flex flex-col px-5 pb-1 min-[1120px]:sticky min-[1120px]:bottom-[calc(var(--creator-canvas-padding)*-1)] min-[1120px]:z-[1] min-[1120px]:border-t min-[1120px]:border-[var(--ui-border-subtle)] min-[1120px]:bg-[var(--ui-surface-1)] min-[1120px]:pt-3">
          <button
            ref={submitRef}
            type="submit"
            disabled={isPublishing || waiting}
            aria-busy={isPublishing || waiting || undefined}
            className={CREATOR_BAR_PRIMARY_CLASS}
          >
            {isPublishing || waiting ? <Loader2 aria-hidden className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Globe aria-hidden className="h-4 w-4" />}
            Publish to the feed
          </button>
        </div>
        {/* The full composer for the same creation (decision 18, 2026-10-17): a caption, a paid
            recipe, a private post. It reads the creation from its address, and what was chosen
            here from the rest of it (#711's review). */}
        <Link
          href={buildMoreOptionsHref(generationId, waiting ? null : draft)}
          aria-disabled={isPublishing || undefined}
          onClick={(event) => {
            // Leaving while a publish is in flight would post the creation twice.
            if (draft.isPublishingRef.current) event.preventDefault();
          }}
          className={clsx(
            'ui-focus-ring -mt-3 inline-flex min-h-12 items-center justify-center gap-1.5 self-center rounded-full px-3 text-sm font-semibold text-[var(--ui-text-muted)] transition-colors',
            isPublishing ? 'pointer-events-none opacity-50' : 'hover:text-[var(--ui-text-primary)]',
          )}
        >
          More options
          <ArrowRight aria-hidden className="h-4 w-4" />
        </Link>
      </form>

      {/* The phone's bar (the artboard Result at 390): Publish kept in reach while the form's own
          is out of view, with Download beside it and what it will send under it. */}
      {showsBar ? (
        <div
          data-testid="creator-publish-bar"
          className="fixed inset-x-0 bottom-[var(--app-shell-bottom-nav-space,0px)] z-30 border-t border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5 min-[1120px]:hidden"
        >
          <div className="mx-auto grid max-w-[680px] grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5">
            <button
              type="button"
              onClick={() => void submit(true)}
              disabled={isPublishing || waiting}
              aria-busy={isPublishing || waiting || undefined}
              className={CREATOR_BAR_PRIMARY_CLASS}
            >
              {isPublishing || waiting ? <Loader2 aria-hidden className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}
              <span className="truncate">{handle ? `Publish as @${handle}` : 'Publish to the feed'}</span>
            </button>
            <CreatorDownloadButton {...download} iconOnly />
            <p className="col-span-2 text-xs leading-5 text-[var(--ui-text-muted)] [overflow-wrap:anywhere]">
              {describePublishSummary({ name, title: draft.title, recipeShared })}
              {' · '}
              <button
                type="button"
                onClick={() => {
                  titleRef.current?.focus({ preventScroll: true });
                  formRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                }}
                className={CREATOR_NOTE_LINK_CLASS}
              >
                Edit details
              </button>
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * A creator page's side of publishing on its canvas, the same in the three creators: the done
 * creation's details and the remix's original, read for the form; what a publish answered,
 * which Posted is drawn from; and whether one is in flight, which Generate waits for, since a
 * new run takes the form away mid-request (the Publish window covered the page while it sent).
 */
export function useCreatorPublish({
  generationId,
  done,
  accessToken,
  remixPostId,
  viewerUserId,
}: {
  /** The run on the canvas. */
  generationId: string | null;
  /** It finished, with a result to publish. */
  done: boolean;
  accessToken: string | null | undefined;
  /** The post a remix was opened from (`?remixPost=`). */
  remixPostId: string | null | undefined;
  viewerUserId: string | null | undefined;
}) {
  const details = useCreationPublishDetails(done ? generationId : null, accessToken);
  const remix = useRemixOriginal(remixPostId, accessToken, viewerUserId);
  const [published, setPublished] = useState<{ generationId: string; post: PublishedCreation } | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const posted = published && published.generationId === generationId ? published.post : null;
  // The panel's props that come from here; the page adds its media's download and surface.
  const panel = done && generationId ? {
    generationId,
    accessToken,
    viewerUserId,
    details,
    remix,
    published: posted,
    onPublished: (post: PublishedCreation) => setPublished({ generationId, post }),
    onPublishingChange: setInFlight,
  } : null;
  return { panel, posted, inFlight };
}
