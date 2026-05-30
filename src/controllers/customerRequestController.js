const { db } = require('../config/firebase');
const { pushToUser } = require('../utils/notificationHelper');
const { normalizeRouteLabels } = require('../utils/aiLocationHelper');
const { labelFromLocation } = require('../utils/locationLabelHelper');

function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function distanceScore(aLat, aLng, bLat, bLng) {
  if ([aLat, aLng, bLat, bLng].some((v) => v == null)) return Number.MAX_SAFE_INTEGER;
  const dLat = aLat - bLat;
  const dLng = aLng - bLng;
  return dLat * dLat + dLng * dLng;
}

function distanceKm(aLat, aLng, bLat, bLng) {
  if ([aLat, aLng, bLat, bLng].some((v) => v == null)) return null;
  const toRad = (value) => (value * Math.PI) / 180;
  const earthKm = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return earthKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function isValidLat(value) {
  return value != null && value >= -90 && value <= 90;
}

function isValidLng(value) {
  return value != null && value >= -180 && value <= 180;
}

function isZeroCoordinate(lat, lng) {
  return Number(lat) === 0 && Number(lng) === 0;
}

async function attachOffers(request) {
  const snap = await db
    .collection('customerRideOffers')
    .where('requestId', '==', request.id)
    .orderBy('createdAt', 'desc')
    .get();
  request.offers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return request;
}

async function cleanupExpiredOpenRequests() {
  const now = new Date();
  const snap = await db
    .collection('customerRideRequests')
    .where('status', 'in', ['open', 'countered'])
    .limit(100)
    .get();

  const batch = db.batch();
  let writes = 0;

  for (const doc of snap.docs) {
    const request = doc.data() || {};
    const requestedAt = new Date(request.requestedAt || '');
    if (Number.isNaN(requestedAt.getTime()) || requestedAt >= now) continue;

    const offersSnap = await db
      .collection('customerRideOffers')
      .where('requestId', '==', doc.id)
      .get();
    for (const offer of offersSnap.docs) {
      batch.delete(offer.ref);
      writes += 1;
    }
    batch.delete(doc.ref);
    writes += 1;
  }

  if (writes > 0) await batch.commit();
}

function requestDistance(captainLat, captainLng, request) {
  const km = distanceKm(captainLat, captainLng, request.startLat, request.startLng);
  return {
    distanceKm: km == null ? null : Number(km.toFixed(2)),
    isNearby: km != null && km <= 20,
  };
}

const createCustomerRequest = async (req, res) => {
  const uid = req.user.uid;
  const {
    startLocation,
    endLocation,
    pickupLocation,
    dropLocation,
    vehicleType,
    rideMode,
    desiredFare,
    requestedAt,
    startLat,
    startLng,
    endLat,
    endLng,
    pickupLat,
    pickupLng,
    dropLat,
    dropLng,
    customerLat,
    customerLng,
    city,
  } = req.body;

  const rawPickupLocation = labelFromLocation(pickupLocation);
  const rawDropLocation = labelFromLocation(dropLocation);
  const rawStartLocation = labelFromLocation(startLocation) || rawPickupLocation;
  const rawEndLocation = labelFromLocation(endLocation) || rawDropLocation;
  const parsedStartLat = parseNumber(startLat ?? pickupLat);
  const parsedStartLng = parseNumber(startLng ?? pickupLng);
  const parsedEndLat = parseNumber(endLat ?? dropLat);
  const parsedEndLng = parseNumber(endLng ?? dropLng);
  const parsedRequestedAt = requestedAt
    ? new Date(requestedAt)
    : new Date(Date.now() + 60 * 60 * 1000);

  if (!rawStartLocation || !rawEndLocation) {
    return res.status(400).json({
      success: false,
      error: 'startLocation and endLocation are required',
      code: 'MISSING_FIELDS',
    });
  }

  if (
    !isValidLat(parsedStartLat) ||
    !isValidLng(parsedStartLng) ||
    !isValidLat(parsedEndLat) ||
    !isValidLng(parsedEndLng) ||
    isZeroCoordinate(parsedStartLat, parsedStartLng) ||
    isZeroCoordinate(parsedEndLat, parsedEndLng)
  ) {
    return res.status(400).json({
      success: false,
      error: 'Map pickup and drop coordinates are required',
      code: 'MAP_COORDINATES_REQUIRED',
    });
  }

  if (Number.isNaN(parsedRequestedAt.getTime())) {
    return res.status(400).json({ success: false, error: 'requestedAt is invalid', code: 'INVALID_REQUESTED_AT' });
  }

  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
    }
    const user = userDoc.data();
    const customerGender = (user.gender || '').toString().trim().toLowerCase();
    const normalizedVehicleType = String(vehicleType || 'car').toLowerCase();
    const normalizedRideMode = String(rideMode || 'solo').toLowerCase();
    if (!['car', 'bike', 'bus', 'truck', 'shazore'].includes(normalizedVehicleType)) {
      return res.status(400).json({ success: false, error: 'Invalid vehicleType', code: 'INVALID_VEHICLE_TYPE' });
    }
    if (!['solo', 'share'].includes(normalizedRideMode)) {
      return res.status(400).json({ success: false, error: 'rideMode must be solo or share', code: 'INVALID_RIDE_MODE' });
    }

    const normalizedLabels = await normalizeRouteLabels({
      startLocation: rawStartLocation,
      endLocation: rawEndLocation,
      exactPickup: pickupLocation,
      exactDrop: dropLocation,
      city: city || user.city,
    });

    const now = new Date().toISOString();
    const ref = db.collection('customerRideRequests').doc();
    const request = {
      id: ref.id,
      customerId: uid,
      customerName: user.name || 'Customer',
      customerPhone: user.phone || '',
      startLocation: normalizedLabels.startLocation,
      endLocation: normalizedLabels.endLocation,
      pickupLocation: rawPickupLocation || rawStartLocation,
      dropLocation: rawDropLocation || rawEndLocation,
      customerGender: customerGender || null,
      isLadiesRequest: customerGender === 'female',
      requestedAt: parsedRequestedAt.toISOString(),
      vehicleType: normalizedVehicleType,
      rideMode: normalizedRideMode,
      desiredFare: parseNumber(desiredFare),
      finalFare: null,
      acceptedOfferId: null,
      acceptedCaptainId: null,
      acceptedCaptainPhone: null,
      captainPhoneRevealed: false,
      customerPhoneRevealed: false,
      startLat: parsedStartLat,
      startLng: parsedStartLng,
      endLat: parsedEndLat,
      endLng: parsedEndLng,
      customerLat: parseNumber(customerLat),
      customerLng: parseNumber(customerLng),
      city: (city || user.city || '').toString().trim(),
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };

    await ref.set(request);

    try {
      const captainsSnap = await db.collection('users').where('role', '==', 'captain').get();
      const targets = captainsSnap.docs.filter((doc) => {
        const captain = doc.data() || {};
        return Boolean(captain.fcmToken);
      });
      await Promise.all(targets.map((doc) =>
        pushToUser(doc.id, {
          title: 'New Customer Request',
          body: `${request.customerName} needs a ride from ${request.startLocation} to ${request.endLocation}. ${request.pickupLocation ? `Pickup: ${request.pickupLocation}.` : ''}${request.dropLocation ? ` Drop: ${request.dropLocation}.` : ''}`,
          type: 'customer_request',
          data: { requestId: ref.id, screen: 'customer-requests' },
        }),
      ));
    } catch (notifyErr) {
      console.error('Customer request notification error:', notifyErr.message);
    }

    return res.status(201).json({ success: true, request });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'CREATE_CUSTOMER_REQUEST_ERROR' });
  }
};

