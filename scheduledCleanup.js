/**
 * scheduledCleanup.js
 * 
 * Scheduled cleanup job for expired rides and old deals.
 * 
 * Run this via:
 * 1. Firebase Cloud Scheduler (recommended for Firebase projects)
 * 2. Linux cron job (for VPS / dedicated server)
 * 3. node-cron package in a separate process
 * 4. GitHub Actions scheduled workflow
 * 5. Manual execution: node scheduledCleanup.js
 * 
 * Frequency: Every 5-10 minutes
 * 
 * ⚠️ IMPORTANT: This file should NEVER be imported into API route handlers.
 * It is meant to run as a standalone background job ONLY.
 */

// Load environment variables
require('dotenv').config();

const { runAllCleanup } = require('./src/utils/throttledCleanup');

// Configuration
const CONFIG = {
  // Maximum execution time in milliseconds (5 minutes)
  MAX_EXECUTION_TIME: 5 * 60 * 1000,
  // Enable detailed logging
  VERBOSE: true,
  // Exit code for success
  EXIT_SUCCESS: 0,
  // Exit code for failure
  EXIT_FAILURE: 1,
};

/**
 * Format duration in a human-readable format
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Log with timestamp
 */
function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

/**
 * Main cleanup function with timeout protection
 */
async function main() {
  const startTime = Date.now();
  let exitCode = CONFIG.EXIT_SUCCESS;
  
  try {
    log('🚀 Starting scheduled cleanup job...');
    log(`📋 Configuration: MAX_EXECUTION_TIME=${CONFIG.MAX_EXECUTION_TIME}ms, VERBOSE=${CONFIG.VERBOSE}`);
    
    // Set a timeout to prevent infinite execution
    const timeoutId = setTimeout(() => {
      log('⏰ Cleanup job exceeded maximum execution time!', 'ERROR');
      process.exit(CONFIG.EXIT_FAILURE);
    }, CONFIG.MAX_EXECUTION_TIME);
    
    // Run the cleanup
    await runAllCleanup();
    
    // Clear the timeout
    clearTimeout(timeoutId);
    
    const duration = Date.now() - startTime;
    log(`✅ Cleanup job completed successfully in ${formatDuration(duration)}`);
    
  } catch (error) {
    log(`❌ Cleanup job failed: ${error.message}`, 'ERROR');
    
    if (CONFIG.VERBOSE) {
      console.error(error.stack);
    }
    
    exitCode = CONFIG.EXIT_FAILURE;
    
  } finally {
    // Always log the final status
    const duration = Date.now() - startTime;
    log(`📊 Job finished with exit code ${exitCode} after ${formatDuration(duration)}`);
    
    // Exit with appropriate code
    process.exit(exitCode);
  }
}

/**
 * Handle uncaught exceptions
 */
process.on('uncaughtException', (error) => {
  log(`💥 Uncaught exception: ${error.message}`, 'ERROR');
  console.error(error.stack);
  process.exit(CONFIG.EXIT_FAILURE);
});

/**
 * Handle unhandled promise rejections
 */
process.on('unhandledRejection', (reason, promise) => {
  log(`💥 Unhandled rejection at: ${promise}`, 'ERROR');
  console.error(reason);
  process.exit(CONFIG.EXIT_FAILURE);
});

/**
 * Handle process signals
 */
process.on('SIGINT', () => {
  log('🛑 Received SIGINT signal, shutting down...');
  process.exit(CONFIG.EXIT_SUCCESS);
});

process.on('SIGTERM', () => {
  log('🛑 Received SIGTERM signal, shutting down...');
  process.exit(CONFIG.EXIT_SUCCESS);
});

// =============================================
// EXECUTION
// =============================================

// Run if called directly (not imported)
if (require.main === module) {
  // Check if we're in a Node.js environment
  if (typeof process !== 'undefined' && process.version) {
    log(`🖥️ Node.js version: ${process.version}`);
    log(`📂 Current directory: ${process.cwd()}`);
    main();
  } else {
    console.error('❌ This script must be run in a Node.js environment');
    process.exit(CONFIG.EXIT_FAILURE);
  }
}

// Export for programmatic usage (if needed)
module.exports = {
  main,
  CONFIG,
  formatDuration,
  log,
};
