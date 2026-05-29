const rateLimit = require('express-rate-limit');

const isDev = process.env.NODE_ENV !== 'production';
const skipLocalhost = (req) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return isDev && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
};

// Global: relaxed in dev
exports.globalLimiter = rateLimit({
  windowMs: isDev ? 60 * 1000 : 15 * 60 * 1000,
  max: isDev ? 500 : 3000,
  skip: skipLocalhost,
  message: { error: 'Too many requests, try again later' },
});

// Deals: higher limit for reads/writes in dev
exports.dealLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 120 : 120,
  skip: skipLocalhost,
  message: { error: 'Too many booking attempts' },
});

// Rides
exports.rideLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 120 : 120,
  skip: skipLocalhost,
  message: { error: 'Too many ride requests' },
});

// Auth
exports.authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 30 : 10,
  skip: skipLocalhost,
  message: { error: 'Too many auth requests' },
});

// Wallet is polled by the app so balance updates appear immediately.
exports.walletLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 120 : 120,
  skip: skipLocalhost,
  message: { error: 'Too many top-up requests' }
});
