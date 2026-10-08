# Section 12J — upload cleanup after actual worker death

Three local process-death controls pass, extending the reclaim suite to fourteen
actual Storage/PostgREST/SQL cases. This batch changes only tests and evidence.
CI is pending.

Each case forks an owned Node process running the real cleanup service. The
worker pauses only after a successful API response at its named checkpoint. The
parent independently reads durable SQL and Storage state, sends SIGKILL and
requires that exact exit signal, then forks a fresh replacement and duplicate.
The checkpoint itself does not mock business logic or database/Storage outcomes.
Network access is restricted to isolated Supabase.

| Kill checkpoint | Durable state | Fresh-worker outcome |
| --- | --- | --- |
| After scan marker | Object exists; intent has scan marker but is uncleared | Reclaims object and clears intent. |
| After Storage DELETE | Object absent; intent still uncleared | Real listing proves absence; clears bookkeeping without deleting anything again. |
| After clearing PATCH | Object absent; intent already cleared | Scans no work. |

The duplicate run scans nothing in all cases. Each fixture also owns an equally
old, never-consumed upload; with the rollout flag absent, its object remains
fetchable and neither marker nor clearing timestamp changes through the crash,
recovery or duplicate runs. Cleanup stops any remaining owned process, removes
objects through Storage, deletes the exact fixture user and verifies zero users,
intents and objects with independent SQL.

These cases certify the service's named crash boundaries, not the outer managed
job's expired-holder fencing, concurrent reference creation or production load.
They rely on the 12I marker schema and run sequentially with the rest of the
isolated API reclaim suite. Private log:
`.audit-evidence/backend-social/upload-reclaim-worker-death.log`.
