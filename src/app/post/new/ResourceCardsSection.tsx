'use client';

import { useId, useState } from 'react';

import {
  FileText,
  Image as ImageIcon,
  Link2,
  Package,
  Pencil,
  Plus,
  Repeat2,
  Settings2,
  Trash2,
  Workflow,
} from 'lucide-react';

import {
  getPostComposerResourceCardErrors,
  POST_COMPOSER_RESOURCE_CARD_OPTIONS,
  resourceCardHasContent,
  type PostComposerResourceCardDraft,
  type PostComposerResourceCardType,
} from '@/lib/post-composer-resource-cards';

const RESOURCE_PREVIEW_MAX_LENGTH = 180;
const RESOURCE_SUMMARY_MAX_LENGTH = 180;

export function ResourceTypeIcon({
  type,
  className = 'h-4 w-4',
}: {
  type: PostComposerResourceCardType;
  className?: string;
}) {
  switch (type) {
    case 'prompt':
      return <FileText className={className} />;
    case 'reference_media':
      return <ImageIcon className={className} />;
    case 'settings':
      return <Settings2 className={className} />;
    case 'workflow':
      return <Workflow className={className} />;
    case 'source_assets':
      return <Package className={className} />;
    case 'guide':
      return <FileText className={className} />;
    case 'remix_link':
      return <Repeat2 className={className} />;
    default:
      return <Link2 className={className} />;
  }
}

export function getResourceCardTypeLabel(type: PostComposerResourceCardType) {
  return POST_COMPOSER_RESOURCE_CARD_OPTIONS.find((option) => option.id === type)?.label ?? 'Resource';
}

function describeScope(card: PostComposerResourceCardDraft, mediaCount: number) {
  if (card.appliesToAll || card.mediaKeys.length === 0) {
    return mediaCount > 1 ? 'All outputs' : null;
  }
  return `${card.mediaKeys.length} selected ${card.mediaKeys.length === 1 ? 'output' : 'outputs'}`;
}

