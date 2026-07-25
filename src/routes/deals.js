const router = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const {
  createDeal,
  confirmDeal,
  cancelDeal,
  counterDeal,
  startDeal,
  completeDeal,
  getDeal,
  rateDeal,
  getMyBookings,
  getMyDeals, // ✅ NEW - Captain's all deals
  getRideDeals,
  getConfirmedPassengers,
  updateBoardingStatus,
  notifyDealMessage,
} = require('../controllers/dealController');

router.post('/', verifyToken, createDeal);
router.get('/my-bookings', verifyToken, getMyBookings);
router.get('/my-deals', verifyToken, getMyDeals); // ✅ NEW ROUTE
router.get('/ride/:rideId/confirmed', verifyToken, getConfirmedPassengers);
router.get('/ride/:rideId', verifyToken, getRideDeals);
router.get('/:dealId', verifyToken, getDeal);
router.patch('/:dealId/confirm', verifyToken, confirmDeal);
router.patch('/:dealId/cancel', verifyToken, cancelDeal);
router.patch('/:dealId/counter', verifyToken, counterDeal);
router.patch('/:dealId/start', verifyToken, startDeal);
router.patch('/:dealId/boarding', verifyToken, updateBoardingStatus);
router.patch('/:dealId/complete', verifyToken, completeDeal);
router.patch('/:dealId/rate', verifyToken, rateDeal);
router.post('/:dealId/notify-message', verifyToken, notifyDealMessage);

module.exports = router;