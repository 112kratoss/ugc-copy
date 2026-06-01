import {
  clampVideoDuration,
  type ImageModelId,
  type MotionModelId,
  type VideoModelId,
} from '@/lib/models';
import {
  buildWorkflowPromptFieldGuidance,
  type EnhancerContext,
} from '@/lib/prompt-enhancer';
import {
  createCanvasEdge,
  createWorkflowNode,
  isSeedance2VideoModel,
  normalizeNodeData,
  normalizeWorkflowGraph,
  type AudioInputNodeData,
  type GroupNodeData,
  type ImageGenerateNodeData,
  type ImageInputNodeData,
  type MotionGenerateNodeData,
  type NoteNodeData,
  type TextInputNodeData,
  type VideoGenerateNodeData,
  type VideoInputNodeData,
  type VoiceoverGenerateNodeData,
  type WorkflowCanvasEdge,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
  type WorkflowNodeData,
  type WorkflowNodeKind,
} from '@/lib/workflow-canvas';
import {
  WORKFLOW_BLUEPRINT_COST,
  type WorkflowAspectRatio,
} from '@/lib/workflow-blueprint';

type WorkflowAssistantMessageRole = 'user' | 'assistant';
type WorkflowAssistantProposalStatus = 'ready' | 'applied' | 'discarded';
type WorkflowAssistantAssetKind = 'image' | 'video' | 'audio';
export type WorkflowAssistantPreviewState = 'added' | 'changed' | 'removed';
export type WorkflowAssistantAvailability = 'ready' | 'setup_required';

export const WORKFLOW_ASSISTANT_SETUP_ERROR_CODE = 'assistant_schema_missing';
const WORKFLOW_ASSISTANT_SETUP_MIGRATION = '20260416120000_workflow_canvas_assistant.sql';
export const WORKFLOW_ASSISTANT_SETUP_MESSAGE = `Workflow assistant database tables are missing. Run migration ${WORKFLOW_ASSISTANT_SETUP_MIGRATION}.`;

export interface WorkflowAssistantAssetSlot {
  slotKey: string;
  kind: WorkflowAssistantAssetKind;
  label: string;
  purpose: string;
  required: boolean;
}

interface WorkflowAssistantShot {
  shotKey: string;
  title: string;
  purpose: string;
  beat: string;
  visualPrompt: string;
  videoPrompt: string;
  motionPrompt: string;
  duration: number;
  startSlotKey: string | null;
  endSlotKey: string | null;
  referenceImageSlotKeys: string[];
  referenceVideoSlotKeys: string[];
  referenceAudioSlotKeys: string[];
}

export interface WorkflowAssistantBlueprint {
  title: string;
  assistantReply: string;
  changeSummary: string;
  creativeStrategy: string;
  narrative: string;
  voiceover: string;
  assetSlots: WorkflowAssistantAssetSlot[];
  shots: WorkflowAssistantShot[];
  deliveryPlan: {
    primaryModel: VideoModelId;
    stillImageModel: ImageModelId;
    motionModel: MotionModelId;
    aspectRatio: WorkflowAspectRatio;
  };
}

interface WorkflowAssistantDiffNode {
  id: string;
  title: string;
  type: WorkflowNodeKind;
  roleKey: string | null;
  slotKey: string | null;
}

export interface WorkflowAssistantProposalDiff {
  regionId: string;
  nodes: {
    added: WorkflowAssistantDiffNode[];
    changed: WorkflowAssistantDiffNode[];
    removed: WorkflowAssistantDiffNode[];
  };
  edges: {
    added: number;
    removed: number;
  };
}

export interface WorkflowCanvasAssistantMessageRecord {
  id: string;
  canvas_id: string;
  role: WorkflowAssistantMessageRole;
  content: string;
  proposal_id: string | null;
  created_at: string;
}

export interface WorkflowCanvasAssistantProposalRecord {
  id: string;
  canvas_id: string;
  base_revision: number;
  status: WorkflowAssistantProposalStatus;
  summary: string;
  diff: WorkflowAssistantProposalDiff;
  proposed_graph: WorkflowCanvasGraph;
  created_at: string;
  applied_at: string | null;
  discarded_at: string | null;
}

export interface WorkflowCanvasAssistantState {
  messages: WorkflowCanvasAssistantMessageRecord[];
  proposal: WorkflowCanvasAssistantProposalRecord | null;
  availability: WorkflowAssistantAvailability;
  setupMessage: string | null;
}

export interface WorkflowAssistantPromptContext {
  currentCanvasSummary: string;
  assistantRegionSummary: string;
  recentMessages: Array<Pick<WorkflowCanvasAssistantMessageRecord, 'role' | 'content'>>;
  latestUserMessage: string;
}

interface CompileManagedWorkflowOptions {
  currentGraph: WorkflowCanvasGraph;
  blueprint: WorkflowAssistantBlueprint;
}

interface ExistingAssistantNodeRef {
  id: string;
  position: { x: number; y: number };
}

interface AssistantNodeDraft {
  node: WorkflowCanvasNode;
  roleKey: string;
}

const DEFAULT_ASSISTANT_REGION_TITLE = 'AI workflow region';
const DEFAULT_REGION_OFFSET_X = 320;
const DEFAULT_REGION_START_X = 140;
const DEFAULT_REGION_START_Y = 72;
const SLOT_VERTICAL_GAP = 156;
const SHOT_COLUMN_WIDTH = 520;
const SHOT_CARD_VERTICAL_GAP = 220;
const SLOT_KIND_ORDER: Record<WorkflowAssistantAssetKind, number> = {
  image: 0,
  video: 1,
  audio: 2,
};

export const WORKFLOW_ASSISTANT_COST = WORKFLOW_BLUEPRINT_COST;

