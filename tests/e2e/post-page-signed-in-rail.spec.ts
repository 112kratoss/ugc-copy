import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';

import freeRecipePost from './fixtures/creation-post-free-recipe.json';
import paidRecipePost from './fixtures/creation-post-paid-recipe.json';
import plainCreationPost from './fixtures/creation-post.json';
import uploadRecipePost from './fixtures/upload-post-recipe-without-remix.json';

// The owner's screen recording of the live site, 2026-11-16 (build 24ac32b80, signed in, Chrome on a
// laptop): every post opened from the Marketplace drew its Comments card with "Sign in to join the
// conversation" and its rail without "Report user · Block user", though the top bar already showed
// the reader's avatar and balance. About 0.2 s later the composer took the sign-in link's place and
// the row came in, pushing Comments down. The post page checks the session in the browser
// (`OptionalAuth`: a provider of its own on each page, which a client navigation starts again), and
// both parts drew a reader whose session was still being checked as a signed-out visitor.
//
// Here the browser holds a session cookie and no E2E bypass, so the page's provider checks it with
// Supabase as production's does, and the test holds that check (`/auth/v1/user`) until it has seen
// the page drawn meanwhile. Every frame the rail is drawn in is recorded. The dev server answers the
// post's reads (support/supabase-server-stub.cjs, fixtures/creation-post-free-recipe.json: a post
// with a free recipe, as the recording's were); the thread is answered here.

const ORIGIN = 'http://127.0.0.1:3100';
// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };
const POST_ID = freeRecipePost.post.id;
const POST_PATH = `/showcase/${POST_ID}`;
const TITLE = freeRecipePost.post.title;
const COMMENT = 'The light on the water is perfect.';

/** A post the page draws: its id, address, title and creator. */
type DrawnPost = { id: string; path: string; title: string; creatorId: string };
/** The post with a free recipe, which the recording's posts were. */
const RECIPE_POST: DrawnPost = { id: POST_ID, path: POST_PATH, title: TITLE, creatorId: freeRecipePost.creator.id };
/** A picture post with no recipe at all (fixtures/creation-post.json), by a creator of its own. */
const PLAIN_POST: DrawnPost = {
  id: plainCreationPost.post.id,
  path: `/showcase/${plainCreationPost.post.id}`,
  title: plainCreationPost.post.title,
  creatorId: plainCreationPost.creator.id,
};
/** A picture post whose paid recipe locks its Remix (fixtures/creation-post-paid-recipe.json), by a creator of its own. */
const PAID_POST: DrawnPost = {
  id: paidRecipePost.post.id,
  path: `/showcase/${paidRecipePost.post.id}`,
  title: paidRecipePost.post.title,
  creatorId: paidRecipePost.creator.id,
};
/**
 * A picture made elsewhere whose free recipe does not include the post's Remix
 * (fixtures/upload-post-recipe-without-remix.json): with no creation, nobody has a Remix, its creator
 * included.
 */
const UPLOAD_POST: DrawnPost = {
  id: uploadRecipePost.post.id,
  path: `/showcase/${uploadRecipePost.post.id}`,
  title: uploadRecipePost.post.title,
  creatorId: uploadRecipePost.creator.id,
};

test.describe.configure({ timeout: 180_000 });

function base64Url(text: string) {
  return Buffer.from(text).toString('base64url');
}

const user = {
  id: 'workflow-user',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'workflow-user@example.com',
  is_anonymous: false,
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { name: 'Workflow User' },
  identities: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

/** The browser's session checks (`/auth/v1/user`), answered at once or held from `hold()` to `release()`. */
function sessionChecks() {
  let gate: Promise<void> | null = null;
  let open = () => {};
  let held = 0;
  return {
    hold() {
      held = 0;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open();
    },
    /** How many checks have been asked for since `hold()`. */
    held: () => held,
    async answer() {
      if (!gate) return;
      held += 1;
      await gate;
    },
  };
}

/** The post's own creator, as Supabase's auth describes them. */
const postCreator = {
  ...user,
  id: freeRecipePost.creator.id,
  email: 'free-remix-creator@example.com',
  user_metadata: { name: freeRecipePost.creator.display_name },
};

/** The paid recipe's creator. */
const paidPostCreator = {
  ...user,
  id: paidRecipePost.creator.id,
  email: 'paid-recipe-creator@example.com',
  user_metadata: { name: paidRecipePost.creator.display_name },
};

/** The upload's creator. */
const uploadPostCreator = {
  ...user,
  id: uploadRecipePost.creator.id,
  email: 'upload-recipe-creator@example.com',
  user_metadata: { name: uploadRecipePost.creator.display_name },
};

/** The account's profile row, which the top bar reads its name, picture and balance from. */
type ProfileRow = { display_name: string | null; avatar_url: string | null; credits: number; promotional_credits: number };
const WORKFLOW_PROFILE: ProfileRow = { display_name: 'Workflow User', avatar_url: null, credits: 22, promotional_credits: 0 };

/**
 * Signed in as a browser is: a session cookie for the placeholder project, sent with every request,
 * and no E2E bypass, which would hand the page's provider its session at once.
 */
async function signIn(
  context: BrowserContext,
  account: Omit<typeof user, 'user_metadata'> & { user_metadata: Record<string, unknown> } = user,
  profile: ProfileRow = WORKFLOW_PROFILE,
) {
  const checks = sessionChecks();
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    sub: account.id, aud: 'authenticated', role: 'authenticated', exp: 4_102_444_800, session_id: 'e2e-session',
  }));
  const session = {
    access_token: `${header}.${payload}.c2lnbmF0dXJl`,
    refresh_token: 'e2e-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4_102_444_800,
    user: account,
  };
  await context.addCookies([
    { name: 'sb-example-auth-token', value: `base64-${base64Url(JSON.stringify(session))}`, url: ORIGIN },
  ]);
  await context.route('https://example.supabase.co/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') {
      await checks.answer();
      return route.fulfill({ json: account }).catch(() => undefined);
    }
    if (pathname === '/auth/v1/token') return route.fulfill({ json: session });
    const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
    if (pathname === '/rest/v1/profiles') {
      return route.fulfill({ json: single ? profile : [profile] });
    }
    if (pathname.startsWith('/rest/v1/')) return route.fulfill(single ? { status: 406, json: {} } : { json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  return { checks, accessToken: session.access_token };
}

/**
 * Every API call unanswered but the post's thread: one comment by someone else. `reads` gets the
 * Authorization of each read of the thread, null for a visitor's.
 */
async function answerApi(page: Page, reads: Array<string | null> = [], post: DrawnPost = RECIPE_POST) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await page.route(`**/api/showcase/posts/${post.id}/comments**`, (route) => {
    reads.push(route.request().headers().authorization ?? null);
    return route.fulfill({
      json: {
        postId: post.id,
        postCreatorId: post.creatorId,
        commentCount: 1,
        comments: [{
          id: 'c-1',
          parentId: null,
          body: COMMENT,
          status: 'active',
          createdAt: '2026-11-10T08:00:00.000Z',
          replyCount: 0,
          author: { id: 'someone-else', username: 'lena', displayName: 'Lena', avatarUrl: null },
          likeCount: 2,
          viewerReaction: null,
          editedAt: null,
          hearted: false,
          pinned: false,
        }],
        pageInfo: { hasMore: false, nextOffset: null, limit: 20, offset: 0 },
      },
    });
  });
}

type Frame = {
  path: string;
  /** When the frame was drawn, in ms since the navigation began (not what tells it from the last). */
  at: number;
  /** Comments' top from the rail's own top: what a row drawn late above it moves. */
  commentsOffset: number | null;
  /**
   * The HTML parser had not left the Comments panel when the frame was drawn: its header and first
   * rows are in, its end, where the composer or the sign-in offer goes, is not yet (`RECORDER`).
   */
  commentsParsing: boolean;
  signInShown: boolean;
  reportUserShown: boolean;
  /** "Report post or recipe", which is everyone's but the post's creator's. */
  reportPostShown: boolean;
  /** The creator's own row, "Owner tools", or its place. */
  ownerToolsShown: boolean;
  composerShown: boolean;
  /** The initials on the composer's avatar, "" for none; null while there is no composer. */
  composerInitials: string | null;
  /** The thread's comments drawn. */
  comments: number;
  /**
   * The rail's pointer to the recipe as it reads ("Free recipe View"), null while none is shown, or
   * while the HTML parser is still inside it and it has its box and not yet all of its words.
   */
  recipeLink: string | null;
  /** The recipe's bar along the bottom edge as it reads (below 1180px), null while none is shown. */
  recipeBar: string | null;
};

/** A frame of the post's column: the engagement row's Remix as it reads ("Remix · Free"), "" for none. */
type RemixFrame = { path: string; remix: string };

/**
 * A frame of the recipe panel under the post: what is shown of it, as one line (null while it is not
 * laid out, as in the dev server's first frames), and whether its HTML has all arrived (the rail,
 * which comes after it, is in).
 */
type RecipeFrame = { path: string; whole: boolean; text: string | null };

/**
 * Records every frame whose drawing of the post's rail differs from the last, from the document's
 * first frame on: its first frames are the server's HTML under the stylesheet and the pre-paint
 * script, before the page's own scripts have run. The engagement row's Remix, which the HTML draws
 * before the rail, is recorded apart from its own first frame (`__remixFrames`), and so is the
 * recipe panel under the post (`__recipeFrames`).
 */
