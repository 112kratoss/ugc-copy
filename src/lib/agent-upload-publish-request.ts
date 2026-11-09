import { createHash } from 'node:crypto';

import {
  APP_SOURCE_TOOL_DISPLAY_LABEL,
  isAppSourceToolLabel,
  slugifySourceTool,
  validateSourceToolSelections,
  type SourceToolSelection,
} from '@/lib/source-tools';

/**
 * The post an agent's `publish_post` makes from files it staged (`uploads`): media made outside
 * Magicbooklet, by another tool or on the person's own machine. It is built as the composer page
 * builds its own request (`NewPostClient.tsx`: the same form fields, a media post or a media post
 * with a note, no recipe), so the composer service's rules decide it and the post is the one the
 * web would have made from the same files.
 *
 * Three things here are the agent's own. The post's id is derived from the creator and the staged
 * paths, so a publish repeated after a lost answer finds the post it made instead of making a
 * second. Made with is what the agent says made the media, as free text: a name the catalog knows
 * is filed under it, any other is kept on the post alone, and the shared catalog is never added
 * to (the composer's `createTool` and `createModel` are never sent). And Magicbooklet's own name
 * is not one of those names: media made here is published from its creation, which names its
 * model itself.
 */

export type AgentMadeWithEntry = { tool: string; model?: string };

/** One staged file of a post, with the type the server recorded for it (never the agent's word). */
export type AgentUploadPublishMedia = { storagePath: string; contentType: string | null };

export type AgentUploadPublishArgs = {
  title: string;
  description?: string;
  body?: string;
  category?: string;
  visibility: 'public' | 'private';
  isNsfw?: boolean;
  madeWith: readonly AgentMadeWithEntry[];
  uploads: readonly AgentUploadPublishMedia[];
};

const POST_ID_NAMESPACE = 'magicbooklet:agent-upload-post:v1';

/**
 * The id of the post this creator makes from these staged files, in this order: a UUID whose
 * bits are a SHA-256 of the three, marked version 8 (RFC 9562's form for an id of one's own
 * making) with RFC 4122's variant bits, so it is a UUID wherever one is checked. A staged path is
 * spent by the publish that uses it, so the same paths name the same post and nothing else.
 */
export function agentUploadPostId(userId: string, storagePaths: readonly string[]): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([POST_ID_NAMESPACE, userId.trim().toLowerCase(), storagePaths]))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether a name is Magicbooklet's own, in any spelling the catalog reads as the app's tool. */
export function namesMagicbooklet(tool: string): boolean {
  const slug = slugifySourceTool(tool);
  return isAppSourceToolLabel(tool) || isAppSourceToolLabel(slug) || slug === 'emptybooklet';
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
  if (madeWith.some((entry) => namesMagicbooklet(entry.tool))) return AGENT_MADE_WITH_APP_REFUSAL;
  return validateSourceToolSelections(agentMadeWithSelections(madeWith));
}

/** A staged object's name without the upload id the sign step prefixes: the name the post's media is filed under. */
function originalNameOf(storagePath: string): string {
  const base = storagePath.split('/').pop() ?? '';
  return base.replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/iu, '') || base;
}

/**
 * The form the composer service reads (`preparePostCreationSubmission`), field for field as the
 * composer page fills it for uploaded media: `postFormat` is `mixed` for media with a note and
 * `media` without one, the category is the one given or the first file's kind, and the recipe is
 * none (an upload has no prompt or inputs to share).
 */
export function buildAgentUploadPublishFormData(args: AgentUploadPublishArgs): FormData {
  const sourceTools = agentMadeWithSelections(args.madeWith);
  const body = args.body?.trim() ?? '';
  const firstType = args.uploads[0]?.contentType ?? '';
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
  formData.set('postFormat', body ? 'mixed' : 'media');
  formData.set('resourceBundle', JSON.stringify({ accessMode: 'none' }));
  formData.set('mediaItems', JSON.stringify(args.uploads.map((upload) => ({
    storagePath: upload.storagePath,
    originalName: originalNameOf(upload.storagePath),
    contentType: upload.contentType ?? '',
  }))));
  formData.set('category', args.category ?? (firstType.startsWith('video/') ? 'video' : 'image'));
  return formData;
}
