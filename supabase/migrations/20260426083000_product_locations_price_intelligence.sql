alter table public.product_locations
  add column if not exists avg_price numeric,
  add column if not exists price_count integer default 0,
  add column if not exists price_confidence integer default 0;

update public.product_locations
set
  avg_price = case
    when avg_price is not null then avg_price
    when price is not null then price
    else null
  end,
  price_count = case
    when price_count > 0 then price_count
    when price is not null then 1
    else 0
  end,
  price_confidence = least(
    100,
    (case
      when price_count > 0 then price_count
      when price is not null then 1
      else 0
    end) * 20
  );

create or replace function public.apply_product_location_price_intelligence()
returns trigger
language plpgsql
as $$
begin
  if new.price is null then
    if tg_op = 'INSERT' then
      new.avg_price := null;
      new.price_count := coalesce(new.price_count, 0);
      new.price_confidence := least(100, new.price_count * 20);
    else
      new.avg_price := coalesce(new.avg_price, old.avg_price);
      new.price_count := coalesce(new.price_count, old.price_count, 0);
      new.price_confidence := least(100, new.price_count * 20);
    end if;

    return new;
  end if;

  if tg_op = 'INSERT' then
    new.avg_price := new.price;
    new.price_count := 1;
  else
    new.avg_price := (
      (coalesce(old.avg_price, 0) * coalesce(old.price_count, 0)) + new.price
    ) / (coalesce(old.price_count, 0) + 1);
    new.price_count := coalesce(old.price_count, 0) + 1;
  end if;

  new.price_confidence := least(100, new.price_count * 20);

  return new;
end;
$$;

drop trigger if exists trg_product_locations_price_intelligence on public.product_locations;

create trigger trg_product_locations_price_intelligence
before insert or update of price on public.product_locations
for each row
execute function public.apply_product_location_price_intelligence();
