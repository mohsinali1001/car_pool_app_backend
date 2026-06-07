const router = require('express').Router();
const { verifyToken, requireCaptain } = require('../middleware/auth');
const {
  syncUser,
  getProfile,
  updateProfile,
  updateFcmToken,
  updateOnlineStatus,
} = require('../controllers/authController');

// ============= AUTH ROUTES =============

router.post('/sync', verifyToken, syncUser);
router.get('/profile', verifyToken, getProfile);
router.patch('/profile', verifyToken, updateProfile);
router.patch('/fcm-token', verifyToken, updateFcmToken);
router.patch('/status', verifyToken, updateOnlineStatus);

// ============= CAPTAIN SPECIFIC ROUTES =============

router.patch('/profile/captain', verifyToken, async (req, res) => {
  const { db } = require('../config/firebase');
  const {
    phone,
    gender,
    captainVerificationStatus,
    city,
    vehicleMake,
    vehicleModel,
    captainVehicleType,
    vehicleColor,
    vehicleRegistration,
    vehicleYear,
    vehicleSeats,
  } = req.body;

  try {
    // Validate gender
    const genderValue = gender == null ? null : String(gender).trim().toLowerCase();
    if (gender !== undefined && !['male', 'female'].includes(genderValue)) {
      return res.status(400).json({
        success: false,
        error: 'gender must be male or female',
        code: 'INVALID_GENDER',
      });
    }

    // Validate captainVehicleType
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

    const userRef = db.collection('users').doc(req.user.uid);
    const userSnap = await userRef.get();
    const existingStatus = userSnap.exists ? userSnap.data().captainVerificationStatus : null;
    const lockedStatus =
      existingStatus === 'pending_verification' || existingStatus === 'verified';

    const updateData = {
      captainVerificationStatus: lockedStatus
        ? existingStatus
        : captainVerificationStatus || existingStatus || 'pending_verification',
      isVerified: false,
      updatedAt: new Date().toISOString(),
    };

    const setIfPresent = (key, value, normalize = (v) => v) => {
      if (value !== undefined) {
        const normalized = normalize(value);
        updateData[key] = normalized === '' ? null : normalized;
      }
    };

    setIfPresent('phone', phone, (v) => String(v).trim());
    setIfPresent('city', city, (v) => String(v).trim());
    setIfPresent('vehicleMake', vehicleMake, (v) => String(v).trim());
    setIfPresent('vehicleModel', vehicleModel, (v) => String(v).trim());
    setIfPresent('captainVehicleType', normalizedCaptainVehicleType);
    setIfPresent('vehicleColor', vehicleColor, (v) => String(v).trim());
    setIfPresent('vehicleRegistration', vehicleRegistration, (v) => String(v).trim());
    setIfPresent('vehicleYear', vehicleYear);
    setIfPresent('vehicleSeats', vehicleSeats);

    if (gender !== undefined) {
      updateData.gender = genderValue;
    }

    await userRef.set(updateData, { merge: true });

    return res.json({
      success: true,
      message: 'Captain profile updated successfully',
    });
  } catch (err) {
    console.error('Error updating captain profile:', err);
    return res.status(500).json({
      success: false,
      error: err.message,
      code: 'CAPTAIN_UPDATE_ERROR',
    });
  }
});

module.exports = router;
