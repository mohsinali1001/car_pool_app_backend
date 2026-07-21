const router = require('express').Router();
const { verifyToken, requireCaptain } = require('../middleware/auth');
const {
  postRide,
  getActiveRides,
  getRideById,
  updateRideStatus,
  getMyRides,
  updateRideLocation,
  updateRide,
  deleteRide,
} = require('../controllers/rideController');

// ✅ HEAD version – without requireCaptain on GET/my-rides and other routes
// The controller itself handles ownership checks, so passenger-mode users
// can view their own posted rides (posted when they were captain).
router.post('/', verifyToken, requireCaptain, postRide);
router.get('/active', verifyToken, getActiveRides);
router.get('/', verifyToken, getActiveRides);
router.get('/my-rides', verifyToken, getMyRides);
router.get('/:rideId', verifyToken, getRideById);
router.patch('/:rideId', verifyToken, updateRide);
router.patch('/:rideId/status', verifyToken, updateRideStatus);
router.patch('/:rideId/location', verifyToken, updateRideLocation);
router.delete('/:rideId', verifyToken, deleteRide);

module.exports = router;
