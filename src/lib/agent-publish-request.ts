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
};

/** The listing lines the web writes for the recipe of a prompt and a remix (`buildAutoUnlockSummary`, `buildAutoUnlockPreview`). */
export const AGENT_RECIPE_SUMMARY = 'Prompt and remix from this creation';
export const AGENT_RECIPE_PREVIEW = 'Unlock the saved prompt and remix used to create this result.';

/** The free recipe a remixable agent post carries: the prompt now, the server's additions at publish. */
export function agentFreeRecipeBundle(promptText: string): PostResourceBundleInput {
  return {
    accessMode: 'free',
    summary: AGENT_RECIPE_SUMMARY,
    previewText: AGENT_RECIPE_PREVIEW,
    priceUsdCents: 0,
    resources: {
      promptText,
      workflowShareUrl: null,
      attachments: [],
      // No live input is handed over: the recipe holds copies of what it shares (owner, 2026-11-05).
      allowRemix: false,
    },
  };
}

export function buildAgentPublishRequest(args: AgentPublishArgs): ShowcasePublishRequestBody {
  const prompt = args.creationPrompt?.trim() ?? '';
  const sendsRecipe = args.allowRemixes && prompt.length > 0;
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
    request.resourceBundle = agentFreeRecipeBundle(prompt);
    request.includeGenerationReferences = true;
  } else {
    request.resourceBundle = { accessMode: 'none' };
  }
  return request;
}
