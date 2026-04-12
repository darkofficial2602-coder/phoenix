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

// ─── RAZORPAY WEBHOOK ────────────────────────────────────
app.post('/api/webhook/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const { verifyWebhookSignature } = require('./config/razorpay');
    const { supabase } = require('./config/supabase');
    const sig = req.headers['x-razorpay-signature'];
    const bodyString = req.body.toString('utf8');
    const body = JSON.parse(bodyString);
    if (verifyWebhookSignature(bodyString, sig)) {
      console.log('✅ Razorpay webhook verified:', body.event);
      if (body.event === 'payment.captured' || body.event === 'payment.authorized') {
         const entity = body.payload.payment.entity;
         const depositId = entity.notes?.deposit_id;
         if (depositId) {
            // ATOMIC LOCK: Claim the pending transaction
            const { data: txn } = await supabase.from('transactions')
               .update({ status: 'processing', reference_id: entity.id })
               .eq('id', depositId)
               .eq('status', 'pending')
               .select()
               .maybeSingle();

            if (txn) {
               const { data: wallet } = await supabase.from('wallets').select('balance, total_deposited').eq('user_id', txn.user_id).single();
               if (wallet) {
                  const newBalance = Number(wallet.balance) + Number(txn.amount);
                  await supabase.from('wallets').update({ balance: newBalance, total_deposited: (Number(wallet.total_deposited) || 0) + Number(txn.amount) }).eq('user_id', txn.user_id);
                  await supabase.from('transactions').update({ status: 'success', balance_after: newBalance }).eq('id', depositId);
               }
            }
         }
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(400).json({ success: false });
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/api/auth',        require('./routes/auth.routes'));
app.use('/api/user',        require('./routes/user.routes').userRouter);
app.use('/api/wallet',      require('./routes/wallet.routes'));
app.use('/api/tournaments', require('./routes/tournament.routes'));
app.use('/api/game',        require('./routes/game.routes').gameRouter);
app.use('/api/admin',       require('./routes/admin.routes'));
app.use('/api/friends',     require('./routes/friend.routes'));

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', platform: 'PHOENIX X', db: 'Supabase', timestamp: new Date() });
});

// ─── SOCKET.IO ────────────────────────────────────────────
require(path.join(__dirname, './socket/socket'))(io);

// ─── TOURNAMENT MANAGER ────────────────────────────────────
const TournamentManager = require('./services/tournament.manager');
TournamentManager.init(io);

// ─── STATIC FRONTEND ─────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

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
