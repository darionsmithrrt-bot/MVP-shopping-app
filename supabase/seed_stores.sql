-- Seed: major store chains
-- Safe to rerun: ON CONFLICT DO NOTHING skips duplicates without erroring.
-- Adjust city/state per location before using in production.

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
