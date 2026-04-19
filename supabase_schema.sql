-- ============================================================
-- PHOENIX X — Supabase PostgreSQL Schema
-- Run this entire file in Supabase → SQL Editor → New query
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PROFILES (extends Supabase auth.users)
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username        TEXT UNIQUE NOT NULL,
  full_name       TEXT DEFAULT '',
  phone           TEXT DEFAULT '',
  player_id       TEXT UNIQUE,
  profile_image   TEXT DEFAULT '',
  iq_level        INTEGER DEFAULT 100,
  rank            TEXT DEFAULT 'Bronze' CHECK (rank IN ('Bronze','Silver','Gold','Platinum')),
  kyc_status      TEXT DEFAULT 'not_verified' CHECK (kyc_status IN ('not_verified','pending','verified','approved','rejected')),
  kyc_verified    BOOLEAN DEFAULT FALSE,
  kyc_rejection_reason TEXT DEFAULT '',
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','blocked','banned')),
  is_admin        BOOLEAN DEFAULT FALSE,
  is_online       BOOLEAN DEFAULT FALSE,
  last_seen       TIMESTAMPTZ DEFAULT NOW(),
  -- Stats
  total_matches   INTEGER DEFAULT 0,
  wins            INTEGER DEFAULT 0,
  losses          INTEGER DEFAULT 0,
  draws           INTEGER DEFAULT 0,
  win_rate        NUMERIC DEFAULT 0,
  current_streak  INTEGER DEFAULT 0,
  best_streak     INTEGER DEFAULT 0,
  -- Settings (stored as JSON)
  settings        JSONB DEFAULT '{
    "theme": "dark",
    "highlight_moves": true,
    "legal_moves": true,
    "premoves": false,
    "result_animation": true,
    "language": "en",
    "chat_enabled": true,
    "notifications": {"match_found": true, "tournament": true, "friend_request": true},
    "privacy": {"visibility": "public", "online_status": true, "friend_requests": "everyone"},
    "challenge_mode": "auto_accept"
  }'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-generate player_id
CREATE OR REPLACE FUNCTION generate_player_id()
RETURNS TRIGGER AS $$
DECLARE
  seq_val INTEGER;
