const { db } = require('../config/firebase');
const { DEAL_STATUS, RIDE_STATUS } = require('../constants/statuses');
const { addBalance, deductBalance } = require('./walletHelper');

const ACTIVE_RIDE_STATUSES = [
  RIDE_STATUS.ACTIVE,
  RIDE_STATUS.FILLED,
  RIDE_STATUS.IN_PROGRESS,
];

const ACTIVE_CUSTOMER_REQUEST_STATUSES = ['open', 'countered', 'accepted'];
const ACCEPTED_REQUEST_RETENTION_MS = 10 * 60 * 1000;

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
    if (!isPastIso(ride.departureTime, now)) continue;

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

module.exports = {
  cleanupExpiredRides,
  cleanupExpiredCustomerRequests,
};
