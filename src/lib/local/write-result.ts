import 'server-only'

import { MutationLimitError } from './mutation-limits'

type LimitedForm = {
  status: 'error'
  message: string
  values?: Record<string, string>
  body?: string
  projectId?: string
  goalId?: string
}

function message(error: MutationLimitError) {
  return `You are making changes too quickly. Try again in ${error.retryAfterSeconds} seconds. Nothing from this attempt was saved.`
}

/** Only expected budget refusals are handled; storage/auth errors still fail closed. */
export async function localFormWrite<T>(
  operation: () => Promise<T>,
  form?: FormData,
): Promise<T | LimitedForm> {
  try { return await operation() } catch (error) {
    if (!(error instanceof MutationLimitError)) throw error
    const values = form ? Object.fromEntries([...form.entries()]
      .filter(([key, value]) => typeof value === 'string' && !/password|secret|token|code/i.test(key))
      .map(([key, value]) => [key, String(value).slice(0, 10_000)])) : undefined
    return {
      status: 'error', message: message(error), ...(values ? { values } : {}),
      ...(values?.body !== undefined ? { body: values.body } : {}),
      ...(values?.projectId !== undefined ? { projectId: values.projectId } : {}),
      ...(values?.goalId !== undefined ? { goalId: values.goalId } : {}),
    }
  }
}

export async function localInteractionWrite<T>(
  operation: () => Promise<T>,
): Promise<T | { ok: false; message: string }> {
  try { return await operation() } catch (error) {
    if (!(error instanceof MutationLimitError)) throw error
    return { ok: false, message: message(error) }
  }
}
