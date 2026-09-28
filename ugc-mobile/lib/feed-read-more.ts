export type FeedReadMoreSection = 'story' | 'prompt';

/** Open the section that contains the text actually previewed on the card. */
export function feedReadMoreSection(
  preview: string,
  details: { body?: string | null; prompt?: string | null }
): FeedReadMoreSection {
  const normalize = (value?: string | null) => (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const shown = normalize(preview);
  if (shown && shown === normalize(details.body)) return 'story';
  if (shown && shown === normalize(details.prompt)) return 'prompt';
  return details.body?.trim() ? 'story' : 'prompt';
}
