const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SUPABASE_ANON_KEY) {
  console.error('❌ Missing SUPABASE_URL, SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

// Service client — bypasses RLS, used in all backend controllers
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Anon client — for verifying user JWTs from frontend
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

module.exports = { supabase, supabaseAnon };