const RECORDER = `(() => {
  const frames = [];
  window.__railFrames = frames;
  const remixFrames = [];
  window.__remixFrames = remixFrames;
  const recipeFrames = [];
  window.__recipeFrames = recipeFrames;
  let last = '';
  let lastRemix = '';
  let lastRecipe = '';
  const shown = (element) => Boolean(element && element.getClientRects().length > 0);
  // Chrome's HTML parser stops to let the page be drawn on a time budget, whether or not the whole
  // document is in, so a frame can be drawn from a part it has not finished: #883's CI run of
  // 2026-11-19 drew the Comments panel with its header and its loading row and not yet its end,
  // where the composer or the sign-in offer goes, and the next frame with the offer. Nothing follows
  // a part in the document until the parser has left it (.claude/rules/e2e.md), so such a frame is
  // marked, and the rail's checks leave it out of what a frame must show.
  const unfinished = (element) => {
    if (!element || document.readyState !== 'loading') return false;
    for (let node = element; node && node !== document.documentElement; node = node.parentNode) {
      if (node.nextSibling) return false;
    }
    return true;
  };
  // What a shown element reads: the text of what is shown of it, as one line.
  const reads = (element) => (shown(element) ? element.innerText.replace(/\\s+/g, ' ').trim() : null);
  function sample() {
    // The engagement row closes the post's own column (the post, its writing, then the row), its
    // Remix ahead of Save: once Save is in the page, so is the Remix the row draws.
    const column = document.querySelector('[data-testid="media-detail-document"], [data-testid="text-detail-note"]');
    const save = column && Array.from(column.querySelectorAll('button'))
      .find((button) => /^(Save|Remove save from) /.test(button.getAttribute('aria-label') || ''));
    if (save) {
      const remix = Array.from(column.querySelectorAll('a, button'))
        .map(reads)
        .filter((text) => text !== null && /^Remix\\b/.test(text))
        .join(' | ');
      const remixFrame = { path: location.pathname, remix };
      const remixKey = JSON.stringify(remixFrame);
      if (remixKey !== lastRemix) {
        lastRemix = remixKey;
        remixFrames.push(remixFrame);
      }
    }
    const recipe = document.querySelector('[data-testid="canonical-post-recipe"]');
    if (recipe) {
      const recipeFrame = {
        path: location.pathname,
        whole: Boolean(document.querySelector('[data-testid="canonical-post-actions"]')),
        text: reads(recipe),
      };
      const recipeKey = JSON.stringify(recipeFrame);
      if (recipeKey !== lastRecipe) {
        lastRecipe = recipeKey;
        recipeFrames.push(recipeFrame);
      }
    }
    const rail = document.querySelector('[data-testid="canonical-post-actions"]');
    if (rail) {
      const comments = rail.querySelector('[data-testid="canonical-post-comments"]');
      const signIn = Array.from(rail.querySelectorAll('a'))
        .find((link) => link.textContent.includes('Sign in to join the conversation'));
      const reportUser = Array.from(rail.querySelectorAll('button'))
        .find((button) => button.textContent.trim() === 'Report user');
      const reportPost = Array.from(rail.querySelectorAll('button'))
        .find((button) => button.textContent.trim() === 'Report post or recipe');
      const ownerTools = Array.from(rail.querySelectorAll('span'))
        .filter((span) => span.textContent.trim() === 'Owner tools');
      const composerField = rail.querySelector('textarea[aria-label="Write a comment"]');
      // The composer's row: its avatar, then the field.
      const composerRow = composerField ? composerField.closest('.flex.items-start') : null;
      // The parser can stop inside the recipe link too: main's run of 2026-11-27 drew a frame 7.3 s
      // in with the rail ending at the link, its box there and no word in it yet, which read as ""
      // and failed the creator's own rail as a recipe that was not theirs. Such a link is not one yet.
      const recipeJump = rail.querySelector('[data-testid="recipe-jump-link"]');
      const frame = {
        path: location.pathname,
        commentsOffset: comments
          ? Math.round(comments.getBoundingClientRect().top - rail.getBoundingClientRect().top)
          : null,
        commentsParsing: unfinished(comments),
        signInShown: shown(signIn),
        reportUserShown: shown(reportUser),
        reportPostShown: shown(reportPost),
        ownerToolsShown: ownerTools.some(shown),
        composerShown: shown(composerField),
        composerInitials: shown(composerField) && composerRow && composerRow.firstElementChild
          ? composerRow.firstElementChild.textContent.trim()
          : null,
        comments: rail.querySelectorAll('ol[aria-label="Comment thread"] > li').length,
        recipeLink: unfinished(recipeJump) ? null : reads(recipeJump),
        recipeBar: reads(document.querySelector('[data-testid="recipe-bar"]')),
      };
      const key = JSON.stringify(frame);
      if (key !== last) {
        last = key;
        frame.at = Math.round(performance.now());
        frames.push(frame);
      }
    }
    if (!window.__railFramesDone) requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();`;

/**
 * The frames recorded so far, read once two more have passed, so the last change committed before
 * the call has been sampled. `stop: false` leaves the recorder running.
 */
async function recordedFrames(page: Page, { stop = true, path = POST_PATH } = {}): Promise<Frame[]> {
  const frames = await page.evaluate(async (stopRecording) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const record = window as unknown as { __railFrames: Frame[]; __railFramesDone?: boolean };
    if (stopRecording) record.__railFramesDone = true;
    return record.__railFrames;
  }, stop);
  return frames.filter((frame) => frame.path === path);
}

/** The engagement row's frames recorded so far; read after `recordedFrames`, which stops the recorder. */
async function recordedRemixFrames(page: Page, { path = POST_PATH } = {}): Promise<RemixFrame[]> {
  const frames = await page.evaluate(() => (window as unknown as { __remixFrames: RemixFrame[] }).__remixFrames);
  return frames.filter((frame) => frame.path === path);
}

/** The engagement row's Remix, read the same in every frame from the row's first. */
function expectRemixInEveryFrame(frames: RemixFrame[], remix: string) {
  const all = JSON.stringify(frames);
  expect(frames.length, all).toBeGreaterThan(0);
  expect(frames.filter((frame) => frame.remix !== remix), all).toEqual([]);
}

/**
 * Each reading is one of `steps`: the first reads the first step, the last the last, and none goes
 * back to an earlier step. What a signed-in reader is told of a post's recipe goes through, from the
 * page's first frame to their own read of it.
 */
function expectStepsInOrder(readings: Array<string | null>, steps: Array<string | RegExp>, all: string) {
  const stepOf = (reading: string | null) => steps.findIndex((step) => (
    typeof step === 'string' ? reading === step : step.test(reading ?? '')
  ));
  const at = readings.map(stepOf);
  expect(readings.length, all).toBeGreaterThan(0);
  expect(readings.filter((_, index) => at[index] < 0), all).toEqual([]);
  expect([at[0], at.at(-1)], all).toEqual([0, steps.length - 1]);
  expect(at.filter((step, index) => index > 0 && step < at[index - 1]), all).toEqual([]);
}

/** The engagement row's Remix, reading `steps` in order from the row's first frame. */
function expectRemixInOrder(frames: RemixFrame[], steps: string[]) {
  expectStepsInOrder(frames.map((frame) => frame.remix), steps, JSON.stringify(frames));
}

/** The recipe panel's frames recorded so far; read after `recordedFrames`, which stops the recorder. */
async function recordedRecipeFrames(page: Page, { path = POST_PATH } = {}): Promise<RecipeFrame[]> {
  const frames = await page.evaluate(() => (window as unknown as { __recipeFrames: RecipeFrame[] }).__recipeFrames);
  return frames.filter((frame) => frame.path === path);
}

/**
 * What the recipe panel says to a reader it offers the recipe to: its price or "Free recipe" on its
 * badge, what an unlock gives them, and the ways to get it.
 */
const RECIPE_OFFER = /Free recipe|Get free recipe|Get the full recipe|Unlock the full recipe|Pay \$|Use [\d,]+ credits|Sign in to see your credit balance/;
/** The free recipe's offer in the panel: its badge, then its button. */
const FREE_RECIPE_OFFER = /Free recipe[\s\S]*Get free recipe/;
/** The paid recipe's offer in the panel: its badge, then its two ways to pay. */
const PAID_RECIPE_OFFER = /\$9\.00 · 900 credits[\s\S]*Pay \$9\.00[\s\S]*Use 900 credits/;
/** The creator's own words in the panel: their recipe, held until their own read of it lands. */
const OWN_RECIPE_PANEL = /^RECIPE Your recipe\b/;
/**
 * The panel while a signed-in reader's own read of the recipe is out: held, neither offered nor
 * called theirs (owner, 2026-11-18: "Yes, hold it").
 */
const CHECKING_RECIPE_PANEL = /^RECIPE Checking…[\s\S]*Checking your recipes…/;
/** The panel once a reader's own read says the recipe is theirs, bought or opened free. */
const UNLOCKED_RECIPE_PANEL = /^RECIPE Unlocked\b/;

/**
 * The recipe panel as a visitor reads it: offered in every frame it is drawn whole in, and never in
 * the creator's words in any frame.
 */
