create table if not exists seed_products (
  id uuid primary key default gen_random_uuid(),
  product_name text not null,
  brand text,
  category text not null,
  keywords text[],
  created_at timestamptz default now()
);

create index if not exists seed_products_category_idx
on seed_products(category);

create index if not exists seed_products_product_name_idx
on seed_products using gin (to_tsvector('english', product_name));

create index if not exists seed_products_keywords_idx
on seed_products using gin (keywords);

insert into seed_products (product_name, brand, category, keywords) values
('Large White Eggs', 'Eggland''s Best', 'eggs', array['eggs','egg','large eggs','white eggs']),
('Cage Free Large Brown Eggs', 'Vital Farms', 'eggs', array['eggs','egg','cage free','brown eggs']),
('Grade A Large Eggs', 'Great Value', 'eggs', array['eggs','egg','grade a','large eggs']),
('Organic Brown Eggs', '365', 'eggs', array['eggs','egg','organic eggs','brown eggs']),
('18 Count Large Eggs', 'Kirkland Signature', 'eggs', array['eggs','egg','18 count','large eggs']),
('Large Grade A Eggs', 'Lucerne', 'eggs', array['eggs','egg','grade a','large eggs'])
on conflict do nothing;
