import { createHash } from 'node:crypto';

import {
  buildResourceCardBundleInput,
  createPostComposerResourceCard,
} from '@/lib/post-composer-resource-cards';
import {
  POST_RESOURCE_CARD_DESCRIPTION_MAX_LENGTH,
  POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS,
  POST_RESOURCE_PRICE_INCREMENT_USD_CENTS,
  type PostResourceBundleInput,
} from '@/lib/post-resource-bundles';
import {
  APP_SOURCE_TOOL_DISPLAY_LABEL,
  isAppSourceToolLabel,
  slugifySourceTool,
  validateSourceToolSelections,
  type SourceToolSelection,
} from '@/lib/source-tools';

/**
 * The posts an agent's `publish_post` makes through the composer's own create, where no creation
 * is behind them: a post of files the agent staged (`uploads`: media made outside Magicbooklet, by
 * another tool or on the person's own machine), and a text post. Either may carry a resource: a
 * prompt, a guide or a link, free or at a price the person set, which is how an agent shares a
 * skill or a prompt pack. The request is built as the composer page builds its own
 * (`NewPostClient.tsx`: the same form fields; the resource through the composer's own serializer,
 * `buildResourceCardBundleInput`), so the composer service's rules decide it and the post is one
 * the web could have made.
 *
 * What is the agent's own here. The post's id is derived, from the creator and the staged paths
 * or the text, so a publish repeated after a lost answer finds the post it made instead of making
 * a second. Made with is what the agent says made the media, as free text: a name the catalog
 * knows is filed under it, any other is kept on the post alone, and the shared catalog is never
 * added to (the composer's `createTool` and `createModel` are never sent). Magicbooklet's own name
 * is not one of those names: media made here is published from its creation, which names its
 * model itself. And a resource holds text and links only, no file, on cards whose ids this module
 * gives (the composer's factory mints random ones), so the same cards serialize the same bundle.
 *
 * Nothing here prices anything: a price is the person's number, passed to the serializer as the
 * composer passes it, and the composer service's validator is the authority on it.
 */

export type AgentMadeWithEntry = { tool: string; model?: string };

/** One staged file of a post, with the type the server recorded for it (never the agent's word). */
export type AgentUploadPublishMedia = { storagePath: string; contentType: string | null };

/** One thing a person gets from a post's resource: a prompt or a guide (its text), or a link. */
export type AgentResourceCard = {
  type: 'prompt' | 'guide' | 'external_link';
  title: string;
  /** A line under the card's title, shown once the resource is unlocked (the locked preview carries titles only). */
  description?: string;
  /** The text of a `prompt` or a `guide`, shown once unlocked. */
  text?: string;
  /** The address of an `external_link`, shown once unlocked. */
  url?: string;
};

export type AgentComposedPostArgs = {
  title: string;
  description?: string;
  body?: string;
  category?: string;
  visibility: 'public' | 'private';
  isNsfw?: boolean;
  /** Required for uploads by the tool; a text post may name what its words are about, or nothing. */
  madeWith?: readonly AgentMadeWithEntry[];
  /** The staged files, in the post's order; none for a text post. */
  uploads?: readonly AgentUploadPublishMedia[];
  /** The post's resource as `buildAgentResourceBundle` made it; null or absent for none. */
  resourceBundle?: PostResourceBundleInput | null;
};

const UPLOAD_POST_ID_NAMESPACE = 'magicbooklet:agent-upload-post:v1';
const TEXT_POST_ID_NAMESPACE = 'magicbooklet:agent-text-post:v1';

/**
 * A UUID whose bits are a SHA-256 of the parts, marked version 4 with RFC 4122's variant bits:
 * the form every other post id has (`randomUUID`), so every check that reads a post id takes it.
 * Not version 8, RFC 9562's form for an id of one's own making: account deletion reads each post's
 * storage paths with a pattern that takes versions 1 to 5 (`account-deletion-service.ts`), after
 * the account is marked as deleting, and an id it refused would leave the account never erased.
 */