function expectRecipeOfferedInEveryFrame(frames: RecipeFrame[], offer: RegExp) {
  const all = JSON.stringify(frames);
  const whole = frames.filter((frame) => frame.whole && frame.text !== null);
  expect(whole.length, all).toBeGreaterThan(0);
  expect(whole.filter((frame) => !offer.test(frame.text ?? '')), all).toEqual([]);
  expect(frames.filter((frame) => /Your recipe|Opening your recipe/.test(frame.text ?? '')), all).toEqual([]);
}

/**
 * The recipe panel as anyone else signed in reads it: held in every frame it is drawn whole in until
 * their own read of the recipe says, then `then` (the offer, or "Unlocked" for a recipe they have),
 * and never in the creator's words in any frame. A recipe they have is offered to them in no frame.
 */
function expectRecipeHeldForReader(frames: RecipeFrame[], then: RegExp) {
  const all = JSON.stringify(frames);
  const whole = frames.filter((frame) => frame.whole && frame.text !== null);
  expectStepsInOrder(whole.map((frame) => frame.text), [CHECKING_RECIPE_PANEL, then], all);
  expect(frames.filter((frame) => /Your recipe|Opening your recipe/.test(frame.text ?? '')), all).toEqual([]);
  // Held means offering nothing: no frame both holds the recipe and offers it.
  expect(frames.filter((frame) => /Checking…/.test(frame.text ?? '') && RECIPE_OFFER.test(frame.text ?? '')), all).toEqual([]);
  if (then === UNLOCKED_RECIPE_PANEL) {
    expect(frames.filter((frame) => RECIPE_OFFER.test(frame.text ?? '')), all).toEqual([]);
  }
}

/**
 * The creator's own recipe in the panel, in every frame: theirs ("Your recipe"), offered to them in
 * none (no price, "Free recipe" or way to get it), its body held while their own read of it is out.
 */
function expectOwnRecipeInEveryFrame(frames: RecipeFrame[]) {
  const all = JSON.stringify(frames);
  const whole = frames.filter((frame) => frame.whole && frame.text !== null);
  expect(whole.length, all).toBeGreaterThan(0);
  expect(whole.filter((frame) => !OWN_RECIPE_PANEL.test(frame.text ?? '')), all).toEqual([]);
  expect(frames.filter((frame) => RECIPE_OFFER.test(frame.text ?? '')), all).toEqual([]);
}

/** A frame at 60 Hz: how long the last frame recorded is taken to stay. */
const FRAME_MS = 17;
/** How long, in all, the Comments panel may be drawn with the parser inside it (`commentsParsing`). */
const PARSER_INSIDE_COMMENTS_MS = 500;

/** How long the frames drawn with the parser inside the Comments panel stayed on screen, in all. */
function parserInsideComments(frames: Frame[]): number {
  return frames.reduce((total, frame, index) => (
    frame.commentsParsing ? total + (frames[index + 1]?.at ?? frame.at + FRAME_MS) - frame.at : total
  ), 0);
}

/** Lets two frames pass, so what the page has committed has been drawn, and recorded. */
async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/**
 * Waiting for the page to ask for its session check, polled often: the time a check is held for
 * comes out of its deadline (SESSION_CHECK_DEADLINE_MS, 4.5 s from when the check began).
 */
const CHECK_ASKED = { ...COLD_PAGE, intervals: [50] };

/** The rail's pointer to the post's free recipe, as anyone but its creator reads it. */
const FREE_RECIPE_LINK = 'Free recipe View';
/** The same pointer as the recipe's creator reads it. */
const OWN_RECIPE_LINK = 'Your recipe View';
/**
 * The same pointer while a signed-in reader's own read of the recipe is out: neither its price nor
 * "Unlocked", which only that read can tell apart (owner, 2026-11-18: "Yes, hold it").
 */
const CHECKING_RECIPE_LINK = 'Recipe View';
/** The same pointer once a reader's own read says the recipe is theirs, bought or opened free. */
const UNLOCKED_RECIPE_LINK = 'Unlocked View';
/** The post's Remix for anyone without its free recipe: taking the recipe on the way. */
const FREE_REMIX = 'Remix · Free';
/** The open Remix, the creator's of their own creation: nothing to take or unlock. */
const OPEN_REMIX = 'Remix';

/**
 * The rail as the reader keeps it: the same in every frame it was drawn in, but for its pointer to the
 * recipe, which reads `recipeLinks` in order (a signed-in reader's is held until their own read of
 * the recipe says).
 */
function expectSteadyRail(frames: Frame[], reader: 'signed in' | 'signed out', recipeLinks: string | string[] = FREE_RECIPE_LINK) {
  const all = JSON.stringify(frames);
  expect(frames.length, 'frames of the rail').toBeGreaterThan(0);
  // A frame painted from part of the page's HTML, before the rail's rows have streamed in, has no
  // Comments yet and shows none of the rows: CI's dev server sends the page in pieces and Chrome
  // paints what it has (CI run of 2026-11-17, #838). One painted with the parser inside the Comments
  // panel has its header and not yet the composer's place at its end (`commentsParsing`, #883's CI
  // run of 2026-11-19). What a frame must show is asked of the frames with Comments drawn whole;
  // what no frame may show is asked of every frame.
  const drawn = frames.filter((frame) => frame.commentsOffset !== null && !frame.commentsParsing);
  expect(drawn.length, all).toBeGreaterThan(0);
  // The parser's stops are each on screen until the next frame: together they stay short, or the
  // page held the panel half-drawn, a fault of its own this must not hide.
  expect.soft(parserInsideComments(frames), `the Comments panel drawn with the parser inside it: ${all}`)
    .toBeLessThan(PARSER_INSIDE_COMMENTS_MS);
  // A signed-in reader is never offered sign-in, and a signed-out one always is.
  expect(frames.filter((frame) => reader === 'signed in' && frame.signInShown), all).toEqual([]);
  expect(drawn.filter((frame) => reader === 'signed out' && !frame.signInShown), all).toEqual([]);
  // Report user and Block user are a signed-in reader's who is not the post's creator.
  expect(frames.filter((frame) => reader === 'signed out' && frame.reportUserShown), all).toEqual([]);
  expect(drawn.filter((frame) => reader === 'signed in' && !frame.reportUserShown), all).toEqual([]);
  // Anyone but the creator may report the post, and only the creator has Owner tools.
  expect(frames.filter((frame) => frame.ownerToolsShown), all).toEqual([]);
  expect(drawn.filter((frame) => !frame.reportPostShown), all).toEqual([]);
  // Nothing drawn late above Comments moved it.
  const offsets = new Set(frames.map((frame) => frame.commentsOffset).filter((offset) => offset !== null));
  expect([...offsets], all).toHaveLength(1);
  // The thread, once drawn, is not taken away and drawn again.
  const firstDrawn = frames.findIndex((frame) => frame.comments > 0);
  expect(firstDrawn, all).toBeGreaterThanOrEqual(0);
  expect(frames.slice(firstDrawn).filter((frame) => frame.comments === 0), all).toEqual([]);
  // The recipe as the reader is told it, in every frame the rail is drawn in: offered to a visitor
  // from the first, and to anyone else signed in held until their own read of it says.
  expectStepsInOrder(drawn.map((frame) => frame.recipeLink), typeof recipeLinks === 'string' ? [recipeLinks] : recipeLinks, all);
}

/** A signed-in reader's pointer to the post's free recipe: held, then offered once their own read has said. */
const READERS_FREE_RECIPE_LINKS = [CHECKING_RECIPE_LINK, FREE_RECIPE_LINK];
/** A signed-in reader's Remix of a post its free recipe locks: the open one, inert, then offered with the recipe. */
const READERS_FREE_REMIXES = [OPEN_REMIX, FREE_REMIX];

/**
 * The recipe's bar along the bottom edge, below 1180px, for a signed-in reader it is offered to: in no
 * frame while their own read of the recipe is out, and in every frame from the one that offers it.
 */
function expectBarOnceOffered(frames: Frame[], offeredLink: string, bar: string) {
  const all = JSON.stringify(frames);
  expect(frames.filter((frame) => frame.recipeLink === CHECKING_RECIPE_LINK && frame.recipeBar !== null), all).toEqual([]);
  const firstOffered = frames.findIndex((frame) => frame.recipeLink === offeredLink);
  expect(firstOffered, all).toBeGreaterThanOrEqual(0);
  expect(frames.slice(firstOffered).filter((frame) => !frame.recipeBar?.startsWith(bar)), all).toEqual([]);
}

/**
 * The creator's own recipe as they keep it on their own post: theirs in every frame, and never
 * offered to them, in the rail or along the bottom edge.
 */
function expectOwnRecipe(frames: Frame[]) {
  const all = JSON.stringify(frames);
  expect(frames.some((frame) => frame.recipeLink === OWN_RECIPE_LINK), all).toBe(true);
  expect(frames.filter((frame) => frame.recipeLink !== null && frame.recipeLink !== OWN_RECIPE_LINK), all).toEqual([]);
  expect(frames.filter((frame) => frame.recipeBar !== null), all).toEqual([]);
}

/**
 * What only the post's creator gets on their own post, the same in every frame: Owner tools, or their
 * place, and never a report of their own post or of themselves; their recipe as theirs, with no bar
 * offering it; Comments where it stays.
 */
