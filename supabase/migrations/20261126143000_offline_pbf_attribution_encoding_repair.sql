-- Repair OSM attribution text that was double-encoded when the original
-- migration was applied through the hosted SQL path. The source files and
-- incoming dataset use the correct © character.
alter table public.offline_pbf_imports
  drop constraint if exists offline_pbf_imports_attribution_check;
alter table public.offline_pbf_stage_rows
  drop constraint if exists offline_pbf_stage_rows_attribution_check;

update public.offline_pbf_imports
set attribution = chr(169) || ' OpenStreetMap contributors'
where attribution = chr(194) || chr(169) || ' OpenStreetMap contributors';
update public.offline_pbf_stage_rows
set attribution = chr(169) || ' OpenStreetMap contributors'
where attribution = chr(194) || chr(169) || ' OpenStreetMap contributors';
update public.tourism_place_sources
set attribution = chr(169) || ' OpenStreetMap contributors'
where source_name = 'openstreetmap'
  and attribution = chr(194) || chr(169) || ' OpenStreetMap contributors';

alter table public.offline_pbf_imports
  add constraint offline_pbf_imports_attribution_check
  check (attribution = chr(169) || ' OpenStreetMap contributors');
alter table public.offline_pbf_stage_rows
  add constraint offline_pbf_stage_rows_attribution_check
  check (attribution = chr(169) || ' OpenStreetMap contributors');

-- Preserve the audited RPC definitions and privileges while repairing only
-- the malformed attribution literal in their PL/pgSQL bodies.
do $repair$
declare
  v_signature regprocedure;
  v_definition text;
  v_bad text := chr(194) || chr(169) || ' OpenStreetMap contributors';
  v_good text := chr(169) || ' OpenStreetMap contributors';
  v_repaired text;
begin
  foreach v_signature in array array[
    'public.import_offline_pbf_batch(text,text,text,integer,jsonb)'::regprocedure,
    'public.promote_offline_pbf_records(text,text,uuid,text,text,jsonb)'::regprocedure
  ] loop
    v_definition := pg_get_functiondef(v_signature);
    v_repaired := replace(v_definition, v_bad, v_good);
    if v_repaired = v_definition and position(v_good in v_definition) = 0 then
      raise exception 'Expected OSM attribution literal missing from %', v_signature;
    end if;
    execute v_repaired;
  end loop;
end
$repair$;
