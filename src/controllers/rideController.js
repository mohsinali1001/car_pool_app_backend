const { db } = require('../config/firebase');
const { getBalance } = require('../utils/walletHelper');
const { pushToUser } = require('../utils/notificationHelper');
const { normalizeRouteLabels } = require('../utils/aiLocationHelper');
const { labelFromLocation } = require('../utils/locationLabelHelper');
const { maybeCleanupExpiredRides } = require('../utils/throttledCleanup');
const {
  sanitizeString,
  exceedsMaxLength,
  MAX_LOCATION,
} = require('../utils/inputSanitizer');

// Helper function to parse numbers
function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Helper function to calculate distance in km using Haversine formula
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

const postRide = async (req, res) => {
  const uid = req.user ? req.user.uid : req.body.captainId;
  if (!uid) return res.status(400).json({ success: false, error: 'Captain ID is required', code: 'MISSING_CAPTAIN_ID' });

  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ success: false, error: 'User profile not found.', code: 'USER_NOT_FOUND' });

    const userData = userDoc.data();
    const verificationStatus = userData.captainVerificationStatus;
    const isCaptainVerified = verificationStatus === 'verified' || verificationStatus === 'approved' || userData.isVerified === true;
    if (!isCaptainVerified) return res.status(403).json({ success: false, error: 'Your documents are under review.', code: 'NOT_VERIFIED' });

    const requiredVehicleFields = ['vehicleMake', 'vehicleModel', 'vehicleColor', 'vehicleRegistration'];
    const missingVehicle = requiredVehicleFields.filter(f => !userData[f] || String(userData[f]).trim() === '');
    if (missingVehicle.length > 0) return res.status(403).json({ success: false, error: 'Complete your vehicle details first.', code: 'INCOMPLETE_VEHICLE_DETAILS' });

    await getBalance(uid);

    const {
      startLocation, endLocation,
      startLat, startLng, endLat, endLng,
      departureTime, totalSeats, suggestedFare,
      rideType, vehicleType, acceptsDelivery, vehicleInfo,
      tourType, maxPassengers,
      cargoType, weightCapacity, truckSize, exactLocation, exactDropLocation,
    } = req.body;

    // Validate rideMode
    const rideMode = req.body.rideMode || 'share';
    const normalizedRideMode = String(rideMode).toLowerCase();
    if (!['share', 'solo'].includes(normalizedRideMode)) {
      return res.status(400).json({ success: false, error: 'rideMode must be share or solo', code: 'INVALID_RIDE_MODE' });
    }

    // Validate rideType and vehicleType
    const normalizedRideType = String(rideType || 'random').toLowerCase();
    const isTourRide = normalizedRideType === 'tour';
    const captainVehicleType = String(userData.captainVehicleType || '').toLowerCase();
    const normalizedVehicleType = String(vehicleType || '').toLowerCase();
    
    // Allowed vehicle types
    const allowedVehicleTypes = ['car', 'bike', 'bus', 'truck', 'shazore'];
    
    // Infer vehicle type - FIXED
    let inferredVehicleType;
    if (isTourRide) {
      inferredVehicleType = 'tour';
    } else if (normalizedVehicleType && allowedVehicleTypes.includes(normalizedVehicleType)) {
      inferredVehicleType = normalizedVehicleType;
    } else if (captainVehicleType && allowedVehicleTypes.includes(captainVehicleType)) {
      inferredVehicleType = captainVehicleType;
    } else {
      inferredVehicleType = 'car';
    }
    
    // Validate vehicle type
    if (!allowedVehicleTypes.includes(inferredVehicleType) && inferredVehicleType !== 'tour') {
      return res.status(400).json({ success: false, error: 'vehicleType must be one of car, bike, bus, truck, shazore', code: 'INVALID_VEHICLE_TYPE' });
    }

    // Check captain vehicle type mismatch (only for non-tour rides)
    if (captainVehicleType && !isTourRide) {
      const postingType = inferredVehicleType === 'shazore' ? 'shazore' : inferredVehicleType;
      if (postingType !== captainVehicleType) {
        return res.status(403).json({ success: false, error: `You can only post ${captainVehicleType} rides`, code: 'VEHICLE_TYPE_MISMATCH' });
      }
    }

    if (
      exceedsMaxLength(startLocation, MAX_LOCATION) ||
      exceedsMaxLength(endLocation, MAX_LOCATION) ||
      exceedsMaxLength(exactLocation, MAX_LOCATION) ||
      exceedsMaxLength(exactDropLocation, MAX_LOCATION)
    ) {
      return res.status(400).json({
        success: false,
        error: `Location fields must be at most ${MAX_LOCATION} characters`,
        code: 'FIELD_TOO_LONG',
      });
    }

    const rawStartLocation = sanitizeString(labelFromLocation(startLocation), MAX_LOCATION);
    const rawEndLocation = sanitizeString(labelFromLocation(endLocation), MAX_LOCATION);
    const rawExactLocation = exactLocation
      ? sanitizeString(labelFromLocation(exactLocation), MAX_LOCATION)
      : '';
    const rawExactDropLocation = exactDropLocation
      ? sanitizeString(labelFromLocation(exactDropLocation), MAX_LOCATION)
      : '';

    if (!rawStartLocation || !rawEndLocation || !departureTime || !totalSeats || !suggestedFare) {
      return res.status(400).json({ success: false, error: 'Missing required fields', code: 'MISSING_FIELDS' });
    }

    const parsedStartLat = parseNumber(startLat);
    const parsedStartLng = parseNumber(startLng);
    const parsedEndLat = parseNumber(endLat);
    const parsedEndLng = parseNumber(endLng);
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
        error: 'Valid map pickup and drop coordinates are required',
        code: 'MAP_COORDINATES_REQUIRED',
      });
    }

    const parsedDeparture = new Date(departureTime);
    if (Number.isNaN(parsedDeparture.getTime())) {
      return res.status(400).json({ success: false, error: 'departureTime is invalid', code: 'INVALID_DEPARTURE_TIME' });
    }
    if (parsedDeparture <= new Date()) {
      return res.status(400).json({ success: false, error: 'departureTime must be in the future', code: 'PAST_DEPARTURE_TIME' });
    }

    const parsedSeats = parseInt(totalSeats, 10);
    if (!Number.isInteger(parsedSeats) || parsedSeats < 1) {
      return res.status(400).json({ success: false, error: 'totalSeats must be at least 1', code: 'INVALID_TOTAL_SEATS' });
    }
    const captainVehicleSeats = parseInt(userData.vehicleSeats || userData.totalSeats || 0, 10);
    if (isTourRide && Number.isInteger(captainVehicleSeats) && captainVehicleSeats > 0 && parsedSeats > captainVehicleSeats) {
      return res.status(400).json({
        success: false,
        error: `Tour seats cannot exceed your registered vehicle seats (${captainVehicleSeats})`,
        code: 'TOUR_SEATS_EXCEED_VEHICLE',
      });
    }

    const parsedFare = parseNumber(suggestedFare);
    if (!parsedFare || parsedFare <= 0) {
      return res.status(400).json({ success: false, error: 'suggestedFare must be greater than 0', code: 'INVALID_FARE' });
    }
    if (parsedFare < 50) {
      return res.status(400).json({ success: false, error: 'Minimum fare is Rs 50', code: 'FARE_TOO_LOW' });
    }

    const normalizedLabels = await normalizeRouteLabels({
      startLocation: rawStartLocation,
      endLocation: rawEndLocation,
      exactPickup: rawExactLocation,
      exactDrop: rawExactDropLocation,
      city: userData.city,
    });

    // Build ride object
    const ride = {
      captainId: uid,
      captainName: userData.name || 'Anonymous',
      captainPhone: userData.phone || '',
      captainRating: userData.rating || 5.0,
      captainGender: (userData.gender || '').toString().toLowerCase() || null,
      startLocation: normalizedLabels.startLocation,
      endLocation: normalizedLabels.endLocation,
      exactLocation: rawExactLocation || null,
      exactDropLocation: rawExactDropLocation || null,
      startLat: parsedStartLat,
      startLng: parsedStartLng,
      endLat: parsedEndLat,
      endLng: parsedEndLng,
      departureTime: parsedDeparture.toISOString(),
      totalSeats: parsedSeats,
      availableSeats: parsedSeats,
      full: false,
      suggestedFare: parsedFare,
      rideType: normalizedRideType,
      rideMode: normalizedRideMode,
      vehicleType: inferredVehicleType === 'shazore' ? 'truck' : inferredVehicleType,
      isShazoreRide: inferredVehicleType === 'shazore',
      isLadiesRide: ((userData.gender || '').toString().toLowerCase() === 'female'),
      acceptsDelivery: acceptsDelivery || false,
      vehicleInfo: vehicleInfo || `${userData.vehicleMake || ''} ${userData.vehicleModel || ''}`.trim() || 'Not Specified',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Handle tour ride specific fields
    if (isTourRide) {
      const normalizedTourType = String(tourType || 'share').toLowerCase();
      if (!['share', 'solo'].includes(normalizedTourType)) {
        return res.status(400).json({ success: false, error: "tourType must be share or solo", code: 'INVALID_TOUR_TYPE' });
      }
      ride.tourType = normalizedTourType;
      if (normalizedTourType === 'share') {
        const parsedMax = parseInt(maxPassengers ?? parsedSeats, 10);
        if (!Number.isInteger(parsedMax) || parsedMax < 1) {
          ride.maxPassengers = parsedSeats;
        } else {
          ride.maxPassengers = Math.min(parsedMax, parsedSeats);
        }
      } else {
        ride.maxPassengers = 1;
      }
    }

    // Handle truck / shazore specific fields
    if (inferredVehicleType === 'truck' || inferredVehicleType === 'shazore') {
      const normalizedTruckSize = String(truckSize || '').toLowerCase();
      if (normalizedTruckSize && !['mini', 'half', 'full'].includes(normalizedTruckSize)) {
        return res.status(400).json({ success: false, error: "truckSize must be mini, half, or full", code: 'INVALID_TRUCK_SIZE' });
      }
      ride.cargoType = (cargoType || '').toString().trim() || null;
      ride.weightCapacity = weightCapacity != null ? Number(weightCapacity) : null;
      ride.truckSize = normalizedTruckSize || (inferredVehicleType === 'shazore' ? 'full' : null);
    }

    // Save to Firebase
    const ref = await db.collection('rides').add(ride);

    // Send notifications
    try {
      const usersSnap = await db
        .collection('users')
        .where('role', 'in', ['customer', 'passenger'])
        .where('fcmToken', '!=', null)
        .get();
      const captainCity = (userData.city || '').toString().trim().toLowerCase();
      const targets = usersSnap.docs.filter((doc) => {
        const u = doc.data() || {};
        if (!captainCity) return true;
        return (u.city || '').toString().trim().toLowerCase() === captainCity;
      });
      await Promise.all(targets.map(doc => pushToUser(doc.id, {
        title: 'New Ride Available',
        body: `New ride from ${ride.startLocation} to ${ride.endLocation} near you!${ride.exactLocation ? ` Exact pickup: ${ride.exactLocation}.` : ''}${ride.exactDropLocation ? ` Exact drop: ${ride.exactDropLocation}.` : ''}`,
        type: 'new_ride',
        data: { rideId: ref.id, screen: 'find-ride' },
      })));
    } catch (notifyErr) {
      console.error('Ride notification error:', notifyErr.message);
    }

    return res.status(201).json({ success: true, message: 'Ride posted successfully!', rideId: ref.id, ride: { id: ref.id, ...ride } });
  } catch (err) {
    console.error('CRITICAL ERROR in postRide:', err);
    return res.status(500).json({ success: false, error: 'Internal Server Error: ' + err.message, code: 'POST_RIDE_ERROR' });
  }
};

