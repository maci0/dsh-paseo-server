/**
 * Directory, search, and prompt projections over the same records the daemon
 * already reads.
 *
 * Paseo asks for a paginated, filtered, sorted agent directory and for matches
 * inside one agent's timeline. Both are pure queries over data this daemon
 * holds, so they live here rather than in the protocol layer.
 *
 * @module dsh-paseo-server/paseo/directory
 */

import type { AgentRecord, TimelineEntry, WorkspaceRecord } from '../bridge.ts'

/** One directory row. */
export interface DirectoryRow {
  readonly agent: AgentRecord
  readonly workspace: WorkspaceRecord
}

/** Filter a client may apply to the directory. */
export interface DirectoryFilter {
  readonly statuses?: readonly string[]
  readonly includeArchived?: boolean
  readonly projectKeys?: readonly string[]
  readonly requiresAttention?: boolean
}

/** One sort instruction. */
export interface DirectorySort {
  readonly key: 'status_priority' | 'created_at' | 'updated_at' | 'title'
  readonly direction: 'asc' | 'desc'
}

/** How many rows and from where. */
export interface DirectoryPage {
  readonly limit: number
  readonly cursor?: string
}

/** One directory query. */
export interface DirectoryQuery {
  readonly filter?: DirectoryFilter
  readonly search?: string
  readonly sort?: readonly DirectorySort[]
  readonly page?: DirectoryPage
}

