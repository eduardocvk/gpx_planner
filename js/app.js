// =============================================
// GPX TRACKER - Progressive Web App
// Standalone application logic
// =============================================

// --- Constants ---
const DB_NAME = 'gpx-tracker-db';
const DB_VERSION = 1;
const STORE_NAME = 'tracks';

// --- Global State ---
let chart, map, mapMarker, mapPolyline;
let parsedData = null;
let detectedClimbs = [];
let climbMapLayers = [];
let activeClimbLayer = null;
let gpsWatchId = null;
let gpsMarker = null;
let gpsAccuracyCircle = null;
let gpsRouteConnector = null;
let gpsNearestMarker = null;
let gpsLastPosition = null;
let fileContent = '';
let fileName = '';
let deferredPrompt = null;
let currentAnalyzedTrack = null;
let surfaceAnalysisRequestId = 0;
const selectedTrackIds = new Set();
const historyTracksById = new Map();
let trackCompareMap = null;
let trackCompareLayers = [];
let analysisFountainsLayer = null;
let analysisFountainsVisible = false;
let analysisFountainsRequestId = 0;


// =============================================
// =============================================
// CLOUD SYNC & DATABASE (IndexedDB + Supabase)
// =============================================

const SUPABASE_URL = 'https://ketihpjheglbplwdswfq.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_G9meSMRexP5YKaam18BbPA_E9eyOxNr';
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY) || null;
let cloudSession = null;

function setCloudSyncState(state = 'idle', label = '') {
  const indicator = document.getElementById('cloudSyncStatus');
  if (!indicator) return;
  indicator.className = `cloud-sync-indicator is-${state}`;
  const descriptions = {
    idle: 'Sincronización disponible',
    syncing: 'Sincronizando rutas',
    synced: 'Rutas sincronizadas',
    local: 'Modo local',
    error: 'Error de sincronización'
  };
  const description = label || descriptions[state] || descriptions.idle;
  indicator.title = description;
  indicator.setAttribute('aria-label', description);
}

function updateCloudAccountUI() {
  const signedOutPanel = document.getElementById('cloudSignedOut');
  const signedInPanel = document.getElementById('cloudSignedIn');
  const accountEmail = document.getElementById('cloudAccountEmail');
  const forceSyncBtn = document.getElementById('btnForceSync');
  const isSignedIn = Boolean(cloudSession?.user);

  signedOutPanel?.classList.toggle('hidden', isSignedIn);
  signedInPanel?.classList.toggle('hidden', !isSignedIn);
  if (accountEmail) accountEmail.textContent = cloudSession?.user?.email || '';
  if (forceSyncBtn) forceSyncBtn.disabled = !isSignedIn;
  setCloudSyncState(isSignedIn ? 'idle' : 'local');
  document.getElementById('sharedReplaysPanel')?.classList.toggle('hidden', !isSignedIn);
  if (isSignedIn && typeof loadSharedReplayList === 'function') loadSharedReplayList();
}

async function initializeCloudAuth() {
  localStorage.removeItem('gpx_cloud_url');
  if (!supabaseClient) {
    updateCloudAccountUI();
    const message = document.getElementById('cloudAuthMessage');
    if (message) message.textContent = 'La nube no está disponible sin conexión.';
    return;
  }

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) console.warn('Could not restore Supabase session:', error.message);
  cloudSession = data?.session || null;
  updateCloudAccountUI();

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    cloudSession = session;
    updateCloudAccountUI();
    setTimeout(() => loadHistory(), 0);
  });
}

async function sendCloudMagicLink() {
  const emailInput = document.getElementById('cloudEmail');
  const message = document.getElementById('cloudAuthMessage');
  if (!supabaseClient) {
    if (message) message.textContent = 'Conéctate a Internet para acceder a la nube.';
    return;
  }
  const email = (emailInput?.value || '').trim();
  if (!email || !email.includes('@')) {
    if (message) {
      message.className = 'text-xs font-bold text-red-600';
      message.textContent = 'Introduce un correo válido.';
    }
    return;
  }

  if (message) {
    message.className = 'text-xs font-bold text-blue-600 animate-pulse';
    message.textContent = 'Enviando enlace seguro...';
  }

  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo }
  });

  if (message) {
    message.className = error ? 'text-xs font-bold text-red-600' : 'text-xs font-bold text-emerald-600';
    message.textContent = error
      ? `No se pudo enviar: ${error.message}`
      : 'Revisa tu correo y abre el enlace para conectar este dispositivo.';
  }
}

async function signOutFromCloud() {
  if (!supabaseClient) return;
  const { error } = await supabaseClient.auth.signOut();
  if (error) alert(`No se pudo cerrar la sesión: ${error.message}`);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function generateGPXFromPoints(name, points) {
  if (!points || !Array.isArray(points) || points.length === 0) return '';
  const safeName = (name || 'Ruta').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GPX Tracker">\n  <trk>\n    <name>${safeName}</name>\n    <trkseg>\n`;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    let lat, lon, ele;
    if (Array.isArray(p)) {
      lat = p[0];
      lon = p[1];
      ele = p[2] !== undefined ? p[2] : 0;
    } else {
      lat = p.lat !== undefined ? p.lat : p[0];
      lon = p.lon !== undefined ? p.lon : (p.lng !== undefined ? p.lng : p[1]);
      ele = p.ele !== undefined ? p.ele : (p[2] !== undefined ? p[2] : 0);
    }
    if (isNaN(lat) || isNaN(lon)) continue;
    xml += `      <trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele></trkpt>\n`;
  }
  xml += `    </trkseg>\n  </trk>\n</gpx>`;
  return xml;
}

function extractPointsFromGPX(gpxXml) {
  if (!gpxXml || typeof gpxXml !== 'string') return [];
  const pts = [];
  const latRegex = /lat=["']([^"']+)["']/i;
  const lonRegex = /lon=["']([^"']+)["']/i;
  const eleRegex = /<ele>([^<]+)<\/ele>/i;

  const trkpts = gpxXml.split(/<\/trkpt>/i);
  for (const block of trkpts) {
    const latM = block.match(latRegex);
    const lonM = block.match(lonRegex);
    const eleM = block.match(eleRegex);
    if (latM && lonM) {
      const lat = parseFloat(latM[1]);
      const lon = parseFloat(lonM[1]);
      const ele = eleM ? parseFloat(eleM[1]) : 0;
      if (!isNaN(lat) && !isNaN(lon)) {
        pts.push([Number(lat.toFixed(5)), Number(lon.toFixed(5)), Math.round(ele || 0)]);
      }
    }
  }
  return pts;
}

function prepareTrackForCloud(t) {
  const copy = { ...t, inCloud: true };

  // Supabase can store the original GPX, so cross-device downloads keep every point.
  // The parsed `puntos` array is redundant and much heavier than the source XML.
  if (!copy.gpxContent && (!copy.points || copy.points.length === 0) && Array.isArray(copy.puntos)) {
    copy.points = copy.puntos.map(p => [p.lat, p.lon, p.ele || 0]);
  }
  delete copy.puntos;
  return copy;
}

function restoreCloudTrack(t) {
  const track = { ...t, inCloud: true };
  const pts = track.points || track.puntos;

  // Rebuild gpxContent if missing or invalid
  if (!track.gpxContent || !track.gpxContent.includes('<trkpt')) {
    if (pts && Array.isArray(pts) && pts.length > 0) {
      track.gpxContent = generateGPXFromPoints(track.nombre, pts);
    }
  }
  return track;
}

async function getCloudTracks() {
  if (!supabaseClient || !cloudSession?.user) return null;

  try {
    const { data, error } = await supabaseClient
      .from('tracks')
      .select('data, updated_at')
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return (data || []).map(row => restoreCloudTrack({
      ...(row.data || {}),
      updatedAt: row.data?.updatedAt || row.updated_at
    }));
  } catch (err) {
    console.warn('Supabase fetch warning:', err);
    return null;
  }
}

async function syncTracksToCloud(tracksArray) {
  if (!supabaseClient || !cloudSession?.user) {
    return { ok: false, signedOut: true, message: 'Inicia sesión para sincronizar.' };
  }
  if (!tracksArray || tracksArray.length === 0) return { ok: true };

  try {
    const now = new Date().toISOString();
    const rows = tracksArray
      .filter(t => t?.id !== undefined && t?.id !== null)
      .map(t => ({
        user_id: cloudSession.user.id,
        id: String(t.id),
        data: prepareTrackForCloud({
          ...t,
          updatedAt: t.updatedAt || t.fecha || now
        }),
        updated_at: t.updatedAt || t.fecha || now
      }));

    const { error } = await supabaseClient
      .from('tracks')
      .upsert(rows, { onConflict: 'user_id,id' });

    if (error) throw error;

    for (const t of tracksArray) {
      if (t?.id !== undefined && t?.id !== null) {
        await saveTrackToLocalDB({ ...t, inCloud: true });
      }
    }
    return { ok: true };
  } catch (err) {
    console.error('Supabase save error:', err);
    return { ok: false, message: err.message || 'Error de conexión con Supabase' };
  }
}

async function forceSyncAllToCloud() {
  const btn = document.getElementById('btnForceSync');
  if (btn) btn.disabled = true;
  setCloudSyncState('syncing');

  try {
    if (!cloudSession?.user) {
      document.getElementById('cloudEmail')?.focus();
      throw new Error('Inicia sesión con tu correo antes de subir los tracks.');
    }

    const localTracks = await getLocalTracks();
    const cloudTracks = await getCloudTracks();
    const mergedTracks = mergeTracks(localTracks, cloudTracks || []);

    const result = await syncTracksToCloud(mergedTracks);

    if (result.ok) {
      const freshLocal = await getLocalTracks();
      renderHistoryTable(freshLocal);

      setCloudSyncState('synced', `${freshLocal.length} rutas sincronizadas`);
    } else {
      setCloudSyncState('error');
      alert('Detalle del error al subir a la nube: ' + (result.message || 'Error de red'));
    }
  } catch (err) {
    setCloudSyncState('error');
    alert('Error al forzar la subida: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveTrackToLocalDB(track) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(track);
    req.onsuccess = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function getLocalTracks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result.reverse());
    req.onerror = () => reject(req.error);
  });
}

function normalizeTrackName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
}

