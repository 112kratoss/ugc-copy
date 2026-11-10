import type { PostResourceBundleInput } from '@/lib/post-resource-bundles';
import type { ShowcasePublishRequestBody } from '@/lib/showcase-publish-service';

/**
 * The publish request an agent's `publish_post` sends, built as the creator page's one-click
 * Publish builds its own (`usePublishCreation.ts`), so a post an agent publishes is the post the
 * web would have published from the same creation.
 *
 * With remixes allowed (the default, as on the web) the post carries the creation's recipe, free:
 * its exact prompt, which the server adds as the locked "Exact generation prompt" item where the
 * recipe has no prompt item of its own, and copies of the saved inputs the creation may share
 * (`includeGenerationReferences`), with the summary and preview the web writes for a recipe of
 * the prompt and the remix. With remixes off the media goes alone, with no recipe: the server
 * gates a creation post's Remix at its recipe's unlock, so a post without one offers none, and
 * the "Allow remixes" switch is left out, since the server reads a composer that sends it as one
 * that offers no post without a recipe (`CREATION_RECIPE_REQUIRED`). A creation with no prompt
 * has nothing a free recipe could hold, so it goes alone either way.
 *
 * The recipe is free unless the person set a price (owner, 2026-11-10): then it is the same
 * recipe, paid, as the web's Publish sends one (`buildAutoResourceBundle`: `accessMode: 'paid'`
 * and the price in `priceUsdCents`, which holds the token count). Nothing is computed here: the
 * publish service's validator holds the price to its minimum and steps, keeps a paid recipe's
 * prompt out of the post's title and text, and holds a remix to the terms of what it remixed.
 */

export type AgentPublishArgs = {
  generationId: string;
  title?: string;
  description?: string;
  body?: string;
  category?: string;
  visibility: 'public' | 'private';
  isNsfw?: boolean;
  allowRemixes: boolean;
  /** The creation's own prompt, as stored; null for a run that had none. */
  creationPrompt: string | null;
  /** The recipe's price in tokens, where the person set one; absent or 0, the recipe is free. */
  recipePriceTokens?: number;
  /** The recipe's listing line and preview in the person's words; absent, the web's own. */
  recipeSummary?: string;
  recipePreview?: string;
};

/** The listing lines the web writes for the recipe of a prompt and a remix (`buildAutoUnlockSummary`, `buildAutoUnlockPreview`). */
export const AGENT_RECIPE_SUMMARY = 'Prompt and remix from this creation';
export const AGENT_RECIPE_PREVIEW = 'Unlock the saved prompt and remix used to create this result.';

/**
 * The recipe a remixable agent post carries: the prompt now, the server's additions at publish.
 * Free, or paid at the price given, with the web's listing lines unless the person wrote their own.
 */
export function agentRecipeBundle(
  promptText: string,
  { priceTokens = 0, summary, preview }: { priceTokens?: number; summary?: string; preview?: string } = {},
): PostResourceBundleInput {
  const paid = priceTokens > 0;
  return {
    accessMode: paid ? 'paid' : 'free',
    summary: summary?.trim() || AGENT_RECIPE_SUMMARY,
    previewText: preview?.trim() || AGENT_RECIPE_PREVIEW,
    priceUsdCents: paid ? priceTokens : 0,
    resources: {
      promptText,
      workflowShareUrl: null,
      attachments: [],
      // No live input is handed over: the recipe holds copies of what it shares (owner, 2026-11-05).
      allowRemix: false,
    },
  };
}

/** The free recipe a remixable agent post carries. */
export function agentFreeRecipeBundle(promptText: string): PostResourceBundleInput {
  return agentRecipeBundle(promptText);
}

/** Whether a publish of this creation carries a recipe: remixes allowed, and a prompt for it to hold. */
export function agentPublishSendsRecipe(args: Pick<AgentPublishArgs, 'allowRemixes' | 'creationPrompt'>): boolean {
  return args.allowRemixes && (args.creationPrompt?.trim() ?? '').length > 0;
}

export function buildAgentPublishRequest(args: AgentPublishArgs): ShowcasePublishRequestBody {
  const prompt = args.creationPrompt?.trim() ?? '';
  const sendsRecipe = agentPublishSendsRecipe(args);
  const request: ShowcasePublishRequestBody = {
    generationId: args.generationId,
    visibility: args.visibility,
    shareInputMediaForRemix: false,
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.body !== undefined ? { body: args.body } : {}),
    ...(args.category !== undefined ? { category: args.category } : {}),
    ...(args.isNsfw ? { isNsfw: true } : {}),
  };
  if (sendsRecipe) {
    request.allowRemixes = true;
    request.resourceBundle = agentRecipeBundle(prompt, {
      priceTokens: args.recipePriceTokens,
      summary: args.recipeSummary,
      preview: args.recipePreview,
    });
    request.includeGenerationReferences = true;
  } else {
    request.resourceBundle = { accessMode: 'none' };
  }
  return request;
}
