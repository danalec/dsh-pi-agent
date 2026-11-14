/**
 * Load the DSH credential references into the environment.
 *
 * The DSH host resolves its credentials into the process environment at
 * boot, and the Pi child inherits that environment. A tool that runs
 * outside the host has to do the same: the credentials live in
 * `~/.dsh/.credentials.yaml` as `refs`, one entry per environment
 * variable.
 *
 * The values are never printed.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * Load the credential references into `process.env`.
 *
 * @returns the names of the variables that were loaded.
 */
export function loadDshCredentials() {
  const file = `${homedir()}/.dsh/.credentials.yaml`
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const loaded = []
  let inRefs = false
  for (const line of text.split('\n')) {
    if (line.startsWith('refs:')) {
      inRefs = true
      continue
    }
    if (!inRefs || !line.trim()) continue
    const match = /^ {2}([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    const [, name, value] = match
    if (value === '') continue
    process.env[name] = value
    loaded.push(name)
  }
  return loaded
}
