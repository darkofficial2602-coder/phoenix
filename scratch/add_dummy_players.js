const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = 'https://jxzalgpvuamfmoysvkkz.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4emFsZ3B2dWFtZm1veXN2a2t6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTgzOTY1NCwiZXhwIjoyMDkxNDE1NjU0fQ.SQ1uFQm76DN5B8vC2UhJbcK0DjmWnWbBacf8EkXVXXU';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const TOURNAMENT_ID = '722e0be3-6b1a-45bd-8e9f-8276582c5eee'; // TR-18 (100 Coin)

async function addPlayers() {
  console.log(`Adding 15 players to Tournament ${TOURNAMENT_ID}...`);
  
  // 1. Get 15 profiles
  const { data: profiles, error: pError } = await supabase.from('profiles').select('id, username').limit(15);
  if (pError) return console.error('Error fetching profiles:', pError);

  // 2. Add to tournament_players
  const playersToAdd = profiles.map(p => ({
    tournament_id: TOURNAMENT_ID,
    user_id: p.id
  }));

  const { error: joinError } = await supabase.from('tournament_players').insert(playersToAdd);
  if (joinError) return console.error('Error joining players:', joinError);

  // 3. Update current_players count
  const { error: updateError } = await supabase
    .from('tournaments')
    .update({ current_players: 15 })
    .eq('id', TOURNAMENT_ID);

  if (updateError) return console.error('Error updating tournament count:', updateError);

  console.log('Successfully added 15 players and updated count.');
}

addPlayers();
