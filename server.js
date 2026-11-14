'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ ok: true }));

const COLORS = ['#f56c78', '#4d99eb', '#40b88a', '#a778e6'];
const NAMES = ['Coral', 'Bubbles', 'Pickles', 'Plum'];

const races = [
  { seconds: 6, mode: 'equation', lines: [[2,0],[4,0],[3,0],[1,0]] },
  { seconds: 5, mode: 'equation', lines: [[2,10],[4,0],[3,4],[1,11]] },
  { seconds: 6, mode: 'graph', lines: [[3,1],[1,14],[2,7],[4,0]] },
  { seconds: 3, mode: 'equation', lines: [[2,9],[4,1],[3,4],[5,0]] },
  { seconds: 6, mode: 'table', lines: [[2,8],[3,3],[4,0],[1,14]] },
  { seconds: 8, mode: 'partial', shown: 4, lines: [[2,11],[4,0],[3,5],[1,14]] },
  { seconds: 7, mode: 'equation', lines: [[3,3],[2,10],[4,0],[1,15]] },
  { seconds: 6, mode: 'mixed', lines: [[2,10],[4,0],[3,5],[1,17]] },
  { seconds: 10, mode: 'partial', shown: 5, lines: [[2,13],[4,0],[3,7],[1,17]] },
  { seconds: 8, mode: 'mixed', lines: [[3,11],[4,0],[2,19],[5,0]] }
];

const rooms = new Map();
const clean = s => String(s || '').replace(/[<>\x00-\x1f]/g, '').trim().slice(0, 24);

function code() {
  let x;
  do { x = String(crypto.randomInt(100000, 1000000)); }
  while (rooms.has(x));
  return x;
}

function winIndices(r) {
  const vals = r.lines.map(([m,b]) => m * r.seconds + b);
  const max = Math.max(...vals);
  return vals.flatMap((v,i) => v === max ? [i] : []);
}

function publicState(room, viewerId, teacher = false) {
  const players = [...room.players.values()];
  const p = room.players.get(viewerId);
  return {
    code: room.code,
    phase: room.phase,
    index: room.index,
    total: races.length,
    race: races[room.index] || null,
    names: NAMES,
    colors: COLORS,
    joined: players.length,
    betCount: players.filter(p => p.bet && p.bet.round === room.index).length,
    distribution: room.phase === 'betting' ? null : NAMES.map((_,i) => players.filter(p => p.bet?.round === room.index && p.bet.pick === i).length),
    myBet: p?.bet?.round === room.index ? p.bet : null,
    myName: p?.name || null,
    myCoins: p?.coins ?? null,
    startAt: room.startAt,
    finishedAt: room.finishedAt,
    winners: room.phase === 'results' ? winIndices(races[room.index]) : null,
    leaderboard: (room.phase === 'results' || room.phase === 'finished')
      ? players.map(p => ({name:p.name, coins:p.coins, wins:p.wins}))
          .sort((a,b) => b.coins-a.coins || b.wins-a.wins || a.name.localeCompare(b.name)).slice(0,20)
      : null,
    isTeacher: teacher
  };
}

function publish(room) {
  for (const [socketId, role] of room.connections) {
    const sock = io.sockets.sockets.get(socketId);
    if (sock) sock.emit('state', publicState(room, role.playerId, role.teacher));
  }
}

function fail(cb, msg) {
  cb?.({ok:false, error:msg});
}

function member(socket) {
  const c = socket.data.code;
  if (!c) return null;
  const r = rooms.get(c);
  return r && r.connections.get(socket.id) ? r : null;
}

