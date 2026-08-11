// =============================================
// GPX TRACKER - Track Creator Module
// Draws tracks on the map (manual or road-following)
// =============================================

const DEFAULT_ORS_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImYyMjk4YTk2YzU1ODQ4NzRhZjM1NjAxNDQzMDY2YmVkIiwiaCI6Im11cm11cjY0In0=';

// --- Creator State ---
const creator = {
  map: null,
  chart: null,
  initialized: false,
  mode: 'road',                   // 'manual' | 'road'
  profile: 'cycling-road',
  apiKey: DEFAULT_ORS_KEY,
  waypoints: [],                  // [{lat, lng}] user-placed points
  routeSegments: [],              // Arrays of [lat, lng, ele] between waypoints
  polyline: null,
  markers: [],
  midpointMarkers: [],
  undoStack: [],                  // Each entry: { waypoints, routeSegments } snapshot
  totalDistance: 0,
  elevationGain: 0,
  editingTrackId: null,           // Preserved track ID when editing an existing track
  surfaceSummary: null,
  fountainsLayer: null,
  fountainsVisible: false,
  deleteMode: false,              // Click a waypoint marker to remove it
  isRouting: false                // Prevent double-clicks while routing
};
let creatorSurfaceTimer = null;
let creatorSurfaceRequestId = 0;
let creatorFountainsTimer = null;
let creatorFountainsRequestId = 0;

// =============================================
// 1. INITIALIZATION
// =============================================

function initCreator() {
  if (creator.initialized) {
    setTimeout(() => {
      if (creator.map) creator.map.invalidateSize();
      if (creator.chart) creator.chart.resize();
    }, 200);
    return;
  }

  // Load API key from localStorage or use built-in key
  creator.apiKey = localStorage.getItem('ors-api-key') || DEFAULT_ORS_KEY;

  // Init map
  creator.map = L.map('mapCrear', {
    zoomControl: true,
    attributionControl: true
  }).setView([40.4167, -3.7033], 6);

  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 19
  });

  const satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri',
    maxZoom: 19
  });

  osmLayer.addTo(creator.map);

  creator.fountainsLayer = L.layerGroup();

  L.control.layers({
    '🗺️ Mapa': osmLayer,
    '🛰️ Satélite': satLayer
  }, {
    '🚰 Fuentes de agua potable': creator.fountainsLayer
  }, { position: 'topright' }).addTo(creator.map);

  creator.map.on('overlayadd', event => {
    if (event.layer !== creator.fountainsLayer) return;
    creator.fountainsVisible = true;
    scheduleCreatorFountains(getAllFlatPoints(), true);
  });
  creator.map.on('overlayremove', event => {
    if (event.layer === creator.fountainsLayer) creator.fountainsVisible = false;
  });

  // Init chart
  const chartEl = document.getElementById('chartCrear');
  if (chartEl) {
    creator.chart = echarts.init(chartEl);
    window.addEventListener('resize', () => {
      if (creator.chart) creator.chart.resize();
    });
  }

  // Click handler
  creator.map.on('click', (e) => {
    if (creator.isRouting || creator.deleteMode) return;
    addWaypoint(e.latlng);
  });

  // Setup event listeners
  setupCreatorEvents();

  creator.initialized = true;

  setTimeout(() => {
    if (creator.map) creator.map.invalidateSize();
    if (creator.chart) creator.chart.resize();
  }, 200);
}

function setupCreatorEvents() {
  // Mode toggle
  const modeToggle = document.getElementById('creatorModeToggle');
  if (modeToggle) {
    modeToggle.addEventListener('change', () => {
      creator.mode = modeToggle.checked ? 'road' : 'manual';
      const profSelector = document.getElementById('profileSelector');
      if (profSelector) profSelector.style.display = creator.mode === 'road' ? 'inline-block' : 'none';
    });
  }

  // Profile selector
  const profileSelect = document.getElementById('creatorProfile');
  if (profileSelect) {
    profileSelect.addEventListener('change', () => {
      creator.profile = profileSelect.value;
      rebuildPolyline();
      updateCreatorStats();
    });
  }

  // Location search & Geolocation
  setupLocationSearch();
  document.getElementById('btnGeolocate')?.addEventListener('click', geolocateUser);
  document.getElementById('btnFitCreatorRoute')?.addEventListener('click', fitCreatorRoute);

  // Buttons
  document.getElementById('btnUndo')?.addEventListener('click', undoLastAction);
  document.getElementById('btnReturnToStart')?.addEventListener('click', returnToStart);
  document.getElementById('btnReverseTrack')?.addEventListener('click', reverseCreatedTrack);
  document.getElementById('btnDeletePoint')?.addEventListener('click', () => setDeletePointMode(!creator.deleteMode));
  document.getElementById('btnClearTrack')?.addEventListener('click', clearCreatedTrack);
  document.getElementById('btnSaveCreated')?.addEventListener('click', saveCreatedTrack);
  document.getElementById('btnDownloadCreated')?.addEventListener('click', downloadCreatedTrack);
  document.getElementById('btnAnalyzeCreated')?.addEventListener('click', analyzeCreatedTrack);
  document.getElementById('btnCreatorHelp')?.addEventListener('click', openCreatorHelp);
  document.getElementById('btnCloseCreatorHelp')?.addEventListener('click', closeCreatorHelp);
  document.getElementById('creatorHelpModal')?.addEventListener('click', event => {
    if (event.target.id === 'creatorHelpModal') closeCreatorHelp();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCreatorHelp();
    const vistaCrear = document.getElementById('vistaCrear');
    if (vistaCrear && !vistaCrear.classList.contains('hidden')) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undoLastAction();
      }
    }
  });
}

// =============================================
// LOCATION SEARCH & GEOLOCATION
// =============================================

let searchDebounceTimeout = null;

function setupLocationSearch() {
  const searchInput = document.getElementById('locationSearch');
  const resultsContainer = document.getElementById('searchResults');

  if (!searchInput || !resultsContainer) return;

  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimeout);
    const query = searchInput.value.trim();

    if (query.length < 2) {
      resultsContainer.classList.add('hidden');
      resultsContainer.innerHTML = '';
      return;
    }

    searchDebounceTimeout = setTimeout(() => {
      performLocationSearch(query);
    }, 350);
  });

  // Hide dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !resultsContainer.contains(e.target)) {
      resultsContainer.classList.add('hidden');
    }
  });
}

