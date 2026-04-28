-- Add user profile tracking to location_confirmations and product_locations tables
-- These columns support trust score weighting and contributor attribution

ALTER TABLE location_confirmations
  ADD COLUMN IF NOT EXISTS user_profile_id uuid,
  ADD COLUMN IF NOT EXISTS user_trust_score_at_time integer DEFAULT 0;

ALTER TABLE product_locations
  ADD COLUMN IF NOT EXISTS last_user_profile_id uuid,
  ADD COLUMN IF NOT EXISTS last_user_trust_score integer DEFAULT 0;

-- Create indexes for trust score queries (future leaderboard/reporting)
CREATE INDEX IF NOT EXISTS idx_location_confirmations_user_profile_id 
  ON location_confirmations(user_profile_id);

CREATE INDEX IF NOT EXISTS idx_product_locations_last_user_profile_id 
  ON product_locations(last_user_profile_id);

CREATE INDEX IF NOT EXISTS idx_product_locations_user_trust_score 
  ON product_locations(last_user_trust_score DESC);
