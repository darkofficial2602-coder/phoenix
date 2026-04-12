// ===== auth.routes.js =====
const express = require('express');
const router = express.Router();
const { register, login, logout, refreshToken, getMe, oauthLogin } = require('../controllers/auth.controller');
const auth = require('../middleware/auth.middleware');
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({ 
    windowMs: 15 * 60 * 1000, // 15 Mins
    max: 10, 
    message: { success: false, message: 'Too many authentication attempts. Please try again after 15 minutes.' }
});

router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/oauth-login', authLimiter, oauthLogin);
router.post('/logout', auth, logout);
router.post('/refresh', refreshToken);
router.get('/me', auth, getMe);
module.exports = router;
