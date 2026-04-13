const { supabase } = require('../config/supabase');

const getMatchHistory = async (req, res) => {
  try {
    const { filter, page = 1, limit = 20 } = req.query;
    let query = supabase
      .from('matches')
      .select('*, p1:player1_id(id, username, profile_image, iq_level), p2:player2_id(id, username, profile_image, iq_level)', { count: 'exact' })
      .or(`player1_id.eq.${req.user.id},player2_id.eq.${req.user.id}`)
      .eq('status', 'finished')
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (filter === 'wins') query = query.eq('winner_id', req.user.id);
    else if (filter === 'draws') query = query.eq('result', 'draw');
    else if (filter === 'losses') query = query.neq('result', 'draw').neq('winner_id', req.user.id).not('winner_id', 'is', null).or(`player1_id.eq.${req.user.id},player2_id.eq.${req.user.id}`);

    const { data, count } = await query;

    // Rename for cleaner response
    const matches = (data || []).map(m => ({
      ...m,
      player1_id: m.p1,
      player2_id: m.p2,
      p1: undefined, p2: undefined,
    }));

    res.json({ success: true, matches, total: count, pages: Math.ceil((count || 0) / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const getLeaderboard = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const { data, count } = await supabase
      .from('profiles')
      .select('id, username, profile_image, iq_level, rank, total_matches, wins, win_rate, player_id', { count: 'exact' })
      .eq('status', 'active')
      .order('iq_level', { ascending: false })
      .order('wins', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    const leaderboard = (data || []).map((u, i) => ({
      rank: (page - 1) * limit + i + 1,
      user_id: u.id,
      username: u.username,
      profile_image: u.profile_image,
      iq_level: u.iq_level,
      rank_badge: u.rank,
      wins: u.wins,
      total_matches: u.total_matches,
      win_rate: u.win_rate,
      player_id: u.player_id,
    }));

    res.json({ success: true, leaderboard, total: count, pages: Math.ceil((count || 0) / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const getMatchById = async (req, res) => {
  try {
    const { data: match } = await supabase
      .from('matches')
      .select('*, p1:player1_id(id, username, profile_image, iq_level), p2:player2_id(id, username, profile_image, iq_level)')
      .eq('id', req.params.id)
      .single();
    if (!match) return res.status(404).json({ success: false, message: 'Match not found.' });
    res.json({ success: true, match });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// Called by socket after game ends
const processMatchResult = async (matchId, result, winnerId, finalFen = null) => {
  try {
    const { data: match } = await supabase.from('matches').select('*').eq('id', matchId).single();
    if (!match || match.status === 'finished') return;

    const IQ_WIN = 15, IQ_LOSS = -5, IQ_DRAW = 0;
    const p1Win = result === 'player1_win';
    const p2Win = result === 'player2_win';
    const isDraw = result === 'draw';
    const iq1 = p1Win ? IQ_WIN : isDraw ? IQ_DRAW : IQ_LOSS;
    const iq2 = p2Win ? IQ_WIN : isDraw ? IQ_DRAW : IQ_LOSS;

    // Update match
    const { error: matchErr } = await supabase.from('matches').update({
      result, winner_id: winnerId || null, status: 'finished',
      iq_change_p1: iq1, iq_change_p2: iq2, end_time: new Date().toISOString()
    }).eq('id', matchId);
    
    if (matchErr) console.error('Match Update Error:', matchErr);

    // Update player stats helper
    const updatePlayer = async (userId, won, lost, drew, iqChange) => {
      const { data: p } = await supabase.from('profiles').select('iq_level, total_matches, wins, losses, draws, current_streak, best_streak').eq('id', userId).single();
      if (!p) return;
      const newTotal = p.total_matches + 1;
      const newWins = p.wins + (won ? 1 : 0);
      const newLosses = p.losses + (lost ? 1 : 0);
      const newDraws = p.draws + (drew ? 1 : 0);
      const newStreak = won ? p.current_streak + 1 : 0;
      const newBestStreak = Math.max(p.best_streak, newStreak);
      const newIQ = Math.max(0, p.iq_level + iqChange);
      const newRank = newIQ >= 2000 ? 'Platinum' : newIQ >= 1000 ? 'Gold' : newIQ >= 500 ? 'Silver' : 'Bronze';
      const newWinRate = Math.round(((newWins + (0.5 * newDraws)) / newTotal) * 100);

      await supabase.from('profiles').update({
        iq_level: newIQ, rank: newRank,
        total_matches: newTotal, wins: newWins, losses: newLosses, draws: newDraws,
        win_rate: newWinRate, current_streak: newStreak, best_streak: newBestStreak,
      }).eq('id', userId);
    };

    if (match.player1_id) await updatePlayer(match.player1_id, p1Win, p2Win, isDraw, iq1);
    if (match.player2_id && match.match_type !== 'bot') await updatePlayer(match.player2_id, p2Win, p1Win, isDraw, iq2);

    // Update tournament player scores if tournament match
    if (match.tournament_id) {
       let scoreChange1 = p1Win ? 15 : isDraw ? 10 : -5;
       let scoreChange2 = p2Win ? 15 : isDraw ? 10 : -5;
       
       const { data: tData } = await supabase.from('tournaments').select('format').eq('id', match.tournament_id).single();
       if (tData && (tData.format === 'quick' || tData.format === 'battle') && finalFen) {
           // Calculate piece values based on standard FEN check
           // Init values: 8*1 + 2*2(r) + 2*2(n) + 2*2(b) + 1*5(q) = 25 total target value per side
           const cur = { w: { p:0, n:0, b:0, r:0, q:0 }, b: { p:0, n:0, b:0, r:0, q:0 } };
           const fenRows = finalFen.split(' ')[0].split('/');
           fenRows.forEach(row => {
               for(let i=0; i<row.length; i++) {
                   const char = row[i];
                   if (isNaN(char)) {
                       const color = char === char.toUpperCase() ? 'w' : 'b';
                       const type = char.toLowerCase();
                       if(cur[color][type] !== undefined) cur[color][type]++;
                   }
               }
           });
           
           const init = { p: 8, n: 2, b: 2, r: 2, q: 1 };
           const pVals = { p: 1, n: 2, b: 2, r: 2, q: 5 };
           
           let wCapPoints = 0, bCapPoints = 0;
           Object.keys(init).forEach(type => {
               // White missing pieces = Black captured them
               const wMissing = init[type] - cur.w[type];
               if (wMissing > 0) bCapPoints += wMissing * pVals[type];
               
               // Black missing pieces = White captured them
               const bMissing = init[type] - cur.b[type];
               if (bMissing > 0) wCapPoints += bMissing * pVals[type];
           });
           
           const matchPts1 = p1Win ? 10 : isDraw ? 5 : 0;
           const matchPts2 = p2Win ? 10 : isDraw ? 5 : 0;
           
           const isP1White = match.player1_color !== 'black';
           scoreChange1 = matchPts1 + (isP1White ? wCapPoints : bCapPoints);
           scoreChange2 = matchPts2 + (isP1White ? bCapPoints : wCapPoints);
       }

      if (match.player1_id) {
        await supabase.rpc('increment_tournament_score', { p_tournament_id: match.tournament_id, p_user_id: match.player1_id, p_score: scoreChange1, p_won: p1Win ? 1 : 0, p_drew: isDraw ? 1 : 0 });
      }
      if (match.player2_id) {
        await supabase.rpc('increment_tournament_score', { p_tournament_id: match.tournament_id, p_user_id: match.player2_id, p_score: scoreChange2, p_won: p2Win ? 1 : 0, p_drew: isDraw ? 1 : 0 });
      }
    }

    return match;
  } catch (err) {
    console.error('processMatchResult error:', err);
  }
};

const saveBotMatch = async (req, res) => {
  try {
    const { result, fen } = req.body;
    const matchData = {
      player1_id: req.user.id,
      player2_id: null, // No opponent
      match_type: 'bot',
      timer_type: 0,
      status: 'active',
      start_time: new Date().toISOString(),
    };
    const { data: match, error } = await supabase.from('matches').insert(matchData).select().single();
    if (error || !match) return res.status(500).json({ success: false, message: 'DB Error' });
    
    await processMatchResult(match.id, result, result === 'player1_win' ? req.user.id : null, fen);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { getMatchHistory, getLeaderboard, getMatchById, processMatchResult, saveBotMatch };
