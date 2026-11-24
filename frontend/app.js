import { filterCities, getView, mockCities, mockItinerary } from "./data.js";

const main = document.querySelector("#main-content");
const navLinks = [...document.querySelectorAll("[data-nav]")];
const saved = new Set();
let query = "";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function cityCard(city, index) {
  return `<a class="city-card card-${index}" href="#city/${city.id}" aria-label="Explore ${escapeHtml(city.name)}, mock guide">
    <div class="city-art ${city.color}" aria-hidden="true"><span class="art-orbit orbit-one"></span><span class="art-orbit orbit-two"></span><span class="art-letter">${city.name.slice(0, 1)}</span><span class="art-caption">FIELD NOTES&nbsp; / &nbsp;0${index + 1}</span></div>
    <div class="city-card-copy"><div class="eyebrow">${escapeHtml(city.region)} <span class="mock-tag">MOCK GUIDE</span></div><h3>${escapeHtml(city.name)}</h3><p>${escapeHtml(city.intro)}</p><span class="text-link">Open city guide <span aria-hidden="true">↗</span></span></div>
  </a>`;
}

function cityGridMarkup() {
  const cities = filterCities(query);
  return cities.length ? cities.map(cityCard).join("") : `<div class="empty-state" role="status"><span class="empty-glyph" aria-hidden="true">⌕</span><h3>No sample cities found</h3><p>Try another spelling or clear the search.</p><button class="quiet-button" data-clear-search>Clear search</button></div>`;
}

function homeView() {
  return `<div class="page-wrap">
    <section class="home-hero" aria-labelledby="page-title"><div class="hero-copy"><p class="eyebrow"><span class="sun-mark" aria-hidden="true">✳</span> A MORE HUMAN WAY TO EXPLORE</p><h1 id="page-title">Find your way<br /><em>into a place.</em></h1><p class="hero-intro">Thoughtful city guides, gentle plans, and the little details that make a trip yours.</p><label class="search-box"><span aria-hidden="true">⌕</span><span class="sr-only">Search sample city guides</span><input id="city-search" type="search" placeholder="Try a city name" value="${escapeHtml(query)}" autocomplete="off" /><kbd>⌘ K</kbd></label><p class="data-note"><span aria-hidden="true">◌</span> Preview edition · sample content, not verified travel data</p></div><div class="hero-art" aria-hidden="true"><div class="sun-disc"></div><div class="arch arch-back"></div><div class="arch arch-front"><span></span></div><div class="hero-art-label">A PLACE<br />TAKES SHAPE</div><div class="hero-side-note">01 — 02<br />CITY NOTES</div></div></section>
    <section class="section-block city-section" aria-labelledby="cities-title"><div class="section-heading"><div><p class="eyebrow">START SOMEWHERE</p><h2 id="cities-title">A city, at a glance<span class="period">.</span></h2></div><a class="text-link all-cities" href="#home">Browse all <span aria-hidden="true">→</span></a></div><div class="city-grid" id="city-grid" aria-live="polite">${cityGridMarkup()}</div></section>
    <section class="quiet-banner"><span class="banner-mark" aria-hidden="true">✳</span><div><p class="eyebrow">MADE FOR THE WAY YOU TRAVEL</p><p>Good trips leave space for a little surprise.</p></div><span class="banner-arrow" aria-hidden="true">↗</span></section>
    <footer class="site-footer"><span>LOCALISE <span class="footer-dot">·</span> A PERSONAL CITY GUIDE</span><span>Preview edition <span aria-hidden="true">✳</span></span></footer>
  </div>`;
}

function cityView(city) {
  const savedCities = city.attractions.map((place) => `<article class="place-card"><div class="place-glyph" aria-hidden="true">${place.icon}</div><div class="place-copy"><p class="eyebrow">${escapeHtml(place.category)}</p><h3>${escapeHtml(place.name)}</h3><p>${escapeHtml(place.note)}</p></div><button class="save-button ${saved.has(place.id) ? "is-saved" : ""}" data-save="${escapeHtml(place.id)}" aria-label="${saved.has(place.id) ? "Remove" : "Save"} ${escapeHtml(place.name)}" aria-pressed="${saved.has(place.id)}">${saved.has(place.id) ? "♥" : "♡"}</button></article>`).join("");
  return `<div class="page-wrap city-page"><a class="back-link" href="#home"><span aria-hidden="true">←</span> All cities</a><section class="city-header ${city.color}"><div class="city-header-copy"><p class="eyebrow">${escapeHtml(city.region)} <span class="mock-tag">MOCK GUIDE</span></p><h1>${escapeHtml(city.name)}<span class="period">.</span></h1><p>${escapeHtml(city.intro)}</p></div><div class="city-header-art" aria-hidden="true"><span>${city.name.slice(0, 1)}</span><small>LOCALISE<br />FIELD NOTES</small></div></section>
    <div class="city-content"><section class="history-panel" aria-labelledby="history-title"><div class="history-icon" aria-hidden="true">✳</div><div><p class="eyebrow">A SENSE OF PLACE <span class="mock-tag">MOCK COPY</span></p><h2 id="history-title">The story so far</h2><p>${escapeHtml(city.history)}</p><span class="source-note">Sources and attribution will appear when this guide is verified.</span></div></section>
    <section class="section-block" aria-labelledby="attractions-title"><div class="section-heading"><div><p class="eyebrow">WORTH A CLOSER LOOK</p><h2 id="attractions-title">Landmarks & places<span class="period">.</span></h2></div><span class="count-label">${String(city.attractions.length).padStart(2, "0")} PLACES</span></div><div class="place-list">${savedCities}</div></section>
    <div class="city-columns"><section class="mini-section" aria-labelledby="food-title"><p class="eyebrow">TASTE THE CITY</p><h2 id="food-title">Food & drink</h2>${city.restaurants.map((item) => `<article class="mini-card"><span class="mini-icon" aria-hidden="true">◒</span><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.note)}</p></div></article>`).join("")}</section><section class="mini-section" aria-labelledby="stay-title"><p class="eyebrow">A PLACE TO LAND</p><h2 id="stay-title">Places to stay</h2>${city.stays.map((item) => `<article class="mini-card"><span class="mini-icon" aria-hidden="true">⌂</span><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.note)}</p></div></article>`).join("")}</section></div></div></div>`;
}

