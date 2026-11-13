import type { MagicbookletApiClient } from './api-client';
import { buildImmersiveShowcaseItems, type ImmersivePreviewItem } from './immersive-preview-view-model';
import type { RemixSourceBundle, ShowcaseFeedItem } from './types';
import { getNativeRemixCreateHref, getRemixSourceContext, type RemixSourceContext } from './viewer-actions';

/** The remix endpoint's answer for a post whose remix sits behind an unlock. */
export const REMIX_UNLOCK_REQUIRED_CODE = 'REMIX_UNLOCK_REQUIRED';

type RemixApi = Pick<MagicbookletApiClient, 'remixShowcasePost' | 'unlockFreeBundle'>;

export type RemixStartResponse = Awaited<ReturnType<RemixApi['remixShowcasePost']>>;

export type RemixStartResult =
  | {
      kind: 'started';
      response: RemixStartResponse;
      /** True when this tap also took the post's free unlock, so its caches are stale. */
      claimedFreeUnlock: boolean;
    }
  /**
   * The server wants an unlock the loaded post did not mention. The caller
   * shows the unlock sheet; nothing has been claimed or spent.
   */
  | { kind: 'unlock-required' };

/**
 * The requests behind one tap on Remix, shared by Home and the reel.
 *
 * A free unlock is claimed here, in the same tap, because it costs the viewer
 * nothing. A paid one never is: the caller sends those to the unlock sheet
 * before calling this, and this function has no way to spend credits.
 */
export async function startShowcaseRemix({
  api,
  postId,
  claimFreeUnlock,
  onSourceReadable,
}: {
  api: RemixApi;
  postId: string;
  /** The loaded post says remix sits behind a free unlock this viewer has not taken. */
  claimFreeUnlock: boolean;
  /**
   * Told when the remix's source may be read beside the start: at once, or once the
   * free unlock is recorded. `/api/remix-source` keeps the start's own gate, so a read
   * sent before the claim would be refused as still locked (`launchShowcaseRemix`).
   */
  onSourceReadable?: () => void;
}): Promise<RemixStartResult> {
  // Claiming twice is harmless: the server answers a repeat as already owned.
  if (claimFreeUnlock) await api.unlockFreeBundle(postId);
  onSourceReadable?.();

  try {
    const response = await api.remixShowcasePost(postId);
    return { kind: 'started', response, claimedFreeUnlock: claimFreeUnlock };
  } catch (error) {
    // Still locked straight after a claim means something else is wrong, and
    // sending the viewer back to unlock again would only loop.
    if (claimFreeUnlock || !isRemixUnlockRequired(error)) throw error;
    return { kind: 'unlock-required' };
  }
}

/**
 * A creator's read of the remix it opened on, taking the post's free recipe on the way when the
 * read is refused for it (`REMIX_UNLOCK_REQUIRED`), then reading once more. A Remix tap takes the
 * recipe itself (`startShowcaseRemix`); a creator opened any other way has no tap to do it: a
 * guest who signs up from a Home shelf card lands in the creator on the remix
 * (`homeShelfGuestReturnTo`), and so does a link to a remix. The web's creators do the same
 * (`src/lib/use-remix-source-read.ts`, owner 2026-11-13).
 *
 * The server decides what is free: a paid, retired or withheld recipe refuses the claim, and the
 * remix stays refused as it was. A claim that only failed to be made (a 429, a 5xx, the network)
 * is thrown as itself, so the creator says why, and its Retry restore asks again. `onFreeRecipeTaken`
 * is told once the recipe is the reader's, for the caches and the notice a claim brings.
 */
export async function readRemixSourceTakingFreeRecipe(
  api: Pick<MagicbookletApiClient, 'getRemixSourceBundle' | 'unlockFreeBundle'>,
  generationId: string,
  postId: string | null,
  onFreeRecipeTaken: () => void,
): Promise<RemixSourceBundle> {
  try {
    return await api.getRemixSourceBundle(generationId, { postId });
  } catch (refusal) {
    if (!postId || !isRemixUnlockRequired(refusal)) throw refusal;
    try {
      await api.unlockFreeBundle(postId);
    } catch (claimFailure) {
      throw claimMayWorkLater(claimFailure) ? claimFailure : refusal;
    }
    onFreeRecipeTaken();
    return api.getRemixSourceBundle(generationId, { postId });
  }
}

/** A claim that failed for a passing reason: the network (no status), a timeout, a 429 or a 5xx. */
function claimMayWorkLater(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== 'number' || status === 0) return true;
  return status === 408 || status === 429 || status >= 500;
}