async function deleteLocalTrackIds(ids) {
  if (!ids?.length) return;
  const keys = new Set(ids.flatMap(id => [id, String(id), !isNaN(id) ? Number(id) : id]));
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    keys.forEach(id => store.delete(id));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllTracks() {
  // 1. Try to fetch latest tracks from cloud
  const cloudTracks = await getCloudTracks();
  if (cloudTracks !== null) {
    // Save/cache all cloud tracks into IndexedDB
    for (const t of cloudTracks) {
      if (t && t.id) await saveTrackToLocalDB(t);
    }
    return cloudTracks;
  }

  // 2. Fallback to local IndexedDB if offline
  return getLocalTracks();
}

async function saveTrackToDB(track) {
  const localTracks = await getLocalTracks();
  const normalizedName = normalizeTrackName(track.nombre);
  const sameNameTracks = localTracks
    .filter(existing => normalizeTrackName(existing.nombre) === normalizedName)
    .sort((a, b) => new Date(b.updatedAt || b.fecha || 0) - new Date(a.updatedAt || a.fecha || 0));

  const currentId = track.id !== undefined && track.id !== null ? String(track.id) : null;
  const targetExists = currentId && sameNameTracks.some(existing => String(existing.id) === currentId);
  const willOverwrite = sameNameTracks.length > 0 && (!currentId || targetExists || sameNameTracks.some(existing => String(existing.id) !== currentId));

  if (willOverwrite) {
    const duplicateCount = sameNameTracks.length;
    const message = duplicateCount > 1
      ? `Ya existen ${duplicateCount} tracks llamados “${track.nombre}”. Se conservará uno y se sobrescribirá con esta versión. ¿Continuar?`
      : `Ya existe un track llamado “${track.nombre}”. Se sobrescribirá y solo quedará una copia. ¿Continuar?`;
    if (!confirm(message)) return { cancelled: true, cloudSaved: Boolean(cloudSession?.user) };
  }

  if (!track.id) {
    track.id = sameNameTracks[0]?.id || (Date.now() + Math.floor(Math.random() * 1000));
  }
  track.updatedAt = new Date().toISOString();

  await saveTrackToLocalDB(track);

  const duplicateIds = sameNameTracks
    .filter(existing => String(existing.id) !== String(track.id))
    .map(existing => existing.id);
  await deleteLocalTrackIds(duplicateIds);

  if (cloudSession?.user) {
    if (duplicateIds.length) {
      const { error: deleteError } = await supabaseClient
        .from('tracks')
        .delete()
        .in('id', duplicateIds.map(String));
      if (deleteError) throw deleteError;
    }
    const allLocal = await getLocalTracks();
    const result = await syncTracksToCloud(allLocal);
    if (!result.ok) throw new Error(result.message || 'No se pudo sincronizar');
  }

  return {
    cloudSaved: Boolean(cloudSession?.user),
    overwritten: willOverwrite,
    id: track.id
  };
}

async function deleteTrackFromDB(id) {
  const targetId = (typeof id === 'string' && !isNaN(id)) ? Number(id) : id;

  // 1. Delete from local IndexedDB (try both Number and String key types)
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(targetId);
    store.delete(String(targetId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // 2. Delete the same track in Supabase. Other cloud tracks are untouched.
  const remaining = await getLocalTracks();

  if (cloudSession?.user) {
    const { error } = await supabaseClient
      .from('tracks')
      .delete()
      .eq('id', String(id));
    if (error) throw error;
  }

  // 3. Re-render table
  renderHistoryTable(remaining);
}


// =============================================
// 2. GPX PARSER
// =============================================

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseGPX(text) {
  const xmlDoc = new DOMParser().parseFromString(text, 'text/xml');
  
  // Check for XML parse errors
  const parseError = xmlDoc.getElementsByTagName('parsererror');
  if (parseError.length > 0) {
    throw new Error('El archivo no es un XML válido');
  }
  
  const trkpts = xmlDoc.getElementsByTagName('trkpt');
  if (trkpts.length === 0) {
    throw new Error('GPX inválido: no se encontraron puntos de track');
  }

  // Get track name
  const safeFileName = (typeof fileName !== 'undefined' && fileName) ? fileName.replace('.gpx', '') : 'Sin nombre';
  const trackElement = xmlDoc.getElementsByTagName('trk')[0];
  const metadataElement = xmlDoc.getElementsByTagName('metadata')[0];
  const nameTag = trackElement?.getElementsByTagName('name')[0]
    || metadataElement?.getElementsByTagName('name')[0]
    || xmlDoc.getElementsByTagName('name')[0];
  const trackName = nameTag ? nameTag.textContent.trim() : safeFileName;

  let points = [];
  let totalDist = 0;
  let gain = 0;
  let loss = 0;

  for (let i = 0; i < trkpts.length; i++) {
    const lat = parseFloat(trkpts[i].getAttribute('lat'));
    const lon = parseFloat(trkpts[i].getAttribute('lon'));
    const eleNode = trkpts[i].getElementsByTagName('ele')[0];
    const ele = eleNode ? parseFloat(eleNode.textContent) : 0;

    if (i > 0) {
      totalDist += haversineDistance(points[i - 1].lat, points[i - 1].lon, lat, lon);
      const diff = ele - points[i - 1].ele;
      if (diff > 0) gain += diff;
      else loss += Math.abs(diff);
    }
    points.push({ lat, lon, ele, distance: totalDist });
  }

  return {
    nombre: trackName,
    puntos: points,
    points: points,
    distancia: parseFloat(totalDist.toFixed(2)),
    desnivelPositivo: Math.round(gain),
    desnivelNegativo: Math.round(loss),
    altitudMax: Math.round(Math.max(...points.map(p => p.ele))),
    altitudMin: Math.round(Math.min(...points.map(p => p.ele)))
  };
}

// Surface percentages are an estimate: GPX does not normally contain this
// information, so nearby OpenStreetMap ways are matched to sampled track points.
const SURFACE_TYPES = {
  asphalt: { label: 'Asfalto', color: '#334155' },
  track: { label: 'Pista', color: '#d97706' },
  trail: { label: 'Sendero', color: '#16a34a' },
  unknown: { label: 'Sin datos', color: '#cbd5e1' }
};

function classifyOSMWay(tags = {}) {
  const highway = String(tags.highway || '').toLowerCase();
  const surface = String(tags.surface || '').toLowerCase();
  const paved = ['asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'sett', 'cobblestone'];
  const unpaved = ['unpaved', 'gravel', 'fine_gravel', 'compacted', 'dirt', 'earth', 'ground', 'sand', 'mud', 'grass', 'woodchips', 'rock'];

  if (['path', 'footway', 'bridleway', 'steps'].includes(highway)) return 'trail';
  if (highway === 'track') return 'track';
  if (paved.includes(surface)) return 'asphalt';
  if (unpaved.includes(surface)) return 'track';
  if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'living_street', 'service', 'unclassified', 'cycleway'].includes(highway)) return 'asphalt';
  return 'unknown';
}

function pointToSegmentMeters(point, start, end) {
  const meanLat = (point.lat + start.lat + end.lat) / 3 * Math.PI / 180;
  const scaleX = 111320 * Math.cos(meanLat);
  const scaleY = 110540;
  const px = point.lon * scaleX;
  const py = point.lat * scaleY;
  const ax = start.lon * scaleX;
  const ay = start.lat * scaleY;
  const bx = end.lon * scaleX;
  const by = end.lat * scaleY;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  return Math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy));
}

function samplePointsForSurface(points) {
  if (!points?.length) return [];
  const totalDistance = points[points.length - 1].distance || 0;
  const step = Math.max(0.15, totalDistance / 70);
  const samples = [];
  for (let distance = 0; distance < totalDistance; distance += step) {
    samples.push(interpolateTrackPoint(points, distance));
  }
  samples.push(interpolateTrackPoint(points, totalDistance));
  return samples.filter(Boolean);
}

function getSurfaceCacheKey(points) {
  if (!points?.length) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `surface:${first.lat.toFixed(4)},${first.lon.toFixed(4)}:${last.lat.toFixed(4)},${last.lon.toFixed(4)}:${(last.distance || 0).toFixed(1)}`;
}

function renderSurfaceSummary(summary, message = '', target = 'surface') {
  const prefix = target === 'creator' ? 'creatorSurface' : 'surface';
  const section = document.getElementById(`${prefix}Section`);
  const status = document.getElementById(`${prefix}Status`);
  const bar = document.getElementById(`${prefix}Bar`);
  const legend = document.getElementById(`${prefix}Legend`);
  if (!section || !status || !bar || !legend) return;
  section.classList.remove('hidden');
  status.className = 'context-help';
  status.textContent = '?';
  status.tabIndex = 0;
  status.setAttribute('role', 'img');
  status.setAttribute('aria-label', message || 'Información sobre la estimación');
  status.dataset.tooltip = message || 'Información sobre la estimación';

  if (!summary) {
    bar.innerHTML = '<span class="surface-loading"></span>';
    legend.innerHTML = '';
    return;
  }

  bar.innerHTML = Object.entries(SURFACE_TYPES).map(([key, meta]) => {
    const percentage = Number(summary[key]?.percentage || 0);
    return percentage > 0
      ? `<span style="width:${percentage}%;background:${meta.color}" title="${meta.label}: ${percentage.toFixed(1)}%"></span>`
      : '';
  }).join('');

  legend.innerHTML = Object.entries(SURFACE_TYPES).map(([key, meta]) => {
    const item = summary[key] || { percentage: 0, km: 0 };
    return `<div class="surface-legend-item">
      <span class="surface-dot" style="background:${meta.color}"></span>
      <span>${meta.label}</span>
      <strong>${item.percentage.toFixed(1)}%</strong>
      <small>${item.km.toFixed(1)} km</small>
    </div>`;
  }).join('');
}

async function fetchOSMWaysForSurface(samples) {
  const wayQueries = samples.map(point => `way(around:35,${point.lat.toFixed(6)},${point.lon.toFixed(6)})["highway"];`).join('\n');
  const query = `[out:json][timeout:25];(${wayQueries});out tags geom;`;
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: `data=${encodeURIComponent(query)}`
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return (data.elements || []).filter(element => element.type === 'way' && element.geometry?.length > 1);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('OpenStreetMap no respondió');
}

async function getRouteSurfaceSummary(points) {
  const cacheKey = getSurfaceCacheKey(points);
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached?.summary && Date.now() - cached.savedAt < 7 * 24 * 60 * 60 * 1000) return cached.summary;
  } catch (_) {}

  const samples = samplePointsForSurface(points);
  const ways = await fetchOSMWaysForSurface(samples);
  const distances = { asphalt: 0, track: 0, trail: 0, unknown: 0 };
  for (let index = 0; index < samples.length - 1; index++) {
    const point = samples[index];
    const segmentKm = Math.max(0, samples[index + 1].distance - point.distance);
    let nearestDistance = Infinity;
    let nearestType = 'unknown';
    for (const way of ways) {
      for (let geoIndex = 1; geoIndex < way.geometry.length; geoIndex++) {
        const distance = pointToSegmentMeters(point, way.geometry[geoIndex - 1], way.geometry[geoIndex]);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestType = classifyOSMWay(way.tags);
        }
      }
    }
    distances[nearestDistance <= 55 ? nearestType : 'unknown'] += segmentKm;
  }
  const total = Object.values(distances).reduce((sum, value) => sum + value, 0) || 1;
  const summary = Object.fromEntries(Object.entries(distances).map(([key, km]) => [key, { km, percentage: km / total * 100 }]));
  try { localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), summary })); } catch (_) {}
  return summary;
}

