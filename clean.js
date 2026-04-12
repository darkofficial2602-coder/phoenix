require('dotenv').config({ path: './.env' });
const { supabase } = require('./backend/config/supabase');

async function clean() {
  const { data: upcoming } = await supabase.from('tournaments')
      .select('id, start_time').eq('type', 'free').eq('status', 'upcoming')
      .order('start_time', { ascending: true });
      
  if (upcoming && upcoming.length > 4) {
      // Keep only the first 4, delete the rest
      const keepIds = upcoming.slice(0, 4).map(t => t.id);
      const { error } = await supabase.from('tournaments')
         .delete()
         .eq('type', 'free')
         .eq('status', 'upcoming')
         .not('id', 'in', `(${keepIds.join(',')})`);
      if (error) console.log(error);
      else console.log('Cleaned extra upcoming tournaments.');
  } else {
      console.log('No extra upcoming tournaments found.');
  }
}
clean();
