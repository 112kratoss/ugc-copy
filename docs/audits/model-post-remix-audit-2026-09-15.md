# Model APIs, publishing, and remix system audit

**Reviewed:** 15 September 2026  
**Source snapshot:** `5233d61fdd6f3a3402041053334a6efd125739ba`  
**Scope:** model catalog, quoting, generation start and callbacks, input media, posts, resource bundles, remix access, mobile drafts, and OTA behavior.

## Executive summary

The system has solid foundations: a shared model catalog, server-side quote calculation, generation idempotency, durable completion jobs, and transactional post/resource updates. The main risks are at the boundaries between those systems.

Six actionable findings were identified: four high priority and two medium priority. The recent iPhone reference-recovery OTA fixes the reported empty-reference draft case, but it does not cover every stale-draft or account-switch scenario.

## Findings

### A1 — Remix endpoints do not consistently enforce unlock access (High)

The UI can report `unlock_required`, but `remixShowcasePostForRoute` can still return the original generation prompt and settings to an authenticated non-owner. The direct remix-source loader also bases access mainly on generation visibility and input-sharing flags. The entitlement check is used for additional recipe media, not consistently for the original recipe.

**Impact:** A viewer may obtain protected prompt/settings through a direct endpoint even when the UI shows an unlock requirement.

**Recommendation:** Centralize the owner/public/unlocked/blocked/moderated decision and require it in both remix endpoints. Define explicitly whether an unlock protects the original generation recipe, additional resources, or both.

### A2 — Reference-video pricing trusts client duration metadata (High)

The unified request parser accepts caller-supplied `durationSeconds`, including zero. The quote builder passes that value into reference-adjustment pricing, and the generic start path reserves the quoted amount without independently probing the media duration.

**Impact:** An understated duration can reduce the charge and bypass combined-duration validation for models whose provider billing depends on input seconds.

**Recommendation:** Derive billable duration from a trusted uploaded/prepared asset or server-side media probe. Bind the quote and start request to the asset version and reject unverified metadata.

### A3 — Lost start responses can create duplicate generations (High)

The mobile creator creates a new idempotency key for each Generate press and clears the active key after the request finishes. If the server accepted the first request but the response was lost, the next press uses a different key and can start another generation.

**Impact:** One intended generation can become two provider jobs and two credit reservations.

**Recommendation:** Persist an account-scoped generation attempt and its request fingerprint before sending. Reconcile that same attempt after timeouts, app restarts, and ambiguous errors. Provide a separate explicit “start new run” action.

### A4 — Post and generation visibility can diverge (High)

Post updates commit first. The linked generation’s `is_public` and media fields are updated afterward in a separate call; synchronization errors are logged while the post update still succeeds. The direct remix loader can use the generation’s public flag without requiring a currently public parent post.

**Impact:** A post made private may leave a public generation, prompt, or input media accessible. Failed derivative deletion can also leave old public bytes available.

**Recommendation:** Update post and generation exposure in one transaction. Require current parent-post exposure for non-owner source reads. Queue failed storage revocations for durable retry and monitoring.

### A5 — Ordinary mobile drafts are shared across accounts (Medium)

Remix drafts include account/source scope, but ordinary Create drafts use the global `magicbooklet.creation.drafts.v1` key. Sign-out clears auth and the home feed, not ordinary drafts.

**Impact:** On a shared phone, account B can see account A’s saved prompt and persisted reference descriptors. This is local-device isolation, not evidence of a server authorization bypass.

**Recommendation:** Scope every draft to an explicit account or guest identity. Migrate legacy unowned drafts conservatively instead of assigning them to the next account.

### A6 — Persisted signed URLs can expire without renewal (Medium)

Generation input URLs are signed for one hour. Saved drafts retain those URLs. A completed remix restore with a nonempty reference list does not trigger the empty-reference recovery path, and the reference thumbnail caller does not supply a URL-renewal callback.

**Impact:** A valid reference can appear missing after cache eviction or URL expiry, even though generation submission may later re-resolve storage-backed media.

**Recommendation:** Persist stable asset identity/storage provenance and renew display URLs on resume or image-load failure while preserving prompt edits, handles, settings, and removals.

## Additional risks to validate

- Generic motion-model onboarding should have a create → complete → publish → remix round-trip test. Generic records store motion information differently from the legacy motion path.
- Input-media persistence failures are logged per item. Track recipe-capture completeness and retry missing durable inputs before advertising full remixability.
- OTA delivery, OTA application, catalog refresh, and draft migration are separate events. A successful OTA publish does not prove that an existing phone has applied the update or repaired old saved data.

## Verification

- 1,032 distinct targeted existing tests passed across server and mobile model, generation, post, remix, callback, settlement, OTA, and draft suites.
- Six focused diagnostic counterexamples confirmed the current behaviors described above. They were run in a disposable checkout and did not create paid provider jobs or change production data.
- This was a source and test audit, not an exhaustive penetration test, provider-economics certification, database deployment-parity check, or physical-device expiry test.

## Recommended fix order

1. Enforce remix entitlements and post/generation visibility atomically.
2. Make reference billing derive from trusted media metadata.
3. Persist and reconcile ambiguous generation attempts.
4. Partition all mobile drafts by account/guest identity.
5. Add signed-URL renewal and a model round-trip release gate.

## Regression matrix

Test owner, linked guest, unlocked viewer, locked viewer, blocked viewer, account switch, public/private/archived/moderated posts, image/video/audio/motion inputs, edited and completed drafts, expired URLs, cache eviction, offline starts, lost responses, duplicate callbacks, storage/database failures, stale catalog revisions, and physical iOS/Android OTA runtimes.

## OTA and the reported iPhone issue

The shipped recovery detects a completed remix draft with missing, still-mentioned image references, reloads the authorized source, and restores matching references while preserving edits. The user confirmed the image became visible. The phone’s original local storage was not extracted, so the exact earlier event remains inferred. The evidence does not support calling this an iPhone renderer defect or proving that every device was running old code.

Add non-sensitive support diagnostics for installed build, OTA update ID/runtime/channel, catalog revision, draft schema version, reference count, and restore outcome. Do not log prompts or signed URLs. For every OTA release, verify both delivery and application on physical iOS and Android devices, then reopen an existing draft.