async function analyzeRouteSurface(points, savedSummary = null) {
  const requestId = ++surfaceAnalysisRequestId;
  if (savedSummary) {
    parsedData.surfaceSummary = savedSummary;
    renderSurfaceSummary(savedSummary, 'Guardado con el track');
    return;
  }

  renderSurfaceSummary(null, 'Consultando OpenStreetMap…');
  try {
    const summary = await getRouteSurfaceSummary(points);
    if (requestId !== surfaceAnalysisRequestId) return;
    parsedData.surfaceSummary = summary;
    if (currentAnalyzedTrack) currentAnalyzedTrack.surfaceSummary = summary;
    renderSurfaceSummary(summary, 'Estimación OSM');
  } catch (error) {
    if (requestId !== surfaceAnalysisRequestId) return;
    console.warn('Surface analysis error:', error);
    const unknownSummary = {
      asphalt: { km: 0, percentage: 0 },
      track: { km: 0, percentage: 0 },
      trail: { km: 0, percentage: 0 },
      unknown: { km: points.at(-1)?.distance || 0, percentage: 100 }
    };
    renderSurfaceSummary(unknownSummary, 'No se pudo consultar OSM');
  }
}


// =============================================
// CLIMB & MOUNTAIN PASS DETECTION
// =============================================

function interpolateTrackPoint(points, targetDistance) {
  if (!points?.length) return null;
  if (targetDistance <= points[0].distance) return { ...points[0], distance: targetDistance };
  if (targetDistance >= points[points.length - 1].distance) return { ...points[points.length - 1], distance: targetDistance };

  let low = 1;
  let high = points.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].distance < targetDistance) low = mid + 1;
    else high = mid;
  }

  const before = points[low - 1];
  const after = points[low];
  const span = after.distance - before.distance;
  const ratio = span > 0 ? (targetDistance - before.distance) / span : 0;
  return {
    lat: before.lat + (after.lat - before.lat) * ratio,
    lon: before.lon + (after.lon - before.lon) * ratio,
    ele: before.ele + (after.ele - before.ele) * ratio,
    distance: targetDistance
  };
}

function getClimbCategory(gain, averageSlope) {
  if (gain >= 1000 || (gain >= 800 && averageSlope >= 7)) return 'HC';
  if (gain >= 700) return '1ª';
  if (gain >= 500) return '2ª';
  if (gain >= 300) return '3ª';
  if (gain >= 150) return '4ª';
  return 'Cota';
}

function getClimbCategoryColor(category) {
  return {
    HC: '#171717',
    '1ª': '#881337',
    '2ª': '#dc2626',
    '3ª': '#ea580c',
    '4ª': '#eab308',
    Cota: '#10b981'
  }[category] || '#ea580c';
}

function detectClimbs(points) {
  if (!points || points.length < 3) return [];
  const totalDistance = points[points.length - 1].distance;
  if (totalDistance < 0.5) return [];

  const step = 0.1; // 100 m samples make the result independent from GPX point density.
  const samples = [];
  for (let distance = 0; distance < totalDistance; distance += step) {
    samples.push(interpolateTrackPoint(points, distance));
  }
  samples.push(interpolateTrackPoint(points, totalDistance));

  // Light weighted smoothing removes isolated GPS altitude spikes.
  const smoothed = samples.map((sample, index) => {
    const previous = samples[Math.max(0, index - 1)].ele;
    const next = samples[Math.min(samples.length - 1, index + 1)].ele;
    return { ...sample, ele: (previous + sample.ele * 2 + next) / 4 };
  });

  const climbs = [];
  let activeStart = null;
  let summitIndex = null;

  const finalizeClimb = () => {
    if (activeStart === null || summitIndex === null || summitIndex <= activeStart) return;
    const start = smoothed[activeStart];
    const summit = smoothed[summitIndex];
    const distance = summit.distance - start.distance;
    const gain = summit.ele - start.ele;
    const averageSlope = distance > 0 ? gain / (distance * 10) : 0;

    if (distance >= 0.5 && gain >= 30 && averageSlope >= 2.5) {
      let maxSlope = 0;
      for (let i = activeStart + 2; i <= summitIndex; i++) {
        const run = smoothed[i].distance - smoothed[i - 2].distance;
        if (run <= 0) continue;
        const slope = (smoothed[i].ele - smoothed[i - 2].ele) / (run * 10);
        maxSlope = Math.max(maxSlope, slope);
      }

      const category = getClimbCategory(gain, averageSlope);
      climbs.push({
        startDistance: start.distance,
        endDistance: summit.distance,
        distance,
        gain: Math.round(gain),
        averageSlope,
        maxSlope,
        startElevation: Math.round(start.ele),
        summitElevation: Math.round(summit.ele),
        startPoint: start,
        summitPoint: summit,
        category,
        isPass: category !== 'Cota'
      });
    }
  };

  for (let i = 2; i < smoothed.length; i++) {
    const rollingRun = smoothed[i].distance - smoothed[i - 2].distance;
    const rollingSlope = rollingRun > 0
      ? (smoothed[i].ele - smoothed[i - 2].ele) / (rollingRun * 10)
      : 0;

    if (activeStart === null) {
      if (rollingSlope >= 2) {
        const searchFrom = Math.max(0, i - 5);
        activeStart = searchFrom;
        for (let j = searchFrom + 1; j <= i; j++) {
          if (smoothed[j].ele < smoothed[activeStart].ele) activeStart = j;
        }
        summitIndex = i;
      }
      continue;
    }

    if (smoothed[i].ele >= smoothed[summitIndex].ele) summitIndex = i;
    const distanceAfterSummit = smoothed[i].distance - smoothed[summitIndex].distance;
    const dropAfterSummit = smoothed[summitIndex].ele - smoothed[i].ele;

    if ((distanceAfterSummit >= 0.3 && dropAfterSummit >= 12) || distanceAfterSummit >= 0.7) {
      finalizeClimb();
      activeStart = null;
      summitIndex = null;

      if (rollingSlope >= 2) {
        activeStart = Math.max(0, i - 2);
        summitIndex = i;
      }
    }
  }

  finalizeClimb();

  return climbs.map((climb, index) => ({
    ...climb,
    index,
    label: climb.isPass ? `Puerto ${index + 1}` : `Subida ${index + 1}`
  }));
}

function clearClimbMapLayers() {
  if (!map) return;
  climbMapLayers.forEach(layer => {
    if (map.hasLayer(layer)) map.removeLayer(layer);
  });
  climbMapLayers = [];
  if (activeClimbLayer && map.hasLayer(activeClimbLayer)) map.removeLayer(activeClimbLayer);
  activeClimbLayer = null;
}

