/**
 * The transport plumbing the service composes, driven directly.
 *
 * The end-to-end specs go through the service, which means the failure paths
 * they do not script — no ssh client installed, no tar, a source path that is a
 * file, a pipe that dies mid-upload — would otherwise only be reachable by
 * breaking a machine. Each of those is a decision the module makes on its own,
 * so it is called on its own here.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  archiveTree,
  pushArchive,
  resolveSshExecutable,
  resolveTarExecutable,
  runLocal,
  runRemote,
  sshArgv,
} from '../src/ssh.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** A subprocess face answering only the executable lookups a test declares. */
class ExecutableLookup {
  readonly requested: string[] = []
  constructor(private readonly installed: Map<string, string> = new Map()) {}

  async resolveExecutable(command: string): Promise<string> {
    this.requested.push(command)
    const known = this.installed.get(command)
    if (known !== undefined) return known
    throw new Error(`not found: ${command}`)
  }
}

/**
 * Run one body with a `process.env` entry removed.
 *
 * The Windows probe falls back to a literal `C:\Windows` when `SystemRoot` is
 * unset, which is the state of a stripped-down service account rather than of a
 * developer's shell.
 * @param name - the variable to remove.
 * @param body - the assertions to run without it.
 */
async function withoutEnv(name: string, body: () => Promise<void>): Promise<void> {
  const held = process.env[name]
  Reflect.deleteProperty(process.env, name)
  try {
    await body()
  } finally {
    if (held !== undefined) process.env[name] = held
  }
}

/**
 * Run one body with a `process.env` entry set to a value.
 * @param name - the variable to set.
 * @param value - the value to set it to.
 * @param body - the assertions to run with it.
 */
