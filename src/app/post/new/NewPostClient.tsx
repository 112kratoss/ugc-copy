'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  BadgePlus,
  BookText,
  Check,
  Film,
  ImageIcon,
  Loader2,
  Plus,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import { assessMarketplaceListingQuality } from '@/lib/marketplace-trust';
import {
  getPostResourceKindLabel,
  normalizePostResourceBundleAccessMode,
  type PostResourceAttachment,
  type PostResourceBundleInput,
  type PostResourceBundleAccessMode,
  type PostResourceItem,
  type PostResourceItemRole,
  type PostResourceItemType,
  type PostResourceRemixUse,
  type PostResourceKind,
  type PostResourceSection,
  type PostResourceSectionKind,
} from '@/lib/post-resource-bundles';
import { slugifySourceTool, type SourceToolOption } from '@/lib/source-tools';
import { uploadMediaToTemporaryStorage } from '@/lib/temporary-media-upload';
import type { ShowcaseItemCategory } from '@/lib/showcase';
import CreatableCombobox, { type CreatableComboboxOption } from './CreatableCombobox';
import type { EditablePostDraft } from './post-editor-types';

type PostVisibility = 'public' | 'unlisted' | 'private';
type ProofMode = 'media' | 'text';
type PostFormat = 'text' | 'media' | 'mixed';
type PostMediaCategory = Exclude<ShowcaseItemCategory, 'text'>;

interface MadeWithRow {
  id: string;
  toolLabel: string;
  toolSlug: string;
  modelLabel: string;
  modelSlug: string;
  createTool: boolean;
  createModel: boolean;
}

interface CreatedPostState {
  postId: string;
  showcasePath: string | null;
  ownerPath: string;
  resourceBundlePath: string | null;
  visibility: PostVisibility;
  resourceAccessMode: PostResourceBundleAccessMode;
  resourceBundleStatus: 'draft' | 'published' | null;
}

interface ComposerError {
  section: 'post' | 'story' | 'resources' | 'publish';
  message: string;
}

class ComposerSubmissionError extends Error {
  readonly section: ComposerError['section'];

  constructor(message: string, section: ComposerError['section']) {
    super(message);
    this.name = 'ComposerSubmissionError';
    this.section = section;
  }
}

function getSubmissionError(data: { error?: string; field?: string }, fallback: string) {
  return new ComposerSubmissionError(
    data.error || fallback,
    data.field === 'sourceTools' ? 'post' : 'publish'
  );
}

interface AttachmentRow {
  id: string;
  label: string;
  kind: 'link' | 'file';
  url: string;
  storagePath: string;
  contentType: string;
  sizeBytes: number | null;
  resourceType: PostResourceItemType;
  role: PostResourceItemRole;
  remixUse: PostResourceRemixUse;
  isUploading?: boolean;
}

interface ResourceSectionRow {
  id: string;
  title: string;
  kind: PostResourceSectionKind;
  description: string;
  promptText: string;
  workflowShareUrl: string;
  notesMarkdown: string;
  attachments: AttachmentRow[];
  allowRemix: boolean;
}

interface GenerationDraft {
  id: string;
  title: string;
  description: string;
  prompt: string;
  outputUrl: string | null;
  category: PostMediaCategory;
  model: string;
  paywallPrefill: GenerationPaywallPrefill | null;
}

const BODY_MAX_LENGTH = 2000;

const RESOURCE_KIND_OPTIONS: Array<{
  value: PostResourceKind;
  label: string;
  description: string;
}> = [
  { value: 'prompt', label: 'Prompt', description: 'The exact prompt or prompt pack.' },
  { value: 'workflow', label: 'Workflow / setup', description: 'A workflow link, file link, or build path.' },
  { value: 'files', label: 'Files / links', description: 'Reference files, docs, presets, or source links.' },
  { value: 'notes', label: 'Notes', description: 'Usage notes, steps, or instructions.' },
  { value: 'remix', label: 'Remix access', description: 'Require an unlock before someone can remix.' },
];

const RESOURCE_ITEM_TYPE_OPTIONS: Array<{
  value: PostResourceItemType;
  label: string;
}> = [
  { value: 'reference_image', label: 'Reference image' },
  { value: 'workflow', label: 'Workflow' },
  { value: 'source_file', label: 'Source file' },
  { value: 'preset', label: 'Preset' },
  { value: 'external_link', label: 'Link' },
];

const RESOURCE_ITEM_ROLE_OPTIONS: Array<{
  value: PostResourceItemRole;
  label: string;
}> = [
  { value: 'primary', label: 'Primary' },
  { value: 'style_reference', label: 'Style reference' },
  { value: 'product_reference', label: 'Product reference' },
  { value: 'composition_reference', label: 'Composition reference' },
  { value: 'character_reference', label: 'Character reference' },
  { value: 'before_input', label: 'Before/input' },
  { value: 'supporting_workflow', label: 'Supporting workflow' },
  { value: 'manual_import', label: 'Manual import' },
  { value: 'other', label: 'Other' },
];

const RESOURCE_SECTION_KIND_OPTIONS: Array<{
  value: PostResourceSectionKind;
  label: string;
}> = [
  { value: 'scene', label: 'Scene' },
  { value: 'shot', label: 'Shot' },
  { value: 'frame', label: 'Frame' },
  { value: 'variation', label: 'Variation' },
  { value: 'workflow_step', label: 'Workflow step' },
  { value: 'asset_group', label: 'Asset group' },
  { value: 'chapter', label: 'Chapter' },
  { value: 'other', label: 'Other' },
];


const EMPTY_RESOURCE_SELECTIONS: Record<PostResourceKind, boolean> = {
  prompt: false,
  workflow: false,
  files: false,
  notes: false,
  remix: false,
};

let attachmentIdCounter = 0;
let resourceSectionIdCounter = 0;

function createAttachmentRow(partial?: Partial<Omit<AttachmentRow, 'id'>>): AttachmentRow {
  attachmentIdCounter += 1;

  return {
    id: `attachment-${attachmentIdCounter}`,
    label: partial?.label ?? '',
    kind: partial?.kind ?? 'link',
    url: partial?.url ?? '',
    storagePath: partial?.storagePath ?? '',
    contentType: partial?.contentType ?? '',
    sizeBytes: partial?.sizeBytes ?? null,
    resourceType: partial?.resourceType ?? 'external_link',
    role: partial?.role ?? 'primary',
    remixUse: partial?.remixUse ?? 'none',
  };
}

function createResourceSectionRow(partial?: Partial<Omit<ResourceSectionRow, 'id'>> & { id?: string }): ResourceSectionRow {
  resourceSectionIdCounter += 1;
  const id = partial?.id ?? `section-${resourceSectionIdCounter}`;

  return {
    id,
    title: partial?.title ?? `Section ${resourceSectionIdCounter}`,
    kind: partial?.kind ?? 'scene',
    description: partial?.description ?? '',
    promptText: partial?.promptText ?? '',
    workflowShareUrl: partial?.workflowShareUrl ?? '',
    notesMarkdown: partial?.notesMarkdown ?? '',
    attachments: partial?.attachments ?? [createAttachmentRow()],
    allowRemix: partial?.allowRemix ?? false,
  };
}

function inferCategory(file: File | null): PostMediaCategory | null {
  if (!file) {
    return null;
  }

  if (file.type.startsWith('image/')) {
    return 'image';
  }

  if (file.type.startsWith('video/')) {
    return 'video';
  }

  return null;
}

function serializeAttachmentRows(rows: AttachmentRow[]): PostResourceAttachment[] {
  return rows
    .map((row): PostResourceAttachment | null => {
      if (row.kind === 'file') {
        const storagePath = row.storagePath.trim();
        if (!storagePath) {
          return null;
        }

        return {
          label: row.label.trim() || storagePath.split('/').pop() || 'File',
          kind: 'file' as const,
          storagePath,
          contentType: row.contentType || null,
          sizeBytes: row.sizeBytes,
          resourceType: row.resourceType,
          role: row.role,
          remixUse: row.remixUse,
        };
      }

      const url = row.url.trim();
      if (!url) {
        return null;
      }

      return {
        label: row.label.trim() || url,
        kind: 'link' as const,
        url,
        resourceType: row.resourceType,
        role: row.role,
        remixUse: row.remixUse,
      };
    })
    .filter((row): row is PostResourceAttachment => row !== null);
}

function sectionHasContent(section: ResourceSectionRow): boolean {
  return Boolean(
    section.title.trim() ||
    section.description.trim() ||
    section.promptText.trim() ||
    section.workflowShareUrl.trim() ||
    section.notesMarkdown.trim() ||
    serializeAttachmentRows(section.attachments).length > 0 ||
    section.allowRemix
  );
}

function serializeResourceSectionRows(rows: ResourceSectionRow[]): PostResourceSection[] {
  return rows
    .filter(sectionHasContent)
    .map((row, index) => ({
      id: row.id,
      title: row.title.trim() || `Section ${index + 1}`,
      kind: row.kind,
      description: row.description.trim() || null,
      sortOrder: index,
    }));
}

function buildResourceItems(params: {
  selectedKinds: PostResourceKind[];
  promptText: string;
  notesMarkdown: string;
  workflowShareUrl: string;
  attachments: PostResourceAttachment[];
  allowRemix: boolean;
}): PostResourceItem[] {
  const items: PostResourceItem[] = [];
  const pushItem = (item: Omit<PostResourceItem, 'sortOrder' | 'isPrimary'>) => {
    items.push({
      ...item,
      sortOrder: items.length,
      isPrimary: items.length === 0,
    });
  };

  if (params.selectedKinds.includes('prompt') && params.promptText.trim()) {
    pushItem({
      type: 'prompt',
      role: 'primary',
      sectionId: null,
      title: 'Prompt',
      description: null,
      textContent: params.promptText.trim(),
      externalUrl: null,
      storagePath: null,
      contentType: null,
      sizeBytes: null,
      workflowSnapshot: null,
      remixUse: 'none',
    });
  }

  if (params.selectedKinds.includes('workflow') && params.workflowShareUrl.trim()) {
    pushItem({
      type: 'workflow',
      role: 'primary',
      sectionId: null,
      title: 'Workflow',
      description: null,
      textContent: null,
      externalUrl: params.workflowShareUrl.trim(),
      storagePath: null,
      contentType: null,
      sizeBytes: null,
      workflowSnapshot: null,
      remixUse: 'import_source',
    });
  }

  if (params.selectedKinds.includes('files')) {
    for (const attachment of params.attachments) {
      const type = attachment.resourceType ?? (attachment.kind === 'file' ? 'source_file' : 'external_link');
      pushItem({
        type,
        role: attachment.role ?? (type === 'reference_image' ? 'style_reference' : 'primary'),
        sectionId: null,
        title: attachment.label,
        description: null,
        textContent: null,
        externalUrl: attachment.kind === 'file' ? null : attachment.url ?? null,
        storagePath: attachment.kind === 'file' ? attachment.storagePath ?? null : null,
        contentType: attachment.contentType ?? null,
        sizeBytes: attachment.sizeBytes ?? null,
        workflowSnapshot: null,
        remixUse: attachment.remixUse ?? (type === 'reference_image' ? 'reference_only' : type === 'workflow' ? 'import_source' : 'none'),
      });
    }
  }

  if (params.selectedKinds.includes('notes') && params.notesMarkdown.trim()) {
    pushItem({
      type: 'note',
      role: 'primary',
      sectionId: null,
      title: 'Notes',
      description: null,
      textContent: params.notesMarkdown.trim(),
      externalUrl: null,
      storagePath: null,
      contentType: null,
      sizeBytes: null,
      workflowSnapshot: null,
      remixUse: 'none',
    });
  }

  if (params.allowRemix) {
    pushItem({
      type: 'remix_access',
      role: 'primary',
      sectionId: null,
      title: 'Remix access',
      description: null,
      textContent: null,
      externalUrl: null,
      storagePath: null,
      contentType: null,
      sizeBytes: null,
      workflowSnapshot: null,
      remixUse: 'direct_remix',
    });
  }

  return items;
}

