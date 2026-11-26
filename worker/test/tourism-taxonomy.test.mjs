import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTourismPlace,
  evaluateFoodQuality,
  filterSmartTripResults,
  rankLandmarks,
} from '../src/tourism-data/taxonomy.ts';

const place = (overrides = {}) => ({
  id: 'place-1',
  canonical_name: 'Test destination',
  category: 'attraction',
  review_status: 'approved',
  latitude: 17.4,
  longitude: 78.4,
  importance_score: 0,
  ...overrides,
});

test('classifies a lake and a city-specific escape from evidence, not its name', () => {
  const result = classifyTourismPlace({
    place: place({ canonical_name: 'Reservoir View Apartments' }),
    tags: { natural: 'water', water: 'lake', tourism: 'attraction' },
    cityMembership: {
      distanceKm: 68,
      radiusKm: 100,
      outsideCityBoundary: true,
      tourismSignificanceVerified: true,
    },
  });
  assert.deepEqual(result.categories, ['lakes', 'nearby_escapes']);
  assert.deepEqual(result.exclusionReasons, []);
});

test('recognizes category distinctions from OSM tags', () => {
  const cases = [
    [{ shop: 'mall' }, 'shopping_malls'],
    [{ tourism: 'theme_park' }, 'leisure_entertainment'],
    [{ leisure: 'water_park' }, 'leisure_entertainment'],
    [{ tourism: 'museum' }, 'museums'],
    [{ amenity: 'marketplace' }, 'local_shopping_markets'],
    [{ amenity: 'place_of_worship' }, 'religious'],
  ];
  for (const [tags, expected] of cases) {
    assert.ok(classifyTourismPlace({ place: place(), tags }).categories.includes(expected), expected);
  }
});

test('requires independent evidence before recommending residential apartments as stays', () => {
  const result = classifyTourismPlace({
    place: place({ category: 'accommodation', subcategory: 'apartment' }),
    tags: { tourism: 'apartment', building: 'apartments', landuse: 'residential' },
  });
  assert.equal(result.recommendationEligible, false);
  assert.ok(result.exclusionReasons.includes('unverified_tourist_apartment'));
});

test('keeps significant memorials but excludes unsupported minor statues', () => {
  const minor = classifyTourismPlace({
    place: place({ subcategory: 'memorial' }),
    tags: { historic: 'memorial', memorial: 'statue' },
  });
  assert.equal(minor.recommendationEligible, false);
  assert.ok(minor.exclusionReasons.includes('minor_memorial_without_tourism_evidence'));

  const significant = classifyTourismPlace({
    place: place({ subcategory: 'memorial', wikidata_id: 'Q4984164' }),
    tags: { historic: 'memorial', memorial: 'statue' },
    evidence: { officialTourismReference: 'https://tourism.example.test/place' },
  });
  assert.equal(significant.recommendationEligible, true);
});

test('uses confidence-aware rating rules and does not let tiny samples dominate', () => {
  assert.equal(evaluateFoodQuality({ rating: 3.4, reviewCount: 500 }).recommendation, 'exclude_rated');
  assert.equal(evaluateFoodQuality({ rating: 4.9, reviewCount: 3 }).recommendation, 'low_confidence');
  const established = evaluateFoodQuality({ rating: 4.6, reviewCount: 500 });
  assert.equal(established.recommendation, 'high_priority');
  assert.ok(established.bayesianRating < 4.6);
  assert.equal(evaluateFoodQuality({ rating: 4.2, reviewCount: 100 }).recommendation, 'recommended');
  assert.equal(evaluateFoodQuality({ rating: null, reviewCount: null }).recommendation, 'unrated');
});

test('flags recurring negative feedback only from a representative review sample', () => {
  const issues = { hygiene: 5, service: 4, food_quality: 2 };
  assert.deepEqual(evaluateFoodQuality({ rating: 4.2, reviewCount: 90, feedback: { representative: false, sampleSize: 90, issueCounts: issues } }).riskFlags, []);
  assert.deepEqual(evaluateFoodQuality({ rating: 4.2, reviewCount: 90, feedback: { representative: true, sampleSize: 90, issueCounts: issues } }).riskFlags, ['hygiene', 'service']);
});

