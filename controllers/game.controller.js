const Game = require("../models/game.model");
const { v4: uuidv4 } = require("uuid");
const { io } = require("../server");

// Create game
exports.createGame = async (req, res) => {
  const { maxPlayers } = req.body;
  try {
    const gameId = uuidv4(); // Consistent with your approach
    const game = new Game({
      gameId,
      maxPlayers: maxPlayers || 10,
      state: 'waiting', // Explicitly set for clarity
      currentPhase: 'waiting',
      players: [], // Explicitly empty
    });

    await game.save();
    const gameData = game.toJSON(); // Serialize to ensure Maps are objects
    // console.log('Game created:', gameData);
    io.emit('gameCreated', gameData); // Broadcast to all clients, not just gameId room
    res.json({ gameId, url: `https://mafia-v01-client.vercel.app/${gameId}` });
  } catch (err) {
    console.error('CreateGame error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
};

// Join game
exports.joinGame = async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ msg: 'Name is required' });

  try {
    const game = await Game.findOne({ gameId: req.params.id });
    if (!game) return res.status(404).json({ msg: 'Game not found' });
    if (game.state !== 'waiting') return res.status(400).json({ msg: 'Game already started wait for new match' });
    if (game.players.some((p) => p.name === name)) return res.status(400).json({ msg: 'Name already taken' });
    if (game.players.length >= game.maxPlayers) return res.status(400).json({ msg: 'Room is full' });

    game.players.push({ name, socketId: req.socket?.id });
    await game.save();
    io.to(game.gameId).emit('playerJoined', { name });
    io.to(game.gameId).emit('gameUpdated', game);
    res.json(game);
  } catch (err) {
    console.error('JoinGame error:', err.message);
    res.status(500).send('Server error');
  }
};

// Fetch game data
exports.fetchGameData = async (req, res) => {
  try {
    const game = await Game.findOne({ gameId: req.params.id });
    if (!game) return res.status(404).json({ msg: 'Game not found' });
    res.json(game);
  } catch (err) {
    console.error('FetchGameData error:', err.message);
    res.status(500).send('Server error');
  }
};

// Set ready status
exports.setReady = async (req, res) => {
  const { name } = req.body;
  try {
    const game = await Game.findOne({ gameId: req.params.id });
    if (!game) return res.status(404).json({ msg: 'Game not found' });
    if (game.state !== 'waiting') return res.status(400).json({ msg: 'Game already started' });

    const player = game.players.find((p) => p.name === name);
    if (!player) return res.status(400).json({ msg: 'Player not found' });

    player.isReady = true;
    await game.save();

    io.to(game.gameId).emit('playerReady', { name });
    io.to(game.gameId).emit('gameUpdated', game);

    const allReady = game.players.every((p) => p.isReady);
    if (game.players.length >= 5 && allReady) {
      io.to(game.gameId).emit('startCountdown', { countdown: 10 });
      setTimeout(async () => {
        const updatedGame = await Game.findOne({ gameId: game.gameId });
        if (updatedGame.players.length >= 5 && updatedGame.players.every((p) => p.isReady)) {
          await startGame(updatedGame);
        }
      }, 10000); // 10-second countdown
    }
    res.json(game);
  } catch (err) {
    console.error('SetReady error:', err.message);
    res.status(500).send('Server error');
  }
};

// Set unready status
exports.setUnready = async (req, res) => {
  const { name } = req.body;
  try {
    const game = await Game.findOne({ gameId: req.params.id });
    if (!game) return res.status(404).json({ msg: 'Game not found' });
    if (game.state !== 'waiting') return res.status(400).json({ msg: 'Game already started' });

    const player = game.players.find((p) => p.name === name);
    if (!player) return res.status(400).json({ msg: 'Player not found' });

    player.isReady = false;
    await game.save();

    io.to(game.gameId).emit('playerUnready', { name });
    io.to(game.gameId).emit('gameUpdated', game);
    res.json(game);
  } catch (err) {
    console.error('SetUnready error:', err.message);
    res.status(500).send('Server error');
  }
};

