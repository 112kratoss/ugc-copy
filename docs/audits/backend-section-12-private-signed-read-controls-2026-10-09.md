# Section 12L — actual private signed-read controls

One sequential integration scenario passes access and lifecycle checks
against isolated Supabase Auth and Storage. Two disposable confirmed users sign
in through the actual password API. The fixture asserts that `generation_inputs`
is private, then creates one object per owner and uses actual client JWTs.

| Boundary | Observed result |
| --- | --- |
| Owner signs and fetches their object | 200 with exact fixture bytes |
| Valid signed byte range | 206, exact Content-Range and requested bytes |
| Another owner requests a signature | Rejected, no signed URL |
| Anonymous caller requests a signature | Rejected, no signed URL |
| Unsigned public-object endpoint, with and without Range | Rejected |
| Signature altered | Rejected |
| Signed URL rebound to the other owner's existing path | Rejected |
| Two-second signed URL before and after four real seconds | Works before; ordinary and range reads rejected after expiry |
| Still-valid signed URL after object deletion | Ordinary and range reads rejected |
| Other owner's untouched object | Still fetchable |

The initial local Storage version returned 400 for unsuccessful file requests;
assertions require rejection, without depending on that deployment-specific
status mapping. No JWT, password or signed URL is written to evidence. Cleanup
uses actual Storage deletion and Auth admin deletion, then independently checks
zero owned users and objects with SQL. All HTTP calls are restricted to the
isolated API origin. The permanent scenario runs in API CI.

This is test/evidence-only work. It extends MEDIA-08 coverage; it does not certify
hosted CDN caching, video decoding, imported provider assets, native-client
handling or all application-level entitlement boundaries. Candidate CI and its
release record are pending. Private baseline evidence is under
`.audit-evidence/backend-social/private-signed-read-*`.
