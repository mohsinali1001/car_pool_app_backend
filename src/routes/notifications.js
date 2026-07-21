const router = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const {
  sendNotification,
  getMyNotifications,
  getNotificationSummary,
  markNotificationsRead,
} = require('../controllers/notificationController');

router.get('/summary', verifyToken, getNotificationSummary);
router.get('/', verifyToken, getMyNotifications);
router.patch('/read-all', verifyToken, markNotificationsRead);
router.post('/send', verifyToken, sendNotification);

module.exports = router;
