/**
 * Workspace labels and project presentation, kept by this daemon.
 *
 * The harness has no label catalog and no rename for a workspace record, but
 * a Paseo client groups and names its sidebar with them. They are the
 * operator's own presentation data, so they live in one file under the
 * harness home rather than being invented per request.
 *
 * @module dsh-paseo-server/dsh/labels
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Colors a label may carry, as the Paseo protocol enumerates them. */
export const LABEL_COLORS = [
  'violet',
  'sky',
  'emerald',
  'orange',
  'pink',
  'indigo',
  'teal',
  'red',
  'amber',
  'blue',
] as const

/** One label definition. */
export interface LabelDefinition {
  readonly name: string
  readonly color: typeof LABEL_COLORS[number]
}

/** Everything the label file holds. */
export interface LabelState {
  /** Generation token the client echoes back in a sync cursor. */
  readonly generation: string
  /** Sequence of the newest change, which is what a sync cursor advances on. */
  readonly seq: number
  readonly labels: readonly LabelDefinition[]
  /** Workspace id to the label names assigned to it. */
  readonly assignments: Readonly<Record<string, readonly string[]>>
}

/** Directory under the harness home that holds this plugin's own state. */
const STATE_DIRECTORY = 'paseo'

/** File name of the label store. */
const STATE_FILE = 'workspace-labels.json'

/** Empty catalog a first run starts from. */
export const EMPTY_LABELS: LabelState = { generation: 'g1', seq: 0, labels: [], assignments: {} }

/**
 * Read the label store.
 * @param homePath - harness home path builder.
 * @returns the catalog, empty when nothing was ever stored.
 */
export async function loadLabels(homePath: (...segments: string[]) => string): Promise<LabelState> {
  try {
    const parsed = JSON.parse(await readFile(join(homePath(STATE_DIRECTORY, STATE_FILE)), 'utf8')) as LabelState
    if (!Array.isArray(parsed.labels) || typeof parsed.assignments !== 'object' || parsed.assignments === null) return EMPTY_LABELS
    return {
      generation: typeof parsed.generation === 'string' ? parsed.generation : 'g1',
      seq: typeof parsed.seq === 'number' ? parsed.seq : 0,
      labels: parsed.labels.filter((label) => typeof label?.name === 'string'),
      assignments: parsed.assignments,
    }
  } catch {
    // An absent file is the normal first run; an unreadable one leaves the
    // daemon with no labels rather than refusing to start.
    return EMPTY_LABELS
  }
}

/**
 * Write the label store, replacing it whole.
 * @param homePath - harness home path builder.
 * @param state - catalog to store.
 */
export async function saveLabels(homePath: (...segments: string[]) => string, state: LabelState): Promise<void> {
  const file = join(homePath(STATE_DIRECTORY, STATE_FILE))
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

/** Normalize a label name the way the client does. */
export function normalizeLabelName(name: string): string {
  return name.replace(/\s+/g, ' ').trim()
}

/** Create or rename one label, returning the catalog after the change. */
export function applyLabelUpdate(
  state: LabelState,
  input: { readonly name: string; readonly newName?: string; readonly color?: typeof LABEL_COLORS[number] },
): { readonly state: LabelState; readonly label: LabelDefinition; readonly affected: number } {
  const name = normalizeLabelName(input.name)
  const target = input.newName === undefined ? name : normalizeLabelName(input.newName)
  const existing = state.labels.find((label) => label.name === name)
  const label: LabelDefinition = {
    name: target,
    color: input.color ?? existing?.color ?? 'sky',
  }
  const labels = [...state.labels.filter((entry) => entry.name !== name && entry.name !== target), label]
  const assignments: Record<string, readonly string[]> = {}
  let affected = 0
  for (const [workspaceId, names] of Object.entries(state.assignments)) {
    if (!names.includes(name)) {
      assignments[workspaceId] = names
      continue
    }
    affected += 1
    assignments[workspaceId] = names.map((entry) => entry === name ? target : entry)
  }
  return {
    state: { ...state, seq: state.seq + 1, labels, assignments },
    label,
    affected,
  }
}

/** Remove one label and every assignment of it. */
export function applyLabelDelete(state: LabelState, name: string): { readonly state: LabelState; readonly affected: number } {
  const target = normalizeLabelName(name)
  const assignments: Record<string, readonly string[]> = {}
  let affected = 0
  for (const [workspaceId, names] of Object.entries(state.assignments)) {
    if (!names.includes(target)) {
      assignments[workspaceId] = names
      continue
    }
    affected += 1
    assignments[workspaceId] = names.filter((entry) => entry !== target)
  }
  return {
    state: {
      ...state,
      seq: state.seq + 1,
      labels: state.labels.filter((label) => label.name !== target),
      assignments,
    },
    affected,
  }
}

/** Assign or clear one label on one workspace. */
export function applyAssignment(
  state: LabelState,
  workspaceId: string,
  label: LabelDefinition,
  assigned: boolean,
): { readonly state: LabelState; readonly workspaceLabels: readonly string[] } {
  const name = normalizeLabelName(label.name)
  const current = state.assignments[workspaceId] ?? []
  const next = assigned
    ? current.includes(name) ? current : [...current, name]
    : current.filter((entry) => entry !== name)
  const labels = state.labels.some((entry) => entry.name === name)
    ? state.labels
    : [...state.labels, { name, color: label.color }]
  return {
    state: {
      ...state,
      seq: state.seq + 1,
      labels,
      assignments: { ...state.assignments, [workspaceId]: next },
    },
    workspaceLabels: next,
  }
}

/** Labels assigned to one workspace, in catalog order. */
export function labelsOf(state: LabelState, workspaceId: string): readonly string[] {
  const assigned = state.assignments[workspaceId] ?? []
  return state.labels.filter((label) => assigned.includes(label.name)).map((label) => label.name)
}

/** Operator presentation of one project. */
export interface ProjectPresentation {
  /** Name the operator gave the project, overriding the directory name. */
  readonly customName?: string
  /** Icon bytes as base64 with their media type. */
  readonly icon?: { readonly data: string; readonly mimeType: string }
}

/** Everything the presentation file holds. */
export type ProjectState = Readonly<Record<string, ProjectPresentation>>

/** File name of the project presentation store. */
const PROJECT_FILE = 'projects.json'

/**
 * Read the project presentation store.
 * @param homePath - harness home path builder.
 * @returns one entry per project that has a custom name or icon.
 */
export async function loadProjects(homePath: (...segments: string[]) => string): Promise<ProjectState> {
  try {
    const parsed = JSON.parse(await readFile(join(homePath(STATE_DIRECTORY, PROJECT_FILE)), 'utf8')) as ProjectState
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    // An absent file is the normal first run; an unreadable one leaves the
    // operator's names and icons unset rather than refusing to start.
    return {}
  }
}

/**
 * Write the project presentation store, replacing it whole.
 * @param homePath - harness home path builder.
 * @param state - presentations to store.
 */
export async function saveProjects(homePath: (...segments: string[]) => string, state: ProjectState): Promise<void> {
  const file = join(homePath(STATE_DIRECTORY, PROJECT_FILE))
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}
