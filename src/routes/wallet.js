const router = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const {
  getWallet,
  getTransactions,
  topUpWallet,
  getEarningsSummary,
} = require('../controllers/walletController');

router.get('/', verifyToken, getWallet);
router.get('/transactions', verifyToken, getTransactions);
router.get('/earnings-summary', verifyToken, getEarningsSummary);
router.post('/topup', verifyToken, topUpWallet);

module.exports = router;
