const { db } = require('../config/firebase');

const ALLOWED_USER_FIELDS = [
  'name',
  'phone',
  'role',
  'gender',
  'cnic',
  'cnicFrontUrl',
  'cnicBackUrl',
  'vehicleMake',
  'vehicleModel',
  'vehicleColor',
  'vehicleRegistration',
  'vehicleYear',
  'vehicleSeats',
  'city',
  'vehiclePhotoUrl',
  'captainVehicleType',
  'emergencyContactName',
  'emergencyContactPhone',
  'captainVerificationStatus',
];

// Simple in-memory cache for profiles (5 seconds TTL)
const userCache = new Map();

function normalizeGender(value) {
  if (value === undefined || value === null || value === '') return null;
  const gender = String(value).trim().toLowerCase();
  if (gender === 'male' || gender === 'female') return gender;
  return null;
}

function pickUpdates(body) {
  const updates = {};
  for (const key of ALLOWED_USER_FIELDS) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
      updates[key] = body[key];
    }
  }
  return updates;
}

async function ensureCaptainWallet(uid) {
  const walletRef = db.collection('wallets').doc(uid);
  const walletSnap = await walletRef.get();
  if (!walletSnap.exists) {
    await walletRef.set({
      id: uid,
      userId: uid,
      balance: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}

const syncUser = async (req, res) => {
  const { uid } = req.user;
  const body = req.body;
  const incomingGender = normalizeGender(body.gender);

  if (body.gender !== undefined && incomingGender === null) {
    return res.status(400).json({
      success: false,
      error: 'gender must be male or female',
      code: 'INVALID_GENDER',
    });
  }

  try {
    const userRef = db.collection('users').doc(uid);
    const snap = await userRef.get();

    if (!snap.exists) {
      const role = body.role || 'customer';
      const userRole = role || 'customer';
      const isCaptain = userRole === 'captain';
      
      // Minimal user data for faster writes
      const userData = {
        id: uid,
        uid: uid,
        email: req.user.email || '',
        name: body.name || req.user.name || '',
        phone: body.phone || '',
        role: userRole,
        gender: incomingGender,
        isVerified: userRole === 'customer' || userRole === 'passenger',
        captainVerificationStatus:
          body.captainVerificationStatus ||
          (isCaptain ? 'pending_verification' : null),
        cnicFrontUrl: body.cnicFrontUrl || null,
        cnicBackUrl: body.cnicBackUrl || null,
        cnic: body.cnic || null,
        vehicleMake: body.vehicleMake || null,
        vehicleModel: body.vehicleModel || null,
        vehicleColor: body.vehicleColor || null,
        vehicleRegistration: body.vehicleRegistration || null,
        vehicleYear: body.vehicleYear || null,
        vehicleSeats: body.vehicleSeats ? parseInt(body.vehicleSeats, 10) : null,
        city: body.city || null,
        vehiclePhotoUrl: body.vehiclePhotoUrl || null,
        captainVehicleType: body.captainVehicleType || null,
        emergencyContactName: body.emergencyContactName || null,
        emergencyContactPhone: body.emergencyContactPhone || null,
        rating: 0.0,
        totalRides: 0,
        fcmToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await userRef.set(userData);

      if (isCaptain) {
        await ensureCaptainWallet(uid);
      }
      
      // Clear cache for this user
      userCache.delete(uid);

      return res.status(201).json({ success: true, user: userData });
    }

    // Update existing user
    const updates = pickUpdates(body);
    const existing = snap.data() || {};
    const existingStatus = existing.captainVerificationStatus;
    const isStatusLocked =
      existingStatus === 'pending_verification' || existingStatus === 'verified';

    if (incomingGender) {
      updates.gender = incomingGender;
    }

    if (isStatusLocked && updates.captainVerificationStatus !== undefined) {
      delete updates.captainVerificationStatus;
    }

    const nextRole = updates.role || existing.role;
    if (
      nextRole === 'captain' &&
      !isStatusLocked &&
      (!existingStatus || String(existingStatus).trim() === '') &&
      updates.captainVerificationStatus === undefined
    ) {
      updates.captainVerificationStatus = 'pending_verification';
    }
    
    if (Object.keys(updates).length > 0) {
      if (updates.captainVerificationStatus === 'pending_verification') {
        updates.isVerified = false;
      }
      if (updates.captainVerificationStatus === 'verified') {
        updates.isVerified = true;
      }

      updates.updatedAt = new Date().toISOString();
      await userRef.update(updates);
      
      // Clear cache for this user
      userCache.delete(uid);

      const role = updates.role || snap.data().role;
      if (role === 'captain') {
        await ensureCaptainWallet(uid);
      }
    }

    const updated = await userRef.get();
    return res.json({ success: true, user: updated.data() });
  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ success: false, error: err.message, code: 'SYNC_ERROR' });
  }
};

const getProfile = async (req, res) => {
  try {
    const uid = req.user.uid;
    
    // Check cache first (faster)
    if (userCache.has(uid)) {
      return res.json({ success: true, user: userCache.get(uid) });
    }
    
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
    }
    
    const userData = doc.data();
    
    // Store in cache with 5 seconds TTL
    userCache.set(uid, userData);
    setTimeout(() => userCache.delete(uid), 5000);
    
    return res.json({ success: true, user: userData });
  } catch (err) {
    console.error('Profile error:', err);
    return res.status(500).json({ success: false, error: err.message, code: 'PROFILE_ERROR' });
  }
};

const updateProfile = async (req, res) => {
  const { uid } = req.user;
  const updates = pickUpdates(req.body);
  const incomingGender = normalizeGender(req.body.gender);

  if (req.body.gender !== undefined && incomingGender === null) {
    return res.status(400).json({
      success: false,
      error: 'gender must be male or female',
      code: 'INVALID_GENDER',
    });
  }

  try {
    const userRef = db.collection('users').doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) {
      return res.status(404).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ success: true, user: snap.data() });
    }

    const existing = snap.data() || {};
    const existingStatus = existing.captainVerificationStatus;
    const isStatusLocked =
      existingStatus === 'pending_verification' || existingStatus === 'verified';

    if (incomingGender) {
      updates.gender = incomingGender;
    }

    if (isStatusLocked && updates.captainVerificationStatus !== undefined) {
      delete updates.captainVerificationStatus;
    }

    const nextRole = updates.role || existing.role;
    if (
      nextRole === 'captain' &&
      !isStatusLocked &&
      (!existingStatus || String(existingStatus).trim() === '') &&
      updates.captainVerificationStatus === undefined
    ) {
      updates.captainVerificationStatus = 'pending_verification';
    }

    if (updates.captainVerificationStatus === 'pending_verification') {
      updates.isVerified = false;
    }
    if (updates.captainVerificationStatus === 'verified') {
      updates.isVerified = true;
    }

    updates.updatedAt = new Date().toISOString();
    await userRef.update(updates);
    
    // Clear cache for this user
    userCache.delete(uid);

    const role = updates.role || snap.data().role;
    if (role === 'captain') {
      await ensureCaptainWallet(uid);
    }

    const updated = await userRef.get();
    return res.json({ success: true, user: updated.data() });
  } catch (err) {
    console.error('Update profile error:', err);
    return res.status(500).json({ success: false, error: err.message, code: 'PROFILE_UPDATE_ERROR' });
  }
};

const updateFcmToken = async (req, res) => {
  const { fcmToken } = req.body;
  const uid = req.user.uid;
  try {
    await db.collection('users').doc(uid).set(
      { fcmToken, updatedAt: new Date().toISOString() },
      { merge: true }
    );
    
    // Clear cache to ensure updated token reflects everywhere
    userCache.delete(uid);

    return res.json({ success: true, message: 'FCM token updated' });
  } catch (err) {
    console.error('FCM update error:', err);
    return res.status(500).json({ success: false, error: err.message, code: 'FCM_UPDATE_ERROR' });
  }
};

module.exports = { syncUser, getProfile, updateProfile, updateFcmToken };