async function performLocationSearch(query) {
  const searchInput = document.getElementById('locationSearch');
  const resultsContainer = document.getElementById('searchResults');
  const spinner = document.getElementById('searchSpinner');

  if (spinner) spinner.classList.remove('hidden');

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6&addressdetails=1`;
    const res = await fetch(url, {
      headers: { 'Accept-Language': 'es' }
    });
    const data = await res.json();

    if (spinner) spinner.classList.add('hidden');

    if (!data || data.length === 0) {
      resultsContainer.innerHTML = `<div class="p-3 text-gray-400 font-medium">No se encontraron resultados</div>`;
      resultsContainer.classList.remove('hidden');
      return;
    }

    resultsContainer.innerHTML = '';
    data.forEach(item => {
      const div = document.createElement('div');
      div.className = 'p-2.5 hover:bg-blue-50 cursor-pointer font-medium text-gray-700 transition-colors flex items-center gap-2';
      div.innerHTML = `
        <svg class="w-4 h-4 text-blue-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
        </svg>
        <span class="truncate">${escapeCreatorHtml(item.display_name)}</span>
      `;

      div.addEventListener('click', () => {
        const lat = parseFloat(item.lat);
        const lon = parseFloat(item.lon);

        if (creator.map) {
          creator.map.flyTo([lat, lon], 14, { duration: 1.5 });

          // Temporary search highlight marker
          if (window._searchMarker) creator.map.removeLayer(window._searchMarker);
          window._searchMarker = L.circleMarker([lat, lon], {
            radius: 10,
            color: '#3b82f6',
            fillColor: '#60a5fa',
            fillOpacity: 0.6,
            weight: 3
          }).addTo(creator.map);

          setTimeout(() => {
            if (window._searchMarker) {
              creator.map.removeLayer(window._searchMarker);
              window._searchMarker = null;
            }
          }, 4000);
        }

        searchInput.value = item.display_name.split(',')[0];
        resultsContainer.classList.add('hidden');
      });

      resultsContainer.appendChild(div);
    });

    resultsContainer.classList.remove('hidden');
  } catch (err) {
    console.error('Search error:', err);
    if (spinner) spinner.classList.add('hidden');
    resultsContainer.innerHTML = `<div class="p-3 text-red-500 font-medium">Error al buscar</div>`;
    resultsContainer.classList.remove('hidden');
  }
}

function geolocateUser() {
  if (!navigator.geolocation) {
    alert('Tu navegador no soporta geolocalización.');
    return;
  }

  const spinner = document.getElementById('searchSpinner');
  if (spinner) spinner.classList.remove('hidden');

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (spinner) spinner.classList.add('hidden');
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      if (creator.map) {
        creator.map.flyTo([lat, lon], 15, { duration: 1.5 });
      }
    },
    (err) => {
      if (spinner) spinner.classList.add('hidden');
      alert('No se pudo obtener la ubicación: ' + err.message);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function escapeCreatorHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}


// =============================================
// 2. WAYPOINT MANAGEMENT
// =============================================

async function addWaypoint(latlng) {
  // Save snapshot for undo
  pushUndoState();

  creator.waypoints.push(latlng);

  if (creator.waypoints.length === 1) {
    // First point — just add marker
    addWaypointMarker(latlng, 0);
    updateCreatorStats();
    return;
  }

  const prevWp = creator.waypoints[creator.waypoints.length - 2];

  if (creator.mode === 'road') {
    creator.apiKey = creator.apiKey || DEFAULT_ORS_KEY;

    creator.isRouting = true;
    showRoutingSpinner(true);

    try {
      const segment = await fetchRoute(prevWp, latlng);
      if (segment && segment.length > 0) {
        creator.routeSegments.push(segment);
        addWaypointMarker(latlng, creator.waypoints.length - 1);
        rebuildPolyline();
        updateMidpoints();
        updateCreatorStats();
      } else {
        // Routing failed, remove waypoint
        creator.waypoints.pop();
        creator.undoStack.pop();
      }
    } catch (err) {
      console.error('Routing error:', err);
      showCreatorNotice('No se pudo calcular el tramo. Inténtalo de nuevo o usa el modo manual.', 'warning');
      creator.waypoints.pop();
      creator.undoStack.pop();
    } finally {
      creator.isRouting = false;
      showRoutingSpinner(false);
    }
  } else {
    // Manual mode — straight line with interpolated terrain elevation lookup
    showRoutingSpinner(true);
    try {
      const linePoints = interpolateSegmentPoints(prevWp, latlng, 0.05);
      const seg = await enrichElevations(linePoints);
      creator.routeSegments.push(seg);
      addWaypointMarker(latlng, creator.waypoints.length - 1);
      rebuildPolyline();
      updateMidpoints();
      updateCreatorStats();
    } finally {
      showRoutingSpinner(false);
    }
  }
}

function interpolateSegmentPoints(from, to, stepKm = 0.05) {
  const dist = haversineDistanceCreator(from.lat, from.lng, to.lat, to.lng);
  const numSteps = Math.max(2, Math.ceil(dist / stepKm));
  const points = [];
  for (let i = 0; i <= numSteps; i++) {
    const frac = i / numSteps;
    const lat = from.lat + (to.lat - from.lat) * frac;
    const lng = from.lng + (to.lng - from.lng) * frac;
    points.push([lat, lng, 0]);
  }
  return points;
}

function indexToLetter(index) {
  let result = '';
  let i = index;
  while (i >= 0) {
    result = String.fromCharCode((i % 26) + 65) + result;
    i = Math.floor(i / 26) - 1;
  }
  return result;
}

function addWaypointMarker(latlng, index) {
  const isFirst = index === 0;
  const color = creator.deleteMode ? '#e11d48' : (isFirst ? '#10b981' : '#3b82f6');
  const label = indexToLetter(index);

  const icon = L.divIcon({
    html: `<div style="background:${color};color:white;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:11px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);cursor:${creator.deleteMode ? 'pointer' : 'grab'};">${creator.deleteMode ? '−' : label}</div>`,
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  const marker = L.marker(latlng, { icon, draggable: !creator.deleteMode }).addTo(creator.map);

  marker.on('click', e => {
    if (!creator.deleteMode) return;
    if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
    deleteWaypointAt(index);
  });

  marker.on('dragend', async () => {
    pushUndoState();
    const newPos = marker.getLatLng();
    creator.waypoints[index] = newPos;
    await recalculateSegmentsAround(index);
  });

  creator.markers.push(marker);
}

function rebuildAllMarkers() {
  // Remove all markers
  creator.markers.forEach(m => creator.map.removeLayer(m));
  creator.markers = [];

  // Recreate
  creator.waypoints.forEach((wp, i) => addWaypointMarker(wp, i));
}


// =============================================
// 3. ROUTING (OpenRouteService & Elevation)
// =============================================

async function enrichElevations(points, forceRefresh = false) {
  if (!points || points.length === 0) return points;

  // Check if elevation data is missing (points have 0 elevation)
  const needsEle = points.some(p => !p[2] || p[2] === 0);
  if (!needsEle && !forceRefresh) return points;

  try {
    const chunkSize = 80;
    const enriched = [];

    for (let i = 0; i < points.length; i += chunkSize) {
      const chunk = points.slice(i, i + chunkSize);
      const lats = chunk.map(p => p[0].toFixed(5)).join(',');
      const lons = chunk.map(p => p[1].toFixed(5)).join(',');

      const url = `https://elevation-api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
      const res = await fetch(url);

      if (res.ok) {
        const data = await res.json();
        if (data.elevation && data.elevation.length === chunk.length) {
          chunk.forEach((p, idx) => {
            const terrainElevation = data.elevation[idx];
            const shouldReplace = forceRefresh || !p[2] || p[2] <= 10;
            const ele = shouldReplace && terrainElevation !== null && terrainElevation !== undefined
              ? Math.round(terrainElevation)
              : (p[2] || 0);
            enriched.push([p[0], p[1], ele]);
          });
          continue;
        }
      }
      enriched.push(...chunk);
    }
    return enriched;
  } catch (err) {
    console.warn('Open-Meteo elevation fallback error:', err);
    return points;
  }
}