const getOpenCustomerRequests = async (req, res) => {
  const uid = req.user.uid;
  try {
    await cleanupExpiredOpenRequests();
    const captainDoc = await db.collection('users').doc(uid).get();
    if (!captainDoc.exists) {
      return res.status(404).json({ success: false, error: 'Captain not found', code: 'USER_NOT_FOUND' });
    }
    const captain = captainDoc.data();
    const captainLat = parseNumber(req.query.lat);
    const captainLng = parseNumber(req.query.lng);
    const snap = await db
      .collection('customerRideRequests')
      .where('status', 'in', ['open', 'countered', 'accepted'])
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    let requests = snap.docs.map((d) => {
      const request = { id: d.id, ...d.data() };
      return { ...request, ...requestDistance(captainLat, captainLng, request) };
    });
    requests = requests.filter((r) => {
      const status = (r.status || '').toString().toLowerCase();
      return !['completed', 'cancelled', 'deleted'].includes(status);
    });
    requests = requests.filter((r) => r.status !== 'accepted' || r.acceptedCaptainId === uid);
    requests.sort((a, b) => {
      if (a.isNearby !== b.isNearby) return a.isNearby ? -1 : 1;
      const byDistance = distanceScore(captainLat, captainLng, a.startLat, a.startLng) -
        distanceScore(captainLat, captainLng, b.startLat, b.startLng);
      if (byDistance !== 0) return byDistance;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });

    return res.json({ success: true, requests });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_CUSTOMER_REQUESTS_ERROR' });
  }
};

const getMyCustomerRequests = async (req, res) => {
  try {
    await cleanupExpiredOpenRequests();
    const snap = await db
      .collection('customerRideRequests')
      .where('customerId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    let requests = await Promise.all(
      snap.docs.map((doc) => attachOffers({ id: doc.id, ...doc.data() })),
    );
    return res.json({ success: true, requests });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_MY_CUSTOMER_REQUESTS_ERROR' });
  }
};

