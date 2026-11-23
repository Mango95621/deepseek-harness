import { describe, expect, it } from 'vitest'
import { distinguishingPathSuffixes } from '../src/client/path-suffix.ts'

const suffixes = (...rows: [title: string, path: string][]) =>
  [...distinguishingPathSuffixes(rows.map(([title, path], id) => ({ id, title, path }))).entries()]

describe('distinguishingPathSuffixes', () => {
  it('leaves uniquely titled Workspaces without a suffix', () => {
    expect(suffixes(['a', '/x/a'], ['b', '/x/b'])).toEqual([])
  })

  it('gives each same-titled Workspace its own shortest unique suffix', () => {
    expect(suffixes(
      ['workspace', '/home/me/a/workspace'],
      ['workspace', '/home/me/b/workspace'],
      ['workspace', '/srv/deep/b/workspace'],
      ['other', '/home/me/a/other'],
    )).toEqual([
      [0, 'a/workspace'],
      [1, 'me/b/workspace'],
      [2, 'deep/b/workspace'],
    ])
  })

  it('distinguishes by basename when same-titled paths end differently', () => {
    expect(suffixes(['workspace', '/p/renamed'], ['workspace', '/q/workspace'])).toEqual([
      [0, 'renamed'],
      [1, 'workspace'],
    ])
  })

  it('shows the whole path when it is a suffix of a peer, keeping its separators', () => {
    expect(suffixes(['workspace', '/workspace'], ['workspace', '/a/workspace'], ['w', 'C:\\x\\w'], ['w', 'C:\\y\\w'])).toEqual([
      [0, '/workspace'],
      [1, 'a/workspace'],
      [2, 'x\\w'],
      [3, 'y\\w'],
    ])
  })

  it('names a root Workspace by its whole path instead of an empty suffix', () => {
    expect(suffixes(['disk', '/'], ['disk', '/srv/disk'], ['c', 'C:\\'], ['c', 'D:\\c'])).toEqual([
      [0, '/'],
      [1, 'disk'],
      [2, 'C:\\'],
      [3, 'c'],
    ])
  })

  it('gives a rootless Workspace no suffix, since it has no path to tell it apart by', () => {
    // A project created by the wizard's first step holds no repository root until step 2, so its
    // path is null. It shares a title with a real directory here: the directory keeps its suffix
    // against the *other* real path, and the rootless row simply contributes nothing — which is
    // also why it must not crash the split.
    expect([
      ...distinguishingPathSuffixes([
        { id: 0, title: 'workspace', path: '/home/me/a/workspace' },
        { id: 1, title: 'workspace', path: '/home/me/b/workspace' },
        { id: 2, title: 'workspace', path: null },
      ]).entries(),
    ]).toEqual([[0, 'a/workspace'], [1, 'b/workspace']])
  })
})
