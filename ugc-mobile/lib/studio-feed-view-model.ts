import type { ToolAccent } from '@/lib/theme';
import type { GenerationListItem } from '@/lib/types';
import type { PreviewViewerSource } from './immersive-preview-view-model';
import { formatRelativeTime } from './home-view-model';

export type StudioCreationFilter = 'all' | 'image' | 'video' | 'motion' | 'text';

export interface StudioCreationCard {
  id: string;
  title: string;
  prompt: string;
  kind: Exclude<StudioCreationFilter, 'all'>;
  label: string;
  badge: string;
  status: string;
  metaLabel: string;
  timeLabel: string;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | null;
  accent: ToolAccent;
  height: number;
  viewerSource: PreviewViewerSource;
  sourceId: string;
}

export function buildStudioCreationMasonry(items: GenerationListItem[]) {
  return buildStudioCreationColumns(items.map(generationToStudioCreationCard));
}

export function buildStudioCreationColumns(cards: StudioCreationCard[]) {
  const columns: StudioCreationCard[][] = [[], []];
  const columnHeights = [0, 0];

  for (const card of cards) {
    const targetColumn = columnHeights[0] <= columnHeights[1] ? 0 : 1;
    columns[targetColumn].push(card);
    columnHeights[targetColumn] += card.height + 116;
  }

  return columns;
}

export function filterStudioCreationCards(cards: StudioCreationCard[], filter: StudioCreationFilter) {
  if (filter === 'all') return cards;
  return cards.filter((card) => card.kind === filter);
}

export function generationToStudioCreationCard(item: GenerationListItem): StudioCreationCard {
  const kind = generationKind(item);
  const status = item.status || 'unknown';
  const cost = item.cost ?? 0;

  return {
    id: item.id,
    title: item.title || item.prompt || 'Untitled creation',
    prompt: item.prompt || item.description || 'A saved Magic Booklet generation.',
    kind,
    label: creationLabel(kind),
    badge: statusBadge(status, kind),
    status,
    metaLabel: `${cost} ${cost === 1 ? 'credit' : 'credits'}`,
    timeLabel: formatRelativeTime(item.completed_at ?? item.created_at),
    mediaUrl: item.output_urls?.[0] ?? item.output_url ?? null,
    mediaKind: kind === 'text' ? null : kind === 'image' ? 'image' : 'video',
    accent: kind === 'text' ? 'amber' : kind === 'motion' ? 'motion' : kind === 'video' ? 'video' : 'image',
    height: kind === 'text' ? 218 : kind === 'motion' ? 256 : kind === 'video' ? 268 : 238,
    viewerSource: 'studio-creations',
    sourceId: item.id,
  };
}

function generationKind(item: GenerationListItem): StudioCreationCard['kind'] {
  if (item.category === 'video') return 'video';
  if (item.category === 'motion') return 'motion';
  if (item.category === 'text') return 'text';
  return 'image';
}

function statusBadge(status: string, kind: StudioCreationCard['kind']) {
  if (status === 'processing' || status === 'waiting') return 'Processing';
  if (status === 'failed') return 'Failed';
  return creationLabel(kind);
}

function creationLabel(kind: StudioCreationCard['kind']) {
  if (kind === 'motion') return 'Motion';
  if (kind === 'video') return 'Video';
  if (kind === 'text') return 'Text';
  return 'Image';
}
