/**
 * Sidebar shell: column geometry and global panel navigation.
 * Collapse is a slide plus crossfade:
 * content freezes at its expanded width (inline style) and fades out in place
 * while the sliding column (AppFrame grid tracks) clips it — nothing reflows
 * mid-slide. At settle the wide-only content unmounts and the upper
 * controls enter the 56px rail from the same horizontal offset (one icon each,
 * same top-down order) on one fade that ends with the slide. The bottom-pinned
 * settings control only fades. The workspace/session browsing region between
 * global panel rows and the foot is the `sidebar.workspaces` registrant's,
 * and the foot holds `sidebar.settings` plus `sidebar.footer.action`; the shell
 * hands them the wide flag (plus an expand request callback for the browser).
 * Through the browser's hookContext, the shell also hands it the scroller hook
 * that continues wheel scrolling over the sidebar viewport into its list.
 *
 * The shell renders no New Session control of its own: starting a Session is
 * the workspace browser's per-project action, so the seat below the brand row
 * hosts only what a plugin contributes through `sidebar.session.action` and
 * the brand row is identity only.
 *
 * The column also owns whether the scroll regions nested in it draw a
 * scrollbar at all: the shell tracks the pointer and rebinds ui-theme's
 * scrollbar indirection away while it is elsewhere, so a list the user is not
 * pointing at carries no bar.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import clsx from 'clsx'
import {
  FishLogo, IconAppsAddOutlineRegular,
  IconPanelLeftOutlineRegular, IconPinFillRegular, focusWithoutRing, isBehindModal, isDarwinDesktop, Menu, Toast,
  Tooltip, useModalLayer, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SidebarPanelActionsOwnerProps, SidebarPanelMetadata, SidebarRootComponentProps, SidebarRootInjected, SidebarSectionHookContext,
  SidebarSectionOwnerProps,
} from './contract/slots.ts'
import { FIXED_PANEL_ID } from './panel-pins.ts'
import { createScrollHandoff } from './scroll-handoff.ts'
import css from './SidebarRoot.module.css'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/** Format complete-build metadata for the local brand badge. */
function localBuildVersion(): string | undefined {
  const version = process.env.DSH_CLIENT_VERSION
  if (version === undefined) return undefined
  const commit = process.env.DSH_CLIENT_COMMIT_HASH
  return version
    + (commit === undefined ? '' : `-${commit}`)
    + (process.env.DSH_CLIENT_GIT_DIRTY === 'true' ? '-dirty' : '')
}

type PanelRowProps =
  Pick<SidebarPanelMetadata, 'id' | 'label'>
  & Pick<SidebarSectionOwnerProps, 'wide'>
  & Pick<PropsRuntime<'sidebar'>, 'usePanelInfo'>
  & Pick<InjectFace<SidebarRootInjected>, 'selectPanel' | 'trackEntryClick' | 'setPinned'>
  & { readonly unpinLabel: string; readonly unpinTooltip: string; readonly canUnpin: boolean }
  & PropsRenderFactories

/** Analytics category of an official panel; other panels are never reported. */
function officialEntry(id: string): 'plugin' | 'cron' | undefined {
  if (id === 'plugins') return 'plugin'
  return id === 'schedules' ? 'cron' : undefined
}

/** Each panel row subscribes only to its own selection state. */
function PanelRow({
  id, label, wide, unpinLabel, unpinTooltip, canUnpin, usePanelInfo, selectPanel, setPinned, trackEntryClick, renderFactorySlot,
}: PanelRowProps) {
  const active = usePanelInfo(info => info.activePanelId === id)
  return (
    <div className={clsx(css.panelEntry, wide && css.panelEntryWide, active && css.panelEntryActive)}>
      <Tooltip label={label} delayMs={500} disabled={wide}>
        <button
          type="button"
          className={css.panelRow}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          onClick={() => {
            const entry = officialEntry(id)
            if (entry !== undefined) trackEntryClick({ menu_name: entry, position: 'sidebar' })
            selectPanel(id)
          }}
        >
          <span className={css.panelGlyph} aria-hidden="true">
            {renderFactorySlot('sidebar.panel.icon', { id, size: wide ? 16 : 18, active })}
          </span>
          {wide && (
            <span className={clsx(css.panelTitle, css.wide)}>
              {label}
            </span>
          )}
        </button>
      </Tooltip>
      {wide && canUnpin && <Tooltip label={unpinTooltip} side="bottom" align="end" delayMs={500} portal>
        <button type="button" className={css.panelUnpin} aria-label={unpinLabel} onClick={(event) => {
          // Unpin is rendered only while this navigation also renders More.
          const navigation = event.currentTarget.closest('nav') as HTMLElement
          const more = navigation.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement
          focusWithoutRing(more)
          setPinned(id, false)
        }}>
          <IconPinFillRegular size={14} />
        </button>
      </Tooltip>}
    </div>
  )
}

