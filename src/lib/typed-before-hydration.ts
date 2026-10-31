/**
 * What a visitor types into a server-rendered textarea before the page's script has run.
 *
 * No React hears that typing. Where the server drew text in the field, this React build's
 * hydration also writes that text back over the field's value (`initTextarea`), so the
 * motion creator's prompt, which opens on a prompt of its own, kept nothing to read back
 * (2026-10-31). The root layout therefore runs `TYPED_BEFORE_HYDRATION_CAPTURE` inline
 * from the server's HTML, ahead of every field: each textarea keeps its latest typed text
 * on itself, where hydration leaves it alone, for `useTypedBeforeHydration` to read as
 * the page mounts.
 *
 * Only what an input event brought counts. A browser that restores a form's text on Back
 * or a reload fires none, and that text can be another account's or a stale tab's, so the
 * field's own value is never read as typed.
 */

const TYPED_TEXT_PROPERTY = '__typedText';

/** Inline in the server's HTML: every textarea's text, as typed, kept on the field. */
export const TYPED_BEFORE_HYDRATION_CAPTURE = `document.addEventListener("input",function(e){var f=e.target;f&&f.localName==="textarea"&&(f.${TYPED_TEXT_PROPERTY}=f.value)},true)`;

/** The text last typed into the field, or undefined where nothing was typed into it. */
export function typedText(field: HTMLTextAreaElement): string | undefined {
  const typed = (field as HTMLTextAreaElement & Record<typeof TYPED_TEXT_PROPERTY, unknown>)[TYPED_TEXT_PROPERTY];
  return typeof typed === 'string' ? typed : undefined;
}
