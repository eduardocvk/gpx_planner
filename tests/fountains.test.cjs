const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(`${__dirname}/../js/track-creator.js`, 'utf8');
function setup(respond) {
  const cache = new Map();
  const queries = [];
  const context = vm.createContext({
    AbortController, setTimeout, clearTimeout,
    localStorage: { getItem: key => cache.get(key), setItem: (key, value) => cache.set(key, value) },
    fetch: async (url, options) => {
      const query = new URLSearchParams(options.body).get('data');
      queries.push(query);
      return { ok: true, json: async () => respond(query, queries.length) };
    }
  });
  const haversine = source.slice(source.indexOf('function haversineDistanceCreator('));
  vm.runInContext(haversine.slice(0, haversine.indexOf('\n}') + 2), context);
  vm.runInContext(source.slice(source.indexOf('async function fetchCreatorFountains('), source.indexOf('function renderFountainsOnLayer(')), context);
  return { fetch: points => context.fetchCreatorFountains(points), queries, cache };
}
test('requests coordinates and accepts nodes and area centres, deduplicated across batches', async () => {
  const app = setup(() => ({ elements: [
    { type: 'node', id: 1, lat: 40, lon: -3, tags: { name: 'Fuente' } },
    { type: 'way', id: 1, center: { lat: 40.1, lon: -3 } },
    { type: 'node', id: 2, lat: 40.5, lon: -3.02 }
  ] }));
  const items = await app.fetch([[40, -3], [41, -3]]);
  assert.equal(items.length, 2);
  assert.ok(app.queries.length > 1);
  assert.ok(app.queries.every(q => q.endsWith('out center body;')));
  const boxes = app.queries.map(q => q.match(/nwr\(([^)]*)/)[1].split(',').map(Number));
  assert.ok(boxes.some(([south, , north]) => south < 40.5 && north > 40.5));
  assert.ok(boxes.slice(1).every((box, i) => box[0] <= boxes[i][2]));
  assert.match(app.queries[0], /drinking_water"!="no/);
  assert.match(app.queries[0], /natural"="spring/);
});
test('cache includes route interior and ignores obsolete empty results', async () => {
  const app = setup(() => ({ elements: [{ type: 'node', id: 1, lat: 40, lon: -3 }] }));
  app.cache.set('fountains:40.000,-3.000:40.010,-3.000:40.020,-3.000', JSON.stringify({savedAt:Date.now(),items:[]}));
  const a = [[40, -3], [40.005, -3.01], [40.01, -3], [40.02, -3]];
  const b = [[40, -3], [40.005, -2.99], [40.01, -3], [40.02, -3]];
  assert.equal((await app.fetch(a)).length, 1);
  const before = app.queries.length;
  await app.fetch(a);
  assert.equal(app.queries.length, before);
  await app.fetch(b);
  assert.ok(app.queries.length > before);
});
test('incomplete Overpass responses use fallback and never cache a false empty result', async () => {
  const app = setup(() => ({ elements: [], remark: 'runtime error: Query timed out' }));
  await assert.rejects(app.fetch([[40, -3], [40.01, -3]]), /timed out/);
  assert.equal(app.queries.length, 2);
  assert.equal(app.cache.size, 0);
});
test('valid empty results are cached; endpoint failure can recover', async () => {
  const app = setup((q, count) => {
    if (count === 1) throw new Error('Unavailable');
    return { elements: [] };
  });
  assert.equal((await app.fetch([[40, -3], [40.01, -3]])).length, 0);
  assert.equal(app.queries.length, 2);
  assert.equal(app.cache.size, 1);
});