// Mafia vote
exports.mafiaVote = async (req, res) => {
  const { voterName, targetName } = req.body;
  try {
    const game = await Game.findOne({ gameId: req.params.id });
    if (!game || game.state !== 'inProgress' || game.currentPhase !== 'nightMafia') {
      return res.status(400).json({ msg: 'Mafia can only vote during mafia phase' });
    }

    const voter = game.players.find((p) => (p.role === 'Mafia' || p.role === 'Godfather') && p.name === voterName && p.isAlive);
    if (!voter) return res.status(400).json({ msg: 'Invalid voter' });
    if (game.mafiaVotes.has(voterName)) return res.status(400).json({ msg: 'You have already voted' });
    const target = game.players.find((p) => p.name === targetName && p.isAlive);
    if (!target) return res.status(400).json({ msg: 'Invalid target' });

    game.mafiaVotes.set(voterName, targetName);
    await game.save();

    // Notify all mafia members of the vote
    const mafiaSocketIds = game.players.filter((p) => (p.role === 'Mafia' || p.role === 'Godfather') && p.isAlive).map((p) => p.socketId);
    mafiaSocketIds.forEach((socketId) => {
      io.to(socketId).emit('mafiaVoteCast', { voter: voterName, target: targetName });
    });

    // Check if all living mafia have voted
    const livingMafiaCount = game.players.filter((p) => (p.role === 'Mafia' || p.role === 'Godfather') && p.isAlive).length;
    if (game.mafiaVotes.size === livingMafiaCount) {
      // Determine mafia target (majority or last vote in tie)
      const voteCount = {};
      game.players.forEach((p) => (voteCount[p.name] = 0));
      game.mafiaVotes.forEach((target) => voteCount[target]++);
      const maxVotes = Math.max(...Object.values(voteCount));
      const candidates = Object.entries(voteCount).filter(([name, count]) => count === maxVotes).map(([name]) => name);
      let mafiaTarget = null;
      if (candidates.length === 1) {
        mafiaTarget = candidates[0];
      } else if (candidates.length > 1) {
        // Tie: select the last voted player among candidates
        const voteOrder = Array.from(game.mafiaVotes.values());
        for (let i = voteOrder.length - 1; i >= 0; i--) {
          if (candidates.includes(voteOrder[i])) {
            mafiaTarget = voteOrder[i];
            break;
          }
        }
      }
      game.mafiaTarget = mafiaTarget;
      await setPhase(game, 'nightDetective');
    }

    res.json(game);
  } catch (err) {
    console.error('MafiaVote error:', err.message);
    res.status(500).send('Server error');
  }
};

// Detective investigate
exports.investigate = async (req, res) => {
  const { investigatorName, targetName } = req.body;
  try {
    const game = await Game.findOne({ gameId: req.params.id });
    if (!game || game.state !== 'inProgress' || game.currentPhase !== 'nightDetective') {
      return res.status(400).json({ msg: 'Detective can only investigate during detective phase' });
    }

    const investigator = game.players.find((p) => p.name === investigatorName && p.role === 'Detective' && p.isAlive);
    if (!investigator) return res.status(400).json({ msg: 'Invalid investigator' });
    if (game.detectiveResult) return res.status(400).json({ msg: 'You have already investigated' });
    const target = game.players.find((p) => p.name === targetName && p.isAlive);
    if (!target) return res.status(400).json({ msg: 'Invalid target' });

    // Godfather appears as non-Mafia
    const result = target.role === 'Godfather' ? '-ve' : target.role === 'Mafia' ? '+ve' : '-ve';
    game.detectiveResult = result;
    await game.save();

    // Send result only to the detective
    const detectiveSocketId = investigator.socketId;
    io.to(detectiveSocketId).emit('investigationResult', { target: targetName, result });
    await setPhase(game, 'nightDoctor');

    res.json(game);
  } catch (err) {
    console.error('Investigate error:', err.message);
    res.status(500).send('Server error');
  }
};