async function fetchRoute(from, to) {
  // Use POST request to /v2/directions/{profile}/geojson so ORS returns 3D coordinates [lon, lat, ele]
  const routingProfile = creator.profile === 'cycling-greenway' ? 'cycling-regular' : creator.profile;
  const url = `https://api.openrouteservice.org/v2/directions/${routingProfile}/geojson`;

  const requestOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': creator.apiKey },
    body: JSON.stringify({ coordinates: [[from.lng, from.lat], [to.lng, to.lat]], elevation: true })
  };
  let response = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(url, requestOptions);
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 450 * (attempt + 1)));
  }

  if (!response) {
    console.warn('Routing service unavailable:', lastError);
    showCreatorNotice('Servicio de rutas no disponible. Se ha añadido un tramo recto provisional.', 'warning');
    return enrichElevations(interpolateSegmentPoints(from, to, 0.05), true);
  }

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    console.warn('Routing service response:', response.status, errData);
    showCreatorNotice('No se pudo seguir la carretera. Se ha añadido un tramo recto provisional.', 'warning');
    return enrichElevations(interpolateSegmentPoints(from, to, 0.05), true);
  }

  const data = await response.json();

  if (!data.features || data.features.length === 0) {
    showCreatorNotice('No se encontró una vía entre esos puntos. Se ha añadido un tramo recto provisional.', 'warning');
    return enrichElevations(interpolateSegmentPoints(from, to, 0.05), true);
  }

  const coords = data.features[0].geometry.coordinates;
  // ORS returns [lon, lat, ele] 3D coordinates in GeoJSON format
  let points = coords.map(c => [c[1], c[0], c[2] !== undefined ? Math.round(c[2]) : 0]);

  // Keep the elevation produced by the routed geometry. Query terrain elevation
  // only when the routing service did not provide it (terrain DEMs can create
  // false ravines under bridges, tunnels and greenways).
  points = await enrichElevations(points);

  return points;
}

async function recalculateSegmentsAround(index) {
  if (creator.mode === 'manual') {
    // Manual: rebuild simple segments with interpolated elevation lookup
    if (index > 0) {
      const prev = creator.waypoints[index - 1];
      const curr = creator.waypoints[index];
      const ptsPrev = interpolateSegmentPoints(prev, curr, 0.05);
      creator.routeSegments[index - 1] = await enrichElevations(ptsPrev);
    }
    if (index < creator.waypoints.length - 1) {
      const curr = creator.waypoints[index];
      const next = creator.waypoints[index + 1];
      const ptsNext = interpolateSegmentPoints(curr, next, 0.05);
      creator.routeSegments[index] = await enrichElevations(ptsNext);
    }
    rebuildPolyline();
    updateMidpoints();
    updateCreatorStats();
    return;
  }

  // Road mode: re-route affected segments
  creator.isRouting = true;
  showRoutingSpinner(true);

  try {
    if (index > 0) {
      const segment = await fetchRoute(creator.waypoints[index - 1], creator.waypoints[index]);
      if (segment) creator.routeSegments[index - 1] = segment;
    }
    if (index < creator.waypoints.length - 1) {
      const segment = await fetchRoute(creator.waypoints[index], creator.waypoints[index + 1]);
      if (segment) creator.routeSegments[index] = segment;
    }
    rebuildPolyline();
    updateMidpoints();
    updateCreatorStats();
  } catch (err) {
    console.error('Recalculate error:', err);
    alert('Error recalculando ruta: ' + err.message);
  } finally {
    creator.isRouting = false;
    showRoutingSpinner(false);
  }
}


// =============================================
// 4. POLYLINE & MIDPOINTS
// =============================================

function rebuildPolyline() {
  if (creator.polyline) creator.map.removeLayer(creator.polyline);

  const allPoints = getAllFlatPoints();
  if (allPoints.length < 2) {
    creator.polyline = null;
    return;
  }

  creator.polyline = L.polyline(allPoints.map(p => [p[0], p[1]]), {
    color: '#ef4444',
    weight: 4,
    opacity: 0.85
  }).addTo(creator.map);
}

function getAllFlatPoints() {
  const flat = [];
  for (let i = 0; i < creator.routeSegments.length; i++) {
    const seg = creator.routeSegments[i];
    for (let j = 0; j < seg.length; j++) {
      // Avoid duplicates at segment joins
      if (flat.length > 0 && j === 0) {
        const last = flat[flat.length - 1];
        if (Math.abs(last[0] - seg[0][0]) < 0.00001 && Math.abs(last[1] - seg[0][1]) < 0.00001) {
          continue;
        }
      }
      flat.push(seg[j]);
    }
  }
  return cleanElevations(flat);
}

