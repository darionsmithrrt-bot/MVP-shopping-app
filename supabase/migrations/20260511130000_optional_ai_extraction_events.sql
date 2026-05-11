-- Optional table for tracking AI extraction events and confidence metrics
-- Use this for analytics and debugging AI extraction quality

create table if not exists public.ai_extraction_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now(),
  
  -- Product context
  barcode text,
  product_name text,
  
  -- Extraction metadata
  image_roles jsonb, -- {"product_label": {...}, "size_label": {...}, "price_sign": {...}}
  ai_provider text, -- "openai", "anthropic", etc.
  
  -- Success/failure tracking
  success boolean default false,
  error_message text,
  
  -- Confidence scores
  confidence jsonb, -- {product_confidence: 0.95, brand_confidence: 0.87, size_confidence: 0.92, ...}
  
  -- Extracted field values (for analytics)
  extracted_fields jsonb, -- {product_name: "...", brand: "...", size_value: "...", price: "...", ...}
  
  -- Do NOT store API keys or sensitive credentials
  
  -- Index for querying by product
  constraint ai_extraction_events_barcode_idx unique (barcode, created_at)
);

-- RLS: allow authenticated users to view their own extraction events (if needed)
alter table public.ai_extraction_events enable row level security;

-- Allow authenticated users to insert events
create policy "allow_authenticated_ai_events_insert" on public.ai_extraction_events
  for insert
  to authenticated
  with check (true);

-- Allow authenticated users to select their own events
create policy "allow_authenticated_ai_events_select" on public.ai_extraction_events
  for select
  to authenticated
  using (true);

-- Create index for common queries
create index idx_ai_extraction_events_created_at on public.ai_extraction_events(created_at desc);
create index idx_ai_extraction_events_barcode on public.ai_extraction_events(barcode);
create index idx_ai_extraction_events_success on public.ai_extraction_events(success);
create index idx_ai_extraction_events_provider on public.ai_extraction_events(ai_provider);
