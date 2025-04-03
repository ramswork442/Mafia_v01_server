const express = require('express');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const connectDB = require('./config/db');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const mediasoup = require('mediasoup');
const Game = require('./models/game.model');

dotenv.config();
const app = express();
app.set('trust proxy', 1); // Trust Render’s proxy

app.use(cors({
  origin: 'https://mafia-v01-client.vercel.app',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
  allowedHeaders: ['Content-Type'],
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'https://mafia-v01-client.vercel.app',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

module.exports.io = io;

connectDB();

app.use(express.json());
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

app.use('/api/games', require('./routes/game.routes'));

let worker;
let router;
const rooms = new Map();

(async () => {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });
  worker.on('died', () => {
    console.error('Mediasoup worker died, exiting...');
    process.exit(1);
  });

  router = await worker.createRouter({
    mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    ],
  });
})();

io.on('connection', (socket) => {
  // console.log(`Client connected: ${socket.id}`);

  socket.on('joinRoom', async ({ gameId }) => {
    try {
      socket.join(gameId);
      // console.log(`Client ${socket.id} joined room: ${gameId}`);
      const game = await Game.findOne({ gameId });
      if (game) {
        const player = game.players.find((p) => p.socketId === null || p.socketId === socket.id);
        if (player && !player.socketId) {
          player.socketId = socket.id;
          await game.save();
        }
        io.to(gameId).emit('gameUpdated', game);
      }
    } catch (err) {
      console.error('Error in joinRoom:', err.message);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  socket.on('joinGame', async ({ gameId, playerName }, callback) => {
    try {
      if (!gameId || !playerName) throw new Error('Missing gameId or playerName');
      socket.join(gameId);
      const game = await Game.findOne({ gameId });
      if (!game) throw new Error('Game not found');

      let player = game.players.find((p) => p.name === playerName);
      if (!player) {
        player = { name: playerName, socketId: socket.id, isAlive: true, role: 'unassigned', isReady: false };
        game.players.push(player);
      } else if (!player.socketId) {
        player.socketId = socket.id;
      } else {
        throw new Error('Player already connected');
      }

      await game.save();
      io.to(gameId).emit('playerJoined', { name: playerName });
      io.to(gameId).emit('gameUpdated', game.toJSON());
      // console.log(`${playerName} joined game: ${gameId} with playerId: ${player._id.toString()}`);
      callback({ playerId: player._id.toString() });
    } catch (err) {
      console.error('Error in joinGame:', err.message);
      socket.emit('error', { message: 'Failed to join game' });
      callback({ error: err.message });
    }
  });

  socket.on('chatMessage', async ({ gameId, name, message }) => {
    try {
      const game = await Game.findOne({ gameId });
      if (!game) return socket.emit('error', { message: 'Game not found' });

      const player = game.players.find((p) => p.name === name);
      if (!player || !player.isAlive) return socket.emit('error', { message: 'Dead players cannot chat' });

      if (game.currentPhase === 'nightMafia') {
        const isMafia = player.role === 'Mafia' || player.role === 'Godfather';
        if (isMafia) {
          const mafiaSocketIds = game.players
            .filter((p) => (p.role === 'Mafia' || p.role === 'Godfather') && p.isAlive)
            .map((p) => p.socketId);
          mafiaSocketIds.forEach((id) => io.to(id).emit('mafiaChat', { name, message }));
        }
      } else if (game.currentPhase === 'day') {
        io.to(gameId).emit('chatMessage', { name, message });
      }
    } catch (err) {
      console.error('Error in chatMessage:', err.message);
      socket.emit('error', { message: 'Failed to send chat message' });
    }
  });

  socket.on('gameUpdated', async (game) => {
    try {
      const room = rooms.get(game.gameId);
      if (game.currentPhase === 'day') {
        if (!room) {
          rooms.set(game.gameId, {
            producers: new Map(),
            transports: new Map(),
            consumers: new Map(),
            playerSockets: new Map(),
            active: true,
          });
        }
        const updatedRoom = rooms.get(game.gameId);
        updatedRoom.active = true;
        io.to(game.gameId).emit('audioStarted', { gameId: game.gameId });
      } else if (room && room.active) {
        room.active = false;
        io.to(game.gameId).emit('audioStopped');
      }
    } catch (err) {
      console.error('Error in gameUpdated:', err);
    }
  });

  socket.on('joinAudio', async ({ gameId }) => {
    try {
      const game = await Game.findOne({ gameId });
      if (!game) throw new Error('Game not found');
      const player = game.players.find((p) => p.socketId === socket.id);
      if (!player) throw new Error('Player not found');
      if (!player.isAlive) {
        // console.log(`Dead player ${player.name} tried joining audio`);
        return;
      }

      socket.join(`audio-${gameId}`);
      // console.log(`Client ${socket.id} (player ${player.name}) joined audio room: audio-${gameId}`);
      // console.log(`Clients in audio-${gameId}: ${Array.from(io.sockets.adapter.rooms.get(`audio-${gameId}`) || []).join(', ')}`);

      if (!rooms.has(gameId)) {
        rooms.set(gameId, {
          producers: new Map(),
          transports: new Map(),
          consumers: new Map(),
          playerSockets: new Map(),
          active: true,
        });
      }

      const room = rooms.get(gameId);
      room.playerSockets.set(player._id.toString(), socket.id);
      // console.log(`Emitting rtpCapabilities to ${player.name}`);
      socket.emit('rtpCapabilities', router.rtpCapabilities);
    } catch (err) {
      console.error('JoinAudio error:', err.message);
    }
  });

  socket.on('createTransport', async ({ gameId, direction }, callback) => {
    try {
      const room = rooms.get(gameId);
      if (!room || !room.active) throw new Error('Room not found or audio not active');

      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: "mafia-v01-server.onrender.com" || null }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        appData: { socketId: socket.id },
      });

      room.transports.set(transport.id, transport);
      // console.log(`🚚 ${direction} transport created: ${transport.id} for ${socket.id}`);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });

      transport.on('dtlsstatechange', (dtlsState) => {
        // console.log(`Transport ${transport.id} DTLS state: ${dtlsState}`);
        if (dtlsState === 'closed') room.transports.delete(transport.id);
      });
    } catch (err) {
      console.error('CreateTransport error:', err.message);
      callback({ error: err.message });
    }
  });

  socket.on('connectTransport', async ({ gameId, transportId, dtlsParameters }, callback) => {
    try {
      const room = rooms.get(gameId);
      if (!room) throw new Error('Room not found');
      const transport = room.transports.get(transportId);
      if (!transport) throw new Error('Transport not found');

      await transport.connect({ dtlsParameters });
      // console.log(`Transport ${transportId} connected for ${socket.id}`);
      if (callback) callback({ success: true });
    } catch (err) {
      console.error('ConnectTransport error:', err.message);
      if (callback) callback({ error: err.message });
    }
  });

  socket.on('produce', async ({ gameId, transportId, kind, rtpParameters, playerId }, callback) => {
    try {
      const room = rooms.get(gameId);
      if (!room || !room.active) throw new Error('Audio not active');
      const transport = room.transports.get(transportId);
      if (!transport) throw new Error('Transport not found');

      const producer = await transport.produce({ kind, rtpParameters });
      room.producers.set(producer.id, { producer, playerId, socketId: socket.id });
      // console.log(`🔊 Producer created: ${producer.id} for player ${socket.id}`);

      producer.on('transportclose', () => {
        // console.log(`🔊 Producer ${producer.id} closed due to transport close`);
        room.producers.delete(producer.id);
      });

      socket.to(`audio-${gameId}`).emit('newProducer', { producerId: producer.id, playerId });
      // console.log(`📢 Emitted newProducer ${producer.id} with playerId ${playerId} to audio-${gameId}`);
      callback({ id: producer.id });
    } catch (err) {
      console.error('Produce error:', err.message);
      callback({ error: err.message });
    }
  });

  socket.on('consume', async ({ gameId, transportId, producerId, rtpCapabilities }, callback) => {
    try {
      const room = rooms.get(gameId);
      if (!room || !room.active) return callback({ error: 'Audio not active' });

      const transport = room.transports.get(transportId);
      if (!transport) throw new Error('Transport not found');

      const producerInfo = room.producers.get(producerId);
      if (!producerInfo) throw new Error('Producer not found');

      if (producerInfo.socketId === socket.id) {
        // console.log(`Skipping consume for ${socket.id} on own producer ${producerId}`);
        return callback({ error: 'Cannot consume own producer' });
      }

      if (!router.canConsume({ producerId, rtpCapabilities })) {
        console.error(`Cannot consume producer ${producerId} with given rtpCapabilities`);
        return callback({ error: 'Cannot consume this producer' });
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });

      room.consumers.set(consumer.id, consumer);
      console.log(`🎧 Consumer created: ${consumer.id} consuming ${producerId} for ${socket.id} in game ${gameId}`);

      consumer.on('transportclose', () => {
        console.log(`🎧 Consumer ${consumer.id} closed due to transport close`);
        room.consumers.delete(consumer.id);
      });

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (err) {
      console.error('Consume error:', err.message);
      callback({ error: err.message });
    }
  });

  socket.on('getProducers', ({ gameId }, callback) => {
    const room = rooms.get(gameId); // Fixed: Use 'rooms' instead of 'audioRooms'
    if (!room) return callback({ error: 'Room not found' });
    const producers = Array.from(room.producers.entries()).map(([producerId, { playerId }]) => ({
      producerId,
      playerId,
    }));
    // console.log(`Returning producers for game ${gameId}:`, producers);
    callback({ producers });
  });

  socket.on('disconnect', async (reason) => {
    try {
      // console.log(`🚪 Client disconnected: ${socket.id} (${reason})`);
      const game = await Game.findOne({ 'players.socketId': socket.id });
      if (!game) return;

      const player = game.players.find((p) => p.socketId === socket.id);
      if (!player) return;

      const room = rooms.get(game.gameId);
      if (room) {
        Array.from(room.transports.entries()).forEach(([id, transport]) => {
          if (transport.appData?.socketId === socket.id) {
            transport.close();
            room.transports.delete(id);
          }
        });

        Array.from(room.producers.entries()).forEach(([id, { producer, socketId }]) => {
          if (socketId === socket.id) {
            producer.close();
            room.producers.delete(id);
          }
        });

        Array.from(room.consumers.entries()).forEach(([id, consumer]) => {
          consumer.close();
          room.consumers.delete(id);
        });

        if (room.playerSockets) {
          room.playerSockets.delete(player._id.toString());
          if (room.playerSockets.size === 0) {
            room.active = false;
            io.to(game.gameId).emit('audioStopped');
            rooms.delete(game.gameId);
            console.log(`Audio room ${game.gameId} closed due to no players`);
          }
        }
      }

      if (game.state === 'waiting') {
        game.players = game.players.filter((p) => p.socketId !== socket.id);
      } else if (game.state === 'inProgress') {
        player.socketId = null;
      }

      await game.save();
      io.to(game.gameId).emit('gameUpdated', game);
    } catch (err) {
      console.error('Error in disconnect:', err.message);
    }
  });
});

app.get('/', (req, res) => {
  res.json({ message: 'Hello, your API is working! 🚀' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));