function expectCreatorsOwnRail(frames: Frame[]) {
  const all = JSON.stringify(frames);
  expect(frames.length, 'frames of the rail').toBeGreaterThan(0);
  // As in `expectSteadyRail`: a frame painted from part of the page's HTML has no Comments yet and
  // can end between the recipe link and Owner tools (#852's CI run of 2026-11-17 painted one), so
  // what a frame must show is asked of the frames with Comments drawn.
  const drawn = frames.filter((frame) => frame.commentsOffset !== null);
  expect(drawn.length, all).toBeGreaterThan(0);
  expect(frames.filter((frame) => frame.reportPostShown || frame.reportUserShown), all).toEqual([]);
  expect(drawn.filter((frame) => !frame.ownerToolsShown), all).toEqual([]);
  const offsets = new Set(frames.map((frame) => frame.commentsOffset).filter((offset) => offset !== null));
  expect([...offsets], all).toHaveLength(1);
  expectOwnRecipe(frames);
}

/**
 * The rail as the post's creator keeps it on their own post while their session is checked within
 * its deadline: their own parts, and never an offer to sign in.
 */
function expectOwnerRail(frames: Frame[]) {
  expectCreatorsOwnRail(frames);
  expect(frames.filter((frame) => frame.signInShown), JSON.stringify(frames)).toEqual([]);
}

const rail = (page: Page) => page.getByTestId('canonical-post-actions');
const composer = (page: Page) => rail(page).getByRole('textbox', { name: 'Write a comment' });

/**
 * Loads the post once, unmeasured and with the session check answered at once, before the load
 * whose frames are read: `next dev` then has the page and supabase-js compiled, and the measured
 * load starts its check as a built page does, as soon as it has drawn. The check is timed from
 * supabase-js's arrival (SESSION_CHECK_START_DEADLINE_MS, 8 s, for one not yet begun; then
 * SESSION_CHECK_DEADLINE_MS, 4.5 s, from its start), and supabase-js is a client chunk `next dev`
 * compiles on its first use: on CI that compile outlasted the deadline, and the page drew the
 * reader's own parts as a visitor's (their composer's place offering sign-in, the report rows with
 * no composer) before the held check was released, which the frame checks rejected (#864's and
 * #865's runs, 2026-11-17; #855's took 8.2 s). Built for production, the chunk comes with the page,
 * as the reel's did (explore-reel-open.spec.ts, #850). The reader's composer is the sign the check
 * has named them, so supabase-js has loaded. Not for the tests that hold the check past its
 * deadline on purpose; the tests that open the post from the Marketplace have supabase-js from the
 * Marketplace's own load, whose top bar is waited for before the check is held.
 */
async function warmSessionCheck(page: Page, path: string) {
  await page.goto(path);
  await expect(composer(page)).toBeVisible(COLD_PAGE);
}

/**
 * Whether the document's React root has committed its hydration, which only the page's script
 * does: its router then takes a navigation (login-typed-before-script.spec.ts says why the root's
 * record, and not a `__reactFiber$` key, is the sign).
 */
function hydrationCommitted(page: Page) {
  return page.evaluate(() => {
    type HostRoot = { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } };
    const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
    const root = key ? (document as unknown as Record<string, HostRoot>)[key] : undefined;
    return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
  });
}

/** How long a push is given to ask the server for the post before it is taken for dropped. */
const PUSH_TAKEN_WITHIN_MS = 2_000;

/**
 * Opens the post by a client navigation, as a link of the page makes. A push made before the
 * page's script has taken the document over is dropped (the fifth gotcha in .claude/rules/e2e.md:
 * CI's run of 2026-11-16 stayed on /marketplace), so it is made after the root's commit, and made
 * again only while the router has not asked the server for the post's page: a push it has taken is
 * never repeated, since each one starts the navigation over and the post's render takes seconds
 * offline. The address is read every 100 ms, so a held session check's deadline is not spent
 * waiting to see the navigation land.
 */
async function openPostByClientNavigation(page: Page, path = POST_PATH) {
  await expect.poll(() => hydrationCommitted(page), COLD_PAGE).toBe(true);
  let taken = false;
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname === path && (url.searchParams.has('_rsc') || request.headers().rsc === '1')) taken = true;
  };
  page.on('request', onRequest);
  try {
    let lastPush = -Infinity;
    await expect.poll(async () => {
      const push = !taken && Date.now() - lastPush >= PUSH_TAKEN_WITHIN_MS;
      if (push) lastPush = Date.now();
      return page.evaluate(({ href, pushNow }) => {
        if (pushNow && window.location.pathname !== href) {
          (window as unknown as { next: { router: { push: (target: string) => void } } }).next.router.push(href);
        }
        return window.location.pathname;
      }, { href: path, pushNow: push });
    }, { ...COLD_PAGE, intervals: [100] }).toBe(path);
  } finally {
    page.off('request', onRequest);
  }
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a post opened from the Marketplace draws a signed-in reader\'s composer and rail from its first frame, while the session is checked', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { checks } = await signIn(context);
  await answerApi(page);
  await page.addInitScript(RECORDER);

  // Offline, the storefront's own server read fails and it draws its error card; the way out of it
  // is a client navigation as a recipe's link makes, which is what this is about.
  await page.goto('/marketplace');
  // The top bar has the reader before the post is opened, as the recording's did.
  await expect(page.getByRole('link', { name: /^22 credits/ })).toBeVisible(COLD_PAGE);

  checks.hold();
  await openPostByClientNavigation(page);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  // The post page's provider is checking the session: held only while the rail drawn meanwhile is
  // seen, well inside the check's deadline (SESSION_CHECK_DEADLINE_MS from when it began).
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);
  // Report user and Block user hold their place, and wait for the session to act. Soft, so a rail
  // without them still reaches the frames below, which say what was drawn instead.
  await expect.soft(rail(page).getByRole('button', { name: 'Report user' })).toBeDisabled({ timeout: 1_000 });

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByRole('button', { name: 'Report user' })).toBeEnabled();
  await expect(rail(page).getByRole('button', { name: 'Block user' })).toBeEnabled();
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await rail(page).screenshot({ path: testInfo.outputPath('rail-settled.png') });

  // Their own read of the recipe fails here (answerApi), so the page's offer is theirs once it has.
  await expect(rail(page).getByTestId('recipe-jump-link')).toContainText('Free recipe');
  const frames = await recordedFrames(page);
  // Frames drawn while the session was checked, and after it.
  expect(frames.some((frame) => !frame.composerShown), JSON.stringify(frames)).toBe(true);
  expect(frames.at(-1)?.composerShown, JSON.stringify(frames)).toBe(true);
  expectSteadyRail(frames, 'signed in', READERS_FREE_RECIPE_LINKS);
  expectRemixInOrder(await recordedRemixFrames(page), READERS_FREE_REMIXES);
  expectRecipeHeldForReader(await recordedRecipeFrames(page), FREE_RECIPE_OFFER);
});

test('a signed-in reader who loads a post draws its composer and rail from the first frame, while the session is checked', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { checks } = await signIn(context);
  await answerApi(page);
  await warmSessionCheck(page, POST_PATH);
  checks.hold();
  await page.addInitScript(RECORDER);

  await page.goto(POST_PATH);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  // A check is asked for once the page's script has run: held only while the rail drawn meanwhile
  // is seen, well inside the check's deadline.
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByRole('button', { name: 'Report user' })).toBeEnabled();
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  // Their own read of the recipe fails here (answerApi), so the page's offer is theirs once it has.
  await expect(rail(page).getByTestId('recipe-jump-link')).toContainText('Free recipe');

  const frames = await recordedFrames(page);
  expect(frames.some((frame) => !frame.composerShown), JSON.stringify(frames)).toBe(true);
  expect(frames.at(-1)?.composerShown, JSON.stringify(frames)).toBe(true);
  expectSteadyRail(frames, 'signed in', READERS_FREE_RECIPE_LINKS);
  expectRemixInOrder(await recordedRemixFrames(page), READERS_FREE_REMIXES);
  expectRecipeHeldForReader(await recordedRecipeFrames(page), FREE_RECIPE_OFFER);
});

test('a signed-out reader is offered sign-in where the composer goes, and no Report user, in every frame', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().route('https://example.supabase.co/**', (route) => route.fulfill({ status: 401, json: {} }));
  await answerApi(page);
  await page.addInitScript(RECORDER);

  // Loaded, then opened again by a client navigation from the Marketplace.
  await page.goto(POST_PATH);
  // The thread is read by the page's script: it has run.
  await expect(rail(page).getByText(COMMENT)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByRole('link', { name: 'Sign in to join the conversation' })).toBeVisible();
  expectSteadyRail(await recordedFrames(page), 'signed out');
  expectRecipeOfferedInEveryFrame(await recordedRecipeFrames(page), FREE_RECIPE_OFFER);

  await page.goto('/marketplace');
  await openPostByClientNavigation(page);
  await expect(rail(page).getByText(COMMENT)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByRole('link', { name: 'Sign in to join the conversation' })).toBeVisible();
  expectSteadyRail(await recordedFrames(page), 'signed out');
  expectRecipeOfferedInEveryFrame(await recordedRecipeFrames(page), FREE_RECIPE_OFFER);
});

/** Opens Owner tools, which only the real row does once the session has named its creator. */
async function expectOwnerToolsOpen(page: Page) {
  await rail(page).getByText('Owner tools').click();
  await expect(rail(page).getByRole('link', { name: 'Edit post' })).toBeVisible();
}

