const { supabase } = require('../config/supabase');

const getTournaments = async (req, res) => {
  try {
    const { type, status } = req.query;
    let query = supabase.from('tournaments').select('*').order('created_at', { ascending: false }).limit(100);
    
    if (type) query = query.eq('type', type);
    
    if (status) {
        if (status === 'upcoming') query = query.in('status', ['upcoming', 'full']);
        else if (status === 'live') query = query.in('status', ['live', 'starting']);
        else query = query.eq('status', status);
    } else {
        query = query.in('status', ['upcoming', 'full', 'live', 'starting']);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    
    // Check if user is joined in each tournament
    const { data: userJoins } = await supabase.from('tournament_players').select('tournament_id').eq('user_id', req.user.id);
    const joinedIds = new Set(userJoins?.map(j => j.tournament_id) || []);

    const tournaments = (data || []).map(t => ({
        ...t,
        is_joined: joinedIds.has(t.id)
    }));

    res.json({ success: true, tournaments });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const getTournamentById = async (req, res) => {
  try {
    const { data: tournament } = await supabase.from('tournaments').select('*').eq('id', req.params.id).single();
    if (!tournament) return res.status(404).json({ success: false, message: 'Tournament not found.' });

    const { data: players } = await supabase
      .from('tournament_players')
      .select('*, profiles(username, profile_image, iq_level, rank)')
      .eq('tournament_id', req.params.id)
      .order('score', { ascending: false });

    res.json({ success: true, tournament: { ...tournament, players: players || [] } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const joinTournament = async (req, res) => {
  try {
    const { data: tournament } = await supabase.from('tournaments').select('*').eq('id', req.params.id).single();
    if (!tournament) return res.status(404).json({ success: false, message: 'Tournament not found.' });
    
    if (tournament.status !== 'upcoming') return res.status(400).json({ success: false, message: 'Tournament is no longer accepting joins.' });
    if (tournament.current_players >= tournament.max_players) return res.status(400).json({ success: false, message: 'Tournament is full.' });

    const { data: already } = await supabase.from('tournament_players').select('id').eq('tournament_id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (already) return res.status(400).json({ success: false, message: 'Already joined.' });

    if (tournament.type === 'paid') {
      if (req.user.kyc_status !== 'verified') return res.status(403).json({ success: false, message: 'KYC verification required for paid tournaments.' });
      
      const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
      if (!wallet || Number(wallet.balance) < tournament.entry_fee) return res.status(400).json({ success: false, message: 'Insufficient balance.' });

      const newBalance = Number(wallet.balance) - tournament.entry_fee;
      await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);
      await supabase.from('transactions').insert({ user_id: req.user.id, type: 'tournament_entry', amount: tournament.entry_fee, status: 'success', reference_id: tournament.id, balance_after: newBalance });
    }

    await supabase.from('tournament_players').insert({ tournament_id: req.params.id, user_id: req.user.id });
    
    const newCount = tournament.current_players + 1;
    let newStatus = 'upcoming';
    if (newCount >= tournament.max_players) newStatus = 'full';

    await supabase.from('tournaments').update({ current_players: newCount, status: newStatus }).eq('id', req.params.id);

    res.json({ success: true, message: 'Joined successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const autoCreatePaidTournaments = async () => {
  try {
    const configs = [
      { timer: 1, max: 16, entries: [5, 10, 15, 20, 30, 50, 80, 100, 200, 300, 500], name: '1 Min Knockout' },
      { timer: 3, max: 32, entries: [10, 20, 50, 100], name: '3 Min Tournament' }
    ];
    
    for (const conf of configs) {
       for (const entry of conf.entries) {
          const { data: existing } = await supabase.from('tournaments').select('id').eq('type', 'paid').eq('timer_type', conf.timer).eq('entry_fee', entry).eq('status', 'upcoming').maybeSingle();
          if (!existing) {
             const pool = entry * conf.max;
             // 15% Platform Fee, 85% distributed: 35%, 30%, 20%
             const prize_first = Math.floor(pool * 0.35);
             const prize_second = Math.floor(pool * 0.30);
             const prize_third = Math.floor(pool * 0.20);
             
             await supabase.from('tournaments').insert({
               name: `${entry} Coin ${conf.name}`, type: 'paid', timer_type: conf.timer, format: 'standard',
               entry_fee: entry, max_players: conf.max, status: 'upcoming', prize_pool: pool,
               prize_first, prize_second, prize_third
             });
          }
       }
    }
  } catch(e) { console.error('Auto-create error:', e); }
};

const distributeTournamentPrizes = async (tournament) => {
  try {
    const { data: winners } = await supabase.from('tournament_players').select('user_id').eq('tournament_id', tournament.id).order('score', { ascending: false }).limit(3);
    if (!winners || winners.length === 0) return;

    const prizes = [tournament.prize_first, tournament.prize_second, tournament.prize_third];
    for (let i = 0; i < winners.length; i++) {
        const amount = prizes[i];
        if (amount > 0) {
            const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', winners[i].user_id).single();
            const newBalance = Number(wallet.balance) + amount;
            await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', winners[i].user_id);
            await supabase.from('transactions').insert({ user_id: winners[i].user_id, type: 'tournament_prize', amount, status: 'success', reference_id: tournament.id, balance_after: newBalance });
        }
    }
  } catch (err) { console.error('Prize distribution error:', err); }
};

// Helper to snap to next exact half-hour block
const getNextHalfHour = (baseDate) => {
  const d = baseDate ? new Date(baseDate) : new Date();
  const m = d.getMinutes();
  if (m < 30) { d.setMinutes(30, 0, 0); }
  else { d.setHours(d.getHours() + 1); d.setMinutes(0, 0, 0); }
  return d.toISOString();
};

const autoCreateFreeTournaments = async (customStartTime, customEndTime) => {
  try {
    const timers = [1, 3, 5, 10];
    const startTime = customStartTime || getNextHalfHour();
    const endTime = customEndTime || new Date(new Date(startTime).getTime() + 30 * 60 * 1000).toISOString();
    const { data: existing } = await supabase.from('tournaments').select('id').eq('type', 'free').eq('status', 'upcoming');
    if (existing && existing.length > 0) return;
    const rows = timers.map(t => ({
      name: `Free ${t}min Tournament`, type: 'free', format: 'standard', timer_type: t,
      max_players: 500, start_time: startTime, end_time: endTime, duration_minutes: 30,
    }));
    await supabase.from('tournaments').insert(rows);
  } catch (err) { console.error('Auto-create free error:', err); }
};

const updateTournamentStatuses = async () => {
    // Basic status update for Free tournaments (Paid is handled by Manager)
    try {
        const now = new Date().toISOString();
        await supabase.from('tournaments').update({ status: 'live' }).eq('status', 'upcoming').eq('type', 'free').lte('start_time', now);
        await supabase.from('tournaments').update({ status: 'completed' }).eq('status', 'live').eq('type', 'free').lte('end_time', now);
    } catch(e) {}
};

const getLeaderboard = async (req, res) => {
  try {
    const { data } = await supabase
      .from('tournament_players')
      .select('*, profiles(username, profile_image, iq_level)')
      .eq('tournament_id', req.params.id)
      .order('score', { ascending: false });
    res.json({ success: true, leaderboard: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { getTournaments, getTournamentById, joinTournament, getLeaderboard, autoCreateFreeTournaments, autoCreatePaidTournaments, updateTournamentStatuses, distributeTournamentPrizes };
