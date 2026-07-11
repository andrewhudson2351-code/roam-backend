// Google Places API (New) helpers. Server-side only — the key never reaches
// the client. With GOOGLE_PLACES_API_KEY unset every helper returns null so
// venue pages degrade gracefully to our own data.
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || null;

// regularOpeningHours + editorialSummary put this call in the
// Enterprise+Atmosphere SKU (1,000 free events/month) — results are cached in
// venue_place_cache for 30 days so cost scales with distinct venues viewed.
const DETAILS_FIELDS = "id,photos,nationalPhoneNumber,websiteUri,googleMapsUri,regularOpeningHours,editorialSummary";

async function fetchPlaceDetails(placeId) {
  if (!PLACES_KEY) return null;
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: { "X-Goog-Api-Key": PLACES_KEY, "X-Goog-FieldMask": DETAILS_FIELDS },
  });
  if (!res.ok) throw new Error(`Place Details HTTP ${res.status}`);
  return res.json();
}

// Photo media resolutions are metered ($7/1k after 1,000 free/month) — cache
// the resolved googleusercontent URL so repeat views don't re-bill.
const photoUriCache = new Map();
const PHOTO_URI_TTL_MS = 12 * 60 * 60 * 1000;

async function resolvePhotoUri(photoName, maxWidthPx = 1200) {
  if (!PLACES_KEY) return null;
  const cached = photoUriCache.get(photoName);
  if (cached && cached.expires > Date.now()) return cached.uri;
  const res = await fetch(
    `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true`,
    { headers: { "X-Goog-Api-Key": PLACES_KEY } }
  );
  if (!res.ok) throw new Error(`Place Photo HTTP ${res.status}`);
  const { photoUri } = await res.json();
  if (photoUriCache.size > 5000) photoUriCache.clear();
  photoUriCache.set(photoName, { uri: photoUri, expires: Date.now() + PHOTO_URI_TTL_MS });
  return photoUri;
}

module.exports = { PLACES_KEY, fetchPlaceDetails, resolvePhotoUri };