// Review of #838: the page's HTML is drawn once for every visitor and crawler, and Owner tools are in
// it for the creator's browser to show before the first paint. Hidden, a link is still a link: every
// post page carried its /post/<id>/edit links, the visibility menu, Archive and Delete, and each crawl
// of an edit link is a function invocation that redirects to sign-in. The HTML holds the row alone.
test("a post page's HTML, which every visitor and crawler gets, carries no owner link or action", async ({ page }) => {
  const response = await page.request.get(POST_PATH, { timeout: 0 });
  expect(response.status()).toBe(200);
  const html = await response.text();
  // Drawn for the creator's browser to show before the first paint: the row alone.
  expect(html).toContain('Owner tools');
  expect(html).not.toContain(`/post/${POST_ID}/edit`);
  for (const action of ['Edit post', 'Manage recipe', `Visibility of ${TITLE}`]) {
    expect(html).not.toContain(action);
  }
});

// Review of #833: the server draws Report user and Block user for any browser with a session
// cookie, and on the creator's own post the row showed until the page's script found whose cookie it
// was, then went, and Comments jumped up. Before #833 the creator never saw it.
// Sweep of 2026-11-17 (build 941e2a55b): the same post drew "Report post or recipe" in Owner tools'
// place until the check named the creator, about 16 frames on a client navigation.
test("the post's creator, loading their own post, has Owner tools from the first frame and never a report row", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { checks } = await signIn(context, postCreator);
  await answerApi(page);
  await warmSessionCheck(page, POST_PATH);
  checks.hold();
  await page.addInitScript(RECORDER);

  await page.goto(POST_PATH);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);

  checks.release();
  // The check names the creator, and their tools work from here on (opened after the frames are
  // read: an open row moves Comments down, as the reader asked).
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  const frames = await recordedFrames(page);
  await expectOwnerToolsOpen(page);
  // Their own Remix, open in every frame: asked first, as a failure of the rail's would hide it.
  expectRemixInEveryFrame(await recordedRemixFrames(page), OPEN_REMIX);
  // Their recipe under the post, theirs in every frame (sweep of 2026-11-17: "Free recipe" and
  // "Get free recipe" until their own read landed).
  expectOwnRecipeInEveryFrame(await recordedRecipeFrames(page));
  expectOwnerRail(frames);
});

test("the post's creator, opening their own post from the Marketplace, has Owner tools from the first frame and never a report row", async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { checks } = await signIn(context, postCreator);
  await answerApi(page);
  await page.addInitScript(RECORDER);

  await page.goto('/marketplace');
  await expect(page.getByRole('link', { name: /^22 credits/ })).toBeVisible(COLD_PAGE);

  checks.hold();
  await openPostByClientNavigation(page);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await rail(page).screenshot({ path: testInfo.outputPath('owner-rail-while-session-checked.png') });

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  const frames = await recordedFrames(page);
  await expectOwnerToolsOpen(page);
  // Their own Remix, open in every frame: asked first, as a failure of the rail's would hide it.
  expectRemixInEveryFrame(await recordedRemixFrames(page), OPEN_REMIX);
  expectOwnRecipeInEveryFrame(await recordedRecipeFrames(page));
  expectOwnerRail(frames);
});

/**
 * The room under the post, from the end of its column to the end of the page: the page's own
 * 1.5rem, and 5rem more while the recipe's bar floats along the bottom edge.
 */
function roomUnderThePost(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector('.canonical-post-shell');
    const pageBody = shell?.parentElement;
    return shell && pageBody
      ? Math.round(pageBody.getBoundingClientRect().bottom - shell.getBoundingClientRect().bottom)
      : null;
  });
}

// Live sweep of 2026-11-17: on their own post the creator was offered their own
// recipe, "Free recipe · View" in the rail and, below 1180px, "View free recipe" along the bottom
// edge, until their own read of the recipe landed (live, the post later read "Your recipe · View").
// The page is drawn once for everyone and the recipe's words came only from that read. Here the read
// never answers (answerApi), so whatever the creator is shown comes from the page alone.
test("the post's creator, loading their own post below 1180px, reads their recipe as theirs and is offered no bar for it, from the first frame", async ({ page, context }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const { checks } = await signIn(context, postCreator);
  await answerApi(page);
  await warmSessionCheck(page, POST_PATH);
  checks.hold();
  await page.addInitScript(RECORDER);

  await page.goto(POST_PATH);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);
  // Review of #847's second round: while the check runs their Remix waits for it, as their Owner
  // tools do; a press would have sent them to sign in. Soft, so the frames below still say the rest.
  const ownRemix = page.getByTestId('media-detail-document').getByRole('button', { name: 'Remix', exact: true });
  await expect.soft(ownRemix).toBeDisabled({ timeout: 1_000 });

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  await expect(ownRemix).toBeEnabled();
  const frames = await recordedFrames(page);
  // Their own Remix, open in every frame: asked first, as a failure of the rail's would hide it.
  expectRemixInEveryFrame(await recordedRemixFrames(page), OPEN_REMIX);
  expectOwnRecipeInEveryFrame(await recordedRecipeFrames(page));
  expectOwnerRail(frames);
  // No room is kept under the post for a bar that is never drawn.
  expect(await roomUnderThePost(page)).toBeLessThan(40);

  // Their Remix starts the remix as its owner, with no recipe to take on the way.
  const claims: string[] = [];
  const remixes: Array<string | null> = [];
  await page.route(`**/api/posts/${POST_ID}/resource-bundle/unlock-free`, (route) => {
    claims.push(route.request().url());
    return route.fulfill({ status: 500, json: { error: 'Not answered offline' } });
  });
  await page.route('**/api/showcase/remix', (route) => {
    remixes.push(route.request().postData());
    return route.fulfill({ json: { success: true, redirectTo: '#remix-started' } });
  });
  await ownRemix.click();
  await expect.poll(() => remixes).toEqual([JSON.stringify({ postId: POST_ID })]);
  expect(claims).toEqual([]);
});

test('a signed-in reader below 1180px is offered a free recipe that is not theirs, in the rail and along the bottom edge, from the frame their own read says so', async ({ page, context }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const { checks } = await signIn(context);
  await answerApi(page);
  await warmSessionCheck(page, POST_PATH);
  checks.hold();
  await page.addInitScript(RECORDER);

  await page.goto(POST_PATH);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  // Their own read of the recipe fails here (answerApi), so the page's offer is theirs once it has.
  await expect(rail(page).getByTestId('recipe-jump-link')).toContainText('Free recipe');
  const frames = await recordedFrames(page);
  expectSteadyRail(frames, 'signed in', READERS_FREE_RECIPE_LINKS);
  expectRemixInOrder(await recordedRemixFrames(page), READERS_FREE_REMIXES);
  expectRecipeHeldForReader(await recordedRecipeFrames(page), FREE_RECIPE_OFFER);
  expectBarOnceOffered(frames, FREE_RECIPE_LINK, 'View free recipe');
  // The post's end scrolls clear of the bar.
  expect(await roomUnderThePost(page)).toBeGreaterThan(90);
});

// Review of #847: the paid recipe's words differ from the creator's in both halves of the rail's
// pointer ("$9.00 · 900 credits · Unlock" against "Your recipe · View"), and its locked Remix is a
// link to the recipe ("Remix · 900 credits") where the free one's takes it on the way.
/** The paid recipe's pointer, its locked Remix and its bar, as anyone but its creator reads them. */
const PAID_RECIPE_LINK = '$9.00 · 900 credits Unlock';
const PAID_REMIX = 'Remix · 900 credits';
const PAID_RECIPE_BAR = 'Unlock recipe for $9.00 · 900 credits';

