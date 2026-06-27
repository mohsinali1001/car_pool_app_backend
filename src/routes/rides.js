const router = require('express').Router();
const { verifyToken, requireCaptain } = require('../middleware/auth');
const {
  postRide,
  getActiveRides,
  getRideById,
  updateRideStatus,
  getMyRides,
  updateRideLocation,
} = require('../controllers/rideController');

router.post('/', verifyToken, requireCaptain, postRide);
router.get('/active', verifyToken, getActiveRides);
router.get('/', verifyToken, getActiveRides);
router.get('/my-rides', verifyToken, requireCaptain, getMyRides);
router.get('/:rideId', verifyToken, getRideById);
router.patch('/:rideId/status', verifyToken, requireCaptain, updateRideStatus);
router.patch('/:rideId/location', verifyToken, requireCaptain, updateRideLocation);

module.exports = router;