const getActiveRides = async (req, res) => {
  const { rideType, startLocation, endLocation, rideMode } = req.query;
  const pageLimit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const afterId = (req.query.after || '').toString().trim();
  try {
    await maybeCleanupExpiredRides();
    const userLat = parseNumber(req.query.lat);
    const userLng = parseNumber(req.query.lng);
    let requesterGender = '';
    if (req.user?.uid) {
      const requesterDoc = await db.collection('users').doc(req.user.uid).get();
      if (requesterDoc.exists) requesterGender = (requesterDoc.data().gender || '').toString().toLowerCase();
    }

    const now = new Date().toISOString();
    let query = db.collection('rides').where('status', '==', 'active').where('departureTime', '>=', now);
    if (afterId) {
      const afterDoc = await db.collection('rides').doc(afterId).get();
      if (afterDoc.exists) {
        query = query.orderBy('departureTime').startAfter(afterDoc);
      } else {
        query = query.orderBy('departureTime');
      }
    } else {
      query = query.orderBy('departureTime');
    }
    const snap = await query.limit(pageLimit).get();
    let rides = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const lastDoc = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;

    // Filter ladies rides
    if (requesterGender !== 'female') {
      rides = rides.filter(r => r.isLadiesRide !== true);
    }

    // Filter by rideType / vehicleType
    if (rideType) {
      const rt = String(rideType).toLowerCase();
      if (['car', 'bike', 'bus', 'truck'].includes(rt)) {
        rides = rides.filter(r => (r.vehicleType || '').toString().toLowerCase() === rt);
      } else if (rt === 'shazore') {
        rides = rides.filter(r => r.isShazoreRide === true);
      } else if (rt === 'tour') {
        rides = rides.filter(r => (r.rideType || '').toString().toLowerCase() === 'tour');
      } else if (rt === 'ladies') {
        if (requesterGender !== 'female') rides = [];
        else rides = rides.filter(r => r.isLadiesRide === true);
      } else if (rt !== 'all' && rt !== 'random') {
        rides = rides.filter(r => (r.rideType || '').toString().toLowerCase() === rt);
      }
    }

    // Filter by rideMode
    if (rideMode) {
      const rm = String(rideMode).toLowerCase();
      if (['solo', 'share'].includes(rm)) {
        rides = rides.filter(r => (r.rideMode || 'share').toString().toLowerCase() === rm);
      }
    }

    // Filter by location (text-based)
    if (startLocation) {
      const q = startLocation.toLowerCase();
      rides = rides.filter(r => r.startLocation.toLowerCase().includes(q));
    }

    if (endLocation) {
      const q = endLocation.toLowerCase();
      rides = rides.filter(r => r.endLocation.toLowerCase().includes(q));
    }

    if (userLat != null && userLng != null) {
      rides = rides
        .map((r) => ({
          ...r,
          distanceKm: distanceKm(userLat, userLng, parseNumber(r.startLat), parseNumber(r.startLng)),
        }))
        .sort((a, b) => {
          const ad = a.distanceKm == null ? Number.MAX_SAFE_INTEGER : a.distanceKm;
          const bd = b.distanceKm == null ? Number.MAX_SAFE_INTEGER : b.distanceKm;
          if (ad !== bd) return ad - bd;
          return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
        })
        .map((r) => ({
          ...r,
          distanceKm: r.distanceKm == null ? null : Number(r.distanceKm.toFixed(2)),
        }));
    } else {
      rides.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }

    res.set('Cache-Control', 'public, max-age=10');
    return res.json({
      success: true,
      count: rides.length,
      rides,
      hasMore: snap.docs.length >= pageLimit,
      lastDocId: lastDoc ? lastDoc.id : null,
    });
  } catch (err) {
    console.error('Error fetching rides:', err);
    return res.status(500).json({ success: false, error: err.message, code: 'GET_RIDES_ERROR' });
  }
};