test("the post's creator, loading their own post with a paid recipe below 1180px, reads it as theirs and remixes it openly, from the first frame", async ({ page, context }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const { checks } = await signIn(context, paidPostCreator);
  await answerApi(page, [], PAID_POST);
  await warmSessionCheck(page, PAID_POST.path);
  checks.hold();
  await page.addInitScript(RECORDER);

  await page.goto(PAID_POST.path);
  await expect(page.getByRole('heading', { level: 1, name: PAID_POST.title })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  const frames = await recordedFrames(page, { path: PAID_POST.path });
  // Their own Remix, open in every frame: asked first, as a failure of the rail's would hide it.
  expectRemixInEveryFrame(await recordedRemixFrames(page, { path: PAID_POST.path }), OPEN_REMIX);
  expectOwnRecipeInEveryFrame(await recordedRecipeFrames(page, { path: PAID_POST.path }));
  expectOwnerRail(frames);
  expect(await roomUnderThePost(page)).toBeLessThan(40);
});

test('a signed-in reader below 1180px is offered a paid recipe that is not theirs at its price, in the rail, in Remix and along the bottom edge, from the frame their own read says so', async ({ page, context }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const { checks } = await signIn(context);
  await answerApi(page, [], PAID_POST);
  await warmSessionCheck(page, PAID_POST.path);
  checks.hold();
  await page.addInitScript(RECORDER);

  await page.goto(PAID_POST.path);
  await expect(page.getByRole('heading', { level: 1, name: PAID_POST.title })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  // Their own read of the recipe fails here (answerApi), so the page's offer is theirs once it has.
  await expect(rail(page).getByTestId('recipe-jump-link')).toContainText('$9.00');
  const frames = await recordedFrames(page, { path: PAID_POST.path });
  expectRemixInOrder(await recordedRemixFrames(page, { path: PAID_POST.path }), [OPEN_REMIX, PAID_REMIX]);
  expectRecipeHeldForReader(await recordedRecipeFrames(page, { path: PAID_POST.path }), PAID_RECIPE_OFFER);
  expectSteadyRail(frames, 'signed in', [CHECKING_RECIPE_LINK, PAID_RECIPE_LINK]);
  expectBarOnceOffered(frames, PAID_RECIPE_LINK, PAID_RECIPE_BAR);
  expect(await roomUnderThePost(page)).toBeGreaterThan(90);
});

/**
 * A reader's own read of a recipe they have, bought or opened free: all of it, theirs to read and not
 * theirs to own, as the route answers it (post-resource-bundle-route-adapter-service.ts).
 */
function heldRecipeRead(postId: string, bundle: typeof freeRecipePost.bundle | typeof paidRecipePost.bundle) {
  const paid = bundle.access_mode === 'paid';
  return {
    success: true,
    bundle: {
      id: bundle.id,
      postId,
      title: bundle.title,
      summary: '',
      previewText: '',
      accessMode: bundle.access_mode,
      priceUsdCents: bundle.price_usd_cents,
      priceQuote: { currency: 'USD', amountSubunits: bundle.price_usd_cents, formatted: paid ? '$9.00' : 'Free', note: null },
      status: 'published',
      allowRemix: true,
      resourceKinds: ['prompt', 'remix'],
      lockedPreview: null,
      salesCount: paid ? 1 : 0,
      freeUnlockCount: paid ? 0 : 1,
      viewerCanAccess: true,
      viewerIsOwner: false,
      viewerHasPurchased: true,
      resources: {
        promptText: bundle.prompt_text,
        notesMarkdown: null,
        workflowShareUrl: null,
        workflowSnapshot: null,
        attachments: [],
        allowRemix: true,
      },
      purchasedRevision: null,
    },
  };
}

// Sweep of 2026-11-18: a reader who had a post's recipe was offered it until their own read of it
// landed, about a second: its price or "Free recipe" in the rail, the Remix locked behind it, "Get
// free recipe" in the panel under the post and the bar along the bottom edge, then "Unlocked". The
// page is drawn once for everyone, with the recipe as a visitor reads it, and only the reader's own
// read says whether they have it, so until it lands the page holds the recipe for anyone signed in
// (owner, 2026-11-18: "Yes, hold it"). The read is answered here, as theirs.
test("a signed-in reader who bought a post's recipe, loading it below 1180px, is offered it in no frame, and has it once their own read lands", async ({ page, context }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const { checks, accessToken } = await signIn(context);
  await answerApi(page, [], PAID_POST);
  const recipeReads: string[] = [];
  await page.route(`**/api/posts/${PAID_POST.id}/resource-bundle**`, (route) => {
    recipeReads.push(route.request().headers().authorization ?? '');
    return route.fulfill({ json: heldRecipeRead(PAID_POST.id, paidRecipePost.bundle) });
  });
  await warmSessionCheck(page, PAID_POST.path);
  checks.hold();
  await page.addInitScript(RECORDER);
  const remix = page.getByTestId('media-detail-document').getByRole('button', { name: 'Remix', exact: true });

  await page.goto(PAID_POST.path);
  await expect(page.getByRole('heading', { level: 1, name: PAID_POST.title })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);
  // While their read waits for the check, their Remix waits for it. Soft, so the frames below say
  // what was drawn instead.
  await expect.soft(remix).toBeDisabled({ timeout: 1_000 });

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByTestId('recipe-jump-link')).toContainText('Unlocked');
  await expect(page.getByTestId('canonical-post-recipe').getByText(paidRecipePost.bundle.prompt_text)).toBeVisible();
  await expect(remix).toBeEnabled();
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  expect(recipeReads.at(-1)).toBe(`Bearer ${accessToken}`);
  const frames = await recordedFrames(page, { path: PAID_POST.path });
  // Asked first, as a failure of the rail's would hide them.
  expectRemixInEveryFrame(await recordedRemixFrames(page, { path: PAID_POST.path }), OPEN_REMIX);
  expectRecipeHeldForReader(await recordedRecipeFrames(page, { path: PAID_POST.path }), UNLOCKED_RECIPE_PANEL);
  expectSteadyRail(frames, 'signed in', [CHECKING_RECIPE_LINK, UNLOCKED_RECIPE_LINK]);
  // No bar, and no room kept for one, in any frame.
  expect(frames.filter((frame) => frame.recipeBar !== null), JSON.stringify(frames)).toEqual([]);
  expect(await roomUnderThePost(page)).toBeLessThan(40);
});

test("a signed-in reader who has a post's free recipe, opening it from the Marketplace, is offered it in no frame, and has it once their own read lands", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { checks } = await signIn(context);
  await answerApi(page);
  await page.route(`**/api/posts/${POST_ID}/resource-bundle**`, (route) => (
    route.fulfill({ json: heldRecipeRead(POST_ID, freeRecipePost.bundle) })
  ));
  await page.addInitScript(RECORDER);

  await page.goto('/marketplace');
  await expect(page.getByRole('link', { name: /^22 credits/ })).toBeVisible(COLD_PAGE);

  checks.hold();
  await openPostByClientNavigation(page);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByTestId('recipe-jump-link')).toContainText('Unlocked');
  await expect(page.getByTestId('canonical-post-recipe').getByText(freeRecipePost.bundle.prompt_text)).toBeVisible();
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  const frames = await recordedFrames(page);
  expectRemixInEveryFrame(await recordedRemixFrames(page), OPEN_REMIX);
  expectRecipeHeldForReader(await recordedRecipeFrames(page), UNLOCKED_RECIPE_PANEL);
  expectSteadyRail(frames, 'signed in', [CHECKING_RECIPE_LINK, UNLOCKED_RECIPE_LINK]);
});

// Review of #847's second and third rounds: a post with no creation (here a picture made elsewhere,
// whose free recipe holds a reference picture and does not include the post's Remix) has nothing
// to remix: the server answers its Remix "Only generation-backed posts can be remixed". Its creator
// gets no Remix, as nobody else does, in any frame: round 3 drew them a dead-end open Remix, and
// before that it came in after the page's script, moving Save, Comment and Share along the row.
test("the post's creator, on a post with no creation, has no Remix in any frame, as nobody else does", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { checks } = await signIn(context, uploadPostCreator);
  await answerApi(page, [], UPLOAD_POST);
  await warmSessionCheck(page, UPLOAD_POST.path);
  checks.hold();
  await page.addInitScript(RECORDER);

  await page.goto(UPLOAD_POST.path);
  await expect(page.getByRole('heading', { level: 1, name: UPLOAD_POST.title })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  const frames = await recordedFrames(page, { path: UPLOAD_POST.path });
  // No Remix in any frame: asked first, as a failure of the rail's would hide it.
  expectRemixInEveryFrame(await recordedRemixFrames(page, { path: UPLOAD_POST.path }), '');
  expectOwnRecipeInEveryFrame(await recordedRecipeFrames(page, { path: UPLOAD_POST.path }));
  expectOwnerRail(frames);
});

test('a signed-in reader is offered no Remix in any frame where the recipe does not include it', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { checks } = await signIn(context);
  await answerApi(page, [], UPLOAD_POST);
  await warmSessionCheck(page, UPLOAD_POST.path);
  checks.hold();
  await page.addInitScript(RECORDER);

  await page.goto(UPLOAD_POST.path);
  await expect(page.getByRole('heading', { level: 1, name: UPLOAD_POST.title })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  // Their own read of the recipe fails here (answerApi), so the page's offer is theirs once it has.
  await expect(rail(page).getByTestId('recipe-jump-link')).toContainText('Free recipe');
  const frames = await recordedFrames(page, { path: UPLOAD_POST.path });
  expectRemixInEveryFrame(await recordedRemixFrames(page, { path: UPLOAD_POST.path }), '');
  expectRecipeHeldForReader(await recordedRecipeFrames(page, { path: UPLOAD_POST.path }), FREE_RECIPE_OFFER);
  expectSteadyRail(frames, 'signed in', READERS_FREE_RECIPE_LINKS);
});

// Review of #833: Supabase's check has no deadline of its own, and a stalled one held the thread
// unread, the composer's place inert and Report user doing nothing for as long as it stalled.
test('a session check that outlasts its deadline draws the reader as a visitor until a late answer names them', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { checks, accessToken } = await signIn(context);
  checks.hold();
  const reads: Array<string | null> = [];
  await answerApi(page, reads);

  await page.goto(POST_PATH);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  // The check has been asked for and is still within its deadline: the composer's place is held.
  await expect(rail(page).getByText('Add a comment…')).toBeVisible();
  // Past the deadline (SESSION_CHECK_DEADLINE_MS, 4.5 s from when the check began): the visitor's
  // page, as before the check was waited for.
  await expect(rail(page).getByRole('link', { name: 'Sign in to join the conversation' })).toBeVisible({ timeout: 15_000 });
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  await expect(rail(page).getByRole('button', { name: 'Report user' })).toHaveCount(0);
  expect(reads).toEqual([null]);

  // The answer comes at last: the reader's composer and row, and the thread read again for them.
  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByRole('button', { name: 'Report user' })).toBeEnabled();
  await expect.poll(() => reads).toEqual([null, `Bearer ${accessToken}`]);
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
});

