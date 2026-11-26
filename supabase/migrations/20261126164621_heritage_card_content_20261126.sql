-- Add source-backed heritage detail fields for public, reviewed places.
-- Existing RLS and grants remain unchanged; only approved active records are served by the Worker.
begin;

alter table public.tourism_places
  add column if not exists historical_points jsonb not null default '[]'::jsonb,
  add column if not exists visiting_info jsonb not null default '{}'::jsonb,
  add column if not exists visit_duration_minutes integer,
  add column if not exists visit_duration_verified boolean not null default false,
  add column if not exists visit_duration_source_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tourism_places_historical_points_array') then
    alter table public.tourism_places
      add constraint tourism_places_historical_points_array
      check (jsonb_typeof(historical_points) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tourism_places_visiting_info_object') then
    alter table public.tourism_places
      add constraint tourism_places_visiting_info_object
      check (jsonb_typeof(visiting_info) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tourism_places_visit_duration_valid') then
    alter table public.tourism_places
      add constraint tourism_places_visit_duration_valid
      check (visit_duration_minutes is null or visit_duration_minutes between 1 and 1440);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tourism_places_verified_duration_has_source') then
    alter table public.tourism_places
      add constraint tourism_places_verified_duration_has_source
      check (visit_duration_verified = false or
        (visit_duration_minutes is not null and visit_duration_source_url ~ '^https://[^[:space:]]+$'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tourism_places_verified_visiting_info_has_source') then
    alter table public.tourism_places
      add constraint tourism_places_verified_visiting_info_has_source
      check (coalesce((visiting_info->>'verified')::boolean, false) = false or
        visiting_info->>'source_url' ~ '^https://[^[:space:]]+$');
  end if;
end
$$;

comment on column public.tourism_places.historical_points is
  'Independently written factual highlights; every item must carry a source_url before public rendering.';
comment on column public.tourism_places.visiting_info is
  'Source-backed visiting schedule; verified=true requires a secure source_url and is checked again by the Worker.';
comment on column public.tourism_places.visit_duration_minutes is
  'Optional visitor duration; displayed only when visit_duration_verified and a source URL are present.';

do $$
declare
  v_target_count integer;
  v_updated_count integer;
begin
  select count(*) into v_target_count
  from public.tourism_places p
  join public.tourism_place_sources s on s.place_id = p.id and s.source_name = 'openstreetmap'
  where p.review_status = 'approved' and p.is_active is true
    and s.source_id in ('way/238186115','relation/9128913','way/116031164','way/238284090');

  if v_target_count <> 4 then
    raise exception 'Expected exactly four approved Hyderabad heritage sources, found %', v_target_count;
  end if;

  with content as (
    select * from jsonb_to_recordset($heritage$
      [
        {
          "source_key":"way/238186115",
          "historical_points":[
            {"text":"Construction began in 1589 and the monument was completed in 1591 under Sultan Muhammad Quli Qutb Shah.","source_url":"https://hyderabad.telangana.gov.in/tourist-place/charminar/"},
            {"text":"The square monument has four minarets and was designed by Iranian architect Mir Momin Astarabadi.","source_url":"https://hyderabad.telangana.gov.in/tourist-place/charminar/"},
            {"text":"A mosque occupies the upper level, reached by a staircase of 149 steps.","source_url":"https://hyderabad.telangana.gov.in/tourist-place/charminar/"}
          ],
          "visiting_info":{"verified":true,"source_url":"https://culture.gov.in/files/inline-documents/TheAncientMonumentsandArchaeologicalSitesandRemainsRules1959_20.03.2018.pdf","opening_text":"Upper levels: 09:00; remaining area: sunrise","closing_text":"Upper levels: 17:30 or sunset, whichever is earlier; remaining area: 22:00","weekly_closed_text":"Not specified in the cited rule","status_exceptions":true,"notes":"The official rule gives separate hours by monument area. Temporary closures may be announced."},
          "image_url":"https://commons.wikimedia.org/wiki/Special:FilePath/Charminar_at_Hyderabad_Telangana_India.jpg?width=1600",
          "image_source_url":"https://commons.wikimedia.org/wiki/File:Charminar_at_Hyderabad_Telangana_India.jpg",
          "image_author":"Kavali Chandrakanth KCK",
          "image_license":"CC BY-SA 4.0",
          "duration_minutes":null,
          "duration_source_url":null
        },
        {
          "source_key":"relation/9128913",
          "historical_points":[
            {"text":"The fort's early history is associated with Kakatiya rule; Bahmani and Qutb Shahi rulers later held the site.","source_url":"https://hyderabad.telangana.gov.in/tourist-place/golconda-fort/"},
            {"text":"Qutb Shahi rulers expanded it into a granite fortress before Mughal emperor Aurangzeb captured Golconda in 1687.","source_url":"https://hyderabad.telangana.gov.in/tourist-place/golconda-fort/"},
            {"text":"A clap near Fateh Darwaza can be heard at the hilltop pavilion, an acoustic signaling feature described by the district government.","source_url":"https://hyderabad.telangana.gov.in/tourist-place/golconda-fort/"}
          ],
          "visiting_info":{"verified":true,"source_url":"https://hyderabad.telangana.gov.in/tourist-place/golconda-fort/","opening_text":"09:00","closing_text":"17:00","weekly_closed_text":"Not specified on the cited government page","status_exceptions":true,"notes":"Check the official page for temporary access changes before visiting."},
          "image_url":"https://commons.wikimedia.org/wiki/Special:FilePath/Golkonda_Fort-Hyderabad-Telangana-3.jpg?width=1600",
          "image_source_url":"https://commons.wikimedia.org/wiki/File:Golkonda_Fort-Hyderabad-Telangana-3.jpg",
          "image_author":"Ajit Jadhav (Ajitjadhav28)",
          "image_license":"CC BY-SA 4.0",
          "duration_minutes":null,
          "duration_source_url":null
        },
        {
          "source_key":"way/116031164",
          "historical_points":[
            {"text":"Chowmahalla served as a palace of Hyderabad's Nizams and was a major ceremonial complex.","source_url":"https://hyderabad.telangana.gov.in/tourist-place/chowmahalla-palace/"},
            {"text":"The complex includes two courtyards, palace buildings, gardens, fountains and the Khilwat or Durbar Hall.","source_url":"https://hyderabad.telangana.gov.in/tourist-place/chowmahalla-palace/"},
            {"text":"The northern courtyard includes the Bara Imam corridor and the Clock Tower, which houses the working Khilwat Clock.","source_url":"https://hyderabad.telangana.gov.in/tourist-place/chowmahalla-palace/"}
          ],
          "visiting_info":{"verified":true,"source_url":"https://www.chowmahalla.in/visit/","weekly":{"Monday":{"open":"10:00","close":"17:00"},"Tuesday":{"open":"10:00","close":"17:00"},"Wednesday":{"open":"10:00","close":"17:00"},"Thursday":{"open":"10:00","close":"17:00"},"Friday":{"closed":true},"Saturday":{"open":"10:00","close":"17:00"},"Sunday":{"open":"10:00","close":"17:00"}},"last_entry":"Ticket counter closes at 17:00","fees_verified":true,"entry_fee":"Indian adults ₹150; children under 10 ₹50; foreign visitors ₹500; mobile photography ₹50","status_exceptions":false},
          "image_url":"https://commons.wikimedia.org/wiki/Special:FilePath/Chowmahalla_Palace_-_Northern_Courtyard_%286%29.jpg?width=1600",
          "image_source_url":"https://commons.wikimedia.org/wiki/File:Chowmahalla_Palace_-_Northern_Courtyard_(6).jpg",
          "image_author":"Rajashree Talukdar",
          "image_license":"CC BY-SA 4.0",
          "duration_minutes":120,
          "duration_source_url":"https://www.chowmahalla.in/visit/"
        },
        {
          "source_key":"way/238284090",
          "historical_points":[
            {"text":"Salar Jung III, Mir Yousuf Ali Khan, assembled most of the collection over decades of collecting art and manuscripts.","source_url":"https://salarjungmuseum.in/history-of-sjm/"},
            {"text":"The museum opened to the public at Dewan Deodi on 16 December 1951, inaugurated by Prime Minister Jawaharlal Nehru.","source_url":"https://salarjungmuseum.in/history-of-sjm/"},
            {"text":"Parliament declared the museum an Institution of National Importance in 1961; it moved to its present building in 1968.","source_url":"https://salarjungmuseum.in/history-of-sjm/"}
          ],
          "visiting_info":{"verified":true,"source_url":"https://salarjungmuseum.in/Hours-and-admission.html","weekly":{"Monday":{"open":"10:00","close":"18:00"},"Tuesday":{"open":"10:00","close":"18:00"},"Wednesday":{"open":"10:00","close":"18:00"},"Thursday":{"open":"10:00","close":"18:00"},"Friday":{"closed":true},"Saturday":{"open":"10:00","close":"18:00"},"Sunday":{"open":"10:00","close":"18:00"}},"last_entry":"Ticket counter closes at 17:15","fees_verified":true,"entry_fee":"Indian adults ₹50; children above 5 years ₹20; foreign visitors ₹1,000; camera or smartphone ₹50","status_exceptions":true,"notes":"The museum also closes on notified holidays; check the museum notice before visiting."},
          "image_url":"https://commons.wikimedia.org/wiki/Special:FilePath/Salar_Jung_Museum,_Hyderabad,_India.jpg?width=1600",
          "image_source_url":"https://commons.wikimedia.org/wiki/File:Salar_Jung_Museum,_Hyderabad,_India.jpg",
          "image_author":"Omer123hussain",
          "image_license":"CC BY-SA 4.0",
          "duration_minutes":null,
          "duration_source_url":null
        }
      ]
    $heritage$::jsonb) as item(
      source_key text,
      historical_points jsonb,
      visiting_info jsonb,
      image_url text,
      image_source_url text,
      image_author text,
      image_license text,
      duration_minutes integer,
      duration_source_url text
    )
  ), targets as (
    select p.id, c.*
    from public.tourism_places p
    join public.tourism_place_sources s on s.place_id = p.id and s.source_name = 'openstreetmap'
    join content c on c.source_key = s.source_id
    where p.review_status = 'approved' and p.is_active is true
  )
  update public.tourism_places p
  set historical_points = t.historical_points,
      visiting_info = t.visiting_info,
      image_url = t.image_url,
      image_source_url = t.image_source_url,
      image_author = t.image_author,
      image_license = t.image_license,
      visit_duration_minutes = t.duration_minutes,
      visit_duration_verified = t.duration_minutes is not null,
      visit_duration_source_url = t.duration_source_url
  from targets t
  where p.id = t.id;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 4 then
    raise exception 'Expected to enrich four approved heritage records, updated %', v_updated_count;
  end if;
end
$$;

commit;