/** Result of one directory query. */
export interface DirectoryResult {
  readonly rows: readonly DirectoryRow[]
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

/** Running agents rank above the rest, which is what a client sorts on first. */
const STATUS_PRIORITY: Readonly<Record<string, number>> = {
  running: 0,
  initializing: 1,
  error: 2,
  idle: 3,
  closed: 4,
}

/** Default page size when the client names none. */
const DEFAULT_PAGE_LIMIT = 50

/**
 * Apply one directory query.
 * @param rows - every row the daemon can offer.
 * @param query - filter, search, sort, and page.
 * @returns the page and its cursor.
 */
export function queryDirectory(rows: readonly DirectoryRow[], query: DirectoryQuery): DirectoryResult {
  // An archived agent stays out of the directory unless the client asked for
  // it, which is a rule of the listing rather than of one filter.
  const filtered = rows.filter((row) =>
    (query.filter?.includeArchived === true || row.agent.archivedAt == null)
    && matchesFilter(row, query.filter)
    && matchesSearch(row, query.search))
  const sorted = [...filtered].sort(compareBy(query.sort))
  const offset = cursorOffset(query.page?.cursor)
  const limit = query.page?.limit !== undefined && query.page.limit > 0 ? query.page.limit : DEFAULT_PAGE_LIMIT
  const page = sorted.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  const hasMore = nextOffset < sorted.length
  return { rows: page, nextCursor: hasMore ? String(nextOffset) : null, hasMore }
}

/** Whether one row passes the requested filter. */
function matchesFilter(row: DirectoryRow, filter: DirectoryFilter | undefined): boolean {
  if (filter === undefined) return true
  if (filter.statuses !== undefined && filter.statuses.length > 0 && !filter.statuses.includes(row.agent.status)) return false
  if (filter.projectKeys !== undefined && filter.projectKeys.length > 0 && !filter.projectKeys.includes(row.workspace.projectId)) return false
  if (filter.requiresAttention === true && row.agent.status !== 'error') return false
  return true
}

/** Whether one row matches the free-text search. */
function matchesSearch(row: DirectoryRow, search: string | undefined): boolean {
  if (search === undefined || search.trim().length === 0) return true
  const needle = search.trim().toLowerCase()
  const haystack = [
    row.agent.title ?? '',
    row.agent.cwd,
    row.workspace.name,
    row.workspace.projectName,
    row.workspace.directory,
    row.workspace.projectId,
  ].join(' ').toLowerCase()
  return haystack.includes(needle)
}

/** Comparator for the requested sort keys, defaulting to most recently updated first. */
function compareBy(sort: readonly DirectorySort[] | undefined): (left: DirectoryRow, right: DirectoryRow) => number {
  const keys = sort !== undefined && sort.length > 0 ? sort : [{ key: 'updated_at', direction: 'desc' } as DirectorySort]
  return (left, right) => {
    for (const instruction of keys) {
      const order = compareKey(left, right, instruction)
      if (order !== 0) return order
    }
    return left.agent.id.localeCompare(right.agent.id)
  }
}

/** One sort key's comparison. */
function compareKey(left: DirectoryRow, right: DirectoryRow, instruction: DirectorySort): number {
  const direction = instruction.direction === 'asc' ? 1 : -1
  if (instruction.key === 'title') {
    return direction * (left.agent.title ?? '').localeCompare(right.agent.title ?? '')
  }
  if (instruction.key === 'created_at') {
    return direction * (Date.parse(left.agent.createdAt) - Date.parse(right.agent.createdAt))
  }
  if (instruction.key === 'status_priority') {
    return direction * ((STATUS_PRIORITY[left.agent.status] ?? 99) - (STATUS_PRIORITY[right.agent.status] ?? 99))
  }
  return direction * (Date.parse(left.agent.updatedAt) - Date.parse(right.agent.updatedAt))
}

/** Read an offset cursor, treating a malformed one as the start. */
function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const parsed = Number(cursor)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

/** One place a search term occurs. */
export interface SearchLocation {
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly count: number
}

/** Timeline search result. */
export interface SearchResult {
  readonly locations: readonly SearchLocation[]
  readonly nextCursor: number | null
}

/** Most matches one search page returns. */
const SEARCH_PAGE_SIZE = 50

/**
 * Find the rows of one timeline that contain a term.
 * @param entries - timeline rows, oldest first.
 * @param query - term to find.
 * @param cursor - row index to resume from.
 * @returns the matches and the cursor for the next page.
 */
export function searchTimeline(entries: readonly TimelineEntry[], query: string, cursor?: number): SearchResult {
  const needle = query.toLowerCase()
  if (needle.length === 0) return { locations: [], nextCursor: null }
  const locations: SearchLocation[] = []
  let index = cursor !== undefined && cursor >= 0 ? cursor : 0
  let next: number | null = null
  for (; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === undefined) continue
    const text = textOf(entry)
    const role = roleOf(entry)
    if (text === null || role === null) continue
    const count = occurrences(text.toLowerCase(), needle)
    if (count === 0) continue
    if (locations.length >= SEARCH_PAGE_SIZE) {
      next = index
      break
    }
    locations.push({ seq: entry.seq, role, count })
  }
  return { locations, nextCursor: next }
}

/** One earlier prompt in a conversation. */
export interface PromptPreview {
  readonly seq: number
  readonly timestamp: string
  readonly preview: string
}

/** Longest preview one prompt entry carries. */
const PREVIEW_CHARS = 200

/**
 * List the user prompts of one timeline.
 * @param entries - timeline rows, oldest first.
 * @returns one entry per user message or steering row.
 */
export function listPrompts(entries: readonly TimelineEntry[]): readonly PromptPreview[] {
  const prompts: PromptPreview[] = []
  for (const entry of entries) {
    const text = textOf(entry)
    if (text === null || roleOf(entry) !== 'user') continue
    prompts.push({
      seq: entry.seq,
      timestamp: entry.timestamp,
      preview: text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`,
    })
  }
  return prompts
}

/** Text one row carries, when it carries any. */
function textOf(entry: TimelineEntry): string | null {
  const item = entry.item
  if (item.type === 'user_message' || item.type === 'assistant_message' || item.type === 'reasoning') return item.text
  return null
}

/** Which side of the conversation one row belongs to. */
function roleOf(entry: TimelineEntry): 'user' | 'assistant' | null {
  const item = entry.item
  if (item.type === 'user_message') return 'user'
  if (item.type === 'assistant_message' || item.type === 'reasoning') return 'assistant'
  return null
}

/** Count non-overlapping occurrences of a needle. */
function occurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
