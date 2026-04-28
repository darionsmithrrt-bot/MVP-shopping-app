create unique index if not exists product_locations_unique_store_location
on public.product_locations (
  barcode,
  store_id,
  aisle,
  coalesce(section, ''),
  coalesce(shelf, '')
);
