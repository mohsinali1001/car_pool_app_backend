const { db } = require('../config/firebase');
const { deductBalance, addBalance } = require('../utils/walletHelper');
const { pushToUser } = require('../utils/notificationHelper');
const { RIDE_STATUS, DEAL_STATUS, ACTIVE_DEAL_STATUSES } = require('../constants/statuses');
const { labelFromLocation } = require('../utils/locationLabelHelper');
// Cleanup helpers are now called from a separate scheduled job only
// const { maybeCleanupExpiredRides, maybeAutoArchiveConfirmedDeals, maybeCleanupOldCompletedDeals } = require('../utils/throttledCleanup');
const { seatUpdateFromRide } = require('../utils/seatHelper');
const {
  sanitizeString,
  exceedsMaxLength,
  MAX_CUSTOMER_MESSAGE,
  MAX_REVIEW,
} = require('../utils/inputSanitizer');
const { CAPTAIN_STARTER_BALANCE } = require('../utils/walletHelper');

const PLATFORM_FEE_PERCENT = 0.05;
const BOOKING_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours – completed bookings disappear after 1 day

// ---------- Helpers ----------
function generalPickupArea(address) {
  if (!address || typeof address !== 'string') return 'Along route';
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0] || 'Along route';
}

function parseCoord(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function maskCaptainPhone(phone) {
  return '03**-*****';
}

/** Recompute ride listing status from active deals on that ride. */
async function syncRideStatusFromDeals(rideId) {
  const rideRef = db.collection('rides').doc(rideId);
  const rideDoc = await rideRef.get();
  if (!rideDoc.exists) return;

  const ride = rideDoc.data();
  if (ride.status === RIDE_STATUS.CANCELLED || ride.status === RIDE_STATUS.COMPLETED) {
    return;
  }

  const dealsSnap = await db.collection('deals').where('rideId', '==', rideId).get();
  const deals = dealsSnap.docs.map((d) => d.data());

  const hasStarted = deals.some((d) => d.status === DEAL_STATUS.STARTED);
  if (hasStarted) {
    await rideRef.update({
      status: RIDE_STATUS.IN_PROGRESS,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  const openDeals = deals.filter((d) =>
    [DEAL_STATUS.PENDING, DEAL_STATUS.CONFIRMED].includes(d.status),
  );
  const availableSeats = ride.availableSeats ?? ride.totalSeats ?? 0;

  await rideRef.update({
    status: availableSeats <= 0 && openDeals.length === 0 ? RIDE_STATUS.FILLED : RIDE_STATUS.ACTIVE,
    full: availableSeats <= 0,
    updatedAt: new Date().toISOString(),
  });
}

/** Mark ride completed only when every deal is terminal. */
async function maybeCompleteRide(rideId) {
  const dealsSnap = await db.collection('deals').where('rideId', '==', rideId).get();
  const deals = dealsSnap.docs.map((d) => d.data());
  if (deals.length === 0) return;

  const allTerminal = deals.every((d) =>
    [DEAL_STATUS.COMPLETED, DEAL_STATUS.CANCELLED].includes(d.status),
  );
  if (!allTerminal) return;

  const anyCompleted = deals.some((d) => d.status === DEAL_STATUS.COMPLETED);
  await db.collection('rides').doc(rideId).update({
    status: anyCompleted ? RIDE_STATUS.COMPLETED : RIDE_STATUS.CANCELLED,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Populate a single deal with its ride data.
 * Used inside Promise.all for parallel fetching.
 */
async function populateRide(deal) {
  if (!deal.rideId) return deal;
  // If ride data already exists (denormalized), skip fetch
  if (deal.ride) return deal;
  const rideDoc = await db.collection('rides').doc(deal.rideId).get();
  if (!rideDoc.exists) return deal;
  const ride = rideDoc.data();
  deal.ride = {
    id: deal.rideId,
    startLocation: ride.startLocation,
    endLocation: ride.endLocation,
    exactLocation: ride.exactLocation,
    exactDropLocation: ride.exactDropLocation,
    startLat: ride.startLat,
    startLng: ride.startLng,
    endLat: ride.endLat,
    endLng: ride.endLng,
    departureTime: ride.departureTime,
    captainName: ride.captainName,
    captainId: ride.captainId,
    vehicleInfo: ride.vehicleInfo,
    vehiclePhotoUrl: ride.vehiclePhotoUrl,
    suggestedFare: ride.suggestedFare,
    status: ride.status,
    availableSeats: ride.availableSeats,
    totalSeats: ride.totalSeats,
    full: ride.full === true || (ride.availableSeats || 0) <= 0,
  };
  return deal;
}

function normalizeBooking(deal) {
  const status = (deal.status || DEAL_STATUS.PENDING).toString().toLowerCase();
  const ride = deal.ride || {};
  const departure = new Date(ride.departureTime || deal.departureTime || 0);
  const now = new Date();
  const isCompleted = status === DEAL_STATUS.COMPLETED;
  const isConfirmed = status === DEAL_STATUS.CONFIRMED;
  const isUpcoming =
    [DEAL_STATUS.PENDING, DEAL_STATUS.CONFIRMED, DEAL_STATUS.STARTED].includes(status) &&
    (Number.isNaN(departure.getTime()) || departure >= now || status === DEAL_STATUS.STARTED);

  return {
    ...deal,
    status,
    bookingStatus: status,
    tabStatus: isCompleted
      ? 'completed'
      : isConfirmed
        ? 'confirmed'
        : isUpcoming
          ? 'upcoming'
          : status,
    isUpcoming,
    isConfirmed,
    isCompleted,
    canRate: isCompleted && deal.rating == null,
  };
}

async function getCaptainReviewSummary(captainId, limit = 5) {
  const [reviewsSnap, ridesSnap] = await Promise.all([
    db
      .collection('deals')
      .where('captainId', '==', captainId)
      .where('status', '==', DEAL_STATUS.COMPLETED)
      .get(),
    db
      .collection('rides')
      .where('captainId', '==', captainId)
      .where('status', '==', RIDE_STATUS.COMPLETED)
      .get(),
  ]);

  const reviews = reviewsSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((deal) => deal.rating != null)
    .sort((a, b) => String(b.ratedAt || b.completedAt || '').localeCompare(String(a.ratedAt || a.completedAt || '')));
  const ratingSum = reviews.reduce((sum, deal) => sum + Number(deal.rating || 0), 0);
  const reviewCount = reviews.length;

  return {
    averageRating: reviewCount > 0 ? Number((ratingSum / reviewCount).toFixed(2)) : 0,
    reviewCount,
    totalCompletedRides: reviewsSnap.size || ridesSnap.size,
    recentReviews: reviews.slice(0, limit).map((deal) => ({
      id: deal.id,
      rating: Number(deal.rating || 0),
      review: deal.review || '',
      customerName: deal.customerName || 'Customer',
      routeLabel: deal.rideId || '',
      createdAt: deal.ratedAt || deal.completedAt || deal.updatedAt || deal.createdAt || null,
    })),
  };
}

// ---------- REUSABLE CONFIRM TRANSACTION ----------
async function _executeConfirmTransaction(dealId, actorUid, options = {}) {
  const { skipOwnershipCheck = false } = options;

  const dealRef = db.collection('deals').doc(dealId);
  const dealSnap = await dealRef.get();
  if (!dealSnap.exists) throw Object.assign(new Error('Deal not found'), { code: 'DEAL_NOT_FOUND' });
  const preDeal = dealSnap.data();

  const isCaptain = preDeal.captainId === actorUid;
  const isCustomer = preDeal.customerId === actorUid;

  if (!skipOwnershipCheck && !isCaptain && !isCustomer) {
    throw Object.assign(new Error('Not your deal'), { code: 'UNAUTHORIZED' });
  }
  if (!skipOwnershipCheck && isCustomer && preDeal.lastCounterBy !== 'captain') {
    throw Object.assign(new Error('Only captain can confirm this deal'), { code: 'UNAUTHORIZED' });
  }
  if (preDeal.status !== DEAL_STATUS.PENDING) {
    throw Object.assign(new Error('Deal already processed'), { code: 'INVALID_STATE' });
  }

  const captainId = preDeal.captainId;
  const rideRef = db.collection('rides').doc(preDeal.rideId);
  const walletRef = db.collection('wallets').doc(captainId);
  const commission = parseFloat(preDeal.agreedFare || 0) * PLATFORM_FEE_PERCENT;
  const now = new Date().toISOString();
  let newBalance = 0;
  let customerId = preDeal.customerId;

  await db.runTransaction(async (t) => {
    const dealDoc = await t.get(dealRef);
    if (!dealDoc.exists) throw Object.assign(new Error('Deal not found'), { code: 'DEAL_NOT_FOUND' });
    const deal = dealDoc.data();
    if (!skipOwnershipCheck && deal.captainId !== captainId) {
      throw Object.assign(new Error('Not your deal'), { code: 'UNAUTHORIZED' });
    }
    if (!skipOwnershipCheck && isCustomer && deal.lastCounterBy !== 'captain') {
      throw Object.assign(new Error('Only captain can confirm this deal'), { code: 'UNAUTHORIZED' });
    }
    if (deal.status !== DEAL_STATUS.PENDING) {
      throw Object.assign(new Error('Deal already processed'), { code: 'INVALID_STATE' });
    }

    const rideDoc = await t.get(rideRef);
    if (!rideDoc.exists) throw new Error('Ride not found');
    const ride = rideDoc.data();
    const available = ride.availableSeats ?? ride.totalSeats ?? 0;
    if (available <= 0) {
      throw Object.assign(new Error('Ride is full'), { code: 'RIDE_FULL', statusCode: 400 });
    }

    const walletDoc = await t.get(walletRef);
    let currentBalance = walletDoc.exists
      ? Number(walletDoc.data().balance || 0)
      : CAPTAIN_STARTER_BALANCE;

    if (currentBalance < commission) {
      throw Object.assign(new Error('Insufficient wallet balance to confirm deal'), {
        code: 'INSUFFICIENT_BALANCE',
        statusCode: 400,
        required: commission,
        current: currentBalance,
      });
    }

    newBalance = currentBalance - commission;
    customerId = deal.customerId;

    const { available: newSeats } = seatUpdateFromRide(ride, -1);
    const rideUpdates = {
      availableSeats: newSeats,
      full: newSeats <= 0,
      updatedAt: now,
    };
    if (newSeats <= 0) {
      rideUpdates.status = RIDE_STATUS.FILLED;
    }
    t.update(rideRef, rideUpdates);

    t.set(
      walletRef,
      {
        id: captainId,
        userId: captainId,
        balance: newBalance,
        updatedAt: now,
      },
      { merge: true },
    );

    const txRef = db.collection('transactions').doc();
    t.set(txRef, {
      walletId: captainId,
      type: 'commission',
      amount: commission,
      reference: dealId,
      description: `5% commission for deal ${dealId}`,
      balanceAfter: newBalance,
      createdAt: now,
    });

    t.update(dealRef, {
      status: DEAL_STATUS.CONFIRMED,
      phoneRevealed: true,
      confirmedAt: now,
      confirmedBy: skipOwnershipCheck ? 'system' : (isCustomer ? 'customer' : 'captain'),
      updatedAt: now,
    });
  });

  await syncRideStatusFromDeals(preDeal.rideId);
  const notifyRecipient = (isCustomer || skipOwnershipCheck) ? captainId : customerId;
  await pushToUser(notifyRecipient, {
    title: 'Booking confirmed',
    body: 'Your ride booking has been confirmed.',
    type: 'deal_confirmed',
    data: { dealId },
  });

  return { commission, newBalance };
}

// ---------- CONTROLLER ENDPOINTS ----------

/**
 * createDeal – stores ride snapshot (denormalized) and auto-confirms if fare matches
 */
const createDeal = async (req, res) => {
  const uid = req.user.uid;
  const {
    rideId,
    agreedFare,
    customerMessage,
    passengerPickupLat,
    passengerPickupLng,
    passengerPickupAddress,
    passengerDropLat,
    passengerDropLng,
    passengerDropAddress,
  } = req.body;

  if (!rideId || agreedFare == null) {
    return res.status(400).json({ success: false, error: 'rideId and agreedFare required', code: 'MISSING_FIELDS' });
  }

  if (exceedsMaxLength(customerMessage, MAX_CUSTOMER_MESSAGE)) {
    return res.status(400).json({
      success: false,
      error: `customerMessage must be at most ${MAX_CUSTOMER_MESSAGE} characters`,
      code: 'FIELD_TOO_LONG',
    });
  }
  const sanitizedMessage = sanitizeString(customerMessage, MAX_CUSTOMER_MESSAGE);

  const pickupLat = parseCoord(passengerPickupLat);
  const pickupLng = parseCoord(passengerPickupLng);
  const pickupAddress = labelFromLocation(passengerPickupAddress);
  const dropAddress = labelFromLocation(passengerDropAddress);
  if (pickupLat == null || pickupLng == null || !pickupAddress) {
    return res.status(400).json({
      success: false,
      error: 'Passenger pickup location is required',
      code: 'MISSING_PICKUP',
    });
  }

  try {
    const rideRef = db.collection('rides').doc(rideId);
    const rideDoc = await rideRef.get();
    if (!rideDoc.exists) {
      return res.status(404).json({ success: false, error: 'Ride not found', code: 'RIDE_NOT_FOUND' });
    }
    const rideData = rideDoc.data();
    const isSelfBooking = rideData.captainId === uid;
    if (isSelfBooking) {
      console.warn(`⚠️ Captain ${uid} is booking their own ride ${rideId} - Testing mode`);
    }

    const existing = await db
      .collection('deals')
      .where('rideId', '==', rideId)
      .where('customerId', '==', uid)
      .where('status', 'in', ACTIVE_DEAL_STATUSES)
      .get();

    if (!existing.empty) {
      return res.status(409).json({ success: false, error: 'Active booking already exists', code: 'DEAL_EXISTS' });
    }

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
    }
    const customerGender = (userDoc.data().gender || '').toString().trim().toLowerCase();

    const dealRef = db.collection('deals').doc();
    const platformFee = parseFloat(agreedFare) * PLATFORM_FEE_PERCENT;
    const captainId = rideData.captainId;
    const captainUserDoc = await db.collection('users').doc(captainId).get();
    const captainPhone = captainUserDoc.exists ? (captainUserDoc.data().phone || '') : '';

    const suggestedFare = Number(rideData.suggestedFare || 0);
    const isNegotiated = parseFloat(agreedFare) !== suggestedFare;

    // Build denormalized ride snapshot
    const rideSnapshot = {
      id: rideId,
      startLocation: rideData.startLocation,
      endLocation: rideData.endLocation,
      exactLocation: rideData.exactLocation,
      exactDropLocation: rideData.exactDropLocation,
      startLat: rideData.startLat,
      startLng: rideData.startLng,
      endLat: rideData.endLat,
      endLng: rideData.endLng,
      departureTime: rideData.departureTime,
      captainName: rideData.captainName,
      captainId: rideData.captainId,
      vehicleInfo: rideData.vehicleInfo,
      vehiclePhotoUrl: rideData.vehiclePhotoUrl,
      suggestedFare: rideData.suggestedFare,
      status: rideData.status,
      availableSeats: rideData.availableSeats,
      totalSeats: rideData.totalSeats,
      full: rideData.full === true || (rideData.availableSeats || 0) <= 0,
    };

    const dealData = await db.runTransaction(async (t) => {
      const ride = await t.get(rideRef);
      if (!ride.exists) throw new Error('Ride not found');
      const rideStatus = ride.data().status;
      const rideData = ride.data();
      if (rideData.isLadiesRide === true && customerGender !== 'female') {
        throw new Error('Ladies rides can only be booked by female passengers');
      }
      if (rideStatus === RIDE_STATUS.FILLED || rideData.full === true) {
        throw new Error('Ride is full');
      }
      if (![RIDE_STATUS.ACTIVE].includes(rideStatus)) {
        throw new Error('Ride is no longer available');
      }
      if ((rideData.availableSeats || 0) <= 0) {
        throw new Error('Ride is full');
      }

      const dropLat = parseCoord(passengerDropLat);
      const dropLng = parseCoord(passengerDropLng);

      const data = {
        id: dealRef.id,
        rideId,
        ride: rideSnapshot, // denormalized
        captainId: rideData.captainId,
        customerId: uid,
        customerName: userDoc.data().name || 'Guest',
        customerPhone: userDoc.data().phone || '',
        captainPhone,
        phoneRevealed: false,
        agreedFare: parseFloat(agreedFare),
        platformFee,
        status: DEAL_STATUS.PENDING,
        customerMessage: sanitizedMessage,
        passengerPickupLat: pickupLat,
        passengerPickupLng: pickupLng,
        passengerPickupAddress: pickupAddress,
        passengerDropLat: dropLat ?? rideData.endLat ?? 0,
        passengerDropLng: dropLng ?? rideData.endLng ?? 0,
        passengerDropAddress: dropAddress || labelFromLocation(rideData.endLocation),
        pickupOrder: null,
        boardingStatus: 'waiting',
        isNegotiated,
        review: null,
        confirmedAt: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
      };
      t.set(dealRef, data);
      return data;
    });

    // Auto-confirm if fare matches
    if (!isNegotiated) {
      try {
        await _executeConfirmTransaction(dealRef.id, uid, { skipOwnershipCheck: true });
        console.log(`✅ Auto-confirmed deal ${dealRef.id} (fare matched)`);
      } catch (err) {
        console.warn(`⚠️ Auto-confirm failed for deal ${dealRef.id}: ${err.message}`);
        await pushToUser(captainId, {
          title: 'Booking received but not confirmed',
          body: 'A passenger booked your ride, but your wallet balance is insufficient to confirm. Please add balance.',
          type: 'wallet_insufficient',
          data: { dealId: dealRef.id, rideId },
        });
      }
    }

    await pushToUser(captainId, {
      title: isNegotiated ? 'New Booking Request!' : 'New Booking Confirmed!',
      body: `${dealData.customerName} wants to ride with you.${isNegotiated ? ' Tap to respond.' : ' It is confirmed.'}`,
      type: 'new_deal',
      data: { rideId, dealId: dealRef.id, screen: 'my-rides' },
    });

    return res.status(201).json({ success: true, dealId: dealRef.id, deal: dealData });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message, code: 'CREATE_DEAL_ERROR' });
  }
};

const confirmDeal = async (req, res) => {
  const { dealId } = req.params;
  const uid = req.user.uid;

  try {
    const result = await _executeConfirmTransaction(dealId, uid, { skipOwnershipCheck: false });
    return res.json({
      success: true,
      message: 'Deal confirmed',
      commissionDeducted: result.commission,
      newBalance: result.newBalance,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      success: false,
      error: err.message,
      code: err.code || 'CONFIRM_DEAL_ERROR',
      required: err.required,
      current: err.current,
    });
  }
};

const cancelDeal = async (req, res) => {
  const { dealId } = req.params;
  const uid = req.user.uid;

  try {
    const dealRef = db.collection('deals').doc(dealId);
    const dealSnap = await dealRef.get();
    if (!dealSnap.exists) {
      return res.status(404).json({ success: false, error: 'Deal not found', code: 'DEAL_NOT_FOUND' });
    }
    const deal = dealSnap.data();
    if (deal.captainId !== uid && deal.customerId !== uid) {
      return res.status(403).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    if (!ACTIVE_DEAL_STATUSES.includes(deal.status)) {
      return res.status(400).json({ success: false, error: 'Cannot cancel this deal', code: 'INVALID_STATE' });
    }

    const rideRef = db.collection('rides').doc(deal.rideId);

    await db.runTransaction(async (t) => {
      const rideDoc = await t.get(rideRef);
      if ([DEAL_STATUS.CONFIRMED, DEAL_STATUS.STARTED].includes(deal.status) && rideDoc.exists) {
        const ride = rideDoc.data();
        const { available: newSeats } = seatUpdateFromRide(ride, 1);
        t.update(rideRef, {
          availableSeats: newSeats,
          full: false,
          status: RIDE_STATUS.ACTIVE,
          updatedAt: new Date().toISOString(),
        });
      }
      t.update(dealRef, {
        status: DEAL_STATUS.CANCELLED,
        updatedAt: new Date().toISOString(),
      });
    });

    await syncRideStatusFromDeals(deal.rideId);

    if ([DEAL_STATUS.CONFIRMED, DEAL_STATUS.STARTED].includes(deal.status)) {
      await addBalance(deal.captainId, deal.platformFee, {
        type: 'refund',
        description: 'Commission refund for cancelled booking',
        reference: dealId,
      });
    }

    const notifyId = deal.customerId === uid ? deal.captainId : deal.customerId;
    await pushToUser(notifyId, {
      title: 'Booking cancelled',
      body: 'A booking was cancelled.',
      type: 'deal_cancelled',
      data: { dealId },
    });

    return res.json({ success: true, message: 'Deal cancelled' });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message, code: 'CANCEL_DEAL_ERROR' });
  }
};

const counterDeal = async (req, res) => {
  const { dealId } = req.params;
  const uid = req.user.uid;
  const { counterFare, message } = req.body;
  const parsedFare = parseFloat(counterFare);

  if (!Number.isFinite(parsedFare) || parsedFare <= 0) {
    return res.status(400).json({ success: false, error: 'counterFare must be a positive number', code: 'INVALID_COUNTER_FARE' });
  }

  try {
    const dealRef = db.collection('deals').doc(dealId);
    const dealSnap = await dealRef.get();
    if (!dealSnap.exists) {
      return res.status(404).json({ success: false, error: 'Deal not found', code: 'DEAL_NOT_FOUND' });
    }

    const deal = dealSnap.data();
    if (deal.captainId !== uid && deal.customerId !== uid) {
      return res.status(403).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    if (deal.status !== DEAL_STATUS.PENDING) {
      return res.status(400).json({ success: false, error: 'Only pending deals can be countered', code: 'INVALID_STATE' });
    }

    const isCaptain = deal.captainId === uid;
    const now = new Date().toISOString();
    const updateData = {
      agreedFare: parsedFare,
      lastCounterBy: isCaptain ? 'captain' : 'customer',
      lastCounterAt: now,
      updatedAt: now,
      isNegotiated: true,
    };
    if (message != null && String(message).trim().length > 0) {
      if (exceedsMaxLength(message, MAX_CUSTOMER_MESSAGE)) {
        return res.status(400).json({
          success: false,
          error: `message must be at most ${MAX_CUSTOMER_MESSAGE} characters`,
          code: 'FIELD_TOO_LONG',
        });
      }
      updateData.customerMessage = sanitizeString(message, MAX_CUSTOMER_MESSAGE);
    }

    await dealRef.update(updateData);

    const recipientId = isCaptain ? deal.customerId : deal.captainId;
    await pushToUser(recipientId, {
      title: isCaptain ? 'Captain sent counter fare' : 'Passenger sent counter fare',
      body: `${isCaptain ? 'Captain' : 'Passenger'} offered Rs. ${parsedFare.toFixed(0)}. Tap to respond.`,
      type: 'deal_counter',
      data: {
        dealId,
        rideId: deal.rideId || '',
        screen: isCaptain ? 'my-bookings' : 'my-rides',
      },
    });

    const updated = await dealRef.get();
    return res.json({ success: true, message: 'Counter fare sent', deal: { id: dealId, ...updated.data() } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'COUNTER_DEAL_ERROR' });
  }
};

const startDeal = async (req, res) => {
  const { dealId } = req.params;
  const uid = req.user.uid;

  try {
    const dealRef = db.collection('deals').doc(dealId);
    const dealSnap = await dealRef.get();
    if (!dealSnap.exists) {
      return res.status(404).json({ success: false, error: 'Deal not found', code: 'DEAL_NOT_FOUND' });
    }
    const deal = dealSnap.data();
    if (deal.captainId !== uid) {
      return res.status(403).json({ success: false, error: 'Only captain can start ride', code: 'UNAUTHORIZED' });
    }
    if (deal.status !== DEAL_STATUS.CONFIRMED) {
      return res.status(400).json({ success: false, error: 'Ride must be confirmed first', code: 'INVALID_STATE' });
    }

    const startedAt = new Date().toISOString();
    await dealRef.update({
      status: DEAL_STATUS.STARTED,
      startedAt,
      boardingStatus: 'arrived',
      updatedAt: startedAt,
    });

    await syncRideStatusFromDeals(deal.rideId);

    if (deal.customerId) {
      await pushToUser(deal.customerId, {
        title: 'Ride started',
        body: 'Your captain has started the ride. Track them on the map.',
        type: 'ride_started',
        data: { rideId: deal.rideId, dealId },
      });
    }

    return res.json({ success: true, message: 'Ride started for this passenger' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'START_DEAL_ERROR' });
  }
};

const completeDeal = async (req, res) => {
  const { dealId } = req.params;
  const uid = req.user.uid;

  try {
    const dealRef = db.collection('deals').doc(dealId);
    const dealSnap = await dealRef.get();
    if (!dealSnap.exists) {
      return res.status(404).json({ success: false, error: 'Deal not found', code: 'DEAL_NOT_FOUND' });
    }
    const deal = dealSnap.data();
    if (deal.customerId !== uid) {
      return res.status(403).json({ success: false, error: 'Only passenger can complete ride', code: 'UNAUTHORIZED' });
    }
    if (![DEAL_STATUS.CONFIRMED, DEAL_STATUS.STARTED].includes(deal.status)) {
      return res.status(400).json({ success: false, error: 'Ride must be confirmed or started first', code: 'INVALID_STATE' });
    }

    const fare = parseFloat(deal.agreedFare);

    await deductBalance(deal.customerId, fare, {
      type: 'ride_payment',
      description: `Fare payment for ride to ${deal.rideId}`,
      dealId,
    });

    await addBalance(deal.captainId, fare, {
      type: 'ride_earning',
      description: `Fare earned from completed ride`,
      reference: dealId,
    });

    await dealRef.update({
      status: DEAL_STATUS.COMPLETED,
      completedAt: new Date().toISOString(),
    });

    await db.collection('users').doc(deal.captainId).set(
      {
        completedRides: (await getCaptainReviewSummary(deal.captainId, 0)).totalCompletedRides,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );

    await maybeCompleteRide(deal.rideId);

    await pushToUser(deal.captainId, {
      title: 'Ride completed',
      body: `Rs. ${fare} has been credited to your wallet.`,
      type: 'ride_completed',
      data: { dealId },
    });

    return res.json({ success: true, message: 'Ride completed' });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message, code: 'COMPLETE_DEAL_ERROR' });
  }
};

const getDeal = async (req, res) => {
  try {
    const doc = await db.collection('deals').doc(req.params.dealId).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'Deal not found', code: 'DEAL_NOT_FOUND' });
    }
    let deal = { id: doc.id, ...doc.data() };
    deal = await populateRide(deal);

    const uid = req.user.uid;
    if (deal.customerId !== uid && deal.captainId !== uid) {
      return res.status(403).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    if (deal.captainId) {
      const captain = await db.collection('users').doc(deal.captainId).get();
      const phoneRevealed = deal.phoneRevealed === true;
      const fullCaptainPhone = deal.captainPhone || (captain.exists ? captain.data().phone : '');
      deal.captainPhone = phoneRevealed ? fullCaptainPhone : maskCaptainPhone(fullCaptainPhone);
      if (captain.exists) {
        deal.captain = {
          name: captain.data().name,
          phone: deal.captainPhone,
          rating: captain.data().rating,
          vehicleMake: captain.data().vehicleMake,
          vehicleModel: captain.data().vehicleModel,
          vehicleColor: captain.data().vehicleColor,
          vehicleRegistration: captain.data().vehicleRegistration,
        };
      }
    }

    if (deal.customerId) {
      const customer = await db.collection('users').doc(deal.customerId).get();
      if (customer.exists) {
        deal.customer = {
          name: customer.data().name,
          phone: deal.customerPhone || customer.data().phone || '',
          rating: customer.data().rating || 0,
        };
      }
    }

    return res.json({ success: true, deal: normalizeBooking(deal) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_DEAL_ERROR' });
  }
};

const rateDeal = async (req, res) => {
  const { dealId } = req.params;
  const uid = req.user.uid;
  const { rating, review } = req.body;
  const parsedRating = Number(rating);

  if (!Number.isFinite(parsedRating) || parsedRating < 1 || parsedRating > 5) {
    return res.status(400).json({ success: false, error: 'Rating must be 1-5', code: 'INVALID_RATING' });
  }

  if (exceedsMaxLength(review, MAX_REVIEW)) {
    return res.status(400).json({
      success: false,
      error: `review must be at most ${MAX_REVIEW} characters`,
      code: 'FIELD_TOO_LONG',
    });
  }
  const sanitizedReview = sanitizeString(review, MAX_REVIEW);

  try {
    const dealRef = db.collection('deals').doc(dealId);
    const dealSnap = await dealRef.get();
    if (!dealSnap.exists) {
      return res.status(404).json({ success: false, error: 'Deal not found', code: 'DEAL_NOT_FOUND' });
    }
    const deal = dealSnap.data();
    if (deal.status !== DEAL_STATUS.COMPLETED) {
      return res.status(400).json({ success: false, error: 'Cannot rate this deal', code: 'INVALID_STATE' });
    }
    const isCustomerRatingCaptain = deal.customerId === uid;
    const isCaptainRatingCustomer = deal.captainId === uid;
    if (!isCustomerRatingCaptain && !isCaptainRatingCustomer) {
      return res.status(403).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const targetUserId = isCustomerRatingCaptain ? deal.captainId : deal.customerId;
    const ratingField = isCustomerRatingCaptain ? 'rating' : 'customerRating';
    const reviewField = isCustomerRatingCaptain ? 'review' : 'customerReview';
    const ratedAtField = isCustomerRatingCaptain ? 'ratedAt' : 'customerRatedAt';
    const targetRef = db.collection('users').doc(targetUserId);

    await db.runTransaction(async (t) => {
      const freshDealDoc = await t.get(dealRef);
      if (!freshDealDoc.exists) throw Object.assign(new Error('Deal not found'), { code: 'DEAL_NOT_FOUND' });
      const freshDeal = freshDealDoc.data();
      if (freshDeal.status !== DEAL_STATUS.COMPLETED) {
        throw Object.assign(new Error('Cannot rate this deal'), { code: 'INVALID_STATE' });
      }
      if (freshDeal[ratingField] != null) {
        throw Object.assign(new Error('Already rated'), { code: 'ALREADY_RATED' });
      }

      const targetDoc = await t.get(targetRef);
      const target = targetDoc.data() || {};
      const currentRating = Number(target.rating || 0);
      const reviewCount = Number(target.reviewCount || target.totalReviews || 0);
      const completedRides = Number(target.completedRides || target.totalRides || 0);
      const newAvg = (currentRating * reviewCount + parsedRating) / (reviewCount + 1);
      const now = new Date().toISOString();
      const userUpdate = {
        rating: parseFloat(newAvg.toFixed(2)),
        averageRating: parseFloat(newAvg.toFixed(2)),
        reviewCount: reviewCount + 1,
        totalReviews: reviewCount + 1,
        updatedAt: now,
      };
      if (isCustomerRatingCaptain) {
        userUpdate.completedRides = completedRides;
        userUpdate.totalRides = Math.max(Number(target.totalRides || 0), completedRides);
      }
      t.set(targetRef, userUpdate, { merge: true });
      t.update(dealRef, {
        [ratingField]: parseFloat(parsedRating.toFixed(1)),
        [reviewField]: sanitizedReview,
        [ratedAtField]: now,
        updatedAt: now,
      });
    });

    return res.json({ success: true, message: 'Rating submitted' });
  } catch (err) {
    const status = ['ALREADY_RATED', 'INVALID_STATE', 'DEAL_NOT_FOUND'].includes(err.code) ? 400 : 500;
    return res.status(status).json({ success: false, error: err.message, code: err.code || 'RATE_DEAL_ERROR' });
  }
};

/**
 * ✅ getMyBookings – optimized: skips ride fetch for denormalized deals, clean cursor pagination
 */
const getMyBookings = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    // Build base query ordered by createdAt descending
    let query = db.collection('deals')
      .where('customerId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(limit);

    // ✅ FIXED: Use createdAt ISO string directly as cursor value.
    // Firestore allows startAfter() with a raw field value when the query
    // is ordered by that field — no second round-trip needed.
    if (req.query.startAfter) {
      query = query.startAfter(req.query.startAfter);
    }

    const snap = await query.get();
    const now = Date.now();
    const dealsToPopulate = [];

    for (const doc of snap.docs) {
      const deal = { id: doc.id, ...doc.data() };
      const status = (deal.status || '').toString().toLowerCase();

      // ✅ Exclude terminal deals older than BOOKING_RETENTION_MS (24 hours)
      if ([DEAL_STATUS.COMPLETED, DEAL_STATUS.CANCELLED].includes(status)) {
        // Prefer completedAt, then updatedAt, then createdAt
        const terminalAtRaw = deal.completedAt || deal.updatedAt || deal.createdAt || null;
        const terminalAt = terminalAtRaw ? new Date(terminalAtRaw).getTime() : NaN;
        if (Number.isFinite(terminalAt) && now - terminalAt > BOOKING_RETENTION_MS) {
          continue; // Skip – older than retention window
        }
      }
      dealsToPopulate.push(deal);
    }

    // ✅ OPTIMIZED: Skip populateRide() for deals that already carry a denormalized
    // ride snapshot (set at deal creation time). Only fetch from Firestore for
    // legacy deals that lack the embedded snapshot.
    const populatedDeals = await Promise.all(
      dealsToPopulate.map(deal => (deal.ride ? Promise.resolve(deal) : populateRide(deal)))
    );

    const bookings = populatedDeals.map(deal => {
      const phoneRevealed = deal.phoneRevealed === true;
      const fullCaptainPhone = deal.captainPhone || '';
      deal.captainPhone = phoneRevealed ? fullCaptainPhone : maskCaptainPhone(fullCaptainPhone);
      return normalizeBooking(deal);
    });

    const hasMore = snap.docs.length === limit && bookings.length > 0;
    const nextCursor = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1].data().createdAt : null;

    return res.json({
      success: true,
      bookings,
      hasMore,
      nextCursor,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_MY_BOOKINGS_ERROR' });
  }
};

/**
 * ✅ getMyDeals – parallel ride fetch, no pagination (can be added later)
 */
const getMyDeals = async (req, res) => {
  try {
    const captainId = req.user.uid;
    const snap = await db
      .collection('deals')
      .where('captainId', '==', captainId)
      .orderBy('createdAt', 'desc')
      .get();

    const now = Date.now();
    const deals = [];
    for (const doc of snap.docs) {
      let deal = { id: doc.id, ...doc.data() };
      const status = (deal.status || '').toString().toLowerCase();

      if ([DEAL_STATUS.COMPLETED, DEAL_STATUS.CANCELLED].includes(status)) {
        const terminalAtRaw = deal.completedAt || deal.updatedAt || deal.createdAt || null;
        const terminalAt = terminalAtRaw ? new Date(terminalAtRaw).getTime() : NaN;
        if (Number.isFinite(terminalAt) && Date.now() - terminalAt > BOOKING_RETENTION_MS) {
          continue;
        }
      }
      deals.push(deal);
    }

    const populatedDeals = await Promise.all(deals.map(async (deal) => {
      deal = await populateRide(deal);
      if (deal.customerId) {
        const customer = await db.collection('users').doc(deal.customerId).get();
        if (customer.exists) {
          const customerData = customer.data();
          deal.customer = {
            name: customerData.name || 'Customer',
            phone: customerData.phone || '',
            rating: customerData.rating || 0,
          };
          deal.customerName = customerData.name || 'Customer';
          deal.customerPhone = customerData.phone || '';
        }
      }
      return deal;
    }));

    const result = populatedDeals.map(deal => ({
      ...deal,
      tabStatus: normalizeBooking(deal).tabStatus,
      displayStatus: deal.status,
    }));

    return res.json({
      success: true,
      deals: result,
      count: result.length,
    });
  } catch (err) {
    console.error('Error in getMyDeals:', err);
    return res.status(500).json({
      success: false,
      error: err.message,
      code: 'GET_MY_DEALS_ERROR',
    });
  }
};

const getConfirmedPassengers = async (req, res) => {
  const { rideId } = req.params;
  const uid = req.user.uid;

  try {
    const rideDoc = await db.collection('rides').doc(rideId).get();
    if (!rideDoc.exists) {
      return res.status(404).json({ success: false, error: 'Ride not found', code: 'RIDE_NOT_FOUND' });
    }
    const ride = rideDoc.data();
    const isCaptain = ride.captainId === uid;

    const snap = await db
      .collection('deals')
      .where('rideId', '==', rideId)
      .where('status', 'in', [DEAL_STATUS.CONFIRMED, DEAL_STATUS.STARTED, DEAL_STATUS.COMPLETED])
      .get();

    const passengers = snap.docs
      .map((doc) => {
        const d = { id: doc.id, ...doc.data() };
        const fullName = d.customerName || 'Passenger';
        const firstName = fullName.split(' ')[0];
        const base = {
          dealId: doc.id,
          firstName,
          boardingStatus: d.boardingStatus || 'waiting',
          pickupOrder: d.pickupOrder ?? 0,
          agreedFare: d.agreedFare,
        };
        if (isCaptain) {
          return {
            ...base,
            customerId: d.customerId,
            customerName: fullName,
            customerPhone: d.customerPhone,
            passengerPickupLat: d.passengerPickupLat,
            passengerPickupLng: d.passengerPickupLng,
            passengerPickupAddress: d.passengerPickupAddress,
            passengerDropLat: d.passengerDropLat,
            passengerDropLng: d.passengerDropLng,
            passengerDropAddress: d.passengerDropAddress,
            customerMessage: d.customerMessage || '',
            status: d.status,
          };
        }
        if (d.customerId === uid) {
          return {
            ...base,
            customerId: d.customerId,
            passengerPickupLat: d.passengerPickupLat,
            passengerPickupLng: d.passengerPickupLng,
            passengerPickupAddress: d.passengerPickupAddress,
            status: d.status,
          };
        }
        return {
          ...base,
          pickupArea: generalPickupArea(d.passengerPickupAddress),
        };
      })
      .filter((p) => isCaptain || p.customerId === uid || (p.pickupArea != null && p.pickupArea !== ''));

    passengers.sort((a, b) => (a.pickupOrder || 0) - (b.pickupOrder || 0));

    return res.json({
      success: true,
      ride: {
        id: rideId,
        totalSeats: ride.totalSeats,
        availableSeats: ride.availableSeats,
        full: ride.full === true || (ride.availableSeats || 0) <= 0,
      },
      passengers,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'CONFIRMED_PASSENGERS_ERROR' });
  }
};

const updateBoardingStatus = async (req, res) => {
  const { dealId } = req.params;
  const uid = req.user.uid;
  const { boardingStatus } = req.body;

  const allowed = ['waiting', 'arrived', 'boarded', 'dropped'];
  if (!allowed.includes(boardingStatus)) {
    return res.status(400).json({ success: false, error: 'Invalid boarding status', code: 'INVALID_STATUS' });
  }

  try {
    const dealRef = db.collection('deals').doc(dealId);
    const dealSnap = await dealRef.get();
    if (!dealSnap.exists) {
      return res.status(404).json({ success: false, error: 'Deal not found', code: 'DEAL_NOT_FOUND' });
    }
    const deal = dealSnap.data();
    if (deal.captainId !== uid) {
      return res.status(403).json({ success: false, error: 'Only captain can update boarding', code: 'UNAUTHORIZED' });
    }
    if (![DEAL_STATUS.CONFIRMED, DEAL_STATUS.STARTED].includes(deal.status)) {
      return res.status(400).json({ success: false, error: 'Ride not active', code: 'INVALID_STATE' });
    }

    await dealRef.update({
      boardingStatus,
      updatedAt: new Date().toISOString(),
    });

    if (boardingStatus === 'arrived' && deal.customerId) {
      await pushToUser(deal.customerId, {
        title: 'Captain has arrived',
        body: 'Your captain has arrived at the pickup point.',
        type: 'captain_arrived',
        data: { dealId, rideId: deal.rideId },
      });
    }

    if (boardingStatus === 'boarded' && deal.customerId) {
      await pushToUser(deal.customerId, {
        title: 'You are boarded',
        body: 'The captain marked you as boarded.',
        type: 'passenger_boarded',
        data: { dealId, rideId: deal.rideId },
      });
    }

    return res.json({ success: true, message: 'Boarding status updated' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'BOARDING_UPDATE_ERROR' });
  }
};

const getRideDeals = async (req, res) => {
  const { rideId } = req.params;
  try {
    const rideDoc = await db.collection('rides').doc(rideId).get();
    if (!rideDoc.exists) {
      return res.status(404).json({ success: false, error: 'Ride not found', code: 'RIDE_NOT_FOUND' });
    }
    if (rideDoc.data().captainId !== req.user.uid) {
      return res.status(403).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const snap = await db
      .collection('deals')
      .where('rideId', '==', rideId)
      .orderBy('createdAt', 'desc')
      .get();

    const deals = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const populatedDeals = await Promise.all(deals.map(async (deal) => {
      const phoneRevealed = deal.phoneRevealed === true;
      const fullCaptainPhone = deal.captainPhone || '';
      deal.captainPhone = phoneRevealed ? fullCaptainPhone : maskCaptainPhone(fullCaptainPhone);
      if (deal.customerId) {
        const customer = await db.collection('users').doc(deal.customerId).get();
        if (customer.exists) {
          const customerPhone = (deal.customerPhone || customer.data().phone || '').toString().trim();
          deal.customer = {
            name: customer.data().name,
            phone: customerPhone,
            rating: customer.data().rating || 0,
          };
          deal.customerPhone = customerPhone;
        }
      }
      return deal;
    }));

    return res.json({
      success: true,
      deals: populatedDeals,
      ride: {
        totalSeats: rideDoc.data().totalSeats,
        availableSeats: rideDoc.data().availableSeats,
        full: rideDoc.data().full === true || (rideDoc.data().availableSeats || 0) <= 0,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_RIDE_DEALS_ERROR' });
  }
};

const notifyDealMessage = async (req, res) => {
  const { dealId } = req.params;
  const uid = req.user.uid;
  const { text } = req.body;

  try {
    const dealSnap = await db.collection('deals').doc(dealId).get();
    if (!dealSnap.exists) {
      return res.status(404).json({ success: false, error: 'Deal not found', code: 'DEAL_NOT_FOUND' });
    }
    const deal = dealSnap.data();
    if (deal.customerId !== uid && deal.captainId !== uid) {
      return res.status(403).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const recipientId = deal.customerId === uid ? deal.captainId : deal.customerId;
    const preview = (text || 'New message').toString().slice(0, 80);

    await pushToUser(recipientId, {
      title: 'New message',
      body: preview,
      type: 'deal_message',
      data: { dealId, rideId: deal.rideId || '' },
    });

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'NOTIFY_MESSAGE_ERROR' });
  }
};

const getCaptainProfile = async (req, res) => {
  const captainId = req.params.captainId || req.query.captainId;
  if (!captainId) {
    return res.status(400).json({ success: false, error: 'Captain ID is required', code: 'MISSING_CAPTAIN_ID' });
  }

  try {
    const captainDoc = await db.collection('users').doc(captainId).get();
    if (!captainDoc.exists) {
      return res.status(404).json({ success: false, error: 'Captain not found', code: 'CAPTAIN_NOT_FOUND' });
    }

    const captain = captainDoc.data() || {};
    const summary = await getCaptainReviewSummary(captainId, 5);
    const userUpdate = {
      rating: summary.averageRating,
      averageRating: summary.averageRating,
      reviewCount: summary.reviewCount,
      totalReviews: summary.reviewCount,
      completedRides: summary.totalCompletedRides,
      totalRides: Math.max(Number(captain.totalRides || 0), summary.totalCompletedRides),
      updatedAt: new Date().toISOString(),
    };
    await captainDoc.ref.set(userUpdate, { merge: true });

    return res.json({
      success: true,
      captain: {
        id: captainId,
        uid: captainId,
        email: captain.email || '',
        name: captain.name || '',
        phone: captain.phone || '',
        role: 'captain',
        gender: captain.gender || null,
        isVerified: captain.isVerified === true,
        captainVerificationStatus: captain.captainVerificationStatus || null,
        vehicleMake: captain.vehicleMake || null,
        vehicleModel: captain.vehicleModel || null,
        vehicleColor: captain.vehicleColor || null,
        vehicleRegistration: captain.vehicleRegistration || null,
        vehicleYear: captain.vehicleYear || null,
        vehicleSeats: captain.vehicleSeats || null,
        city: captain.city || null,
        vehiclePhotoUrl: captain.vehiclePhotoUrl || null,
        captainVehicleType: captain.captainVehicleType || null,
        createdAt: captain.createdAt || new Date().toISOString(),
        ...userUpdate,
        recentReviews: summary.recentReviews,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'CAPTAIN_PROFILE_ERROR' });
  }
};

module.exports = {
  createDeal,
  confirmDeal,
  cancelDeal,
  counterDeal,
  startDeal,
  completeDeal,
  getDeal,
  rateDeal,
  getMyBookings,
  getMyDeals,
  getRideDeals,
  getConfirmedPassengers,
  updateBoardingStatus,
  notifyDealMessage,
  getCaptainProfile,
};