const updateRideStatus = async (req, res) => {
  const { rideId } = req.params;
  const { status } = req.body;
  const uid = req.user ? req.user.uid : req.body.captainId;
  const validStatuses = ['active', 'filled', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) return res.status(400).json({ success: false, error: 'Invalid status type', code: 'INVALID_STATUS' });
  
  try {
    const rideRef = db.collection('rides').doc(rideId);
    const rideDoc = await rideRef.get();
    if (!rideDoc.exists) return res.status(404).json({ success: false, error: 'Ride not found', code: 'RIDE_NOT_FOUND' });
    if (rideDoc.data().captainId !== uid) return res.status(403).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    await rideRef.update({ status, updatedAt: new Date().toISOString() });
    return res.json({ success: true, message: `Ride marked as ${status}` });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'UPDATE_RIDE_ERROR' });
  }
};

const getMyRides = async (req, res) => {
  const uid = req.user ? req.user.uid : req.query.captainId;
  if (!uid) return res.status(400).json({ success: false, error: 'Captain ID is required', code: 'MISSING_CAPTAIN_ID' });
  
  try {
    await maybeCleanupExpiredRides();
    const snap = await db.collection('rides').where('captainId', '==', uid).orderBy('createdAt', 'desc').get();
    const rides = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, rides });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_MY_RIDES_ERROR' });
  }
};