function cleanElevations(rawPoints) {
  if (!rawPoints || rawPoints.length === 0) return rawPoints;

  // Shallow copy points [lat, lon, ele]
  const points = rawPoints.map(p => [p[0], p[1], p[2] || 0]);

  // Step 1: Interpolate 0 / near-zero corrupt elevation points using nearest valid neighbors
  for (let i = 0; i < points.length; i++) {
    if (points[i][2] <= 10) { // Near zero / corrupt elevation sample
      let prevVal = 0;
      for (let j = i - 1; j >= 0; j--) {
        if (points[j][2] > 10) { prevVal = points[j][2]; break; }
      }

      let nextVal = 0;
      for (let j = i + 1; j < points.length; j++) {
        if (points[j][2] > 10) { nextVal = points[j][2]; break; }
      }

      if (prevVal > 0 && nextVal > 0) {
        points[i][2] = Math.round((prevVal + nextVal) / 2);
      } else if (prevVal > 0) {
        points[i][2] = prevVal;
      } else if (nextVal > 0) {
        points[i][2] = nextVal;
      }
    }
  }

  if (points.length < 3) return points;

  const cumulativeDistance = [0];
  for (let i = 1; i < points.length; i++) {
    cumulativeDistance.push(cumulativeDistance[i - 1] + haversineDistanceCreator(
      points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]
    ));
  }

  // Step 2: distance-based median. A point-count window was too narrow on
  // detailed geometries and failed to remove broad DEM ravines below bridges.
  const filtered = points.map(point => [...point]);
  const isGreenway = creator.profile === 'cycling-greenway';
  const halfWindowKm = isGreenway ? 1.5 : creator.profile === 'cycling-road' ? 0.7
    : creator.profile === 'cycling-mountain' ? 0.3 : 0.25;
  const deviationThreshold = isGreenway ? 2.5 : creator.profile === 'cycling-road' ? 4 : 18;
  let windowStart = 0;
  let windowEnd = 0;
  for (let i = 1; i < points.length - 1; i++) {
    while (windowStart < i && cumulativeDistance[i] - cumulativeDistance[windowStart] > halfWindowKm) windowStart++;
    while (windowEnd < points.length - 1 && cumulativeDistance[windowEnd + 1] - cumulativeDistance[i] <= halfWindowKm) windowEnd++;
    const values = points.slice(windowStart, windowEnd + 1).map(point => point[2]).sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    const deviations = values.map(value => Math.abs(value - median)).sort((a, b) => a - b);
    const mad = deviations[Math.floor(deviations.length / 2)];
    const outlierLimit = isGreenway || creator.profile === 'cycling-road'
      ? deviationThreshold
      : Math.max(deviationThreshold, mad * 3.5);
    if (Math.abs(points[i][2] - median) > outlierLimit) filtered[i][2] = median;
  }

  // Step 3: cap physically implausible point-to-point gradients. Road routing
  // gets a stricter limit; MTB and hiking retain legitimately steeper terrain.
  const maxGrade = isGreenway ? 0.025 : creator.profile === 'cycling-road' ? 0.18
    : creator.profile === 'cycling-mountain' ? 0.32 : 0.45;
  for (let i = 1; i < filtered.length; i++) {
    const distanceMeters = haversineDistanceCreator(filtered[i - 1][0], filtered[i - 1][1], filtered[i][0], filtered[i][1]) * 1000;
    const maxChange = Math.max(3, distanceMeters * maxGrade + 1.5);
    filtered[i][2] = Math.max(filtered[i - 1][2] - maxChange, Math.min(filtered[i - 1][2] + maxChange, filtered[i][2]));
  }
  for (let i = filtered.length - 2; i >= 0; i--) {
    const distanceMeters = haversineDistanceCreator(filtered[i][0], filtered[i][1], filtered[i + 1][0], filtered[i + 1][1]) * 1000;
    const maxChange = Math.max(3, distanceMeters * maxGrade + 1.5);
    filtered[i][2] = Math.max(filtered[i + 1][2] - maxChange, Math.min(filtered[i + 1][2] + maxChange, filtered[i][2]));
  }

  // Step 4: smooth over physical distance instead of a fixed number of points.
  const smoothRadiusKm = isGreenway ? 0.28 : creator.profile === 'cycling-road' ? 0.08 : 0.05;
  let smoothed = filtered.map((point, index) => {
    if (index === 0 || index === filtered.length - 1) return [point[0], point[1], Math.round(point[2])];
    let weighted = 0;
    let weightTotal = 0;
    for (let sampleIndex = index; sampleIndex >= 0 && cumulativeDistance[index] - cumulativeDistance[sampleIndex] <= smoothRadiusKm; sampleIndex--) {
      const weight = 1 - (cumulativeDistance[index] - cumulativeDistance[sampleIndex]) / (smoothRadiusKm * 1.25);
      weighted += filtered[sampleIndex][2] * weight;
      weightTotal += weight;
    }
    for (let sampleIndex = index + 1; sampleIndex < filtered.length && cumulativeDistance[sampleIndex] - cumulativeDistance[index] <= smoothRadiusKm; sampleIndex++) {
      const weight = 1 - (cumulativeDistance[sampleIndex] - cumulativeDistance[index]) / (smoothRadiusKm * 1.25);
      weighted += filtered[sampleIndex][2] * weight;
      weightTotal += weight;
    }
    return [point[0], point[1], Math.round(weighted / weightTotal)];
  });

  // A greenway follows a former railway and its long profile is normally
  // monotonic. DEMs often read the ground above tunnels or below viaducts,
  // creating kilometre-long false valleys that a local spike filter cannot
  // distinguish from real hills. Isotonic regression keeps the overall route
  // direction while finding the closest smooth monotonic elevation profile.
  if (isGreenway && smoothed.length > 2) {
    const edgeCount = Math.max(1, Math.min(12, Math.floor(smoothed.length * 0.08)));
    const startMean = smoothed.slice(0, edgeCount).reduce((sum, point) => sum + point[2], 0) / edgeCount;
    const endMean = smoothed.slice(-edgeCount).reduce((sum, point) => sum + point[2], 0) / edgeCount;
    if (Math.abs(endMean - startMean) >= 3) {
      const corrected = isotonicElevation(smoothed.map(point => point[2]), endMean > startMean);
      smoothed = smoothed.map((point, index) => [point[0], point[1], Math.round(corrected[index])]);
    }
  }

  return smoothed;
}

function isotonicElevation(values, increasing) {
  const signedValues = increasing ? values : values.map(value => -value);
  const blocks = [];
  signedValues.forEach((value, index) => {
    blocks.push({ start: index, end: index, sum: value, count: 1 });
    while (blocks.length > 1) {
      const right = blocks[blocks.length - 1];
      const left = blocks[blocks.length - 2];
      if (left.sum / left.count <= right.sum / right.count) break;
      blocks.pop();
      blocks.pop();
      blocks.push({
        start: left.start,
        end: right.end,
        sum: left.sum + right.sum,
        count: left.count + right.count
      });
    }
  });
  const result = new Array(values.length);
  blocks.forEach(block => {
    const mean = block.sum / block.count;
    for (let index = block.start; index <= block.end; index++) result[index] = increasing ? mean : -mean;
  });
  return result;
}

let kilometerMarkers = [];

function updateKilometerMarkers(flatPoints, totalDist) {
  kilometerMarkers.forEach(m => creator.map.removeLayer(m));
  kilometerMarkers = [];

  if (!flatPoints || flatPoints.length < 2 || totalDist < 1) return;

  // Interval rule: 1 km if <= 30 km, 5 km if > 30 km
  const interval = totalDist <= 30 ? 1 : 5;
  let nextKmTarget = interval;
  let accumulatedDist = 0;

  for (let i = 1; i < flatPoints.length; i++) {
    const prev = flatPoints[i - 1];
    const curr = flatPoints[i];
    const segDist = haversineDistanceCreator(prev[0], prev[1], curr[0], curr[1]);

    while (accumulatedDist + segDist >= nextKmTarget && nextKmTarget < totalDist) {
      const ratio = (nextKmTarget - accumulatedDist) / segDist;
      const kmLat = prev[0] + ratio * (curr[0] - prev[0]);
      const kmLng = prev[1] + ratio * (curr[1] - prev[1]);

      const kmIcon = L.divIcon({
        html: `<div class="km-marker-badge">${nextKmTarget}k</div>`,
        className: '',
        iconSize: [32, 18],
        iconAnchor: [16, 9]
      });

      const marker = L.marker([kmLat, kmLng], {
        icon: kmIcon,
        interactive: false,
        zIndexOffset: -100
      }).addTo(creator.map);

      kilometerMarkers.push(marker);
      nextKmTarget += interval;
    }

    accumulatedDist += segDist;
  }
}