// CI run of 2026-11-17 (PR #853, E2E shard 2): the creator's test above that loads their own post
// recorded their Remix as "Remix", "Remix · Free", then "Remix". The dev server had served supabase-js
// 8.2 s after the page's script ran, past the 8 s a check that has not begun is waited for
// (SESSION_CHECK_START_DEADLINE_MS), and the page drew the deadline's fallback until the held check
// named the creator: a visitor's Remix, "Free recipe" and "Report post or recipe" in place of their
// own, then theirs again. The deadline stops the page waiting for the reader's own parts (the thread
// and the composer's place, as the test above holds), never for the creator's: only the check's
// answer says the cookie is not theirs. Here the check outlasts its 4.5 s deadline instead, which
// the dev server's speed cannot change. Below 1180px, so the recipe's bar would show too.
test("the post's creator keeps their Remix, Owner tools and recipe in every frame while a session check outlasts its deadline, and has them once a late answer names them", async ({ page, context }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const { checks, accessToken } = await signIn(context, postCreator);
  checks.hold();
  const reads: Array<string | null> = [];
  await answerApi(page, reads);
  await page.addInitScript(RECORDER);

  await page.goto(POST_PATH);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  // Past the deadline the reader's own parts fall back, as for any reader: the thread is read as a
  // visitor's and the composer's place offers sign-in.
  await expect(rail(page).getByRole('link', { name: 'Sign in to join the conversation' })).toBeVisible({ timeout: 15_000 });
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  expect(reads).toEqual([null]);
  await twoFrames(page);
  // Their Remix still waits for the check, as their Owner tools do. Soft, so the frames below say
  // what was drawn instead.
  const ownRemix = page.getByTestId('media-detail-document').getByRole('button', { name: 'Remix', exact: true });
  await expect.soft(ownRemix).toBeDisabled({ timeout: 1_000 });

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect.poll(() => reads).toEqual([null, `Bearer ${accessToken}`]);
  await expect(ownRemix).toBeEnabled();
  const frames = await recordedFrames(page);
  // Their own Remix, open in every frame: asked first, as a failure of the rail's would hide it.
  expectRemixInEveryFrame(await recordedRemixFrames(page), OPEN_REMIX);
  expectOwnRecipeInEveryFrame(await recordedRecipeFrames(page));
  expectCreatorsOwnRail(frames);
  await expectOwnerToolsOpen(page);
});

// Sweep of 2026-11-17 (build 988d55079), signed in as @magicbooklet: on their own post the recipe
// panel under it read "Free recipe", with "Get free recipe" under it, for 0.4 to 1.6 s, until their
// own read of the recipe landed and the panel started again from it as "Your recipe" with "Owner
// preview". The page knew them from the first frame (the rail's pointer and Owner tools follow it
// since #847 and #855); the panel drew the recipe the page holds, a visitor's, until that read.
/** The creator's own read of their free recipe: all of it, theirs. */
const OWN_RECIPE_READ = {
  success: true,
  bundle: {
    id: freeRecipePost.bundle.id,
    postId: POST_ID,
    title: freeRecipePost.bundle.title,
    summary: '',
    previewText: '',
    accessMode: 'free',
    priceUsdCents: 0,
    priceQuote: { currency: 'USD', amountSubunits: 0, formatted: 'Free', note: null },
    status: 'published',
    allowRemix: true,
    resourceKinds: ['prompt', 'remix'],
    lockedPreview: null,
    salesCount: 0,
    freeUnlockCount: 0,
    viewerCanAccess: true,
    viewerIsOwner: true,
    viewerHasPurchased: false,
    resources: {
      promptText: freeRecipePost.bundle.prompt_text,
      notesMarkdown: null,
      workflowShareUrl: null,
      workflowSnapshot: null,
      attachments: [],
      allowRemix: true,
    },
    purchasedRevision: null,
  },
};

test("the post's creator holds their recipe as theirs until their own read of it lands, a failed one included, and is offered it in no frame", async ({ page, context }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const { checks } = await signIn(context, postCreator);
  await answerApi(page);
  // Before the read's own answers below, which the warm-up's read would otherwise spend.
  await warmSessionCheck(page, POST_PATH);
  checks.hold();
  // Their read of the recipe: refused the first time, answered after Try again.
  const recipeReads: string[] = [];
  await page.route(`**/api/posts/${POST_ID}/resource-bundle**`, (route) => {
    recipeReads.push(route.request().headers().authorization ?? '');
    return recipeReads.length === 1
      ? route.fulfill({ status: 503, json: { error: 'Not answered offline' } })
      : route.fulfill({ json: OWN_RECIPE_READ });
  });
  await page.addInitScript(RECORDER);
  const recipe = page.getByTestId('canonical-post-recipe');

  await page.goto(POST_PATH);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);
  // While the check runs: theirs, held, and nothing to get. Soft, so the frames below say what was
  // drawn instead.
  await expect.soft(recipe.getByText('Opening your recipe…')).toBeVisible({ timeout: 1_000 });
  await expect.soft(recipe.getByRole('button', { name: 'Get free recipe' })).toHaveCount(0);

  checks.release();
  // Their read goes out once the check names them, and fails: still theirs, with a way to ask again.
  await expect.poll(() => recipeReads.length, COLD_PAGE).toBe(1);
  const tryAgain = recipe.getByRole('button', { name: 'Try again' });
  await expect(tryAgain).toBeVisible(COLD_PAGE);
  await expect(recipe.getByText('The recipe could not be opened.')).toBeVisible();

  await tryAgain.click();
  await expect(recipe.getByText(/^Owner preview\./)).toBeVisible(COLD_PAGE);
  await expect(recipe.getByText(freeRecipePost.bundle.prompt_text)).toBeVisible();
  expect(recipeReads).toHaveLength(2);
  expect(new Set(recipeReads).size, 'both read with the creator\'s session').toBe(1);
  expect(recipeReads[0]).toMatch(/^Bearer /);

  await recordedFrames(page);
  const frames = await recordedRecipeFrames(page);
  const all = JSON.stringify(frames);
  expectOwnRecipeInEveryFrame(frames);
  // Held, then the read's failure, then the recipe, which stays.
  const shows = (frame: RecipeFrame, words: string) => (frame.text ?? '').includes(words);
  const held = frames.findIndex((frame) => frame.whole && shows(frame, 'Opening your recipe…'));
  const failed = frames.findIndex((frame) => shows(frame, 'The recipe could not be opened.'));
  const opened = frames.findIndex((frame) => shows(frame, 'Owner preview.'));
  expect([held >= 0, failed > held, opened > failed], all).toEqual([true, true, true]);
  expect(frames.slice(opened).filter((frame) => !shows(frame, 'Owner preview.')), all).toEqual([]);
});

// Review of #866: the creator's read of their recipe goes out only once the session check names
// them, and a check that never ends (supabase-js failing to load after a deploy, `getUser`
// hanging) held their recipe at "Opening your recipe…" for good, with nothing to press. Here the
// check is held past its deadline (SESSION_CHECK_DEADLINE_MS, 4.5 s from when it began).
test("the post's creator, whose session check outlasts its deadline, is told their recipe could not be opened, and Try again asks the check again", async ({ page, context }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const { checks } = await signIn(context, postCreator);
  checks.hold();
  await answerApi(page);
  const recipeReads: string[] = [];
  await page.route(`**/api/posts/${POST_ID}/resource-bundle**`, (route) => {
    recipeReads.push(route.request().url());
    return route.fulfill({ json: OWN_RECIPE_READ });
  });
  await page.addInitScript(RECORDER);
  const recipe = page.getByTestId('canonical-post-recipe');
  const ownRemix = page.getByTestId('media-detail-document').getByRole('button', { name: 'Remix', exact: true });

  await page.goto(POST_PATH);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  // Past the deadline: their recipe says it could not be opened, with a way to ask again...
  const tryAgain = recipe.getByRole('button', { name: 'Try again' });
  await expect(tryAgain).toBeVisible({ timeout: 15_000 });
  await expect(recipe.getByText('The recipe could not be opened.')).toBeVisible();
  // ...while their Remix still waits for the check's answer, as their Owner tools do.
  await expect(ownRemix).toBeDisabled();
  expect(recipeReads).toEqual([]);

  // Try again asks the check again, and the recipe is opening while it runs.
  const checksBefore = checks.held();
  await tryAgain.click();
  await expect.poll(checks.held, 'Try again asked the session check again').toBeGreaterThan(checksBefore);
  await expect(recipe.getByText('Opening your recipe…')).toBeVisible();

  // The check answers: their read goes out, and their recipe opens.
  checks.release();
  await expect(recipe.getByText(/^Owner preview\./)).toBeVisible(COLD_PAGE);
  await expect(ownRemix).toBeEnabled();
  expect(recipeReads).toHaveLength(1);
  await recordedFrames(page);
  expectOwnRecipeInEveryFrame(await recordedRecipeFrames(page));
});

// Sweep of 2026-11-17 (build 941e2a55b), signed in as @magicbooklet: the composer's avatar read "I",
// the first letter of the sign-in email (the account has no name in Supabase's user_metadata), where
// the top bar read "MB", from the profile's name, "Magic Booklet".
const namelessReader = { ...user, email: 'ivy.reader@example.com', user_metadata: {} };
const MAGIC_BOOKLET_PROFILE: ProfileRow = { display_name: 'Magic Booklet', avatar_url: null, credits: 22, promotional_credits: 0 };

