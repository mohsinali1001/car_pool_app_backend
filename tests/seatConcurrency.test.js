const assert = require('node:assert/strict');
const test = require('node:test');
const { seatUpdateFromRide } = require('../src/utils/seatHelper');

test('seat update prevents overbooking and caps released seats', () => {
  const ride = { totalSeats: 2, availableSeats: 2 };

  const first = seatUpdateFromRide(ride, -1);
  assert.equal(first.available, 1);
  assert.equal(first.totalSeats, 2);

  const second = seatUpdateFromRide(
    { totalSeats: first.totalSeats, availableSeats: first.available },
    -1,
  );
  assert.equal(second.available, 0);

  assert.throws(
    () =>
      seatUpdateFromRide(
        { totalSeats: second.totalSeats, availableSeats: second.available },
        -1,
      ),
    /Ride is full/,
  );

  const released = seatUpdateFromRide(
    { totalSeats: 2, availableSeats: 2 },
    1,
  );
  assert.equal(released.available, 2);
});

test('three confirmed bookings consume every seat exactly once', () => {
  let ride = { totalSeats: 3, availableSeats: 3 };

  ride = { ...ride, availableSeats: seatUpdateFromRide(ride, -1).available };
  assert.equal(ride.availableSeats, 2);
  ride = { ...ride, availableSeats: seatUpdateFromRide(ride, -1).available };
  assert.equal(ride.availableSeats, 1);
  ride = { ...ride, availableSeats: seatUpdateFromRide(ride, -1).available };
  assert.equal(ride.availableSeats, 0);

  assert.throws(() => seatUpdateFromRide(ride, -1), /Ride is full/);
});
