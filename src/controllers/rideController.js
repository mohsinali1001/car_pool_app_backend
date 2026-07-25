const { db } = require('../config/firebase');
const { getBalance } = require('../utils/walletHelper');
const { pushToUser } = require('../utils/notificationHelper');
const { normalizeRouteLabels } = require('../utils/aiLocationHelper');
const { labelFromLocation } = require('../utils/locationLabelHelper');
const { maybeCleanupExpiredRides } = require('../utils/throttledCleanup');
const { DEAL_STATUS } = require('../constants/statuses');
const { fetchRoutePolyline, projectPointOnPolyline } = require('../utils/routeHelper');
const {
  sanitizeString,
  exceedsMaxLength,
  MAX_LOCATION,
} = require('../utils/inputSanitizer');

// ─── HELPERS ──────────────────────────────────────────────
function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

function calculateRouteProximityMeters(userLat, userLng, startLat, startLng, endLat, endLng) {
  const pickupLat = parseNumber(userLat);
  const pickupLng = parseNumber(userLng);
  const routeStartLat = parseNumber(startLat);
  const routeStartLng = parseNumber(startLng);
  const routeEndLat = parseNumber(endLat);
  const routeEndLng = parseNumber(endLng);

  if ([pickupLat, pickupLng, routeStartLat, routeStartLng, routeEndLat, routeEndLng].some((v) => v == null)) {
    return null;
  }

  const toRouteDistanceKm = (pointLat, pointLng, lineStartLat, lineStartLng, lineEndLat, lineEndLng) => {
    const dx = lineEndLng - lineStartLng;
    const dy = lineEndLat - lineStartLat;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) {
      return distanceKm(pointLat, pointLng, lineStartLat, lineStartLng);
    }

    const t = ((pointLng - lineStartLng) * dx + (pointLat - lineStartLat) * dy) / lengthSq;
    const clampedT = Math.max(0, Math.min(1, t));
    const nearestLat = lineStartLat + clampedT * dy;
    const nearestLng = lineStartLng + clampedT * dx;
    return distanceKm(pointLat, pointLng, nearestLat, nearestLng);
  };

  const distanceKmToSegment = toRouteDistanceKm(
    pickupLat,
    pickupLng,
    routeStartLat,
    routeStartLng,
    routeEndLat,
    routeEndLng,
  );

  return distanceKmToSegment == null ? null : distanceKmToSegment * 1000;
}

function pointProjectionOnRoute(pointLat, pointLng, startLat, startLng, endLat, endLng) {
  const lat = parseNumber(pointLat);
  const lng = parseNumber(pointLng);
  const sLat = parseNumber(startLat);
  const sLng = parseNumber(startLng);
  const eLat = parseNumber(endLat);
  const eLng = parseNumber(endLng);

  if ([lat, lng, sLat, sLng, eLat, eLng].some((v) => v == null)) return null;

  const dx = eLng - sLng;
  const dy = eLat - sLat;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    const distance = distanceKm(lat, lng, sLat, sLng);
    return { t: 0, distanceKm: distance == null ? null : distance };
  }

  const rawT = ((lng - sLng) * dx + (lat - sLat) * dy) / lengthSq;
  const t = Math.max(0, Math.min(1, rawT));
  const nearestLat = sLat + t * dy;
  const nearestLng = sLng + t * dx;
  return {
    t,
    rawT,
    distanceKm: distanceKm(lat, lng, nearestLat, nearestLng),
  };
}

