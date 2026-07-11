/** Ride document statuses */
const RIDE_STATUS = {
  ACTIVE: 'active',
  FILLED: 'filled',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

/** Deal (booking) statuses */
const DEAL_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  STARTED: 'started',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

const ACTIVE_DEAL_STATUSES = [
  DEAL_STATUS.PENDING,
  DEAL_STATUS.CONFIRMED,
  DEAL_STATUS.STARTED,
];

const TERMINAL_DEAL_STATUSES = [DEAL_STATUS.COMPLETED, DEAL_STATUS.CANCELLED];

module.exports = {
  RIDE_STATUS,
  DEAL_STATUS,
  ACTIVE_DEAL_STATUSES,
  TERMINAL_DEAL_STATUSES,
};