/**
 * The creator a started remix opens: the server's create link as the app's
 * route (or the post's own tool and prompt when the app cannot map it), with
 * the row naming the source. `item` is the post as the reel reads it. Home and
 * the reel both build the link here; Home's own copy once left the row out.
 */
export function showcaseRemixCreateHref(item: ImmersivePreviewItem, response: RemixStartResponse) {
  return getNativeRemixCreateHref({
    redirectTo: response.redirectTo,
    recreateTool: item.recreateTool,
    prompt: response.prefill?.prompt ?? item.recreatePrompt,
    context: getRemixSourceContext(item),
  });
}

/**
 * What the creator a Remix tap launched is told once the start is answered: carry on,
 * give way to the link the answer names, or close while the tapped screen says why (a
 * refusal, an unlock to take, a creation the app has no creator for).
 */
export type RemixLaunchAnswer =
  | { kind: 'confirmed' }
  | { kind: 'replaced'; href: string }
  | { kind: 'closed' };

/**
 * The creator's side of a Remix tap's launch (`launchShowcaseRemix`). The creator finds
 * it by its link's `remixLaunch` (`findRemixLaunch`) and holds what the answer decides
 * until it comes: the source it restores, its saves and a run.
 */
export interface RemixLaunch {
  /** The remix the tap launched, which the creator's link must name too. */
  readonly generationId: string;
  readonly postId: string;
  /** The original's model as the tapped post names it, for the creator to name while its source loads. */
  readonly modelId: string | null;
  /** Null until the start is answered. */
  readonly answer: RemixLaunchAnswer | null;
  /** The creator listens for as long as it is open, and stops as it unmounts. */
  subscribe(listener: () => void): () => void;
  /**
   * The source, for the creator's restore. The first read is the one the tap sent
   * beside the start; a later one (a retry, a restore started again) also waits for any
   * free unlock. Either lands, or fails, only once the start is answered as this remix,
   * and never on a creator the answer closes or sends elsewhere, which is leaving.
   */
  readSource(): Promise<RemixSourceBundle>;
  /**
   * True once only: for whoever takes the answer's way out (the replace or the close).
   * The creator does when it is open, its effects running before its route's; the route
   * does while the community rules stand in front of the creator, which is not open yet.
   */
  claimExit(): boolean;
}

/** The tap's side of the launch: what the start's answer does to the creator it opened. */
export interface RemixLaunchControl {
  /** The start no longer waits on an unlock, so the source read goes out (`startShowcaseRemix`). */
  sourceReadable(): void;
  /** The answer's creator link: the creator carries on when it is the link it opened on, and gives way to it when not. */
  land(href: string): void;
  /**
   * The start was refused, or lands nowhere the app can open: the creator closes. Settles
   * once it has gone, so a sheet of the tapped screen's own opens over that screen: on
   * iOS a Modal is presented from its screen, and a screen under the creator has none to
   * present from.
   */
  close(): Promise<void>;
}

/**
 * The creator link's param that names its launch. Only the tap's own link carries it, so
 * a creator opened any other way (a link, a return from sign-in, the answer's own link)
 * opens as every remix link does.
 */
export const REMIX_LAUNCH_PARAM = 'remixLaunch';

/** Launches kept for a creator that has not taken its own yet, at most. */
const LAUNCHES_KEPT = 8;
const launches = new Map<string, RemixLaunch>();
let lastLaunchId = 0;

/**
 * The launch the creator's link names (`REMIX_LAUNCH_PARAM`), while its tap is still
 * known, and only for the remix it launched: a link that names another tap's launch
 * opens as any remix link does.
 */
export function findRemixLaunch(
  id: string | null | undefined,
  source: { generationId?: string | null; postId?: string | null } | undefined,
): RemixLaunch | null {
  const launch = id ? launches.get(id) : undefined;
  return launch && launch.generationId === source?.generationId?.trim() && launch.postId === source?.postId?.trim()
    ? launch
    : null;
}

/**
 * Opens the creator for a Remix tap at once, on the link the start is expected to answer
 * with: the post's own tool, creation and row, as the server's link maps
 * (`showcaseRemixCreateHref`). Waiting for the answer first left the tap with nothing on
 * screen for 0.75 to 1 s, and up to 4 s, on the Pixel 9a against production
 * (2026-11-03), and the creator's own reads only began after it. The source is read
 * beside the start, and the creator holds it until the answer. A post that cannot name
 * its creation opens on the answer, as before.
 */
