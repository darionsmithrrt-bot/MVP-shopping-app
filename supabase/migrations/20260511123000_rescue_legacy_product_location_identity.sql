-- Rescue legacy product identity in store-specific location/price data.
-- Non-destructive and idempotent migration.

alter table public.product_locations
  add column if not exists product_name text,
  add column if not exists brand text,
  add column if not exists category text,
  add column if not exists size_value text,
  add column if not exists size_unit text,
  add column if not exists display_size text,
  add column if not exists canonical_product_key text,
  add column if not exists store_name text,
  add column if not exists legacy_link_status text,
  add column if not exists legacy_link_notes text,
  add column if not exists linked_catalog_product_id uuid,
  add column if not exists updated_at timestamptz default now();

alter table public.catalog_products
  add column if not exists category text,
  add column if not exists size_value text,
  add column if not exists size_unit text,
  add column if not exists quantity text,
  add column if not exists display_size text,
  add column if not exists canonical_product_key text;

create or replace function public.mvp_norm_text(input text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(
      regexp_replace(lower(coalesce(input, '')), '[^a-z0-9]+', ' ', 'g'),
      '\s+',
      ' ',
      'g'
    ),
    ''
  );
$$;

create or replace function public.mvp_norm_size_unit(input text)
returns text
language sql
immutable
as $$
  select case public.mvp_norm_text(input)
    when 'oz' then 'oz'
    when 'ounce' then 'oz'
    when 'ounces' then 'oz'
    when 'fl oz' then 'fl oz'
    when 'fluid oz' then 'fl oz'
    when 'fluid ounce' then 'fl oz'
    when 'fluid ounces' then 'fl oz'
    when 'lb' then 'lb'
    when 'lbs' then 'lb'
    when 'pound' then 'lb'
    when 'pounds' then 'lb'
    when 'g' then 'g'
    when 'gram' then 'g'
    when 'grams' then 'g'
    when 'kg' then 'kg'
    when 'kilogram' then 'kg'
    when 'kilograms' then 'kg'
    when 'ml' then 'ml'
    when 'milliliter' then 'ml'
    when 'milliliters' then 'ml'
    when 'l' then 'l'
    when 'liter' then 'l'
    when 'liters' then 'l'
    when 'litre' then 'l'
    when 'litres' then 'l'
    when 'gallon' then 'gallon'
    when 'gallons' then 'gallon'
    when 'gal' then 'gallon'
    when 'qt' then 'quart'
    when 'quart' then 'quart'
    when 'quarts' then 'quart'
    when 'count' then 'count'
    when 'ct' then 'count'
    else public.mvp_norm_text(input)
  end;
$$;

create or replace function public.mvp_make_product_key(
  brand text,
  product_name text,
  size_value text,
  size_unit text,
  display_size text
)
returns text
language sql
immutable
as $$
  with normalized as (
    select
      public.mvp_norm_text(brand) as b,
      public.mvp_norm_text(product_name) as p,
      nullif(concat_ws(' ', public.mvp_norm_text(size_value), public.mvp_norm_size_unit(size_unit)), '') as sz_pair,
      public.mvp_norm_text(display_size) as sz_display
  )
  select case
    when p is null then null
    else concat_ws('|', b, p, coalesce(sz_pair, sz_display))
  end
  from normalized;
$$;

-- Keep store_name synchronized for existing mapped rows when possible.
update public.product_locations pl
set
  store_name = s.name,
  updated_at = coalesce(pl.updated_at, now())
from public.stores s
where pl.store_id = s.id
  and (pl.store_name is null or btrim(pl.store_name) = '')
  and s.name is not null
  and btrim(s.name) <> '';

-- Backfill display_size from explicit size fields where possible.
update public.catalog_products cp
set display_size = concat_ws(' ', nullif(btrim(cp.size_value), ''), nullif(btrim(cp.size_unit), ''))
where (cp.display_size is null or btrim(cp.display_size) = '')
  and coalesce(nullif(btrim(cp.size_value), ''), nullif(btrim(cp.size_unit), '')) is not null;

update public.product_locations pl
set display_size = concat_ws(' ', nullif(btrim(pl.size_value), ''), nullif(btrim(pl.size_unit), ''))
where (pl.display_size is null or btrim(pl.display_size) = '')
  and coalesce(nullif(btrim(pl.size_value), ''), nullif(btrim(pl.size_unit), '')) is not null;

-- Backfill canonical product key in catalog_products.
update public.catalog_products cp
set canonical_product_key = public.mvp_make_product_key(cp.brand, cp.product_name, cp.size_value, cp.size_unit, cp.display_size)
where (cp.canonical_product_key is null or btrim(cp.canonical_product_key) = '')
  and public.mvp_make_product_key(cp.brand, cp.product_name, cp.size_value, cp.size_unit, cp.display_size) is not null;

