require('dotenv').config();
const { supabase } = require('./config/supabase');
async function test() {
  const { data, error } = await supabase.from('matches').insert({
    player1_id: '8642ca00-eade-4cc9-b3a6-b9cf9ba86bc9', // dummy uuid
    player2_id: '8642ca00-eade-4cc9-b3a6-b9cf9ba86bc9', 
    player1_color: 'white', 
    match_type: 'random', 
    timer_type: 10, 
    status: 'active'
  }).select();
  console.log("DATA:", data);
  console.log("ERROR:", error);
}
test();