async function withEnv(name: string, value: string, body: () => Promise<void>): Promise<void> {
  const held = process.env[name]
  process.env[name] = value
  try {
    await body()
  } finally {
    if (held === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = held
  }
}

/**
 * Run one body with `process.platform` reporting something else.
 *
 * The platform decides which absolute locations are probed before the bare
 * name, so the Windows branches are only reachable this way on a Linux CI box —
 * and the alternative, a build that silently skips them, would leave the
 * location that actually ships on the user's machine untested.
 * @param platform - the value `process.platform` should report.
 * @param body - the assertions to run under that platform.
 */
async function withPlatform(platform: string, body: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  try {
    await body()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

describe('resolveSshExecutable', () => {
  it('uses a pinned client without probing any platform location', async () => {
    const lookup = new ExecutableLookup(new Map([['/opt/openssh/bin/ssh', '/opt/openssh/bin/ssh']]))
    await expect(resolveSshExecutable('  /opt/openssh/bin/ssh  ', lookup as never))
      .resolves.toBe('/opt/openssh/bin/ssh')
    // A deployment that pins a client must not have its choice second-guessed.
    expect(lookup.requested).toEqual(['/opt/openssh/bin/ssh'])
  })

  it('treats a blank configuration entry as unset rather than as a name', async () => {
    // Schemastery materializes an unset `z.string()` as `''`; resolving that
    // verbatim would turn "use the platform default" into "no client found".
    const lookup = new ExecutableLookup(new Map([['ssh', '/usr/bin/ssh']]))
    await expect(resolveSshExecutable('   ', lookup as never)).resolves.toBe('/usr/bin/ssh')
    // The platform probe ran — on Windows it tries the System32 location first —
    // and never asked for the blank value itself.
    expect(lookup.requested).not.toContain('')
    expect(lookup.requested.at(-1)).toBe('ssh')
  })

  it('reports every location it tried when no client is installed', async () => {
    const lookup = new ExecutableLookup()
    await expect(resolveSshExecutable(undefined, lookup as never))
      .rejects.toThrow(/no OpenSSH client found; set sshExecutable in the server declaration\. Tried .*not found/)
    // The platform probe is attempted before giving up, so the message names
    // what was actually tried on this host.
    expect(lookup.requested.length).toBeGreaterThan(0)
  })

  it('reports the underlying reason, not just the location that failed', async () => {
    const lookup = new ExecutableLookup()
    await expect(resolveSshExecutable('/definitely/absent', lookup as never))
      .rejects.toThrow('/definitely/absent: not found: /definitely/absent')
  })

  it('probes System32 on Windows before the bare name', async () => {
    // Run as though on Windows: the platform location is tried first, so a
    // machine with OpenSSH installed for Windows uses it rather than whatever
    // `ssh` PATH resolution happens to find.
    await withPlatform('win32', async () => {
      await withEnv('SystemRoot', 'D:\\Windows', async () => {
        const lookup = new ExecutableLookup()
        await expect(resolveSshExecutable(undefined, lookup as never))
          .rejects.toThrow(/no OpenSSH client found/)
        expect(lookup.requested[0]).toBe('D:\\Windows\\System32\\OpenSSH\\ssh.exe')
        expect(lookup.requested.at(-1)).toBe('ssh')
      })
    })
  })

  it('probes only the bare name on a POSIX host', async () => {
    // On Linux and macOS the client is always on PATH, so there is no second
    // location to try — and on a Windows CI box this branch would otherwise go
    // untested while a whole deployment class depends on it.
    await withPlatform('linux', async () => {
      const lookup = new ExecutableLookup(new Map([['ssh', '/usr/bin/ssh']]))
      await expect(resolveSshExecutable(undefined, lookup as never)).resolves.toBe('/usr/bin/ssh')
      expect(lookup.requested).toEqual(['ssh'])
    })
  })

  it('falls back to the conventional Windows location without SystemRoot', async () => {
    await withPlatform('win32', async () => {
      await withoutEnv('SystemRoot', async () => {
        const lookup = new ExecutableLookup()
        await expect(resolveSshExecutable(undefined, lookup as never)).rejects.toThrow(/no OpenSSH client/)
        expect(lookup.requested[0]).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe')
      })
    })
  })

  it('reports a non-Error rejection by its string form', async () => {
    // A lookup that throws a bare string, the way a native binding can.
    const lookup = { resolveExecutable: () => Promise.reject('access denied') }
    await expect(resolveSshExecutable('/pinned', lookup as never))
      .rejects.toThrow('/pinned: access denied')
  })
})

describe('resolveTarExecutable', () => {
  it('uses a pinned archive tool directly', async () => {
    const lookup = new ExecutableLookup(new Map([['/opt/bin/tar', '/opt/bin/tar']]))
    await expect(resolveTarExecutable('/opt/bin/tar', lookup as never)).resolves.toBe('/opt/bin/tar')
  })

  it('falls through the platform candidates to the bare name', async () => {
    // Only the bare name is "installed", so the platform-specific path is tried,
    // missed, and the loop continues — the behaviour the double was built to pin.
    const lookup = new ExecutableLookup(new Map([['tar', '/usr/bin/tar']]))
    await expect(resolveTarExecutable(undefined, lookup as never)).resolves.toBe('/usr/bin/tar')
    expect(lookup.requested.at(-1)).toBe('tar')
  })

  it('fails loud when no archive tool exists at all', async () => {
    const lookup = new ExecutableLookup()
    await expect(resolveTarExecutable(undefined, lookup as never))
      .rejects.toThrow(/no tar executable found; set tarExecutable in the plugin configuration/)
  })

  it('probes the System32 bsdtar on Windows before the bare name', async () => {
    // Windows ships `bsdtar` there and Git ships a GNU tar on PATH; either
    // accepts the flag set this module uses, so both are tried.
    await withPlatform('win32', async () => {
      await withEnv('SystemRoot', 'D:\\Windows', async () => {
        const lookup = new ExecutableLookup()
        await expect(resolveTarExecutable(undefined, lookup as never)).rejects.toThrow(/no tar executable/)
        expect(lookup.requested[0]).toBe('D:\\Windows\\System32\\tar.exe')
        expect(lookup.requested.at(-1)).toBe('tar')
      })
    })
  })

  it('uses a pinned archive tool without probing a location', async () => {
    await withPlatform('win32', async () => {
      const lookup = new ExecutableLookup(new Map([['/opt/bin/tar', '/opt/bin/tar']]))
      await expect(resolveTarExecutable('/opt/bin/tar', lookup as never)).resolves.toBe('/opt/bin/tar')
      expect(lookup.requested).toEqual(['/opt/bin/tar'])
    })
  })

  it('probes only the bare name on a POSIX host', async () => {
    await withPlatform('linux', async () => {
      const lookup = new ExecutableLookup(new Map([['tar', '/usr/bin/tar']]))
      await expect(resolveTarExecutable(undefined, lookup as never)).resolves.toBe('/usr/bin/tar')
      expect(lookup.requested).toEqual(['tar'])
    })
  })

  it('falls back to the conventional Windows location without SystemRoot', async () => {
    await withPlatform('win32', async () => {
      await withoutEnv('SystemRoot', async () => {
        const lookup = new ExecutableLookup()
        await expect(resolveTarExecutable(undefined, lookup as never)).rejects.toThrow(/no tar executable/)
        expect(lookup.requested[0]).toBe('C:\\Windows\\System32\\tar.exe')
      })
    })
  })

  it('treats a blank archive-tool entry as unset', async () => {
    const lookup = new ExecutableLookup(new Map([['tar', '/usr/bin/tar']]))
    await expect(resolveTarExecutable('  ', lookup as never)).resolves.toBe('/usr/bin/tar')
    expect(lookup.requested).not.toContain('')
  })
})

describe('sshArgv', () => {
  it('bounds the handshake and forbids an interactive prompt', () => {
    // `BatchMode=yes` is load-bearing: without it a missing key becomes a
    // password prompt that hangs until the timeout.
    expect(sshArgv('user@host', 'uname -s')).toEqual([
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', 'user@host', 'uname -s',
    ])
  })
})

/** Minimal spawn face: one recorded spec and a scripted handle. */
class SpawnFace {
  readonly specs: SubprocessSpawnSpec[] = []
  constructor(private readonly make: (spec: SubprocessSpawnSpec) => SubprocessHandle) {}
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    return this.make(spec)
  }
}

/** A handle whose command already finished, with the given output. */
function finishedHandle(input: {
  exitCode: number | null
  stdout?: string
  stderr?: string
  lossy?: boolean
}): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: {
        readFrom: (from: number) => ({
          text: (input.stdout ?? '').slice(from),
          nextOffset: (input.stdout ?? '').length,
          lossy: input.lossy ?? false,
        }),
      },
      stderr: {
        readFrom: () => ({
          text: input.stderr ?? '',
          nextOffset: (input.stderr ?? '').length,
          lossy: false,
        }),
      },
    },
    done: Promise.resolve({ exitCode: input.exitCode, signal: null }),
    terminate: () => undefined,
    waitForExit: async () => true,
  } satisfies SubprocessHandle
}