type PanelMoreMenuProps =
  Pick<SidebarSectionOwnerProps, 'wide'>
  & Omit<SidebarPanelActionsOwnerProps, 'onDismiss'>
  & PropsRenderSlots<'sidebar.panellist.actions'>
  & Pick<InjectFace<SidebarRootInjected>, 'trackEntryClick'>
  & { readonly label: string }

/** The panel list's More launcher: a panel-row button whose menu rows come from `sidebar.panellist.actions`. */
function PanelMoreMenu({ wide, label, entries, onOpen, onPinnedChange, trackEntryClick, renderSlot }: PanelMoreMenuProps) {
  const [open, setOpen] = useState(false)
  const onDismiss = (): void => { setOpen(false) }
  return (
    <Menu open={open} onClose={onDismiss} portal autoFocus className={css.moreAnchor} listClassName={css.moreMenu}
      anchor={(
        <Tooltip label={label} delayMs={500} disabled={wide}>
          <button type="button" className={css.panelRow} aria-label={label} aria-haspopup="menu" aria-expanded={open}
            onClick={() => {
              trackEntryClick({ menu_name: 'more', position: 'sidebar' })
              setOpen(value => !value)
            }}>
            <span className={css.panelGlyph} aria-hidden="true"><IconAppsAddOutlineRegular size={wide ? 16 : 18} /></span>
            {wide && <span className={clsx(css.panelTitle, css.wide)}>{label}</span>}
          </button>
        </Tooltip>
      )}>
      {renderSlot('sidebar.panellist.actions', { entries, onOpen, onPinnedChange, onDismiss })}
    </Menu>
  )
}

/**
 * Render the sidebar column shell.
 * @param props - composed slot props (runtime share + injected callbacks, contract/slots.ts).
 * @returns the sidebar element tree.
 */
