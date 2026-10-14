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
import { forgeToken, lookupPullRequest, parseGithubRemote } from './forge.js';
import { commitCheckout, pullCheckout, pushCheckout, readDiff, readGitStatus } from './git.js';
import { fromPaseoCadence, toPaseoCadence } from './schedules.js';
import { readWorkspaceScripts } from './scripts.js';
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
    /** Session that owns each reminder this daemon has seen. */
    scheduleOwners = new Map();
    /** First instant this daemon saw each reminder, which stands in for a creation time. */
    scheduleSeenAt = new Map();
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
    /** Pull request facts for one directory's current branch. */
    async checkoutPrStatus(directory) {
        const status = await readGitStatus(directory);
        if (!status.isGit || status.currentBranch === null)
            return { status: null, authenticated: false, error: null };
        const remote = parseGithubRemote(status.remoteUrl);
        if (remote === null)
            return { status: null, authenticated: false, error: null };
        return lookupPullRequest(remote, status.currentBranch, forgeToken());
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
    /** Declared scripts of one workspace, each with its current lifecycle. */
    /** Every recurring reminder this runtime holds, across Sessions. */
    async listSchedules() {
        const service = this.ctx.get('schedule');
        if (service === undefined)
            return [];
        const records = [];
        for (const summary of await this.summaries()) {
            for (const view of await service.list({ sessionId: summary.sessionId })) {
                const record = scheduleRecord(summary.sessionId, view, this.firstSeenAt(view.id));
                // A one-shot reminder has no cadence Paseo can render, so it stays out
                // of the listing instead of appearing as a recurrence that fires again.
                if (record === null)
                    continue;
                this.scheduleOwners.set(record.id, summary.sessionId);
                records.push(record);
            }
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
        const record = scheduleRecord(input.agentId, view, this.firstSeenAt(view.id));
        if (record === null)
            throw new Error('the created reminder has no cadence Paseo can render');
        this.scheduleOwners.set(record.id, input.agentId);
        return record;
    }
    /** Remove one reminder from the Session that owns it. */
    async deleteSchedule(scheduleId) {
        const service = this.requireScheduleService();
        const sessionId = await this.scheduleOwner(scheduleId);
        if (sessionId === null)
            return false;
        const result = await service.delete({ sessionId, id: scheduleId }, new AbortController().signal);
        const removed = result !== null && typeof result === 'object' && result.deleted !== false;
        if (removed)
            this.scheduleOwners.delete(scheduleId);
        return removed;
    }
    /** Deliver one reminder's prompt now, through the ordinary prompt path. */
    async runScheduleNow(scheduleId) {
        const sessionId = await this.scheduleOwner(scheduleId);
        if (sessionId === null)
            throw new Error(`unknown reminder ${scheduleId}`);
        const service = this.requireScheduleService();
        const view = (await service.list({ sessionId })).find((entry) => entry.id === scheduleId);
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
/** Project one reminder into the client shape, or null for a one-shot. */
function scheduleRecord(agentId, view, firstSeen) {
    const cadence = toPaseoCadence({
        kind: view.kind,
        ...(view.everySeconds === undefined ? {} : { everySeconds: view.everySeconds }),
        ...(view.expression === undefined ? {} : { expression: view.expression }),
        ...(view.timeZone === undefined ? {} : { timeZone: view.timeZone }),
        ...(view.time === undefined ? {} : { dailyTime: view.time }),
        ...(view.weekdays === undefined ? {} : { weekdays: view.weekdays }),
    });
    if (cadence === null)
        return null;
    return {
        id: view.id,
        agentId,
        name: view.title.length > 0 ? view.title : null,
        prompt: view.prompt,
        cadence,
        // A record read back from storage carries no status; only an explicit
        // inactive marker means the reminder stopped.
        status: view.status === 'inactive' ? 'inactive' : 'active',
        createdAt: firstSeen,
        nextRunAt: view.status === 'inactive' ? null : view.scheduledAt ?? null,
    };
}
