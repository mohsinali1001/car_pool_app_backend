const { db } = require('../config/firebase');
const { DEAL_STATUS, RIDE_STATUS, CLEANUP_TIMINGS } = require('../constants/statuses');
const { addBalance, deductBalance } = require('../utils/walletHelper');

// ======================== LOCAL CONSTANTS (legacy support) ========================
// Agar koi purani function inhe use kar raha ho to yeh bhi rakh rahe hain,
// lekin ab CLEANUP_TIMINGS se values le rahe hain.

const ACTIVE_RIDE_STATUSES = [
  RIDE_STATUS.ACTIVE,
  RIDE_STATUS.FILLED,
  RIDE_STATUS.IN_PROGRESS,
];

const ACTIVE_CUSTOMER_REQUEST_STATUSES = ['open', 'countered', 'accepted'];
const ACCEPTED_REQUEST_RETENTION_MS = 10 * 60 * 1000;

// ⚠️ Ab yeh values CLEANUP_TIMINGS se override hongi, lekin variables rakhe hain
// taki existing code break na ho.
const RIDE_GRACE_PERIOD_MS = CLEANUP_TIMINGS.RIDE_GRACE_PERIOD;
const COMPLETED_DEAL_RETENTION_MS = CLEANUP_TIMINGS.PASSENGER_COMPLETED_RETENTION; // 6h
const TERMINAL_DEAL_STATUSES = [DEAL_STATUS.COMPLETED, DEAL_STATUS.CANCELLED];
const DEAL_ARCHIVE_RETENTION_MS = CLEANUP_TIMINGS.CONFIRMED_ARCHIVE; // 6h

// ======================== HELPER FUNCTIONS ========================
function isPastIso(value, now = new Date()) {
  const dt = new Date(value || '');
  return !Number.isNaN(dt.getTime()) && dt < now;
}

function isOlderThanIso(value, ms, now = new Date()) {
  const dt = new Date(value || '');
  return !Number.isNaN(dt.getTime()) && now.getTime() - dt.getTime() >= ms;
}

// ======================== 1. CLEANUP EXPIRED RIDES (Captain) ========================
async function cleanupExpiredRides() {
  const now = new Date();
  console.log('[Cleanup] Checking expired rides...');

  const snap = await db
    .collection('rides')
    .where('status', 'in', ACTIVE_RIDE_STATUSES)
    .limit(100)
    .get();

  if (snap.empty) {
    console.log('[Cleanup] No active rides to check.');
    return;
  }

  const batch = db.batch();
  let writes = 0;
  const walletSettlements = [];

  for (const doc of snap.docs) {
    const ride = doc.data() || {};
    // Grace period (30min) ke baad hi process karein
    if (!isOlderThanIso(ride.departureTime, RIDE_GRACE_PERIOD_MS, now)) continue;

    console.log(`[Cleanup] Processing expired ride: ${doc.id}`);
    const completedAt = now.toISOString();

    const dealsSnap = await db.collection('deals').where('rideId', '==', doc.id).get();
    const deals = dealsSnap.docs.map((dealDoc) => ({
      ref: dealDoc.ref,
      data: dealDoc.data() || {},
    }));

    const hasConfirmedDeal = deals.some((deal) =>
      [DEAL_STATUS.CONFIRMED, DEAL_STATUS.STARTED, DEAL_STATUS.COMPLETED].includes(deal.data.status)
    );

    // Agar koi confirmed deal nahi hai to saari deals aur ride delete kar do
    if (!hasConfirmedDeal) {
      for (const deal of deals) {
        batch.delete(deal.ref);
        writes += 1;
      }
      batch.delete(doc.ref);
      writes += 1;
      continue;
    }

    // Confirmed/Started deals ko complete karo, pending ko cancel
    for (const deal of deals) {
      if ([DEAL_STATUS.CONFIRMED, DEAL_STATUS.STARTED].includes(deal.data.status)) {
        batch.update(deal.ref, {
          status: DEAL_STATUS.COMPLETED,
          completedAt,
          updatedAt: completedAt,
        });
        writes += 1;
        walletSettlements.push({
          dealId: deal.ref.id,
          captainId: deal.data.captainId,
          customerId: deal.data.customerId,
          agreedFare: deal.data.agreedFare,
        });
      } else if (deal.data.status === DEAL_STATUS.PENDING) {
        batch.update(deal.ref, {
          status: DEAL_STATUS.CANCELLED,
          updatedAt: completedAt,
        });
        writes += 1;
      }
    }

    // Ride ko completed mark karo
    batch.update(doc.ref, {
      status: RIDE_STATUS.COMPLETED,
      full: true,
      completedAt,
      updatedAt: completedAt,
    });
    writes += 1;
  }

  if (writes > 0) await batch.commit();
  console.log(`[Cleanup] Processed ${writes} expired ride records.`);

  // Wallet settlements
  for (const settlement of walletSettlements) {
    const { dealId, captainId, customerId, agreedFare } = settlement;
    const fare = parseFloat(agreedFare || 0);
    if (!fare || fare <= 0 || !captainId || !customerId) continue;

    try {
      await addBalance(captainId, fare, {
        type: 'ride_earning',
        description: 'Auto-completed ride earning',
        reference: dealId,
      });
      console.log(`[Cleanup] Added ${fare} to captain ${captainId}`);
    } catch (err) {
      console.error(`[Cleanup] Captain payout failed for deal ${dealId}:`, err.message);
    }

    try {
      await deductBalance(customerId, fare, {
        type: 'ride_payment',
        description: 'Auto-completed ride payment',
        reference: dealId,
      });
      console.log(`[Cleanup] Deducted ${fare} from customer ${customerId}`);
    } catch (err) {
      console.error(`[Cleanup] Customer payment failed for deal ${dealId}:`, err.message);
    }
  }
}

