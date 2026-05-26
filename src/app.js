app.set('trust proxy', 1);
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

const app = express();

// Security Middlewares
app.use(helmet());
app.use(globalLimiter); // Global Security
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' })); // Anti-DOS payload limit

// API Routes with specific security
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/rides', rideLimiter, rideRoutes);
app.use('/api/deals', dealLimiter, dealRoutes);
app.use('/api/wallet', walletLimiter, walletRoutes);
app.use('/api/notifications', notificationRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// 404 Handler
app.use((req, res) => res.status(404).json({ success: false, error: 'Route not found', code: 'ROUTE_NOT_FOUND' }));

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' });
});

module.exports = app;