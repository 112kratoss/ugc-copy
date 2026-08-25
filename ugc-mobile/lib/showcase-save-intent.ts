/**
 * Ordering primitives shared by every surface that can save a post.
 *
 * The scope decides which requests may be in flight together; the ledger
 * decides which responses are still worth listening to. Neither is enough on
 * its own — serializing pins which write lands last but lets an obsolete
 * response reconcile on its way past, and silencing obsolete responses leaves
 * two requests racing each other to the database.
 */

/**
 * Every save queues behind the last one, across posts and across surfaces.
 *
 * Two taps on one post used to fan out two overlapping POSTs, and whichever
 * response landed last won — in the cache *and* in the database, since the two
 * requests race each other through auth and the rate-limit check before either
 * reaches its RPC. React Query runs same-scope mutations in series instead, and
 * `onMutate` is not gated by the scope (the gate lives inside the retryer, after
 * the optimistic write), so the heart still flips on the tap while only the
 * request waits.
 *
 * It is deliberately one queue rather than one per post: `scope` is read from
 * the hook's options, not from the variables, and the home feed shares a single
 * hook across every card, so per-post scoping would mean a mutation per cell.
 * The cost of the coarse queue is that a save on one post waits out an in-flight
 * save on another — one round trip, bounded by the 30s timeout in
 * api-client.ts:209. Keying by surface would narrow that, but the post page is
 * pushed *over* the feed with both hooks mounted, so the same post could still
 * race itself across the two.
 *
 * Both the feed hook and the viewer's own mutation join this one queue rather
 * than open a second one alongside it.
 */
export const SHOWCASE_SAVE_MUTATION_SCOPE = { id: 'showcase-save' } as const;

/**
 * Which tap a save response belongs to.
 *
 * Serializing the requests (see `SHOWCASE_SAVE_MUTATION_SCOPE`) pins which write
 * lands last, but not which write lands at all. With a save still in flight, the
 * unsave that follows it flips the heart optimistically and *then* the save's
 * own response reconciles the truth it was told a moment ago — flicking the
 * heart back until the unsave returns. An overtaken tap has nothing left to say:
 * its result, its rollback and its error buzz all describe an intent the viewer
 * has already replaced, so the ledger lets each surface drop them.
 *
 * Sequence numbers are per post and only ever compared for equality, so the
 * counter restarting at 1 after a post settles is harmless — by then nothing for
 * that post is in flight.
 */
export interface ShowcaseSaveIntentLedger {
  /** Records a fresh tap on `postId` and returns the sequence number to carry. */
  open(postId: string): number;
  /** Whether a newer tap on `postId` has replaced `intentSeq`. */
  isOvertaken(postId: string, intentSeq: number): boolean;
  /** Forgets `postId`, so the ledger holds only posts with a save in flight. */
  close(postId: string, intentSeq: number): void;
}

export function createShowcaseSaveIntentLedger(): ShowcaseSaveIntentLedger {
  const latestByPostId = new Map<string, number>();

  return {
    open(postId) {
      const intentSeq = (latestByPostId.get(postId) ?? 0) + 1;
      latestByPostId.set(postId, intentSeq);
      return intentSeq;
    },
    isOvertaken(postId, intentSeq) {
      return latestByPostId.get(postId) !== intentSeq;
    },
    close(postId, intentSeq) {
      if (latestByPostId.get(postId) === intentSeq) {
        latestByPostId.delete(postId);
      }
    },
  };
}

/**
 * The app-wide ledger, shared by every save surface.
 *
 * Deliberately a module singleton rather than one per hook, for the same reason
 * `SHOWCASE_SAVE_MUTATION_SCOPE` is: a post saved from the feed and then unsaved
 * from the viewer it opens into is one conversation about one post, held across
 * two mounted surfaces with independent mutations. A per-surface ledger would
 * let the feed's obsolete response reconcile anyway, because nothing told it the
 * viewer had spoken more recently.
 *
 * It stays small on its own — `close` drops each post as its newest tap settles,
 * so the map holds only saves currently in flight.
 */
export const showcaseSaveIntents = createShowcaseSaveIntentLedger();
