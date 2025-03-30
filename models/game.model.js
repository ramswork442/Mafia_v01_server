const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const PlayerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  role: { type: String, default: 'unassigned' },
  isAlive: { type: Boolean, default: true },
  isReady: { type: Boolean, default: false },
  socketId: { type: String, default: null },
});

const GameSchema = new mongoose.Schema({
  gameId: { type: String, default: uuidv4, unique: true },
  state: { type: String, default: 'waiting', enum: ['waiting', 'inProgress', 'finished'] },
  currentPhase: { 
    type: String, 
    default: 'waiting',
    enum: ['waiting', 'nightMafia', 'nightDetective', 'nightDoctor', 'day', 'finished']
  },
  players: [PlayerSchema],
  maxPlayers: { type: Number, default: 10 },
  votes: { type: Map, of: String, default: () => new Map() },
  mafiaVotes: { type: Map, of: String, default: () => new Map() },
  mafiaTarget: { type: String, default: null },
  detectiveResult: { type: String, default: null },
  doctorSave: { type: String, default: null },
  lastKilled: { type: String, default: null },
});

// Custom toJSON method with safe Map handling
GameSchema.set('toJSON', {
  transform: (doc, ret) => {
    // Safely convert votes to a plain object
    ret.votes = ret.votes instanceof Map ? Object.fromEntries(ret.votes) : ret.votes || {};
    // Safely convert mafiaVotes to a plain object
    ret.mafiaVotes = ret.mafiaVotes instanceof Map ? Object.fromEntries(ret.mafiaVotes) : ret.mafiaVotes || {};
    return ret;
  },
});

module.exports = mongoose.model('Game', GameSchema);