// ===== LOAD ENVIRONMENT VARIABLES =====
require('dotenv').config();

// ===== IMPORT APP =====
const app = require('./src/app');

// ===== PORT CONFIGURATION =====
// Hugging Face uses PORT environment variable, default 7860
const PORT = Number(process.env.PORT || 7860);
const HOST = '0.0.0.0';  // Listen on all interfaces (required for Hugging Face)

// ===== START SERVER =====
const server = app.listen(PORT, HOST, () => {
    console.log(`🚀 CarPool backend running at http://${HOST}:${PORT}`);
    console.log(`📡 Health endpoint: http://${HOST}:${PORT}/health`);
    console.log(`✅ Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔥 Firebase Project: ${process.env.FIREBASE_PROJECT_ID || 'Not Set'}`);
});

// ===== SERVER TIMEOUTS =====
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

// ===== ERROR HANDLING =====
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    server.close(() => {
        process.exit(1);
    });
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    server.close(() => {
        process.exit(1);
    });
});
