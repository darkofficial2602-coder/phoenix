const { supabase } = require('../config/supabase');
const { processMatchResult } = require('../controllers/game.controller');

// chess.js v1 compatible import
let Chess;
try { Chess = require('chess.js').Chess; } catch { Chess = require('chess.js'); }

const TournamentManager = require('../services/tournament.manager');

// Matchmaking queues per timer: { 1: [], 3: [], 5: [], 10: [] }
const queues = { 1: [], 3: [], 5: [], 10: [] };

// Tournament matchmaking queues: { [tournamentId]: [] }
const tournamentQueues = {};

// Active games: matchId → { chess, player1, player2, interval, timer_type }
const activeGames = new Map();

// Socket ↔ User maps
const socketToUser = new Map(); // socketId → { userId, username }
const userToSocket = new Map(); // userId  → socketId
const userSockets = new Map();  // userId  → Set(socketId)

const banLocks = new Set(); // Prevents anti-cheat double-confiscation race condition

let onlineCount = 0;

module.exports = (io) => {
  TournamentManager.init(io, userToSocket);

  // Expose for updates
  io.on('connection', (socket) => {
    // Standard broadcast on connection to all, with unique user count
    broadcastLiveInfo(io);

    // ─── AUTHENTICATE ───────────────────────────────────────
    socket.on('authenticate', async ({ userId, username }) => {
      // Single-Device Enforcement
      if (userSockets.has(userId) && userSockets.get(userId).size > 0) {
          // Allow multiple instances or tabs silently instead of aggressively kicking.
          // By not dropping them, they can browse Dashboard and Play simultaneously.
      }

      socketToUser.set(socket.id, { userId, username });
      userToSocket.set(userId, socket.id);
      if (!userSockets.has(userId)) userSockets.set(userId, new Set());
      userSockets.get(userId).add(socket.id);
      
      // Force live info sync to client directly once authenticated successfully
      broadcastLiveInfo(io);
      socket.emit('live_info', { online_users: userSockets.size, active_matches: activeGames.size });

      
      // Attempt to rejoin active generic match
      for (const [matchId, game] of activeGames.entries()) {
        const isP1 = game.player1.userId === userId;
        const isP2 = game.player2.userId === userId;

        if (isP1 || isP2) {
          if (isP1) {
            game.player1.socketId = socket.id;
          } else {
            game.player2.socketId = socket.id;
          }

          if (game.disconnectTimeout) { 
            clearTimeout(game.disconnectTimeout); 
            game.disconnectTimeout = null; 
          }

          socket.emit('match_sync', {
            matchId,
            fen: game.chess.fen(),
            pgn: game.chess.pgn(),
            white_time: game.player1.time,
            black_time: game.player2.time,
            moveCount: game.moveCount || 0,
            myColor: isP1 ? 'white' : 'black',
            opponent: {
              userId: isP1 ? game.player2.userId : game.player1.userId,
              username: isP1 ? game.player2.username : game.player1.username
            }
          });
        }
      }

      try {
        await supabase.from('profiles').update({ is_online: true, last_seen: new Date().toISOString() }).eq('id', userId);
        
        // Notify friends that this user is now online
        const { data: friends } = await supabase.from('friends').select('user_id, friend_id').or(`user_id.eq.${userId},friend_id.eq.${userId}`).eq('status', 'accepted');
        if (friends) {
           friends.forEach(f => {
              const friendId = f.user_id === userId ? f.friend_id : f.user_id;
              const friendSocket = userToSocket.get(friendId);
              if (friendSocket) io.to(friendSocket).emit('friend_status_update', { userId, is_online: true });
           });
        }
      } catch {}
      socket.emit('authenticated', { success: true });
    });

    // ─── TOURNAMENT MGR EVENTS ──────────────────────────────
    socket.on('join_tournament', ({ tournamentId }) => {
        socket.join(`tournament_${tournamentId}`);
    });

    socket.on('rejoin_tr_match', ({ matchId, userId }) => {
        TournamentManager.rejoinMatch(socket, matchId, userId);
    });

    socket.on('make_tr_move', ({ matchId, moveSan, userId }) => {
        TournamentManager.handleMove(userId, matchId, moveSan);
    });

    // ─── RANDOM MATCHMAKING ──────────────────────────────────
    socket.on('find_match', ({ timer, userId, username }) => {
      const queue = queues[timer];
      if (!queue) return;

      // Remove duplicates from queue
      const idx = queue.findIndex(p => p.userId === userId);
      if (idx !== -1) queue.splice(idx, 1);

      if (queue.length > 0) {
        const opponent = queue.shift();
        createMatch(io, socket, { timer, userId, username }, opponent, 'random');
      } else {
        queue.push({ socketId: socket.id, userId, username });
        socket.emit('searching', { timer });
      }
    });

    socket.on('cancel_search', ({ timer, userId }) => {
      if (queues[timer]) {
        const i = queues[timer].findIndex(p => p.userId === userId);
        if (i !== -1) queues[timer].splice(i, 1);
      }
      socket.emit('search_cancelled');
    });

    // ─── TOURNAMENT MATCHMAKING ─────────────────────────────────
    socket.on('find_tournament_match', ({ tournamentId, timer, userId, username }) => {
      if (!tournamentQueues[tournamentId]) tournamentQueues[tournamentId] = [];
      const queue = tournamentQueues[tournamentId];

      const idx = queue.findIndex(p => p.userId === userId);
      if (idx !== -1) queue.splice(idx, 1); // remove duplicate

      // Don't pair with currently active players in this tournament
      const isAlreadyInMatch = Array.from(activeGames.values()).some(g => 
        g.tournamentId === tournamentId && (g.player1.userId === userId || g.player2.userId === userId)
      );
      if (isAlreadyInMatch) return; // Prevent double queueing

      if (queue.length > 0) {
        const opponent = queue.shift();
        createMatch(io, socket, { timer, userId, username, tournamentId }, opponent, 'tournament');
      } else {
        queue.push({ socketId: socket.id, userId, username, timer, tournamentId });
        socket.emit('searching_tournament', { tournamentId });
      }
    });

    socket.on('cancel_tournament_search', ({ tournamentId, userId }) => {
      if (tournamentQueues[tournamentId]) {
        const i = tournamentQueues[tournamentId].findIndex(p => p.userId === userId);
        if (i !== -1) tournamentQueues[tournamentId].splice(i, 1);
      }
      socket.emit('search_cancelled');
    });

    // ─── FRIEND INVITE ───────────────────────────────────────
    socket.on('invite_friend', async ({ targetUserId, fromUserId, fromUsername, timer }) => {
      const targetSocket = userToSocket.get(targetUserId);
      const isPlaying = Array.from(activeGames.values()).some(g => g.player1.userId === targetUserId || g.player2.userId === targetUserId);

      try {
        // 1. Persist challenge in DB
        const { data: existing } = await supabase.from('game_challenges')
          .select('id').eq('from_user_id', fromUserId).eq('to_user_id', targetUserId).eq('status', 'pending').maybeSingle();
        
        if (!existing) {
          await supabase.from('game_challenges').insert({
            from_user_id: fromUserId,
            to_user_id: targetUserId,
            timer: timer,
            status: 'pending'
          });
        }

        // 2. Always save a persistent site notification
        const { sendNotification } = require('../services/notification.service');
        await sendNotification({
          user_id: targetUserId,
          type: 'challenge',
          title: 'New Chess Challenge! ♟️',
          message: `${fromUsername} has challenged you to a ${timer}-minute match.`,
        });

        // 3. Handle Real-time delivery
        const sockets = userSockets.get(targetUserId);
        if (sockets && sockets.size > 0) {
          if (isPlaying) {
             // If already in a game, just show a silent notification/toast
             sockets.forEach(sid => io.to(sid).emit('silent_notification'));
          } else {
             // Otherwise, show the big "Accept/Decline" modal
             sockets.forEach(sid => {
                io.to(sid).emit('friend_invite', { fromUserId, fromUsername, timer });
             });
          }
        } else {
           socket.emit('invite_info', { message: 'Player is offline. They will see your challenge when they log in!' });
        }
      } catch (e) {
        console.error('Challenge invite error:', e);
      }
    });

    socket.on('accept_invite', ({ fromUserId, toUserId, fromUsername, toUsername, timer }) => {
      const fromSocket = userToSocket.get(fromUserId);
      const host = { socketId: fromSocket, userId: fromUserId, username: fromUsername };
      const guest = { socketId: socket.id, userId: toUserId, username: toUsername };
      
      // Randomize White/Black colors for fair Friend Match initiation
      const isHostWhite = Math.random() < 0.5;
      const p1 = isHostWhite ? host : guest;
      const p2 = isHostWhite ? guest : host;
      
      createMatch(io, socket, p2, p1, 'friend', timer);
    });

    socket.on('reject_invite', ({ fromUserId }) => {
      const s = userToSocket.get(fromUserId);
      if (s) io.to(s).emit('invite_rejected');
    });

    // ─── ROOM MATCH ──────────────────────────────────────────
    socket.on('create_room', ({ roomId, userId, username }) => {
      socket.join(roomId);
      socket.emit('room_created', { roomId });
    });

    socket.on('join_room', ({ roomId, userId, username, timer }) => {
      const room = io.sockets.adapter.rooms.get(roomId);
      if (!room) return socket.emit('room_error', { message: 'Room not found.' });
      if (room.size >= 2) return socket.emit('room_error', { message: 'Room is full.' });

      socket.join(roomId);
      const opponentSocketId = [...room][0];
      const opponentData = socketToUser.get(opponentSocketId) || {};
      const p1 = { socketId: opponentSocketId, userId: opponentData.userId, username: opponentData.username };
      const p2 = { socketId: socket.id, userId, username };
      createMatch(io, socket, p2, p1, 'room', timer || 5);
    });

    // ─── CHESS MOVE ──────────────────────────────────────────
    socket.on('make_move', async ({ matchId, move }) => {
      const caller = socketToUser.get(socket.id);
      if (!caller) return;
      const userId = caller.userId;

      const game = activeGames.get(matchId);
      if (!game) return socket.emit('move_error', { message: 'Game not found.' });

      const isP1 = game.player1.userId === userId;
      const myColor = isP1 ? 'w' : 'b';
      if (game.chess.turn() !== myColor) return socket.emit('move_error', { message: 'Not your turn.' });

      let result;
      try { result = game.chess.move(move); }
      catch { return socket.emit('move_error', { message: 'Illegal move.' }); }
      if (!result) return socket.emit('move_error', { message: 'Illegal move.' });

      const moveData = {
        move: result,
        fen: game.chess.fen(),
        turn: game.chess.turn(),
        pgn: game.chess.pgn(),
      };

      io.to(game.player1.socketId).emit('move_made', moveData);
      io.to(game.player2.socketId).emit('move_made', moveData);

      game.moveCount = (game.moveCount || 0) + 1;

      if (game.moveCount === 1) {
        if (game.abortTimeout) clearTimeout(game.abortTimeout);
        startTimer(io, matchId, game);
      }

      // Persist move to Supabase
      try {
        const { data: m } = await supabase.from('matches').select('moves').eq('id', matchId).single();
        const moves = Array.isArray(m?.moves) ? m.moves : [];
        moves.push({ move: result.san, timestamp: new Date().toISOString(), player: userId });
        await supabase.from('matches').update({ moves }).eq('id', matchId);
      } catch {}

      if (game.chess.isGameOver()) await endGame(io, matchId, game);
    });

    // ─── CHAT MSG ────────────────────────────────────────────
    socket.on('chat_msg', ({ matchId, username, message }) => {
      const game = activeGames.get(matchId);
      if (!game) return;
      
      const isP1 = game.player1.socketId === socket.id;
      const targetSocketId = isP1 ? game.player2.socketId : game.player1.socketId;
      
      if (targetSocketId) {
        io.to(targetSocketId).emit('chat_msg', { username, message });
      }
    });

    // ─── RESIGN ──────────────────────────────────────────────
    socket.on('resign', async ({ matchId }) => {
      const caller = socketToUser.get(socket.id);
      if (!caller) return;
      const userId = caller.userId;

      const game = activeGames.get(matchId);
      if (!game) return;
      const isP1 = game.player1.userId === userId;
      const result = isP1 ? 'player2_win' : 'player1_win';
      const winnerId = isP1 ? game.player2.userId : game.player1.userId;
      await endGame(io, matchId, game, result, winnerId, 'resign');
    });

    // ─── DRAW OFFER ──────────────────────────────────────────
    socket.on('offer_draw', ({ matchId }) => {
      const caller = socketToUser.get(socket.id);
      if (!caller) return;
      const userId = caller.userId;

      const game = activeGames.get(matchId);
      if (!game) return;
      const opponentSocket = game.player1.userId === userId ? game.player2.socketId : game.player1.socketId;
      io.to(opponentSocket).emit('draw_offered');
    });

    socket.on('accept_draw', async ({ matchId }) => {
      const game = activeGames.get(matchId);
      if (!game) return;
      await endGame(io, matchId, game, 'draw', null, 'agreement');
    });

    // ─── ANTI-CHEAT ──────────────────────────────────────────
    // cheat_detected listener removed to prevent client-trusted security hole.
    // Server-side analysis will be implemented in future via cron or match logs.

    // ─── DISCONNECT ──────────────────────────────────────────
    socket.on('disconnect', async () => {
      onlineCount = Math.max(0, onlineCount - 1);
      const userData = socketToUser.get(socket.id);

      if (userData) {
        const sockets = userSockets.get(userData.userId);
        if (sockets) {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            userSockets.delete(userData.userId);
            try { await supabase.from('profiles').update({ is_online: false, last_seen: new Date().toISOString() }).eq('id', userData.userId); } catch {}
          }
        }

        // Remove from queues
        for (const t of [1, 3, 5, 10]) {
          const i = queues[t].findIndex(p => p.socketId === socket.id);
          if (i !== -1) queues[t].splice(i, 1);
        }
        
        // Remove from tournament queues
        for (const tId in tournamentQueues) {
          const i = tournamentQueues[tId].findIndex(p => p.socketId === socket.id);
          if (i !== -1) tournamentQueues[tId].splice(i, 1);
        }

        // Handle active game disconnect (with a 10-second grace period for page navigation)
        for (const [matchId, game] of activeGames.entries()) {
          if (game.player1.socketId === socket.id || game.player2.socketId === socket.id) {
            const disconnectedIsP1 = game.player1.socketId === socket.id;
            
            // Clear any existing timeout
            if (game.disconnectTimeout) clearTimeout(game.disconnectTimeout);
            
            game.disconnectTimeout = setTimeout(async () => {
              // Check if game is still active before ending
              if (!activeGames.has(matchId)) return;
              const result = disconnectedIsP1 ? 'player2_win' : 'player1_win';
              const winnerId = disconnectedIsP1 ? game.player2.userId : game.player1.userId;
              await endGame(io, matchId, game, result, winnerId, 'disconnect');
            }, 30000); // 30 seconds to navigate to game.html and reconnect

            break;
          }
        }

        socketToUser.delete(socket.id);
        if (!userSockets.has(userData.userId) || userSockets.get(userData.userId).size === 0) {
           userToSocket.delete(userData.userId);
           
           // Notify friends that this user is now offline
           try {
              const { data: friends } = await supabase.from('friends').select('user_id, friend_id').or(`user_id.eq.${userData.userId},friend_id.eq.${userData.userId}`).eq('status', 'accepted');
              if (friends) {
                 friends.forEach(f => {
                    const friendId = f.user_id === userData.userId ? f.friend_id : f.user_id;
                    const friendSocket = userToSocket.get(friendId);
                    if (friendSocket) io.to(friendSocket).emit('friend_status_update', { userId: userData.userId, is_online: false });
                 });
              }
           } catch {}
        }
      }

      // Recalculate unique online users on any disconnection
      onlineCount = userSockets.size;
      broadcastLiveInfo(io);
    });
  });

  // ─── CREATE MATCH ─────────────────────────────────────────
  async function createMatch(io, socket, p2, p1, matchType, timer) {
    const t = timer || p2.timer || p1.timer || 5;
    try {
      const matchData = {
        player1_id: p1.userId,
        player2_id: p2.userId,
        match_type: matchType,
        timer_type: t,
        status: 'active',
        start_time: new Date().toISOString(),
      };
      
      if (matchType === 'tournament' && p2.tournamentId) {
        matchData.tournament_id = p2.tournamentId;
      }

      // Save match to Supabase
      const { data: match, error } = await supabase.from('matches').insert(matchData).select().single();

      if (error || !match) { console.error('Match create error:', error); return; }

      const chess = new Chess();
      const gameState = {
        chess,
        matchId: match.id,
        tournamentId: p2.tournamentId || null,
        player1: { userId: p1.userId, username: p1.username, socketId: p1.socketId, time: t * 60 },
        player2: { userId: p2.userId, username: p2.username, socketId: p2.socketId || socket.id, time: t * 60 },
        timer_type: t,
        interval: null,
        moveCount: 0,
        abortTimeout: null,
      };
      activeGames.set(match.id, gameState);

      io.to(p1.socketId).emit('match_found', { matchId: match.id, color: 'white', opponent: { username: p2.username, userId: p2.userId }, timer: t });
      io.to(p2.socketId || socket.id).emit('match_found', { matchId: match.id, color: 'black', opponent: { username: p1.username, userId: p1.userId }, timer: t });

      // Start 30s abort timer for White's first move
      gameState.abortTimeout = setTimeout(async () => {
         if (!activeGames.has(match.id)) return;
         await endGame(io, match.id, gameState, 'draw', null, 'abandoned');
      }, 30000);

      broadcastLiveInfo(io);
    } catch (err) {
      console.error('createMatch error:', err);
    }
  }

  // ─── TIMER ────────────────────────────────────────────────
  function startTimer(io, matchId, game) {
    game.interval = setInterval(async () => {
      if (!activeGames.has(matchId)) { clearInterval(game.interval); return; }
      const turn = game.chess.turn();
      if (turn === 'w') game.player1.time--;
      else game.player2.time--;

      io.to(game.player1.socketId).emit('timer_update', { white_time: game.player1.time, black_time: game.player2.time });
      io.to(game.player2.socketId).emit('timer_update', { white_time: game.player1.time, black_time: game.player2.time });

      if (game.player1.time <= 0 || game.player2.time <= 0) {
        const result = game.player1.time <= 0 ? 'player2_win' : 'player1_win';
        const winnerId = game.player1.time <= 0 ? game.player2.userId : game.player1.userId;
        await endGame(io, matchId, game, result, winnerId, 'timeout');
      }
    }, 1000);
  }

  // ─── END GAME ─────────────────────────────────────────────
  async function endGame(io, matchId, game, forceResult, forceWinnerId, reason = 'normal') {
    if (!activeGames.has(matchId)) return;
    if (game.interval) clearInterval(game.interval);
    if (game.disconnectTimeout) clearTimeout(game.disconnectTimeout);
    if (game.abortTimeout) clearTimeout(game.abortTimeout);
    activeGames.delete(matchId);

    let result = forceResult;
    let winnerId = forceWinnerId;

    if (!result) {
      if (game.chess.isCheckmate()) {
        result = game.chess.turn() === 'w' ? 'player2_win' : 'player1_win';
        winnerId = game.chess.turn() === 'w' ? game.player2.userId : game.player1.userId;
      } else {
        result = 'draw';
        winnerId = null;
      }
    }

    const endData = { result, winnerId, reason, fen: game.chess.fen() };
    io.to(game.player1.socketId).emit('game_over', endData);
    io.to(game.player2.socketId).emit('game_over', endData);

    // Process result in DB
    await processMatchResult(matchId, result, winnerId, game.chess.fen());
    broadcastLiveInfo(io);
  }

  function broadcastLiveInfo(io) {
    io.emit('live_info', { online_users: userSockets.size, active_matches: activeGames.size });
  }
};

module.exports.userToSocket = userToSocket;
module.exports.socketToUser = socketToUser;
module.exports.activeGames = activeGames;
