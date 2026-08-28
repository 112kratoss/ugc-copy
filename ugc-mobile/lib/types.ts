export type CreatorToolId = 'image' | 'video' | 'motion';

export interface MobileCompatibilityPolicy {
  currentApiVersion: number;
  minimumApiVersion: number;
  minimumAppVersion: string;
  supportedCatalogSchemaVersions: number[];
  unversionedClientsUseApiVersion: number;
}

export interface AppVersionResponse {
  buildId: string;
  mobileCompatibility: MobileCompatibilityPolicy;
}

export interface MobileCompatibilityErrorResponse {
  code: 'MOBILE_UPDATE_REQUIRED' | 'MOBILE_SERVER_UPDATE_REQUIRED';
  error: string;
  compatibility: MobileCompatibilityPolicy;
}

export type MediaPreviewStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface VisualMediaDescriptor {
  id: string;
  kind: 'image' | 'video';
  url: string;
  /**
   * Small faststart copy for autoplaying surfaces. Null when the backend has
   * not produced one, so callers must fall back to `url`.
   */
  renditionUrl?: string | null;
  /** 8s muted head of a long clip; feed-only. */
  teaserUrl?: string | null;
  /**
   * The server's decision of what a feed card may autoplay. An explicit null
   * means poster-only and is authoritative; absent means an older server, and
   * the client falls back to teaser then rendition — never to `url`.
   */
  feedStreamUrl?: string | null;
  previewUrl: string | null;
  thumbhash: string | null;
  cacheKey: string;
  expiresAt: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  status: MediaPreviewStatus;
  gridReady: boolean;
}

export interface ProfileResponse {
  id: string;
  username: string | null;
  suggestedUsername?: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  websiteUrl: string | null;
  twitterHandle: string | null;
  instagramHandle: string | null;
  tiktokHandle: string | null;
  location: string | null;
  credits: number | null;
  promotionalCredits?: number | null;
  marketplaceSpendableCredits?: number | null;
}

export type OnboardingGoal = 'image' | 'video' | 'motion';
export type OnboardingStatus = 'not_started' | 'in_progress' | 'skipped' | 'completed';
export type OnboardingEventName =
  | 'started'
  | 'screen_viewed'
  | 'skipped'
  | 'auth_started'
  | 'auth_succeeded'
  | 'auth_canceled'
  | 'username_saved'
  | 'username_conflict'
  | 'reward_viewed'
  | 'reward_claimed'
  | 'reward_deferred'
  | 'reward_failed'
  | 'guided_creator_opened'
  | 'first_generation_started'
  | 'first_generation_succeeded';

export interface OnboardingStateResponse {
  state: {
    flowVersion: number;
    status: OnboardingStatus;
    goal: OnboardingGoal | null;
    usernameCompletedAt: string | null;
    rewardClaimedAt: string | null;
    completedAt: string | null;
    updatedAt: string | null;
  };
}

export interface WelcomeCreditResponse {
  programKey: string;
  status: 'eligible' | 'claimed' | 'already_claimed' | 'legacy_ineligible' | 'requires_account' | 'not_eligible' | 'unavailable';
  amount: number;
  promotionalAmount: number;
  credits: number;
  promotionalCredits: number;
  claimedAt: string | null;
  identityComplete: boolean;
}

export interface OnboardingEventRequest {
  clientEventId: string;
  eventName: OnboardingEventName;
  platform: 'ios' | 'android';
  goal?: OnboardingGoal | null;
  step?: string | null;
  occurredAt: string;
}

export interface ReferralProgramSummary {
  inviterPercent: number;
  inviteeFirstPurchasePercent: number;
  attributionWindowDays: number;
}

export interface ReferralStats {
  visits: number;
  signups: number;
  purchasers: number;
  creditsEarned: number;
  creditsReversed: number;
}

export type ReferralRewardStatus = 'granted' | 'reversed' | 'restored';
export type ReferralRewardKind = 'inviter_purchase' | 'invitee_first_purchase';

export interface ReferralReward {
  id: string;
  credits: number;
  status: ReferralRewardStatus;
  kind: ReferralRewardKind;
  createdAt: string;
}

export interface ReferralOverviewResponse {
  success: true;
  program: ReferralProgramSummary;
  code: string | null;
  shareUrl: string | null;
  stats: ReferralStats;
  recentRewards: ReferralReward[];
}

/**
 * `merged` — the guest's balance moved and its data is now reachable from this
 *   account. `already_merged` — a replay of the same redemption; treat as
 *   success. Both clear the stored ticket.
 *
 * `conflict` — the guest was already linked to a different account (two devices
 *   raced). `expired` — the ticket outlived its window. `not_eligible` — refused,
 *   and NOT terminal: the ticket stays spendable, so this one is retried rather
 *   than surfaced. None of these may be reported as a successful transfer.
 */
