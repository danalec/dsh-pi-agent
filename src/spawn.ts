/**
 * Cross-platform process launch for the Pi executable.
 *
 * Pi is installed as a command shim. On POSIX that is an executable shell
 * script and `spawn` runs it directly. On Windows the same shim is a `.cmd`
 * batch file, and Node refuses to execute a batch file without a shell
 * (`spawn EINVAL`) while the extensionless POSIX shim next to it is not a
 * valid Win32 image at all (`spawn ENOENT`). Launching the batch file through
 * `cmd.exe` with explicitly quoted arguments is the only portable way to run
 * it — and quoting every argument keeps the command line injection-free.
 */

import { spawn, type ChildProcessByStdio, type StdioOptions } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'

/** Executable extensions Windows accepts. */
const WINDOWS_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat']

export interface SpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: StdioOptions
  signal?: AbortSignal
  windowsHide?: boolean
}

/**
 * Resolve a command to an executable file on Windows.
 *
 * Only PATHEXT-style extensions are considered: the extensionless POSIX shim
 * that npm-style installers drop next to the `.cmd` file is not a runnable
 * Win32 image.
 *
 * @returns the resolved path, or `undefined` when nothing matched.
 */
export function resolveWindowsExecutable(command: string): string | undefined {
  const lower = command.toLowerCase()
  const hasExtension = WINDOWS_EXTENSIONS.some((extension) => lower.endsWith(extension))
  const candidates: string[] = []
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    candidates.push(command)
    if (!hasExtension) {
      for (const extension of WINDOWS_EXTENSIONS) candidates.push(`${command}${extension}`)
    }
  } else {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      if (directory === '') continue
      if (hasExtension) {
        candidates.push(join(directory, command))
      } else {
        for (const extension of WINDOWS_EXTENSIONS) candidates.push(join(directory, `${command}${extension}`))
      }
    }
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // not a candidate
    }
  }
  return undefined
}

/** Quote one argument for a `cmd.exe` command line. */
function quoteArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** A child process whose stdout and stderr are pipes. */
export type PipedChild = ChildProcessByStdio<null, Readable, Readable>

/**
 * Spawn the Pi executable.
 *
 * On Windows a `.cmd`/`.bat` shim is launched through `cmd.exe` with every
 * argument quoted; everything else is spawned directly.
 */
export function spawnPi(command: string, args: string[], options: SpawnOptions): PipedChild {
  if (process.platform === 'win32') {
    const resolved = resolveWindowsExecutable(command)
    if (resolved !== undefined && /\.(cmd|bat)$/i.test(resolved)) {
      const commandLine = [quoteArgument(resolved), ...args.map(quoteArgument)].join(' ')
      // `cmd /s /c` strips the outermost quote pair of the command string, so
      // the line is wrapped once more to keep the shim's own path quoted.
      // `windowsVerbatimArguments` keeps Node from re-escaping the quotes
      // into `\"`, which cmd.exe does not understand.
      return spawn(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `"${commandLine}"`],
        { ...options, windowsVerbatimArguments: true },
      ) as PipedChild
    }
  }
  return spawn(command, args, options) as PipedChild
}
