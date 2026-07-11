const admin = require('firebase-admin');
require('dotenv').config();

// Log environment check (for debugging)
console.log('🔧 Initializing Firebase...');
console.log('📋 Checking environment variables:');
console.log('  - FIREBASE_PROJECT_ID:', process.env.FIREBASE_PROJECT_ID ? '✅ Set' : '❌ Missing');
console.log('  - FIREBASE_PRIVATE_KEY:', process.env.FIREBASE_PRIVATE_KEY ? '✅ Set' : '❌ Missing');
console.log('  - FIREBASE_CLIENT_EMAIL:', process.env.FIREBASE_CLIENT_EMAIL ? '✅ Set' : '❌ Missing');

// Check if Firebase credentials exist
if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_PRIVATE_KEY || !process.env.FIREBASE_CLIENT_EMAIL) {
    console.error('❌ Firebase credentials missing! Please set environment variables.');
    console.error('Required: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL');
    
    // Export empty objects to prevent app crash (but features won't work)
    module.exports = { 
        admin: admin, 
        db: null, 
        auth: null, 
        messaging: null 
    };
} else {
    try {
        // Initialize Firebase only if not already initialized
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                }),
            });
            console.log('✅ Firebase initialized successfully!');
            console.log(`📁 Project: ${process.env.FIREBASE_PROJECT_ID}`);
        } else {
            console.log('✅ Firebase already initialized');
        }

        // Initialize Firestore, Auth, Messaging
        const db = admin.firestore();
        const auth = admin.auth();
        const messaging = admin.messaging();

        console.log('✅ Firestore connected');
        console.log('✅ Firebase Auth ready');
        console.log('✅ Firebase Messaging ready');

        // Export everything
        module.exports = { 
            admin, 
            db, 
            auth, 
            messaging 
        };

    } catch (error) {
        console.error('❌ Firebase initialization error:', error.message);
        console.error('Stack:', error.stack);
        
        // Export with error - app will handle gracefully
        module.exports = { 
            admin: admin, 
            db: null, 
            auth: null, 
            messaging: null 
        };
    }
}