function simpleView(type) {
  if (type === "itineraries") return `<div class="page-wrap simple-page"><p class="eyebrow">YOUR DAYS, OPEN</p><h1>Make room<br /><em>for the good bits.</em></h1><p class="hero-intro">A flexible plan can help a day unfold. Start with the places you care about.</p><section class="itinerary-card"><div class="itinerary-top"><span class="itinerary-symbol" aria-hidden="true">▤</span><span class="mock-tag">MOCK PLAN</span></div><p class="eyebrow">A GENTLE START</p><h2>${mockItinerary.title}</h2><p>${mockItinerary.note}</p><ol>${mockItinerary.stops.map((stop) => `<li>${escapeHtml(stop)}</li>`).join("")}</ol><a class="primary-link" href="#city/hyderabad">Choose a sample city <span aria-hidden="true">→</span></a></section></div>`;
  if (type === "social") return `<div class="page-wrap simple-page"><p class="eyebrow">TRAVEL, SHARED</p><h1>Stories make<br /><em>the map bigger.</em></h1><div class="empty-panel" role="status"><span class="empty-glyph" aria-hidden="true">◎</span><h2>Your circle starts here</h2><p>Shared trip notes will have a home here. Social features are a preview and aren't connected yet.</p><span class="mock-tag">PREVIEW</span></div></div>`;
  const savedPlaces = mockCities.flatMap((city) => city.attractions.filter((place) => saved.has(place.id)).map((place) => ({ ...place, city })));
  return `<div class="page-wrap simple-page"><p class="eyebrow">KEEP WHAT CALLS TO YOU</p><h1>A little list<br /><em>of your own.</em></h1>${savedPlaces.length ? `<div class="saved-list">${savedPlaces.map(({ city, ...place }) => `<a class="saved-card" href="#city/${city.id}"><span class="place-glyph" aria-hidden="true">${place.icon}</span><span><span class="eyebrow">${escapeHtml(city.name)} · MOCK</span><strong>${escapeHtml(place.name)}</strong></span><span class="saved-heart" aria-hidden="true">♥</span></a>`).join("")}</div>` : `<div class="empty-panel" role="status"><span class="empty-glyph" aria-hidden="true">♡</span><h2>Nothing saved yet</h2><p>Save a landmark from a sample city guide and it will be ready to find here.</p><a class="text-link" href="#home">Explore city guides <span aria-hidden="true">→</span></a></div>`}</div>`;
}

function render() {
  const view = getView(window.location.hash);
  try {
    main.innerHTML = view.type === "home" ? homeView() : view.type === "city" ? cityView(view.city) : view.type === "not-found" ? `<div class="page-wrap simple-page"><h1>That page wandered off.</h1><a class="text-link" href="#home">Back to city guides →</a></div>` : simpleView(view.type);
  } catch {
    main.innerHTML = `<section class="page-wrap empty-panel" role="alert"><h1>This guide could not be shown.</h1><p>Please try opening the page again.</p><a class="text-link" href="#home">Return home</a></section>`;
  }
  main.setAttribute("aria-busy", "false");
  navLinks.forEach((link) => {
    const active = link.dataset.nav === view.type || (view.type === "city" && link.dataset.nav === "home");
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  document.title = view.type === "city" ? `${view.city.name} — Localise` : `${view.type[0].toUpperCase()}${view.type.slice(1)} — Localise`;
  const search = document.querySelector("#city-search");
  search?.addEventListener("input", (event) => {
    query = event.target.value;
    const grid = document.querySelector("#city-grid");
    if (!grid) return;
    grid.innerHTML = cityGridMarkup();
    grid.querySelector("[data-clear-search]")?.addEventListener("click", () => {
      query = "";
      search.value = "";
      grid.innerHTML = cityGridMarkup();
    });
  });
  document.querySelector("[data-clear-search]")?.addEventListener("click", () => {
    query = "";
    const grid = document.querySelector("#city-grid");
    const currentSearch = document.querySelector("#city-search");
    if (currentSearch) currentSearch.value = "";
    if (grid) grid.innerHTML = cityGridMarkup();
    document.querySelector("#city-search")?.focus();
  });
  document.querySelectorAll("[data-save]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.save;
    if (saved.has(id)) saved.delete(id); else saved.add(id);
    render();
  }));
}

window.addEventListener("hashchange", render);
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (getView(window.location.hash).type !== "home") window.location.hash = "#home";
    requestAnimationFrame(() => document.querySelector("#city-search")?.focus());
  }
});
render();
