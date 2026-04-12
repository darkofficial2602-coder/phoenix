// user.routes.js
const express = require('express');
const auth = require('../middleware/auth.middleware');
const uc = require('../controllers/user.controller');
const rc = require('../controllers/report.controller');
const fc = require('../controllers/feedback.controller');
const r1 = express.Router();
r1.post('/feedback', auth, fc.submitFeedback);
r1.post('/report', auth, rc.submitReport);
r1.get('/profile', auth, uc.getProfile);
r1.put('/profile', auth, uc.updateProfile);
r1.post('/kyc', auth, uc.submitKYC);
r1.post('/change-password', auth, uc.changePassword);
r1.put('/settings', auth, uc.updateSettings);
r1.get('/notifications', auth, uc.getNotifications);
r1.put('/notifications/read', auth, uc.markNotificationsRead);
r1.get('/stats', auth, uc.getStats);
module.exports = { userRouter: r1 };
