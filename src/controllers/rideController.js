const { db } = require('../config/firebase');
const { getBalance } = require('../utils/walletHelper');

/**
 * 1. Post a new ride
 * Huzaifa's Logic: Verification + Wallet Check
 */
const postRide = async (req, res) => {
  const uid = req.user ? req.user.uid : req.body.captainId;

  if (!uid) {
    return res.status(400).json({ success: false, error: 'Captain ID is required', code: 'MISSING_CAPTAIN_ID' });
  }

  try {
    // 🛡️ SECURITY CHECK 1: User Verification
    const userDoc = await db.collection('users').doc(uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User profile not found. Please complete your profile.', code: 'USER_NOT_FOUND' });
    }

    const userData = userDoc.data();
    const verificationStatus = userData.captainVerificationStatus;
    const isCaptainVerified =
      verificationStatus === 'verified' ||
      verificationStatus === 'approved' ||
      userData.isVerified === true;

    if (!isCaptainVerified) {
      return res.status(403).json({
        success: false,
        error: 'Your documents are under review. You will be notified once verified.',
        code: 'NOT_VERIFIED'
      });
    }

    const requiredVehicleFields = [
      'vehicleMake',
      'vehicleModel',
      'vehicleColor',
      'vehicleRegistration',
    ];
    const missingVehicle = requiredVehicleFields.filter(
      (f) => !userData[f] || String(userData[f]).trim() === '',
    );
    if (missingVehicle.length > 0) {
      return res.status(403).json({
        success: false,
        error: 'Complete your vehicle details in your captain profile before posting rides.',
        code: 'INCOMPLETE_VEHICLE_DETAILS'
      });
    }

    // Check wallet balance if needed
    await getBalance(uid);

    const {
      startLocation, endLocation,
      startLat, startLng, endLat, endLng,
      departureTime, totalSeats, suggestedFare,
      rideType, acceptsDelivery, vehicleInfo,
    } = req.body;

    // Validation
    if (!startLocation || !endLocation || !departureTime || !totalSeats || !suggestedFare) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: startLocation, endLocation, departureTime, totalSeats, suggestedFare',
        code: 'MISSING_FIELDS'
      });
    }

    // Ride Data Object
    const ride = {
      captainId: uid,
      captainName: userData.name || 'Anonymous',
      captainRating: userData.rating || 5.0,
      startLocation: startLocation.trim(),
      endLocation: endLocation.trim(),
      startLat: parseFloat(startLat) || 0.0,
      startLng: parseFloat(startLng) || 0.0,
      endLat: parseFloat(endLat) || 0.0,
      endLng: parseFloat(endLng) || 0.0,
      departureTime: new Date(departureTime).toISOString(),
      totalSeats: parseInt(totalSeats),
      availableSeats: parseInt(totalSeats),
      full: false,
      suggestedFare: parseFloat(suggestedFare),
      rideType: rideType || 'random',
      acceptsDelivery: acceptsDelivery || false,
      vehicleInfo: vehicleInfo || `${userData.vehicleMake || ''} ${userData.vehicleModel || ''}`.trim() || 'Not Specified',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Database mein add karna
    const ref = await db.collection('rides').add(ride);

    // Success Response
    return res.status(201).json({
      success: true,
      message: "Ride posted successfully!",
      rideId: ref.id,
      ride: { id: ref.id, ...ride }
    });

  } catch (err) {
    console.error("CRITICAL ERROR in postRide:", err);
    return res.status(500).json({ 
      success: false, 
      error: "Internal Server Error: " + err.message, 
      code: 'POST_RIDE_ERROR' 
    });
  }
};

/**
 * 2. Get Active Rides (With Advanced Filtering - No Index Required)
 */
const getActiveRides = async (req, res) => {
  const { rideType, startLocation } = req.query;

  try {
    // Simple query without complex filters to avoid index requirement
    let query = db.collection('rides').where('status', '==', 'active');
    
    // Sirf future rides dikhane ke liye
    const now = new Date().toISOString();
    query = query.where('departureTime', '>=', now);
    
    const snap = await query.orderBy('departureTime').get();
    let rides = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Manual filtering for rideType (avoids composite index)
    if (rideType && rideType !== 'all' && rideType !== 'random') {
      rides = rides.filter(r => r.rideType === rideType);
    }

    // Manual filtering for location search (case-insensitive)
    if (startLocation) {
      const q = startLocation.toLowerCase();
      rides = rides.filter(r =>
        r.startLocation.toLowerCase().includes(q) ||
        r.endLocation.toLowerCase().includes(q)
      );
    }

    return res.json({ success: true, count: rides.length, rides });
  } catch (err) {
    console.error("Error fetching rides:", err);
    return res.status(500).json({ 
      success: false, 
      error: err.message, 
      code: 'GET_RIDES_ERROR' 
    });
  }
};