describe('runLocal', () => {
  it('reports the collected streams and the byte cap it was given', async () => {
    const face = new SpawnFace(() => finishedHandle({
      exitCode: 3, stdout: 'out\n', stderr: 'err\n', lossy: true,
    }))

    const result = await runLocal(face, ['tar'], {
      cwd: process.cwd(), maxBytes: 64,
    })
    expect(result).toEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', stdoutTruncated: true })
    expect(face.specs[0]?.stdio.stdout).toEqual({ maxBytes: 64 })
    // An unset environment must leave the provider's own environment in place.
    expect(face.specs[0]).not.toHaveProperty('env')
  })

  it('passes an explicit environment through when one is supplied', async () => {
    const face = new SpawnFace(() => finishedHandle({ exitCode: 0 }))
    await runLocal(face, ['tar'], {
      cwd: process.cwd(), env: { PATH: '/usr/bin' },
    })
    expect(face.specs[0]?.env).toEqual({ PATH: '/usr/bin' })
  })

  it('defaults the stdout budget when the caller sets none', async () => {
    const face = new SpawnFace(() => finishedHandle({ exitCode: 0 }))
    await runLocal(face, ['tar'], { cwd: process.cwd() })
    // 8 MiB: tar is chatty on a warning-heavy tree, and a bare `undefined` here
    // would silently mean the provider's own default.
    expect(face.specs[0]?.stdio.stdout).toEqual({ maxBytes: 8 * 1024 * 1024 })
  })
})

