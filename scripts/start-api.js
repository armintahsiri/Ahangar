import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const api = spawn(process.execPath, ['server.js'], {
  cwd: path.join(root, 'api'),
  env: {
    ...process.env,
    PORT: process.env.PORT || '3000',
    DATA_DIR: process.env.DATA_DIR || path.join(root, 'data'),
    ORIGIN: process.env.ORIGIN || 'http://localhost:5173',
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
