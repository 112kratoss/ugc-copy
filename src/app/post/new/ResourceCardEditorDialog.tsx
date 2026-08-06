'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Loader2, Play, Plus, X } from 'lucide-react';

import {
  createPostComposerResourceCard,
  getPostComposerResourceCardErrors,
  isPostComposerResourceCardReady,
  POST_COMPOSER_RESOURCE_CARD_OPTIONS,
  type PostComposerResourceCardDraft,
  type PostComposerResourceCardType,
} from '@/lib/post-composer-resource-cards';
import type { PostResourceAttachment, PostResourceItemType } from '@/lib/post-resource-bundles';
import { isUploadCancelledError } from '@/lib/upload-queue';

import { getResourceCardTypeLabel, ResourceTypeIcon } from './ResourceCardsSection';

const CARD_TITLE_MAX_LENGTH = 80;
const CARD_PREVIEW_MAX_LENGTH = 120;

type ResourceFileUploadProgress = {
  bytesSent: number;
  totalBytes: number;
  fraction: number;
};

type UploadResourceFile = (
  file: File,
  options?: {
    signal?: AbortSignal;
    onProgress?: (progress: ResourceFileUploadProgress) => void;
  },
) => Promise<PostResourceAttachment>;

const TEXT_TYPES: PostComposerResourceCardType[] = ['prompt', 'settings', 'guide', 'workflow', 'other'];
const LINK_TYPES: PostComposerResourceCardType[] = ['external_link', 'remix_link', 'workflow'];
const FILE_TYPES: PostComposerResourceCardType[] = ['reference_media', 'source_assets', 'workflow', 'other'];
const REFERENCE_MEDIA_CONTENT_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'video/mp4', 'video/x-m4v', 'video/quicktime', 'video/webm',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac',
]);
const REFERENCE_MEDIA_EXTENSION_FAMILY = new Map([
  ['jpg', 'image'], ['jpeg', 'image'], ['png', 'image'], ['webp', 'image'],
  ['gif', 'image'], ['heic', 'image'], ['heif', 'image'],
  ['mp4', 'video'], ['m4v', 'video'], ['mov', 'video'], ['webm', 'video'],
  ['mp3', 'audio'], ['wav', 'audio'], ['m4a', 'audio'], ['aac', 'audio'],
  ['ogg', 'audio'], ['flac', 'audio'],
]);
const REFERENCE_MEDIA_ACCEPT = [
  ...REFERENCE_MEDIA_CONTENT_TYPES,
  ...[...REFERENCE_MEDIA_EXTENSION_FAMILY.keys()].map((extension) => `.${extension}`),
].join(',');
const RESOURCE_FILE_ACCEPT = [
  'application/csv', 'application/json', 'application/pdf', 'application/gzip',
  'application/x-yaml', 'application/x-gzip', 'application/zip',
  'application/x-zip-compressed', 'application/yaml',
  'text/comma-separated-values', 'text/csv', 'text/markdown', 'text/plain',
  'text/x-markdown', 'text/x-yaml', 'text/yaml',
  ...REFERENCE_MEDIA_CONTENT_TYPES,
  '.json', '.txt', '.md', '.markdown', '.csv', '.yaml', '.yml', '.pdf',
  '.zip', '.gz', '.workflow',
  ...[...REFERENCE_MEDIA_EXTENSION_FAMILY.keys()].map((extension) => `.${extension}`),
].join(',');

export interface ResourceScopeMediaOption {
  mediaKey: string;
  label: string;
  previewUrl: string | null;
  mediaKind: 'image' | 'video';
}

// Matches the inference the mobile composer applies to a freshly uploaded
// attachment, so the same file produces the same resource type on both clients.
// Only 'other' cards read it back -- every other card type is decided by the
// card itself during serialization.
function inferResourceAttachmentType(contentType: string | null): PostResourceItemType {
  if (contentType?.startsWith('image/')) return 'reference_image';
  if (contentType?.startsWith('video/')) return 'reference_video';
  if (contentType?.startsWith('audio/')) return 'reference_audio';
  return 'source_file';
}

function isReferenceMediaFile(file: File) {
  const contentType = file.type.trim().toLowerCase();
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const extensionFamily = REFERENCE_MEDIA_EXTENSION_FAMILY.get(extension);
  if (!extensionFamily) return false;
  if (!contentType || contentType === 'application/octet-stream') return true;
  return REFERENCE_MEDIA_CONTENT_TYPES.has(contentType)
    && contentType.startsWith(`${extensionFamily}/`);
}

