
const router = require('express').Router();
const { verifyToken, requireCaptain } = require('../middleware/auth');
const { syncUser, getProfile, updateProfile, updateFcmToken } = require('../controllers/authController');

// ============= AUTH ROUTES =============

// Sync user after signup
router.post('/sync', verifyToken, syncUser);

// Get user profile
router.get('/profile', verifyToken, getProfile);

// Update user profile
router.patch('/profile', verifyToken, updateProfile);

// Update FCM token
router.patch('/fcm-token', verifyToken, updateFcmToken);

// ============= CAPTAIN SPECIFIC ROUTES =============

// Update captain profile with CNIC and vehicle details
router.patch('/profile/captain', verifyToken, async (req, res) => {
  const { db } = require('../config/firebase');
  const { 
    phone, 
    gender,
    captainVerificationStatus, 
    cnicFrontUrl, 
    cnicBackUrl,
    cnic,
    city,
    vehicleMake,
    vehicleModel,
    captainVehicleType,
    vehicleColor,
    vehicleRegistration,
    vehicleYear,
    vehicleSeats,
    emergencyContactName,
    emergencyContactPhone
  } = req.body;

  try {
    const genderValue = gender == null ? null : String(gender).trim().toLowerCase();
    if (gender !== undefined && !['male', 'female'].includes(genderValue)) {
      return res.status(400).json({
        success: false,
        error: 'gender must be male or female',
        code: 'INVALID_GENDER',
      });
    }

    const userRef = db.collection('users').doc(req.user.uid);
    const userSnap = await userRef.get();
    const existingStatus = userSnap.exists ? userSnap.data().captainVerificationStatus : null;
    const lockedStatus =
      existingStatus === 'pending_verification' || existingStatus === 'verified';

    const updateData = {
      phone: phone || '',
      captainVerificationStatus: lockedStatus
        ? existingStatus
        : (captainVerificationStatus || existingStatus || 'pending_verification'),
      cnicFrontUrl: cnicFrontUrl || null,
      cnicBackUrl: cnicBackUrl || null,
      cnic: cnic || null,
      city: city || null,
      vehicleMake: vehicleMake || null,
      vehicleModel: vehicleModel || null,
      captainVehicleType: normalizedCaptainVehicleType || null,
      vehicleColor: vehicleColor || null,
      vehicleRegistration: vehicleRegistration || null,
      vehicleYear: vehicleYear || null,
      vehicleSeats: vehicleSeats || null,
      emergencyContactName: emergencyContactName || null,
      emergencyContactPhone: emergencyContactPhone || null,
      isVerified: false,
      updatedAt: new Date().toISOString(),
    };

    // Remove undefined fields
    Object.keys(updateData).forEach(key => {
      if (updateData[key] === undefined) {
        delete updateData[key];
      }
    });
    if (gender !== undefined) {
      updateData.gender = genderValue;
    }

    await userRef.update(updateData);

    return res.json({ 
      success: true, 
      message: 'Captain profile updated successfully' 
    });
  } catch (err) {
    console.error('Error updating captain profile:', err);
    return res.status(500).json({ 
      success: false, 
      error: err.message,
      code: 'CAPTAIN_UPDATE_ERROR' 
    });
  }
});
router.patch('/profile', verifyToken, async (req, res) => {
  const { db } = require('../config/firebase');
  try {
    const userRef = db.collection('users').doc(req.user.uid);
    const snap = await userRef.get();
    if (!snap.exists) {
      return res.status(404).json({ success: 'false', error: 'User not found', code: 'USER_NOT_FOUND' });
    }
    await userRef.set({ ...req.body, updatedAt: new Date().toISOString() }, { merge: true });
    const updated = await userRef.get();
    return res.json({ success: true, user: updated.data() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
    const normalizedCaptainVehicleType = captainVehicleType == null
      ? null
      : String(captainVehicleType).trim().toLowerCase();
    if (
      captainVehicleType !== undefined &&
      !['car', 'bike', 'bus', 'truck', 'shazore', 'tour'].includes(normalizedCaptainVehicleType)
    ) {
      return res.status(400).json({
        success: false,
        error: 'captainVehicleType must be one of car, bike, bus, truck, shazore, tour',
        code: 'INVALID_CAPTAIN_VEHICLE_TYPE',
      });
    }
