-- Keep verified monument fees readable regardless of client or database encoding.
begin;

with fee_data(source_key, entry_fee) as (
  values
    ('way/116031164', 'Indian adults INR 150; children under 10 INR 50; foreign visitors INR 500; mobile photography INR 50'),
    ('way/238284090', 'Indian adults INR 50; children above 5 years INR 20; foreign visitors INR 1,000; camera or smartphone INR 50')
), targets as (
  select p.id, f.entry_fee
  from public.tourism_places p
  join public.tourism_place_sources s on s.place_id = p.id and s.source_name = 'openstreetmap'
  join fee_data f on f.source_key = s.source_id
  where p.review_status = 'approved' and p.is_active is true
    and p.visiting_info->>'verified' = 'true'
)
update public.tourism_places p
set visiting_info = jsonb_set(p.visiting_info, '{entry_fee}', to_jsonb(t.entry_fee), true)
from targets t
where p.id = t.id;

do $$
begin
  if (select count(*) from public.tourism_places p
      join public.tourism_place_sources s on s.place_id=p.id and s.source_name='openstreetmap'
      where s.source_id in ('way/116031164','way/238284090')
        and p.visiting_info->>'entry_fee' like '%INR%') <> 2 then
    raise exception 'Expected both verified museum fee strings to be normalized';
  end if;
end
$$;

commit;
