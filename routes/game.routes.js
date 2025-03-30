const express = require('express');
const router = express.Router();
const gameController = require('../controllers/game.controller');
const rateLimit = require('express-rate-limit');

// Rate limiter for actions
const actionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later.',
});

router.post('/', gameController.createGame);
router.get('/:id', gameController.fetchGameData);
router.post('/:id/join', gameController.joinGame);
router.post('/:id/ready', gameController.setReady);
router.post('/:id/unready', gameController.setUnready);
router.post('/:id/mafiaVote', actionLimiter, gameController.mafiaVote);
router.post('/:id/investigate', actionLimiter, gameController.investigate);
router.post('/:id/save', actionLimiter, gameController.doctorSave);
router.post('/:id/dayVote', actionLimiter, gameController.dayVote);

module.exports = router;