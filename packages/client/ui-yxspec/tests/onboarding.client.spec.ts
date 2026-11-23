/**
 * The onboarding state machine: step order, the idempotence of completing a step
 * twice, the answers surviving a reopen, and the two predicates the view reads
 * (which step is outstanding, and whether a step's own inputs are supplied).
 *
 * These are the rules the gate's correctness rests on, so they are asserted
 * directly rather than through a render: a rendering test proves the wizard draws,
 * this one proves that what it draws is decided correctly.
 */

import { describe, expect, it } from 'vitest'
import {
  EMPTY_PROGRESS, ONBOARDING_STEPS, completeStep, currentStep, establishedProgress,
  prerequisitesMet, reopenStep, stepSatisfied, type OnboardingAnswers, type OnboardingProgress,
} from '../src/client/onboarding.ts'

/** Walk every step, returning the progress a fully-onboarded project holds. */
function onboarded(): OnboardingProgress {
  return ONBOARDING_STEPS.reduce<OnboardingProgress>(
    (progress, step) => completeStep(progress, step, {}),
    EMPTY_PROGRESS,
  )
}

describe('onboarding step order', () => {
  it('asks for the project and its repositories before the specification', () => {
    // The order is forced by the data, not by taste: the specification candidates are files
    // inside the project's declared roots, so a wizard that asked for the document first
    // would show an empty list on every cold start.
    expect(ONBOARDING_STEPS).toEqual(['project', 'repositories', 'specification', 'server', 'ready'])
  })

  it('opens on the first step for a project with no record', () => {
    expect(currentStep(undefined)).toBe('project')
    expect(currentStep(EMPTY_PROGRESS)).toBe('project')
  })

  it('resumes at the first step still outstanding', () => {
    const progress = completeStep(completeStep(EMPTY_PROGRESS, 'project'), 'repositories')
    expect(currentStep(progress)).toBe('specification')
  })

  it('reports no outstanding step once every answer is recorded', () => {
    expect(currentStep(onboarded())).toBeUndefined()
  })
})

describe('completing a step', () => {
  it('records the step and its answers', () => {
    const progress = completeStep(EMPTY_PROGRESS, 'project', { projectTitle: 'ivi-hmi' })
    expect(progress.completed).toEqual(['project'])
    expect(progress.answers.projectTitle).toBe('ivi-hmi')
  })

  it('is idempotent and keeps the trail ordered', () => {
    // Stepping back and returning must not accumulate duplicate chips.
    const once = completeStep(EMPTY_PROGRESS, 'project', { projectTitle: 'a' })
    const twice = completeStep(once, 'project', { projectTitle: 'a' })
    expect(twice.completed).toEqual(['project'])
    expect(twice).toEqual(once)
  })

  it('merges answers over what was already there rather than replacing them', () => {
    const first = completeStep(EMPTY_PROGRESS, 'repositories', { repositories: ['/a'] })
    const second = completeStep(first, 'specification', { specificationPath: 'specs/spec.md' })
    expect(second.answers).toEqual({ repositories: ['/a'], specificationPath: 'specs/spec.md' })
  })

  it('carries a multi-root specification answer with the root it came from', () => {
    // The same relative path can exist in two repositories of one project, so the root
    // index is part of the answer, not decoration.
    const progress = completeStep(EMPTY_PROGRESS, 'specification', {
      specificationPath: 'specs/spec.md',
      specificationRootIndex: 2,
    })
    expect(progress.answers.specificationRootIndex).toBe(2)
  })

  it('starts from the empty record when there is none', () => {
    expect(completeStep(undefined, 'server', { serverResolved: true }).completed).toEqual(['server'])
  })
})

