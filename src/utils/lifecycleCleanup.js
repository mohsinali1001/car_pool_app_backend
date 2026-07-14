const { db } = require('../config/firebase');
const { DEAL_STATUS, RIDE_STATUS } = require('../constants/statuses');
// ✅ FIXED: Correct path for walletHelper
const { addBalance, deductBalance } = require('../utils/walletHelper');

const ACTIVE_RIDE_STATUSES = [
  RIDE_STATUS.ACTIVE,
  RIDE_STATUS.FILLED,
  RIDE_STATUS.IN_PROGRESS,
];

const ACTIVE_CUSTOMER_REQUEST_STATUSES = ['open', 'countered', 'accepted'];
const ACCEPTED_REQUEST_RETENTION_MS = 10 * 60 * 1000;

// Grace period: a captain's ride stays visible/active for 20 minutes
// after its departureTime has passed, before it gets auto-completed/deleted.
const RIDE_GRACE_PERIOD_MS = 20 * 60 * 1000;

// Retention: completed/cancelled deals (bookings) are kept for 3 days after
// they become terminal, then permanently deleted. This backs "My Bookings"
// item #15 — completed bookings should disappear from the list after 3 days.
const COMPLETED_DEAL_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const TERMINAL_DEAL_STATUSES = [DEAL_STATUS.COMPLETED, DEAL_STATUS.CANCELLED];

// ✅ NEW: 24 hours retention for auto-archive and delete
const DEAL_ARCHIVE_RETENTION_MS = 24 * 60 * 60 * 1000;

function isPastIso(value, now = new Date()) {
  const dt = new Date(value || '');
  return !Number.isNaN(dt.getTime()) && dt < now;
}

function isOlderThanIso(value, ms, now = new Date()) {
  const dt = new Date(value || '');
  return !Number.isNaN(dt.getTime()) && now.getTime() - dt.getTime() >= ms;
}

async function cleanupExpiredRides() {
  const now = new Date();
  const snap = await db
    .collection('rides')
    .where('status', 'in', ACTIVE_RIDE_STATUSES)
    .limit(100)
    .get();

  const batch = db.batch();
  let writes = 0;
  const walletSettlements = [];

  for (const doc of snap.docs) {
    const ride = doc.data() || {};
    // Only clean up once departureTime + 20 minute grace period has passed
    if (!isOlderThanIso(ride.departureTime, RIDE_GRACE_PERIOD_MS, now)) continue;

    const completedAt = now.toISOString();
    const dealsSnap = await db.collection('deals').where('rideId', '==', doc.id).get();
    const deals = dealsSnap.docs.map((dealDoc) => ({
      ref: dealDoc.ref,
      data: dealDoc.data() || {},
    }));
    const hasConfirmedDeal = deals.some((deal) =>
      [DEAL_STATUS.CONFIRMED, DEAL_STATUS.STARTED, DEAL_STATUS.COMPLETED].includes(deal.data.status),
    );

    if (!hasConfirmedDeal) {
      for (const deal of deals) {
        batch.delete(deal.ref);
        writes += 1;
      }
      batch.delete(doc.ref);
      writes += 1;
      continue;
    }

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

    batch.update(doc.ref, {
      status: RIDE_STATUS.COMPLETED,
      full: true,
      completedAt,
      updatedAt: completedAt,
    });
    writes += 1;
  }

  if (writes > 0) await batch.commit();

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
    } catch (err) {
      console.error(`Auto-complete captain payout failed for deal ${dealId}:`, err.message);
    }

    try {
      await deductBalance(customerId, fare, {
        type: 'ride_payment',
        description: 'Auto-completed ride payment',
        reference: dealId,
      });
    } catch (err) {
      console.error(`Auto-complete customer payment failed for deal ${dealId}:`, err.message);
    }
  }
}