function updateMidpoints() {
  // Remove existing midpoints
  creator.midpointMarkers.forEach(m => creator.map.removeLayer(m));
  creator.midpointMarkers = [];

  if (creator.waypoints.length < 2 || creator.deleteMode) return;

  for (let i = 0; i < creator.waypoints.length - 1; i++) {
    const a = creator.waypoints[i];
    const b = creator.waypoints[i + 1];
    const midLat = (a.lat + b.lat) / 2;
    const midLng = (a.lng + b.lng) / 2;

    const ghostIcon = L.divIcon({
      html: '<div class="ghost-marker"></div>',
      className: '',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });

    const midMarker = L.marker([midLat, midLng], {
      icon: ghostIcon,
      draggable: true,
      opacity: 0.7
    }).addTo(creator.map);

    const segIndex = i; // Capture for closure
    midMarker.on('dragend', async () => {
      pushUndoState();
      const newPos = midMarker.getLatLng();
      insertWaypointAt(segIndex + 1, newPos);
    });

    creator.midpointMarkers.push(midMarker);
  }
}

async function insertWaypointAt(index, latlng) {
  creator.waypoints.splice(index, 0, latlng);

  if (creator.mode === 'road' && creator.apiKey) {
    creator.isRouting = true;
    showRoutingSpinner(true);
    try {
      // Remove old segment and replace with two new routed segments
      const segBefore = await fetchRoute(creator.waypoints[index - 1], latlng);
      const segAfter = await fetchRoute(latlng, creator.waypoints[index + 1]);
      creator.routeSegments.splice(index - 1, 1, segBefore, segAfter);
    } catch (err) {
      console.error('Insert routing error:', err);
      alert('Error calculando ruta para el punto insertado: ' + err.message);
      // Rollback
      creator.waypoints.splice(index, 1);
      creator.isRouting = false;
      showRoutingSpinner(false);
      return;
    }
    creator.isRouting = false;
    showRoutingSpinner(false);
  } else {
    // Manual: replace segment with two straight lines
    const prev = creator.waypoints[index - 1];
    const next = creator.waypoints[index + 1];
    const segBefore = [[prev.lat, prev.lng, 0], [latlng.lat, latlng.lng, 0]];
    const segAfter = [[latlng.lat, latlng.lng, 0], [next.lat, next.lng, 0]];
    creator.routeSegments.splice(index - 1, 1, segBefore, segAfter);
  }

  rebuildAllMarkers();
  rebuildPolyline();
  updateMidpoints();
  updateCreatorStats();
}

function setDeletePointMode(active) {
  creator.deleteMode = Boolean(active && creator.waypoints.length > 0);
  const button = document.getElementById('btnDeletePoint');
  button?.classList.toggle('is-active', creator.deleteMode);
  if (button) {
    button.title = creator.deleteMode
      ? 'Pulsa un punto rojo para eliminarlo'
      : 'Seleccionar un punto para eliminarlo';
  }
  rebuildAllMarkers();
  updateMidpoints();

  const status = document.getElementById('creatorSaveStatus');
  if (status) {
    status.className = creator.deleteMode ? 'text-xs font-bold text-rose-600' : 'text-xs font-bold';
    status.textContent = creator.deleteMode ? 'Pulsa el punto que quieras eliminar' : '';
  }
}

async function deleteWaypointAt(index) {
  if (creator.isRouting || index < 0 || index >= creator.waypoints.length) return;
  pushUndoState();
  const previousState = creator.undoStack[creator.undoStack.length - 1];
  const oldCount = creator.waypoints.length;
  creator.waypoints.splice(index, 1);

  creator.isRouting = true;
  showRoutingSpinner(true);
  try {
    if (oldCount <= 2) {
      creator.routeSegments = [];
    } else if (index === 0) {
      creator.routeSegments.shift();
    } else if (index === oldCount - 1) {
      creator.routeSegments.pop();
    } else {
      const previous = creator.waypoints[index - 1];
      const next = creator.waypoints[index];
      let replacement;
      if (creator.mode === 'road') {
        replacement = await fetchRoute(previous, next);
      } else {
        replacement = await enrichElevations(interpolateSegmentPoints(previous, next, 0.05));
      }
      creator.routeSegments.splice(index - 1, 2, replacement);
    }

    rebuildAllMarkers();
    rebuildPolyline();
    updateMidpoints();
    updateCreatorStats();
    if (creator.waypoints.length === 0) setDeletePointMode(false);
  } catch (err) {
    console.error('Delete waypoint error:', err);
    creator.undoStack.pop();
    creator.waypoints = previousState.waypoints;
    creator.routeSegments = previousState.routeSegments;
    rebuildAllMarkers();
    rebuildPolyline();
    updateMidpoints();
    updateCreatorStats();
    alert('No se pudo recalcular la ruta al eliminar el punto: ' + err.message);
  } finally {
    creator.isRouting = false;
    showRoutingSpinner(false);
  }
}

function reverseCreatedTrack() {
  if (creator.waypoints.length < 2 || creator.isRouting) return;
  pushUndoState();
  setDeletePointMode(false);
  creator.waypoints = [...creator.waypoints].reverse();
  creator.routeSegments = [...creator.routeSegments]
    .reverse()
    .map(segment => [...segment].reverse().map(point => [...point]));
  rebuildAllMarkers();
  rebuildPolyline();
  updateMidpoints();
  updateCreatorStats();

  const status = document.getElementById('creatorSaveStatus');
  if (status) {
    status.className = 'text-xs font-bold text-blue-600';
    status.textContent = '↔ Sentido de la ruta invertido';
    setTimeout(() => {
      if (status.textContent.includes('invertido')) status.textContent = '';
    }, 2200);
  }
}


// =============================================
// 5. UNDO
// =============================================

function pushUndoState() {
  creator.undoStack.push({
    waypoints: creator.waypoints.map(wp => L.latLng(wp.lat, wp.lng)),
    routeSegments: creator.routeSegments.map(seg => seg.map(p => [...p]))
  });

  // Limit undo stack
  if (creator.undoStack.length > 50) creator.undoStack.shift();
}

function undoLastAction() {
  if (creator.undoStack.length === 0) return;

  const state = creator.undoStack.pop();
  creator.waypoints = state.waypoints;
  creator.routeSegments = state.routeSegments;

  // Rebuild everything
  rebuildAllMarkers();
  rebuildPolyline();
  updateMidpoints();
  updateCreatorStats();
}


// =============================================
// 6. RETURN TO START
// =============================================

