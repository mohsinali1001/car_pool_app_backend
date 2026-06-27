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
