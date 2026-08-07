import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import crypto from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public')
const PORT = Number(process.env.PORT ?? 3000)
const SESSION_COOKIE = 'session_id'
const USERS = { admin: 'admin', demo: 'demo' }

const sessions = new Map() // token -> username on top of the stateless default

async function render(templatePath, vars = {}) {
  let html = await readFile(join(ROOT, templatePath), 'utf8')
  for (const [key, value] of Object.entries(vars)) {
    html = html.replaceAll(`__${key}__`, value)
  }
  return html
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const method = req.method

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true }))
  }

  // Login API
  if (method === 'POST' && url.pathname === '/api/login') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { username, password } = JSON.parse(body || '{}')

    if (!username || !password) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Invalid credentials' }))
    }

    const token = crypto.randomUUID()
    sessions.set(token, username)
    res.writeHead(302, {
      'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/`,
      Location: '/dashboard',
    })
    return res.end()
  }

  // Logout
  if (url.pathname === '/logout') {
    const token = parseCookie(req, SESSION_COOKIE)
    if (token) sessions.delete(token)
    res.writeHead(302, {
      'Set-Cookie': `${SESSION_COOKIE}=; Max-Age=0; Path=/`,
      Location: '/login',
    })
    return res.end()
  }

  const token = parseCookie(req, SESSION_COOKIE)
  const username = token ? sessions.get(token) : undefined

  // Protected: dashboard
  if (url.pathname === '/dashboard') {
    if (!username) {
      res.writeHead(302, { Location: '/login' })
      return res.end()
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(await render('dashboard.html', { USERNAME: username }))
  }

  // Unprotected pages + static
  if (url.pathname === '/' || url.pathname === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(await render('login.html'))
  }

  if (url.pathname === '/whoami') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ loggedIn: !!username, username: username ?? null }))
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

function parseCookie(req, name) {
  const raw = req.headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return undefined
}

server.listen(PORT, () => {
  console.log(`[login-test-server] http://localhost:${PORT}`)
  console.log(`  Credentials: admin/admin or demo/demo`)
})