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
        // Check every second for advancing timers and states
        setInterval(() => this.tick(), 1000);
        // Poll for tournaments transitioning states in DB
        setInterval(() => this.pollTournaments(), 5000);
    }

    static async pollTournaments() {
        try {
            // Pick up tournaments that are 'full' or 'live' but not in memory
            const { data: tourneys } = await supabase.from('tournaments')
                .select('*')
                .eq('type', 'paid')
                .in('status', ['full', 'live', 'starting', 'playing', 'rest']);
            
            if (!tourneys) return;

            for (const t of tourneys) {
                if (!activeTourneys.has(t.id)) {
                    // Load players
                    const { data: players } = await supabase.from('tournament_players')
                        .select('*, profiles(username, rank)')
                        .eq('tournament_id', t.id);
                    
                    const playersData = (players || []).map(p => ({
                         user_id: p.user_id,
                         username: p.profiles?.username || 'Unknown',
                         rank: p.profiles?.rank || 'Bronze',
                         socketId: null,
                         status: p.status || 'active' // Ensure default is active
                    }));

                    this.initializeActiveTournament(t.id, playersData, t);
                    console.log(`🚀 TournamentManager picked up TR: ${t.id} (${t.status}) with ${playersData.length} players`);
                }
            }
        } catch(e) {
            console.error('pollTournaments err:', e);
        }
    }

    static initializeActiveTournament(tournamentId, playersData, tData) {
        const tState = {
            id: tournamentId,
            tr_id: tData.display_id || `TR-${tournamentId.slice(0,4)}`,
            players: playersData.filter(p => (p.status || 'active') === 'active'),
            allPlayers: playersData,
            max: tData.max_players,
            timer: tData.timer_type,
            status: tData.status.toLowerCase(), 
            countdown: 0,
            round: tData.round || 0,
            matches: [],
            prize_pool: tData.prize_pool || 0,
            prize_first: tData.prize_first || 0,
            prize_second: tData.prize_second || 0,
            prize_third: tData.prize_third || 0
        };

        // Initialize countdowns based on pickup phase
        if (tState.status === 'full') {
            tState.countdown = 2 * 60; // 2 min to LIVE
        } else if (tState.status === 'live') {
            tState.countdown = 2 * 60; // 2 min to STARTING (as requested)
        }

        // If it's already playing, recover matches from DB
        if (['starting', 'playing', 'rest'].includes(tState.status)) {
            // Recovery logic could be enhanced here to fetch active matches from DB
        }

        activeTourneys.set(tournamentId, tState);
        this.broadcastState(tournamentId);
    }

    static tick() {
        activeTourneys.forEach((tState, tId) => {
            // 1. Lifecycle Management
            if (tState.status === 'full') {
                tState.countdown--;
                if (tState.countdown <= 0) {
                    this.transitionToLive(tState);
                }
            } 
            else if (tState.status === 'live') {
                tState.countdown--;
                if (tState.countdown <= 0) {
                    this.transitionToStarting(tState);
                }
            }
            else if (tState.status === 'starting') {
                this.transitionToRound(tState, 1);
            }
            else if (tState.status.startsWith('round_') || tState.status === 'final' || tState.status === 'playing') {
                const allDone = tState.matches.every(m => m.status === 'finished');
                if (allDone && tState.matches.length > 0) {
                    this.processRoundEnd(tState);
                }
            }
            else if (tState.status === 'rest') {
                tState.countdown--;
                if (tState.countdown <= 0) {
                    const nextRound = tState.round + 1;
                    if (tState.players.length <= 1) {
                        this.finishTournament(tId, tState);
                    } else {
                        this.transitionToRound(tState, nextRound);
                    }
                }
            }

            if (tState.countdown % 5 === 0 || tState.countdown <= 10) {
                this.broadcastState(tId);
            }
        });

        // 2. Active Match Timers
        activeTournamentMatches.forEach((match, matchId) => {
            if (match.status !== 'playing') return;

            if (match.turn === 'w') match.player1.time--;
            else match.player2.time--;

            if (match.player1.time % 5 === 0 || match.player1.time <= 10 || match.player2.time <= 10) {
                this.io.to(match.roomId).emit('timer_update', { 
                    white_time: Math.max(0, match.player1.time), 
                    black_time: Math.max(0, match.player2.time) 
                });
            }

            if (match.player1.time <= 0 || match.player2.time <= 0) {
                 const result = match.player1.time <= 0 ? 'player2_win' : 'player1_win';
                 const winnerId = match.player1.time <= 0 ? match.player2.userId : match.player1.userId;
                 this.resolveMatch(matchId, result, winnerId, 'timeout');
            }
        });
    }

    static async transitionToLive(tState) {
        tState.status = 'live';
        tState.countdown = 5 * 60;
        await supabase.from('tournaments').update({ status: 'live' }).eq('id', tState.id);
        this.io.to(`tournament_${tState.id}`).emit('tournament_msg', { message: 'Tournament LIVE – Get Ready!' });
        this.broadcastState(tState.id);
    }

    static async transitionToStarting(tState) {
        tState.status = 'starting';
        await supabase.from('tournaments').update({ status: 'starting' }).eq('id', tState.id);
        this.broadcastState(tState.id);
    }

    static async transitionToRound(tState, roundNum) {
        tState.round = roundNum;
        tState.status = roundNum === 4 ? 'final' : `round_${roundNum}`;
        tState.matches = [];
        
        await supabase.from('tournaments').update({ status: 'playing', round: roundNum }).eq('id', tState.id);

        const pool = [...tState.players];
        pool.sort(() => 0.5 - Math.random());

        while (pool.length >= 2) {
            const p1 = pool.pop();
            const p2 = pool.pop();
            await this.setupMatch(p1, p2, tState);
        }

        if (pool.length === 1) {
            const pBye = pool.pop();
            this.io.to(`tournament_${tState.id}`).emit('tournament_msg', { message: `${pBye.username} gets a BYE this round!` });
        }
        
        this.broadcastState(tState.id);
    }

    static async setupMatch(p1, p2, tState) {
        const matchId = `tr_${tState.id}_${p1.user_id.slice(0, 4)}_${p2.user_id.slice(0, 4)}`;
        const roomId = `match_${matchId}`;
        const sid1 = this.userToSocket.get(p1.user_id);
        const sid2 = this.userToSocket.get(p2.user_id);
        
        const match = {
            id: matchId,
            roomId,
            round: tState.round,
            chess: new Chess(),
            turn: 'w',
            player1: { userId: p1.user_id, time: tState.timer * 60, socketId: sid1, username: p1.username },
            player2: { userId: p2.user_id, time: tState.timer * 60, socketId: sid2, username: p2.username },
            status: 'playing',
            winnerId: null
        };

        tState.matches.push(match);
        activeTournamentMatches.set(matchId, match);

        // Notify players with BOTH match_found_tr and match_start for compatibility
        const eventData = { 
            matchId, roomId, color: 'white', opponent: p2, duration: tState.timer * 60, round: tState.round 
        };

        this.io.to(`user_${p1.user_id}`).emit('match_found_tr', eventData);
        this.io.to(`user_${p1.user_id}`).emit('match_start', { ...eventData, color: 'white', opponent: p2 });

        const eventData2 = { 
            matchId, roomId, color: 'black', opponent: p1, duration: tState.timer * 60, round: tState.round 
        };
        this.io.to(`user_${p2.user_id}`).emit('match_found_tr', eventData2);
        this.io.to(`user_${p2.user_id}`).emit('match_start', { ...eventData2, color: 'black', opponent: p1 });
    }

    static processRoundEnd(tState) {
        const advanced = [];
        const eliminated = [];

        tState.matches.forEach(m => {
            const winnerId = m.winnerId || (Math.random() > 0.5 ? m.player1.userId : m.player2.userId);
            const loserId = m.player1.userId === winnerId ? m.player2.userId : m.player1.userId;
            
            const winner = tState.players.find(p => p.user_id === winnerId);
            const loser = tState.players.find(p => p.user_id === loserId);

            if (winner) {
                winner.score = (winner.score || 0) + 1;
                advanced.push(winner);
            }
            if (loser) {
                loser.status = 'eliminated';
                eliminated.push(loser);
            }
        });

        tState.players.forEach(p => {
            const played = tState.matches.some(m => m.player1.userId === p.user_id || m.player2.userId === p.user_id);
            if (!played && p.status === 'active') advanced.push(p);
        });

        eliminated.forEach(async p => {
            await supabase.from('tournament_players').update({ status: 'eliminated' }).eq('tournament_id', tState.id).eq('user_id', p.user_id);
            this.io.to(`user_${p.user_id}`).emit('tournament_eliminated', { message: 'Eliminated from tournament.' });
        });

        tState.players = advanced;
        tState.status = 'rest';
        tState.countdown = 15;
        this.broadcastState(tState.id);
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
            this.io.to(match.roomId).emit('move_made', { 
                move: moveData, 
                fen: match.chess.fen(), 
                turn: match.turn,
                white_time: match.player1.time,
                black_time: match.player2.time
            });

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
        if (!match || match.status === 'finished') return;

        match.status = 'finished';
        match.winnerId = winnerId;
        
        this.io.to(match.roomId).emit('game_over', { result, winnerId, reason, fen: match.chess.fen() });
        processMatchResult(matchId, result, winnerId, match.chess.fen()).catch(()=>{});
        activeTournamentMatches.delete(matchId);
    }

    static async finishTournament(tId, tState) {
        tState.status = 'completed';
        await supabase.from('tournaments').update({ status: 'completed' }).eq('id', tId);
        
        const winner = tState.players[0];
        if (winner) {
            const { data: tData } = await supabase.from('tournaments').select('*').eq('id', tId).single();
            if (tData) {
                const { distributeTournamentPrizes } = require('../controllers/tournament.controller');
                await distributeTournamentPrizes(tData);
            }
        }
        this.broadcastState(tId);
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
             countdown: Math.max(0, tState.countdown),
             round: tState.round,
             players_alive: tState.players.length,
             matches: syncMatches,
             players: tState.players.map(p => ({ user_id: p.user_id, username: p.username, score: p.score }))
        });
    }

    static rejoinMatch(socket, matchId, userId) {
        const match = activeTournamentMatches.get(matchId);
        if (!match) return false;
        
        socket.join(match.roomId);
        socket.emit('match_rejoined', { 
            roomId: match.roomId,
            fen: match.chess.fen(), 
            turn: match.turn,
            white_time: match.player1.time,
            black_time: match.player2.time,
            color: match.player1.userId === userId ? 'white' : 'black',
            opponent: match.player1.userId === userId ? { user_id: match.player2.userId, username: match.player2.username } : { user_id: match.player1.userId, username: match.player1.username }
        });
        return true;
    }
}

module.exports = TournamentManager;
