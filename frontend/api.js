export function createApiClient({ apiBaseUrl, fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = String(apiBaseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("A public API base URL is required.");
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable.");

  async function get(path) {
    const response = await fetchImpl(`${baseUrl}${path}`, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      let detail = `Request failed (${response.status}).`;
      try {
        const body = await response.json();
        if (typeof body?.error === "string") detail = body.error;
      } catch { /* Keep the status message when the response has no JSON body. */ }
      throw new Error(detail);
    }
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error("The API returned an unexpected response.");
    return body;
  }

  return {
    listCities() {
      return get("/public/cities");
    },
    listPlaces(cityId) {
      const params = new URLSearchParams({ city_id: cityId, limit: "100" });
      return get(`/public/places?${params}`);
    },
  };
}