/** The composer's avatar as the last recorded frame drew it. */
async function composerInitials(page: Page) {
  return (await recordedFrames(page, { stop: false })).at(-1)?.composerInitials ?? null;
}

/** Blank while the profile is read, then the profile's name: never a name it is not. */
function expectComposerNamedByProfile(frames: Frame[], initials: string) {
  const all = JSON.stringify(frames);
  expect(frames.filter((frame) => frame.composerInitials !== null
    && frame.composerInitials !== ''
    && frame.composerInitials !== initials), all).toEqual([]);
  expect(frames.at(-1)?.composerInitials, all).toBe(initials);
}

test("the composer's avatar names the reader as the top bar does, from their profile, never by the sign-in email", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(context, namelessReader, MAGIC_BOOKLET_PROFILE);
  await answerApi(page);
  await page.addInitScript(RECORDER);

  // Loaded...
  await page.goto(POST_PATH);
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(page.getByRole('button', { name: 'Open account menu for Magic Booklet' })).toBeVisible();
  await expect.poll(() => composerInitials(page)).toBe('MB');
  expectComposerNamedByProfile(await recordedFrames(page), 'MB');

  // ...and opened from another page, by a client navigation.
  await page.goto('/marketplace');
  await expect(page.getByRole('button', { name: 'Open account menu for Magic Booklet' })).toBeVisible(COLD_PAGE);
  await openPostByClientNavigation(page);
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect.poll(() => composerInitials(page)).toBe('MB');
  expectComposerNamedByProfile(await recordedFrames(page), 'MB');
});

/** Counts the browser's checks of the session (`/auth/v1/user`) and reads of the reader's own row. */
function countAccountReads(page: Page) {
  const asked = { sessionChecks: 0, profileReads: 0 };
  page.on('request', (request) => {
    const { hostname, pathname } = new URL(request.url());
    if (hostname !== 'example.supabase.co') return;
    if (pathname === '/auth/v1/user') asked.sessionChecks += 1;
    if (pathname === '/rest/v1/profiles') asked.profileReads += 1;
  });
  return {
    /** What was asked since the last call. */
    take() {
      const taken = { ...asked };
      asked.sessionChecks = 0;
      asked.profileReads = 0;
      return taken;
    },
  };
}

/** Long enough for a part that asks late (the composer's avatar, a top bar's slow chunk) to have asked. */
const LATE_ASKER_MS = 1_500;

// Production, 2026-11-20 (build 788a6edf2): a signed-in load of a post page asked Supabase Auth who
// the reader was twice and read their own profile row three times, the page's provider, the top bar
// and the comment composer each for itself. They share one of each now (browser-account-reads.ts). A
// post opened by a client navigation still checks the session as its page opens, as it always did,
// and its composer shares that page's read.
test("a signed-in load of a post asks Supabase Auth about the session once and reads the reader's row once", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(context);
  await answerApi(page);
  await page.addInitScript(RECORDER);
  // Compiled first, so the load counted is a whole document of its own.
  await warmSessionCheck(page, POST_PATH);
  const reads = countAccountReads(page);
  reads.take();

  await page.goto(POST_PATH);
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(page.getByRole('button', { name: 'Open account menu for Workflow User' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^22 credits/ })).toBeVisible();
  await expect.poll(() => composerInitials(page)).toBe('WU');
  await page.waitForTimeout(LATE_ASKER_MS);
  // Main: two checks and three reads.
  expect(reads.take()).toEqual({ sessionChecks: 1, profileReads: 1 });

  // A page with a provider of its own, then a post opened from it by a client navigation.
  await page.goto('/marketplace');
  await expect(page.getByRole('button', { name: 'Open account menu for Workflow User' })).toBeVisible(COLD_PAGE);
  await page.waitForTimeout(LATE_ASKER_MS);
  // Main: two and two (the storefront's provider and the top bar).
  expect(reads.take()).toEqual({ sessionChecks: 1, profileReads: 1 });

  await openPostByClientNavigation(page);
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect.poll(() => composerInitials(page)).toBe('WU');
  await page.waitForTimeout(LATE_ASKER_MS);
  // The post's provider asks as its page opens; main read the row again for the composer.
  expect(reads.take()).toEqual({ sessionChecks: 1, profileReads: 1 });
});

// Sweep of 2026-11-17 (build 941e2a55b): every post a signed-in reader opened that had no recipe
// asked for theirs, which the server answered 404, and Chrome logged "Failed to load resource" for
// it on every such post.
test('a signed-in reader of a post with no recipe logs no failed recipe read, loaded or opened from another page', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(context);
  await answerApi(page, [], PLAIN_POST);
  const recipeReads: string[] = [];
  await page.route(`**/api/posts/${PLAIN_POST.id}/resource-bundle**`, (route) => {
    const url = new URL(route.request().url());
    recipeReads.push(`${url.pathname}${url.search}`);
    // As the route answers for a post with no recipe (post-resource-bundle-route-adapter-service.ts):
    // 404, or none when it is asked to answer an absent recipe as none.
    return url.searchParams.get('absent') === 'none'
      ? route.fulfill({ json: { success: true, bundle: null } })
      : route.fulfill({ status: 404, json: { error: 'Resource bundle not found.' } });
  });
  const failedRecipeLoads: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.location().url.includes('/resource-bundle')) {
      failedRecipeLoads.push(`${message.location().url}: ${message.text()}`);
    }
  });
  /** Waits for the reader's own recipe read of this page, if it makes one, to be answered. */
  async function readAnswered(count: number) {
    await expect(composer(page)).toBeVisible(COLD_PAGE);
    await expect.poll(() => recipeReads.length).toBeGreaterThanOrEqual(count);
    await twoFrames(page);
    await page.waitForTimeout(250);
  }

  await page.goto(PLAIN_POST.path);
  await expect(page.getByRole('heading', { level: 1, name: PLAIN_POST.title })).toBeVisible(COLD_PAGE);
  await readAnswered(1);
  expect(failedRecipeLoads, JSON.stringify(recipeReads)).toEqual([]);

  await page.goto('/marketplace');
  await openPostByClientNavigation(page, PLAIN_POST.path);
  await expect(page.getByRole('heading', { level: 1, name: PLAIN_POST.title })).toBeVisible(COLD_PAGE);
  await readAnswered(2);
  expect(failedRecipeLoads, JSON.stringify(recipeReads)).toEqual([]);
});

// Main's Quality run for 0461f74b9 (2026-11-27) failed the creator's own rail on one frame: 7.3 s
// in, the HTML parser had stopped inside the rail's recipe link, so the link had its box and no word
// yet. It read as "", a recipe that was not theirs. `RECORDER` reads a link the parser is still
// inside as none (.claude/rules/e2e.md, "Frames drawn from part of the HTML"). This draws that frame
// on purpose, a document sent in two parts with the first ending inside the link, and asks it the
// check that failed. The second part is held until the page has been seen in that state with a frame
// recorded, so no timing decides it. It needs no page of the app's: the rail here is the recorder's
// own selectors.
test('a frame drawn with the HTML parser inside the recipe link reads as no link yet', async ({ page }) => {
  const firstPart = '<!doctype html><html><head><meta charset="utf-8"><title>A rail in two parts</title></head><body>'
    // Past any buffer the browser fills before it starts on a document.
    + `<!-- ${'part '.repeat(700)} -->`
    + '<div data-testid="canonical-post-actions">'
    + '<a data-testid="recipe-jump-link" href="#recipe" style="display:inline-flex;padding:8px 12px;border:1px solid">';
  const secondPart = '<span>Your recipe</span> <span>View</span></a><span>Owner tools</span>'
    + '<section data-testid="canonical-post-comments"><h2>Comments</h2></section></div></body></html>';
  let sendSecondPart = () => {};
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
    response.write(firstPart);
    let sent = false;
    sendSecondPart = () => {
      if (sent) return;
      sent = true;
      response.end(secondPart);
    };
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await page.addInitScript(RECORDER);
    await page.goto(`http://127.0.0.1:${port}/rail-in-two-parts`, { waitUntil: 'commit' });
    // The state CI drew: the document still arriving, the link's box there with no word in it, and
    // the recorder with a frame of the rail.
    await expect.poll(() => page.evaluate(() => {
      const link = document.querySelector<HTMLElement>('[data-testid="recipe-jump-link"]');
      const recorded = (window as unknown as { __railFrames?: unknown[] }).__railFrames ?? [];
      return document.readyState === 'loading' && link !== null && link.getClientRects().length > 0
        && link.innerText === '' && recorded.length > 0;
    })).toBe(true);
    // Two more frames of it, so a recorder that reads the link's empty box has recorded that.
    await twoFrames(page);
    sendSecondPart();
    await expect(page.getByTestId('canonical-post-comments')).toBeVisible();
    const frames = await recordedFrames(page, { path: '/rail-in-two-parts' });
    const all = JSON.stringify(frames);
    // The first part's frame is among them: the rail with no Comments yet.
    expect(frames.filter((frame) => frame.commentsOffset === null).length, all).toBeGreaterThan(0);
    expectOwnRecipe(frames);
  } finally {
    // A request left open would keep the server from closing.
    sendSecondPart();
    await new Promise((resolve) => server.close(resolve));
  }
});
