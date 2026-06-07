const { auth } = require('../config/firebase');

const verifyToken = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided', code: 'NO_TOKEN' });
  }

  const token = header.split('Bearer ')[1];
  try {
    const decoded = await auth.verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    console.warn('AuthMiddleware: token rejected');
    return res.status(401).json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
  }
};

const requireCaptain = async (req, res, next) => {
  try {
    const { db } = require('../config/firebase');
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'captain') {
      return res.status(403).json({ error: 'Captains only' });
    }
    req.userDoc = userDoc.data();
    next();
  } catch (err) {
    console.error('requireCaptain error:', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
};

module.exports = { verifyToken, requireCaptain };
