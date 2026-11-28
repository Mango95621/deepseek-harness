/**
 * YXSpec process section: the ASPICE stage list with each stage's artifact landing status, plus the
 * build servers the project declared and what their last connection test concluded.
 *
 * The server list is here because the question it answers is asked from here: an operator looking at
 * a stalled stage wants to know whether the machine that compiles it is reachable, and the wizard
 * that declared the server is no longer on screen once the project is running.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { YxspecRemoteServerView, YxspecStageView, YxspecStatusValue } from '@deepseek-ai/dsh-yxspec-api/types'
import { resolveProjectId } from './project.ts'
import { ServerStateDot } from './ServerStateDot.tsx'
import type { YxspecSectionProps } from './slots.ts'

/** One stage row: ASPICE process, title, step count, and landing state. */
function StageRow({ stage, props }: { stage: YxspecStageView; props: YxspecSectionProps }): ReactNode {
  const frozen = stage.steps.filter(step => step.frozen).length
  const state = stage.landed === undefined
    ? props.t('section.unknown')
    : stage.landed
      ? props.t('section.landed')
      : props.t('section.missing', { count: stage.missing?.length ?? 0 })
  const tone = stage.landed === undefined ? 'unknown' : stage.landed ? 'ok' : 'pending'
  return (
    <div className="yxspec-stage" data-tone={tone}>
      <span className="yxspec-stage-aspice">{stage.aspice}</span>
      <span className="yxspec-stage-title">{stage.title}</span>
      <span className="yxspec-stage-steps">
        {stage.steps.length}
        {frozen > 0 ? ` · ${props.t('step.frozen')}×${frozen}` : ''}
      </span>
      <span className="yxspec-stage-state">{state}</span>
    </div>
  )
}

/**
 * Render the YXSpec process section. Loads once on mount; the section owns no process
 * state, so a stale read is corrected by the next mount rather than by a subscription —
 * deliberately, because a live subscription would add host→client traffic for a table that
 * changes only when an agent advances a step.
 * @param props - the slot props, carrying the bound translator and the loader.
 * @returns the section body.
 */
export function YxspecSection(props: YxspecSectionProps): ReactNode {
  const [state, setState] = useState<YxspecStatusValue | undefined>()
  const [unavailable, setUnavailable] = useState(false)
  const [servers, setServers] = useState<readonly YxspecRemoteServerView[]>([])
  const [probing, setProbing] = useState<string | undefined>(undefined)
  const { load, loadServers, probeServer, useWorkspaces, useSessions } = props
  // The project comes from the same two catalogues the wizard resolves it from, rather than from a
  // prop the panel owner would have to thread through every other section.
  const workspaces = useWorkspaces(whole => whole)
  const sessions = useSessions(whole => whole)
  const projectId = resolveProjectId(workspaces, sessions)

  useEffect(() => {
    let live = true
    void load().then(
      (value) => {
        if (!live) return
        if (value === undefined) setUnavailable(true)
        else setState(value)
      },
      () => { if (live) setUnavailable(true) },
    )
    return () => { live = false }
  }, [load])

  const reloadServers = useCallback((): void => {
    if (projectId === undefined) {
      setServers([])
      return
    }
    void loadServers(projectId).then(
      (value) => { setServers(value) },
      // An absent build-server namespace is not a failure of this section: it renders its process
      // state and simply has no servers to show.
      () => { setServers([]) },
    )
  }, [loadServers, projectId])

  useEffect(() => { reloadServers() }, [reloadServers])

  /*
   * A test is a write on the declaration (the host stores its outcome), so the section re-reads its
   * list afterwards rather than holding an answer: the status line then describes what the host
   * recorded, which is the same thing a reloaded panel shows.
   */
  const test = async (serverId: string): Promise<void> => {
    /* v8 ignore next -- the control renders only for a resolved project, so this guard is a second
     * line of defence rather than a live path. */
    if (projectId === undefined) return
    setProbing(serverId)
    try {
      await probeServer(projectId, serverId)
    } catch {
      // A refused call leaves the stored state as it was; the row keeps saying what it last knew,
      // and the wizard is where a refusal is explained. Silence here is deliberate: this section
      // owns no notice surface, and inventing one would be a second place to read the same fact.
    } finally {
      setProbing(undefined)
      reloadServers()
    }
  }

  /*
   * One block, two readings. The process read and the build-server read are independent — the
   * servers live in a namespace a deployment may not mount — so neither may hide the other: an
   * operator whose process service is missing still needs to know whether the machine that
   * compiles is reachable, and one with no build-server plugin still needs the stage list.
   *
   * A server row carries no tone of its own: the row's state is the dot it shows, and a second
   * verdict drawn from the same record would be a second answer to the same question.
   */
  const serversBlock = servers.length === 0
    ? null
    : (
      <div className="yxspec-servers">
        <span className="yxspec-servers-title">{props.t('section.servers')}</span>
        {servers.map(server => (
          <div key={server.serverId} className="yxspec-server">
            <span className="yxspec-server-title" title={server.destination}>{server.title || server.serverId}</span>
            <ServerStateDot server={server} t={props.t} className="yxspec-server-state" />
            <Button
              variant="ghost"
              disabled={probing !== undefined}
              onClick={() => { void test(server.serverId) }}
            >
              {props.t('server.probe')}
            </Button>
          </div>
        ))}
      </div>
    )
  if (unavailable) {
    return (
      <div className="yxspec-panel" data-empty="true">
        <p>{props.t('empty')}</p>
        {serversBlock}
      </div>
    )
  }
  if (state === undefined) {
    return <div className="yxspec-panel" data-loading="true">{serversBlock}</div>
  }

  return (
    <div className="yxspec-panel">
      <div className="yxspec-identity">
        <span>{props.t('identity.specId')}: {state.identity.specId}</span>
        <span>{props.t('identity.customer')}: {state.identity.customer}</span>
      </div>
      {state.stages.map(stage => <StageRow key={stage.id} stage={stage} props={props} />)}
      {serversBlock}
    </div>
  )
}
