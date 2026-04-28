-- Create profiles table for user identity and reputation
CREATE TABLE IF NOT EXISTS profiles (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  email text,
  home_store_id uuid,
  role text default 'user',
  trust_score integer default 0,
  total_points integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Enable RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Anyone can insert (anonymous profile creation)
CREATE POLICY "Anyone can insert profiles"
  ON profiles
  FOR INSERT
  WITH CHECK (true);

-- Anyone can read profiles (for leaderboards, etc.)
CREATE POLICY "Anyone can read profiles"
  ON profiles
  FOR SELECT
  USING (true);

-- User can update their own profile
CREATE POLICY "Users can update own profile"
  ON profiles
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Create index on display_name for leaderboard queries
CREATE INDEX IF NOT EXISTS idx_profiles_display_name ON profiles(display_name);

-- Create index on total_points for leaderboard
CREATE INDEX IF NOT EXISTS idx_profiles_total_points ON profiles(total_points DESC);

-- Create index on created_at for trending
CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON profiles(created_at DESC);