export function launchShowcaseRemix({
  api,
  item,
  navigate,
}: {
  api: Pick<MagicbookletApiClient, 'getRemixSourceBundle'>;
  /** The post as the reel reads it. */
  item: ImmersivePreviewItem;
  /** Opens a creator link (`router.push`). */
  navigate: (href: string) => void;
}): RemixLaunchControl {
  const generationId = item.generationId?.trim();
  const postId = item.showcasePostId?.trim();
  const expected = generationId && postId
    ? showcaseRemixCreateHref(item, {
        success: true,
        redirectTo: `/create-${item.recreateTool}?${new URLSearchParams({ remix: generationId, remixPost: postId })}`,
      })
    : null;
  if (!generationId || !postId || !expected) {
    return { sourceReadable: () => undefined, land: navigate, close: () => Promise.resolve() };
  }

  const id = String(++lastLaunchId);
  const listeners = new Set<() => void>();
  let answer: RemixLaunchAnswer | null = null;
  // Whether the creator ever listened: until then, one may still be mounting.
  let taken = false;
  let creatorGone!: () => void;
  const gone = new Promise<void>((resolve) => { creatorGone = resolve; });
  // Answered, with no creator open: the creator has gone, or has yet to come and will
  // follow the answer as it opens. Once one has come and gone, nothing can ask again.
  const release = () => {
    if (!answer || listeners.size > 0) return;
    creatorGone();
    if (taken) launches.delete(id);
  };
  let answerConfirmed!: (confirmed: boolean) => void;
  const confirmed = new Promise<boolean>((resolve) => { answerConfirmed = resolve; });
  // Readable once any free unlock is recorded, or once the start is answered as this remix.
  let markReadable!: (readable: boolean) => void;
  const readable = new Promise<boolean>((resolve) => { markReadable = resolve; });
  const read = () => readable.then((open) => {
    // Only a creator the answer took back gets here, and it never sees this (`afterAnswer`).
    if (!open) throw new Error('This remix did not start.');
    return api.getRemixSourceBundle(generationId, { postId });
  });
  // Sent whether or not the creator takes it (the answer can close it before it opens), so
  // a failure nobody reads is handled here.
  const tapRead = read();
  tapRead.catch(() => undefined);
  let tapReadTaken = false;
  let exitClaimed = false;
  const leaving = () => new Promise<never>(() => undefined);
  const afterAnswer = (source: Promise<RemixSourceBundle>) => source.then(
    (bundle) => confirmed.then((ok) => (ok ? bundle : leaving())),
    (error: unknown) => confirmed.then((ok) => (ok ? Promise.reject(error) : leaving())),
  );

  const launch: RemixLaunch = {
    generationId,
    postId,
    modelId: item.details?.model?.trim() || null,
    get answer() {
      return answer;
    },
    subscribe(listener) {
      taken = true;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        release();
      };
    },
    readSource() {
      if (tapReadTaken) return afterAnswer(read());
      tapReadTaken = true;
      return afterAnswer(tapRead);
    },
    claimExit() {
      if (exitClaimed) return false;
      exitClaimed = true;
      return true;
    },
  };
  const settle = (next: RemixLaunchAnswer) => {
    if (answer) return;
    answer = next;
    markReadable(next.kind === 'confirmed');
    answerConfirmed(next.kind === 'confirmed');
    listeners.forEach((listener) => listener());
    release();
  };
  // A launch whose creator never came stays only until newer taps push it out.
  for (const [kept, entry] of launches) {
    if (launches.size < LAUNCHES_KEPT) break;
    if (entry.answer) launches.delete(kept);
  }
  launches.set(id, launch);
  navigate(`${expected}&${REMIX_LAUNCH_PARAM}=${id}`);
  return {
    sourceReadable: () => markReadable(true),
    land: (href) => settle(href === expected ? { kind: 'confirmed' } : { kind: 'replaced', href }),
    close: () => {
      settle({ kind: 'closed' });
      return gone;
    },
  };
}

/**
 * The row for a post read by id (`api.getShowcasePost`), for a creator whose
 * link named the post alone. Read as the reel reads the post, as Home's links
 * are, so the row says what it would have said opened from either.
 */
export function showcasePostRemixSourceContext(post: ShowcaseFeedItem): RemixSourceContext {
  return getRemixSourceContext(buildImmersiveShowcaseItems('showcase-feed', [post])[0]);
}

function isRemixUnlockRequired(error: unknown) {
  return error instanceof Error
    && (error as Error & { code?: unknown }).code === REMIX_UNLOCK_REQUIRED_CODE;
}
