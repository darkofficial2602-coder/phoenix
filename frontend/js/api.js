// ─── CONFIG ──────────────────────────────────────────────
const API_BASE = (window.location.port === '5500' || window.location.port === '3000') 
  ? 'http://localhost:5000/api' 
  : '/api';

// ─── FORMAT HELPERS ───────────────────────────────────────
const fmt = {
  username: (name) => name ? (name.startsWith('@') ? name : '@' + name) : '',
  coins   : (n) => `${Number(n||0).toLocaleString()} <i class="fa-solid fa-coins"></i>`,
  inr     : (n) => `₹${Number(n||0).toLocaleString()}`,
  time    : (d) => new Date(d).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }),
  relTime : (d) => {
    const s = Math.floor((Date.now() - new Date(d)) / 1000);
    if (s < 60)    return 'just now';
    if (s < 3600)  return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    return `${Math.floor(s/86400)}d ago`;
  },
  countdown: (t) => {
    if (!t || t < 0 || isNaN(t) || t > 360000) return '0:00';
    const m = Math.floor(t/60), s = t%60;
    return `${m}:${String(s).padStart(2,'0')}`;
  },
  rankClass: (rank) => ({ Bronze:'badge-bronze', Silver:'badge-silver', Gold:'badge-gold', Platinum:'badge-platinum' }[rank] || 'badge-bronze'),
};

// ─── SESSION HELPERS ─────────────────────────────────────
const getToken        = () => localStorage.getItem('px_token');
const getRefreshToken = () => localStorage.getItem('px_refresh');
const getUser         = () => { try { return JSON.parse(localStorage.getItem('px_user')); } catch { return null; } };
const isLoggedIn      = () => !!getToken();

const setSession = (token, refresh, user) => {
  if (token) localStorage.setItem('px_token', token);
  if (refresh) localStorage.setItem('px_refresh', refresh);
  if (user) localStorage.setItem('px_user', JSON.stringify(user));
};

const clearSession = () => {
  localStorage.removeItem('px_token');
  localStorage.removeItem('px_refresh');
  localStorage.removeItem('px_user');
};

let _refreshing = false;

const api = async (endpoint, options = {}, retry = true) => {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    // Token expired → try refresh once
    const isAuthRoute = endpoint.startsWith('/auth/login') || endpoint.startsWith('/auth/register');
    if (res.status === 401 && retry && !_refreshing && !isAuthRoute) {
      _refreshing = true;
      const refreshed = await tryRefreshToken();
      _refreshing = false;
      if (refreshed) return api(endpoint, options, false);
      clearSession();
      window.location.href = '/pages/login.html';
      return;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    console.error(`API Error [${endpoint}]:`, err);
    return { success: false, message: 'Network error. Check connection.' };
  }
};

const tryRefreshToken = async () => {
  const refresh_token = getRefreshToken();
  if (!refresh_token) return false;
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token }),
    });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem('px_token', data.token);
      localStorage.setItem('px_refresh', data.refresh_token);
      return true;
    }
    return false;
  } catch { return false; }
};

// ─── AUTH API ────────────────────────────────────────────
const AuthAPI = {
  register    : (d) => api('/auth/register',      { method: 'POST', body: d }),
  login       : (d) => api('/auth/login',          { method: 'POST', body: d }),
  oauthLogin  : (d) => api('/auth/oauth-login',   { method: 'POST', body: d }),
  logout      : async () => {
    try { await api('/auth/logout', { method: 'POST' }, false); } catch {}
    clearSession();
    window.location.href = '/pages/login.html';
  },
  me          : ()  => api('/auth/me'),
};

// ─── USER API ────────────────────────────────────────────
const UserAPI = {
  getProfile     : ()  => api('/user/profile'),
  updateProfile  : (d) => api('/user/profile',        { method: 'PUT',  body: d }),
  changePassword : (d) => api('/user/change-password', { method: 'POST', body: d }),
  updateSettings : (s) => api('/user/settings',        { method: 'PUT',  body: { settings: s } }),
  getNotifications: () => api('/user/notifications'),
  markNotificationsRead: () => api('/user/notifications/read', { method: 'PUT' }),
  getStats       : ()  => api('/user/stats'),
  submitReport   : (d) => api('/user/report', { method: 'POST', body: d }),
  submitFeedback : (d) => api('/user/feedback', { method: 'POST', body: d }),
  savePayoutDetails: (d) => api('/user/payout-details', { method: 'PUT', body: d }),
};

// ─── WALLET API ──────────────────────────────────────────
const WalletAPI = {
  getBalance        : ()   => api('/wallet/balance'),
  createDepositOrder: (amt)=> api('/wallet/deposit/create-order', { method: 'POST', body: { amount: amt } }),
  verifyDeposit     : (d)  => api('/wallet/deposit/verify',       { method: 'POST', body: d }),
  requestWithdraw   : (amt)=> api('/wallet/withdraw',             { method: 'POST', body: { amount: amt } }),
  getTransactions   : (type='all', page=1) => api(`/wallet/transactions?type=${type}&page=${page}`),
};

// ─── GAME API ────────────────────────────────────────────
const GameAPI = {
  getHistory    : (filter='all', page=1) => api(`/game/history?filter=${filter}&page=${page}`),
  getLeaderboard: (page=1)               => api(`/game/leaderboard?page=${page}`),
  getMatch      : (id)                   => api(`/game/match/${id}`),
  saveBotMatch  : (result, fen)          => api('/game/bot-match', { method: 'POST', body: { result, fen } }),
};

