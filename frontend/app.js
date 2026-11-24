import { createApiClient } from "./api.js";
import { runtimeConfig } from "./config.js";
import { filterCities, mockCities, mockItinerary, getView } from "./data.js";
import { filterPlaces, getOpenStreetMapUrl, getPlaceGroupCounts } from "./places.js";

const main = document.querySelector("#main-content");
const navLinks = [...document.querySelectorAll("[data-nav]")];
const saved = new Set();
const placeCache = new Map();
const mockByName = new Map(mockCities.map((city) => [city.name.toLocaleLowerCase(), city]));
let query = "";
let cities = [];
let citiesLoaded = false;
let source = "api";
let requestNumber = 0;
let cityLoadError = "";
let selectedCategory = "all";
const client = runtimeConfig.apiBaseUrl ? createApiClient({ apiBaseUrl: runtimeConfig.apiBaseUrl }) : null;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const safeUrl = (value) => {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
};
const present = (value) => value !== null && value !== undefined && value !== "";
const coordinateLine = (item) => {
  const mapUrl = getOpenStreetMapUrl(item);
  return mapUrl
    ? `<p class="place-meta">${item.latitude.toFixed(5)}, ${item.longitude.toFixed(5)} · <a href="${escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer">Open in OpenStreetMap</a></p>`
    : "";
};
const dataLabel = () => source === "mock" ? '<span class="mock-tag">MOCK GUIDE</span>' : '<span class="data-tag">API DATA</span>';

function cityCard(city, index) {
  const color = city.color || ["saffron", "rose", "blue", "green"][index % 4];
  const subtitle = city.state_name || city.state || "INDIA";
  return `<a class="city-card card-${index}" href="#city/${encodeURIComponent(city.id)}" aria-label="Explore ${escapeHtml(city.name)}${source === "mock" ? ", mock guide" : ""}">
    <div class="city-art ${escapeHtml(color)}" aria-hidden="true"><span class="art-orbit orbit-one"></span><span class="art-orbit orbit-two"></span><span class="art-letter">${escapeHtml(city.name.slice(0, 1))}</span><span class="art-caption">FIELD NOTES&nbsp; / &nbsp;${String(index + 1).padStart(2, "0")}</span></div>
    <div class="city-card-copy"><div class="eyebrow">${escapeHtml(subtitle)} ${dataLabel()}</div><h3>${escapeHtml(city.name)}</h3><p>${escapeHtml(city.intro || "Explore approved places in this city.")}</p><span class="text-link">Open city guide <span aria-hidden="true">→</span></span></div>
  </a>`;
}

function cityGridMarkup() {
  const filtered = filterCities(query, cities);
  if (filtered.length) return filtered.map(cityCard).join("");
  return query
    ? `<div class="empty-state" role="status"><span class="empty-glyph" aria-hidden="true">⌕</span><h3>No cities found</h3><p>Try another spelling or clear the search.</p><button class="quiet-button" data-clear-search>Clear search</button></div>`
    : '<div class="empty-state" role="status"><h3>No cities are available yet</h3><p>Public city guides will appear here when enabled.</p></div>';
}

function homeView() {
  return `<div class="page-wrap">
    <section class="home-hero" aria-labelledby="page-title"><div class="hero-copy"><p class="eyebrow"><span class="sun-mark" aria-hidden="true">✳</span> A MORE HUMAN WAY TO EXPLORE</p><h1 id="page-title">Find your way<br /><em>into a place.</em></h1><p class="hero-intro">Thoughtful city guides, gentle plans, and the little details that make a trip yours.</p><label class="search-box"><span aria-hidden="true">⌕</span><span class="sr-only">Search cities</span><input id="city-search" type="search" placeholder="Try a city name" value="${escapeHtml(query)}" autocomplete="off" /><kbd>⌘ K</kbd></label><p class="data-note"><span aria-hidden="true">◌</span> ${source === "mock" ? "Development sample content · mock data, not verified travel data" : "Approved places from the Localise public API"}</p></div><div class="hero-art" aria-hidden="true"><div class="sun-disc"></div><div class="arch arch-back"></div><div class="arch arch-front"><span></span></div><div class="hero-art-label">A PLACE<br />TAKES SHAPE</div><div class="hero-side-note">01 — 02<br />CITY NOTES</div></div></section>
    <section class="section-block city-section" aria-labelledby="cities-title"><div class="section-heading"><div><p class="eyebrow">START SOMEWHERE</p><h2 id="cities-title">A city, at a glance<span class="period">.</span></h2></div><a class="text-link all-cities" href="#home">Browse all <span aria-hidden="true">→</span></a></div><div class="city-grid" id="city-grid" aria-live="polite">${cityGridMarkup()}</div></section>
    <section class="quiet-banner"><span class="banner-mark" aria-hidden="true">✳</span><div><p class="eyebrow">MADE FOR THE WAY YOU TRAVEL</p><p>Good trips leave space for a little surprise.</p></div><span class="banner-arrow" aria-hidden="true">↗</span></section>
    <footer class="site-footer"><span>LOCALISE <span class="footer-dot">·</span> A PERSONAL CITY GUIDE</span><span>${source === "mock" ? "Development preview" : "Public API"} <span aria-hidden="true">✳</span></span></footer>
  </div>`;
}

