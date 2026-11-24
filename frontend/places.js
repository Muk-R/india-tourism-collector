const PLACE_GROUPS = Object.freeze({
  restaurant: "food",
  accommodation: "stays",
});

export function getPlaceGroup(row) {
  const place = row?.place || row || {};
  const category = typeof place.category === "string" ? place.category.trim().toLocaleLowerCase() : "";
  return category ? PLACE_GROUPS[category] || "attractions" : "unclassified";
}

export function filterPlaces(rows, group = "all") {
  return group === "all" ? rows : rows.filter((row) => getPlaceGroup(row) === group);
}

export function getPlaceGroupCounts(rows) {
  return rows.reduce((counts, row) => {
    const group = getPlaceGroup(row);
    counts[group] = (counts[group] || 0) + 1;
    return counts;
  }, {});
}

export function hasValidCoordinates(place) {
  return Number.isFinite(place?.latitude) && Number.isFinite(place?.longitude)
    && place.latitude >= -90 && place.latitude <= 90
    && place.longitude >= -180 && place.longitude <= 180;
}

export function getOpenStreetMapUrl(place) {
  if (!hasValidCoordinates(place)) return "";
  const { latitude, longitude } = place;
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
}
