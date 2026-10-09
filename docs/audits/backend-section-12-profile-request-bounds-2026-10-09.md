# Section 12P — bounded profile JSON requests

Four profile adapters buffered JSON without an application byte limit: profile
PATCH, profile validation POST, media signing POST and media cleanup POST. Twelve
actual adapter invocations with real local Auth/PostgREST/SQL accepted 128 KiB
payloads and returned 200 with absent, correct or understated Content-Length.
The bodies contained valid fields plus oversized ignored padding. This is the
request-limit gap already tracked under SOCIAL-04/MAP-02, not a new obligation.

The adapters now use the existing streamed JSON reader with a shared 64 KiB
budget. Larger bodies return 413 with `Profile request is too large.` and private
no-store headers. Content-Length permits early rejection but cannot bypass actual
byte counting. Authentication stays ahead of parsing; validation's existing rate
limit stays ahead of parsing too. Malformed/non-object input retains its prior
400 behavior. Profile JSON carries text and metadata; actual image bytes continue
to upload directly to Storage.

The permanent integration suite passes 28 cases (seven per adapter):

- Oversized bodies with absent, honest and understated length headers reject;
  profile fields stay unchanged and no upload capability reservation is created.
- Valid JSON exactly at 65,536 bytes succeeds.
- Multibyte UTF-8 exceeds the budget even when character count is below it.
- Unauthenticated calls return 401 without reading the oversized body.
- An oversized stream is cancelled with its tail unread, instead of buffered in
  full. The test allows one prefetched chunk beyond the detecting chunk.

These invoke actual adapters with native Request/ReadableStream objects and real
Auth and SQL dependencies. They are not claims about a deployed Next HTTP socket
or a hosted proxy's independent limits. Before/after logs are retained privately
as `profile-request-bounds-*`. The baseline's issued capabilities and all fixture
users/reservations/rate rows are removed; upload counters reconcile. Both targets
must be loopback and client fetch refuses external origins.

The shared mobile contract records 413 for the three exposed mobile operations;
the existing client preserves status, message and details without a runtime
change. All 136 mobile contract cases and 30 focused web/parser cases pass, as do
application/test typing and scoped lint. API integration CI includes the new
suite. No migration, production data mutation or provider request is needed.

Production release is pending. SOCIAL-04 remains failed for this reproduced
limit gap until release verification; other profile/social methods and remaining
lifecycle coverage remain open. Includes the eight passing 12O media controls.
