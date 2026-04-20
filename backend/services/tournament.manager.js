const { supabase } = require('../config/supabase');
const { Chess } = require('chess.js');
const { processMatchResult } = require('../controllers/game.controller');

const activeTourneys = new Map();
const activeTournamentMatches = new Map();

class TournamentManager {
    static init(io) {
        console.log('🚀 TournamentManager.init starting...');
        this.io = io;
        setInterval(() => this.tick(), 1000);
        setInterval(() => this.pollLiveTournaments(), 5000);
        
        // FAIL-SAFE: Check for replenishment every 3 minutes
        setInterval(() => {
            const { autoCreatePaidTournaments } = require('../controllers/tournament.controller');
            autoCreatePaidTournaments().catch(()=>{});
        }, 3 * 60 * 1000);

        // RECOVERY: Recover any stuck tournaments from previous session
        this.recoverStuckTournaments()
            .then(() => console.log('✅ TournamentManager recovery complete.'))
            .catch(err => console.error('❌ Recovery Error:', err));
    }

    static async pollLiveTournaments() {
        try {
            // SELF-HEALING: Detect and fix stuck 'upcoming' tournaments that are actually full
            const { data: upcomingPaid } = await supabase.from('tournaments')
                .select('id, tr_id, status, max_players').eq('type', 'paid').eq('status', 'upcoming');
            
            if (upcomingPaid) {
                for (const ut of upcomingPaid) {
                    const { count } = await supabase.from('tournament_players').select('*', { count: 'exact', head: true }).eq('tournament_id', ut.id);
                    if (count >= (ut.max_players || 16)) {
                        console.log(`🔧 Self-healing TR-${ut.tr_id}: Forcing LOCKED (Actual count: ${count})`);
                        await supabase.from('tournaments').update({ 
                            status: 'full', 
                            current_players: 16,
                            start_time: new Date(Date.now() + 120000).toISOString() 
                        }).eq('id', ut.id);
                        this.pickupTournament(ut.id).catch(()=>{});
                    }
                }
            }

            const { data: tourneys } = await supabase.from('tournaments')
                .select('*').eq('type', 'paid')
                .in('status', ['full', 'starting', 'live']);
            if (!tourneys) return;

            for (const t of tourneys) {
                if (activeTourneys.has(t.id)) continue;
                await this.pickupTournament(t.id);
            }
        } catch(e) { console.error('pollLiveTournaments err:', e); }
    }

    static async pickupTournament(tournamentId) {
        if (activeTourneys.has(tournamentId)) return;
        
        const { data: t, error } = await supabase.from('tournaments').select('*').eq('id', tournamentId).single();
        if (error || !t) return;

        if (!['full', 'starting', 'live'].includes(t.status)) return;

        let { data: players, error: pError } = await supabase.from('tournament_players')
            .select('*, profiles(username, rank)').eq('tournament_id', tournamentId)
            .order('joined_at', { ascending: true })
            .limit(16);
        
        if (pError || !players || players.length === 0) return;

        const playersData = players.map((p, i) => ({
            user_id: p.user_id, username: p.profiles?.username || 'Unknown',
            rank: p.profiles?.rank || 'Bronze', score: 0, status: 'alive', slot: i + 1
        }));

        this.startTournament(tournamentId, playersData, t);
    }

    static startTournament(tournamentId, playersData, tData) {
        let countdown = 60; // 1 minute lobby before Round 1 starts
        
        if (tData.status === 'live' && tData.live_lobby_ends_at) {
            const endsAt = new Date(tData.live_lobby_ends_at);
            countdown = Math.max(0, Math.floor((endsAt - Date.now()) / 1000));
        } else if (tData.start_time) {
            countdown = Math.max(0, Math.floor((new Date(tData.start_time) - Date.now()) / 1000));
        }
        
        // Cap lobby countdown at 60s for paid knockout tournaments
        if (tData.type === 'paid') {
            countdown = Math.min(60, countdown);
        }

        const tState = {
            id: tournamentId, tr_id: tData.tr_id,
            players: [...playersData], allPlayers: [...playersData],
            max: tData.max_players, timer: tData.timer_type,
            status: tData.status || 'full', 
            phase: tData.phase || (tData.status === 'live' ? 'lobby' : 'upcoming'),
            countdown,
            round: tData.round || 0, matches: [],
            nextRoundPending: false, 
            prize_pool: tData.prize_pool || 0
        };

        activeTourneys.set(tournamentId, tState);
    }

