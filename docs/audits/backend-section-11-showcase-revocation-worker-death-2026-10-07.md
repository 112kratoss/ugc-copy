# Section 11W — showcase revocation after worker death

October 7, 2026. Three actual owned-process SIGKILL controls extend
[11V](backend-section-11-showcase-revocation-recovery-2026-10-07.md). Each starts
the actual revocation processor in a separate Node 24 process with a new
Supabase client, waits for a named checkpoint, verifies durable SQL/Storage
state and kills only that process.

The checkpoints are before Storage removal (six objects and gallery inventory
remain), after actual Storage removal (objects are absent and gallery inventory
remains), and after gallery deletion commits (objects and gallery are absent,
queue remains). A fresh process completes each pending queue entry. A second
fresh process finds zero work. Actual downloads fail for every removed path.

All **three cases** pass, along with test types, scoped lint and diff checks.
GoTrue creates the owner; the real post trigger queues its private transition.
The six variants are inert PNG objects, without provider or encoding work.
Every case verifies unchanged 500-credit balance, empty usage and independent
zero Auth/profile/generation/post/media/queue/object cleanup. The child receives
only the disposable config path and test controls, guards the local API origin
and does not load production environment files.

This runs the business processor directly. It does not certify the scheduler's
managed lease, overlong live-holder fencing, renewed references during deletion,
hosted cache/CDN behavior or historical orphan reconciliation. No new runtime,
migration or installed-client change is included. The suite is added sequentially
to Quality. Own exact-head CI, verified #397 parent, standard release and
independent readback remain required; MEDIA-09/JOB-01/02 stay open for their
broader matrices. Private logs are in `.audit-evidence/backend-social/`.