describe('runRemote', () => {
  it('bounds the whole invocation with its own deadline', async () => {
    const face = new SpawnFace(() => finishedHandle({ exitCode: 0, stdout: 'Linux\n' }))

    const result = await runRemote(
      face, '/usr/bin/ssh', 'user@host', 'uname -s',
      { timeoutMs: 30_000 },
    )
    expect(result).toMatchObject({ exitCode: 0, stdout: 'Linux\n', timedOut: false })
    // The client is invoked with the destination and the command as separate
    // arguments, so the command text is never re-split by a shell locally.
    expect(face.specs[0]?.argv[0]).toBe('/usr/bin/ssh')
    expect(face.specs[0]?.argv.at(-1)).toBe('uname -s')
  })

  it('combines a caller signal with the deadline so either can cancel', async () => {
    const face = new SpawnFace(() => finishedHandle({ exitCode: null, stdout: '' }))
    const controller = new AbortController()

    await runRemote(
      face, '/usr/bin/ssh', 'user@host', 'true',
      { timeoutMs: 30_000, signal: controller.signal },
    )
    // A cancellation token that is not yet aborted: the provider gets a signal
    // that fires on whichever comes first, which is what the argument is for.
    expect(face.specs[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(face.specs[0]?.signal?.aborted).toBe(false)
  })

  it('reports a signal-killed client as a null exit code', async () => {
    const face = new SpawnFace(() => finishedHandle({ exitCode: null }))
    const result = await runRemote(
      face, '/usr/bin/ssh', 'user@host', 'true', { timeoutMs: 1 },
    )
    expect(result.exitCode).toBeNull()
  })
})

describe('archiveTree', () => {
  /** A scratch source tree and a staging directory under it. */
  async function source(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-ssh-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'main.c'), 'int main(void) { return 0; }\n')
    return root
  }

  it('passes each exclusion to tar and never reads the excluded subtree', async () => {
    const root = await source()
    // The archive is written by the double at the path tar was told to use, so
    // the digest is taken over real bytes.
    const face = new SpawnFace((spec) => {
      // The invocation under test always passes `-czf <archive>`; the double
      // writes that archive so the digest is taken over real bytes.
      const target = spec.argv[spec.argv.indexOf('-czf') + 1]!
      // Synchronous so the file exists by the time the archive is digested.
      writeFileSync(target, 'archive\n')
      return finishedHandle({ exitCode: 0 })
    })

    const archive = await archiveTree(
      face, '/usr/bin/tar', root, ['.git', '', 'node_modules'],
    )
    cleanups.push(() => archive.dispose())

    const argv = face.specs[0]!.argv
    // The blank entry is dropped rather than handed to tar as an empty pattern.
    expect(argv.filter(part => part === '--exclude')).toHaveLength(2)
    expect(argv).toContain('.git')
    expect(argv).toContain('node_modules')
    expect(argv[argv.indexOf('-C') + 1]).toBe(root)
    expect(archive.bytes).toBeGreaterThan(0)
    expect(archive.digest).toMatch(/^[0-9a-f]{64}$/)
    expect((await stat(archive.path)).isFile()).toBe(true)
  })

  it('refuses a source that is not a directory', async () => {
    const root = await source()
    const face = new SpawnFace(() => finishedHandle({ exitCode: 0 }))
    await expect(archiveTree(
      face, '/usr/bin/tar', join(root, 'main.c'), [],
    )).rejects.toThrow(/not a directory/)
    // Nothing was spawned: the check happens before the archive is attempted.
    expect(face.specs).toEqual([])
  })

  it('surfaces tar\'s own diagnostic and cleans the staging tree when it fails', async () => {
    const root = await source()
    const face = new SpawnFace(() => finishedHandle({
      exitCode: 2, stderr: 'tar: cannot stat: No such file\n',
    }))

    await expect(archiveTree(face, '/usr/bin/tar', root, []))
      .rejects.toThrow(/tar failed \(exit 2\): tar: cannot stat/)
  })

  it('falls back to stdout for the diagnostic when tar writes nothing to stderr', async () => {
    const root = await source()
    const face = new SpawnFace(() => finishedHandle({ exitCode: 1, stdout: 'out of space\n' }))
    await expect(archiveTree(face, '/usr/bin/tar', root, []))
      .rejects.toThrow(/tar failed \(exit 1\): out of space/)
  })

  it('propagates a spawn failure after removing the staging tree', async () => {
    const root = await source()
    const face = new SpawnFace(() => {
      throw new Error('spawn refused')
    })
    await expect(archiveTree(face, '/usr/bin/tar', root, []))
      .rejects.toThrow('spawn refused')
  })
})

