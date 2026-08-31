// ---------- Google Maps distance auto-calc ----------
// Used by the booking wizard to auto-fill trip distance (and therefore the
// live fare estimate) from pickup/drop addresses, instead of the customer
// typing an approximate km figure by hand.
//
// Two separate keys, on purpose:
//   GOOGLE_MAPS_BROWSER_KEY  - sent to the browser (via /api/config) to power
//                              the Places Autocomplete widget on the pickup/
//                              drop inputs. Restrict this key by HTTP referrer
//                              in Google Cloud Console — it's meant to be public.
//   GOOGLE_MAPS_SERVER_KEY   - never leaves the server. Used here to call the
//                              Distance Matrix API. Restrict this one by
//                              server/IP, not referrer.
//
// Fully optional: with no GOOGLE_MAPS_SERVER_KEY set, /api/distance responds
// 501 and the frontend falls back to the old manual "approx. distance" field
// — so nothing breaks if you skip Maps setup.

const { GOOGLE_MAPS_SERVER_KEY, GOOGLE_MAPS_BROWSER_KEY } = process.env;

const configured = !!GOOGLE_MAPS_SERVER_KEY;

if (!configured) {
  console.log('[maps] GOOGLE_MAPS_SERVER_KEY not set — auto distance calc is disabled; ' +
    'the booking form will fall back to manual distance entry. See README for setup.');
}
if (!GOOGLE_MAPS_BROWSER_KEY) {
  console.log('[maps] GOOGLE_MAPS_BROWSER_KEY not set — pickup/drop address autocomplete is disabled.');
}

// Distance Matrix API — one origin, one destination, driving distance in km.
async function calcDistanceKm(pickup, drop) {
  if (!configured) {
    const err = new Error('Maps not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  url.searchParams.set('origins', pickup);
  url.searchParams.set('destinations', drop);
  url.searchParams.set('units', 'metric');
  url.searchParams.set('key', GOOGLE_MAPS_SERVER_KEY);

  const resp = await fetch(url);
  const data = await resp.json();

  if (data.status !== 'OK') {
    const err = new Error(`Distance Matrix API error: ${data.status}${data.error_message ? ' - ' + data.error_message : ''}`);
    err.code = 'API_ERROR';
    throw err;
  }
  const element = data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK') {
    const err = new Error(`Could not find a driving route (${element?.status || 'UNKNOWN'})`);
    err.code = 'NO_ROUTE';
    throw err;
  }
  return {
    distanceKm: Math.round((element.distance.value / 1000) * 10) / 10, // meters -> km, 1 decimal
    durationText: element.duration.text,
    originAddress: data.origin_addresses?.[0] || pickup,
    destinationAddress: data.destination_addresses?.[0] || drop,
  };
}

module.exports = { calcDistanceKm, mapsConfigured: configured, GOOGLE_MAPS_BROWSER_KEY };