describe('reopening a step', () => {
  it('withdraws the completion but keeps the answers to redisplay', () => {
    const progress = ONBOARDING_STEPS
      .filter(step => step !== 'specification')
      .reduce<OnboardingProgress>(
        (current, step) => completeStep(current, step, {}),
        completeStep(EMPTY_PROGRESS, 'specification', { specificationPath: 'a/spec.md' }),
      )
    expect(currentStep(progress)).toBeUndefined()

    const reopened = reopenStep(progress, 'specification')
    expect(reopened.completed).not.toContain('specification')
    // A step that reopened blank would make the operator re-choose what they already chose.
    expect(reopened.answers.specificationPath).toBe('a/spec.md')
    // It is outstanding again, so the gate stays shut.
    expect(currentStep(reopened)).toBe('specification')
    // The others are untouched.
    expect(reopened.completed).toEqual(expect.arrayContaining(['project', 'repositories', 'server', 'ready']))
  })

  it('leaves the other steps alone', () => {
    const progress = completeStep(completeStep(EMPTY_PROGRESS, 'project'), 'repositories')
    const reopened = reopenStep(progress, 'project')
    expect(reopened.completed).toEqual(['repositories'])
  })

  it('is a no-op for a step that was not completed', () => {
    expect(reopenStep(EMPTY_PROGRESS, 'server').completed).toEqual([])
  })

  it('tolerates a missing record', () => {
    expect(reopenStep(undefined, 'project').completed).toEqual([])
  })

  it('reports the earliest outstanding step, not the most recently withdrawn', () => {
    // `currentStep` is the resumed position in wizard order; a step withdrawn out of order
    // does not become the resume point — the wizard's own Back jumps there directly.
    const progress = completeStep(completeStep(EMPTY_PROGRESS, 'project'), 'repositories')
    expect(currentStep(reopenStep(progress, 'repositories'))).toBe('repositories')
    expect(currentStep(reopenStep(progress, 'project'))).toBe('project')
  })
})

describe('whether a step has what it needs', () => {
  it.each<[Parameters<typeof stepSatisfied>[0], OnboardingAnswers, boolean]>([
    ['project', {}, false],
    ['project', { projectTitle: 'ivi' }, true],
    // Whitespace is not a name.
    ['project', { projectTitle: '   ' }, false],
    ['repositories', {}, false],
    ['repositories', { repositories: [] }, false],
    ['repositories', { repositories: ['/aosp'] }, true],
    ['specification', {}, false],
    ['specification', { specificationPath: '' }, false],
    ['specification', { specificationPath: 'specs/spec.md' }, true],
    ['server', {}, false],
    ['server', { serverResolved: false }, false],
    // "This project builds locally" is an answer, and a deliberately recorded one.
    ['server', { serverResolved: true }, true],
  ])('answers %s from %o as %s', (step, answers, expected) => {
    const progress: OnboardingProgress = { completed: [], answers }
    expect(stepSatisfied(step, progress)).toBe(expected)
  })

  it('reads absent progress as nothing supplied', () => {
    expect(stepSatisfied('project', undefined)).toBe(false)
  })

  it('lets the summary be confirmed once the four before it are done', () => {
    const four = ONBOARDING_STEPS
      .filter(step => step !== 'ready')
      .reduce<OnboardingProgress>((progress, step) => completeStep(progress, step, {}), EMPTY_PROGRESS)
    expect(stepSatisfied('ready', four)).toBe(true)
    expect(prerequisitesMet(four)).toBe(true)
    // The summary is not confirmable before them.
    expect(prerequisitesMet(completeStep(EMPTY_PROGRESS, 'project'))).toBe(false)
    expect(prerequisitesMet(undefined)).toBe(false)
  })

  it('does not treat the summary itself as one of its own prerequisites', () => {
    // Asking `currentStep`-shaped completeness here would be circular: the answer would
    // include the very step being asked about, and the summary could never become ready.
    const confirmed = completeStep(EMPTY_PROGRESS, 'ready')
    expect(stepSatisfied('ready', confirmed)).toBe(false)
    expect(prerequisitesMet(onboarded())).toBe(true)
  })
})

describe('the progress an established project starts from', () => {
  it('records the project and its repositories, opening the walk at the specification', () => {
    // An adopted project has already answered these two by existing: its roots *are* step 2's
    // answer, and its title is step 1's. Folding them in is what puts the operator in front of
    // the ASPICE questions instead of the ones they have already answered.
    const progress = establishedProgress(['/aosp', '/vendor'], 'ivi-hmi')
    expect(progress.completed).toEqual(['project', 'repositories'])
    expect(progress.answers).toEqual({ projectTitle: 'ivi-hmi', repositories: ['/aosp', '/vendor'] })
    expect(currentStep(progress)).toBe('specification')
  })

  it('records rather than skips, so both steps read as satisfied', () => {
    // The difference matters beyond the trail: a step listed in `completed` without its own
    // answer present is drawn as todo, and Back could not reopen it. Both keys are supplied.
    const progress = establishedProgress(['/aosp'], 'ivi')
    expect(stepSatisfied('project', progress)).toBe(true)
    expect(stepSatisfied('repositories', progress)).toBe(true)
  })

  it('leaves a rootless project to walk from step 1', () => {
    // Nothing points a rootless project at code, so it has established nothing: there is no
    // repository answer to fold in, and the wizard's first two steps are exactly what it needs.
    expect(establishedProgress([], 'ivi')).toEqual(EMPTY_PROGRESS)
    expect(currentStep(establishedProgress([], 'ivi'))).toBe('project')
  })
})
