-- Read-only RPC for store-aware cart comparison across canonical product identity.
-- No destructive side effects.

create or replace function public.find_cheapest_store_for_cart_v1(
  cart_items jsonb,
  brand_mode text default 'flexible'
)
returns table (
  store_id uuid,
  store_name text,
  matched_count integer,
  total_item_count integer,
  coverage_pct numeric,
  total_price numeric,
  avg_confidence numeric,
  decision_reason text,
  item_breakdown jsonb
)
language sql
stable
as $$
with parsed_cart as (
  select
    c.ord::int as cart_idx,
    nullif(btrim(c.item ->> 'barcode'), '') as barcode,
    nullif(btrim(c.item ->> 'canonical_product_key'), '') as canonical_product_key,
    nullif(btrim(coalesce(c.item ->> 'product_name', c.item ->> 'name')), '') as product_name,
    nullif(btrim(c.item ->> 'brand'), '') as brand,
    nullif(btrim(c.item ->> 'category'), '') as category,
    nullif(btrim(c.item ->> 'size_value'), '') as size_value,
    nullif(btrim(c.item ->> 'size_unit'), '') as size_unit,
    nullif(btrim(c.item ->> 'display_size'), '') as display_size,
    public.mvp_norm_text(c.item ->> 'brand') as brand_n,
    public.mvp_norm_text(coalesce(c.item ->> 'product_name', c.item ->> 'name')) as product_name_n,
    public.mvp_norm_text(c.item ->> 'category') as category_n,
    coalesce(
      nullif(concat_ws(' ', public.mvp_norm_text(c.item ->> 'size_value'), public.mvp_norm_size_unit(c.item ->> 'size_unit')), ''),
      public.mvp_norm_text(c.item ->> 'display_size')
    ) as size_n
  from jsonb_array_elements(coalesce(cart_items, '[]'::jsonb)) with ordinality as c(item, ord)
),
cart_count as (
  select count(*)::int as total_item_count
  from parsed_cart
),
price_rows as (
  select
    sp.store_id,
    sp.store_name,
    nullif(btrim(sp.barcode), '') as barcode,
    nullif(btrim(sp.canonical_product_key), '') as canonical_product_key,
    sp.product_name,
    sp.brand,
    sp.category,
    sp.size_value,
    sp.size_unit,
    sp.display_size,
    sp.aisle,
    sp.section,
    sp.shelf,
    case
      when coalesce(sp.avg_price, 0) > 0 then sp.avg_price
      when coalesce(sp.price, 0) > 0 then sp.price
      else null
    end as price_used,
    sp.price_type,
    coalesce(sp.confidence_score, 0) as confidence_score,
    public.mvp_norm_text(sp.brand) as brand_n,
    public.mvp_norm_text(sp.product_name) as product_name_n,
    public.mvp_norm_text(sp.category) as category_n,
    coalesce(
      nullif(concat_ws(' ', public.mvp_norm_text(sp.size_value), public.mvp_norm_size_unit(sp.size_unit)), ''),
      public.mvp_norm_text(sp.display_size)
    ) as size_n
  from public.store_product_price_map_v1 sp
  where sp.store_id is not null
    and (
      coalesce(sp.avg_price, 0) > 0
      or coalesce(sp.price, 0) > 0
    )
),
candidate_matches as (
  select
    pc.cart_idx,
    pc.product_name as cart_product_name,
    pc.brand as cart_brand,
    pc.category as cart_category,
    pc.size_value as cart_size_value,
    pc.size_unit as cart_size_unit,
    pc.display_size as cart_display_size,
    pr.store_id,
    pr.store_name,
    pr.product_name as matched_product_name,
    pr.brand as matched_brand,
    pr.size_value as matched_size_value,
    pr.size_unit as matched_size_unit,
    pr.display_size as matched_display_size,
    pr.price_used,
    pr.price_type,
    pr.aisle,
    pr.section,
    pr.shelf,
    pr.confidence_score,
    case
      when pc.barcode is not null and pr.barcode is not null and pc.barcode = pr.barcode then 'barcode'
      when pc.canonical_product_key is not null
        and pr.canonical_product_key is not null
        and pc.canonical_product_key = pr.canonical_product_key
        and (
          lower(coalesce(brand_mode, 'flexible')) <> 'brand_match'
          or (
            pc.brand_n is not null
            and pr.brand_n is not null
            and pc.brand_n = pr.brand_n
          )
        )
      then 'canonical_key'
      when pc.product_name_n is not null
        and pr.product_name_n is not null
        and pc.product_name_n = pr.product_name_n
        and pc.size_n is not null
        and pr.size_n is not null
        and pc.size_n = pr.size_n
        and pc.brand_n is not null
        and pr.brand_n is not null
        and pc.brand_n = pr.brand_n
      then 'strict_identity'
      when lower(coalesce(brand_mode, 'flexible')) = 'flexible'
        and pc.product_name_n is not null
        and pr.product_name_n is not null
        and pc.product_name_n = pr.product_name_n
        and pc.size_n is not null
        and pr.size_n is not null
        and pc.size_n = pr.size_n
        and (
          (pc.brand_n is not null and pr.brand_n is not null and pc.brand_n = pr.brand_n)
          or pc.brand_n is null
          or pr.brand_n is null
        )
        and (
          pc.category_n is null
          or pr.category_n is null
          or pc.category_n = pr.category_n
        )
      then 'flexible_identity'
      else null
    end as match_method,
    case
      when pc.barcode is not null and pr.barcode is not null and pc.barcode = pr.barcode then 1
      when pc.canonical_product_key is not null
        and pr.canonical_product_key is not null
        and pc.canonical_product_key = pr.canonical_product_key
      then 2
      when pc.product_name_n is not null
        and pr.product_name_n is not null
        and pc.product_name_n = pr.product_name_n
        and pc.size_n is not null
        and pr.size_n is not null
        and pc.size_n = pr.size_n
        and pc.brand_n is not null
        and pr.brand_n is not null
        and pc.brand_n = pr.brand_n
      then 3
      else 4
    end as match_priority
  from parsed_cart pc
  join price_rows pr on (
    (pc.barcode is not null and pr.barcode is not null and pc.barcode = pr.barcode)
    or (
      pc.canonical_product_key is not null
      and pr.canonical_product_key is not null
      and pc.canonical_product_key = pr.canonical_product_key
    )
    or (
      pc.product_name_n is not null
      and pr.product_name_n is not null
      and pc.product_name_n = pr.product_name_n
      and pc.size_n is not null
      and pr.size_n is not null
      and pc.size_n = pr.size_n
    )
  )
  where pr.price_used is not null
),
ranked_matches as (
  select
    cm.*,
    row_number() over (
      partition by cm.store_id, cm.cart_idx
      order by
        cm.match_priority asc,
        cm.confidence_score desc,
        cm.price_used asc,
        cm.matched_product_name asc
    ) as rn
  from candidate_matches cm
  where cm.match_method is not null
),
selected_matches as (
  select *
  from ranked_matches
  where rn = 1
),
store_rollup as (
  select
    sm.store_id,
    max(sm.store_name) as store_name,
    count(*)::int as matched_count,
    sum(sm.price_used) as total_price,
    round(avg(sm.confidence_score)::numeric, 2) as avg_confidence,
    jsonb_agg(
      jsonb_build_object(
        'cart_product_name', coalesce(sm.cart_product_name, 'Unknown product'),
        'matched_product_name', coalesce(sm.matched_product_name, 'Unknown product'),
        'brand', sm.matched_brand,
        'size', nullif(concat_ws(' ', sm.matched_size_value, sm.matched_size_unit), ''),
        'price_used', sm.price_used,
        'price_type', sm.price_type,
        'aisle', sm.aisle,
        'section', sm.section,
        'shelf', sm.shelf,
        'confidence_score', sm.confidence_score,
        'match_method', sm.match_method
      )
      order by sm.cart_idx
    ) as item_breakdown
  from selected_matches sm
  group by sm.store_id
),
scored as (
  select
    sr.store_id,
    sr.store_name,
    sr.matched_count,
    cc.total_item_count,
    case
      when cc.total_item_count > 0 then round((sr.matched_count::numeric * 100.0) / cc.total_item_count::numeric, 2)
      else 0
    end as coverage_pct,
    sr.total_price,
    sr.avg_confidence,
    sr.item_breakdown
  from store_rollup sr
  cross join cart_count cc
),
top_stats as (
  select
    coalesce(max(matched_count), 0) as max_matched_count,
    coalesce(min(total_price) filter (where matched_count = (select max(matched_count) from scored)), 0) as min_price_at_max_coverage
  from scored
)
select
  s.store_id,
  s.store_name,
  s.matched_count,
  s.total_item_count,
  s.coverage_pct,
  s.total_price,
  s.avg_confidence,
  case
    when s.matched_count = ts.max_matched_count
      and s.total_price = ts.min_price_at_max_coverage
      and s.matched_count = s.total_item_count
      then format(
        'Chosen because it matched %s of %s cart items and had the lowest total price.',
        s.matched_count,
        s.total_item_count
      )
    when s.matched_count = ts.max_matched_count
      and s.total_price = ts.min_price_at_max_coverage
      and s.matched_count < s.total_item_count
      then format(
        'Partial match only: this store matched %s of %s cart items.',
        s.matched_count,
        s.total_item_count
      )
    when s.matched_count = ts.max_matched_count
      then 'Chosen because it had better item coverage than other stores.'
    else format(
      'Partial match only: this store matched %s of %s cart items.',
      s.matched_count,
      s.total_item_count
    )
  end as decision_reason,
  s.item_breakdown
from scored s
cross join top_stats ts
order by
  s.coverage_pct desc,
  s.total_price asc,
  s.avg_confidence desc;
$$;

-- Simple RPC test call using sample cart JSON objects (no test data inserted).
select *
from public.find_cheapest_store_for_cart_v1(
  jsonb_build_array(
    jsonb_build_object(
      'barcode', null,
      'canonical_product_key', 'sunhearth|whole milk|1 gallon',
      'product_name', 'SunHearth Whole Milk',
      'brand', 'SunHearth',
      'category', 'dairy',
      'size_value', '1',
      'size_unit', 'gallon',
      'display_size', '1 gallon',
      'quantity', '1'
    ),
    jsonb_build_object(
      'barcode', null,
      'canonical_product_key', 'suave|men ocean charge body wash|28 fl oz',
      'product_name', 'Suave Men Ocean Charge Body Wash',
      'brand', 'Suave',
      'category', 'personal care',
      'size_value', '28',
      'size_unit', 'fl oz',
      'display_size', '28 fl oz',
      'quantity', '1'
    )
  ),
  'flexible'
);
