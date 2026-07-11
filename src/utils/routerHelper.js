// src/utils/routeHelper.js
// Fetches the real driving route between two points and checks how close
// a given point (customer pickup/drop) is to that route.

const OSRM_BASE_URL = process.env.OSRM_BASE_URL || 'https://router.project-osrm.org';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

function toRad(v) { return (v * Math.PI) / 180; }

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Decodes a Google/OSRM encoded polyline string into [{lat, lng}, ...]
function decodePolyline(encoded) {
  let index = 0, lat = 0, lng = 0;
  const points = [];
  while (index < encoded.length) {
    let result = 1, shift = 0, b;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 1; shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push({ lat: lat * 1e-5, lng: lng * 1e-5 });
  }
  return points;
}

// Fetches the real road route between two coordinates.
// Returns an array of {lat, lng} points, or null if it fails.
async function fetchRoutePolyline(startLat, startLng, endLat, endLng) {
  try {
    if (GOOGLE_MAPS_API_KEY) {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${startLat},${startLng}&destination=${endLat},${endLng}&key=${GOOGLE_MAPS_API_KEY}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const data = await res.json();
      if (data.status === 'OK' && data.routes?.[0]?.overview_polyline?.points) {
        return decodePolyline(data.routes[0].overview_polyline.points);
      }
      console.error('Google Directions error:', data.status);
      return null;
    }

    // Fallback: free public OSRM server, no API key required
    const url = `${OSRM_BASE_URL}/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=polyline`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const data = await res.json();
    if (data.code === 'Ok' && data.routes?.[0]?.geometry) {
      return decodePolyline(data.routes[0].geometry);
    }
    console.error('OSRM error:', data.code);
    return null;
  } catch (err) {
    console.error('fetchRoutePolyline failed:', err.message);
    return null;
  }
}

// Projects a point onto a multi-point road route.
// Returns { distanceMeters, progress } where progress (0..1) tells how far
// along the whole route the closest point is (used to check pickup-before-drop order).
function projectPointOnPolyline(pointLat, pointLng, polyline) {
  if (!Array.isArray(polyline) || polyline.length < 2) return null;

  const segmentLengths = [];
  let totalLength = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const segLen = haversineMeters(
      polyline[i].lat, polyline[i].lng,
      polyline[i + 1].lat, polyline[i + 1].lng,
    );
    segmentLengths.push(segLen);
    totalLength += segLen;
  }

  let best = null;
  let runningLength = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const segLen = segmentLengths[i];

    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    const lengthSq = dx * dx + dy * dy;
    let t = 0;
    if (lengthSq > 0) {
      t = ((pointLng - a.lng) * dx + (pointLat - a.lat) * dy) / lengthSq;
      t = Math.max(0, Math.min(1, t));
    }
    const nearLat = a.lat + t * dy;
    const nearLng = a.lng + t * dx;
    const dist = haversineMeters(pointLat, pointLng, nearLat, nearLng);

    if (best === null || dist < best.distanceMeters) {
      best = {
        distanceMeters: dist,
        progress: totalLength > 0 ? (runningLength + segLen * t) / totalLength : 0,
      };
    }
    runningLength += segLen;
  }

  return best;
}

module.exports = {
  fetchRoutePolyline,
  decodePolyline,
  projectPointOnPolyline,
  haversineMeters,
};