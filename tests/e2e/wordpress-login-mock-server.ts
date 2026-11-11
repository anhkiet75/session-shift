import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'

/**
 * WordPress-login-semantics server for cookie-delivery tests. WordPress checks
 * its cookies more strictly than most sites, so it is where a profile tab that
 * silently lost them shows first:
 *
 * - `GET /wp-login.php` sets `wordpress_test_cookie` (Path=/).
 * - `POST /wp-login.php` without that cookie answers "Cookies are blocked or
 *   not supported by your browser", exactly like wp-login.php.
 * - A successful login sets the auth cookie on Path=/wp-admin (and
 *   /wp-content/plugins) and the logged-in cookie on Path=/, then redirects to
 *   `/wp-admin/`.
 * - `/wp-admin/` needs the auth cookie AND the logged-in cookie; otherwise it
 *   redirects to `/wp-login.php?reauth=1`.
 * - `wp-login.php?reauth=1` clears the auth cookies of whoever arrives.
 * - `/go?to=<url>` redirects there without setting a cookie (a plain link hop).
 *
 * The server listens on `localhost`; `127.0.0.1` on the same port is a second
 * cookie host and a different site (cookies ignore ports, not hostnames).
 */

const HASH = 'e2e'
export const TEST_COOKIE = 'wordpress_test_cookie'
export const AUTH_COOKIE = `wordpress_${HASH}`
export const LOGGED_IN_COOKIE = `wordpress_logged_in_${HASH}`
export const WP_USER = 'admin'
export const WP_PASSWORD = 'admin123'
export const COOKIES_BLOCKED_ERROR = 'Cookies are blocked or not supported by your browser.'

export type WordPressLogEntry = {
  method: string
  /** Path plus query string. */
  path: string
  host: string
  /** Names of the cookies the request carried, sorted. */
  cookies: string[]
  status: number
}

export interface WordPressLoginServer {
  server: http.Server
  /** `http://localhost:<port>` */
  url: string
  /** `http://127.0.0.1:<port>` — a different cookie host and site, same server. */
  altUrl: string
  log: WordPressLogEntry[]
  /** A valid login token, as if a browser had logged in (no browser round trip). */
  issueLogin(): string
}

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

export function startWordPressLoginServer(): WordPressLoginServer {
  const logins = new Set<string>()
  const log: WordPressLogEntry[] = []
  const sockets = new Set<net.Socket>()
  const issueLogin = () => {
    const token = crypto.randomBytes(16).toString('hex')
    logins.add(token)
    return token
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    let raw = ''
    for await (const chunk of req) raw += chunk
    const cookies = parseCookies(req.headers.cookie)

    const send = (status: number, body: string, headers: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', ...headers })
      res.end(body)
      log.push({
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        host: url.hostname,
        cookies: Object.keys(cookies).sort(),
        status,
      })
    }

    const path = url.pathname
    if (path === '/wp-login.php' && req.method === 'POST') {
      const form = new URLSearchParams(raw)
      if (!(TEST_COOKIE in cookies)) {
        return send(200, page('Log In', `<div id="login_error">${COOKIES_BLOCKED_ERROR}</div>`))
      }
      if (form.get('log') !== WP_USER || form.get('pwd') !== WP_PASSWORD) {
        return send(200, page('Log In', '<div id="login_error">Wrong credentials.</div>'))
      }
      const token = issueLogin()
      return send(302, '', {
        Location: '/wp-admin/',
        'Set-Cookie': [
          `${AUTH_COOKIE}=${token}; Path=/wp-content/plugins; HttpOnly`,
          `${AUTH_COOKIE}=${token}; Path=/wp-admin; HttpOnly`,
          `${LOGGED_IN_COOKIE}=${token}; Path=/; HttpOnly`,
        ],
      })
    }
    if (path === '/wp-login.php') {
      const setCookie = [`${TEST_COOKIE}=WP%20Cookie%20check; Path=/`]
      if (url.searchParams.get('reauth') === '1') {
        // wp_clear_auth_cookie(): forces a fresh login for whoever arrives.
        setCookie.push(
          `${AUTH_COOKIE}=; Path=/wp-content/plugins; Max-Age=0`,
          `${AUTH_COOKIE}=; Path=/wp-admin; Max-Age=0`,
          `${LOGGED_IN_COOKIE}=; Path=/; Max-Age=0`,
        )
      }
      return send(200, page('Log In', `<form method="POST" action="/wp-login.php">
        <input id="user_login" name="log"><input id="user_pass" name="pwd" type="password">
        <button id="wp-submit">Log In</button></form>`), { 'Set-Cookie': setCookie })
    }
    if (path === '/wp-admin/' || path.startsWith('/wp-admin/')) {
      const token = cookies[AUTH_COOKIE]
      if (!token || !logins.has(token) || cookies[LOGGED_IN_COOKIE] !== token) {
        return send(302, '', { Location: '/wp-login.php?reauth=1' })
      }
      return send(200, page('Dashboard', `<p id="dashboard">Howdy, ${WP_USER}</p>`))
    }
    if (path === '/go') return send(302, '', { Location: url.searchParams.get('to') ?? '/' })
    if (path === '/') {
      const link = url.searchParams.get('link')
      return send(200, page('Home', link ? `<a id="link" href="${link}">link</a>` : ''))
    }
    return send(404, page('Not found'))
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
    issueLogin,
  }
}
