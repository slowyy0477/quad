import { LEGACY_THEME_STORAGE_KEY, THEME_STORAGE_KEY } from './theme-config'

/**
 * The theme is applied before the first paint.
 *
 * A `useEffect` would run after React hydrates, which means a reader who chose dark mode
 * gets a white flash on every navigation. This is the one legitimate inline script in
 * the project: it runs synchronously in `<head>`, does one local read and one
 * classList toggle, and touches nothing else.
 *
 * When the CSP lands (M7) it needs a nonce or a hash. That is noted here so the person
 * adding the CSP does not discover it by breaking dark mode.
 */
export function ThemeScript({ nonce }: { nonce?: string } = {}) {
  const code = `(function(){try{var c=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})||localStorage.getItem(${JSON.stringify(LEGACY_THEME_STORAGE_KEY)})||'system';var d=c==='dark'||(c==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})();`

  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: code }} />
}
