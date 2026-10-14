/**
 * The file surface a client browses: one directory listing and one file read.
 *
 * Every path is resolved against the workspace directory the daemon advertised
 * and refused when it escapes that directory, so a browse request cannot read
 * the rest of the machine.
 *
 * @module dsh-paseo-server/dsh/files
 */
/** One directory entry. */
export interface DirectoryEntry {
    readonly name: string;
    readonly path: string;
    readonly kind: 'file' | 'directory';
    readonly size: number;
    readonly modifiedAt: string;
}
/** One file's content and how to interpret it. */
export interface FileContent {
    readonly path: string;
    readonly kind: 'text' | 'image' | 'binary';
    readonly encoding: 'utf-8' | 'base64' | 'none';
    readonly content?: string;
    readonly mimeType?: string;
    readonly size: number;
    readonly modifiedAt: string;
}
/**
 * Resolve one requested path inside a workspace directory.
 * @param base - advertised workspace directory.
 * @param requested - relative path the client asked for, or empty for the root.
 * @returns the absolute path, or null when it escapes the workspace.
 */
export declare function resolveInside(base: string, requested: string | undefined): string | null;
/**
 * List one directory.
 * @param base - workspace directory.
 * @param requested - path inside it.
 * @returns the entries sorted by name, or null when the path is not a readable directory.
 */
export declare function listDirectory(base: string, requested?: string): Promise<readonly DirectoryEntry[] | null>;
/**
 * Read one file.
 * @param base - workspace directory.
 * @param requested - path inside it.
 * @returns the content, or null when the path is unreadable or too large.
 */
export declare function readWorkspaceFile(base: string, requested: string): Promise<FileContent | null>;
/** One suggestion for a partially typed path. */
export interface PathSuggestion {
    readonly path: string;
    readonly kind: 'file' | 'directory';
}
/**
 * Suggest paths under the directory a partially typed path names.
 *
 * This is the picker a client uses to add a project, so unlike the workspace
 * browser it deliberately reads outside the advertised workspaces: choosing a
 * directory to add is exactly the case where nothing is advertised yet. It
 * lists names only and never file contents, and only on the daemon side of an
 * authenticated session.
 * @param query - partial path, absolute or relative to `cwd`.
 * @param cwd - directory a relative query resolves against.
 * @param limit - most suggestions to return.
 * @returns matching entries, directories first.
 */
export declare function suggestPaths(query: string, cwd: string, limit: number): Promise<readonly PathSuggestion[]>;
/** One project config file read back with its revision. */
export interface ProjectConfigFile {
    readonly config: unknown;
    readonly revision: {
        readonly mtimeMs: number;
        readonly size: number;
    };
}
/**
 * Read a project config file.
 * @param directory - project root.
 * @returns the parsed config and its revision, or null when there is no readable file.
 */
export declare function readProjectConfig(directory: string): Promise<ProjectConfigFile | null>;
/**
 * Write a project config file, refusing a write based on a stale revision.
 * @param directory - project root.
 * @param config - config document to store.
 * @param expected - revision the client read, or null to create or overwrite.
 * @returns the new revision, or the reason the write was refused.
 */
export declare function writeProjectConfig(directory: string, config: unknown, expected: {
    readonly mtimeMs: number;
    readonly size: number;
} | null): Promise<{
    readonly revision: {
        readonly mtimeMs: number;
        readonly size: number;
    };
} | {
    readonly error: string;
}>;