// ─── TOURNAMENT API ──────────────────────────────────────
const TournamentAPI = {
  getAll      : (type, status) => api(`/tournaments?${type?'type='+type:''}${status?'&status='+status:''}`),
  getById     : (id)           => api(`/tournaments/${id}`),
  join        : (id)           => api(`/tournaments/${id}/join`, { method: 'POST' }),
  getLeaderboard: (id)         => api(`/tournaments/${id}/leaderboard`),
};

// ─── ADMIN API ───────────────────────────────────────────
const AdminAPI = {
  getDashboard   : ()              => api('/admin/dashboard'),
  getUsers       : (params='')     => api(`/admin/users?${params}`),
  updateUserStatus:(id, status)    => api(`/admin/users/${id}/status`,  { method: 'PUT',  body: { status } }),
  getKYC         : ()              => KYCAPI.getAdminList(),
  reviewKYC      : (requestId, status, reason) => KYCAPI.review({ requestId, status, reason }),
  getWithdrawals : ()              => api('/admin/withdrawals'),
  processWithdraw: (id, action, reason) => api(`/admin/withdrawals/${id}`, { method: 'PUT', body: { action, rejection_reason: reason } }),
  createTournament:(d)             => api('/admin/tournaments',         { method: 'POST', body: d }),
  getAllTournaments: ()            => api('/admin/tournaments'),
  cancelTournament: (id)           => api(`/admin/tournaments/${id}/cancel`, { method: 'PUT' }),
  getLiveMatches : ()              => api('/admin/matches/live'),
  getTransactions: (type, page=1) => api(`/admin/transactions?type=${type}&page=${page}`),
  getReports     : ()              => api('/admin/reports'),
  updateReportStatus: (id, status) => api(`/admin/reports/${id}`, { method: 'PUT', body: { status } }),
  getFeedbacks   : ()              => api('/admin/feedbacks'),
};

// ─── FRIEND API ──────────────────────────────────────────
const FriendAPI = {
  getFriends    : () => api('/friends'),
  removeFriend  : (id) => api(`/friends/${id}`, { method: 'DELETE' }),
  sendRequest   : (username) => api('/friends/request', { method: 'POST', body: { targetUsername: username } }),
  getRequests   : () => api('/friends/requests'),
  respondRequest: (id, action) => api('/friends/requests', { method: 'PUT', body: { id, action } }),
  getChallenges: () => api('/friends/challenges'),
  respondChallenge: (id, action) => api('/friends/challenges', { method: 'PUT', body: { id, action } }),
};

// ─── KYC API ─────────────────────────────────────────────
const KYCAPI = {
  submit: (formData) => {
    const token = getToken();
    return fetch(`${API_BASE}/kyc/submit`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: formData 
    }).then(res => res.json());
  },
  getAdminList: () => api('/kyc/admin/list'),
  review: (data) => api('/kyc/admin/review', { method: 'POST', body: data })
};

// ─── TOAST ───────────────────────────────────────────────
const Toast = {
  _container: null,
  _getContainer() {
    if (!this._container) {
      this._container = document.getElementById('toast-container');
      if (!this._container) {
        this._container = document.createElement('div');
        this._container.id = 'toast-container';
        this._container.className = 'toast-container';
        document.body.appendChild(this._container);
      }
    }
    return this._container;
  },
  show(message, type = 'info', duration = 3500) {
    const c = this._getContainer();
    const icons = { success: '<i class="fa-solid fa-check"></i>', error: '<i class="fa-solid fa-xmark"></i>', info: '<i class="fa-solid fa-info-circle"></i>', warning: '<i class="fa-solid fa-triangle-exclamation"></i>' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${icons[type]}</span><span>${message}</span>`;
    c.appendChild(el);
    setTimeout(() => {
      el.style.animation = 'toast-in 0.3s ease reverse forwards';
      setTimeout(() => el.remove(), 300);
    }, duration);
  },
  success: (m) => Toast.show(m, 'success'),
  error  : (m) => Toast.show(m, 'error'),
  info   : (m) => Toast.show(m, 'info'),
  warning: (m) => Toast.show(m, 'warning'),
};

// ─── GUARDS ──────────────────────────────────────────────
const requireAuth  = () => { if (!isLoggedIn()) { window.location.href = '/pages/login.html'; return false; } return true; };
const requireGuest = () => { if (isLoggedIn())  { window.location.href = '/pages/dashboard.html'; return false; } return true; };

// ─── SIDEBAR LOADER ──────────────────────────────────────
const loadSidebar = async () => {
  const container = document.getElementById('sidebar-container');
  if (!container) return;
  try {
    const res = await fetch('/components/sidebar.html');
    const html = await res.text();
    container.innerHTML = html;
    
    // Manually execute scripts in injected HTML
    const scripts = container.querySelectorAll('script');
    scripts.forEach(oldScript => {
      const newScript = document.createElement('script');
      Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
      newScript.appendChild(document.createTextNode(oldScript.innerHTML));
      oldScript.parentNode.replaceChild(newScript, oldScript);
    });
  } catch (err) {
    console.error('loadSidebar error:', err);
  }
};