function routeMatchScore(ride, search) {
  const pickupRadiusKm = search.pickupRadiusKm;
  const destinationRadiusKm = search.destinationRadiusKm;
  const routeRadiusKm = search.routeRadiusKm;
  const pickupLat = search.pickupLat;
  const pickupLng = search.pickupLng;
  const destLat = search.destLat;
  const destLng = search.destLng;

  function projectOnRoute(lat, lng) {
    if (lat == null || lng == null) return null;
    if (Array.isArray(ride.routePolyline) && ride.routePolyline.length >= 2) {
      const hit = projectPointOnPolyline(lat, lng, ride.routePolyline);
      if (!hit) return null;
      return { t: hit.progress, distanceKm: hit.distanceMeters / 1000 };
    }
    return pointProjectionOnRoute(lat, lng, ride.startLat, ride.startLng, ride.endLat, ride.endLng);
  }

  const pickupProjection = projectOnRoute(pickupLat, pickupLng);
  const destinationProjection = projectOnRoute(destLat, destLng);
  const pickupStartKm = distanceKm(pickupLat, pickupLng, parseNumber(ride.startLat), parseNumber(ride.startLng));
  const destinationEndKm = distanceKm(destLat, destLng, parseNumber(ride.endLat), parseNumber(ride.endLng));
  const captainCurrentKm = distanceKm(pickupLat, pickupLng, parseNumber(ride.captainLat), parseNumber(ride.captainLng));

  const pickupOnRoute =
    pickupProjection?.distanceKm != null && pickupProjection.distanceKm <= routeRadiusKm;
  const destinationOnRoute =
    destinationProjection?.distanceKm != null && destinationProjection.distanceKm <= routeRadiusKm;
  const pickupNearStart = pickupStartKm != null && pickupStartKm <= pickupRadiusKm;
  const destinationNearEnd = destinationEndKm != null && destinationEndKm <= destinationRadiusKm;
  const captainNearPickup = captainCurrentKm != null && captainCurrentKm <= pickupRadiusKm;
  const directionOk =
    pickupProjection?.t == null ||
    destinationProjection?.t == null ||
    pickupProjection.t <= destinationProjection.t + 0.03;

  const routeIncludesJourney =
    directionOk &&
    (pickupOnRoute || pickupNearStart || captainNearPickup) &&
    (destinationOnRoute || destinationNearEnd);

  const pickupLabelScore = Math.max(
    levenshteinSimilarity(search.startLocation, ride.startLocation),
    levenshteinSimilarity(search.startLocation, ride.exactLocation),
  );
  const destinationLabelScore = Math.max(
    levenshteinSimilarity(search.endLocation, ride.endLocation),
    levenshteinSimilarity(search.endLocation, ride.exactDropLocation),
  );
  const textOverlap = search.startLocation && search.endLocation
    ? locationsOverlap(search.startLocation, search.endLocation, ride.startLocation, ride.endLocation)
    : false;

  let score = 0;
  if (routeIncludesJourney) score += 70;
  if (pickupNearStart) score += 18;
  if (captainNearPickup) score += 12;
  if (pickupOnRoute) score += 16;
  if (destinationNearEnd) score += 16;
  if (destinationOnRoute) score += 16;
  if (directionOk) score += 10;
  if (textOverlap) score += 18;
  score += Math.floor(Math.max(pickupLabelScore, 0) * 0.12);
  score += Math.floor(Math.max(destinationLabelScore, 0) * 0.12);

  const pickupRouteKm = pickupProjection?.distanceKm;
  const destinationRouteKm = destinationProjection?.distanceKm;
  const suitable =
    routeIncludesJourney ||
    (textOverlap && directionOk) ||
    (pickupLabelScore >= 80 && (destinationLabelScore >= 70 || destinationOnRoute || destinationNearEnd));

  return {
    suitable,
    score,
    directionOk,
    routePassesThroughPickup: pickupOnRoute,
    routePassesThroughDestination: destinationOnRoute,
    pickupRouteKm,
    destinationRouteKm,
    distanceFromPickup: pickupStartKm,
    distanceFromDestination: destinationEndKm,
    captainDistanceFromPickup: captainCurrentKm,
    pickupProgress: pickupProjection?.t ?? null,
    destinationProgress: destinationProjection?.t ?? null,
    isDirectMatch: pickupNearStart && destinationNearEnd,
    isProximityMatch: routeIncludesJourney || pickupOnRoute || destinationOnRoute,
  };
}

function buildRideRouteSummary(startLat, startLng, endLat, endLng) {
  const routeStartLat = parseNumber(startLat);
  const routeStartLng = parseNumber(startLng);
  const routeEndLat = parseNumber(endLat);
  const routeEndLng = parseNumber(endLng);

  if ([routeStartLat, routeStartLng, routeEndLat, routeEndLng].some((v) => v == null)) {
    return null;
  }

  const routeDistanceKm = distanceKm(routeStartLat, routeStartLng, routeEndLat, routeEndLng);

  return {
    routeBoundingBox: {
      north: Math.max(routeStartLat, routeEndLat),
      south: Math.min(routeStartLat, routeEndLat),
      east: Math.max(routeStartLng, routeEndLng),
      west: Math.min(routeStartLng, routeEndLng),
    },
    routeDistanceKm: routeDistanceKm == null ? null : Number(routeDistanceKm.toFixed(2)),
    routeDistanceMeters: routeDistanceKm == null ? null : Number((routeDistanceKm * 1000).toFixed(0)),
  };
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

function isRideUpcoming(ride, now = new Date()) {
  const status = (ride.status || '').toString().toLowerCase();
  if (!['active', 'in_progress'].includes(status)) return false;
  const departure = new Date(ride.departureTime || '');
  return !Number.isNaN(departure.getTime()) && departure > now;
}

function formatRideDateTime(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Karachi',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const parts = formatter.formatToParts(date);
    const day = parts.find(p => p.type === 'day').value;
    const month = parts.find(p => p.type === 'month').value;
    const year = parts.find(p => p.type === 'year').value;
    const hour = parts.find(p => p.type === 'hour').value;
    const minute = parts.find(p => p.type === 'minute').value;
    const dayPeriod = parts.find(p => p.type === 'dayPeriod').value.toLowerCase();

    const minutesStr = minute === '00' ? '' : `:${minute}`;
    const timeStr = `${hour}${minutesStr} ${dayPeriod}`;

    return `${day} ${month} ${year} time ${timeStr}`;
  } catch (e) {
    const day = date.getDate();
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const minutesStr = minutes === 0 ? '' : `:${minutes.toString().padStart(2, '0')}`;
    return `${day} ${month} ${year} time ${hours}${minutesStr} ${ampm}`;
  }
}

