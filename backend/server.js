require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const compression = require('compression');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── MIDDLEWARE ───────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── STATIC FRONTEND ─────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── API ROUTES ───────────────────────────────────────────
app.use('/api/auth',        require('./routes/auth.routes'));
app.use('/api/user',        require('./routes/user.routes').userRouter);
app.use('/api/wallet',      require('./routes/wallet.routes'));
app.use('/api/tournaments', require('./routes/tournament.routes'));
app.use('/api/game',        require('./routes/game.routes').gameRouter);
app.use('/api/admin',       require('./routes/game.routes').adminRouter);
app.use('/api/friends',     require('./routes/friend.routes'));

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', platform: 'PHOENIX X', db: 'Supabase', timestamp: new Date() });
});

// ─── RAZORPAY WEBHOOK ────────────────────────────────────
app.post('/api/webhook/razorpay', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const { verifyWebhookSignature } = require('./config/razorpay');
    const sig = req.headers['x-razorpay-signature'];
    const body = JSON.parse(req.body);
    if (verifyWebhookSignature(body, sig)) {
      console.log('✅ Razorpay webhook verified:', body.event);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(400).json({ success: false });
  }
});

// ─── SOCKET.IO ────────────────────────────────────────────
require('../socket/socket')(io);

// ─── SCHEDULERS ───────────────────────────────────────────
const { autoCreateFreeTournaments, autoCreatePaidTournaments, updateTournamentStatuses } = require('./controllers/tournament.controller');

// Update tournament statuses every 30 seconds
setInterval(updateTournamentStatuses, 30 * 1000);

// Run the Paid tournament auto-creation scheduler every minute
setInterval(autoCreatePaidTournaments, 60 * 1000);

// Create initial batch of tournaments on startup (if none exist)
setTimeout(() => {
  autoCreateFreeTournaments();
  autoCreatePaidTournaments();
}, 3000);

// ─── CATCH-ALL → SERVE FRONTEND ───────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/pages/login.html'));
});

// ─── START ───────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log('');
  console.log('  ♔  PHOENIX X — Online Chess Platform');
  console.log('  ─────────────────────────────────────');
  console.log(`  🚀  Server   : http://localhost:${PORT}`);
  console.log(`  🗄  Database : Supabase (PostgreSQL)`);
  console.log(`  🔌  Socket   : Socket.IO ready`);
  console.log(`  💳  Payment  : Razorpay configured`);
  console.log('');
});

module.exports = { app, io };
