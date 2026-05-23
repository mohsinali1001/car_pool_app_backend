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
    captainVerificationStatus, 
    cnicFrontUrl, 
    cnicBackUrl,
    cnic,
    city,
    vehicleMake,
    vehicleModel,
    vehicleColor,
    vehicleRegistration,
    vehicleYear,
    vehicleSeats,
    emergencyContactName,
    emergencyContactPhone
  } = req.body;

  try {
    const updateData = {
      phone: phone || '',
      captainVerificationStatus: captainVerificationStatus || 'pending_verification',
      cnicFrontUrl: cnicFrontUrl || null,
      cnicBackUrl: cnicBackUrl || null,
      cnic: cnic || null,
      city: city || null,
      vehicleMake: vehicleMake || null,
      vehicleModel: vehicleModel || null,
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

    await db.collection('users').doc(req.user.uid).update(updateData);

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