function locationsOverlap(queryStart, queryEnd, rideStart, rideEnd) {
  const qs = (queryStart || '').toLowerCase();
  const qe = (queryEnd || '').toLowerCase();
  const rs = (rideStart || '').toLowerCase();
  const re = (rideEnd || '').toLowerCase();

  const sequence = [
    'peshawar',
    'nowshera',
    'attock',
    'wah cantt',
    'wah',
    'taxila',
    'rawalpindi',
    'pindi',
    'islamabad',
    'isb'
  ];

  const findIndex = (loc) => {
    return sequence.findIndex(item => loc.includes(item));
  };

  const qStartIdx = findIndex(qs);
  const qEndIdx = findIndex(qe);
  const rStartIdx = findIndex(rs);
  const rEndIdx = findIndex(re);

  if (qStartIdx !== -1 && qEndIdx !== -1 && rStartIdx !== -1 && rEndIdx !== -1) {
    const queryDir = qEndIdx - qStartIdx;
    const rideDir = rEndIdx - rStartIdx;

    if ((queryDir > 0 && rideDir > 0) || (queryDir < 0 && rideDir < 0)) {
      const qMin = Math.min(qStartIdx, qEndIdx);
      const qMax = Math.max(qStartIdx, qEndIdx);
      const rMin = Math.min(rStartIdx, rEndIdx);
      const rMax = Math.max(rStartIdx, rEndIdx);

      return Math.max(qMin, rMin) <= Math.min(qMax, rMax);
    }
  }

  return rs.includes(qs) && re.includes(qe);
}

function levenshteinSimilarity(str1, str2) {
  const s1 = (str1 || '').toLowerCase().trim();
  const s2 = (str2 || '').toLowerCase().trim();

  if (s1 === s2) return 100;
  if (!s1 || !s2) return 0;

  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;

  if (longer.includes(shorter)) return 95;

  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }

  const distance = costs[s2.length];
  const maxLen = Math.max(s1.length, s2.length);
  return Math.round(((maxLen - distance) / maxLen) * 100);
}

function calculateDestinationMatch(userDest, rideStart, rideEnd) {
  if (!userDest || !rideEnd) return { score: 0, passesThrough: false };

  const userDest_lower = (userDest || '').toLowerCase().trim();
  const rideEnd_lower = (rideEnd || '').toLowerCase().trim();
  const rideStart_lower = (rideStart || '').toLowerCase().trim();

  const directMatch = levenshteinSimilarity(userDest_lower, rideEnd_lower);

  const startMatch = levenshteinSimilarity(userDest_lower, rideStart_lower);
  const passesThrough = startMatch >= 80;

  const score = Math.max(directMatch, startMatch);

  return {
    score: Math.round(score),
    passesThrough: passesThrough || directMatch >= 80
  };
}

function serializeRide(id, data) {
  const ride = { id, ...data };
  const displayDateTime = formatRideDateTime(ride.departureTime);
  const routeSummary = buildRideRouteSummary(ride.startLat, ride.startLng, ride.endLat, ride.endLng);
  return {
    ...ride,
    routeLabel: `${ride.startLocation || ''} -> ${ride.endLocation || ''}`.trim(),
    departureDisplay: displayDateTime,
    displayDateTime,
    ...(routeSummary || {}),
  };
}

// ─── NOTIFICATION HELPERS ──────────────────────────────────

// Captain post ride → Notify PASSENGERS in same city
async function notifyPassengersAboutRide(ride, rideId, captainCity) {
  try {
    const passengersSnap = await db
      .collection('users')
      .where('role', 'in', ['customer', 'passenger'])
      .get();

    const targets = passengersSnap.docs.filter((doc) => {
      const u = doc.data() || {};
      if (!captainCity) return true;
      return (u.city || '').toString().trim().toLowerCase() === captainCity;
    });

    await Promise.all(targets.map(doc => pushToUser(doc.id, {
      title: '🚗 New Ride Available!',
      body: `${ride.captainName} posted a ${ride.vehicleType} ride from ${ride.startLocation} to ${ride.endLocation}`,
      type: 'new_ride',
      data: {
        rideId: rideId,
        screen: 'find-ride',
        vehicleType: ride.vehicleType,
        startLocation: ride.startLocation,
        endLocation: ride.endLocation,
        suggestedFare: String(ride.suggestedFare)
      },
    })));

    console.log(`✅ Notified ${targets.length} passengers about new ride`);
  } catch (err) {
    console.error('Passenger notification error:', err.message);
  }
}

// Customer ride request → Notify CAPTAINS in same city
async function notifyCaptainsAboutRequest(request, requestId, customerCity, vehicleType) {
  try {
    const captainsSnap = await db
      .collection('users')
      .where('role', '==', 'captain')
      .where('isActive', '==', true)
      .get();

    let targets = captainsSnap.docs.filter((doc) => {
      const u = doc.data() || {};
      if (!customerCity) return true;
      return (u.city || '').toString().trim().toLowerCase() === customerCity;
    });

    // Filter by vehicle type match
    if (vehicleType && vehicleType !== 'any') {
      targets = targets.filter((doc) => {
        const u = doc.data() || {};
        const captainVehicle = (u.captainVehicleType || '').toLowerCase();
        return captainVehicle === vehicleType.toLowerCase();
      });
    }

    await Promise.all(targets.map(doc => pushToUser(doc.id, {
      title: '🧑 New Ride Request!',
      body: `${request.customerName} needs a ride from ${request.startLocation} to ${request.endLocation}`,
      type: 'customer_ride_request',
      data: {
        requestId: requestId,
        screen: 'captain-requests',
        customerId: request.customerId,
        startLocation: request.startLocation,
        endLocation: request.endLocation,
        preferredFare: String(request.preferredFare || 0),
      },
    })));

    console.log(`✅ Notified ${targets.length} captains about ride request`);
  } catch (err) {
    console.error('Captain notification error:', err.message);
  }
}

