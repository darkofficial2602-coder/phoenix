const { supabase } = require('../config/supabase');
const { createClient } = require('@supabase/supabase-js');

// Helper: normalize username to strict @username format
const normalizeUsername = (raw) => {
  if (!raw) return '';
  let u = raw.trim().replace(/\s+/g, ''); // remove all spaces
  u = u.replace(/^@+/, '');               // strip leading @ signs
  u = '@' + u;                            // add single @
  return u.toLowerCase();
};

// Helper: validate @username format
const isValidUsername = (username) => {
  // Must start with @, followed by 4+ alphanumeric/underscore chars, no spaces
  return /^@[a-z0-9_]{4,20}$/.test(username);
};

// Helper: calculate rank from IQ
const calcRank = (iq) => {
  if (iq >= 2000) return 'Platinum';
  if (iq >= 1000) return 'Gold';
  if (iq >= 500) return 'Silver';
  return 'Bronze';
};

const register = async (req, res) => {
  try {
    const { username: rawUsername, email, password, phone, full_name } = req.body;
    if (!rawUsername || !email || !password) {
      return res.status(400).json({ success: false, message: 'Username, email, and password required.' });
    }

    // Normalize and validate @username
    const username = normalizeUsername(rawUsername);
    if (!isValidUsername(username)) {
      return res.status(400).json({ success: false, message: 'Username must be @username format: 4-20 characters (a-z, 0-9, underscore), no spaces.' });
    }

    // Check username uniqueness
    const { data: existing } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', username)
      .maybeSingle();
    if (existing) return res.status(400).json({ success: false, message: 'Username already taken.' });

    // Register via Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // skip email verification for now
    });
    if (authError) return res.status(400).json({ success: false, message: authError.message });

    const userId = authData.user.id;

    // Create profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .insert({ id: userId, username, full_name: full_name || '', phone: phone || '' })
      .select()
      .single();
    
    if (profileError) {
      await supabase.auth.admin.deleteUser(userId);
      return res.status(400).json({ success: false, message: profileError.message });
    }

    // Create wallet
    await supabase.from('wallets').insert({ user_id: userId });

    // Welcome notification
    await supabase.from('notifications').insert({
      user_id: userId, type: 'welcome',
      title: 'Welcome to PHOENIX X! ♔',
      message: 'Your account is ready. Complete KYC to unlock wallet & paid tournaments.',
    });

    // Sign in to get session token (using a fresh client to not mutate global)
    const tempClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: signInData, error: signInError } = await tempClient.auth.signInWithPassword({ email, password });
    if (signInError) return res.status(400).json({ success: false, message: signInError.message });

    res.status(201).json({
      success: true,
      message: 'Account created!',
      token: signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
      user: {
        id: profile.id, username: profile.username, email,
        player_id: profile.player_id, iq_level: profile.iq_level,
        rank: profile.rank, kyc_status: profile.kyc_status,
        is_admin: profile.is_admin, wallet_balance: 0,
      },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required.' });

    // Sign in with fresh client to not mutate global service_role client
    const tempClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data, error } = await tempClient.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ success: false, message: 'Invalid credentials.' });

    const userId = data.user.id;

    // Get profile + wallet
    const [{ data: profile }, { data: wallet }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('wallets').select('balance').eq('user_id', userId).maybeSingle(),
    ]);

    if (!profile) return res.status(404).json({ success: false, message: 'Profile not found.' });
    if (profile.status === 'blocked' || profile.status === 'banned') {
      return res.status(403).json({ success: false, message: 'Account blocked. Contact support.' });
    }

    // Mark online
    await supabase.from('profiles').update({ is_online: true, last_seen: new Date().toISOString() }).eq('id', userId);

    // Count unread notifications
    const { count: unreadCount } = await supabase
      .from('notifications').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('read', false);

    res.json({
      success: true,
      token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      user: {
        id: profile.id, username: profile.username, email: data.user.email,
        player_id: profile.player_id, iq_level: profile.iq_level,
        rank: profile.rank, kyc_status: profile.kyc_status,
        profile_image: profile.profile_image, is_admin: profile.is_admin,
        stats: { total_matches: profile.total_matches, wins: profile.wins, losses: profile.losses, draws: profile.draws, win_rate: profile.win_rate, current_streak: profile.current_streak, best_streak: profile.best_streak },
        settings: profile.settings,
        wallet_balance: wallet?.balance || 0,
        unread_notifications: unreadCount || 0,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const logout = async (req, res) => {
  try {
    await supabase.from('profiles').update({ is_online: false, last_seen: new Date().toISOString() }).eq('id', req.user.id);
    res.json({ success: true, message: 'Logged out.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const refreshToken = async (req, res) => {
  try {
    const { refresh_token } = req.body;
    // Temp Anon Client to properly process refreshing JWT without caching bugs
    const tempClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data, error } = await tempClient.auth.refreshSession({ refresh_token });
    if (error) return res.status(401).json({ success: false, message: 'Invalid refresh token.' });
    res.json({ success: true, token: data.session.access_token, refresh_token: data.session.refresh_token });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const getMe = async (req, res) => {
  try {
    const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).maybeSingle();
    const { count: unread } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('read', false);
    res.json({ success: true, user: { ...req.user, wallet_balance: wallet?.balance || 0, unread_notifications: unread || 0 } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const oauthLogin = async (req, res) => {
  try {
    const { access_token, refresh_token: oauth_refresh } = req.body;
    if (!access_token) return res.status(400).json({ success: false, message: 'Access token required.' });

    // Verify the token with Supabase to get the authenticated user
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(access_token);
    if (authError || !authUser) {
      return res.status(401).json({ success: false, message: 'Invalid or expired OAuth token.' });
    }

    const provider = authUser.app_metadata?.provider;

    const userId = authUser.id;
    const email = authUser.email;

    // Check if profile exists
    let { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    // If no profile, create one (first-time OAuth login)
    if (!profile) {
      const rawName = (authUser.user_metadata?.full_name || email.split('@')[0])
        .toLowerCase().replace(/[^a-z0-9_]/g, '_').substring(0, 20);

      // Normalize to @username format
      let finalUsername = normalizeUsername(rawName);
      const namePart = finalUsername.replace('@', '');
      if (namePart.length < 4) {
        finalUsername = '@player' + Math.floor(Math.random() * 9999);
      }

      // Ensure unique @username
      let attempts = 0;
      while (attempts < 5) {
          const { data: existingUser } = await supabase
            .from('profiles')
            .select('id')
            .eq('username', finalUsername)
            .maybeSingle();
          if (!existingUser) break;
          finalUsername = normalizeUsername(rawName + '_' + Math.floor(Math.random() * 9999));
          attempts++;
      }

      const { data: newProfile, error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: userId,
          username: finalUsername,
          full_name: authUser.user_metadata?.full_name || '',
          profile_image: authUser.user_metadata?.avatar_url || '',
        })
        .select()
        .single();

      if (profileError) return res.status(400).json({ success: false, message: profileError.message });
      profile = newProfile;

      // Create wallet
      await supabase.from('wallets').insert({ user_id: userId });

      // Welcome notification
      await supabase.from('notifications').insert({
        user_id: userId, type: 'welcome',
        title: 'Welcome to PHOENIX X! ♔',
        message: 'Signed in successfully. Complete KYC to unlock wallet & paid tournaments.',
      });
    }

    // Check account status
    if (profile.status === 'blocked' || profile.status === 'banned') {
      return res.status(403).json({ success: false, message: 'Account blocked. Contact support.' });
    }

    // Mark online
    await supabase.from('profiles').update({ is_online: true, last_seen: new Date().toISOString() }).eq('id', userId);

    // Get wallet + unread count
    const [{ data: wallet }, { count: unreadCount }] = await Promise.all([
      supabase.from('wallets').select('balance').eq('user_id', userId).maybeSingle(),
      supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('read', false),
    ]);

    res.json({
      success: true,
      token: access_token,
      refresh_token: oauth_refresh || '',
      user: {
        id: profile.id, username: profile.username, email,
        player_id: profile.player_id, iq_level: profile.iq_level,
        rank: profile.rank, kyc_status: profile.kyc_status,
        profile_image: profile.profile_image, is_admin: profile.is_admin,
        stats: { total_matches: profile.total_matches, wins: profile.wins, losses: profile.losses, draws: profile.draws, win_rate: profile.win_rate, current_streak: profile.current_streak, best_streak: profile.best_streak },
        settings: profile.settings,
        wallet_balance: wallet?.balance || 0,
        unread_notifications: unreadCount || 0,
      },
    });
  } catch (err) {
    console.error('OAuth login error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { register, login, logout, refreshToken, getMe, oauthLogin };
