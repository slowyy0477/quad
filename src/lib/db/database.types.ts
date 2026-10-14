/**
 * Generated database types. **Do not edit by hand.**
 *
 *   npm run db:types:local     # regenerate from supabase/migrations (no network, no Docker)
 *   npm run db:types           # regenerate from a linked Supabase project (preferred)
 *
 * Derived from 17 migrations by scripts/db/schema.mjs, applying the real
 * SQL to PostgreSQL 18 in-process — the same path the permission suite takes, so the
 * types and the tests cannot disagree about what the schema is.
 *
 * Why the file exists at all: before it, every `queries.ts` declared its own row
 * shapes against 52 tables and TypeScript could not catch a renamed column, a dropped
 * one, or a column that became nullable. A schema change now fails the build at the
 * exact call site that needs attention.
 *
 * Limitations, stated rather than discovered later:
 *   * Function argument names come from `pg_get_function_arguments`; a function whose
 *     arguments are unnamed is not representable and is mapped to `[_ in never]`.
 *   * Return types that are not a single column (TABLE(...), SETOF) are
 *     `Record<string, unknown>[]`. Add an explicit interface at the call site when a
 *     function's result matters — guessing here would compile and lie.
 *   * The `app` schema is not emitted: it is not exposed through PostgREST, and the
 *     application never queries it directly.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  public: {
    Tables: {
      achievement_definitions: {
        Row: {
          "key": string
          "name": string
          "description": string
          "criteria": string
          "category": string
          "tier": string
          "icon": string
          "sort_order": number
          "is_active": boolean
          "created_at": string
        }
        Insert: {
          "key": string
          "name": string
          "description": string
          "criteria": string
          "category": string
          "tier"?: string
          "icon": string
          "sort_order"?: number
          "is_active"?: boolean
          "created_at"?: string
        }
        Update: {
          "key"?: string
          "name"?: string
          "description"?: string
          "criteria"?: string
          "category"?: string
          "tier"?: string
          "icon"?: string
          "sort_order"?: number
          "is_active"?: boolean
          "created_at"?: string
        }
        Relationships: [

        ]
      }
      blocks: {
        Row: {
          "blocker_id": string
          "blocked_id": string
          "reason": string | null
          "created_at": string
        }
        Insert: {
          "blocker_id": string
          "blocked_id": string
          "reason"?: string | null
          "created_at"?: string
        }
        Update: {
          "blocker_id"?: string
          "blocked_id"?: string
          "reason"?: string | null
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "blocks_blocked_id_fkey"
            columns: ["blocked_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blocks_blocker_id_fkey"
            columns: ["blocker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      comment_likes: {
        Row: {
          "comment_id": string
          "profile_id": string
          "created_at": string
        }
        Insert: {
          "comment_id": string
          "profile_id": string
          "created_at"?: string
        }
        Update: {
          "comment_id"?: string
          "profile_id"?: string
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "comment_likes_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comment_likes_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      comments: {
        Row: {
          "id": string
          "post_id": string
          "author_id": string
          "parent_id": string | null
          "body": string
          "like_count": number
          "reply_count": number
          "is_edited": boolean
          "moderation_status": string
          "created_at": string
          "updated_at": string
          "deleted_at": string | null
        }
        Insert: {
          "id"?: string
          "post_id": string
          "author_id": string
          "parent_id"?: string | null
          "body": string
          "like_count"?: number
          "reply_count"?: number
          "is_edited"?: boolean
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Update: {
          "id"?: string
          "post_id"?: string
          "author_id"?: string
          "parent_id"?: string | null
          "body"?: string
          "like_count"?: number
          "reply_count"?: number
          "is_edited"?: boolean
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      connections: {
        Row: {
          "id": string
          "requester_id": string
          "addressee_id": string
          "status": string
          "message": string | null
          "pair_low": string
          "pair_high": string
          "created_at": string
          "updated_at": string
          "responded_at": string | null
        }
        Insert: {
          "id"?: string
          "requester_id": string
          "addressee_id": string
          "status"?: string
          "message"?: string | null
          "pair_low": string
          "pair_high": string
          "created_at"?: string
          "updated_at"?: string
          "responded_at"?: string | null
        }
        Update: {
          "id"?: string
          "requester_id"?: string
          "addressee_id"?: string
          "status"?: string
          "message"?: string | null
          "pair_low"?: string
          "pair_high"?: string
          "created_at"?: string
          "updated_at"?: string
          "responded_at"?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "connections_addressee_id_fkey"
            columns: ["addressee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_participants: {
        Row: {
          "conversation_id": string
          "profile_id": string
          "role": string
          "last_read_at": string | null
          "unread_count": number
          "is_muted": boolean
          "left_at": string | null
          "joined_at": string
          "updated_at": string
        }
        Insert: {
          "conversation_id": string
          "profile_id": string
          "role"?: string
          "last_read_at"?: string | null
          "unread_count"?: number
          "is_muted"?: boolean
          "left_at"?: string | null
          "joined_at"?: string
          "updated_at"?: string
        }
        Update: {
          "conversation_id"?: string
          "profile_id"?: string
          "role"?: string
          "last_read_at"?: string | null
          "unread_count"?: number
          "is_muted"?: boolean
          "left_at"?: string | null
          "joined_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_participants_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_participants_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          "id": string
          "type": string
          "title": string | null
          "created_by": string | null
          "last_message_at": string | null
          "last_message_id": string | null
          "last_message_preview": string | null
          "pair_low": string | null
          "pair_high": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "type"?: string
          "title"?: string | null
          "created_by"?: string | null
          "last_message_at"?: string | null
          "last_message_id"?: string | null
          "last_message_preview"?: string | null
          "pair_low"?: string | null
          "pair_high"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "type"?: string
          "title"?: string | null
          "created_by"?: string | null
          "last_message_at"?: string | null
          "last_message_id"?: string | null
          "last_message_preview"?: string | null
          "pair_low"?: string | null
          "pair_high"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      courses: {
        Row: {
          "id": string
          "profile_id": string
          "semester_id": string | null
          "code": string | null
          "title": string
          "instructor": string | null
          "credits": number | null
          "status": string
          "grade": string | null
          "color": string | null
          "notes": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "profile_id": string
          "semester_id"?: string | null
          "code"?: string | null
          "title": string
          "instructor"?: string | null
          "credits"?: number | null
          "status"?: string
          "grade"?: string | null
          "color"?: string | null
          "notes"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "profile_id"?: string
          "semester_id"?: string | null
          "code"?: string | null
          "title"?: string
          "instructor"?: string | null
          "credits"?: number | null
          "status"?: string
          "grade"?: string | null
          "color"?: string | null
          "notes"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "courses_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "courses_semester_id_fkey"
            columns: ["semester_id"]
            isOneToOne: false
            referencedRelation: "semesters"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_logs: {
        Row: {
          "id": string
          "profile_id": string
          "log_date": string
          "mood": number | null
          "productivity": number | null
          "hours_studied": number | null
          "summary": string | null
          "wins": string | null
          "blockers": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "profile_id": string
          "log_date": string
          "mood"?: number | null
          "productivity"?: number | null
          "hours_studied"?: number | null
          "summary"?: string | null
          "wins"?: string | null
          "blockers"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "profile_id"?: string
          "log_date"?: string
          "mood"?: number | null
          "productivity"?: number | null
          "hours_studied"?: number | null
          "summary"?: string | null
          "wins"?: string | null
          "blockers"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_logs_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          "id": string
          "university_id": string
          "name": string
          "slug": string
          "is_verified": boolean
          "created_by": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "university_id": string
          "name": string
          "slug": string
          "is_verified"?: boolean
          "created_by"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "university_id"?: string
          "name"?: string
          "slug"?: string
          "is_verified"?: boolean
          "created_by"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_university_id_fkey"
            columns: ["university_id"]
            isOneToOne: false
            referencedRelation: "universities"
            referencedColumns: ["id"]
          },
        ]
      }
      event_attendees: {
        Row: {
          "event_id": string
          "profile_id": string
          "status": string
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "event_id": string
          "profile_id": string
          "status"?: string
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "event_id"?: string
          "profile_id"?: string
          "status"?: string
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_attendees_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_attendees_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          "id": string
          "slug": string
          "created_by": string
          "title": string
          "description": string | null
          "type": string
          "starts_at": string
          "ends_at": string | null
          "time_zone": string
          "is_all_day": boolean
          "attendance_mode": string
          "location": string | null
          "location_url": string | null
          "join_url": string | null
          "project_id": string | null
          "university_id": string | null
          "visibility": string
          "capacity": number | null
          "attendee_count": number
          "interested_count": number
          "status": string
          "moderation_status": string
          "created_at": string
          "updated_at": string
          "deleted_at": string | null
        }
        Insert: {
          "id"?: string
          "slug": string
          "created_by": string
          "title": string
          "description"?: string | null
          "type"?: string
          "starts_at": string
          "ends_at"?: string | null
          "time_zone"?: string
          "is_all_day"?: boolean
          "attendance_mode"?: string
          "location"?: string | null
          "location_url"?: string | null
          "join_url"?: string | null
          "project_id"?: string | null
          "university_id"?: string | null
          "visibility"?: string
          "capacity"?: number | null
          "attendee_count"?: number
          "interested_count"?: number
          "status"?: string
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Update: {
          "id"?: string
          "slug"?: string
          "created_by"?: string
          "title"?: string
          "description"?: string | null
          "type"?: string
          "starts_at"?: string
          "ends_at"?: string | null
          "time_zone"?: string
          "is_all_day"?: boolean
          "attendance_mode"?: string
          "location"?: string | null
          "location_url"?: string | null
          "join_url"?: string | null
          "project_id"?: string | null
          "university_id"?: string | null
          "visibility"?: string
          "capacity"?: number | null
          "attendee_count"?: number
          "interested_count"?: number
          "status"?: string
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_university_id_fkey"
            columns: ["university_id"]
            isOneToOne: false
            referencedRelation: "universities"
            referencedColumns: ["id"]
          },
        ]
      }
      follows: {
        Row: {
          "follower_id": string
          "following_id": string
          "created_at": string
        }
        Insert: {
          "follower_id": string
          "following_id": string
          "created_at"?: string
        }
        Update: {
          "follower_id"?: string
          "following_id"?: string
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "follows_follower_id_fkey"
            columns: ["follower_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follows_following_id_fkey"
            columns: ["following_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      goal_milestones: {
        Row: {
          "id": string
          "goal_id": string
          "title": string
          "is_completed": boolean
          "completed_at": string | null
          "target_date": string | null
          "sort_order": number
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "goal_id": string
          "title": string
          "is_completed"?: boolean
          "completed_at"?: string | null
          "target_date"?: string | null
          "sort_order"?: number
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "goal_id"?: string
          "title"?: string
          "is_completed"?: boolean
          "completed_at"?: string | null
          "target_date"?: string | null
          "sort_order"?: number
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "goal_milestones_goal_id_fkey"
            columns: ["goal_id"]
            isOneToOne: false
            referencedRelation: "goals"
            referencedColumns: ["id"]
          },
        ]
      }
      goals: {
        Row: {
          "id": string
          "profile_id": string
          "title": string
          "description": string | null
          "category": string
          "status": string
          "target_value": number
          "current_value": number
          "unit": string | null
          "progress_percent": number | null
          "course_id": string | null
          "semester_id": string | null
          "project_id": string | null
          "visibility": string
          "start_date": string | null
          "target_date": string | null
          "completed_at": string | null
          "milestone_count": number
          "completed_milestone_count": number
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "profile_id": string
          "title": string
          "description"?: string | null
          "category"?: string
          "status"?: string
          "target_value"?: number
          "current_value"?: number
          "unit"?: string | null
          "progress_percent"?: number | null
          "course_id"?: string | null
          "semester_id"?: string | null
          "project_id"?: string | null
          "visibility"?: string
          "start_date"?: string | null
          "target_date"?: string | null
          "completed_at"?: string | null
          "milestone_count"?: number
          "completed_milestone_count"?: number
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "profile_id"?: string
          "title"?: string
          "description"?: string | null
          "category"?: string
          "status"?: string
          "target_value"?: number
          "current_value"?: number
          "unit"?: string | null
          "progress_percent"?: number | null
          "course_id"?: string | null
          "semester_id"?: string | null
          "project_id"?: string | null
          "visibility"?: string
          "start_date"?: string | null
          "target_date"?: string | null
          "completed_at"?: string | null
          "milestone_count"?: number
          "completed_milestone_count"?: number
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "goals_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goals_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goals_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goals_semester_id_fkey"
            columns: ["semester_id"]
            isOneToOne: false
            referencedRelation: "semesters"
            referencedColumns: ["id"]
          },
        ]
      }
      idea_comments: {
        Row: {
          "id": string
          "idea_id": string
          "author_id": string
          "body": string
          "is_edited": boolean
          "moderation_status": string
          "created_at": string
          "updated_at": string
          "deleted_at": string | null
        }
        Insert: {
          "id"?: string
          "idea_id": string
          "author_id": string
          "body": string
          "is_edited"?: boolean
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Update: {
          "id"?: string
          "idea_id"?: string
          "author_id"?: string
          "body"?: string
          "is_edited"?: boolean
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "idea_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "idea_comments_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "ideas"
            referencedColumns: ["id"]
          },
        ]
      }
      idea_interest: {
        Row: {
          "idea_id": string
          "profile_id": string
          "message": string | null
          "offering": string | null
          "created_at": string
        }
        Insert: {
          "idea_id": string
          "profile_id": string
          "message"?: string | null
          "offering"?: string | null
          "created_at"?: string
        }
        Update: {
          "idea_id"?: string
          "profile_id"?: string
          "message"?: string | null
          "offering"?: string | null
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "idea_interest_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "idea_interest_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      idea_skills: {
        Row: {
          "idea_id": string
          "skill_id": string
          "created_at": string
        }
        Insert: {
          "idea_id": string
          "skill_id": string
          "created_at"?: string
        }
        Update: {
          "idea_id"?: string
          "skill_id"?: string
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "idea_skills_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "idea_skills_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["id"]
          },
        ]
      }
      idea_votes: {
        Row: {
          "idea_id": string
          "profile_id": string
          "created_at": string
        }
        Insert: {
          "idea_id": string
          "profile_id": string
          "created_at"?: string
        }
        Update: {
          "idea_id"?: string
          "profile_id"?: string
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "idea_votes_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "idea_votes_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ideas: {
        Row: {
          "id": string
          "author_id": string
          "title": string
          "description": string
          "category": string
          "looking_for": string | null
          "status": string
          "visibility": string
          "university_id": string | null
          "converted_project_id": string | null
          "converted_at": string | null
          "upvote_count": number
          "comment_count": number
          "interest_count": number
          "moderation_status": string
          "created_at": string
          "updated_at": string
          "deleted_at": string | null
        }
        Insert: {
          "id"?: string
          "author_id": string
          "title": string
          "description": string
          "category"?: string
          "looking_for"?: string | null
          "status"?: string
          "visibility"?: string
          "university_id"?: string | null
          "converted_project_id"?: string | null
          "converted_at"?: string | null
          "upvote_count"?: number
          "comment_count"?: number
          "interest_count"?: number
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Update: {
          "id"?: string
          "author_id"?: string
          "title"?: string
          "description"?: string
          "category"?: string
          "looking_for"?: string | null
          "status"?: string
          "visibility"?: string
          "university_id"?: string | null
          "converted_project_id"?: string | null
          "converted_at"?: string | null
          "upvote_count"?: number
          "comment_count"?: number
          "interest_count"?: number
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ideas_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ideas_converted_project_id_fkey"
            columns: ["converted_project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ideas_university_id_fkey"
            columns: ["university_id"]
            isOneToOne: false
            referencedRelation: "universities"
            referencedColumns: ["id"]
          },
        ]
      }
      interests: {
        Row: {
          "id": string
          "name": string
          "slug": string
          "category": string
          "is_approved": boolean
          "usage_count": number
          "created_by": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "name": string
          "slug": string
          "category"?: string
          "is_approved"?: boolean
          "usage_count"?: number
          "created_by"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "name"?: string
          "slug"?: string
          "category"?: string
          "is_approved"?: boolean
          "usage_count"?: number
          "created_by"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "interests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          "id": string
          "conversation_id": string
          "sender_id": string
          "body": string | null
          "attachment_path": string | null
          "attachment_mime": string | null
          "attachment_size": number | null
          "attachment_name": string | null
          "reply_to_id": string | null
          "is_edited": boolean
          "edited_at": string | null
          "deleted_at": string | null
          "moderation_status": string
          "created_at": string
        }
        Insert: {
          "id"?: string
          "conversation_id": string
          "sender_id": string
          "body"?: string | null
          "attachment_path"?: string | null
          "attachment_mime"?: string | null
          "attachment_size"?: number | null
          "attachment_name"?: string | null
          "reply_to_id"?: string | null
          "is_edited"?: boolean
          "edited_at"?: string | null
          "deleted_at"?: string | null
          "moderation_status"?: string
          "created_at"?: string
        }
        Update: {
          "id"?: string
          "conversation_id"?: string
          "sender_id"?: string
          "body"?: string | null
          "attachment_path"?: string | null
          "attachment_mime"?: string | null
          "attachment_size"?: number | null
          "attachment_name"?: string | null
          "reply_to_id"?: string | null
          "is_edited"?: boolean
          "edited_at"?: string | null
          "deleted_at"?: string | null
          "moderation_status"?: string
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_reply_to_id_fkey"
            columns: ["reply_to_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_categories: {
        Row: {
          "category": string
          "label": string
          "description": string
          "is_suppressible": boolean
          "sort_order": number
        }
        Insert: {
          "category": string
          "label": string
          "description": string
          "is_suppressible"?: boolean
          "sort_order"?: number
        }
        Update: {
          "category"?: string
          "label"?: string
          "description"?: string
          "is_suppressible"?: boolean
          "sort_order"?: number
        }
        Relationships: [

        ]
      }
      notification_preferences: {
        Row: {
          "profile_id": string
          "category": string
          "in_app_enabled": boolean
          "updated_at": string
        }
        Insert: {
          "profile_id": string
          "category": string
          "in_app_enabled"?: boolean
          "updated_at"?: string
        }
        Update: {
          "profile_id"?: string
          "category"?: string
          "in_app_enabled"?: boolean
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_preferences_category_fkey"
            columns: ["category"]
            isOneToOne: false
            referencedRelation: "notification_categories"
            referencedColumns: ["category"]
          },
          {
            foreignKeyName: "notification_preferences_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_types: {
        Row: {
          "type": string
          "category": string
          "resurfaces": boolean
          "sort_order": number
        }
        Insert: {
          "type": string
          "category": string
          "resurfaces"?: boolean
          "sort_order"?: number
        }
        Update: {
          "type"?: string
          "category"?: string
          "resurfaces"?: boolean
          "sort_order"?: number
        }
        Relationships: [
          {
            foreignKeyName: "notification_types_category_fkey"
            columns: ["category"]
            isOneToOne: false
            referencedRelation: "notification_categories"
            referencedColumns: ["category"]
          },
        ]
      }
      notifications: {
        Row: {
          "id": string
          "recipient_id": string
          "type": string
          "actor_id": string | null
          "post_id": string | null
          "comment_id": string | null
          "project_id": string | null
          "idea_id": string | null
          "event_id": string | null
          "opportunity_id": string | null
          "conversation_id": string | null
          "skill_id": string | null
          "achievement_key": string | null
          "body": string | null
          "is_read": boolean
          "read_at": string | null
          "created_at": string
        }
        Insert: {
          "id"?: string
          "recipient_id": string
          "type": string
          "actor_id"?: string | null
          "post_id"?: string | null
          "comment_id"?: string | null
          "project_id"?: string | null
          "idea_id"?: string | null
          "event_id"?: string | null
          "opportunity_id"?: string | null
          "conversation_id"?: string | null
          "skill_id"?: string | null
          "achievement_key"?: string | null
          "body"?: string | null
          "is_read"?: boolean
          "read_at"?: string | null
          "created_at"?: string
        }
        Update: {
          "id"?: string
          "recipient_id"?: string
          "type"?: string
          "actor_id"?: string | null
          "post_id"?: string | null
          "comment_id"?: string | null
          "project_id"?: string | null
          "idea_id"?: string | null
          "event_id"?: string | null
          "opportunity_id"?: string | null
          "conversation_id"?: string | null
          "skill_id"?: string | null
          "achievement_key"?: string | null
          "body"?: string | null
          "is_read"?: boolean
          "read_at"?: string | null
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_achievement_key_fkey"
            columns: ["achievement_key"]
            isOneToOne: false
            referencedRelation: "achievement_definitions"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "notifications_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_type_fkey"
            columns: ["type"]
            isOneToOne: false
            referencedRelation: "notification_types"
            referencedColumns: ["type"]
          },
        ]
      }
      opportunities: {
        Row: {
          "id": string
          "slug": string
          "posted_by": string
          "title": string
          "organisation": string
          "description": string
          "type": string
          "compensation": string | null
          "work_mode": string
          "location": string | null
          "apply_url": string | null
          "apply_email": string | null
          "deadline": string | null
          "starts_on": string | null
          "university_id": string | null
          "visibility": string
          "status": string
          "source": string
          "save_count": number
          "moderation_status": string
          "created_at": string
          "updated_at": string
          "deleted_at": string | null
        }
        Insert: {
          "id"?: string
          "slug": string
          "posted_by": string
          "title": string
          "organisation": string
          "description": string
          "type": string
          "compensation"?: string | null
          "work_mode"?: string
          "location"?: string | null
          "apply_url"?: string | null
          "apply_email"?: string | null
          "deadline"?: string | null
          "starts_on"?: string | null
          "university_id"?: string | null
          "visibility"?: string
          "status"?: string
          "source"?: string
          "save_count"?: number
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Update: {
          "id"?: string
          "slug"?: string
          "posted_by"?: string
          "title"?: string
          "organisation"?: string
          "description"?: string
          "type"?: string
          "compensation"?: string | null
          "work_mode"?: string
          "location"?: string | null
          "apply_url"?: string | null
          "apply_email"?: string | null
          "deadline"?: string | null
          "starts_on"?: string | null
          "university_id"?: string | null
          "visibility"?: string
          "status"?: string
          "source"?: string
          "save_count"?: number
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "opportunities_posted_by_fkey"
            columns: ["posted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunities_university_id_fkey"
            columns: ["university_id"]
            isOneToOne: false
            referencedRelation: "universities"
            referencedColumns: ["id"]
          },
        ]
      }
      opportunity_saves: {
        Row: {
          "opportunity_id": string
          "profile_id": string
          "note": string | null
          "created_at": string
        }
        Insert: {
          "opportunity_id": string
          "profile_id": string
          "note"?: string | null
          "created_at"?: string
        }
        Update: {
          "opportunity_id"?: string
          "profile_id"?: string
          "note"?: string | null
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "opportunity_saves_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_saves_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      opportunity_skills: {
        Row: {
          "opportunity_id": string
          "skill_id": string
          "is_required": boolean
          "created_at": string
        }
        Insert: {
          "opportunity_id": string
          "skill_id": string
          "is_required"?: boolean
          "created_at"?: string
        }
        Update: {
          "opportunity_id"?: string
          "skill_id"?: string
          "is_required"?: boolean
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "opportunity_skills_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_skills_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["id"]
          },
        ]
      }
      post_likes: {
        Row: {
          "post_id": string
          "profile_id": string
          "created_at": string
        }
        Insert: {
          "post_id": string
          "profile_id": string
          "created_at"?: string
        }
        Update: {
          "post_id"?: string
          "profile_id"?: string
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_likes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_likes_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      post_media: {
        Row: {
          "id": string
          "post_id": string
          "storage_path": string
          "mime_type": string
          "size_bytes": number
          "width": number | null
          "height": number | null
          "alt_text": string | null
          "sort_order": number
          "created_at": string
        }
        Insert: {
          "id"?: string
          "post_id": string
          "storage_path": string
          "mime_type": string
          "size_bytes": number
          "width"?: number | null
          "height"?: number | null
          "alt_text"?: string | null
          "sort_order"?: number
          "created_at"?: string
        }
        Update: {
          "id"?: string
          "post_id"?: string
          "storage_path"?: string
          "mime_type"?: string
          "size_bytes"?: number
          "width"?: number | null
          "height"?: number | null
          "alt_text"?: string | null
          "sort_order"?: number
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_media_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_saves: {
        Row: {
          "post_id": string
          "profile_id": string
          "created_at": string
        }
        Insert: {
          "post_id": string
          "profile_id": string
          "created_at"?: string
        }
        Update: {
          "post_id"?: string
          "profile_id"?: string
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_saves_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_saves_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      posts: {
        Row: {
          "id": string
          "author_id": string
          "type": string
          "body": string | null
          "title": string | null
          "link_url": string | null
          "project_id": string | null
          "achievement_key": string | null
          "goal_id": string | null
          "opportunity_id": string | null
          "university_id": string | null
          "visibility": string
          "like_count": number
          "comment_count": number
          "save_count": number
          "is_edited": boolean
          "edited_at": string | null
          "moderation_status": string
          "created_at": string
          "updated_at": string
          "deleted_at": string | null
        }
        Insert: {
          "id"?: string
          "author_id": string
          "type"?: string
          "body"?: string | null
          "title"?: string | null
          "link_url"?: string | null
          "project_id"?: string | null
          "achievement_key"?: string | null
          "goal_id"?: string | null
          "opportunity_id"?: string | null
          "university_id"?: string | null
          "visibility"?: string
          "like_count"?: number
          "comment_count"?: number
          "save_count"?: number
          "is_edited"?: boolean
          "edited_at"?: string | null
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Update: {
          "id"?: string
          "author_id"?: string
          "type"?: string
          "body"?: string | null
          "title"?: string | null
          "link_url"?: string | null
          "project_id"?: string | null
          "achievement_key"?: string | null
          "goal_id"?: string | null
          "opportunity_id"?: string | null
          "university_id"?: string | null
          "visibility"?: string
          "like_count"?: number
          "comment_count"?: number
          "save_count"?: number
          "is_edited"?: boolean
          "edited_at"?: string | null
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "posts_achievement_key_fkey"
            columns: ["achievement_key"]
            isOneToOne: false
            referencedRelation: "achievement_definitions"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_goal_id_fkey"
            columns: ["goal_id"]
            isOneToOne: false
            referencedRelation: "goals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_university_id_fkey"
            columns: ["university_id"]
            isOneToOne: false
            referencedRelation: "universities"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_achievements: {
        Row: {
          "profile_id": string
          "achievement_key": string
          "awarded_at": string
          "awarded_value": number | null
          "is_pinned": boolean
        }
        Insert: {
          "profile_id": string
          "achievement_key": string
          "awarded_at"?: string
          "awarded_value"?: number | null
          "is_pinned"?: boolean
        }
        Update: {
          "profile_id"?: string
          "achievement_key"?: string
          "awarded_at"?: string
          "awarded_value"?: number | null
          "is_pinned"?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "profile_achievements_achievement_key_fkey"
            columns: ["achievement_key"]
            isOneToOne: false
            referencedRelation: "achievement_definitions"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "profile_achievements_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_interests: {
        Row: {
          "profile_id": string
          "interest_id": string
          "created_at": string
        }
        Insert: {
          "profile_id": string
          "interest_id": string
          "created_at"?: string
        }
        Update: {
          "profile_id"?: string
          "interest_id"?: string
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_interests_interest_id_fkey"
            columns: ["interest_id"]
            isOneToOne: false
            referencedRelation: "interests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_interests_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_skill_endorsements: {
        Row: {
          "profile_id": string
          "skill_id": string
          "endorser_id": string
          "created_at": string
        }
        Insert: {
          "profile_id": string
          "skill_id": string
          "endorser_id": string
          "created_at"?: string
        }
        Update: {
          "profile_id"?: string
          "skill_id"?: string
          "endorser_id"?: string
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_skill_endorsements_endorser_id_fkey"
            columns: ["endorser_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_skill_endorsements_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profile_skills"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "profile_skill_endorsements_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profile_skills"
            referencedColumns: ["skill_id"]
          },
          {
            foreignKeyName: "profile_skill_endorsements_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "profile_skills"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "profile_skill_endorsements_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "profile_skills"
            referencedColumns: ["skill_id"]
          },
        ]
      }
      profile_skills: {
        Row: {
          "profile_id": string
          "skill_id": string
          "level": string
          "is_learning": boolean
          "years_experience": number | null
          "display_order": number
          "endorsement_count": number
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "profile_id": string
          "skill_id": string
          "level"?: string
          "is_learning"?: boolean
          "years_experience"?: number | null
          "display_order"?: number
          "endorsement_count"?: number
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "profile_id"?: string
          "skill_id"?: string
          "level"?: string
          "is_learning"?: boolean
          "years_experience"?: number | null
          "display_order"?: number
          "endorsement_count"?: number
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_skills_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_skills_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          "id": string
          "username": string
          "display_name": string
          "avatar_url": string | null
          "cover_url": string | null
          "headline": string | null
          "bio": string | null
          "university_id": string | null
          "department_id": string | null
          "program_id": string | null
          "degree": string | null
          "semester": number | null
          "graduation_year": number | null
          "location": string | null
          "website": string | null
          "github_username": string | null
          "linkedin_url": string | null
          "twitter_username": string | null
          "visibility": string
          "allow_messages_from": string
          "allow_connection_requests": boolean
          "searchable": boolean
          "onboarding_completed": boolean
          "onboarding_step": number
          "status": string
          "suspended_until": string | null
          "suspension_reason": string | null
          "warning_count": number
          "username_changed_at": string | null
          "follower_count": number
          "following_count": number
          "connection_count": number
          "post_count": number
          "project_count": number
          "last_active_at": string
          "created_at": string
          "updated_at": string
          "deleted_at": string | null
        }
        Insert: {
          "id": string
          "username": string
          "display_name": string
          "avatar_url"?: string | null
          "cover_url"?: string | null
          "headline"?: string | null
          "bio"?: string | null
          "university_id"?: string | null
          "department_id"?: string | null
          "program_id"?: string | null
          "degree"?: string | null
          "semester"?: number | null
          "graduation_year"?: number | null
          "location"?: string | null
          "website"?: string | null
          "github_username"?: string | null
          "linkedin_url"?: string | null
          "twitter_username"?: string | null
          "visibility"?: string
          "allow_messages_from"?: string
          "allow_connection_requests"?: boolean
          "searchable"?: boolean
          "onboarding_completed"?: boolean
          "onboarding_step"?: number
          "status"?: string
          "suspended_until"?: string | null
          "suspension_reason"?: string | null
          "warning_count"?: number
          "username_changed_at"?: string | null
          "follower_count"?: number
          "following_count"?: number
          "connection_count"?: number
          "post_count"?: number
          "project_count"?: number
          "last_active_at"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Update: {
          "id"?: string
          "username"?: string
          "display_name"?: string
          "avatar_url"?: string | null
          "cover_url"?: string | null
          "headline"?: string | null
          "bio"?: string | null
          "university_id"?: string | null
          "department_id"?: string | null
          "program_id"?: string | null
          "degree"?: string | null
          "semester"?: number | null
          "graduation_year"?: number | null
          "location"?: string | null
          "website"?: string | null
          "github_username"?: string | null
          "linkedin_url"?: string | null
          "twitter_username"?: string | null
          "visibility"?: string
          "allow_messages_from"?: string
          "allow_connection_requests"?: boolean
          "searchable"?: boolean
          "onboarding_completed"?: boolean
          "onboarding_step"?: number
          "status"?: string
          "suspended_until"?: string | null
          "suspension_reason"?: string | null
          "warning_count"?: number
          "username_changed_at"?: string | null
          "follower_count"?: number
          "following_count"?: number
          "connection_count"?: number
          "post_count"?: number
          "project_count"?: number
          "last_active_at"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "programs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_university_id_fkey"
            columns: ["university_id"]
            isOneToOne: false
            referencedRelation: "universities"
            referencedColumns: ["id"]
          },
        ]
      }
      programs: {
        Row: {
          "id": string
          "department_id": string
          "name": string
          "slug": string
          "degree_type": string
          "duration_semesters": number | null
          "is_verified": boolean
          "created_by": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "department_id": string
          "name": string
          "slug": string
          "degree_type"?: string
          "duration_semesters"?: number | null
          "is_verified"?: boolean
          "created_by"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "department_id"?: string
          "name"?: string
          "slug"?: string
          "degree_type"?: string
          "duration_semesters"?: number | null
          "is_verified"?: boolean
          "created_by"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "programs_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      project_applications: {
        Row: {
          "id": string
          "project_id": string
          "applicant_id": string
          "message": string | null
          "desired_role": string | null
          "status": string
          "reviewed_by": string | null
          "reviewed_at": string | null
          "review_note": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "project_id": string
          "applicant_id": string
          "message"?: string | null
          "desired_role"?: string | null
          "status"?: string
          "reviewed_by"?: string | null
          "reviewed_at"?: string | null
          "review_note"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "project_id"?: string
          "applicant_id"?: string
          "message"?: string | null
          "desired_role"?: string | null
          "status"?: string
          "reviewed_by"?: string | null
          "reviewed_at"?: string | null
          "review_note"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_applications_applicant_id_fkey"
            columns: ["applicant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_applications_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_applications_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_invites: {
        Row: {
          "id": string
          "project_id": string
          "invitee_id": string
          "inviter_id": string
          "message": string | null
          "proposed_role": string | null
          "status": string
          "responded_at": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "project_id": string
          "invitee_id": string
          "inviter_id": string
          "message"?: string | null
          "proposed_role"?: string | null
          "status"?: string
          "responded_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "project_id"?: string
          "invitee_id"?: string
          "inviter_id"?: string
          "message"?: string | null
          "proposed_role"?: string | null
          "status"?: string
          "responded_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_invites_invitee_id_fkey"
            columns: ["invitee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_invites_inviter_id_fkey"
            columns: ["inviter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_invites_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_media: {
        Row: {
          "id": string
          "project_id": string
          "storage_path": string
          "mime_type": string
          "size_bytes": number
          "width": number | null
          "height": number | null
          "alt_text": string | null
          "display_order": number
          "uploaded_by": string | null
          "created_at": string
        }
        Insert: {
          "id"?: string
          "project_id": string
          "storage_path": string
          "mime_type": string
          "size_bytes": number
          "width"?: number | null
          "height"?: number | null
          "alt_text"?: string | null
          "display_order"?: number
          "uploaded_by"?: string | null
          "created_at"?: string
        }
        Update: {
          "id"?: string
          "project_id"?: string
          "storage_path"?: string
          "mime_type"?: string
          "size_bytes"?: number
          "width"?: number | null
          "height"?: number | null
          "alt_text"?: string | null
          "display_order"?: number
          "uploaded_by"?: string | null
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_media_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_media_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_members: {
        Row: {
          "project_id": string
          "profile_id": string
          "role": string
          "title": string | null
          "invited_by": string | null
          "joined_at": string
          "updated_at": string
        }
        Insert: {
          "project_id": string
          "profile_id": string
          "role"?: string
          "title"?: string | null
          "invited_by"?: string | null
          "joined_at"?: string
          "updated_at"?: string
        }
        Update: {
          "project_id"?: string
          "profile_id"?: string
          "role"?: string
          "title"?: string | null
          "invited_by"?: string | null
          "joined_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_members_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_skills: {
        Row: {
          "project_id": string
          "skill_id": string
          "is_required": boolean
          "created_at": string
        }
        Insert: {
          "project_id": string
          "skill_id": string
          "is_required"?: boolean
          "created_at"?: string
        }
        Update: {
          "project_id"?: string
          "skill_id"?: string
          "is_required"?: boolean
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_skills_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_skills_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["id"]
          },
        ]
      }
      project_stars: {
        Row: {
          "project_id": string
          "profile_id": string
          "created_at": string
        }
        Insert: {
          "project_id": string
          "profile_id": string
          "created_at"?: string
        }
        Update: {
          "project_id"?: string
          "profile_id"?: string
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_stars_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_stars_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          "id": string
          "owner_id": string
          "title": string
          "slug": string
          "tagline": string | null
          "description": string | null
          "category": string
          "status": string
          "visibility": string
          "university_id": string | null
          "cover_url": string | null
          "repo_url": string | null
          "demo_url": string | null
          "is_seeking_members": boolean
          "looking_for": string | null
          "team_size_target": number | null
          "started_at": string | null
          "completed_at": string | null
          "member_count": number
          "star_count": number
          "application_count": number
          "post_count": number
          "moderation_status": string
          "created_at": string
          "updated_at": string
          "deleted_at": string | null
        }
        Insert: {
          "id"?: string
          "owner_id": string
          "title": string
          "slug": string
          "tagline"?: string | null
          "description"?: string | null
          "category"?: string
          "status"?: string
          "visibility"?: string
          "university_id"?: string | null
          "cover_url"?: string | null
          "repo_url"?: string | null
          "demo_url"?: string | null
          "is_seeking_members"?: boolean
          "looking_for"?: string | null
          "team_size_target"?: number | null
          "started_at"?: string | null
          "completed_at"?: string | null
          "member_count"?: number
          "star_count"?: number
          "application_count"?: number
          "post_count"?: number
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Update: {
          "id"?: string
          "owner_id"?: string
          "title"?: string
          "slug"?: string
          "tagline"?: string | null
          "description"?: string | null
          "category"?: string
          "status"?: string
          "visibility"?: string
          "university_id"?: string | null
          "cover_url"?: string | null
          "repo_url"?: string | null
          "demo_url"?: string | null
          "is_seeking_members"?: boolean
          "looking_for"?: string | null
          "team_size_target"?: number | null
          "started_at"?: string | null
          "completed_at"?: string | null
          "member_count"?: number
          "star_count"?: number
          "application_count"?: number
          "post_count"?: number
          "moderation_status"?: string
          "created_at"?: string
          "updated_at"?: string
          "deleted_at"?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "projects_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_university_id_fkey"
            columns: ["university_id"]
            isOneToOne: false
            referencedRelation: "universities"
            referencedColumns: ["id"]
          },
        ]
      }
      reserved_usernames: {
        Row: {
          "username": string
          "reason": string
        }
        Insert: {
          "username": string
          "reason"?: string
        }
        Update: {
          "username"?: string
          "reason"?: string
        }
        Relationships: [

        ]
      }
      semesters: {
        Row: {
          "id": string
          "profile_id": string
          "name": string
          "term": string | null
          "year": number | null
          "start_date": string | null
          "end_date": string | null
          "is_current": boolean
          "notes": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "profile_id": string
          "name": string
          "term"?: string | null
          "year"?: number | null
          "start_date"?: string | null
          "end_date"?: string | null
          "is_current"?: boolean
          "notes"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "profile_id"?: string
          "name"?: string
          "term"?: string | null
          "year"?: number | null
          "start_date"?: string | null
          "end_date"?: string | null
          "is_current"?: boolean
          "notes"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "semesters_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      skills: {
        Row: {
          "id": string
          "name": string
          "slug": string
          "category": string
          "description": string | null
          "is_approved": boolean
          "usage_count": number
          "created_by": string | null
          "reviewed_by": string | null
          "reviewed_at": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "name": string
          "slug": string
          "category"?: string
          "description"?: string | null
          "is_approved"?: boolean
          "usage_count"?: number
          "created_by"?: string | null
          "reviewed_by"?: string | null
          "reviewed_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "name"?: string
          "slug"?: string
          "category"?: string
          "description"?: string | null
          "is_approved"?: boolean
          "usage_count"?: number
          "created_by"?: string | null
          "reviewed_by"?: string | null
          "reviewed_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "skills_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skills_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      study_sessions: {
        Row: {
          "id": string
          "profile_id": string
          "course_id": string | null
          "goal_id": string | null
          "started_at": string
          "duration_minutes": number
          "ended_at": string
          "focus_rating": number | null
          "notes": string | null
          "created_at": string
        }
        Insert: {
          "id"?: string
          "profile_id": string
          "course_id"?: string | null
          "goal_id"?: string | null
          "started_at"?: string
          "duration_minutes": number
          "ended_at": string
          "focus_rating"?: number | null
          "notes"?: string | null
          "created_at"?: string
        }
        Update: {
          "id"?: string
          "profile_id"?: string
          "course_id"?: string | null
          "goal_id"?: string | null
          "started_at"?: string
          "duration_minutes"?: number
          "ended_at"?: string
          "focus_rating"?: number | null
          "notes"?: string | null
          "created_at"?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_sessions_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_sessions_goal_id_fkey"
            columns: ["goal_id"]
            isOneToOne: false
            referencedRelation: "goals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_sessions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      universities: {
        Row: {
          "id": string
          "slug": string
          "name": string
          "short_name": string | null
          "country": string | null
          "city": string | null
          "website": string | null
          "logo_url": string | null
          "description": string | null
          "email_domains": (string)[]
          "status": string
          "rejection_reason": string | null
          "submitted_by": string | null
          "reviewed_by": string | null
          "reviewed_at": string | null
          "student_count": number
          "project_count": number
          "normalized_name": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "slug": string
          "name": string
          "short_name"?: string | null
          "country"?: string | null
          "city"?: string | null
          "website"?: string | null
          "logo_url"?: string | null
          "description"?: string | null
          "email_domains"?: (string)[]
          "status"?: string
          "rejection_reason"?: string | null
          "submitted_by"?: string | null
          "reviewed_by"?: string | null
          "reviewed_at"?: string | null
          "student_count"?: number
          "project_count"?: number
          "normalized_name"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "slug"?: string
          "name"?: string
          "short_name"?: string | null
          "country"?: string | null
          "city"?: string | null
          "website"?: string | null
          "logo_url"?: string | null
          "description"?: string | null
          "email_domains"?: (string)[]
          "status"?: string
          "rejection_reason"?: string | null
          "submitted_by"?: string | null
          "reviewed_by"?: string | null
          "reviewed_at"?: string | null
          "student_count"?: number
          "project_count"?: number
          "normalized_name"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: [

        ]
      }
      user_roles: {
        Row: {
          "user_id": string
          "role": string
          "granted_by": string | null
          "granted_at": string
          "note": string | null
        }
        Insert: {
          "user_id": string
          "role": string
          "granted_by"?: string | null
          "granted_at"?: string
          "note"?: string | null
        }
        Update: {
          "user_id"?: string
          "role"?: string
          "granted_by"?: string | null
          "granted_at"?: string
          "note"?: string | null
        }
        Relationships: [

        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      convert_idea_to_project: {
        Args: {
          "p_idea_id": string
        }
        Returns: string
      }
      create_group_conversation: {
        Args: {
          "p_title": string
          "p_members": (string)[]
        }
        Returns: string
      }
      current_study_streak: {
        Args: {
        [_ in never]: never
        }
        Returns: number
      }
      dispatch_due_reminders: {
        Args: {
          "v_event_window": string
          "v_opportunity_window": string
        }
        Returns: number
      }
      mark_conversation_read: {
        Args: {
          "p_conversation_id": string
        }
        Returns: undefined
      }
      start_direct_conversation: {
        Args: {
          "p_other_user": string
        }
        Returns: string
      }
      total_unread_messages: {
        Args: {
        [_ in never]: never
        }
        Returns: number
      }
      touch_last_active: {
        Args: {
        [_ in never]: never
        }
        Returns: undefined
      }
      transfer_project_ownership: {
        Args: {
          "p_project_id": string
          "p_new_owner": string
        }
        Returns: undefined
      }
      unread_notification_count: {
        Args: {
        [_ in never]: never
        }
        Returns: number
      }
    }
    Enums: {

    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type PublicSchema = Database['public']

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row']
export type TablesInsert<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Insert']
export type TablesUpdate<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Update']
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T]
