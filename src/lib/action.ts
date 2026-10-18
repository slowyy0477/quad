/**
 * The Server Action wrapper — ARCHITECTURE §4, in code.
 *
 *   action(schema)
 *     .use(requireActiveAccount)
 *     .use(rateLimit('report:file'))
 *     .use(guard('You can only report something you can see.', isVisible))
 *     .run(async ({ input, user, supabase }) => { … })
 *
 * One write path, in this order:
 *
 *   zod parse → auth → account status → rate limit → ownership guard →
 *   service → revalidate → typed Result
 *
 * Why a wrapper rather than the same six lines in every action: those six lines
 * are the security-relevant ones, and five hand-written copies of a security
 * check are five chances to forget one. The three actions written before this
 * existed say so in a comment (src/features/feed/actions.ts and friends) and are
 * listed as remaining work rather than quietly left behind.
 *
 * What the wrapper guarantees:
 *
 *   * **The raw error never reaches the browser.** Every database failure goes
 *     through `describeWriteError`, which logs the code and the message
 *     server-side and returns a sentence. A PostgREST message names tables,
 *     columns and constraints, which is a free map of the schema.
 *   * **Authorisation is not this file's job.** What RLS permits is the boundary;
 *     the checks here are a legible early refusal and a better message, never the
 *     thing standing between a user and someone else's row. The one exception is
 *     `rateLimit`, which has no database-level equivalent for a whole action.
 *   * **A refused action is a value, not an exception.** `ActionResult` forces the
 *     caller to handle both halves; there is no path where a failed write and a
 *     successful one are the same shape.
 *
 * A `'use server'` module may only export async functions, so the handler this
 * returns is created per module and called per request — never memoised, because
 * a Supabase client built from one request's cookies must never serve another
 * user's request (see src/lib/supabase/server.ts).
 */

import 'server-only'

import type { User } from '@supabase/supabase-js'
import type { z } from 'zod'
import { describeWriteError, echoValues, type FormState } from '@/lib/form-state'
import { isSupabaseConfigured } from '@/lib/env'
import { checkRateLimit, type RateLimitBucket } from '@/lib/rate-limit'
import { createClient } from '@/lib/supabase/server'

type Supabase = Awaited<ReturnType<typeof createClient>>

/** The shape every action returns. `code` is for logging and tests, never copy. */
export type ActionResult<T = null> =
  | { ok: true; value: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string>; code?: string }

/**
 * A refusal raised *inside* a step or a service with copy meant for the user.
 *
 * Anything else that is thrown is treated as a bug, mapped by its Postgres code
 * and logged — which is how "we meant to say no" stays distinguishable from
 * "something broke".
 */
export class ActionError extends Error {
  constructor(
    readonly userMessage: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(userMessage)
    this.name = 'ActionError'
  }
}

export type ActionContext = {
  /** Non-null: authentication is performed by the wrapper, before any step. */
  user: User
  supabase: Supabase
}

/**
 * A pre-flight check. Returns a sentence to refuse with, or null to continue.
 *
 * Steps are deliberately narrow. `guard` is the escape hatch for the
 * domain-specific one (does this person own this row), and it lives at the call
 * site because only the call site knows what ownership means there.
 */
export type Step<Input> = (ctx: ActionContext, input: Input) => Promise<string | null>

const NOT_CONFIGURED =
  'This deployment has no database connection, so that could not be saved.'

const NOT_SIGNED_IN = 'Please sign in to do that.'

/** The fields a form posted, as plain strings, so a rejected form can be redrawn. */
export function formInput(formData: FormData): Record<string, string> {
  return echoValues(formData)
}

/**
 * Turn a Result into the FormState a `useActionState` form renders.
 *
 * Kept here rather than in each feature so the mapping from "the write failed"
 * to "what the user sees" exists once.
 *
 * `formData` is optional but should always be passed by a form action: the
 * rejected values come back in `values`, which is what stops a form clearing
 * itself because one field was wrong. A form that loses a paragraph somebody just
 * wrote is worse than one with no validation at all.
 */
