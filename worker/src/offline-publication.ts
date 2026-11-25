const ALLOWED_CATEGORIES = new Set(["attraction", "food", "accommodation", "transport"]);
const SOURCE_KEY = /^(node|way|relation)\/[1-9][0-9]{0,18}$/;
const IDP_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{15,159}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BrowseApproval = {
  source_key: string;
  category: string;
  decision: "approve_browse_only";
  importance_score: number;
  importance_rationale: string;
  importance_source_url: string;
  historical_summary?: string;
  historical_summary_source_url?: string;
  historical_summary_license?: string;
};

export type PromotionRequest = {
  idempotency_key: string;
  snapshot_id: string;
  city_id: string;
  approval_reference: string;
  records: BrowseApproval[];
};

type Validation = { ok: true; value: PromotionRequest } | { ok: false; error: string };

function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

export function validatePromotionRequest(body: unknown): Validation {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Request body must be a JSON object." };
  const input = body as Record<string, unknown>;
  const envelopeKeys = new Set(["idempotency_key", "snapshot_id", "city_id", "approval_reference", "records"]);
  if (Object.keys(input).some((key) => !envelopeKeys.has(key))) return { ok: false, error: "Unexpected promotion request field." };
  if (typeof input.idempotency_key !== "string" || !IDP_KEY.test(input.idempotency_key)) {
    return { ok: false, error: "A 16–160 character idempotency_key is required." };
  }
  if (typeof input.snapshot_id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(input.snapshot_id)) {
    return { ok: false, error: "A SHA-256 snapshot_id is required." };
  }
  if (typeof input.city_id !== "string" || !UUID.test(input.city_id)) return { ok: false, error: "A valid city_id UUID is required." };
  if (typeof input.approval_reference !== "string" || input.approval_reference.trim().length < 8 || input.approval_reference.length > 200) {
    return { ok: false, error: "A release approval reference is required." };
  }
  if (!Array.isArray(input.records) || input.records.length < 1 || input.records.length > 100) {
    return { ok: false, error: "records must contain between 1 and 100 individually approved places." };
  }
  const seen = new Set<string>();
  const records: BrowseApproval[] = [];
  const allowedRecordKeys = new Set([
    "source_key", "category", "decision", "importance_score", "importance_rationale", "importance_source_url",
    "historical_summary", "historical_summary_source_url", "historical_summary_license",
  ]);
  for (const value of input.records) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Each approval must be a JSON object." };
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !allowedRecordKeys.has(key))) return { ok: false, error: "Unexpected place field; identity and coordinates are sourced from staging." };
    if (typeof record.source_key !== "string" || !SOURCE_KEY.test(record.source_key)) return { ok: false, error: "Each approval requires a valid OSM source_key." };
    if (seen.has(record.source_key)) return { ok: false, error: "Duplicate source_key in approval batch." };
    seen.add(record.source_key);
    if (typeof record.category !== "string" || !ALLOWED_CATEGORIES.has(record.category)) return { ok: false, error: "Each approval requires a supported primary category." };
    if (record.decision !== "approve_browse_only") return { ok: false, error: "Only explicit browse-only approvals are supported." };
    if (!Number.isInteger(record.importance_score) || Number(record.importance_score) < 0 || Number(record.importance_score) > 100) {
      return { ok: false, error: "importance_score must be an editorial ranking from 0 through 100; it is not a customer rating." };
    }
    if (typeof record.importance_rationale !== "string" || record.importance_rationale.trim().length < 8 || record.importance_rationale.length > 1000) {
      return { ok: false, error: "An evidence-based importance_rationale is required." };
    }
    if (!httpsUrl(record.importance_source_url)) return { ok: false, error: "importance_source_url must use HTTPS." };
    const summary = record.historical_summary;
    if (summary !== undefined && (typeof summary !== "string" || summary.trim().length < 20 || summary.length > 3000)) {
      return { ok: false, error: "historical_summary must be 20–3000 characters when provided." };
    }
    if (summary !== undefined && (!httpsUrl(record.historical_summary_source_url) || typeof record.historical_summary_license !== "string" || !record.historical_summary_license.trim() || record.historical_summary_license.length > 120)) {
      return { ok: false, error: "A summary source URL and explicit reuse license are required with historical_summary." };
    }
    if (summary === undefined && (record.historical_summary_source_url !== undefined || record.historical_summary_license !== undefined)) {
      return { ok: false, error: "Summary source and license cannot be supplied without a summary." };
    }
    records.push({
      source_key: record.source_key,
      category: record.category,
      decision: "approve_browse_only",
      importance_score: Number(record.importance_score),
      importance_rationale: record.importance_rationale.trim(),
      importance_source_url: record.importance_source_url,
      ...(typeof summary === "string" ? {
        historical_summary: summary.trim(),
        historical_summary_source_url: record.historical_summary_source_url as string,
        historical_summary_license: (record.historical_summary_license as string).trim(),
      } : {}),
    });
  }
  return { ok: true, value: {
    idempotency_key: input.idempotency_key,
    snapshot_id: input.snapshot_id,
    city_id: input.city_id,
    approval_reference: input.approval_reference.trim(),
    records,
  } };
}

export function validatePublicationRollback(body: unknown): { ok: true; value: { idempotency_key: string; rollback_reference: string } } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Request body must be a JSON object." };
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !new Set(["idempotency_key", "rollback_reference"]).has(key))) return { ok: false, error: "Unexpected rollback request field." };
  if (typeof value.idempotency_key !== "string" || !IDP_KEY.test(value.idempotency_key)) return { ok: false, error: "A valid publication idempotency_key is required." };
  if (typeof value.rollback_reference !== "string" || value.rollback_reference.trim().length < 8 || value.rollback_reference.length > 200) return { ok: false, error: "A rollback approval reference is required." };
  return { ok: true, value: { idempotency_key: value.idempotency_key, rollback_reference: value.rollback_reference.trim() } };
}
