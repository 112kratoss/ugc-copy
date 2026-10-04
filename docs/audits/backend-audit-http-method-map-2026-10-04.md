# Explicit HTTP method inventory — October 4, 2026

Source snapshot: `3720477850ad85335693ca8aec5dc4ab0a75efcb`. 162 route files export 186 explicit HTTP methods. The TypeScript AST review handles named functions, variables, destructured factory returns and named reexports. Every file retains an existing closure gate; zero unresolved files and zero missing routes against the October 1 inventory.

This is inventory and scheduling evidence, not behavioral certification. Framework-generated HEAD/OPTIONS are excluded. Imports and initializer expressions locate implementations; they do not establish authorization or complete call chains. Full evidence is in [the JSON snapshot](backend-audit-http-method-map-2026-10-04.json). MAP-02 stays open.

| Area | Routes | Explicit methods |
| --- | ---: | ---: |
| AUTH | 6 | 8 |
| SOCIAL | 35 | 45 |
| PAY | 15 | 16 |
| OPS | 5 | 5 |
| JOB | 23 | 24 |
| GEN | 19 | 24 |
| MARKET | 20 | 20 |
| MEDIA | 8 | 8 |
| WORKFLOW | 31 | 36 |

## Social method review queue

Earlier Section 2 ownership controls and Sections 8A–8D cover parts of this queue. No row below is a whole-method pass. Each still needs evidence for applicable identities, limits, transitions, retries, visibility and side effects.

| Route | Methods | Closure gate |
| --- | --- | --- |
| `/api/admin/contact` | POST | SOCIAL-GATE |
| `/api/admin/moderation/generations` | POST | SOCIAL-GATE |
| `/api/admin/moderation/post-reports` | POST | SOCIAL-GATE |
| `/api/admin/moderation/posts` | POST | SOCIAL-GATE |
| `/api/admin/moderation/subject-reports` | POST | SOCIAL-GATE |
| `/api/admin/users/sanctions` | POST | SOCIAL-GATE |
| `/api/contact` | POST | SOCIAL-GATE |
| `/api/content-preferences` | GET, POST | SOCIAL-GATE |
| `/api/creators/[username]` | GET | SOCIAL-GATE |
| `/api/moderation/blocks/[userId]` | DELETE, POST | SOCIAL-GATE |
| `/api/moderation/reports` | POST | SOCIAL-GATE |
| `/api/posts/[postId]/archive` | POST | SOCIAL-GATE |
| `/api/posts/[postId]/report` | POST | SOCIAL-GATE |
| `/api/posts/[postId]/restore` | POST | SOCIAL-GATE |
| `/api/posts/[postId]/reveal` | POST | SOCIAL-GATE |
| `/api/posts/[postId]` | DELETE, GET, PATCH, PUT | SOCIAL-GATE |
| `/api/posts` | GET, POST | SOCIAL-GATE |
| `/api/profile/follow/notify` | POST | SOCIAL-GATE |
| `/api/profile/follow` | GET, POST | SOCIAL-GATE |
| `/api/profile` | GET, PATCH | SOCIAL-GATE |
| `/api/profile/share` | POST | SOCIAL-GATE |
| `/api/profile/validate` | POST | SOCIAL-GATE |
| `/api/search` | GET | SOCIAL-GATE |
| `/api/showcase/feed/events` | POST | SOCIAL-GATE |
| `/api/showcase/feed` | GET, HEAD | SOCIAL-GATE |
| `/api/showcase/posts/[postId]/comments/[commentId]` | DELETE | SOCIAL-GATE |
| `/api/showcase/posts/[postId]/comments` | GET, POST | SOCIAL-GATE |
| `/api/showcase/posts/[postId]` | GET | SOCIAL-GATE |
| `/api/showcase/preview` | GET | SOCIAL-GATE |
| `/api/showcase/publish` | POST | SOCIAL-GATE |
| `/api/showcase/remix` | POST | SOCIAL-GATE |
| `/api/showcase/save` | POST | SOCIAL-GATE |
| `/api/showcase/saved-media` | GET | SOCIAL-GATE |
| `/api/showcase/saved-state` | GET | SOCIAL-GATE |
| `/api/showcase/share` | POST | SOCIAL-GATE |
