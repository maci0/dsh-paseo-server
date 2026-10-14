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
/** Colors a label may carry, as the Paseo protocol enumerates them. */
export declare const LABEL_COLORS: readonly ['violet', 'sky', 'emerald', 'orange', 'pink', 'indigo', 'teal', 'red', 'amber', 'blue'];
/** One label definition. */
export interface LabelDefinition {
    readonly name: string;
    readonly color: typeof LABEL_COLORS[number];
}
/** Everything the label file holds. */
export interface LabelState {
    /** Generation token the client echoes back in a sync cursor. */
    readonly generation: string;
    /** Sequence of the newest change, which is what a sync cursor advances on. */
    readonly seq: number;
    readonly labels: readonly LabelDefinition[];
    /** Workspace id to the label names assigned to it. */
    readonly assignments: Readonly<Record<string, readonly string[]>>;
}
/** Empty catalog a first run starts from. */
export declare const EMPTY_LABELS: LabelState;
/**
 * Read the label store.
 * @param homePath - harness home path builder.
 * @returns the catalog, empty when nothing was ever stored.
 */
export declare function loadLabels(homePath: (...segments: string[]) => string): Promise<LabelState>;
/**
 * Write the label store, replacing it whole.
 * @param homePath - harness home path builder.
 * @param state - catalog to store.
 */
export declare function saveLabels(homePath: (...segments: string[]) => string, state: LabelState): Promise<void>;
/** Normalize a label name the way the client does. */
export declare function normalizeLabelName(name: string): string;
/** Create or rename one label, returning the catalog after the change. */
export declare function applyLabelUpdate(state: LabelState, input: {
    readonly name: string;
    readonly newName?: string;
    readonly color?: typeof LABEL_COLORS[number];
}): {
    readonly state: LabelState;
    readonly label: LabelDefinition;
    readonly affected: number;
};
/** Remove one label and every assignment of it. */
export declare function applyLabelDelete(state: LabelState, name: string): {
    readonly state: LabelState;
    readonly affected: number;
};
/** Assign or clear one label on one workspace. */
export declare function applyAssignment(state: LabelState, workspaceId: string, label: LabelDefinition, assigned: boolean): {
    readonly state: LabelState;
    readonly workspaceLabels: readonly string[];
};
/** Labels assigned to one workspace, in catalog order. */
export declare function labelsOf(state: LabelState, workspaceId: string): readonly string[];
/** Operator presentation of one project. */
export interface ProjectPresentation {
    /** Name the operator gave the project, overriding the directory name. */
    readonly customName?: string;
    /** Icon bytes as base64 with their media type. */
    readonly icon?: {
        readonly data: string;
        readonly mimeType: string;
    };
}
/** Everything the presentation file holds. */
export type ProjectState = Readonly<Record<string, ProjectPresentation>>;
/**
 * Read the project presentation store.
 * @param homePath - harness home path builder.
 * @returns one entry per project that has a custom name or icon.
 */
export declare function loadProjects(homePath: (...segments: string[]) => string): Promise<ProjectState>;
/**
 * Write the project presentation store, replacing it whole.
 * @param homePath - harness home path builder.
 * @param state - presentations to store.
 */
export declare function saveProjects(homePath: (...segments: string[]) => string, state: ProjectState): Promise<void>;
