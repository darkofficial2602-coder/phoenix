const { supabase } = require('../config/supabase');

const getTournaments = async (req, res) => {
  try {
    const { type, status } = req.query;
    let query = supabase.from('tournaments').select('*').order('start_time', { ascending: true }).limit(20);
    if (type) query = query.eq('type', type);
    if (status) query = query.eq('status', status);
    else query = query.in('status', ['upcoming', 'live']);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, tournaments: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const getTournamentById = async (req, res) => {
  try {
    const { data: tournament } = await supabase.from('tournaments').select('*').eq('id', req.params.id).single();
    if (!tournament) return res.status(404).json({ success: false, message: 'Tournament not found.' });

    // Get players with profile info
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
    if (tournament.status === 'completed' || tournament.status === 'cancelled') return res.status(400).json({ success: false, message: 'Tournament not joinable.' });
    if (tournament.current_players >= tournament.max_players) return res.status(400).json({ success: false, message: 'Tournament is full.' });

    // Check already joined
    const { data: already } = await supabase.from('tournament_players').select('id').eq('tournament_id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (already) return res.status(400).json({ success: false, message: 'Already joined.' });

    // Paid tournament: deduct coins + KYC check
    if (tournament.type === 'paid') {
      if (req.user.kyc_status !== 'verified') return res.status(403).json({ success: false, message: 'KYC required for paid tournaments.' });
      const { data: wallet } = await supabase.from('wallets').select('balance, total_spent').eq('user_id', req.user.id).single();
      if (!wallet || Number(wallet.balance) < tournament.entry_fee) return res.status(400).json({ success: false, message: 'Insufficient balance.' });

      const newBalance = Number(wallet.balance) - tournament.entry_fee;
      const newTotalSpent = Number(wallet.total_spent || 0) + tournament.entry_fee;
      await supabase.from('wallets').update({ balance: newBalance, total_spent: newTotalSpent }).eq('user_id', req.user.id);
      await supabase.from('transactions').insert({ user_id: req.user.id, type: 'tournament_entry', amount: tournament.entry_fee, status: 'success', reference_id: tournament.id, balance_after: newBalance });
    }

    // Add player
    await supabase.from('tournament_players').insert({ tournament_id: req.params.id, user_id: req.user.id });
    await supabase.from('tournaments').update({ current_players: tournament.current_players + 1 }).eq('id', req.params.id);

    await supabase.from('notifications').insert({ user_id: req.user.id, type: 'tournament_join', title: 'Joined Tournament! 🏆', message: `You've joined "${tournament.name}". Get ready to play!` });

    res.json({ success: true, message: 'Joined successfully!' });
  } catch (err) {
    console.error('Join tournament error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
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

// Auto-create free tournaments
const autoCreateFreeTournaments = async (customStartTime, customEndTime) => {
  try {
    const timers = [1, 3, 5, 10];
    const startTime = customStartTime || new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const endTime = customEndTime || new Date(new Date(startTime).getTime() + 30 * 60 * 1000).toISOString();
    
    // strictly enforce ONE upcoming batch at any time
    const { data: existing } = await supabase.from('tournaments')
      .select('id').eq('type', 'free').eq('status', 'upcoming');
      
    if (existing && existing.length > 0) return;

    const rows = timers.map(t => ({
      name: `Free ${t}min Tournament`, type: 'free', timer_type: t,
      max_players: 500, start_time: startTime, end_time: endTime, duration_minutes: 30,
    }));
    await supabase.from('tournaments').insert(rows);
    console.log(`✅ Auto-created free tournaments for ${startTime}`);
  } catch (err) {
    console.error('Auto-create error:', err);
  }
};

// Distribute prizes for completed paid tournaments
const distributeTournamentPrizes = async (tournament) => {
  try {
    if (tournament.type !== 'paid') return;

    // Get top 3 players
    const { data: players } = await supabase
      .from('tournament_players')
      .select('user_id, score')
      .eq('tournament_id', tournament.id)
      .order('score', { ascending: false })
      .limit(3);

    if (!players || players.length === 0) return;

    const prizes = [tournament.prize_first, tournament.prize_second, tournament.prize_third];

    for (let i = 0; i < players.length; i++) {
        const player = players[i];
        const amount = prizes[i];
        if (amount && amount > 0) {
            const { data: wallet } = await supabase.from('wallets').select('balance, total_won').eq('user_id', player.user_id).single();
            if (wallet) {
                const newBalance = Number(wallet.balance) + amount;
                await supabase.from('wallets').update({ 
                    balance: newBalance, 
                    total_won: Number(wallet.total_won || 0) + amount 
                }).eq('user_id', player.user_id);

                await supabase.from('transactions').insert({
                    user_id: player.user_id,
                    type: 'tournament_prize',
                    amount: amount,
                    status: 'success',
                    reference_id: tournament.id,
                    description: `Finished rank ${i+1} in ${tournament.name}`,
                    balance_after: newBalance
                });

                await supabase.from('notifications').insert({
                    user_id: player.user_id,
                    type: 'tournament_prize',
                    title: `Tournament Prize! 🏆`,
                    message: `You placed rank ${i+1} in ${tournament.name} and won ${amount} coins!`
                });
            }
        }
    }
  } catch (err) {
    console.error('distributeTournamentPrizes error:', err);
  }
};

// Seed knockouts helper
const advanceToBracket = async (t, topN) => {
  const { data: players } = await supabase.from('tournament_players').select('user_id, score').eq('tournament_id', t.id).order('score', { ascending: false });
  if (!players) return;
  // Eliminate bottom players
  const advanced = players.slice(0, topN);
  const eliminated = players.slice(topN);
  for (const p of eliminated) {
     await supabase.from('tournament_players').update({ is_eliminated: true }).eq('tournament_id', t.id).eq('user_id', p.user_id);
  }
  
  // Create first round matches mapping
  const matches = [];
  // Standard bracket seeding: 1 vs 16, 2 vs 15, etc.
  for (let i = 0; i < advanced.length / 2; i++) {
     const p1 = advanced[i].user_id;
     const p2 = advanced[advanced.length - 1 - i]?.user_id;
     matches.push({ p1, p2, winner: null, active_match_id: null });
  }

  const roundName = topN === 16 ? 'round_of_16' : topN === 8 ? 'quarterfinal' : topN === 4 ? 'semifinal' : 'final';
  
  const bracketState = {
     current_round: roundName,
     rounds: {
        [roundName]: matches
     }
  };

  await supabase.from('tournaments').update({ phase: 'bracket', bracket_state: bracketState }).eq('id', t.id);
};

// Auto-update tournament statuses
const updateTournamentStatuses = async () => {
  try {
    const now = new Date().toISOString();
    
    // Upcoming -> Live
    const { data: goingLive } = await supabase.from('tournaments')
      .select('*')
      .eq('status', 'upcoming').lte('start_time', now);
      
    if (goingLive && goingLive.length > 0) {
      for (const t of goingLive) {
        await supabase.from('tournaments').update({ status: 'live', phase: 'qualifier' }).eq('id', t.id);
      }
      
      // Feature: Immediately as a free tournament goes live, spawn the NEXT upcoming batch!
      const freeGoingLive = goingLive.filter(t => t.type === 'free');
      if (freeGoingLive.length > 0) {
        const newlyLiveEndTime = freeGoingLive[0].end_time;
        const nextStart = new Date(newlyLiveEndTime);
        const nextEnd = new Date(nextStart.getTime() + 30 * 60 * 1000);
        await autoCreateFreeTournaments(nextStart.toISOString(), nextEnd.toISOString());
      }
    }
      
    // Handle Live format phases
    const { data: active } = await supabase.from('tournaments').select('*').eq('status', 'live');
    if (active) {
       for (const t of active) {
          if (t.format === 'quick' && t.phase === 'qualifier') {
             const threshold = new Date(new Date(t.start_time).getTime() + 10 * 60000).toISOString();
             if (now >= threshold) await advanceToBracket(t, 4);
          }
          if (t.format === 'battle' && t.phase === 'qualifier') {
             const threshold = new Date(new Date(t.start_time).getTime() + 15 * 60000).toISOString();
             if (now >= threshold) await advanceToBracket(t, 16);
          }
       }
    }

    // Live -> Completed
    const { data: completing } = await supabase.from('tournaments')
      .select('*')
      .eq('status', 'live').lte('end_time', now);

    if (completing && completing.length > 0) {
      for (const t of completing) {
        await supabase.from('tournaments').update({ status: 'completed', phase: 'completed' }).eq('id', t.id);
        if (t.type === 'paid') {
          await distributeTournamentPrizes(t);
        }
      }
    }
  } catch (err) {
    console.error('Status update error:', err);
  }
};

module.exports = { getTournaments, getTournamentById, joinTournament, getLeaderboard, autoCreateFreeTournaments, updateTournamentStatuses };
