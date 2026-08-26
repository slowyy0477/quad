-- =============================================================================
-- 0008_posts.sql  --  Posts, media, likes, saves, comments
--
-- VISIBILITY CLAMP
-- ----------------
-- A post can never be more visible than its author's profile. Without this, an
-- anonymous visitor could read a public post whose author's name they are not
-- permitted to see -- the row-level privacy model in 0004 would contradict
-- itself. `app.clamp_visibility` (defined in 0001, shared with projects)
-- enforces the ceiling in a BEFORE trigger, so it holds no matter which code
-- path writes the row.
--
-- PAGINATION
-- ----------
-- Every list index is (..., created_at desc, id desc) to support keyset cursors.
-- `id` is the tiebreaker so a cursor is total-ordered even when two rows share a
-- timestamp; without it, keyset pagination silently drops rows.
-- =============================================================================


-- =============================================================================
-- posts
-- =============================================================================

create table public.posts (
  id        uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles (id) on delete cascade,

  type text not null default 'text'
       check (type in ('text', 'image', 'project_update', 'achievement',
                       'question', 'resource', 'looking_for_teammates',
                       'learning_update', 'opportunity')),

  body     text check (length(body) <= 5000),
  title    text check (length(title) <= 200),
  link_url text check (link_url is null or link_url ~* '^https?://'),

  -- Optional anchors to the thing the post is *about*. This is what stops the
  -- feed being a decontextualised timeline (see docs/PRODUCT.md).
  project_id     uuid references public.projects (id) on delete set null,
  achievement_key text,
  goal_id        uuid,
  opportunity_id uuid,

  -- Denormalised from the author so university-scoped feeds are one index scan
  -- rather than a join. Maintained by trigger.
  university_id uuid references public.universities (id) on delete set null,

  visibility text not null default 'public'
             check (visibility in ('public', 'university', 'connections', 'private')),

  like_count    integer not null default 0,
  comment_count integer not null default 0,
  save_count    integer not null default 0,

  is_edited boolean not null default false,
  edited_at timestamptz,

  moderation_status text not null default 'active'
                    check (moderation_status in ('active', 'hidden', 'removed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  -- A post must carry something. An empty post is a bug, not a feature.
  constraint posts_not_empty check (
    coalesce(btrim(body), '') <> ''
    or coalesce(btrim(title), '') <> ''
    or link_url is not null
    or project_id is not null
    or achievement_key is not null
  )
);

comment on table public.posts is
  'Feed items. visibility is clamped to the author profile visibility by trigger.';

create index posts_feed_idx
  on public.posts (created_at desc, id desc)
  where deleted_at is null and moderation_status = 'active';

create index posts_author_idx
  on public.posts (author_id, created_at desc, id desc)
  where deleted_at is null and moderation_status = 'active';

create index posts_university_idx
  on public.posts (university_id, created_at desc, id desc)
  where deleted_at is null and moderation_status = 'active';

create index posts_type_idx
  on public.posts (type, created_at desc, id desc)
  where deleted_at is null and moderation_status = 'active';

create index posts_project_idx on public.posts (project_id)
  where project_id is not null and deleted_at is null;

create index posts_body_trgm_idx
  on public.posts using gin (body extensions.gin_trgm_ops);

create index posts_moderation_idx on public.posts (moderation_status)
  where moderation_status <> 'active';

create trigger posts_set_updated_at
  before update on public.posts
  for each row execute function app.set_updated_at();


create or replace function app.posts_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author_visibility text;
  v_university_id     uuid;
begin
  if tg_op = 'INSERT' and not app.is_privileged_role() then
    new.author_id := auth.uid();
    new.like_count := 0;
    new.comment_count := 0;
    new.save_count := 0;
    new.moderation_status := 'active';
  end if;

  select p.visibility, p.university_id
    into v_author_visibility, v_university_id
    from public.profiles p where p.id = new.author_id;

  new.university_id := v_university_id;
  new.visibility := app.clamp_visibility(new.visibility, v_author_visibility);

  -- Anchor validation. A post card renders the linked project's title, so
  -- anchoring to a project you cannot see would leak that title to everyone who
  -- can see the post. Membership is required rather than mere visibility: a
  -- "project update" from a stranger is not an update, it is a hijack of
  -- someone else's project page.
  if new.project_id is not null
     and not app.is_privileged_role()
     and (tg_op = 'INSERT' or new.project_id is distinct from old.project_id)
  then
    if not app.is_project_member(new.project_id, new.author_id) then
      raise exception 'You are not a member of that project'
        using errcode = '42501', hint = 'not_project_member';
    end if;
  end if;

  if tg_op = 'UPDATE'
     and new.body is distinct from old.body
     and not app.is_privileged_role() then
    new.is_edited := true;
    new.edited_at := now();
  end if;

  return new;
end;
$$;

revoke execute on function app.posts_before_write() from public;

create trigger posts_before_write
  before insert or update on public.posts
  for each row execute function app.posts_before_write();

create trigger posts_protect_columns
  before update on public.posts
  for each row execute function app.reject_protected_column_change(
    'id', 'author_id', 'created_at', 'like_count', 'comment_count', 'save_count'
  );


-- profiles.post_count
create or replace function app.sync_profile_post_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was_live boolean := (tg_op <> 'INSERT'
                         and old.deleted_at is null and old.moderation_status = 'active');
  v_is_live  boolean := (tg_op <> 'DELETE'
                         and new.deleted_at is null and new.moderation_status = 'active');
begin
  if v_was_live = v_is_live then
    return null;
  end if;

  if v_is_live then
    update public.profiles set post_count = post_count + 1 where id = new.author_id;
  else
    update public.profiles set post_count = greatest(post_count - 1, 0)
      where id = old.author_id;
  end if;

  return null;
end;
$$;

revoke execute on function app.sync_profile_post_count() from public;

create trigger posts_sync_profile_count
  after insert or update or delete on public.posts
  for each row execute function app.sync_profile_post_count();


-- projects.post_count -- the number of updates posted against a project. Same
-- liveness rule as the profile counter, plus the case where a post is re-anchored
-- from one project to another.
create or replace function app.sync_project_post_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was_live boolean := (tg_op <> 'INSERT'
                         and old.deleted_at is null and old.moderation_status = 'active'
                         and old.project_id is not null);
  v_is_live  boolean := (tg_op <> 'DELETE'
                         and new.deleted_at is null and new.moderation_status = 'active'
                         and new.project_id is not null);
begin
  if v_was_live
     and (not v_is_live or new.project_id is distinct from old.project_id)
  then
    update public.projects set post_count = greatest(post_count - 1, 0)
      where id = old.project_id;
  end if;

  if v_is_live
     and (not v_was_live or new.project_id is distinct from old.project_id)
  then
    update public.projects set post_count = post_count + 1
      where id = new.project_id;
  end if;

  return null;
end;
$$;

revoke execute on function app.sync_project_post_count() from public;

create trigger posts_sync_project_count
  after insert or update or delete on public.posts
  for each row execute function app.sync_project_post_count();


-- -----------------------------------------------------------------------------
-- The single post-visibility predicate. Every read path uses it: RLS on posts,
-- comments, likes, and media. One definition, one place to get it wrong.
-- -----------------------------------------------------------------------------
create or replace function app.can_view_post(v_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.posts p
    where p.id = v_post_id
      and (
        p.author_id = auth.uid()
        or app.is_moderator()
        or (
          p.deleted_at is null
          and p.moderation_status = 'active'
          and not app.is_blocked_either_way(p.author_id, auth.uid())
          and (
            p.visibility = 'public'
            or (p.visibility = 'university'
                and app.share_university(p.author_id, auth.uid()))
            or (p.visibility = 'connections'
                and app.are_connected(p.author_id, auth.uid()))
          )
        )
      )
  );
$$;

revoke execute on function app.can_view_post(uuid) from public;
grant execute on function app.can_view_post(uuid) to authenticated, anon, service_role;


alter table public.posts enable row level security;

-- Written inline rather than via can_view_post() so the planner can use
-- posts_feed_idx. A function call here would defeat index usage on list queries.
create policy posts_select
  on public.posts for select
  to anon, authenticated
  using (
    author_id = auth.uid()
    or app.is_moderator()
    or (
      deleted_at is null
      and moderation_status = 'active'
      and not app.is_blocked_either_way(author_id, auth.uid())
      and (
        visibility = 'public'
        or (visibility = 'university' and app.share_university(author_id, auth.uid()))
        or (visibility = 'connections' and app.are_connected(author_id, auth.uid()))
      )
    )
  );

create policy posts_insert_own
  on public.posts for insert
  to authenticated
  with check (author_id = auth.uid());

create policy posts_update_own
  on public.posts for update
  to authenticated
  using (author_id = auth.uid() and deleted_at is null)
  with check (author_id = auth.uid());

create policy posts_update_moderator
  on public.posts for update
  to authenticated
  using (app.is_moderator()) with check (app.is_moderator());

-- Author deletion is a soft delete (UPDATE deleted_at); hard DELETE is
-- moderator-only so that reported content survives long enough to be reviewed.
create policy posts_delete_moderator
  on public.posts for delete
  to authenticated
  using (app.is_moderator());

revoke all on table public.posts from anon, authenticated;
grant select on table public.posts to anon, authenticated;
grant insert on table public.posts to authenticated;
grant update (body, title, link_url, type, visibility, project_id,
              is_edited, edited_at, updated_at, deleted_at)
  on table public.posts to authenticated;
grant delete on table public.posts to authenticated;


-- =============================================================================
-- post_media
-- =============================================================================

create table public.post_media (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references public.posts (id) on delete cascade,
  storage_path text not null,
  mime_type    text not null check (mime_type in ('image/jpeg', 'image/png',
                                                  'image/webp', 'image/gif')),
  size_bytes   integer not null check (size_bytes > 0 and size_bytes <= 5242880),
  width        integer check (width  > 0),
  height       integer check (height > 0),
  alt_text     text check (length(alt_text) <= 500),
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);

create index post_media_post_idx on public.post_media (post_id, sort_order);

alter table public.post_media enable row level security;

create policy post_media_select
  on public.post_media for select
  to anon, authenticated
  using (app.can_view_post(post_id));

create policy post_media_write_own
  on public.post_media for all
  to authenticated
  using (exists (select 1 from public.posts p
                 where p.id = post_media.post_id and p.author_id = auth.uid()))
  with check (exists (select 1 from public.posts p
                      where p.id = post_media.post_id and p.author_id = auth.uid()));

revoke all on table public.post_media from anon, authenticated;
grant select on table public.post_media to anon, authenticated;
grant insert, update, delete on table public.post_media to authenticated;


-- =============================================================================
-- post_likes / post_saves
-- =============================================================================

create table public.post_likes (
  post_id    uuid not null references public.posts (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, profile_id)
);

create index post_likes_profile_idx on public.post_likes (profile_id, created_at desc);

create table public.post_saves (
  post_id    uuid not null references public.posts (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, profile_id)
);

create index post_saves_profile_idx on public.post_saves (profile_id, created_at desc);


create or replace function app.sync_post_like_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set like_count = like_count + 1 where id = new.post_id;
  else
    update public.posts set like_count = greatest(like_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

create or replace function app.sync_post_save_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set save_count = save_count + 1 where id = new.post_id;
  else
    update public.posts set save_count = greatest(save_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

revoke execute on function app.sync_post_like_count() from public;
revoke execute on function app.sync_post_save_count() from public;

create trigger post_likes_sync_count
  after insert or delete on public.post_likes
  for each row execute function app.sync_post_like_count();

create trigger post_saves_sync_count
  after insert or delete on public.post_saves
  for each row execute function app.sync_post_save_count();


alter table public.post_likes enable row level security;
alter table public.post_saves enable row level security;

create policy post_likes_select
  on public.post_likes for select
  to anon, authenticated
  using (app.can_view_post(post_id));

create policy post_likes_insert_own
  on public.post_likes for insert
  to authenticated
  with check (profile_id = auth.uid() and app.can_view_post(post_id));

create policy post_likes_delete_own
  on public.post_likes for delete
  to authenticated
  using (profile_id = auth.uid());

-- Saves are private: nobody sees what you bookmarked.
create policy post_saves_select_own
  on public.post_saves for select
  to authenticated
  using (profile_id = auth.uid());

create policy post_saves_insert_own
  on public.post_saves for insert
  to authenticated
  with check (profile_id = auth.uid() and app.can_view_post(post_id));

create policy post_saves_delete_own
  on public.post_saves for delete
  to authenticated
  using (profile_id = auth.uid());

revoke all on table public.post_likes from anon, authenticated;
grant select on table public.post_likes to anon, authenticated;
grant insert, delete on table public.post_likes to authenticated;

revoke all on table public.post_saves from anon, authenticated;
grant select, insert, delete on table public.post_saves to authenticated;


-- =============================================================================
-- comments  (one level of replies — flat threads beyond depth 1 are unreadable
--            on mobile and unbounded to paginate)
-- =============================================================================

create table public.comments (
  id        uuid primary key default gen_random_uuid(),
  post_id   uuid not null references public.posts (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  parent_id uuid references public.comments (id) on delete cascade,

  body text not null check (length(btrim(body)) between 1 and 2000),

  like_count  integer not null default 0,
  reply_count integer not null default 0,

  is_edited boolean not null default false,
  moderation_status text not null default 'active'
                    check (moderation_status in ('active', 'hidden', 'removed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index comments_post_idx
  on public.comments (post_id, created_at asc, id asc)
  where parent_id is null and deleted_at is null;

create index comments_parent_idx
  on public.comments (parent_id, created_at asc, id asc)
  where deleted_at is null;

create index comments_author_idx on public.comments (author_id, created_at desc);

create trigger comments_set_updated_at
  before update on public.comments
  for each row execute function app.set_updated_at();


create or replace function app.comments_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_post   uuid;
  v_parent_parent uuid;
begin
  if tg_op = 'INSERT' and not app.is_privileged_role() then
    new.author_id := auth.uid();
    new.like_count := 0;
    new.reply_count := 0;
    new.moderation_status := 'active';
  end if;

  if new.parent_id is not null then
    select c.post_id, c.parent_id into v_parent_post, v_parent_parent
      from public.comments c where c.id = new.parent_id;

    if v_parent_post is null then
      raise exception 'parent comment does not exist' using errcode = '23503';
    end if;

    -- Depth is capped at 1: a reply cannot itself be replied to.
    if v_parent_parent is not null then
      raise exception 'replies cannot be nested more than one level deep'
        using errcode = '23514', hint = 'max_depth';
    end if;

    -- A reply always belongs to the same post as its parent.
    new.post_id := v_parent_post;
  end if;

  if tg_op = 'UPDATE' and new.body is distinct from old.body then
    new.is_edited := true;
  end if;

  return new;
end;
$$;

revoke execute on function app.comments_before_write() from public;

create trigger comments_before_write
  before insert or update on public.comments
  for each row execute function app.comments_before_write();

create trigger comments_protect_columns
  before update on public.comments
  for each row execute function app.reject_protected_column_change(
    'id', 'post_id', 'author_id', 'parent_id', 'created_at',
    'like_count', 'reply_count'
  );


create or replace function app.sync_comment_counts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was_live boolean := (tg_op <> 'INSERT'
                         and old.deleted_at is null and old.moderation_status = 'active');
  v_is_live  boolean := (tg_op <> 'DELETE'
                         and new.deleted_at is null and new.moderation_status = 'active');
  v_delta    integer;
begin
  if v_was_live = v_is_live then
    return null;
  end if;

  v_delta := case when v_is_live then 1 else -1 end;

  if v_is_live then
    update public.posts set comment_count = comment_count + 1 where id = new.post_id;
    if new.parent_id is not null then
      update public.comments set reply_count = reply_count + 1 where id = new.parent_id;
    end if;
  else
    update public.posts set comment_count = greatest(comment_count - 1, 0)
      where id = old.post_id;
    if old.parent_id is not null then
      update public.comments set reply_count = greatest(reply_count - 1, 0)
        where id = old.parent_id;
    end if;
  end if;

  return null;
end;
$$;

revoke execute on function app.sync_comment_counts() from public;

create trigger comments_sync_counts
  after insert or update or delete on public.comments
  for each row execute function app.sync_comment_counts();


alter table public.comments enable row level security;

create policy comments_select
  on public.comments for select
  to anon, authenticated
  using (
    app.can_view_post(post_id)
    and (
      author_id = auth.uid()
      or app.is_moderator()
      or (deleted_at is null
          and moderation_status = 'active'
          and not app.is_blocked_either_way(author_id, auth.uid()))
    )
  );

create policy comments_insert_own
  on public.comments for insert
  to authenticated
  with check (author_id = auth.uid() and app.can_view_post(post_id));

create policy comments_update_own
  on public.comments for update
  to authenticated
  using (author_id = auth.uid() and deleted_at is null)
  with check (author_id = auth.uid());

create policy comments_update_moderator
  on public.comments for update
  to authenticated
  using (app.is_moderator()) with check (app.is_moderator());

-- Post authors moderate their own threads; that is a genuine need, not a
-- convenience. Comment authors soft-delete via UPDATE.
create policy comments_delete_own_or_post_author
  on public.comments for delete
  to authenticated
  using (
    author_id = auth.uid()
    or app.is_moderator()
    or exists (select 1 from public.posts p
               where p.id = comments.post_id and p.author_id = auth.uid())
  );

revoke all on table public.comments from anon, authenticated;
grant select on table public.comments to anon, authenticated;
grant insert, delete on table public.comments to authenticated;
grant update (body, is_edited, updated_at, deleted_at)
  on table public.comments to authenticated;


-- =============================================================================
-- comment_likes
-- =============================================================================

create table public.comment_likes (
  comment_id uuid not null references public.comments (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, profile_id)
);

create or replace function app.sync_comment_like_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.comments set like_count = like_count + 1 where id = new.comment_id;
  else
    update public.comments set like_count = greatest(like_count - 1, 0)
      where id = old.comment_id;
  end if;
  return null;
end;
$$;

revoke execute on function app.sync_comment_like_count() from public;

create trigger comment_likes_sync_count
  after insert or delete on public.comment_likes
  for each row execute function app.sync_comment_like_count();

alter table public.comment_likes enable row level security;

create policy comment_likes_select
  on public.comment_likes for select
  to anon, authenticated
  using (exists (select 1 from public.comments c
                 where c.id = comment_likes.comment_id and app.can_view_post(c.post_id)));

create policy comment_likes_insert_own
  on public.comment_likes for insert
  to authenticated
  with check (
    profile_id = auth.uid()
    and exists (select 1 from public.comments c
                where c.id = comment_likes.comment_id and app.can_view_post(c.post_id))
  );

create policy comment_likes_delete_own
  on public.comment_likes for delete
  to authenticated
  using (profile_id = auth.uid());

revoke all on table public.comment_likes from anon, authenticated;
grant select on table public.comment_likes to anon, authenticated;
grant insert, delete on table public.comment_likes to authenticated;
