-- Create contact_messages table
CREATE TABLE IF NOT EXISTS public.contact_messages (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL,
    subject text DEFAULT 'general',
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- Enable RLS (only service_role can insert; no public access)
ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

-- Only the service_role can insert (webhook/API uses service_role key)
-- No public policies needed — the API route uses service_role
