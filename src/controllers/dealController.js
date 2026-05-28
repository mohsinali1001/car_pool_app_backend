const { db } = require('../config/firebase');
const { deductBalance, addBalance } = require('../utils/walletHelper');
const { pushToUser } = require('../utils/notificationHelper');
const { RIDE_STATUS, DEAL_STATUS, ACTIVE_DEAL_STATUSES } = require('../constants/statuses');

const PLATFORM_FEE_PERCENT = 0.05;

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

/** Apply seat delta inside a transaction; returns new available seat count. */
function seatUpdateFromRide(ride, delta) {
  const totalSeats = ride.totalSeats ?? ride.availableSeats ?? 0;
  let available = ride.availableSeats ?? totalSeats;
  available += delta;
  if (available < 0) throw new Error('Ride is full');
  if (available > totalSeats) available = totalSeats;
  return { available, totalSeats };
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

async function populateRide(deal) {
  if (!deal.rideId) return deal;
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
    suggestedFare: ride.suggestedFare,
    status: ride.status,
    availableSeats: ride.availableSeats,
    totalSeats: ride.totalSeats,
    full: ride.full === true || (ride.availableSeats || 0) <= 0,
  };
  return deal;
}

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

  const pickupLat = parseCoord(passengerPickupLat);
  const pickupLng = parseCoord(passengerPickupLng);
  if (pickupLat == null || pickupLng == null || !passengerPickupAddress) {
    return res.status(400).json({
      success: false,
      error: 'Passenger pickup location is required',
      code: 'MISSING_PICKUP',
    });
  }

  try {
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

    const rideRef = db.collection('rides').doc(rideId);
    const dealRef = db.collection('deals').doc();
    const platformFee = parseFloat(agreedFare) * PLATFORM_FEE_PERCENT;
    const captainDoc = await rideRef.get();
    if (!captainDoc.exists) {
      return res.status(404).json({ success: false, error: 'Ride not found', code: 'RIDE_NOT_FOUND' });
    }
    const captainId = captainDoc.data().captainId;
    const captainUserDoc = await db.collection('users').doc(captainId).get();
    const captainPhone = captainUserDoc.exists ? (captainUserDoc.data().phone || '') : '';

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
        captainId: rideData.captainId,
        customerId: uid,
        customerName: userDoc.data().name || 'Guest',
        customerPhone: userDoc.data().phone || '',
        captainPhone,
        phoneRevealed: false,
        agreedFare: parseFloat(agreedFare),
        platformFee,
        status: DEAL_STATUS.PENDING,
        customerMessage: customerMessage || '',
        passengerPickupLat: pickupLat,
        passengerPickupLng: pickupLng,
        passengerPickupAddress: String(passengerPickupAddress).trim(),
        passengerDropLat: dropLat ?? rideData.endLat ?? 0,
        passengerDropLng: dropLng ?? rideData.endLng ?? 0,
        passengerDropAddress: (passengerDropAddress || rideData.endLocation || '').trim(),
        pickupOrder: null,
        boardingStatus: 'waiting',
        rating: null,
        review: null,
        confirmedAt: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
      };
      t.set(dealRef, data);
      return data;
    });

    await pushToUser(dealData.captainId, {
      title: 'New Booking Request!',
      body: `${dealData.customerName} wants to ride with you. Tap to respond.`,
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
    const dealRef = db.collection('deals').doc(dealId);
    const dealSnap = await dealRef.get();
    if (!dealSnap.exists) {
      return res.status(404).json({ success: false, error: 'Deal not found', code: 'DEAL_NOT_FOUND' });
    }
    const deal = dealSnap.data();
    if (deal.captainId !== uid) {
      return res.status(403).json({ success: false, error: 'Not your deal', code: 'UNAUTHORIZED' });
    }
    if (deal.status !== DEAL_STATUS.PENDING) {
      return res.status(400).json({ success: false, error: 'Deal already processed', code: 'INVALID_STATE' });
    }

    const commission = parseFloat(deal.agreedFare || 0) * PLATFORM_FEE_PERCENT;
    const walletRef = db.collection('wallets').doc(uid);
    const walletSnap = await walletRef.get();
    const currentBalance = walletSnap.exists ? Number(walletSnap.data().balance || 0) : 0;

    if (currentBalance < commission) {
      return res.status(400).json({
        success: false,
        code: 'INSUFFICIENT_BALANCE',
        error: 'Insufficient wallet balance to confirm deal',
        required: commission,
        current: currentBalance,
      });
    }

    const newBalance = currentBalance - commission;
    const now = new Date().toISOString();

    await walletRef.set(
      {
        id: uid,
        userId: uid,
        balance: newBalance,
        updatedAt: now,
      },
      { merge: true },
    );

    await db.collection('transactions').add({
      walletId: uid,
      type: 'commission',
      amount: commission,
      reference: dealId,
      description: `5% commission for deal ${dealId}`,
      balanceAfter: newBalance,
      createdAt: now,
    });

    await dealRef.update({
      status: DEAL_STATUS.CONFIRMED,
      phoneRevealed: true,
      confirmedAt: now,
      updatedAt: now,
    });

    await pushToUser(deal.customerId, {
      title: 'Booking confirmed',
      body: 'Your ride booking has been confirmed.',
      type: 'deal_confirmed',
      data: { dealId },
    });

    return res.json({
      success: true,
      message: 'Deal confirmed',
      commissionDeducted: commission,
      newBalance,
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message, code: 'CONFIRM_DEAL_ERROR' });
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
    };
    if (message != null && String(message).trim().isNotEmpty) {
      updateData.customerMessage = String(message).trim();
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

    const confirmedSnap = await db
      .collection('deals')
      .where('rideId', '==', deal.rideId)
      .where('status', '==', DEAL_STATUS.CONFIRMED)
      .get();

    const startedAt = new Date().toISOString();
    const batch = db.batch();
    for (const doc of confirmedSnap.docs) {
      batch.update(doc.ref, {
        status: DEAL_STATUS.STARTED,
        startedAt,
      });
    }
    await batch.commit();

    await db.collection('rides').doc(deal.rideId).update({
      status: RIDE_STATUS.IN_PROGRESS,
      startedAt,
      updatedAt: startedAt,
    });

    const notifyIds = new Set(confirmedSnap.docs.map((d) => d.data().customerId));
    await Promise.all(
      [...notifyIds].map((customerId) =>
        pushToUser(customerId, {
          title: 'Ride started',
          body: 'Your captain has started the ride. Track them on the map.',
          type: 'ride_started',
          data: { rideId: deal.rideId },
        }),
      ),
    );

    return res.json({ success: true, message: 'Ride started for all passengers' });
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

    return res.json({ success: true, deal });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_DEAL_ERROR' });
  }
};