function sourceLinks(place) {
  const links = [];
  const descriptionSource = safeUrl(place.description_source);
  const wikipedia = safeUrl(place.wikipedia_url);
  if (descriptionSource) links.push(`<a href="${escapeHtml(descriptionSource)}" target="_blank" rel="noopener noreferrer">Description source</a>`);
  else if (present(place.description_source)) links.push(`<span>${escapeHtml(place.description_source)}</span>`);
  if (wikipedia && wikipedia !== descriptionSource) links.push(`<a href="${escapeHtml(wikipedia)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>`);
  if (present(place.description_license)) {
    const licenseUrl = safeUrl(place.description_license);
    links.push(licenseUrl ? `<a href="${escapeHtml(licenseUrl)}" target="_blank" rel="noopener noreferrer">Description licence</a>` : `<span>Licence: ${escapeHtml(place.description_license)}</span>`);
  }
  for (const attribution of Array.isArray(place.sources) ? place.sources : []) {
    const url = safeUrl(attribution.source_url);
    const label = [attribution.source_name, attribution.attribution].filter(present).join(" · ");
    if (url) links.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label || "Source")}</a>`);
    else if (label) links.push(`<span>${escapeHtml(label)}</span>`);
    if (present(attribution.license)) {
      const license = safeUrl(attribution.license);
      links.push(license ? `<a href="${escapeHtml(license)}" target="_blank" rel="noopener noreferrer">Source licence</a>` : `<span>Licence: ${escapeHtml(attribution.license)}</span>`);
    }
  }
  return links.length ? `<p class="place-meta source-links">${links.join(" · ")}</p>` : "";
}

function imageAttribution(place) {
  const author = present(place.image_author) ? `Image by ${escapeHtml(place.image_author)}` : "";
  const imageUrl = safeUrl(place.image_url);
  const license = present(place.image_license) ? safeUrl(place.image_license) : "";
  const licenseText = present(place.image_license)
    ? (license ? `<a href="${escapeHtml(license)}" target="_blank" rel="noopener noreferrer">Image licence</a>` : `Licence: ${escapeHtml(place.image_license)}`)
    : "";
  const authorText = author && imageUrl
    ? `<a href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener noreferrer">${author}</a>`
    : author;
  const details = [authorText, licenseText].filter(Boolean).join(" · ");
  return details ? `<p class="place-meta">${details}</p>` : "";
}

function placeCard(row) {
  const place = row?.place || row || {};
  const id = String(place.id || place.canonical_name || place.name || "unknown");
  const name = place.canonical_name || place.name || "Unnamed place";
  const category = [place.category, place.subcategory].filter(present).join(" · ") || "Place";
  const description = place.description || place.note || "No description is available.";
  const quality = present(place.quality_score) ? `<span class="score-label">Data quality ${escapeHtml(place.quality_score)}</span>` : "";
  const importance = present(place.importance_score) ? `<span class="score-label">Importance ${escapeHtml(place.importance_score)}</span>` : "";
  const distance = present(row?.distance_km) ? `<span class="score-label">${escapeHtml(row.distance_km)} km away</span>` : "";
  const imageUrl = safeUrl(place.image_url);
  const mockCopy = source === "mock" ? `<span class="mock-tag">MOCK COPY</span>` : "";
  return `<article class="place-card"><div class="place-glyph" aria-hidden="true">${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : "✳"}</div><div class="place-copy"><p class="eyebrow">${escapeHtml(category)} ${mockCopy}</p><h3>${escapeHtml(name)}</h3><p>${escapeHtml(description)}</p>${coordinateLine(place)}${imageAttribution(place)}${sourceLinks(place)}<div class="place-scores">${importance}${quality}${distance}</div></div><button class="save-button ${saved.has(id) ? "is-saved" : ""}" data-save="${escapeHtml(id)}" aria-label="${saved.has(id) ? "Remove" : "Save"} ${escapeHtml(name)}" aria-pressed="${saved.has(id)}">${saved.has(id) ? "♥" : "♡"}</button></article>`;
}

