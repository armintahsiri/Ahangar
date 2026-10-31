import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// .env is the same file docker-compose feeds the api container (`env_file: .env`), so read it
// here too and dev runs against the same settings (ADMIN_UIDS, INVITE_ONLY, …). Values already
// present in the real environment — e.g. ORIGIN/PORT that scripts/dev.js picks — keep precedence.
const env = { ...process.env }
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const key = t.slice(0, eq).trim()
    if (env[key] === undefined) env[key] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  }
} catch { /* no .env — plain defaults still apply */ }

const api = spawn(process.execPath, ['server.js'], {
  cwd: path.join(root, 'api'),
  env: {
    ...env,
    PORT: env.PORT || '3000',
    DATA_DIR: env.DATA_DIR || path.join(root, 'data'),
    ORIGIN: env.ORIGIN || 'http://localhost:5173',
  },
  stdio: 'inherit'
})

api.on('error', error => {
  console.error(`Could not start the API: ${error.message}`)
  process.exitCode = 1
})

api.on('exit', code => {
  process.exitCode = code ?? 1
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => api.kill(signal))
}
