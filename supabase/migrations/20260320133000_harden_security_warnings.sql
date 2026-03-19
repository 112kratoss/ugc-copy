DROP POLICY IF EXISTS "Service role can manage contact messages" ON public.contact_messages;

CREATE POLICY "Service role can manage contact messages"
  ON public.contact_messages
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

ALTER FUNCTION public.add_credits(uuid, integer, uuid, text)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.deduct_credits(uuid, integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.handle_new_user()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.refund_ai_usage_event(uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.refund_credits(uuid, integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.refund_generation(text)
  SET search_path = public, pg_temp;
