import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'

/**
 * Laravel-semantics session server for isolation tests. The plain cookie echo
 * server cannot catch session bugs: these need a server that behaves like
 * Laravel's StartSession + VerifyCsrfToken + auth/guest middleware.
 *
 * - Every web response re-sends `laravel_session` (HttpOnly) and `XSRF-TOKEN`.
 * - POST requires `_token` / `X-CSRF-TOKEN` / `X-XSRF-TOKEN` == session token, else 419.
 * - Login regenerates the session id AND the token; the old session is destroyed.
 * - Logout invalidates the session and regenerates the token.
 * - An unknown session id starts a fresh guest session.
 * - A wrong password flashes an error shown by exactly one following request.
 * - SSO: `POST /sso/login` on one host issues a ticket and redirects to the
 *   other host's `/sso/accept`, which starts a logged-in session there.
 *
 * The server listens on `localhost`; `127.0.0.1` on the same port is a second
 * cookie host (cookies ignore ports, not hostnames).
 */

type Session = { token: string; user: string | null; flash: string | null }

export type SessionLogEntry = {
  method: string
  /** Path plus query string. */
  path: string
  host: string
  /** Session id the request carried, or null when it had none. */
  got: string | null
  /** Session id the response set. */
  set: string
  status: number
}

export interface LaravelSessionServer {
  server: http.Server
  /** `http://localhost:<port>` */
  url: string
  /** `http://127.0.0.1:<port>` — a different cookie host, same server. */
  altUrl: string
  log: SessionLogEntry[]
  /** Creates a logged-in session directly (no browser round trip). */
  sessionUser(id: string | null): string | null
}

export const VALID_PASSWORD = 'secret'
export const WRONG_PASSWORD_FLASH = 'These credentials do not match our records.'

const page = (title: string, body = '') =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

export function startLaravelSessionServer(): LaravelSessionServer {
  const sessions = new Map<string, Session>()
  const tickets = new Map<string, string>()
  const log: SessionLogEntry[] = []
  const random = () => crypto.randomBytes(16).toString('hex')
  const newSession = (user: string | null = null) => {
    const id = random()
    sessions.set(id, { token: random(), user, flash: null })
    return id
  }
  const sockets = new Set<net.Socket>()

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    let raw = ''
    for await (const chunk of req) raw += chunk
    const cookies = parseCookies(req.headers.cookie)
    const got = cookies.laravel_session ?? null
    let sid = got && sessions.has(got) ? got : newSession()
    let session = sessions.get(sid)!
    const wantsJson = req.headers['x-requested-with'] === 'XMLHttpRequest' ||
      (req.headers.accept ?? '').includes('json') || Boolean(req.headers['x-inertia'])

    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        'Content-Type': body.startsWith('<') ? 'text/html' : 'application/json',
        'Cache-Control': 'no-store',
        'Set-Cookie': [
          `laravel_session=${sid}; Path=/; HttpOnly; SameSite=Lax`,
          `XSRF-TOKEN=${encodeURIComponent(session.token)}; Path=/; SameSite=Lax`,
        ],
        ...headers,
      })
      res.end(body)
      log.push({ method: req.method ?? 'GET', path: url.pathname + url.search, host: url.hostname, got, set: sid, status })
    }
    const redirect = (location: string) => send(302, '', { Location: location })

    if (req.method === 'POST') {
      const form = new URLSearchParams(req.headers['content-type']?.includes('json') ? '' : raw)
      const xsrf = req.headers['x-xsrf-token']
      const sent = form.get('_token') ?? req.headers['x-csrf-token'] ??
        (typeof xsrf === 'string' ? decodeURIComponent(xsrf) : undefined)
      if (sent !== session.token) return send(419, JSON.stringify({ message: 'CSRF token mismatch.' }))
    }

    const path = url.pathname
    if (path === '/login' && req.method === 'GET') {
      if (session.user) return redirect('/dashboard')
      const flash = session.flash
      session.flash = null // one-shot, like Laravel's flashed errors
      return send(200, page('login', `${flash ? `<p id="error">${flash}</p>` : ''}
        <form method="POST" action="/login"><input type="hidden" name="_token" value="${session.token}">
        <input id="password" name="password" value="${VALID_PASSWORD}"><button id="submit">Log in</button></form>`))
    }
    if (path === '/login' && req.method === 'POST') {
      const password = new URLSearchParams(raw).get('password')
      if (!wantsJson && password !== null && password !== VALID_PASSWORD) {
        session.flash = WRONG_PASSWORD_FLASH
        return redirect('/login')
      }
      sessions.delete(sid) // session()->regenerate(): new id and new token
      sid = newSession('admin')
      session = sessions.get(sid)!
      if (!wantsJson || req.headers['x-inertia']) return redirect('/dashboard')
      return send(204, '')
    }
    if (path === '/logout' && req.method === 'POST') {
      sessions.delete(sid)
      sid = newSession()
      session = sessions.get(sid)!
      return redirect('/login')
    }
    if (path === '/sso/login' && req.method === 'POST') {
      const ticket = random()
      tickets.set(ticket, 'admin')
      const target = url.hostname === 'localhost' ? '127.0.0.1' : 'localhost'
      return redirect(`http://${target}:${url.port}/sso/accept?ticket=${ticket}`)
    }
    if (path === '/sso/accept') {
      const user = tickets.get(url.searchParams.get('ticket') ?? '')
      if (!user) return redirect('/login')
      tickets.delete(url.searchParams.get('ticket') ?? '')
      sessions.delete(sid)
      sid = newSession(user)
      session = sessions.get(sid)!
      return redirect('/dashboard')
    }
    if (path === '/dashboard' || path === '/api/user') {
      if (!session.user) {
        return wantsJson && !req.headers['x-inertia']
          ? send(401, JSON.stringify({ message: 'Unauthenticated.' }))
          : redirect('/login')
      }
      return wantsJson
        ? send(200, JSON.stringify({ user: session.user }))
        : send(200, page('dashboard', `<p id="user">${session.user}</p>`))
    }
    if (path === '/page') return send(200, page('page'))
    // A genuine 3xx document: no Location, so the browser renders its body.
    if (path === '/multiple-choices') return send(300, page('choices', '<p id="choices">pick one</p>'))
    return send(404, JSON.stringify({ message: 'Not found.' }))
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const origClose = server.close.bind(server)
  server.close = (cb?: (err?: Error) => void) => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    return origClose(cb)
  }

  server.listen(0)
  const port = (server.address() as net.AddressInfo).port
  return {
    server,
    url: `http://localhost:${port}`,
    altUrl: `http://127.0.0.1:${port}`,
    log,
    sessionUser: (id) => (id ? sessions.get(id)?.user ?? null : null),
  }
}
