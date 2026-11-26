const MAX_ESCAPE_RADIUS_KM = 150;

const arrays = (value: unknown): string[] => Array.isArray(value) ? value.map((item) => String(item).toLowerCase()) : [];

function tourismEvidence(input: { evidence?: Record<string, unknown> }) {
  const evidence = input.evidence || {};
  return Boolean(evidence.officialTourismReference || evidence.wikidataId || evidence.wikidata_id || evidence.recognizedHeritageRegister);
}

/** Classify from source tags and independent evidence; names are intentionally not used. */
export function classifyTourismPlace(input: {
  place?: Record<string, any>;
  tags?: Record<string, string | undefined>;
  evidence?: Record<string, unknown>;
  cityMembership?: { distanceKm?: number; radiusKm?: number; outsideCityBoundary?: boolean; tourismSignificanceVerified?: boolean };
}) {
  const place = input.place || {};
  const tags = input.tags || {};
  const categories = new Set<string>();
  const exclusionReasons: string[] = [];
  const independentlyVerified = tourismEvidence(input) || Boolean(place.wikidata_id || place.wikidataId);
  const historyOrImportance = Number(place.importance_score || 0) > 0 || independentlyVerified;

  if (tags.natural === 'water' && ['lake', 'reservoir', 'pond'].includes(String(tags.water || ''))) categories.add('lakes');
  if (tags.landuse === 'reservoir') categories.add('lakes');
  if (tags.shop === 'mall') categories.add('shopping_malls');
  if (tags.tourism === 'theme_park' || tags.leisure === 'water_park' || tags.leisure === 'amusement_arcade') categories.add('leisure_entertainment');
  if (tags.tourism === 'museum') categories.add('museums');
  if (tags.amenity === 'marketplace' || tags.shop === 'marketplace') categories.add('local_shopping_markets');
  if (tags.amenity === 'place_of_worship' || tags.religion) categories.add('religious');
  if (tags.historic || tags.heritage) categories.add('heritage');
  if (tags.tourism === 'attraction' && categories.size === 0) categories.add('heritage');
  if (['park', 'garden', 'nature_reserve'].includes(String(tags.leisure || ''))) categories.add('parks_gardens');
  if (['peak', 'waterfall', 'beach', 'cave_entrance', 'viewpoint'].includes(String(tags.natural || ''))) categories.add('nature');
  if (tags.tourism === 'zoo' || tags.leisure === 'nature_reserve') categories.add('wildlife');
  if (tags.sport || tags.leisure === 'sports_centre') categories.add('adventure');
  if (tags.tourism === 'artwork' || tags.tourism === 'gallery' || tags.amenity === 'arts_centre') categories.add('arts_culture');

  const category = String(place.category || '').toLowerCase();
  const residential = tags.landuse === 'residential' || ['apartments', 'residential', 'house', 'residential_building'].includes(String(tags.building || ''));
  const verifiedTouristStay = Boolean(input.evidence?.tourismAccommodationVerified || input.evidence?.officialAccommodationReference);
  if (category === 'accommodation' && (residential || tags.tourism === 'apartment') && !verifiedTouristStay) {
    exclusionReasons.push('unverified_tourist_apartment');
  }

  const minorMemorial = (tags.historic === 'memorial' || place.subcategory === 'memorial') && !historyOrImportance;
  if (minorMemorial) exclusionReasons.push('minor_memorial_without_tourism_evidence');
  if (residential && !verifiedTouristStay) exclusionReasons.push('residential_property');

  if (category === 'attraction' && !residential && !minorMemorial) {
    const subcategory = String(place.subcategory || '').toLowerCase();
    if (['religious', 'temple', 'place_of_worship'].includes(subcategory)) categories.add('religious');
    else if (['museum', 'gallery'].includes(subcategory)) categories.add('museums');
    else if (['lake', 'reservoir'].includes(subcategory)) categories.add('lakes');
    else if (['mall', 'shopping_mall'].includes(subcategory)) categories.add('shopping_malls');
    else if (['theme_park', 'amusement_park', 'water_park', 'film_city'].includes(subcategory)) categories.add('leisure_entertainment');
    else if (['market', 'bazaar', 'marketplace'].includes(subcategory)) categories.add('local_shopping_markets');
    else if (['park', 'garden'].includes(subcategory)) categories.add('parks_gardens');
    else if (['nature', 'waterfall', 'viewpoint', 'hill'].includes(subcategory)) categories.add('nature');
    else if (subcategory) categories.add('heritage');
  }

  const membership = input.cityMembership;
  if (membership) {
    const radius = Number(membership.radiusKm);
    const distance = Number(membership.distanceKm);
    if (Number.isFinite(radius) && radius > MAX_ESCAPE_RADIUS_KM) throw new RangeError(`Nearby escape radius cannot exceed ${MAX_ESCAPE_RADIUS_KM} km.`);
    if (Number.isFinite(radius) && Number.isFinite(distance) && radius >= 0 && distance <= radius
      && membership.outsideCityBoundary === true && membership.tourismSignificanceVerified === true && !exclusionReasons.length) {
      categories.add('nearby_escapes');
    }
  }

  const recommendationEligible = exclusionReasons.length === 0 && categories.size > 0;
  return { categories: [...categories].sort(), exclusionReasons: [...new Set(exclusionReasons)], recommendationEligible };
}