function buildSectionResourceItems(sections: ResourceSectionRow[], startingSortOrder: number): PostResourceItem[] {
  const items: PostResourceItem[] = [];
  const pushItem = (
    section: ResourceSectionRow,
    item: Omit<PostResourceItem, 'sortOrder' | 'isPrimary'>
  ) => {
    items.push({
      ...item,
      sectionId: section.id,
      sortOrder: startingSortOrder + items.length,
      isPrimary: startingSortOrder + items.length === 0,
    });
  };

  for (const section of sections.filter(sectionHasContent)) {
    const sectionTitle = section.title.trim() || 'Section';
    const promptText = section.promptText.trim();
    const workflowShareUrl = section.workflowShareUrl.trim();
    const notesMarkdown = section.notesMarkdown.trim();

    if (promptText) {
      pushItem(section, {
        type: 'prompt',
        role: 'primary',
        sectionId: section.id,
        title: `${sectionTitle} prompt`,
        description: null,
        textContent: promptText,
        externalUrl: null,
        storagePath: null,
        contentType: null,
        sizeBytes: null,
        workflowSnapshot: null,
        remixUse: 'none',
      });
    }

    if (workflowShareUrl) {
      pushItem(section, {
        type: 'workflow',
        role: 'primary',
        sectionId: section.id,
        title: `${sectionTitle} workflow`,
        description: null,
        textContent: null,
        externalUrl: workflowShareUrl,
        storagePath: null,
        contentType: null,
        sizeBytes: null,
        workflowSnapshot: null,
        remixUse: 'import_source',
      });
    }

    for (const attachment of serializeAttachmentRows(section.attachments)) {
      const type = attachment.resourceType ?? (attachment.kind === 'file' ? 'source_file' : 'external_link');
      pushItem(section, {
        type,
        role: attachment.role ?? (type === 'reference_image' ? 'style_reference' : 'primary'),
        sectionId: section.id,
        title: attachment.label,
        description: null,
        textContent: null,
        externalUrl: attachment.kind === 'file' ? null : attachment.url ?? null,
        storagePath: attachment.kind === 'file' ? attachment.storagePath ?? null : null,
        contentType: attachment.contentType ?? null,
        sizeBytes: attachment.sizeBytes ?? null,
        workflowSnapshot: null,
        remixUse: attachment.remixUse ?? (type === 'reference_image' ? 'reference_only' : type === 'workflow' ? 'import_source' : 'none'),
      });
    }

    if (notesMarkdown) {
      pushItem(section, {
        type: 'note',
        role: 'primary',
        sectionId: section.id,
        title: `${sectionTitle} notes`,
        description: null,
        textContent: notesMarkdown,
        externalUrl: null,
        storagePath: null,
        contentType: null,
        sizeBytes: null,
        workflowSnapshot: null,
        remixUse: 'none',
      });
    }

    if (section.allowRemix) {
      pushItem(section, {
        type: 'remix_access',
        role: 'primary',
        sectionId: section.id,
        title: `${sectionTitle} remix access`,
        description: null,
        textContent: null,
        externalUrl: null,
        storagePath: null,
        contentType: null,
        sizeBytes: null,
        workflowSnapshot: null,
        remixUse: 'direct_remix',
      });
    }
  }

  return items;
}

function formatGeneratedCategory(value: string | null | undefined): PostMediaCategory {
  if (value === 'video' || value === 'motion' || value === 'ugc-ad') {
    return value;
  }

  return 'image';
}

function getLockedSummary(selectedKinds: PostResourceKind[]): string {
  if (selectedKinds.length === 0) {
    return 'Nothing locked';
  }

  return selectedKinds.map((kind) => getPostResourceKindLabel(kind)).join(', ');
}

function getVisibilityStatusLabel(v: PostVisibility): string {
  if (v === 'public') return 'Visible in Feed';
  if (v === 'unlisted') return 'Shareable by link only';
  return 'Saved privately in Studio';
}

function buildDefaultResourceSummary(selectedKinds: PostResourceKind[], mode: PostResourceBundleAccessMode): string {
  if (mode === 'none') {
    return '';
  }

  const kindSummary = selectedKinds.length > 0
    ? getLockedSummary(selectedKinds).toLowerCase()
    : 'reusable process';

  return `Unlock the ${kindSummary} behind this public post.`;
}

function buildDefaultResourcePreview(selectedKinds: PostResourceKind[]): string {
  if (selectedKinds.length === 0) {
    return 'Includes reusable resources buyers can open after access.';
  }

  return `Includes ${getLockedSummary(selectedKinds).toLowerCase()} for reuse after access.`;
}

function getInitialResourceSelections(bundle: PostResourceBundleInput | null | undefined): Record<PostResourceKind, boolean> {
  const resources = bundle?.resources;
  const items = resources?.items ?? [];
  return {
    prompt: Boolean(resources?.promptText?.trim() || items.some((item) => item.type === 'prompt')),
    workflow: Boolean(resources?.workflowShareUrl?.trim() || resources?.workflowSnapshot || items.some((item) => item.type === 'workflow')),
    files: Boolean((Array.isArray(resources?.attachments) && resources.attachments.length > 0) || items.some((item) => item.type === 'reference_image' || item.type === 'source_file' || item.type === 'preset' || item.type === 'external_link')),
    notes: Boolean(resources?.notesMarkdown?.trim() || items.some((item) => item.type === 'note' || item.type === 'settings')),
    remix: Boolean(resources?.allowRemix || items.some((item) => item.type === 'remix_access' || item.remixUse === 'direct_remix')),
  };
}

function getInitialAttachmentRows(bundle: PostResourceBundleInput | null | undefined): AttachmentRow[] {
  const attachments = Array.isArray(bundle?.resources?.attachments) && bundle.resources.attachments.length > 0
    ? bundle.resources.attachments
    : (bundle?.resources?.items ?? [])
      .filter((item) => !item.sectionId)
      .filter((item) => item.type === 'reference_image' || item.type === 'source_file' || item.type === 'preset' || item.type === 'external_link' || item.type === 'workflow')
      .filter((item) => item.storagePath || item.externalUrl)
      .map((item): PostResourceAttachment => ({
        label: item.title,
        kind: item.storagePath ? 'file' : 'link',
        url: item.externalUrl,
        storagePath: item.storagePath,
        contentType: item.contentType,
        sizeBytes: item.sizeBytes,
        resourceType: item.type,
        role: item.role,
        remixUse: item.remixUse,
      }));
  if (!attachments || attachments.length === 0) {
    return [createAttachmentRow()];
  }

    return attachments.map((attachment) =>
      createAttachmentRow({
        label: attachment.label,
        kind: attachment.kind === 'file' ? 'file' : 'link',
        url: attachment.url ?? '',
        storagePath: attachment.storagePath ?? '',
        contentType: attachment.contentType ?? '',
        sizeBytes: attachment.sizeBytes ?? null,
        resourceType: attachment.resourceType ?? (attachment.kind === 'file' ? 'source_file' : 'external_link'),
        role: attachment.role ?? 'primary',
        remixUse: attachment.remixUse ?? 'none',
      })
    );
}

function getInitialResourceSectionRows(bundle: PostResourceBundleInput | null | undefined): ResourceSectionRow[] {
  const sections = bundle?.resources?.sections ?? [];
  const items = bundle?.resources?.items ?? [];

  if (!Array.isArray(sections) || sections.length === 0) {
    return [];
  }

  return sections.map((section) => {
    const sectionItems = items.filter((item) => item.sectionId === section.id);
    const promptItem = sectionItems.find((item) => item.type === 'prompt');
    const workflowItem = sectionItems.find((item) => item.type === 'workflow');
    const notesItem = sectionItems.find((item) => item.type === 'note' || item.type === 'settings');
    const attachmentItems = sectionItems
      .filter((item) =>
        item.type === 'reference_image' ||
        item.type === 'source_file' ||
        item.type === 'preset' ||
        item.type === 'external_link'
      )
      .filter((item) => item.storagePath || item.externalUrl)
      .map((item): AttachmentRow => createAttachmentRow({
        label: item.title,
        kind: item.storagePath ? 'file' : 'link',
        url: item.externalUrl ?? '',
        storagePath: item.storagePath ?? '',
        contentType: item.contentType ?? '',
        sizeBytes: item.sizeBytes ?? null,
        resourceType: item.type,
        role: item.role,
        remixUse: item.remixUse,
      }));

    return createResourceSectionRow({
      id: section.id,
      title: section.title,
      kind: section.kind,
      description: section.description ?? '',
      promptText: promptItem?.textContent ?? '',
      workflowShareUrl: workflowItem?.externalUrl ?? '',
      notesMarkdown: notesItem?.textContent ?? '',
      attachments: attachmentItems.length > 0 ? attachmentItems : [createAttachmentRow()],
      allowRemix: sectionItems.some((item) => item.type === 'remix_access' || item.remixUse === 'direct_remix'),
    });
  });
}

async function uploadResourceFile(file: File, accessToken: string): Promise<PostResourceAttachment> {
  const formData = new FormData();
  formData.set('file', file);

  const response = await fetch('/api/posts/resource-files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: formData,
  });
  const data = await response.json();

  if (!response.ok || !data.attachment) {
    throw new Error(data.error || 'Failed to upload resource file.');
  }

  return data.attachment as PostResourceAttachment;
}