/**
 * 3. Update Ride Status
 */
const updateRideStatus = async (req, res) => {
  const { rideId } = req.params;
  const { status } = req.body;
  const uid = req.user ? req.user.uid : req.body.captainId;

  const validStatuses = ['active', 'filled', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid status type', 
      code: 'INVALID_STATUS' 
    });
  }

  try {
    const rideRef = db.collection('rides').doc(rideId);
    const rideDoc = await rideRef.get();

    if (!rideDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        error: 'Ride not found', 
        code: 'RIDE_NOT_FOUND' 
      });
    }

    // Auth Check: Sirf captain apni ride update kar sakay
    if (rideDoc.data().captainId !== uid) {
      return res.status(403).json({ 
        success: false, 
        error: 'Unauthorized: You do not own this ride', 
        code: 'UNAUTHORIZED' 
      });
    }

    await rideRef.update({
      status,
      updatedAt: new Date().toISOString()
    });

    return res.json({ 
      success: true, 
      message: `Ride marked as ${status}` 
    });
  } catch (err) {
    return res.status(500).json({ 
      success: false, 
      error: err.message, 
      code: 'UPDATE_RIDE_ERROR' 
    });
  }
};

/**
 * 4. Get My Rides (Captain sees their own posted rides)
 */
const getMyRides = async (req, res) => {
  const uid = req.user ? req.user.uid : req.query.captainId;

  if (!uid) {
    return res.status(400).json({ 
      success: false, 
      error: 'Captain ID is required', 
      code: 'MISSING_CAPTAIN_ID' 
    });
  }

  try {
    const snap = await db.collection('rides')
      .where('captainId', '==', uid)
      .orderBy('createdAt', 'desc')
      .get();

    const rides = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, rides });
  } catch (err) {
    return res.status(500).json({ 
      success: false, 
      error: err.message, 
      code: 'GET_MY_RIDES_ERROR' 
    });
  }
};

/**
 * 5. Get Ride By ID
 */
const getRideById = async (req, res) => {
  const { rideId } = req.params;

  try {
    const rideDoc = await db.collection('rides').doc(rideId).get();
    
    if (!rideDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        error: 'Ride not found', 
        code: 'RIDE_NOT_FOUND' 
      });
    }

    return res.json({ 
      success: true, 
      ride: { id: rideDoc.id, ...rideDoc.data() } 
    });
  } catch (err) {
    return res.status(500).json({ 
      success: false, 
      error: err.message, 
      code: 'GET_RIDE_BY_ID_ERROR' 
    });
  }
};

/**
 * 6. Update Ride Location (Captain GPS updates)
 */
const updateRideLocation = async (req, res) => {
  const { rideId } = req.params;
  const { lat, lng } = req.body;
  const uid = req.user ? req.user.uid : req.body.captainId;

  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ 
      success: false, 
      error: 'Latitude and Longitude are required', 
      code: 'MISSING_COORDINATES' 
    });
  }

  try {
    const rideRef = db.collection('rides').doc(rideId);
    const rideDoc = await rideRef.get();

    if (!rideDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        error: 'Ride not found', 
        code: 'RIDE_NOT_FOUND' 
      });
    }

    if (rideDoc.data().captainId !== uid) {
      return res.status(403).json({ 
        success: false, 
        error: 'Unauthorized: You do not own this ride', 
        code: 'UNAUTHORIZED' 
      });
    }

    await rideRef.update({
      captainLat: parseFloat(lat),
      captainLng: parseFloat(lng),
      updatedAt: new Date().toISOString()
    });

    return res.json({ 
      success: true, 
      message: 'Location updated successfully' 
    });
  } catch (err) {
    return res.status(500).json({ 
      success: false, 
      error: err.message, 
      code: 'UPDATE_LOCATION_ERROR' 
    });
  }
};

module.exports = {
  postRide,
  getActiveRides,
  updateRideStatus,
  getMyRides,
  getRideById,
  updateRideLocation
};