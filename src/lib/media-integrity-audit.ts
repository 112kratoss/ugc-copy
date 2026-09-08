/**
 * The decisions the media integrity audit makes before it downloads anything.
 *
 * They live here rather than inside `scripts/audit-media-previews.ts` so they
 * can be tested without a database or a Storage round trip — the script keeps
 * the I/O and the reporting.
 */

export type PreviewCandidateVerdict =
  /** The record's only source is gone; it can never earn a preview. */
  | { kind: 'source_unavailable' }
  /** Nothing visual is expected of this row. */
  | { kind: 'not_applicable' }
  /** Owed a preview and without one; `issue` is what to report. */
  | { kind: 'finding'; issue: 'missing_preview' | 'missing_source_and_preview' }
  /** There is a stored preview to fetch and decode, at `path`. */
  | { kind: 'checkable'; path: string };

/**
 * Whether a row is worth downloading, and what to say about it if not.
 *
 * `source_unavailable` comes first on purpose. The repair job sets that marker
 * after an external source answers 404/410 on a second, separate run, and the
 * product then renders the record as explicitly unavailable. Such a row has no
 * preview and never will, so reporting it as a failure kept the audit red
 * forever over records nothing can fix — which is precisely what stopped it
 * being usable as a health signal.
 */
export function classifyPreviewCandidate(row: {
  sourceUnavailable: boolean;
  path: string | null;
  category: string | null;
  hasSource: boolean;
}): PreviewCandidateVerdict {
  if (row.sourceUnavailable) return { kind: 'source_unavailable' };
  if (row.path) return { kind: 'checkable', path: row.path };
  // Text and audio have no visual preview to owe.
  if (row.category === 'text' || row.category === 'audio') return { kind: 'not_applicable' };
  return {
    kind: 'finding',
    issue: row.hasSource ? 'missing_preview' : 'missing_source_and_preview',
  };
}

/**
 * An evenly spread subset, so a bounded periodic check says something about the
 * whole corpus instead of re-reading its oldest corner every time. Rows arrive
 * ordered by id, which is why taking the first n would keep sampling the same
 * records forever.
 */
export function drawIntegritySample<T>(rows: readonly T[], size: number): T[] {
  if (size <= 0) return [];
  if (rows.length <= size) return [...rows];
  const step = rows.length / size;
  return Array.from({ length: size }, (_unused, index) => rows[Math.floor(index * step)]);
}
