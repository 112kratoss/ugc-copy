'use client';

import { useId, useState } from 'react';

import {
  BookOpen,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Link2,
  Package,
  Pencil,
  Plus,
  Repeat2,
  Settings2,
  Shapes,
  Trash2,
  Users,
  Workflow,
} from 'lucide-react';

import {
  getPostComposerResourceCardErrors,
  POST_COMPOSER_RESOURCE_CARD_OPTIONS,
  resourceCardHasContent,
  type PostComposerResourceCardDraft,
  type PostComposerResourceCardType,
} from '@/lib/post-composer-resource-cards';

export const RECIPE_PREVIEW_MAX_LENGTH = 180;

/** One icon per type, so no two rows of the picker look alike. */
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
      return <FolderOpen className={className} />;
    case 'guide':
      return <BookOpen className={className} />;
    case 'external_link':
      return <Link2 className={className} />;
    case 'remix_link':
      return <Repeat2 className={className} />;
    default:
      return <Shapes className={className} />;
  }
}

export function getResourceCardTypeLabel(type: PostComposerResourceCardType) {
  return POST_COMPOSER_RESOURCE_CARD_OPTIONS.find((option) => option.id === type)?.label ?? 'Item';
}

/** The note over the items of a recipe people already have (D1, 2026-10-27). */
export function describeRecipeBuyers(count: number): string {
  return count === 1
    ? '1 person has this recipe. They keep the version they got and see your changes.'
    : `${count} people have this recipe. They keep the version they got and see your changes.`;
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
  onEdit,
  onRemove,
}: {
  card: PostComposerResourceCardDraft;
  mediaCount: number;
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
            <span className="sr-only" role="status">Remove this item?</span>
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
              aria-label={`Edit ${displayTitle}`}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 transition hover:border-white/20 hover:text-white"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setIsConfirmingRemove(true)}
              aria-label={`Remove ${displayTitle}`}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 transition hover:border-rose-300/40 hover:text-rose-200"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The creation's saved inputs, which the publish route copies into the recipe
 * (A-F9). Read-only: "Include creation references" above adds and removes it.
 */
function CreationReferencesRow({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-3 rounded-[20px] border border-white/8 bg-black/30 p-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-zinc-300">
        <ImageIcon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-white">
          {`Creation references · ${count} ${count === 1 ? 'file' : 'files'}`}
        </div>
        <div className="mt-0.5 truncate text-xs text-zinc-500">Saved inputs from this creation</div>
      </div>
    </div>
  );
}

export default function ResourceCardsSection({
  cards,
  mediaCount,
  previewText,
  previewError,
  creationReferenceCount = 0,
  includesRemix = false,
  buyerCount = 0,
  onAddCard,
  onEditCard,
  onRemoveCard,
  onPreviewTextChange,
}: {
  cards: PostComposerResourceCardDraft[];
  mediaCount: number;
  /** The one public text (S6): the creator's own, or the suggestion while they have not written it. */
  previewText: string;
  previewError?: string | null;
  /** Saved inputs the recipe will carry; 0 leaves their row out. */
  creationReferenceCount?: number;
  /** A creation post's recipe includes its Remix (S1). */
  includesRemix?: boolean;
  /** People who have this recipe already. */
  buyerCount?: number;
  onAddCard: () => void;
  onEditCard: (id: string) => void;
  onRemoveCard: (id: string) => void;
  onPreviewTextChange: (previewText: string) => void;
}) {
  const readyCount = cards.filter((card) => resourceCardHasContent(card)).length
    + (creationReferenceCount > 0 ? 1 : 0);
  const rowCount = cards.length + (creationReferenceCount > 0 ? 1 : 0);
  const previewHelpId = useId();
  const previewErrorId = useId();

  return (
    <div className="space-y-5">
      {buyerCount > 0 ? (
        <div className="flex items-start gap-3 rounded-[20px] border border-white/8 bg-black/25 p-4 text-xs leading-5 text-zinc-300">
          <Users className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
          <p>{describeRecipeBuyers(buyerCount)}</p>
        </div>
      ) : null}

      <div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-white">What people receive</div>
            <p className="mt-1 text-xs text-zinc-400">
              {rowCount === 0
                ? 'Add at least one item.'
                : `${readyCount} ${readyCount === 1 ? 'item' : 'items'} ready`}
            </p>
          </div>
          <button
            type="button"
            onClick={onAddCard}
            className="inline-flex items-center gap-2 rounded-full bg-emerald-300 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-200"
          >
            <Plus className="h-4 w-4" />
            Add item
          </button>
        </div>

        {rowCount > 0 ? (
          <div className="mt-3 space-y-2">
            {cards.map((card) => (
              <ResourceCardRow
                key={card.id}
                card={card}
                mediaCount={mediaCount}
                onEdit={() => onEditCard(card.id)}
                onRemove={() => onRemoveCard(card.id)}
              />
            ))}
            {creationReferenceCount > 0 ? <CreationReferencesRow count={creationReferenceCount} /> : null}
          </div>
        ) : (
          <button
            type="button"
            onClick={onAddCard}
            className="mt-3 flex w-full flex-col items-center justify-center gap-2 rounded-[22px] border border-dashed border-white/12 bg-white/[0.02] px-4 py-8 text-zinc-400 transition hover:border-emerald-300/40 hover:text-zinc-200"
          >
            <Package className="h-7 w-7 text-zinc-500" />
            <span className="text-sm font-semibold">Add your first item</span>
          </button>
        )}

        {/* Remix permission is no switch and no item: on a creation post the
            server gates the post's Remix at the recipe's unlock (S1). */}
        {includesRemix ? (
          <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-zinc-400">
            <Repeat2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
            <span>Remix comes with this recipe: people who unlock it can remix your post.</span>
          </p>
        ) : null}
      </div>

      <label className="block">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            Recipe preview <span className="text-emerald-300">Required</span>
          </span>
          <span aria-hidden="true" className="text-xs text-zinc-500">
            {previewText.length}/{RECIPE_PREVIEW_MAX_LENGTH}
          </span>
        </div>
        <textarea
          value={previewText}
          onChange={(event) => onPreviewTextChange(event.target.value.slice(0, RECIPE_PREVIEW_MAX_LENGTH))}
          maxLength={RECIPE_PREVIEW_MAX_LENGTH}
          rows={3}
          aria-label={`Recipe preview, required, maximum ${RECIPE_PREVIEW_MAX_LENGTH} characters`}
          aria-required="true"
          aria-invalid={Boolean(previewError)}
          aria-describedby={previewError ? `${previewHelpId} ${previewErrorId}` : previewHelpId}
          placeholder="Tell people what they will receive"
          className="w-full rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
        />
        <p id={previewHelpId} className="mt-2 text-xs leading-5 text-zinc-500">
          Everyone sees this before unlocking.
        </p>
        {previewError ? <p id={previewErrorId} className="mt-1 text-xs text-rose-300">{previewError}</p> : null}
      </label>
    </div>
  );
}
