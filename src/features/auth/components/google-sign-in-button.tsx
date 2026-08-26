import { signInWithGoogleAction } from '@/features/auth/actions'
import { SubmitButton } from '@/components/ui/submit-button'

/**
 * Google sign-in.
 *
 * A form, not an onClick handler, so it needs no client JavaScript: the Server
 * Action builds the provider URL (which requires the anon key and the configured
 * redirect origin) and redirects. Doing it client-side would mean assembling the
 * OAuth URL in the browser and would break with JS disabled.
 *
 * The mark is inline SVG in Google's four brand colours because their sign-in
 * branding guidelines require the unmodified logo.
 */
export function GoogleSignInButton({ next, disabled }: { next: string; disabled?: boolean }) {
  return (
    <form action={signInWithGoogleAction}>
      <input type="hidden" name="next" value={next} />
      <SubmitButton variant="secondary" block pendingLabel="Redirecting to Google…" disabled={disabled}>
        <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
          <path
            fill="#4285F4"
            d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.64h6.19a5.3 5.3 0 0 1-2.3 3.48v2.9h3.72c2.17-2 3.45-4.95 3.45-8.57Z"
          />
          <path
            fill="#34A853"
            d="M12 24c3.11 0 5.72-1.03 7.63-2.79l-3.72-2.89c-1.03.69-2.35 1.1-3.91 1.1-3 0-5.54-2.03-6.44-4.75H1.76v3c1.9 3.77 5.8 6.33 10.24 6.33Z"
          />
          <path
            fill="#FBBC05"
            d="M5.56 14.67a7.2 7.2 0 0 1 0-4.6v-3h-3.8a11.98 11.98 0 0 0 0 10.6l3.8-3Z"
          />
          <path
            fill="#EA4335"
            d="M12 4.75c1.69 0 3.2.58 4.4 1.72l3.29-3.29C17.71 1.19 15.1 0 12 0 7.56 0 3.66 2.56 1.76 6.33l3.8 3c.9-2.72 3.44-4.58 6.44-4.58Z"
          />
        </svg>
        Continue with Google
      </SubmitButton>
    </form>
  )
}
