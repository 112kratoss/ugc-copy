# Mobile Post Flow Design

## Context

Magicbooklet should stay marketplace and community first. The mobile `+` action must not only publish Magicbooklet-generated media. It should let users create community posts from text, uploaded media made in external tools, and Magicbooklet creations, with optional unlockable marketplace resources.

This design follows the approved mockup order:

1. Title
2. Content
3. Caption / body
4. Source
5. Category
6. Unlockables
7. Preview
8. Publish

Reference mockups are in `mockups/mobile-post-flow/`.

## Goals

- Make posting feel like creating a community post first, then optionally turning it into a marketplace listing.
- Support text posts, uploaded media posts from external tools, and Magicbooklet creation posts.
- Preserve a fast default path: users can publish a normal public post without touching unlockable settings.
- Make unlockables prominent but optional: no unlock, free unlock, or paid unlock.
- After publishing, show the post in the immersive TikTok-style viewer so the user immediately sees the community-facing result.

## Entry Flow

The center `+` opens a `MagicCreateMenu` overlay with two actions:

- `Create`: opens the existing creator tab where users choose Image, AI Video, or Motion.
- `Post`: opens the universal mobile post composer at `/post/new`.

The menu keeps the first decision simple. Creation remains a tool path; posting remains the community and marketplace path.

## Composer Layout

The composer is a single-screen ordered form, not a multi-step wizard.

The first fields are always the public post fields:

- `Title`: short name or hook for the post.
- `Content`: a segmented choice between `Text`, `Upload`, and `Creation`.
- `Caption / body`: public explanation shown under the post.
- `Source`: attribution such as Magicbooklet, Runway, Midjourney, Sora, Kling, CapCut, Other, or manual.
- `Category`: image, video, motion, text, UGC ad, prompt, or other supported marketplace category.

The unlock row appears after those public fields:

- `No unlock`: default.
- `Free unlock`: attaches resources that users can unlock without credits.
- `Paid unlock`: attaches resources with a credit or price requirement.

When `No unlock` is selected, the form stays short and ends with `Preview post` and `Post now`.

When `Free unlock` or `Paid unlock` is selected, the marketplace section expands below the public fields.

## Content Modes

`Text` mode creates text-first posts. The content/body should render in feed previews and in the immersive viewer as readable text, not as missing media.

`Upload` mode supports media created outside Magicbooklet. The user can upload image/video files, or use an already uploaded media storage path where the app has one, and provide source attribution. This mode maps to the existing `/api/posts` behavior instead of the Magicbooklet generation publish endpoint.

`Creation` mode lists recent succeeded Magicbooklet generations. Publishing a selected creation continues to use the existing generation publish flow, with optional resource bundle support.

## Marketplace Section

The marketplace section is only visible when the user chooses `Free unlock` or `Paid unlock`.

It includes:

- Resource kinds: prompt, workflow, files, notes, remix.
- Buyer preview text.
- Private unlock content fields for the selected resource kinds.
- Price or credit settings for paid unlocks.
- A readiness state that explains what buyers will receive before publish.

The public post remains visually above the marketplace section so users understand what everyone sees versus what buyers unlock.

## Publish Behavior

Publishing a normal text or uploaded-media post uses the existing `/api/posts` FormData endpoint.

Publishing a Magicbooklet generation uses the existing `/api/showcase/publish` endpoint.

After publish succeeds:

- Seed relevant mobile caches for feed/profile where practical.
- Navigate to the immersive viewer with the new post as the initial item.
- Keep the viewer free of comments/search for this version.
- The viewer should support the existing left-swipe details page for prompt/resource details.

## Error Handling

If the user is signed out, opening `/post/new` redirects to auth and returns to the composer afterward when possible.

If upload fails, keep entered title, caption, source, category, and unlock fields intact.

If generation publishing fails, show the specific publish error and keep the selected creation.

If unlock resource upload fails, keep the post draft locally in memory and let the user retry the failed attachment.

## Implementation Units

- `MagicCreateMenu`: reusable `+` overlay with `Create` and `Post`.
- `PostComposerScreen`: mobile `/post/new` screen with the ordered layout.
- `post-composer-view-model`: mode state, validation, source/category options, unlock state, and submit payload construction.
- Mobile API client additions for `/api/posts` FormData post creation while keeping `publishGeneration`.
- Shared preview mapping into the existing immersive viewer item model.

## Validation Rules

- Title is required for all posts.
- Text posts require text content or caption/body.
- Upload posts require a file or an existing uploaded media storage path.
- Creation posts require a selected succeeded generation.
- Paid unlocks require a valid price or credit amount.
- Unlockable resources require at least one selected resource kind and buyer preview text.

## Testing

Unit tests should cover:

- Create menu action definitions.
- Composer mode transitions for text, upload, and creation.
- Validation for normal posts, free unlocks, and paid unlocks.
- Payload construction for `/api/posts` and `/api/showcase/publish`.
- Viewer navigation metadata after publish.

Manual Pixel 9a checks should cover:

- `+` opens the Create/Post menu.
- `Post` opens the ordered composer.
- Text-only post publishes and opens in the viewer.
- Uploaded outside-Magicbooklet media publishes and keeps source attribution.
- Magicbooklet creation post still publishes.
- Free and paid unlock sections expand only when selected.
- Failed network/upload attempts do not erase the draft.

## Out Of Scope

- Full desktop composer redesign.
- Comments in the immersive viewer.
- Search inside the post composer.
- Draft persistence across app restarts.
- New backend marketplace tables or migrations.
