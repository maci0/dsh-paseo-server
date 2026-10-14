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
import type { AgentRecord, TimelineEntry, WorkspaceRecord } from '../bridge.ts';
/** One directory row. */
export interface DirectoryRow {
    readonly agent: AgentRecord;
    readonly workspace: WorkspaceRecord;
}
/** Filter a client may apply to the directory. */
export interface DirectoryFilter {
    readonly statuses?: readonly string[];
    readonly includeArchived?: boolean;
    readonly projectKeys?: readonly string[];
    readonly requiresAttention?: boolean;
}
/** One sort instruction. */
export interface DirectorySort {
    readonly key: 'status_priority' | 'created_at' | 'updated_at' | 'title';
    readonly direction: 'asc' | 'desc';
}
/** How many rows and from where. */
export interface DirectoryPage {
    readonly limit: number;
    readonly cursor?: string;
}
/** One directory query. */
export interface DirectoryQuery {
    readonly filter?: DirectoryFilter;
    readonly search?: string;
    readonly sort?: readonly DirectorySort[];
    readonly page?: DirectoryPage;
}
/** Result of one directory query. */
export interface DirectoryResult {
    readonly rows: readonly DirectoryRow[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
}
/**
 * Apply one directory query.
 * @param rows - every row the daemon can offer.
 * @param query - filter, search, sort, and page.
 * @returns the page and its cursor.
 */
export declare function queryDirectory(rows: readonly DirectoryRow[], query: DirectoryQuery): DirectoryResult;
/** One place a search term occurs. */
export interface SearchLocation {
    readonly seq: number;
    readonly role: 'user' | 'assistant';
    readonly count: number;
}
/** Timeline search result. */
export interface SearchResult {
    readonly locations: readonly SearchLocation[];
    readonly nextCursor: number | null;
}
/**
 * Find the rows of one timeline that contain a term.
 * @param entries - timeline rows, oldest first.
 * @param query - term to find.
 * @param cursor - row index to resume from.
 * @returns the matches and the cursor for the next page.
 */
export declare function searchTimeline(entries: readonly TimelineEntry[], query: string, cursor?: number): SearchResult;
/** One earlier prompt in a conversation. */
export interface PromptPreview {
    readonly seq: number;
    readonly timestamp: string;
    readonly preview: string;
}
/**
 * List the user prompts of one timeline.
 * @param entries - timeline rows, oldest first.
 * @returns one entry per user message or steering row.
 */
export declare function listPrompts(entries: readonly TimelineEntry[]): readonly PromptPreview[];
