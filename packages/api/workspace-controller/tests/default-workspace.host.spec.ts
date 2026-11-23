import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_DIRECTORY,
  workspaceDisplayTitle,
} from '../src/default-workspace.ts'

describe('first-use Workspace naming', () => {
  it('labels the automatic first-use title with the reader\'s localized default name', () => {
    // The stored title is language-neutral; only the label is localized, so one
    // installation keeps one on-disk path across language switches.
    expect(workspaceDisplayTitle(DEFAULT_WORKSPACE_DIRECTORY, '默认项目')).toBe('默认项目')
    expect(workspaceDisplayTitle(DEFAULT_WORKSPACE_DIRECTORY, 'Default project')).toBe('Default project')
  })

  it('reads every other title verbatim, including one that merely contains the default name', () => {
    expect(workspaceDisplayTitle('Vehicle platform', '默认项目')).toBe('Vehicle platform')
    expect(workspaceDisplayTitle(`${DEFAULT_WORKSPACE_DIRECTORY} backup`, '默认项目'))
      .toBe(`${DEFAULT_WORKSPACE_DIRECTORY} backup`)
    expect(workspaceDisplayTitle('', '默认项目')).toBe('')
  })
})
