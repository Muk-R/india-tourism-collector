-- Narrow additive compatibility for the public places Worker query.
-- This avoids enabling the separate collection-cycle migration solely to
-- provide current-link and importance fields.
begin;

alter table public.tourism_city_places
  add column if not exists is_current boolean not null default true;

alter table public.tourism_places
  add column if not exists importance_score smallint not null default 0
    check (importance_score between 0 and 100);

comment on column public.tourism_city_places.is_current is
  'Whether this city-place association is current and eligible for public browsing after place approval.';
comment on column public.tourism_places.importance_score is
  'Reviewed tourism importance ranking used for attraction browsing; zero is the conservative default.';

commit;
