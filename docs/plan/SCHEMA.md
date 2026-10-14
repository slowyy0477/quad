# Schema reference

**Generated** by `npm run db:schema:local` from the migrations. Do not edit by hand.

Not a substitute for reading a migration — the migrations carry the reasoning, this
carries the shape. Use it to write a query without opening 17 files; use the migration
when you need to know *why* a column exists or which policy governs it.

**52 tables, 0 views, 0 enums, 10 functions in `public`.

## Tables

### achievement_definitions

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `key` | text | no |  |
| `name` | text | no |  |
| `description` | text | no |  |
| `criteria` | text | no |  |
| `category` | text | no |  |
| `tier` | text | no | `'bronze'::text` |
| `icon` | text | no |  |
| `sort_order` | int4 | no | `0` |
| `is_active` | bool | no | `true` |
| `created_at` | timestamptz | no | `now()` |

### blocks

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `blocker_id` | uuid | no |  |
| `blocked_id` | uuid | no |  |
| `reason` | text | yes |  |
| `created_at` | timestamptz | no | `now()` |

References: `blocked_id` → `profiles.id`, `blocker_id` → `profiles.id`

### comment_likes

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `comment_id` | uuid | no |  |
| `profile_id` | uuid | no |  |
| `created_at` | timestamptz | no | `now()` |

References: `comment_id` → `comments.id`, `profile_id` → `profiles.id`

### comments

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `post_id` | uuid | no |  |
| `author_id` | uuid | no |  |
| `parent_id` | uuid | yes |  |
| `body` | text | no |  |
| `like_count` | int4 | no | `0` |
| `reply_count` | int4 | no | `0` |
| `is_edited` | bool | no | `false` |
| `moderation_status` | text | no | `'active'::text` |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |
| `deleted_at` | timestamptz | yes |  |

References: `author_id` → `profiles.id`, `parent_id` → `comments.id`, `post_id` → `posts.id`

### connections

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `requester_id` | uuid | no |  |
| `addressee_id` | uuid | no |  |
| `status` | text | no | `'pending'::text` |
| `message` | text | yes |  |
| `pair_low` | uuid | no |  |
| `pair_high` | uuid | no |  |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |
| `responded_at` | timestamptz | yes |  |

References: `addressee_id` → `profiles.id`, `requester_id` → `profiles.id`

