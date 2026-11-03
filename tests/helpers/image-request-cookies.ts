import { AsyncLocalStorage } from 'node:async_hooks'

/** Test-only request context. Never grants an actor: db.mutate verifies its token. */
const requests = new AsyncLocalStorage<Request>()

export function runWithImageRequest<T>(request: Request, work: () => T): T {
  return requests.run(request, work)
}

/** Mock next/headers with the actual synthetic Request, not a caller-selected ID. */
export async function imageRequestCookies() {
  const header = requests.getStore()?.headers.get('cookie') ?? ''
  return {
    get(name: string) {
      const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`))
      return matches.length === 1 ? { name, value: matches[0].slice(name.length + 1) } : undefined
    },
  }
}

export async function imageRequestHeaders(): Promise<Headers> {
  return new Headers(requests.getStore()?.headers)
}