// ─── CAPTAIN POST RIDE ────────────────────────────────────
// Captain ride post → PASSENGERS ko notification
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

    const requiredVehicleFields = ['captainVehicleType', 'vehicleModel', 'vehicleRegistration', 'vehiclePhotoUrl'];
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

    const rideMode = req.body.rideMode || 'share';
    const normalizedRideMode = String(rideMode).toLowerCase();
    if (!['share', 'solo'].includes(normalizedRideMode)) {
      return res.status(400).json({ success: false, error: 'rideMode must be share or solo', code: 'INVALID_RIDE_MODE' });
    }

    const normalizedRideType = String(rideType || 'random').toLowerCase();
    const isTourRide = normalizedRideType === 'tour';
    const captainVehicleType = String(userData.captainVehicleType || '').toLowerCase();
    const normalizedVehicleType = String(vehicleType || '').toLowerCase();

    const allowedVehicleTypes = ['car', 'bike', 'bus', 'truck', 'shazore'];

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

    if (!allowedVehicleTypes.includes(inferredVehicleType) && inferredVehicleType !== 'tour') {
      return res.status(400).json({ success: false, error: 'vehicleType must be one of car, bike, bus, truck, shazore', code: 'INVALID_VEHICLE_TYPE' });
    }

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
      vehiclePhotoUrl: userData.vehiclePhotoUrl || '',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

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

    if (inferredVehicleType === 'truck' || inferredVehicleType === 'shazore') {
      const normalizedTruckSize = String(truckSize || '').toLowerCase();
      if (normalizedTruckSize && !['mini', 'half', 'full'].includes(normalizedTruckSize)) {
        return res.status(400).json({ success: false, error: "truckSize must be mini, half, or full", code: 'INVALID_TRUCK_SIZE' });
      }
      ride.cargoType = (cargoType || '').toString().trim() || null;
      ride.weightCapacity = weightCapacity != null ? Number(weightCapacity) : null;
      ride.truckSize = normalizedTruckSize || (inferredVehicleType === 'shazore' ? 'full' : null);
    }

    try {
      const routePolyline = await fetchRoutePolyline(
        ride.startLat, ride.startLng, ride.endLat, ride.endLng,
      );
      if (routePolyline && routePolyline.length >= 2) {
        ride.routePolyline = routePolyline;
      }
    } catch (routeErr) {
      console.error('Route polyline fetch failed (continuing without it):', routeErr.message);
    }

    const ref = await db.collection('rides').add(ride);

    // ─── NOTIFICATION: Captain ride → PASSENGERS ───
    await notifyPassengersAboutRide(ride, ref.id, userData.city);

    return res.status(201).json({
      success: true,
      message: 'Ride posted successfully!',
      rideId: ref.id,
      ride: serializeRide(ref.id, ride)
    });
  } catch (err) {
    console.error('CRITICAL ERROR in postRide:', err);
    return res.status(500).json({ success: false, error: 'Internal Server Error: ' + err.message, code: 'POST_RIDE_ERROR' });
  }
};

// ─── CUSTOMER POST RIDE REQUEST ──────────────────────────
// Customer ride request → CAPTAINS ko notification
const postCustomerRideRequest = async (req, res) => {
  const uid = req.user ? req.user.uid : req.body.customerId;
  if (!uid) return res.status(400).json({ success: false, error: 'Customer ID is required', code: 'MISSING_CUSTOMER_ID' });

  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ success: false, error: 'User profile not found.', code: 'USER_NOT_FOUND' });

    const userData = userDoc.data();

    const {
      startLocation, endLocation,
      startLat, startLng, endLat, endLng,
      departureTime, preferredFare,
      vehicleType, seats, exactLocation, exactDropLocation,
    } = req.body;

    if (!startLocation || !endLocation || !startLat || !startLng || !endLat || !endLng) {
      return res.status(400).json({ success: false, error: 'Missing required fields', code: 'MISSING_FIELDS' });
    }

    const request = {
      customerId: uid,
      customerName: userData.name || 'Anonymous',
      customerPhone: userData.phone || '',
      startLocation: sanitizeString(labelFromLocation(startLocation), MAX_LOCATION),
      endLocation: sanitizeString(labelFromLocation(endLocation), MAX_LOCATION),
      exactLocation: exactLocation ? sanitizeString(labelFromLocation(exactLocation), MAX_LOCATION) : null,
      exactDropLocation: exactDropLocation ? sanitizeString(labelFromLocation(exactDropLocation), MAX_LOCATION) : null,
      startLat: parseNumber(startLat),
      startLng: parseNumber(startLng),
      endLat: parseNumber(endLat),
      endLng: parseNumber(endLng),
      departureTime: departureTime ? new Date(departureTime).toISOString() : new Date().toISOString(),
      preferredFare: parseNumber(preferredFare) || 0,
      vehicleType: String(vehicleType || 'any').toLowerCase(),
      seats: parseInt(seats, 10) || 1,
      status: 'pending',
      isLadiesRide: ((userData.gender || '').toString().toLowerCase() === 'female'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const ref = await db.collection('customerRideRequests').add(request);

    // ─── NOTIFICATION: Customer request → CAPTAINS ───
    await notifyCaptainsAboutRequest(request, ref.id, userData.city, request.vehicleType);

    return res.status(201).json({
      success: true,
      message: 'Ride request posted successfully! Captains will be notified.',
      requestId: ref.id,
      request,
    });

  } catch (err) {
    console.error('CRITICAL ERROR in postCustomerRideRequest:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error: ' + err.message,
      code: 'POST_REQUEST_ERROR'
    });
  }
};

