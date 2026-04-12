const { supabase } = require('../config/supabase');

// Helper: normalize username to strict @username format
const normalizeUsername = (raw) => {
  if (!raw) return '';
  let u = raw.trim().replace(/\s+/g, '');
  u = u.replace(/^@+/, '');
  u = '@' + u;
  return u.toLowerCase();
};

// Helper: validate @username format
const isValidUsername = (username) => {
  return /^@[a-z0-9_]{4,20}$/.test(username);
};

const getProfile = async (req, res) => {
  try {
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', req.user.id).single();
    res.json({ success: true, user: profile });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const updateProfile = async (req, res) => {
  try {
    const { username: rawUsername, full_name, phone, profile_image } = req.body;
    const updates = {};

    if (rawUsername) {
      const username = normalizeUsername(rawUsername);
      if (!isValidUsername(username)) {
        return res.status(400).json({ success: false, message: 'Username must be @username format: 4-20 characters (a-z, 0-9, underscore), no spaces.' });
      }
      if (username !== req.user.username) {
        const { data: exists } = await supabase.from('profiles').select('id').eq('username', username).maybeSingle();
        if (exists) return res.status(400).json({ success: false, message: 'Username already taken.' });
      }
      updates.username = username;
    }

    if (full_name !== undefined) updates.full_name = full_name;
    if (phone !== undefined) updates.phone = phone;
    if (profile_image !== undefined) updates.profile_image = profile_image;
    const { data, error } = await supabase.from('profiles').update(updates).eq('id', req.user.id).select().single();
    if (error) return res.status(400).json({ success: false, message: error.message });
    res.json({ success: true, message: 'Profile updated.', user: data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const submitKYC = async (req, res) => {
  try {
    const { type, name, id_number } = req.body;
    if (!type || !name || !id_number) return res.status(400).json({ success: false, message: 'All fields required.' });
    if (type === 'aadhaar' && !/^\d{12}$/.test(id_number)) return res.status(400).json({ success: false, message: 'Invalid Aadhaar number (12 digits).' });
    if (type === 'pan' && !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(id_number)) return res.status(400).json({ success: false, message: 'Invalid PAN format (ABCDE1234F).' });
    if (req.user.kyc_status === 'verified') return res.status(400).json({ success: false, message: 'KYC already verified.' });

    // Upsert KYC record
    const { error: kycError } = await supabase.from('kyc').upsert({
      user_id: req.user.id, type, name, id_number, status: 'pending', rejection_reason: '',
    }, { onConflict: 'user_id' });
    if (kycError) return res.status(400).json({ success: false, message: kycError.message });

    // Update profile kyc_status
    await supabase.from('profiles').update({ kyc_status: 'pending' }).eq('id', req.user.id);

    // Notification
    await supabase.from('notifications').insert({
      user_id: req.user.id, type: 'kyc',
      title: 'KYC Submitted',
      message: 'Your KYC is under review. Usually takes up to 24 hours.',
    });

    res.json({ success: true, message: 'KYC submitted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const changePassword = async (req, res) => {
  try {
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password || new_password.length < 6) return res.status(400).json({ success: false, message: 'Current password and new password (min 6 chars) required.' });
    
    // Fetch email to use in signInWithPassword via Admin API since user might not be in req session exactly
    const { data: { user: adminUser }, error: userErr } = await supabase.auth.admin.getUserById(req.user.id);
    if (userErr || !adminUser) return res.status(400).json({ success: false, message: 'Auth session invalid.' });

    // Verify old password by attempting signin
    const { createClient } = require('@supabase/supabase-js');
    const tempClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { error: signInError } = await tempClient.auth.signInWithPassword({ email: adminUser.email, password: old_password });
    if (signInError) return res.status(401).json({ success: false, message: 'Incorrect current password.' });

    const { error } = await supabase.auth.admin.updateUserById(req.user.id, { password: new_password });
    if (error) return res.status(400).json({ success: false, message: error.message });
    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const updateSettings = async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') return res.status(400).json({ success: false, message: 'Invalid settings format.' });

    const sanitized = {
      theme: settings.theme === 'light' ? 'light' : 'dark',
      highlight_moves: !!settings.highlight_moves,
      legal_moves: !!settings.legal_moves,
      premoves: !!settings.premoves,
      result_animation: !!settings.result_animation,
      chat_enabled: !!settings.chat_enabled,
      language: typeof settings.language === 'string' ? settings.language.substring(0, 5) : 'en',
      challenge_mode: typeof settings.challenge_mode === 'string' ? settings.challenge_mode.substring(0, 20) : 'auto_accept'
    };

    if (settings.notifications && typeof settings.notifications === 'object') {
       sanitized.notifications = {
         match_found: !!settings.notifications.match_found,
         tournament: !!settings.notifications.tournament,
         friend_request: !!settings.notifications.friend_request
       };
    }
    
    if (settings.privacy && typeof settings.privacy === 'object') {
       sanitized.privacy = {
         online_status: !!settings.privacy.online_status,
         visibility: typeof settings.privacy.visibility === 'string' ? settings.privacy.visibility.substring(0, 10) : 'public',
         friend_requests: typeof settings.privacy.friend_requests === 'string' ? settings.privacy.friend_requests.substring(0, 20) : 'everyone'
       };
    }

    const { error } = await supabase.from('profiles').update({ settings: sanitized }).eq('id', req.user.id);
    if (error) return res.status(400).json({ success: false, message: error.message });
    res.json({ success: true, message: 'Settings saved.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const getNotifications = async (req, res) => {
  try {
    const { data: notifs } = await supabase.from('notifications').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(30);
    // Removed auto-mark as read to support Notification Bell Fix
    res.json({ success: true, notifications: notifs || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const markNotificationsRead = async (req, res) => {
  try {
    await supabase.from('notifications').update({ read: true }).eq('user_id', req.user.id).eq('read', false);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const getStats = async (req, res) => {
  try {
    const { data } = await supabase.from('profiles').select('iq_level, rank, total_matches, wins, losses, draws, win_rate, current_streak, best_streak').eq('id', req.user.id).single();
    res.json({ success: true, stats: { total_matches: data.total_matches, wins: data.wins, losses: data.losses, draws: data.draws, win_rate: data.win_rate, current_streak: data.current_streak, best_streak: data.best_streak }, iq_level: data.iq_level, rank: data.rank });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { getProfile, updateProfile, submitKYC, changePassword, updateSettings, getNotifications, markNotificationsRead, getStats };
