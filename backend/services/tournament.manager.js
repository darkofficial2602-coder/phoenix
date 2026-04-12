const { supabase } = require('../config/supabase');
const { Chess } = require('chess.js');
const { processMatchResult } = require('../controllers/game.controller');

// State map: tournamentId -> tournamentState
const activeTourneys = new Map();
// Exported so socket.js can interact with active matches
const activeTournamentMatches = new Map(); 

class TournamentManager {
    static init(io) {
        this.io = io;
        // Check every second for advancing timers and states inside activeTourneys
        setInterval(() => this.tick(), 1000);
        // Check every 10 seconds for new tournaments transitioning to live
        setInterval(() => this.pollLiveTournaments(), 10000);
    }

    static async pollLiveTournaments() {
        try {
            // Find paid tournaments that are 'live'
            const { data: liveTourneys } = await supabase.from('tournaments')
                .select('*')
                .eq('type', 'paid')
                .eq('status', 'live');
            
            if (!liveTourneys) return;

            for (const t of liveTourneys) {
                if (!activeTourneys.has(t.id)) {
                    // It's a new live tournament not yet picked up by the manager!
                    // Load players
                    const { data: players } = await supabase.from('tournament_players')
                        .select('*, profiles(username, rank)')
                        .eq('tournament_id', t.id);
                    
                    const playersData = (players || []).map(p => ({
                         user_id: p.user_id,
                         username: p.profiles?.username || 'Unknown',
                         rank: p.profiles?.rank || 'Bronze',
                         socketId: null // They must reconnect to update this!
                    }));

                    this.startLiveTournament(t.id, playersData, t);
                    console.log(`🚀 TournamentManager picked up Live TR: ${t.id} (${playersData.length} players)`);
                }
            }
        } catch(e) {
            console.error('pollLiveTournaments err:', e);
        }
    }

    static async startLiveTournament(tournamentId, playersData, tData) {
        // format configuration
        // tData has: timer_type (1,3,5), max_players (16,32,100), type ('paid')

        const tState = {
            id: tournamentId,
            players: [...playersData], // { user_id, socketId, username, rank, points }
            allPlayers: [...playersData],
            max: tData.max_players,
            timer: tData.timer_type,
            status: 'lobby_wait',
            countdown: 5 * 60, // 5 minutes flat wait before tournament officially kicks off 
            round: 0,
            matches: [],
            prize_pool: tData.prize_pool || 0,
            prize_cfg: tData.timer_type === 5 ? 'top16' : (tData.timer_type === 3 ? 'top6' : 'top3')
        };
        
        // initialize points
        tState.players.forEach(p => p.points = 0);
        tState.allPlayers.forEach(p => p.points = 0);

        // Join players to tournament room
        playersData.forEach(p => {
          if (p.socketId) {
            const s = this.io.sockets.sockets.get(p.socketId);
            if (s) s.join(`tournament_${tournamentId}`);
          }
        });

        activeTourneys.set(tournamentId, tState);
        this.broadcastState(tournamentId);
    }

    static tick() {
        activeTourneys.forEach((tState, tId) => {
            if (tState.status === 'lobby_wait') {
                tState.countdown--;
                if (tState.countdown <= 0) {
                    this.transitionInitialRound(tState);
                } else if (tState.countdown % 10 === 0 || tState.countdown <= 5) {
                    this.broadcastState(tId);
                }
            } 
            else if (tState.status === 'playing') {
                // If it's the hybrid 5 min qualifier (100 players) or normal bracket
                // Match actual logic timers run locally per match in KnockoutManager.
                // We just wait here until all active matches are finished.
                const allDone = tState.matches.every(m => m.status === 'finished');
                if (allDone) {
                    if (tState.timer === 5 && tState.round === 1 && tState.max === 100) {
                        tState.status = 'leaderboard_wait';
                        tState.countdown = 20; // 20s leaderboard Wait
                        this.processHybridLeaderboard(tState);
                    } else {
                        // Standard knockout progression
                        tState.status = 'rest';
                        tState.countdown = 15; // 15 seconds rest
                        this.processKnockoutResults(tState);
                    }
                    this.broadcastState(tId);
                }
            }
            else if (tState.status === 'rest' || tState.status === 'leaderboard_wait') {
                tState.countdown--;
                if (tState.countdown <= 0) {
                    if (tState.players.length <= 1) {
                        this.finishTournament(tId, tState);
                    } else {
                        tState.round++;
                        this.createRoundMatches(tState).catch(console.error);
                    }
                } else if (tState.countdown <= 5) {
                    this.broadcastState(tId);
                }
            }
        });

        // Tick Active Matches explicitly (Decoupled from standard `match_found` random logic)
        activeTournamentMatches.forEach((match, matchId) => {
            if (match.status !== 'playing') return;

            // Strict server timer minus
            if (match.turn === 'w') match.player1.time--;
            else match.player2.time--;

            if (match.player1.time % 5 === 0 || match.player1.time <= 10 || match.player2.time <= 10) {
                this.io.to(match.roomId).emit('timer_update', { white_time: match.player1.time, black_time: match.player2.time });
            }

            if (match.player1.time <= 0 || match.player2.time <= 0) {
                 const result = match.player1.time <= 0 ? 'player2_win' : 'player1_win';
                 const winnerId = match.player1.time <= 0 ? match.player2.userId : match.player1.userId;
                 this.resolveMatch(matchId, result, winnerId, 'timeout');
            }
        });
    }