export const DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT: WorkflowAssistantBlueprint = {
  title: 'AI workflow draft',
  assistantReply: 'I drafted a workflow proposal based on your request.',
  changeSummary: 'Created a new assistant-managed workflow region with runnable prompts and media placeholders.',
  creativeStrategy: 'Start with a clear visual anchor, generate the key shot, and keep the workflow easy to swap and rerun.',
  narrative: 'Reference setup -> core shot generation -> motion variation.',
  voiceover: '',
  assetSlots: [
    {
      slotKey: 'hero-reference',
      kind: 'image',
      label: 'Hero reference',
      purpose: 'Primary identity or subject reference',
      required: true,
    },
  ],
  shots: [
    {
      shotKey: 'shot-1',
      title: 'Hero shot',
      purpose: 'Generate the core visual beat',
      beat: 'Establish the subject and deliver the main motion or reveal',
      visualPrompt: 'Reference-led hero still, premium lighting, high detail, clean composition.',
      videoPrompt: 'Reference-led hero video with clear motion, premium lighting, and a direct focal action.',
      motionPrompt: 'Preserve identity and transfer motion naturally with clean commercial polish.',
      duration: 5,
      startSlotKey: null,
      endSlotKey: null,
      referenceImageSlotKeys: ['hero-reference'],
      referenceVideoSlotKeys: [],
      referenceAudioSlotKeys: [],
    },
  ],
  deliveryPlan: {
    primaryModel: 'kling-3.0-video',
    stillImageModel: 'nano-banana-pro',
    motionModel: 'kling-3.0',
    aspectRatio: '9:16',
  },
};

function toSlug(value: string, fallback: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return normalized || fallback;
}

function normalizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function normalizeAssistantAssetKind(value: unknown): WorkflowAssistantAssetKind {
  return value === 'video' || value === 'audio' ? value : 'image';
}

function normalizeAssistantModelAliasValue(value: string) {
  return value
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/\bversion\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VIDEO_MODEL_ALIASES: Array<{ id: VideoModelId; patterns: RegExp[] }> = [
  { id: 'grok-imagine-video', patterns: [/\bgrok(?:\s|-)?imagine(?:\s|-)?video\b/i, /\bgrok(?:\s|-)?video\b/i, /\bxai(?:\s|-)?video\b/i] },
  { id: 'seedance-2-fast', patterns: [/\bseedance(?:\s|-)?2(?:\.0)?(?:\s|-)?fast\b/i] },
  { id: 'seedance-2', patterns: [/\bseedance(?:\s|-)?2(?:\.0)?\b/i] },
  { id: 'seedance-1.5-pro', patterns: [/\bseedance(?:\s|-)?1\.5(?:\s|-)?pro\b/i, /\bseedance(?:\s|-)?1\.5\b/i] },
  { id: 'kling-3.0-video', patterns: [/\bkling(?:\s|-)?3\.0(?:\s|-)?cinematic\b/i, /\bkling(?:\s|-)?3\.0(?:\s|-)?video\b/i, /\bkling(?:\s|-)?3\.0\b/i] },
  { id: 'veo-3.1', patterns: [/\bveo(?:\s|-)?3\.1\b/i] },
];

const IMAGE_MODEL_ALIASES: Array<{ id: ImageModelId; patterns: RegExp[] }> = [
  { id: 'grok-imagine-image', patterns: [/\bgrok(?:\s|-)?imagine(?:\s|-)?image\b/i, /\bgrok(?:\s|-)?imagine\b/i, /\bgrok\b/i, /\bxai(?:\s|-)?image\b/i] },
  { id: 'gpt-image-2', patterns: [/\bgpt(?:\s|-)?image(?:\s|-)?2\b/i, /\bchatgpt(?:\s|-)?image\b/i, /\bchat(?:\s|-)?gpt(?:\s|-)?image\b/i] },
  { id: 'nano-banana-2', patterns: [/\bnano(?:\s|-)?banana(?:\s|-)?2(?:\.0)?\b/i] },
  { id: 'nano-banana-pro', patterns: [/\bnano(?:\s|-)?banana(?:\s|-)?pro\b/i] },
];

const MOTION_MODEL_ALIASES: Array<{ id: MotionModelId; patterns: RegExp[] }> = [
  { id: 'kling-3.0', patterns: [/\bkling(?:\s|-)?3\.0\b/i] },
  { id: 'kling-2.6', patterns: [/\bkling(?:\s|-)?2\.6\b/i] },
];

function matchModelAlias<T extends string>(
  value: unknown,
  aliases: Array<{ id: T; patterns: RegExp[] }>
): T | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const normalizedValue = normalizeAssistantModelAliasValue(value);
  for (const alias of aliases) {
    if (alias.patterns.some((pattern) => pattern.test(normalizedValue))) {
      return alias.id;
    }
  }

  return null;
}

function detectExplicitWorkflowVideoModelRequest(value: string): VideoModelId | null {
  return matchModelAlias(value, VIDEO_MODEL_ALIASES);
}

function normalizeWorkflowAssistantImageModel(value: unknown): ImageModelId {
  return matchModelAlias(value, IMAGE_MODEL_ALIASES) ?? 'nano-banana-pro';
}

function looksLikeTransformationPrompt(value: string) {
  return /\b(before|after|transform|transformation|morph|transition|same character|same subject)\b/i.test(value);
}

function normalizeWorkflowAssistantVideoModel(value: unknown, latestUserMessage: string): VideoModelId {
  const explicitResponseModel = matchModelAlias(value, VIDEO_MODEL_ALIASES);
  if (explicitResponseModel) {
    return explicitResponseModel;
  }

  const explicitRequestedModel = detectExplicitWorkflowVideoModelRequest(latestUserMessage);
  if (explicitRequestedModel) {
    return explicitRequestedModel;
  }

  return looksLikeTransformationPrompt(latestUserMessage) ? 'seedance-1.5-pro' : 'kling-3.0-video';
}