export type GuestAccountMergeStatus =
  | 'merged'
  | 'already_merged'
  | 'conflict'
  | 'expired'
  | 'not_eligible';

export interface GuestAccountMergeResponse {
  status: GuestAccountMergeStatus;
  creditsMoved: number;
  promotionalCreditsMoved: number;
  credits: number | null;
}

/**
 * Minted while still a guest, because that is the last moment the guest can
 * prove who it is. Persisted in Keychain/Keystore so a crash or a lost network
 * between sign-in and redemption costs a retry rather than the balance.
 */
export interface GuestAccountMergeTicketResponse {
  ticket: string;
  expiresAt: string;
}

export interface ReferralLinkRequest {
  next?: string;
}

export interface ReferralLinkResponse {
  success: true;
  code: string;
  shareUrl: string;
}

export interface ReferralVisitRequest {
  code: string;
  source: 'mobile';
  next?: string;
  installationId?: string;
}

export interface ReferralVisitResponse {
  success: true;
  visitToken: string;
  code: string;
  expiresAt: string;
}

export interface ReferralClaimRequest {
  visitToken?: string;
  code?: string;
}

export interface ReferralClaimResponse {
  success: true;
  claimed: boolean;
  reason?: string;
}

export interface GenerationListItem {
  id: string;
  output_url: string | null;
  output_urls?: string[];
  preview_url?: string | null;
  previewUrl?: string | null;
  media?: VisualMediaDescriptor | null;
  origin?: 'creation' | 'template';
  template?: {
    runId: string;
    templateId: string;
    templateTitle: string | null;
  } | null;
  creationMode?: 'motion' | null;
  status: string;
  created_at: string;
  completed_at?: string | null;
  duration?: number | null;
  cost?: number | null;
  model: string;
  category: string | null;
  title?: string | null;
  description?: string | null;
  prompt?: string | null;
  input_media?: Array<{ url?: string | null; kind?: string | null }>;
  linked_post_id?: string | null;
  linked_post_title?: string | null;
  linked_post_visibility?: string | null;
  linked_post_archived_at?: string | null;
  archived_at?: string | null;
}