function placeFilters(rows) {
  const counts = getPlaceGroupCounts(rows);
  const groups = [
    ["all", "All", rows.length],
    ["attractions", "Attractions", counts.attractions || 0],
    ["food", "Food", counts.food || 0],
    ["stays", "Stays", counts.stays || 0],
  ];
  if (selectedCategory !== "all" && !counts[selectedCategory]) selectedCategory = "all";
  return `<div class="place-filters" role="group" aria-label="Filter places by source category">${groups.filter(([group, , count]) => group === "all" || count > 0).map(([group, label, count]) => `<button class="filter-button ${selectedCategory === group ? "active" : ""}" type="button" data-category-filter="${group}" aria-pressed="${selectedCategory === group}">${label}<span>${count}</span></button>`).join("")}</div>`;
}

function cityView(city, rows) {
  const mockCity = source === "mock" ? mockByName.get(city.name.toLocaleLowerCase()) : null;
  const color = city.color || "saffron";
  const filters = placeFilters(rows);
  const shownRows = filterPlaces(rows, selectedCategory);
  const places = shownRows.map(placeCard).join("");
  const unclassifiedCount = getPlaceGroupCounts(rows).unclassified || 0;
  const intro = city.intro || "Discover approved places and their source details.";
  const history = mockCity ? `<section class="history-panel" aria-labelledby="history-title"><div class="history-icon" aria-hidden="true">✳</div><div><p class="eyebrow">A SENSE OF PLACE <span class="mock-tag">MOCK COPY</span></p><h2 id="history-title">The story so far</h2><p>${escapeHtml(mockCity.history)}</p><span class="source-note">Sources and attribution are not verified for this sample copy.</span></div></section>` : "";
  const extras = mockCity ? `<div class="city-columns"><section class="mini-section" aria-labelledby="food-title"><p class="eyebrow">TASTE THE CITY <span class="mock-tag">MOCK</span></p><h2 id="food-title">Food & drink</h2>${mockCity.restaurants.map((item) => `<article class="mini-card"><span class="mini-icon" aria-hidden="true">◒</span><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.note)}</p></div></article>`).join("")}</section><section class="mini-section" aria-labelledby="stay-title"><p class="eyebrow">A PLACE TO LAND <span class="mock-tag">MOCK</span></p><h2 id="stay-title">Places to stay</h2>${mockCity.stays.map((item) => `<article class="mini-card"><span class="mini-icon" aria-hidden="true">⌂</span><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.note)}</p></div></article>`).join("")}</section></div>` : "";
  return `<div class="page-wrap city-page"><a class="back-link" href="#home"><span aria-hidden="true">←</span> All cities</a><section class="city-header ${escapeHtml(color)}"><div class="city-header-copy"><p class="eyebrow">${escapeHtml(city.state_name || city.state || "INDIA")} ${dataLabel()}</p><h1>${escapeHtml(city.name)}<span class="period">.</span></h1><p>${escapeHtml(intro)}</p>${coordinateLine(city)}</div><div class="city-header-art" aria-hidden="true"><span>${escapeHtml(city.name.slice(0, 1))}</span><small>LOCALISE<br />FIELD NOTES</small></div></section>
    <div class="city-content">${history}<section class="section-block" aria-labelledby="attractions-title"><div class="section-heading"><div><p class="eyebrow">WORTH A CLOSER LOOK</p><h2 id="attractions-title">Landmarks & places<span class="period">.</span></h2></div><span class="count-label" aria-live="polite" aria-atomic="true">${String(shownRows.length).padStart(2, "0")} PLACES</span></div>${filters}${selectedCategory === "all" && unclassifiedCount ? `<p class="source-note">${unclassifiedCount} unclassified ${unclassifiedCount === 1 ? "place is" : "places are"} shown in All.</p>` : ""}<div class="place-list">${places || '<div class="empty-state" role="status"><h3>No places in this category</h3><p>Choose another category to see available places.</p></div>'}</div></section>${extras}</div></div>`;
}

