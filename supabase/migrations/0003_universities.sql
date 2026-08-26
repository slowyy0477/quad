-- =============================================================================
-- 0003  Universities, departments, programs
-- =============================================================================
-- Universities are MODERATED (spec §7: "do not allow arbitrary users to create
-- duplicate universities without moderation"). New submissions land as
-- `pending` and are visible only to their submitter and to moderators.
--
-- A pending university is still selectable by the student who submitted it, so
-- onboarding is never blocked while moderation is outstanding. Its public page
-- 404s for everyone else until approved. That is the honest behaviour: the row
-- exists, it just isn't public yet.
--
-- Departments and programs are NOT gated, only flagged (`is_verified`). Gating
-- them would strand any student whose department isn't seeded, and the blast
-- radius of a duplicate department is far smaller than a duplicate university.
-- =============================================================================

create table public.universities (
  id              uuid primary key default gen_random_uuid(),
  slug            text        not null unique,
  name            text        not null check (length(btrim(name)) between 2 and 200),
  short_name      text        check (length(short_name) <= 40),
  country         text        check (length(country) <= 80),
  city            text        check (length(city) <= 120),
  website         text        check (website is null or website ~* '^https?://'),
  logo_url        text,
  description     text        check (length(description) <= 4000),

  -- Email domains, for a future university-verification feature. Stored now so
  -- the data is collected; nothing reads it yet.
  email_domains   text[]      not null default '{}',

  status          text        not null default 'pending'
                              check (status in ('pending', 'approved', 'rejected')),
  rejection_reason text,

  submitted_by    uuid        references auth.users (id) on delete set null,
  reviewed_by     uuid        references auth.users (id) on delete set null,
  reviewed_at     timestamptz,

  -- Denormalised counters, maintained by triggers. Nothing does count(*) in a
  -- list view (spec §39).
  student_count   integer     not null default 0,
  project_count   integer     not null default 0,

  -- Immutable, generated: blocks byte-identical resubmissions outright.
  normalized_name text generated always as (app.slugify(name)) stored,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.universities is
  'Moderated institution directory. Only status=approved rows are public.';

-- Exact-duplicate guard. A unique INDEX (not a constraint) so it can coalesce
-- the nullable country — Postgres treats NULLs as distinct in UNIQUE by default,
-- which would let "MIT"/NULL be inserted a hundred times.
create unique index universities_normalized_country_key
  on public.universities (normalized_name, coalesce(country, ''));

create index universities_status_idx      on public.universities (status);
create index universities_country_idx     on public.universities (country) where status = 'approved';
create index universities_submitted_by_idx on public.universities (submitted_by);
create index universities_name_trgm_idx
  on public.universities using gin (name extensions.gin_trgm_ops);

create trigger universities_set_updated_at
  before update on public.universities
  for each row execute function app.set_updated_at();


-- Slug assignment + ownership stamping. The client cannot choose either.
create or replace function app.universities_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.slug := app.unique_slug('universities', 'slug',
                coalesce(nullif(btrim(new.short_name), ''), new.name));

  if not app.is_privileged_role() and not app.is_moderator() then
    new.submitted_by := auth.uid();
    new.status       := 'pending';
    new.reviewed_by  := null;
    new.reviewed_at  := null;
    new.student_count := 0;
    new.project_count := 0;
  end if;

  return new;
end;
$$;

revoke execute on function app.universities_before_insert() from public;

create trigger universities_before_insert
  before insert on public.universities
  for each row execute function app.universities_before_insert();

-- Submitters may correct a pending submission but never approve it.
create trigger universities_protect_moderation_columns
  before update on public.universities
  for each row execute function app.reject_protected_column_change(
    'status', 'reviewed_by', 'reviewed_at', 'submitted_by',
    'student_count', 'project_count'
  );


-- -----------------------------------------------------------------------------
-- app.can_view_university() — reused by departments/programs policies
-- -----------------------------------------------------------------------------
create or replace function app.can_view_university(v_university_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.universities u
    where u.id = v_university_id
      and (u.status = 'approved'
           or u.submitted_by = auth.uid()
           or app.is_moderator())
  );
$$;

revoke execute on function app.can_view_university(uuid) from public;
grant execute on function app.can_view_university(uuid) to authenticated, anon, service_role;


alter table public.universities enable row level security;

create policy universities_select_public
  on public.universities for select
  to anon, authenticated
  using (status = 'approved');

create policy universities_select_own_submission
  on public.universities for select
  to authenticated
  using (submitted_by = auth.uid());

create policy universities_select_moderator
  on public.universities for select
  to authenticated
  using (app.is_moderator());

create policy universities_insert_authenticated
  on public.universities for insert
  to authenticated
  with check (auth.uid() is not null);

create policy universities_update_own_pending
  on public.universities for update
  to authenticated
  using (submitted_by = auth.uid() and status = 'pending')
  with check (submitted_by = auth.uid());

create policy universities_update_moderator
  on public.universities for update
  to authenticated
  using (app.is_moderator())
  with check (app.is_moderator());

create policy universities_delete_admin
  on public.universities for delete
  to authenticated
  using (app.is_admin());


-- =============================================================================
-- departments
-- =============================================================================

create table public.departments (
  id            uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities (id) on delete cascade,
  name          text not null check (length(btrim(name)) between 2 and 160),
  slug          text not null,
  is_verified   boolean not null default false,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (university_id, slug)
);

comment on table public.departments is
  'Ungated but flagged. is_verified distinguishes seeded/curated rows from user-added ones.';

create index departments_university_idx on public.departments (university_id);
create index departments_name_trgm_idx
  on public.departments using gin (name extensions.gin_trgm_ops);

create trigger departments_set_updated_at
  before update on public.departments
  for each row execute function app.set_updated_at();

create or replace function app.departments_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Scope the slug to the university, so two universities can both have "cs".
  new.slug := coalesce(app.slugify(new.name), 'department');
  if exists (
    select 1 from public.departments d
    where d.university_id = new.university_id and d.slug = new.slug
  ) then
    new.slug := new.slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  end if;

  if not app.is_privileged_role() and not app.is_moderator() then
    new.created_by  := auth.uid();
    new.is_verified := false;
  end if;

  return new;
end;
$$;

revoke execute on function app.departments_before_insert() from public;

create trigger departments_before_insert
  before insert on public.departments
  for each row execute function app.departments_before_insert();

create trigger departments_protect_columns
  before update on public.departments
  for each row execute function app.reject_protected_column_change(
    'is_verified', 'university_id', 'created_by'
  );

alter table public.departments enable row level security;

create policy departments_select
  on public.departments for select
  to anon, authenticated
  using (app.can_view_university(university_id));

create policy departments_insert_authenticated
  on public.departments for insert
  to authenticated
  with check (auth.uid() is not null and app.can_view_university(university_id));

create policy departments_update_moderator
  on public.departments for update
  to authenticated
  using (app.is_moderator())
  with check (app.is_moderator());

create policy departments_delete_moderator
  on public.departments for delete
  to authenticated
  using (app.is_moderator());


-- =============================================================================
-- programs (degrees)
-- =============================================================================

create table public.programs (
  id                 uuid primary key default gen_random_uuid(),
  department_id      uuid not null references public.departments (id) on delete cascade,
  name               text not null check (length(btrim(name)) between 2 and 200),
  slug               text not null,
  degree_type        text not null default 'bachelor'
                     check (degree_type in ('associate', 'bachelor', 'master',
                                            'doctorate', 'diploma', 'certificate', 'other')),
  duration_semesters integer check (duration_semesters between 1 and 24),
  is_verified        boolean not null default false,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (department_id, slug)
);

create index programs_department_idx on public.programs (department_id);

create trigger programs_set_updated_at
  before update on public.programs
  for each row execute function app.set_updated_at();

create or replace function app.programs_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.slug := coalesce(app.slugify(new.name), 'program');
  if exists (
    select 1 from public.programs p
    where p.department_id = new.department_id and p.slug = new.slug
  ) then
    new.slug := new.slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  end if;

  if not app.is_privileged_role() and not app.is_moderator() then
    new.created_by  := auth.uid();
    new.is_verified := false;
  end if;

  return new;
end;
$$;

revoke execute on function app.programs_before_insert() from public;

create trigger programs_before_insert
  before insert on public.programs
  for each row execute function app.programs_before_insert();

create trigger programs_protect_columns
  before update on public.programs
  for each row execute function app.reject_protected_column_change(
    'is_verified', 'department_id', 'created_by'
  );

alter table public.programs enable row level security;

create policy programs_select
  on public.programs for select
  to anon, authenticated
  using (exists (
    select 1 from public.departments d
    where d.id = programs.department_id
      and app.can_view_university(d.university_id)
  ));

create policy programs_insert_authenticated
  on public.programs for insert
  to authenticated
  with check (auth.uid() is not null and exists (
    select 1 from public.departments d
    where d.id = programs.department_id
      and app.can_view_university(d.university_id)
  ));

create policy programs_update_moderator
  on public.programs for update
  to authenticated
  using (app.is_moderator())
  with check (app.is_moderator());

create policy programs_delete_moderator
  on public.programs for delete
  to authenticated
  using (app.is_moderator());
