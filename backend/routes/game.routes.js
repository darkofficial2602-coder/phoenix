const express = require('express');
const auth = require('../middleware/auth.middleware');
const gc = require('../controllers/game.controller');

const gameRouter = express.Router();
gameRouter.get('/history', auth, gc.getMatchHistory);
gameRouter.get('/leaderboard', auth, gc.getLeaderboard);
gameRouter.get('/match/:id', auth, gc.getMatchById);
gameRouter.post('/bot-match', auth, gc.saveBotMatch);

module.exports = { gameRouter };
