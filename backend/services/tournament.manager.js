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
            const { data: liveTourneys } = await supabase.from('tournaments')
                .select('*')
                .eq('type', 'paid')
                .in('status', ['live', 'full', 'starting']);
            
            if (!liveTourneys) return;

            for (const t of liveTourneys) {
                if (!activeTourneys.has(t.id)) {
                    console.log(`🔍 Picked up TR-${t.tr_id || t.id}. Fetching players...`);
                    
                    let { data: players } = await supabase.from('tournament_players')
                        .select('*, profiles(username, rank)')
                        .eq('tournament_id', t.id)
                        .order('created_at', { ascending: true });

                    // Retry once if 0 players (prevent race condition)
                    if (!players || players.length === 0) {
                        console.log(`⚠️ No players found for TR-${t.tr_id}. Retrying in 2s...`);
                        await new Promise(r => setTimeout(r, 2000));
                        const retry = await supabase.from('tournament_players')
                            .select('*, profiles(username, rank)')
                            .eq('tournament_id', t.id)
                            .order('created_at', { ascending: true });
                        players = retry.data;
                    }
                    
                    if (!players || players.length === 0) {
                        console.error(`❌ Still no players found for TR-${t.tr_id}. Skipping pickup.`);
                        continue; 
                    }
                    
                    const playersData = (players || []).map((p, index) => ({
                         user_id: p.user_id,
                         username: p.profiles?.username || 'Unknown',
                         rank: p.profiles?.rank || 'Bronze',
                         socketId: null,
                         points: 0,
                         status: 'alive',
                         slot: index + 1
                    }));

                    console.log(`✅ Loaded ${playersData.length} players for TR-${t.tr_id}. Starting manager.`);
                    this.startLiveTournament(t.id, playersData, t);
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
            status: 'starting',
            countdown: tData.start_time ? Math.max(0, Math.floor((new Date(tData.start_time) - Date.now()) / 1000)) : 120,
            round: 0,
            matches: [],
            prize_pool: tData.prize_pool || 0
        };

        activeTourneys.set(tournamentId, tState);
        this.broadcastState(tournamentId);
    }

    static tick() {
        activeTourneys.forEach((tState, tId) => {
            if (tState.status === 'starting' || tState.status === 'rest') {
                tState.countdown--;
                if (tState.countdown <= 0) {
                    this.nextRound(tState);
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

        // SEQUENTIAL PAIRING (Slot 1 vs 2, 3 vs 4...)
        // No random sorting anymore!
        const pool = [...tState.players]; 
        while (pool.length >= 2) {
            const p1 = pool.shift();
            const p2 = pool.shift();
            await this.setupMatch(p1, p2, tState);
        }

        if (pool.length === 1) {
            const pBye = pool.shift();
            pBye.score = 999; // Automated win for bye
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

        // Dynamic Socket Lookup
        const { userToSocket } = require('../socket/socket');
        const s1 = userToSocket.get(p1.user_id);
        const s2 = userToSocket.get(p2.user_id);

        const match = {
            id: matchId, tournamentId: tState.id, roomId, status: 'playing',
            chess: new Chess(), turn: 'w',
            player1: { userId: p1.user_id, time: tState.timer * 60, socketId: s1, score: 0 },
            player2: { userId: p2.user_id, time: tState.timer * 60, socketId: s2, score: 0 },
            winnerId: null,
            fen: 'start'
        };
        
        activeTournamentMatches.set(matchId, match);
        tState.matches.push(match);

        [ {id: s1, uid: p1.user_id}, {id: s2, uid: p2.user_id} ].forEach(p => {
            if (p.id) {
                const s = this.io.sockets.sockets.get(p.id);
                if (s) { s.join(roomId); s.join(`tournament_${tState.id}`); }
            }
        });

        const eventData = { matchId, roomId, duration: tState.timer * 60, round: tState.round, tr_id: tState.tr_id };
        if (s1) this.io.to(s1).emit('match_found_tr', { ...eventData, color: 'white', opponent: p2 });
        if (s2) this.io.to(s2).emit('match_found_tr', { ...eventData, color: 'black', opponent: p1 });
    }

    static processRoundResults(tState) {
        const winners = [];
        
        tState.matches.forEach(m => {
            // Determine winner based on Hybrid Score (Points)
            if (m.player1.score > m.player2.score) {
                winners.push(tState.players.find(p => p.user_id === m.player1.userId));
            } else if (m.player2.score > m.player1.score) {
                winners.push(tState.players.find(p => p.user_id === m.player2.userId));
            } else {
                // Tiebreak: Checkmate winner or random if draw
                if (m.winnerId) winners.push(tState.players.find(p => p.user_id === m.winnerId));
                else winners.push(Math.random() > 0.5 ? tState.players.find(p => p.user_id === m.player1.userId) : tState.players.find(p => p.user_id === m.player2.userId));
            }
        });

        // Add byes
        const playedIds = new Set();
        tState.matches.forEach(m => { playedIds.add(m.player1.userId); playedIds.add(m.player2.userId); });
        tState.players.forEach(p => { 
            if (!playedIds.has(p.user_id)) winners.push(p); 
        });

        // Re-assign slots for next round based on arrival in winners list
        tState.players = winners.map((p, idx) => ({ ...p, slot: idx + 1 }));
    }

    static async resolveMatch(matchId, result, winnerId, reason) {
        const match = activeTournamentMatches.get(matchId);
        if (!match) return;
        
        match.status = 'finished';
        match.winnerId = winnerId;
        match.fen = match.chess.fen();

        // 🏆 HYBRID SCORING CALCULATION
        const pieceValues = { p: 1, r: 2, n: 2, b: 2, q: 5 };
        const calculatePoints = (fen, color) => {
            const board = fen.split(' ')[0];
            let pts = 0;
            const target = color === 'w' ? 'PRNBQ' : 'prnbq';
            for (const char of board) {
                if (target.includes(char)) pts += pieceValues[char.toLowerCase()];
            }
            return pts;
        };

        const p1Pieces = calculatePoints(match.fen, 'w');
        const p2Pieces = calculatePoints(match.fen, 'b');

        // Result Points: Win=10, Draw=5, Loss=0
        let p1Result = 0, p2Result = 0;
        if (result === 'player1_win') { p1Result = 10; p2Result = 0; }
        else if (result === 'player2_win') { p1Result = 0; p2Result = 10; }
        else { p1Result = 5; p2Result = 5; }

        match.player1.score = p1Pieces + p1Result;
        match.player2.score = p2Pieces + p2Result;

        console.log(`Match ${matchId} resolved: P1(${match.player1.score}) vs P2(${match.player2.score})`);

        this.io.to(match.roomId).emit('game_over', { 
            result, winnerId, reason, fen: match.fen,
            p1_score: match.player1.score, p2_score: match.player2.score 
        });

        processMatchResult(matchId, result, winnerId, match.fen).catch(()=>{});
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
            match.fen = match.chess.fen();
            this.io.to(match.roomId).emit('move_made', { move: moveData, fen: match.fen, turn: match.turn });
            
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