function derivedPostId(parts: readonly unknown[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The id of the post this creator makes from these staged files, in this order. A staged path is
 * spent by the publish that uses it, so the same paths name the same post and nothing else.
 */
export function agentUploadPostId(userId: string, storagePaths: readonly string[]): string {
  return derivedPostId([UPLOAD_POST_ID_NAMESPACE, userId.trim().toLowerCase(), storagePaths]);
}

/**
 * The id of the text post this creator makes with this title and these words, read as the
 * composer service reads them (trimmed, line ends as `\n`). The same title and text publish once:
 * a repeat answers the post, and a post deleted since is made again.
 */
export function agentTextPostId(userId: string, title: string, body: string): string {
  return derivedPostId([
    TEXT_POST_ID_NAMESPACE,
    userId.trim().toLowerCase(),
    title.trim(),
    body.replace(/\r\n/gu, '\n').trim(),
  ]);
}

/** Letters of other scripts that read as the Latin ones in the app's name, folded before it is looked for. */
const LOOKALIKE_LETTERS: Record<string, string> = {
  'а': 'a', 'с': 'c', 'е': 'e', 'і': 'i', 'к': 'k', 'м': 'm', 'о': 'o', 'т': 't', 'ɡ': 'g', 'ӏ': 'l', 'Ь': 'b', 'ь': 'b',
  'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ο': 'o', 'τ': 't',
};

/** A name as its letters and digits alone, lower case, lookalike letters as the Latin ones they pass for. */
function compactName(name: string): string {
  return [...name.normalize('NFKC').toLowerCase()]
    .map((letter) => LOOKALIKE_LETTERS[letter] ?? letter)
    .join('')
    .normalize('NFKD')
    .replace(/[^a-z0-9]/gu, '');
}

/**
 * Whether a name is Magicbooklet's own: any spelling the catalog reads as the app's tool, and any
 * name that holds the app's name once spaces, punctuation, case and lookalike letters are set
 * aside ("magicbooklet.com", "Magic Booklet AI", a Cyrillic а). A post of media made elsewhere
 * must not say the app made it, in the tool's name or in the model's.
 */
export function namesMagicbooklet(name: string): boolean {
  const slug = slugifySourceTool(name);
  if (isAppSourceToolLabel(name) || isAppSourceToolLabel(slug) || slug === 'emptybooklet') return true;
  const compact = compactName(name);
  return compact.includes('magicbooklet') || compact.includes('emptybooklet');
}

/**
 * Made with as the composer sends it (`sourceTools`), each name as the agent gave it and the
 * slugs the composer derives for a name it was typed. No `createTool`, no `createModel`: the
 * server files a name its catalog knows under the catalog's own spelling and keeps any other on
 * the post, and an agent never grows the catalog every composer picks from.
 */
export function agentMadeWithSelections(madeWith: readonly AgentMadeWithEntry[]): SourceToolSelection[] {
  return madeWith.map(({ tool, model }) => {
    const toolLabel = tool.trim();
    const modelLabel = model?.trim() || null;
    return {
      toolLabel,
      toolSlug: slugifySourceTool(toolLabel),
      modelLabel,
      modelSlug: slugifySourceTool(modelLabel),
    };
  });
}

export const AGENT_MADE_WITH_APP_REFUSAL = `${APP_SOURCE_TOOL_DISPLAY_LABEL} is not a name for made_with: media made here is published with generation_id, which names its model itself. Name the tool that made this media.`;

/** Why a `made_with` is refused, in the composer's own words where the composer's validator refuses it; null when it stands. */
export function refuseAgentMadeWith(madeWith: readonly AgentMadeWithEntry[]): string | null {
  if (madeWith.some((entry) => namesMagicbooklet(entry.tool) || (entry.model ? namesMagicbooklet(entry.model) : false))) return AGENT_MADE_WITH_APP_REFUSAL;
  return validateSourceToolSelections(agentMadeWithSelections(madeWith));
}

// ---------------------------------------------------------------------------------------------
// A post's resource: cards of text and links

/** The validator's bound on a card's public title (`validatePostResourceBundleInput`). */
export const AGENT_RESOURCE_CARD_TITLE_MAX_LENGTH = 80;
/**
 * The tool's own bounds, where the composer and its validator set none: how many cards one
 * resource holds and how long a card's text may be, so one publish stays far inside the body the
 * route can take.
 */
export const AGENT_RESOURCE_CARDS_MAX = 10;
export const AGENT_RESOURCE_CARD_TEXT_MAX_LENGTH = 50_000;

function isHttpsUrl(value: string | undefined): boolean {
  try {
    return new URL((value ?? '').trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Why a set of cards is refused before anything is built; null when each can be a card. A card
 * is one thing: a prompt or a guide is its text, an external link its https address, and one that
 * gives both, or the wrong one, is refused instead of having half of it dropped.
 */
export function refuseAgentResources(cards: readonly AgentResourceCard[]): string | null {
  if (cards.length === 0) return 'resources needs at least one card; leave it out for a post with no resource.';
  if (cards.length > AGENT_RESOURCE_CARDS_MAX) return `A resource holds at most ${AGENT_RESOURCE_CARDS_MAX} cards.`;
  for (const [index, card] of cards.entries()) {
    const named = `resources[${index}]`;
    const title = card.title?.trim() ?? '';
    if (!title) return `${named} needs a title: what the person gets, in a few words.`;
    if (title.length > AGENT_RESOURCE_CARD_TITLE_MAX_LENGTH) {
      return `${named}: a card's title is at most ${AGENT_RESOURCE_CARD_TITLE_MAX_LENGTH} characters.`;
    }
    if ((card.description?.trim().length ?? 0) > POST_RESOURCE_CARD_DESCRIPTION_MAX_LENGTH) {
      return `${named}: a card's description is at most ${POST_RESOURCE_CARD_DESCRIPTION_MAX_LENGTH} characters.`;
    }
    if (card.type === 'external_link') {
      if (!isHttpsUrl(card.url)) return `${named} is an external_link: give url, an https address.`;
      if (card.text?.trim()) return `${named} is an external_link: it carries a url, not text. Put text in a prompt or guide card.`;
    } else if (card.type === 'prompt' || card.type === 'guide') {
      if (!card.text?.trim()) return `${named} is a ${card.type}: give its text.`;
      if (card.text.length > AGENT_RESOURCE_CARD_TEXT_MAX_LENGTH) {
        return `${named}: a card's text is at most ${AGENT_RESOURCE_CARD_TEXT_MAX_LENGTH} characters.`;
      }
      if (card.url?.trim()) return `${named} is a ${card.type}: it carries text, not a url. Put a link in an external_link card.`;
    } else {
      return `${named}: type is prompt, guide or external_link.`;
    }
  }
  return null;
}

/**
 * Why a price is refused; null for none, zero (free) or a price a paid resource may have. The
 * two numbers are the composer validator's own, compared and never computed with: a paid
 * resource starts at the minimum and moves in whole steps. A price with nothing to carry it is
 * refused too: it would be dropped without a word.
 */
export function refuseAgentResourcePrice(priceTokens: number | undefined, carriesResource: boolean): string | null {
  if (priceTokens === undefined || priceTokens === 0) return null;
  if (
    !Number.isSafeInteger(priceTokens)
    || priceTokens < POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS
    || priceTokens % POST_RESOURCE_PRICE_INCREMENT_USD_CENTS !== 0
  ) {
    return `resource_price_tokens is a whole number of tokens, ${POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS} or more, in steps of ${POST_RESOURCE_PRICE_INCREMENT_USD_CENTS} (100 tokens = $1.00). Leave it out, or give 0, for a free resource.`;
  }
  if (!carriesResource) {
    return 'resource_price_tokens prices a resource, and this post carries none: give resources (a text post or uploads), or publish a creation with its recipe (allow_remixes on).';
  }
  return null;
}

/**
 * The resource of a text post or an upload post, as the composer's serializer makes it from the
 * same cards: free, or paid at the price given. The summary and the preview are the person's
 * words where given, else what the serializer derives from the cards' titles. Null when no card
 * has content (the serializer drops an empty card), which `refuseAgentResources` rules out.
 */
export function buildAgentResourceBundle({
  cards,
  priceTokens = 0,
  summary,
  preview,
}: {
  cards: readonly AgentResourceCard[];
  priceTokens?: number;
  summary?: string;
  preview?: string;
}): PostResourceBundleInput | null {
  return buildResourceCardBundleInput({
    accessMode: priceTokens > 0 ? 'paid' : 'free',
    cards: cards.map((card, index) => createPostComposerResourceCard(card.type, {
      id: `agent-resource-${index + 1}`,
      title: card.title.trim(),
      preview: card.description?.trim() ?? '',
      textContent: card.type === 'external_link' ? '' : card.text ?? '',
      externalUrl: card.type === 'external_link' ? card.url?.trim() ?? '' : '',
    })),
    // No live input is handed to a remix: these cards are text and links, and nothing to remix.
    allowRemix: false,
    summary: summary ?? '',
    previewText: preview ?? '',
    priceTokens,
  });
}

/** What a post's resource is, in the three words every answer uses. */
export function agentResourceAccess(bundle: PostResourceBundleInput | null | undefined): 'none' | 'free' | 'paid' {
  return bundle?.accessMode === 'paid' ? 'paid' : bundle?.accessMode === 'free' ? 'free' : 'none';
}

// ---------------------------------------------------------------------------------------------
// The form the composer service reads

/** A staged object's name without the upload id the sign step prefixes: the name the post's media is filed under. */
function originalNameOf(storagePath: string): string {
  const base = storagePath.split('/').pop() ?? '';
  return base.replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/iu, '') || base;
}

/**
 * The form the composer service reads (`preparePostCreationSubmission`), field for field as the
 * composer page fills it. With staged files: `postFormat` is `mixed` for media with a note and
 * `media` without one, and the category is the one given or the first file's kind. With none it
 * is the composer's text post: `postFormat` and `category` both `text`. The resource is the
 * bundle given, else none.
 */
export function buildAgentComposedPostFormData(args: AgentComposedPostArgs): FormData {
  const sourceTools = agentMadeWithSelections(args.madeWith ?? []);
  const uploads = args.uploads ?? [];
  const body = args.body?.trim() ?? '';
  const formData = new FormData();
  formData.set('title', args.title);
  formData.set('body', body);
  if (args.description) formData.set('description', args.description);
  if (sourceTools[0]) {
    formData.set('sourceTool', sourceTools[0].toolLabel);
    if (sourceTools[0].toolSlug) formData.set('sourceToolSlug', sourceTools[0].toolSlug);
    formData.set('sourceTools', JSON.stringify(sourceTools));
  }
  formData.set('visibility', args.visibility);
  formData.set('isNsfw', String(args.isNsfw === true));
  formData.set('resourceBundle', JSON.stringify(args.resourceBundle ?? { accessMode: 'none' }));
  if (uploads.length === 0) {
    formData.set('postFormat', 'text');
    formData.set('category', 'text');
    return formData;
  }
  const firstType = uploads[0]?.contentType ?? '';
  formData.set('postFormat', body ? 'mixed' : 'media');
  formData.set('mediaItems', JSON.stringify(uploads.map((upload) => ({
    storagePath: upload.storagePath,
    originalName: originalNameOf(upload.storagePath),
    contentType: upload.contentType ?? '',
  }))));
  formData.set('category', args.category ?? (firstType.startsWith('video/') ? 'video' : 'image'));
  return formData;
}