    static tick() {
        activeTourneys.forEach((tState, tId) => {
            // FULL → Transitions to LIVE
            if (tState.status === 'full') {
                tState.countdown--;
                this.io.to(`tournament_${tId}`).emit('tr_timer', { countdown: tState.countdown });

                if (tState.countdown <= 0) {
                    this.transitionToLive(tId).catch(err => console.error('Transition Error:', err));
                } else if (tState.countdown % 10 === 0) {
                    this.broadcastState(tId);
                }
            }
            // LIVE → Handle Lobby or Matches
            else if (tState.status === 'live') {
                if (tState.phase === 'lobby') {
                    tState.countdown--;
                    this.io.to(`tournament_${tId}`).emit('tr_timer', { countdown: tState.countdown });
                    
                    if (tState.countdown <= 0 && !tState.nextRoundPending) {
                        tState.nextRoundPending = true;
                        tState.phase = 'round_1';
                        tState.round = 1;
                        tState.countdown = 600; // 10 minute overall tournament timer
                        this.nextRound(tState).finally(() => tState.nextRoundPending = false);
                    }
                    if (tState.countdown % 10 === 0) this.broadcastState(tId);
                } 
                else {
                    tState.countdown--;
                    this.io.to(`tournament_${tId}`).emit('tr_timer', { countdown: tState.countdown });
                    if (tState.countdown <= 0) {
                         // Fail-safe: Tournament took too long (10 mins)
                         // this.finishTournament(tId, tState);
                    }
                    if (tState.matches.length > 0) {
                        const allDone = tState.matches.every(m => m.status === 'finished');
                        if (allDone && !tState.nextRoundPending) {
                            tState.status = 'rest';
                            tState.countdown = 15;
                            this.processRoundResults(tState);
                            this.broadcastState(tId);
                        }
                    }
                }
            }
            // REST → Countdown to next round
            else if (tState.status === 'rest') {
                tState.countdown--;
                this.io.to(`tournament_${tId}`).emit('tr_timer', { countdown: tState.countdown });
                if (tState.countdown <= 0 && !tState.nextRoundPending) {
                    tState.nextRoundPending = true;
                    this.nextRound(tState).finally(() => tState.nextRoundPending = false);
                }
            }

            // Sync Match Timers if they are active
            tState.matches.forEach(m => {
                if (m.status === 'waiting_connect') {
                    m.connectTimeout--;
                    if (m.connectTimeout <= 0) {
                        const p1Online = m.player1.connected;
                        const p2Online = m.player2.connected;
                        if (p1Online && !p2Online) this.resolveMatch(m.id, 'player1_win', m.player1.userId, 'opponent_no_show');
                        else if (!p1Online && p2Online) this.resolveMatch(m.id, 'player2_win', m.player2.userId, 'opponent_no_show');
                        else this.resolveMatch(m.id, 'draw', null, 'both_no_show');
                    }
                }
            });
        });

        // Global Match Timer Tick
        activeTournamentMatches.forEach((match, matchId) => {
            if (match.status !== 'live') return; // Note: 'live' matches are playing
            if (match.turn === 'w') match.player1.time--;
            else match.player2.time--;
            this.io.to(match.roomId).emit('timer_update', { white_time: match.player1.time, black_time: match.player2.time });
            if (match.player1.time <= 0 || match.player2.time <= 0) {
                const result = match.player1.time <= 0 ? 'player2_win' : 'player1_win';
                const winnerId = match.player1.time <= 0 ? match.player2.userId : match.player1.userId;
                this.resolveMatch(matchId, result, winnerId, 'timeout');
            }
            if (match.disconnectGrace !== null) {
                match.disconnectGrace--;
                if (match.disconnectGrace <= 0) {
                    const result = match.disconnectedPlayer === 'p1' ? 'player2_win' : 'player1_win';
                    const winnerId = match.disconnectedPlayer === 'p1' ? match.player2.userId : match.player1.userId;
                    this.resolveMatch(matchId, result, winnerId, 'disconnect_timeout');
                }
            }
        });
    }

