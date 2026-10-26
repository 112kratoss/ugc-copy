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
 *
 * The first lineup (owner, 2026-10-26: "can we select from the medias which are
 * already created ? all are made by ourself anyways", then "All five"): the
 * five posts already on the feed that qualify. The two that fit the welcome
 * credits lead. No motion post qualifies yet: none has a saved recipe.
 */
export const HOME_SHELF_PINS: readonly HomeShelfPin[] = [
  // "A paper boat drifting slowly across a sunlit pond" (video, @batman)
  { postId: '102ab476-9eab-4cd3-bc65-848f7f2f1e09' },
  // "A giraffe in front of the Eiffel Tower" (image, @batman)
  { postId: 'f158d4a4-d14b-4860-b8cf-1868432055a5' },
  // "Kung fu cats" (video, @fluffy)
  { postId: 'e4d0dddd-47d7-4857-9230-306847c19faa' },
  // "UGC character" (image, @testcreator123)
  { postId: 'acb57ac5-5e94-4b11-b832-633b4c32fcca' },
  // "Peeling off a fake mask" (image, @hello-athul)
  { postId: 'f0316319-0d03-481d-997a-047123e37dfc' },
];

/**
 * The Earn card stays off until a real paid recipe has been sold and its
 * payout requested and paid (owner, 2026-10-25): until then nothing proves the
 * promise the card makes.
 */
export const HOME_SHELF_EARN_CARD_ENABLED = false;
