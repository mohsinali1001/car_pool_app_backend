// Thin compatibility shim: original file is named `routerHelper.js`.
// `rideController.js` expects ../utils/routeHelper, so re-export
// the necessary functions here to avoid changing callers.

const router = require('./routerHelper');

const { fetchRoutePolyline, projectPointOnPolyline } = router;

module.exports = {
  fetchRoutePolyline,
  projectPointOnPolyline,
};
