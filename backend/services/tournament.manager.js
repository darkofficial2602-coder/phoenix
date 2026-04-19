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
        // Check every 5 seconds for new tournaments transitioning to live/full
        setInterval(() => this.pollLiveTournaments(), 5000);
    }

    static async pollLiveTournaments() {
        try {
            // Find paid tournaments that are 'live' or 'full' (Going LIVE)
            const { data: liveTourneys } = await supabase.from('tournaments')
                .select('*')
                .eq('type', 'paid')
                .in('status', ['live', 'full', 'starting']);
            
            if (!liveTourneys) return;

            for (const t of liveTourneys) {
                if (!activeTourneys.has(t.id)) {
                    // It's a new live tournament not yet picked up by the manager!
                    const { data: players } = await supabase.from('tournament_players')
                        .select('*, profiles(username, rank)')
                        .eq('tournament_id', t.id);
                    
                    const playersData = (players || []).map(p => ({
                         user_id: p.user_id,
                         username: p.profiles?.username || 'Unknown',
                         rank: p.profiles?.rank || 'Bronze',
                         socketId: null,
                         points: 0,
                         status: 'alive'
                    }));

                    this.startLiveTournament(t.id, playersData, t);
                    console.log(`🚀 TournamentManager picked up TR-${t.tr_id || t.id}: ${t.status} (${playersData.length} players)`);
                }
            }
        } catch(e) {
            console.error('pollLiveTournaments err:', e);
        }
    }

    static async startLiveTournament(tournamentId, playersData, tData) {
        const tState = {
            id: tournamentId,
            tr_id: tData.tr_id,
            players: [...playersData],
            allPlayers: [...playersData],
            max: tData.max_players,
            timer: tData.timer_type,
            status: tData.status === 'full' ? 'going_live' : 'starting',
            countdown: tData.status === 'full' ? 60 : 15, // 60s if full, 15s if live
            round: 0,
            matches: [],
            prize_pool: tData.prize_pool || 0
        };

        activeTourneys.set(tournamentId, tState);
        this.broadcastState(tournamentId);
    }

    static tick() {
        activeTourneys.forEach((tState, tId) => {
            if (tState.status === 'going_live' || tState.status === 'starting' || tState.status === 'rest') {
                tState.countdown--;
                if (tState.countdown <= 0) {
                    if (tState.status === 'going_live') {
                        tState.status = 'starting';
                        tState.countdown = 15;
                        supabase.from('tournaments').update({ status: 'live' }).eq('id', tId).then(()=>{});
                    } else {
                        this.nextRound(tState);
                    }
                }
                this.broadcastState(tId);
            } 
            else if (tState.status === 'playing') {
                const allDone = tState.matches.every(m => m.status === 'finished');
                if (allDone && tState.matches.length > 0) {
                    tState.status = 'rest';
                    tState.countdown = 15;
                    this.processRoundResults(tState);
                    this.broadcastState(tId);
                }
            }
        });

        // Tick Active Matches
        activeTournamentMatches.forEach((match, matchId) => {
            if (match.status !== 'playing') return;
            if (match.turn === 'w') match.player1.time--;
            else match.player2.time--;

            if (match.player1.time % 10 === 0 || match.player1.time <= 5 || match.player2.time <= 5) {
                this.io.to(match.roomId).emit('timer_update', { white_time: match.player1.time, black_time: match.player2.time });
            }

            if (match.player1.time <= 0 || match.player2.time <= 0) {
                 const result = match.player1.time <= 0 ? 'player2_win' : 'player1_win';
                 const winnerId = match.player1.time <= 0 ? match.player2.userId : match.player1.userId;
                 this.resolveMatch(matchId, result, winnerId, 'timeout');
            }
        });
    }

    static async nextRound(tState) {
        if (tState.players.length <= 1) {
            return this.finishTournament(tState.id, tState);
        }

        tState.round++;
        tState.status = 'playing';
        tState.matches = [];

        const phaseName = tState.players.length === 2 ? 'final' : (tState.players.length === 4 ? 'semifinal' : `round_${tState.round}`);
        await supabase.from('tournaments').update({ phase: phaseName, status: 'live' }).eq('id', tState.id);

        const pool = [...tState.players].sort(() => 0.5 - Math.random());
        while (pool.length >= 2) {
            await this.setupMatch(pool.pop(), pool.pop(), tState);
        }

        if (pool.length === 1) {
            const pBye = pool.pop();
            if (pBye.socketId) this.io.to(pBye.socketId).emit('tournament_msg', { message: 'You got a BYE! Advancing to next round.' });
        }
        this.broadcastState(tState.id);
    }

    static async setupMatch(p1, p2, tState) {
        const { data: dbMatch } = await supabase.from('matches').insert({
            player1_id: p1.user_id, player2_id: p2.user_id,
            match_type: 'tournament', timer_type: tState.timer,
            tournament_id: tState.id, status: 'active'
        }).select().single();

        if (!dbMatch) return;

        const matchId = dbMatch.id;
        const roomId = 'tr_' + matchId;
        const match = {
            id: matchId, tournamentId: tState.id, roomId, status: 'playing',
            chess: new Chess(), turn: 'w',
            player1: { userId: p1.user_id, time: tState.timer * 60, socketId: p1.socketId },
            player2: { userId: p2.user_id, time: tState.timer * 60, socketId: p2.socketId },
            winnerId: null
        };
        
        activeTournamentMatches.set(matchId, match);
        tState.matches.push(match);

        [p1, p2].forEach(p => {
            if (p.socketId) {
                const s = this.io.sockets.sockets.get(p.socketId);
                if (s) { s.join(roomId); s.join(`tournament_${tState.id}`); }
            }
        });

        const eventData = { matchId, roomId, duration: tState.timer * 60, round: tState.round, tr_id: tState.tr_id };
        if (p1.socketId) this.io.to(p1.socketId).emit('match_found_tr', { ...eventData, color: 'white', opponent: p2 });
        if (p2.socketId) this.io.to(p2.socketId).emit('match_found_tr', { ...eventData, color: 'black', opponent: p1 });
    }

    static processRoundResults(tState) {
        const winners = new Set();
        tState.matches.forEach(m => {
            if (m.winnerId) winners.add(m.winnerId);
            else winners.add(Math.random() > 0.5 ? m.player1.userId : m.player2.userId); // Tiebreak
        });

        // Add byes
        const playedIds = new Set();
        tState.matches.forEach(m => { playedIds.add(m.player1.userId); playedIds.add(m.player2.userId); });
        tState.players.forEach(p => { if (!playedIds.has(p.user_id)) winners.add(p.user_id); });

        tState.players = tState.players.filter(p => winners.has(p.user_id));
    }

    static async resolveMatch(matchId, result, winnerId, reason) {
        const match = activeTournamentMatches.get(matchId);
        if (!match) return;
        match.status = 'finished';
        match.winnerId = winnerId;
        this.io.to(match.roomId).emit('game_over', { result, winnerId, reason, fen: match.chess.fen() });
        processMatchResult(matchId, result, winnerId, match.chess.fen()).catch(()=>{});
        activeTournamentMatches.delete(matchId);
    }

    static handleMove(userId, matchId, moveSan) {
        const match = activeTournamentMatches.get(matchId);
        if (!match || match.status !== 'playing') return false;
        if ((match.turn === 'w' && match.player1.userId !== userId) || (match.turn === 'b' && match.player2.userId !== userId)) return false;

        try {
            const moveData = match.chess.move(moveSan);
            if (!moveData) return false;
            match.turn = match.chess.turn();
            this.io.to(match.roomId).emit('move_made', { move: moveData, fen: match.chess.fen(), turn: match.turn });
            if (match.chess.isGameOver()) {
                const result = match.chess.isCheckmate() ? (match.chess.turn() === 'w' ? 'player2_win' : 'player1_win') : 'draw';
                const winnerId = match.chess.isCheckmate() ? (match.chess.turn() === 'w' ? match.player2.userId : match.player1.userId) : null;
                this.resolveMatch(matchId, result, winnerId, 'board');
            }
            return true;
        } catch(e) { return false; }
    }

    static async finishTournament(tId, tState) {
        tState.status = 'completed';
        this.broadcastState(tId);
        await supabase.from('tournaments').update({ status: 'completed', phase: 'completed' }).eq('id', tId);
        const { distributeTournamentPrizes } = require('../controllers/tournament.controller');
        const { data: tData } = await supabase.from('tournaments').select('*').eq('id', tId).single();
        if (tData) await distributeTournamentPrizes(tData);
        activeTourneys.delete(tId);
    }

    static broadcastState(tId) {
        const tState = activeTourneys.get(tId);
        if (!tState) return;
        this.io.to(`tournament_${tId}`).emit(`tournament_sync_${tId}`, {
             status: tState.status, countdown: tState.countdown,
             round: tState.round, players_alive: tState.players.length, tr_id: tState.tr_id
        });
    }

    static rejoinMatch(socket, matchId, userId) {
        const match = activeTournamentMatches.get(matchId);
        if (!match) return false;
        if (match.player1.userId === userId) match.player1.socketId = socket.id;
        else if (match.player2.userId === userId) match.player2.socketId = socket.id;
        else return false;
        socket.join(match.roomId);
        socket.join(`tournament_${match.tournamentId}`);
        socket.emit('match_rejoined', { 
            roomId: match.roomId, fen: match.chess.fen(), turn: match.turn,
            white_time: match.player1.time, black_time: match.player2.time,
            color: match.player1.userId === userId ? 'white' : 'black',
            opponent: match.player1.userId === userId ? match.player2 : match.player1
        });
        return true;
    }
}

module.exports = TournamentManager;
