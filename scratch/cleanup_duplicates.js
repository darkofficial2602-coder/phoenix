const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function verifyAndCleanup() {
    console.log('🔍 Verifying tournament existence...');
    const { data: tournaments } = await supabase
        .from('tournaments')
        .select('id, entry_fee, current_players, status')
        .eq('type', 'paid')
        .eq('status', 'upcoming');

    console.log(`Found ${tournaments.length} upcoming paid tournaments.`);
    
    const feeMap = new Map();
    const toDelete = [];

    for (const t of tournaments) {
        if (!feeMap.has(t.entry_fee)) {
            feeMap.set(t.entry_fee, t.id);
            console.log(`✅ Keeping ID: ${t.id} for Fee: ${t.entry_fee}`);
        } else {
            if (t.current_players === 0) {
                toDelete.push(t.id);
            }
        }
    }

    if (toDelete.length > 0) {
        console.log(`🗑️ Attempting to delete ${toDelete.length} duplicates...`);
        const { error, data } = await supabase
            .from('tournaments')
            .delete()
            .in('id', toDelete)
            .select(); // Add select to see what was actually deleted

        if (error) {
            console.error('❌ Delete Error:', error.message);
        } else {
            console.log(`✅ Successfully deleted ${data.length} rows.`);
        }
    } else {
        console.log('✨ No duplicates found.');
    }
}

verifyAndCleanup();