// ======================== 2. CLEANUP EXPIRED CUSTOMER REQUESTS ========================
async function cleanupExpiredCustomerRequests() {
  const now = new Date();
  console.log('[Cleanup] Checking expired customer requests...');

  const snap = await db
    .collection('customerRideRequests')
    .where('status', 'in', ACTIVE_CUSTOMER_REQUEST_STATUSES)
    .limit(100)
    .get();

  if (snap.empty) {
    console.log('[Cleanup] No active customer requests.');
    return;
  }

  const batch = db.batch();
  let writes = 0;

  for (const doc of snap.docs) {
    const request = doc.data() || {};
    const status = (request.status || '').toString().toLowerCase();
    const offersSnap = await db
      .collection('customerRideOffers')
      .where('requestId', '==', doc.id)
      .get();

    // Agar accepted request expire ho chuki hai to delete karo
    if (
      ['accepted', 'completed'].includes(status) &&
      isOlderThanIso(
        request.acceptedAt || request.completedAt || request.updatedAt,
        ACCEPTED_REQUEST_RETENTION_MS,
        now
      )
    ) {
      console.log(`[Cleanup] Deleting expired accepted request: ${doc.id}`);
      for (const offerDoc of offersSnap.docs) {
        batch.delete(offerDoc.ref);
        writes += 1;
      }
      batch.delete(doc.ref);
      writes += 1;
      continue;
    }

    // Agar requested time pass ho chuki hai to process karo
    if (!isPastIso(request.requestedAt, now)) continue;

    console.log(`[Cleanup] Processing expired customer request: ${doc.id}`);
    const completedAt = now.toISOString();

    const acceptedOffer = offersSnap.docs.find((offerDoc) => {
      const offer = offerDoc.data() || {};
      return offer.status === 'accepted' || offerDoc.id === request.acceptedOfferId;
    });

    if (status === 'accepted' && acceptedOffer) {
      // Complete the accepted request
      batch.update(doc.ref, {
        status: 'completed',
        completedAt,
        updatedAt: completedAt,
      });
      writes += 1;

      for (const offerDoc of offersSnap.docs) {
        const offer = offerDoc.data() || {};
        if (offerDoc.id === acceptedOffer.id || offer.status === 'accepted') {
          batch.update(offerDoc.ref, {
            status: 'completed',
            phoneRevealed: true,
            completedAt,
            updatedAt: completedAt,
          });
        } else if (['offered', 'countered'].includes(offer.status)) {
          batch.update(offerDoc.ref, {
            status: 'cancelled',
            updatedAt: completedAt,
          });
        }
        writes += 1;
      }
    } else {
      // Non‑accepted requests ko delete karo
      for (const offerDoc of offersSnap.docs) {
        batch.delete(offerDoc.ref);
        writes += 1;
      }
      batch.delete(doc.ref);
      writes += 1;
    }
  }

  if (writes > 0) await batch.commit();
  console.log(`[Cleanup] Processed ${writes} expired customer requests.`);
}