const rateDeal = async (req, res) => {
  const { dealId } = req.params;
  const uid = req.user.uid;
  const { rating, review } = req.body;

  if (rating == null || rating < 1 || rating > 5) {
    return res.status(400).json({ success: false, error: 'Rating must be 1–5', code: 'INVALID_RATING' });
  }

  try {
    const dealRef = db.collection('deals').doc(dealId);
    const dealSnap = await dealRef.get();
    if (!dealSnap.exists) {
      return res.status(404).json({ success: false, error: 'Deal not found', code: 'DEAL_NOT_FOUND' });
    }
    const deal = dealSnap.data();
    if (deal.customerId !== uid) {
      return res.status(403).json({ success: false, error: 'Only customer can rate', code: 'UNAUTHORIZED' });
    }
    if (deal.status !== DEAL_STATUS.COMPLETED) {
      return res.status(400).json({ success: false, error: 'Cannot rate this deal', code: 'INVALID_STATE' });
    }
    if (deal.rating != null) {
      return res.status(400).json({ success: false, error: 'Already rated', code: 'ALREADY_RATED' });
    }

    const captainRef = db.collection('users').doc(deal.captainId);
    await db.runTransaction(async (t) => {
      const captainDoc = await t.get(captainRef);
      const currentRating = captainDoc.data()?.rating || 0;
      const totalRides = captainDoc.data()?.totalRides || 0;
      const newAvg = (currentRating * totalRides + rating) / (totalRides + 1);
      t.update(captainRef, {
        rating: parseFloat(newAvg.toFixed(2)),
        totalRides: totalRides + 1,
        updatedAt: new Date().toISOString(),
      });
      t.update(dealRef, {
        rating: parseFloat(rating),
        review: review || '',
        updatedAt: new Date().toISOString(),
      });
    });

    return res.json({ success: true, message: 'Rating submitted' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'RATE_DEAL_ERROR' });
  }
};

const getMyBookings = async (req, res) => {
  try {
    const snap = await db
      .collection('deals')
      .where('customerId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .get();

    const bookings = [];
    for (const doc of snap.docs) {
      let deal = { id: doc.id, ...doc.data() };
      const phoneRevealed = deal.phoneRevealed === true;
      const fullCaptainPhone = deal.captainPhone || '';
      deal.captainPhone = phoneRevealed ? fullCaptainPhone : maskCaptainPhone(fullCaptainPhone);
      deal = await populateRide(deal);
      bookings.push(deal);
    }
    return res.json({ success: true, bookings });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_MY_BOOKINGS_ERROR' });
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

  const allowed = ['waiting', 'boarded', 'dropped'];
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

    const deals = [];
    for (const doc of snap.docs) {
      const deal = { id: doc.id, ...doc.data() };
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
      deals.push(deal);
    }
    return res.json({
      success: true,
      deals,
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
  getRideDeals,
  getConfirmedPassengers,
  updateBoardingStatus,
  notifyDealMessage,
};
