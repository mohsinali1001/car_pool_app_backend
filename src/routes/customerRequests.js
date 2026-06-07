const router = require('express').Router();
const { verifyToken, requireCaptain } = require('../middleware/auth');
const { offerLimiter } = require('../middleware/ratelimiter');
const {
  createCustomerRequest,
  getOpenCustomerRequests,
  getMyCustomerRequests,
  deleteCustomerRequest,
  acceptCustomerFare,
  createOffer,
  respondOffer,
  updateOffer,
} = require('../controllers/customerRequestController');

router.post('/', verifyToken, createCustomerRequest);
router.get('/my', verifyToken, getMyCustomerRequests);
router.get('/nearby', verifyToken, requireCaptain, getOpenCustomerRequests);
router.get('/', verifyToken, requireCaptain, getOpenCustomerRequests);
router.delete('/:requestId', verifyToken, deleteCustomerRequest);
router.post('/:requestId/accept-fare', verifyToken, requireCaptain, acceptCustomerFare);
router.post('/:requestId/offers', verifyToken, requireCaptain, offerLimiter, createOffer);
router.patch('/:requestId/offers/:offerId', verifyToken, (req, res) => {
  if (req.body && req.body.action) {
    return respondOffer(req, res);
  }
  return requireCaptain(req, res, () => updateOffer(req, res));
});
router.patch('/:requestId/offers/:offerId/respond', verifyToken, respondOffer);

module.exports = router;