// ======================== 3. AUTO-ARCHIVE CONFIRMED DEALS (6h) ========================
async function autoArchiveConfirmedDeals() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - DEAL_ARCHIVE_RETENTION_MS);

  try {
    console.log('[Cleanup] Checking for stale confirmed deals...');

    const snapshot = await db
      .collection('deals')
      .where('status', '==', DEAL_STATUS.CONFIRMED)
      .limit(100)
      .get();

    if (snapshot.empty) {
      console.log('[Cleanup] No confirmed deals to archive.');
      return;
    }

    const batch = db.batch();
    let count = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data() || {};
      const refTime = data.confirmedAt || data.updatedAt || data.createdAt;
      if (!isOlderThanIso(refTime, DEAL_ARCHIVE_RETENTION_MS, now)) continue;

      // Do not remove a booking for a future ride. Once the ride has ended,
      // confirmed history is no longer actionable and can be cleaned safely.
      let rideDeparture = data.departureTime;
      if (!rideDeparture && data.rideId) {
        const rideDoc = await db.collection('rides').doc(data.rideId).get();
        rideDeparture = rideDoc.exists ? rideDoc.data()?.departureTime : null;
      }
      if (!isPastIso(rideDeparture, now)) continue;

      console.log(`[Cleanup] Removing stale confirmed deal: ${doc.id}`);
      batch.delete(doc.ref);
      count++;
    }

    if (count > 0) {
      await batch.commit();
      console.log(`[Cleanup] Removed ${count} stale confirmed deals (older than 6h).`);
    }
  } catch (err) {
    console.error('[Cleanup] Error in autoArchiveConfirmedDeals:', err);
  }
}

// ======================== 4. CLEANUP OLD COMPLETED DEALS (History) ========================
// Yeh function completed/cancelled deals ko delete karega after six hours.
async function cleanupOldCompletedDeals() {
  const now = new Date();
  const retentionMs = CLEANUP_TIMINGS.PASSENGER_COMPLETED_RETENTION; // 6h
  const cutoff = new Date(now - retentionMs);

  try {
    console.log(`[Cleanup] Checking for old completed deals older than ${cutoff.toISOString()}`);

    const snap = await db
      .collection('deals')
      .where('status', '==', DEAL_STATUS.COMPLETED)
      .where('completedAt', '<=', cutoff.toISOString())
      .limit(200)
      .get();

    if (snap.empty) {
      console.log('[Cleanup] No old completed deals to delete.');
      return;
    }

    console.log(`[Cleanup] Found ${snap.size} old completed deals to delete.`);

    const batch = db.batch();
    let writes = 0;

    for (const doc of snap.docs) {
      const deal = doc.data() || {};
      console.log(`[Cleanup] Deleting completed deal: ${doc.id} (completed at ${deal.completedAt})`);
      batch.delete(doc.ref);
      writes++;
    }

    if (writes > 0) {
      await batch.commit();
      console.log(`[Cleanup] Deleted ${writes} old completed deals (older than ${retentionMs/3600000} hours).`);
    }
  } catch (err) {
    console.error('[Cleanup] Error in cleanupOldCompletedDeals:', err);
  }

  // Ab cancelled deals bhi delete karo (same retention)
  try {
    const snapCancelled = await db
      .collection('deals')
      .where('status', '==', DEAL_STATUS.CANCELLED)
      .where('updatedAt', '<=', cutoff.toISOString())
      .limit(200)
      .get();

    if (!snapCancelled.empty) {
      const batch = db.batch();
      let writes = 0;
      for (const doc of snapCancelled.docs) {
        console.log(`[Cleanup] Deleting cancelled deal: ${doc.id}`);
        batch.delete(doc.ref);
        writes++;
      }
      if (writes > 0) {
        await batch.commit();
        console.log(`[Cleanup] Deleted ${writes} old cancelled deals.`);
      }
    }
  } catch (err) {
    console.error('[Cleanup] Error deleting cancelled deals:', err);
  }
}