function normalizeWorkflowAssistantMotionModel(value: unknown): MotionModelId {
  return matchModelAlias(value, MOTION_MODEL_ALIASES) ?? 'kling-3.0';
}

function normalizeWorkflowAssistantAspectRatio(value: unknown): WorkflowAspectRatio {
  return value === '16:9' || value === '1:1' ? value : '9:16';
}

function extractJsonObject(rawContent: string) {
  const fencedMatch = rawContent.match(/```json\s*([\s\S]*?)```/i);
  const rawJson = fencedMatch?.[1] ?? rawContent;
  const start = rawJson.indexOf('{');
  const end = rawJson.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(rawJson.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function inferFallbackAssetSlots(latestUserMessage: string): WorkflowAssistantAssetSlot[] {
  const slots: WorkflowAssistantAssetSlot[] = [];
  const normalizedMessage = latestUserMessage.toLowerCase();

  if (/\b(reference|model|portrait|image|photo|girl|character|subject)\b/.test(normalizedMessage)) {
    slots.push({
      slotKey: 'hero-reference',
      kind: 'image',
      label: 'Hero reference',
      purpose: 'Base subject identity and likeness anchor',
      required: true,
    });
  }

  if (/\bbefore\b/.test(normalizedMessage)) {
    slots.push({
      slotKey: 'before-frame',
      kind: 'image',
      label: 'Before frame',
      purpose: 'Starting state or pre-transformation frame',
      required: true,
    });
  }

  if (/\bafter\b/.test(normalizedMessage)) {
    slots.push({
      slotKey: 'after-frame',
      kind: 'image',
      label: 'After frame',
      purpose: 'Ending state or final reveal frame',
      required: true,
    });
  }

  if (/\b(audio|sound|music|voice|lightning crack|sfx)\b/.test(normalizedMessage)) {
    slots.push({
      slotKey: 'audio-cue',
      kind: 'audio',
      label: 'Audio cue',
      purpose: 'Timing, sound design, or reference audio',
      required: false,
    });
  }

  if (slots.length === 0) {
    slots.push(...DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT.assetSlots);
  }

  return slots;
}

function sanitizeAssetSlots(
  value: unknown,
  latestUserMessage: string
): WorkflowAssistantAssetSlot[] {
  const candidates = Array.isArray(value) ? value : inferFallbackAssetSlots(latestUserMessage);
  const seen = new Set<string>();

  const next = candidates
    .map((candidate, index) => {
      const slot = candidate as Partial<WorkflowAssistantAssetSlot>;
      const label = normalizeString(slot.label, `Asset slot ${index + 1}`);
      const slotKey = toSlug(normalizeString(slot.slotKey, label), `slot-${index + 1}`);

      if (seen.has(slotKey)) {
        return null;
      }

      seen.add(slotKey);

      return {
        slotKey,
        kind: normalizeAssistantAssetKind(slot.kind),
        label,
        purpose: normalizeString(slot.purpose, 'Workflow media placeholder'),
        required: typeof slot.required === 'boolean' ? slot.required : true,
      } satisfies WorkflowAssistantAssetSlot;
    })
    .filter((slot): slot is WorkflowAssistantAssetSlot => Boolean(slot))
    .slice(0, 12);

  return next.length > 0 ? next : DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT.assetSlots;
}

function sanitizeShots(
  value: unknown,
  slotMap: Map<string, WorkflowAssistantAssetSlot>,
  latestUserMessage: string
): WorkflowAssistantShot[] {
  const candidates = Array.isArray(value) ? value : DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT.shots;

  const next = candidates
    .map((candidate, index) => {
      const shot = candidate as Partial<WorkflowAssistantShot>;
      const title = normalizeString(shot.title, `Shot ${index + 1}`);
      const purpose = normalizeString(shot.purpose, 'Drive the main visual beat.');
      const referenceImageSlotKeys = normalizeStringArray(shot.referenceImageSlotKeys)
        .filter((slotKey) => slotMap.get(slotKey)?.kind === 'image');
      const referenceVideoSlotKeys = normalizeStringArray(shot.referenceVideoSlotKeys)
        .filter((slotKey) => slotMap.get(slotKey)?.kind === 'video');
      const referenceAudioSlotKeys = normalizeStringArray(shot.referenceAudioSlotKeys)
        .filter((slotKey) => slotMap.get(slotKey)?.kind === 'audio');
      const startSlotKey = normalizeString(shot.startSlotKey, '') || null;
      const endSlotKey = normalizeString(shot.endSlotKey, '') || null;

      return {
        shotKey: toSlug(normalizeString(shot.shotKey, title), `shot-${index + 1}`),
        title,
        purpose,
        beat: normalizeString(shot.beat, purpose),
        visualPrompt: normalizeString(
          shot.visualPrompt,
          `Reference-led hero still for ${latestUserMessage}, premium lighting, high detail, creator-first framing.`
        ),
        videoPrompt: normalizeString(
          shot.videoPrompt,
          `Reference-led hero video for ${latestUserMessage}, clear motion, commercial clarity, easy-to-follow action.`
        ),
        motionPrompt: normalizeString(
          shot.motionPrompt,
          'Preserve the same subject identity while adding natural motion and clean transition continuity.'
        ),
        duration: typeof shot.duration === 'number' && shot.duration > 0
          ? Math.min(Math.round(shot.duration), 12)
          : 5,
        startSlotKey: startSlotKey && slotMap.get(startSlotKey)?.kind === 'image' ? startSlotKey : null,
        endSlotKey: endSlotKey && slotMap.get(endSlotKey)?.kind === 'image' ? endSlotKey : null,
        referenceImageSlotKeys,
        referenceVideoSlotKeys,
        referenceAudioSlotKeys,
      } satisfies WorkflowAssistantShot;
    })
    .slice(0, 6);

  return next.length > 0 ? next : DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT.shots;
}

export function sanitizeWorkflowAssistantBlueprint(
  candidate: Partial<WorkflowAssistantBlueprint> | null | undefined,
  options: {
    latestUserMessage: string;
  }
): WorkflowAssistantBlueprint {
  const assetSlots = sanitizeAssetSlots(candidate?.assetSlots, options.latestUserMessage);
  const slotMap = new Map(assetSlots.map((slot) => [slot.slotKey, slot]));

  return {
    title: normalizeString(candidate?.title, DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT.title),
    assistantReply: normalizeString(candidate?.assistantReply, DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT.assistantReply),
    changeSummary: normalizeString(candidate?.changeSummary, DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT.changeSummary),
    creativeStrategy: normalizeString(candidate?.creativeStrategy, DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT.creativeStrategy),
    narrative: normalizeString(candidate?.narrative, DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT.narrative),
    voiceover: normalizeString(candidate?.voiceover, DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT.voiceover),
    assetSlots,
    shots: sanitizeShots(candidate?.shots, slotMap, options.latestUserMessage),
    deliveryPlan: {
      primaryModel: normalizeWorkflowAssistantVideoModel(candidate?.deliveryPlan?.primaryModel, options.latestUserMessage),
      stillImageModel: normalizeWorkflowAssistantImageModel(candidate?.deliveryPlan?.stillImageModel),
      motionModel: normalizeWorkflowAssistantMotionModel(candidate?.deliveryPlan?.motionModel),
      aspectRatio: normalizeWorkflowAssistantAspectRatio(candidate?.deliveryPlan?.aspectRatio),
    },
  };
}

export function extractWorkflowAssistantBlueprintFromResponse(
  content: string,
  options: {
    latestUserMessage: string;
  }
): WorkflowAssistantBlueprint {
  const parsed = extractJsonObject(content);
  return sanitizeWorkflowAssistantBlueprint(parsed as Partial<WorkflowAssistantBlueprint> | null, options);
}

function formatConversationHistory(
  messages: WorkflowAssistantPromptContext['recentMessages']
) {
  if (messages.length === 0) {
    return 'No previous assistant conversation for this workflow.';
  }

  return messages
    .slice(-6)
    .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
    .join('\n');
}

export function buildWorkflowAssistantSystemPrompt(
  context: WorkflowAssistantPromptContext
) {
  const plannerContext: EnhancerContext = {
    creativeIntent: 'ugc-ad',
  };

  return [
    'You are the AI Builder inside a workflow canvas for short-form video and creative generation.',
    'Return valid JSON only. No markdown. No commentary.',
    'Design or revise only the assistant-managed region of the workflow. Manual nodes outside that region must be preserved conceptually.',
    'Generate a runnable workflow that uses named media placeholder slots plus prompt-driven generator nodes.',
    'The JSON schema is:',
    '{"title":string,"assistantReply":string,"changeSummary":string,"creativeStrategy":string,"narrative":string,"voiceover":string,"assetSlots":[{"slotKey":string,"kind":"image"|"video"|"audio","label":string,"purpose":string,"required":boolean}],"shots":[{"shotKey":string,"title":string,"purpose":string,"beat":string,"visualPrompt":string,"videoPrompt":string,"motionPrompt":string,"duration":number,"startSlotKey":string|null,"endSlotKey":string|null,"referenceImageSlotKeys":string[],"referenceVideoSlotKeys":string[],"referenceAudioSlotKeys":string[]}],"deliveryPlan":{"primaryModel":string,"stillImageModel":string,"motionModel":string,"aspectRatio":"9:16"|"16:9"|"1:1"}}',
    'Use the existing models only: stillImageModel must be nano-banana-2, nano-banana-pro, gpt-image-2, or grok-imagine-image; primaryModel must be kling-3.0-video, seedance-1.5-pro, seedance-2, seedance-2-fast, veo-3.1, or grok-imagine-video; motionModel must be kling-2.6 or kling-3.0.',
    'Use stable slotKey and shotKey slugs so follow-up edits can revise the same region without unnecessary churn.',
    'Every asset slot should correspond to a real image, video, or audio placeholder a user can replace later.',
    'If the user explicitly names one of the supported models, preserve that model choice in deliveryPlan unless the request is internally contradictory.',
    'When the request sounds like a controlled before/after transformation or same-subject transition, default toward seedance-1.5-pro unless another model is explicitly better.',
    'Keep prompts directly usable in the workflow builder and focused on generation-ready instructions.',
    buildWorkflowPromptFieldGuidance({
      fieldName: 'visualPrompt',
      modelSelector: 'stillImageModel',
      medium: 'image',
      scenario: 'image.reference_guided',
      modelIds: ['nano-banana-2', 'nano-banana-pro', 'gpt-image-2', 'grok-imagine-image'],
      context: plannerContext,
    }),
    buildWorkflowPromptFieldGuidance({
      fieldName: 'videoPrompt',
      modelSelector: 'primaryModel',
      medium: 'video',
      scenario: 'video.image_to_video_start_end',
      modelIds: ['kling-3.0-video', 'seedance-1.5-pro', 'seedance-2', 'seedance-2-fast', 'veo-3.1', 'grok-imagine-video'],
      context: plannerContext,
      additionalRules: [
        'Use startSlotKey and endSlotKey when the user clearly wants a guided beginning and ending frame.',
        'Use referenceVideoSlotKeys and referenceAudioSlotKeys only when the workflow truly needs external motion or timing guidance.',
      ],
    }),
    buildWorkflowPromptFieldGuidance({
      fieldName: 'motionPrompt',
      modelSelector: 'motionModel',
      medium: 'motion',
      scenario: 'motion.transfer',
      modelIds: ['kling-2.6', 'kling-3.0'],
      context: plannerContext,
    }),
    `Current canvas summary:\n${context.currentCanvasSummary}`,
    `Existing assistant region summary:\n${context.assistantRegionSummary}`,
    `Recent workflow conversation:\n${formatConversationHistory(context.recentMessages)}`,
  ].join('\n');
}

export function buildWorkflowAssistantUserPrompt(
  context: WorkflowAssistantPromptContext
) {
  return [
    'Latest user request:',
    context.latestUserMessage,
  ].join('\n');
}

function isAssistantManagedNode(node: WorkflowCanvasNode) {
  return Boolean((node.data as Partial<WorkflowNodeData>).managed);
}

function getAssistantRegionId(node: WorkflowCanvasNode) {
  return typeof (node.data as Partial<WorkflowNodeData>).regionId === 'string'
    ? (node.data as Partial<WorkflowNodeData>).regionId
    : null;
}

function getAssistantRoleKey(node: WorkflowCanvasNode) {
  return typeof (node.data as Partial<WorkflowNodeData>).roleKey === 'string'
    ? (node.data as Partial<WorkflowNodeData>).roleKey
    : null;
}

function getAssistantSlotKey(node: WorkflowCanvasNode) {
  return typeof (node.data as Partial<WorkflowNodeData>).slotKey === 'string'
    ? (node.data as Partial<WorkflowNodeData>).slotKey
    : null;
}

function findWorkflowAssistantRegionId(graph: WorkflowCanvasGraph): string | null {
  const managedNode = graph.nodes.find(isAssistantManagedNode);
  return managedNode ? (getAssistantRegionId(managedNode) ?? null) : null;
}

export function summarizeWorkflowCanvasForAssistant(
  graph: WorkflowCanvasGraph
) {
  const normalized = normalizeWorkflowGraph(graph);
  const manualNodes = normalized.nodes.filter((node) => !isAssistantManagedNode(node));
  const managedNodes = normalized.nodes.filter(isAssistantManagedNode);
  const visibleManualTitles = manualNodes.slice(0, 8).map((node) => `${node.data.title} (${node.type})`);

  return [
    `${manualNodes.length} manual nodes, ${normalized.edges.length} total connections.`,
    visibleManualTitles.length > 0
      ? `Manual nodes: ${visibleManualTitles.join(', ')}`
      : 'Manual nodes: none yet.',
    managedNodes.length > 0
      ? `Assistant region already exists with ${managedNodes.length} nodes.`
      : 'Assistant region: none yet.',
  ].join('\n');
}

export function summarizeWorkflowAssistantRegion(
  graph: WorkflowCanvasGraph
) {
  const normalized = normalizeWorkflowGraph(graph);
  const managedNodes = normalized.nodes.filter(isAssistantManagedNode);

  if (managedNodes.length === 0) {
    return 'No assistant-managed region exists yet.';
  }

  const slotNodes = managedNodes.filter((node) => node.type === 'image-input' || node.type === 'video-input' || node.type === 'audio-input');
  const shotNodes = managedNodes.filter((node) => {
    const roleKey = getAssistantRoleKey(node);
    return Boolean(roleKey?.startsWith('shot-') && roleKey?.endsWith('-video'));
  });

  return [
    `Assistant nodes: ${managedNodes.length}`,
    slotNodes.length > 0
      ? `Slots: ${slotNodes.map((node) => `${node.data.title} (${node.type})`).join(', ')}`
      : 'Slots: none',
    shotNodes.length > 0
      ? `Shot branches: ${shotNodes.map((node) => node.data.title).join(', ')}`
      : 'Shot branches: none',
  ].join('\n');
}

function getAssistantRegionPositionSeed(graph: WorkflowCanvasGraph) {
  const managedNodes = graph.nodes.filter(isAssistantManagedNode);

  if (managedNodes.length > 0) {
    return {
      x: Math.min(...managedNodes.map((node) => node.position.x)),
      y: Math.min(...managedNodes.map((node) => node.position.y)),
    };
  }

  if (graph.nodes.length === 0) {
    return { x: DEFAULT_REGION_START_X, y: DEFAULT_REGION_START_Y };
  }

  const maxX = Math.max(...graph.nodes.map((node) => node.position.x));
  return {
    x: maxX + DEFAULT_REGION_OFFSET_X,
    y: DEFAULT_REGION_START_Y,
  };
}

function sortAssetSlots(slots: WorkflowAssistantAssetSlot[]) {
  return [...slots].sort((left, right) => {
    if (left.required !== right.required) {
      return left.required ? -1 : 1;
    }

    return SLOT_KIND_ORDER[left.kind] - SLOT_KIND_ORDER[right.kind];
  });
}

function ensureAssistantMetadata<T extends WorkflowNodeData>(
  data: T,
  options: {
    managed: boolean;
    regionId: string;
    roleKey: string;
    slotKey?: string | null;
  }
) {
  return {
    ...data,
    managed: options.managed,
    regionId: options.regionId,
    roleKey: options.roleKey,
    slotKey: options.slotKey ?? null,
  } as T;
}

function createAssistantNode(
  existingRoleMap: Map<string, ExistingAssistantNodeRef>,
  type: WorkflowNodeKind,
  position: { x: number; y: number },
  roleKey: string,
  buildData: (base: WorkflowCanvasNode) => Partial<WorkflowNodeData>,
  regionId: string,
  slotKey?: string | null
): AssistantNodeDraft {
  const seedNode = createWorkflowNode(type, existingRoleMap.get(roleKey)?.position ?? position);
  const nodeId = existingRoleMap.get(roleKey)?.id ?? seedNode.id;
  const nextData = ensureAssistantMetadata(
    normalizeNodeData(type, {
      ...seedNode.data,
      ...buildData(seedNode),
    }),
    {
      managed: true,
      regionId,
      roleKey,
      slotKey: slotKey ?? null,
    }
  );

  return {
    roleKey,
    node: {
      ...seedNode,
      id: nodeId,
      position: existingRoleMap.get(roleKey)?.position ?? position,
      data: nextData,
    },
  };
}

function buildAssistantSummaryText(blueprint: WorkflowAssistantBlueprint) {
  return [
    blueprint.changeSummary,
    '',
    `Strategy: ${blueprint.creativeStrategy}`,
    `Narrative: ${blueprint.narrative}`,
    '',
    'Asset slots:',
    ...blueprint.assetSlots.map((slot) => `- ${slot.label} (${slot.kind})${slot.required ? ' required' : ' optional'}: ${slot.purpose}`),
  ].join('\n');
}

function getRoleMapForManagedNodes(graph: WorkflowCanvasGraph) {
  return new Map<string, ExistingAssistantNodeRef>(
    graph.nodes
      .filter(isAssistantManagedNode)
      .map((node) => {
        const roleKey = getAssistantRoleKey(node);
        return roleKey
          ? [roleKey, { id: node.id, position: node.position }]
          : null;
      })
      .filter((entry): entry is [string, ExistingAssistantNodeRef] => Boolean(entry))
  );
}

function buildComparableNode(node: WorkflowCanvasNode) {
  const restData = { ...(node.data as Record<string, unknown>) };
  delete restData.runState;
  delete restData.__runtime;

  return JSON.stringify({
    type: node.type,
    position: node.position,
    data: restData,
  });
}

function buildComparableEdge(edge: WorkflowCanvasEdge) {
  return JSON.stringify({
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
  });
}

function createDiffNode(node: WorkflowCanvasNode): WorkflowAssistantDiffNode {
  return {
    id: node.id,
    title: node.data.title,
    type: node.type,
    roleKey: getAssistantRoleKey(node) ?? null,
    slotKey: getAssistantSlotKey(node) ?? null,
  };
}

function computeWorkflowAssistantDiff(
  currentGraph: WorkflowCanvasGraph,
  proposedGraph: WorkflowCanvasGraph,
  regionId: string
): WorkflowAssistantProposalDiff {
  const currentManagedNodes = currentGraph.nodes.filter((node) => getAssistantRegionId(node) === regionId);
  const proposedManagedNodes = proposedGraph.nodes.filter((node) => getAssistantRegionId(node) === regionId);
  const currentNodeMap = new Map(currentManagedNodes.map((node) => [node.id, node]));
  const proposedNodeMap = new Map(proposedManagedNodes.map((node) => [node.id, node]));
  const currentManagedNodeIds = new Set(currentManagedNodes.map((node) => node.id));
  const proposedManagedNodeIds = new Set(proposedManagedNodes.map((node) => node.id));

  const currentManagedEdges = currentGraph.edges.filter((edge) => currentManagedNodeIds.has(edge.source) || currentManagedNodeIds.has(edge.target));
  const proposedManagedEdges = proposedGraph.edges.filter((edge) => proposedManagedNodeIds.has(edge.source) || proposedManagedNodeIds.has(edge.target));
  const currentEdgeSet = new Set(currentManagedEdges.map(buildComparableEdge));
  const proposedEdgeSet = new Set(proposedManagedEdges.map(buildComparableEdge));

  const added: WorkflowAssistantDiffNode[] = [];
  const changed: WorkflowAssistantDiffNode[] = [];
  const removed: WorkflowAssistantDiffNode[] = [];

  for (const node of proposedManagedNodes) {
    const currentNode = currentNodeMap.get(node.id);
    if (!currentNode) {
      added.push(createDiffNode(node));
      continue;
    }

    if (buildComparableNode(currentNode) !== buildComparableNode(node)) {
      changed.push(createDiffNode(node));
    }
  }

  for (const node of currentManagedNodes) {
    if (!proposedNodeMap.has(node.id)) {
      removed.push(createDiffNode(node));
    }
  }

  let addedEdges = 0;
  let removedEdges = 0;
  for (const edge of proposedManagedEdges) {
    if (!currentEdgeSet.has(buildComparableEdge(edge))) {
      addedEdges += 1;
    }
  }

  for (const edge of currentManagedEdges) {
    if (!proposedEdgeSet.has(buildComparableEdge(edge))) {
      removedEdges += 1;
    }
  }

  return {
    regionId,
    nodes: {
      added,
      changed,
      removed,
    },
    edges: {
      added: addedEdges,
      removed: removedEdges,
    },
  };
}

export function getWorkflowAssistantPreviewNodeStates(
  diff: WorkflowAssistantProposalDiff | null | undefined
) {
  const previewStateByNodeId: Record<string, WorkflowAssistantPreviewState> = {};

  if (!diff) {
    return previewStateByNodeId;
  }

  diff.nodes.added.forEach((node) => {
    previewStateByNodeId[node.id] = 'added';
  });
  diff.nodes.changed.forEach((node) => {
    if (!previewStateByNodeId[node.id]) {
      previewStateByNodeId[node.id] = 'changed';
    }
  });

  return previewStateByNodeId;
}

export function createWorkflowAssistantGraphProposal({
  currentGraph,
  blueprint,
}: CompileManagedWorkflowOptions) {
  const normalizedCurrentGraph = normalizeWorkflowGraph(currentGraph);
  const existingRegionId = findWorkflowAssistantRegionId(normalizedCurrentGraph);
  const regionId = existingRegionId || `assistant-region-${crypto.randomUUID()}`;
  const existingRoleMap = getRoleMapForManagedNodes(normalizedCurrentGraph);
  const managedNodeIds = new Set(
    normalizedCurrentGraph.nodes.filter(isAssistantManagedNode).map((node) => node.id)
  );

  const manualNodes = normalizedCurrentGraph.nodes.filter((node) => !managedNodeIds.has(node.id));
  const manualEdges = normalizedCurrentGraph.edges.filter((edge) => !managedNodeIds.has(edge.source) && !managedNodeIds.has(edge.target));
  const basePosition = getAssistantRegionPositionSeed(normalizedCurrentGraph);

  const assistantNodes: WorkflowCanvasNode[] = [];
  const assistantEdges: WorkflowCanvasEdge[] = [];

  const registerNode = (draft: AssistantNodeDraft) => {
    assistantNodes.push(draft.node);
    return draft.node;
  };

  registerNode(
    createAssistantNode(
      existingRoleMap,
      'note',
      { x: basePosition.x, y: basePosition.y },
      'region-brief',
      (seedNode) => ({
        ...(seedNode.data as NoteNodeData),
        title: blueprint.title,
        subtitle: 'AI builder summary',
        text: buildAssistantSummaryText(blueprint),
      }),
      regionId
    )
  );

  registerNode(
    createAssistantNode(
      existingRoleMap,
      'group',
      { x: basePosition.x - 40, y: Math.max(0, basePosition.y - 36) },
      'region-group',
      (seedNode) => ({
        ...(seedNode.data as GroupNodeData),
        title: DEFAULT_ASSISTANT_REGION_TITLE,
        subtitle: blueprint.title,
        color: 'violet',
      }),
      regionId
    )
  );

  const sortedSlots = sortAssetSlots(blueprint.assetSlots);
  const slotNodeByKey = new Map<string, WorkflowCanvasNode>();

  sortedSlots.forEach((slot, index) => {
    const position = {
      x: basePosition.x,
      y: basePosition.y + 180 + (index * SLOT_VERTICAL_GAP),
    };
    const roleKey = `slot-${slot.slotKey}`;
    const commonData = {
      title: slot.label,
      subtitle: `${slot.required ? 'Required' : 'Optional'} ${slot.kind} slot`,
    };

    const draft = slot.kind === 'image'
      ? createAssistantNode(
          existingRoleMap,
          'image-input',
          position,
          roleKey,
          (seedNode) => ({
            ...(seedNode.data as ImageInputNodeData),
            ...commonData,
          }),
          regionId,
          slot.slotKey
        )
      : slot.kind === 'video'
        ? createAssistantNode(
            existingRoleMap,
            'video-input',
            position,
            roleKey,
            (seedNode) => ({
              ...(seedNode.data as VideoInputNodeData),
              ...commonData,
            }),
            regionId,
            slot.slotKey
          )
        : createAssistantNode(
            existingRoleMap,
            'audio-input',
            position,
            roleKey,
            (seedNode) => ({
              ...(seedNode.data as AudioInputNodeData),
              ...commonData,
            }),
            regionId,
            slot.slotKey
          );

    const node = registerNode(draft);
    slotNodeByKey.set(slot.slotKey, node);
  });

  if (blueprint.voiceover.trim()) {
    const voiceoverPromptNode = registerNode(
      createAssistantNode(
        existingRoleMap,
        'text-input',
        { x: basePosition.x, y: basePosition.y + 220 + (sortedSlots.length * SLOT_VERTICAL_GAP) },
        'voiceover-prompt',
        (seedNode) => ({
          ...(seedNode.data as TextInputNodeData),
          title: 'Voiceover script',
          subtitle: 'Assistant-generated narration',
          text: blueprint.voiceover,
        }),
        regionId
      )
    );

    const voiceoverNode = registerNode(
      createAssistantNode(
        existingRoleMap,
        'voiceover-generate',
        { x: basePosition.x + 280, y: basePosition.y + 220 + (sortedSlots.length * SLOT_VERTICAL_GAP) },
        'voiceover-node',
        (seedNode) => ({
          ...(seedNode.data as VoiceoverGenerateNodeData),
          title: 'Voiceover',
          subtitle: 'Narration track',
          model: 'text-to-speech-turbo-2-5',
          voice: 'Rachel',
          languageCode: 'en',
        }),
        regionId
      )
    );

    assistantEdges.push(createCanvasEdge(voiceoverPromptNode.id, 'text', voiceoverNode.id, 'prompt'));
  }

  blueprint.shots.forEach((shot, index) => {
    const columnX = basePosition.x + 400 + (index * SHOT_COLUMN_WIDTH);
    const imagePromptNode = registerNode(
      createAssistantNode(
        existingRoleMap,
        'text-input',
        { x: columnX, y: basePosition.y + 20 },
        `shot-${shot.shotKey}-still-prompt`,
        (seedNode) => ({
          ...(seedNode.data as TextInputNodeData),
          title: `Shot ${index + 1} still prompt`,
          subtitle: shot.title,
          text: shot.visualPrompt,
        }),
        regionId
      )
    );

    const imageNode = registerNode(
      createAssistantNode(
        existingRoleMap,
        'image-generate',
        { x: columnX + 260, y: basePosition.y + 20 },
        `shot-${shot.shotKey}-still`,
        (seedNode) => ({
          ...(seedNode.data as ImageGenerateNodeData),
          title: `Shot ${index + 1} still`,
          subtitle: shot.title,
          model: blueprint.deliveryPlan.stillImageModel,
          aspectRatio: blueprint.deliveryPlan.aspectRatio,
          resolution: '1K',
          outputFormat: 'jpg',
        }),
        regionId
      )
    );

    const videoPromptNode = registerNode(
      createAssistantNode(
        existingRoleMap,
        'text-input',
        { x: columnX, y: basePosition.y + 20 + SHOT_CARD_VERTICAL_GAP },
        `shot-${shot.shotKey}-video-prompt`,
        (seedNode) => ({
          ...(seedNode.data as TextInputNodeData),
          title: `Shot ${index + 1} video prompt`,
          subtitle: shot.title,
          text: shot.videoPrompt,
        }),
        regionId
      )
    );

    const videoNode = registerNode(
      createAssistantNode(
        existingRoleMap,
        'video-generate',
        { x: columnX + 260, y: basePosition.y + 20 + SHOT_CARD_VERTICAL_GAP },
        `shot-${shot.shotKey}-video`,
        (seedNode) => ({
          ...(seedNode.data as VideoGenerateNodeData),
          title: `Shot ${index + 1} video`,
          subtitle: shot.title,
          model: blueprint.deliveryPlan.primaryModel,
          aspectRatio: blueprint.deliveryPlan.aspectRatio,
          duration: clampVideoDuration(blueprint.deliveryPlan.primaryModel, shot.duration),
          mode: 'std',
          sound: shot.referenceAudioSlotKeys.length === 0,
          resolution: '720p',
          fixedLens: false,
        }),
        regionId
      )
    );

    const motionPromptNode = registerNode(
      createAssistantNode(
        existingRoleMap,
        'text-input',
        { x: columnX, y: basePosition.y + 20 + (SHOT_CARD_VERTICAL_GAP * 2) },
        `shot-${shot.shotKey}-motion-prompt`,
        (seedNode) => ({
          ...(seedNode.data as TextInputNodeData),
          title: `Shot ${index + 1} motion prompt`,
          subtitle: shot.title,
          text: shot.motionPrompt,
        }),
        regionId
      )
    );

    const motionNode = registerNode(
      createAssistantNode(
        existingRoleMap,
        'motion-generate',
        { x: columnX + 260, y: basePosition.y + 20 + (SHOT_CARD_VERTICAL_GAP * 2) },
        `shot-${shot.shotKey}-motion`,
        (seedNode) => ({
          ...(seedNode.data as MotionGenerateNodeData),
          title: `Shot ${index + 1} motion`,
          subtitle: shot.title,
          model: blueprint.deliveryPlan.motionModel,
          mode: '720p',
          characterOrientation: 'video',
        }),
        regionId
      )
    );

    assistantEdges.push(
      createCanvasEdge(imagePromptNode.id, 'text', imageNode.id, 'prompt'),
      createCanvasEdge(videoPromptNode.id, 'text', videoNode.id, 'prompt'),
      createCanvasEdge(motionPromptNode.id, 'text', motionNode.id, 'prompt')
    );

    const videoNeedsReferenceImages = isSeedance2VideoModel(blueprint.deliveryPlan.primaryModel);
    const imageReferenceSlotKeys = [
      ...shot.referenceImageSlotKeys,
      ...[
        shot.startSlotKey,
        shot.endSlotKey,
      ].filter((slotKey): slotKey is string => Boolean(slotKey)),
    ];

    imageReferenceSlotKeys.forEach((slotKey) => {
      const slotNode = slotNodeByKey.get(slotKey);
      if (!slotNode || slotNode.type !== 'image-input') {
        return;
      }

      assistantEdges.push(createCanvasEdge(slotNode.id, 'image', imageNode.id, 'image-reference'));

      if (videoNeedsReferenceImages) {
        assistantEdges.push(createCanvasEdge(slotNode.id, 'image', videoNode.id, 'reference-image'));
      }
    });

    if (!videoNeedsReferenceImages) {
      if (shot.startSlotKey) {
        const startNode = slotNodeByKey.get(shot.startSlotKey);
        if (startNode?.type === 'image-input') {
          assistantEdges.push(createCanvasEdge(startNode.id, 'image', videoNode.id, 'start-frame'));
        }
      }

      if (shot.endSlotKey) {
        const endNode = slotNodeByKey.get(shot.endSlotKey);
        if (endNode?.type === 'image-input') {
          assistantEdges.push(createCanvasEdge(endNode.id, 'image', videoNode.id, 'end-frame'));
        }
      }

      shot.referenceImageSlotKeys.forEach((slotKey) => {
        const slotNode = slotNodeByKey.get(slotKey);
        if (slotNode?.type === 'image-input') {
          assistantEdges.push(createCanvasEdge(slotNode.id, 'image', videoNode.id, 'reference-image'));
        }
      });
    }

    if (videoNeedsReferenceImages) {
      shot.referenceVideoSlotKeys.forEach((slotKey) => {
        const slotNode = slotNodeByKey.get(slotKey);
        if (slotNode?.type === 'video-input') {
          assistantEdges.push(createCanvasEdge(slotNode.id, 'video', videoNode.id, 'reference-video'));
        }
      });

      shot.referenceAudioSlotKeys.forEach((slotKey) => {
        const slotNode = slotNodeByKey.get(slotKey);
        if (slotNode?.type === 'audio-input') {
          assistantEdges.push(createCanvasEdge(slotNode.id, 'audio', videoNode.id, 'reference-audio'));
        }
      });
    }

    const motionImageSlotKey = shot.startSlotKey || shot.referenceImageSlotKeys[0] || imageReferenceSlotKeys[0] || null;
    const motionVideoSlotKey = shot.referenceVideoSlotKeys[0] || null;

    if (motionImageSlotKey) {
      const slotNode = slotNodeByKey.get(motionImageSlotKey);
      if (slotNode?.type === 'image-input') {
        assistantEdges.push(createCanvasEdge(slotNode.id, 'image', motionNode.id, 'reference-image'));
      }
    } else {
      assistantEdges.push(createCanvasEdge(imageNode.id, 'image', motionNode.id, 'reference-image'));
    }

    if (motionVideoSlotKey) {
      const slotNode = slotNodeByKey.get(motionVideoSlotKey);
      if (slotNode?.type === 'video-input') {
        assistantEdges.push(createCanvasEdge(slotNode.id, 'video', motionNode.id, 'reference-video'));
      }
    } else {
      assistantEdges.push(createCanvasEdge(videoNode.id, 'video', motionNode.id, 'reference-video'));
    }
  });

  const proposedGraph = normalizeWorkflowGraph({
    ...normalizedCurrentGraph,
    nodes: [...manualNodes, ...assistantNodes],
    edges: [...manualEdges, ...assistantEdges],
  });

  return {
    regionId,
    proposedGraph,
    diff: computeWorkflowAssistantDiff(normalizedCurrentGraph, proposedGraph, regionId),
  };
}