BEGIN
  SELECT COUNT(*) + 1 INTO seq_val FROM profiles;
  NEW.player_id := 'PX-' || LPAD(seq_val::TEXT, 6, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_player_id
  BEFORE INSERT ON profiles
  FOR EACH ROW
  WHEN (NEW.player_id IS NULL)
  EXECUTE FUNCTION generate_player_id();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- WALLETS
-- ============================================================
CREATE TABLE IF NOT EXISTS wallets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID UNIQUE NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  balance         NUMERIC DEFAULT 0 CHECK (balance >= 0),
  total_deposited NUMERIC DEFAULT 0,
  total_withdrawn NUMERIC DEFAULT 0,
  total_won       NUMERIC DEFAULT 0,
  total_spent     NUMERIC DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER wallets_updated_at
  BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- KYC
-- ============================================================
CREATE TABLE IF NOT EXISTS kyc (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID UNIQUE NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('aadhaar','pan')),
  name            TEXT NOT NULL,
  id_number       TEXT NOT NULL,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  rejection_reason TEXT DEFAULT '',
  reviewed_by     UUID REFERENCES profiles(id),
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER kyc_updated_at
  BEFORE UPDATE ON kyc
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- KYC REQUESTS (New System)
-- ============================================================
CREATE TABLE IF NOT EXISTS kyc_requests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID UNIQUE NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  aadhaar_number  TEXT NOT NULL,
  name            TEXT NOT NULL,
  dob             DATE NOT NULL,
  address_line1   TEXT NOT NULL,
  address_line2   TEXT NOT NULL,
  address_line3   TEXT NOT NULL,
  pincode         TEXT NOT NULL,
  front_image_url TEXT,
  back_image_url  TEXT,
  full_image_url  TEXT,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER kyc_requests_updated_at
  BEFORE UPDATE ON kyc_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- MATCHES
-- ============================================================
CREATE TABLE IF NOT EXISTS matches (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player1_id      UUID REFERENCES profiles(id),
  player2_id      UUID REFERENCES profiles(id),
  match_type      TEXT NOT NULL CHECK (match_type IN ('random','friend','room','bot','tournament')),
  timer_type      INTEGER CHECK (timer_type IN (1,3,5,10)),
  tournament_id   UUID,
  result          TEXT DEFAULT 'ongoing' CHECK (result IN ('player1_win','player2_win','draw','ongoing','cancelled')),
  winner_id       UUID REFERENCES profiles(id),
  iq_change_p1    INTEGER DEFAULT 0,
  iq_change_p2    INTEGER DEFAULT 0,
  moves           JSONB DEFAULT '[]'::jsonb,
  room_id         TEXT,
  status          TEXT DEFAULT 'waiting' CHECK (status IN ('waiting','active','finished','cancelled')),
  bot_difficulty  INTEGER,
  flagged_cheating BOOLEAN DEFAULT FALSE,
  cheat_reason    TEXT DEFAULT '',
  start_time      TIMESTAMPTZ,
  end_time        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX matches_player1_idx ON matches(player1_id);
CREATE INDEX matches_player2_idx ON matches(player2_id);
CREATE INDEX matches_status_idx ON matches(status);

-- ============================================================
-- TOURNAMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS tournaments (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('free','paid')),
  format            TEXT DEFAULT 'standard' CHECK (format IN ('quick','battle','standard')),
  entry_fee         NUMERIC DEFAULT 0,
  timer_type        INTEGER NOT NULL CHECK (timer_type IN (1,3,5,10)),
  max_players       INTEGER DEFAULT 500,
  current_players   INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'upcoming' CHECK (status IN ('upcoming','full','live','starting','completed','cancelled')),
  start_time        TIMESTAMPTZ NOT NULL,
  end_time          TIMESTAMPTZ,
  duration_minutes  INTEGER DEFAULT 30,
  prize_first       NUMERIC DEFAULT 0,
  prize_second      NUMERIC DEFAULT 0,
  prize_third       NUMERIC DEFAULT 0,
  prize_pool        NUMERIC DEFAULT 0,
  created_by        UUID REFERENCES profiles(id),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TOURNAMENT PLAYERS
-- ============================================================
CREATE TABLE IF NOT EXISTS tournament_players (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id  UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  score          NUMERIC DEFAULT 0,
  wins           INTEGER DEFAULT 0,
  losses         INTEGER DEFAULT 0,
  draws          INTEGER DEFAULT 0,
  rank           INTEGER DEFAULT 0,
  status         TEXT DEFAULT 'active' CHECK (status IN ('active','eliminated')),
  joined_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tournament_id, user_id)
);

CREATE INDEX tp_tournament_idx ON tournament_players(tournament_id);
CREATE INDEX tp_user_idx ON tournament_players(user_id);

-- ============================================================
-- TRANSACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type                 TEXT NOT NULL CHECK (type IN ('deposit','withdraw','tournament_entry','tournament_prize','refund')),
  amount               NUMERIC NOT NULL,
  status               TEXT DEFAULT 'pending' CHECK (status IN ('pending','success','failed','cancelled')),
  razorpay_order_id    TEXT DEFAULT '',
  razorpay_payment_id  TEXT DEFAULT '',
  reference_id         TEXT DEFAULT '',
  description          TEXT DEFAULT '',
  balance_after        NUMERIC DEFAULT 0,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX txn_user_idx ON transactions(user_id);
CREATE INDEX txn_type_idx ON transactions(type);

-- ============================================================
-- WITHDRAW REQUESTS
-- ============================================================
CREATE TABLE IF NOT EXISTS withdraw_requests (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount           NUMERIC NOT NULL CHECK (amount >= 30),
  status           TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','completed')),
  queue_position   INTEGER DEFAULT 0,
  rejection_reason TEXT DEFAULT '',
  processed_by     UUID REFERENCES profiles(id),
  processed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX wr_status_idx ON withdraw_requests(status);
CREATE INDEX wr_user_idx ON withdraw_requests(user_id);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  read       BOOLEAN DEFAULT FALSE,
  data       JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX notif_user_idx ON notifications(user_id);
CREATE INDEX notif_read_idx ON notifications(read);

-- ============================================================
-- FEEDBACKS
-- ============================================================
CREATE TABLE IF NOT EXISTS feedbacks (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID REFERENCES profiles(id) ON DELETE CASCADE,
  rating       INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  message      TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER feedbacks_updated_at
  BEFORE UPDATE ON feedbacks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- REPORTS
-- ============================================================
CREATE TABLE IF NOT EXISTS reports (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id      UUID REFERENCES profiles(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('issue','player')),
  reported_user    TEXT,
  issue_type       TEXT,
  priority         TEXT,
  reason           TEXT,
  description      TEXT NOT NULL,
  screenshot_url   TEXT,
  status           TEXT DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER reports_updated_at
  BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- FRIEND SYSTEM
-- ============================================================
CREATE TABLE IF NOT EXISTS friend_requests (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  receiver_id  UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sender_id, receiver_id)
);

CREATE TRIGGER friend_requests_updated_at
  BEFORE UPDATE ON friend_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS friends (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user1_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user2_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user1_id, user2_id)
);

-- ============================================================
-- ROW LEVEL SECURITY (RLS) — important for Supabase!
-- ============================================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (true);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wallets_own" ON wallets USING (auth.uid() = user_id);

ALTER TABLE kyc ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kyc_own" ON kyc USING (auth.uid() = user_id);

ALTER TABLE kyc_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kyc_requests_own" ON kyc_requests USING (auth.uid() = user_id);

ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "matches_select" ON matches FOR SELECT USING (
  auth.uid() = player1_id OR auth.uid() = player2_id
);

ALTER TABLE tournaments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tournaments_read" ON tournaments FOR SELECT USING (true);

ALTER TABLE tournament_players ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tp_read" ON tournament_players FOR SELECT USING (true);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "txn_own" ON transactions USING (auth.uid() = user_id);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notif_own" ON notifications USING (auth.uid() = user_id);

ALTER TABLE withdraw_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wr_own" ON withdraw_requests USING (auth.uid() = user_id);

ALTER TABLE friend_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "friend_requests_select" ON friend_requests FOR SELECT USING (
  auth.uid() = sender_id OR auth.uid() = receiver_id
);

ALTER TABLE friends ENABLE ROW LEVEL SECURITY;
CREATE POLICY "friends_select" ON friends FOR SELECT USING (
  auth.uid() = user1_id OR auth.uid() = user2_id
);

-- ============================================================
-- SERVICE ROLE bypass
-- ============================================================
-- Your backend uses SUPABASE_SERVICE_KEY which bypasses ALL RLS.

SELECT 'PHOENIX X Schema created successfully! 🏆' AS status;

-- ============================================================
-- RPC: increment_tournament_score
-- ============================================================
CREATE OR REPLACE FUNCTION increment_tournament_score(
  p_tournament_id UUID, p_user_id UUID, p_score NUMERIC, p_won INTEGER, p_drew INTEGER
) RETURNS void AS $$
BEGIN
  UPDATE tournament_players
  SET 
    score = score + p_score, 
    wins = wins + p_won, 
    draws = draws + p_drew, 
    losses = losses + CASE WHEN p_won = 0 AND p_drew = 0 THEN 1 ELSE 0 END
  WHERE tournament_id = p_tournament_id AND user_id = p_user_id;
END;
$$ LANGUAGE plpgsql;
