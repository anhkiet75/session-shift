import http from 'node:http'
import net from 'node:net'

export interface MockCookieServer {
  server: http.Server
  url: string
}

/**
 * Starts a local HTTP server on a random OS-assigned port.
 * Binds to port 0 so parallel workers never collide on the same port.
 *
 * Routes:
 *   GET /set?name=value  → Set-Cookie header + 302 to /cookies
 *   GET /set-resource?name=value  → Set-Cookie header + 204
 *   GET /cookies         → reflects cookies as JSON { cookies: { ... } }
 */
export function startMockCookieServer(): MockCookieServer {
  const sockets = new Set<net.Socket>()

  const server = http.createServer((req, res) => {
    const port = (server.address() as net.AddressInfo).port
    const url = new URL(req.url!, `http://localhost:${port}`)

    if (url.pathname === '/set') {
      const cookies = [...url.searchParams].map(([n, v]) => `${n}=${v}; Path=/`)
      res.setHeader('Set-Cookie', cookies)
      res.writeHead(302, { Location: '/cookies' })
      res.end()
    } else if (url.pathname === '/set-resource') {
      const cookies = [...url.searchParams].map(([n, v]) => `${n}=${v}; Path=/`)
      res.setHeader('Set-Cookie', cookies)
      res.writeHead(204)
      res.end()
    } else {
      const raw = req.headers.cookie ?? ''
      const cookies = Object.fromEntries(
        raw.split(';')
          .map(c => c.trim().split('='))
          .filter(([k]) => k)
          .map(([k, ...v]) => [k, v.join('=')])
      )
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ cookies }))
    }
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

  // Port 0 → OS picks a free port; read it back after listen
  server.listen(0)
  const port = (server.address() as net.AddressInfo).port
  return { server, url: `http://localhost:${port}` }
}
