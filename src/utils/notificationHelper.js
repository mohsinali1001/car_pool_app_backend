const { db, messaging } = require('../config/firebase');

const HIGH_PRIORITY_TYPES = new Set([
  'new_deal',
  'deal_confirmed',
  'deal_cancelled',
  'deal_counter',
  'ride_started',
  'ride_completed',
  'deal_message',
  'customer_request',
  'customer_offer',
  'customer_counter',
  'customer_request_accepted',
]);

async function saveInAppNotification(userId, { title, body, type, data }) {
  try {
    await db.collection('notifications').add({
      userId,
      title,
      body,
      type: type || 'general',
      data: data || {},
      read: false,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.log('In-app notification save skipped:', e.message);
  }
}

function stringifyData(data) {
  return Object.fromEntries(
    Object.entries(data || {}).map(([k, v]) => [k, String(v ?? '')]),
  );
}

async function pushToUser(userId, { title, body, type, data }) {
  await saveInAppNotification(userId, { title, body, type, data });
  try {
    const user = await db.collection('users').doc(userId).get();
    if (!user.exists) {
      console.log(`FCM skipped: user ${userId} not found`);
      return;
    }
    const token = user.data().fcmToken;
    if (!token) {
      console.log(`FCM skipped: no token for user ${userId}`);
      return;
    }
    if (!messaging) {
      console.log('FCM skipped: messaging not configured');
      return;
    }

    const msgType = type || 'general';
    const fcmData = stringifyData({ type: msgType, ...(data || {}) });

    const message = {
      token,
      notification: { title, body },
      data: fcmData,
    };

    if (HIGH_PRIORITY_TYPES.has(msgType)) {
      message.android = { priority: 'high' };
      message.apns = { headers: { 'apns-priority': '10' } };
    }

    await messaging.send(message);
  } catch (e) {
    console.error(`FCM push failed for user ${userId}:`, e.message);
    const code = e.code || e.errorInfo?.code || '';
    if (
      code.includes('registration-token-not-registered') ||
      e.message.includes('Requested entity was not found')
    ) {
      try {
        await db.collection('users').doc(userId).set({ fcmToken: null }, { merge: true });
      } catch (_) {}
    }
  }
}

module.exports = { saveInAppNotification, pushToUser };
