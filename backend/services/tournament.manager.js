const { supabase } = require('../config/supabase');
const { Chess } = require('chess.js');
const { processMatchResult } = require('../controllers/game.controller');

const activeTourneys = new Map();
const activeTournamentMatches = new Map();

class TournamentManager {
    static init(io) {
        this.io = io;
        setInterval(() => this.tick(), 1000);
        setInterval(() => this.pollLiveTournaments(), 5000);
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
                        // Set current_players to exactly 16 for consistency
                        await supabase.from('tournaments').update({ 
                            status: 'full', 
                            current_players: 16,
                            start_time: new Date(Date.now() + 120000).toISOString() 
                        }).eq('id', ut.id);
                        
                        const { autoCreatePaidTournaments } = require('../controllers/tournament.controller');
                        autoCreatePaidTournaments().catch(()=>{});

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
        
        const { data: t } = await supabase.from('tournaments').select('*').eq('id', tournamentId).single();
        if (!t || !['full', 'starting', 'live'].includes(t.status)) return;

        let { data: players } = await supabase.from('tournament_players')
            .select('*, profiles(username, rank)').eq('tournament_id', tournamentId)
            .order('created_at', { ascending: true }) // Take first 16 by join time
            .limit(16);
        
        if (!players || players.length === 0) return;

        const playersData = players.map((p, i) => ({
            user_id: p.user_id, username: p.profiles?.username || 'Unknown',
            rank: p.profiles?.rank || 'Bronze', score: 0, status: 'alive', slot: i + 1
        }));

        this.startTournament(tournamentId, playersData, t);
    }

    static startTournament(tournamentId, playersData, tData) {
        const countdown = tData.start_time
            ? Math.max(0, Math.floor((new Date(tData.start_time) - Date.now()) / 1000))
            : 120;
        const tState = {
            id: tournamentId, tr_id: tData.tr_id,
            players: [...playersData], allPlayers: [...playersData],
            max: tData.max_players, timer: tData.timer_type,
            status: 'full', countdown,
            round: 0, matches: [], prize_pool: tData.prize_pool || 0
        };
        activeTourneys.set(tournamentId, tState);
        supabase.from('tournaments').update({ status: 'full', phase: 'full' }).eq('id', tournamentId).then(() => {});
    }

