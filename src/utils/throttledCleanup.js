const { 
  cleanupExpiredRides, 
  cleanupExpiredCustomerRequests,
  autoArchiveConfirmedDeals,
  cleanupOldCompletedDeals
} = require('./lifecycleCleanup');

let lastRideCleanup = 0;
let lastRequestCleanup = 0;
let lastArchiveCleanup = 0;
let lastDeleteCleanup = 0;
const CLEANUP_INTERVAL_MS = 60 * 1000;

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

async function maybeAutoArchiveConfirmedDeals() {
  const now = Date.now();
  if (now - lastArchiveCleanup < CLEANUP_INTERVAL_MS) return;
  lastArchiveCleanup = now;
  await autoArchiveConfirmedDeals();
}

async function maybeCleanupOldCompletedDeals() {
  const now = Date.now();
  if (now - lastDeleteCleanup < CLEANUP_INTERVAL_MS) return;
  lastDeleteCleanup = now;
  await cleanupOldCompletedDeals();
}

module.exports = { 
  maybeCleanupExpiredRides, 
  maybeCleanupExpiredCustomerRequests,
  maybeAutoArchiveConfirmedDeals,
  maybeCleanupOldCompletedDeals
};
