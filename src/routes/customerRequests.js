const router = require('express').Router();
const { verifyToken, requireCaptain } = require('../middleware/auth');
const {
  createCustomerRequest,
  getOpenCustomerRequests,
  getMyCustomerRequests,
  createOffer,
  respondOffer,
} = require('../controllers/customerRequestController');

router.post('/', verifyToken, createCustomerRequest);
router.get('/my', verifyToken, getMyCustomerRequests);
router.get('/', verifyToken, requireCaptain, getOpenCustomerRequests);
router.post('/:requestId/offers', verifyToken, requireCaptain, createOffer);
router.patch('/:requestId/offers/:offerId', verifyToken, respondOffer);

module.exports = router;
