-- RLS controls row access, but legacy Supabase defaults also granted client
-- roles table-level capabilities that the Data API does not need.
DO $migration$
DECLARE
  table_record record;
BEGIN
  FOR table_record IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %I.%I FROM anon',
      table_record.schema_name,
      table_record.table_name
    );
    EXECUTE format(
      'REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE %I.%I FROM authenticated',
      table_record.schema_name,
      table_record.table_name
    );
  END LOOP;
END;
$migration$;
