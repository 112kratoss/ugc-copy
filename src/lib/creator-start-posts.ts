import {
  fitRemixToBalance,
  longestLengthWithin,
  type RemixCandidate,
} from '../../ugc-mobile/lib/creator-run-fit/creator-run-fit';
import type { HomeShelfCreation } from '@/lib/home-shelf';
import type { RemixTool } from '@/lib/remix-tools';

/**
 * "Start from a post" on the creators' empty canvas, and the posts to watch while a run
 * works (owner, 2026-10-28): the Home shelf's creations, the creator's own tool first,
 * each priced as the remix its Remix opens. A video post's remix is fitted to the balance
 * as the page fits it once open (`fitRemixToBalance`, Seedance 2 Mini first), so the card
 * says the price the page will. The server prices the post's run on every model ahead
 * (`creator-start-posts-server.ts`), which no balance changes; the balance is read here.
 */

/** A video post's run on every model the web offers, priced, as a remix fitted to a balance reads it. */
export interface StartPostRemixForecast {
  /** The run on the post's own model, as its remix opens before any fitting. */
  original: { modelId: string; cost: number; durationSeconds: number };
  /** The same run moved to each other model that takes all of it (`fitVideoFormToModel`), at the price the catalog gives it. */
  candidates: RemixCandidate[];
  /**
   * The lengths under the original's of the cheapest model that takes the run
   * (`cheapestRemixCandidate`): what a balance short of every model at that length is
   * fitted to next. Null when no other model takes the run.
   */
  shorter: { modelId: string; prices: Array<{ durationSeconds: number; cost: number | null }> } | null;
  /** The catalog's default video, weighed before the cheapest. */
  preferredModelId: string | null;
  /** The display name of every model a fitted remix can open on. */
  modelNames: Record<string, string>;
}

export type CreatorStartPost = HomeShelfCreation & { remix: StartPostRemixForecast | null };

/** What a card's Remix costs, and the model and length it moved to when the balance is short of the original. */
export type StartPostRemix = {
  cost: number | null;
  fitted: { modelId: string; modelName: string; durationSeconds: number; sameLength: boolean } | null;
};

/**
 * The remix a card offers for this balance (a visitor's: the welcome credits): the
 * original while the balance covers it, else the run fitted to it, else the original. A
 * post without a forecast (an image, a motion, a video whose run the server could not
 * read) keeps the shelf's own price, the one its creator page opens on.
 */
export function startPostRemix(post: CreatorStartPost, balance: number | null): StartPostRemix {
  const listed = post.price?.kind === 'credits' ? post.price.credits : null;
  const forecast = post.remix;
  if (!forecast) return { cost: listed, fitted: null };
  const original: StartPostRemix = { cost: forecast.original.cost, fitted: null };
  const nameOf = (modelId: string) => forecast.modelNames[modelId] ?? modelId;
  const on = (modelId: string, sameLength: boolean): StartPostRemix | null => {
    const candidate = forecast.candidates.find((item) => item.modelId === modelId);
    return candidate && candidate.cost !== null
      ? { cost: candidate.cost, fitted: { modelId, modelName: nameOf(modelId), durationSeconds: candidate.durationSeconds, sameLength } }
      : null;
  };

  const decision = fitRemixToBalance({
    original: forecast.original,
    candidates: forecast.candidates,
    balance,
    preferredModelId: forecast.preferredModelId,
  });
  if (decision.kind === 'fitted') return on(decision.modelId, decision.sameLength) ?? original;
  if (decision.kind === 'shorten' && balance !== null) {
    const prices = forecast.shorter?.modelId === decision.modelId ? forecast.shorter.prices : [];
    const length = longestLengthWithin(prices, balance, decision.durationSeconds);
    const cost = prices.find((price) => price.durationSeconds === length)?.cost ?? null;
    if (length !== null && cost !== null) {
      return { cost, fitted: { modelId: decision.modelId, modelName: nameOf(decision.modelId), durationSeconds: length, sameLength: false } };
    }
    if (decision.otherwise) return on(decision.otherwise.modelId, decision.otherwise.sameLength) ?? original;
  }
  return original;
}

/** The creator's own tool first, then the rest, each group in the shelf's order (owner, 2026-10-28). */
export function orderStartPosts<T extends { tool: RemixTool }>(posts: readonly T[], tool: RemixTool): T[] {
  return [...posts.filter((post) => post.tool === tool), ...posts.filter((post) => post.tool !== tool)];
}