function focusClimb(climb) {
  if (!climb || !parsedData || !map || !chart) return;
  const maxDistance = parsedData.puntos[parsedData.puntos.length - 1].distance || 1;
  const padding = Math.min(0.3, climb.distance * 0.15);
  const start = Math.max(0, ((climb.startDistance - padding) / maxDistance) * 100);
  const end = Math.min(100, ((climb.endDistance + padding) / maxDistance) * 100);
  chart.dispatchAction({ type: 'dataZoom', start, end });

  if (activeClimbLayer && map.hasLayer(activeClimbLayer)) map.removeLayer(activeClimbLayer);
  const climbPoints = parsedData.puntos
    .filter(point => point.distance >= climb.startDistance && point.distance <= climb.endDistance)
    .map(point => [point.lat, point.lon]);
  if (climbPoints.length >= 2) {
    activeClimbLayer = L.polyline(climbPoints, {
      color: getClimbCategoryColor(climb.category),
      weight: 7,
      opacity: 0.95
    }).addTo(map);
    map.fitBounds(activeClimbLayer.getBounds(), { padding: [35, 35] });
  }
  updateMarkerFromChart(climb.endDistance, climb.averageSlope);
  document.getElementById('profileCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderDetectedClimbs(climbs) {
  const section = document.getElementById('climbsSection');
  const list = document.getElementById('climbsList');
  const summary = document.getElementById('climbsSummary');
  if (!section || !list || !summary) return;

  clearClimbMapLayers();
  section.classList.remove('hidden');
  const passCount = climbs.filter(climb => climb.isPass).length;
  const totalGain = climbs.reduce((sum, climb) => sum + climb.gain, 0);
  summary.textContent = `${climbs.length} subida${climbs.length === 1 ? '' : 's'} · ${passCount} puerto${passCount === 1 ? '' : 's'} · +${totalGain} m`;

  if (climbs.length === 0) {
    list.innerHTML = '<div class="md:col-span-2 xl:col-span-3 py-4 text-center text-xs font-bold text-gray-400">No se han detectado subidas continuas relevantes en esta ruta.</div>';
    return;
  }

  list.innerHTML = '';
  climbs.forEach((climb, index) => {
    const color = getClimbCategoryColor(climb.category);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'climb-card';
    card.style.setProperty('--climb-color', color);
    card.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div>
          <p class="text-xs font-black text-gray-900">${climb.isPass ? 'Puerto' : 'Subida'} ${index + 1}</p>
          <p class="text-[10px] text-gray-400 mt-0.5">km ${climb.startDistance.toFixed(1)} → ${climb.endDistance.toFixed(1)}</p>
        </div>
        <span class="climb-category" style="--climb-color:${color}">${climb.category}</span>
      </div>
      <div class="grid grid-cols-4 gap-1.5 mt-2.5 text-center">
        <div><p class="text-[9px] font-bold uppercase text-gray-400">Long.</p><p class="text-xs font-extrabold text-blue-600">${climb.distance.toFixed(1)} km</p></div>
        <div><p class="text-[9px] font-bold uppercase text-gray-400">Desnivel</p><p class="text-xs font-extrabold text-emerald-600">+${climb.gain} m</p></div>
        <div><p class="text-[9px] font-bold uppercase text-gray-400">Media</p><p class="text-xs font-extrabold text-orange-600">${climb.averageSlope.toFixed(1)}%</p></div>
        <div><p class="text-[9px] font-bold uppercase text-gray-400">Máx.</p><p class="text-xs font-extrabold text-red-600">${climb.maxSlope.toFixed(1)}%</p></div>
      </div>`;
    card.addEventListener('click', () => focusClimb(climb));
    list.appendChild(card);

    const summitIcon = L.divIcon({
      html: `<div class="climb-summit-marker">${index + 1}</div>`,
      className: '',
      iconSize: [32, 28],
      iconAnchor: [16, 28]
    });
    const summitMarker = L.marker([climb.summitPoint.lat, climb.summitPoint.lon], {
      icon: summitIcon,
      zIndexOffset: 250
    }).bindTooltip(`<b>${climb.isPass ? 'Puerto' : 'Subida'} ${index + 1}</b><br>${climb.distance.toFixed(1)} km · +${climb.gain} m<br>${climb.averageSlope.toFixed(1)}% media`, {
      direction: 'top',
      offset: [0, -24]
    }).addTo(map);
    summitMarker.on('click', () => focusClimb(climb));
    climbMapLayers.push(summitMarker);
  });
}


// =============================================
// 3. MAP (Leaflet)
// =============================================

function initMap() {
  map = L.map('map', {
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

  osmLayer.addTo(map);

  analysisFountainsLayer = L.layerGroup();

  L.control.layers({
    '🗺️ Mapa': osmLayer,
    '🛰️ Satélite': satLayer
  }, {
    '🚰 Fuentes de agua potable': analysisFountainsLayer
  }, { position: 'topright' }).addTo(map);

  map.on('overlayadd', event => {
    if (event.layer !== analysisFountainsLayer) return;
    analysisFountainsVisible = true;
    refreshAnalyzedFountains(true);
  });
  map.on('overlayremove', event => {
    if (event.layer === analysisFountainsLayer) analysisFountainsVisible = false;
  });

  mapMarker = L.circleMarker([0, 0], {
    radius: 8,
    color: '#ffffff',
    fillColor: '#2563eb',
    fillOpacity: 1,
    weight: 3,
    interactive: false
  }).bindTooltip('', {
    direction: 'top',
    offset: [0, -8],
    opacity: 0.95,
    className: 'profile-map-tooltip'
  });
}

function fitAnalyzedRoute() {
  if (!map || !mapPolyline) return;
  const bounds = mapPolyline.getBounds();
  if (!bounds?.isValid()) return;
  map.invalidateSize();
  map.fitBounds(bounds, {
    padding: window.innerWidth < 640 ? [28, 28] : [52, 52],
    maxZoom: 16,
    animate: false
  });
}

function updateMap(points) {
  const latLngs = points.map(p => [p.lat, p.lon]);
  if (mapPolyline) map.removeLayer(mapPolyline);
  clearProfileMapMarker();
  clearClimbMapLayers();

  mapPolyline = L.polyline(latLngs, {
    color: '#ef4444',
    weight: 4,
    opacity: 0.85
  }).addTo(map);

  fitAnalyzedRoute();

  // Add start and end markers
  const startIcon = L.divIcon({
    html: '<div style="background:#10b981;color:white;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:11px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);">A</div>',
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  const endIcon = L.divIcon({
    html: '<div style="background:#ef4444;color:white;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:11px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);">B</div>',
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  // Remove previous start/end markers
  if (window._startMarker) map.removeLayer(window._startMarker);
  if (window._endMarker) map.removeLayer(window._endMarker);

  window._startMarker = L.marker(latLngs[0], { icon: startIcon }).addTo(map);
  window._endMarker = L.marker(latLngs[latLngs.length - 1], { icon: endIcon }).addTo(map);
  refreshAnalyzedFountains();
}

async function refreshAnalyzedFountains(showFeedback = false) {
  if (!analysisFountainsVisible || !analysisFountainsLayer || !parsedData?.puntos?.length) return;
  if (typeof fetchCreatorFountains !== 'function' || typeof renderFountainsOnLayer !== 'function') return;
  const requestId = ++analysisFountainsRequestId;
  const points = parsedData.puntos.map(point => [point.lat, point.lon, point.ele || 0]);
  try {
    const items = await fetchCreatorFountains(points);
    if (requestId !== analysisFountainsRequestId || !analysisFountainsVisible) return;
    renderFountainsOnLayer(analysisFountainsLayer, items);
    if (showFeedback && typeof showCreatorNotice === 'function') {
      showCreatorNotice(items.length
        ? `${items.length} ${items.length === 1 ? 'fuente encontrada' : 'fuentes encontradas'} junto al recorrido.`
        : 'No hay fuentes de agua potable registradas junto al recorrido.', 'info');
    }
  } catch (error) {
    console.warn('Analyzer fountain search error:', error);
    if (showFeedback && typeof showCreatorNotice === 'function') {
      showCreatorNotice('No se pudieron consultar las fuentes en este momento.', 'warning');
    }
  }
}

function findNearestTrackPoint(dist) {
  if (!parsedData?.puntos?.length) return null;
  const points = parsedData.puntos;
  let low = 0;
  let high = points.length - 1;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].distance < dist) low = mid + 1;
    else high = mid;
  }

  if (low === 0) return points[0];
  const before = points[low - 1];
  const after = points[low];
  return Math.abs(after.distance - dist) < Math.abs(before.distance - dist) ? after : before;
}

function updateMarkerFromChart(dist, slope = null) {
  if (!map || !mapMarker) return;
  const p = findNearestTrackPoint(dist);
  if (!p) return;

  mapMarker.setLatLng([p.lat, p.lon]);
  const slopeLine = Number.isFinite(slope) ? `<br><b>Pendiente:</b> ${slope.toFixed(1)}%` : '';
  mapMarker.setTooltipContent(`<b>${p.distance.toFixed(2)} km</b><br>${Math.round(p.ele)} m${slopeLine}`);
  if (!map.hasLayer(mapMarker)) mapMarker.addTo(map);
  mapMarker.openTooltip();
}

function clearProfileMapMarker() {
  if (map && mapMarker && map.hasLayer(mapMarker)) {
    map.removeLayer(mapMarker);
  }
}

function findNearestRoutePointToLocation(lat, lon) {
  if (!parsedData?.puntos?.length) return null;
  let nearest = null;
  let minDistance = Infinity;
  // Limit work for very dense GPX files while preserving sufficient precision.
  const step = Math.max(1, Math.floor(parsedData.puntos.length / 5000));
  for (let index = 0; index < parsedData.puntos.length; index += step) {
    const point = parsedData.puntos[index];
    const distance = haversineDistance(lat, lon, point.lat, point.lon);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = point;
    }
  }
  const lastPoint = parsedData.puntos[parsedData.puntos.length - 1];
  const lastDistance = haversineDistance(lat, lon, lastPoint.lat, lastPoint.lon);
  if (lastDistance < minDistance) {
    minDistance = lastDistance;
    nearest = lastPoint;
  }
  return nearest ? { point: nearest, distanceKm: minDistance } : null;
}

function setTrackLocationStatus(message, isError = false) {
  const status = document.getElementById('trackLocationStatus');
  if (!status) return;
  status.classList.remove('hidden');
  status.style.color = isError ? '#b91c1c' : '#334155';
  status.textContent = message;
}

function stopTrackLocation() {
  if (gpsWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(gpsWatchId);
  }
  gpsWatchId = null;
  [gpsMarker, gpsAccuracyCircle, gpsRouteConnector, gpsNearestMarker].forEach(layer => {
    if (map && layer && map.hasLayer(layer)) map.removeLayer(layer);
  });
  gpsMarker = null;
  gpsAccuracyCircle = null;
  gpsRouteConnector = null;
  gpsNearestMarker = null;
  const button = document.getElementById('btnTrackLocation');
  button?.classList.remove('is-active');
  if (button) {
    button.title = 'Mostrar mi ubicación en la ruta';
    button.setAttribute('aria-label', button.title);
  }
  const status = document.getElementById('trackLocationStatus');
  status?.classList.add('hidden');
}

function updateTrackLocation(position) {
  if (!map || !parsedData) return;
  const { latitude, longitude, accuracy } = position.coords;
  gpsLastPosition = position;
  const latLng = [latitude, longitude];
  const nearest = findNearestRoutePointToLocation(latitude, longitude);
  if (!nearest) return;

  const isFirstFix = !gpsMarker;
  if (isFirstFix) {
    const icon = L.divIcon({
      html: '<div class="gps-position-marker"></div>',
      className: '',
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
    gpsMarker = L.marker(latLng, { icon, zIndexOffset: 1000 }).addTo(map);
    gpsAccuracyCircle = L.circle(latLng, {
      radius: accuracy || 0,
      color: '#2563eb',
      weight: 1,
      fillColor: '#60a5fa',
      fillOpacity: 0.08,
      interactive: false
    }).addTo(map);
    gpsNearestMarker = L.circleMarker([nearest.point.lat, nearest.point.lon], {
      radius: 5,
      color: '#ffffff',
      weight: 2,
      fillColor: '#0f172a',
      fillOpacity: 1,
      interactive: false
    }).addTo(map);
    gpsRouteConnector = L.polyline([latLng, [nearest.point.lat, nearest.point.lon]], {
      color: '#2563eb',
      weight: 2,
      dashArray: '5 6',
      opacity: 0.8,
      interactive: false
    }).addTo(map);
  } else {
    gpsMarker.setLatLng(latLng);
    gpsAccuracyCircle.setLatLng(latLng).setRadius(accuracy || 0);
    gpsNearestMarker.setLatLng([nearest.point.lat, nearest.point.lon]);
    gpsRouteConnector.setLatLngs([latLng, [nearest.point.lat, nearest.point.lon]]);
  }

  const metersFromRoute = Math.round(nearest.distanceKm * 1000);
  const routeText = metersFromRoute <= 20 ? 'Sobre la ruta' : `A ${metersFromRoute} m de la ruta`;
  const statusText = `${routeText} · km ${nearest.point.distance.toFixed(1)} · ±${Math.round(accuracy || 0)} m`;
  setTrackLocationStatus(statusText);
  gpsMarker.bindTooltip(`<b>Tu ubicación</b><br>${routeText}<br>km ${nearest.point.distance.toFixed(1)}`, {
    direction: 'top',
    offset: [0, -10]
  });
  if (isFirstFix) map.flyTo(latLng, Math.max(map.getZoom(), 16), { duration: 0.8 });
  else map.panInside(L.latLng(latitude, longitude), { padding: [45, 45] });
}

function centerMapOnCurrentLocation() {
  if (!map) return;
  if (!navigator.geolocation) {
    setTrackLocationStatus('Este dispositivo no permite obtener la ubicación.', true);
    return;
  }

  const centerPosition = position => {
    gpsLastPosition = position;
    const { latitude, longitude } = position.coords;
    map.flyTo([latitude, longitude], Math.max(map.getZoom(), 16), { duration: 0.8 });
    if (parsedData) updateTrackLocation(position);
    else setTrackLocationStatus(`Ubicación encontrada · ±${Math.round(position.coords.accuracy || 0)} m`);
  };

  if (gpsLastPosition && Date.now() - gpsLastPosition.timestamp < 30000) {
    centerPosition(gpsLastPosition);
    return;
  }

  setTrackLocationStatus('Buscando ubicación…');
  navigator.geolocation.getCurrentPosition(
    centerPosition,
    error => setTrackLocationStatus(error.code === 1 ? 'Permiso de ubicación denegado.' : 'No se pudo obtener la ubicación.', true),
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );
}

function toggleTrackLocation() {
  if (!parsedData) {
    alert('Carga o abre un track antes de mostrar tu ubicación.');
    return;
  }
  if (!navigator.geolocation) {
    setTrackLocationStatus('Este dispositivo no permite obtener la ubicación.', true);
    return;
  }
  if (gpsWatchId !== null) {
    stopTrackLocation();
    return;
  }

  const button = document.getElementById('btnTrackLocation');
  button?.classList.add('is-active');
  if (button) {
    button.title = 'Dejar de mostrar mi ubicación';
    button.setAttribute('aria-label', button.title);
  }
  setTrackLocationStatus('Buscando señal GPS…');
  gpsWatchId = navigator.geolocation.watchPosition(
    updateTrackLocation,
    error => {
      const message = error.code === 1
        ? 'Permiso de ubicación denegado.'
        : error.code === 2
          ? 'No se pudo obtener la ubicación.'
          : 'La señal GPS está tardando demasiado.';
      stopTrackLocation();
      setTrackLocationStatus(message, true);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}


// =============================================
// 4. CHART (ECharts)
// =============================================

function initChart() {
  chart = echarts.init(document.getElementById('chartContainer'));
  window.addEventListener('resize', () => chart.resize());
  chart.getZr().on('globalout', clearProfileMapMarker);
}

function getSlopeColor(slope) {
  if (slope > 20) return '#171717';      // Black - Wall (>20%)
  if (slope > 15) return '#881337';      // Maroon - Steep wall (15-20%)
  if (slope > 10) return '#dc2626';      // Red - Hard climb (10-15%)
  if (slope > 6)  return '#ea580c';      // Orange - Demanding (6-10%)
  if (slope > 3)  return '#eab308';      // Yellow - Gentle (3-6%)
  if (slope >= 0) return '#10b981';      // Green - Flat (0-3%)
  return '#3b82f6';                      // Blue - Descent (<0%)
}

function renderChart() {
  const interval = Math.max(parseFloat(document.getElementById('intervalSize').value) || 1, 0.1);
  const points = parsedData.puntos;
  const maxDist = points[points.length - 1].distance;

  // Build interval sample points
  let intervals = [];
  for (let d = 0; d <= maxDist; d += interval) {
    let p = points.reduce((prev, curr) =>
      Math.abs(curr.distance - d) < Math.abs(prev.distance - d) ? curr : prev
    );
    intervals.push(p);
  }
  if (intervals[intervals.length - 1].distance < maxDist) {
    intervals.push(points[points.length - 1]);
  }

  // Calculate one slope value for each selected distance interval.
  const slopeSegments = [];

  for (let i = 0; i < intervals.length - 1; i++) {
    const run = intervals[i + 1].distance - intervals[i].distance;
    const rise = intervals[i + 1].ele - intervals[i].ele;
    const slope = run > 0 ? (rise / (run * 1000)) * 100 : 0;
    slopeSegments.push({
      start: intervals[i].distance,
      end: intervals[i + 1].distance,
      slope
    });
  }

  const slopePieces = slopeSegments.map((segment, index) => ({
    ...(index === 0 ? { gte: segment.start } : { gt: segment.start }),
    lte: segment.end,
    color: getSlopeColor(segment.slope)
  }));

  const slopeMarkAreas = slopeSegments.map((segment, index) => {
    const previousSlope = slopeSegments[index - 1]?.slope ?? -Infinity;
    const nextSlope = slopeSegments[index + 1]?.slope ?? -Infinity;
    // Label only the local peak of a hard section so percentages stay legible.
    const showHardPeak = segment.slope >= 10 && segment.slope > previousSlope && segment.slope >= nextSlope;

    return [
      {
        xAxis: segment.start,
        itemStyle: {
          color: getSlopeColor(segment.slope),
          opacity: 0.14
        },
        label: {
          show: showHardPeak,
          formatter: `${segment.slope.toFixed(1)}%`,
          position: 'insideTop',
          color: '#7f1d1d',
          backgroundColor: 'rgba(255, 255, 255, 0.9)',
          borderRadius: 4,
          padding: [2, 4],
          fontSize: 9,
          fontWeight: 800
        }
      },
      { xAxis: segment.end }
    ];
  });

  let segmentIndex = 0;
  const chartData = points.map(p => {
    while (segmentIndex < slopeSegments.length - 1 && p.distance > slopeSegments[segmentIndex].end) {
      segmentIndex++;
    }
    return [p.distance, p.ele, slopeSegments[segmentIndex]?.slope || 0];
  });

  // The translucent area follows the creator style; the foreground line is
  // coloured independently using the slope stored in the third dimension.
  chart.setOption({
    animationDuration: 350,
    grid: { left: 52, right: 22, bottom: 58, top: 18, containLabel: false },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      borderColor: '#e2e8f0',
      textStyle: { fontSize: 12, fontFamily: 'Inter' },
      axisPointer: {
        type: 'line',
        snap: true,
        lineStyle: { color: '#2563eb', width: 1.5, type: 'dashed' }
      },
      formatter: (params) => {
        const profilePoint = params.find(item => item.seriesName === 'Perfil');
        if (!profilePoint) return '';
        const [d, elevation, slope] = profilePoint.value;
        updateMarkerFromChart(d, slope);
        return `<b>${d.toFixed(2)} km</b><br>Altitud: ${elevation.toFixed(0)} m<br> Pendiente: <span style="color:${getSlopeColor(slope)};font-weight:800">${slope.toFixed(1)}%</span>`;
      }
    },
    xAxis: {
      type: 'value',
      name: 'km',
      min: 0,
      max: maxDist,
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      splitLine: { show: false },
      axisLabel: { fontSize: 10, fontFamily: 'Inter', color: '#64748b' },
      nameTextStyle: { color: '#64748b', fontWeight: 700 }
    },
    yAxis: {
      type: 'value',
      name: 'm',
      scale: true,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: '#e2e8f0', type: 'dashed' } },
      axisLabel: { fontSize: 10, fontFamily: 'Inter', color: '#64748b' },
      nameTextStyle: { color: '#64748b', fontWeight: 700 }
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: true
      },
      {
        type: 'slider',
        xAxisIndex: 0,
        filterMode: 'none',
        bottom: 8,
        height: 22,
        borderColor: 'transparent',
        backgroundColor: '#f1f5f9',
        fillerColor: 'rgba(37, 99, 235, 0.16)',
        handleStyle: { color: '#2563eb', borderColor: '#ffffff' },
        dataBackground: {
          lineStyle: { color: '#94a3b8' },
          areaStyle: { color: '#cbd5e1' }
        }
      }
    ],
    visualMap: {
      show: false,
      type: 'piecewise',
      seriesIndex: 1,
      dimension: 0,
      pieces: slopePieces
    },
    series: [
      {
        name: 'Área',
        type: 'line',
        data: chartData.map(item => [item[0], item[1]]),
        symbol: 'none',
        smooth: 0.12,
        silent: true,
        tooltip: { show: false },
        lineStyle: { width: 0, opacity: 0 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(16, 185, 129, 0.38)' },
            { offset: 1, color: 'rgba(16, 185, 129, 0.02)' }
          ])
        },
        markArea: {
          silent: true,
          data: slopeMarkAreas
        }
      },
      {
        name: 'Perfil',
        type: 'line',
        data: chartData,
        encode: { x: 0, y: 1, tooltip: [0, 1, 2] },
        symbol: 'none',
        smooth: 0.12,
        lineStyle: { width: 3 },
        emphasis: { lineStyle: { width: 4 } }
      }
    ]
  }, true);
}

function resetChartZoom() {
  if (!chart) return;
  chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
}

function toggleChartFullscreen(forceExpanded = null) {
  const card = document.getElementById('profileCard');
  const button = document.getElementById('btnToggleChartFullscreen');
  if (!card || !button) return;

  const shouldExpand = forceExpanded === null
    ? !card.classList.contains('profile-expanded')
    : forceExpanded;

  card.classList.toggle('profile-expanded', shouldExpand);
  document.body.classList.toggle('profile-modal-open', shouldExpand);
  button.querySelector('.expand-icon')?.classList.toggle('hidden', shouldExpand);
  button.querySelector('.collapse-icon')?.classList.toggle('hidden', !shouldExpand);
  button.title = shouldExpand ? 'Reducir perfil' : 'Ampliar perfil';
  button.setAttribute('aria-label', button.title);
  setTimeout(() => chart?.resize(), 60);
}


// =============================================
// 5. FILE HANDLING & DISPLAY
// =============================================

function processAndDisplay(gpxText, name, sourceTrack = null) {
  try {
    parsedData = parseGPX(gpxText);
    fileContent = gpxText;
    currentAnalyzedTrack = sourceTrack;
    if (name) fileName = name;
    if (typeof resetRouteReplayShare === 'function') resetRouteReplayShare();
    switchToTab('analizar');

    // Update stats UI
    document.getElementById('trackName').textContent = parsedData.nombre;
    document.getElementById('valDist').textContent = parsedData.distancia.toFixed(2) + ' km';
    document.getElementById('valEle').textContent = parsedData.desnivelPositivo + ' m';
    document.getElementById('valEleDown').textContent = parsedData.desnivelNegativo + ' m';
    document.getElementById('valAltMax').textContent = parsedData.altitudMax + ' m';
    document.getElementById('valAltMin').textContent = parsedData.altitudMin + ' m';

    // Show containers
    document.getElementById('statusContainer').classList.remove('hidden');
    document.getElementById('noDataMessage').classList.add('hidden');
    document.getElementById('slopeLegend').classList.remove('hidden');
    document.getElementById('btnGuardar').disabled = false;
    document.getElementById('btnOpenRouteReplay').disabled = false;

    // Render map and chart
    updateMap(parsedData.puntos);
    renderChart();
    detectedClimbs = detectClimbs(parsedData.puntos);
    renderDetectedClimbs(detectedClimbs);
    analyzeRouteSurface(parsedData.puntos, sourceTrack?.surfaceSummary);
    setTimeout(() => fitAnalyzedRoute(), 180);
  } catch (err) {
    alert('Error procesando GPX: ' + err.message);
  }
}

function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  fileName = file.name;
  const reader = new FileReader();
  reader.onload = (evt) => processAndDisplay(evt.target.result, file.name);
  reader.readAsText(file);
}

async function consumeSharedGPX() {
  const url = new URL(window.location.href);
  const sharedGPX = url.searchParams.get('shared-gpx');
  const shareError = url.searchParams.get('share-error');
  if (!sharedGPX && !shareError) return;

  url.searchParams.delete('shared-gpx');
  url.searchParams.delete('share-error');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);

  if (shareError) {
    const message = shareError === 'too-large'
      ? 'El archivo GPX compartido supera el límite de 25 MB.'
      : 'No se pudo abrir el archivo compartido. Comprueba que sea un GPX válido.';
    alert(message);
    return;
  }

  try {
    const cache = await caches.open('gpx-tracker-shared-v1');
    const cacheKey = new URL('./__shared-gpx', document.baseURI).href;
    const response = await cache.match(cacheKey);
    if (!response) throw new Error('No se encontró el archivo compartido');

    await cache.delete(cacheKey);
    const encodedName = response.headers.get('X-GPX-File-Name') || 'track.gpx';
    const sharedFileName = decodeURIComponent(encodedName);
    const gpxText = await response.text();
    if (!/<gpx[\s>]/i.test(gpxText)) throw new Error('El archivo no contiene datos GPX');

    switchToTab('analizar');
    processAndDisplay(gpxText, sharedFileName);
  } catch (error) {
    console.warn('Error opening shared GPX:', error);
    alert('No se pudo abrir el GPX compartido: ' + error.message);
  }
}


// =============================================
// 6. TRACK SAVE / HISTORY
// =============================================

async function saveCurrentTrack() {
  if (!parsedData || !fileContent) return;

  const btn = document.getElementById('btnGuardar');
  const status = document.getElementById('saveStatus');
  btn.disabled = true;
  status.className = 'text-xs font-bold text-blue-600 animate-pulse h-4';
  status.textContent = 'Guardando...';

  try {
    const saveResult = await saveTrackToDB({
      ...(currentAnalyzedTrack?.id !== undefined ? { id: currentAnalyzedTrack.id } : {}),
      fecha: new Date().toISOString(),
      nombre: parsedData.nombre,
      distancia: parsedData.distancia,
      desnivelPositivo: parsedData.desnivelPositivo,
      desnivelNegativo: parsedData.desnivelNegativo,
      altitudMax: parsedData.altitudMax,
      altitudMin: parsedData.altitudMin,
      surfaceSummary: parsedData.surfaceSummary || currentAnalyzedTrack?.surfaceSummary || null,
      gpxContent: fileContent
    });

    if (saveResult.cancelled) {
      status.className = 'text-xs font-bold text-gray-500 h-4';
      status.textContent = 'Guardado cancelado';
      btn.disabled = false;
      return;
    }

    await loadHistory();

    status.className = 'text-xs font-bold text-green-600 h-4';
    status.textContent = saveResult.overwritten
      ? '✓ Track sobrescrito'
      : saveResult.cloudSaved ? '✓ Guardado en la nube' : '✓ Guardado local';
  } catch (err) {
    status.className = 'text-xs font-bold text-red-600 h-4';
    status.textContent = '✕ Error';
    btn.disabled = false;
  }
}

function createTrackThumbnail(track) {
  let rawPoints = Array.isArray(track?.points) ? track.points : [];
  if (rawPoints.length === 0 && track?.gpxContent) rawPoints = extractPointsFromGPX(track.gpxContent);
  const points = rawPoints.map(point => Array.isArray(point)
    ? { lat: Number(point[0]), lon: Number(point[1]), ele: Number(point[2] ?? 0) }
    : { lat: Number(point.lat), lon: Number(point.lon ?? point.lng), ele: Number(point.ele ?? 0) }
  ).filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));

  if (points.length < 2) {
    return '<div class="track-thumbnail flex items-center justify-center text-gray-300" title="Sin vista previa">⌁</div>';
  }

  const routeSample = [];
  const routeStep = Math.max(1, Math.ceil(points.length / 180));
  for (let index = 0; index < points.length; index += routeStep) routeSample.push(points[index]);
  if (routeSample[routeSample.length - 1] !== points[points.length - 1]) routeSample.push(points[points.length - 1]);

  // Correct longitude by latitude so the silhouette is not stretched east-west.
  const middleLatitude = routeSample.reduce((sum, point) => sum + point.lat, 0) / routeSample.length;
  const longitudeFactor = Math.max(0.2, Math.cos(middleLatitude * Math.PI / 180));
  const routeCoordinates = routeSample.map(point => ({ x: point.lon * longitudeFactor, y: point.lat }));
  const minX = Math.min(...routeCoordinates.map(point => point.x));
  const maxX = Math.max(...routeCoordinates.map(point => point.x));
  const minY = Math.min(...routeCoordinates.map(point => point.y));
  const maxY = Math.max(...routeCoordinates.map(point => point.y));
  const xRange = Math.max(maxX - minX, 0.000001);
  const yRange = Math.max(maxY - minY, 0.000001);
  const routeScale = Math.min(106 / xRange, 34 / yRange);
  const routeWidth = xRange * routeScale;
  const routeHeight = yRange * routeScale;
  const routeOffsetX = 7 + (106 - routeWidth) / 2;
  const routeOffsetY = 5 + (34 - routeHeight) / 2;
  const projectedRoute = routeCoordinates.map(point => ({
    x: routeOffsetX + (point.x - minX) * routeScale,
    y: routeOffsetY + (maxY - point.y) * routeScale
  }));
  const routePath = projectedRoute.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');

  let accumulatedDistance = 0;
  const profilePoints = [{ distance: 0, ele: Number.isFinite(points[0].ele) ? points[0].ele : 0 }];
  for (let index = 1; index < points.length; index++) {
    accumulatedDistance += haversineDistance(points[index - 1].lat, points[index - 1].lon, points[index].lat, points[index].lon);
    profilePoints.push({ distance: accumulatedDistance, ele: Number.isFinite(points[index].ele) ? points[index].ele : 0 });
  }
  const profileStep = Math.max(1, Math.ceil(profilePoints.length / 140));
  const profileSample = profilePoints.filter((point, index) => index % profileStep === 0);
  if (profileSample[profileSample.length - 1] !== profilePoints[profilePoints.length - 1]) profileSample.push(profilePoints[profilePoints.length - 1]);
  const minElevation = Math.min(...profileSample.map(point => point.ele));
  const maxElevation = Math.max(...profileSample.map(point => point.ele));
  const elevationRange = Math.max(maxElevation - minElevation, 1);
  const totalDistance = Math.max(accumulatedDistance, 0.001);
  const profilePath = profileSample.map((point, index) => {
    const x = 7 + (point.distance / totalDistance) * 106;
    const y = 66 - ((point.ele - minElevation) / elevationRange) * 14;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  return `<div class="track-thumbnail" title="Silueta y perfil de la ruta">
    <svg viewBox="0 0 120 72" role="img" aria-label="Silueta y perfil altimétrico de la ruta">
      <rect width="120" height="72" fill="#ffffff"/>
      <path d="${routePath}" fill="none" stroke="#111827" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M7 46H113" stroke="#e5e7eb" stroke-width="1"/>
      <path d="${profilePath}" fill="none" stroke="#111827" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>`;
}

function updateCompareTracksButton() {
  const button = document.getElementById('btnCompareTracks');
  const count = document.getElementById('compareTrackCount');
  const selectedCount = selectedTrackIds.size;
  if (count) count.textContent = String(selectedCount);
  if (button) {
    button.disabled = selectedCount < 2;
    button.title = selectedCount < 2 ? 'Selecciona al menos dos tracks' : `Comparar ${selectedCount} tracks`;
  }
}

function setTrackSelected(trackId, selected) {
  const key = String(trackId);
  if (selected) selectedTrackIds.add(key);
  else selectedTrackIds.delete(key);
  document.querySelectorAll(`.track-select-checkbox[data-track-id="${CSS.escape(key)}"]`).forEach(input => {
    input.checked = selected;
  });
  updateCompareTracksButton();
}

function bindTrackSelection(container, track) {
  const checkbox = container.querySelector('.track-select-checkbox');
  checkbox?.addEventListener('click', event => event.stopPropagation());
  checkbox?.addEventListener('change', event => {
    event.stopPropagation();
    setTrackSelected(track.id, event.target.checked);
  });
}

function closeTrackComparison() {
  document.getElementById('trackCompareModal')?.classList.add('hidden');
  document.body.classList.remove('track-compare-open');
}

function openTrackComparison() {
  const tracks = Array.from(selectedTrackIds)
    .map(id => historyTracksById.get(id))
    .filter(Boolean);
  if (tracks.length < 2) {
    alert('Selecciona al menos dos tracks para compararlos.');
    return;
  }
  if (tracks.length > 10) {
    alert('Puedes comparar un máximo de 10 tracks a la vez.');
    return;
  }

  const modal = document.getElementById('trackCompareModal');
  const legend = document.getElementById('trackCompareLegend');
  modal?.classList.remove('hidden');
  document.body.classList.add('track-compare-open');

  if (!trackCompareMap) {
    trackCompareMap = L.map('trackCompareMap', { zoomControl: true }).setView([40.4167, -3.7033], 6);
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      maxZoom: 19
    });
    const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; Esri',
      maxZoom: 19
    });
    osm.addTo(trackCompareMap);
    L.control.layers({ '🗺️ Mapa': osm, '🛰️ Satélite': satellite }, null, { position: 'topright' }).addTo(trackCompareMap);
  }

  trackCompareLayers.forEach(layer => trackCompareMap.removeLayer(layer));
  trackCompareLayers = [];
  const colors = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4f46e5', '#65a30d', '#ea580c'];
  const bounds = L.latLngBounds([]);

  tracks.forEach((track, index) => {
    const points = extractPointsFromGPX(ensureValidGPXContent(track));
    const latLngs = points.map(point => [point[0], point[1]]);
    if (latLngs.length < 2) return;
    const color = colors[index % colors.length];
    const layer = L.polyline(latLngs, { color, weight: 5, opacity: 0.88 }).addTo(trackCompareMap);
    layer.bindTooltip(`<b>${escapeHtml(track.nombre)}</b><br>${(track.distancia || 0).toFixed(1)} km · +${track.desnivelPositivo || 0} m`);
    trackCompareLayers.push(layer);
    bounds.extend(layer.getBounds());
  });

  if (legend) {
    legend.innerHTML = tracks.map((track, index) => `<div>
      <span style="background:${colors[index % colors.length]}"></span>
      <strong>${escapeHtml(track.nombre)}</strong>
      <small>${(track.distancia || 0).toFixed(1)} km · +${track.desnivelPositivo || 0} m</small>
    </div>`).join('');
  }
  setTimeout(() => {
    trackCompareMap.invalidateSize();
    if (bounds.isValid()) trackCompareMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
  }, 80);
}

function renderHistoryTable(tracks) {
  const tbody = document.getElementById('tablaHistorial');
  const mobileCards = document.getElementById('trackCardsMobile');
  const statsContainer = document.getElementById('historialStats');
  if (!tbody) return;

  historyTracksById.clear();
  (tracks || []).forEach(track => historyTracksById.set(String(track.id), track));
  Array.from(selectedTrackIds).forEach(id => {
    if (!historyTracksById.has(id)) selectedTrackIds.delete(id);
  });
  updateCompareTracksButton();

  if (!tracks || tracks.length === 0) {
    if (statsContainer) statsContainer.classList.add('hidden');
    if (mobileCards) {
      mobileCards.innerHTML = `
        <div class="track-mobile-empty">
          <p class="text-3xl mb-2">⌁</p>
          <p class="font-bold">No hay tracks guardados</p>
          <p class="text-xs mt-1">Analiza y guarda tu primera ruta</p>
        </div>`;
    }
    tbody.innerHTML = `
      <tr><td colspan="7" class="px-4 py-12 text-center text-gray-400">
        <svg class="w-12 h-12 mx-auto mb-3 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
        </svg>
        <p class="font-bold">No hay tracks guardados</p>
        <p class="text-xs mt-1">Analiza y guarda tu primera ruta</p>
      </td></tr>`;
    return;
  }

  // Calculate totals
  const totalKm = tracks.reduce((sum, t) => sum + (t.distancia || 0), 0);
  const totalDplus = tracks.reduce((sum, t) => sum + (t.desnivelPositivo || 0), 0);

  if (statsContainer) {
    statsContainer.classList.remove('hidden');
    statsContainer.querySelector('div').innerHTML = `
      <div class="text-center">
        <p class="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Tracks</p>
        <p class="font-extrabold text-xl text-gray-800">${tracks.length}</p>
      </div>
      <div class="text-center">
        <p class="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Km totales</p>
        <p class="font-extrabold text-xl text-blue-600">${totalKm.toFixed(1)}</p>
      </div>
      <div class="text-center">
        <p class="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Desnivel total</p>
        <p class="font-extrabold text-xl text-emerald-600">${totalDplus.toLocaleString('es-ES')} m</p>
      </div>`;
  }

  // Render table rows
  tbody.innerHTML = '';
  if (mobileCards) mobileCards.innerHTML = '';
  tracks.forEach(t => {
    const fecha = new Date(t.fecha);
    const fechaStr = fecha.toLocaleDateString('es-ES', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });

    const cloudBadge = t.inCloud 
      ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-extrabold bg-blue-50 text-blue-600 border border-blue-200 shrink-0" title="Sincronizado en la nube">☁️ Nube</span>`
      : `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-extrabold bg-gray-100 text-gray-500 border border-gray-200 shrink-0" title="Guardado solo en este dispositivo">📱 Local</span>`;

    const tr = document.createElement('tr');
    tr.className = 'hover:bg-blue-50/60 cursor-pointer transition-colors group';
    tr.innerHTML = `
      <td class="px-2 py-2 text-center">
        <input type="checkbox" class="track-select-checkbox" data-track-id="${escapeHtml(String(t.id))}" aria-label="Seleccionar ${escapeHtml(t.nombre)} para comparar" ${selectedTrackIds.has(String(t.id)) ? 'checked' : ''}>
      </td>
      <td class="px-3 py-2">${createTrackThumbnail(t)}</td>
      <td class="px-4 py-3 whitespace-nowrap text-gray-400 text-xs">${fechaStr}</td>
      <td class="px-4 py-3 font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
        <div class="flex items-center justify-between gap-2">
          <span>${escapeHtml(t.nombre)}</span>
          ${cloudBadge}
        </div>
      </td>
      <td class="px-4 py-3 whitespace-nowrap text-right text-blue-600 font-bold tabular-nums">${(t.distancia || 0).toFixed(2)}</td>
      <td class="px-4 py-3 whitespace-nowrap text-right text-emerald-600 font-bold tabular-nums">+${(t.desnivelPositivo || 0).toLocaleString('es-ES')}m</td>
      <td class="px-4 py-3 whitespace-nowrap text-center text-xs">
        <div class="flex items-center justify-center gap-1.5">
          <button class="btn-edit p-1.5 text-amber-600 hover:text-amber-700 hover:bg-amber-50 rounded transition-colors" title="Editar en Creador">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
          <button class="btn-duplicate p-1.5 text-violet-600 hover:text-violet-700 hover:bg-violet-50 rounded transition-colors" title="Duplicar como variante">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <rect x="8" y="8" width="11" height="11" rx="2"/><path stroke-linecap="round" stroke-linejoin="round" d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>
            </svg>
          </button>
          <button class="btn-reanalyze p-1.5 text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded transition-colors" title="Ver análisis">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
          <button class="btn-download p-1.5 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded transition-colors" title="Descargar GPX">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>
          <button class="btn-delete p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors" title="Eliminar">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </td>`;

    tbody.appendChild(tr);
    bindTrackSelection(tr, t);
    bindTrackActions(tr, t, true);

    if (mobileCards) {
      const card = document.createElement('article');
      card.className = 'track-mobile-card';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Analizar ${t.nombre}`);
      card.innerHTML = `
        <label class="track-mobile-select" aria-label="Seleccionar ${escapeHtml(t.nombre)} para comparar">
          <input type="checkbox" class="track-select-checkbox" data-track-id="${escapeHtml(String(t.id))}" ${selectedTrackIds.has(String(t.id)) ? 'checked' : ''}>
          <span>Comparar</span>
        </label>
        <div class="track-mobile-header">
          ${createTrackThumbnail(t)}
          <div class="min-w-0 flex-1">
            <p class="track-mobile-name">${escapeHtml(t.nombre)}</p>
            <div class="mt-1.5">${cloudBadge}</div>
          </div>
        </div>
        <div class="track-mobile-stats">
          <div><span>Fecha</span><strong>${fechaStr}</strong></div>
          <div><span>Distancia</span><strong class="text-blue-600">${(t.distancia || 0).toFixed(2)} km</strong></div>
          <div><span>Desnivel +</span><strong class="text-emerald-600">+${(t.desnivelPositivo || 0).toLocaleString('es-ES')} m</strong></div>
          <div><span>Desnivel −</span><strong class="text-blue-500">−${(t.desnivelNegativo || 0).toLocaleString('es-ES')} m</strong></div>
          <div><span>Alt. máxima</span><strong>${(t.altitudMax || 0).toLocaleString('es-ES')} m</strong></div>
          <div><span>Alt. mínima</span><strong>${(t.altitudMin || 0).toLocaleString('es-ES')} m</strong></div>
        </div>
        <div class="track-mobile-actions">
          <button class="btn-edit" type="button">✏️ <span>Editar</span></button>
          <button class="btn-duplicate" type="button">⧉ <span>Variante</span></button>
          <button class="btn-reanalyze" type="button">◉ <span>Analizar</span></button>
          <button class="btn-download" type="button">↓ <span>GPX</span></button>
          <button class="btn-delete track-mobile-delete" type="button">🗑 <span>Eliminar</span></button>
        </div>`;
      mobileCards.appendChild(card);
      bindTrackSelection(card, t);
      bindTrackActions(card, t, true);
    }
  });
}

function bindTrackActions(container, track, openOnContainerClick) {
  if (openOnContainerClick) {
    container.addEventListener('click', event => {
      if (event.target.closest('button, input, label')) return;
      reanalyzeTrack(track);
    });
    container.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button, input, label')) {
        event.preventDefault();
        reanalyzeTrack(track);
      }
    });
  }

  container.querySelector('.btn-edit')?.addEventListener('click', event => {
    event.stopPropagation();
    if (typeof editTrackInCreator === 'function') editTrackInCreator(track);
  });
  container.querySelector('.btn-duplicate')?.addEventListener('click', event => {
    event.stopPropagation();
    if (typeof duplicateTrackInCreator === 'function') duplicateTrackInCreator(track);
  });
  container.querySelector('.btn-reanalyze')?.addEventListener('click', event => {
    event.stopPropagation();
    reanalyzeTrack(track);
  });
  container.querySelector('.btn-download')?.addEventListener('click', event => {
    event.stopPropagation();
    const safeGPX = ensureValidGPXContent(track);
    downloadGPX(safeGPX, track.nombre + '.gpx');
  });
  container.querySelector('.btn-delete')?.addEventListener('click', async event => {
    event.stopPropagation();
    if (confirm(`¿Eliminar "${track.nombre}"?`)) {
      await deleteTrackFromDB(track.id);
      loadHistory();
    }
  });
}

function mergeTracks(localList, cloudList) {
  const trackMap = new Map();
  (localList || []).forEach(t => {
    if (t?.id !== undefined && t?.id !== null) trackMap.set(String(t.id), t);
  });
  (cloudList || []).forEach(t => { 
    if (t?.id !== undefined && t?.id !== null) {
      const key = String(t.id);
      const existing = trackMap.get(key);
      const localTime = new Date(existing?.updatedAt || existing?.fecha || 0).getTime();
      const cloudTime = new Date(t.updatedAt || t.fecha || 0).getTime();
      const newest = !existing || cloudTime >= localTime
        ? { ...(existing || {}), ...t }
        : { ...t, ...existing };
      trackMap.set(key, { ...newest, inCloud: true });
    }
  });

  const merged = Array.from(trackMap.values());
  merged.sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));
  return merged;
}

async function loadHistory() {
  // 1. Instantly render local tracks first (0 delay!)
  let localTracks = [];
  try {
    localTracks = await getLocalTracks();
    renderHistoryTable(localTracks);
  } catch (err) {
    console.warn('Error loading local tracks:', err);
  }

  // 2. Show syncing status badge
  setCloudSyncState(cloudSession?.user ? 'syncing' : 'local');

  // 3. Fetch cloud tracks in background and MERGE
  try {
    const cloudTracks = await getCloudTracks();
    if (cloudTracks !== null) {
      const mergedTracks = mergeTracks(localTracks, cloudTracks);

      for (const t of mergedTracks) {
        if (t && t.id) await saveTrackToLocalDB(t);
      }

      // Sync combined list to cloud
      await syncTracksToCloud(mergedTracks);

      renderHistoryTable(mergedTracks);

      setCloudSyncState('synced');
    } else {
      setCloudSyncState('local');
    }
  } catch (err) {
    setCloudSyncState(cloudSession?.user ? 'error' : 'local');
  }
}

function ensureValidGPXContent(track) {
  if (!track) return '';

  // 1. Check if gpxContent has valid <trkpt> tags
  if (track.gpxContent && typeof track.gpxContent === 'string' && track.gpxContent.includes('<trkpt')) {
    return track.gpxContent;
  }

  // 2. If track has points array, generate fresh valid GPX XML
  if (track.points && Array.isArray(track.points) && track.points.length > 0) {
    track.gpxContent = generateGPXFromPoints(track.nombre, track.points);
    return track.gpxContent;
  }

  return track.gpxContent || '';
}

function reanalyzeTrack(track) {
  const safeGPX = ensureValidGPXContent(track);
  if (!safeGPX || !safeGPX.includes('<trkpt')) {
    alert('No se pudieron recuperar los puntos de la ruta.');
    return;
  }
  switchToTab('analizar');
  processAndDisplay(safeGPX, track.nombre + '.gpx', track);
}

function getCurrentAnalyzedTrack() {
  // A saved route is already a complete editing source. Do not reject it just
  // because the transient fileContent copy is empty (for example after cloud
  // hydration or a PWA restoration).
  if (currentAnalyzedTrack) {
    const safeGPX = ensureValidGPXContent(currentAnalyzedTrack);
    if (safeGPX?.includes('<trkpt')) {
      return { ...currentAnalyzedTrack, gpxContent: safeGPX };
    }
  }

  if (!parsedData || !fileContent?.includes('<trkpt')) return null;
  return {
    nombre: parsedData.nombre || fileName.replace(/\.gpx$/i, '') || 'Ruta',
    gpxContent: fileContent
  };
}

function closeAnalyzerMenu() {
  const menu = document.getElementById('analyzerMenu');
  const trigger = document.getElementById('btnAnalyzerMenu');
  menu?.classList.add('hidden');
  trigger?.setAttribute('aria-expanded', 'false');
}

function toggleAnalyzerMenu() {
  const menu = document.getElementById('analyzerMenu');
  const trigger = document.getElementById('btnAnalyzerMenu');
  if (!menu || !trigger) return;
  const willOpen = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !willOpen);
  trigger.setAttribute('aria-expanded', String(willOpen));
}

function openTrackPointInGoogleMaps(which) {
  const points = parsedData?.puntos;
  if (!points?.length) return;
  const point = which === 'end' ? points[points.length - 1] : points[0];
  const destination = `${Number(point.lat).toFixed(7)},${Number(point.lon).toFixed(7)}`;
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('destination', destination);
  url.searchParams.set('travelmode', 'bicycling');
  window.open(url.toString(), '_blank', 'noopener,noreferrer');
  closeAnalyzerMenu();
}

function renameGPXContent(content, newName) {
  const xml = new DOMParser().parseFromString(content, 'application/xml');
  if (xml.querySelector('parsererror')) return content;
  Array.from(xml.getElementsByTagNameNS('*', 'name')).slice(0, 2).forEach(element => {
    element.textContent = newName;
  });
  return new XMLSerializer().serializeToString(xml);
}

async function renameAnalyzedTrack(track) {
  const currentName = parsedData?.nombre || track?.nombre || 'Ruta';
  const newName = (await requestTrackName(currentName))?.trim();
  if (!newName || newName === currentName) return;

  const renamedContent = renameGPXContent(ensureValidGPXContent(track), newName);
  const updatedTrack = {
    ...track,
    nombre: newName,
    gpxContent: renamedContent,
    distancia: parsedData.distancia,
    desnivelPositivo: parsedData.desnivelPositivo,
    desnivelNegativo: parsedData.desnivelNegativo,
    altitudMax: parsedData.altitudMax,
    altitudMin: parsedData.altitudMin,
    surfaceSummary: parsedData.surfaceSummary || track.surfaceSummary || null
  };

  if (track.id !== undefined && track.id !== null) {
    const result = await saveTrackToDB(updatedTrack);
    if (result.cancelled) return;
    await loadHistory();
  }

  parsedData.nombre = newName;
  fileContent = renamedContent;
  fileName = `${newName}.gpx`;
  currentAnalyzedTrack = updatedTrack;
  document.getElementById('trackName').textContent = newName;
  const status = document.getElementById('saveStatus');
  if (status) {
    status.className = 'text-xs font-bold text-emerald-600 h-4';
    status.textContent = track.id !== undefined && track.id !== null ? '✓ Nombre actualizado' : '✓ Nombre cambiado';
    setTimeout(() => { if (status.textContent.includes('Nombre')) status.textContent = ''; }, 2500);
  }
}

function requestTrackName(currentName) {
  const modal = document.getElementById('renameTrackModal');
  const input = document.getElementById('renameTrackInput');
  const confirmButton = document.getElementById('btnConfirmRename');
  const cancelButton = document.getElementById('btnCancelRename');
  if (!modal || !input || !confirmButton || !cancelButton) return Promise.resolve(null);

  modal.classList.remove('hidden');
  input.value = currentName;
  setTimeout(() => { input.focus(); input.select(); }, 20);

  return new Promise(resolve => {
    const finish = value => {
      modal.classList.add('hidden');
      confirmButton.onclick = null;
      cancelButton.onclick = null;
      modal.onclick = null;
      input.onkeydown = null;
      resolve(value);
    };
    confirmButton.onclick = () => finish(input.value);
    cancelButton.onclick = () => finish(null);
    modal.onclick = event => { if (event.target === modal) finish(null); };
    input.onkeydown = event => {
      if (event.key === 'Enter') finish(input.value);
      if (event.key === 'Escape') finish(null);
    };
  });
}

function setupAnalyzerMenu() {
  document.getElementById('btnAnalyzerMenu')?.addEventListener('click', event => {
    event.stopPropagation();
    toggleAnalyzerMenu();
  });
  document.getElementById('analyzerMenu')?.addEventListener('click', async event => {
    event.stopPropagation();
    const button = event.target.closest('button[data-analyzer-action]');
    if (!button || button.disabled) return;

    const action = button.dataset.analyzerAction;
    if (action === 'replay') {
      closeAnalyzerMenu();
      return;
    }
    if (action === 'start' || action === 'end') {
      openTrackPointInGoogleMaps(action);
      return;
    }

    const track = getCurrentAnalyzedTrack();
    closeAnalyzerMenu();
    if (!track) {
      alert('No se pudo recuperar la ruta. Vuelve a abrirla desde Mis Tracks.');
      return;
    }

    if (action === 'edit' && typeof editTrackInCreator === 'function') {
      editTrackInCreator(track);
    } else if (action === 'rename') {
      await renameAnalyzedTrack(track);
    } else if (action === 'duplicate' && typeof duplicateTrackInCreator === 'function') {
      duplicateTrackInCreator(track);
    } else if (action === 'download') {
      downloadGPX(ensureValidGPXContent(track), `${track.nombre}.gpx`);
    }
  });
  document.addEventListener('click', closeAnalyzerMenu);
}

function downloadGPX(content, filename) {
  const blob = new Blob([content], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}


// =============================================
// 7. TAB NAVIGATION
// =============================================

function switchToTab(tab) {
  const btnA = document.getElementById('tabAnalizar');
  const btnH = document.getElementById('tabHistorial');
  const btnC = document.getElementById('tabCrear');
  const vistaA = document.getElementById('vistaAnalizar');
  const vistaH = document.getElementById('vistaHistorial');
  const vistaC = document.getElementById('vistaCrear');

  const activeClass = 'app-nav-button is-active';
  const inactiveClass = 'app-nav-button';

  // Hide all views, deactivate all buttons
  vistaA.classList.add('hidden');
  vistaH.classList.add('hidden');
  vistaC.classList.add('hidden');
  btnA.className = inactiveClass;
  btnH.className = inactiveClass;
  btnC.className = inactiveClass;

  if (tab === 'analizar') {
    btnA.classList.remove('hidden');
    vistaA.classList.remove('hidden');
    btnA.className = activeClass;
    // Recalculate map/chart sizes after tab switch
    setTimeout(() => {
      if (chart) chart.resize();
      fitAnalyzedRoute();
    }, 150);
  } else if (tab === 'historial') {
    btnA.classList.toggle('hidden', !parsedData);
    vistaH.classList.remove('hidden');
    btnH.className = activeClass;
    loadHistory();
  } else if (tab === 'crear') {
    btnA.classList.toggle('hidden', !parsedData);
    vistaC.classList.remove('hidden');
    btnC.className = activeClass;
    // Lazy-init creator map
    if (typeof initCreator === 'function') {
      setTimeout(() => {
        initCreator();
        if (typeof fitCreatorRoute === 'function') fitCreatorRoute();
      }, 150);
    }
  }
}


// =============================================
// 8. PWA INSTALL
// =============================================

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('installBanner').classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
  document.getElementById('installBanner').classList.add('hidden');
  deferredPrompt = null;
});

function installApp() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(() => {
    document.getElementById('installBanner').classList.add('hidden');
    deferredPrompt = null;
  });
}

// Register Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker registrado:', reg.scope))
      .catch(err => console.warn('Service Worker error:', err));
  });
}


// =============================================
// 9. INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', () => {
  // Initialize map and chart
  initMap();
  initChart();
  if (typeof initRouteReplayUI === 'function') initRouteReplayUI();
  setupAnalyzerMenu();
  consumeSharedGPX();
  document.getElementById('btnCenterCurrentLocation')?.addEventListener('click', centerMapOnCurrentLocation);
  document.getElementById('btnFitAnalyzedRoute')?.addEventListener('click', fitAnalyzedRoute);
  document.getElementById('btnCompareTracks')?.addEventListener('click', openTrackComparison);
  document.getElementById('btnCloseTrackCompare')?.addEventListener('click', closeTrackComparison);
  document.getElementById('trackCompareModal')?.addEventListener('click', event => {
    if (event.target.id === 'trackCompareModal') closeTrackComparison();
  });

  // Restore the Supabase session before the first cloud sync.
  initializeCloudAuth()
    .then(() => loadHistory())
    .catch(err => {
      console.warn('Cloud auth initialization error:', err);
      loadHistory();
    });

  // File input
  document.getElementById('gpxFile').addEventListener('change', handleFileSelect);

  // Interval change
  document.getElementById('intervalSize').addEventListener('change', () => {
    if (parsedData) renderChart();
  });

  const resetChartZoomBtn = document.getElementById('btnResetChartZoom');
  const toggleChartFullscreenBtn = document.getElementById('btnToggleChartFullscreen');
  if (resetChartZoomBtn) resetChartZoomBtn.addEventListener('click', resetChartZoom);
  if (toggleChartFullscreenBtn) toggleChartFullscreenBtn.addEventListener('click', () => toggleChartFullscreen());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAnalyzerMenu();
    if (e.key === 'Escape' && !document.getElementById('trackCompareModal')?.classList.contains('hidden')) closeTrackComparison();
    if (e.key === 'Escape' && document.getElementById('profileCard')?.classList.contains('profile-expanded')) {
      toggleChartFullscreen(false);
    }
  });

  // Save button
  document.getElementById('btnGuardar').addEventListener('click', saveCurrentTrack);

  // Force sync button
  const forceSyncBtn = document.getElementById('btnForceSync');
  if (forceSyncBtn) forceSyncBtn.addEventListener('click', forceSyncAllToCloud);

  const cloudLoginBtn = document.getElementById('btnCloudLogin');
  const cloudLogoutBtn = document.getElementById('btnCloudLogout');
  const cloudEmail = document.getElementById('cloudEmail');
  if (cloudLoginBtn) cloudLoginBtn.addEventListener('click', sendCloudMagicLink);
  if (cloudLogoutBtn) cloudLogoutBtn.addEventListener('click', signOutFromCloud);
  if (cloudEmail) cloudEmail.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendCloudMagicLink();
  });

  // Tab navigation
  document.getElementById('tabAnalizar').addEventListener('click', () => switchToTab('analizar'));
  document.getElementById('tabHistorial').addEventListener('click', () => switchToTab('historial'));
  document.getElementById('tabCrear').addEventListener('click', () => switchToTab('crear'));

  // PWA install buttons
  const installBtn = document.getElementById('btnInstall');
  const dismissBtn = document.getElementById('btnDismiss');
  if (installBtn) installBtn.addEventListener('click', installApp);
  if (dismissBtn) dismissBtn.addEventListener('click', () => {
    document.getElementById('installBanner').classList.add('hidden');
  });

  // Handle drag and drop
  const body = document.body;
  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    body.classList.add('ring-4', 'ring-blue-400', 'ring-inset');
  });

  body.addEventListener('dragleave', () => {
    body.classList.remove('ring-4', 'ring-blue-400', 'ring-inset');
  });

  body.addEventListener('drop', (e) => {
    e.preventDefault();
    body.classList.remove('ring-4', 'ring-blue-400', 'ring-inset');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.gpx')) {
      fileName = file.name;
      const reader = new FileReader();
      reader.onload = (evt) => processAndDisplay(evt.target.result, file.name);
      reader.readAsText(file);
    }
  });
});