### conversation_participants

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `conversation_id` | uuid | no |  |
| `profile_id` | uuid | no |  |
| `role` | text | no | `'member'::text` |
| `last_read_at` | timestamptz | yes |  |
| `unread_count` | int4 | no | `0` |
| `is_muted` | bool | no | `false` |
| `left_at` | timestamptz | yes |  |
| `joined_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `conversation_id` → `conversations.id`, `profile_id` → `profiles.id`

### conversations

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `type` | text | no | `'direct'::text` |
| `title` | text | yes |  |
| `created_by` | uuid | yes |  |
| `last_message_at` | timestamptz | yes |  |
| `last_message_id` | uuid | yes |  |
| `last_message_preview` | text | yes |  |
| `pair_low` | uuid | yes |  |
| `pair_high` | uuid | yes |  |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `created_by` → `profiles.id`

### courses

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `profile_id` | uuid | no |  |
| `semester_id` | uuid | yes |  |
| `code` | text | yes |  |
| `title` | text | no |  |
| `instructor` | text | yes |  |
| `credits` | numeric | yes |  |
| `status` | text | no | `'in_progress'::text` |
| `grade` | text | yes |  |
| `color` | text | yes |  |
| `notes` | text | yes |  |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `profile_id` → `profiles.id`, `semester_id` → `semesters.id`

### daily_logs

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `profile_id` | uuid | no |  |
| `log_date` | date | no |  |
| `mood` | int2 | yes |  |
| `productivity` | int2 | yes |  |
| `hours_studied` | numeric | yes |  |
| `summary` | text | yes |  |
| `wins` | text | yes |  |
| `blockers` | text | yes |  |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `profile_id` → `profiles.id`

### departments

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `university_id` | uuid | no |  |
| `name` | text | no |  |
| `slug` | text | no |  |
| `is_verified` | bool | no | `false` |
| `created_by` | uuid | yes |  |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `university_id` → `universities.id`

### event_attendees

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `event_id` | uuid | no |  |
| `profile_id` | uuid | no |  |
| `status` | text | no | `'going'::text` |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `event_id` → `events.id`, `profile_id` → `profiles.id`

### events

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `slug` | text | no |  |
| `created_by` | uuid | no |  |
| `title` | text | no |  |
| `description` | text | yes |  |
| `type` | text | no | `'other'::text` |
| `starts_at` | timestamptz | no |  |
| `ends_at` | timestamptz | yes |  |
| `time_zone` | text | no | `'UTC'::text` |
| `is_all_day` | bool | no | `false` |
| `attendance_mode` | text | no | `'onsite'::text` |
| `location` | text | yes |  |
| `location_url` | text | yes |  |
| `join_url` | text | yes |  |
| `project_id` | uuid | yes |  |
| `university_id` | uuid | yes |  |
| `visibility` | text | no | `'public'::text` |
| `capacity` | int4 | yes |  |
| `attendee_count` | int4 | no | `0` |
| `interested_count` | int4 | no | `0` |
| `status` | text | no | `'scheduled'::text` |
| `moderation_status` | text | no | `'active'::text` |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |
| `deleted_at` | timestamptz | yes |  |

References: `created_by` → `profiles.id`, `project_id` → `projects.id`, `university_id` → `universities.id`

### follows

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `follower_id` | uuid | no |  |
| `following_id` | uuid | no |  |
| `created_at` | timestamptz | no | `now()` |

References: `follower_id` → `profiles.id`, `following_id` → `profiles.id`

### goal_milestones

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `goal_id` | uuid | no |  |
| `title` | text | no |  |
| `is_completed` | bool | no | `false` |
| `completed_at` | timestamptz | yes |  |
| `target_date` | date | yes |  |
| `sort_order` | int4 | no | `0` |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `goal_id` → `goals.id`

### goals

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `profile_id` | uuid | no |  |
| `title` | text | no |  |
| `description` | text | yes |  |
| `category` | text | no | `'other'::text` |
| `status` | text | no | `'active'::text` |
| `target_value` | numeric | no | `100` |
| `current_value` | numeric | no | `0` |
| `unit` | text | yes |  |
| `progress_percent` | int4 | yes |  |
| `course_id` | uuid | yes |  |
| `semester_id` | uuid | yes |  |
| `project_id` | uuid | yes |  |
| `visibility` | text | no | `'private'::text` |
| `start_date` | date | yes |  |
| `target_date` | date | yes |  |
| `completed_at` | timestamptz | yes |  |
| `milestone_count` | int4 | no | `0` |
| `completed_milestone_count` | int4 | no | `0` |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `course_id` → `courses.id`, `profile_id` → `profiles.id`, `project_id` → `projects.id`, `semester_id` → `semesters.id`

### idea_comments

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `idea_id` | uuid | no |  |
| `author_id` | uuid | no |  |
| `body` | text | no |  |
| `is_edited` | bool | no | `false` |
| `moderation_status` | text | no | `'active'::text` |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |
| `deleted_at` | timestamptz | yes |  |

References: `author_id` → `profiles.id`, `idea_id` → `ideas.id`

### idea_interest

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `idea_id` | uuid | no |  |
| `profile_id` | uuid | no |  |
| `message` | text | yes |  |
| `offering` | text | yes |  |
| `created_at` | timestamptz | no | `now()` |

References: `idea_id` → `ideas.id`, `profile_id` → `profiles.id`

### idea_skills

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `idea_id` | uuid | no |  |
| `skill_id` | uuid | no |  |
| `created_at` | timestamptz | no | `now()` |

References: `idea_id` → `ideas.id`, `skill_id` → `skills.id`

### idea_votes

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `idea_id` | uuid | no |  |
| `profile_id` | uuid | no |  |
| `created_at` | timestamptz | no | `now()` |

References: `idea_id` → `ideas.id`, `profile_id` → `profiles.id`

### ideas

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `author_id` | uuid | no |  |
| `title` | text | no |  |
| `description` | text | no |  |
| `category` | text | no | `'other'::text` |
| `looking_for` | text | yes |  |
| `status` | text | no | `'open'::text` |
| `visibility` | text | no | `'public'::text` |
| `university_id` | uuid | yes |  |
| `converted_project_id` | uuid | yes |  |
| `converted_at` | timestamptz | yes |  |
| `upvote_count` | int4 | no | `0` |
| `comment_count` | int4 | no | `0` |
| `interest_count` | int4 | no | `0` |
| `moderation_status` | text | no | `'active'::text` |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |
| `deleted_at` | timestamptz | yes |  |

References: `author_id` → `profiles.id`, `converted_project_id` → `projects.id`, `university_id` → `universities.id`

### interests

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `name` | text | no |  |
| `slug` | text | no |  |
| `category` | text | no | `'other'::text` |
| `is_approved` | bool | no | `false` |
| `usage_count` | int4 | no | `0` |
| `created_by` | uuid | yes |  |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `created_by` → `profiles.id`

### messages

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `conversation_id` | uuid | no |  |
| `sender_id` | uuid | no |  |
| `body` | text | yes |  |
| `attachment_path` | text | yes |  |
| `attachment_mime` | text | yes |  |
| `attachment_size` | int4 | yes |  |
| `attachment_name` | text | yes |  |
| `reply_to_id` | uuid | yes |  |
| `is_edited` | bool | no | `false` |
| `edited_at` | timestamptz | yes |  |
| `deleted_at` | timestamptz | yes |  |
| `moderation_status` | text | no | `'active'::text` |
| `created_at` | timestamptz | no | `now()` |

References: `conversation_id` → `conversations.id`, `reply_to_id` → `messages.id`, `sender_id` → `profiles.id`

### notification_categories

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `category` | text | no |  |
| `label` | text | no |  |
| `description` | text | no |  |
| `is_suppressible` | bool | no | `true` |
| `sort_order` | int4 | no | `100` |

### notification_preferences

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `profile_id` | uuid | no |  |
| `category` | text | no |  |
| `in_app_enabled` | bool | no | `true` |
| `updated_at` | timestamptz | no | `now()` |

References: `category` → `notification_categories.category`, `profile_id` → `profiles.id`

### notification_types

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `type` | text | no |  |
| `category` | text | no |  |
| `resurfaces` | bool | no | `false` |
| `sort_order` | int4 | no | `100` |

References: `category` → `notification_categories.category`

### notifications

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `recipient_id` | uuid | no |  |
| `type` | text | no |  |
| `actor_id` | uuid | yes |  |
| `post_id` | uuid | yes |  |
| `comment_id` | uuid | yes |  |
| `project_id` | uuid | yes |  |
| `idea_id` | uuid | yes |  |
| `event_id` | uuid | yes |  |
| `opportunity_id` | uuid | yes |  |
| `conversation_id` | uuid | yes |  |
| `skill_id` | uuid | yes |  |
| `achievement_key` | text | yes |  |
| `body` | text | yes |  |
| `is_read` | bool | no | `false` |
| `read_at` | timestamptz | yes |  |
| `created_at` | timestamptz | no | `now()` |

References: `achievement_key` → `achievement_definitions.key`, `actor_id` → `profiles.id`, `comment_id` → `comments.id`, `conversation_id` → `conversations.id`, `event_id` → `events.id`, `idea_id` → `ideas.id`, `opportunity_id` → `opportunities.id`, `post_id` → `posts.id`, `project_id` → `projects.id`, `recipient_id` → `profiles.id`, `skill_id` → `skills.id`, `type` → `notification_types.type`

### opportunities

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `slug` | text | no |  |
| `posted_by` | uuid | no |  |
| `title` | text | no |  |
| `organisation` | text | no |  |
| `description` | text | no |  |
| `type` | text | no |  |
| `compensation` | text | yes |  |
| `work_mode` | text | no | `'onsite'::text` |
| `location` | text | yes |  |
| `apply_url` | text | yes |  |
| `apply_email` | text | yes |  |
| `deadline` | date | yes |  |
| `starts_on` | date | yes |  |
| `university_id` | uuid | yes |  |
| `visibility` | text | no | `'public'::text` |
| `status` | text | no | `'open'::text` |
| `source` | text | no | `'user_submitted'::text` |
| `save_count` | int4 | no | `0` |
| `moderation_status` | text | no | `'active'::text` |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |
| `deleted_at` | timestamptz | yes |  |

References: `posted_by` → `profiles.id`, `university_id` → `universities.id`

### opportunity_saves

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `opportunity_id` | uuid | no |  |
| `profile_id` | uuid | no |  |
| `note` | text | yes |  |
| `created_at` | timestamptz | no | `now()` |

References: `opportunity_id` → `opportunities.id`, `profile_id` → `profiles.id`

### opportunity_skills

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `opportunity_id` | uuid | no |  |
| `skill_id` | uuid | no |  |
| `is_required` | bool | no | `false` |
| `created_at` | timestamptz | no | `now()` |

References: `opportunity_id` → `opportunities.id`, `skill_id` → `skills.id`

### post_likes

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `post_id` | uuid | no |  |
| `profile_id` | uuid | no |  |
| `created_at` | timestamptz | no | `now()` |

References: `post_id` → `posts.id`, `profile_id` → `profiles.id`

### post_media

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `post_id` | uuid | no |  |
| `storage_path` | text | no |  |
| `mime_type` | text | no |  |
| `size_bytes` | int4 | no |  |
| `width` | int4 | yes |  |
| `height` | int4 | yes |  |
| `alt_text` | text | yes |  |
| `sort_order` | int4 | no | `0` |
| `created_at` | timestamptz | no | `now()` |

References: `post_id` → `posts.id`

### post_saves

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `post_id` | uuid | no |  |
| `profile_id` | uuid | no |  |
| `created_at` | timestamptz | no | `now()` |

References: `post_id` → `posts.id`, `profile_id` → `profiles.id`

### posts

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `author_id` | uuid | no |  |
| `type` | text | no | `'text'::text` |
| `body` | text | yes |  |
| `title` | text | yes |  |
| `link_url` | text | yes |  |
| `project_id` | uuid | yes |  |
| `achievement_key` | text | yes |  |
| `goal_id` | uuid | yes |  |
| `opportunity_id` | uuid | yes |  |
| `university_id` | uuid | yes |  |
| `visibility` | text | no | `'public'::text` |
| `like_count` | int4 | no | `0` |
| `comment_count` | int4 | no | `0` |
| `save_count` | int4 | no | `0` |
| `is_edited` | bool | no | `false` |
| `edited_at` | timestamptz | yes |  |
| `moderation_status` | text | no | `'active'::text` |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |
| `deleted_at` | timestamptz | yes |  |

References: `achievement_key` → `achievement_definitions.key`, `author_id` → `profiles.id`, `goal_id` → `goals.id`, `opportunity_id` → `opportunities.id`, `project_id` → `projects.id`, `university_id` → `universities.id`

### profile_achievements

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `profile_id` | uuid | no |  |
| `achievement_key` | text | no |  |
| `awarded_at` | timestamptz | no | `now()` |
| `awarded_value` | int4 | yes |  |
| `is_pinned` | bool | no | `false` |

References: `achievement_key` → `achievement_definitions.key`, `profile_id` → `profiles.id`

### profile_interests

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `profile_id` | uuid | no |  |
| `interest_id` | uuid | no |  |
| `created_at` | timestamptz | no | `now()` |

References: `interest_id` → `interests.id`, `profile_id` → `profiles.id`

### profile_skill_endorsements

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `profile_id` | uuid | no |  |
| `skill_id` | uuid | no |  |
| `endorser_id` | uuid | no |  |
| `created_at` | timestamptz | no | `now()` |

References: `endorser_id` → `profiles.id`, `profile_id` → `profile_skills.profile_id`, `profile_id` → `profile_skills.skill_id`, `skill_id` → `profile_skills.profile_id`, `skill_id` → `profile_skills.skill_id`

### profile_skills

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `profile_id` | uuid | no |  |
| `skill_id` | uuid | no |  |
| `level` | text | no | `'learning'::text` |
| `is_learning` | bool | no | `false` |
| `years_experience` | numeric | yes |  |
| `display_order` | int4 | no | `0` |
| `endorsement_count` | int4 | no | `0` |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `profile_id` → `profiles.id`, `skill_id` → `skills.id`

### profiles

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `username` | text | no |  |
| `display_name` | text | no |  |
| `avatar_url` | text | yes |  |
| `cover_url` | text | yes |  |
| `headline` | text | yes |  |
| `bio` | text | yes |  |
| `university_id` | uuid | yes |  |
| `department_id` | uuid | yes |  |
| `program_id` | uuid | yes |  |
| `degree` | text | yes |  |
| `semester` | int4 | yes |  |
| `graduation_year` | int4 | yes |  |
| `location` | text | yes |  |
| `website` | text | yes |  |
| `github_username` | text | yes |  |
| `linkedin_url` | text | yes |  |
| `twitter_username` | text | yes |  |
| `visibility` | text | no | `'public'::text` |
| `allow_messages_from` | text | no | `'everyone'::text` |
| `allow_connection_requests` | bool | no | `true` |
| `searchable` | bool | no | `true` |
| `onboarding_completed` | bool | no | `false` |
| `onboarding_step` | int4 | no | `0` |
| `status` | text | no | `'active'::text` |
| `suspended_until` | timestamptz | yes |  |
| `suspension_reason` | text | yes |  |
| `warning_count` | int4 | no | `0` |
| `username_changed_at` | timestamptz | yes |  |
| `follower_count` | int4 | no | `0` |
| `following_count` | int4 | no | `0` |
| `connection_count` | int4 | no | `0` |
| `post_count` | int4 | no | `0` |
| `project_count` | int4 | no | `0` |
| `last_active_at` | timestamptz | no | `now()` |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |
| `deleted_at` | timestamptz | yes |  |

References: `department_id` → `departments.id`, `program_id` → `programs.id`, `university_id` → `universities.id`

### programs

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `department_id` | uuid | no |  |
| `name` | text | no |  |
| `slug` | text | no |  |
| `degree_type` | text | no | `'bachelor'::text` |
| `duration_semesters` | int4 | yes |  |
| `is_verified` | bool | no | `false` |
| `created_by` | uuid | yes |  |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `department_id` → `departments.id`

### project_applications

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `project_id` | uuid | no |  |
| `applicant_id` | uuid | no |  |
| `message` | text | yes |  |
| `desired_role` | text | yes |  |
| `status` | text | no | `'pending'::text` |
| `reviewed_by` | uuid | yes |  |
| `reviewed_at` | timestamptz | yes |  |
| `review_note` | text | yes |  |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `applicant_id` → `profiles.id`, `project_id` → `projects.id`, `reviewed_by` → `profiles.id`

### project_invites

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `project_id` | uuid | no |  |
| `invitee_id` | uuid | no |  |
| `inviter_id` | uuid | no |  |
| `message` | text | yes |  |
| `proposed_role` | text | yes |  |
| `status` | text | no | `'pending'::text` |
| `responded_at` | timestamptz | yes |  |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `invitee_id` → `profiles.id`, `inviter_id` → `profiles.id`, `project_id` → `projects.id`

### project_media

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `project_id` | uuid | no |  |
| `storage_path` | text | no |  |
| `mime_type` | text | no |  |
| `size_bytes` | int4 | no |  |
| `width` | int4 | yes |  |
| `height` | int4 | yes |  |
| `alt_text` | text | yes |  |
| `display_order` | int4 | no | `0` |
| `uploaded_by` | uuid | yes |  |
| `created_at` | timestamptz | no | `now()` |

References: `project_id` → `projects.id`, `uploaded_by` → `profiles.id`

### project_members

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `project_id` | uuid | no |  |
| `profile_id` | uuid | no |  |
| `role` | text | no | `'member'::text` |
| `title` | text | yes |  |
| `invited_by` | uuid | yes |  |
| `joined_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `invited_by` → `profiles.id`, `profile_id` → `profiles.id`, `project_id` → `projects.id`