function getInitialPriceUsd(bundle: PostResourceBundleInput | null | undefined): string {
  if (bundle?.accessMode !== 'paid') {
    return '9';
  }

  const cents = typeof bundle.priceUsdCents === 'number' ? bundle.priceUsdCents : 0;
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

function getInitialProofMode(initialPost: EditablePostDraft | null | undefined): ProofMode {
  if (!initialPost) {
    return 'media';
  }

  return initialPost.postFormat === 'text' && !initialPost.mediaUrl ? 'text' : 'media';
}

function isGenerationPaywallPrefill(value: unknown): value is GenerationPaywallPrefill {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const typedValue = value as Partial<GenerationPaywallPrefill>;
  if (!Array.isArray(typedValue.resourceKinds)) {
    return false;
  }

  const validKinds = new Set<PostResourceKind>(RESOURCE_KIND_OPTIONS.map((option) => option.value));
  if (!typedValue.resourceKinds.every((kind) => validKinds.has(kind))) {
    return false;
  }

  return (
    (typeof typedValue.promptText === 'string' || typedValue.promptText === null || typedValue.promptText === undefined) &&
    (typeof typedValue.notesMarkdown === 'string' || typedValue.notesMarkdown === null || typedValue.notesMarkdown === undefined) &&
    typeof typedValue.allowRemix === 'boolean'
  );
}

function hasUsableGenerationPaywallPrefill(prefill: GenerationPaywallPrefill | null | undefined): boolean {
  return Boolean(prefill && prefill.resourceKinds.length > 0);
}

interface NewPostClientProps {
  initialPost?: EditablePostDraft | null;
}

export default function NewPostClient({ initialPost = null }: NewPostClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session } = useAuth();
  const generationId = initialPost?.generationId ?? searchParams.get('generationId');
  const isEditMode = Boolean(initialPost);
  const publishIntent = searchParams.get('publishIntent');
  const requestedResourceMode = searchParams.get('resourceMode');
  const requestedFocusTarget = searchParams.get('focus');
  const entrySurface = searchParams.get('from');
  const isGeneratedPaywallIntent = publishIntent === 'paid-generation' && Boolean(generationId);
  const isCreationPaywallManagementIntent =
    isEditMode && entrySurface === 'creations' && requestedFocusTarget === 'price';
  const initialBundle = initialPost?.resourceBundle ?? { accessMode: 'none' as const };
  const initialResourceSelections = getInitialResourceSelections(initialBundle);
  const initialCategory =
    initialPost?.category && initialPost.category !== 'text'
      ? initialPost.category
      : 'image';
  const initialResourceAccessMode = normalizePostResourceBundleAccessMode(requestedResourceMode ?? initialBundle.accessMode);

  const [proofMode, setProofMode] = useState<ProofMode>(() => getInitialProofMode(initialPost));
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [title, setTitle] = useState(initialPost?.title ?? '');
  const [description, setDescription] = useState(initialPost?.description ?? '');
  const [body, setBody] = useState(initialPost?.body ?? '');
  const [madeWithRows, setMadeWithRows] = useState<MadeWithRow[]>(() => {
    if (initialPost?.sourceTools && initialPost.sourceTools.length > 0) {
      return initialPost.sourceTools.map((st, i) => ({
        id: `mw-${i}`,
        toolLabel: st.toolLabel,
        toolSlug: st.toolSlug ?? '',
        modelLabel: st.modelLabel ?? '',
        modelSlug: st.modelSlug ?? '',
        createTool: st.createTool === true,
        createModel: st.createModel === true,
      }));
    }
    if (initialPost?.sourceTool) {
      return [{
        id: 'mw-0',
        toolLabel: initialPost.sourceTool,
        toolSlug: initialPost.sourceToolSlug ?? '',
        modelLabel: '',
        modelSlug: '',
        createTool: false,
        createModel: false,
      }];
    }
    if (initialPost?.generationId || generationId) {
      return [{
        id: 'mw-0',
        toolLabel: 'magicbooklet',
        toolSlug: 'magicbooklet',
        modelLabel: '',
        modelSlug: '',
        createTool: false,
        createModel: false,
      }];
    }
    return [{
      id: 'mw-0',
      toolLabel: '',
      toolSlug: '',
      modelLabel: '',
      modelSlug: '',
      createTool: false,
      createModel: false,
    }];
  });
  const [sourceToolsData, setSourceToolsData] = useState<SourceToolOption[]>([]);
  const [visibility, setVisibility] = useState<PostVisibility>(initialPost?.visibility ?? 'public');
  const [category, setCategory] = useState<PostMediaCategory>(initialCategory);
  const [isDetailsOpen, setIsDetailsOpen] = useState(Boolean(initialPost?.description));
  const [resourceAccessMode, setResourceAccessMode] = useState<PostResourceBundleAccessMode>(initialResourceAccessMode);
  const [resourceSelections, setResourceSelections] = useState<Record<PostResourceKind, boolean>>(
    Object.values(initialResourceSelections).some(Boolean)
      ? initialResourceSelections
      : EMPTY_RESOURCE_SELECTIONS
  );
  const [resourceSummary] = useState(initialBundle.summary ?? '');
  const [resourcePreviewText] = useState(initialBundle.previewText ?? '');
  const [resourcePromptText, setResourcePromptText] = useState(initialBundle.resources?.promptText ?? '');
  const [resourceNotes, setResourceNotes] = useState(initialBundle.resources?.notesMarkdown ?? '');
  const [resourceWorkflowUrl, setResourceWorkflowUrl] = useState(initialBundle.resources?.workflowShareUrl ?? '');
  const [resourceAttachmentRows, setResourceAttachmentRows] = useState<AttachmentRow[]>(() => getInitialAttachmentRows(initialBundle));
  const [resourceSectionRows, setResourceSectionRows] = useState<ResourceSectionRow[]>(() => getInitialResourceSectionRows(initialBundle));
  const [organizeResourceSections, setOrganizeResourceSections] = useState(() =>
    (initialBundle.resources?.sections?.length ?? 0) > 0
  );
  const [resourcePriceUsd, setResourcePriceUsd] = useState(() => getInitialPriceUsd(initialBundle));
  const [resourceSelectionsTouched, setResourceSelectionsTouched] = useState(false);
  const [resourcePromptTouched, setResourcePromptTouched] = useState(false);
  const [resourceNotesTouched, setResourceNotesTouched] = useState(false);
  const [didApplyGenerationPaywallPrefill, setDidApplyGenerationPaywallPrefill] = useState(false);
  const [didFocusPriceInput, setDidFocusPriceInput] = useState(false);
  const [error, setError] = useState<ComposerError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdPost, setCreatedPost] = useState<CreatedPostState | null>(null);
  const [prefilledGeneration, setPrefilledGeneration] = useState<GenerationDraft | null>(() =>
    initialPost?.generationId
      ? {
          id: initialPost.generationId,
          title: initialPost.title,
          description: initialPost.description,
          prompt: initialPost.prompt,
          outputUrl: initialPost.mediaUrl,
          category: initialCategory,
          model: 'magicbooklet',
          paywallPrefill: null,
        }
      : null
  );
  const [isLoadingGeneration, setIsLoadingGeneration] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const submitVisibilityRef = useRef<PostVisibility>(initialPost?.visibility ?? 'public');
  const formRef = useRef<HTMLFormElement | null>(null);
  const priceInputRef = useRef<HTMLInputElement | null>(null);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const postSectionRef = useRef<HTMLDivElement | null>(null);
  const storySectionRef = useRef<HTMLDivElement | null>(null);
  const resourceSectionRef = useRef<HTMLDivElement | null>(null);
  const publishSectionRef = useRef<HTMLDivElement | null>(null);

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  const existingProofUrl = initialPost?.generationId ? null : initialPost?.mediaUrl ?? null;
  const hasGeneratedProof = Boolean(prefilledGeneration);
  const selectedResourceKinds = useMemo(
    () => RESOURCE_KIND_OPTIONS.filter((option) => resourceSelections[option.value]).map((option) => option.value),
    [resourceSelections]
  );
  const trimmedBody = body.trim();
  const bodyCount = body.length;
  const hasMediaProof = proofMode === 'media' && (Boolean(file) || hasGeneratedProof || Boolean(existingProofUrl));
  const postFormat: PostFormat = hasMediaProof ? (trimmedBody ? 'mixed' : 'media') : 'text';
  const displayVisibility = visibility;
  const attachments = useMemo(() => serializeAttachmentRows(resourceAttachmentRows), [resourceAttachmentRows]);
  const generationPaywallPrefill = prefilledGeneration?.paywallPrefill ?? null;
  const hasGenerationPaywallPrefill = hasUsableGenerationPaywallPrefill(generationPaywallPrefill);
  const shouldFocusPriceInput =
    requestedFocusTarget === 'price' && (isGeneratedPaywallIntent || isCreationPaywallManagementIntent);
  const hasResourceContent = Boolean(
    (resourceSelections.prompt && resourcePromptText.trim()) ||
    (resourceSelections.notes && resourceNotes.trim()) ||
    (resourceSelections.workflow && resourceWorkflowUrl.trim()) ||
    (resourceSelections.files && attachments.length > 0) ||
    resourceSelections.remix ||
    (organizeResourceSections && resourceSectionRows.some(sectionHasContent))
  );
  const parsedResourcePriceUsd = Number.parseFloat(resourcePriceUsd.trim() || '0');
  const resourcePriceUsdCents = resourceAccessMode === 'paid' && Number.isFinite(parsedResourcePriceUsd)
    ? Math.round(parsedResourcePriceUsd * 100)
    : 0;
  const defaultResourceSummary = useMemo(
    () => buildDefaultResourceSummary(selectedResourceKinds, resourceAccessMode),
    [resourceAccessMode, selectedResourceKinds]
  );
  const defaultResourcePreview = useMemo(
    () => buildDefaultResourcePreview(selectedResourceKinds),
    [selectedResourceKinds]
  );
  const resourceItems = useMemo(
    () => {
      const globalItems = buildResourceItems({
        selectedKinds: selectedResourceKinds,
        promptText: resourcePromptText,
        notesMarkdown: resourceNotes,
        workflowShareUrl: resourceWorkflowUrl,
        attachments,
        allowRemix: resourceSelections.remix,
      });

      return organizeResourceSections
        ? [
            ...globalItems,
            ...buildSectionResourceItems(resourceSectionRows, globalItems.length),
          ]
        : globalItems;
    },
    [
      attachments,
      organizeResourceSections,
      resourceNotes,
      resourcePromptText,
      resourceSectionRows,
      resourceSelections.remix,
      resourceWorkflowUrl,
      selectedResourceKinds,
    ]
  );
  const resourceSections = useMemo(
    () => organizeResourceSections ? serializeResourceSectionRows(resourceSectionRows) : [],
    [organizeResourceSections, resourceSectionRows]
  );
  const resourceBundleDraft = useMemo<PostResourceBundleInput | null>(() => {
    if (resourceAccessMode === 'none') {
      return null;
    }

    return {
      accessMode: resourceAccessMode,
      summary: resourceSummary.trim() || defaultResourceSummary,
      previewText: resourcePreviewText.trim() || defaultResourcePreview,
      priceUsdCents: resourceAccessMode === 'paid' ? resourcePriceUsdCents : 0,
      resources: {
        promptText: resourceSelections.prompt ? resourcePromptText.trim() || null : null,
        notesMarkdown: resourceSelections.notes ? resourceNotes.trim() || null : null,
        workflowShareUrl: resourceSelections.workflow ? resourceWorkflowUrl.trim() || null : null,
        attachments: resourceSelections.files ? attachments : [],
        allowRemix: resourceSelections.remix,
        sections: resourceSections,
        items: resourceItems,
      },
    };
  }, [
    attachments,
    defaultResourcePreview,
    defaultResourceSummary,
    resourceAccessMode,
    resourceNotes,
    resourcePreviewText,
    resourcePriceUsdCents,
    resourcePromptText,
    resourceSections,
    resourceItems,
    resourceSelections,
    resourceSummary,
    resourceWorkflowUrl,
  ]);
  const publicPostTitle = title.trim() || (trimmedBody ? trimmedBody.split(/[.!?\n]/)[0]?.trim() ?? '' : '');
  const completionChecklist = useMemo(() => [
    {
      label: 'Proof added',
      complete: hasMediaProof || trimmedBody.length >= 24,
      detail: hasMediaProof ? 'Media is attached' : trimmedBody.length >= 24 ? 'Text proof is ready' : 'Add media or switch to text',
    },
    {
      label: 'Story ready',
      complete: proofMode !== 'text' || trimmedBody.length > 0,
      detail: trimmedBody ? (proofMode === 'text' ? 'Post body is included' : 'Caption is included') : 'Add a short visible post',
    },
    {
      label: 'Unlock optional',
      complete: resourceAccessMode === 'none' || hasResourceContent,
      detail: resourceAccessMode === 'none' ? 'No unlock selected' : hasResourceContent ? getLockedSummary(selectedResourceKinds) : 'Add one asset',
    },
  ], [
    hasMediaProof,
    hasResourceContent,
    proofMode,
    resourceAccessMode,
    selectedResourceKinds,
    trimmedBody,
  ]);
  const stepBadgeLabel = hasGeneratedProof ? 'Generated media attached' : proofMode === 'text' ? 'Text post' : 'Media post';

  useEffect(() => {
    if (!previewUrl) {
      return;
    }

    return () => {
      URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    setDidApplyGenerationPaywallPrefill(false);
    setDidFocusPriceInput(false);
  }, [generationId, isCreationPaywallManagementIntent, isGeneratedPaywallIntent]);

  useEffect(() => {
    if (resourceAccessMode === 'none') {
      return;
    }

    if (!Object.values(resourceSelections).some(Boolean)) {
      setResourceSelections((current) => ({
        ...current,
        prompt: true,
      }));
    }
  }, [resourceAccessMode, resourceSelections]);

  useEffect(() => {
    if (!resourceSelections.files) {
      return;
    }

    if (resourceAttachmentRows.length === 0) {
      setResourceAttachmentRows([createAttachmentRow()]);
    }
  }, [resourceAttachmentRows.length, resourceSelections.files]);

  useEffect(() => {
    if (!isGeneratedPaywallIntent || didApplyGenerationPaywallPrefill || !prefilledGeneration) {
      return;
    }

    const paywallPrefill = prefilledGeneration.paywallPrefill;
    if (!paywallPrefill || !hasUsableGenerationPaywallPrefill(paywallPrefill)) {
      setDidApplyGenerationPaywallPrefill(true);
      return;
    }

    if (!resourceSelectionsTouched) {
      setResourceSelections((current) => {
        const nextSelections = { ...current };
        for (const kind of paywallPrefill.resourceKinds) {
          nextSelections[kind] = true;
        }
        return nextSelections;
      });
    }

    if (!resourcePromptTouched && !resourcePromptText.trim() && paywallPrefill.promptText) {
      setResourcePromptText(paywallPrefill.promptText);
    }

    if (!resourceNotesTouched && !resourceNotes.trim() && paywallPrefill.notesMarkdown) {
      setResourceNotes(paywallPrefill.notesMarkdown);
    }

    setDidApplyGenerationPaywallPrefill(true);
  }, [
    didApplyGenerationPaywallPrefill,
    isGeneratedPaywallIntent,
    prefilledGeneration,
    resourceNotes,
    resourceNotesTouched,
    resourcePromptText,
    resourcePromptTouched,
    resourceSelectionsTouched,
  ]);

  useEffect(() => {
    if (
      !shouldFocusPriceInput ||
      didFocusPriceInput ||
      isLoadingGeneration ||
      resourceAccessMode !== 'paid'
    ) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      priceInputRef.current?.focus();
      priceInputRef.current?.select();
      setDidFocusPriceInput(true);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    didFocusPriceInput,
    isLoadingGeneration,
    resourceAccessMode,
    shouldFocusPriceInput,
  ]);

  useEffect(() => {
    if (!generationId || !session?.access_token) {
      setPrefilledGeneration(null);
      setGenerationError(null);
      return;
    }

    let cancelled = false;

    const loadGeneration = async () => {
      setIsLoadingGeneration(true);
      setGenerationError(null);

      try {
        const response = await fetch('/api/generations', {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || 'Failed to load generation.');
        }

        const generation = Array.isArray(payload.generations)
          ? payload.generations.find((item: { id?: string }) => item.id === generationId)
          : null;

        if (!generation) {
          throw new Error('We could not find that generation in your account.');
        }

        if (cancelled) {
          return;
        }

        const nextGeneration: GenerationDraft = {
          id: generation.id,
          title: typeof generation.title === 'string' ? generation.title : '',
          description: typeof generation.description === 'string' ? generation.description : '',
          prompt: typeof generation.prompt === 'string' ? generation.prompt : '',
          outputUrl: typeof generation.output_url === 'string' ? generation.output_url : null,
          category: formatGeneratedCategory(generation.category),
          model: typeof generation.model === 'string' ? generation.model : 'magicbooklet',
          paywallPrefill: isGenerationPaywallPrefill(generation.paywallPrefill)
            ? generation.paywallPrefill
            : null,
        };

        setPrefilledGeneration(nextGeneration);
        setProofMode('media');
        setCategory(nextGeneration.category);
        setTitle((current) => current || nextGeneration.title);
        setDescription((current) => current || nextGeneration.description);
      } catch (loadError) {
        if (!cancelled) {
          setGenerationError(loadError instanceof Error ? loadError.message : 'Failed to load generation.');
          setPrefilledGeneration(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingGeneration(false);
        }
      }
    };

    void loadGeneration();

    return () => {
      cancelled = true;
    };
  }, [generationId, session?.access_token]);

  useEffect(() => {
    let cancelled = false;

    void fetch('/api/source-tools')
      .then(async (response) => {
        const payload = await response.json();
        if (!cancelled && Array.isArray(payload.tools)) {
          setSourceToolsData(payload.tools as SourceToolOption[]);
        }
      })
      .catch(() => {
        // Source tools fetch is non-critical; use empty list as fallback.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (prefilledGeneration && madeWithRows.length === 1 && !madeWithRows[0].toolLabel) {
      setMadeWithRows([{
        id: 'mw-0',
        toolLabel: 'magicbooklet',
        toolSlug: 'magicbooklet',
        modelLabel: prefilledGeneration.model || '',
        modelSlug: prefilledGeneration.model || '',
        createTool: false,
        createModel: false,
      }]);
    }
  }, [prefilledGeneration, madeWithRows]);

  const inferredCategory = useMemo((): PostMediaCategory | null => {
    if (proofMode === 'text') return null;
    if (hasGeneratedProof) return prefilledGeneration?.category ?? 'image';
    return inferCategory(file);
  }, [file, hasGeneratedProof, prefilledGeneration, proofMode]);

  const sourceToolsForSubmit = useMemo(() => {
    return madeWithRows
      .filter((row) => row.toolLabel.trim())
      .map((row) => {
        const requestedSlug = slugifySourceTool(row.toolSlug);
        const selectedTool = sourceToolsData.find(
          (tool) =>
            (requestedSlug && tool.slug === requestedSlug) ||
            tool.label.toLowerCase() === row.toolLabel.trim().toLowerCase()
        );
        const requestedModelSlug = slugifySourceTool(row.modelSlug);
        const selectedModel = selectedTool?.models.find(
          (model) =>
            (requestedModelSlug && model.slug === requestedModelSlug) ||
            model.label.toLowerCase() === row.modelLabel.trim().toLowerCase()
        );

        return {
          toolLabel: selectedTool?.label ?? row.toolLabel.trim(),
          toolSlug: selectedTool?.slug ?? requestedSlug ?? slugifySourceTool(row.toolLabel),
          modelLabel: selectedModel?.label ?? (row.modelLabel.trim() || null),
          modelSlug: selectedModel?.slug ?? slugifySourceTool(row.modelSlug || row.modelLabel),
          ...(row.createTool ? { createTool: true } : {}),
          ...(row.createModel ? { createModel: true } : {}),
        };
      });
  }, [madeWithRows, sourceToolsData]);

  const primarySourceTool = useMemo(() => {
    if (sourceToolsForSubmit.length === 0) {
      return { label: null, slug: null };
    }
    const first = sourceToolsForSubmit[0];
    return { label: first.toolLabel, slug: first.toolSlug };
  }, [sourceToolsForSubmit]);

  const updateMadeWithRow = (id: string, patch: Partial<MadeWithRow>) => {
    setMadeWithRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
    resetFeedback();
  };

  const addMadeWithRow = () => {
    setMadeWithRows((current) => [
      ...current,
      {
        id: `mw-${Date.now()}`,
        toolLabel: '',
        toolSlug: '',
        modelLabel: '',
        modelSlug: '',
        createTool: false,
        createModel: false,
      },
    ]);
    resetFeedback();
  };

  const removeMadeWithRow = (id: string) => {
    setMadeWithRows((current) => {
      const next = current.filter((row) => row.id !== id);
      return next.length > 0 ? next : [{
        id: 'mw-0',
        toolLabel: '',
        toolSlug: '',
        modelLabel: '',
        modelSlug: '',
        createTool: false,
        createModel: false,
      }];
    });
    resetFeedback();
  };

  const submitWithVisibility = (targetVisibility: PostVisibility) => {
    submitVisibilityRef.current = targetVisibility;
    setVisibility(targetVisibility);
    resetFeedback();
  };

  const resetFeedback = () => {
    setCreatedPost(null);
    setError(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      if (droppedFile.type.startsWith('image/') || droppedFile.type.startsWith('video/')) {
        setFile(droppedFile);
        resetFeedback();
      }
    }
  };

  const handleMiddleClick = () => {
    mediaInputRef.current?.click();
  };

  const focusComposerSection = (section: 'post' | 'story' | 'resources' | 'publish') => {
    const target = {
      post: postSectionRef,
      story: storySectionRef,
      resources: resourceSectionRef,
      publish: publishSectionRef,
    }[section];

    window.requestAnimationFrame(() => {
      target.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.current?.focus({ preventScroll: true });
    });
  };

  const stopWithError = (message: string, section: 'post' | 'story' | 'resources' | 'publish') => {
    setError({ section, message });
    focusComposerSection(section);
  };

  const renderSectionError = (section: ComposerError['section']) => {
    if (!error || error.section !== section) {
      return null;
    }

    return (
      <div role="alert" className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
        {error.message}
      </div>
    );
  };

  const updateResourceSelection = (kind: PostResourceKind) => {
    setResourceSelectionsTouched(true);
    setResourceSelections((current) => ({
      ...current,
      [kind]: !current[kind],
    }));
    resetFeedback();
  };


  const updateAttachmentRow = (
    id: string,
    field: 'label' | 'url' | 'resourceType' | 'role' | 'remixUse',
    value: string
  ) => {
    setResourceAttachmentRows((current) =>
      current.map((row) => {
        if (row.id !== id) {
          return row;
        }

        if (field === 'resourceType') {
          return { ...row, resourceType: value as PostResourceItemType };
        }

        if (field === 'role') {
          return { ...row, role: value as PostResourceItemRole };
        }

        if (field === 'remixUse') {
          return { ...row, remixUse: value as PostResourceRemixUse };
        }

        return { ...row, [field]: value };
      })
    );
    resetFeedback();
  };

  const updateResourceSection = (
    id: string,
    field: 'title' | 'kind' | 'description' | 'promptText' | 'workflowShareUrl' | 'notesMarkdown' | 'allowRemix',
    value: string | boolean
  ) => {
    setResourceSectionRows((current) =>
      current.map((section) => section.id === id ? { ...section, [field]: value } : section)
    );
    resetFeedback();
  };

  const addResourceSection = () => {
    setOrganizeResourceSections(true);
    setResourceSectionRows((current) => [...current, createResourceSectionRow()]);
    resetFeedback();
  };

  const duplicateResourceSection = (id: string) => {
    setResourceSectionRows((current) => {
      const section = current.find((row) => row.id === id);
      if (!section) {
        return current;
      }

      return [
        ...current,
        createResourceSectionRow({
          ...section,
          id: undefined,
          title: `${section.title || 'Section'} copy`,
          attachments: section.attachments.map((attachment) => createAttachmentRow({ ...attachment })),
        }),
      ];
    });
    resetFeedback();
  };

  const removeResourceSection = (id: string) => {
    setResourceSectionRows((current) => current.filter((section) => section.id !== id));
    resetFeedback();
  };

  const applySectionToFullPost = (id: string) => {
    const section = resourceSectionRows.find((row) => row.id === id);
    if (!section) {
      return;
    }

    if (section.promptText.trim()) {
      setResourcePromptText(section.promptText);
      setResourcePromptTouched(true);
      setResourceSelections((current) => ({ ...current, prompt: true }));
    }

    if (section.workflowShareUrl.trim()) {
      setResourceWorkflowUrl(section.workflowShareUrl);
      setResourceSelections((current) => ({ ...current, workflow: true }));
    }

    if (section.notesMarkdown.trim()) {
      setResourceNotes(section.notesMarkdown);
      setResourceNotesTouched(true);
      setResourceSelections((current) => ({ ...current, notes: true }));
    }

    const sectionAttachments = serializeAttachmentRows(section.attachments);
    if (sectionAttachments.length > 0) {
      setResourceAttachmentRows(sectionAttachments.map((attachment) => createAttachmentRow({
        label: attachment.label,
        kind: attachment.kind === 'file' ? 'file' : 'link',
        url: attachment.url ?? '',
        storagePath: attachment.storagePath ?? '',
        contentType: attachment.contentType ?? '',
        sizeBytes: attachment.sizeBytes ?? null,
        resourceType: attachment.resourceType ?? (attachment.kind === 'file' ? 'source_file' : 'external_link'),
        role: attachment.role ?? 'primary',
        remixUse: attachment.remixUse ?? 'none',
      })));
      setResourceSelections((current) => ({ ...current, files: true }));
    }

    if (section.allowRemix) {
      setResourceSelections((current) => ({ ...current, remix: true }));
    }

    resetFeedback();
  };

  const updateSectionAttachmentRow = (
    sectionId: string,
    attachmentId: string,
    field: 'label' | 'url' | 'resourceType' | 'role' | 'remixUse',
    value: string
  ) => {
    setResourceSectionRows((current) =>
      current.map((section) => {
        if (section.id !== sectionId) {
          return section;
        }

        return {
          ...section,
          attachments: section.attachments.map((attachment) => {
            if (attachment.id !== attachmentId) {
              return attachment;
            }

            if (field === 'resourceType') {
              return { ...attachment, resourceType: value as PostResourceItemType };
            }

            if (field === 'role') {
              return { ...attachment, role: value as PostResourceItemRole };
            }

            if (field === 'remixUse') {
              return { ...attachment, remixUse: value as PostResourceRemixUse };
            }

            return { ...attachment, [field]: value };
          }),
        };
      })
    );
    resetFeedback();
  };

  const addSectionAttachmentRow = (sectionId: string) => {
    setResourceSectionRows((current) =>
      current.map((section) =>
        section.id === sectionId
          ? { ...section, attachments: [...section.attachments, createAttachmentRow()] }
          : section
      )
    );
    resetFeedback();
  };

  const removeSectionAttachmentRow = (sectionId: string, attachmentId: string) => {
    setResourceSectionRows((current) =>
      current.map((section) => {
        if (section.id !== sectionId) {
          return section;
        }

        const nextAttachments = section.attachments.filter((attachment) => attachment.id !== attachmentId);
        return {
          ...section,
          attachments: nextAttachments.length > 0 ? nextAttachments : [createAttachmentRow()],
        };
      })
    );
    resetFeedback();
  };

  const handleAttachmentFileUpload = async (id: string, fileToUpload: File | null) => {
    if (!fileToUpload || !session?.access_token) {
      return;
    }

    setResourceAttachmentRows((current) =>
      current.map((row) => row.id === id ? { ...row, isUploading: true } : row)
    );
    resetFeedback();

    try {
      const uploaded = await uploadResourceFile(fileToUpload, session.access_token);
      setResourceAttachmentRows((current) =>
        current.map((row) =>
          row.id === id
            ? {
                ...row,
                label: uploaded.label,
                kind: 'file',
                url: '',
                storagePath: uploaded.storagePath ?? '',
                contentType: uploaded.contentType ?? '',
                sizeBytes: uploaded.sizeBytes ?? null,
                resourceType: uploaded.contentType?.startsWith('image/') ? 'reference_image' : row.resourceType === 'external_link' ? 'source_file' : row.resourceType,
                role: uploaded.contentType?.startsWith('image/') ? 'style_reference' : row.role,
                remixUse: uploaded.contentType?.startsWith('image/') ? 'reference_only' : row.remixUse,
                isUploading: false,
              }
            : row
        )
      );
    } catch (uploadError) {
      setError({
        section: 'resources',
        message: uploadError instanceof Error ? uploadError.message : 'Failed to upload resource file.',
      });
      setResourceAttachmentRows((current) =>
        current.map((row) => row.id === id ? { ...row, isUploading: false } : row)
      );
    }
  };

  const addAttachmentRow = () => {
    setResourceAttachmentRows((current) => [...current, createAttachmentRow()]);
    resetFeedback();
  };

  const removeAttachmentRow = (id: string) => {
    setResourceAttachmentRows((current) => {
      const nextRows = current.filter((row) => row.id !== id);
      return nextRows.length > 0 ? nextRows : [createAttachmentRow()];
    });
    resetFeedback();
  };

  const completePublish = (nextPost: CreatedPostState, options: { redirect?: boolean } = {}) => {
    setCreatedPost(nextPost);

    if (options.redirect) {
      const nextPath = nextPost.showcasePath ?? nextPost.ownerPath;
      if (nextPath) {
        router.push(nextPath);
      }
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setCreatedPost(null);

    const effectiveVisibility = submitVisibilityRef.current;

    if (!session?.access_token) {
      router.push('/login?returnUrl=/post/new');
      return;
    }

    if (proofMode === 'media' && !hasMediaProof) {
      stopWithError(hasGeneratedProof ? 'We could not load the generated media. Try again from My Studio.' : 'Upload an image or video to start the post.', 'post');
      return;
    }

    if (!trimmedBody && !hasMediaProof) {
      stopWithError('Add a story or media before publishing.', 'story');
      return;
    }

    if (proofMode === 'text' && !trimmedBody) {
      stopWithError('Write the story before publishing a text post.', 'story');
      return;
    }

    if (file?.type.startsWith('audio/')) {
      stopWithError('Audio posts are not supported in the community feed yet.', 'post');
      return;
    }

    if (bodyCount > BODY_MAX_LENGTH) {
      stopWithError(`Story posts are limited to ${BODY_MAX_LENGTH} characters.`, 'story');
      return;
    }

    let resourceBundle: PostResourceBundleInput | undefined;
    if (resourceAccessMode !== 'none') {
      if (selectedResourceKinds.length === 0) {
        stopWithError('Choose at least one thing people will unlock.', 'resources');
        return;
      }

      if (resourceAccessMode === 'paid' && (!Number.isFinite(parsedResourcePriceUsd) || parsedResourcePriceUsd < 1)) {
        stopWithError('Paid unlocks must be priced at $1.00 or above.', 'resources');
        return;
      }

      if (!hasResourceContent) {
        stopWithError('Add content for at least one selected unlock item before publishing.', 'resources');
        return;
      }

      const shouldRunSubmittedMarketplaceQuality = effectiveVisibility === 'public';
      const submittedMarketplaceAssessment = resourceBundleDraft && shouldRunSubmittedMarketplaceQuality
        ? assessMarketplaceListingQuality({
            title: publicPostTitle,
            summary: resourceBundleDraft.summary,
            previewText: resourceBundleDraft.previewText,
            accessMode: resourceBundleDraft.accessMode,
            priceUsdCents: resourceBundleDraft.priceUsdCents,
            resources: resourceBundleDraft.resources,
            post: {
              title: publicPostTitle,
              body: trimmedBody,
              visibility: effectiveVisibility,
              archivedAt: initialPost?.archivedAt ?? null,
              reviewStatus: 'visible',
              hasMedia: hasMediaProof,
            },
            seller: {
              name: 'Profile ready',
            },
          })
        : { eligible: true, issues: [] };

      if (!submittedMarketplaceAssessment.eligible) {
        const firstIssue = submittedMarketplaceAssessment.issues[0];
        stopWithError(`Improve this unlock before publishing: ${firstIssue?.message ?? 'Finish the marketplace checklist.'}`, firstIssue?.field === 'post' || firstIssue?.field === 'title' ? 'story' : 'resources');
        return;
      }

      resourceBundle = resourceBundleDraft ?? undefined;
    }

    try {
      setIsSubmitting(true);

      if (generationId) {
        const response = await fetch('/api/showcase/publish', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
            body: JSON.stringify({
            generationId,
            visibility: effectiveVisibility,
            title: title.trim() || undefined,
            description: description.trim() || undefined,
            body: trimmedBody || undefined,
            category: inferredCategory ?? undefined,
            sourceTools: sourceToolsForSubmit.length > 0 ? sourceToolsForSubmit : undefined,
            resourceBundle: resourceBundle ?? { accessMode: 'none' },
          }),
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw getSubmissionError(data, 'Failed to publish post.');
        }

        completePublish({
          postId: data.postId as string,
          showcasePath: (data.showcasePath as string | null) ?? null,
          ownerPath: (data.ownerPath as string | null) ?? `/post/${data.postId as string}/edit`,
          resourceBundlePath: (data.resourceBundlePath as string | null) ?? null,
          visibility: data.visibility as PostVisibility,
          resourceAccessMode,
          resourceBundleStatus: data.resourceBundleStatus === 'draft' || data.resourceBundleStatus === 'published'
            ? data.resourceBundleStatus
            : null,
        }, { redirect: true });

        return;
      }

      if (isEditMode && initialPost) {
        const response = await fetch(`/api/posts/${initialPost.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            title: title.trim() || null,
            description: description.trim() || null,
            body: trimmedBody || null,
            sourceTools: sourceToolsForSubmit.length > 0 ? sourceToolsForSubmit : undefined,
            visibility: effectiveVisibility,
            category: inferredCategory ?? undefined,
            resourceBundle: resourceBundle ?? { accessMode: 'none' },
          }),
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
          throw getSubmissionError(data, 'Failed to save post.');
        }

        completePublish({
          postId: data.postId as string,
          showcasePath: (data.showcasePath as string | null) ?? null,
          ownerPath: (data.ownerPath as string | null) ?? `/post/${data.postId as string}/edit`,
          resourceBundlePath: (data.resourceBundlePath as string | null) ?? null,
          visibility: data.visibility as PostVisibility,
          resourceAccessMode,
          resourceBundleStatus: data.resourceBundleStatus === 'draft' || data.resourceBundleStatus === 'published'
            ? data.resourceBundleStatus
            : null,
        });

        return;
      }

      const formData = new FormData();
      formData.set('title', title);
      formData.set('description', description);
      formData.set('body', body);
      if (primarySourceTool.label) {
        formData.set('sourceTool', primarySourceTool.label);
      }
      if (primarySourceTool.slug) {
        formData.set('sourceToolSlug', primarySourceTool.slug);
      }
      if (sourceToolsForSubmit.length > 0) {
        formData.set('sourceTools', JSON.stringify(sourceToolsForSubmit));
      }
      formData.set('visibility', effectiveVisibility);
      formData.set('postFormat', postFormat);
      formData.set('resourceBundle', JSON.stringify(resourceBundle ?? { accessMode: 'none' }));

      if (hasMediaProof && file) {
        const uploadedMedia = await uploadMediaToTemporaryStorage(file, session.user.id);
        formData.set('mediaStoragePath', uploadedMedia.storagePath);
        formData.set('mediaContentType', file.type);
        formData.set('mediaOriginalName', file.name);
        formData.set('category', inferredCategory ?? 'image');
      } else if (proofMode === 'text') {
        formData.set('category', 'text');
      }

      const response = await fetch('/api/posts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      });
      const data = await response.json();

      if (!response.ok) {
        throw getSubmissionError(data, 'Failed to publish post.');
      }

      completePublish({
        postId: data.postId as string,
        showcasePath: (data.showcasePath as string | null) ?? null,
        ownerPath: (data.ownerPath as string | null) ?? `/post/${data.postId as string}/edit`,
        resourceBundlePath: (data.resourceBundlePath as string | null) ?? null,
        visibility: data.visibility as PostVisibility,
        resourceAccessMode,
        resourceBundleStatus: data.resourceBundleStatus === 'draft' || data.resourceBundleStatus === 'published'
          ? data.resourceBundleStatus
          : null,
      }, { redirect: true });
    } catch (submitError) {
      setError({
        section: submitError instanceof ComposerSubmissionError ? submitError.section : 'publish',
        message: submitError instanceof Error ? submitError.message : 'Failed to publish post.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const createdPostHasResources = createdPost ? createdPost.resourceAccessMode !== 'none' : false;
  const primaryPostPath = createdPost?.showcasePath ?? createdPost?.ownerPath ?? null;
  const primaryPostLabel = createdPost?.resourceBundleStatus === 'draft'
    ? 'Continue editing'
    : createdPost?.showcasePath
      ? 'View post'
      : 'Open editor';
  const isEditingUnlisted = isEditMode && displayVisibility === 'unlisted';
  const backHref = isEditMode || entrySurface === 'creations' ? '/creations' : '/showcase';
  const backLabel = isEditMode || entrySurface === 'creations' ? 'Back to studio' : 'Back to community';

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute left-[-10%] top-[-8%] h-[40%] w-[32%] rounded-full bg-sky-500/12 blur-[140px]" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[36%] w-[30%] rounded-full bg-emerald-500/10 blur-[160px]" />
      </div>

      {!createdPost ? (
        <div className="fixed inset-x-4 bottom-4 z-40 lg:hidden">
          {isEditingUnlisted ? (
            <div className="flex items-center justify-between gap-3 rounded-[24px] border border-white/10 bg-zinc-950/95 p-3 shadow-[0_20px_70px_rgba(0,0,0,0.55)] backdrop-blur-xl">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                  Unlisted post
                </div>
                <div className="mt-1 truncate text-sm font-semibold text-white">
                  Shareable by link only
                </div>
              </div>
              <button
                type="submit"
                form="post-composer-form"
                disabled={isSubmitting || isLoadingGeneration}
                onClick={() => submitWithVisibility('unlisted')}
                className="inline-flex shrink-0 items-center gap-2 rounded-full bg-sky-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save unlisted
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-[24px] border border-white/10 bg-zinc-950/95 p-3 shadow-[0_20px_70px_rgba(0,0,0,0.55)] backdrop-blur-xl">
              <button
                type="submit"
                form="post-composer-form"
                disabled={isSubmitting || isLoadingGeneration}
                onClick={() => submitWithVisibility('private')}
                className="inline-flex flex-1 shrink-0 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save private
              </button>
              <button
                type="submit"
                form="post-composer-form"
                disabled={isSubmitting || isLoadingGeneration}
                onClick={() => submitWithVisibility('public')}
                className="inline-flex flex-1 shrink-0 items-center justify-center gap-2 rounded-full bg-sky-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgePlus className="h-4 w-4" />}
                Publish public
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div className="studio-shell relative z-10 py-12 sm:py-16">
        <Link
          href={backHref}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          {backLabel}
        </Link>

        <div className="mt-10 grid gap-8 xl:grid-cols-[minmax(0,1fr)_280px]">
          <section className="rounded-[32px] border border-white/8 bg-zinc-950/70 p-5 shadow-[0_28px_80px_rgba(0,0,0,0.45)] backdrop-blur-sm sm:p-6">
            <div className="mb-6">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                {isCreationPaywallManagementIntent
                  ? 'Manage the unlock behind this post'
                  : isEditMode
                    ? 'Update post'
                    : 'Create post'}
              </h1>
              <p className="mt-2 text-sm text-zinc-400">
                {isCreationPaywallManagementIntent
                  ? 'Adjust post settings, pricing, and visibility below.'
                  : isGeneratedPaywallIntent
                    ? 'Your media is attached. Complete the optional unlock details below.'
                    : isEditMode
                      ? 'Edit post content, visibility, and unlock settings.'
                      : 'Share your work and add optional unlockable resources.'}
              </p>
            </div>

            <form id="post-composer-form" ref={formRef} className="space-y-6 pb-28 lg:pb-0" onSubmit={handleSubmit}>
              {initialPost?.archivedAt ? (
                <div className="rounded-[24px] border border-amber-400/20 bg-amber-500/10 px-5 py-4 text-sm leading-6 text-amber-50">
                  This post is archived. It stays out of public surfaces until you restore it from My Studio.
                </div>
              ) : null}

              <div
                ref={postSectionRef}
                tabIndex={-1}
                data-composer-section="post"
                className="rounded-3xl border border-white/8 bg-[linear-gradient(180deg,rgba(17,24,39,0.82),rgba(9,11,16,0.9))] p-5 outline-none sm:p-6"
              >
                <label className="block">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Title</div>
                  <input
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      resetFeedback();
                    }}
                    placeholder={proofMode === 'text' ? 'Title (optional)' : 'Give your post a title'}
                    className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                  />
                </label>

                {proofMode === 'media' ? (
                  <div className="mt-5 rounded-[24px] border border-sky-300/15 bg-sky-400/5 p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-100/75">Made With</div>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">
                          Add the tool and model you used.{hasGeneratedProof ? ' magicbooklet is already set.' : ''}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 space-y-3">
                      {madeWithRows.map((row, index) => {
                        const selectedTool = sourceToolsData.find((t) =>
                          row.toolSlug ? t.slug === row.toolSlug : t.label === row.toolLabel
                        );
                        const provisionalToolRows = madeWithRows.filter((candidate) => candidate.createTool);
                        const toolOptions: CreatableComboboxOption[] = [
                          ...sourceToolsData.map((tool) => ({
                            value: tool.slug,
                            label: tool.label,
                          })),
                          ...provisionalToolRows
                            .filter((candidate, candidateIndex, candidates) => (
                              candidates.findIndex((item) => item.toolSlug === candidate.toolSlug) === candidateIndex
                              && !sourceToolsData.some((tool) => tool.slug === candidate.toolSlug)
                            ))
                            .map((candidate) => ({
                              value: candidate.toolSlug,
                              label: candidate.toolLabel,
                              provisional: true,
                            })),
                        ];
                        const catalogModels = selectedTool?.models ?? [];
                        const provisionalModelRows = madeWithRows.filter((candidate) => (
                          candidate.toolSlug === row.toolSlug
                          && candidate.createModel
                          && candidate.modelLabel
                        ));
                        const modelOptions: CreatableComboboxOption[] = [
                          ...catalogModels.map((model) => ({
                            value: model.slug,
                            label: model.label,
                          })),
                          ...provisionalModelRows
                            .filter((candidate, candidateIndex, candidates) => (
                              candidates.findIndex((item) => item.modelSlug === candidate.modelSlug) === candidateIndex
                              && !catalogModels.some((model) => model.slug === candidate.modelSlug)
                            ))
                            .map((candidate) => ({
                              value: candidate.modelSlug,
                              label: candidate.modelLabel,
                              provisional: true,
                            })),
                        ];
                        const toolIsCatalogEntry = Boolean(selectedTool);
                        const modelIsCatalogEntry = Boolean(catalogModels.some((model) => model.slug === row.modelSlug));

                        return (
                          <div key={row.id} className="flex flex-wrap items-center gap-2">
                            <CreatableCombobox
                              ariaLabel={`Tool ${index + 1}`}
                              value={row.toolLabel}
                              options={toolOptions}
                              placeholder="Choose or search tool"
                              disabled={hasGeneratedProof}
                              allowCustomEdit={!toolIsCatalogEntry && !row.createTool}
                              onSelect={(option) => {
                                if (!option) {
                                  updateMadeWithRow(row.id, {
                                    toolLabel: '',
                                    toolSlug: '',
                                    modelLabel: '',
                                    modelSlug: '',
                                    createTool: false,
                                    createModel: false,
                                  });
                                  return;
                                }
                                updateMadeWithRow(row.id, {
                                  toolLabel: option.label,
                                  toolSlug: option.value,
                                  modelLabel: '',
                                  modelSlug: '',
                                  createTool: option.provisional === true,
                                  createModel: false,
                                });
                              }}
                              onCreate={(label) => {
                                updateMadeWithRow(row.id, {
                                  toolLabel: label,
                                  toolSlug: slugifySourceTool(label) ?? '',
                                  modelLabel: '',
                                  modelSlug: '',
                                  createTool: true,
                                  createModel: false,
                                });
                              }}
                              onCustomEdit={(label) => {
                                updateMadeWithRow(row.id, {
                                  toolLabel: label,
                                  toolSlug: slugifySourceTool(label) ?? '',
                                  createTool: false,
                                });
                              }}
                            />
                            <CreatableCombobox
                              ariaLabel={`Model for ${row.toolLabel || `tool ${index + 1}`}`}
                              value={row.modelLabel}
                              options={modelOptions}
                              placeholder="Any model"
                              emptyOptionLabel="Any model"
                              disabled={hasGeneratedProof || !row.toolLabel}
                              allowCustomEdit={Boolean(row.modelLabel && !modelIsCatalogEntry && !row.createModel)}
                              onSelect={(option) => {
                                updateMadeWithRow(row.id, {
                                  modelLabel: option?.label ?? '',
                                  modelSlug: option?.value ?? '',
                                  createModel: option?.provisional === true,
                                });
                              }}
                              onCreate={(label) => {
                                updateMadeWithRow(row.id, {
                                  modelLabel: label,
                                  modelSlug: slugifySourceTool(label) ?? '',
                                  createModel: true,
                                });
                              }}
                              onCustomEdit={(label) => {
                                updateMadeWithRow(row.id, {
                                  modelLabel: label,
                                  modelSlug: slugifySourceTool(label) ?? '',
                                  createModel: false,
                                });
                              }}
                            />
                            {!hasGeneratedProof && madeWithRows.length > 1 ? (
                              <button
                                type="button"
                                onClick={() => removeMadeWithRow(row.id)}
                                className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
                                aria-label={`Remove tool ${index + 1}`}
                              >
                                <X className="h-4 w-4" />
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                      {!hasGeneratedProof && madeWithRows.length < 5 ? (
                        <button
                          type="button"
                          onClick={addMadeWithRow}
                          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                        >
                          <Plus className="h-4 w-4" />
                          Add another tool
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {renderSectionError('post')}

                <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-t border-white/8 pt-5">
                  <div>
                    <h2 className="text-xl font-semibold text-white">Proof</h2>
                    <p className="mt-1 text-xs text-zinc-400">
                      {isEditMode || hasGeneratedProof
                        ? 'Attached media is locked in.'
                        : 'Share a result via image/video, or publish a text-only tip.'}
                    </p>
                  </div>
                  {!hasGeneratedProof && !isEditMode ? (
                    <div className="inline-flex rounded-full border border-white/10 bg-black/30 p-1">
                      <button
                        type="button"
                        onClick={() => {
                          setProofMode('media');
                          resetFeedback();
                        }}
                        className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                          proofMode === 'media'
                            ? 'bg-sky-300 text-slate-950'
                            : 'text-zinc-300 hover:text-white'
                        }`}
                      >
                        Media
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setProofMode('text');
                          setFile(null);
                          resetFeedback();
                        }}
                        className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                          proofMode === 'text'
                            ? 'bg-sky-300 text-slate-950'
                            : 'text-zinc-300 hover:text-white'
                        }`}
                      >
                        Text
                      </button>
                    </div>
                  ) : (
                    <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-medium text-zinc-300">
                      {stepBadgeLabel}
                    </div>
                  )}
                </div>

                {proofMode === 'media' ? (
                  <div className="mt-5">
                    {hasGeneratedProof ? (
                      <div className="rounded-[28px] border border-white/10 bg-white/[0.02] p-5">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Generated media</div>
                            <div className="mt-2 text-lg font-semibold text-white">
                              {prefilledGeneration?.title || 'magicbooklet creation'}
                            </div>
                            <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-300">
                              Created in magicbooklet with {prefilledGeneration?.model || 'your latest model'}.
                            </p>
                          </div>
                          <div className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-50">
                            Attached automatically
                          </div>
                        </div>

                        <div className="mt-5 rounded-[24px] border border-white/8 bg-black/50 p-3">
                          {isLoadingGeneration ? (
                            <div className="flex min-h-[320px] items-center justify-center">
                              <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
                            </div>
                          ) : prefilledGeneration?.outputUrl ? (
                            category === 'video' || category === 'motion' ? (
                              <video
                                src={prefilledGeneration.outputUrl}
                                controls
                                playsInline
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={prefilledGeneration.outputUrl}
                                alt={title || 'Generated preview'}
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            )
                          ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-[18px] border border-dashed border-white/10 bg-zinc-950/60 text-center">
                              <Sparkles className="h-10 w-10 text-zinc-500" />
                              <p className="mt-4 max-w-sm text-sm leading-6 text-zinc-400">
                                The generation is attached, but the preview could not be loaded here.
                              </p>
                            </div>
                          )}
                        </div>

                        {generationError ? (
                          <div className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                            {generationError}
                          </div>
                        ) : null}
                      </div>
                    ) : existingProofUrl ? (
                      <div className="rounded-[28px] border border-white/10 bg-white/[0.02] p-5">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Attached media</div>
                            <div className="mt-2 text-lg font-semibold text-white">
                              {title.trim() || 'Existing post media'}
                            </div>
                            <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-300">
                              This media is already saved on the post. Use the sections below to update the story or the unlock around it.
                            </p>
                          </div>
                          <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-200">
                            Media locked in
                          </div>
                        </div>

                        <div className="mt-5 rounded-[24px] border border-white/8 bg-black/50 p-3">
                          {category === 'video' || category === 'motion' ? (
                            <video
                              src={existingProofUrl}
                              controls
                              playsInline
                              className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                            />
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={existingProofUrl}
                              alt={title || 'Saved post preview'}
                              className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                            />
                          )}
                        </div>
                      </div>
                    ) : (
                      <div
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        className={`rounded-3xl border border-dashed p-5 transition duration-200 ${
                          isDragging
                            ? 'border-sky-400 bg-sky-400/5'
                            : 'border-white/14 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.03]'
                        }`}
                      >
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-center gap-4">
                            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-400/10 text-sky-100">
                              <UploadCloud className="h-6 w-6" />
                            </div>
                            <div>
                              <div className="text-sm font-semibold text-white">Upload image or video</div>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => mediaInputRef.current?.click()}
                            className="inline-flex items-center justify-center gap-2 rounded-full bg-sky-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-200"
                          >
                            <BadgePlus className="h-4 w-4" />
                            Add media
                          </button>
                        </div>

                        <input
                          ref={mediaInputRef}
                          type="file"
                          accept="image/*,video/*"
                          className="sr-only"
                          onChange={(event) => {
                            const nextFile = event.target.files?.[0] ?? null;
                            setFile(nextFile);
                            resetFeedback();
                          }}
                        />

                        <div className="mt-5 rounded-[24px] border border-white/8 bg-black/50 p-3">
                          {previewUrl ? (
                            file?.type.startsWith('video/') ? (
                              <video
                                src={previewUrl}
                                controls
                                playsInline
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={previewUrl}
                                alt={title || 'Uploaded preview'}
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            )
                          ) : (
                            <div
                              onClick={handleMiddleClick}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  handleMiddleClick();
                                }
                              }}
                              role="button"
                              tabIndex={0}
                              className={`flex min-h-[320px] cursor-pointer flex-col items-center justify-center rounded-[18px] border border-dashed text-center outline-none transition duration-200 ${
                                isDragging
                                  ? 'border-sky-400 bg-sky-400/10 text-sky-200 scale-[0.99]'
                                  : 'border-white/10 bg-zinc-950/60 text-zinc-400 hover:border-white/20 hover:bg-zinc-950/80 hover:text-zinc-300'
                              }`}
                            >
                              {inferredCategory === 'video' ? (
                                <Film className="h-10 w-10 text-zinc-500" />
                              ) : (
                                <ImageIcon className="h-10 w-10 text-zinc-500" />
                              )}
                              <p className="mt-3 text-sm text-zinc-400 font-medium">
                                Drag & drop file, or click to upload
                              </p>
                              <p className="mt-1.5 text-xs text-zinc-500">JPG, PNG, MP4, MOV</p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-5 rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.14),transparent_34%),linear-gradient(180deg,rgba(20,20,24,0.96),rgba(10,10,14,0.96))] p-5">
                    <div className="flex items-center gap-4">
                      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-400/10 text-sky-100">
                        <BookText className="h-6 w-6" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-white">This will be a text post</div>
                        <p className="mt-1 text-xs text-zinc-400">
                          Write your tip or guide in the story section below.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div
                ref={storySectionRef}
                tabIndex={-1}
                data-composer-section="story"
                className="rounded-3xl border border-white/8 bg-black/20 p-5 outline-none"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Story</h2>
                    <p className="mt-1 text-xs text-zinc-400">
                      The public content visible in the community feed.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsDetailsOpen((current) => !current)}
                    className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                  >
                    {isDetailsOpen ? 'Hide description' : 'Add feed description'}
                  </button>
                </div>

                {renderSectionError('story')}

                <label className="mt-5 block">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                      {proofMode === 'text' ? 'Post body' : 'Caption'}
                    </span>
                    <span className={`text-xs ${bodyCount > BODY_MAX_LENGTH ? 'text-rose-300' : 'text-zinc-500'}`}>
                      {bodyCount}/{BODY_MAX_LENGTH}
                    </span>
                  </div>
                  <textarea
                    value={body}
                    onChange={(event) => {
                      setBody(event.target.value);
                      resetFeedback();
                    }}
                    placeholder={
                      proofMode === 'text'
                        ? 'Write the post content...'
                        : 'Write an optional caption...'
                    }
                    rows={proofMode === 'text' ? 8 : 6}
                    className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                  />
                </label>

                {isDetailsOpen ? (
                  <label className="mt-5 block">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Feed description</div>
                    <textarea
                      value={description}
                      onChange={(event) => {
                        setDescription(event.target.value);
                        resetFeedback();
                      }}
                      placeholder="Optional: give the post a short one-line setup for feeds and previews."
                      rows={3}
                      className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                    />
                  </label>
                ) : null}
              </div>

              <div
                id="resources"
                ref={resourceSectionRef}
                tabIndex={-1}
                data-composer-section="resources"
                className="rounded-3xl border border-emerald-500/15 bg-emerald-500/5 p-5 outline-none"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Unlock</h2>
                    <p className="mt-1 text-xs text-zinc-400">
                      Add optional gated resources (prompts, files, notes, or remix access) to this post.
                    </p>
                  </div>
                  <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-medium text-zinc-300">
                    {resourceAccessMode === 'none' ? 'No unlock' : resourceAccessMode === 'free' ? 'Free unlock' : 'Paid unlock'}
                  </div>
                </div>

                {isGeneratedPaywallIntent ? (
                  <div className="mt-5 rounded-[24px] border border-emerald-300/18 bg-black/30 p-4 text-sm leading-6 text-zinc-200">
                    {isLoadingGeneration
                      ? 'Preparing the saved prompt and generation setup for this paid unlock.'
                      : hasGenerationPaywallPrefill
                        ? 'Saved prompt, reusable setup notes, and remix access are ready where this creation supports them. Set the price first, then publish or edit anything below.'
                        : 'This creation does not have enough saved inputs to auto-fill a paid unlock yet. The media is still attached, and you can add the prompt, notes, or remix access manually below.'}
                  </div>
                ) : isCreationPaywallManagementIntent ? (
                  <div className="mt-5 rounded-[24px] border border-emerald-300/18 bg-black/30 p-4 text-sm leading-6 text-zinc-200">
                    You came from My Studio to manage this post&apos;s unlock. The unlock mode is ready here, and the price field is focused so you can adjust the paid layer quickly.
                  </div>
                ) : null}

                {resourceAccessMode !== 'none' && displayVisibility !== 'public' ? (
                  <div className="mt-4 rounded-[24px] border border-white/8 bg-black/25 px-4 py-3 text-sm text-zinc-200">
                    This unlock will save as a draft until the post is public.
                  </div>
                ) : null}

                {renderSectionError('resources')}

                <label className="mt-4 flex items-center gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={resourceAccessMode !== 'none'}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      if (checked) {
                        setResourceAccessMode('free');
                        setResourceSelections((prev) => {
                          const hasAny = Object.values(prev).some(Boolean);
                          return hasAny ? prev : { ...prev, prompt: true };
                        });
                      } else {
                        setResourceAccessMode('none');
                      }
                      resetFeedback();
                    }}
                    className="h-4 w-4 rounded border-white/10 bg-white/[0.03] text-emerald-400 focus:ring-0 focus:ring-offset-0"
                  />
                  <span className="text-sm font-semibold text-white">Add references & unlockable resources</span>
                </label>

                {resourceAccessMode !== 'none' && (
                  <div className="mt-5 space-y-5">
                    <div className="rounded-[24px] border border-white/8 bg-black/25 p-4 space-y-4">
                      {/* Access Mode and Pricing */}
                      <div className="flex flex-wrap items-center gap-4 sm:justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Access Mode:</span>
                          <div className="inline-flex rounded-full border border-white/10 bg-black/30 p-1">
                            {([
                              { value: 'free', label: 'Free' },
                              { value: 'paid', label: 'Paid ($)' }
                            ] as const).map((mode) => {
                              const active = (resourceAccessMode === 'paid' ? 'paid' : 'free') === mode.value;
                              return (
                                <button
                                  key={mode.value}
                                  type="button"
                                  onClick={() => {
                                    setResourceAccessMode(mode.value);
                                    resetFeedback();
                                  }}
                                  className={`rounded-full px-4 py-1 text-xs font-semibold transition ${
                                    active
                                      ? 'bg-emerald-300 text-emerald-950'
                                      : 'text-zinc-300 hover:text-white'
                                  }`}
                                >
                                  {mode.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {resourceAccessMode === 'paid' ? (
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Price:</span>
                            <div className="relative inline-flex items-center">
                              <span className="absolute left-3 text-xs text-zinc-500">$</span>
                              <input
                                ref={priceInputRef}
                                type="text"
                                aria-label="Price"
                                placeholder="9"
                                value={resourcePriceUsd}
                                onChange={(event) => {
                                  setResourcePriceUsd(event.target.value);
                                  resetFeedback();
                                }}
                                className="w-20 rounded-full border border-white/10 bg-white/[0.03] pl-6 pr-3 py-1 text-center text-xs font-semibold text-white outline-none focus:border-emerald-300/40"
                              />
                            </div>
                          </div>
                        ) : null}
                      </div>

                      {/* Resource Kind Selection */}
                      <div className="border-t border-white/5 pt-4">
                        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500 mb-3">Resource Types to Include</div>
                        <div className="flex flex-wrap gap-2">
                          {RESOURCE_KIND_OPTIONS.map((option) => {
                            const active = resourceSelections[option.value];

                            return (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => updateResourceSelection(option.value)}
                                title={option.description}
                                className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm font-semibold transition ${
                                  active
                                    ? 'border-emerald-300/35 bg-emerald-400/15 text-emerald-50'
                                    : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:border-white/20 hover:bg-white/[0.06] hover:text-white'
                                }`}
                              >
                                {active ? <Check className="h-4 w-4 text-emerald-200" /> : null}
                                {option.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Section Layout Option */}
                      <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-4">
                        <span className="text-xs text-zinc-500">Need section-based structure?</span>
                        <button
                          type="button"
                          onClick={() => {
                            const nextValue = !organizeResourceSections;
                            setOrganizeResourceSections(nextValue);
                            if (nextValue && resourceSectionRows.length === 0) {
                              setResourceSectionRows([createResourceSectionRow()]);
                            }
                            resetFeedback();
                          }}
                          className="text-xs font-semibold text-emerald-300 hover:text-emerald-200 transition"
                        >
                          {organizeResourceSections ? 'Remove section layout' : 'Enable section layout'}
                        </button>
                      </div>
                    </div>

                    {resourceSelections.prompt ? (
                      <label className="block">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Prompt</div>
                        <textarea
                          value={resourcePromptText}
                          onChange={(event) => {
                            setResourcePromptTouched(true);
                            setResourcePromptText(event.target.value);
                            resetFeedback();
                          }}
                          rows={6}
                          placeholder="Paste the exact prompt people should unlock."
                          className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                        />
                      </label>
                    ) : null}

                    {resourceSelections.notes ? (
                      <label className="block">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Notes</div>
                        <textarea
                          value={resourceNotes}
                          onChange={(event) => {
                            setResourceNotesTouched(true);
                            setResourceNotes(event.target.value);
                            resetFeedback();
                          }}
                          rows={6}
                          placeholder="Add the steps, settings, or instructions that make this reusable."
                          className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                        />
                      </label>
                    ) : null}

                    {resourceSelections.workflow ? (
                      <label className="block">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Workflow / setup link</div>
                        <input
                          value={resourceWorkflowUrl}
                          onChange={(event) => {
                            setResourceWorkflowUrl(event.target.value);
                            resetFeedback();
                          }}
                          placeholder="https://..."
                          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                        />
                      </label>
                    ) : null}

                    {resourceSelections.files ? (
                      <div className="rounded-[24px] border border-white/8 bg-black/30 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Files / links</div>
                            <p className="mt-1 text-sm leading-6 text-zinc-400">
                              Add gated workflow files or labeled links people should open after unlocking. Resource file uploads must be 50MB or smaller.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={addAttachmentRow}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                          >
                            <Plus className="h-4 w-4" />
                            Add link
                          </button>
                        </div>

                        <div className="mt-4 space-y-3">
                          {resourceAttachmentRows.map((row, index) => (
                            <div key={row.id} className="grid gap-3 rounded-[20px] border border-white/8 bg-white/[0.03] p-3 md:grid-cols-[minmax(0,180px)_1fr_auto]">
                              <input
                                value={row.label}
                                onChange={(event) => updateAttachmentRow(row.id, 'label', event.target.value)}
                                placeholder={`Label ${index + 1}`}
                                className="rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-black/45"
                              />
                              <div className="grid gap-2">
                                <div className="grid gap-2 sm:grid-cols-3">
                                  <label>
                                    <span className="sr-only">Resource type</span>
                                    <select
                                      value={row.resourceType}
                                      onChange={(event) => updateAttachmentRow(row.id, 'resourceType', event.target.value)}
                                      className="w-full rounded-2xl border border-white/10 bg-black/35 px-3 py-2.5 text-xs font-medium text-white outline-none transition focus:border-emerald-400/35"
                                    >
                                      {RESOURCE_ITEM_TYPE_OPTIONS.map((option) => (
                                        <option key={option.value} value={option.value} className="bg-zinc-950 text-white">
                                          {option.label}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <label>
                                    <span className="sr-only">Resource role</span>
                                    <select
                                      value={row.role}
                                      onChange={(event) => updateAttachmentRow(row.id, 'role', event.target.value)}
                                      className="w-full rounded-2xl border border-white/10 bg-black/35 px-3 py-2.5 text-xs font-medium text-white outline-none transition focus:border-emerald-400/35"
                                    >
                                      {RESOURCE_ITEM_ROLE_OPTIONS.map((option) => (
                                        <option key={option.value} value={option.value} className="bg-zinc-950 text-white">
                                          {option.label}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <label>
                                    <span className="sr-only">Reuse mode</span>
                                    <select
                                      value={row.remixUse}
                                      onChange={(event) => updateAttachmentRow(row.id, 'remixUse', event.target.value)}
                                      className="w-full rounded-2xl border border-white/10 bg-black/35 px-3 py-2.5 text-xs font-medium text-white outline-none transition focus:border-emerald-400/35"
                                    >
                                      <option value="none" className="bg-zinc-950 text-white">Download/use</option>
                                      <option value="reference_only" className="bg-zinc-950 text-white">Use as reference</option>
                                      <option value="import_source" className="bg-zinc-950 text-white">Import source</option>
                                    </select>
                                  </label>
                                </div>
                                <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                                {row.kind === 'file' && row.storagePath ? (
                                  <div className="rounded-2xl border border-emerald-300/15 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-50">
                                    {row.label || row.storagePath}
                                    {row.sizeBytes ? (
                                      <span className="ml-2 text-xs text-emerald-50/65">{Math.ceil(row.sizeBytes / 1024)} KB</span>
                                    ) : null}
                                  </div>
                                ) : (
                                  <input
                                    value={row.url}
                                    onChange={(event) => updateAttachmentRow(row.id, 'url', event.target.value)}
                                    placeholder="https://..."
                                    className="rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-black/45"
                                  />
                                )}
                                <label className="inline-flex cursor-pointer items-center justify-center rounded-2xl border border-white/10 bg-black/35 px-3 py-3 text-sm font-medium text-zinc-200 transition hover:bg-black/45 hover:text-white">
                                  {row.isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Upload file'}
                                  <input
                                    type="file"
                                    className="sr-only"
                                    disabled={row.isUploading}
                                    onChange={(event) => {
                                      void handleAttachmentFileUpload(row.id, event.target.files?.[0] ?? null);
                                      event.target.value = '';
                                    }}
                                  />
                                </label>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => removeAttachmentRow(row.id)}
                                className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-black/35 px-3 py-3 text-zinc-300 transition hover:bg-black/45 hover:text-white"
                                aria-label={`Remove link ${index + 1}`}
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {resourceSelections.remix ? (
                      <div className="rounded-[24px] border border-white/8 bg-black/30 p-4">
                        <div className="text-sm font-semibold text-white">Remix access is included in this unlock</div>
                        <p className="mt-1 text-sm leading-6 text-zinc-400">
                          People will need to open this unlock before remixing this post.
                        </p>
                      </div>
                    ) : null}

                    {organizeResourceSections ? (
                      <div className="rounded-[24px] border border-emerald-300/18 bg-black/30 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-100/75">Resource sections</div>
                            <p className="mt-2 text-sm leading-6 text-zinc-400">
                              Full post resources stay above. Add sections only for grouped prompts, references, workflows, or notes.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={addResourceSection}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                          >
                            <Plus className="h-4 w-4" />
                            Add section
                          </button>
                        </div>

                        <div className="mt-4 rounded-[20px] border border-white/8 bg-white/[0.025] p-3">
                          <div className="text-sm font-semibold text-white">Full post resources</div>
                          <p className="mt-1 text-xs leading-5 text-zinc-500">
                            Anything entered in the prompt, workflow, files, notes, or remix controls above applies to the whole post.
                          </p>
                        </div>

                        <div className="mt-4 space-y-4">
                          {resourceSectionRows.map((section, sectionIndex) => (
                            <div key={section.id} className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4">
                              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                <div className="grid flex-1 gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
                                  <label className="block">
                                    <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                      Section title {sectionIndex + 1}
                                    </span>
                                    <input
                                      aria-label={`Section title ${sectionIndex + 1}`}
                                      value={section.title}
                                      onChange={(event) => updateResourceSection(section.id, 'title', event.target.value)}
                                      placeholder="Hook, Look 1, Step 3..."
                                      className="w-full rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-black/45"
                                    />
                                  </label>
                                  <label className="block">
                                    <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                      Section kind {sectionIndex + 1}
                                    </span>
                                    <select
                                      aria-label={`Section kind ${sectionIndex + 1}`}
                                      value={section.kind}
                                      onChange={(event) => updateResourceSection(section.id, 'kind', event.target.value as PostResourceSectionKind)}
                                      className="w-full rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35"
                                    >
                                      {RESOURCE_SECTION_KIND_OPTIONS.map((option) => (
                                        <option key={option.value} value={option.value} className="bg-zinc-950 text-white">
                                          {option.label}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                </div>

                                <div className="flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={() => applySectionToFullPost(section.id)}
                                    className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
                                  >
                                    Apply to full post
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => duplicateResourceSection(section.id)}
                                    className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
                                  >
                                    Duplicate section
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => removeResourceSection(section.id)}
                                    className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>

                              <label className="mt-3 block">
                                <span className="sr-only">Section description {sectionIndex + 1}</span>
                                <input
                                  aria-label={`Section description ${sectionIndex + 1}`}
                                  value={section.description}
                                  onChange={(event) => updateResourceSection(section.id, 'description', event.target.value)}
                                  placeholder="Optional section description"
                                  className="w-full rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-black/45"
                                />
                              </label>

                              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                                <label className="block">
                                  <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                    Section prompt {sectionIndex + 1}
                                  </span>
                                  <textarea
                                    aria-label={`Section prompt ${sectionIndex + 1}`}
                                    value={section.promptText}
                                    onChange={(event) => updateResourceSection(section.id, 'promptText', event.target.value)}
                                    rows={4}
                                    placeholder="Prompt for this section."
                                    className="w-full rounded-[20px] border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-black/45"
                                  />
                                </label>
                                <label className="block">
                                  <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                    Section notes {sectionIndex + 1}
                                  </span>
                                  <textarea
                                    aria-label={`Section notes ${sectionIndex + 1}`}
                                    value={section.notesMarkdown}
                                    onChange={(event) => updateResourceSection(section.id, 'notesMarkdown', event.target.value)}
                                    rows={4}
                                    placeholder="Settings, direction, or usage notes for this section."
                                    className="w-full rounded-[20px] border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-black/45"
                                  />
                                </label>
                              </div>

                              <label className="mt-3 block">
                                <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                  Section workflow link {sectionIndex + 1}
                                </span>
                                <input
                                  aria-label={`Section workflow link ${sectionIndex + 1}`}
                                  value={section.workflowShareUrl}
                                  onChange={(event) => updateResourceSection(section.id, 'workflowShareUrl', event.target.value)}
                                  placeholder="https://..."
                                  className="w-full rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-black/45"
                                />
                              </label>

                              <div className="mt-3 rounded-[18px] border border-white/8 bg-black/25 p-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                    Section files / links
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => addSectionAttachmentRow(section.id)}
                                    className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
                                  >
                                    Add link
                                  </button>
                                </div>
                                <div className="mt-3 space-y-2">
                                  {section.attachments.map((attachment, attachmentIndex) => (
                                    <div key={attachment.id} className="grid gap-2 md:grid-cols-[150px_1fr_140px_auto]">
                                      <input
                                        value={attachment.label}
                                        onChange={(event) => updateSectionAttachmentRow(section.id, attachment.id, 'label', event.target.value)}
                                        placeholder={`Label ${attachmentIndex + 1}`}
                                        className="rounded-2xl border border-white/10 bg-black/35 px-3 py-2.5 text-sm text-white outline-none transition focus:border-emerald-400/35"
                                      />
                                      <input
                                        value={attachment.url}
                                        onChange={(event) => updateSectionAttachmentRow(section.id, attachment.id, 'url', event.target.value)}
                                        placeholder="https://..."
                                        className="rounded-2xl border border-white/10 bg-black/35 px-3 py-2.5 text-sm text-white outline-none transition focus:border-emerald-400/35"
                                      />
                                      <select
                                        value={attachment.resourceType}
                                        onChange={(event) => updateSectionAttachmentRow(section.id, attachment.id, 'resourceType', event.target.value)}
                                        className="rounded-2xl border border-white/10 bg-black/35 px-3 py-2.5 text-xs font-medium text-white outline-none transition focus:border-emerald-400/35"
                                      >
                                        {RESOURCE_ITEM_TYPE_OPTIONS.map((option) => (
                                          <option key={option.value} value={option.value} className="bg-zinc-950 text-white">
                                            {option.label}
                                          </option>
                                        ))}
                                      </select>
                                      <button
                                        type="button"
                                        onClick={() => removeSectionAttachmentRow(section.id, attachment.id)}
                                        className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-black/35 px-3 py-2.5 text-zinc-300 transition hover:bg-black/45 hover:text-white"
                                        aria-label={`Remove section ${sectionIndex + 1} link ${attachmentIndex + 1}`}
                                      >
                                        <X className="h-4 w-4" />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              <label className="mt-3 inline-flex items-center gap-3 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-sm font-medium text-zinc-200">
                                <input
                                  type="checkbox"
                                  checked={section.allowRemix}
                                  onChange={(event) => updateResourceSection(section.id, 'allowRemix', event.target.checked)}
                                  className="h-4 w-4 accent-emerald-300"
                                />
                                Include remix access for this section
                              </label>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {/* Price field has been moved to the top Access Mode area */}
                  </div>
                )}
              </div>

              {createdPost ? (
                <div className="rounded-[28px] border border-emerald-500/20 bg-emerald-500/10 p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="text-sm font-semibold text-white">
                      {isEditMode
                        ? 'Changes saved'
                        : createdPost.resourceBundleStatus === 'draft'
                          ? 'Draft saved with an unlock'
                          : createdPostHasResources
                            ? 'Post published with an unlock'
                            : 'Post published'}
                    </div>
                    <div className="rounded-full border border-emerald-300/20 bg-black/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-50">
                      {createdPost.visibility}
                    </div>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-emerald-50/90">
                    {isEditMode
                      ? createdPost.visibility === 'private'
                        ? 'Your changes are saved in the owner editor. This post is not publicly visible right now.'
                        : 'The post has been updated and the latest version is ready.'
                      : createdPost.resourceBundleStatus === 'draft'
                        ? 'The public post and unlock are saved for you. Make the post public when you are ready to list the unlock.'
                        : createdPostHasResources
                          ? 'The post is public and the unlockable process is ready on the same page.'
                          : createdPost.visibility === 'public'
                            ? 'Your post is live.'
                            : 'Your post is saved with limited visibility.'}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    {primaryPostPath ? (
                      <Link
                        href={primaryPostPath}
                        className="rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
                      >
                        {primaryPostLabel}
                      </Link>
                    ) : null}
                    {createdPostHasResources && createdPost.resourceBundlePath ? (
                      <Link
                        href={createdPost.resourceBundlePath}
                        className="rounded-full border border-emerald-300/30 bg-emerald-400/15 px-4 py-2.5 text-sm font-semibold text-emerald-50 transition hover:border-emerald-200/40 hover:bg-emerald-400/20"
                      >
                        Open unlock section
                      </Link>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div
                ref={publishSectionRef}
                tabIndex={-1}
                data-composer-section="publish"
                className="rounded-3xl border border-white/8 bg-zinc-950/75 p-5 outline-none"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Publish</h2>
                    <p className="mt-1 text-xs text-zinc-400">
                      Choose who can see this post.
                    </p>
                  </div>
                  <div className="shrink-0 rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs font-semibold text-zinc-300">
                    {resourceAccessMode === 'none'
                      ? getVisibilityStatusLabel(displayVisibility)
                      : resourceAccessMode === 'paid'
                        ? `${getVisibilityStatusLabel(displayVisibility)} · paid unlock`
                        : `${getVisibilityStatusLabel(displayVisibility)} · free unlock`}
                  </div>
                </div>

                {renderSectionError('publish')}

                {isEditingUnlisted ? (
                  <div className="mt-5 space-y-4">
                    <div className="rounded-[24px] border border-amber-400/20 bg-amber-500/10 px-5 py-4 text-sm leading-6 text-amber-50">
                      This post is currently <span className="font-semibold">Unlisted</span> — shareable by link only.
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="submit"
                        disabled={isSubmitting || isLoadingGeneration || Boolean(createdPost)}
                        onClick={() => submitWithVisibility('unlisted')}
                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-5 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Save unlisted changes
                      </button>
                      <button
                        type="submit"
                        disabled={isSubmitting || isLoadingGeneration || Boolean(createdPost)}
                        onClick={() => submitWithVisibility('public')}
                        className="inline-flex items-center gap-2 rounded-full bg-sky-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Make public
                      </button>
                      <button
                        type="submit"
                        disabled={isSubmitting || isLoadingGeneration || Boolean(createdPost)}
                        onClick={() => submitWithVisibility('private')}
                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-semibold text-zinc-300 transition hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Make private
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-5">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <button
                        type="button"
                        disabled={isSubmitting || isLoadingGeneration || Boolean(createdPost)}
                        onClick={() => submitWithVisibility('private')}
                        className="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-5 text-left transition hover:border-white/20 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        <div className="text-sm font-semibold text-zinc-200">Save private</div>
                        <p className="mt-1.5 text-xs leading-5 text-zinc-500">Saved privately in Studio.</p>
                      </button>
                      <button
                        type="button"
                        disabled={isSubmitting || isLoadingGeneration || Boolean(createdPost)}
                        onClick={() => submitWithVisibility('public')}
                        className="rounded-2xl bg-sky-300 px-5 py-5 text-left transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        <div className="text-sm font-semibold text-slate-950">Publish public</div>
                        <p className="mt-1.5 text-xs leading-5 text-slate-700">Visible in Feed.</p>
                      </button>
                    </div>
                  </div>
                )}

              </div>
            </form>
          </section>

          <aside aria-label="Publish checklist" className="lg:sticky lg:top-24">
            <div className="rounded-3xl border border-white/8 bg-zinc-900/60 p-5 shadow-[0_20px_50px_rgba(0,0,0,0.28)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Publish checklist</div>
              <div className="mt-4 space-y-3">
                {completionChecklist.map((item) => (
                  <div key={item.label} className="flex items-center gap-3">
                    <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
                      item.complete
                        ? 'border-emerald-300/30 bg-emerald-400/15 text-emerald-100'
                        : 'border-white/10 bg-white/[0.04] text-zinc-500'
                    }`}>
                      {item.complete ? <Check className="h-4 w-4" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white">{item.label}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