export interface GenerationListResponse {
  generations: GenerationListItem[];
  // Optional: contract fixtures and older callers omit it.
  pagination?: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export interface GenerationStartResponse {
  success: boolean;
  predictionId: string;
  generationId: string | null;
  status: string;
  remainingCredits?: number;
  cost?: number;
}

export type MediaUploadKind = 'image' | 'video' | 'audio';

export interface MediaUploadIntentRequest {
  fileName: string;
  mimeType: string;
  kind: MediaUploadKind;
  sizeBytes: number;
}

export interface MediaUploadIntentResponse {
  success: boolean;
  uploadId: string;
  bucket: 'uploads';
  path: string;
  storagePath: string;
  token: string;
  signedUploadUrl: string | null;
  expiresInSeconds: number;
}

export interface MediaReadUrlRequest {
  storagePath: string;
}

export interface MediaReadUrlResponse {
  success: boolean;
  signedUrl: string;
  expiresInSeconds: number;
}

export interface MediaTemplateCreator {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface MediaTemplateInputSlot {
  key: string;
  kind: 'image' | 'video';
  label: string;
  description: string | null;
  required: boolean;
}

export interface MediaTemplateSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  creatorUserId: string | null;
  creator: MediaTemplateCreator | null;
  inputSlots: MediaTemplateInputSlot[];
  outputKind: 'image' | 'video';
  status: 'draft' | 'active' | 'disabled';
  estimatedTotalCredits: number | null;
  useCount: number;
}

export interface MediaTemplateDetail extends MediaTemplateSummary {
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MediaTemplateListResponse {
  success: boolean;
  templates: MediaTemplateSummary[];
}

export interface MediaTemplateDetailResponse {
  success: boolean;
  template: MediaTemplateDetail;
}

export type TemplateRunStatus =
  | 'collecting_inputs'
  | 'queued'
  | 'processing'
  | 'awaiting_approval'
  | 'succeeded'
  | 'needs_attention'
  | 'failed'
  | 'cancelled';

export type TemplateRunFailureCode =
  | 'insufficient_credits'
  | 'invalid_input_media'
  | 'service_misconfigured'
  | 'provider_busy'
  | 'provider_unavailable'
  | 'provider_rejected';

export interface TemplateRunInput {
  slotKey: string;
  status: 'uploaded' | 'missing' | string;
  previewUrl: string | null;
  fileName: string | null;
}

export interface TemplateRunStep {
  id: string;
  kind: 'generation' | 'approval';
  mediaKind: 'image' | 'video';
  status: string;
  label: string;
  outputUrl: string | null;
  errorMessage: string | null;
  failureCode: TemplateRunFailureCode | null;
  canRetry: boolean;
  estimatedRetryCredits: number | null;
}

export interface TemplateRunResult {
  /** The canonical generation selected by the backend as this run's result.
   * It is intentionally nullable for legacy runs and must never be inferred
   * from a workflow step id. */
  generationId: string | null;
  kind: 'image' | 'video';
  url: string;
}

export interface TemplateRun {
  id: string;
  templateId: string;
  templateSlug: string;
  templateTitle: string;
  templateCreator: MediaTemplateCreator | null;
  status: TemplateRunStatus;
  inputSlots: MediaTemplateInputSlot[];
  inputs: TemplateRunInput[];
  steps: TemplateRunStep[];
  result: TemplateRunResult | null;
  estimatedTotalCredits: number | null;
  estimatedRemainingCredits: number | null;
  creditsUsed: number;
  errorMessage: string | null;
  isTest: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TemplateRunResponse {
  success: boolean;
  run: TemplateRun;
}

export interface TemplateRunInputSignRequest {
  slotKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface TemplateRunInputSignResponse {
  success: boolean;
  uploadId: string;
  bucket: 'template_inputs';
  path: string;
  storagePath: string;
  token: string;
  signedUploadUrl: string | null;
  expiresInSeconds: number;
}

export interface TemplateRunInputFinalizeRequest {
  inputs: Array<{
    slotKey: string;
    storagePath: string;
  }>;
}

export type ProfileMediaUploadRole = 'avatar' | 'cover';

export interface ProfileMediaUploadIntentRequest {
  role: ProfileMediaUploadRole;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ProfileMediaUploadIntentResponse {
  success: boolean;
  uploadId: string;
  bucket: 'profiles';
  path: string;
  token: string;
  signedUploadUrl: string | null;
  publicUrl: string;
  expiresInSeconds: number;
}

export interface GenerationStatusResponse {
  status: 'waiting' | 'processing' | 'succeeded' | 'failed' | string;
  output?: string | null;
  outputs?: string[];
  error?: string | null;
  timing?: unknown;
  retryAfterMs?: number | null;
}

export interface GenerationElementDescriptor {
  id: string;
  displayName: string;
  handle: string;
  storagePath?: string | null;
  sourceGenerationId?: string | null;
}

export type RemixAssetKind = 'image' | 'video' | 'audio';

export interface RemixMediaAssetDescriptor {
  url?: string | null;
  kind?: RemixAssetKind | null;
  label?: string | null;
  storagePath?: string | null;
  sourceGenerationId?: string | null;
  mediaType?: RemixAssetKind;
  fileName?: string | null;
}

export interface RemixResolvedAsset extends RemixMediaAssetDescriptor {
  kind: RemixAssetKind;
  url: string | null;
}

export interface RemixResolvedImageElement extends GenerationElementDescriptor {
  url: string | null;
}

export interface GenerationInputMediaItem {
  id?: string;
  generationId?: string;
  url?: string | null;
  storagePath?: string | null;
  kind?: RemixAssetKind | string | null;
  label?: string | null;
  sourceGenerationId?: string | null;
}

export interface RemixSourceGeneration {
  id: string;
  title: string;
  prompt: string;
  category: 'image' | 'video' | 'text';
  model: string;
}

export interface RemixSourceResult {
  mediaType: 'image' | 'video';
  url: string | null;
}

export interface RemixSourceBundle {
  generation: RemixSourceGeneration;
  result: RemixSourceResult | null;
  inputs: {
    image?: {
      elements: RemixResolvedImageElement[];
    };
    video?: {
      referenceMode: 'frames' | 'elements';
      startFrame: RemixResolvedAsset | null;
      endFrame: RemixResolvedAsset | null;
      elements: RemixResolvedImageElement[];
      referenceVideos?: RemixResolvedAsset[];
      referenceAudios?: RemixResolvedAsset[];
    };
    motion?: {
      characterImage: RemixResolvedAsset | null;
      referenceVideo: RemixResolvedAsset | null;
    };
  };
  inputMedia?: GenerationInputMediaItem[];
  workflowSettings: Record<string, unknown>;
  restoreIssues: string[];
}

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  imageUrls?: string[];
  elements?: GenerationElementDescriptor[];
  aspectRatio?: string;
  resolution?: string;
  qualityMode?: 'standard' | 'turbo' | 'balanced' | 'quality';
  outputFormat?: 'jpg' | 'png';
  googleSearch?: boolean;
  sourceGenerationId?: string | null;
  catalogRevision?: string | null;
  settings?: Record<string, string | number | boolean>;
}

export interface VideoMultiPromptInput {
  id: string;
  prompt: string;
  duration: number;
}

export interface KlingVideoElementInput {
  id?: string | null;
  url: string;
  handle?: string | null;
  displayName?: string | null;
  storagePath?: string | null;
  sourceGenerationId?: string | null;
}

export interface VideoGenerationRequest {
  model: string;
  isMultiShot?: boolean;
  prompt: string;
  multiPrompts?: VideoMultiPromptInput[];
  elements?: GenerationElementDescriptor[];
  elementImageUrls?: string[];
  imageUrls?: string[];
  referenceVideoUrls?: string[];
  klingVideoElements?: KlingVideoElementInput[];
  referenceAudioUrls?: string[];
  preparedAudioIds?: string[];
  characterIds?: string[];
  startImageUrl?: string | null;
  endImageUrl?: string | null;
  mode?: string;
  aspectRatio?: string;
  sound?: boolean;
  duration?: number;
  resolution?: string;
  fixedLens?: boolean;
  referenceMode?: 'frames' | 'elements';
  startFrame?: RemixMediaAssetDescriptor | null;
  endFrame?: RemixMediaAssetDescriptor | null;
  seedanceAssets?: unknown | null;
  sourceGenerationId?: string | null;
  catalogRevision?: string | null;
  settings?: Record<string, string | number | boolean>;
}

export interface MotionGenerationRequest {
  model: string;
  prompt: string;
  referenceVideoUrl: string;
  characterImageUrl: string;
  duration: number;
  characterOrientation?: 'video' | 'image';
  mode?: '720p' | '1080p';
  characterImage?: RemixMediaAssetDescriptor | null;
  referenceVideo?: RemixMediaAssetDescriptor | null;
  sourceGenerationId?: string | null;
  catalogRevision?: string | null;
  settings?: Record<string, string | number | boolean>;
}

export type PromptEnhancementMedium = 'image' | 'video' | 'motion';

export interface PromptEnhancementWarning {
  code: string;
  severity: 'info' | 'warning' | 'blocking';
  message: string;
  fixHint?: string;
}

export type PromptEnhancementLevel = 'faithful' | 'cinematic';

export interface PromptEnhancementRequest {
  medium: PromptEnhancementMedium;
  selectedModel: string;
  prompt: string;
  context?: {
    duration?: number;
    sound?: boolean;
    hasStartImage?: boolean;
    hasEndImage?: boolean;
    hasReferenceVideo?: boolean;
    referenceImageCount?: number;
    isMultiShot?: boolean;
    shotCount?: number;
    elementReferences?: Array<{ handle: string; displayName: string }>;
    /** Uploaded frame URLs so the enhancer LLM can see the actual start/end frames. */
    frameImageUrls?: string[];
    /** 'faithful' = light-touch slot filling; 'cinematic' (default) = full rewrite. */
    enhancementLevel?: PromptEnhancementLevel;
  };
}

export interface PromptEnhancementResponse {
  enhancedPrompt: string;
  remainingCredits?: number;
  agentId?: string;
  qualityScore?: number;
  warnings?: PromptEnhancementWarning[];
  appliedSafeguards?: Array<{ code: string; message: string }>;
}

export interface ShowcaseCreator {
  id: string | null;
  username: string | null;
  name: string;
  avatar: string | null;
}

export interface ShowcaseAssetSummary {
  id: string;
  postId: string;
  title: string;
  accessMode: 'free' | 'paid';
  priceUsdCents: number;
  previewText: string;
  allowRemix: boolean;
  salesCount?: number;
  resourceKinds?: string[];
  priceQuote?: { formatted?: string; amountSubunits?: number; currency?: string };
  lockedPreview?: PostResourceBundleLockedPreview | null;
  itemCounts?: Partial<Record<string, number>>;
}

export interface ShowcaseMediaItem {
  id: string;
  mediaKey?: string;
  url: string;
  renditionUrl?: string | null;
  teaserUrl?: string | null;
  feedStreamUrl?: string | null;
  previewUrl?: string | null;
  previewThumbhash?: string | null;
  previewStatus?: MediaPreviewStatus;
  previewCacheKey?: string;
  gridReady?: boolean;
  preview?: VisualMediaDescriptor;
  mediaKind: 'image' | 'video';
  contentType: string | null;
  originalName: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  sortOrder: number;
}

export interface ShowcaseRecommendationMetadata {
  deliveryId: string;
  position: number;
  reason?: string | null;
  algorithmVersion?: string | null;
}

/**
 * Mirror of GENERATION_SHARE_SOURCE_SURFACES in the web app's `src/lib/share.ts`.
 * The backend validates against a closed enum and a matching database CHECK, so
 * an unlisted value is a 400 and a lost share event, not a new label.
 */
export type GenerationShareSourceSurface =
  | 'create-image'
  | 'create-video'
  | 'create-motion'
  | 'my-creations'
  | 'creator-profile'
  | 'showcase'
  | 'showcase-reel'
  | 'detail-page'
  | 'feed';

/** Mirror of PROFILE_SHARE_SOURCE_SURFACES. Mobile only ever shares from the
 * creator profile screen; 'profile' is the web owner-profile surface. */
export type ProfileShareSourceSurface = 'creator-profile' | 'profile';

export type ShareChannel = 'native-share' | 'copy-link';

export type ShowcaseFeedEventType =
  | 'impression'
  | 'open'
  | 'dwell'
  | 'media_progress'
  | 'quick_skip'
  | 'save'
  | 'unsave'
  | 'share'
  | 'follow'
  | 'remix_start'
  | 'remix_complete'
  | 'resource_open'
  | 'purchase'
  | 'not_interested'
  | 'hide_creator'
  | 'report';

export interface ShowcaseFeedEventRequest {
  clientEventId: string;
  feedSessionId?: string;
  deliveryId?: string;
  postId: string;
  eventType: ShowcaseFeedEventType;
  position?: number;
  durationMs?: number;
  progress?: number;
  sourceSurface: 'showcase' | 'showcase-reel';
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ShowcaseFeedEventResponse {
  success: boolean;
  accepted?: boolean;
  duplicate?: boolean;
}

export interface ShowcaseFeedEventBatchResponse {
  success: true;
  recorded: number;
  rejected: number;
}

export interface ShowcaseFeedItem {
  id: string;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | null;
  mediaItems?: ShowcaseMediaItem[];
  model: string;
  title: string;
  prompt: string;
  body: string;
  category: 'image' | 'video' | 'text';
  creationMode?: 'motion' | null;
  postFormat: 'text' | 'media' | 'mixed';
  saveCount: number;
  remixCount: number;
  commentCount: number;
  createdAt: string;
  creator: ShowcaseCreator;
  isSaved?: boolean;
  sourceKind?: 'post' | 'generation';
  sourceTool?: string | null;
  sourceToolSlug?: string | null;
  sourceTools?: SourceToolSelection[];
  generationId: string | null;
  asset: ShowcaseAssetSummary | null;
  canRemix: boolean;
  savedAt?: string;
  recommendation?: ShowcaseRecommendationMetadata | null;
}

export interface ShowcaseFeedResponse {
  items: ShowcaseFeedItem[];
  feedSessionId?: string | null;
  algorithmVersion?: string | null;
  nextCursor?: string | null;
  pageInfo?: {
    hasMore: boolean;
    limit?: number;
    nextOffset?: number | null;
    nextCursor?: string | null;
    offset?: number;
  };
}

export interface ShowcasePostResponse {
  success: boolean;
  item: ShowcaseFeedItem;
}

export type PostCommentStatus =
  | 'active'
  | 'removed_by_author'
  | 'removed_by_owner'
  | 'removed_by_moderation';

export interface PostCommentAuthor {
  id: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
}

export interface PostComment {
  id: string;
  parentId: string | null;
  body: string;
  status: PostCommentStatus;
  createdAt: string;
  replyCount: number;
  /** Null once a comment is removed — the server withholds the author too. */
  author: PostCommentAuthor | null;
}

export interface PostCommentsResponse {
  postId: string;
  postCreatorId: string | null;
  commentCount: number;
  comments: PostComment[];
  pageInfo: {
    hasMore: boolean;
    nextOffset: number | null;
    limit: number;
    offset: number;
  };
}

export interface CreatePostCommentResponse {
  success: true;
  comment: PostComment;
  commentCount: number;
}

export interface DeletePostCommentResponse {
  success: true;
  status: PostCommentStatus;
  commentCount: number;
}

export interface CreatorProfileResponse {
  profile: {
    id: string;
    username: string;
    displayName: string;
    bio: string | null;
    avatarUrl: string | null;
    coverUrl: string | null;
    websiteUrl: string | null;
    twitterHandle: string | null;
    instagramHandle: string | null;
    tiktokHandle: string | null;
    location: string | null;
  };
  stats: {
    publicCreations: number;
    totalSaves: number;
    totalRemixes: number;
    unlocks: number;
    totalUnlockSales: number;
    toolsUsed: Array<{ slug: string; label: string; count: number }>;
  };
  items: ShowcaseFeedItem[];
  pageInfo: {
    hasMore: boolean;
    nextLimit: number | null;
    nextOffset: number | null;
    limit: number;
    offset: number;
  };
  viewer: {
    isOwner: boolean;
    isFollowing: boolean;
  };
}

export type PostResourceKind = 'prompt' | 'workflow' | 'files' | 'notes' | 'remix';
export type PostResourceBundleAccessMode = 'none' | 'free' | 'paid';
export type PostResourceSectionKind =
  | 'global'
  | 'scene'
  | 'shot'
  | 'frame'
  | 'variation'
  | 'workflow_step'
  | 'asset_group'
  | 'chapter'
  | 'other';
export type PostResourceItemType =
  | 'prompt'
  | 'workflow'
  | 'reference_image'
  | 'reference_video'
  | 'reference_audio'
  | 'source_file'
  | 'preset'
  | 'settings'
  | 'note'
  | 'external_link'
  | 'remix_link'
  | 'remix_access';
export type PostResourceItemRole =
  | 'primary'
  | 'style_reference'
  | 'product_reference'
  | 'composition_reference'
  | 'character_reference'
  | 'color_reference'
  | 'negative_reference'
  | 'before_input'
  | 'supporting_workflow'
  | 'manual_import'
  | 'other';
export type PostResourceRemixUse =
  | 'none'
  | 'reference_only'
  | 'import_source'
  | 'direct_remix'
  | 'text_template';

export type PostResourceItemScope =
  | { kind: 'all' }
  | { kind: 'media'; mediaKeys: string[] };

export interface PostResourceItem {
  id?: string;
  scope?: PostResourceItemScope;
  type: PostResourceItemType;
  role: PostResourceItemRole;
  sectionId: string | null;
  title: string;
  description: string | null;
  textContent: string | null;
  externalUrl: string | null;
  storagePath: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  workflowSnapshot: unknown | null;
  sortOrder: number;
  isPrimary: boolean;
  remixUse: PostResourceRemixUse;
}

export interface PostResourceSection {
  id: string;
  title: string;
  publicTitle?: string | null;
  resourceType?: PostResourceItemType | null;
  scope?: PostResourceItemScope;
  kind: PostResourceSectionKind;
  description: string | null;
  sortOrder: number;
}

export interface PostResourceCardPreview {
  sectionId: string;
  publicTitle: string;
  resourceType: PostResourceItemType;
  scope: PostResourceItemScope;
  itemCount: number;
  hasRemix: boolean;
}

export interface PostResourceAttachment {
  label: string;
  kind?: 'link' | 'file';
  url?: string | null;
  storagePath?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  resourceType?: PostResourceItemType | null;
  role?: PostResourceItemRole | null;
  remixUse?: PostResourceRemixUse | null;
}

/**
 * Resource files are uploaded straight to storage, the same way the web
 * composer does it: sign for a one-time URL, PUT the bytes, then finalize so
 * the server can verify what actually landed. The multipart route this used to
 * post to is retired and answers 410.
 */
export interface PostResourceFileUploadMetadata {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface PostResourceFileSignRequest extends PostResourceFileUploadMetadata {}

export interface PostResourceFileSignResponse {
  success: boolean;
  uploadId: string;
  bucket: 'post_resource_files';
  path: string;
  token: string;
  signedUploadUrl: string | null;
  expiresInSeconds: number;
  expected: PostResourceFileUploadMetadata;
}

export interface UploadFinalizeRequest {
  uploadId: string;
}

export interface UploadFinalizeResponse {
  bucket: string;
  path: string;
  storagePath: string;
  contentType: string;
  sizeBytes: number;
}

export interface PostResourceFileFinalizeRequest extends PostResourceFileUploadMetadata {
  path: string;
}

export interface PostResourceFileFinalizeResponse {
  success: boolean;
  attachment: PostResourceAttachment;
}

export interface PostResourceBundleResources {
  promptText: string | null;
  notesMarkdown: string | null;
  workflowShareUrl: string | null;
  workflowSnapshot: unknown | null;
  attachments: PostResourceAttachment[];
  allowRemix: boolean;
  sections?: PostResourceSection[];
  items?: PostResourceItem[];
}

export interface PostResourceBundleInput {
  accessMode: PostResourceBundleAccessMode;
  summary?: string | null;
  previewText?: string | null;
  priceUsdCents?: number | null;
  resources?: Partial<PostResourceBundleResources> | null;
}

export type SourceToolType = 'platform' | 'editor' | 'workflow' | 'api-marketplace';

export type SourceToolCapability = 'image' | 'video' | 'audio' | 'avatar' | 'design' | '3d' | 'vfx';

export type SourceToolCatalogTier = 'featured' | 'extended' | 'historical';

export type SourceToolStatus = 'current' | 'legacy' | 'deprecated' | 'sunset';

export interface SourceToolModel {
  slug: string;
  label: string;
  capabilities?: SourceToolCapability[];
  status?: SourceToolStatus;
  providerSlug?: string | null;
  aliases?: string[];
}

export interface SourceToolOption {
  slug: string;
  label: string;
  models: SourceToolModel[];
  supportedMediaKinds: Array<'image' | 'video'>;
  toolType?: SourceToolType;
  capabilities?: SourceToolCapability[];
  catalogTier?: SourceToolCatalogTier;
  status?: SourceToolStatus;
  providerSlug?: string | null;
  aliases?: string[];
}

export interface SourceToolSelection {
  toolLabel: string;
  toolSlug: string | null;
  modelLabel?: string | null;
  modelSlug?: string | null;
  createTool?: boolean;
  createModel?: boolean;
}

export interface PostResourceBundleLockedPreview {
  cardPreviews?: PostResourceCardPreview[];
  itemCounts?: Partial<Record<PostResourceItemType, number>>;
  itemPreviews?: Array<{
    id?: string;
    scope?: PostResourceItemScope;
    type: PostResourceItemType;
    title: string;
    role: PostResourceItemRole;
    sectionId?: string | null;
    contentType?: string | null;
    sizeBytes?: number | null;
    remixUse: PostResourceRemixUse;
  }>;
  sectionCount?: number;
  hasPrompt?: boolean;
  hasNotes?: boolean;
  hasWorkflow?: boolean;
  hasRemix?: boolean;
  updatedAt?: string | null;
  promptPreview?: string | null;
  notesPreview?: string | null;
  attachmentPreviews?: Array<{ kind: 'link' | 'file' | string; label: string }>;
  resourceKinds?: PostResourceKind[];
}

export interface MarketplaceResource {
  id: string;
  postId?: string;
  legacyAssetId?: string | null;
  title: string;
  summary?: string;
  description?: string;
  previewText?: string;
  accessMode?: 'free' | 'paid';
  priceUsdCents?: number;
  salesCount?: number;
  allowRemix?: boolean;
  priceQuote?: { formatted?: string; amountSubunits?: number; currency?: string; note?: string | null };
  resourceKinds?: PostResourceKind[];
  creator?: ShowcaseCreator;
  seller?: ShowcaseCreator;
  post?: {
    id: string;
    title: string;
    body: string;
    mediaUrl: string | null;
    mediaKind: 'image' | 'video' | null;
    mediaItems?: ShowcaseMediaItem[];
    saveCount?: number;
    remixCount?: number;
  } | null;
  mediaUrl?: string | null;
}

export interface MarketplaceResourceList {
  items: MarketplaceResource[];
  pageInfo?: {
    hasMore: boolean;
    nextOffset: number | null;
  };
}

export interface MarketplaceResourceDetail extends MarketplaceResource {
  status: 'draft' | 'published';
  resources: PostResourceBundleResources | null;
  lockedPreview?: PostResourceBundleLockedPreview | null;
  viewerIsOwner: boolean;
  viewerHasPurchased: boolean;
  viewerCanAccess: boolean;
}

export interface MarketplaceResourceDetailResponse {
  success: boolean;
  bundle: MarketplaceResourceDetail;
}

export interface OwnerPostBundleSummary {
  id: string;
  accessMode: 'free' | 'paid';
  status: string;
  priceUsdCents: number;
  salesCount: number;
  earningsUsdCents: number;
  resourceKinds: PostResourceKind[];
}

export interface OwnerPostListItem {
  id: string;
  title: string;
  /**
   * The stored title without the "Untitled post" display fallback; '' when the
   * post has none. Editors must hydrate from this — echoing the fallback back
   * on save trips the server's marketplace placeholder gate.
   */
  rawTitle?: string;
  createdAt: string;
  visibility: string;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | null;
  mediaItems?: ShowcaseMediaItem[];
  description?: string;
  prompt?: string;
  body?: string;
  category?: ShowcaseFeedItem['category'];
  postFormat?: ShowcaseFeedItem['postFormat'];
  sourceLabel?: string;
  publicPath?: string | null;
  ownerPath?: string;
  bundle: OwnerPostBundleSummary | null;
  archivedAt?: string | null;
  generationId?: string | null;
  sourceTool?: string | null;
  sourceToolSlug?: string | null;
  sourceTools?: SourceToolSelection[];
  commentCount: number;
}

export interface OwnerPostsResponse {
  success: boolean;
  posts: OwnerPostListItem[];
  pageInfo?: {
    hasMore: boolean;
    limit: number | null;
    nextOffset: number | null;
    offset: number;
  };
  summary?: {
    earningsUsdCents: number;
    listingCount: number;
    salesCount: number;
  };
}

export interface CreatePostResponse {
  success: boolean;
  postId: string;
  visibility: 'public' | 'unlisted' | 'private';
  showcasePath: string | null;
  ownerPath: string | null;
  resourceBundlePath: string | null;
  message?: string;
}

export interface MobileCommerceSyncResponse {
  success: boolean;
  entitlement: 'credits' | 'marketplace_unlock' | 'post_resource_unlock';
  credits?: number | null;
  referralBonusCredits?: number;
  alreadyProcessed?: boolean;
  assetId?: string;
  postId?: string;
  message?: string;
}

export type MobilePushPlatform = 'ios' | 'android';

export type MobileNotificationCategory = 'generation' | 'commerce' | 'social' | 'system';

export type MobileNotificationType =
  | 'generation_succeeded'
  | 'generation_failed'
  | 'credits_purchased'
  | 'referral_reward_earned'
  | 'referral_reward_reversed'
  | 'purchases_restored'
  | 'marketplace_unlocked'
  | 'post_resource_unlocked'
  | 'creator_followed'
  | 'post_saved'
  | 'post_remixed'
  | 'post_shared';

export interface MobileNotification {
  id: string;
  type: MobileNotificationType;
  category: MobileNotificationCategory;
  title: string;
  body: string;
  deepLink: string | null;
  objectType: string | null;
  objectId: string | null;
  eventCount: number;
  isRead: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MobileNotificationsResponse {
  success: boolean;
  notifications: MobileNotification[];
  unreadCount: number;
}

export interface MobilePushTokenRegistration {
  expoPushToken: string;
  platform: MobilePushPlatform;
  deviceId?: string | null;
  appVersion?: string | null;
  allDevices?: boolean;
}

export interface MobileNotificationPreferences {
  pushEnabled: boolean;
  generationEnabled: boolean;
  commerceEnabled: boolean;
  socialEnabled: boolean;
}

/**
 * An item in the buyer's unlock library. Mirrors ViewerUnlockItem on the web
 * side; `retired` and `tombstoned` mean the creator removed the unlock or the
 * whole post, which the buyer keeps regardless.
 */
export interface ViewerUnlockItem {
  unlockId: string;
  bundleId: string | null;
  postId: string | null;
  title: string;
  previewText: string;
  accessMode: 'free' | 'paid';
  priceUsdCents: number;
  purchasedAt: string;
  purchasePriceUsdCents: number;
  hasNewerRevision: boolean;
  retired: boolean;
  tombstoned: boolean;
  post: {
    title: string;
    category: string;
    postFormat: string;
    mediaUrl: string | null;
    mediaKind: string | null;
  } | null;
  creator: {
    username: string | null;
    displayName: string;
    avatarUrl: string | null;
  };
}

export interface ViewerUnlocksResponse {
  success: boolean;
  items: ViewerUnlockItem[];
  pageInfo: {
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
    limit: number;
    offset: number;
  };
}

export interface ViewerUnlockRevision {
  revisionId: string;
  revisionNumber: number;
  createdAt: string;
  title: string;
  summary: string;
  previewText: string;
  accessMode: 'free' | 'paid';
  priceUsdCents: number;
  resources: PostResourceBundleResources;
  mediaItems: ShowcaseMediaItem[];
}

export interface ViewerUnlockDetail {
  unlockId: string;
  bundleId: string | null;
  postId: string | null;
  title: string;
  summary: string;
  previewText: string;
  accessMode: 'free' | 'paid';
  priceUsdCents: number;
  purchasePriceUsdCents: number;
  salesCount: number | null;
  purchasedAt: string;
  creatorDisplayName: string;
  resourceKinds: PostResourceKind[];
  currentResources: PostResourceBundleResources | null;
  purchasedRevision: ViewerUnlockRevision;
  hasNewerRevision: boolean;
  detached: boolean;
  retired: boolean;
  tombstoned: boolean;
  postVisibility: string | null;
  post: MarketplaceResource['post'] | null;
  mediaItems: ShowcaseMediaItem[];
}

export interface ViewerUnlockDetailResponse {
  success: boolean;
  unlock: ViewerUnlockDetail;
}