test('does not promote an unverified permanent-closure signal', () => {
  assert.equal(evaluateFoodQuality({ rating: 4.2, reviewCount: 300, businessStatus: 'CLOSED_PERMANENTLY' }).recommendation, 'recommended');
  assert.equal(evaluateFoodQuality({ rating: 4.2, reviewCount: 300, businessStatus: 'CLOSED_PERMANENTLY', businessStatusVerified: true, businessStatusCheckedAt: '2026-11-26' }).recommendation, 'closed');
});

test('ranks sourced landmark importance before proximity and customer ratings', () => {
  const rows = [
    { distance_km: 1, place: place({ id: 'near', importance_score: 0, rating: 4.9 }) },
    { distance_km: 20, place: place({ id: 'iconic', importance_score: 90, rating: null }) },
  ];
  assert.deepEqual(rankLandmarks(rows).map((row) => row.place.id), ['iconic', 'near']);
});

test('Smart Trips modes share verified-data filters and do not invent missing values', () => {
  const rows = [
    { place: place({ id: 'timed', visit_duration_minutes: 60, visit_duration_verified: true, travel_minutes_verified: true, travel_minutes: 30 }) },
    { place: place({ id: 'unknown', visit_duration_minutes: null, visit_duration_verified: false }) },
  ];
  assert.deepEqual(filterSmartTripResults(rows, 'limited_time', { availableMinutes: 120 }).map((row) => row.place.id), ['timed']);
  assert.deepEqual(filterSmartTripResults(rows, 'budget', { budgetPerPerson: 1000 }), []);
});

test('all remaining Smart Trips modes require their own verified attributes', () => {
  const make = (id, details) => ({ place: place({ id, ...details }) });
  assert.equal(filterSmartTripResults([make('indoor', { indoor: true, indoor_verified: true })], 'rainy_day').length, 1);
  assert.equal(filterSmartTripResults([make('walk', { walkable: true, walkable_verified: true, walk_cluster_id: 'old-town', walk_cluster_id_verified: true })], 'on_foot').length, 1);
  assert.equal(filterSmartTripResults([make('photo', { scenic: true, scenic_verified: true, photography_times: ['sunset'], photography_time_verified: true })], 'photography', { visitTime: 'sunset' }).length, 1);
  assert.equal(filterSmartTripResults([make('route', { detour_km: 2, detour_km_verified: true })], 'along_route', { maxDetourKm: 3 }).length, 1);
  assert.equal(filterSmartTripResults([make('accessible', { accessible: true, accessibility_verified: true })], 'limited_walking').length, 1);
  assert.equal(filterSmartTripResults([make('hidden', { hidden_gem: true, hidden_gem_verified: true })], 'hidden_gems').length, 1);
  assert.equal(filterSmartTripResults([make('evening', { evening_experience: true, evening_experience_verified: true, opening_hours_verified: true })], 'after_sunset').length, 1);
  assert.equal(filterSmartTripResults([make('unsafe', { accessible: true })], 'limited_walking').length, 0);
});

test('escape classification is capped by the configured radius and requires boundary and significance evidence', () => {
  const destination = { natural: 'peak' };
  const valid = classifyTourismPlace({ place: place(), tags: destination, cityMembership: { distanceKm: 99, radiusKm: 100, outsideCityBoundary: true, tourismSignificanceVerified: true } });
  const tooFar = classifyTourismPlace({ place: place(), tags: destination, cityMembership: { distanceKm: 101, radiusKm: 100, outsideCityBoundary: true, tourismSignificanceVerified: true } });
  const insideBoundary = classifyTourismPlace({ place: place(), tags: destination, cityMembership: { distanceKm: 10, radiusKm: 100, outsideCityBoundary: false, tourismSignificanceVerified: true } });
  assert.ok(valid.categories.includes('nearby_escapes'));
  assert.ok(!tooFar.categories.includes('nearby_escapes'));
  assert.ok(!insideBoundary.categories.includes('nearby_escapes'));
  assert.throws(() => classifyTourismPlace({ place: place(), tags: destination, cityMembership: { distanceKm: 100, radiusKm: 151, outsideCityBoundary: true, tourismSignificanceVerified: true } }), /radius/i);
});