const createOffer = async (req, res) => {
  const uid = req.user.uid;
  const { requestId } = req.params;
  const { fare, message } = req.body;
  const amount = parseNumber(fare);
  if (!amount || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Valid fare is required', code: 'INVALID_FARE' });
  }

  try {
    const requestDoc = await db.collection('customerRideRequests').doc(requestId).get();
    if (!requestDoc.exists) {
      return res.status(404).json({ success: false, error: 'Request not found', code: 'REQUEST_NOT_FOUND' });
    }
    const request = requestDoc.data();
    if (!['open', 'countered'].includes(request.status)) {
      return res.status(400).json({ success: false, error: 'Request is not open', code: 'INVALID_STATE' });
    }
    const captainDoc = await db.collection('users').doc(uid).get();
    if (!captainDoc.exists) {
      return res.status(404).json({ success: false, error: 'Captain not found', code: 'USER_NOT_FOUND' });
    }
    const captain = captainDoc.data();
    const vehicleParts = [
      captain.captainVehicleType,
      captain.vehicleMake,
      captain.vehicleModel,
      captain.vehicleColor,
    ]
      .filter(Boolean)
      .map((v) => String(v).trim())
      .filter(Boolean);
    const now = new Date().toISOString();
    const ref = db.collection('customerRideOffers').doc();
    const offer = {
      id: ref.id,
      requestId,
      captainId: uid,
      captainName: captain.name || 'Captain',
      captainPhone: captain.phone || '',
      captainVehicleType: captain.captainVehicleType || '',
      captainVehicleInfo: vehicleParts.join(' '),
      captainVehicleRegistration: captain.vehicleRegistration || '',
      availableSeats: parseInt(captain.vehicleSeats || 1, 10) || 1,
      customerId: request.customerId,
      fare: amount,
      counterFare: null,
      message: message || '',
      status: 'offered',
      phoneRevealed: false,
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(offer);

    await pushToUser(request.customerId, {
      title: 'Captain Sent Fare',
      body: `${offer.captainName} offered Rs ${amount.toFixed(0)} for your ride.`,
      type: 'customer_offer',
      data: { requestId, offerId: ref.id, screen: 'customer-request' },
    });

    return res.status(201).json({ success: true, offer });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'CREATE_OFFER_ERROR' });
  }
};

const respondOffer = async (req, res) => {
  const uid = req.user.uid;
  const { requestId, offerId } = req.params;
  const { action, counterFare, pickupLocation } = req.body;

  try {
    const requestRef = db.collection('customerRideRequests').doc(requestId);
    const offerRef = db.collection('customerRideOffers').doc(offerId);
    const requestDoc = await requestRef.get();
    const offerDoc = await offerRef.get();
    if (!requestDoc.exists || !offerDoc.exists) {
      return res.status(404).json({ success: false, error: 'Request or offer not found', code: 'NOT_FOUND' });
    }
    const request = requestDoc.data();
    const offer = offerDoc.data();
    if (request.customerId !== uid) {
      return res.status(403).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const now = new Date().toISOString();
    const pickupLabel = labelFromLocation(pickupLocation);
    const pickupUpdate = pickupLabel
      ? { pickupLocation: pickupLabel }
      : {};
    if (action === 'accept') {
      await requestRef.update({
        status: 'accepted',
        finalFare: offer.counterFare || offer.fare,
        acceptedOfferId: offerId,
        acceptedCaptainId: offer.captainId,
        acceptedCaptainPhone: offer.captainPhone || '',
        captainPhoneRevealed: true,
        customerPhoneRevealed: true,
        ...pickupUpdate,
        updatedAt: now,
      });
      await offerRef.update({ status: 'accepted', phoneRevealed: true, updatedAt: now });
      await pushToUser(offer.captainId, {
        title: 'Offer Accepted',
        body: `${request.customerName} accepted your fare. Contact number is now available.`,
        type: 'customer_request_accepted',
        data: { requestId, offerId, screen: 'customer-requests' },
      });
      return res.json({ success: true, message: 'Offer accepted' });
    }

    if (action === 'counter') {
      const amount = parseNumber(counterFare);
      if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Valid counterFare is required', code: 'INVALID_COUNTER_FARE' });
      }
      await requestRef.update({ status: 'countered', desiredFare: amount, ...pickupUpdate, updatedAt: now });
      await offerRef.update({ status: 'countered', counterFare: amount, updatedAt: now });
      await pushToUser(offer.captainId, {
        title: 'Customer Countered Fare',
        body: `${request.customerName} countered your offer with Rs ${amount.toFixed(0)}.`,
        type: 'customer_counter',
        data: { requestId, offerId, screen: 'customer-requests' },
      });
      return res.json({ success: true, message: 'Counter sent' });
    }

    return res.status(400).json({ success: false, error: 'action must be accept or counter', code: 'INVALID_ACTION' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'RESPOND_OFFER_ERROR' });
  }
};

module.exports = {
  createCustomerRequest,
  getOpenCustomerRequests,
  getMyCustomerRequests,
  createOffer,
  respondOffer,
};
