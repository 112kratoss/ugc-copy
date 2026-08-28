import type { PostResourceBundleInput } from '@/lib/post-resource-bundles';
import type {
  ShowcaseItemCategory,
  ShowcaseMediaKind,
  ShowcaseMediaItem,
  ShowcasePostFormat,
  ShowcaseSourceKind,
  ShowcaseVisibility,
} from '@/lib/showcase';

export interface EditablePostDraft {
  id: string;
  generationId: string | null;
  title: string;
  /**
   * The stored title without the "Untitled post" display fallback; '' when the
   * post has none. Editors must hydrate from this — echoing the fallback back
   * on save trips the marketplace placeholder gate. Optional because older
   * callers may not supply it; the composer then falls back to `title`.
   */
  rawTitle?: string;
  description: string;
  prompt: string;
  body: string;
  visibility: ShowcaseVisibility;
  category: ShowcaseItemCategory;
  postFormat: ShowcasePostFormat;
  sourceKind: ShowcaseSourceKind;
  sourceTool: string | null;
  sourceToolSlug?: string | null;
  sourceTools?: Array<{
    toolLabel: string;
    toolSlug?: string | null;
    modelLabel?: string | null;
    modelSlug?: string | null;
    createTool?: boolean;
    createModel?: boolean;
  }> | null;
  mediaUrl: string | null;
  mediaKind: ShowcaseMediaKind | null;
  mediaItems?: ShowcaseMediaItem[];
  archivedAt: string | null;
  resourceBundle: PostResourceBundleInput;
  hasPaidOrders: boolean;
}
