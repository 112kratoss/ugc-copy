/**
 * What a visitor types into a server-rendered textarea or input before the page's script has run.
 *
 * No React hears that typing. Where the server drew text in the field, this React build's
 * hydration also writes that text back over a textarea's value (`initTextarea`), so the
 * motion creator's prompt, which opens on a prompt of its own, kept nothing to read back
 * (2026-10-31). The root layout therefore runs `TYPED_BEFORE_HYDRATION_CAPTURE` inline
 * from the server's HTML, ahead of every field: each textarea, and each input marked with
 * `TYPED_INPUT_PROPS`, keeps its latest typed text on itself, where hydration leaves it alone,
 * for `useTypedBeforeHydration` to read as the page mounts. Marked inputs since 2026-11-06: the
 * post composer takes its title and its price only as typed, as it takes its post text.
 *
 * Only what an input event brought counts. A browser that restores a form's text on Back
 * or a reload fires none, and that text can be another account's or a stale tab's, so the
 * field's own value is never read as typed.
 */

const TYPED_TEXT_PROPERTY = '__typedText';
const TYPED_INPUT_ATTRIBUTE = 'data-typed-before-hydration';

/**
 * On an input whose typed text `useTypedBeforeHydration` reads: the capture copies no other
 * input's. A copy outlives the page clearing its field, so the capture keeps none of the
 * inputs that are not read this way, a password among them (a "Show password" button makes it
 * a text field), nor an email or payout details.
 */
export const TYPED_INPUT_PROPS = { [TYPED_INPUT_ATTRIBUTE]: '' } as const;

/** Inline in the server's HTML: every textarea's and marked input's text, as typed, kept on the field. */
export const TYPED_BEFORE_HYDRATION_CAPTURE = `document.addEventListener("input",function(e){var f=e.target;f&&(f.localName==="textarea"||f.localName==="input"&&f.type!=="password"&&f.hasAttribute("${TYPED_INPUT_ATTRIBUTE}"))&&(f.${TYPED_TEXT_PROPERTY}=f.value)},true)`;

/** The text last typed into the field, or undefined where nothing was typed into it. */
export function typedText(field: HTMLTextAreaElement | HTMLInputElement): string | undefined {
  const typed = (field as (HTMLTextAreaElement | HTMLInputElement) & Record<typeof TYPED_TEXT_PROPERTY, unknown>)[TYPED_TEXT_PROPERTY];
  return typeof typed === 'string' ? typed : undefined;
}