    static async nextRound(tState) {
        if (tState.players.length <= 1) return this.finishTournament(tState.id, tState);

        tState.matches = []; // Clear previous round matches

        // Advance round only if we are coming from REST or Lobby
        if (tState.status === 'rest') {
            tState.round++;
        }
        
        tState.status = 'live';
        tState.matches = [];
        const phaseName = tState.players.length === 2 ? 'final' : (tState.players.length === 4 ? 'semifinal' : `round_${tState.round}`);
        tState.phase = phaseName;

        await supabase.from('tournaments').update({ phase: phaseName, status: 'live', round: tState.round }).eq('id', tState.id);

        const pool = [...tState.players].sort(() => Math.random() - 0.5);

        while (pool.length >= 2) {
            const p1 = pool.shift(); 
            const p2 = pool.shift();
            await this.setupMatch(p1, p2, tState);
        }

        if (pool.length === 1) {
            const pBye = pool[0];
            const { userSockets } = require('../socket/socket');
            const s = userSockets.get(pBye.user_id) || new Set();
            s.forEach(sid => this.io.to(sid).emit('tournament_msg', { message: 'You got a BYE! Advancing.' }));
        }

        this.broadcastState(tState.id);
    }

    static async setupMatch(p1, p2, tState) {
        const { data: dbMatch, error } = await supabase.from('matches').insert({
            player1_id: p1.user_id, player2_id: p2.user_id,
            match_type: 'tournament', timer_type: tState.timer,
            tournament_id: tState.id, status: 'active',
            round: tState.round
        }).select().single();
        if (error || !dbMatch) return;

        const { userSockets } = require('../socket/socket');
        const s1 = userSockets.get(p1.user_id) || new Set();
        const s2 = userSockets.get(p2.user_id) || new Set();

        const p1Online = s1.size > 0;
        const p2Online = s2.size > 0;
        console.log(`🔍 TR Match Setup: ${p1.username}(${p1Online}) vs ${p2.username}(${p2Online})`);

        const match = {
            id: dbMatch.id,
            tournamentId: tState.id,
            roomId: dbMatch.room_id || `tr_${dbMatch.id}`,
            status: 'waiting_connect',
            connectTimeout: 60,
            chess: new Chess(),
            turn: 'w',
            player1: { userId: p1.user_id, time: tState.timer * 60, socketId: [...s1][0], score: 0, connected: p1Online },
            player2: { userId: p2.user_id, time: tState.timer * 60, socketId: [...s2][0], score: 0, connected: p2Online },
            winnerId: null,
            fen: 'start',
            disconnectGrace: null,
            disconnectedPlayer: null
        };

        if (p1Online && p2Online) match.status = 'live';

        activeTournamentMatches.set(dbMatch.id, match);
        tState.matches.push(match);

        const eventData = { matchId: dbMatch.id, tournamentId: tState.id, timer: tState.timer, roomId: dbMatch.room_id };
        s1.forEach(sid => this.io.to(sid).emit('match_found_tr', { ...eventData, color: 'white', opponent: p2 }));
        s2.forEach(sid => this.io.to(sid).emit('match_found_tr', { ...eventData, color: 'black', opponent: p1 }));
    }

    static processRoundResults(tState) {
        const winners = [];
        const { userSockets } = require('../socket/socket');

        tState.matches.forEach(m => {
            if (m.winnerId) {
                const w = tState.players.find(p => p.user_id === m.winnerId);
                if (w) winners.push(w);
            } else {
                if (m.player1.score > m.player2.score) winners.push(tState.players.find(p => p.user_id === m.player1.userId));
                else if (m.player2.score > m.player1.score) winners.push(tState.players.find(p => p.user_id === m.player2.userId));
                else {
                    const t1 = (tState.timer * 60) - m.player1.time;
                    const t2 = (tState.timer * 60) - m.player2.time;
                    if (t1 < t2) winners.push(tState.players.find(p => p.user_id === m.player1.userId));
                    else if (t2 < t1) winners.push(tState.players.find(p => p.user_id === m.player2.userId));
                    else winners.push(Math.random() > 0.5 ? tState.players.find(p => p.user_id === m.player1.userId) : tState.players.find(p => p.user_id === m.player2.userId));
                }
            }
        });

        const matchedIds = new Set();
        tState.matches.forEach(m => { matchedIds.add(m.player1.userId); matchedIds.add(m.player2.userId); });
        tState.players.forEach(p => {
            if (!matchedIds.has(p.user_id)) {
                const online = (userSockets.get(p.user_id) || new Set()).size > 0;
                if (online || p.score > 0) winners.push(p);
            }
        });

        const oldPlayerIds = new Set(tState.players.map(p => p.user_id));
        tState.players = winners.filter(Boolean).map((p, idx) => ({ ...p, slot: idx + 1 }));
        const newPlayerIds = new Set(tState.players.map(p => p.user_id));

        // Notify eliminated players
        oldPlayerIds.forEach(id => {
            if (!newPlayerIds.has(id)) {
                const sockets = userSockets.get(id);
                if (sockets) {
                    sockets.forEach(sid => {
                        this.io.to(sid).emit('tournament_msg', { message: 'You have been eliminated.' });
                        this.io.to(sid).emit('tournament_eliminated');
                    });
                }
            }
        });
    }

