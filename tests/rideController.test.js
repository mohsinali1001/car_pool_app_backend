const assert = require('node:assert/strict');
const test = require('node:test');
const {
  calculateRouteProximityMeters,
  buildRideRouteSummary,
  routeMatchScore,
} = require('../src/controllers/rideController');
const { decodePolyline } = require('../src/utils/routerHelper');

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
  assert.deepEqual(summary.QrouteBoundingBox, {
    north: 33.6848,
    south: 33.6840,
    east: 73.0485,
    west: 73.0470,
  });
  assert.equal(summary.routeDistanceKm > 0, true);
});

test('matches only passengers whose pickup and drop follow the captain route', () => {
  const ride = {
    startLat: 0,
    startLng: 0,
    endLat: 0,
    endLng: 10,
    routePolyline: [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 5 },
      { lat: 0, lng: 10 },
    ],
    startLocation: 'Wah Cantt',
    endLocation: 'Lahore',
  };

  const sameDirection = routeMatchScore(ride, {
    pickupLat: 0,
    pickupLng: 2,
    destLat: 0,
    destLng: 8,
    pickupRadiusKm: 3,
    destinationRadiusKm: 3,
    routeRadiusKm: 2.5,
    startLocation: 'Point 2',
    endLocation: 'Point 8',
  });
  assert.equal(sameDirection.routeIncludesJourney, true);
  assert.equal(sameDirection.directionOk, true);

  const reverseDirection = routeMatchScore(ride, {
    pickupLat: 0,
    pickupLng: 8,
    destLat: 0,
    destLng: 2,
    pickupRadiusKm: 3,
    destinationRadiusKm: 3,
    routeRadiusKm: 2.5,
    startLocation: 'Point 8',
    endLocation: 'Point 2',
  });
  assert.equal(reverseDirection.routeIncludesJourney, false);

  const offRoute = routeMatchScore(ride, {
    pickupLat: 1,
    pickupLng: 2,
    destLat: 1,
    destLng: 8,
    pickupRadiusKm: 3,
    destinationRadiusKm: 3,
    routeRadiusKm: 2.5,
    startLocation: 'Other city',
    endLocation: 'Other city',
  });
  assert.equal(offRoute.routeIncludesJourney, false);
});

test('decodes standard Google/OSRM polylines without coordinate drift', () => {
  const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');

  assert.equal(points.length, 3);
  assert.ok(Math.abs(points[0].lat - 38.5) < 0.00001);
  assert.ok(Math.abs(points[0].lng + 120.2) < 0.00001);
  assert.ok(Math.abs(points[1].lat - 40.7) < 0.00001);
  assert.ok(Math.abs(points[1].lng + 120.95) < 0.00001);
  assert.ok(Math.abs(points[2].lat - 43.252) < 0.00001);
  assert.ok(Math.abs(points[2].lng + 126.453) < 0.00001);
});
