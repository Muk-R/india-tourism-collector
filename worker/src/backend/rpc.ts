/** Typed boundary for the PostgREST RPCs used by the collection Worker.
 *
 * Keep these names, `p_*` argument keys, and result shapes aligned with
 * supabase/migrations/20261124_collection_cycles.sql. The transport is injected
 * so callers can use the existing authenticated PostgREST client or a test
 * double without coupling this module to Worker environment bindings.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type SourceName = "openstreetmap" | "wikidata";
export type CycleStatus =
  | "pending"
  | "processing"
  | "retry_wait"
  | "ready_to_finalize"
  | "partial"
  | "completed"
  | "failed"
  | "exhausted"
  | "legacy_review"
  | "superseded";
export type SourceStatus =
  | "pending"
  | "processing"
  | "retry_wait"
  | "completed"
  | "exhausted"
  | "truncated"
  | "superseded";
export type ItemStatus = "pending" | "processing" | "completed" | "failed" | "exhausted" | "superseded";

export interface CycleClaim {
  cycle_id: string;
  city_id: string;
  radius_km: number;
  lease_token: string;
  lease_expires_at: string;
  cycle_status: CycleStatus;
}

export interface CycleSource {
  cycle_id: string;
  source_name: SourceName;
  status: SourceStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  cursor: Json | null;
  pages_completed: number;
  items_discovered: number;
  is_complete: boolean;
  last_attempt_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface CycleItem {
  id: string;
  cycle_id: string;
  source_name: SourceName;
  source_id: string;
  raw_payload: Json;
  status: ItemStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  priority_score: number;
  priority_reasons: string[];
  last_error: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface SourcePageResult {
  page_applied: boolean;
  cursor_after: Json | null;
  source_complete: boolean;
}

export interface DiscoveredItem {
  source_id: string;
  raw_payload: Json;
  priority_score?: number;
  priority_reasons?: string[];
}

export interface SourceAttributionInput {
  source_name: SourceName;
  source_id: string;
  source_url?: string | null;
  attribution?: string | null;
  license?: string | null;
  payload?: Json;
}

export interface WikipediaAttributionInput {
  source_id: string;
  source_url?: string | null;
  attribution?: string | null;
  license?: string | null;
  payload?: Json;
}

export interface PlaceInput {
  canonical_name: string;
  latitude: number;
  longitude: number;
  category?: string | null;
  subcategory?: string | null;
  address?: string | null;
  description?: string | null;
  description_source?: string | null;
  description_license?: string | null;
  website_url?: string | null;
  phone?: string | null;
  wikipedia_url?: string | null;
  wikidata_id?: string | null;
  osm_type?: string | null;
  osm_id?: number | null;
  image_url?: string | null;
  image_source_url?: string | null;
  image_author?: string | null;
  image_license?: string | null;
  quality_score?: number;
  importance_score?: number;
  [key: string]: Json | undefined;
}

export interface RpcContracts {
  claim_tourism_collection_cycle: {
    args: {
      p_city_id: string;
      p_radius_km: number | null;
      p_rediscover: boolean;
      p_confirm_legacy_radius: boolean;
      p_lease_seconds: number;
      p_reconcile_links: boolean;
    };
    result: CycleClaim[];
  };
  claim_next_tourism_collection_cycle: {
    args: { p_lease_seconds: number };
    result: CycleClaim[];
  };
  claim_tourism_cycle_source: {
    args: { p_cycle_id: string; p_city_lease_token: string; p_source_name: SourceName; p_lease_seconds: number };
    result: CycleSource[];
  };
  persist_tourism_cycle_source_page: {
    args: {
      p_cycle_id: string;
      p_city_lease_token: string;
      p_source_name: SourceName;
      p_source_lease_token: string;
      p_page_key: string;
      p_expected_cursor: Json | null;
      p_next_cursor: Json | null;
      p_items: DiscoveredItem[];
      p_is_complete: boolean;
    };
    result: SourcePageResult[];
  };
  fail_tourism_cycle_source: {
    args: { p_cycle_id: string; p_city_lease_token: string; p_source_name: SourceName; p_source_lease_token: string; p_error: string };
    result: "retry_wait" | "exhausted";
  };
  claim_tourism_cycle_items: {
    args: { p_cycle_id: string; p_city_lease_token: string; p_limit: number; p_lease_seconds: number };
    result: CycleItem[];
  };
  renew_tourism_collection_lease: {
    args: {
      p_cycle_id: string;
      p_city_lease_token: string;
      p_lease_seconds: number;
      p_source_name: SourceName | null;
      p_source_lease_token: string | null;
      p_item_id: string | null;
      p_item_lease_token: string | null;
    };
    result: string;
  };
  release_tourism_cycle_source: {
    args: { p_cycle_id: string; p_city_lease_token: string; p_source_name: SourceName; p_source_lease_token: string };
    result: SourceStatus;
  };
  release_tourism_collection_city_lease: {
    args: { p_cycle_id: string; p_city_lease_token: string };
    result: boolean;
  };
  upsert_tourism_place_for_cycle: {
    args: {
      p_cycle_id: string;
      p_city_lease_token: string;
      p_item_id: string;
      p_item_lease_token: string;
      p_place: PlaceInput;
      p_source: SourceAttributionInput;
      p_wikipedia_source: WikipediaAttributionInput | null;
    };
    result: string;
  };
  fail_tourism_cycle_item: {
    args: { p_cycle_id: string; p_city_lease_token: string; p_item_id: string; p_item_lease_token: string; p_error: string };
    result: "failed" | "exhausted";
  };
  finish_tourism_collection_cycle: {
    args: { p_cycle_id: string; p_city_lease_token: string };
    result: number;
  };
}

export type RpcName = keyof RpcContracts;
export type RpcArgs<Name extends RpcName> = RpcContracts[Name]["args"];
export type RpcResult<Name extends RpcName> = RpcContracts[Name]["result"];

export interface BackendRpcTransport {
  rpc<Name extends RpcName>(name: Name, args: RpcArgs<Name>): Promise<RpcResult<Name>>;
}

/** Thin adapter: preserve PostgREST's scalar, set-returning, and table result shapes. */
export function createBackendPersistence(transport: BackendRpcTransport) {
  return {
    claimCityCycle: (args: RpcArgs<"claim_tourism_collection_cycle">) =>
      transport.rpc("claim_tourism_collection_cycle", args),
    claimNextCityCycle: (args: RpcArgs<"claim_next_tourism_collection_cycle">) =>
      transport.rpc("claim_next_tourism_collection_cycle", args),
    claimSource: (args: RpcArgs<"claim_tourism_cycle_source">) =>
      transport.rpc("claim_tourism_cycle_source", args),
    persistSourcePage: (args: RpcArgs<"persist_tourism_cycle_source_page">) =>
      transport.rpc("persist_tourism_cycle_source_page", args),
    failSource: (args: RpcArgs<"fail_tourism_cycle_source">) =>
      transport.rpc("fail_tourism_cycle_source", args),
    claimItems: (args: RpcArgs<"claim_tourism_cycle_items">) =>
      transport.rpc("claim_tourism_cycle_items", args),
    renewLease: (args: RpcArgs<"renew_tourism_collection_lease">) =>
      transport.rpc("renew_tourism_collection_lease", args),
    releaseSource: (args: RpcArgs<"release_tourism_cycle_source">) =>
      transport.rpc("release_tourism_cycle_source", args),
    releaseCityLease: (args: RpcArgs<"release_tourism_collection_city_lease">) =>
      transport.rpc("release_tourism_collection_city_lease", args),
    upsertPlaceForCycle: (args: RpcArgs<"upsert_tourism_place_for_cycle">) =>
      transport.rpc("upsert_tourism_place_for_cycle", args),
    failItem: (args: RpcArgs<"fail_tourism_cycle_item">) =>
      transport.rpc("fail_tourism_cycle_item", args),
    finishCycle: (args: RpcArgs<"finish_tourism_collection_cycle">) =>
      transport.rpc("finish_tourism_collection_cycle", args),
  };
}

/** API-facing contract: omission uses the existing 40 km default. */
export function parseCollectionRadius(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("radiusKm must be a whole number from 10 through 150.");
  const radius = Number(value);
  if (!Number.isInteger(radius) || radius < 10 || radius > 150) {
    throw new Error("radiusKm must be a whole number from 10 through 150.");
  }
  return radius;
}

export function defaultCollectionRadius(configured: string | undefined, cityRadius: number | undefined): number {
  if (Number.isInteger(cityRadius) && cityRadius! >= 10 && cityRadius! <= 150) return cityRadius!;
  const radius = Number(configured);
  return Number.isInteger(radius) && radius >= 10 && radius <= 150 ? radius : 40;
}
