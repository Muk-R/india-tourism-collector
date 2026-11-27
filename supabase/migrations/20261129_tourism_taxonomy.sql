-- Versioned OSM taxonomy materialized inside protected source provenance.
-- The public Worker projects only the approved category/facet arrays; raw tags
-- and exclusion reasons remain in the private source payload/staging layer.
begin;

create or replace function public.classify_osm_tourism_tags(
  p_tags jsonb,
  p_place_category text,
  p_importance_score integer default 0,
  p_wikidata_id text default null
) returns jsonb
language plpgsql immutable
set search_path = pg_catalog, public
as $$
declare
  v_categories text[] := array[]::text[];
  v_food_facets text[] := array[]::text[];
  v_exclusions text[] := array[]::text[];
  v_category text := lower(coalesce(p_place_category, ''));
  v_residential boolean := coalesce(p_tags->>'landuse' = 'residential', false)
    or lower(coalesce(p_tags->>'building','')) in ('apartments','residential','house','residential_building');
  v_significant boolean := coalesce(p_importance_score,0) > 0 or nullif(p_wikidata_id,'') is not null or nullif(p_tags->>'wikidata','') is not null;
  v_tourism text := lower(coalesce(p_tags->>'tourism',''));
  v_amenity text := lower(coalesce(p_tags->>'amenity',''));
  v_shop text := lower(coalesce(p_tags->>'shop',''));
  v_leisure text := lower(coalesce(p_tags->>'leisure',''));
  v_historic text := lower(coalesce(p_tags->>'historic',''));
  v_natural text := lower(coalesce(p_tags->>'natural',''));
  v_food boolean := v_category in ('food','restaurant','cafe')
    or v_amenity in ('restaurant','cafe','fast_food','food_court','ice_cream','pub','bar','canteen','biergarten')
    or v_shop in ('bakery','confectionery','pastry','deli','street_food');
  v_eligible boolean;
  v_food_value text;
begin
  if jsonb_typeof(coalesce(p_tags,'{}'::jsonb)) <> 'object' then
    raise exception 'OSM tags must be a JSON object';
  end if;

  if (v_natural = 'water' and lower(coalesce(p_tags->>'water','')) in ('lake','reservoir','pond'))
     or lower(coalesce(p_tags->>'landuse','')) = 'reservoir' then v_categories := array_append(v_categories,'lakes'); end if;
  if v_shop = 'mall' then v_categories := array_append(v_categories,'shopping_malls'); end if;
  if v_tourism = 'theme_park' or v_leisure in ('water_park','amusement_park','amusement_arcade') then v_categories := array_append(v_categories,'leisure_entertainment'); end if;
  if v_leisure = 'adventure_park' or lower(coalesce(p_tags->>'adventure','')) = 'yes' then v_categories := array_append(v_categories,'adventure'); end if;
  if v_tourism = 'museum' then v_categories := array_append(v_categories,'museums'); end if;
  if v_amenity = 'marketplace' or v_shop = 'marketplace' then v_categories := array_append(v_categories,'local_shopping_markets'); end if;
  if v_amenity = 'place_of_worship' or nullif(p_tags->>'religion','') is not null then v_categories := array_append(v_categories,'religious'); end if;
  if nullif(p_tags->>'historic','') is not null or nullif(p_tags->>'heritage','') is not null then v_categories := array_append(v_categories,'heritage'); end if;
  if v_tourism = 'attraction' and cardinality(v_categories) = 0 then v_categories := array_append(v_categories,'heritage'); end if;
  if v_leisure in ('park','garden','nature_reserve') then v_categories := array_append(v_categories,'parks_gardens'); end if;
  if v_natural in ('peak','waterfall','beach','cave_entrance','viewpoint') then v_categories := array_append(v_categories,'nature'); end if;
  if v_natural = 'viewpoint' or v_tourism = 'viewpoint' or nullif(p_tags->>'viewpoint','') is not null then v_categories := array_append(v_categories,'scenic_spots'); end if;
  if v_tourism = 'zoo' or v_leisure = 'nature_reserve' then v_categories := array_append(v_categories,'wildlife'); end if;
  if v_tourism in ('artwork','gallery') or v_amenity = 'arts_centre' then v_categories := array_append(v_categories,'arts_culture'); end if;

  if v_food then
    v_categories := array_append(v_categories,'food');
    if nullif(p_tags->>'cuisine','') is not null then
      v_food_value := 'cuisine:' || replace(lower(regexp_replace(trim(p_tags->>'cuisine'), '\s*;\s*', '|', 'g')),' ','_');
      v_food_facets := array_append(v_food_facets,v_food_value);
    end if;
    if p_tags->>'diet:vegetarian' = 'only' then v_food_facets := array_append(v_food_facets,'diet:pure_vegetarian');
    elsif p_tags->>'diet:vegetarian' = 'yes' then v_food_facets := array_append(v_food_facets,'diet:vegetarian_options'); end if;
    if p_tags->>'diet:non-vegetarian' = 'yes' or p_tags->>'diet:meat' = 'yes' then v_food_facets := array_append(v_food_facets,'diet:non_vegetarian'); end if;
    if p_tags->>'diet:vegan' = 'only' then v_food_facets := array_append(v_food_facets,'diet:vegan'); end if;
    if p_tags->>'diet:jain' in ('yes','only') then v_food_facets := array_append(v_food_facets,'diet:jain'); end if;
    if p_tags->>'diet:halal' in ('yes','only') then v_food_facets := array_append(v_food_facets,'diet:halal'); end if;
    foreach v_food_value in array string_to_array(coalesce(p_tags->>'meal',''),';') loop
      if trim(v_food_value) <> '' then v_food_facets := array_append(v_food_facets,'meal:' || lower(trim(v_food_value))); end if;
    end loop;
    if v_amenity in ('restaurant','cafe','fast_food','food_court','ice_cream','pub','bar','canteen','biergarten') then v_food_facets := array_append(v_food_facets,'establishment:' || v_amenity); end if;
    if v_shop in ('bakery','confectionery','pastry','deli','street_food') then v_food_facets := array_append(v_food_facets,'establishment:' || v_shop); end if;
  end if;

  if v_tourism in ('hotel','hostel','guest_house','motel','camp_site','alpine_hut','chalet','caravan_site') then
    v_categories := array_append(v_categories,'accommodation');
  elsif v_category = 'accommodation' and (v_residential or v_tourism = 'apartment') then
    v_exclusions := array_append(v_exclusions,'unverified_tourist_apartment');
  end if;

  if v_residential and v_tourism not in ('hotel','hostel','guest_house','motel','camp_site','alpine_hut','chalet','caravan_site') then
    v_exclusions := array_append(v_exclusions,'residential_property');
  end if;
  if (v_historic = 'memorial' or lower(coalesce(p_tags->>'memorial','')) = 'statue') and not v_significant then
    v_exclusions := array_append(v_exclusions,'minor_memorial_without_tourism_evidence');
  end if;
  v_categories := array(select distinct item from unnest(v_categories) item order by item);
  v_food_facets := array(select distinct item from unnest(v_food_facets) item order by item);
  v_exclusions := array(select distinct item from unnest(v_exclusions) item order by item);
  v_eligible := cardinality(v_categories) > 0 and cardinality(v_exclusions) = 0;
  return jsonb_build_object(
    'version',1,
    'categories',to_jsonb(v_categories),
    'foodFacets',to_jsonb(v_food_facets),
    'exclusionReasons',to_jsonb(v_exclusions),
    'recommendationEligible',v_eligible
  );
