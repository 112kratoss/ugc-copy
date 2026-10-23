/**
 * Picked files' names, as a person reads them.
 *
 * Android's photo picker hands a picture over under its media id ("1000333161.jpg"), or a random UUID where
 * it cannot read a name, and a camera names its files after the time ("20261021_103000.jpg"): names nobody
 * would know a picture by. A name with a letter in it says something. Upload names are ASCII (lib/media.ts),
 * but a picker's own name can be in any script, so a character past ASCII counts as a letter too.
 */
const NAMELESS = /^(?:[^a-z\u0080-￿]*|[0-9a-f]{8}(?:[ _-]?[0-9a-f]{4}){3}[ _-]?[0-9a-f]{12})$/i;

/** Whether a name says nothing: a file's name without its extension, or a reference's name made from one. */
export function nameSaysNothing(name: string) {
  return NAMELESS.test(name.trim());
}

/** A file's name where it says something; null for a media id, a timestamp, a UUID or no name at all. */
export function readableFileName(fileName: string | null | undefined): string | null {
  const name = fileName?.trim();
  if (!name) return null;
  return nameSaysNothing(name.replace(/\.[^.]+$/, '')) ? null : name;
}

/**
 * Files named in a sentence: each by its name where the name says something, the rest counted by kind in
 * the order they come ("bravo.png, 2 pictures and a clip"), so three media ids read "3 pictures" and not
 * three numbers. `sentenceStart` capitalises a list that opens with a kind; a file's name is kept as written.
 */
export function listFilesInSentence<Kind extends string>(
  files: ReadonlyArray<{ fileName?: string | null; kind: Kind }>,
  nouns: Readonly<Record<Kind, readonly [one: string, many: string]>>,
  { sentenceStart = false }: { sentenceStart?: boolean } = {},
) {
  const named = files.map((file) => readableFileName(file.fileName)).filter((name): name is string => name !== null);
  const unnamed = new Map<Kind, number>();
  for (const file of files) {
    if (readableFileName(file.fileName) === null) unnamed.set(file.kind, (unnamed.get(file.kind) ?? 0) + 1);
  }
  const counted = [...unnamed].map(([kind, count]) => (count === 1 ? nouns[kind][0] : `${count} ${nouns[kind][1]}`));
  const parts = [...named, ...counted];
  const listed = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? '';
  return sentenceStart && named.length === 0 ? listed.charAt(0).toUpperCase() + listed.slice(1) : listed;
}