-- Priority A: link by product_locations.product_id -> catalog_products.id, when product_id exists on row json and is uuid.
update public.product_locations pl
set
  linked_catalog_product_id = cp.id,
  product_name = case when pl.product_name is null or btrim(pl.product_name) = '' then cp.product_name else pl.product_name end,
  brand = case when pl.brand is null or btrim(pl.brand) = '' then cp.brand else pl.brand end,
  category = case when pl.category is null or btrim(pl.category) = '' then cp.category else pl.category end,
  size_value = case when pl.size_value is null or btrim(pl.size_value) = '' then cp.size_value else pl.size_value end,
  size_unit = case when pl.size_unit is null or btrim(pl.size_unit) = '' then cp.size_unit else pl.size_unit end,
  display_size = case when pl.display_size is null or btrim(pl.display_size) = '' then cp.display_size else pl.display_size end,
  barcode = case when pl.barcode is null or btrim(pl.barcode) = '' then cp.barcode else pl.barcode end,
  canonical_product_key = case
    when pl.canonical_product_key is null or btrim(pl.canonical_product_key) = ''
      then coalesce(cp.canonical_product_key, public.mvp_make_product_key(cp.brand, cp.product_name, cp.size_value, cp.size_unit, cp.display_size))
    else pl.canonical_product_key
  end,
  legacy_link_status = 'linked_by_product_id',
  legacy_link_notes = 'Linked to catalog by product_id',
  updated_at = now()