### project_skills

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `project_id` | uuid | no |  |
| `skill_id` | uuid | no |  |
| `is_required` | bool | no | `false` |
| `created_at` | timestamptz | no | `now()` |

References: `project_id` → `projects.id`, `skill_id` → `skills.id`

### project_stars

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `project_id` | uuid | no |  |
| `profile_id` | uuid | no |  |
| `created_at` | timestamptz | no | `now()` |

References: `profile_id` → `profiles.id`, `project_id` → `projects.id`

### projects

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `owner_id` | uuid | no |  |
| `title` | text | no |  |
| `slug` | text | no |  |
| `tagline` | text | yes |  |
| `description` | text | yes |  |
| `category` | text | no | `'other'::text` |
| `status` | text | no | `'planning'::text` |
| `visibility` | text | no | `'public'::text` |
| `university_id` | uuid | yes |  |
| `cover_url` | text | yes |  |
| `repo_url` | text | yes |  |
| `demo_url` | text | yes |  |
| `is_seeking_members` | bool | no | `false` |
| `looking_for` | text | yes |  |
| `team_size_target` | int4 | yes |  |
| `started_at` | date | yes |  |
| `completed_at` | date | yes |  |
| `member_count` | int4 | no | `0` |
| `star_count` | int4 | no | `0` |
| `application_count` | int4 | no | `0` |
| `post_count` | int4 | no | `0` |
| `moderation_status` | text | no | `'active'::text` |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |
| `deleted_at` | timestamptz | yes |  |

