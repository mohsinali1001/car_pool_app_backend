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

<<<<<<< HEAD
// NOTE: requireCaptain is only kept on POST / (creating a brand new ride
// listing), because that genuinely requires the account's *current* role to
// be captain (verified, with vehicle details, etc).
//
// getMyRides / updateRide / updateRideStatus / updateRideLocation / deleteRide
// all already do their own ownership check inside the controller
// (rideData.captainId === uid). They used to ALSO require requireCaptain,
// which meant that once a captain switched their account role to
// "passenger" (see PATCH /auth/profile), they permanently lost the ability
// to see, manage, or accept requests on rides they had posted earlier while
// still a captain — even though those rides still belonged to them. Removing
// requireCaptain here (while keeping the ownership check inside each
// controller) fixes that without opening up access to anyone else's rides.
router.post('/', verifyToken, requireCaptain, postRide);
router.get('/active', verifyToken, getActiveRides);
router.get('/', verifyToken, getActiveRides);
router.get('/my-rides', verifyToken, getMyRides);
router.get('/:rideId', verifyToken, getRideById);
router.patch('/:rideId', verifyToken, updateRide);
router.patch('/:rideId/status', verifyToken, updateRideStatus);
router.patch('/:rideId/location', verifyToken, updateRideLocation);
router.delete('/:rideId', verifyToken, deleteRide);
=======
router.post('/', verifyToken, requireCaptain, postRide);
router.get('/active', verifyToken, getActiveRides);
router.get('/', verifyToken, getActiveRides);
router.get('/my-rides', verifyToken, requireCaptain, getMyRides);
router.get('/:rideId', verifyToken, getRideById);
router.patch('/:rideId', verifyToken, requireCaptain, updateRide);
router.patch('/:rideId/status', verifyToken, requireCaptain, updateRideStatus);
router.patch('/:rideId/location', verifyToken, requireCaptain, updateRideLocation);
router.delete('/:rideId', verifyToken, requireCaptain, deleteRide);
>>>>>>> bfa8cac1341b9747bc346d5e6a617496b8f28346

module.exports = router;