from public.catalog_products cp
where pl.linked_catalog_product_id is null
  and nullif(btrim(to_jsonb(pl) ->> 'product_id'), '') is not null
  and nullif(btrim(to_jsonb(pl) ->> 'product_id'), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and cp.id = (nullif(btrim(to_jsonb(pl) ->> 'product_id'), ''))::uuid;

-- Priority B: link by exact non-empty barcode when barcode maps to exactly one catalog row.
with barcode_catalog_unique as (
  select btrim(cp.barcode) as barcode_key, min(cp.id) as catalog_id
  from public.catalog_products cp
  where cp.barcode is not null and btrim(cp.barcode) <> ''
  group by btrim(cp.barcode)
  having count(*) = 1
)
update public.product_locations pl
set
  linked_catalog_product_id = cp.id,
  product_name = case when pl.product_name is null or btrim(pl.product_name) = '' then cp.product_name else pl.product_name end,
  brand = case when pl.brand is null or btrim(pl.brand) = '' then cp.brand else pl.brand end,
  category = case when pl.category is null or btrim(pl.category) = '' then cp.category else pl.category end,
  size_value = case when pl.size_value is null or btrim(pl.size_value) = '' then cp.size_value else pl.size_value end,
  size_unit = case when pl.size_unit is null or btrim(pl.size_unit) = '' then cp.size_unit else pl.size_unit end,
  display_size = case when pl.display_size is null or btrim(pl.display_size) = '' then cp.display_size else pl.display_size end,
  canonical_product_key = case
    when pl.canonical_product_key is null or btrim(pl.canonical_product_key) = ''
      then coalesce(cp.canonical_product_key, public.mvp_make_product_key(cp.brand, cp.product_name, cp.size_value, cp.size_unit, cp.display_size))
    else pl.canonical_product_key
  end,
  legacy_link_status = 'linked_by_barcode',
  legacy_link_notes = 'Linked to catalog by exact barcode',
  updated_at = now()
from barcode_catalog_unique bcu
join public.catalog_products cp on cp.id = bcu.catalog_id
where pl.linked_catalog_product_id is null
  and pl.barcode is not null
  and btrim(pl.barcode) <> ''
  and btrim(pl.barcode) = bcu.barcode_key;

-- Priority C: strict identity match by normalized brand + product_name + size, only when exactly one catalog row matches.
with catalog_identity as (
  select
    cp.id,
    cp.product_name,
    cp.brand,
    cp.category,
    cp.barcode,
    cp.size_value,
    cp.size_unit,
    cp.display_size,
    coalesce(cp.canonical_product_key, public.mvp_make_product_key(cp.brand, cp.product_name, cp.size_value, cp.size_unit, cp.display_size)) as canonical_product_key,
    public.mvp_norm_text(cp.brand) as brand_n,
    public.mvp_norm_text(cp.product_name) as name_n,
    coalesce(
      nullif(concat_ws(' ', public.mvp_norm_text(cp.size_value), public.mvp_norm_size_unit(cp.size_unit)), ''),
      public.mvp_norm_text(cp.display_size)
    ) as size_n
  from public.catalog_products cp
), unique_identity as (
  select brand_n, name_n, size_n, min(id) as catalog_id
  from catalog_identity
  where brand_n is not null
    and name_n is not null
    and size_n is not null
  group by brand_n, name_n, size_n
  having count(*) = 1
)
update public.product_locations pl
set
  linked_catalog_product_id = ci.id,
  product_name = case when pl.product_name is null or btrim(pl.product_name) = '' then ci.product_name else pl.product_name end,
  brand = case when pl.brand is null or btrim(pl.brand) = '' then ci.brand else pl.brand end,
  category = case when pl.category is null or btrim(pl.category) = '' then ci.category else pl.category end,
  size_value = case when pl.size_value is null or btrim(pl.size_value) = '' then ci.size_value else pl.size_value end,
  size_unit = case when pl.size_unit is null or btrim(pl.size_unit) = '' then ci.size_unit else pl.size_unit end,
  display_size = case when pl.display_size is null or btrim(pl.display_size) = '' then ci.display_size else pl.display_size end,
  barcode = case when pl.barcode is null or btrim(pl.barcode) = '' then ci.barcode else pl.barcode end,
  canonical_product_key = case
    when pl.canonical_product_key is null or btrim(pl.canonical_product_key) = ''
      then ci.canonical_product_key
    else pl.canonical_product_key
  end,
  legacy_link_status = 'linked_by_strict_identity',
  legacy_link_notes = 'Linked to catalog by strict normalized identity',
  updated_at = now()
from unique_identity ui
join catalog_identity ci on ci.id = ui.catalog_id
where pl.linked_catalog_product_id is null
  and public.mvp_norm_text(pl.brand) = ui.brand_n
  and public.mvp_norm_text(coalesce(pl.product_name, '')) = ui.name_n
  and coalesce(
    nullif(concat_ws(' ', public.mvp_norm_text(pl.size_value), public.mvp_norm_size_unit(pl.size_unit)), ''),
    public.mvp_norm_text(pl.display_size)
  ) = ui.size_n;

-- Fill canonical key for product_locations from row identity where still missing.
update public.product_locations pl
set
  canonical_product_key = public.mvp_make_product_key(pl.brand, pl.product_name, pl.size_value, pl.size_unit, pl.display_size),
  updated_at = now()
where (pl.canonical_product_key is null or btrim(pl.canonical_product_key) = '')
  and public.mvp_make_product_key(pl.brand, pl.product_name, pl.size_value, pl.size_unit, pl.display_size) is not null;

-- Preserve unmatched legacy rows (do not delete) with explicit rescue status.
update public.product_locations pl
set
  legacy_link_status = 'legacy_unlinked',
  legacy_link_notes = 'Preserved legacy row; needs product identity link before price comparison',
  updated_at = coalesce(pl.updated_at, now())
where pl.linked_catalog_product_id is null
  and coalesce(pl.legacy_link_status, '') not in ('linked_by_product_id', 'linked_by_barcode', 'linked_by_strict_identity');

create index if not exists idx_product_locations_canonical_product_key
  on public.product_locations(canonical_product_key);

create index if not exists idx_product_locations_store_id_canonical_product_key
  on public.product_locations(store_id, canonical_product_key);

create index if not exists idx_product_locations_store_id_barcode
  on public.product_locations(store_id, barcode);

create index if not exists idx_product_locations_store_id_canonical_product_key_price
  on public.product_locations(store_id, canonical_product_key, price);

create index if not exists idx_catalog_products_canonical_product_key
  on public.catalog_products(canonical_product_key);

create index if not exists idx_catalog_products_barcode
  on public.catalog_products(barcode);

create or replace view public.store_product_price_map_v1 as
select
  pl.store_id,
  pl.store_name,
  pl.barcode,
  pl.canonical_product_key,
  pl.product_name,
  pl.brand,
  pl.category,
  pl.size_value,
  pl.size_unit,
  pl.display_size,
  pl.aisle,
  pl.section,
  pl.shelf,
  pl.price,
  pl.avg_price,
  pl.price_type,
  pl.price_count,
  pl.price_confidence,
  pl.confidence_score,
  pl.last_confirmed_at,
  pl.updated_at
from public.product_locations pl
where pl.store_id is not null
  and pl.canonical_product_key is not null
  and btrim(pl.canonical_product_key) <> ''
  and (
    coalesce(pl.avg_price, 0) > 0
    or coalesce(pl.price, 0) > 0
  );

create or replace view public.legacy_product_location_rescue_status_v1 as
select
  count(*)::bigint as total_rows,
  count(*) filter (where coalesce(pl.legacy_link_status, '') in ('linked_by_product_id', 'linked_by_barcode', 'linked_by_strict_identity'))::bigint as linked_rows,
  count(*) filter (where coalesce(pl.legacy_link_status, '') = 'legacy_unlinked')::bigint as unlinked_rows,
  count(*) filter (where coalesce(pl.avg_price, 0) > 0 or coalesce(pl.price, 0) > 0)::bigint as rows_with_price,
  count(*) filter (where pl.canonical_product_key is not null and btrim(pl.canonical_product_key) <> '')::bigint as rows_with_canonical_key,
  count(*) filter (where coalesce(pl.avg_price, 0) <= 0 and coalesce(pl.price, 0) <= 0)::bigint as rows_missing_price,
  count(*) filter (where pl.product_name is null or btrim(pl.product_name) = '')::bigint as rows_missing_product_name
from public.product_locations pl;

select * from public.legacy_product_location_rescue_status_v1;