end;
$$;

revoke all on function public.classify_osm_tourism_tags(jsonb,text,integer,text) from public, anon, authenticated;
grant execute on function public.classify_osm_tourism_tags(jsonb,text,integer,text) to service_role;

create or replace function public.attach_offline_tourism_taxonomy()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_tags jsonb;
  v_category text;
  v_importance integer;
  v_wikidata text;
  v_taxonomy jsonb;
begin
  select stage.raw_tags, place.category, place.importance_score, place.wikidata_id
    into v_tags, v_category, v_importance, v_wikidata
  from public.offline_pbf_stage_rows stage
  join public.tourism_places place on place.id = new.place_id
  where stage.id = new.stage_row_id;
  if not found then return new; end if;
  v_taxonomy := public.classify_osm_tourism_tags(v_tags,v_category,v_importance,v_wikidata);
  update public.tourism_place_sources
  set payload = payload || jsonb_build_object('localise_taxonomy',v_taxonomy)
  where place_id = new.place_id and source_name = 'openstreetmap' and source_id = new.source_key;
  return new;
end;
$$;

revoke all on function public.attach_offline_tourism_taxonomy() from public, anon, authenticated;
grant execute on function public.attach_offline_tourism_taxonomy() to service_role;

drop trigger if exists offline_pbf_publication_taxonomy on public.offline_pbf_publication_items;
create trigger offline_pbf_publication_taxonomy
after insert on public.offline_pbf_publication_items
for each row execute function public.attach_offline_tourism_taxonomy();

-- Backfill only already-published OSM identities; staging and quarantined rows
-- stay private and unchanged. The function is also triggered for later batches.
update public.tourism_place_sources source
set payload = source.payload || jsonb_build_object(
  'localise_taxonomy',
  public.classify_osm_tourism_tags(stage.raw_tags,place.category,place.importance_score,place.wikidata_id)
)
from public.offline_pbf_publication_items item
join public.offline_pbf_stage_rows stage on stage.id = item.stage_row_id
join public.tourism_places place on place.id = item.place_id
where source.place_id = item.place_id
  and source.source_name = 'openstreetmap'
  and source.source_id = item.source_key;

commit;
