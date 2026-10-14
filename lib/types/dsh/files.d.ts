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
/** Outcome of one filesystem write inside a workspace. */
export type WriteOutcome = {
    readonly status: 'written';
    readonly modifiedAt: string;
    readonly size: number;
} | {
    readonly status: 'conflict';
    readonly modifiedAt: string;
    readonly size: number;
} | {
    readonly status: 'error';
    readonly error: string;
};
/**
 * Write one file, refusing a write based on a stale modification time.
 *
 * The client sends the modification time it read; a file that changed since
 * then is reported as a conflict instead of being overwritten, which is what
 * keeps two writers from silently losing one of the changes.
 * @param base - workspace directory.
 * @param requested - path inside it.
 * @param content - text to store.
 * @param expectedModifiedAt - modification time the client read.
 * @returns the outcome.
 */
export declare function writeWorkspaceFile(base: string, requested: string, content: string, expectedModifiedAt: string): Promise<WriteOutcome>;
/** Create one file or directory inside a workspace. */
export declare function createEntry(base: string, parentPath: string, name: string, kind: 'file' | 'directory'): Promise<{
    readonly path: string;
} | {
    readonly error: string;
}>;
/** Whether one path inside a workspace exists. */
export declare function entryExists(base: string, requested: string): Promise<boolean>;
/** Rename or move one entry inside a workspace. */
export declare function renameEntry(base: string, requested: string, name: string): Promise<{
    readonly path: string;
} | {
    readonly error: string;
}>;
/** Delete one entry inside a workspace, recursively for a directory. */
export declare function deleteEntry(base: string, requested: string): Promise<{
    readonly ok: true;
} | {
    readonly error: string;
}>;
/** Copy one entry next to itself under a fresh name, as a client duplicate does. */
export declare function duplicateEntry(base: string, requested: string): Promise<{
    readonly path: string;
} | {
    readonly error: string;
}>;
/** One path's size and modification time. */
export declare function statEntry(base: string, requested: string): Promise<{
    readonly size: number;
    readonly modifiedAt: string;
} | null>;
/** One upload in progress, written under the harness home. */
export interface UploadTarget {
    readonly id: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly path: string;
    readonly expectedSize: number;
    received: number;
    started: boolean;
}
/** Name one upload's directory and file. */
export declare function uploadPath(home: string, id: string, fileName: string): string;
/** Strip anything from a client-supplied name that a path must not carry. */
export declare function sanitizeFileName(name: string): string;
/** Create the file a begin frame starts writing into. */
export declare function startUpload(target: UploadTarget): Promise<void>;
/**
 * Append one chunk.
 * @param target - upload being written.
 * @param bytes - chunk bytes.
 * @returns null when accepted, or the reason the chunk was refused.
 */
export declare function appendUpload(target: UploadTarget, bytes: Uint8Array): Promise<string | null>;
/** Finish one upload, removing it when the byte count does not match. */
export declare function finishUpload(target: UploadTarget): Promise<string | null>;
/** Discard an upload that failed or was abandoned. */
export declare function discardUpload(target: UploadTarget): Promise<void>;
/** One download token, redeemed by the HTTP route that serves the file. */
export interface DownloadGrant {
    readonly token: string;
    readonly path: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly expiresAt: number;
}
/**
 * Mint one download grant.
 *
 * The token is what the client puts on the download URL, so it is random and
 * short lived rather than derived from the path.
 * @param path - absolute file the token unlocks.
 * @param fileName - name offered in the download.
 * @param mimeType - media type to serve.
 * @returns the grant.
 */
export declare function createDownloadGrant(path: string, fileName: string, mimeType: string): DownloadGrant;
/** How long a download token stays valid. */
export declare const DOWNLOAD_GRANT_TTL_MS = 60000;
/** Guess a media type from a file name. */
export declare function mediaTypeOf(fileName: string): string;
/**
 * Create one directory under a parent path.
 *
 * This is the project picker's "new folder", so unlike the workspace browser it
 * writes outside the advertised directories on purpose: the folder being
 * created is the one about to be added.
 * @param parentPath - directory to create it in.
 * @param name - one path segment.
 * @returns the created path, or why it was refused.
 */
export declare function createDirectory(parentPath: string, name: string): Promise<{
    readonly path: string;
} | {
    readonly error: string;
}>;