References: `owner_id` → `profiles.id`, `university_id` → `universities.id`

### reserved_usernames

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `username` | text | no |  |
| `reason` | text | no | `'reserved'::text` |

### semesters

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `profile_id` | uuid | no |  |
| `name` | text | no |  |
| `term` | text | yes |  |
| `year` | int4 | yes |  |
| `start_date` | date | yes |  |
| `end_date` | date | yes |  |
| `is_current` | bool | no | `false` |
| `notes` | text | yes |  |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `profile_id` → `profiles.id`

### skills

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `name` | text | no |  |
| `slug` | text | no |  |
| `category` | text | no | `'other'::text` |
| `description` | text | yes |  |
| `is_approved` | bool | no | `false` |
| `usage_count` | int4 | no | `0` |
| `created_by` | uuid | yes |  |
| `reviewed_by` | uuid | yes |  |
| `reviewed_at` | timestamptz | yes |  |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

References: `created_by` → `profiles.id`, `reviewed_by` → `profiles.id`

### study_sessions

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `profile_id` | uuid | no |  |
| `course_id` | uuid | yes |  |
| `goal_id` | uuid | yes |  |
| `started_at` | timestamptz | no | `now()` |
| `duration_minutes` | int4 | no |  |
| `ended_at` | timestamptz | no |  |
| `focus_rating` | int2 | yes |  |
| `notes` | text | yes |  |
| `created_at` | timestamptz | no | `now()` |

