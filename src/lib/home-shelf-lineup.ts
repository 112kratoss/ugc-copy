import type { HomeShelfPin } from '@/lib/home-shelf';

/**
 * What the "Make this" shelf shows, in order. Edited by hand in a PR: the
 * owner approves each creation before it is pinned here.
 *
 * Each pin must be a public post made in the app (it has a generation) whose
 * remix is open to everyone: a recipe that sells its remix keeps the post off
 * the shelf, and so does a placeholder title. `toHomeShelfCreation` checks all
 * of it on every build, so a pin that stops qualifying simply drops out.
 *
 * The lineup this was planned with (2026-10-25): a new model while it is new,
 * an image and a video that fit the welcome credits, a motion, then a premium
 * image and a premium video. Fewer than three qualifying pins renders no shelf.
 */
export const HOME_SHELF_PINS: readonly HomeShelfPin[] = [];

/**
 * The Earn card stays off until a real paid recipe has been sold and its
 * payout requested and paid (owner, 2026-10-25): until then nothing proves the
 * promise the card makes.
 */
export const HOME_SHELF_EARN_CARD_ENABLED = false;
