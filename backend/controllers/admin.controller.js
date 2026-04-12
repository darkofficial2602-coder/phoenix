const { supabase } = require('../config/supabase');

const getDashboard = async (req, res) => {
  try {
    const [
      { count: totalUsers },
      { count: activeUsers },
      { count: activeMatches },
      { count: pendingKYC },
      { count: pendingWithdraw },
      { data: walletData },
    ] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('is_online', true),
      supabase.from('matches').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('kyc').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('withdraw_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('wallets').select('balance, total_deposited, total_withdrawn'),
    ]);

    const totalCoins = (walletData || []).reduce((sum, w) => sum + Number(w.balance), 0);
    const totalDeposited = (walletData || []).reduce((sum, w) => sum + Number(w.total_deposited), 0);

    res.json({ success: true, stats: { totalUsers, activeUsers, activeMatches, pendingKYC, pendingWithdraw, totalCoins, totalDeposited } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const getUsers = async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    let query = supabase.from('profiles').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
    if (status) query = query.eq('status', status);
    if (search) {
      // Normalize search: ensure @username format for username searches
      let searchTerm = search.trim();
      if (!searchTerm.startsWith('@') && !searchTerm.startsWith('PX-')) {
        searchTerm = '@' + searchTerm;
      }
      const safeTerm = searchTerm.replace(/[%_\\]/g, '\\$&');
      const safeSearch = search.trim().replace(/[%_\\]/g, '\\$&');
      query = query.or(`username.ilike.%${safeTerm}%,player_id.ilike.%${safeSearch}%`);
    }
    const { data, count } = await query;
    res.json({ success: true, users: data || [], total: count, pages: Math.ceil((count || 0) / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const updateUserStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'banned', 'suspended'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status provided.' });
    }
    const { data, error } = await supabase.from('profiles').update({ status }).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ success: false, message: error.message });
    await supabase.from('notifications').insert({ user_id: req.params.id, type: 'account', title: `Account ${status}`, message: `Your account has been ${status} by admin.` });
    res.json({ success: true, message: `User ${status}.`, user: data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const getPendingKYC = async (req, res) => {
  try {
    const { data: kycs } = await supabase
      .from('kyc')
      .select('*, profiles(username, email, player_id)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    res.json({ success: true, kycs: kycs || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
const reviewKYC = async (req, res) => {
  try {
    const { action, rejection_reason } = req.body;
    
    // KYC record fetch
    const { data: kyc, error: kycErr } = await supabase
      .from('kyc')
      .select('*')
      .eq('id', req.params.id)
      .single();
      
    if (kycErr || !kyc) {
      return res.status(404).json({ success: false, message: 'KYC not found.' });
    }

    const newStatus = action === 'approve' ? 'verified' : 'rejected';

    // KYC table update
    await supabase
      .from('kyc')
      .update({
        status: newStatus,
        rejection_reason: rejection_reason || '',
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', req.params.id);

    // Profile kyc_status update — இதுதான் wallet unlock பண்றது
    await supabase
      .from('profiles')
      .update({
        kyc_status: newStatus,
        kyc_rejection_reason: rejection_reason || ''
      })
      .eq('id', kyc.user_id);  // ← kyc.user_id use பண்ணு

    // Notification
    await supabase
      .from('notifications')
      .insert({
        user_id: kyc.user_id,
        type: 'kyc',
        title: action === 'approve' ? 'KYC Approved ✅' : 'KYC Rejected ❌',
        message: action === 'approve'
          ? 'KYC verified! Wallet & paid tournaments unlocked.'
          : `KYC rejected: ${rejection_reason || 'Please resubmit.'}`
      });

    res.json({ success: true, message: `KYC ${action}d successfully.` });
  } catch (err) {
    console.error('reviewKYC error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
const getWithdrawRequests = async (req, res) => {
  try {
    // First withdraw requests fetch பண்ணு
    const { data: requests } = await supabase
      .from('withdraw_requests')
      .select('*')
      .eq('status', 'pending')
      .order('queue_position', { ascending: true });

    // Profile info separately fetch பண்ணு
    const result = await Promise.all((requests || []).map(async (r) => {
      const { data: profile } = await supabase
        .from('profiles')
        .select('username, email, player_id')
        .eq('id', r.user_id)
        .single();
      return { ...r, profiles: profile };
    }));

    res.json({ success: true, requests: result });
  } catch (err) {
    console.error('getWithdrawRequests error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const processWithdraw = async (req, res) => {
  try {
    const { action, rejection_reason } = req.body;
    const { data: wr } = await supabase.from('withdraw_requests').select('*').eq('id', req.params.id).single();
    if (!wr || wr.status !== 'pending') return res.status(400).json({ success: false, message: 'Request not found or already processed.' });

    if (action === 'approve') {
      await supabase.from('withdraw_requests').update({ status: 'completed', processed_by: req.user.id, processed_at: new Date().toISOString() }).eq('id', req.params.id);
      await supabase.from('transactions').update({ status: 'success' }).eq('reference_id', req.params.id).eq('type', 'withdraw');
      // Note: balance & total_withdrawn already updated in requestWithdraw — no double update needed
      await supabase.from('notifications').insert({ user_id: wr.user_id, type: 'withdraw', title: 'Withdrawal Approved ✅', message: `${wr.amount} coins withdrawal processed.` });
    } else {
      await supabase.from('withdraw_requests').update({ status: 'rejected', rejection_reason: rejection_reason || '', processed_by: req.user.id, processed_at: new Date().toISOString() }).eq('id', req.params.id);
      // Refund coins + undo the total_withdrawn since request was rejected
      const { data: wallet } = await supabase.from('wallets').select('balance, total_withdrawn').eq('user_id', wr.user_id).single();
      if (wallet) {
          await supabase.from('wallets').update({ 
            balance: Number(wallet.balance) + Number(wr.amount),
            total_withdrawn: Math.max(0, Number(wallet.total_withdrawn || 0) - Number(wr.amount))
          }).eq('user_id', wr.user_id);
      }
      await supabase.from('transactions').update({ status: 'failed' }).eq('reference_id', req.params.id).eq('type', 'withdraw');
      await supabase.from('notifications').insert({ user_id: wr.user_id, type: 'withdraw', title: 'Withdrawal Rejected ❌', message: `${wr.amount} coins refunded. Reason: ${rejection_reason || 'N/A'}` });
    }

    res.json({ success: true, message: `Withdrawal ${action}d.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const createTournament = async (req, res) => {
  try {
    const { name, type, format, entry_fee, timer_type, max_players, prize_distribution, start_time, duration_minutes } = req.body;
    const fee = entry_fee || 0;
    const maxP = max_players || 500;
    const { data, error } = await supabase.from('tournaments').insert({
      name, type, format: format || 'standard', entry_fee: fee, timer_type,
      max_players: maxP, prize_pool: fee * maxP,
      prize_first: prize_distribution?.first || 0,
      prize_second: prize_distribution?.second || 0,
      prize_third: prize_distribution?.third || 0,
      start_time: new Date(start_time).toISOString(),
      end_time: new Date(new Date(start_time).getTime() + (duration_minutes || 30) * 60000).toISOString(),
      duration_minutes: duration_minutes || 30,
      created_by: req.user.id,
    }).select().single();
    if (error) return res.status(400).json({ success: false, message: error.message });
    res.json({ success: true, message: 'Tournament created!', tournament: data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const getLiveMatches = async (req, res) => {
  try {
    const { data } = await supabase.from('matches').select('*, p1:player1_id(username, iq_level), p2:player2_id(username, iq_level)').eq('status', 'active').order('created_at', { ascending: false }).limit(50);
    res.json({ success: true, matches: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const getAllTransactions = async (req, res) => {
  try {
    const { type, page = 1, limit = 30 } = req.query;
    let query = supabase.from('transactions').select('*, profiles(username, player_id)', { count: 'exact' }).order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
    if (type && type !== 'all') query = query.eq('type', type);
    const { data, count } = await query;
    res.json({ success: true, transactions: data || [], total: count, pages: Math.ceil((count || 0) / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const getAllTournaments = async (req, res) => {
  try {
    const { data } = await supabase.from('tournaments').select('*').order('created_at', { ascending: false });
    res.json({ success: true, tournaments: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const cancelTournament = async (req, res) => {
  try {
    const { id } = req.params;
    const { data: tourney } = await supabase.from('tournaments').select('*').eq('id', id).single();
    if (!tourney) return res.status(404).json({ success: false, message: 'Not found.' });
    if (['completed', 'cancelled', 'live'].includes(tourney.status)) 
      return res.status(400).json({ success: false, message: 'Cannot cancel a completed, cancelled, or live tournament.' });

    await supabase.from('tournaments').update({ status: 'cancelled' }).eq('id', id);

    if (tourney.type === 'paid') {
      const { data: players } = await supabase.from('tournament_players').select('user_id').eq('tournament_id', id);
      if (players && players.length > 0) {
        for (const p of players) {
          const { data: wallet } = await supabase.from('wallets').select('balance, total_spent').eq('user_id', p.user_id).single();
          if (wallet) {
              const newBalance = Number(wallet.balance) + tourney.entry_fee;
              const newTotalSpent = Math.max(0, Number(wallet.total_spent || 0) - tourney.entry_fee);
              await supabase.from('wallets').update({ balance: newBalance, total_spent: newTotalSpent }).eq('user_id', p.user_id);
              await supabase.from('transactions').insert({
                user_id: p.user_id, type: 'refund', amount: tourney.entry_fee, 
                status: 'success', reference_id: id, description: `Refund: ${tourney.name}`,
                balance_after: newBalance
              });
              await supabase.from('notifications').insert({
                user_id: p.user_id, type: 'system', title: 'Tournament Cancelled',
                message: `${tourney.name} was cancelled. ${tourney.entry_fee} entry refunded.`
              });
          }
        }
      }
    }
    res.json({ success: true, message: 'Tournament cancelled.' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { getDashboard, getUsers, updateUserStatus, getPendingKYC, reviewKYC, getWithdrawRequests, processWithdraw, createTournament, getLiveMatches, getAllTransactions, getAllTournaments, cancelTournament };