References: `course_id` → `courses.id`, `goal_id` → `goals.id`, `profile_id` → `profiles.id`

### universities

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `slug` | text | no |  |
| `name` | text | no |  |
| `short_name` | text | yes |  |
| `country` | text | yes |  |
| `city` | text | yes |  |
| `website` | text | yes |  |
| `logo_url` | text | yes |  |
| `description` | text | yes |  |
| `email_domains` | _text | no | `'{}'::text[]` |
| `status` | text | no | `'pending'::text` |
| `rejection_reason` | text | yes |  |
| `submitted_by` | uuid | yes |  |
| `reviewed_by` | uuid | yes |  |
| `reviewed_at` | timestamptz | yes |  |
| `student_count` | int4 | no | `0` |
| `project_count` | int4 | no | `0` |
| `normalized_name` | text | yes |  |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

### user_roles

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `user_id` | uuid | no |  |
| `role` | text | no |  |
| `granted_by` | uuid | yes |  |
| `granted_at` | timestamptz | no | `now()` |
| `note` | text | yes |  |

## Enums


## Functions in `public`

- `convert_idea_to_project(p_idea_id uuid)` → uuid
- `create_group_conversation(p_title text, p_members uuid[] DEFAULT '{}'::uuid[])` → uuid
- `current_study_streak()` → integer
- `dispatch_due_reminders(v_event_window interval DEFAULT '24:00:00'::interval, v_opportunity_window interval DEFAULT '48:00:00'::interval)` → integer
- `mark_conversation_read(p_conversation_id uuid)` → void
- `start_direct_conversation(p_other_user uuid)` → uuid
- `total_unread_messages()` → integer
- `touch_last_active()` → void
- `transfer_project_ownership(p_project_id uuid, p_new_owner uuid)` → void
- `unread_notification_count()` → integer