function simpleView(type) {
  if (type === "itineraries") return `<div class="page-wrap simple-page"><p class="eyebrow">YOUR DAYS, OPEN</p><h1>Make room<br /><em>for the good bits.</em></h1><p class="hero-intro">A flexible plan can help a day unfold. Start with the places you care about.</p><section class="itinerary-card"><div class="itinerary-top"><span class="itinerary-symbol" aria-hidden="true">▤</span><span class="mock-tag">MOCK PLAN</span></div><p class="eyebrow">A GENTLE START</p><h2>${escapeHtml(mockItinerary.title)}</h2><p>${escapeHtml(mockItinerary.note)}</p><ol>${mockItinerary.stops.map((stop) => `<li>${escapeHtml(stop)}</li>`).join("")}</ol><p class="source-note">Planning API is not available yet.</p></section></div>`;
  if (type === "social") return `<div class="page-wrap simple-page"><p class="eyebrow">TRAVEL, SHARED</p><h1>Stories make<br /><em>the map bigger.</em></h1><div class="empty-panel" role="status"><span class="empty-glyph" aria-hidden="true">◉</span><h2>Your circle starts here</h2><p>Shared trip notes will have a home here. Social features are a preview and aren't connected yet.</p><span class="mock-tag">PREVIEW</span></div></div>`;
  const savedPlaces = [...placeCache.entries()].flatMap(([cityId, rows]) => {
    const city = cities.find((item) => item.id === cityId);
    return rows.filter((row) => saved.has(String((row.place || row).id || (row.place || row).canonical_name || (row.place || row).name))).map((row) => ({ row, city }));
  });
  return `<div class="page-wrap simple-page"><p class="eyebrow">KEEP WHAT CALLS TO YOU</p><h1>A little list<br /><em>of your own.</em></h1>${savedPlaces.length ? `<div class="saved-list">${savedPlaces.map(({ row, city }) => { const place = row.place || row; return `<a class="saved-card" href="#city/${encodeURIComponent(city?.id || "")}"><span class="place-glyph" aria-hidden="true">✳</span><span><span class="eyebrow">${escapeHtml(city?.name || "City")} ${dataLabel()}</span><strong>${escapeHtml(place.canonical_name || place.name || "Unnamed place")}</strong></span><span class="saved-heart" aria-hidden="true">♥</span></a>`; }).join("")}</div>` : `<div class="empty-panel" role="status"><span class="empty-glyph" aria-hidden="true">♡</span><h2>Nothing saved yet</h2><p>Save a landmark from a city guide and it will be ready to find here.</p><a class="text-link" href="#home">Explore city guides <span aria-hidden="true">→</span></a></div>`}</div>`;
}

function statusView(title, description, action = "Try again") {
  return `<section class="page-wrap empty-panel" role="${title.includes("could not") ? "alert" : "status"}"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p><button class="quiet-button" data-retry>${escapeHtml(action)}</button></section>`;
}

async function loadCityPlaces(city) {
  if (placeCache.has(city.id)) return placeCache.get(city.id);
  if (source === "mock") {
    const sample = mockByName.get(city.name.toLocaleLowerCase());
    const rows = (sample?.attractions || []).map((place) => ({ place: { ...place, canonical_name: place.name } }));
    placeCache.set(city.id, rows);
    return rows;
  }
  if (!client) throw new Error("The API base URL is not configured.");
  try {
    const rows = await client.listPlaces(city.id);
    placeCache.set(city.id, rows);
    return rows;
  } catch (error) {
    if (runtimeConfig.developmentMode) {
      source = "mock";
      placeCache.clear();
      return loadCityPlaces(city);
    }
    throw error;
  }
}

async function loadCities() {
  if (!client) {
    if (runtimeConfig.developmentMode) {
      source = "mock";
      cities = mockCities;
      citiesLoaded = true;
      return;
    }
    throw new Error("Set LOCALISE_CONFIG.apiBaseUrl to connect the public API. Mock data is available only in development mode.");
  }
  try {
    cities = await client.listCities();
    if (cities.some((city) => !city || typeof city.id !== "string" || typeof city.name !== "string")) {
      throw new Error("The API returned city records in an unexpected format.");
    }
    source = "api";
    citiesLoaded = true;
  } catch (error) {
    if (runtimeConfig.developmentMode) {
      source = "mock";
      cities = mockCities;
      citiesLoaded = true;
      cityLoadError = `API unavailable; showing mock development guides. ${error.message}`;
      return;
    }
    throw error;
  }
}

