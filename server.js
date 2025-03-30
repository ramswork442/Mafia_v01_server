const express = require('express');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require("socket.io");
const connectDB = require('./config/db');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const mediasoup = require('mediasoup');
const Game = require('./models/game.model');

dotenv.config();
const app = express();
// Consistent CORS for Express
app.use(cors({
  origin: "https://mafia-v01-client.vercel.app",
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
  allowedHeaders: ['Content-Type'],
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://mafia-v01-client.vercel.app",
    methods: ['GET', 'POST'],
    credentials: true,
  },
});


module.exports.io = io;

// Database connection
connectDB();

// Middleware
app.use(express.json());
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

// Routes
app.use('/api/games', require('./routes/game.routes'));

// Mediasoup setup
let worker;
let router;
const rooms = new Map(); // Map for audio rooms

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
    webRtcTransportOptions: {
      listenIps: [{ ip: '0.0.0.0' }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    },
  });
})();

// Socket.IO connection handling
io.on('connection', (socket) => {
  // console.log('New client connected:', socket.id);

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

  socket.on('joinGame', async ({ gameId, playerName }) => {
    try {
      if (!gameId || !playerName) throw new Error('Missing gameId or playerName');
      socket.join(gameId);
      const game = await Game.findOne({ gameId });
      if (game) {
        const player = game.players.find((p) => p.name === playerName);
        if (player && !player.socketId) {
          player.socketId = socket.id;
          await game.save();
          io.to(gameId).emit('playerJoined', { name: playerName });
          io.to(gameId).emit('gameUpdated', game);
        }
      }
      // console.log(`${playerName} joined game: ${gameId}`);
    } catch (err) {
      console.error('Error in joinGame:', err.message);
      socket.emit('error', { message: 'Failed to join game' });
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

  // PROBLEM: This listener might not trigger as expected; it’s client-emitted, not server-driven
  socket.on('gameUpdated', async (game) => {
    try {
      const room = rooms.get(game.gameId);
      if (game.currentPhase === 'day' && (!room || !room.active)) {
        if (!rooms.has(game.gameId)) {
          rooms.set(game.gameId, {
            router,
            transports: new Map(),
            producers: new Map(),
            consumers: new Map(),
            active: false,
          });
        }
        const updatedRoom = rooms.get(game.gameId);
        updatedRoom.active = true;
        io.to(game.gameId).emit('audioStarted', { gameId: game.gameId });
        // console.log(`Audio started for game ${game.gameId} in day phase`);
      } else if (game.currentPhase !== 'day' && room && room.active) {
        updatedRoom.active = false;
        io.to(game.gameId).emit('audioStopped');
        // console.log(`Audio stopped for game ${game.gameId}`);
      }
    } catch (err) {
      console.error('Error in gameUpdated audio handling:', err.message);
    }
  });

  socket.on('joinAudio', async ({ gameId }) => {
    try {
      const game = await Game.findOne({ gameId });
      if (!game || game.currentPhase !== 'day') {
        return socket.emit('error', { message: 'Audio only available during day phase' });
      }
      const player = game.players.find((p) => p.socketId === socket.id);
      if (!player || !player.isAlive) {
        return socket.emit('error', { message: 'Dead players cannot join audio' });
      }

      if (!rooms.has(gameId)) {
        rooms.set(gameId, {
          router,
          transports: new Map(),
          producers: new Map(),
          consumers: new Map(),
          active: true,
        });
        io.to(gameId).emit('audioStarted', { gameId });
      } else {
        const room = rooms.get(gameId);
        if (!room.active) {
          room.active = true;
          io.to(gameId).emit('audioStarted', { gameId });
        }
      }
      socket.join(`audio-${gameId}`);
      socket.emit('rtpCapabilities', router.rtpCapabilities);
    } catch (err) {
      console.error('Error in joinAudio:', err.message);
      socket.emit('error', { message: 'Failed to join audio' });
    }
  });

  socket.on('createTransport', async ({ gameId, direction }, callback) => {
    try {
      const room = rooms.get(gameId);
      if (!room || !room.active) return callback({ error: 'Audio not active' });

      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0' }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });
      room.transports.set(transport.id, transport);
      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
      transport.on('dtlsstatechange', (dtlsState) => {
        if (dtlsState === 'closed') room.transports.delete(transport.id);
      });
    } catch (err) {
      console.error('Error in createTransport:', err.message);
      callback({ error: 'Failed to create transport' });
    }
  });

  socket.on('connectTransport', async ({ gameId, transportId, dtlsParameters }) => {
    try {
      const room = rooms.get(gameId);
      const transport = room.transports.get(transportId);
      if (!transport) throw new Error('Transport not found');
      await transport.connect({ dtlsParameters });
    } catch (err) {
      console.error('Error in connectTransport:', err.message);
      socket.emit('error', { message: 'Failed to connect transport' });
    }
  });

  socket.on('produce', async ({ gameId, transportId, kind, rtpParameters }, callback) => {
    try {
      const room = rooms.get(gameId);
      const transport = room.transports.get(transportId);
      if (!transport) throw new Error('Transport not found');
      const producer = await transport.produce({ kind, rtpParameters });
      room.producers.set(producer.id, producer);
      // console.log(`🔊 Producer created: ${producer.id} for game ${gameId}`);
      producer.on('transportclose', () => room.producers.delete(producer.id));
      io.to(`audio-${gameId}`).emit('newProducer', { producerId: producer.id });
      callback({ id: producer.id });
    } catch (err) {
      console.error('Error in produce:', err.message);
      callback({ error: 'Failed to produce audio' });
    }
  });

  socket.on('consume', async ({ gameId, transportId, producerId, rtpCapabilities }, callback) => {
    try {
      const room = rooms.get(gameId);
      const transport = room.transports.get(transportId);
      if (!transport) throw new Error('Transport not found');
      if (router.canConsume({ producerId, rtpCapabilities })) {
        const consumer = await transport.consume({ producerId, rtpCapabilities });
        room.consumers.set(consumer.id, consumer);
        consumer.on('transportclose', () => room.consumers.delete(consumer.id));
        // console.log(`🎧 Consumer created: ${consumer.id} consuming ${producerId} for game ${gameId}`);
        callback({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } // PROBLEM: No else clause; if canConsume fails, callback isn’t called
    } catch (err) {
      console.error('Error in consume:', err.message);
      callback({ error: 'Failed to consume audio' });
    }
  });

  socket.on('disconnect', async () => {
    // console.log('Client disconnected:', socket.id);
    try {
      const game = await Game.findOne({ 'players.socketId': socket.id });
      if (game) {
        if (game.state === 'waiting') {
          game.players = game.players.filter((p) => p.socketId !== socket.id);
          await game.save();
          io.to(game.gameId).emit('playerLeft', { socketId: socket.id });
        } else if (game.state === 'inProgress') {
          const player = game.players.find((p) => p.socketId === socket.id);
          if (player) {
            player.socketId = null;
            await game.save();
          }
        }
        io.to(game.gameId).emit('gameUpdated', game);

        const room = rooms.get(game.gameId);
        if (room) {
          if (game.state === 'finished') {
            room.transports.forEach((t) => t.close());
            room.producers.forEach((p) => p.close());
            room.consumers.forEach((c) => c.close());
            rooms.delete(game.gameId);
            io.to(game.gameId).emit('audioStopped');
            console.log(`Audio cleaned up for finished game ${game.gameId}`);
          } else if (game.currentPhase !== 'day') {
            room.active = false;
            io.to(game.gameId).emit('audioStopped');
            console.log(`Audio stopped for game ${game.gameId} (not in day phase)`);
          }
        }
      }
    } catch (err) {
      console.error('Error in disconnect:', err.message);
    }
  });
});

app.get("/", (req, res) => {
  res.json({ message: "Hello, your API is working! 🚀" });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));