// ─── GET ACTIVE RIDES ─────────────────────────────────────
const getActiveRides = async (req, res) => {

  const { rideType, startLocation, endLocation, rideMode } = req.query;
  const pageLimit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const afterId = (req.query.after || req.query.lastDocId || '').toString().trim();
  const hasRouteSearch = Boolean(startLocation || endLocation || req.query.lat || req.query.lng);
  const fetchLimit = hasRouteSearch ? Math.min(Math.max(pageLimit * 5, 75), 150) : pageLimit;
  const pickupRadiusKm = Math.min(Math.max(parseNumber(req.query.pickupRadiusKm) || 8, 1), 30);
  const destinationRadiusKm = Math.min(Math.max(parseNumber(req.query.destinationRadiusKm) || 10, 1), 40);
  const routeRadiusKm = Math.min(Math.max(parseNumber(req.query.routeRadiusKm) || 6, 1), 25);
  try {
    await maybeCleanupExpiredRides();
    const userLat = parseNumber(req.query.lat ?? req.query.pickupLat);
    const userLng = parseNumber(req.query.lng ?? req.query.pickupLng);
    const destLat = parseNumber(req.query.destLat ?? req.query.endLat);
    const destLng = parseNumber(req.query.destLng ?? req.query.endLng);
    let requesterGender = '';
    if (req.user?.uid) {
      const requesterDoc = await db.collection('users').doc(req.user.uid).get();
      if (requesterDoc.exists) requesterGender = (requesterDoc.data().gender || '').toString().toLowerCase();
    }

    const RIDE_GRACE_PERIOD_MS = 30 * 60 * 1000;
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const graceFloor = new Date(nowMs - RIDE_GRACE_PERIOD_MS).toISOString();
    let query = db.collection('rides').where('status', '==', 'active').where('departureTime', '>=', graceFloor);
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
    const snap = await query.limit(fetchLimit).get();
    let rides = snap.docs.map(d => serializeRide(d.id, d.data()));
    rides = rides.map((r) => ({
      ...r,
      isGracePeriod: new Date(r.departureTime || 0).getTime() < nowMs,
    }));
    const lastDoc = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;

    if (requesterGender !== 'female') {
      rides = rides.filter(r => r.isLadiesRide !== true);
    }

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

    if (rideMode) {
      const rm = String(rideMode).toLowerCase();
      if (['solo', 'share'].includes(rm)) {
        rides = rides.filter(r => (r.rideMode || 'share').toString().toLowerCase() === rm);
      }
    }

    if (req.user?.uid) {
      try {
        const myDealsSnap = await db
          .collection('deals')
          .where('customerId', '==', req.user.uid)
          .where('status', 'in', [DEAL_STATUS.PENDING, DEAL_STATUS.CONFIRMED, DEAL_STATUS.STARTED])
          .get();
        const excludedRideIds = new Set(myDealsSnap.docs.map((d) => d.data().rideId).filter(Boolean));
        if (excludedRideIds.size > 0) {
          rides = rides.filter((r) => !excludedRideIds.has(r.id));
        }
      } catch (excludeErr) {
        console.error('Error excluding already-booked rides:', excludeErr.message);
      }
    }

    const canCoordinateMatch = userLat != null && userLng != null && destLat != null && destLng != null;
    const shouldRouteFilter = Boolean(startLocation || endLocation || canCoordinateMatch);
    if (shouldRouteFilter) {
      rides = rides
        .map((r) => {
          const coordinateMatch = canCoordinateMatch
            ? routeMatchScore(r, {
                startLocation,
                endLocation,
                pickupLat: userLat,
                pickupLng: userLng,
                destLat,
                destLng,
                pickupRadiusKm,
                destinationRadiusKm,
                routeRadiusKm,
              })
            : null;
          const destMatch = endLocation
            ? calculateDestinationMatch(endLocation, r.startLocation, r.endLocation)
            : { score: 0, passesThrough: false };
          const labelOverlap = startLocation && endLocation
            ? locationsOverlap(startLocation, endLocation, r.startLocation, r.endLocation)
            : false;
          const pickupLabelScore = startLocation
            ? Math.max(
                levenshteinSimilarity(startLocation, r.startLocation),
                levenshteinSimilarity(startLocation, r.exactLocation),
              )
            : 0;
          const suitable =
            coordinateMatch?.suitable === true ||
            labelOverlap ||
            (pickupLabelScore >= 80 && (!endLocation || destMatch.score >= 70 || destMatch.passesThrough));
          const relevanceScore =
            (coordinateMatch?.score || 0) +
            (labelOverlap ? 20 : 0) +
            Math.floor(pickupLabelScore * 0.15) +
            Math.floor((destMatch.score || 0) * 0.15);

          return {
            ...r,
            routeMatchScore: relevanceScore,
            destinationMatchScore: destMatch.score,
            routePassesThrough: coordinateMatch?.isProximityMatch === true || destMatch.passesThrough,
            isDirectMatch: coordinateMatch?.isDirectMatch === true,
            isProximityMatch: coordinateMatch?.isProximityMatch === true || destMatch.passesThrough,
            directionOk: coordinateMatch?.directionOk ?? null,
            pickupProgress: coordinateMatch?.pickupProgress ?? null,
            destinationProgress: coordinateMatch?.destinationProgress ?? null,
            distanceFromPickup: coordinateMatch?.distanceFromPickup ?? (userLat != null && userLng != null ? distanceKm(userLat, userLng, parseNumber(r.startLat), parseNumber(r.startLng)) : null),
            distanceFromDest: coordinateMatch?.distanceFromDestination ?? (destLat != null && destLng != null ? distanceKm(destLat, destLng, parseNumber(r.endLat), parseNumber(r.endLng)) : null),
            routeProximityKm: coordinateMatch?.pickupRouteKm ?? null,
            destinationRouteProximityKm: coordinateMatch?.destinationRouteKm ?? null,
            captainDistanceFromPickup: coordinateMatch?.captainDistanceFromPickup ?? null,
            _suitable: suitable,
          };
        })
        .filter((r) => r._suitable === true)
        .sort((a, b) => {
          if ((a.routeMatchScore || 0) !== (b.routeMatchScore || 0)) {
            return (b.routeMatchScore || 0) - (a.routeMatchScore || 0);
          }
          const aPickup = a.distanceFromPickup == null ? Number.MAX_SAFE_INTEGER : a.distanceFromPickup;
          const bPickup = b.distanceFromPickup == null ? Number.MAX_SAFE_INTEGER : b.distanceFromPickup;
          if (aPickup !== bPickup) return aPickup - bPickup;
          const aDest = a.distanceFromDest == null ? Number.MAX_SAFE_INTEGER : a.distanceFromDest;
          const bDest = b.distanceFromDest == null ? Number.MAX_SAFE_INTEGER : b.distanceFromDest;
          if (aDest !== bDest) return aDest - bDest;
          return String(a.departureTime || '').localeCompare(String(b.departureTime || ''));
        })
        .slice(0, pageLimit)
        .map((r) => {
          const { _suitable, ...cleanRide } = r;
          return {
            ...cleanRide,
            distanceFromPickup: cleanRide.distanceFromPickup == null ? null : Number(cleanRide.distanceFromPickup.toFixed(2)),
            distanceFromDest: cleanRide.distanceFromDest == null ? null : Number(cleanRide.distanceFromDest.toFixed(2)),
            distanceKm: cleanRide.distanceFromPickup == null ? null : Number(cleanRide.distanceFromPickup.toFixed(2)),
            routeProximityKm: cleanRide.routeProximityKm == null ? null : Number(cleanRide.routeProximityKm.toFixed(2)),
            destinationRouteProximityKm: cleanRide.destinationRouteProximityKm == null ? null : Number(cleanRide.destinationRouteProximityKm.toFixed(2)),
            captainDistanceFromPickup: cleanRide.captainDistanceFromPickup == null ? null : Number(cleanRide.captainDistanceFromPickup.toFixed(2)),
          };
        });
    }

    res.set('Cache-Control', 'public, max-age=10');
    return res.json({
      success: true,
      count: rides.length,
      rides,
      hasMore: snap.docs.length >= fetchLimit,
      lastDocId: lastDoc ? lastDoc.id : null,
    });
  } catch (err) {
    console.error('Error fetching rides:', err);
    return res.status(500).json({ success: false, error: err.message, code: 'GET_RIDES_ERROR' });
  }
};

