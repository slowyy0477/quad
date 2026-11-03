-- One bounded HTTP read for the replies beneath a page of top-level comments.
-- Existing comments_parent_idx supplies the ordered parent keyset. All reads
-- stay SECURITY INVOKER: a cursor or known private UUID never grants access.
create function public.comment_reply_pages(
  p_parent_ids uuid[],
  p_limit integer default 10,
  p_focus_parent uuid default null,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null
)
returns table (parent_id uuid, comments jsonb, has_more boolean)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_parent uuid;
begin
  if p_parent_ids is null or cardinality(p_parent_ids) > 30
     or array_position(p_parent_ids, null) is not null
     or p_limit is null or p_limit < 1 or p_limit > 20
     or (p_after_created_at is null) <> (p_after_id is null)
     or (p_after_id is not null and
         (p_focus_parent is null or not p_focus_parent = any(p_parent_ids))) then
    raise exception 'Invalid reply page'
      using errcode = '22023', hint = 'invalid_reply_page';
  end if;

  for v_parent in
    select c.id from public.comments c
    where c.id = any(p_parent_ids) and c.parent_id is null
      and c.deleted_at is null and c.moderation_status = 'active'
    order by c.created_at, c.id
  loop
    return query
    with bounded as (
      select c.id, c.parent_id, c.body, c.like_count, c.reply_count,
             c.is_edited, c.created_at, c.author_id
      from public.comments c
      where c.parent_id = v_parent
        and c.deleted_at is null and c.moderation_status = 'active'
        and (p_focus_parent is distinct from v_parent or p_after_id is null
             or (c.created_at, c.id) > (p_after_created_at, p_after_id))
      order by c.created_at, c.id
      limit p_limit + 1
    ), numbered as (
      select b.*, row_number() over (order by b.created_at, b.id) as ordinal
      from bounded b
    )
    select v_parent,
      coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'parent_id', r.parent_id, 'body', r.body,
        'like_count', r.like_count, 'reply_count', r.reply_count,
        'is_edited', r.is_edited, 'created_at', r.created_at,
        'author', (
          select jsonb_build_object(
            'id', a.id, 'username', a.username, 'display_name', a.display_name,
            'avatar_url', a.avatar_url, 'headline', a.headline
          )
          from public.profiles a where a.id = r.author_id
        )
      ) order by r.created_at, r.id) filter (where r.ordinal <= p_limit), '[]'::jsonb),
      count(*) > p_limit
    from numbered r;
  end loop;
end;
$$;

revoke execute on function public.comment_reply_pages(uuid[], integer, uuid, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.comment_reply_pages(uuid[], integer, uuid, timestamptz, uuid)
  to anon, authenticated, service_role;
