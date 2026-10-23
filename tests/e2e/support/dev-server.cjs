// The one preload of the E2E dev server (playwright.config.ts, NODE_OPTIONS --require). `next dev` hands
// its server process only the last --require it was given, so both files come in through this one: the
// checkout's .env files kept out first, then the Supabase reads the server answers itself.
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./no-env-files.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./supabase-server-stub.cjs');