/**
 * Compares everything a person can change in the editor, so closing with
 * unsaved edits can warn instead of silently discarding them.
 */
function getCardSignature(card: PostComposerResourceCardDraft) {
  return JSON.stringify({
    type: card.type,
    title: card.title,
    publicTitleIntent: card.publicTitleIntent,
    preview: card.preview,
    textContent: card.textContent,
    externalUrl: card.externalUrl,
    attachments: card.attachments.map((attachment) => attachment.id),
    appliesToAll: card.appliesToAll,
    mediaKeys: [...card.mediaKeys].sort(),
  });
}

export default function ResourceCardEditorDialog({
  card,
  isChoosingType,
  mediaOptions,
  canScopeToMedia,
  onChooseType,
  onChange,
  onSave,
  onClose,
  onUploadFile,
}: {
  card: PostComposerResourceCardDraft | null;
  isChoosingType: boolean;
  mediaOptions: ResourceScopeMediaOption[];
  canScopeToMedia: boolean;
  onChooseType: (type: PostComposerResourceCardType) => void;
  onChange: (patch: Partial<PostComposerResourceCardDraft>) => void;
  onSave: () => void;
  onClose: () => void;
  onUploadFile: UploadResourceFile;
}) {
  if (!isChoosingType && !card) {
    return null;
  }

  return (
    <ResourceCardEditorDialogContent
      // Choosing a type swaps a null card for a fresh draft without unmounting
      // this dialog, so the content has to remount for it to capture that draft
      // as the pristine state its discard warning compares against.
      key={card?.id ?? '__type-chooser__'}
      card={card}
      isChoosingType={isChoosingType}
      mediaOptions={mediaOptions}
      canScopeToMedia={canScopeToMedia}
      onChooseType={onChooseType}
      onChange={onChange}
      onSave={onSave}
      onClose={onClose}
      onUploadFile={onUploadFile}
    />
  );
}

