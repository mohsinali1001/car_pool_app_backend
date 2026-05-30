require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

// Import Limiters from local folder
const { 
  globalLimiter, 
  authLimiter, 
  dealLimiter,
  rideLimiter,
  walletLimiter 
} = require('./middleware/ratelimiter');

// Import Routes
const authRoutes = require('./routes/auth');
const rideRoutes = require('./routes/rides');
const dealRoutes = require('./routes/deals');
const walletRoutes = require('./routes/wallet');
const notificationRoutes = require('./routes/notifications');
const customerRequestRoutes = require('./routes/customerRequests');

const app = express();

const serviceInfo = {
  success: true,
  service: 'CarPool Backend',
  status: 'running',
  apiBase: '/api',
  health: '/health',
  endpoints: {
    auth: ['/api/auth/sync', '/api/auth/profile', '/api/auth/profile/captain'],
    rides: ['/api/rides', '/api/rides/active', '/api/rides/my-rides'],
    deals: ['/api/deals', '/api/deals/my-bookings'],
    customerRequests: ['/api/customer-requests', '/api/customer-requests/my'],
    wallet: ['/api/wallet'],
    notifications: ['/api/notifications'],
  },
};

function rootStatus(req, res) {
  if (req.accepts('html')) {
    return res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CarPool Backend</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 0; padding: 32px; background: #f6f8f5; color: #263225; }
      main { max-width: 760px; margin: 0 auto; background: #fff; border: 1px solid #dfe7dc; border-radius: 14px; padding: 24px; }
      h1 { margin: 0 0 8px; }
      code { background: #eef4ec; padding: 3px 6px; border-radius: 6px; }
      li { margin: 6px 0; }
    </style>
  </head>
  <body>
    <main>
      <h1>CarPool Backend is running</h1>
      <p>Status: <strong>OK</strong></p>
      <p>Health: <a href="/health"><code>/health</code></a></p>
      <p>API base: <code>/api</code></p>
      <ul>
        <li><code>/api/auth/sync</code> - Google/Firebase user sync and role profile</li>
        <li><code>/api/rides</code> - active captain rides</li>
        <li><code>/api/customer-requests</code> - customer posted ride requests</li>
        <li><code>/api/deals</code> - booking and deal flow</li>
      </ul>
    </main>
  </body>
</html>`);
  }
  return res.json(serviceInfo);
}

// Trust proxy (MUST be after app initialization)
app.set('trust proxy', 1);

// Security Middlewares
app.use(helmet());
app.use(globalLimiter); // Global Security
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' })); // Anti-DOS payload limit

app.get('/', rootStatus);
app.get('/api', (req, res) => res.json(serviceInfo));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// API Routes with specific security
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/rides', rideLimiter, rideRoutes);
app.use('/api/deals', dealLimiter, dealRoutes);
app.use('/api/customer-requests', dealLimiter, customerRequestRoutes);
app.use('/api/wallet', walletLimiter, walletRoutes);
app.use('/api/notifications', notificationRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Backward-compatible root routes for older mobile builds.
app.use('/auth', authLimiter, authRoutes);
app.use('/rides', rideLimiter, rideRoutes);
app.use('/deals', dealLimiter, dealRoutes);
app.use('/customer-requests', dealLimiter, customerRequestRoutes);
app.use('/wallet', walletLimiter, walletRoutes);
app.use('/notifications', notificationRoutes);
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 404 Handler
app.use((req, res) => res.status(404).json({ success: false, error: 'Route not found', code: 'ROUTE_NOT_FOUND' }));

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' });
});

module.exports = app;