io.on('connection', socket => {
  socket.on('create', (_, cb) => {
    const c = code(), secret = crypto.randomBytes(24).toString('hex');
    const room = {
      code:c, secret, phase:'betting', index:0,
      players:new Map(), connections:new Map(),
      startAt:null, finishedAt:null, timer:null
    };
    rooms.set(c, room);
    socket.data.code = c;
    room.connections.set(socket.id, {teacher:true});
    socket.join(c);
    cb?.({ok:true, code:c, secret});
    publish(room);
  });

  socket.on('host:rejoin', ({code:c, secret}, cb) => {
    const room = rooms.get(String(c || ''));
    if (!room || room.secret !== secret)
      return fail(cb, 'Teacher session unavailable. Create a new game.');
    socket.data.code = room.code;
    room.connections.set(socket.id, {teacher:true});
    socket.join(room.code);
    cb?.({ok:true});
    publish(room);
  });

  socket.on('join', ({code:c, name, id}, cb) => {
    const room = rooms.get(String(c || '').trim());
    if (!room) return fail(cb, 'No game with that PIN. Check the teacher screen.');
    name = clean(name);
    if (!name) return fail(cb, 'Enter your first name or nickname.');
    if (room.phase === 'finished') return fail(cb, 'This game has ended.');

    const playerId = (typeof id === 'string' && /^[a-f0-9]{32}$/.test(id))
      ? id : crypto.randomBytes(16).toString('hex');

    let p = room.players.get(playerId);
    if (!p) {
      if ([...room.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase()))
        return fail(cb, 'That name is taken. Add an initial.');
      p = {name, coins:100, wins:0, bet:null};
      room.players.set(playerId, p);
    }
    socket.data.code = room.code;
    room.connections.set(socket.id, {teacher:false, playerId});
    socket.join(room.code);
    cb?.({ok:true, id:playerId});
    publish(room);
  });

  socket.on('bet', ({pick, amount}, cb) => {
    const room = member(socket);
    const role = room?.connections.get(socket.id);
    if (!room || role?.teacher) return fail(cb, 'Join as a student first.');
    if (room.phase !== 'betting') return fail(cb, 'Betting is closed.');
    const p = room.players.get(role.playerId);
    if (!p) return fail(cb, 'Player not found.');
    if (p.bet?.round === room.index) return fail(cb, 'Your bet is already locked.');
    if (!Number.isInteger(pick) || pick < 0 || pick > 3 || ![10,20,30].includes(amount))
      return fail(cb, 'Invalid bet.');
    if (amount > p.coins) return fail(cb, 'Not enough Turtle Bucks.');
    p.bet = {round:room.index, pick, amount};
    cb?.({ok:true});
    publish(room);
  });

  socket.on('host:action', ({action}, cb) => {
    const room = member(socket);
    const role = room?.connections.get(socket.id);
    if (!room || !role?.teacher) return fail(cb, 'Teacher access required.');

    if (action === 'start' && room.phase === 'betting') {
      room.phase = 'racing';
      room.startAt = Date.now() + 1200;
      room.finishedAt = room.startAt + 8200;
      room.timer = setTimeout(() => {
        if (room.phase !== 'racing') return;
        const winners = winIndices(races[room.index]);
        for (const p of room.players.values()) {
          if (p.bet?.round !== room.index) continue;
          const won = winners.includes(p.bet.pick);
          p.coins += won ? p.bet.amount : -p.bet.amount;
          if (won) p.wins++;
        }
        room.phase = 'results';
        publish(room);
      }, room.finishedAt - Date.now());

    } else if (action === 'next' && room.phase === 'results') {
      room.index++;
      room.startAt = null;
      room.finishedAt = null;
      if (room.index >= races.length) {
        room.phase = 'finished';
      } else {
        room.phase = 'betting';
        for (const p of room.players.values())
          if (p.coins < 10) p.coins += 30;
      }

    } else if (action === 'reset' && ['results','finished','betting'].includes(room.phase)) {
      clearTimeout(room.timer);
      room.index = 0;
      room.phase = 'betting';
      room.startAt = null;
      room.finishedAt = null;
      for (const p of room.players.values()) {
        p.coins = 100;
        p.wins = 0;
        p.bet = null;
      }

    } else {
      return fail(cb, 'That action is not available now.');
    }
    cb?.({ok:true});
    publish(room);
  });

  socket.on('disconnect', () => {
    const room = member(socket);
    if (room) {
      room.connections.delete(socket.id);
      publish(room);
    }
  });
});

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => console.log('Turtle Race Day on port ' + port));