async function cleanupExpiredCustomerRequests() {
  const now = new Date();
  const snap = await db
    .collection('customerRideRequests')
    .where('status', 'in', ACTIVE_CUSTOMER_REQUEST_STATUSES)
    .limit(100)
    .get();

  const batch = db.batch();
  let writes = 0;

  for (const doc of snap.docs) {
    const request = doc.data() || {};
    const status = (request.status || '').toString().toLowerCase();
    const offersSnap = await db
      .collection('customerRideOffers')
      .where('requestId', '==', doc.id)
      .get();

    if (
      ['accepted', 'completed'].includes(status) &&
      isOlderThanIso(
        request.acceptedAt || request.completedAt || request.updatedAt,
        ACCEPTED_REQUEST_RETENTION_MS,
        now,
      )
    ) {
      for (const offerDoc of offersSnap.docs) {
        batch.delete(offerDoc.ref);
        writes += 1;
      }
      batch.delete(doc.ref);
      writes += 1;
      continue;
    }

    if (!isPastIso(request.requestedAt, now)) continue;

    const completedAt = now.toISOString();

    const acceptedOffer = offersSnap.docs.find((offerDoc) => {
      const offer = offerDoc.data() || {};
      return offer.status === 'accepted' || offerDoc.id === request.acceptedOfferId;
    });

    if (status === 'accepted' && acceptedOffer) {
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
      for (const offerDoc of offersSnap.docs) {
        batch.delete(offerDoc.ref);
        writes += 1;
      }
      batch.delete(doc.ref);
      writes += 1;
    }
  }

  if (writes > 0) await batch.commit();
}

/**
 * NEW: autoArchiveConfirmedDeals
 * Auto-archives confirmed deals that are older than 24 hours.
 * Changes status from 'confirmed' to 'completed' automatically.
 */
async function autoArchiveConfirmedDeals() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - DEAL_ARCHIVE_RETENTION_MS);

  try {
    const snapshot = await db
      .collection('deals')
      .where('status', '==', DEAL_STATUS.CONFIRMED)
      .where('confirmedAt', '<=', cutoff.toISOString())
      .limit(100)
      .get();

    if (snapshot.empty) {
      console.log('✅ No confirmed deals to archive (older than 24h)');
      return;
    }

    const batch = db.batch();
    let count = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data() || {};
      // Also check if there's a confirmedAt field, if not use updatedAt
      const refTime = data.confirmedAt || data.updatedAt || data.createdAt;
      if (!isOlderThanIso(refTime, DEAL_ARCHIVE_RETENTION_MS, now)) continue;

      batch.update(doc.ref, {
        status: DEAL_STATUS.COMPLETED,
        completedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        autoArchived: true,
      });
      count++;
    }

    if (count > 0) {
      await batch.commit();
      console.log(`✅ Auto-archived ${count} confirmed deals (older than 24h)`);
    }
  } catch (err) {
    console.error('❌ autoArchiveConfirmedDeals error:', err);
  }
}

/**
 * cleanupOldCompletedDeals
 * Deletes "deals" (bookings) permanently once they've been in a terminal
 * state (completed or cancelled) for more than 3 days. This is the
 * background counterpart to the 3-day filter already applied in
 * dealController.js -> getMyBookings (that filter hides old bookings from
 * the response immediately; this function actually removes them from the
 * database so the collection doesn't grow forever).
 *
 * Uses completedAt (if present) else updatedAt else createdAt as the
 * reference timestamp, since cancelled deals don't always set completedAt.
 */
async function cleanupOldCompletedDeals() {
  const now = new Date();

  const snap = await db
    .collection('deals')
    .where('status', 'in', TERMINAL_DEAL_STATUSES)
    .limit(200)
    .get();

  if (snap.empty) return;

  const batch = db.batch();
  let writes = 0;

  for (const doc of snap.docs) {
    const deal = doc.data() || {};
    const referenceTimestamp = deal.completedAt || deal.updatedAt || deal.createdAt;

    if (isOlderThanIso(referenceTimestamp, COMPLETED_DEAL_RETENTION_MS, now)) {
      batch.delete(doc.ref);
      writes += 1;
    }
  }

  if (writes > 0) {
    await batch.commit();
    console.log(`✅ Deleted ${writes} old completed/cancelled deals (older than 3 days)`);
  }
}

module.exports = {
  cleanupExpiredRides,
  cleanupExpiredCustomerRequests,
  autoArchiveConfirmedDeals,     // ✅ ADDED - exports this function
  cleanupOldCompletedDeals,      // ✅ ADDED - exports this function
};
