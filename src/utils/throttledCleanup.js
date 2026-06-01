const { cleanupExpiredRides, cleanupExpiredCustomerRequests } = require('./lifecycleCleanup');

let lastRideCleanup = 0;
let lastRequestCleanup = 0;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

async function maybeCleanupExpiredRides() {
  const now = Date.now();
  if (now - lastRideCleanup < CLEANUP_INTERVAL_MS) return;
  lastRideCleanup = now;
  await cleanupExpiredRides();
}

async function maybeCleanupExpiredCustomerRequests() {
  const now = Date.now();
  if (now - lastRequestCleanup < CLEANUP_INTERVAL_MS) return;
  lastRequestCleanup = now;
  await cleanupExpiredCustomerRequests();
}

module.exports = { maybeCleanupExpiredRides, maybeCleanupExpiredCustomerRequests };