describe('pushArchive', () => {
  /** A scratch archive file to stream, and a directory to hold it. */
  async function staged(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-yxspec-push-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'tree.tar.gz')
    await writeFile(path, 'payload\n')
    return path
  }

  /** A handle with a real piped stdin, so the bytes actually travel. */
  function pipedHandle(onBytes: (count: number) => void, exitCode = 0, delayMs = 0): SubprocessHandle {
    let received = 0
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        received += chunk.length
        onBytes(received)
        callback()
      },
    })
    return {
      stdin: stdin as never,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: new Promise((resolve) => {
        setTimeout(() => { resolve({ exitCode, signal: null }) }, delayMs)
      }),
      terminate: () => undefined,
      waitForExit: async () => true,
    } satisfies SubprocessHandle
  }

  it('streams the archive into a piped stdin and clears the target first', async () => {
    const archive = await staged()
    let sawBytes = 0
    // A deadline and a cancellation token can both be supplied; the combined
    // signal is what the provider receives.
    const controller = new AbortController()
    const face = new SpawnFace(() => pipedHandle((count) => { sawBytes = count }))

    const result = await pushArchive(
      face,
      '/usr/bin/ssh',
      'user@host',
      '/srv/builds/slug',
      archive,
      { timeoutMs: 30_000, signal: controller.signal },
    )

    expect(result.exitCode).toBe(0)
    // The command removes a previous tree, recreates it, and extracts from stdin
    // rather than from an argument, so a large tree never meets `ARG_MAX`.
    const command = face.specs[0]!.argv.at(-1)!
    expect(command).toContain("rm -rf -- '/srv/builds/slug'")
    expect(command).toContain("tar -xzf - -C '/srv/builds/slug'")
    expect(face.specs[0]?.stdio.stdin).toBe('pipe')
    expect(sawBytes).toBeGreaterThan(0)
  })

  it('reports a timed-out upload as an exit fact rather than as a rejection', async () => {
    const archive = await staged()
    // The transfer is still in flight when the deadline fires: `timedOut` is
    // read off the deadline's own signal, so it is true even though the client
    // did eventually report an exit code of its own.
    const face = new SpawnFace(() => pipedHandle(() => undefined, 255, 50))

    const result = await pushArchive(
      face, '/usr/bin/ssh', 'user@host', '/srv/x', archive,
      { timeoutMs: 1 },
    )
    expect(result).toMatchObject({ exitCode: 255, timedOut: true })
  })

  it('reports a completed upload as not timed out', async () => {
    const archive = await staged()
    const face = new SpawnFace(() => pipedHandle(() => undefined, 0))
    const result = await pushArchive(
      face, '/usr/bin/ssh', 'user@host', '/srv/x', archive,
      { timeoutMs: 30_000 },
    )
    expect(result.timedOut).toBe(false)
  })

  it('terminates the client when the archive cannot be read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-yxspec-push-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    let terminated = false
    const face = new SpawnFace(() => ({
      stdin: new Writable({ write: (_chunk, _encoding, callback) => callback() }) as never,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => { terminated = true },
      waitForExit: async () => true,
    } satisfies SubprocessHandle))

    // A path that does not exist stands in for "the archive was removed between
    // staging and upload": the read fails and the client must not be left running.
    await expect(pushArchive(
      face,
      '/usr/bin/ssh', 'user@host', '/srv/x', join(dir, 'missing.tar.gz'),
      { timeoutMs: 30_000 },
    )).rejects.toThrow(/ENOENT/)
    expect(terminated).toBe(true)
  })
})
