# Section 10D — retained resource publication and file-access boundaries

Baseline 449c07f0 (#375 candidate). Six added actual local controls cover a
structured purchased file, unsupported publication paths, buyer/retraction
boundaries and signed-URL integrity/expiry. No runtime/schema change in these
controls. All 33 actual controls pass on Node 24.21.0 in 152.01 seconds. Test
typechecking and scoped lint pass. Tracked fixture cleanup assertions pass.

A canonical structured file in post_resource_files is captured in the immutable
purchased revision, retained with the original attachment and read as matching
PNG bytes after creator deletion. Publication rejects bucket-qualified uploads,
generation_inputs and generated_images paths: its ownership trigger expects a
creator-prefix resource file. Each denial leaves the old empty resource_items
intact, with no purchase or deletion job. The first trial assumed those paths
could be published; the actual SQL guard rejected them. These are denial controls,
not certification of bucket-qualified publication.

An unrelated buyer cannot mint a URL using another buyer's purchase ID. The buyer
cannot mint a URL for an unlisted owner path or the internal neutral retained
path. Moderation retraction prevents another mint even though the retained copy
still exists. These requests call the actual entitlement projection and file URL
service with the real database/Storage; they are not deployed HTTP route checks.

A separate two-second local-origin signed URL reads the correct bytes before
expiry, rejects a changed signature, and is rejected after actual token expiry.
The normal application URL still mints and reads afterwards. Application TTL is
unchanged at 600 seconds. The test does not wait ten minutes or certify production
CDN/browser cache revocation. Supabase documents that signed URLs are independent
of Auth-key rotation, and [Smart CDN caches](https://supabase.com/docs/guides/storage/cdn/smart-cdn)
may outlive token expiry until cache eviction. New mint denial is distinct from
revocation of a previously issued capability; no immediate revocation claim is
made by this evidence.

The current Supabase changelog and Storage signed-URL documentation were checked.
All operations use tracked random identities/paths in the isolated loopback
stack; no external provider, customer balance or production file is touched.
AUTH-03, MARKET-03 and MEDIA-08 remain open for their full matrices, including
refund/restore and production delivery behavior.

Private logs: .audit-evidence/backend-social/account-deletion-retained-final*.