const getRideById = async (req, res) => {
  const { rideId } = req.params;
  try {
    await maybeCleanupExpiredRides();
    const rideDoc = await db.collection('rides').doc(rideId).get();
    if (!rideDoc.exists) return res.status(404).json({ success: false, error: 'Ride not found', code: 'RIDE_NOT_FOUND' });
    res.set('Cache-Control', 'public, max-age=10');
    return res.json({ success: true, ride: { id: rideDoc.id, ...rideDoc.data() } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_RIDE_BY_ID_ERROR' });
  }
};

const updateRideLocation = async (req, res) => {
  const { rideId } = req.params;
  const { lat, lng } = req.body;
  const uid = req.user ? req.user.uid : req.body.captainId;
  if (lat === undefined || lng === undefined) return res.status(400).json({ success: false, error: 'Latitude and Longitude are required', code: 'MISSING_COORDINATES' });
  
  try {
    const rideRef = db.collection('rides').doc(rideId);
    const rideDoc = await rideRef.get();
    if (!rideDoc.exists) return res.status(404).json({ success: false, error: 'Ride not found', code: 'RIDE_NOT_FOUND' });
    if (rideDoc.data().captainId !== uid) return res.status(403).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    await rideRef.update({ captainLat: parseFloat(lat), captainLng: parseFloat(lng), updatedAt: new Date().toISOString() });
    return res.json({ success: true, message: 'Location updated successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'UPDATE_LOCATION_ERROR' });
  }
};

module.exports = { postRide, getActiveRides, updateRideStatus, getMyRides, getRideById, updateRideLocation };
