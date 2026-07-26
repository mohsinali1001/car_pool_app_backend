/**
 * Ride and Deal Status Constants
 * Centralized status management to avoid typos and inconsistencies
 */

const RIDE_STATUS = {
  ACTIVE: 'active',
  FILLED: 'filled',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

const DEAL_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  STARTED: 'started',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

// Statuses that are considered "active" for deals
const ACTIVE_DEAL_STATUSES = [
  DEAL_STATUS.PENDING,
  DEAL_STATUS.CONFIRMED,
  DEAL_STATUS.STARTED,
];

// Statuses that are "terminal" (no further transitions)
const TERMINAL_DEAL_STATUSES = [
  DEAL_STATUS.COMPLETED,
  DEAL_STATUS.CANCELLED,
];

// Cleanup timing constants (in milliseconds)
const CLEANUP_TIMINGS = {
  // Captain "My Rides > Done" - ride marked done after 3 hours
  CAPTAIN_DONE_RETENTION: 3 * 60 * 60 * 1000, // 3 hours
  
  // History/Completed deals delete after six hours
  HISTORY_DELETE: 6 * 60 * 60 * 1000, // 6 hours
  
  // Passenger completed/confirmed booking retention
  PASSENGER_COMPLETED_RETENTION: 6 * 60 * 60 * 1000, // 6 hours

  // Stale confirmed records are archived by lifecycle cleanup.
  CONFIRMED_ARCHIVE: 6 * 60 * 60 * 1000, // 6 hours
  
  // Pending deals auto-cancel after 24 hours
  PENDING_DEAL_EXPIRY: 24 * 60 * 60 * 1000, // 24 hours
  
  // Ride grace period before marking as done / hiding from search
  RIDE_GRACE_PERIOD: 30 * 60 * 1000, // 30 minutes
};

module.exports = {
  RIDE_STATUS,
  DEAL_STATUS,
  ACTIVE_DEAL_STATUSES,
  TERMINAL_DEAL_STATUSES,
  CLEANUP_TIMINGS,
};
