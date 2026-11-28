/**
 * The transport plumbing the service composes, driven directly.
 *
 * The end-to-end specs go through the service, which means the failure paths
 * they do not script — no ssh client installed, no tar, a byte ceiling hit
 * mid-stream, a remote tool that exits nonzero — would otherwise only be
 * reachable by breaking a machine. Each of those is a decision the module
 * makes on its own, so it is called on its own here.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  extractArchive,
  fetchArchive,
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

/**
 * A handle whose stdout is the live readable a test scripts, as the fetch's
 * `stdout: 'pipe'` spawn produces. Only stderr is collected on this shape; the
 * archive travels on the raw pipe, so no collected stdout reader exists.
 */
function streamingHandle(
  stdout: Readable,
  input: {
    exitCode?: number | null
    stderr?: string
    onTerminate?: () => void
  } = {},
): SubprocessHandle {
  return {
    stdin: undefined,
    stdout,
    stderr: undefined,
    control: undefined,
    collected: {
      // Absent rather than present-and-undefined: the handle type declares the reader as
      // optional under exactOptionalPropertyTypes, so a stdout this double does not collect
      // must not appear as a key at all.
      stderr: {
        readFrom: () => ({
          text: input.stderr ?? '',
          nextOffset: (input.stderr ?? '').length,
          lossy: false,
        }),
      },
    },
    done: Promise.resolve({ exitCode: input.exitCode ?? 0, signal: null }),
    terminate: () => input.onTerminate?.(),
    waitForExit: async () => true,
  } satisfies SubprocessHandle
}

