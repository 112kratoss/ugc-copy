import type { ToolAccent } from '@/lib/theme';
import type { GenerationListItem } from '@/lib/types';
import type { PreviewViewerSource } from './immersive-preview-view-model';
import { getGenerationKind, getGenerationLabel, getGenerationRenderableMediaKind } from './generation-media';
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
  const kind = getGenerationKind(item);
  const status = item.status || 'unknown';
  const cost = item.cost ?? 0;

  return {
    id: item.id,
    title: item.title || item.prompt || 'Untitled creation',
    prompt: item.prompt || item.description || 'A saved Magic Booklet generation.',
    kind,
    label: getGenerationLabel(kind),
    badge: statusBadge(status, kind),
    status,
    metaLabel: `${cost} ${cost === 1 ? 'credit' : 'credits'}`,
    timeLabel: formatRelativeTime(item.completed_at ?? item.created_at),
    mediaUrl: item.output_urls?.[0] ?? item.output_url ?? null,
    mediaKind: getGenerationRenderableMediaKind(kind),
    accent: kind === 'text' ? 'amber' : kind === 'motion' ? 'motion' : kind === 'video' ? 'video' : 'image',
    height: kind === 'text' ? 218 : kind === 'motion' ? 256 : kind === 'video' ? 268 : 238,
    viewerSource: 'studio-creations',
    sourceId: item.id,
  };
}

function statusBadge(status: string, kind: StudioCreationCard['kind']) {
  if (status === 'processing' || status === 'waiting') return 'Processing';
  if (status === 'failed') return 'Failed';
  return getGenerationLabel(kind);
}