// ─── UPDATE RIDE STATUS ──────────────────────────────────
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

// ─── UPDATE RIDE ──────────────────────────────────────────
const updateRide = async (req, res) => {
  const { rideId } = req.params;
  const uid = req.user ? req.user.uid : req.body.captainId;
  if (!uid) return res.status(400).json({ success: false, error: 'Captain ID is required', code: 'MISSING_CAPTAIN_ID' });

  try {
    const rideRef = db.collection('rides').doc(rideId);
    const rideDoc = await rideRef.get();
    if (!rideDoc.exists) return res.status(404).json({ success: false, error: 'Ride not found', code: 'RIDE_NOT_FOUND' });

    const existingRide = rideDoc.data();
    if (existingRide.captainId !== uid) {
      return res.status(403).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const {
      startLocation,
      endLocation,
      startLat,
      startLng,
      endLat,
      endLng,
      departureTime,
      suggestedFare,
      totalSeats,
      rideType,
      rideMode,
      exactLocation,
      exactDropLocation,
    } = req.body;

    if (
      startLocation != null && exceedsMaxLength(startLocation, MAX_LOCATION) ||
      endLocation != null && exceedsMaxLength(endLocation, MAX_LOCATION) ||
      exactLocation != null && exceedsMaxLength(exactLocation, MAX_LOCATION) ||
      exactDropLocation != null && exceedsMaxLength(exactDropLocation, MAX_LOCATION)
    ) {
      return res.status(400).json({
        success: false,
        error: `Location fields must be at most ${MAX_LOCATION} characters`,
        code: 'FIELD_TOO_LONG',
      });
    }

    const nextStartLocation = startLocation != null ? sanitizeString(labelFromLocation(startLocation), MAX_LOCATION) : existingRide.startLocation;
    const nextEndLocation = endLocation != null ? sanitizeString(labelFromLocation(endLocation), MAX_LOCATION) : existingRide.endLocation;
    const nextExactLocation = exactLocation != null ? sanitizeString(labelFromLocation(exactLocation), MAX_LOCATION) : existingRide.exactLocation;
    const nextExactDropLocation = exactDropLocation != null ? sanitizeString(labelFromLocation(exactDropLocation), MAX_LOCATION) : existingRide.exactDropLocation;

    if (!nextStartLocation || !nextEndLocation) {
      return res.status(400).json({ success: false, error: 'startLocation and endLocation are required', code: 'MISSING_FIELDS' });
    }

    const updatePayload = {
      updatedAt: new Date().toISOString(),
      startLocation: nextStartLocation,
      endLocation: nextEndLocation,
      exactLocation: nextExactLocation || null,
      exactDropLocation: nextExactDropLocation || null,
    };

    let routeCoordsChanged = false;

    if (startLat != null || startLng != null || endLat != null || endLng != null) {
      const parsedStartLat = startLat != null ? parseNumber(startLat) : existingRide.startLat;
      const parsedStartLng = startLng != null ? parseNumber(startLng) : existingRide.startLng;
      const parsedEndLat = endLat != null ? parseNumber(endLat) : existingRide.endLat;
      const parsedEndLng = endLng != null ? parseNumber(endLng) : existingRide.endLng;

      if (
        !isValidLat(parsedStartLat) ||
        !isValidLng(parsedStartLng) ||
        !isValidLat(parsedEndLat) ||
        !isValidLng(parsedEndLng) ||
        isZeroCoordinate(parsedStartLat, parsedStartLng) ||
        isZeroCoordinate(parsedEndLat, parsedEndLng)
      ) {
        return res.status(400).json({ success: false, error: 'Valid map coordinates are required', code: 'MAP_COORDINATES_REQUIRED' });
      }

      updatePayload.startLat = parsedStartLat;
      updatePayload.startLng = parsedStartLng;
      updatePayload.endLat = parsedEndLat;
      updatePayload.endLng = parsedEndLng;
      routeCoordsChanged = true;
    }

    if (routeCoordsChanged) {
      try {
        const routePolyline = await fetchRoutePolyline(
          updatePayload.startLat, updatePayload.startLng, updatePayload.endLat, updatePayload.endLng,
        );
        if (routePolyline && routePolyline.length >= 2) {
          updatePayload.routePolyline = routePolyline;
        }
      } catch (routeErr) {
        console.error('Route polyline refresh failed (continuing without it):', routeErr.message);
      }
    }

    if (departureTime != null) {
      const parsedDeparture = new Date(departureTime);
      if (Number.isNaN(parsedDeparture.getTime())) {
        return res.status(400).json({ success: false, error: 'departureTime is invalid', code: 'INVALID_DEPARTURE_TIME' });
      }
      if (parsedDeparture <= new Date()) {
        return res.status(400).json({ success: false, error: 'departureTime must be in the future', code: 'PAST_DEPARTURE_TIME' });
      }
      updatePayload.departureTime = parsedDeparture.toISOString();
    }

    if (suggestedFare != null) {
      const parsedFare = parseNumber(suggestedFare);
      if (!parsedFare || parsedFare <= 0) {
        return res.status(400).json({ success: false, error: 'suggestedFare must be greater than 0', code: 'INVALID_FARE' });
      }
      if (parsedFare < 50) {
        return res.status(400).json({ success: false, error: 'Minimum fare is Rs 50', code: 'FARE_TOO_LOW' });
      }
      updatePayload.suggestedFare = parsedFare;
    }

    if (totalSeats != null) {
      const parsedSeats = parseInt(totalSeats, 10);
      if (!Number.isInteger(parsedSeats) || parsedSeats < 1) {
        return res.status(400).json({ success: false, error: 'totalSeats must be at least 1', code: 'INVALID_TOTAL_SEATS' });
      }
      const currentAvailable = Number(existingRide.availableSeats ?? existingRide.totalSeats ?? parsedSeats);
      updatePayload.totalSeats = parsedSeats;
      updatePayload.availableSeats = Math.max(0, Math.min(currentAvailable, parsedSeats));
    }

    if (rideType != null) {
      updatePayload.rideType = String(rideType).toLowerCase();
    }

    if (rideMode != null) {
      const normalizedRideMode = String(rideMode).toLowerCase();
      if (!['share', 'solo'].includes(normalizedRideMode)) {
        return res.status(400).json({ success: false, error: 'rideMode must be share or solo', code: 'INVALID_RIDE_MODE' });
      }
      updatePayload.rideMode = normalizedRideMode;
    }

    await rideRef.update(updatePayload);
    const updatedDoc = await rideRef.get();
    return res.json({ success: true, message: 'Ride updated successfully', ride: serializeRide(updatedDoc.id, updatedDoc.data()) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'UPDATE_RIDE_ERROR' });
  }
};

// ─── DELETE RIDE ──────────────────────────────────────────
const deleteRide = async (req, res) => {
  const { rideId } = req.params;
  const uid = req.user ? req.user.uid : req.body.captainId;
  if (!uid) return res.status(400).json({ success: false, error: 'Captain ID is required', code: 'MISSING_CAPTAIN_ID' });

  try {
    const rideRef = db.collection('rides').doc(rideId);
    const rideDoc = await rideRef.get();
    if (!rideDoc.exists) return res.status(404).json({ success: false, error: 'Ride not found', code: 'RIDE_NOT_FOUND' });
    if (rideDoc.data().captainId !== uid) return res.status(403).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });

    const dealsSnap = await db.collection('deals').where('rideId', '==', rideId).get();
    const now = new Date().toISOString();
    const batch = db.batch();
    dealsSnap.docs.forEach((dealDoc) => {
      const status = (dealDoc.data().status || '').toString().toLowerCase();
      if ([DEAL_STATUS.PENDING, DEAL_STATUS.CONFIRMED, DEAL_STATUS.STARTED].includes(status)) {
        batch.update(dealDoc.ref, {
          status: DEAL_STATUS.CANCELLED,
          cancelledBy: 'captain_delete',
          updatedAt: now,
        });
      }
    });
    batch.delete(rideRef);
    await batch.commit();

    await Promise.all(
      dealsSnap.docs
        .map((dealDoc) => dealDoc.data())
        .filter((deal) => deal.customerId && [DEAL_STATUS.PENDING, DEAL_STATUS.CONFIRMED, DEAL_STATUS.STARTED].includes((deal.status || '').toString().toLowerCase()))
        .map((deal) => pushToUser(deal.customerId, {
          title: 'Ride unavailable',
          body: 'The captain deleted this ride post.',
          type: 'deal_cancelled',
          data: { rideId, screen: 'my-bookings' },
        }).catch(() => null)),
    );

    return res.json({
      success: true,
      message: 'Ride deleted successfully',
      cancelledBookings: dealsSnap.docs.length,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'DELETE_RIDE_ERROR' });
  }
};

