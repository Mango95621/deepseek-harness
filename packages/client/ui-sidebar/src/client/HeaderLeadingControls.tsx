/** Window-chrome controls for the fully hidden sidebar (frame shell.leading seat). */
import {
  IconPanelLeftOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the frame's shell.leading slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import css from './HeaderLeadingControls.module.css'

/** Full props of the shell.leading occupant. */
export type HeaderLeadingControlsProps =
  PropsRuntime<'shell.leading'>
  & InjectFace<SidebarRootInjected>
  & PropsLocale<'sidebar'>

/**
 * The sidebar opener in the frame's window-chrome seat, which the frame mounts
 * only while the column is fully hidden. Starting a Session is the workspace
 * browser's own per-project control rather than a shell affordance, so this seat
 * carries no New Session button on any platform — a titlebar control would have
 * to guess the project, which is the guess the browser's per-row action exists
 * to avoid.
 * @param props - Injected sidebar actions, the global shortcut catalog, and the sidebar locale seat.
 * @returns the sidebar toggle.
 */
export function HeaderLeadingControls({
  toggleSidebar, useShortcuts, t,
}: HeaderLeadingControlsProps) {
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'sidebar.left.toggle'))
  return (
    <div className={css.controls}>
      <Tooltip label={t('toggle.open')} shortcutKeys={shortcut?.keys} delayMs={500}>
        <button
          data-sidebar-opener
          type="button"
          className={css.iconButton}
          aria-label={t('toggle.open')}
          aria-keyshortcuts={shortcut?.aria}
          onClick={() => { toggleSidebar() }}
        >
          <IconPanelLeftOutlineRegular size={16} />
        </button>
      </Tooltip>
    </div>
  )
}