/** A readable that emits one chunk and then ends, as a scripted pipe would. */
function singleChunkStream(chunk: Buffer | string): Readable {
  const stream = new Readable({ read() {} })
  stream.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
  stream.push(null)
  return stream
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

describe('fetchArchive', () => {
  /** A scratch directory for the archive a fetch writes. */
  async function staging(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-yxspec-fetch-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    return dir
  }

  it('builds one quoted tar command run from inside the output directory', async () => {
    const dir = await staging()
    const face = new SpawnFace(() => streamingHandle(singleChunkStream('archive\n')))

    const archive = await fetchArchive(
      face, '/usr/bin/ssh', 'user@host', '/srv/out',
      ['system.img', 'sub/app.bin'],
      { archivePath: join(dir, 'products.tar.gz'), maxBytes: 1024 * 1024 },
      { timeoutMs: 30_000 },
    )

    // Every path is single-quoted after `--`, so a product name is never read
    // as a tar option and the packing runs from the declared output directory.
    expect(face.specs[0]?.argv.at(-1)).toBe(
      "set -e; cd '/srv/out'; tar -czf - -- 'system.img' 'sub/app.bin'",
    )
    expect(face.specs[0]?.argv[0]).toBe('/usr/bin/ssh')
    expect(face.specs[0]?.argv.at(-2)).toBe('user@host')
    // The archive travels on the child's stdout, so stdout must be a raw pipe
    // while stdin stays closed — the fetch sends nothing to the server.
    expect(face.specs[0]?.stdio.stdout).toBe('pipe')
    expect(face.specs[0]?.stdio.stdin).toBe('ignore')
    expect(archive).toEqual({ bytes: 'archive\n'.length })
  })

  it('streams the bytes it reads into the archive file on disk', async () => {
    const dir = await staging()
    const payload = 'past-the-header-this-is-the-products-tarball\n'
    const face = new SpawnFace(() => streamingHandle(singleChunkStream(payload)))
    const archivePath = join(dir, 'products.tar.gz')

    const archive = await fetchArchive(
      face, '/usr/bin/ssh', 'user@host', '/srv/out', ['a.img'],
      { archivePath, maxBytes: 1024 * 1024 },
      { timeoutMs: 30_000 },
    )

    expect(archive.error).toBeUndefined()
    expect(archive.bytes).toBe(payload.length)
    // What landed on disk is exactly what the client streamed: the file is the
    // archive the extraction step will open, not a summary of it.
    expect((await readFile(archivePath)).toString()).toBe(payload)
  })

  it('aborts past the byte ceiling with an actionable error', async () => {
    const dir = await staging()
    let terminated = false
    // One chunk larger than the ceiling stands in for a product tree named by
    // accident; the EOF queued behind it lets the read settle after the abort.
    const face = new SpawnFace(() => streamingHandle(singleChunkStream('x'.repeat(64)), {
      onTerminate: () => { terminated = true },
    }))

    const archive = await fetchArchive(
      face, '/usr/bin/ssh', 'user@host', '/srv/out', ['out/'],
      { archivePath: join(dir, 'products.tar.gz'), maxBytes: 8 },
      { timeoutMs: 30_000 },
    )

    expect(archive.error).toBe(
      'the products exceed the 8-byte fetch ceiling; name fewer or smaller paths',
    )
    // The counting stopped at the chunk that crossed the ceiling, and the
    // client was told to stop rather than being left to finish the transfer.
    expect(archive.bytes).toBe(64)
    expect(terminated).toBe(true)
  })

  it('surfaces the client stderr when the remote side exits nonzero', async () => {
    const dir = await staging()
    const face = new SpawnFace(() => streamingHandle(singleChunkStream(''), {
      exitCode: 255, stderr: 'tar: system.img: Cannot open: No such file or directory\n',
    }))

    const archive = await fetchArchive(
      face, '/usr/bin/ssh', 'user@host', '/srv/out', ['system.img'],
      { archivePath: join(dir, 'products.tar.gz'), maxBytes: 1024 * 1024 },
      { timeoutMs: 30_000 },
    )
    // The client's own words are the diagnostic a caller can act on; an
    // anonymous exit code would send the operator reading ssh manuals.
    expect(archive.error).toBe('tar: system.img: Cannot open: No such file or directory')
  })

  it('falls back to naming the exit code when the client wrote no diagnostic', async () => {
    const dir = await staging()
    const face = new SpawnFace(() => streamingHandle(singleChunkStream(''), { exitCode: 2 }))

    const archive = await fetchArchive(
      face, '/usr/bin/ssh', 'user@host', '/srv/out', ['system.img'],
      { archivePath: join(dir, 'products.tar.gz'), maxBytes: 1024 * 1024 },
      { timeoutMs: 30_000 },
    )
    expect(archive.error).toBe('remote tar exited 2')
  })

  it('combines a caller signal with the deadline', async () => {
    const dir = await staging()
    const controller = new AbortController()
    const face = new SpawnFace(() => streamingHandle(singleChunkStream('archive\n')))

    await fetchArchive(
      face, '/usr/bin/ssh', 'user@host', '/srv/out', ['a.img'],
      { archivePath: join(dir, 'products.tar.gz'), maxBytes: 1024 * 1024 },
      { timeoutMs: 30_000, signal: controller.signal },
    )
    expect(face.specs[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(face.specs[0]?.signal?.aborted).toBe(false)
  })
})

describe('extractArchive', () => {
  it('expands the archive into the target directory with tar', async () => {
    const face = new SpawnFace(() => finishedHandle({ exitCode: 0 }))

    await expect(extractArchive(face, '/usr/bin/tar', '/tmp/products.tar.gz', '/tmp/run'))
      .resolves.toBeUndefined()
    expect(face.specs[0]?.argv).toEqual([
      '/usr/bin/tar', '-xzf', '/tmp/products.tar.gz', '-C', '/tmp/run',
    ])
    // The extraction runs with the target as its working directory, matching
    // the `-C` the archive's relative paths assume.
    expect(face.specs[0]?.cwd).toBe('/tmp/run')
    expect(face.specs[0]?.signal).toBeUndefined()
  })

  it('carries a caller cancellation into the extraction', async () => {
    const face = new SpawnFace(() => finishedHandle({ exitCode: 0 }))
    const controller = new AbortController()
    await extractArchive(face, '/usr/bin/tar', '/tmp/a.tar.gz', '/tmp/run', { signal: controller.signal })
    expect(face.specs[0]?.signal).toBe(controller.signal)
  })

  it('fails loud on a nonzero exit, naming tar stderr', async () => {
    const face = new SpawnFace(() => finishedHandle({
      exitCode: 2, stderr: 'tar: cannot stat: No such file\n',
    }))
    await expect(extractArchive(face, '/usr/bin/tar', '/tmp/a.tar.gz', '/tmp/run'))
      .rejects.toThrow(/tar failed \(exit 2\): tar: cannot stat/)
  })

  it('falls back to stdout for the diagnostic when tar writes nothing to stderr', async () => {
    const face = new SpawnFace(() => finishedHandle({ exitCode: 1, stdout: 'out of space\n' }))
    await expect(extractArchive(face, '/usr/bin/tar', '/tmp/a.tar.gz', '/tmp/run'))
      .rejects.toThrow(/tar failed \(exit 1\): out of space/)
  })
})
