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
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute minimum between cleanups

/**
 * Throttled wrapper for cleanupExpiredRides
 * Ensures cleanup doesn't run more than once per minute
 */
async function maybeCleanupExpiredRides() {
  const now = Date.now();
  if (now - lastRideCleanup < CLEANUP_INTERVAL_MS) return;
  lastRideCleanup = now;
  try {
    await cleanupExpiredRides();
  } catch (err) {
    console.error('[throttledCleanup] Error in maybeCleanupExpiredRides:', err);
  }
}

/**
 * Throttled wrapper for cleanupExpiredCustomerRequests
 * Ensures cleanup doesn't run more than once per minute
 */
async function maybeCleanupExpiredCustomerRequests() {
  const now = Date.now();
  if (now - lastRequestCleanup < CLEANUP_INTERVAL_MS) return;
  lastRequestCleanup = now;
  try {
    await cleanupExpiredCustomerRequests();
  } catch (err) {
    console.error('[throttledCleanup] Error in maybeCleanupExpiredCustomerRequests:', err);
  }
}

/**
 * Throttled wrapper for autoArchiveConfirmedDeals
 * Ensures cleanup doesn't run more than once per minute
 */
async function maybeAutoArchiveConfirmedDeals() {
  const now = Date.now();
  if (now - lastArchiveCleanup < CLEANUP_INTERVAL_MS) return;
  lastArchiveCleanup = now;
  try {
    await autoArchiveConfirmedDeals();
  } catch (err) {
    console.error('[throttledCleanup] Error in maybeAutoArchiveConfirmedDeals:', err);
  }
}

/**
 * Throttled wrapper for cleanupOldCompletedDeals
 * Ensures cleanup doesn't run more than once per minute
 */
async function maybeCleanupOldCompletedDeals() {
  const now = Date.now();
  if (now - lastDeleteCleanup < CLEANUP_INTERVAL_MS) return;
  lastDeleteCleanup = now;
  try {
    await cleanupOldCompletedDeals();
  } catch (err) {
    console.error('[throttledCleanup] Error in maybeCleanupOldCompletedDeals:', err);
  }
}

/**
 * Run ALL cleanups with throttling (for cron jobs)
 * This bypasses individual throttling and runs everything at once
 */
async function runAllCleanup() {
  console.log('[throttledCleanup] Running all cleanups...');
  try {
    await Promise.all([
      cleanupExpiredRides(),
      cleanupExpiredCustomerRequests(),
      autoArchiveConfirmedDeals(),
      cleanupOldCompletedDeals()
    ]);
    console.log('[throttledCleanup] All cleanups completed successfully.');
  } catch (err) {
    console.error('[throttledCleanup] Error in runAllCleanup:', err);
  }
}

module.exports = { 
  // Throttled wrappers (for controllers)
  maybeCleanupExpiredRides, 
  maybeCleanupExpiredCustomerRequests,
  maybeAutoArchiveConfirmedDeals,
  maybeCleanupOldCompletedDeals,
  
  // Direct access (for cron jobs)
  runAllCleanup,
  
  // Direct access to underlying functions (if needed)
  cleanupExpiredRides,
  cleanupExpiredCustomerRequests,
  autoArchiveConfirmedDeals,
  cleanupOldCompletedDeals
};