export function evaluateFoodQuality(input: {
  rating?: number | null; reviewCount?: number | null; businessStatus?: string; businessStatusVerified?: boolean;
  businessStatusCheckedAt?: string; feedback?: { representative?: boolean; sampleSize?: number; issueCounts?: Record<string, number> };
}, policy: { minimumReviews?: number; priorRating?: number; priorWeight?: number; lowRatingThreshold?: number; recommendRating?: number; highRatingThreshold?: number } = {}) {
  const minReviews = policy.minimumReviews ?? 20;
  const prior = policy.priorRating ?? 4;
  const priorWeight = policy.priorWeight ?? 50;
  const rating = Number(input.rating);
  const reviews = Number(input.reviewCount);
  const validRating = input.rating != null && Number.isFinite(rating) && rating >= 0 && rating <= 5;
  const validCount = input.reviewCount != null && Number.isFinite(reviews) && reviews >= 0;
  const verifiedClosed = input.businessStatusVerified === true
    && input.businessStatus === 'CLOSED_PERMANENTLY'
    && Boolean(input.businessStatusCheckedAt);
  const bayesianRating = validRating && validCount ? (rating * reviews + prior * priorWeight) / (reviews + priorWeight) : null;
  let recommendation = 'unrated';
  if (verifiedClosed) recommendation = 'closed';
  else if (validRating && rating < (policy.lowRatingThreshold ?? 3.5)) recommendation = 'exclude_rated';
  else if (validRating && (!validCount || reviews < minReviews)) recommendation = 'low_confidence';
  else if (validRating && rating >= (policy.highRatingThreshold ?? 4.5)) recommendation = 'high_priority';
  else if (validRating && rating >= (policy.recommendRating ?? 4)) recommendation = 'recommended';
  else if (validRating) recommendation = 'lower_priority';

  const feedback = input.feedback;
  const riskFlags = feedback?.representative === true && Number(feedback.sampleSize) >= minReviews
    ? Object.entries(feedback.issueCounts || {}).filter(([, count]) => Number(count) >= 3).map(([kind]) => kind).sort()
    : [];
  return { recommendation, bayesianRating, riskFlags };
}

export function rankLandmarks<T extends { place?: Record<string, any>; distance_km?: number }>(rows: T[]): T[] {
  const tier = (row: T) => Number(row.place?.importance_score || (row as T & Record<string, any>).importance_score || 0);
  return [...rows].sort((a, b) => tier(b) - tier(a)
    || Number(a.distance_km ?? Number.POSITIVE_INFINITY) - Number(b.distance_km ?? Number.POSITIVE_INFINITY));
}

const get = (row: Record<string, any>, key: string) => row.place?.[key] ?? row[key];
const verified = (row: Record<string, any>, key: string) => get(row, `${key}_verified`) === true;

/** Shared evidence-gated filter for all Smart Trips modes; missing facts never pass. */
export function filterSmartTripResults<T extends Record<string, any>>(rows: T[], mode: string, preferences: Record<string, any> = {}): T[] {
  const check = (row: T, key: string) => verified(row, key);
  return rows.filter((row) => {
    const place = row.place || row;
    if (place.review_status && place.review_status !== 'approved') return false;
    if (mode === 'limited_time') {
      const total = Number(get(row, 'visit_duration_minutes')) + Number(get(row, 'travel_minutes'));
      if (!check(row, 'visit_duration') || !check(row, 'travel_minutes') || !Number.isFinite(total) || total > Number(preferences.availableMinutes)) return false;
    } else if (mode === 'budget') {
      if (!check(row, 'price_per_person') || Number(get(row, 'price_per_person')) > Number(preferences.budgetPerPerson)) return false;
    } else if (mode === 'rainy_day') {
      if (get(row, 'indoor_verified') !== true || get(row, 'indoor') !== true) return false;
    } else if (mode === 'on_foot') {
      if (!check(row, 'walkable') || get(row, 'walkable') !== true || !check(row, 'walk_cluster_id') || !get(row, 'walk_cluster_id')) return false;
    } else if (mode === 'photography') {
      if (get(row, 'scenic_verified') !== true || get(row, 'scenic') !== true) return false;
      if (preferences.visitTime && (!check(row, 'photography_time') || !arrays(get(row, 'photography_times')).includes(String(preferences.visitTime)))) return false;
    } else if (mode === 'along_route') {
      if (!check(row, 'detour_km') || Number(get(row, 'detour_km')) > Number(preferences.maxDetourKm)) return false;
    } else if (mode === 'limited_walking') {
      if (!check(row, 'accessibility') || get(row, 'accessible') !== true) return false;
    } else if (mode === 'hidden_gems') {
      if (get(row, 'hidden_gem_verified') !== true || get(row, 'hidden_gem') !== true) return false;
    } else if (mode === 'after_sunset') {
      if (!check(row, 'evening_experience') || get(row, 'evening_experience') !== true || !check(row, 'opening_hours')) return false;
    } else throw new TypeError(`Unknown Smart Trips mode: ${mode}`);
    if (preferences.categories?.length) {
      const categories = arrays(get(row, 'taxonomy_categories') ?? get(row, 'categories'));
      if (!preferences.categories.some((category: string) => categories.includes(category.toLowerCase()))) return false;
    }
    if (preferences.maxWalkingMinutes != null && (!check(row, 'walking_minutes') || !Number.isFinite(Number(get(row, 'walking_minutes'))) || Number(get(row, 'walking_minutes')) > Number(preferences.maxWalkingMinutes))) return false;
    return true;
  });
}
