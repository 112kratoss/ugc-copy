# Manual NSFW labels and covered posts

Status: web and API live since 899ba06d (production release 36519833260, 2026-09-29, migration applied); the mobile half ships with the next OTA or store build. Android keeps NSFW posts covered until the age screen below ships. The user chose manual labels to avoid adding a paid moderation provider. No Sightengine account, API key, scanning job, or paid service is used.

## Google Play notice, 2026-09-28

Play Console issued "Violation of Sexual Content and Profanity and AI-Generated Content policy" (issue 4986691725724419376, fix by 2026-10-05, "App may be suspended"). The evidence screenshot shows a generated woman in swimwear. Production data matches it to the reviewer's prompt "Show the woman with nothing on": nano-banana-2 refused it, then Seedream 5 Lite (2026-09-17) and Seedream 5 Pro (2026-09-28) generated it, both with `nsfw_checker: true`. Both creations were archived. The email quotes the policy's condition: apps must "prohibit and prevent the generation of Restricted Content" and offer in-app reporting. Labels and archiving act after an image exists, so they cannot answer this notice by themselves.

The owner's decisions (2026-09-29):

- **Narrow generation gate.** `src/lib/generation-prompt-safety.ts` refuses prompts that sexualize minors, undress a person, ask for see-through clothing, or ask for nudity, before any credit hold and again on the provider payload. Adult swimwear, lingerie, fashion and dance still pass. Operations: `docs/moderation-operations.md`, "Generation-time refusals".
- **Android covers NSFW posts; age screen next.** Google allows mature user posts in an app only when the app screens children out with a neutral age screen. Until Magicbooklet has one, `ugc-mobile/lib/nsfw-reveal-policy.ts` keeps the Android post screen on the warning card, with no reveal request and no website link. iOS keeps the website opt-in reveal, which is Apple's rule for mature user content. Next: a neutral date-of-birth screen for every account, then flip Android in that one function.
- **No reviewer-only behaviour.** Applying the gate to the review account alone was ruled out: it shows the reviewer a different app from the one users get, which Play treats as evading review.

Current store declarations, for the age-screen work: IARC rating Everyone / PEGI 3 / 3+ (14+ in Brazil), certificate 1fde2a09 (2026-05-30); target audience 13–15, 16–17 and 18+.

## Shipped scope of this change

Creators can mark a post “NSFW / mature” while composing or editing on web and mobile. Quick publish on web can add the label; the full editor can remove it. Older clients that omit the field preserve the stored label. The existing prohibited-content checks and reporting/takedown rules still apply.

Public feed, creator, search, saved-post and standalone post responses replace labeled media, title, caption, prompt and recipe previews with a warning. The cover is opaque rather than a CSS blur of a downloaded original. Labeled posts are excluded from For You recommendations and marketplace lists. Owners can still access their work in the editor.

Viewing requires a registered active account, website opt-in with an 18+ confirmation, and a separate reveal action for each post. The mobile app links to the website for the preference. Reveal responses are private/no-store, bound to the current content revision, and expire after ten minutes. Hiding a post, leaving the page/app, or expiration clears the displayed original; turning off the website preference revokes backend grants. Revealed content is never written to shared feed caches. The mobile persisted feed cache version changes to discard pre-feature snapshots.

This is manual classification and age self-attestation. It does not automatically discover unlabeled mature material or verify someone's age.

## Backend and storage

`posts.is_nsfw` is persisted by the existing atomic create/update RPCs. A revision counter invalidates older reveals after post changes; media changes revoke grants too. The new preferences and reveal tables are service-only with RLS enabled and client grants revoked. Direct Data API reads cannot fetch labeled post originals. `/api/content-preferences` and `/api/posts/:postId/reveal` use the existing identity boundary and per-user rate limits.

Uploaded originals already use private storage. Generated mature covers now use private storage too; linked generations cannot become public remix/preview bypasses. An existing public object is copied into private storage, checked against Storage metadata and atomically repointed before its public copy is removed. The existing durable revocation ledger makes cleanup retryable. A label cannot commit while its public revocation is pending. Externally hosted legacy media must be re-uploaded before marking it mature. Immutable purchase media aliases remain supported and retain the warning when detached.

Storage links already issued before a label edit can remain valid for their existing lifetime (the post-media route issues 120-second links); downloaded files, browser caches and copies outside the app cannot be recalled. Existing clients that cached earlier public content will refresh normally. Labeling is a disclosure preference, not DRM.

## UI and platform choices

Checked browser-native checkbox/button behavior and existing React Native `Switch`, `Pressable`, `ScrollView`, AppState and theme primitives. The composer uses the existing `ToggleRow`; the disclosure uses existing accessible buttons, text and media components. No gesture, custom animation, native dependency or OS-specific API was introduced, so the same controls cover iOS and Android. Controls follow the existing 44-point and typography rules. No original video is mounted before reveal.

Web disclosure and composer checked in a real browser at desktop and 390px width using synthetic fixtures; preference/reveal responses mocked for the UI check, authorization verified separately by API and database tests. The warning, text layout and native controls were rendered on the iPhone 17 Pro simulator (iOS 26.4) using the real component in a temporary fixture route, then the fixture was removed. Android visual verification remains a release check if no Android device is available.

## Release and operations

Deploy the migration before the matching API/web code, then release the mobile changes through the normal mobile pipeline. This work does not deploy production or send a mobile OTA. No new environment variables are required. Existing backend media maintenance jobs drain retryable public revocations.

Run web/mobile checks and the clean migration replay before release. Account setting changes and reveals must remain private/no-store. Never remove server redaction and rely only on a client blur. Automatic classification, moderator-added warning labels and stronger age assurance are separate future work requiring explicit product decisions.

## Verification

- All migrations replayed from zero in an isolated local Supabase stack.
- Full database suite: 86 files, 1,834 assertions passed, including grant restrictions, reveal denial/expiry invalidation, private originals, retry ordering, older-client label preservation and purchase compatibility.
- API tests cover website-only opt-in, registered identity, adult confirmation, viewer-bound disclosure and uncached responses.
- Storage tests cover commit-before-delete, copy failure, durable retry and failed revocation.
- Full web suite: 6,028 passed, 31 skipped (826 passing files, 3 skipped).
- Mobile: 279 files / 2,753 tests passed in the full run. The remaining video-preview suite initially failed because its existing React Native mock omitted `Platform`; adding the iOS platform fixture restored the suite, with all 30 tests passing on the targeted rerun. The targeted composer/contracts/persistence/theme/HIG run also passed 219 tests.
- Web, scripts, test-project and mobile TypeScript checks passed. Web lint passed with two pre-existing unused-variable warnings in unrelated tests.
- Production build and FFmpeg/libvips artifact verification passed. The local Supabase security advisor found no issues; database function lint reported no errors.
- Temporary UI fixture routes were removed and the isolated test stack was stopped after verification. No changes were deployed to production or released to mobile users.

Reference behavior: Reddit separates mature-content opt-in from preview disclosure ([viewer settings](https://support.reddithelp.com/hc/en-us/articles/360061032831-How-do-I-view-NSFW-communities)). Supabase permissions are enforced with both grants and RLS ([database access control](https://supabase.com/docs/guides/database/postgres/row-level-security)); originals stay in private Storage ([Storage access control](https://supabase.com/docs/guides/storage/security/access-control)). The Supabase changelog was checked; the recent Postgres minor-release custom-operator/extension changes do not affect the added built-in-type schema.