    static async resolveMatch(matchId, result, winnerId, reason) {
        console.log(`🏁 Resolving Match ${matchId} | Reason: ${reason} | Result: ${result}`);
        const match = activeTournamentMatches.get(matchId);
        if (!match || match.status === 'finished') return;

        match.status = 'finished';
        match.result = result;
        match.winnerId = winnerId;

        // Find and mark the loser as eliminated in tState
        const { userSockets } = require('../socket/socket');
        const tState = activeTourneys.get(match.tournamentId);
        if (tState) {
            const loserId = (winnerId === match.player1.userId) ? match.player2.userId : (result === 'player1_win' ? match.player2.userId : (result === 'player2_win' ? match.player1.userId : null));
            if (loserId) {
                const pIdx = tState.players.findIndex(p => p.user_id === loserId);
                if (pIdx !== -1) {
                    tState.players[pIdx].status = 'eliminated';
                    // Notify eliminated player immediately
                    const sockets = userSockets.get(loserId);
                    if (sockets) {
                        sockets.forEach(sid => {
                            this.io.to(sid).emit('tournament_msg', { message: 'You have been eliminated.' });
                            this.io.to(sid).emit('tournament_eliminated');
                        });
                    }
                }
            }
            this.broadcastState(tState.id);
        }

        supabase.from('matches').update({ result, winner_id: winnerId, status: 'finished', end_time: new Date().toISOString() }).eq('id', matchId).then(()=>{});
        match.fen = match.chess.fen();

        const pieceValues = { p: 1, r: 2, n: 2, b: 2, q: 5 };
        const calcPieces = (fen, color) => {
            const board = fen.split(' ')[0]; let pts = 0;
            const target = color === 'w' ? 'PRNBQ' : 'prnbq';
            for (const c of board) { if (target.includes(c)) pts += pieceValues[c.toLowerCase()]; }
            return pts;
        };

        const p1Pts = calcPieces(match.fen, 'w'), p2Pts = calcPieces(match.fen, 'b');
        let p1R = 0, p2R = 0;
        if (result === 'player1_win') p1R = 10; else if (result === 'player2_win') p2R = 10; else { p1R = 5; p2R = 5; }
        match.player1.score += p1Pts + p1R;
        match.player2.score += p2Pts + p2R;

        supabase.from('tournament_players').update({ score: match.player1.score }).eq('tournament_id', match.tournamentId).eq('user_id', match.player1.userId).then(()=>{});
        supabase.from('tournament_players').update({ score: match.player2.score }).eq('tournament_id', match.tournamentId).eq('user_id', match.player2.userId).then(()=>{});

        this.broadcastState(match.tournamentId);
        this.io.to(match.roomId).emit('game_over', {
            result, winnerId, reason, fen: match.fen,
            p1_score: match.player1.score, p2_score: match.player2.score
        });
        processMatchResult(matchId, result, winnerId, match.fen).catch(() => {});
        activeTournamentMatches.delete(matchId);
    }

    static handleMove(userId, matchId, moveSan) {
        const match = activeTournamentMatches.get(matchId);
        if (!match || match.status === 'finished') return;

        // If a move is made, the match is definitely live
        if (match.status === 'waiting_connect') {
            console.log(`✅ Match ${matchId} activated by move from ${userId}`);
            match.status = 'live';
        }

        try {
            const moveData = match.chess.move(moveSan);
            if (!moveData) return false;
            match.turn = match.chess.turn(); match.fen = match.chess.fen();
            this.io.to(match.roomId).emit('move_made', { move: moveData, fen: match.fen, turn: match.turn });
            if (match.chess.isGameOver()) {
                const r = match.chess.isCheckmate() ? (match.chess.turn() === 'w' ? 'player2_win' : 'player1_win') : 'draw';
                const w = match.chess.isCheckmate() ? (match.chess.turn() === 'w' ? match.player2.userId : match.player1.userId) : null;
                this.resolveMatch(matchId, r, w, 'board');
            }
            return true;
        } catch(e) { return false; }
    }

