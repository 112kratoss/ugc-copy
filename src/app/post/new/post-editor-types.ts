import type { PostResourceBundleInput } from '@/lib/post-resource-bundles';
import type {
  ShowcaseItemCategory,
  ShowcaseMediaKind,
  ShowcasePostFormat,
  ShowcaseSourceKind,
  ShowcaseVisibility,
} from '@/lib/showcase';

export interface EditablePostDraft {
  id: string;
  generationId: string | null;
  title: string;
  description: string;
  prompt: string;
  body: string;
  visibility: ShowcaseVisibility;
  category: ShowcaseItemCategory;
  postFormat: ShowcasePostFormat;
  sourceKind: ShowcaseSourceKind;
  sourceTool: string | null;
  sourceToolSlug?: string | null;
  mediaUrl: string | null;
  mediaKind: ShowcaseMediaKind | null;
  archivedAt: string | null;
  resourceBundle: PostResourceBundleInput;
  hasPaidOrders: boolean;
}
