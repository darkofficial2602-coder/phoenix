const { supabase } = require('../config/supabase');

const getTournaments = async (req, res) => {
  try {
    const { type, status } = req.query;
    let query = supabase.from('tournaments').select('*, tournament_players(user_id)').order('start_time', { ascending: true }).limit(100);
    if (type) query = query.eq('type', type);
    if (status) {
        if (status.includes(',')) query = query.in('status', status.split(','));
        else query = query.eq('status', status);
    } else {
        query = query.in('status', ['upcoming', 'live']);
    }
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
    if (tournament.status === 'completed' || tournament.status === 'cancelled') {
        return res.status(400).json({ success: false, message: 'Tournament is already finished or cancelled.' });
    }
    // No more joins if phase is already FULL or higher
    if (tournament.phase && tournament.phase !== 'upcoming') {
        return res.status(400).json({ success: false, message: 'Join period closed.' });
    }
    if (tournament.current_players >= tournament.max_players) return res.status(400).json({ success: false, message: 'Tournament is full.' });

    if (tournament.status !== 'upcoming') {
        return res.status(400).json({ success: false, message: 'Tournament is already full or started.' });
    }

    // Check already joined
    const { data: already } = await supabase.from('tournament_players').select('id').eq('tournament_id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (already) return res.status(400).json({ success: false, message: 'Already joined.' });

    // Paid tournament: deduct coins + KYC check
    if (tournament.type === 'paid') {
      // STRICT KYC CHECK
      if (req.user.kyc_status !== 'verified') return res.status(403).json({ success: false, message: 'KYC verified account required to join paid tournaments.' });
      
      const { data: wallet } = await supabase.from('wallets').select('balance, total_spent').eq('user_id', req.user.id).single();
      if (!wallet || Number(wallet.balance) < tournament.entry_fee) return res.status(400).json({ success: false, message: 'Insufficient balance.' });

      const newBalance = Number(wallet.balance) - tournament.entry_fee;
      const newTotalSpent = Number(wallet.total_spent || 0) + tournament.entry_fee;
      const { data: lockedWallet } = await supabase.from('wallets')
          .update({ balance: newBalance, total_spent: newTotalSpent })
          .eq('user_id', req.user.id)
          .eq('balance', wallet.balance)
          .select().maybeSingle();
      
      if (!lockedWallet) return res.status(400).json({ success: false, message: 'Wallet transaction failed. Try again.' });

      await supabase.from('transactions').insert({ user_id: req.user.id, type: 'tournament_entry', amount: tournament.entry_fee, status: 'success', reference_id: tournament.id, balance_after: newBalance });
    }

    // Add player
    const { error: joinErr } = await supabase.from('tournament_players').insert({ tournament_id: req.params.id, user_id: req.user.id });
    if (joinErr) {
       // Refund if fail
       if (tournament.type === 'paid') {
          const { data: w } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
          if (w) {
              const rb = Number(w.balance) + tournament.entry_fee;
              await supabase.from('wallets').update({ balance: rb }).eq('user_id', req.user.id);
          }
       }
       return res.status(400).json({ success: false, message: 'Failed to join tournament.' });
    }
    
    await supabase.rpc('increment_tournament_players', { t_id: req.params.id });

    // Trigger state transition if FULL (16/16)
    const { data: latestT } = await supabase.from('tournaments').select('current_players, max_players').eq('id', tournament.id).single();
    if (tournament.type === 'paid' && latestT && latestT.current_players >= latestT.max_players) {
        // status=upcoming, phase=FULL
        // Start 2 min countdown to LIVE
        const liveStartTime = new Date(Date.now() + 2 * 60000).toISOString();
        await supabase.from('tournaments').update({ 
            status: 'full',
            phase: 'full', 
            start_time: liveStartTime 
        }).eq('id', tournament.id);
        
        // Notify
        const { data: players } = await supabase.from('tournament_players').select('user_id').eq('tournament_id', tournament.id);
        if (players) {
             const notifs = players.map(p => ({
                 user_id: p.user_id, type: 'tournament_alert', title: 'Tournament FULL! ⚡', message: `Tournament "${tournament.name}" is FULL. Going LIVE in 2 minutes!`
             }));
             await supabase.from('notifications').insert(notifs);
        }
    }

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

// Helper to snap to next exact half-hour block
const getNextHalfHour = (baseDate) => {
  const d = baseDate ? new Date(baseDate) : new Date();
  const m = d.getMinutes();
  if (m < 30) { d.setMinutes(30, 0, 0); }
  else { d.setHours(d.getHours() + 1); d.setMinutes(0, 0, 0); }
  return d.toISOString();
};

// Auto-create free tournaments
const autoCreateFreeTournaments = async (customStartTime, customEndTime) => {
  try {
    const timers = [1, 3, 5, 10];
    const startTime = customStartTime || getNextHalfHour();
    const endTime = customEndTime || new Date(new Date(startTime).getTime() + 30 * 60 * 1000).toISOString();
    
    // strictly enforce ONE upcoming batch at any time
    const { data: existing } = await supabase.from('tournaments')
      .select('id').eq('type', 'free').eq('status', 'upcoming');
      
    if (existing && existing.length > 0) return;

    const rows = timers.map(t => ({
      name: `Free ${t}min Tournament`, type: 'free', format: 'standard', timer_type: t,
      max_players: 500, start_time: startTime, end_time: endTime, duration_minutes: 30,
    }));
    await supabase.from('tournaments').insert(rows);
  } catch (err) {
    console.error('Auto-create error:', err);
  }
};

let lastPaidSpawnTimes = { 1: 0, 3: 0, 5: 0 };

const autoCreatePaidTournaments = async () => {
  try {
    const now = Date.now();
    const intervals = { 1: 5 * 60000, 3: 20 * 60000, 5: 30 * 60000 };
    const configs = [
      { timer: 1, max: 16, entries: [5, 10, 15, 20, 30, 50, 80, 100, 200, 300, 500], name: '1 Min Knockout TR' },
      { timer: 3, max: 32, entries: [5, 10, 15, 20, 30, 50, 80, 100, 200, 300, 500], name: '3 Min Knockout TR' },
      { timer: 5, max: 100, entries: [5, 10, 15, 20, 30, 50, 80, 100, 200, 300, 500], name: '5 Min Hybrid' }
    ];
    
    for (const conf of configs) {
       if (now - lastPaidSpawnTimes[conf.timer] < intervals[conf.timer]) continue;
       
       let createdAny = false;
       for (const entry of conf.entries) {
          const { data: existing } = await supabase.from('tournaments')
            .select('id')
            .eq('type', 'paid')
            .eq('timer_type', conf.timer)
            .eq('entry_fee', entry)
            .eq('status', 'upcoming')
            .maybeSingle();
            
          if (!existing) {
             const { count } = await supabase.from('tournaments').select('*', { count: 'exact', head: true });
             const displayId = `TR-${(count || 0) + 1}`;
             const pool = entry * conf.max;
             // Spec: 1st=35%, 2nd=30%, 3rd=20%. Total=85%. 15% is platform fee.
             const prize_first = Math.floor(pool * 0.35);
             const prize_second = Math.floor(pool * 0.30);
             const prize_third = Math.floor(pool * 0.20);
             
             const farFuture = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
             
             await supabase.from('tournaments').insert({
               name: `${entry} Coin ${conf.name}`,
               display_id: displayId,
               type: 'paid',
               timer_type: conf.timer,
               format: 'standard',
               entry_fee: entry,
               max_players: conf.max,
               current_players: 0,
               status: 'upcoming',
               phase: 'upcoming',
               start_time: farFuture,
               prize_pool: pool,
               prize_first, prize_second, prize_third
             });
             createdAny = true;
          }
       }
       if (createdAny) lastPaidSpawnTimes[conf.timer] = now;
    }
  } catch(e) {
    console.error('Paid TR auto-create error:', e);
  }
};

// Distribute prizes for completed paid tournaments
const distributeTournamentPrizes = async (tournament) => {
  try {
    if (tournament.type !== 'paid') return;

    // Get top 3 players by their score (which is updated at match results)
    // Or in knockout, we should have marked their rank.
    // For now, sorting by score is a good fallback, but TournamentManager should ideally set rank.
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
                    description: `Tournament Prize: Rank ${i+1} in ${tournament.name}`,
                    balance_after: newBalance
                });

                await supabase.from('notifications').insert({
                    user_id: player.user_id,
                    type: 'tournament_prize',
                    title: `Tournament Prize! 🏆`,
                    message: `Congratulations! You won ${amount} coins for Rank ${i+1} in ${tournament.name}.`
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
      }
    }
  } catch (err) {
    console.error('Status update error:', err);
  }
};

module.exports = { getTournaments, getTournamentById, joinTournament, getLeaderboard, autoCreateFreeTournaments, autoCreatePaidTournaments, updateTournamentStatuses, distributeTournamentPrizes };
