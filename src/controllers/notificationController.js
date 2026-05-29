const { db } = require('../config/firebase');
const { pushToUser } = require('../utils/notificationHelper');

const sendNotification = async (req, res) => {
  const { userId, title, body, data } = req.body;
  if (!userId || !title || !body) {
    return res.status(400).json({ success: false, error: 'userId, title, body required', code: 'MISSING_FIELDS' });
  }
  try {
    await pushToUser(userId, { title, body, type: data?.type || 'general', data });
    return res.json({ success: true, message: 'Notification sent' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'NOTIFICATION_ERROR' });
  }
};

const getMyNotifications = async (req, res) => {
  try {
    const snap = await db
      .collection('notifications')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    const notifications = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, notifications });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_NOTIFICATIONS_ERROR' });
  }
};

const getNotificationSummary = async (req, res) => {
  try {
    const snap = await db
      .collection('notifications')
      .where('userId', '==', req.user.uid)
      .where('read', '==', false)
      .limit(100)
      .get();
    const byType = {};
    const byScreen = {};
    snap.docs.forEach((doc) => {
      const n = doc.data() || {};
      const type = (n.type || 'general').toString();
      const screen = (n.data?.screen || '').toString();
      byType[type] = (byType[type] || 0) + 1;
      if (screen) byScreen[screen] = (byScreen[screen] || 0) + 1;
    });
    return res.json({
      success: true,
      unreadCount: snap.size,
      byType,
      byScreen,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'NOTIFICATION_SUMMARY_ERROR' });
  }
};

const markNotificationsRead = async (req, res) => {
  try {
    const snap = await db
      .collection('notifications')
      .where('userId', '==', req.user.uid)
      .where('read', '==', false)
      .get();
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.update(doc.ref, { read: true }));
    await batch.commit();
    return res.json({ success: true, message: 'Notifications marked read' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'MARK_READ_ERROR' });
  }
};

module.exports = { sendNotification, getMyNotifications, getNotificationSummary, markNotificationsRead };