async function returnToStart() {
  if (creator.waypoints.length < 2) {
    alert('Necesitas al menos 2 puntos para crear el regreso.');
    return;
  }

  const lastWp = creator.waypoints[creator.waypoints.length - 1];
  const firstWp = creator.waypoints[0];

  // Check if already closed
  if (Math.abs(lastWp.lat - firstWp.lat) < 0.0001 && Math.abs(lastWp.lng - firstWp.lng) < 0.0001) {
    alert('El track ya está cerrado.');
    return;
  }

  pushUndoState();

  if (creator.mode === 'road' && creator.apiKey) {
    creator.isRouting = true;
    showRoutingSpinner(true);
    try {
      const segment = await fetchRoute(lastWp, firstWp);
      if (segment && segment.length > 0) {
        creator.routeSegments.push(segment);
        creator.waypoints.push(L.latLng(firstWp.lat, firstWp.lng));
        rebuildAllMarkers();
        rebuildPolyline();
        updateMidpoints();
        updateCreatorStats();
      }
    } catch (err) {
      console.error('Return routing error:', err);
      alert('Error calculando la vuelta: ' + err.message);
      creator.undoStack.pop(); // Rollback undo
    } finally {
      creator.isRouting = false;
      showRoutingSpinner(false);
    }
  } else {
    // Manual: straight line back
    const seg = [[lastWp.lat, lastWp.lng, 0], [firstWp.lat, firstWp.lng, 0]];
    creator.routeSegments.push(seg);
    creator.waypoints.push(L.latLng(firstWp.lat, firstWp.lng));
    rebuildAllMarkers();
    rebuildPolyline();
    updateMidpoints();
    updateCreatorStats();
  }
}


// =============================================
// 7. CLEAR
// =============================================

function clearCreatedTrack() {
  if (creator.waypoints.length === 0) return;
  if (!confirm('¿Borrar el track actual?')) return;

  pushUndoState();

  creator.waypoints = [];
  creator.routeSegments = [];
  creator.editingTrackId = null;
  creator.surfaceSummary = null;
  creator.deleteMode = false;
  document.getElementById('btnDeletePoint')?.classList.remove('is-active');

  // Remove all from map
  creator.markers.forEach(m => creator.map.removeLayer(m));
  creator.markers = [];
  creator.midpointMarkers.forEach(m => creator.map.removeLayer(m));
  creator.midpointMarkers = [];
  kilometerMarkers.forEach(m => creator.map.removeLayer(m));
  kilometerMarkers = [];

  if (creator.polyline) {
    creator.map.removeLayer(creator.polyline);
    creator.polyline = null;
  }

  updateCreatorStats();
}

async function saveCreatedTrack() {
  if (creator.waypoints.length < 2) return;

  const nameInput = document.getElementById('creatorTrackName');
  const name = (nameInput?.value || '').trim() || 'Track creado ' + new Date().toLocaleDateString('es-ES');

  const gpxContent = generateCreatorGPX(name);
  if (!gpxContent) return;

  const btn = document.getElementById('btnSaveCreated');
  const statusEl = document.getElementById('creatorSaveStatus');
  btn.disabled = true;
  if (statusEl) {
    statusEl.className = 'text-xs font-bold text-blue-600 animate-pulse';
    statusEl.textContent = 'Guardando...';
  }

  try {
    // Parse the generated GPX to get stats (reuse global parseGPX)
    const parsed = parseGPX(gpxContent);

    const trackData = {
      fecha: new Date().toISOString(),
      nombre: parsed.nombre,
      distancia: parsed.distancia,
      desnivelPositivo: parsed.desnivelPositivo,
      desnivelNegativo: parsed.desnivelNegativo,
      altitudMax: parsed.altitudMax,
      altitudMin: parsed.altitudMin,
      gpxContent: gpxContent
    };
    if (creator.surfaceSummary) trackData.surfaceSummary = creator.surfaceSummary;

    // If editing an existing track, include its ID to update it
    if (creator.editingTrackId) {
      trackData.id = creator.editingTrackId;
    }

    const saveResult = await saveTrackToDB(trackData);

    if (saveResult.cancelled) {
      if (statusEl) {
        statusEl.className = 'text-xs font-bold text-gray-500';
        statusEl.textContent = 'Guardado cancelado';
      }
      btn.disabled = false;
      return;
    }

    if (typeof loadHistory === 'function') {
      await loadHistory();
    }

    if (statusEl) {
      statusEl.className = 'text-xs font-bold text-green-600';
      statusEl.textContent = saveResult.overwritten
        ? '✓ Track sobrescrito'
        : creator.editingTrackId ? '✓ Track actualizado' : '✓ Guardado en Mis Tracks';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }
    btn.disabled = false;
  } catch (err) {
    console.error('Save error:', err);
    if (statusEl) {
      statusEl.className = 'text-xs font-bold text-red-600';
      statusEl.textContent = '✕ Error al guardar';
    }
    btn.disabled = false;
  }
}

// =============================================
// 12. EDIT EXISTING SAVED TRACK
// =============================================

function editTrackInCreator(track, options = {}) {
  try {
    const asCopy = Boolean(options.asCopy);
    const safeGPX = (typeof ensureValidGPXContent === 'function') ? ensureValidGPXContent(track) : track.gpxContent;
    const parsed = parseGPX(safeGPX);
    if (!parsed.puntos || parsed.puntos.length === 0) {
      alert('El track no contiene puntos válidos');
      return;
    }

    if (!creator.initialized) {
      initCreator();
    }

    // Reset creator state for editing
    creator.waypoints = [];
    creator.routeSegments = [];
    creator.undoStack = [];
    creator.editingTrackId = asCopy ? null : track.id;
    creator.surfaceSummary = track.surfaceSummary || null;
    creator.deleteMode = false;
    document.getElementById('btnDeletePoint')?.classList.remove('is-active');

    const points = parsed.puntos;

    // Preserve original indexes. Coordinate lookups are ambiguous when a route
    // crosses or revisits the same place and can make a segment jump to the end.
    const selectedIndexes = [];
    if (points.length <= 60) {
      for (let i = 0; i < points.length; i++) selectedIndexes.push(i);
    } else {
      const step = Math.ceil(points.length / 30);
      selectedIndexes.push(0);
      for (let i = step; i < points.length - 1; i += step) selectedIndexes.push(i);
      selectedIndexes.push(points.length - 1);
    }

    creator.waypoints = selectedIndexes.map(index => L.latLng(points[index].lat, points[index].lon));

    // Build segments between waypoints from original detailed points
    creator.routeSegments = [];
    for (let i = 0; i < selectedIndexes.length - 1; i++) {
      const idxA = selectedIndexes[i];
      const idxB = selectedIndexes[i + 1];
      const wpA = creator.waypoints[i];
      const wpB = creator.waypoints[i + 1];
      const segPoints = points.slice(idxA, idxB + 1).map(p => [p.lat, p.lon, p.ele || 0]);
      creator.routeSegments.push(segPoints.length > 0 ? segPoints : [[wpA.lat, wpA.lng, 0], [wpB.lat, wpB.lng, 0]]);
    }

    const nameInput = document.getElementById('creatorTrackName');
    if (nameInput) nameInput.value = asCopy ? `${track.nombre} - Variante` : track.nombre;

    rebuildAllMarkers();
    rebuildPolyline();
    updateMidpoints();
    updateCreatorStats();

    switchToTab('crear');
    setTimeout(() => fitCreatorRoute(), 220);

    const status = document.getElementById('creatorSaveStatus');
    if (asCopy && status) {
      status.className = 'text-xs font-bold text-violet-600';
      status.textContent = 'Copia abierta: se guardará como una ruta nueva';
      setTimeout(() => {
        if (status.textContent.includes('Copia abierta')) status.textContent = '';
      }, 3500);
    }

  } catch (err) {
    console.error('Error opening track for editing:', err);
    alert('Error al abrir el track para editar: ' + err.message);
  }
}

