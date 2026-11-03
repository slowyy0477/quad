-- Bulla people discovery: forward-only, count-free, caller-RLS reads.
-- No fuzzy ranking or offset: literal name/department/skill substrings and a
-- (created_at, id) DESC keyset shared with the local adapter. At most 51 rows
-- (50 displayed + one readable lookahead), and at most five readable skill claims.
-- All parameters remain data. Escape %, _ and \ before constructing LIKE values.
-- Indexes are candidate paths, NOT measured capacity/EXPLAIN evidence.

create index profiles_discovery_recent_idx
  on public.profiles (created_at desc, id desc)
  where searchable and deleted_at is null and status in ('active', 'suspended');

create index profiles_discovery_university_idx
  on public.profiles (university_id, created_at desc, id desc)
  where searchable and deleted_at is null and status in ('active', 'suspended');

create index profiles_discovery_department_idx
  on public.profiles (department_id, created_at desc, id desc)
  where searchable and deleted_at is null and status in ('active', 'suspended');

create index departments_discovery_name_idx
  on public.departments using gin (name extensions.gin_trgm_ops);

create index profile_skills_discovery_idx
  on public.profile_skills (skill_id, profile_id);

-- Portfolio pages use owner + creation keysets, not raw profile counters.
create index projects_portfolio_idx
  on public.projects (owner_id, created_at desc, id desc)
  where deleted_at is null and moderation_status = 'active';
create index ideas_portfolio_idx
  on public.ideas (author_id, created_at desc, id desc)
  where deleted_at is null and moderation_status = 'active';
create index goals_portfolio_idx
  on public.goals (profile_id, created_at desc, id desc);
create index posts_portfolio_idx
  on public.posts (author_id, created_at desc, id desc)
  where deleted_at is null and moderation_status = 'active';

create function public.people_discovery(
  p_query text default '',
  p_university_id uuid default null,
  p_department text default '',
  p_skill text default '',
  p_after_created_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 20,
  p_exclude_self boolean default false
)
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  headline text,
  created_at timestamptz,
  university_id uuid,
  university_name text,
  university_short_name text,
  department text,
  skills jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with terms as (
    select btrim(coalesce(p_query, '')) as q,
           btrim(coalesce(p_department, '')) as dept,
           btrim(coalesce(p_skill, '')) as skill
  ), filters as (
    select t.*,
           '%' || replace(replace(replace(t.q, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' as q_like,
           '%' || replace(replace(replace(t.dept, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' as dept_like,
           '%' || replace(replace(replace(t.skill, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' as skill_like
      from terms t
  )
  select p.id, p.username, p.display_name, p.avatar_url, p.headline,
         p.created_at,
         -- A hidden catalogue embed is null, not a guessed name or a raw FK.
         u.id, u.name, u.short_name, d.name,
         coalesce(claims.skills, '[]'::jsonb)
    from public.profiles p
    cross join filters f
    left join public.universities u on u.id = p.university_id
    left join public.departments d on d.id = p.department_id
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'level', s.level, 'is_learning', s.is_learning
      ) order by s.priority, s.display_order, s.created_at, s.id) as skills
      from (
        select sk.id, sk.name, ps.level, ps.is_learning, ps.display_order, ps.created_at,
               case when f.skill <> '' and sk.name ilike f.skill_like escape E'\\'
                    then 0 else 1 end as priority
          from public.profile_skills ps
          join public.skills sk on sk.id = ps.skill_id
         where ps.profile_id = p.id
           and (sk.is_approved or sk.created_by = auth.uid())
         order by priority, ps.display_order, ps.created_at, sk.id
         limit 5
      ) s
    ) claims on true
   where auth.uid() is not null
     and exists (
       select 1 from public.profiles viewer
        where viewer.id = auth.uid() and viewer.deleted_at is null
          and (viewer.status = 'active'
               or (viewer.status = 'suspended' and viewer.suspended_until <= now()))
     )
     and length(f.q) <= 120 and length(f.q) <> 1
     and length(f.dept) <= 160 and length(f.skill) <= 60
     and p.searchable and p.deleted_at is null
     and (p.status = 'active' or (p.status = 'suspended' and p.suspended_until <= now()))
     and (not coalesce(p_exclude_self, false) or p.id <> auth.uid())
     and not app.is_blocked_either_way(p.id, auth.uid())
     -- Ordinary discovery is not a moderation queue, even for staff.
     and (p.id = auth.uid() or p.visibility = 'public'
          or (p.visibility = 'university' and app.share_university(p.id, auth.uid()))
          or (p.visibility = 'connections' and app.are_connected(p.id, auth.uid())))
     and (p_university_id is null or u.id = p_university_id)
     and (f.dept = '' or d.name ilike f.dept_like escape E'\\')
     and (f.q = '' or p.display_name ilike f.q_like escape E'\\'
                   or p.username ilike f.q_like escape E'\\')
     and (f.skill = '' or exists (
       select 1 from public.profile_skills ps
       join public.skills sk on sk.id = ps.skill_id
       where ps.profile_id = p.id
         and (sk.is_approved or sk.created_by = auth.uid())
         and sk.name ilike f.skill_like escape E'\\'
     ))
     and (p_after_created_at is null or p_after_id is null
          or (p.created_at, p.id) < (p_after_created_at, p_after_id))
   order by p.created_at desc, p.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50) + 1;
$$;

-- Revoke explicit Supabase default grants too, not just PUBLIC's grant.
revoke all on function public.people_discovery(text, uuid, text, text, timestamptz, uuid, integer, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.people_discovery(text, uuid, text, text, timestamptz, uuid, integer, boolean)
  to authenticated, service_role;

comment on function public.people_discovery(text, uuid, text, text, timestamptz, uuid, integer, boolean) is
  'Bounded, count-free people discovery under caller RLS. Skills/affiliation are self-declared; no activity or mastery score.';
