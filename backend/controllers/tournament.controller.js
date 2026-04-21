const { supabase } = require('../config/supabase');

// ─── GET TOURNAMENTS ────────────────────────────────────────
const getTournaments = async (req, res) => {
  try {
    const { type, status } = req.query;
    let query = supabase.from('tournaments')
      .select('*')
      .order('entry_fee', { ascending: true })
      .limit(100);
    
    if (type) query = query.eq('type', type);
    
    if (status) {
        if (status === 'upcoming') query = query.eq('status', 'upcoming');
        else if (status === 'live') query = query.in('status', ['full', 'starting', 'live']);
        else query = query.eq('status', status);
    } else {
        query = query.in('status', ['upcoming', 'full', 'starting', 'live']);
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
    console.error('getTournaments error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─── GET TOURNAMENT BY ID ───────────────────────────────────
const getTournamentById = async (req, res) => {
  try {
    const { data: tournament } = await supabase.from('tournaments').select('*').eq('id', req.params.id).single();
    if (!tournament) return res.status(404).json({ success: false, message: 'Tournament not found.' });

    const { data: players } = await supabase
      .from('tournament_players')
      .select('*, profiles(username, profile_image, iq_level, rank)')
      .eq('tournament_id', req.params.id)
      .order('score', { ascending: false });

    const { data: matches } = await supabase
      .from('matches')
      .select('*, p1:player1_id(username), p2:player2_id(username), win:winner_id(username)')
      .eq('tournament_id', req.params.id)
      .order('created_at', { ascending: true });

    let leaderboard = [];
    if (tournament.status === 'completed') {
      const { data: lb, error: lbError } = await supabase.from('leaderboard').select('*, profiles:user_id(username)').eq('tournament_id', req.params.id).order('rank', { ascending: true });
      if (lbError) console.error('Leaderboard fetch error:', lbError);
      leaderboard = lb || [];
    }

    res.json({ success: true, tournament: { ...tournament, players: players || [], matches: matches || [], leaderboard } });
  } catch (err) {
    console.error('getTournamentById error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─── JOIN TOURNAMENT (COIN LOCK SYSTEM) ─────────────────────
const joinTournament = async (req, res) => {
  try {
    const { data: tournament } = await supabase.from('tournaments').select('*').eq('id', req.params.id).single();
    if (!tournament) return res.status(404).json({ success: false, message: 'Tournament not found.' });
    
    // Only allow joining in UPCOMING status
    if (tournament.status !== 'upcoming') return res.status(400).json({ success: false, message: 'Tournament is no longer accepting joins.' });
    if (tournament.current_players >= tournament.max_players) return res.status(400).json({ success: false, message: 'Tournament is full.' });

    // Prevent duplicate join
    const { data: already } = await supabase.from('tournament_players').select('id').eq('tournament_id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (already) return res.status(400).json({ success: false, message: 'Already joined.' });

    // FRESH COUNT CHECK (to prevent race conditions)
    const { count: currentCount } = await supabase.from('tournament_players').select('*', { count: 'exact', head: true }).eq('tournament_id', req.params.id);
    if (currentCount >= (tournament.max_players || 16)) {
        // Auto-lock if it somehow stayed 'upcoming'
        await supabase.from('tournaments').update({ status: 'full' }).eq('id', req.params.id);
        return res.status(400).json({ success: false, message: 'Tournament is full.' });
    }

    // PAID TOURNAMENT: Coin LOCK system
    if (tournament.type === 'paid') {
      // KYC check
      if (req.user.kyc_status !== 'verified') return res.status(403).json({ success: false, message: 'KYC verification required for paid tournaments.' });
      
      // Balance check
      const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
      if (!wallet || Number(wallet.balance) < tournament.entry_fee) return res.status(400).json({ success: false, message: 'Insufficient balance.' });

      // LOCK coins (deduct from wallet, record as locked transaction)
      const newBalance = Number(wallet.balance) - tournament.entry_fee;
      await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);
      await supabase.from('transactions').insert({ 
        user_id: req.user.id, type: 'tournament_entry', amount: tournament.entry_fee, 
        status: 'success', reference_id: tournament.id, balance_after: newBalance,
        description: `Entry locked for TR-${tournament.tr_id || 'NEW'}`
      });
    }

    // Add player to tournament
    const { error: insErr } = await supabase.from('tournament_players').insert({ tournament_id: req.params.id, user_id: req.user.id });
    if (insErr) {
        console.error('Join insert error:', insErr);
        return res.status(500).json({ success: false, message: 'Failed to join.' });
    }
    
    // FETCH ACCURATE COUNT from tournament_players to avoid race conditions
    const { count: actualCount, error: countErr } = await supabase.from('tournament_players')
        .select('*', { count: 'exact', head: true })
        .eq('tournament_id', req.params.id);
    
    if (countErr) console.error('Count error:', countErr);
    
    const finalCount = (actualCount !== null && actualCount !== undefined) ? actualCount : (tournament.current_players + 1);
    let updateData = { current_players: finalCount };
    
    // CHECK IF FULL (16/16) → Trigger LOCKED
    if (finalCount >= tournament.max_players) {
        updateData.status = 'full';
        // Set start_time to now + 1 minute (LOCKED duration)
        updateData.start_time = new Date(Date.now() + 1 * 60 * 1000).toISOString();
        console.log(`🔒 TR-${tournament.tr_id} is FULL (${finalCount}/${tournament.max_players}). Starting LOCKED countdown.`);
    }

    await supabase.from('tournaments').update(updateData).eq('id', req.params.id);

    // Wake up TournamentManager to pickup the FULL tournament
    if (finalCount >= tournament.max_players) {
      const TournamentManager = require('../services/tournament.manager');
      TournamentManager.pickupTournament(req.params.id).catch(()=>{});
    }

    res.json({ success: true, message: 'Joined successfully!' });
  } catch (err) {
    console.error('joinTournament error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─── AUTO CREATE 1MIN PAID TOURNAMENTS ──────────────────────
const autoCreatePaidTournaments = async () => {
  try {
    const entries = [5, 10, 15, 20, 30, 50, 80, 100, 200, 500];
    const MAX_PLAYERS = 16;
    const TIMER = 1; // 1 min per player
    
    for (const entry of entries) {
      // Check if an UPCOMING tournament already exists for this entry
      const { data: existing } = await supabase.from('tournaments')
        .select('id')
        .eq('type', 'paid')
        .eq('timer_type', TIMER)
        .eq('entry_fee', entry)
        .eq('status', 'upcoming')
        .limit(1);
      
      if (existing && existing.length > 0) continue; // Skip if any upcoming one exists
        // Generate TR ID (global counter)
        const { data: lastTR } = await supabase.from('tournaments')
          .select('tr_id')
          .eq('type', 'paid')
          .not('tr_id', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        
        let nextNum = 1;
        if (lastTR && lastTR.tr_id) {
          const match = lastTR.tr_id.match(/TR-(\d+)/);
          if (match) nextNum = parseInt(match[1]) + 1;
        }
        const trId = `TR-${nextNum}`;

        const pool = entry * MAX_PLAYERS;
        const prize_first = Math.floor(pool * 0.35);
        const prize_second = Math.floor(pool * 0.30);
        const prize_third = Math.floor(pool * 0.20);

        await supabase.from('tournaments').insert({
          name: `${entry} Coin - 1 Min Knockout TR`,
          type: 'paid',
          timer_type: TIMER,
          format: 'standard',
          entry_fee: entry,
          max_players: MAX_PLAYERS,
          status: 'upcoming',
          prize_pool: pool,
          prize_first,
          prize_second,
          prize_third,
          tr_id: trId,
          start_time: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // Far future, updated when FULL
          phase: 'upcoming'
        });
        console.log(`🏆 Created ${trId}: ${entry} Coin - 1 Min Knockout TR`);
    }
  } catch(e) { console.error('Auto-create paid error:', e); }
};

// ─── DISTRIBUTE TOURNAMENT PRIZES ───────────────────────────
const distributeTournamentPrizes = async (tournament) => {
  try {
    const { data: winners } = await supabase.from('tournament_players')
      .select('user_id, score')
      .eq('tournament_id', tournament.id)
      .order('score', { ascending: false })
      .limit(3);
    if (!winners || winners.length === 0) return;

    const prizes = [tournament.prize_first, tournament.prize_second, tournament.prize_third];
    for (let i = 0; i < winners.length; i++) {
        const amount = prizes[i];
        if (amount > 0) {
            // Insert into leaderboard table
            await supabase.from('leaderboard').insert({
                tournament_id: tournament.id,
                user_id: winners[i].user_id,
                rank: i + 1,
                prize: amount
            });

            const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', winners[i].user_id).single();
            if (!wallet) continue;
            const newBalance = Number(wallet.balance) + amount;
            await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', winners[i].user_id);
            await supabase.from('transactions').insert({ 
              user_id: winners[i].user_id, type: 'tournament_prize', amount, 
              status: 'success', reference_id: tournament.id, balance_after: newBalance,
              description: `Prize: Rank ${i+1} in TR-${tournament.tr_id}`
            });
            console.log(`💰 Prize ${amount} coins → ${winners[i].user_id} (Rank ${i+1})`);
        }
    }
  } catch (err) { console.error('Prize distribution error:', err); }
};

// ─── HELPER: Next half-hour ─────────────────────────────────
const getNextHalfHour = (baseDate) => {
  const d = baseDate ? new Date(baseDate) : new Date();
  const m = d.getMinutes();
  if (m < 30) { d.setMinutes(30, 0, 0); }
  else { d.setHours(d.getHours() + 1); d.setMinutes(0, 0, 0); }
  return d.toISOString();
};

// ─── AUTO CREATE FREE TOURNAMENTS ───────────────────────────
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

// ─── UPDATE FREE TOURNAMENT STATUSES ────────────────────────
const updateTournamentStatuses = async () => {
    // Basic status update for Free tournaments (Paid is handled by Manager)
    try {
        const now = new Date().toISOString();
        await supabase.from('tournaments').update({ status: 'live' }).eq('status', 'upcoming').eq('type', 'free').lte('start_time', now);
        await supabase.from('tournaments').update({ status: 'completed' }).eq('status', 'live').eq('type', 'free').lte('end_time', now);
    } catch(e) {}
};

// ─── LEADERBOARD ────────────────────────────────────────────
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

module.exports = { 
  getTournaments, getTournamentById, joinTournament, getLeaderboard, 
  autoCreateFreeTournaments, autoCreatePaidTournaments, updateTournamentStatuses, 
  distributeTournamentPrizes 
};
