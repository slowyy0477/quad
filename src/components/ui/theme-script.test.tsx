import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import vm from 'node:vm'
import { ThemeScript } from './theme-script'

function prepaint(values: Record<string, string>) {
  let dark = false
  const html = renderToStaticMarkup(<ThemeScript nonce="test-nonce" />)
  const code = html.slice(html.indexOf('>') + 1, html.lastIndexOf('</script>'))
  vm.runInNewContext(code, {
    localStorage: { getItem: (key: string) => values[key] ?? null },
    window: { matchMedia: () => ({ matches: false }) },
    document: { documentElement: { classList: { toggle: (_name: string, value: boolean) => { dark = value } } } },
  })
  return { dark, html }
}

describe('Bulla theme continuity', () => {
  it('keeps an existing legacy dark preference before paint', () => {
    expect(prepaint({ 'quad-theme': 'dark' }).dark).toBe(true)
  })

  it('gives an explicit Bulla preference priority', () => {
    expect(prepaint({ 'quad-theme': 'dark', 'bulla-theme': 'light' }).dark).toBe(false)
  })

  it('preserves the request CSP nonce', () => {
    expect(prepaint({}).html).toContain('nonce="test-nonce"')
  })
})
