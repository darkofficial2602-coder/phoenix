const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = 'https://jxzalgpvuamfmoysvkkz.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4emFsZ3B2dWFtZm1veXN2a2t6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTgzOTY1NCwiZXhwIjoyMDkxNDE1NjU0fQ.SQ1uFQm76DN5B8vC2UhJbcK0DjmWnWbBacf8EkXVXXU';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function check() {
  const { data: tourneys } = await supabase.from('tournaments').select('*').order('created_at', { ascending: false }).limit(5);
  if (!tourneys) return console.log('No tournaments found.');
  for (const t of tourneys) {
    const { count } = await supabase.from('tournament_players').select('*', { count: 'exact', head: true }).eq('tournament_id', t.id);
    console.log(`TR-${t.tr_id} (ID: ${t.id}): status=${t.status}, type=${t.type}, fee=${t.entry_fee}, current=${t.current_players}, count=${count}`);
  }
}
check();