function ResourceCardRow({
  card,
  mediaCount,
  disabled,
  onEdit,
  onRemove,
}: {
  card: PostComposerResourceCardDraft;
  mediaCount: number;
  disabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);
  const errors = getPostComposerResourceCardErrors(card);
  const isReady = Object.keys(errors).length === 0;
  const scopeLabel = describeScope(card, mediaCount);
  const attachmentCount = card.attachments.length;
  const typeLabel = getResourceCardTypeLabel(card.type);
  const displayTitle = card.title.trim() || typeLabel;
  // A card keeps its type name as the default title, so repeating it underneath
  // would just print the same words twice.
  const metaParts = [
    displayTitle === typeLabel ? null : typeLabel,
    attachmentCount > 0 ? `${attachmentCount} ${attachmentCount === 1 ? 'file' : 'files'}` : null,
    scopeLabel,
  ].filter(Boolean);

  return (
    <div className="flex items-center gap-3 rounded-[20px] border border-white/8 bg-black/30 p-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-zinc-300">
        <ResourceTypeIcon type={card.type} className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-white">{displayTitle}</div>
        {metaParts.length > 0 ? (
          <div className="mt-0.5 truncate text-xs text-zinc-500">{metaParts.join(' · ')}</div>
        ) : null}
        {!isReady ? (
          <div className="mt-1 text-xs font-medium text-amber-300">
            {errors.title ?? errors.content}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {isConfirmingRemove ? (
          <>
            <span className="sr-only" role="status">Remove this resource?</span>
            <button
              type="button"
              onClick={() => setIsConfirmingRemove(false)}
              autoFocus
              className="min-h-9 rounded-full border border-white/10 px-3 text-xs font-semibold text-zinc-300 transition hover:text-white"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="min-h-9 rounded-full border border-rose-300/30 bg-rose-400/10 px-3 text-xs font-semibold text-rose-100 transition hover:bg-rose-400/20"
            >
              Remove
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onEdit}
              disabled={disabled}
              aria-label={`Edit ${card.title.trim() || getResourceCardTypeLabel(card.type)}`}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 transition hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setIsConfirmingRemove(true)}
              disabled={disabled}
              aria-label={`Remove ${card.title.trim() || getResourceCardTypeLabel(card.type)}`}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 transition hover:border-rose-300/40 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function ResourceCardsSection({
  cards,
  mediaCount,
  disabled,
  allowRemix,
  summary,
  previewText,
  suggestedPreview,
  summaryError,
  previewError,
  onAddCard,
  onEditCard,
  onRemoveCard,
  onAllowRemixChange,
  onSummaryChange,
  onPreviewTextChange,
}: {
  cards: PostComposerResourceCardDraft[];
  mediaCount: number;
  disabled: boolean;
  allowRemix: boolean;
  summary: string;
  previewText: string;
  suggestedPreview: string;
  summaryError?: string | null;
  previewError?: string | null;
  onAddCard: () => void;
  onEditCard: (id: string) => void;
  onRemoveCard: (id: string) => void;
  onAllowRemixChange: (allowRemix: boolean) => void;
  onSummaryChange: (summary: string) => void;
  onPreviewTextChange: (previewText: string) => void;
}) {
  const readyCount = cards.filter((card) => resourceCardHasContent(card)).length;
  const summaryErrorId = useId();
  const previewErrorId = useId();

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-white">What people receive</div>
            <p className="mt-1 text-xs text-zinc-400">
              {cards.length === 0
                ? allowRemix ? 'Direct remix access is ready.' : 'Add at least one useful resource.'
                : `${readyCount} ${readyCount === 1 ? 'resource' : 'resources'} ready${allowRemix ? ' · remix included' : ''}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onAddCard}
            disabled={disabled}
            className="inline-flex items-center gap-2 rounded-full bg-emerald-300 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus className="h-4 w-4" />
            Add
          </button>
        </div>

        {cards.length > 0 ? (
          <div className="mt-3 space-y-2">
            {cards.map((card) => (
              <ResourceCardRow
                key={card.id}
                card={card}
                mediaCount={mediaCount}
                disabled={disabled}
                onEdit={() => onEditCard(card.id)}
                onRemove={() => onRemoveCard(card.id)}
              />
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={onAddCard}
            disabled={disabled}
            className="mt-3 flex w-full flex-col items-center justify-center gap-2 rounded-[22px] border border-dashed border-white/12 bg-white/[0.02] px-4 py-8 text-zinc-400 transition hover:border-emerald-300/40 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Package className="h-7 w-7 text-zinc-500" />
            <span className="text-sm font-semibold">Add your first resource</span>
          </button>
        )}
      </div>

      {/*
        Remix permission cannot live on a card: a remix_access item carries no
        text, link or file, so it would be filtered out as empty content.
      */}
      <label className="flex items-start gap-3 rounded-[20px] border border-white/8 bg-black/25 p-4">
        <input
          type="checkbox"
          checked={allowRemix}
          disabled={disabled}
          onChange={(event) => onAllowRemixChange(event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-white/10 bg-white/[0.03] text-emerald-400 focus:ring-0 focus:ring-offset-0"
        />
        <span>
          <span className="block text-sm font-semibold text-white">Allow direct remix</span>
          <span className="mt-1 block text-xs leading-5 text-zinc-400">
            People who unlock this can remix the post directly.
          </span>
        </span>
      </label>

      <label className="block">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            Public summary <span className="font-normal normal-case tracking-normal text-zinc-600">Optional</span>
          </span>
          <span aria-hidden="true" className="text-xs text-zinc-500">
            {summary.length}/{RESOURCE_SUMMARY_MAX_LENGTH}
          </span>
        </div>
        <input
          value={summary}
          onChange={(event) => onSummaryChange(event.target.value.slice(0, RESOURCE_SUMMARY_MAX_LENGTH))}
          disabled={disabled}
          maxLength={RESOURCE_SUMMARY_MAX_LENGTH}
          aria-label={`Public package summary, optional, maximum ${RESOURCE_SUMMARY_MAX_LENGTH} characters`}
          aria-invalid={Boolean(summaryError)}
          aria-describedby={summaryError ? summaryErrorId : undefined}
          placeholder="A short public headline for this package"
          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-60"
        />
        <p className="mt-2 text-xs leading-5 text-zinc-500">
          When filled, this is the first package description buyers see before unlock. Leave it blank to use the package preview below.
        </p>
        {summaryError ? <p id={summaryErrorId} className="mt-1 text-xs text-rose-300">{summaryError}</p> : null}
      </label>

      <label className="block">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            Package preview <span className="text-emerald-300">Required</span>
          </span>
          <span aria-hidden="true" className="text-xs text-zinc-500">
            {previewText.length}/{RESOURCE_PREVIEW_MAX_LENGTH}
          </span>
        </div>
        <textarea
          value={previewText}
          onChange={(event) => onPreviewTextChange(event.target.value.slice(0, RESOURCE_PREVIEW_MAX_LENGTH))}
          disabled={disabled}
          maxLength={RESOURCE_PREVIEW_MAX_LENGTH}
          rows={3}
          aria-label={`Package preview, required, maximum ${RESOURCE_PREVIEW_MAX_LENGTH} characters`}
          aria-required="true"
          aria-invalid={Boolean(previewError)}
          aria-describedby={previewError ? previewErrorId : undefined}
          placeholder="Tell people what they will receive"
          className="w-full rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-60"
        />
        <p className="mt-2 text-xs leading-5 text-zinc-500">
          Required public detail saved with the package. When the summary is blank, buyers see this as the listing description.
        </p>
        {previewError ? <p id={previewErrorId} className="mt-1 text-xs text-rose-300">{previewError}</p> : null}
        {!previewText.trim() && readyCount > 0 ? (
          <button
            type="button"
            onClick={() => onPreviewTextChange(suggestedPreview.slice(0, RESOURCE_PREVIEW_MAX_LENGTH))}
            disabled={disabled}
            className="mt-2 text-xs font-semibold text-emerald-300 transition hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Use suggested preview
          </button>
        ) : null}
      </label>
    </div>
  );
}