// Doctor save
exports.doctorSave = async (req, res) => {
  const { doctorName, targetName } = req.body;
  try {
    const game = await Game.findOne({ gameId: req.params.id });
    if (!game || game.state !== 'inProgress' || game.currentPhase !== 'nightDoctor') {
      return res.status(400).json({ msg: 'Doctor can only save during doctor phase' });
    }

    const doctor = game.players.find((p) => p.name === doctorName && p.role === 'Doctor' && p.isAlive);
    if (!doctor) return res.status(400).json({ msg: 'Invalid doctor' });
    const target = game.players.find((p) => p.name === targetName && p.isAlive);
    if (!target) return res.status(400).json({ msg: 'Invalid target' });

    game.doctorSave = targetName; // Allow self-save (no restriction on doctorName === targetName)
    await game.save();
    await resolveNight(game); // Move to day phase

    res.json(game.toJSON());
  } catch (err) {
    console.error('DoctorSave error:', err.message);
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
};

// Day vote
exports.dayVote = async (req, res) => {
  const { voterName, targetName } = req.body;
  try {
    const game = await Game.findOne({ gameId: req.params.id });
    if (!game || game.state !== 'inProgress' || game.currentPhase !== 'day') {
      return res.status(400).json({ msg: 'Voting only allowed during day phase' });
    }

    const voter = game.players.find((p) => p.name === voterName && p.isAlive);
    if (!voter) return res.status(400).json({ msg: 'Invalid voter' });
    if (game.votes.has(voterName)) return res.status(400).json({ msg: 'You have already voted' });
    const target = game.players.find((p) => p.name === targetName && p.isAlive);
    if (!target) return res.status(400).json({ msg: 'Invalid target' });

    game.votes.set(voterName, targetName);
    await game.save();
    io.to(game.gameId).emit('gameUpdated', game.toJSON()); // Real-time vote visibility

    // Check if all living players have voted
    const livingPlayers = game.players.filter((p) => p.isAlive).length;
    if (game.votes.size === livingPlayers) {
      const voteCount = {};
      game.players.forEach((p) => (voteCount[p.name] = 0));
      game.votes.forEach((target) => voteCount[target]++);

      const majority = Math.ceil(livingPlayers / 2);
      const maxVotes = Math.max(...Object.values(voteCount));
      let eliminated = null;

      if (maxVotes >= majority) {
        const candidates = Object.entries(voteCount)
          .filter(([_, count]) => count === maxVotes)
          .map(([name]) => name);
        eliminated = candidates.length === 1 ? candidates[0] : candidates[0]; // First in tie
      }

      if (eliminated) {
        const eliminatedPlayer = game.players.find((p) => p.name === eliminated);
        eliminatedPlayer.isAlive = false;
        game.lastKilled = eliminated; // Set for phase transition
        io.to(game.gameId).emit('playerEliminated', { name: eliminated, killedBy: 'vote' });
        io.to(game.gameId).emit('dayVoteResult', { eliminated });
      }

      game.votes.clear();
      await game.save();

      await checkWinConditions(game); // Check win conditions after voting
      if (game.state !== 'finished') {
        await setPhase(game, 'nightMafia'); // Transition to nightMafia for "City goes to sleep"
      }
    }

    res.json(game.toJSON());
  } catch (err) {
    console.error('DayVote error:', err.message);
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
};


// Helper Functions

async function startGame(game) {
  game.state = 'inProgress';
  game.currentPhase = 'nightMafia';

  // Define role counts
  const totalPlayers = game.players.length;
  const mafiaCount = Math.floor(totalPlayers / 3);
  const godfatherCount = mafiaCount > 1 ? 1 : 0;
  const regularMafiaCount = mafiaCount - godfatherCount;
  const specialRolesCount = regularMafiaCount + godfatherCount + 2; // Mafia + Godfather + Detective + Doctor

  // Create role array
  const roles = [
    ...Array(regularMafiaCount).fill('Mafia'),
    ...Array(godfatherCount).fill('Godfather'),
    'Detective',
    'Doctor',
    ...Array(totalPlayers - specialRolesCount).fill('Villager'),
  ];

  // Fisher-Yates shuffle for roles (not players)
  const shuffleArray = (array) => {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  };

  const shuffledRoles = shuffleArray(roles);

  // Assign roles to players in original join order
  game.players.forEach((player, index) => {
    player.role = shuffledRoles[index];
  });

  await game.save();

  // Emit roles privately
  game.players.forEach((player) => {
    io.to(player.socketId).emit('privateRole', { role: player.role });
  });

  // Emit mafia gang to mafia members
  const mafiaGang = game.players
    .filter((p) => p.role === 'Mafia' || p.role === 'Godfather')
    .map((p) => p.name);
  game.players.forEach((player) => {
    if (player.role === 'Mafia' || player.role === 'Godfather') {
      io.to(player.socketId).emit('mafiaGang', mafiaGang);
    }
  });

  io.to(game.gameId).emit('gameStarted', game.toJSON());
  io.to(game.gameId).emit('gameUpdated', game.toJSON());
}

async function setPhase(game, phase) {
  game.currentPhase = phase;

  if (phase === 'nightDetective' && !game.players.some((p) => p.role === 'Detective' && p.isAlive)) {
    return setPhase(game, 'nightDoctor');
  } else if (phase === 'nightDoctor' && !game.players.some((p) => p.role === 'Doctor' && p.isAlive)) {
    return resolveNight(game);
  } else if (phase === 'day') {
    const phaseData = {
      phase,
      lastKilled: game.lastKilled, // Send lastKilled to frontend
    };
    io.to(game.gameId).emit('phaseChanged', phaseData);
    game.lastKilled = null; // Clear after emitting
    await game.save();
    io.to(game.gameId).emit('gameUpdated', game.toJSON());
    io.to(game.gameId).emit('audioStarted');
  } else if (phase === 'nightMafia') {
    io.to(game.gameId).emit('phaseChanged', { phase }); // "City goes to sleep" trigger
    await game.save();
    io.to(game.gameId).emit('gameUpdated', game.toJSON());
  } else {
    // Other phases (e.g., nightDetective)
    await game.save();
    io.to(game.gameId).emit('gameUpdated', game.toJSON());
    io.to(game.gameId).emit('phaseChanged', { phase });
  }
}

// Assuming this is an internal function called after doctor's save
async function resolveNight(game) {
  if (game.mafiaTarget && game.mafiaTarget !== game.doctorSave) {
    const targetPlayer = game.players.find((p) => p.name === game.mafiaTarget);
    if (targetPlayer) {
      targetPlayer.isAlive = false;
      game.lastKilled = targetPlayer.name; // Set lastKilled
      io.to(game.gameId).emit('playerEliminated', { name: targetPlayer.name, killedBy: 'mafia' });
      io.to(game.gameId).emit('nightResult', { msg: `Night ends with the death of ${targetPlayer.name}` });
    }
  } else {
    io.to(game.gameId).emit('nightResult', { msg: 'Night ends with no deaths' });
  }

  game.mafiaTarget = null;
  game.mafiaVotes.clear();
  game.doctorSave = null;
  game.detectiveResult = null;

  await game.save();
  await setPhase(game, 'day');
}

async function checkWinConditions(game) {
  const alivePlayers = game.players.filter((p) => p.isAlive);
  const aliveMafia = alivePlayers.filter((p) => p.role === 'Mafia' || p.role === 'Godfather').length;
  const aliveVillagers = alivePlayers.filter((p) => p.role === 'Villager' || p.role === 'Detective' || p.role === 'Doctor').length;
  const mafiaGang = game.players
    .filter((p) => p.role === 'Mafia' || p.role === 'Godfather')
    .map((p) => p.name); // Get mafia gang names

    if (aliveMafia === 0) {
      game.state = 'finished';
      game.currentPhase = 'finished';
      await game.save();
      io.to(game.gameId).emit('gameOver', { winner: 'Villagers', mafiaGang });
    } else if (aliveMafia >= aliveVillagers) {
      game.state = 'finished';
      game.currentPhase = 'finished';
      await game.save();
      io.to(game.gameId).emit('gameOver', { winner: 'Mafia', mafiaGang });
    }
}
