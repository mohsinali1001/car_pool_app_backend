const { auth } = require('../config/firebase');

const verifyToken = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    console.warn('AuthMiddleware: No Bearer token in headers');
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = header.split('Bearer ')[1];
  try {
    console.log(`AuthMiddleware: Verifying token (length: ${token.length})...`);
    const decoded = await auth.verifyIdToken(token);
    console.log(`AuthMiddleware: Token verified for UID: ${decoded.uid}`);
    req.user = decoded;
    next();
  } catch (err) {
    console.error('AuthMiddleware: Token verification FAILED:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token', detail: err.message });
  }
};

const requireCaptain = async (req, res, next) => {
  const { db } = require('../config/firebase');
  const userDoc = await db.collection('users').doc(req.user.uid).get();
  if (!userDoc.exists || userDoc.data().role !== 'captain') {
    return res.status(403).json({ error: 'Captains only' });
  }
  req.userDoc = userDoc.data();
  next();
};

module.exports = { verifyToken, requireCaptain };