async function render() {
  const currentRequest = ++requestNumber;
  const view = getView(window.location.hash, cities);
  main.setAttribute("aria-busy", "true");
  try {
    if (!citiesLoaded && !cityLoadError) {
      main.innerHTML = '<div class="loading-state" role="status"><span class="loading-mark" aria-hidden="true">✳</span><span>Opening your city notes…</span></div>';
      await loadCities();
    }
    if (currentRequest !== requestNumber) return;
    const activeView = getView(window.location.hash, cities);
    if (activeView.type === "city") {
      const rows = placeCache.get(activeView.city.id);
      if (!rows) {
        main.innerHTML = '<div class="loading-state" role="status"><span class="loading-mark" aria-hidden="true">✳</span><span>Loading approved places…</span></div>';
        const loaded = await loadCityPlaces(activeView.city);
        if (currentRequest !== requestNumber) return;
        main.innerHTML = cityView(activeView.city, loaded);
      } else main.innerHTML = cityView(activeView.city, rows);
    } else if (activeView.type === "home") {
      main.innerHTML = homeView();
      if (cityLoadError) main.insertAdjacentHTML("afterbegin", `<p class="page-wrap source-note" role="status">${escapeHtml(cityLoadError)}</p>`);
    } else if (activeView.type === "not-found") main.innerHTML = `<div class="page-wrap simple-page"><h1>That page wandered off.</h1><a class="text-link" href="#home">Back to city guides →</a></div>`;
    else main.innerHTML = simpleView(activeView.type);
    navLinks.forEach((link) => {
      const active = link.dataset.nav === activeView.type || (activeView.type === "city" && link.dataset.nav === "home");
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    });
    document.title = activeView.type === "city" ? `${activeView.city.name} — Localise` : `${activeView.type[0].toUpperCase()}${activeView.type.slice(1)} — Localise`;
  } catch (error) {
    if (currentRequest !== requestNumber) return;
    const activeView = getView(window.location.hash, cities);
    main.innerHTML = statusView(activeView.type === "city" ? "Places could not be loaded." : "City guides could not be loaded.", error.message);
  } finally {
    if (currentRequest === requestNumber) main.setAttribute("aria-busy", "false");
  }
  bindControls();
}

function bindControls() {
  document.querySelector("#city-search")?.addEventListener("input", (event) => {
    query = event.target.value;
    const grid = document.querySelector("#city-grid");
    if (grid) {
      grid.innerHTML = cityGridMarkup();
      grid.querySelector("[data-clear-search]")?.addEventListener("click", () => {
        query = "";
        const input = document.querySelector("#city-search");
        if (input) input.value = "";
        grid.innerHTML = cityGridMarkup();
        input?.focus();
      });
    }
  });
  document.querySelectorAll("[data-clear-search]").forEach((button) => button.addEventListener("click", () => {
    query = "";
    const input = document.querySelector("#city-search");
    if (input) input.value = "";
    const grid = document.querySelector("#city-grid");
    if (grid) grid.innerHTML = cityGridMarkup();
    input?.focus();
  }));
  document.querySelectorAll("[data-save]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.save;
    if (saved.has(id)) saved.delete(id); else saved.add(id);
    render();
  }));
  document.querySelectorAll("[data-category-filter]").forEach((button) => button.addEventListener("click", () => {
    selectedCategory = button.dataset.categoryFilter;
    render();
    requestAnimationFrame(() => document.querySelector(`[data-category-filter="${selectedCategory}"]`)?.focus());
  }));
  document.querySelectorAll("[data-retry]").forEach((button) => button.addEventListener("click", () => {
    placeCache.clear();
    cityLoadError = "";
    cities = [];
    citiesLoaded = false;
    render();
  }));
}

window.addEventListener("hashchange", render);
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (getView(window.location.hash, cities).type !== "home") window.location.hash = "#home";
    requestAnimationFrame(() => document.querySelector("#city-search")?.focus());
  }
});
render();
