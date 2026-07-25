const router = require('express').Router();
const { verifyToken, requireCaptain } = require('../middleware/auth');
const { getCaptainStats } = require('../controllers/rideController');
const { getCaptainProfile } = require('../controllers/dealController');

router.get('/stats', verifyToken, requireCaptain, getCaptainStats);
router.get('/:captainId/profile', verifyToken, getCaptainProfile);

module.exports = router;
