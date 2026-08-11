// =============================================
// GPX TRACKER - Service Worker
// Cache-first for app shell, network-first for map tiles
// =============================================

const CACHE_NAME = 'gpx-tracker-v28';
const TILES_CACHE = 'gpx-tracker-tiles-v1';
const SHARED_GPX_CACHE = 'gpx-tracker-shared-v1';
const MAX_SHARED_GPX_SIZE = 25 * 1024 * 1024;
const MAX_TILES = 500;

const APP_SHELL = [
  './',
  './index.html',
  './css/style.css?v=28',
  './js/app.js?v=28',
  './js/route-replay.js?v=28',
  './js/track-creator.js?v=28',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
  'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4',
  'https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: remove only obsolete app caches.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(key => key.startsWith('gpx-tracker-v') && key !== CACHE_NAME)
        .map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

async function receiveSharedGPX(request) {
  const redirectUrl = new URL('./?shared-gpx=1', self.registration.scope);

  try {
    const formData = await request.formData();
    const file = formData.get('gpx');
    const fileName = file?.name || '';

    if (!file || typeof file.arrayBuffer !== 'function' || !/\.gpx$/i.test(fileName)) {
      redirectUrl.searchParams.set('share-error', 'invalid');
      redirectUrl.searchParams.delete('shared-gpx');
      return Response.redirect(redirectUrl.href, 303);
    }

    if (file.size > MAX_SHARED_GPX_SIZE) {
      redirectUrl.searchParams.set('share-error', 'too-large');
      redirectUrl.searchParams.delete('shared-gpx');
      return Response.redirect(redirectUrl.href, 303);
    }

    const cache = await caches.open(SHARED_GPX_CACHE);
    const cacheKey = new URL('./__shared-gpx', self.registration.scope).href;
    const safeName = encodeURIComponent(fileName);
    await cache.put(cacheKey, new Response(file, {
      headers: {
        'Content-Type': file.type || 'application/gpx+xml',
        'X-GPX-File-Name': safeName
      }
    }));

    return Response.redirect(redirectUrl.href, 303);
  } catch (error) {
    redirectUrl.searchParams.set('share-error', 'read');
    redirectUrl.searchParams.delete('shared-gpx');
    return Response.redirect(redirectUrl.href, 303);
  }
}

// Fetch strategy
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  if (event.request.method === 'POST' && new URL(url).pathname.endsWith('/share-target')) {
    event.respondWith(receiveSharedGPX(event.request));
    return;
  }

  // Bypass Service Worker cache completely for cloud API requests and dynamic data
  if (url.includes('.supabase.co') || url.includes('openrouteservice.org') || url.includes('nominatim.openstreetmap.org') || url.includes('overpass-api.de') || url.includes('overpass.kumi.systems')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Map tiles: network-first with cache fallback
  if (url.includes('tile.openstreetmap.org') || url.includes('arcgisonline.com')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(TILES_CACHE).then(async cache => {
            cache.put(event.request, clone);
            // Limit tile cache size
            const keys = await cache.keys();
            if (keys.length > MAX_TILES) {
              await cache.delete(keys[0]);
            }
          });
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Google Fonts CSS: network-first (may vary)
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else: network-first for JS/HTML app logic, fallback to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