    static async transitionInitialRound(tState) {
        tState.round = 1;
        await this.createRoundMatches(tState);
    }

    static processHybridLeaderboard(tState) {
        // Sort remaining players by points!
        tState.players.sort((a,b) => b.points - a.points);
        const top16 = tState.players.slice(0, 16);
        const eliminated = tState.players.slice(16);
        
        eliminated.forEach(p => { p.status = 'eliminated'; this.notifyEliminated(p, tState); });
        
        // Retain only top 16 for standard knockout!
        tState.players = top16;
    }

    static processKnockoutResults(tState) {
        // Everyone who lost the match is eliminated
        const advanced = [];
        const eliminated = [];
        tState.matches.forEach(m => {
            if (m.winnerId) {
                // Find winner and add to advanced
                const winner = tState.players.find(p => p.user_id === m.winnerId);
                if (winner) advanced.push(winner);
                
                const loserId = m.player1.userId === m.winnerId ? m.player2.userId : m.player1.userId;
                const loser = tState.players.find(p => p.user_id === loserId);
                if (loser) eliminated.push(loser);
            } else {
                // If draw or abandon in knockout, randomly pick a winner or tiebreak (Random tiebreak for now)
                const rmdPlayer = Math.random() > 0.5 ? m.player1.userId : m.player2.userId;
                const winner = tState.players.find(p => p.user_id === rmdPlayer);
                if (winner) advanced.push(winner);
                const loser = tState.players.find(p => p.user_id !== rmdPlayer && (p.user_id === m.player1.userId || p.user_id === m.player2.userId));
                if (loser) eliminated.push(loser);
            }
        });

        eliminated.forEach(p => { p.status = 'eliminated'; this.notifyEliminated(p, tState); });
        
        // Wait, what if someone had a bye (no opponent)?
        const advancedIds = new Set(advanced.map(p => p.user_id));
        tState.players.forEach(p => {
             const played = tState.matches.some(m => m.player1.userId === p.user_id || m.player2.userId === p.user_id);
             if (!played && !advancedIds.has(p.user_id)) {
                 advanced.push(p); // Byes advance automatically
                 advancedIds.add(p.user_id);
             }
        });

        tState.players = advanced;
    }

    static async createRoundMatches(tState) {
        tState.status = 'playing';
        tState.matches = [];
        
        // Random pairing
        const pool = [...tState.players];
        pool.sort(() => 0.5 - Math.random());

        while (pool.length >= 2) {
            const p1 = pool.pop();
            const p2 = pool.pop();
            await this.setupMatch(p1, p2, tState);
        }

        // Handle bye if pool.length == 1
        if (pool.length === 1) {
            const pBye = pool.pop();
            this.io.to(pBye.socketId).emit('tournament_msg', { message: 'You got a BYE this round! Sit tight.' });
        }
        
        this.broadcastState(tState.id);
    }

    static async setupMatch(p1, p2, tState) {
        // Save legitimately to database so stats don't silent fail
        const { data: dbMatch, error } = await supabase.from('matches').insert({
            player1_id: p1.user_id,
            player2_id: p2.user_id,
            match_type: 'tournament',
            timer_type: tState.timer,
            tournament_id: tState.id,
            status: 'active',
            start_time: new Date().toISOString()
        }).select().single();

        if (error || !dbMatch) {
            console.error('Failed to create DB match for Tournament:', error);
            return;
        }

        const matchId = dbMatch.id;
        const roomId = 'tr_' + matchId;
        
        const match = {
            id: matchId,
            tournamentId: tState.id,
            roomId,
            status: 'playing',
            chess: new Chess(),
            turn: 'w',
            player1: { userId: p1.user_id, time: tState.timer * 60, socketId: p1.socketId }, // white
            player2: { userId: p2.user_id, time: tState.timer * 60, socketId: p2.socketId }, // black
            winnerId: null
        };
        
        activeTournamentMatches.set(matchId, match);
        tState.matches.push(match);

        // Put players in room
        const s1 = this.io.sockets.sockets.get(p1.socketId);
        const s2 = this.io.sockets.sockets.get(p2.socketId);
        if (s1) { s1.join(roomId); s1.join(`tournament_${tState.id}`); }
        if (s2) { s2.join(roomId); s2.join(`tournament_${tState.id}`); }

        const eventData = { matchId, roomId, duration: tState.timer * 60, round: tState.round };
        this.io.to(p1.socketId).emit('match_found_tr', { ...eventData, color: 'white', opponent: p2 });
        this.io.to(p2.socketId).emit('match_found_tr', { ...eventData, color: 'black', opponent: p1 });
    }