export function toFormState<T>(
  result: ActionResult<T>,
  successMessage: string,
  formData?: FormData,
): FormState {
  if (result.ok) {
    const carried =
      result.value && typeof result.value === 'object' && 'message' in result.value
        ? String((result.value as { message?: unknown }).message ?? successMessage)
        : successMessage

    // No `values` on success: a successful form resets, and handing the old input
    // back would refill a composer somebody has already moved on from.
    return { status: 'success', message: carried }
  }

  return {
    status: 'error',
    message: result.error,
    fieldErrors: result.fieldErrors,
    values: formData ? formInput(formData) : undefined,
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Refuse a suspended, banned or deactivated account.
 *
 * The authority is the database — migration 0020 refuses the row from a trigger,
 * and a direct PostgREST call never reaches this file at all. This mirrors the
 * same predicate so the user gets a sentence instead of a Postgres error, and
 * the mirror is stated as a mirror: if the two ever disagree, the database is
 * right and this is the bug.
 */
export const requireActiveAccount: Step<unknown> = async (ctx) => {
  const { data, error } = await ctx.supabase
    .from('profiles')
    .select('status, suspended_until')
    .eq('id', ctx.user.id)
    .maybeSingle<{ status: string; suspended_until: string | null }>()

  if (error) {
    console.error('[action:account]', error.code, error.message)
    return 'Your account could not be checked just now, so nothing was saved. Please try again.'
  }

  // A missing profile is a real state in this schema (a user can exist before
  // 0016's backfill gives them one), and it means the write would fail on RLS
  // anyway, so it is refused here with something legible.
  if (!data) {
    return 'Your profile has not been set up yet, so that could not be saved. Finish onboarding first.'
  }

  if (data.status === 'banned' || data.status === 'deactivated') {
    return 'This account cannot post. Get in touch if you think that is a mistake.'
  }

  if (data.status === 'suspended') {
    // Same rule as app.is_account_restricted(): a suspension that has run out is
    // not a suspension.
    const until = data.suspended_until ? Date.parse(data.suspended_until) : Number.NaN
    if (Number.isNaN(until) || until > Date.now()) {
      return 'Your account is suspended at the moment, so that could not be saved. Get in touch if you think that is a mistake.'
    }
  }

  return null
}

/**
 * Refuse a caller without the role.
 *
 * Reads `user_roles`, which no client can write (0002), so this is not a
 * privilege escalation vector — and it is not the boundary either: every table
 * these actions write is governed by a policy that checks the role again, in the
 * database.
 */
export function requireRole(role: 'moderator' | 'admin'): Step<unknown> {
  return async (ctx) => {
    const { data, error } = await ctx.supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', ctx.user.id)

    if (error) {
      console.error('[action:role]', error.code, error.message)
      return 'Your permissions could not be checked just now. Please try again.'
    }

    const held = (data ?? []).map((row) => (row as { role: string }).role)
    // An administrator implicitly holds every moderator capability, the same way
    // app.is_moderator() defines it.
    const allowed = role === 'moderator' ? held.includes('moderator') || held.includes('admin') : held.includes('admin')

    return allowed ? null : 'That is not available to your account.'
  }
}

/** Refuse a caller who has used up a bucket's budget. */
export function rateLimit(bucket: RateLimitBucket): Step<unknown> {
  return async () => {
    const verdict = await checkRateLimit(bucket)
    return verdict.allowed ? null : verdict.message
  }
}

/**
 * A domain-specific guard: "does this person own this row, and may they touch
 * it". The check is returned as a boolean and the refusal as copy, so the two
 * cannot drift apart in a chain of negations.
 */
export function guard<Input>(
  refusal: string,
  check: (ctx: ActionContext, input: Input) => Promise<boolean>,
): Step<Input> {
  return async (ctx, input) => ((await check(ctx, input)) ? null : refusal)
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

class ActionBuilder<Output> {
  constructor(
    private readonly schema: z.ZodType<Output>,
    private readonly steps: Step<Output>[],
  ) {}

  use(step: Step<Output>): ActionBuilder<Output> {
    return new ActionBuilder(this.schema, [...this.steps, step])
  }

  /**
   * Finish the definition. The returned function is the action: it takes what a
   * form (or a caller) supplied and returns a Result.
   */
  run<Value>(
    service: (args: ActionContext & { input: Output }) => Promise<Value>,
  ): (raw: unknown) => Promise<ActionResult<Value>> {
    return async (raw: unknown): Promise<ActionResult<Value>> => {
      if (!isSupabaseConfigured()) {
        return { ok: false, error: NOT_CONFIGURED, code: 'not_configured' }
      }

      const parsed = this.schema.safeParse(raw)
      if (!parsed.success) {
        const fieldErrors: Record<string, string> = {}
        for (const issue of parsed.error.issues) {
          fieldErrors[String(issue.path[0] ?? 'form')] ??= issue.message
        }
        return {
          ok: false,
          error: 'Check the fields marked below.',
          fieldErrors,
          code: 'invalid_input',
        }
      }

      const input = parsed.data

      let ctx: ActionContext
      try {
        const supabase = await createClient()
        // getUser(), never getSession(): getSession decodes the cookie without
        // verifying it, so a forged cookie would be believed. This call validates
        // the token with the auth server.
        const { data, error } = await supabase.auth.getUser()

        if (error) {
          console.error('[action:auth]', error.code, error.message)
          return { ok: false, error: NOT_SIGNED_IN, code: 'auth_error' }
        }

        if (!data.user) {
          return { ok: false, error: NOT_SIGNED_IN, code: 'unauthenticated' }
        }

        ctx = { supabase, user: data.user }
      } catch (error) {
        console.error('[action:client]', error)
        return { ok: false, error: NOT_CONFIGURED, code: 'client_error' }
      }

      for (const step of this.steps) {
        let refusal: string | null
        try {
          refusal = await step(ctx, input)
        } catch (error) {
          return toResult<Value>(error)
        }
        if (refusal) return { ok: false, error: refusal, code: 'refused' }
      }

      try {
        const value = await service({ ...ctx, input })
        return { ok: true, value }
      } catch (error) {
        return toResult<Value>(error)
      }
    }
  }
}

/**
 * Start an action definition.
 *
 * The schema is mandatory and is applied to whatever the caller supplied —
 * a FormData-derived object, or a value passed by another server module. There
 * is no unvalidated entry point.
 */
export function action<Output>(schema: z.ZodType<Output>): ActionBuilder<Output> {
  return new ActionBuilder<Output>(schema, [])
}

/**
 * Map anything thrown into a Result.
 *
 * A deliberate refusal keeps its sentence. Everything else is a bug: the code and
 * the raw message are logged, and the user gets the house sentence for that code
 * — never `error.message`, which for a PostgREST error names tables, columns and
 * constraints.
 */
function toResult<Value>(error: unknown): ActionResult<Value> {
  if (error instanceof ActionError) {
    return { ok: false, error: error.userMessage, fieldErrors: error.fieldErrors, code: 'refused' }
  }

  const shape =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown; message?: unknown })
      : {}

  const mapped = describeWriteError(
    {
      code: typeof shape.code === 'string' ? shape.code : undefined,
      message: typeof shape.message === 'string' ? shape.message : undefined,
    },
    'action',
  )

  return {
    ok: false,
    error: mapped.message ?? 'That could not be saved. Please try again.',
    code: typeof shape.code === 'string' ? shape.code : 'unknown',
  }
}
