🚗 CarPool App Backend - Professional Node.js API
This is a secure, high-performance backend built for a Carpooling application. It handles user authentication, ride management, wallet transactions, and real-time notifications using Node.js, Express, and Firebase.

🛡️ Key Features & Security
The backend is designed with a "Security First" approach, featuring:

Firebase Admin SDK: Secure authentication and Firestore database integration.

Wallet System: A built-in wallet that tracks balances and transactions.

Auto-Commission Logic: Automatically deducts a 10% platform fee from captains upon deal confirmation.

Anti-Spam Rate Limiting: Implemented express-rate-limit to prevent Brute-force and DoS attacks.

Ride Security: Captains must maintain a minimum balance of Rs. 200 to post a ride.

Role-Based Access: Strict middleware to separate 'Captain' and 'Customer' functionalities.

🏗️ Project Architecture
The project follows a clean MVC (Model-View-Controller) pattern:

src/app.js: Main entry point with security middleware (Helmet, CORS, Morgan).

src/routes/: Route definitions for Auth, Rides, Deals, and Wallet.

src/controllers/: Core business logic (Wallet deductions, ride posting, etc.).

src/middleware/: Authentication guards and rate limiters.

src/config/: Firebase Admin configuration.

🛠️ API Documentation
🔑 Authentication
POST /api/auth/sync - Syncs Firebase user data with Firestore.

GET /api/auth/profile - Fetches current user profile.

🚘 Ride Management
POST /api/rides - Create a ride (Requires Captain role + Min Rs. 200 balance).

GET /api/rides - Browse all active rides.

PATCH /api/rides/:rideId/status - Update ride status (Active/Filled/Completed).

🤝 Deals & Bookings
POST /api/deals - Customer requests to join a ride.

PATCH /api/deals/:dealId/confirm - Captain confirms deal (Deducts 10% Platform Fee).

PATCH /api/deals/:dealId/cancel - Refund logic if a confirmed deal is cancelled.

💳 Wallet System
GET /api/wallet - Check current balance.

GET /api/wallet/transactions - View all credit/debit history.

POST /api/wallet/topup - Manual wallet recharge.

🚀 How to Run
Clone the repo

Install dependencies:

Bash
npm install
Setup Environment Variables (.env):

Code snippet
PORT=3000
FIREBASE_PROJECT_ID=your-id
FIREBASE_PRIVATE_KEY="your-key"
FIREBASE_CLIENT_EMAIL=your-email
Start the server:

Bash
node server.js
📈 Current Status
Server Status: ✅ Online & Functional

Security: ✅ Verified (Rate limits & JWT active)

Database: ✅ Firebase Firestore Connected