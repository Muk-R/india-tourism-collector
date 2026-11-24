export const mockCities = [
  {
    id: "hyderabad",
    name: "Hyderabad",
    state: "Telangana",
    region: "DECCAN · INDIA",
    intro: "A starting point for finding your own rhythm in the city.",
    history: "Mock city history summary. Historical context and source attribution are not yet verified.",
    color: "saffron",
    attractions: [
      { id: "charminar", name: "Charminar", category: "Landmark", note: "Mock attraction entry · details awaiting source review.", icon: "✳" },
      { id: "golconda", name: "Golconda Fort", category: "Fort & heritage", note: "Mock attraction entry · details awaiting source review.", icon: "⌂" },
      { id: "chowmahalla", name: "Chowmahalla Palace", category: "Architecture", note: "Mock attraction entry · details awaiting source review.", icon: "▧" },
    ],
    restaurants: [
      { name: "Old City food walk", note: "Mock dining discovery · cuisine and dietary details unknown." },
      { name: "Market-side tables", note: "Mock dining discovery · cuisine and dietary details unknown." },
    ],
    stays: [
      { name: "Central city stays", note: "Mock stay discovery · price, type and ratings unknown." },
      { name: "Quiet neighborhood stays", note: "Mock stay discovery · price, type and ratings unknown." },
    ],
  },
  {
    id: "jaipur",
    name: "Jaipur",
    state: "Rajasthan",
    region: "RAJASTHAN · INDIA",
    intro: "A sample guide ready to grow with carefully sourced local knowledge.",
    history: "Mock city history summary. Historical context and source attribution are not yet verified.",
    color: "rose",
    attractions: [
      { id: "amber", name: "Amber Fort", category: "Landmark", note: "Mock attraction entry · details awaiting source review.", icon: "✳" },
      { id: "hawa-mahal", name: "Hawa Mahal", category: "Architecture", note: "Mock attraction entry · details awaiting source review.", icon: "▧" },
      { id: "city-palace", name: "City Palace", category: "Museum & heritage", note: "Mock attraction entry · details awaiting source review.", icon: "⌂" },
    ],
    restaurants: [{ name: "Neighborhood food notes", note: "Mock dining discovery · cuisine and dietary details unknown." }],
    stays: [{ name: "Stay ideas near the old city", note: "Mock stay discovery · price, type and ratings unknown." }],
  },
];

export const mockItinerary = {
  title: "A day, at your pace",
  note: "Mock itinerary · no travel times or opening hours have been verified.",
  stops: ["Choose a place to begin", "Leave room for a pause", "Follow what catches your eye"],
};

export function getView(hash, cities = mockCities) {
  const [route = "home", cityId] = (hash || "#home").replace(/^#/, "").split("/");
  if (route === "city") {
    const city = cities.find((item) => item.id === cityId);
    return city ? { type: "city", city } : { type: "not-found" };
  }
  return ["home", "itineraries", "social", "saved"].includes(route)
    ? { type: route }
    : { type: "not-found" };
}

export function filterCities(query, cities = mockCities) {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized ? cities.filter((city) => city.name.toLocaleLowerCase().includes(normalized)) : cities;
}
