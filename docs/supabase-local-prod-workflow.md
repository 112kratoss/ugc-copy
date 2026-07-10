# Supabase Local to Production Workflow

Use the local Supabase Docker stack as the development database. Production changes should come from committed migration files and be pushed only after local verification.

## Current Setup

- Local project id: `magicbooklet`
- Linked production project ref: `ildfmhozpibwiopeavfg`
- Local Studio: `http://127.0.0.1:54323`
- Local API URL: `http://127.0.0.1:54321`
- Local database URL: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`

## Daily Development

1. Start Docker and Supabase:

   ```bash
   supabase start
   ```

2. Make schema changes locally, either in Studio or with SQL against the local DB.

3. Capture local changes as a migration:

   ```bash
   supabase db diff --local --schema public,storage,auth -f describe_the_change
   ```

4. Rebuild local from migrations to verify the full history still works:

   ```bash
   supabase db reset --local
   ```

5. Check what would be deployed to production:

   ```bash
   supabase db push --dry-run --linked
   ```

6. Push to production only when the dry run is expected:

   ```bash
   supabase db push --linked
   ```

Prefer running the linked dry run and production push from a reviewed deployment or CI workflow. If a manual push is necessary, use a clean reviewed branch and keep a rollback plan for the pending migrations.

## Drift Checks

Check the local Docker migration history after the stack is running:

```bash
supabase migration list --local
```

Check committed migration history against the linked production project:

```bash
supabase migration list --linked
```

Check schema drift between local migrations and production:

```bash
supabase db diff --linked --schema public,storage,auth
```

Expected clean output:

```text
No schema changes found
```

## Production Data

Do not automatically copy production data into local Docker. If realistic local data is needed, prefer a small anonymized seed file instead of importing full production user data.