function ResourceCardEditorDialogContent({
  card,
  isChoosingType,
  mediaOptions,
  canScopeToMedia,
  onChooseType,
  onChange,
  onSave,
  onClose,
  onUploadFile,
}: {
  card: PostComposerResourceCardDraft | null;
  isChoosingType: boolean;
  mediaOptions: ResourceScopeMediaOption[];
  canScopeToMedia: boolean;
  onChooseType: (type: PostComposerResourceCardType) => void;
  onChange: (patch: Partial<PostComposerResourceCardDraft>) => void;
  onSave: () => void;
  onClose: () => void;
  onUploadFile: UploadResourceFile;
}) {
  const titleId = useId();
  const titleErrorId = useId();
  const contentErrorId = useId();
  const uploadStatusId = useId();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsRef = useRef(card?.attachments ?? []);
  const uploadSequenceRef = useRef(0);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const openedSignatureRef = useRef<string | null>(card ? getCardSignature(card) : null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [failedUploadFiles, setFailedUploadFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{
    fileName: string;
    bytesSent: number;
    totalBytes: number;
    percent: number;
  } | null>(null);
  const portalRoot = typeof document === 'undefined' ? null : document.body;

  const isDirty = Boolean(card) && getCardSignature(card!) !== openedSignatureRef.current;

  const requestClose = () => {
    if (isUploading) {
      setUploadError('Wait for the file upload to finish or cancel it before closing this resource.');
      return;
    }
    if (isDirty && !window.confirm('Discard the changes to this resource?')) {
      return;
    }
    onClose();
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }

      if (event.key === 'Tab') {
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]):not(.sr-only), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
        if (focusable.length === 0) {
          event.preventDefault();
          panel.focus();
          return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === panel || !panel.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || active === panel || !panel.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const siblings = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay);
    const previous = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));

    siblings.forEach((element) => {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    });
    return () => {
      previous.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) {
          element.removeAttribute('aria-hidden');
        } else {
          element.setAttribute('aria-hidden', ariaHidden);
        }
      });
    };
  }, []);

  useLayoutEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  useEffect(() => {
    attachmentsRef.current = card?.attachments ?? [];
  }, [card?.attachments]);

  useEffect(() => () => uploadAbortRef.current?.abort(), []);

  if (!portalRoot) {
    return null;
  }

  const errors = card ? getPostComposerResourceCardErrors(card) : {};
  const showText = card ? TEXT_TYPES.includes(card.type) : false;
  const showLink = card ? LINK_TYPES.includes(card.type) : false;
  // A legacy section may legitimately combine text/link content with files.
  // The lossless serializer retains those items, and the editor must not hide
  // them merely because the inferred primary card type is text-oriented.
  const showFiles = card ? FILE_TYPES.includes(card.type) || card.attachments.length > 0 : false;

  const handleFiles = async (files: File[]) => {
    if (!card || files.length === 0) return;
    setUploadError(null);
    setFailedUploadFiles([]);

    const rejectedFiles = card.type === 'reference_media'
      ? files.filter((file) => !isReferenceMediaFile(file))
      : [];
    const acceptedFiles = rejectedFiles.length > 0
      ? files.filter((file) => !rejectedFiles.includes(file))
      : files;

    if (acceptedFiles.length === 0) {
      setUploadError('Reference media accepts images, video, or audio. Use Source assets for documents or archives.');
      return;
    }

    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setIsUploading(true);
    const failures: string[] = rejectedFiles.map((file) => `${file.name}: choose an image, video, or audio file`);
    const retryableFiles: File[] = [];
    try {
      for (let fileIndex = 0; fileIndex < acceptedFiles.length; fileIndex += 1) {
        const file = acceptedFiles[fileIndex]!;
        if (controller.signal.aborted) {
          retryableFiles.push(...acceptedFiles.slice(fileIndex));
          break;
        }
        setUploadProgress({
          fileName: file.name,
          bytesSent: 0,
          totalBytes: file.size,
          percent: 0,
        });
        try {
          const attachment = await onUploadFile(file, {
            signal: controller.signal,
            onProgress: (progress) => {
              if (controller.signal.aborted) return;
              setUploadProgress({
                fileName: file.name,
                bytesSent: progress.bytesSent,
                totalBytes: progress.totalBytes,
                percent: Math.round(progress.fraction * 100),
              });
            },
          });
          const uploaded: PostComposerResourceCardDraft['attachments'][number] = {
            id: `att-${attachment.storagePath ?? attachment.label}-${uploadSequenceRef.current++}`,
            kind: 'file',
            label: attachment.label,
            storagePath: attachment.storagePath ?? '',
            contentType: attachment.contentType ?? null,
            sizeBytes: attachment.sizeBytes ?? null,
            resourceType: inferResourceAttachmentType(attachment.contentType ?? null),
            role: 'primary',
            remixUse: 'none',
          };
          const nextAttachments = [...attachmentsRef.current, uploaded];
          // Commit each success immediately. If a later file fails, completed
          // uploads remain visible and are not re-uploaded on retry.
          attachmentsRef.current = nextAttachments;
          onChange({ attachments: nextAttachments });
        } catch (error) {
          if (controller.signal.aborted || isUploadCancelledError(error)) {
            retryableFiles.push(file, ...acceptedFiles.slice(fileIndex + 1));
            failures.push('Upload cancelled. The unfinished files are ready to retry');
            break;
          }
          retryableFiles.push(file);
          failures.push(`${file.name}: ${error instanceof Error ? error.message : 'upload failed'}`);
        }
      }
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      setIsUploading(false);
      setUploadProgress(null);
      setFailedUploadFiles(retryableFiles);
      if (failures.length > 0) {
        setUploadError(`Some files could not be added. ${failures.join('; ')}.`);
      } else {
        setUploadError(null);
      }
    }
  };

  const toggleMediaKey = (mediaKey: string) => {
    if (!card) return;
    const nextKeys = card.mediaKeys.includes(mediaKey)
      ? card.mediaKeys.filter((key) => key !== mediaKey)
      : [...card.mediaKeys, mediaKey];
    onChange({ appliesToAll: nextKeys.length === 0, mediaKeys: nextKeys });
  };

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[85] flex items-end justify-center bg-black/85 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={requestClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={isUploading}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-[28px] border border-white/10 bg-zinc-950 shadow-2xl shadow-black/70 outline-none sm:rounded-[28px]"
      >
        <div className="flex items-center gap-3 border-b border-white/8 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-bold tracking-tight text-white">
              {isChoosingType ? 'Add a resource' : getResourceCardTypeLabel(card!.type)}
            </h2>
            <p className="mt-0.5 truncate text-xs text-zinc-400">
              {isChoosingType ? 'Choose what people will receive.' : 'Contents stay protected until unlock.'}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={isUploading}
            aria-label="Close resource editor"
            aria-describedby={isUploading ? uploadStatusId : undefined}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 transition hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {isChoosingType ? (
          <div className="space-y-2 overflow-y-auto px-5 py-4">
            {POST_COMPOSER_RESOURCE_CARD_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => onChooseType(option.id)}
                className="flex w-full items-center gap-3 rounded-[18px] border border-white/8 bg-white/[0.03] p-3 text-left transition hover:border-white/20 hover:bg-white/[0.06]"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-zinc-300">
                  <ResourceTypeIcon type={option.id} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-white">{option.label}</span>
                  <span className="mt-0.5 block text-xs text-zinc-400">{option.body}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="space-y-4 overflow-y-auto px-5 py-4">
              <label className="block">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                    Resource title <span className="text-emerald-300">Required</span>
                  </span>
                  <span aria-hidden="true" className="text-xs text-zinc-500">
                    {card!.title.length}/{CARD_TITLE_MAX_LENGTH}
                  </span>
                </div>
                <input
                  value={card!.title}
                  onChange={(event) => onChange({
                    title: event.target.value.slice(0, CARD_TITLE_MAX_LENGTH),
                    // Hydrated legacy titles are private editor labels. The
                    // public opt-in happens only through this explicitly
                    // labelled field, never merely by opening and saving.
                    publicTitleIntent: 'explicit',
                  })}
                  maxLength={CARD_TITLE_MAX_LENGTH}
                  aria-label="Resource title, required"
                  aria-required="true"
                  aria-invalid={Boolean(errors.title)}
                  aria-describedby={errors.title ? titleErrorId : undefined}
                  placeholder="Name this resource"
                  className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35"
                />
                <p className="mt-2 text-xs text-zinc-500">
                  {card!.publicTitleIntent === 'legacy_private'
                    ? 'This older private label stays hidden until you edit it here.'
                    : 'Shown publicly on the locked package.'}
                </p>
                {errors.title ? <p id={titleErrorId} className="mt-1 text-xs text-rose-300">{errors.title}</p> : null}
              </label>

              <label className="block">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Short preview</span>
                  <span aria-hidden="true" className="text-xs text-zinc-500">
                    {card!.preview.length}/{CARD_PREVIEW_MAX_LENGTH}
                  </span>
                </div>
                <input
                  value={card!.preview}
                  onChange={(event) => onChange({ preview: event.target.value.slice(0, CARD_PREVIEW_MAX_LENGTH) })}
                  maxLength={CARD_PREVIEW_MAX_LENGTH}
                  aria-label="Short preview, optional"
                  placeholder="What this covers"
                  className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35"
                />
              </label>

              {showText ? (
                <label className="block">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                    Protected content
                  </div>
                  <textarea
                    value={card!.textContent}
                    onChange={(event) => onChange({ textContent: event.target.value })}
                    rows={6}
                    aria-label="Protected content"
                    aria-invalid={Boolean(errors.content)}
                    aria-describedby={errors.content ? contentErrorId : undefined}
                    placeholder="This content is revealed only after unlock"
                    className="w-full rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35"
                  />
                </label>
              ) : null}

              {showLink ? (
                <label className="block">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                    {card!.type === 'remix_link' ? 'Protected remix link' : 'Link'}
                  </div>
                  <input
                    value={card!.externalUrl}
                    onChange={(event) => onChange({ externalUrl: event.target.value })}
                    aria-label={card!.type === 'remix_link' ? 'Protected remix link' : 'Link'}
                    aria-invalid={Boolean(errors.content)}
                    aria-describedby={errors.content ? contentErrorId : undefined}
                    placeholder="https://..."
                    className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35"
                  />
                </label>
              ) : null}

              {showFiles ? (
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Files</div>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploading}
                      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-zinc-200 transition hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                      {isUploading ? 'Uploading' : 'Add file'}
                    </button>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={card!.type === 'reference_media' ? REFERENCE_MEDIA_ACCEPT : RESOURCE_FILE_ACCEPT}
                    className="sr-only"
                    onChange={(event) => {
                      void handleFiles(Array.from(event.target.files ?? []));
                      event.currentTarget.value = '';
                    }}
                  />
                  <p className="mt-1 text-xs text-zinc-500">Resource files must be 50MB or smaller.</p>
                  {isUploading ? (
                    <div id={uploadStatusId} role="status" aria-live="polite" className="mt-2 space-y-2">
                      <div className="flex items-center justify-between gap-3 text-xs text-zinc-400">
                        <span className="min-w-0 truncate">
                          {uploadProgress ? `Uploading ${uploadProgress.fileName} · ${uploadProgress.percent}%` : 'Preparing resource upload'}
                        </span>
                        <button
                          type="button"
                          onClick={() => uploadAbortRef.current?.abort()}
                          className="shrink-0 rounded-full border border-white/10 px-3 py-1.5 font-semibold text-zinc-200 transition hover:border-rose-300/30 hover:text-rose-100"
                        >
                          Cancel upload
                        </button>
                      </div>
                      <div
                        role="progressbar"
                        aria-label={uploadProgress ? `Uploading ${uploadProgress.fileName}` : 'Preparing resource upload'}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={uploadProgress?.percent ?? 0}
                        className="h-1.5 overflow-hidden rounded-full bg-white/8"
                      >
                        <div
                          className="h-full rounded-full bg-emerald-300 transition-[width]"
                          style={{ width: `${uploadProgress?.percent ?? 0}%` }}
                        />
                      </div>
                    </div>
                  ) : null}
                  {uploadError ? <p role="alert" className="mt-1 text-xs text-rose-300">{uploadError}</p> : null}
                  {!isUploading && failedUploadFiles.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => { void handleFiles(failedUploadFiles); }}
                      className="mt-2 rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-200 transition hover:border-emerald-300/30 hover:text-emerald-100"
                    >
                      Retry {failedUploadFiles.length === 1 ? 'file' : `${failedUploadFiles.length} files`}
                    </button>
                  ) : null}
                  {card!.attachments.length > 0 ? (
                    <ul className="mt-3 space-y-2">
                      {card!.attachments.map((attachment) => (
                        <li
                          key={attachment.id}
                          className="flex items-center gap-3 rounded-2xl border border-white/8 bg-black/30 px-3 py-2"
                        >
                          <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{attachment.label}</span>
                          <button
                            type="button"
                            onClick={() => onChange({
                              attachments: card!.attachments.filter((row) => row.id !== attachment.id),
                            })}
                            aria-label={`Remove ${attachment.label}`}
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:text-rose-200"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {canScopeToMedia && mediaOptions.length > 1 ? (
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Applies to</div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onChange({ appliesToAll: true, mediaKeys: [] })}
                      aria-pressed={card!.appliesToAll || card!.mediaKeys.length === 0}
                      className={`rounded-full border px-3 py-2 text-xs font-semibold transition ${
                        card!.appliesToAll || card!.mediaKeys.length === 0
                          ? 'border-emerald-300/35 bg-emerald-400/15 text-emerald-50'
                          : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:text-white'
                      }`}
                    >
                      All outputs
                    </button>
                    {mediaOptions.map((option) => {
                      const selected = !card!.appliesToAll && card!.mediaKeys.includes(option.mediaKey);
                      return (
                        <button
                          key={option.mediaKey}
                          type="button"
                          onClick={() => toggleMediaKey(option.mediaKey)}
                          aria-pressed={selected}
                          aria-label={`Apply to ${option.label}`}
                          className={`flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3 text-xs font-semibold transition ${
                            selected
                              ? 'border-emerald-300/35 bg-emerald-400/15 text-emerald-50'
                              : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:text-white'
                          }`}
                        >
                          <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-black">
                            {option.previewUrl && option.mediaKind === 'image' ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={option.previewUrl} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <Play className="h-3 w-3 text-zinc-400" />
                            )}
                          </span>
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {errors.content ? <p id={contentErrorId} className="text-xs text-rose-300">{errors.content}</p> : null}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-white/8 px-5 py-4">
              <button
                type="button"
                onClick={requestClose}
                disabled={isUploading}
                className="rounded-full border border-white/10 px-4 py-2 text-sm font-semibold text-zinc-300 transition hover:text-white disabled:cursor-wait disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={isUploading || !card || !isPostComposerResourceCardReady(card)}
                className="rounded-full bg-emerald-300 px-5 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Save resource
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    portalRoot
  );
}

export { createPostComposerResourceCard };
