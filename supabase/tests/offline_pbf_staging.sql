-- Run after 20261125_offline_pbf_staging.sql in an isolated local database.
do $$
begin
  if not (select relrowsecurity from pg_class where oid='public.offline_pbf_imports'::regclass) or
     not (select relrowsecurity from pg_class where oid='public.offline_pbf_stage_rows'::regclass) then
    raise exception 'RLS is not enabled for offline staging';
  end if;
  if has_table_privilege('anon','public.offline_pbf_imports','select') or
     has_table_privilege('anon','public.offline_pbf_stage_rows','select') or
     has_table_privilege('authenticated','public.offline_pbf_imports','select') or
     has_table_privilege('authenticated','public.offline_pbf_stage_rows','select') then
    raise exception 'Public or authenticated roles can read private staging';
  end if;
  if has_function_privilege('anon','public.import_offline_pbf_batch(text,text,text,integer,jsonb)','execute') or
     has_function_privilege('authenticated','public.import_offline_pbf_batch(text,text,text,integer,jsonb)','execute') then
    raise exception 'Public or authenticated roles can execute import RPC';
  end if;
  if not has_function_privilege('service_role','public.import_offline_pbf_batch(text,text,text,integer,jsonb)','execute') or
     not has_function_privilege('service_role','public.finalize_offline_pbf_import(text)','execute') then
    raise exception 'Service role is missing import RPC access';
  end if;
  if exists (select 1 from public.offline_pbf_stage_rows where itinerary_ready) then
    raise exception 'Review staging contains itinerary-ready records';
  end if;
  if exists (select 1 from public.offline_pbf_stage_rows where
      (disposition='quarantine' and (name is not null or quarantine_reason <> 'missing_name')) or
      (disposition='review_only' and (name is null or quarantine_reason is not null))) then
    raise exception 'Review/quarantine disposition invariant failed';
  end if;
end;
$$;

set role anon;
do $$
begin
  begin
    execute 'select count(*) from public.offline_pbf_stage_rows';
    raise exception 'anon read private stage unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    execute 'select * from public.import_offline_pbf_batch(null,null,null,null,null)';
    raise exception 'anon import RPC unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set role authenticated;
do $$
begin
  begin
    execute 'select count(*) from public.offline_pbf_imports';
    raise exception 'authenticated read private import unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