// ─── GET MY RIDES ─────────────────────────────────────────
const getMyRides = async (req, res) => {
  const uid = req.user ? req.user.uid : req.query.captainId;
  if (!uid) return res.status(400).json({ success: false, error: 'Captain ID is required', code: 'MISSING_CAPTAIN_ID' });

  try {
    await maybeCleanupExpiredRides();
    const snap = await db.collection('rides').where('captainId', '==', uid).orderBy('createdAt', 'desc').get();
    const rides = snap.docs.map(d => serializeRide(d.id, d.data()));
    return res.json({ success: true, rides });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_MY_RIDES_ERROR' });
  }
};

// ─── GET RIDE BY ID ───────────────────────────────────────
const getRideById = async (req, res) => {
  const { rideId } = req.params;
  try {
    await maybeCleanupExpiredRides();
    const rideDoc = await db.collection('rides').doc(rideId).get();
    if (!rideDoc.exists) return res.status(404).json({ success: false, error: 'Ride not found', code: 'RIDE_NOT_FOUND' });
    res.set('Cache-Control', 'public, max-age=10');
    return res.json({ success: true, ride: serializeRide(rideDoc.id, rideDoc.data()) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_RIDE_BY_ID_ERROR' });
  }
};

// ─── UPDATE RIDE LOCATION ─────────────────────────────────
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

// ─── GET CAPTAIN STATS ────────────────────────────────────
const getCaptainStats = async (req, res) => {
  try {
    const captainId = req.user.uid;
    const now = new Date();

    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const ridesSnap = await db
      .collection('rides')
      .where('captainId', '==', captainId)
      .where('status', '==', 'completed')
      .get();

    const completedDealsSnap = await db
      .collection('deals')
      .where('captainId', '==', captainId)
      .where('status', '==', DEAL_STATUS.COMPLETED)
      .get();

    const txSnap = await db
      .collection('transactions')
      .where('walletId', '==', captainId)
      .get();

    const earningTypes = new Set(['ride_earning', 'earning', 'commission_credit', 'topup']);
    const deductionTypes = new Set(['commission_deduction', 'commission']);

    function calcStats(filterFn) {
      let ridesCompleted = 0;
      let earningsRs = 0;

      ridesSnap.docs.forEach((doc) => {
        const data = doc.data();
        const completedAt = new Date(data.completedAt || data.updatedAt || data.createdAt || 0);
        if (filterFn(completedAt)) ridesCompleted++;
      });

      txSnap.docs.forEach((doc) => {
        const tx = doc.data();
        const createdAt = new Date(tx.createdAt || 0);
        if (!filterFn(createdAt)) return;
        const amt = Math.abs(Number(tx.amount || 0));
        if (earningTypes.has(tx.type)) earningsRs += amt;
        else if (deductionTypes.has(tx.type)) earningsRs -= amt;
      });

      return { ridesCompleted, earningsRs: Math.max(0, Math.round(earningsRs)) };
    }

    const today    = calcStats((d) => d >= startOfToday);
    const week     = calcStats((d) => d >= startOfWeek);
    const month    = calcStats((d) => d >= startOfMonth);
    const lifetime = calcStats(() => true);

    const ratedDeals = completedDealsSnap.docs
      .map((doc) => doc.data())
      .filter((deal) => deal.rating != null);
    const reviewCount = ratedDeals.length;
    const ratingSum = ratedDeals.reduce((sum, deal) => sum + Number(deal.rating || 0), 0);
    const averageRating = reviewCount > 0 ? Number((ratingSum / reviewCount).toFixed(2)) : 0;
    const totalCompletedRides = completedDealsSnap.size || lifetime.ridesCompleted;

    await db.collection('users').doc(captainId).set(
      {
        rating: averageRating,
        averageRating,
        reviewCount,
        totalReviews: reviewCount,
        completedRides: totalCompletedRides,
        totalRides: Math.max(totalCompletedRides, lifetime.ridesCompleted),
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );

    return res.json({
      success: true,
      today,
      week,
      month,
      lifetime,
      profile: {
        averageRating,
        reviewCount,
        totalCompletedRides,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'CAPTAIN_STATS_ERROR' });
  }
};

// ─── EXPORTS ──────────────────────────────────────────────
module.exports = {
  postRide,                    // Captain post ride → PASSENGERS ko notification
  postCustomerRideRequest,     // Customer post request → CAPTAINS ko notification
  getActiveRides,
  updateRideStatus,
  getMyRides,
  getRideById,
  updateRideLocation,
  updateRide,
  deleteRide,
  getCaptainStats,
  calculateRouteProximityMeters,
  buildRideRouteSummary,
};
