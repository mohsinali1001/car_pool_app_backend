function seatUpdateFromRide(ride, delta) {
  const totalSeats = ride.totalSeats ?? ride.availableSeats ?? 0;
  let available = ride.availableSeats ?? totalSeats;
  available += delta;
  if (available < 0) throw new Error('Ride is full');
  if (available > totalSeats) available = totalSeats;
  return { available, totalSeats };
}

module.exports = { seatUpdateFromRide };
