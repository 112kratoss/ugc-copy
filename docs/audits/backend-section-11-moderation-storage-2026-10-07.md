# Section 11U — moderation Storage revocation and recovery

October 7, 2026. Sixteen actual local GoTrue/admin-session/PostgREST/SQL/Storage
cases exercise the proactive post action and report decision handlers. No new
application defect is reproduced; no runtime or migration change is included.

Both take-down paths remove a public cover and all five private gallery paths
(source, preview, rendition, display and teaser). Actual PNG bytes are readable
through a signed URL before deletion; the same URL fails afterward. A repeated
decision keeps the original reviewer/timestamp, re-sweeps the objects and
requests cache invalidation again. Restoring a taken-down post returns 409.
Provisional hide/restore preserves bytes, and subsequent take-down removes them.

Eight recovery cases introduce controlled local transport faults around actual
SQL and Storage calls: deletion returns 503, a successful deletion reply leaves
the object present, HEAD verification returns 503, or a reply is lost after the
moderation SQL actually commits. Each first request returns an error rather than
verified revocation. Retrying performs deletion and verifies absence without
changing the recorded decision or adding a second audit mutation. The installed
Storage SDK throws the verification failure; it is not mistaken for absence.

Two foreign-path cases refuse before deleting any object, preserve the unrelated
object, and recover after repairing only the fixture reference. A separate
generation case verifies the generation owner before accepting its showcase
namespace. Two external-only references disclose the remaining external
revocation obligation; the network guard permits only the disposable API origin.

The fixtures use real GoTrue users and persisted HMAC admin sessions. Gallery
variants contain inert PNG bytes: this does not prove video encoding or delivery.
Feed invalidation is controlled and counted; hosted Next cache/CDN propagation
is not exercised. An initial gallery fixture omitted the required teaser
generation timestamp; it was corrected without changing the constraint, and
the earlier log is retained. Fixture balances stay 500 and usage stays empty.
Every case deletes only its own objects and rows, then independently checks
empty Storage/Auth/profile/session/rate/post/media/report/audit fixtures.

The sixteen local cases pass. Test types and scoped lint pass. Exact-head CI,
verified parent, standard release and independent readback remain required.
Read-only routine comparison and the reviewed four-cast difference are recorded
in [11T](backend-section-11-admin-moderation-inputs-2026-10-07.md).
SOCIAL-03/MEDIA-08 stay open for the broader hosted/cache/expiry/media matrix;
these controls do not close either whole obligation.
