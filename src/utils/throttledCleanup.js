const { db } = require('../config/firebase');
const { RIDE_STATUS, DEAL_STATUS } = require('../constants/statuses');

/**
 * ⚠️ IMPORTANT: These functions should ONLY be called from a scheduled cron job,
 * NOT from individual API request handlers.
 * 
 * Run every 5-10 minutes using:
 * - Firebase Cloud Scheduler
 * - Linux cron job
 * - node-cron package in a separate process
 * 
 * ✅ All functions are idempotent and safe to run multiple times.
 */

// ---------- THROTTLE GUARDS ----------
let lastRideCleanup = 0;
let lastRequestCleanup = 0;
let lastArchiveCleanup = 0;
let lastDeleteCleanup = 0;
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute minimum between runs
let isRunning = false;

// ---------- ACTUAL CLEANUP LOGIC ----------

/**
 * Cleanup expired rides (older than 24 hours and not completed)
 * Soft-delete: mark as EXPIRED
 */
async function cleanupExpiredRides() {
  try {
    console.log('🧹 [1/4] Cleaning expired rides...');
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const snap = await db.collection('rides')
      .where('status', 'in', [RIDE_STATUS.ACTIVE, RIDE_STATUS.FILLED])
      .where('departureTime', '<', cutoff)
      .limit(500) // Batch limit to prevent timeout
      .get();

    let count = 0;
    const batch = db.batch();
    
    for (const doc of snap.docs) {
      batch.update(doc.ref, {
        status: RIDE_STATUS.EXPIRED || 'expired',
        expiredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      count++;
      
      // Commit in batches of 500
      if (count % 500 === 0) {
        await batch.commit();
        console.log(`   ✅ Committed ${count} expired rides so far...`);
      }
    }
    
    if (count % 500 !== 0) {
      await batch.commit();
    }
    
    console.log(`✅ [1/4] Completed: ${count} expired rides cleaned`);
    return count;
  } catch (err) {
    console.error('❌ [1/4] Cleanup error (expired rides):', err);
    return 0;
  }
}

/**
 * Cleanup expired customer requests (pending deals older than 30 minutes)
 */
async function cleanupExpiredCustomerRequests() {
  try {
    console.log('🧹 [2/4] Cleaning expired customer requests...');
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min
    
    const snap = await db.collection('deals')
      .where('status', '==', DEAL_STATUS.PENDING)
      .where('createdAt', '<', cutoff)
      .limit(500)
      .get();

    let count = 0;
    const batch = db.batch();
    
    for (const doc of snap.docs) {
      batch.update(doc.ref, {
        status: DEAL_STATUS.CANCELLED,
        cancelledAt: new Date().toISOString(),
        cancelledReason: 'Auto-cancelled: request expired after 30 min',
        updatedAt: new Date().toISOString(),
      });
      count++;
      
      if (count % 500 === 0) {
        await batch.commit();
        console.log(`   ✅ Committed ${count} expired requests so far...`);
      }
    }
    
    if (count % 500 !== 0) {
      await batch.commit();
    }
    
    console.log(`✅ [2/4] Completed: ${count} expired requests cleaned`);
    return count;
  } catch (err) {
    console.error('❌ [2/4] Cleanup error (expired requests):', err);
    return 0;
  }
}

/**
 * Auto-archive confirmed deals after 24 hours (mark as completed)
 */
async function autoArchiveConfirmedDeals() {
  try {
    console.log('🧹 [3/4] Archiving old confirmed deals...');
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const snap = await db.collection('deals')
      .where('status', '==', DEAL_STATUS.CONFIRMED)
      .where('confirmedAt', '<', cutoff)
      .limit(500)
      .get();

    let count = 0;
    const batch = db.batch();
    
    for (const doc of snap.docs) {
      batch.update(doc.ref, {
        status: DEAL_STATUS.COMPLETED,
        archivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      count++;
      
      if (count % 500 === 0) {
        await batch.commit();
        console.log(`   ✅ Committed ${count} archived deals so far...`);
      }
    }
    
    if (count % 500 !== 0) {
      await batch.commit();
    }
    
    console.log(`✅ [3/4] Completed: ${count} deals archived`);
    return count;
  } catch (err) {
    console.error('❌ [3/4] Cleanup error (auto-archive):', err);
    return 0;
  }
}

/**
 * Cleanup old completed/cancelled deals (older than 3 days)
 * Soft-delete: mark as archived
 */
async function cleanupOldCompletedDeals() {
  try {
    console.log('🧹 [4/4] Cleaning old completed/cancelled deals...');
    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    
    const snap = await db.collection('deals')
      .where('status', 'in', [DEAL_STATUS.COMPLETED, DEAL_STATUS.CANCELLED])
      .where('updatedAt', '<', cutoff)
      .limit(500)
      .get();

    let count = 0;
    const batch = db.batch();
    
    for (const doc of snap.docs) {
      // Soft delete: archive the document
      batch.update(doc.ref, {
        archived: true,
        archivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // Keep status for historical reference
      });
      count++;
      
      if (count % 500 === 0) {
        await batch.commit();
        console.log(`   ✅ Committed ${count} old deals so far...`);
      }
    }
    
    if (count % 500 !== 0) {
      await batch.commit();
    }
    
    console.log(`✅ [4/4] Completed: ${count} old deals archived`);
    return count;
  } catch (err) {
    console.error('❌ [4/4] Cleanup error (old deals):', err);
    return 0;
  }
}

// ---------- THROTTLED WRAPPERS ----------

async function maybeCleanupExpiredRides() {
  const now = Date.now();
  if (now - lastRideCleanup < CLEANUP_INTERVAL_MS) return;
  if (isRunning) {
    console.log('⏭️ Cleanup skipped - already running');
    return;
  }
  lastRideCleanup = now;
  return cleanupExpiredRides();
}

async function maybeCleanupExpiredCustomerRequests() {
  const now = Date.now();
  if (now - lastRequestCleanup < CLEANUP_INTERVAL_MS) return;
  if (isRunning) return;
  lastRequestCleanup = now;
  return cleanupExpiredCustomerRequests();
}

async function maybeAutoArchiveConfirmedDeals() {
  const now = Date.now();
  if (now - lastArchiveCleanup < CLEANUP_INTERVAL_MS) return;
  if (isRunning) return;
  lastArchiveCleanup = now;
  return autoArchiveConfirmedDeals();
}

async function maybeCleanupOldCompletedDeals() {
  const now = Date.now();
  if (now - lastDeleteCleanup < CLEANUP_INTERVAL_MS) return;
  if (isRunning) return;
  lastDeleteCleanup = now;
  return cleanupOldCompletedDeals();
}

/**
 * Run all cleanup jobs in sequence with proper locking
 */
async function runAllCleanup() {
  if (isRunning) {
    console.log('⏭️ Cleanup already running - skipping');
    return;
  }
  
  isRunning = true;
  const startTime = Date.now();
  
  try {
    console.log('🚀 Starting full cleanup cycle...');
    console.log(`🕐 Started at: ${new Date().toISOString()}`);
    
    await maybeCleanupExpiredRides();
    await maybeCleanupExpiredCustomerRequests();
    await maybeAutoArchiveConfirmedDeals();
    await maybeCleanupOldCompletedDeals();
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Full cleanup cycle completed in ${duration}s`);
  } catch (err) {
    console.error('❌ Cleanup cycle failed:', err);
  } finally {
    isRunning = false;
  }
}

// ---------- EXPORTS ----------
module.exports = {
  // Throttled versions (safe for API calls - but DON'T use them in API)
  maybeCleanupExpiredRides,
  maybeCleanupExpiredCustomerRequests,
  maybeAutoArchiveConfirmedDeals,
  maybeCleanupOldCompletedDeals,
  
  // Raw versions (for scheduled jobs)
  cleanupExpiredRides,
  cleanupExpiredCustomerRequests,
  autoArchiveConfirmedDeals,
  cleanupOldCompletedDeals,
  
  // Run all (recommended for scheduled jobs)
  runAllCleanup,
};
