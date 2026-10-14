/**
 * DeepSeek Harness binding for the Paseo bridge.
 *
 * One DSH Session is one Paseo agent, one DSH workspace record is one Paseo
 * workspace, and the repository root behind a workspace directory is the Paseo
 * project. Prompts enter through the session controller, and the timeline is
 * folded from the durable session log, so the two sides never disagree about
 * what happened.
 *
 * @module dsh-paseo-server/dsh/bridge
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createPullRequest as forgeCreatePullRequest, forgeToken, lookupPullRequest, mergePullRequest as forgeMergePullRequest, parseGithubRemote, readCheckDetails, readPullRequestTimeline, searchIssuesAndPulls, searchRepositories, setAutoMerge as forgeSetAutoMerge, } from './forge.js';
import { basename, dirname, join } from 'node:path';
import { addWorktree, cloneRepository, commitCheckout, commitFileDiff, listWorktrees, removeWorktree, discardChanges, listBranches, listCommits, mergeRef, pullCheckout, pushCheckout, readDiff, readGitStatus, renameBranch, resolveBranch, stashList, stashPop, stashSave, switchBranch, } from './git.js';
import { createDirectory, createEntry, deleteEntry, duplicateEntry, listDirectory, readProjectConfig, readWorkspaceFile, renameEntry, sanitizeFileName, statEntry, suggestPaths, uploadPath, writeProjectConfig, writeWorkspaceFile, } from './files.js';
import { loadPausedReminders, savePausedReminders } from './paused-reminders.js';
import { fromPaseoCadence, toPaseoCadence } from './schedules.js';
import { readWorkspaceScripts, readWorktreeSetup } from './scripts.js';
/** Longest agent title derived from a first prompt. */
const TITLE_MAX_CHARS = 80;
/** Messages one cold session's history page returns, matching the client's tail window. */
const COLD_TIMELINE_PAGE_MESSAGES = 200;
/** PTY size a terminal starts with when the client names none. */
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
/** Binding that presents a DSH composition as a Paseo bridge. */
export function createDshBridge(options) {
    return new DshBridge(options);
}
class DshBridge {
    ctx;
    defaultProvider;
    defaultModel;
    listeners = new Set();
    disposers = [];
    workspaceCache = new Map();
    titles = new Map();
    failed = new Set();
    /** Client-minted prompt identities awaiting their user/message event, oldest first. */
    /** Owning session and writable attachment of every terminal this daemon saw. */
    /** Running script jobs, keyed by workspace and script name. */
    /** Workspaces whose declared setup command this daemon started. */
    setupJobs = new Set();
    /** Session that owns each reminder this daemon has seen. */
    scheduleOwners = new Map();
    /** First instant this daemon saw each reminder, which stands in for a creation time. */
    scheduleSeenAt = new Map();
    /** Runtime reminder behind each client-visible reminder identity. */
    scheduleDshIds = new Map();
    /** Reminders this daemon paused, and whether the store was read yet. */
    pausedReminders = [];
    pausedLoaded = false;
    scriptJobs = new Map();
    terminalOwners = new Map();
    pendingClientMessageIds = [];
    started = false;
    constructor(options) {
        this.ctx = options.ctx;
        this.defaultProvider = options.defaultProvider;
        this.defaultModel = options.defaultModel;
    }
    /** Placeholder identity until {@link bindIdentity} installs the real one. */
    serverId = 'srv_pending00000';
    /** Placeholder version until {@link bindIdentity} installs the real one. */
    version = '0.0.0';
    /** Install the daemon identity reported to clients. */
    bindIdentity(serverId, version) {
        this.serverId = serverId;
        this.version = version;
    }
    async listProviders() {
        const llm = this.ctx.get('llm');
        const providers = llm?.listProviders?.() ?? [];
        if (providers.length === 0)
            return [{ provider: this.defaultProvider, available: true }];
        return providers.map((entry) => ({ provider: entry.id, available: true }));
    }
    async listProviderModels(provider) {
        const llm = this.ctx.get('llm');
        if (llm?.listModels === undefined)
            return [];
        try {
            const models = await llm.listModels(provider);
            return models.map((model) => ({
                id: model.id,
                label: model.name ?? model.id,
                ...(model.description === undefined ? {} : { description: model.description }),
            }));
        }
        catch (error) {
            this.ctx.logger.warn(`paseo: model catalog for ${provider} failed: ${String(error)}`);
            return [];
        }
    }
    async listWorkspaces() {
        const registry = this.ctx.get('workspaceRegistry');
        const records = new Map();
        if (registry !== undefined) {
            for (const workspace of registry.list()) {
                const record = this.workspaceRecord(workspace, workspace.path, workspace.title, workspace.createdAt, workspace.updatedAt, []);
                records.set(record.id, record);
            }
        }
        for (const summary of await this.summaries()) {
            const cwd = summary.cwd;
            if (cwd === undefined)
                continue;
            const record = this.workspaceForCwd(cwd);
            records.set(record.id, record);
        }
        const list = [...records.values()];
        for (const record of list)
            this.workspaceCache.set(record.id, record);
        return list;
    }
    async listAgents() {
        const workspaces = await this.listWorkspaces();
        const byCwd = new Map(workspaces.map((workspace) => [workspace.directory, workspace]));
        const archived = this.archivedSessionIds();
        const agents = [];
        for (const summary of await this.summaries()) {
            if (summary.parentSessionId !== undefined || summary.origin === 'subagent')
                continue;
            if (archived.has(summary.sessionId))
                continue;
            agents.push(this.agentRecord(summary, byCwd.get(summary.cwd ?? '')));
        }
        return agents;
    }
    /** Read one directory's checkout state. */
    async checkoutStatus(directory) {
        return readGitStatus(directory);
    }
    /** Read one directory's parsed diff. */
    async checkoutDiff(directory, compare) {
        return readDiff(directory, compare);
    }
    /** Commit one directory's working tree. */
    async commitCheckout(directory, message, addAll) {
        return commitCheckout(directory, message, addAll);
    }
    /** Push one directory's current branch. */
    async pushCheckout(directory) {
        return pushCheckout(directory);
    }
    /** Fast-forward one directory from its upstream. */
    async pullCheckout(directory) {
        return pullCheckout(directory);
    }
    /** Branch refs a client may switch to. */
    async listBranches(directory, query, limit) {
        return listBranches(directory, query, limit);
    }
    /** Whether one branch name resolves. */
    async resolveBranch(directory, branch) {
        return resolveBranch(directory, branch);
    }
    async switchBranch(directory, branch) {
        return switchBranch(directory, branch);
    }
    async renameBranch(directory, branch) {
        return renameBranch(directory, branch);
    }
    async discardChanges(directory, paths) {
        return discardChanges(directory, paths);
    }
    async stashSave(directory, branch) {
        return stashSave(directory, branch);
    }
    async stashList(directory, paseoOnly) {
        return stashList(directory, paseoOnly);
    }
    async stashPop(directory) {
        return stashPop(directory);
    }
    async listCommits(directory) {
        return listCommits(directory);
    }
    async commitFileDiff(directory, sha, path) {
        return commitFileDiff(directory, sha, path);
    }
    async mergeRef(directory, baseRef, strategy) {
        return mergeRef(directory, baseRef, strategy);
    }
    /** List one workspace directory. */
    async listDirectory(directory, path) {
        return listDirectory(directory, path);
    }
    /** Read one file inside a workspace directory. */
    async readWorkspaceFile(directory, path) {
        return readWorkspaceFile(directory, path);
    }
    /** Write one file inside a workspace. */
    async writeWorkspaceFile(directory, path, content, expectedModifiedAt) {
        return writeWorkspaceFile(directory, path, content, expectedModifiedAt);
    }
    async createEntry(directory, parentPath, name, kind) {
        return createEntry(directory, parentPath, name, kind);
    }
    async renameEntry(directory, path, name) {
        return renameEntry(directory, path, name);
    }
    async duplicateEntry(directory, path) {
        return duplicateEntry(directory, path);
    }
    async deleteEntry(directory, path) {
        return deleteEntry(directory, path);
    }
    async statEntry(directory, path) {
        return statEntry(directory, path);
    }
    /** Begin an upload under the harness home, or the OS temp root without one. */
    async beginUpload(input) {
        const id = `upload_${randomUUID()}`;
        const home = this.homePath()?.('paseo') ?? process.env.DSH_HOME ?? process.cwd();
        const fileName = sanitizeFileName(input.fileName);
        return {
            id,
            fileName,
            mimeType: input.mimeType,
            path: uploadPath(home, id, fileName),
            expectedSize: input.size,
            received: 0,
            started: false,
        };
    }
    /** Worktrees of one repository. */
    async listWorktrees(directory) {
        return listWorktrees(directory);
    }
    /**
     * Create a worktree beside its repository and register it as a workspace.
     *
     * The path follows the repository's own name so two repositories do not
     * collide in one parent directory.
     */
    async createWorktree(directory, input) {
        const status = await readGitStatus(directory);
        const root = status.repoRoot ?? directory;
        const path = join(dirname(root), `${basename(root)}-${input.branch.replace(/[^A-Za-z0-9._-]/g, '-')}`);
        const created = await addWorktree(root, {
            path,
            branch: input.branch,
            ...(input.from === undefined ? {} : { from: input.from }),
        });
        if ('error' in created)
            return created;
        const workspace = await this.createWorkspace({ directory: path, name: `${basename(root)} (${input.branch})` });
        return { workspace };
    }
    /** Remove one worktree and its workspace record. */
    async removeWorktree(directory, path) {
        const status = await readGitStatus(directory);
        const root = status.repoRoot ?? directory;
        const removed = await removeWorktree(root, path, false);
        if (removed.success) {
            const workspace = (await this.listWorkspaces()).find((candidate) => candidate.directory === path);
            if (workspace !== undefined)
                await this.deleteWorkspace(workspace.id);
        }
        return removed;
    }
    /** Remove one workspace record. */
    async deleteWorkspace(workspaceId) {
        const registry = this.ctx.get('workspaceRegistry');
        if (registry?.delete === undefined)
            return false;
        return registry.delete(workspaceId);
    }
    /** Suggest paths for a partially typed path. */
    async suggestPaths(query, cwd, limit) {
        return suggestPaths(query, cwd, limit);
    }
    /** Read one project's config file. */
    async readProjectConfig(directory) {
        return readProjectConfig(directory);
    }
    /** Write one project's config file. */
    async writeProjectConfig(directory, config, expected) {
        return writeProjectConfig(directory, config, expected);
    }
    /**
     * Install a model on one agent.
     *
     * Paseo names a model as `provider/model`; a bare model keeps the agent's
     * current provider, which is what a client picks from the same provider's
     * catalog.
     */
    async selectAgentModel(agentId, modelId) {
        const controller = this.requireController();
        if (controller.selectModel === undefined)
            throw new Error('this harness cannot select a model');
        const agent = await this.getAgent(agentId);
        if (agent === null)
            throw new Error(`unknown agent ${agentId}`);
        if (modelId === null || modelId.length === 0) {
            const selected = await controller.selectModel({ sessionId: agentId, provider: agent.provider, model: agent.model ?? '' });
            return { provider: selected.selected.provider, model: selected.selected.model };
        }
        const separator = modelId.indexOf('/');
        const provider = separator > 0 ? modelId.slice(0, separator) : agent.provider;
        const model = separator > 0 ? modelId.slice(separator + 1) : modelId;
        const selected = await controller.selectModel({ sessionId: agentId, provider, model });
        return { provider: selected.selected.provider, model: selected.selected.model };
    }
    /**
     * Sessions one parent spawned.
     *
     * A DSH child session carries `origin: 'subagent'` and names its parent, so
     * the subagent surface is a filter over the same listing the client uses for
     * agents rather than a second source of truth.
     */
    async listSubagents(parentAgentId) {
        const agents = await this.listAgents();
        return agents.filter((agent) => agent.parentAgentId === parentAgentId);
    }
    /** Render one session's conversation up to one message as plain text. */
    async forkContext(agentId, boundaryMessageId) {
        const entries = await this.getTimeline(agentId);
        const lines = [];
        let itemCount = 0;
        let boundary = null;
        for (const entry of entries) {
            const item = entry.item;
            const rendered = renderTimelineLine(item);
            if (rendered !== null) {
                lines.push(rendered);
                itemCount += 1;
            }
            if (boundaryMessageId !== undefined && item.type === 'user_message' && item.messageId === boundaryMessageId) {
                boundary = boundaryMessageId;
                break;
            }
        }
        return { text: lines.join('\n'), itemCount, boundaryMessageId: boundary };
    }
    /** Workspaces whose derived project identity is one id. */
    async workspacesOfProject(projectId) {
        return (await this.listWorkspaces()).filter((workspace) => workspace.projectId === projectId);
    }
    /** Pin or unpin every Session the workspace holds. */
    async setWorkspacePinned(workspaceId, pinned) {
        const registry = this.ctx.get('workspaceRegistry');
        if (registry === undefined)
            return null;
        if (pinned && registry.pinSession === undefined)
            return null;
        if (!pinned && registry.unpinSession === undefined)
            return null;
        const members = (await this.summaries())
            .filter((summary) => summary.cwd !== undefined && this.workspaceForCwd(summary.cwd).id === workspaceId);
        for (const summary of members) {
            if (pinned)
                await registry.pinSession?.(summary.sessionId);
            else
                await registry.unpinSession?.(summary.sessionId);
        }
        return pinned ? new Date().toISOString() : null;
    }
    /**
     * Pull request facts for one directory's current branch.
     *
     * A directory that is not a GitHub checkout answers with no pull request and
     * no authentication, because there is nothing to ask.
     */
    async checkoutPrStatus(directory) {
        const status = await readGitStatus(directory);
        const remote = parseGithubRemote(status.remoteUrl);
        if (remote === null || status.currentBranch === null)
            return { status: null, authenticated: false, error: null };
        return lookupPullRequest(remote, status.currentBranch, forgeToken());
    }
    /** Open a pull request for the directory's current branch. */
    async createPullRequest(directory, input) {
        const remote = await this.forgeRepo(directory);
        const head = await this.forgeBranch(directory);
        if (head === null)
            return { success: false, url: null, number: null, error: 'the directory is not on a branch' };
        const existing = await lookupPullRequest(remote, head, forgeToken());
        if (existing.status !== null) {
            return { success: false, url: existing.status.url, number: existing.status.number, error: 'a pull request already exists for this branch' };
        }
        return forgeCreatePullRequest(remote, forgeToken(), {
            head,
            base: input.baseRef !== undefined && input.baseRef.length > 0 ? input.baseRef : 'main',
            title: input.title !== undefined && input.title.length > 0 ? input.title : `Merge ${head}`,
            body: input.body ?? '',
        });
    }
    /** Merge the pull request whose head is the directory's current branch. */
    async mergePullRequest(directory, method) {
        const found = await this.pullRequestNumber(directory);
        if (typeof found === 'string')
            return { success: false, url: null, number: null, error: found };
        return forgeMergePullRequest(await this.forgeRepo(directory), forgeToken(), found, method);
    }
    /** Turn auto-merge on or off for that pull request. */
    async setPullRequestAutoMerge(directory, enabled, method) {
        const found = await this.pullRequestNumber(directory);
        if (typeof found === 'string')
            return { success: false, url: null, number: null, error: found };
        return forgeSetAutoMerge(await this.forgeRepo(directory), forgeToken(), found, enabled, method);
    }
    /** Discussion of that pull request. */
    async pullRequestTimeline(directory) {
        const found = await this.pullRequestNumber(directory);
        if (typeof found === 'string')
            return { items: [], error: found, number: null };
        const timeline = await readPullRequestTimeline(await this.forgeRepo(directory), forgeToken(), found);
        return { items: timeline.items, error: timeline.error, number: found };
    }
    /** One check run's details. */
    async checkDetails(directory, checkRunId) {
        return readCheckDetails(await this.forgeRepo(directory), forgeToken(), checkRunId);
    }
    /** Repository behind one directory, refusing a remote this daemon cannot read. */
    async forgeRepo(directory) {
        const status = await readGitStatus(directory);
        const remote = parseGithubRemote(status.remoteUrl);
        if (remote === null)
            throw new Error('this directory has no GitHub origin remote');
        return remote;
    }
    /** Current branch of one directory, or null when it is not on one. */
    async forgeBranch(directory) {
        const status = await readGitStatus(directory);
        return status.isGit ? status.currentBranch : null;
    }
    /** Pull request number for one directory, or why there is none. */
    async pullRequestNumber(directory) {
        const lookup = await this.checkoutPrStatus(directory);
        if (lookup.status !== null)
            return lookup.status.number;
        return lookup.error ?? 'no pull request is open for this branch';
    }
    /** Search repositories the token can see. */
    async searchRepositories(query, limit) {
        return searchRepositories(query, limit, forgeToken());
    }
    /** Search issues and pull requests the token can see. */
    async searchForge(query, limit) {
        return searchIssuesAndPulls(query, limit, forgeToken());
    }
    /** Create one directory for the project picker. */
    async createDirectory(parentPath, name) {
        return createDirectory(parentPath, name);
    }
    /** Clone one repository and register the checkout as a workspace. */
    async cloneRepository(repo, target) {
        const cloned = await cloneRepository(repo, target);
        if (!cloned.success)
            return { error: cloned.error?.message ?? 'cloning failed' };
        return { workspace: await this.createWorkspace({ directory: target, name: repo.split('/').pop() ?? target }) };
    }
    /**
     * Attach a persisted session, which is what resuming it means here.
     *
     * The controller adopts a session by id, so a client resuming a handle it
     * kept reaches the same transcript rather than a new session.
     */
    async resumeAgent(sessionId) {
        const controller = this.requireController();
        const summary = (await this.summaries()).find((item) => item.sessionId === sessionId);
        if (summary === undefined)
            return null;
        if (!summary.agentAvailable) {
            await controller.create({
                sessionId,
                ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
            });
        }
        return this.getAgent(sessionId);
    }
    /** Install a reasoning effort on the agent's current model. */
    async selectAgentThinking(agentId, thinkingOptionId) {
        const controller = this.requireController();
        if (controller.selectModel === undefined)
            throw new Error('this harness cannot select a model');
        const agent = await this.getAgent(agentId);
        if (agent === null)
            throw new Error(`unknown agent ${agentId}`);
        if (agent.model === null)
            throw new Error('the agent has no model to set a reasoning effort on');
        await controller.selectModel({
            sessionId: agentId,
            provider: agent.provider,
            model: agent.model,
            ...(thinkingOptionId === null || thinkingOptionId.length === 0 ? {} : { reasoningEffort: thinkingOptionId }),
        });
    }
    /** Run the workspace's declared setup command as a background job. */
    async runWorkspaceSetup(workspaceId) {
        const workspace = await this.workspaceFor(workspaceId);
        if (workspace === undefined)
            throw new Error(`unknown workspace ${workspaceId}`);
        const command = await readWorktreeSetup(workspace.directory);
        if (command === null)
            return false;
        const jobs = this.requireJobs();
        jobs.start({
            kind: 'paseo-setup',
            label: `setup: ${command}`,
            run: (job) => {
                const child = spawn(command, { cwd: workspace.directory, shell: true, env: process.env });
                return {
                    cancel: () => { child.kill('SIGTERM'); },
                    done: new Promise((resolve) => {
                        const forward = (chunk) => { job.append(chunk.toString('utf8')); };
                        child.stdout?.on('data', forward);
                        child.stderr?.on('data', forward);
                        child.on('error', (error) => { resolve({ ok: false, detail: error.message }); });
                        child.on('close', (code, signal) => {
                            resolve({ ok: code === 0, detail: signal === null ? `exit code: ${String(code)}` : `signal: ${signal}` });
                        });
                    }),
                };
            },
        });
        this.setupJobs.add(workspaceId);
        return true;
    }
    /** Whether a setup command is running or finished for one workspace. */
    async workspaceSetupStatus(workspaceId) {
        if (!this.setupJobs.has(workspaceId))
            return null;
        const workspace = await this.workspaceFor(workspaceId);
        if (workspace === undefined)
            return null;
        return {
            status: 'completed',
            detail: {
                type: 'worktree_setup',
                worktreePath: workspace.directory,
                branchName: workspace.checkout.isGit ? '' : '',
                log: '',
                commands: [],
            },
            error: null,
        };
    }
    /** Slash commands the live agent sees, which is what a client offers. */
    async listCommands(agentId) {
        const commands = this.ctx.get('commands');
        if (commands === undefined)
            return [];
        const agents = this.ctx.get('agents');
        const agent = agents?.get(agentId);
        if (agent === undefined)
            return [];
        try {
            return commands.list(agent).map((command) => ({
                name: command.name,
                description: command.description,
                argumentHint: command.input?.hint ?? '',
            }));
        }
        catch {
            // A command view that cannot resolve for this agent offers nothing,
            // which is the same answer as no commands at all.
            return [];
        }
    }
    /** Rename one session, which is the agent's title. */
    async renameAgent(agentId, title) {
        const controller = this.requireController();
        if (controller.rename === undefined)
            throw new Error('this harness cannot rename a session');
        await controller.rename({ sessionId: agentId, title });
        this.titles.set(agentId, title);
    }
    /** Archive one session, which removes it from the active agent list. */
    async archiveAgent(agentId) {
        const registry = this.ctx.get('workspaceRegistry');
        if (registry?.archiveSession === undefined)
            throw new Error('the workspace registry cannot archive sessions');
        await registry.archiveSession(agentId);
        return new Date().toISOString();
    }
    /** Session ids the operator archived. */
    archivedSessionIds() {
        const registry = this.ctx.get('workspaceRegistry');
        return new Set(registry?.archivedSessionIds ?? []);
    }
    async getAgent(id) {
        const summary = (await this.summaries()).find((item) => item.sessionId === id);
        if (summary === undefined)
            return null;
        const workspace = summary.cwd === undefined ? undefined : this.workspaceForCwd(summary.cwd);
        return this.agentRecord(summary, workspace);
    }
    async getTimeline(agentId, options) {
        const limit = options?.limit;
        const session = this.session(agentId);
        // A cold Session has no attached log, so its transcript comes from the
        // durable history page instead. Sending it a prompt resumes it.
        const entries = session === undefined
            ? await this.coldTimeline(agentId)
            : foldEvents(session.snapshotEvents(0, session.seq));
        return limit === undefined || entries.length <= limit ? entries : entries.slice(entries.length - limit);
    }
    /** Read one page of a cold Session's log and fold it into timeline rows. */
    async coldTimeline(agentId) {
        const controller = this.ctx.get('sessionController');
        if (controller?.page === undefined || controller.projections === undefined)
            return [];
        const signal = new AbortController().signal;
        try {
            // A page needs an inclusive log cut, and only the projection watermark
            // carries one for a Session nothing is attached to.
            const projections = await controller.projections({ sessionId: agentId }, signal);
            if (projections?.kind !== 'sequenced' || typeof projections.asOfSeq !== 'number')
                return [];
            const page = await controller.page({
                address: { kind: 'session', sessionId: agentId },
                throughSeq: projections.asOfSeq,
                maxMessages: COLD_TIMELINE_PAGE_MESSAGES,
            }, signal);
            return foldEvents(page.records.map((record) => record.event));
        }
        catch (error) {
            this.ctx.logger.warn(`paseo: cold timeline for ${agentId} failed: ${String(error)}`);
            return [];
        }
    }
    async sendPrompt(agentId, prompt) {
        const controller = this.requireController();
        if (prompt.clientMessageId !== undefined) {
            this.pendingClientMessageIds.push({ agentId, clientMessageId: prompt.clientMessageId });
        }
        await controller.prompt({
            requestId: randomUUID(),
            sessionId: agentId,
            mode: 'queue',
            content: promptParts(prompt),
        }, new AbortController().signal);
        this.titles.set(agentId, titleFrom(prompt.text) ?? this.titles.get(agentId) ?? null);
    }
    /**
     * Take the client-minted identity of the submission whose message event is
     * being folded, oldest first.
     *
     * A client renders its own prompt immediately, so echoing the row back
     * without the identity it minted makes it appear twice. The queue is FIFO
     * because a session admits prompts in arrival order.
     */
    claimClientMessageId(agentId) {
        const index = this.pendingClientMessageIds.findIndex((entry) => entry.agentId === agentId);
        if (index < 0)
            return undefined;
        return this.pendingClientMessageIds.splice(index, 1)[0]?.clientMessageId;
    }
    async createAgent(input) {
        const controller = this.requireController();
        const directory = await this.directoryFor(input);
        const created = await controller.create({ cwd: directory });
        if (input.provider !== undefined && input.model !== undefined && controller.selectModel !== undefined) {
            await controller.selectModel({ sessionId: created.sessionId, provider: input.provider, model: input.model });
        }
        if (input.title !== undefined && controller.rename !== undefined) {
            await controller.rename({ sessionId: created.sessionId, title: input.title });
        }
        if (input.title !== undefined)
            this.titles.set(created.sessionId, input.title);
        if (input.prompt !== undefined && input.prompt.length > 0)
            await this.sendPrompt(created.sessionId, { text: input.prompt, ...(input.images === undefined ? {} : { images: input.images }) });
        const agent = await this.getAgent(created.sessionId);
        if (agent === null)
            throw new Error(`created session ${created.sessionId} has no live agent`);
        return agent;
    }
    /** Resolve the directory a new agent runs in. */
    async directoryFor(input) {
        if (input.workspaceId !== undefined) {
            const workspace = await this.workspaceFor(input.workspaceId);
            if (workspace === undefined)
                throw new Error(`unknown workspace ${input.workspaceId}`);
            return workspace.directory;
        }
        if (input.directory !== undefined && input.directory.length > 0)
            return input.directory;
        throw new Error('agent creation needs a workspace or a directory');
    }
    async cancelAgent(agentId) {
        // Stopping a cold session is a no-op, not a failure: it has no turn to
        // interrupt, and the client shows the same stopped state either way.
        try {
            await this.requireController().cancel({ sessionId: agentId });
        }
        catch (error) {
            if (this.session(agentId) !== undefined)
                throw error;
            this.ctx.logger.debug(`paseo: cancel on cold session ${agentId} ignored: ${String(error)}`);
        }
    }
    /** Terminals retained by the sessions this daemon shows as agents. */
    async listTerminals() {
        const controller = this.ctx.get('terminalController');
        if (controller === undefined)
            return [];
        const records = [];
        for (const summary of await this.summaries()) {
            for (const info of controller.list(summary.sessionId)) {
                const record = this.terminalRecord(summary.sessionId, summary.cwd, info);
                this.terminalOwners.set(record.id, { sessionId: summary.sessionId, attachmentId: info.controllerId });
                records.push(record);
            }
        }
        return records;
    }
    /** Allocate one terminal, owned by a live agent in the requested workspace. */
    async createTerminal(input) {
        const controller = this.requireTerminalController();
        const workspace = await this.workspaceFor(input.workspaceId);
        if (workspace === undefined)
            throw new Error(`unknown workspace ${input.workspaceId}`);
        const sessionId = await this.liveSessionIn(workspace.directory);
        if (sessionId === null)
            throw new Error(`no live agent in ${workspace.directory} can own a terminal`);
        const terminalId = `term_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const info = await controller.create(this.requireAgent(sessionId), {
            id: terminalId,
            cols: input.cols ?? DEFAULT_TERMINAL_COLS,
            rows: input.rows ?? DEFAULT_TERMINAL_ROWS,
        }, new AbortController().signal);
        const record = this.terminalRecord(sessionId, workspace.directory, info);
        this.terminalOwners.set(record.id, { sessionId, attachmentId: info.controllerId });
        if (input.name !== undefined && input.name.length > 0) {
            try {
                controller.rename(this.requireAgent(sessionId), record.id, input.name);
            }
            catch (error) {
                this.ctx.logger.warn(`paseo: naming terminal ${record.id} failed: ${String(error)}`);
            }
        }
        return record;
    }
    /** Attach to one terminal and pump its frames to the listener. */
    async followTerminal(terminalId, listener) {
        const controller = this.requireTerminalController();
        const owner = this.terminalOwners.get(terminalId);
        if (owner === undefined)
            throw new Error(`unknown terminal ${terminalId}`);
        const agent = this.requireAgent(owner.sessionId);
        const attachmentId = `att_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const abort = new AbortController();
        this.terminalOwners.set(terminalId, { sessionId: owner.sessionId, attachmentId });
        const pump = async () => {
            try {
                for await (const frame of controller.follow(agent, terminalId, attachmentId, abort.signal)) {
                    if (abort.signal.aborted)
                        return;
                    listener(this.terminalEvent(owner.sessionId, frame));
                }
            }
            catch (error) {
                if (!abort.signal.aborted)
                    this.ctx.logger.debug(`paseo: terminal ${terminalId} stream ended: ${String(error)}`);
            }
        };
        void pump();
        return () => { abort.abort(); };
    }
    async writeTerminal(terminalId, data) {
        const { agent, attachmentId } = this.requireTerminalOwner(terminalId);
        await this.requireTerminalController().write(agent, terminalId, attachmentId, data);
    }
    async resizeTerminal(terminalId, cols, rows) {
        const { agent, attachmentId } = this.requireTerminalOwner(terminalId);
        await this.requireTerminalController().resize(agent, terminalId, attachmentId, cols, rows);
    }
    async renameTerminal(terminalId, title) {
        const { agent } = this.requireTerminalOwner(terminalId);
        this.requireTerminalController().rename(agent, terminalId, title);
    }
    async closeTerminal(terminalId) {
        const { agent } = this.requireTerminalOwner(terminalId);
        await this.requireTerminalController().close(agent, terminalId);
        this.terminalOwners.delete(terminalId);
    }
    /** Every reminder this runtime holds, across Sessions, plus the paused ones. */
    async listSchedules() {
        const records = [];
        const service = this.ctx.get('schedule');
        const paused = await this.pausedList();
        const pausedDshIds = new Set(paused.flatMap((entry) => entry.dshId === undefined ? [] : [entry.dshId]));
        if (service !== undefined) {
            for (const summary of await this.summaries()) {
                for (const view of await service.list({ sessionId: summary.sessionId })) {
                    if (pausedDshIds.has(view.id))
                        continue;
                    records.push(this.recordFor(summary.sessionId, view));
                }
            }
        }
        for (const entry of paused) {
            records.push({
                id: entry.id,
                agentId: entry.sessionId,
                name: entry.title.length > 0 ? entry.title : null,
                prompt: entry.prompt,
                cadence: toPaseoCadence({ kind: 'cron', expression: '0 0 * * *' }),
                status: 'inactive',
                createdAt: entry.pausedAt,
                nextRunAt: null,
                pausedAt: entry.pausedAt,
                expiresAt: null,
                maxRuns: null,
                ...(isCadence(entry.cadence) ? { cadence: entry.cadence } : {}),
            });
        }
        return records;
    }
    /** Create one reminder owned by the target agent's Session. */
    async createSchedule(input) {
        const service = this.requireScheduleService();
        const timing = fromPaseoCadence(input.cadence);
        if ('error' in timing)
            throw new Error(timing.error);
        const created = await service.create(input.agentId, {
            prompt: input.prompt,
            title: input.name !== undefined && input.name.trim().length > 0 ? input.name : defaultScheduleTitle(input.prompt),
            ...timing,
        }, new AbortController().signal);
        const view = scheduleViewOf(created);
        if (view === null)
            throw new Error(scheduleErrorOf(created) ?? 'the reminder was not created');
        const record = this.recordFor(input.agentId, view);
        this.scheduleOwners.set(record.id, input.agentId);
        return record;
    }
    /** Remove one reminder from the Session that owns it. */
    async deleteSchedule(scheduleId) {
        const paused = await this.pausedList();
        const entry = paused.find((candidate) => candidate.id === scheduleId);
        if (entry !== undefined) {
            await this.savePaused(paused.filter((candidate) => candidate.id !== scheduleId));
            return true;
        }
        const service = this.requireScheduleService();
        const sessionId = await this.scheduleOwner(scheduleId);
        if (sessionId === null)
            return false;
        const dshId = this.dshIdOf(scheduleId);
        const result = await service.delete({ sessionId, id: dshId }, new AbortController().signal);
        const removed = result !== null && typeof result === 'object' && result.deleted !== false;
        if (removed)
            this.scheduleOwners.delete(scheduleId);
        return removed;
    }
    /**
     * Pause one reminder.
     *
     * DSH cannot pause a reminder, so this removes it from the runtime and keeps
     * the definition, which is the only way the reminder stops firing while
     * staying resumable.
     */
    async pauseSchedule(scheduleId) {
        const service = this.requireScheduleService();
        const sessionId = await this.scheduleOwner(scheduleId);
        if (sessionId === null)
            return false;
        const dshId = this.dshIdOf(scheduleId);
        const view = (await service.list({ sessionId })).find((entry) => entry.id === dshId);
        if (view === undefined)
            return false;
        const paused = await this.pausedList();
        if (paused.some((entry) => entry.id === scheduleId))
            return true;
        const cadence = this.cadenceOf(sessionId, view);
        await service.delete({ sessionId, id: dshId }, new AbortController().signal);
        await this.savePaused([
            ...paused,
            {
                id: scheduleId,
                sessionId,
                title: view.title,
                prompt: view.prompt,
                cadence,
                pausedAt: new Date().toISOString(),
            },
        ]);
        return true;
    }
    /** Resume one paused reminder, which recreates it in the runtime. */
    async resumeSchedule(scheduleId) {
        const paused = await this.pausedList();
        const entry = paused.find((candidate) => candidate.id === scheduleId);
        if (entry === undefined)
            throw new Error(`reminder ${scheduleId} is not paused`);
        const service = this.requireScheduleService();
        const timing = fromPaseoCadence(entry.cadence);
        if ('error' in timing)
            throw new Error(timing.error);
        const created = await service.create(entry.sessionId, {
            prompt: entry.prompt,
            title: entry.title,
            ...timing,
        }, new AbortController().signal);
        const view = scheduleViewOf(created);
        if (view === null)
            throw new Error(scheduleErrorOf(created) ?? 'the reminder was not resumed');
        await this.savePaused([
            ...paused.filter((candidate) => candidate.id !== scheduleId),
            { ...entry, dshId: view.id },
        ]);
        this.scheduleOwners.set(scheduleId, entry.sessionId);
        return this.recordFor(entry.sessionId, view, scheduleId);
    }
    /** Deliver one reminder's prompt now, through the ordinary prompt path. */
    async runScheduleNow(scheduleId) {
        const sessionId = await this.scheduleOwner(scheduleId);
        if (sessionId === null)
            throw new Error(`unknown reminder ${scheduleId}`);
        const service = this.requireScheduleService();
        const view = (await service.list({ sessionId })).find((entry) => entry.id === this.dshIdOf(scheduleId));
        if (view === undefined)
            throw new Error(`unknown reminder ${scheduleId}`);
        await this.sendPrompt(sessionId, { text: view.prompt });
    }
    /**
     * When this daemon first saw a reminder.
     *
     * DSH records no creation instant, so the closest fact available is when the
     * daemon learned of the reminder, which for anything created here is its
     * creation moment.
     */
    firstSeenAt(scheduleId) {
        const known = this.scheduleSeenAt.get(scheduleId);
        if (known !== undefined)
            return known;
        const now = new Date().toISOString();
        this.scheduleSeenAt.set(scheduleId, now);
        return now;
    }
    /** Project one runtime reminder, reusing the client identity it already had. */
    recordFor(sessionId, view, id) {
        const paseoId = id ?? this.paseoIdOf(view.id) ?? view.id;
        const record = scheduleRecord(sessionId, view, this.firstSeenAt(paseoId), paseoId);
        this.scheduleOwners.set(record.id, sessionId);
        this.scheduleDshIds.set(record.id, view.id);
        return record;
    }
    /** Cadence one live reminder carries, for keeping it through a pause. */
    cadenceOf(sessionId, view) {
        const record = scheduleRecord(sessionId, view, this.firstSeenAt(view.id), view.id);
        return record.cadence;
    }
    /** Runtime identity behind a client identity. */
    dshIdOf(paseoId) {
        return this.scheduleDshIds.get(paseoId) ?? paseoId;
    }
    /** Client identity already given to one runtime reminder, if any. */
    paseoIdOf(dshId) {
        for (const [paseoId, known] of this.scheduleDshIds) {
            if (known === dshId)
                return paseoId;
        }
        return this.scheduleDshIds.get(dshId) === undefined && this.scheduleOwners.has(dshId) ? dshId : undefined;
    }
    /** Paused reminders, read once and then kept in memory. */
    async pausedList() {
        if (this.pausedLoaded)
            return this.pausedReminders;
        this.pausedLoaded = true;
        const home = this.homePath();
        if (home === undefined)
            return this.pausedReminders;
        this.pausedReminders = await loadPausedReminders(home);
        for (const entry of this.pausedReminders) {
            if (entry.dshId !== undefined)
                this.scheduleDshIds.set(entry.id, entry.dshId);
        }
        return this.pausedReminders;
    }
    async savePaused(paused) {
        this.pausedReminders = [...paused];
        const home = this.homePath();
        if (home === undefined)
            return;
        await savePausedReminders(home, this.pausedReminders);
    }
    /** Harness home path builder, absent on a host that did not provide one. */
    homePath() {
        const value = this.ctx.get('dshHomePath');
        return typeof value === 'function' ? value : undefined;
    }
    /** Session that owns one reminder, resolved from the cache or by listing. */
    async scheduleOwner(scheduleId) {
        const cached = this.scheduleOwners.get(scheduleId);
        if (cached !== undefined)
            return cached;
        await this.listSchedules();
        return this.scheduleOwners.get(scheduleId) ?? null;
    }
    requireScheduleService() {
        const service = this.ctx.get('schedule');
        if (service === undefined)
            throw new Error('the schedule service is not mounted');
        return service;
    }
    async listWorkspaceScripts(workspaceId) {
        const workspace = await this.workspaceFor(workspaceId);
        if (workspace === undefined)
            throw new Error(`unknown workspace ${workspaceId}`);
        const definitions = await readWorkspaceScripts(workspace.directory);
        return definitions.map((definition) => this.scriptRecord(workspaceId, definition));
    }
    /** Start one declared script as a background job. */
    async startWorkspaceScript(workspaceId, name) {
        const workspace = await this.workspaceFor(workspaceId);
        if (workspace === undefined)
            throw new Error(`unknown workspace ${workspaceId}`);
        const definition = (await readWorkspaceScripts(workspace.directory)).find((entry) => entry.name === name);
        if (definition === undefined)
            throw new Error(`workspace declares no script named ${name}`);
        const key = scriptKey(workspaceId, name);
        if (this.scriptJobs.get(key) !== undefined)
            return this.scriptRecord(workspaceId, definition);
        const jobs = this.requireJobs();
        const jobId = jobs.start({
            kind: 'paseo-script',
            label: `${name}: ${definition.command}`,
            run: (job) => {
                // The command is the workspace's own declaration, run through a shell
                // for the same reason Paseo runs it that way: a declared script is a
                // command line, not an argv array. The spawn sits inside the starter so
                // a refused registration cannot leave an orphan process behind.
                const child = spawn(definition.command, { cwd: workspace.directory, shell: true, env: process.env });
                return {
                    cancel: () => { child.kill('SIGTERM'); },
                    done: new Promise((resolve) => {
                        const forward = (chunk) => { job.append(chunk.toString('utf8')); };
                        child.stdout?.on('data', forward);
                        child.stderr?.on('data', forward);
                        child.on('error', (error) => { resolve({ ok: false, detail: error.message }); });
                        child.on('close', (code, signal) => {
                            resolve({ ok: code === 0, detail: signal === null ? `exit code: ${String(code)}` : `signal: ${signal}` });
                        });
                    }),
                };
            },
        });
        this.scriptJobs.set(key, jobId);
        return this.scriptRecord(workspaceId, definition);
    }
    /** Stop one running script. */
    async stopWorkspaceScript(workspaceId, name) {
        const workspace = await this.workspaceFor(workspaceId);
        if (workspace === undefined)
            throw new Error(`unknown workspace ${workspaceId}`);
        const key = scriptKey(workspaceId, name);
        const jobId = this.scriptJobs.get(key);
        if (jobId !== undefined) {
            this.requireJobs().kill(jobId, undefined, 'stopped from Paseo');
            this.scriptJobs.delete(key);
        }
        const definition = (await readWorkspaceScripts(workspace.directory)).find((entry) => entry.name === name);
        if (definition === undefined)
            throw new Error(`workspace declares no script named ${name}`);
        return this.scriptRecord(workspaceId, definition);
    }
    /** Project one declaration plus its job, when it has one. */
    scriptRecord(workspaceId, definition) {
        const jobId = this.scriptJobs.get(scriptKey(workspaceId, definition.name));
        const job = jobId === undefined ? undefined : this.jobsView(jobId);
        return {
            name: definition.name,
            workspaceId,
            type: definition.type,
            command: definition.command,
            port: definition.port,
            lifecycle: job?.status === 'running' || job?.status === 'stopping' ? 'running' : 'stopped',
            health: null,
            exitCode: job === undefined ? null : exitCodeOf(job.detail),
        };
    }
    jobsView(jobId) {
        const jobs = this.ctx.get('jobs');
        if (jobs === undefined)
            return undefined;
        try {
            return jobs.get(jobId);
        }
        catch {
            return undefined;
        }
    }
    requireJobs() {
        const jobs = this.ctx.get('jobs');
        if (jobs === undefined)
            throw new Error('the jobs service is not mounted');
        return jobs;
    }
    requireTerminalController() {
        const controller = this.ctx.get('terminalController');
        if (controller === undefined)
            throw new Error('the terminalController service is not mounted');
        return controller;
    }
    /** The opaque Agent that owns a terminal, plus the attachment it is writable through. */
    requireTerminalOwner(terminalId) {
        const owner = this.terminalOwners.get(terminalId);
        if (owner === undefined)
            throw new Error(`unknown terminal ${terminalId}`);
        return { agent: this.requireAgent(owner.sessionId), attachmentId: owner.attachmentId ?? '' };
    }
    /** The live Agent for one session, which every terminal call must name as owner. */
    requireAgent(sessionId) {
        const agents = this.ctx.get('agents');
        const agent = agents?.get(sessionId);
        if (agent === undefined)
            throw new Error(`session ${sessionId} has no live agent`);
        return agent;
    }
    /** Most recently active live session whose working directory is this one. */
    async liveSessionIn(directory) {
        const summaries = await this.summaries();
        const live = summaries.filter((summary) => summary.agentAvailable && summary.cwd === directory);
        if (live.length === 0)
            return null;
        return live.reduce((newest, candidate) => candidate.updatedAt > newest.updatedAt ? candidate : newest).sessionId;
    }
    terminalRecord(sessionId, cwd, info) {
        const directory = info.cwd.length > 0 ? info.cwd : cwd ?? '';
        return {
            id: info.id,
            sessionId,
            workspaceId: this.workspaceForCwd(directory).id,
            title: info.title,
            cwd: directory,
            cols: info.cols,
            rows: info.rows,
            state: info.state,
            exitCode: info.exitCode,
        };
    }
    terminalEvent(sessionId, frame) {
        if (frame.type === 'snapshot')
            return { type: 'snapshot', screen: frame.screen };
        if (frame.type === 'output')
            return { type: 'output', data: frame.data };
        return { type: 'state', record: this.terminalRecord(sessionId, frame.info.cwd, frame.info) };
    }
    async createWorkspace(input) {
        const registry = this.ctx.get('workspaceRegistry');
        if (registry === undefined)
            throw new Error('the workspaceRegistry service is not mounted');
        const workspace = await registry.create(input.directory, input.name);
        const record = this.workspaceRecord(workspace, workspace.path, workspace.title, workspace.createdAt, workspace.updatedAt, []);
        this.workspaceCache.set(record.id, record);
        return record;
    }
    async archiveWorkspace(workspaceId) {
        const record = await this.workspaceFor(workspaceId);
        if (record === undefined)
            throw new Error(`unknown workspace ${workspaceId}`);
        const registry = this.ctx.get('workspaceRegistry');
        if (registry === undefined)
            throw new Error('the workspaceRegistry service is not mounted');
        await registry.delete(workspaceId);
        this.workspaceCache.delete(workspaceId);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        this.start();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0)
                this.stop();
        };
    }
    /** Attach host listeners once, while at least one client is subscribed. */
    start() {
        if (this.started)
            return;
        this.started = true;
        this.disposers.push(this.ctx.on('session/event', ((session, event) => {
            this.onSessionEvent(session, event);
        })));
        this.disposers.push(this.ctx.on('api-session/added', ((summary) => {
            void this.publishAgent(summary.sessionId);
        })));
        this.disposers.push(this.ctx.on('api-session/removed', ((sessionId) => {
            this.emit({ kind: 'agent_remove', agentId: sessionId });
        })));
        this.disposers.push(this.ctx.on('api-session/status', ((sessionId, running) => {
            if (running)
                this.failed.delete(sessionId);
            void this.publishAgent(sessionId);
        })));
    }
    stop() {
        this.started = false;
        for (const dispose of this.disposers.splice(0))
            dispose();
    }
    onSessionEvent(session, event) {
        if (event.type === 'turn/end') {
            const reason = stringField(event.data, 'reason');
            if (reason === 'error' || reason === 'failure')
                this.failed.add(session.id);
            else if (reason !== undefined)
                this.failed.delete(session.id);
            void this.publishAgent(session.id);
        }
        const clientMessageId = event.type === 'user/message' ? this.claimClientMessageId(session.id) : undefined;
        for (const entry of foldEvent(event, clientMessageId)) {
            this.emit({ kind: 'timeline', agentId: session.id, entry });
        }
    }
    async publishAgent(sessionId) {
        const agent = await this.getAgent(sessionId);
        if (agent === null)
            return;
        this.emit({ kind: 'agent_upsert', agent });
    }
    emit(event) {
        for (const listener of this.listeners) {
            try {
                listener(event);
            }
            catch (error) {
                this.ctx.logger.warn(`paseo: bridge listener failed: ${String(error)}`);
            }
        }
    }
    requireController() {
        const controller = this.ctx.get('sessionController');
        if (controller === undefined)
            throw new Error('the sessionController service is not mounted');
        return controller;
    }
    async summaries() {
        const controller = this.ctx.get('sessionController');
        if (controller !== undefined) {
            const value = await controller.list({}, new AbortController().signal);
            return value.items;
        }
        const sessions = this.ctx.get('sessions');
        const agents = this.ctx.get('agents');
        if (sessions === undefined)
            return [];
        const live = new Set(agents?.list().map((agent) => agent.id) ?? []);
        return sessions.list().map((session) => ({
            sessionId: session.id,
            cwd: session.header.cwd,
            running: false,
            agentAvailable: live.has(session.id),
            blank: false,
            updatedAt: Date.now(),
        }));
    }
    session(id) {
        return this.ctx.get('sessions')?.get(id);
    }
    agentRecord(summary, workspace) {
        const session = this.session(summary.sessionId);
        const header = session?.requestHeader?.();
        const directory = summary.cwd ?? workspace?.directory ?? session?.header.cwd ?? '';
        const status = this.failed.has(summary.sessionId)
            ? 'error'
            : summary.running
                ? 'running'
                : 'idle';
        const updatedAt = new Date(summary.updatedAt).toISOString();
        return {
            id: summary.sessionId,
            shortId: summary.sessionId.slice(-8),
            title: this.titles.get(summary.sessionId) ?? this.titleOf(session) ?? projectedTitle(summary),
            provider: header?.config?.provider ?? projectedSelection(summary)?.provider ?? this.defaultProvider,
            model: header?.config?.model ?? projectedSelection(summary)?.model ?? this.defaultModel,
            status,
            ...(summary.parentSessionId === undefined ? {} : { parentAgentId: summary.parentSessionId }),
            cwd: directory,
            workspaceId: workspace?.id ?? this.workspaceForCwd(directory).id,
            createdAt: updatedAt,
            updatedAt,
            lastUserMessageAt: updatedAt,
            archivedAt: null,
            activeTurn: null,
        };
    }
    /** First human prompt, used as the agent title when DSH has no title. */
    titleOf(session) {
        if (session === undefined)
            return null;
        const cached = this.titles.get(session.id);
        if (cached !== undefined)
            return cached;
        let title = null;
        for (const event of session.snapshotEvents(0, session.seq)) {
            if (event.type !== 'user/message')
                continue;
            if (messageSourceKind(event.data) !== 'user')
                continue;
            title = titleFrom(messageText(event.data)) ?? null;
            break;
        }
        this.titles.set(session.id, title);
        return title;
    }
    /** Directories are workspaces even when the registry never recorded them. */
    workspaceForCwd(cwd) {
        const id = `ws_${digest(cwd)}`;
        const cached = this.workspaceCache.get(id);
        if (cached !== undefined)
            return cached;
        const now = new Date().toISOString();
        const record = this.workspaceRecord({ id, path: cwd, title: basenameOf(cwd), createdAt: now, updatedAt: now, sessionIds: [] }, cwd, basenameOf(cwd), now, now, []);
        this.workspaceCache.set(id, record);
        return record;
    }
    async workspaceFor(workspaceId) {
        const cached = this.workspaceCache.get(workspaceId);
        if (cached !== undefined)
            return cached;
        await this.listWorkspaces();
        return this.workspaceCache.get(workspaceId);
    }
    workspaceRecord(workspace, directory, name, createdAt, updatedAt, agentStatuses) {
        const projectRootPath = directory;
        return {
            id: workspace.id,
            projectId: `prj_${digest(projectRootPath)}`,
            projectKey: projectRootPath,
            projectName: basenameOf(projectRootPath),
            projectRootPath,
            projectKind: 'directory',
            name,
            directory,
            status: workspaceStatus(agentStatuses),
            statusEnteredAt: updatedAt,
            activityAt: updatedAt,
            createdAt,
            updatedAt,
            checkout: { repoRoot: projectRootPath, isGit: false },
        };
    }
}
/** Fold a whole log into timeline rows. */
export function foldEvents(events) {
    const entries = [];
    for (const event of events)
        entries.push(...foldEvent(event));
    return entries;
}
/**
 * Fold one durable session event into zero or more timeline rows.
 *
 * A tool call is emitted once, when its result arrives, so the timeline shows
 * no duplicate running and completed rows. A live running indicator needs the
 * Paseo timeline-replacement surface, which this daemon does not advertise.
 * @param event - committed session event.
 * @param clientMessageId - identity the client minted for this submission, when it made it.
 * @returns the rows this event contributes.
 */
