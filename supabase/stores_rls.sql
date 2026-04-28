-- RLS policies for public.stores
-- Run once in the Supabase SQL editor.

-- 1. Ensure RLS is enabled on the table
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;

-- 2. Allow anyone to read stores
CREATE POLICY "stores_public_read"
  ON public.stores
  FOR SELECT
  USING (true);

-- 3. Allow anyone to insert stores
CREATE POLICY "stores_public_insert"
  ON public.stores
  FOR INSERT
  WITH CHECK (true);

-- 4. Seed major chain stores
INSERT INTO public.stores (name, city, state)
VALUES
  ('Target',      'Unknown', 'HI'),
  ('Walmart',     'Unknown', 'HI'),
  ('Costco',      'Unknown', 'HI'),
  ('Sam''s Club', 'Unknown', 'HI'),
  ('Safeway',     'Unknown', 'HI'),
  ('Foodland',    'Unknown', 'HI'),
  ('CVS',         'Unknown', 'HI'),
  ('Walgreens',   'Unknown', 'HI'),
  ('Home Depot',  'Unknown', 'HI'),
  ('Lowe''s',     'Unknown', 'HI')
ON CONFLICT DO NOTHING;
