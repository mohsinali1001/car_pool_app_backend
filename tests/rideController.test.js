const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateRouteProximityMeters, buildRideRouteSummary } = require('../src/controllers/rideController');

test('calculates route proximity to pickup and builds route bounds', () => {
  const proximityMeters = calculateRouteProximityMeters(
    33.6844,
    73.0479,
    33.6840,
    73.0470,
    33.6848,
    73.0485,
  );

  assert.equal(proximityMeters > 0, true);
  assert.equal(proximityMeters < 2000, true);

  const summary = buildRideRouteSummary(33.6840, 73.0470, 33.6848, 73.0485);
  assert.deepEqual(summary.routeBoundingBox, {
    north: 33.6848,
    south: 33.6840,
    east: 73.0485,
    west: 73.0470,
  });
  assert.equal(summary.routeDistanceKm > 0, true);
});
