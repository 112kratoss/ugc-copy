/**
 * The resting state of the modal slot: nothing.
 *
 * This renders on every route, so it must stay a pure component — reading
 * cookies or headers here would opt every page into dynamic rendering,
 * including the statically prerendered `/` (pinned by
 * anonymous-home-page-cache.test.tsx).
 */
export default function ModalSlotDefault() {
  return null;
}
