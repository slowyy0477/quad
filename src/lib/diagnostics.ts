import 'server-only'
import { notFound } from 'next/navigation'

/**
 * Internal build/configuration diagnostics are a development tool, not a
 * public product endpoint. Deny production, tests and unknown environments
 * before reading or rendering diagnostic details.
 */
export function requireDevelopmentDiagnostics(): void {
  if (process.env.NODE_ENV !== 'development') notFound()
}
