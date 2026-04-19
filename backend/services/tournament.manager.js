const { supabase } = require('../config/supabase');
const { Chess } = require('chess.js');
const { processMatchResult } = require('../controllers/game.controller');

// State map: tournamentId -> tournamentState
const activeTourneys = new Map();
// Exported so socket.js can interact with active matches
const activeTournamentMatches = new Map(); 

class TournamentManager {
    static init(io, userToSocket) {
        this.io = io;
        this.userToSocket = userToSocket;
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
                .in('status', ['full', 'live', 'starting', 'playing', 'rest']);
            
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
            tr_id: tData.tr_id,
            players: [...playersData], // { user_id, socketId, username, rank, points }
            allPlayers: [...playersData],
            max: tData.max_players,
            timer: tData.timer_type,
            status: tData.status === 'full' ? 'FULL' : 'LIVE',
            countdown: 2 * 60, // 2 minutes countdown in current state
            round: 0,
            matches: [],
            prize_pool: tData.prize_pool || 0,
            prize_cfg: 'top3' // Paid 1 min is always top 3
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
            if (tState.status === 'FULL') {
                tState.countdown--;
                if (tState.countdown <= 0) {
                    tState.status = 'LIVE';
                    tState.countdown = 2 * 60; // 2 minutes countdown in LIVE state
                    // Update DB to live and set new start_time for the next transition
                    const nextStartTime = new Date(Date.now() + 2 * 60000).toISOString();
                    supabase.from('tournaments').update({ status: 'live', start_time: nextStartTime }).eq('id', tId).then();
                    this.io.to(`tournament_${tId}`).emit('tournament_msg', { message: 'Tournament LIVE – Get Ready!' });
                }
                this.broadcastState(tId);
            }
            else if (tState.status === 'LIVE') {
                tState.countdown--;
                if (tState.countdown <= 0) {
                    tState.status = 'STARTING';
                    // Update DB to starting
                    supabase.from('tournaments').update({ status: 'starting' }).eq('id', tId).then();
                    this.transitionInitialRound(tState);
                }
                this.broadcastState(tId);
            }
            else if (tState.status === 'STARTING') {
                // Short delay or transition to ROUND_1 immediately
                tState.status = 'playing';
                tState.round = 1;
                this.createRoundMatches(tState).catch(console.error);
            }
            else if (tState.status === 'playing') {
                const allDone = tState.matches.every(m => m.status === 'finished');
                if (allDone) {
                    tState.status = 'rest';
                    tState.countdown = 15; // 15 seconds rest between rounds
                    this.processKnockoutResults(tState);
                    this.broadcastState(tId);
                }
            }
            else if (tState.status === 'rest') {
                tState.countdown--;
                if (tState.countdown <= 0) {
                    if (tState.players.length <= 1) {
                        this.finishTournament(tId, tState);
                    } else {
                        tState.round++;
                        tState.status = 'playing';
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

        eliminated.forEach(p => { 
            p.status = 'eliminated'; 
            this.notifyEliminated(p, tState); 
        });

        // Increment score for winners to reflect their progress on the leaderboard
        advanced.forEach(p => {
            p.score = (p.score || 0) + 1;
            // Update score in DB too
            supabase.from('tournament_players')
                .update({ score: p.score })
                .eq('tournament_id', tState.id)
                .eq('user_id', p.user_id)
                .then()
                .catch(err => console.error('Failed to update score in DB:', err));
        });
        
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
        
        // Update DB end_time when starting rounds (assuming 4 rounds * 2 mins each = 8 mins total wait + play)
        const endTime = new Date(Date.now() + 15 * 60000).toISOString();
        supabase.from('tournaments').update({ end_time: endTime }).eq('id', tState.id).then();

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
            round: tState.round,
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

        // Get current live sockets from the main socket registry
        const sid1 = this.userToSocket.get(p1.user_id);
        const sid2 = this.userToSocket.get(p2.user_id);

        if (sid1) { 
            const s1 = this.io.sockets.sockets.get(sid1);
            if (s1) { s1.join(roomId); s1.join(`tournament_${tState.id}`); }
        }
        if (sid2) {
            const s2 = this.io.sockets.sockets.get(sid2);
            if (s2) { s2.join(roomId); s2.join(`tournament_${tState.id}`); }
        }

        console.log(`[TR-${tState.id}] Match created: ${p1.username} vs ${p2.username}. Sockets: ${sid1}, ${sid2}`);

        const eventData = { matchId, roomId, duration: tState.timer * 60, round: tState.round };
        if (sid1) {
            this.io.to(sid1).emit('match_found_tr', { ...eventData, color: 'white', opponent: p2 });
            console.log(` -> Emitted match_found_tr to ${p1.username} (${sid1})`);
        }
        if (sid2) {
            this.io.to(sid2).emit('match_found_tr', { ...eventData, color: 'black', opponent: p1 });
            console.log(` -> Emitted match_found_tr to ${p2.username} (${sid2})`);
        }
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

                // Save Leaderboard for historical tracking
                const { data: finalPlayers } = await supabase.from('tournament_players')
                    .select('user_id, score')
                    .eq('tournament_id', tId)
                    .order('score', { ascending: false })
                    .limit(3);
                
                if (finalPlayers) {
                    const prizes = [tData.prize_first, tData.prize_second, tData.prize_third];
                    for (let i = 0; i < finalPlayers.length; i++) {
                        await supabase.from('tournament_leaderboard').upsert({
                            tournament_id: tId,
                            user_id: finalPlayers[i].user_id,
                            rank: i + 1,
                            prize: prizes[i] || 0
                        });
                    }
                }
            }
        }

        activeTourneys.delete(tId);
    }

    static broadcastState(tId) {
        const tState = activeTourneys.get(tId);
        if (!tState) return;
        
        const syncMatches = tState.matches.map(m => ({
            id: m.id,
            round: m.round,
            player1: { userId: m.player1.userId, username: m.player1.username },
            player2: { userId: m.player2.userId, username: m.player2.username },
            winnerId: m.winnerId,
            status: m.status
        }));

        this.io.to(`tournament_${tId}`).emit(`tournament_sync_${tId}`, {
             status: tState.status,
             countdown: tState.countdown,
             round: tState.round,
             players_alive: tState.players.length,
             matches: syncMatches,
             players: tState.players.map(p => ({ user_id: p.user_id, username: p.username, score: p.score }))
        });
    }

    static notifyEliminated(player, tState) {
        // Use the userToSocket mapping passed during init
        const sid = this.userToSocket ? this.userToSocket.get(player.user_id) : null;
        if (!sid) return;
        
        try {
            this.io.to(sid).emit('tournament_eliminated', {
                message: 'You have been eliminated.'
            });
        } catch (e) {
            console.error('Failed to emit elimination:', e);
        }
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
