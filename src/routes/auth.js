const router = require('express').Router();
const { verifyToken, requireCaptain } = require('../middleware/auth');
const { syncUser, getProfile, updateProfile, updateFcmToken } = require('../controllers/authController');

// ============= AUTH ROUTES =============

router.post('/sync', verifyToken, syncUser);
router.get('/profile', verifyToken, getProfile);
router.patch('/profile', verifyToken, updateProfile);
router.patch('/fcm-token', verifyToken, updateFcmToken);

// ============= CAPTAIN SPECIFIC ROUTES =============

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
    emergencyContactPhone,
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
      phone: phone || '',
      captainVerificationStatus: lockedStatus
        ? existingStatus
        : captainVerificationStatus || existingStatus || 'pending_verification',
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
      if (updateData[key] === undefined) delete updateData[key];
    });

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