    static async finishTournament(tId, tState) {
        tState.status = 'completed';
        this.broadcastState(tId);
        await supabase.from('tournaments').update({ status: 'completed', phase: 'completed' }).eq('id', tId);
        const { distributeTournamentPrizes, autoCreatePaidTournaments } = require('../controllers/tournament.controller');
        const { data: tData } = await supabase.from('tournaments').select('*').eq('id', tId).single();
        if (tData) await distributeTournamentPrizes(tData);
        activeTourneys.delete(tId);
        autoCreatePaidTournaments().catch(() => {});
    }

    static broadcastState(tournamentId) {
        const tState = activeTourneys.get(tournamentId);
        if (!tState || !this.io) return;
        const cleanState = {
            id: tState.id, tr_id: tState.tr_id, status: tState.status, phase: tState.phase,
            countdown: tState.countdown, round: tState.round,
            players: tState.players.map(p => ({ user_id: p.user_id, username: p.username, rank: p.rank, score: p.score, status: p.status, slot: p.slot })),
            matches: tState.matches.map(m => ({
                id: m.id, roomId: m.roomId, status: m.status,
                player1: { userId: m.player1.userId, time: m.player1.time, score: m.player1.score, connected: m.player1.connected },
                player2: { userId: m.player2.userId, time: m.player2.time, score: m.player2.score, connected: m.player2.connected },
                fen: m.fen
            }))
        };
        this.io.to(`tournament_${tournamentId}`).emit(`tournament_sync_${tournamentId}`, cleanState);
    }

    static onPlayerConnected(userId, socket) {
        activeTourneys.forEach((tState, tId) => {
            if (tState.allPlayers.some(p => p.user_id === userId)) {
                socket.join(`tournament_${tId}`);
                this.broadcastState(tId);
            }
        });
        activeTournamentMatches.forEach((match, matchId) => {
            if (match.player1.userId === userId || match.player2.userId === userId) {
                this.rejoinMatch(socket, matchId, userId);
            }
        });
    }

    static rejoinMatch(socket, matchId, userId) {
        const match = activeTournamentMatches.get(matchId);
        if (!match) return false;
        if (match.player1.userId === userId) { match.player1.socketId = socket.id; match.player1.connected = true; }
        else if (match.player2.userId === userId) { match.player2.socketId = socket.id; match.player2.connected = true; }
        else return false;

        if (match.status === 'waiting_connect' && match.player1.connected && match.player2.connected) match.status = 'live';
        socket.join(match.roomId);
        socket.emit('match_rejoined', {
            roomId: match.roomId, fen: match.chess.fen(), turn: match.turn,
            white_time: match.player1.time, black_time: match.player2.time,
            color: match.player1.userId === userId ? 'white' : 'black',
            opponent: match.player1.userId === userId ? match.player2 : match.player1
        });
        return true;
    }

    static handleDisconnect(userId) {
        activeTournamentMatches.forEach((match) => {
            if (match.player1.userId === userId) { match.player1.connected = false; match.disconnectGrace = 10; }
            else if (match.player2.userId === userId) { match.player2.connected = false; match.disconnectGrace = 10; }
        });
    }

    static async transitionToLive(tournamentId) {
        const tState = activeTourneys.get(tournamentId);
        if (!tState || tState.status === 'live') return;

        // Update memory immediately to prevent re-entry
        tState.status = 'live';
        tState.phase = 'lobby';
        tState.countdown = 120;

        const liveLobbyEndsAt = new Date(Date.now() + 120000).toISOString();
        const { data: t, error } = await supabase.from('tournaments')
            .update({ status: 'live', phase: 'lobby', live_lobby_ends_at: liveLobbyEndsAt })
            .eq('id', tournamentId).select().single();

        if (error) return console.error('Transition Error:', error);

        if (t && !t.next_created) {
            await supabase.from('tournaments').update({ next_created: true }).eq('id', tournamentId);
            const { autoCreatePaidTournaments } = require('../controllers/tournament.controller');
            autoCreatePaidTournaments().catch(()=>{});
        }
        this.broadcastState(tournamentId);
    }

    static async recoverStuckTournaments() {
        const { data: stuck } = await supabase.from('tournaments').select('*').in('status', ['full', 'starting']).eq('type', 'paid');
        if (!stuck) return;
        for (const t of stuck) {
            if (new Date() >= new Date(t.start_time)) {
                await this.pickupTournament(t.id);
                await this.transitionToLive(t.id);
            }
        }
    }
}

module.exports = TournamentManager;
