-- Attach an approved OSM source to one exact, pending Wikidata canonical place
-- instead of creating a duplicate when both sources identify the same entity.
-- Prior state is retained for a non-destructive audited rollback. pgcrypto is
-- installed in the non-default `extensions` schema on Supabase projects.
alter table public.offline_pbf_publication_items
  add column if not exists previous_record_state jsonb;
alter table public.offline_pbf_publication_items
  add column if not exists previous_link_state jsonb;

do $upgrade$
declare
  v_signature regprocedure := 'public.promote_offline_pbf_records(text,text,uuid,text,text,jsonb)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_old text;
  v_new text;
  v_changed text;
begin
  v_changed := replace(v_definition,
    '  v_link_state jsonb;',
    '  v_link_state jsonb;' || E'\n' ||
    '  v_previous_record_state jsonb;' || E'\n' ||
    '  v_previous_link_state jsonb;' || E'\n' ||
    '  v_link public.tourism_city_places%rowtype;');
  if v_changed = v_definition then raise exception 'Promotion function declaration seam not found'; end if;
  v_definition := v_changed;

  v_old := $old$
    if exists (select 1 from public.tourism_places p where p.osm_type=v_stage.source_type and p.osm_id=v_stage.source_id)
       or (v_wikidata_id is not null and exists (select 1 from public.tourism_places p where p.wikidata_id=v_wikidata_id))
       or exists (select 1 from public.tourism_place_sources s where s.source_name='openstreetmap' and s.source_id=v_source_key) then
      raise exception 'Source identity conflicts with an existing canonical place and requires manual reconciliation: %', v_source_key;
    end if;
$old$;
  v_new := $new$
    if exists (select 1 from public.tourism_places p where p.osm_type=v_stage.source_type and p.osm_id=v_stage.source_id)
       or exists (select 1 from public.tourism_place_sources s where s.source_name='openstreetmap' and s.source_id=v_source_key) then
      raise exception 'OSM source identity already exists and requires manual reconciliation: %', v_source_key;
    end if;
    v_previous_record_state := null;
    v_previous_link_state := null;
    v_place := null;
    if v_wikidata_id is not null then
      if (select count(*) from public.tourism_places p where p.wikidata_id=v_wikidata_id) > 1 then
        raise exception 'Wikidata identity maps to multiple canonical places: %', v_wikidata_id;
      end if;
      select * into v_place from public.tourism_places p where p.wikidata_id=v_wikidata_id for update;
      if found then
        if v_place.category not in ('attraction','wikidata_attraction')
           or v_place.review_status <> 'pending' or not v_place.is_active
           or not exists (select 1 from public.tourism_place_sources s
                          where s.place_id=v_place.id and s.source_name='wikidata' and s.source_id=v_wikidata_id) then
          raise exception 'Existing Wikidata canonical place is not eligible for exact-source reconciliation: %', v_source_key;
        end if;
        v_previous_record_state := jsonb_build_object(
          'canonical_name',v_place.canonical_name,'category',v_place.category,'subcategory',v_place.subcategory,
          'latitude',v_place.latitude,'longitude',v_place.longitude,'description',v_place.description,
          'description_source',v_place.description_source,'description_license',v_place.description_license,
          'importance_score',v_place.importance_score,'review_status',v_place.review_status,
          'is_active',v_place.is_active,'route_ready',v_place.route_ready,'updated_at',v_place.updated_at
        );
      end if;
    end if;
$new$;
  if position(v_old in v_definition)=0 then raise exception 'Promotion identity guard seam not found'; end if;
  v_definition := replace(v_definition,v_old,v_new);

  v_old := $old$
    insert into public.tourism_places(
      canonical_name,category,subcategory,latitude,longitude,description,description_source,description_license,
      wikidata_id,osm_type,osm_id,importance_score,review_status,is_active,route_ready
    ) values (
      v_stage.name,v_category,v_subcategory,v_stage.latitude,v_stage.longitude,v_description,v_description_source_url,
      v_description_license,v_wikidata_id,v_stage.source_type,v_stage.source_id,
      (v_record->>'importance_score')::smallint,'approved',true,false
    ) returning * into v_place;
$old$;
  v_new := $new$
    if v_place.id is null then
      insert into public.tourism_places(
        canonical_name,category,subcategory,latitude,longitude,description,description_source,description_license,
        wikidata_id,osm_type,osm_id,importance_score,review_status,is_active,route_ready
      ) values (
        v_stage.name,v_category,v_subcategory,v_stage.latitude,v_stage.longitude,v_description,v_description_source_url,
        v_description_license,v_wikidata_id,v_stage.source_type,v_stage.source_id,
        (v_record->>'importance_score')::smallint,'approved',true,false
      ) returning * into v_place;
    else
      update public.tourism_places set
        canonical_name=v_stage.name,category=v_category,subcategory=v_subcategory,
        latitude=v_stage.latitude,longitude=v_stage.longitude,
        description=null,description_source=null,description_license=null,
        importance_score=(v_record->>'importance_score')::smallint,
        review_status='approved',is_active=true,route_ready=false,updated_at=now()
      where id=v_place.id returning * into v_place;
    end if;
$new$;
  if position(v_old in v_definition)=0 then raise exception 'Canonical insert seam not found'; end if;
  v_definition := replace(v_definition,v_old,v_new);

  v_old := $old$
    insert into public.tourism_city_places(city_id,place_id,distance_km,relevance_score,is_current)
    values (p_city_id,v_place.id,v_exact_distance,(v_record->>'importance_score')::integer,true);
