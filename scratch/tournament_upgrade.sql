-- Add tr_id to tournaments
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS tr_id TEXT UNIQUE;

-- Add round to matches
ALTER TABLE matches ADD COLUMN IF NOT EXISTS round INTEGER DEFAULT 1;

-- Create tournament_leaderboard table
CREATE TABLE IF NOT EXISTS tournament_leaderboard (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id   UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rank            INTEGER NOT NULL,
  prize           NUMERIC DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tournament_id, user_id)
);

-- Initialize TR_ID sequence logic
-- We'll use a simple counter based on existing tournaments for now, 
-- or a dedicated sequence if preferred.
CREATE SEQUENCE IF NOT EXISTS tournament_tr_id_seq START 1;

-- Function to generate TR ID
CREATE OR REPLACE FUNCTION generate_tr_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.type = 'paid' AND NEW.tr_id IS NULL THEN
    NEW.tr_id := 'TR-' || nextval('tournament_tr_id_seq')::TEXT;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for TR ID
DROP TRIGGER IF EXISTS tr_id_trigger ON tournaments;
CREATE TRIGGER tr_id_trigger
BEFORE INSERT ON tournaments
FOR EACH ROW
EXECUTE FUNCTION generate_tr_id();

-- Update existing paid tournaments if any (optional)
UPDATE tournaments SET tr_id = 'TR-' || id::text WHERE type = 'paid' AND tr_id IS NULL;