// ======================== 5. CLEANUP OLD CAPTAIN RIDES (Done tab) ========================
// Captain ki "Done" rides ko 3 hours baad archive karein (status -> 'archived')
async function cleanupOldCaptainRides() {
  const now = new Date();
  const retentionMs = CLEANUP_TIMINGS.CAPTAIN_DONE_RETENTION; // 3 hours
  const cutoff = new Date(now - retentionMs);

  try {
    console.log(`[Cleanup] Checking for old captain rides (Done) older than ${cutoff.toISOString()}`);

    const snap = await db
      .collection('rides')
      .where('status', 'in', [RIDE_STATUS.COMPLETED, RIDE_STATUS.CANCELLED])
      .where('updatedAt', '<=', cutoff.toISOString())
      .limit(200)
      .get();

    if (snap.empty) {
      console.log('[Cleanup] No old captain rides to archive.');
      return;
    }

    console.log(`[Cleanup] Found ${snap.size} old captain rides to archive.`);

    const batch = db.batch();
    let writes = 0;

    for (const doc of snap.docs) {
      console.log(`[Cleanup] Archiving ride: ${doc.id}`);
      batch.update(doc.ref, {
        status: RIDE_STATUS.ARCHIVED,
        archivedAt: now.toISOString(),
        archivedReason: 'auto_cleanup_3_hours',
      });
      writes++;
    }

    if (writes > 0) {
      await batch.commit();
      console.log(`[Cleanup] Archived ${writes} old captain rides (older than 3 hours).`);
    }
  } catch (err) {
    console.error('[Cleanup] Error in cleanupOldCaptainRides:', err);
  }
}

// ======================== 6. CLEANUP EXPIRED PENDING DEALS (24h) ========================
async function cleanupExpiredPendingDeals() {
  const now = new Date();
  const expiryMs = CLEANUP_TIMINGS.PENDING_DEAL_EXPIRY; // 24 hours
  const cutoff = new Date(now - expiryMs);

  try {
    console.log(`[Cleanup] Checking for expired pending deals older than ${cutoff.toISOString()}`);

    const snap = await db
      .collection('deals')
      .where('status', '==', DEAL_STATUS.PENDING)
      .where('createdAt', '<=', cutoff.toISOString())
      .limit(100)
      .get();

    if (snap.empty) {
      console.log('[Cleanup] No expired pending deals.');
      return;
    }

    console.log(`[Cleanup] Found ${snap.size} expired pending deals to cancel.`);

    const batch = db.batch();
    let writes = 0;

    for (const doc of snap.docs) {
      console.log(`[Cleanup] Auto-cancelling pending deal: ${doc.id}`);
      batch.update(doc.ref, {
        status: DEAL_STATUS.CANCELLED,
        cancelledAt: now.toISOString(),
        cancellationReason: 'auto_cancelled_expired_24h',
        updatedAt: now.toISOString(),
      });
      writes++;
    }

    if (writes > 0) {
      await batch.commit();
      console.log(`[Cleanup] Cancelled ${writes} expired pending deals.`);
    }
  } catch (err) {
    console.error('[Cleanup] Error in cleanupExpiredPendingDeals:', err);
  }
}

// ======================== MAIN FUNCTION (Run All) ========================
async function runLifecycleCleanup() {
  console.log('========================================');
  console.log('[Cleanup] Starting lifecycle cleanup job...');
  console.log(`[Cleanup] Time: ${new Date().toISOString()}`);
  console.log('========================================');

  try {
    await Promise.all([
      cleanupExpiredRides(),
      cleanupExpiredCustomerRequests(),
      autoArchiveConfirmedDeals(),
      cleanupOldCompletedDeals(),
      cleanupOldCaptainRides(),
      cleanupExpiredPendingDeals(),
    ]);
    console.log('========================================');
    console.log('[Cleanup] Lifecycle cleanup completed successfully.');
    console.log('========================================');
  } catch (error) {
    console.error('[Cleanup] Lifecycle cleanup failed:', error);
  }
}

// ======================== EXPORTS ========================
module.exports = {
  runLifecycleCleanup,
  cleanupExpiredRides,
  cleanupExpiredCustomerRequests,
  autoArchiveConfirmedDeals,
  cleanupOldCompletedDeals,
  cleanupOldCaptainRides,
  cleanupExpiredPendingDeals,
};
