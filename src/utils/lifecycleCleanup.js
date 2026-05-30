const { db } = require('../config/firebase');
const { DEAL_STATUS, RIDE_STATUS } = require('../constants/statuses');

const ACTIVE_RIDE_STATUSES = [
  RIDE_STATUS.ACTIVE,
  RIDE_STATUS.FILLED,
  RIDE_STATUS.IN_PROGRESS,
];

const ACTIVE_CUSTOMER_REQUEST_STATUSES = ['open', 'countered', 'accepted'];

function isPastIso(value, now = new Date()) {
  const dt = new Date(value || '');
  return !Number.isNaN(dt.getTime()) && dt < now;
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
    if (!isPastIso(request.requestedAt, now)) continue;

    const completedAt = now.toISOString();
    const offersSnap = await db
      .collection('customerRideOffers')
      .where('requestId', '==', doc.id)
      .get();

    const acceptedOffer = offersSnap.docs.find((offerDoc) => {
      const offer = offerDoc.data() || {};
      return offer.status === 'accepted' || offerDoc.id === request.acceptedOfferId;
    });

    if (request.status === 'accepted' && acceptedOffer) {
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
