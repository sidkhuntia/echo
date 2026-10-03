// A repository served from a workspace lives under /r/<id>/, so its API calls need that prefix. In a
// single-repository echo BASE is empty and nothing changes. Workspace routes (/ws/...) are never prefixed.
export const baseOf = pathname => (pathname.match(/^\/r\/[^/]+/) || [''])[0]
export const BASE = baseOf(globalThis.location?.pathname || '')
export const WS_ID = BASE ? decodeURIComponent(BASE.slice(3)) : ''
export const withBase = (u, base = BASE) => u.startsWith('/api/') ? base + u : u
// Browser storage is one store per origin, and a workspace is one origin, so a repository's own keys carry its id.
export const storeKey = (k, base = BASE, id = WS_ID) => base ? `${k}:${id}` : k