export function SidebarRoot({
  collapsed,
  width,
  drawer,
  toggleSidebar,
  selectPanel,
  setPinned,
  trackEntryClick,
  usePanels,
  useEntryPins,
  useEntryActions,
  useSessionActions,
  useShortcuts,
  usePanelInfo,
  t,
  renderSlot,
  renderFactorySlot,
}: SidebarRootComponentProps) {
  const panels = usePanels(snapshot => snapshot)
  const unpinned = useEntryPins(ids => ids)
  const activePanelId = usePanelInfo(info => info.activePanelId)
  const hasEntryActions = useEntryActions(registered => registered)
  const hasSessionActions = useSessionActions(registered => registered)
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'sidebar.left.toggle'))
  const toggleLabel = collapsed ? t('toggle.open') : t('toggle.collapse')
  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  // A closed drawer retains its content with the rail phase already settled.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (drawer || !collapsed) { setSettled(collapsed); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed, drawer])
  const windowsTitlebar = document.documentElement.hasAttribute('data-windows-titlebar')
  const wide = drawer || (windowsTitlebar ? !collapsed : !collapsed || !settled)
  const [scrollHandoff] = useState(createScrollHandoff)
  const sectionHookContext = useMemo<SidebarSectionHookContext>(
    () => ({ useSectionScroller: scrollHandoff.useSectionScroller }), [scrollHandoff],
  )
  // The Windows caption menus occupy the strip to the right of the rail's
  // controls (that is what --dsh-windows-menu-start reserves), so a right-side
  // bubble lands under their text. Below the caption is the only clear side.
  const captionTooltipSide = windowsTitlebar ? 'bottom' : 'right'
  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it. The
  // rail layout (.collapsed styles) only applies once the fade settles.
  const lastWideWidth = useRef(width)
  if (drawer || !collapsed) lastWideWidth.current = width

  // A closed drawer returns to the static rail; only a live collapse fades it in.
  const animateRail = useRef(!collapsed)
  if (drawer || !collapsed) animateRail.current = !collapsed

  // Scrollbars in the column follow the pointer: .quietBars rebinds them away
  // whenever the pointer is outside, and its stylesheet owns the delay and
  // fade, so a pointer that returns before the fade starts sees no change.
  const column = useRef<HTMLDivElement>(null)
  const sidebarFocus = useRef<Element | null>(null)
  useModalLayer(column, drawer && !collapsed, toggleSidebar)
  useLayoutEffect(() => {
    if (!collapsed) return
    const controlled = sidebarFocus.current?.getAttribute('aria-controls')?.split(/\s+/) ?? []
    const ownsMenuFocus = controlled.some(id => document.getElementById(id)?.contains(document.activeElement))
    if (sidebarFocus.current !== document.activeElement && !ownsMenuFocus) return
    const opener = drawer
      ? column.current?.ownerDocument.querySelector<HTMLElement>('[data-sidebar-opener]')
      : column.current?.querySelector<HTMLElement>('[data-sidebar-toggle]')
    if (opener != null && !isBehindModal(opener)) focusWithoutRing(opener, { preventScroll: true })
  }, [drawer, collapsed])
  const [pointerInside, setPointerInside] = useState(false)
  // Inside is decided by the column's BOX, not by DOM containment, for every
  // pointer move that reaches the column. ui-settings renders its
  // full-viewport panel as a fixed-position DESCENDANT of this column, and the
  // column's menus and tooltips are React portals, so a pointer over them
  // fires no `pointerleave` here while their moves still bubble to it. The
  // element's own leave stays as the one signal geometry cannot give: a
  // pointer that leaves the window emits no further moves.
  const trackPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    setPointerInside(event.clientX >= rect.left && event.clientX < rect.right
      && event.clientY >= rect.top && event.clientY < rect.bottom)
  }

  const buildVersion = localBuildVersion()
  // The local-build fallbacks copy the badge text; the brand button below
  // skips New Session for clicks inside them. The click still bubbles, so
  // document-level outside-click listeners see it.
  // Each successful copy bumps the key so a repeated copy replays the toast.
  const [copiedToast, setCopiedToast] = useState<number | null>(null)
  const copyVersion = (version: string) => (): void => {
    void writeClipboard(version).then((ok) => {
      if (ok) setCopiedToast(seq => (seq ?? 0) + 1)
    })
  }

  const darwinDesktop = isDarwinDesktop()
  // Rail resting state is the whale mark; hovering swaps in the panel icon
  // (the expand affordance, figma sidebar-hover flow). Expanded it is a plain
  // panel icon.
  const toggle = (
    <Tooltip label={toggleLabel} shortcutKeys={shortcut?.keys} delayMs={500} side={captionTooltipSide} portal={drawer}>
      <button
        data-sidebar-toggle
        data-modal-autofocus={drawer || undefined}
        type="button"
        className={clsx(css.iconButton, css.toggle)}
        aria-label={toggleLabel}
        aria-keyshortcuts={shortcut?.aria}
        onClick={() => { toggleSidebar() }}
      >
        {!wide && !windowsTitlebar && (
          <span className={css.railMark} aria-hidden="true">
            {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <FishLogo size={24} /> })}
          </span>
        )}
        {/* Rail icons render at 18 (figma rail spec); expanded keeps the glyph-native sizes. */}
        <IconPanelLeftOutlineRegular className={css.panelIcon} size={wide || windowsTitlebar ? 16 : 18} />
        {!wide && renderSlot('sidebar.toggle.badge', {})}
      </button>
    </Tooltip>
  )

  return (
    <div
      ref={column}
      onFocusCapture={(event) => { sidebarFocus.current = event.target }}
      role={drawer ? 'dialog' : undefined}
      data-shortcut-modal={drawer ? 'sidebar' : undefined}
      aria-modal={drawer && !collapsed ? true : undefined}
      aria-label={drawer ? t('navigation.label') : undefined}
      tabIndex={drawer ? -1 : undefined}
      className={clsx(
        css.root, !wide && css.collapsed, !wide && animateRail.current && css.railIn,
        !drawer && collapsed && wide && css.fading, !pointerInside && css.quietBars,
      )}
      style={wide ? { width: !drawer && collapsed ? lastWideWidth.current : width } : undefined}
      onPointerEnter={trackPointer}
      onPointerMove={trackPointer}
      onPointerLeave={() => { setPointerInside(false) }}
    >
      {/* macOS hiddenInset titlebar: the strip shares the row with the
          traffic lights and keeps the toggle at the sidebar's top-right. */}
      {darwinDesktop && <div className={css.topStrip} data-window-drag>{toggle}</div>}
      <div className={css.logoRow} data-window-drag>
        {/* The brand row is identity only. Starting a Session is the workspace
            browser's own per-project control, never a shell affordance, so the
            brand stays part of the logo row's window-drag surface on every
            platform; the collapsed rail's logo is the expand toggle below
            instead. Mouse clicks on the local-build fallbacks copy the version
            instead. */}
        {wide && (
          <span className={clsx(css.brand, css.wide)}>
            <span className={css.brandIdentity} aria-hidden="true">
              <span className={css.brandMark}>
                {renderSlot('sidebar.brand.mark', { size: 24 }, {
                  fallback: buildVersion === undefined
                    ? <FishLogo size={24} />
                    : <span className={css.copyVersion} data-copy-version onClick={copyVersion(buildVersion)}><FishLogo size={24} /></span>,
                })}
              </span>
              <span className={css.brandName}>
                {renderSlot('sidebar.brand.name', {}, {
                  fallback: buildVersion === undefined
                    ? <span className={css.fallbackBrandName}>{t('brand.localBuild')}</span>
                    : (
                      <span className={clsx(css.localBuildBrand, css.copyVersion)} data-copy-version onClick={copyVersion(buildVersion)}>
                        <span className={css.localBuildTitle}>{t('brand.localBuild')}</span>
                        <span className={css.buildVersion}>{buildVersion}</span>
                      </span>
                    ),
                })}
              </span>
            </span>
          </span>
        )}
        {!darwinDesktop && toggle}
      </div>

      {/* The shell offers no New Session control: starting a Session is the
          workspace browser's own per-project action, which keeps the operator's
          intended project in view instead of guessing one. The
          `sidebar.session.action` seat therefore hosts only what a plugin
          contributes — with no occupant the row is absent rather than empty,
          so nothing renders a dead control here. */}
      {hasSessionActions && (
        <div className={css.sessionActionRow}>
          {renderSlot('sidebar.session.action', { wide }, { children: null })}
        </div>
      )}

      <div className={css.scrollRegion}>
        <div
          ref={scrollHandoff.bindViewportRef}
          className={css.scrollArea}
          data-sidebar-scrollport={wide ? '' : undefined}
        >
          {panels.length > 0 && (
            <nav className={css.panelList} aria-label={t('panels.label')}>
              {panels.filter(({ id }) => id === FIXED_PANEL_ID || !hasEntryActions || !unpinned.includes(id)).map(({ id, label }) => (
                <PanelRow
                  key={id}
                  id={id}
                  label={label}
                  wide={wide}
                  unpinLabel={t('panels.unpin', { name: label })}
                  unpinTooltip={t('panels.unpinTooltip')}
                  canUnpin={hasEntryActions && id !== FIXED_PANEL_ID}
                  setPinned={setPinned}
                  usePanelInfo={usePanelInfo}
                  selectPanel={selectPanel}
                  trackEntryClick={trackEntryClick}
                  renderFactorySlot={renderFactorySlot}
                />
              ))}
              {hasEntryActions && (
                <PanelMoreMenu
                  wide={wide}
                  label={t('panels.more')}
                  entries={panels.filter(({ id }) => id !== FIXED_PANEL_ID)
                    .map(({ id, label }) => ({ id, label, pinned: !unpinned.includes(id), active: id === activePanelId }))}
                  onOpen={(id) => {
                    const entry = officialEntry(id)
                    if (entry !== undefined) trackEntryClick({ menu_name: entry, position: 'sidebar_more' })
                    const panel = panels.find(candidate => candidate.id === id)
                    if (panel !== undefined) selectPanel(panel.id)
                  }}
                  onPinnedChange={setPinned}
                  trackEntryClick={trackEntryClick}
                  renderSlot={renderSlot}
                />
              )}
            </nav>
          )}
          <div className={css.regionArea}>
            {renderSlot('sidebar.workspaces', {
              wide,
              expandSidebar: () => { if (collapsed) toggleSidebar() },
            }, { hookContext: sectionHookContext })}
          </div>
        </div>
        <span className={css.scrollFade} aria-hidden="true" />
      </div>

      {copiedToast !== null && (
        <Toast key={copiedToast} tone="success" text={t('version.copied')} onDone={() => { setCopiedToast(null) }} />
      )}

      {/* Footer actions stack above Settings in both sidebar widths. */}
      <div className={css.footArea}>
        <div className={css.footerActions}>
          {renderSlot('sidebar.footer.action', { wide })}
        </div>
        <div className={css.settingsArea}>
          {renderSlot('sidebar.settings', { wide })}
        </div>
      </div>
    </div>
  )
}