function duplicateTrackInCreator(track) {
  editTrackInCreator(track, { asCopy: true });
}

function fitCreatorRoute() {
  if (!creator.map || !creator.polyline) return;
  const bounds = creator.polyline.getBounds();
  if (!bounds?.isValid()) return;
  creator.map.invalidateSize();
  creator.map.fitBounds(bounds, {
    padding: window.innerWidth < 640 ? [28, 28] : [52, 52],
    maxZoom: 16,
    animate: false
  });
}

function openCreatorHelp() {
  document.getElementById('creatorHelpModal')?.classList.remove('hidden');
  document.body.classList.add('creator-help-open');
}

function closeCreatorHelp() {
  document.getElementById('creatorHelpModal')?.classList.add('hidden');
  document.body.classList.remove('creator-help-open');
}

function analyzeCreatedTrack() {
  if (creator.waypoints.length < 2) return;
  const name = (document.getElementById('creatorTrackName')?.value || '').trim() || 'Ruta sin guardar';
  const gpxContent = generateCreatorGPX(name);
  if (gpxContent && typeof processAndDisplay === 'function') {
    processAndDisplay(gpxContent, `${name}.gpx`, { nombre: name, gpxContent, surfaceSummary: creator.surfaceSummary });
  }
}

function scheduleCreatorSurfaceAnalysis(rawPoints) {
  clearTimeout(creatorSurfaceTimer);
  const section = document.getElementById('creatorSurfaceSection');
  if (!rawPoints || rawPoints.length < 2) {
    section?.classList.add('hidden');
    creatorSurfaceRequestId++;
    return;
  }

  const snapshot = rawPoints.map(point => [...point]);
  creatorSurfaceTimer = setTimeout(async () => {
    const requestId = ++creatorSurfaceRequestId;
    let distance = 0;
    const points = snapshot.map((point, index) => {
      if (index > 0) {
        const previous = snapshot[index - 1];
        distance += haversineDistanceCreator(previous[0], previous[1], point[0], point[1]);
      }
      return { lat: point[0], lon: point[1], ele: point[2] || 0, distance };
    });
    renderSurfaceSummary(null, 'Actualizando…', 'creator');
    try {
      const summary = await getRouteSurfaceSummary(points);
      if (requestId === creatorSurfaceRequestId) {
        creator.surfaceSummary = summary;
        renderSurfaceSummary(summary, 'Estimación OSM', 'creator');
      }
    } catch (error) {
      if (requestId !== creatorSurfaceRequestId) return;
      console.warn('Creator surface analysis error:', error);
      renderSurfaceSummary({
        asphalt: { km: 0, percentage: 0 }, track: { km: 0, percentage: 0 },
        trail: { km: 0, percentage: 0 }, unknown: { km: distance, percentage: 100 }
      }, 'Sin datos OSM', 'creator');
    }
  }, 1400);
}

function sampleCreatorRoute(rawPoints, maxSamples = 24) {
  if (!rawPoints?.length) return [];
  if (rawPoints.length <= maxSamples) return rawPoints.map(point => ({ lat: point[0], lon: point[1] }));
  const cumulative = [0];
  for (let index = 1; index < rawPoints.length; index++) {
    cumulative.push(cumulative[index - 1] + haversineDistanceCreator(
      rawPoints[index - 1][0], rawPoints[index - 1][1], rawPoints[index][0], rawPoints[index][1]
    ));
  }
  const total = cumulative[cumulative.length - 1];
  const samples = [];
  let cursor = 0;
  for (let sampleIndex = 0; sampleIndex < maxSamples; sampleIndex++) {
    const target = total * sampleIndex / (maxSamples - 1);
    while (cursor < cumulative.length - 1 && cumulative[cursor] < target) cursor++;
    const point = rawPoints[cursor];
    samples.push({ lat: point[0], lon: point[1] });
  }
  return samples;
}

