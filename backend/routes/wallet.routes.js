// wallet.routes.js
const express = require('express');
const auth = require('../middleware/auth.middleware');
const wc = require('../controllers/wallet.controller');
const rateLimit = require('express-rate-limit');

const wr = express.Router();

const withdrawLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { success: false, message: 'Too many withdrawal requests. Please wait 1 minute.' }
});

wr.get('/balance', auth, wc.getWallet);
wr.post('/deposit/create-order', auth, wc.createDepositOrder);
wr.post('/deposit/verify', auth, wc.verifyDeposit);
wr.post('/withdraw', auth, withdrawLimiter, wc.requestWithdraw);
wr.get('/transactions', auth, wc.getTransactions);
module.exports = wr;
