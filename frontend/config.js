const supplied = globalThis.LOCALISE_CONFIG || {};

export const runtimeConfig = Object.freeze({
  apiBaseUrl: typeof supplied.apiBaseUrl === "string" ? supplied.apiBaseUrl.trim() : "",
  developmentMode: supplied.developmentMode === true,
});
