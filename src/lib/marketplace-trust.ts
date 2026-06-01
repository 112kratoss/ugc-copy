import {
  getPostResourceKinds,
  normalizePostResourceAttachments,
  normalizePostResourceItems,
  type MarketplacePriceQuote,
  type PersistedPostResourceBundleAccessMode,
  type PostResourceBundleAccessMode,
  type PostResourceBundleResources,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';

interface MarketplaceQualityIssue {
  code: string;
  field: string;
  message: string;
}

export interface MarketplaceQualityAssessment {
  eligible: boolean;
  issues: MarketplaceQualityIssue[];
}

export interface MarketplaceQualityInput {
  title?: string | null;
  summary?: string | null;
  previewText?: string | null;
  accessMode?: PostResourceBundleAccessMode | PersistedPostResourceBundleAccessMode | null;
  priceUsdCents?: number | null;
  resources?: Partial<PostResourceBundleResources> | null;
  resourceKinds?: PostResourceKind[] | null;
  post?: {
    title?: string | null;
    body?: string | null;
    postFormat?: string | null;
    visibility?: string | null;
    archivedAt?: string | null;
    reviewStatus?: string | null;
    mediaUrl?: string | null;
    mediaKind?: string | null;
    hasMedia?: boolean | null;
  } | null;
  seller?: {
    username?: string | null;
    name?: string | null;
    displayName?: string | null;
  } | null;
}

export function formatBundleAccessLabel({
  accessMode,
  priceQuote,
}: {
  accessMode: PersistedPostResourceBundleAccessMode;
  priceQuote: MarketplacePriceQuote;
}): string {
  if (accessMode === 'free' || priceQuote.amountSubunits === 0) {
    return 'Free unlock';
  }

  return `${priceQuote.formatted} unlock`;
}

export function assessMarketplaceListingQuality(input: MarketplaceQualityInput): MarketplaceQualityAssessment {
  const issues: MarketplaceQualityIssue[] = [];
  const title = normalizeText(input.title);
  const preview = firstUsefulText(input.summary, input.previewText);
  const post = input.post ?? null;

  if (!title || title.length < 6) {
    issues.push({
      code: 'missing_title',
      field: 'title',
      message: 'Add a clear listing title with at least 6 characters.',
    });
  } else if (isPlaceholderText(title)) {
    issues.push({
      code: 'placeholder_title',
      field: 'title',
      message: 'Replace the placeholder listing title with a specific buyer-facing title.',
    });
  }

  if (!preview || preview.length < 18 || isPlaceholderText(preview)) {
    issues.push({
      code: 'missing_preview',
      field: 'preview',
      message: 'Add a useful preview or summary that tells buyers what they will unlock.',
    });
  }

  if (!hasMeaningfulResources(input.resources, input.resourceKinds)) {
    issues.push({
      code: 'missing_resources',
      field: 'resources',
      message: 'Attach at least one useful prompt, workflow, file, note, or remix permission.',
    });
  }

  if (input.accessMode === 'paid' && Math.round(input.priceUsdCents ?? 0) < 100) {
    issues.push({
      code: 'invalid_price',
      field: 'price',
      message: 'Paid unlocks must be priced at $1.00 or above.',
    });
  }

  if (!post || post.visibility !== 'public' || post.archivedAt || post.reviewStatus === 'hidden') {
    issues.push({
      code: 'post_not_public',
      field: 'post',
      message: 'Publish a visible public post before listing this unlock in the marketplace.',
    });
  } else if (!hasUsefulPublicProof(post)) {
    issues.push({
      code: 'missing_public_proof',
      field: 'post',
      message: 'Add useful public post content or media so buyers can judge the result before unlocking.',
    });
  }

  if (!hasCreatorIdentity(input.seller)) {
    issues.push({
      code: 'missing_creator_identity',
      field: 'creator',
      message: 'Complete your creator profile name or username before publishing a marketplace unlock.',
    });
  }

  return {
    eligible: issues.length === 0,
    issues,
  };
}

export function getMarketplaceQualityError(input: MarketplaceQualityInput): string | null {
  const assessment = assessMarketplaceListingQuality(input);
  if (assessment.eligible) {
    return null;
  }

  return `Improve this unlock before publishing: ${assessment.issues[0].message}`;
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function firstUsefulText(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function isPlaceholderText(value: string): boolean {
  const comparable = normalizeComparableText(value);
  if (!comparable) {
    return true;
  }

  const placeholderTokens = new Set([
    'asdf',
    'demo',
    'draft',
    'example',
    'foo',
    'ipsum',
    'lorem',
    'placeholder',
    'sample',
    'test',
    'testing',
    'todo',
    'untitled',
  ]);
  const tokens = comparable.split(/\s+/).filter(Boolean);
  if (tokens.some((token) => placeholderTokens.has(token))) {
    return true;
  }

  const compact = comparable.replace(/\s+/g, '');
  if (compact.length >= 6) {
    const uniqueChars = new Set(compact).size;
    if (uniqueChars <= 3) {
      return true;
    }

    for (let size = 1; size <= 3; size += 1) {
      const pattern = compact.slice(0, size);
      if (pattern.repeat(Math.ceil(compact.length / size)).slice(0, compact.length) === compact) {
        return true;
      }
    }
  }

  return false;
}

function hasCreatorIdentity(seller: MarketplaceQualityInput['seller']): boolean {
  const username = normalizeComparableText(normalizeText(seller?.username));
  const displayName = normalizeComparableText(normalizeText(seller?.displayName ?? seller?.name));
  const genericNames = new Set(['anonymous', 'creator', 'magicbooklet', 'unknown', 'user']);

  return Boolean(
    (username.length >= 3 && !genericNames.has(username) && !isPlaceholderText(username)) ||
    (displayName.length >= 3 && !genericNames.has(displayName) && !isPlaceholderText(displayName))
  );
}

function hasUsefulPublicProof(post: NonNullable<MarketplaceQualityInput['post']>): boolean {
  if (post.hasMedia || post.mediaUrl || post.mediaKind) {
    return true;
  }

  const body = normalizeText(post.body);
  if (body.length >= 24 && !isPlaceholderText(body)) {
    return true;
  }

  const title = normalizeText(post.title);
  return title.length >= 12 && !isPlaceholderText(title);
}

function hasMeaningfulResources(
  resources: Partial<PostResourceBundleResources> | null | undefined,
  resourceKinds: PostResourceKind[] | null | undefined
): boolean {
  if (!resources) {
    return Array.isArray(resourceKinds) && resourceKinds.length > 0;
  }

  const attachments = normalizePostResourceAttachments(resources.attachments);
  const items = normalizePostResourceItems(resources.items, resources);
  const promptText = normalizeText(resources.promptText);
  const notesMarkdown = normalizeText(resources.notesMarkdown);
  const workflowShareUrl = normalizeText(resources.workflowShareUrl);
  const kinds = getPostResourceKinds({
    ...resources,
    attachments,
  });

  return Boolean(
    (promptText.length >= 20 && !isPlaceholderText(promptText)) ||
    (notesMarkdown.length >= 20 && !isPlaceholderText(notesMarkdown)) ||
    workflowShareUrl ||
    resources.workflowSnapshot ||
    attachments.some((attachment) => attachment.label.length >= 4 && !isPlaceholderText(attachment.label)) ||
    items.some((item) =>
      item.title.length >= 4 &&
      !isPlaceholderText(item.title) &&
      Boolean(item.textContent || item.externalUrl || item.storagePath || item.workflowSnapshot || item.remixUse !== 'none')
    ) ||
    resources.allowRemix ||
    kinds.some((kind) => resourceKinds?.includes(kind))
  );
}
