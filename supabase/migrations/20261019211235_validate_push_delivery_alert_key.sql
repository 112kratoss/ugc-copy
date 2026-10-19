-- Checks the key 20261019122652 added to mobile_push_deliveries NOT VALID.
-- Every delivery already pointed at an alert under the key it replaced, so
-- this finds nothing; on its own, it holds only a lock that lets reads and
-- writes of both tables go on while it scans.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.mobile_push_deliveries
  VALIDATE CONSTRAINT mobile_push_deliveries_notification_id_fkey;