async function fetchCreatorFountains(rawPoints) {
  const samples = sampleCreatorRoute(rawPoints);
  if (!samples.length) return [];
  const first = samples[0];
  const middle = samples[Math.floor(samples.length / 2)];
  const last = samples[samples.length - 1];
  const cacheKey = `fountains:${first.lat.toFixed(3)},${first.lon.toFixed(3)}:${middle.lat.toFixed(3)},${middle.lon.toFixed(3)}:${last.lat.toFixed(3)},${last.lon.toFixed(3)}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached?.items && Date.now() - cached.savedAt < 7 * 24 * 60 * 60 * 1000) return cached.items;
  } catch (_) {}

  const nodeQueries = samples.map(point =>
    `node(around:400,${point.lat.toFixed(6)},${point.lon.toFixed(6)})["amenity"="drinking_water"];`
  ).join('\n');
  const query = `[out:json][timeout:25];(${nodeQueries});out tags;`;
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  let lastError = null;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const items = (data.elements || [])
        .filter(item => item.type === 'node' && Number.isFinite(item.lat) && Number.isFinite(item.lon))
        .map(item => ({ id: item.id, lat: item.lat, lon: item.lon, name: item.tags?.name || '' }));
      try { localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), items })); } catch (_) {}
      return items;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('OpenStreetMap no respondió');
}

function renderFountainsOnLayer(layer, items) {
  if (!layer) return;
  layer.clearLayers();
  const icon = L.divIcon({
    className: '',
    html: '<span class="fountain-map-marker" aria-hidden="true">🚰</span>',
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  });
  items.forEach(item => {
    const name = item.name ? escapeCreatorHtml(item.name) : 'Fuente de agua potable';
    L.marker([item.lat, item.lon], { icon })
      .bindTooltip(`<strong>${name}</strong><br><span>Registrada en OpenStreetMap</span>`)
      .addTo(layer);
  });
}

function renderCreatorFountains(items) {
  renderFountainsOnLayer(creator.fountainsLayer, items);
}

function scheduleCreatorFountains(rawPoints, immediate = false) {
  clearTimeout(creatorFountainsTimer);
  if (!creator.fountainsVisible) return;
  if (!rawPoints || rawPoints.length < 2) {
    creator.fountainsLayer?.clearLayers();
    if (immediate) showCreatorNotice('Crea una ruta para buscar fuentes cercanas.', 'info');
    return;
  }
  const snapshot = rawPoints.map(point => [...point]);
  creatorFountainsTimer = setTimeout(async () => {
    const requestId = ++creatorFountainsRequestId;
    try {
      const items = await fetchCreatorFountains(snapshot);
      if (requestId !== creatorFountainsRequestId || !creator.fountainsVisible) return;
      renderCreatorFountains(items);
      if (immediate) {
        showCreatorNotice(items.length
          ? `${items.length} ${items.length === 1 ? 'fuente encontrada' : 'fuentes encontradas'} junto al recorrido.`
          : 'No hay fuentes de agua potable registradas junto al recorrido.', 'info');
      }
    } catch (error) {
      if (requestId !== creatorFountainsRequestId) return;
      console.warn('Creator fountain search error:', error);
      if (immediate) showCreatorNotice('No se pudieron consultar las fuentes en este momento.', 'warning');
    }
  }, immediate ? 0 : 1600);
}


// =============================================
// 8. STATS & LIVE CHART
// =============================================

function updateCreatorStats() {
  const allPoints = getAllFlatPoints();
  let dist = 0;
  let gain = 0;

  for (let i = 1; i < allPoints.length; i++) {
    dist += haversineDistanceCreator(allPoints[i - 1][0], allPoints[i - 1][1], allPoints[i][0], allPoints[i][1]);
    const diff = (allPoints[i][2] || 0) - (allPoints[i - 1][2] || 0);
    // Ignore micro elevation jitter under 1 meter
    if (diff >= 1.0) gain += diff;
  }

  creator.totalDistance = dist;
  creator.elevationGain = Math.round(gain);

  const distEl = document.getElementById('creatorDistance');
  if (distEl) distEl.textContent = dist.toFixed(2) + ' km';

  const eleEl = document.getElementById('creatorEleGain');
  if (eleEl) eleEl.textContent = Math.round(gain) + ' m';

  const pointsEl = document.getElementById('creatorPoints');
  if (pointsEl) pointsEl.textContent = creator.waypoints.length;

  // Update kilometer milestone badges on map
  updateKilometerMarkers(allPoints, dist);

  // Enable/disable buttons
  const hasPoints = creator.waypoints.length > 0;
  const hasTrack = creator.waypoints.length >= 2;
  document.getElementById('btnUndo').disabled = creator.undoStack.length === 0;
  document.getElementById('btnReturnToStart').disabled = !hasTrack;
  document.getElementById('btnReverseTrack').disabled = !hasTrack;
  document.getElementById('btnDeletePoint').disabled = !hasPoints;
  document.getElementById('btnClearTrack').disabled = !hasPoints;
  document.getElementById('btnSaveCreated').disabled = !hasTrack;
  document.getElementById('btnDownloadCreated').disabled = !hasTrack;
  document.getElementById('btnAnalyzeCreated').disabled = !hasTrack;
  if (!hasPoints && creator.deleteMode) {
    creator.deleteMode = false;
    document.getElementById('btnDeletePoint')?.classList.remove('is-active');
  }

  // Render live elevation chart
  renderCreatorChart(allPoints);
  scheduleCreatorSurfaceAnalysis(allPoints);
  scheduleCreatorFountains(allPoints);
}

function renderCreatorChart(allPoints) {
  const noDataMsg = document.getElementById('noDataMessageCrear');

  if (!creator.chart) return;

  if (allPoints.length < 2) {
    if (noDataMsg) noDataMsg.classList.remove('hidden');
    creator.chart.clear();
    return;
  }

  if (noDataMsg) noDataMsg.classList.add('hidden');

  // Build chart series data [dist, ele]
  let currentDist = 0;
  const chartData = [[0, allPoints[0][2] || 0]];

  for (let i = 1; i < allPoints.length; i++) {
    currentDist += haversineDistanceCreator(allPoints[i - 1][0], allPoints[i - 1][1], allPoints[i][0], allPoints[i][1]);
    chartData.push([parseFloat(currentDist.toFixed(2)), Math.round(allPoints[i][2] || 0)]);
  }

  creator.chart.setOption({
    grid: { left: '12%', right: '5%', bottom: '15%', top: '10%' },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      borderColor: '#e2e8f0',
      textStyle: { fontSize: 12, fontFamily: 'Inter' },
      formatter: (params) => {
        const d = params[0].value[0];
        const ele = params[0].value[1];
        return `<b>Dist.:</b> ${d.toFixed(2)} km<br><b>Alt.:</b> ${ele} m`;
      }
    },
    xAxis: {
      type: 'value',
      name: 'km',
      splitLine: { show: false },
      axisLabel: { fontSize: 10, fontFamily: 'Inter' }
    },
    yAxis: {
      type: 'value',
      name: 'm',
      scale: true,
      axisLabel: { fontSize: 10, fontFamily: 'Inter' }
    },
    dataZoom: [
      { type: 'inside' }
    ],
    series: [{
      type: 'line',
      data: chartData,
      symbol: 'none',
      smooth: true,
      lineStyle: { width: 2.5, color: '#10b981' },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(16, 185, 129, 0.5)' },
          { offset: 1, color: 'rgba(16, 185, 129, 0.02)' }
        ])
      }
    }]
  }, true);
}

function haversineDistanceCreator(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// =============================================
// 9. GPX GENERATION
// =============================================

function generateCreatorGPX(name) {
  const allPoints = getAllFlatPoints();
  if (allPoints.length < 2) return null;

  const now = new Date().toISOString();
  let trkpts = '';

  for (const p of allPoints) {
    const lat = p[0].toFixed(7);
    const lon = p[1].toFixed(7);
    const ele = (p[2] || 0).toFixed(1);
    trkpts += `      <trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele></trkpt>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Tracker Creator"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(name)}</name>
    <time>${now}</time>
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${trkpts}    </trkseg>
  </trk>
</gpx>`;
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


// =============================================
// 10. SAVE & DOWNLOAD
// =============================================

function downloadCreatedTrack() {
  if (creator.waypoints.length < 2) return;

  const nameInput = document.getElementById('creatorTrackName');
  const name = (nameInput?.value || '').trim() || 'Track creado ' + new Date().toLocaleDateString('es-ES');

  const gpxContent = generateCreatorGPX(name);
  if (!gpxContent) return;

  // Reuse global downloadGPX function
  downloadGPX(gpxContent, name + '.gpx');
}


// =============================================
// 11. UI HELPERS
// =============================================

function showRoutingSpinner(show) {
  const spinner = document.getElementById('routingSpinner');
  if (spinner) {
    spinner.classList.toggle('hidden', !show);
  }
}

function showCreatorNotice(message, type = 'info') {
  const status = document.getElementById('creatorSaveStatus');
  if (!status) return;
  status.className = `creator-map-notice ${type === 'warning' ? 'is-warning' : ''}`;
  status.textContent = message;
  clearTimeout(showCreatorNotice.timer);
  showCreatorNotice.timer = setTimeout(() => {
    if (status.textContent === message) status.textContent = '';
  }, 5500);
}
