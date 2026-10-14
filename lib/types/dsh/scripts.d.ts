/**
 * Workspace scripts, as `paseo.json` declares them.
 *
 * Paseo keeps its per-workspace script declarations in `paseo.json` at the
 * workspace root, so this daemon reads the same file. Nothing else about the
 * format is invented: a script is a name, an optional lifecycle type, a
 * command, and an optional port.
 *
 * @module dsh-paseo-server/dsh/scripts
 */
/** One declared script. */
export interface WorkspaceScriptDefinition {
    readonly name: string;
    readonly type: 'script' | 'service';
    readonly command: string;
    /** Port the script serves on, when it declares one; Paseo does not proxy without it. */
    readonly port: number | null;
}
/**
 * Read one workspace's script declarations.
 * @param directory - workspace directory.
 * @returns the declarations, empty when the file is absent or unreadable.
 */
export declare function readWorkspaceScripts(directory: string): Promise<readonly WorkspaceScriptDefinition[]>;