    static handleMove(userId, matchId, moveSan) {
        const match = activeTournamentMatches.get(matchId);
        if (!match || match.status !== 'playing') return false;

        const isP1 = match.player1.userId === userId;
        const reqTurn = isP1 ? 'w' : 'b';
        if (match.turn !== reqTurn) return false;

        try {
            const moveData = match.chess.move(moveSan);
            if (!moveData) return false;

            match.turn = match.chess.turn();

            // Handle points accumulation for Type 3 Hybrid Qualifiers
            const tState = activeTourneys.get(match.tournamentId);
            if (tState && tState.timer === 5 && tState.round === 1 && tState.max === 100) {
                if (moveData.captured) {
                    const pts = { 'p': 1, 'n': 2, 'b': 2, 'r': 2, 'q': 5 }[moveData.captured] || 0;
                    const capturer = tState.players.find(p => p.user_id === userId);
                    if (capturer) capturer.points += pts;
                }
            }

            this.io.to(match.roomId).emit('move_made', { move: moveData, fen: match.chess.fen(), turn: match.turn });

            if (match.chess.isGameOver()) {
                let result = 'draw';
                let winnerId = null;
                if (match.chess.isCheckmate()) {
                    result = reqTurn === 'w' ? 'player1_win' : 'player2_win';
                    winnerId = userId;
                }
                this.resolveMatch(matchId, result, winnerId, 'board');
            }

            return true;
        } catch(e) { return false; }
    }

    static resolveMatch(matchId, result, winnerId, reason) {
        const match = activeTournamentMatches.get(matchId);
        if (!match) return;

        match.status = 'finished';
        match.winnerId = winnerId;
        
        // Apply Win/Draw points for Hybrid Qualifiers
        const tState = activeTourneys.get(match.tournamentId);
        if (tState && tState.timer === 5 && tState.round === 1 && tState.max === 100) {
             const p1 = tState.players.find(p => p.user_id === match.player1.userId);
             const p2 = tState.players.find(p => p.user_id === match.player2.userId);
             if (winnerId) {
                  const winner = winnerId === p1?.user_id ? p1 : p2;
                  if (winner) winner.points += 10;
             } else {
                  if (p1) p1.points += 5;
                  if (p2) p2.points += 5;
             }
         }

        this.io.to(match.roomId).emit('game_over', { result, winnerId, reason, fen: match.chess.fen() });
        // processMatchResult DB persist happens asynchronously
        processMatchResult(matchId, result, winnerId, match.chess.fen()).catch(()=>{});
        
        activeTournamentMatches.delete(matchId);
    }

    static async finishTournament(tId, tState) {
        tState.status = 'completed';
        this.broadcastState(tId);
        
        // Save to DB
        await supabase.from('tournaments').update({ status: 'completed' }).eq('id', tId);

        // Calculate and Distribute Prizes 
        // Logic heavily relies on tState.prize_cfg ('top3', 'top6', 'top16')
        const winner = tState.players[0]; // If there's 1 left, that's the ultimate winner
        
        if (winner) {
            console.log(`Tournament ${tId} Won by ${winner.user_id}! Distributing prizes.`);
            const { data: tData } = await supabase.from('tournaments').select('*').eq('id', tId).single();
            if (tData) {
                // Sync points to DB before distributing prizes
                for (const p of tState.allPlayers) {
                  await supabase.from('tournament_players')
                    .update({ score: p.points || 0 })
                    .eq('tournament_id', tId)
                    .eq('user_id', p.user_id);
                }
                const { distributeTournamentPrizes } = require('../controllers/tournament.controller');
                await distributeTournamentPrizes(tData);
            }
        }

        activeTourneys.delete(tId);
    }

    static broadcastState(tId) {
        const tState = activeTourneys.get(tId);
        if (!tState) return;
        this.io.to(`tournament_${tId}`).emit(`tournament_sync_${tId}`, {
             status: tState.status,
             countdown: tState.countdown,
             round: tState.round,
             players_alive: tState.players.length
        });
    }

    static notifyEliminated(player, tState) {
        if (!player.socketId) return;
        this.io.to(player.socketId).emit('tournament_eliminated', {
            message: 'You have been eliminated.'
        });
    }

    static rejoinMatch(socket, matchId, userId) {
        const match = activeTournamentMatches.get(matchId);
        if (!match) return false;
        
        if (match.player1.userId === userId) { match.player1.socketId = socket.id; socket.join(match.roomId); }
        else if (match.player2.userId === userId) { match.player2.socketId = socket.id; socket.join(match.roomId); }
        else return false;

        socket.emit('match_rejoined', { 
            roomId: match.roomId,
            fen: match.chess.fen(), 
            turn: match.turn,
            white_time: match.player1.time,
            black_time: match.player2.time,
            color: match.player1.userId === userId ? 'white' : 'black',
            opponent: match.player1.userId === userId ? match.player2 : match.player1
        });
        return true;
    }
}

module.exports = TournamentManager;