export function foldEvent(event, clientMessageId) {
    const timestamp = new Date(event.time).toISOString();
    switch (event.type) {
        case 'user/message': {
            if (messageSourceKind(event.data) !== 'user')
                return [];
            const text = messageText(event.data);
            if (text === undefined || text.length === 0)
                return [];
            const messageId = stringField(event.data, 'id');
            return [{
                    item: {
                        type: 'user_message',
                        text,
                        ...(messageId === undefined ? {} : { messageId }),
                        ...(clientMessageId === undefined ? {} : { clientMessageId }),
                    },
                    timestamp,
                    seq: event.seq,
                }];
        }
        case 'assistant/message': {
            const message = recordField(event.data, 'message');
            if (message === undefined)
                return [];
            const text = messageText(message);
            const messageId = stringField(message, 'id');
            const rows = [];
            const reasoning = messageReasoning(message);
            if (reasoning !== undefined && reasoning.length > 0)
                rows.push({ item: { type: 'reasoning', text: reasoning }, timestamp, seq: event.seq });
            if (text !== undefined && text.length > 0) {
                rows.push({
                    item: { type: 'assistant_message', text, ...(messageId === undefined ? {} : { messageId }) },
                    timestamp,
                    seq: event.seq,
                });
            }
            return rows;
        }
        case 'tool/call':
            // Held until the matching result arrives; see the function contract.
            return [];
        case 'tool/result':
            return [toolResultEntry(event, timestamp)];
        default:
            return [];
    }
}
function toolResultEntry(event, timestamp) {
    const message = recordField(event.data, 'message');
    const callId = message === undefined ? undefined : stringField(message, 'toolCallId');
    const error = recordField(event.data, 'error');
    const isError = message !== undefined && message['isError'] === true;
    const item = {
        type: 'tool_call',
        callId: callId ?? `call_${event.seq}`,
        name: stringField(event.data, 'name') ?? 'tool',
        status: isError ? 'failed' : 'completed',
        input: null,
        output: messageText(message ?? {}) ?? null,
        ...(error === undefined ? {} : { error: stringField(error, 'reason') ?? stringField(error, 'name') ?? 'tool failed' }),
    };
    return { item, timestamp, seq: event.seq };
}
/** Concatenate the text blocks of one message. */
export function messageText(message) {
    const content = message['content'];
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return undefined;
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object')
            continue;
        const record = block;
        if (record.type !== 'text')
            continue;
        if (typeof record.text === 'string')
            parts.push(record.text);
    }
    return parts.length === 0 ? undefined : parts.join('\n');
}
/** Concatenate the reasoning blocks of one assistant message. */
export function messageReasoning(message) {
    const content = message['content'];
    if (!Array.isArray(content))
        return undefined;
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object')
            continue;
        const record = block;
        if (record.type !== 'reasoning')
            continue;
        if (typeof record.text === 'string')
            parts.push(record.text);
    }
    return parts.length === 0 ? undefined : parts.join('\n');
}
/** `source.kind` of one message, when it carries a source. */
function messageSourceKind(message) {
    const source = recordField(message, 'source');
    return source === undefined ? undefined : stringField(source, 'kind');
}
function recordField(record, key) {
    const value = record[key];
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function stringField(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}
/** Workspace status bucket from the statuses of its agents, most severe first. */
export function workspaceStatus(statuses) {
    if (statuses.includes('initializing') || statuses.includes('running'))
        return 'running';
    if (statuses.includes('error'))
        return 'failed';
    return 'done';
}
/**
 * Model selection a cold listing already carries.
 *
 * The session controller projects the durable selection and the list service
 * ships that projection as a hint, so a session with nothing attached still
 * reports the provider and model it last ran.
 */
function projectedSelection(summary) {
    const value = summary.projections?.values?.['modelSelection'];
    if (value === null || typeof value !== 'object')
        return undefined;
    const projection = value;
    const selection = projection.next ?? projection.lastUsed;
    if (selection === null || typeof selection !== 'object')
        return undefined;
    return selection;
}
/**
 * Title a cold listing already carries.
 *
 * The session-title plugin projects the current title, and the list service
 * ships that projection as a hint for exactly this case: a Session with no
 * attached log still has a name.
 */
function projectedTitle(summary) {
    const title = summary.projections?.values?.['title'];
    return typeof title === 'string' && title.length > 0 ? title : null;
}
/**
 * Turn one submitted prompt into session content parts.
 *
 * The text part is omitted when a client sent only images, and an image whose
 * media type the attachment seam does not accept is dropped rather than
 * failing the whole prompt.
 * @param prompt - submitted prompt.
 * @returns the content parts to admit.
 */
export function promptParts(prompt) {
    const parts = [];
    if (prompt.text.trim().length > 0)
        parts.push({ type: 'text', text: prompt.text });
    for (const image of prompt.images ?? []) {
        if (!isImageMediaType(image.mimeType))
            continue;
        parts.push({ type: 'image', mediaType: image.mimeType, data: image.data });
    }
    return parts;
}
/** Whether the attachment seam accepts this media type. */
export function isImageMediaType(value) {
    return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif';
}
function titleFrom(text) {
    if (text === undefined)
        return undefined;
    const line = text.trim().split('\n', 1)[0]?.trim() ?? '';
    if (line.length === 0)
        return undefined;
    return line.length <= TITLE_MAX_CHARS ? line : `${line.slice(0, TITLE_MAX_CHARS - 1)}…`;
}
function basenameOf(path) {
    const trimmed = path.replace(/[\\/]+$/, '');
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return index < 0 ? trimmed : trimmed.slice(index + 1);
}
function digest(input) {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
/** Key one running script by workspace and name. */
function scriptKey(workspaceId, name) {
    return `${workspaceId}\u0000${name}`;
}
/** Exit code git-style detail carries, when it names one. */
function exitCodeOf(detail) {
    const match = detail?.match(/exit code: (\d+)/);
    return match === null || match === undefined ? null : Number(match[1]);
}
/** Title a reminder gets when the client named none. */
function defaultScheduleTitle(prompt) {
    const line = prompt.trim().split('\n')[0] ?? '';
    return line.length <= 120 ? line : line.slice(0, 120);
}
/** Reminder view inside a create result, or null when the result is an error. */
function scheduleViewOf(value) {
    if (value === null || typeof value !== 'object')
        return null;
    const record = value;
    return typeof record.id === 'string' && typeof record.kind === 'string' ? record : null;
}
/** Error text a failed reminder creation carries, when it carries one. */
function scheduleErrorOf(value) {
    if (value === null || typeof value !== 'object')
        return null;
    const message = value.message;
    return typeof message === 'string' ? message : null;
}
/**
 * Project one reminder into the client shape.
 *
 * A one-shot reminder projects onto the cron rule of its own instant, carries
 * `maxRuns: 1`, and expires at that instant, which is what keeps a client from
 * reading it as a recurrence that fires every year.
 */
function scheduleRecord(agentId, view, firstSeen, id) {
    const oneShot = view.kind === 'at' || view.kind === 'after';
    const cadence = toPaseoCadence({
        kind: view.kind,
        ...(view.everySeconds === undefined ? {} : { everySeconds: view.everySeconds }),
        ...(view.expression === undefined ? {} : { expression: view.expression }),
        ...(view.timeZone === undefined ? {} : { timeZone: view.timeZone }),
        ...(view.time === undefined ? {} : { dailyTime: view.time }),
        ...(view.weekdays === undefined ? {} : { weekdays: view.weekdays }),
        ...(view.scheduledAt === undefined ? {} : { scheduledAt: view.scheduledAt }),
    });
    const status = view.status === 'inactive' ? 'inactive' : 'active';
    return {
        id: id ?? view.id,
        agentId,
        name: view.title.length > 0 ? view.title : null,
        prompt: view.prompt,
        // A rule with no clock shape at all still lists: the client shows an
        // hourly cadence rather than losing the reminder entirely.
        cadence: cadence ?? { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
        // A record read back from storage carries no status; only an explicit
        // inactive marker means the reminder stopped.
        status,
        createdAt: firstSeen,
        nextRunAt: status === 'inactive' ? null : view.scheduledAt ?? null,
        pausedAt: null,
        expiresAt: oneShot ? view.scheduledAt ?? null : null,
        maxRuns: oneShot ? 1 : null,
    };
}
/** Whether a stored cadence still has the shape a client sent. */
function isCadence(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const cadence = value;
    if (cadence.type === 'every')
        return typeof cadence.everyMs === 'number';
    return cadence.type === 'cron' && typeof cadence.expression === 'string';
}
/** One timeline row as a plain line of text, or null for a row with nothing to say. */
function renderTimelineLine(item) {
    if (item.type === 'user_message')
        return `User: ${item.text}`;
    if (item.type === 'assistant_message')
        return `Assistant: ${item.text}`;
    if (item.type === 'reasoning')
        return `Reasoning: ${item.text}`;
    if (item.type === 'tool_call')
        return `Tool ${item.name} (${item.status})`;
    return null;
}