    static tick() {
        activeTourneys.forEach((tState, tId) => {
            // FULL → STARTING
            if (tState.status === 'full') {
                tState.countdown--;
                this.io.to(`tournament_${tId}`).emit('tr_timer', { countdown: tState.countdown });

                if (tState.countdown <= 0) {
                    tState.status = 'live';
                    tState.countdown = 120; // 2 min Live Lobby Wait
                    supabase.from('tournaments').update({ status: 'live', phase: 'lobby' }).eq('id', tId).then(() => {});
                    
                    // TRIGGER NEXT TR NOW
                    const { autoCreatePaidTournaments } = require('../controllers/tournament.controller');
                    autoCreatePaidTournaments().catch(() => {});
                    
                    console.log(`📡 TR-${tState.tr_id} is now LIVE. Next TR triggered. Lobby wait: 120s.`);
                    this.broadcastState(tId);
                } else if (tState.countdown % 10 === 0) {
                    this.broadcastState(tId);
                }
            }
            // STARTING / REST → countdown → next round
            else if (tState.status === 'starting' || tState.status === 'rest') {
                tState.countdown--;
                this.io.to(`tournament_${tId}`).emit('tr_timer', { countdown: tState.countdown });

                if (tState.countdown <= 0) this.nextRound(tState);
                else if (tState.countdown % 5 === 0) this.broadcastState(tId);
            }
            // LIVE → check all matches done
            else if (tState.status === 'live') {
                // LIVE LOBBY WAIT (before Round 1 matches are created)
                if (tState.matches.length === 0) {
                    tState.countdown--;
                    this.io.to(`tournament_${tId}`).emit('tr_timer', { countdown: tState.countdown });
                    
                    if (tState.countdown <= 0) {
                        console.log(`🎮 TR-${tState.tr_id} starting matches (Round 1)`);
                        this.nextRound(tState);
                    }
                    this.broadcastState(tId);
                    return;
                }

                const allDone = tState.matches.every(m => m.status === 'finished');
                if (allDone && tState.matches.length > 0) {
                    tState.status = 'rest';
                    tState.countdown = 15;
                    this.processRoundResults(tState);
                    this.broadcastState(tId);
                }

                // Connect timeout check (15s buffer)
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
            }
            this.broadcastState(tId);
        });

        // Tick active match timers
        activeTournamentMatches.forEach((match, matchId) => {
            if (match.status !== 'playing') return;

            // Timer tick
            if (match.turn === 'w') match.player1.time--;
            else match.player2.time--;

            // Emit timer only to match room
            this.io.to(match.roomId).emit('timer_update', {
                white_time: match.player1.time, black_time: match.player2.time
            });

            // Timeout check
            if (match.player1.time <= 0 || match.player2.time <= 0) {
                const result = match.player1.time <= 0 ? 'player2_win' : 'player1_win';
                const winnerId = match.player1.time <= 0 ? match.player2.userId : match.player1.userId;
                this.resolveMatch(matchId, result, winnerId, 'timeout');
            }

            // Disconnect grace (3 sec)
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

        tState.round++;
        tState.status = 'live';
        tState.matches = [];

        const phaseName = tState.players.length === 2 ? 'final' :
            tState.players.length === 4 ? 'semifinal' : `round_${tState.round}`;
        await supabase.from('tournaments').update({ phase: phaseName, status: 'live' }).eq('id', tState.id);

        // Random shuffle
        const pool = [...tState.players].sort(() => Math.random() - 0.5);
        const { userSockets } = require('../socket/socket');

        while (pool.length >= 2) {
            const p1 = pool.shift();
            const p2 = pool.shift();
            const s1 = userSockets.get(p1.user_id) || new Set();
            const s2 = userSockets.get(p2.user_id) || new Set();

            if (s1.size > 0 && s2.size > 0) {
                await this.setupMatch(p1, p2, tState);
            } else if (s1.size > 0 && s2.size === 0) {
                p1.score += 15; // Auto-win score
                console.log(`🏆 Auto-win TR-${tState.tr_id}: ${p1.username} (Opponent ${p2.username} absent)`);
                supabase.from('tournament_players').update({ score: p1.score }).eq('tournament_id', tState.id).eq('user_id', p1.user_id).then(()=>{});
            } else if (s1.size === 0 && s2.size > 0) {
                p2.score += 15;
                console.log(`🏆 Auto-win TR-${tState.tr_id}: ${p2.username} (Opponent ${p1.username} absent)`);
                supabase.from('tournament_players').update({ score: p2.score }).eq('tournament_id', tState.id).eq('user_id', p2.user_id).then(()=>{});
            } else {
                console.log(`❌ Double No-Show TR-${tState.tr_id}: ${p1.username} & ${p2.username}`);
            }
        }

        // Bye for odd player
        if (pool.length === 1) {
            const pBye = pool[0];
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
        if (error || !dbMatch) { console.error('Match create failed:', error); return; }

        const matchId = dbMatch.id;
        const roomId = 'tr_' + matchId;
        const { userSockets } = require('../socket/socket');
        const s1 = userSockets.get(p1.user_id) || new Set();
        const s2 = userSockets.get(p2.user_id) || new Set();

        const match = {
            id: matchId, tournamentId: tState.id, roomId, status: 'waiting_connect',
            connectTimeout: 15, // 15 sec timeout
            chess: new Chess(), turn: 'w',
            player1: { userId: p1.user_id, time: tState.timer * 60, socketId: [...s1][0], score: 0, connected: s1.size > 0 },
            player2: { userId: p2.user_id, time: tState.timer * 60, socketId: [...s2][0], score: 0, connected: s2.size > 0 },
            winnerId: null, fen: 'start', disconnectGrace: null, disconnectedPlayer: null
        };
        
        if (match.player1.connected && match.player2.connected) match.status = 'live';

        activeTournamentMatches.set(matchId, match);
        tState.matches.push(match);

        s1.forEach(sid => { const s = this.io.sockets.sockets.get(sid); if (s) { s.join(roomId); s.join(`tournament_${tState.id}`); } });
        s2.forEach(sid => { const s = this.io.sockets.sockets.get(sid); if (s) { s.join(roomId); s.join(`tournament_${tState.id}`); } });

        const eventData = { matchId, roomId, duration: tState.timer * 60, round: tState.round, tr_id: tState.tr_id };
        s1.forEach(sid => this.io.to(sid).emit('match_found_tr', { ...eventData, color: 'white', opponent: p2 }));
        s2.forEach(sid => this.io.to(sid).emit('match_found_tr', { ...eventData, color: 'black', opponent: p1 }));
    }

    static processRoundResults(tState) {
        const winners = [];
        const { userSockets } = require('../socket/socket');

        // Winners from actual matches
        tState.matches.forEach(m => {
            if (m.winnerId) {
                const w = tState.players.find(p => p.user_id === m.winnerId);
                if (w) winners.push(w);
            } else {
                // Tiebreak: score → less time used → random
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

        // Auto-win players (no match created) — already have points added
        const matchedIds = new Set();
        tState.matches.forEach(m => { matchedIds.add(m.player1.userId); matchedIds.add(m.player2.userId); });
        tState.players.forEach(p => {
            if (!matchedIds.has(p.user_id)) {
                // Check if online (auto-win recipients stay, absent get eliminated)
                const online = (userSockets.get(p.user_id) || new Set()).size > 0;
                if (online || p.score > 0) winners.push(p);
            }
        });

        tState.players = winners.filter(Boolean).map((p, idx) => ({ ...p, slot: idx + 1 }));
    }

    static async resolveMatch(matchId, result, winnerId, reason) {
        const match = activeTournamentMatches.get(matchId);
        if (!match || match.status === 'finished') return;

        match.status = 'finished';
        match.winnerId = winnerId;
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

        // Sync to DB for Admin/Prize distribution
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
        if (!match || match.status !== 'live') return false;
        if ((match.turn === 'w' && match.player1.userId !== userId) || (match.turn === 'b' && match.player2.userId !== userId)) return false;
        try {
            const moveData = match.chess.move(moveSan);
            if (!moveData) return false;
            match.turn = match.chess.turn();
            match.fen = match.chess.fen();
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
        if (!this.io) return;
        const tState = activeTourneys.get(tournamentId);
        if (!tState) return;
        const tIdStr = String(tournamentId);
        const cleanState = {
            id: tState.id, tr_id: tState.tr_id, status: tState.status,
            countdown: tState.countdown, round: tState.round,
            players: tState.players.map(p => ({ user_id: p.user_id, username: p.username, rank: p.rank, score: p.score, status: p.status, slot: p.slot })),
            matches: tState.matches.map(m => ({
                id: m.id, roomId: m.roomId, status: m.status,
                player1: { userId: m.player1.userId, time: m.player1.time, score: m.player1.score },
                player2: { userId: m.player2.userId, time: m.player2.time, score: m.player2.score },
                fen: m.fen
            }))
        };
        this.io.to(`tournament_${tIdStr}`).emit(`tournament_sync_${tIdStr}`, cleanState);
        if (['full', 'starting', 'rest', 'completed'].includes(tState.status)) {
            this.io.emit(`tournament_global_sync_${tIdStr}`, cleanState);
        }
    }

    static rejoinMatch(socket, matchId, userId) {
        const match = activeTournamentMatches.get(matchId);
        if (!match) return false;
        if (match.player1.userId === userId) { match.player1.socketId = socket.id; match.player1.connected = true; }
        else if (match.player2.userId === userId) { match.player2.socketId = socket.id; match.player2.connected = true; }
        else return false;

        if (match.status === 'waiting_connect' && match.player1.connected && match.player2.connected) {
            match.status = 'live';
        }
        if (match.disconnectGrace !== null) { match.disconnectGrace = null; match.disconnectedPlayer = null; }
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

    static handleDisconnect(userId) {
        activeTournamentMatches.forEach((match) => {
            if (match.status !== 'live') return;
            if (match.player1.userId === userId) { match.disconnectGrace = 3; match.disconnectedPlayer = 'p1'; }
            else if (match.player2.userId === userId) { match.disconnectGrace = 3; match.disconnectedPlayer = 'p2'; }
        });
    }
}

module.exports = TournamentManager;