$old$;
  v_new := $new$
    select * into v_link from public.tourism_city_places cp
    where cp.city_id=p_city_id and cp.place_id=v_place.id for update;
    if found then
      v_previous_link_state := jsonb_build_object(
        'distance_km',v_link.distance_km,'relevance_score',v_link.relevance_score,'is_current',v_link.is_current
      );
      update public.tourism_city_places set distance_km=v_exact_distance,
        relevance_score=(v_record->>'importance_score')::integer,is_current=true
      where city_id=p_city_id and place_id=v_place.id returning * into v_link;
    else
      v_previous_link_state := null;
      insert into public.tourism_city_places(city_id,place_id,distance_km,relevance_score,is_current)
      values (p_city_id,v_place.id,v_exact_distance,(v_record->>'importance_score')::integer,true)
      returning * into v_link;
    end if;
$new$;
  if position(v_old in v_definition)=0 then raise exception 'City-place link seam not found'; end if;
  v_definition := replace(v_definition,v_old,v_new);

  v_old := $old$
    v_link_state := jsonb_build_object(
      'city_id',p_city_id,'place_id',v_place.id,'distance_km',v_exact_distance,
      'relevance_score',(v_record->>'importance_score')::integer,'is_current',true
    );
$old$;
  v_new := $new$
    v_link_state := jsonb_build_object(
      'city_id',p_city_id,'place_id',v_place.id,'distance_km',v_link.distance_km,
      'relevance_score',v_link.relevance_score,'is_current',v_link.is_current
    );
$new$;
  if position(v_old in v_definition)=0 then raise exception 'Published link audit seam not found'; end if;
  v_definition := replace(v_definition,v_old,v_new);

  v_old := $old$
      publication_id,stage_row_id,source_key,place_id,category,importance_score,importance_rationale,
      importance_source_url,source_record_sha256,published_record_state,published_link_state
    ) values (
      v_batch.id,v_stage.id,v_source_key,v_place.id,v_category,(v_record->>'importance_score')::smallint,
      trim(v_record->>'importance_rationale'),trim(v_record->>'importance_source_url'),
      encode(digest(v_stage.raw_record::text,'sha256'),'hex'),v_published_state,v_link_state
$old$;
  v_new := $new$
      publication_id,stage_row_id,source_key,place_id,category,importance_score,importance_rationale,
      importance_source_url,source_record_sha256,published_record_state,published_link_state,
      previous_record_state,previous_link_state
    ) values (
      v_batch.id,v_stage.id,v_source_key,v_place.id,v_category,(v_record->>'importance_score')::smallint,
      trim(v_record->>'importance_rationale'),trim(v_record->>'importance_source_url'),
      encode(digest(v_stage.raw_record::text,'sha256'),'hex'),v_published_state,v_link_state,
      v_previous_record_state,v_previous_link_state
$new$;
  if position(v_old in v_definition)=0 then raise exception 'Publication audit item seam not found'; end if;
  v_definition := replace(v_definition,v_old,v_new);

  v_changed := replace(v_definition,'digest(','extensions.digest(');
  if v_changed=v_definition and position('extensions.digest(' in v_definition)=0 then
    raise exception 'pgcrypto digest call seam not found';
  end if;
  if position('digest(' in replace(v_changed,'extensions.digest(',''))>0 then
    raise exception 'Unqualified digest call remains in promotion function';
  end if;
  v_definition := v_changed;

  execute v_definition;
end
$upgrade$;

do $rollback_upgrade$
declare
  v_signature regprocedure := 'public.rollback_offline_pbf_publication(text,text,text)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_old text;
  v_new text;
begin
  v_definition := replace(v_definition,
    '  v_count integer := 0;',
    '  v_count integer := 0;');
  v_old := $old$
    update public.tourism_city_places set is_current=false
    where city_id=v_batch.city_id and place_id=v_item.place_id;
    update public.tourism_places set review_status='rejected',is_active=false,route_ready=false,updated_at=now()
    where id=v_item.place_id;
$old$;
  v_new := $new$
    if v_item.previous_link_state is null then
      update public.tourism_city_places set is_current=false
      where city_id=v_batch.city_id and place_id=v_item.place_id;
    else
      update public.tourism_city_places set
        distance_km=(v_item.previous_link_state->>'distance_km')::double precision,
        relevance_score=(v_item.previous_link_state->>'relevance_score')::integer,
        is_current=(v_item.previous_link_state->>'is_current')::boolean
      where city_id=v_batch.city_id and place_id=v_item.place_id;
    end if;
    if v_item.previous_record_state is null then
      update public.tourism_places set review_status='rejected',is_active=false,route_ready=false,updated_at=now()
      where id=v_item.place_id;
    else
      update public.tourism_places set
        canonical_name=v_item.previous_record_state->>'canonical_name',
        category=v_item.previous_record_state->>'category',subcategory=v_item.previous_record_state->>'subcategory',
        latitude=(v_item.previous_record_state->>'latitude')::double precision,
        longitude=(v_item.previous_record_state->>'longitude')::double precision,
        description=v_item.previous_record_state->>'description',
        description_source=v_item.previous_record_state->>'description_source',
        description_license=v_item.previous_record_state->>'description_license',
        importance_score=(v_item.previous_record_state->>'importance_score')::smallint,
        review_status=v_item.previous_record_state->>'review_status',
        is_active=(v_item.previous_record_state->>'is_active')::boolean,
        route_ready=(v_item.previous_record_state->>'route_ready')::boolean,
        updated_at=(v_item.previous_record_state->>'updated_at')::timestamptz
      where id=v_item.place_id;
    end if;
$new$;
  if position(v_old in v_definition)=0 then raise exception 'Publication rollback seam not found'; end if;
  v_definition := replace(v_definition,v_old,v_new);
  execute v_definition;
end
$rollback_upgrade$;
