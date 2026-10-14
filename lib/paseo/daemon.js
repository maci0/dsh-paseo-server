/**
 * Paseo daemon: one WebSocket session per connected Paseo client, plus the
 * fan-out of live agent, workspace, and timeline events from the bridge.
 *
 * @module dsh-paseo-server/paseo/daemon
 */
import { TERMINAL_MAX_SLOT, TERMINAL_OPCODE, decodeResizePayload, decodeTerminalFrame, encodeOutputFrame, } from './terminal-frames.js';
import { agentRemoved, agentCreateFailedStatus, agentDeleted, agentCreateResponse, agentCreatedStatus, agentResponse, agentStatus, agentStream, availableProvidersResponse, agentUpdate, agentsResponse, attentionCleared, cancelResponse, checkoutDiffGetResponse, checkoutDiffUpdate, attentionClearedFor, directorySuggestions, agentActionResponse, forkContextResponse, subagentList, projectAdded, projectConfigMissing, projectConfigRead, projectConfigWriteFailed, projectConfigWritten, projectRemoved, availableEditors, workspaceArchived, workspaceMarkedUnread, workspacePinned, workspaceTitleSet, branchSuggestions, directoryListing, fileContents, openedInEditor, branchValidated, checkDetailsResponse, commitDiff, commitList, stashEntries, checkoutPrStatusResponse, pullRequestCreated, pullRequestTimelineResponse, pullRequestWriteResponse, checkoutStatusResponse, subscribeCheckoutDiffResponse, daemonStatus, eventsSubscriptionSet, envelope, terminalCreated, terminalKilled, terminalRenamed, terminalSubscribeFailed, terminalSubscribed, terminalsChanged, scheduleCreated, scheduleDeleted, scheduleList, schedulePaused, scheduleRanOnce, scheduleResumed, scriptStatusUpdate, terminalsResponse, workspaceScriptResponse, parseInbound, pong, providerModelsResponse, providerModesResponse, providersSnapshotResponse, projectsResponse, rpcError, sendMessageRejected, sendMessageResponse, serverInfo, subscriptionReleased, timelineResponse, waitForFinishResponse, workspaceUpdate, workspaceCreateResponse, workspacesResponse, isSettledStatus, } from './wire.js';
/** Default `wait_for_finish_request` deadline when the client names none. */
const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
/** How often a subscribed diff is re-read, in milliseconds. */
const DIFF_POLL_INTERVAL_MS = 4_000;
/** Live event fan-out plus request dispatch for every connected client. */
export class PaseoDaemon {
    options;
    connections = new Set();
    unsubscribe;
    closed = false;
    constructor(options) {
        this.options = options;
    }
    /** Start listening to bridge events. */
    start() {
        if (this.unsubscribe !== undefined)
            return;
        this.unsubscribe = this.options.bridge.subscribe((event) => { this.onBridgeEvent(event); });
    }
    /** Stop the fan-out; transport sockets are owned by the caller. */
    stop() {
        this.closed = true;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        for (const connection of this.connections) {
            connection.socket.detach();
            this.connections.delete(connection);
        }
    }
    /** Number of admitted clients, for diagnostics. */
    get size() {
        return this.connections.size;
    }
    /**
     * Admit one transport socket as a Paseo client.
     *
     * The transport owns its own listeners and drives this handle: it calls
     * {@link PaseoConnection.receive} per text frame and
     * {@link PaseoConnection.dispose} when the peer goes away.
     * @param socket - transport to speak the protocol over.
     * @returns the connection handle for that socket.
     */
    attach(socket, host) {
        const connection = {
            socket,
            ready: false,
            closed: false,
            proxyBase: host === undefined ? undefined : `http://${host}`,
            diffWatches: new Map(),
            slots: new Map(),
            terminalStreams: new Map(),
        };
        this.connections.add(connection);
        return {
            receive: (text) => { this.onFrame(connection, text); },
            receiveBinary: (bytes) => { void this.onBinaryFrame(connection, bytes); },
            dispose: () => {
                connection.closed = true;
                for (const subscriptionId of [...connection.diffWatches.keys()])
                    this.stopDiffWatch(connection, subscriptionId);
                for (const terminalId of [...connection.terminalStreams.keys()])
                    this.stopTerminalStream(connection, terminalId);
                this.connections.delete(connection);
            },
        };
    }
    /** Route one inbound terminal stream frame. */
    async onBinaryFrame(connection, bytes) {
        if (this.closed || connection.closed)
            return;
        const frame = decodeTerminalFrame(bytes);
        if (frame === null)
            return;
        const terminalId = connection.slots.get(frame.slot)?.terminalId;
        if (terminalId === undefined)
            return;
        try {
            if (frame.opcode === TERMINAL_OPCODE.INPUT) {
                await this.options.bridge.writeTerminal(terminalId, new TextDecoder().decode(frame.payload));
                return;
            }
            if (frame.opcode === TERMINAL_OPCODE.RESIZE) {
                const size = decodeResizePayload(frame.payload);
                if (size !== null)
                    await this.options.bridge.resizeTerminal(terminalId, size.cols, size.rows);
            }
        }
        catch (error) {
            this.options.logger.warn(`paseo: terminal ${terminalId} input failed: ${String(error)}`);
        }
    }
    /** Route one inbound text frame. */
    onFrame(connection, text) {
        if (this.closed || connection.closed)
            return;
        const frame = parseInbound(text);
        if (frame === null)
            return;
        if (frame.kind === 'ping') {
            connection.socket.send(pong());
            return;
        }
        if (frame.kind === 'recording_state')
            return;
        if (frame.kind === 'hello') {
            if (this.options.password !== undefined && this.options.password.length > 0) {
                const provided = frame.hello.auth?.kind === 'password' ? frame.hello.auth.password : undefined;
                if (provided !== this.options.password) {
                    connection.socket.send(JSON.stringify({
                        type: 'hello.rejected',
                        reason: provided === undefined ? 'password_required' : 'incorrect_password',
                        accepts: ['password'],
                    }));
                    connection.socket.close(4401, 'auth failed');
                    return;
                }
            }
            connection.ready = true;
            connection.socket.send(envelope(serverInfo(this.options.bridge, this.options.hostname)));
            return;
        }
        if (!connection.ready)
            return;
        void this.dispatch(connection, frame.message);
    }
    /** Answer one request message. */
    async dispatch(connection, message) {
        const type = typeof message.type === 'string' ? message.type : '';
        const requestId = typeof message.requestId === 'string' ? message.requestId : '';
        const reply = (payload) => {
            if (connection.closed)
                return;
            connection.socket.send(envelope(payload));
        };
        try {
            switch (type) {
                case 'fetch_workspaces_request': {
                    const workspaces = await this.options.bridge.listWorkspaces();
                    this.cacheWorkspaces(workspaces);
                    reply(workspacesResponse(requestId, subscriptionIdOf(message), workspaces));
                    return;
                }
                case 'project.list.request': {
                    reply(projectsResponse(requestId, await this.options.bridge.listWorkspaces()));
                    return;
                }
                case 'fetch_agents_request': {
                    const [agents, workspaces] = await Promise.all([this.options.bridge.listAgents(), this.options.bridge.listWorkspaces()]);
                    this.cacheWorkspaces(workspaces);
                    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
                    const entries = agents.flatMap((agent) => {
                        const workspace = byId.get(agent.workspaceId);
                        return workspace === undefined ? [] : [{ agent, workspace }];
                    });
                    reply(agentsResponse(requestId, subscriptionIdOf(message), entries));
                    return;
                }
                case 'fetch_agent_request': {
                    const agentId = stringField(message, 'agentId');
                    const agent = agentId === undefined ? null : await this.options.bridge.getAgent(agentId);
                    const workspace = agent === null ? null : (await this.workspaceFor(agent.workspaceId)) ?? null;
                    reply(agentResponse(requestId, agent, workspace, agent === null ? 'agent not found' : null));
                    return;
                }
                case 'fetch_agent_timeline_request': {
                    const agentId = stringField(message, 'agentId');
                    const agent = agentId === undefined ? null : await this.options.bridge.getAgent(agentId);
                    if (agent === null) {
                        reply(rpcError(requestId, type, 'agent not found', 'agent_not_found'));
                        return;
                    }
                    const entries = await this.options.bridge.getTimeline(agent.id);
                    reply(timelineResponse(requestId, agent, epochFor(agent.id), entries));
                    return;
                }
                case 'send_agent_message_request':
                case 'send_agent_message': {
                    const agentId = stringField(message, 'agentId');
                    const text = stringField(message, 'text') ?? '';
                    if (agentId === undefined) {
                        reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'));
                        return;
                    }
                    const agent = await this.options.bridge.getAgent(agentId);
                    if (agent === null) {
                        reply(sendMessageRejected(requestId, agentId, 'agent not found'));
                        return;
                    }
                    await this.options.bridge.sendPrompt(agent.id, {
                        text,
                        ...(stringField(message, 'messageId') === undefined ? {} : { clientMessageId: stringField(message, 'messageId') }),
                        ...(imagesOf(message) === undefined ? {} : { images: imagesOf(message) }),
                    });
                    const updated = (await this.options.bridge.getAgent(agent.id)) ?? agent;
                    reply(sendMessageResponse(requestId, updated));
                    return;
                }
                case 'cancel_agent_request': {
                    const agentId = stringField(message, 'agentId');
                    if (agentId === undefined) {
                        reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'));
                        return;
                    }
                    await this.options.bridge.cancelAgent(agentId);
                    reply(cancelResponse(requestId, agentId, await this.options.bridge.getAgent(agentId)));
                    return;
                }
                case 'archive_agent_request': {
                    const agentId = stringField(message, 'agentId');
                    if (agentId === undefined) {
                        reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'));
                        return;
                    }
                    try {
                        const archivedAt = await this.options.bridge.archiveAgent(agentId);
                        reply({ type: 'agent_archived', payload: { agentId, archivedAt, requestId } });
                    }
                    catch (error) {
                        reply(rpcError(requestId, type, error instanceof Error ? error.message : String(error), 'archive_failed'));
                    }
                    return;
                }
                case 'close_items_request': {
                    // Closing a tab synchronizes client state. There is no daemon-side
                    // item to close, so every requested agent is already gone from this
                    // client's view and nothing is reported as archived.
                    reply({ type: 'close_items_response', payload: { requestId, agents: [], terminals: [] } });
                    return;
                }
                case 'workspace.create.request': {
                    const source = recordValue(message.source);
                    if (source === undefined || source.kind !== 'directory' || typeof source.path !== 'string') {
                        reply(workspaceCreateResponse(requestId, null, null, 'only a directory workspace source is supported'));
                        return;
                    }
                    const workspace = await this.options.bridge.createWorkspace({
                        directory: source.path,
                        ...(typeof message.title === 'string' ? { name: message.title } : {}),
                    });
                    this.workspaceCache.set(workspace.id, workspace);
                    reply(workspaceCreateResponse(requestId, workspace, null, null));
                    return;
                }
                case 'agent.create.request':
                case 'create_agent_request': {
                    const legacy = type === 'create_agent_request';
                    const config = recordValue(message.config);
                    const provider = config === undefined ? undefined : stringField(config, 'provider');
                    const model = config === undefined ? undefined : stringField(config, 'model');
                    const workspaceId = stringField(message, 'workspaceId');
                    const directory = config === undefined ? undefined : stringField(config, 'cwd');
                    if (workspaceId === undefined && directory === undefined) {
                        const failure = 'agent creation needs workspaceId or config.cwd';
                        reply(legacy ? agentCreateFailedStatus(requestId, failure) : agentCreateResponse(requestId, null, failure));
                        return;
                    }
                    try {
                        const agent = await this.options.bridge.createAgent({
                            ...(workspaceId === undefined ? {} : { workspaceId }),
                            ...(directory === undefined ? {} : { directory }),
                            ...(provider === undefined ? {} : { provider }),
                            ...(model === undefined ? {} : { model }),
                            ...(config === undefined || typeof config.title !== 'string' ? {} : { title: config.title }),
                            ...(typeof message.initialPrompt === 'string' ? { prompt: message.initialPrompt } : {}),
                            ...(imagesOf(message) === undefined ? {} : { images: imagesOf(message) }),
                        });
                        reply(legacy ? agentCreatedStatus(requestId, agent) : agentCreateResponse(requestId, agent, null));
                    }
                    catch (error) {
                        this.options.logger.warn(`paseo: agent creation failed: ${error instanceof Error ? error.message : String(error)}`);
                        const failure = error instanceof Error ? error.message : String(error);
                        if (!legacy)
                            throw error;
                        reply(agentCreateFailedStatus(requestId, failure));
                    }
                    return;
                }
                case 'get_providers_snapshot_request': {
                    const providers = await this.options.bridge.listProviders();
                    const entries = await Promise.all(providers.map(async (entry) => ({
                        provider: entry.provider,
                        available: entry.available,
                        models: await this.options.bridge.listProviderModels(entry.provider),
                    })));
                    reply(providersSnapshotResponse(requestId, entries));
                    return;
                }
                case 'list_available_providers_request': {
                    reply(availableProvidersResponse(requestId, await this.options.bridge.listProviders()));
                    return;
                }
                case 'list_provider_models_request': {
                    const provider = stringField(message, 'provider');
                    if (provider === undefined) {
                        reply(rpcError(requestId, type, 'provider is required', 'invalid_request'));
                        return;
                    }
                    reply(providerModelsResponse(requestId, provider, await this.options.bridge.listProviderModels(provider)));
                    return;
                }
                case 'list_provider_modes_request': {
                    const provider = stringField(message, 'provider');
                    if (provider === undefined) {
                        reply(rpcError(requestId, type, 'provider is required', 'invalid_request'));
                        return;
                    }
                    reply(providerModesResponse(requestId, provider));
                    return;
                }
                case 'list_provider_features_request': {
                    const provider = stringField(message, 'provider');
                    if (provider === undefined) {
                        reply(rpcError(requestId, type, 'provider is required', 'invalid_request'));
                        return;
                    }
                    reply({
                        type: 'list_provider_features_response',
                        payload: { provider, features: [], fetchedAt: new Date().toISOString(), requestId },
                    });
                    return;
                }
                case 'wait_for_finish_request': {
                    const agentId = stringField(message, 'agentId');
                    if (agentId === undefined) {
                        reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'));
                        return;
                    }
                    const agent = await this.options.bridge.getAgent(agentId);
                    if (agent === null) {
                        reply(waitForFinishResponse(requestId, 'error', null, null, 'agent not found'));
                        return;
                    }
                    if (isSettledStatus(agent.status)) {
                        reply(waitForFinishResponse(requestId, 'idle', agent, null));
                        return;
                    }
                    const timeoutMs = typeof message.timeoutMs === 'number' && message.timeoutMs > 0 ? message.timeoutMs : DEFAULT_WAIT_TIMEOUT_MS;
                    this.waitForSettle(connection, requestId, agent, timeoutMs);
                    return;
                }
                case 'checkout_pr_status_request': {
                    const directory = stringField(message, 'cwd');
                    if (directory === undefined) {
                        reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'));
                        return;
                    }
                    const known = await this.knownDirectory(directory);
                    if (known === null) {
                        reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'));
                        return;
                    }
                    try {
                        reply(checkoutPrStatusResponse(requestId, known, await this.options.bridge.checkoutPrStatus(known)));
                    }
                    catch (error) {
                        reply(checkoutPrStatusResponse(requestId, known, {
                            status: null,
                            authenticated: false,
                            error: error instanceof Error ? error.message : String(error),
                        }));
                    }
                    return;
                }
                case 'checkout_pr_create_request':
                case 'checkout_pr_merge_request':
                case 'checkout.forge.set_auto_merge.request':
                case 'checkout.github.set_auto_merge.request':
                case 'pull_request_timeline_request':
                case 'checkout.forge.get_check_details.request':
                case 'checkout.github.get_check_details.request': {
                    const directory = stringField(message, 'cwd');
                    if (directory === undefined) {
                        reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'));
                        return;
                    }
                    const known = await this.knownDirectory(directory);
                    if (known === null) {
                        reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'));
                        return;
                    }
                    if (type === 'pull_request_timeline_request') {
                        const timeline = await this.options.bridge.pullRequestTimeline(known);
                        reply(pullRequestTimelineResponse(requestId, known, timeline.number, timeline.items, timeline.error));
                        return;
                    }
                    if (type === 'checkout.forge.get_check_details.request' || type === 'checkout.github.get_check_details.request') {
                        const checkRunId = message.checkRunId;
                        if (typeof checkRunId !== 'number') {
                            reply(rpcError(requestId, type, 'checkRunId is required', 'invalid_request'));
                            return;
                        }
                        const details = await this.options.bridge.checkDetails(known, checkRunId);
                        reply(checkDetailsResponse(type === 'checkout.github.get_check_details.request'
                            ? 'checkout.github.get_check_details.response'
                            : 'checkout.forge.get_check_details.response', requestId, known, details.details, details.error));
                        return;
                    }
                    if (type === 'checkout_pr_create_request') {
                        const result = await this.options.bridge.createPullRequest(known, {
                            ...(stringField(message, 'title') === undefined ? {} : { title: stringField(message, 'title') }),
                            ...(stringField(message, 'body') === undefined ? {} : { body: stringField(message, 'body') }),
                            ...(stringField(message, 'baseRef') === undefined ? {} : { baseRef: stringField(message, 'baseRef') }),
                        });
                        reply(pullRequestCreated(requestId, known, result));
                        return;
                    }
                    const method = mergeMethodOf(message.mergeMethod);
                    if (type === 'checkout_pr_merge_request') {
                        reply(pullRequestWriteResponse('checkout_pr_merge_response', requestId, known, await this.options.bridge.mergePullRequest(known, method)));
                        return;
                    }
                    const enabled = message.enabled === true;
                    const result = await this.options.bridge.setPullRequestAutoMerge(known, enabled, method);
                    reply(pullRequestWriteResponse(type === 'checkout.github.set_auto_merge.request'
                        ? 'checkout.github.set_auto_merge.response'
                        : 'checkout.forge.set_auto_merge.response', requestId, known, result, enabled));
                    return;
                }
                case 'checkout_status_request': {
                    const directory = stringField(message, 'cwd') ?? stringField(message, 'workspaceDirectory');
                    if (directory === undefined) {
                        reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'));
                        return;
                    }
                    // Only directories this daemon advertised are read: the request would
                    // otherwise be an arbitrary path probe into the operator's machine.
                    const known = await this.knownDirectory(directory);
                    if (known === null) {
                        reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'));
                        return;
                    }
                    reply(checkoutStatusResponse(requestId, known, await this.options.bridge.checkoutStatus(known)));
                    return;
                }
                case 'checkout.diff.get.request':
                case 'subscribe_checkout_diff_request': {
                    const directory = stringField(message, 'cwd');
                    if (directory === undefined) {
                        reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'));
                        return;
                    }
                    const known = await this.knownDirectory(directory);
                    if (known === null) {
                        reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'));
                        return;
                    }
                    const compare = compareOf(message);
                    const files = await this.options.bridge.checkoutDiff(known, compare);
                    if (type === 'checkout.diff.get.request') {
                        reply(checkoutDiffGetResponse(requestId, known, files));
                        return;
                    }
                    const subscriptionId = stringField(message, 'subscriptionId') ?? `diff_${requestId}`;
                    reply(subscribeCheckoutDiffResponse(requestId, subscriptionId, known, files));
                    this.watchDiff(connection, subscriptionId, known, compare, files);
                    return;
                }
                case 'unsubscribe_checkout_diff_request': {
                    const subscriptionId = stringField(message, 'subscriptionId');
                    if (subscriptionId !== undefined)
                        this.stopDiffWatch(connection, subscriptionId);
                    return;
                }
                case 'branch_suggestions_request': {
                    const directory = stringField(message, 'cwd');
                    if (directory === undefined) {
                        reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'));
                        return;
                    }
                    const known = await this.knownDirectory(directory);
                    if (known === null) {
                        reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'));
                        return;
                    }
                    const limit = typeof message.limit === 'number' ? message.limit : 100;
                    reply(branchSuggestions(requestId, await this.options.bridge.listBranches(known, stringField(message, 'query'), limit)));
                    return;
                }
                case 'validate_branch_request': {
                    const directory = stringField(message, 'cwd');
                    const branchName = stringField(message, 'branchName');
                    if (directory === undefined || branchName === undefined) {
                        reply(rpcError(requestId, type, 'cwd and branchName are required', 'invalid_request'));
                        return;
                    }
                    const known = await this.knownDirectory(directory);
                    if (known === null) {
                        reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'));
                        return;
                    }
                    reply(branchValidated(requestId, await this.options.bridge.resolveBranch(known, branchName)));
                    return;
                }
                case 'checkout_switch_branch_request':
                case 'checkout.rename_branch.request':
                case 'checkout.discard_changes.request':
                case 'stash_save_request':
                case 'stash_pop_request':
                case 'stash_list_request':
                case 'checkout_merge_request':
                case 'checkout_merge_from_base_request':
                case 'checkout.commits.list.request':
                case 'checkout.commits.file_diff.request': {
                    const directory = stringField(message, 'cwd');
                    if (directory === undefined) {
                        reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'));
                        return;
                    }
                    const known = await this.knownDirectory(directory);
                    if (known === null) {
                        reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'));
                        return;
                    }
                    const bridge = this.options.bridge;
                    switch (type) {
                        case 'checkout_switch_branch_request':
                            reply(checkoutOperationResponse(type, requestId, known, await bridge.switchBranch(known, stringField(message, 'branch') ?? '')));
                            return;
                        case 'checkout.rename_branch.request':
                            reply(checkoutOperationResponse(type, requestId, known, await bridge.renameBranch(known, stringField(message, 'branch') ?? '')));
                            return;
                        case 'checkout.discard_changes.request': {
                            const paths = Array.isArray(message.paths) ? message.paths.filter((path) => typeof path === 'string') : [];
                            reply(checkoutOperationResponse(type, requestId, known, await bridge.discardChanges(known, paths)));
                            return;
                        }
                        case 'stash_save_request':
                            reply(checkoutOperationResponse(type, requestId, known, await bridge.stashSave(known, stringField(message, 'branch'))));
                            return;
                        case 'stash_pop_request':
                            reply(checkoutOperationResponse(type, requestId, known, await bridge.stashPop(known)));
                            return;
                        case 'stash_list_request':
                            reply(stashEntries(requestId, known, await bridge.stashList(known, message.paseoOnly !== false)));
                            return;
                        case 'checkout_merge_request':
                            reply(checkoutOperationResponse(type, requestId, known, await bridge.mergeRef(known, stringField(message, 'baseRef') ?? 'main', message.strategy === 'squash' ? 'squash' : 'merge')));
                            return;
                        case 'checkout_merge_from_base_request':
                            reply(checkoutOperationResponse(type, requestId, known, await bridge.mergeRef(known, stringField(message, 'baseRef') ?? 'main', 'merge')));
                            return;
                        case 'checkout.commits.list.request':
                            reply(commitList(requestId, known, await bridge.listCommits(known)));
                            return;
                        default: {
                            const sha = stringField(message, 'sha');
                            const path = stringField(message, 'path');
                            if (sha === undefined || path === undefined) {
                                reply(rpcError(requestId, type, 'sha and path are required', 'invalid_request'));
                                return;
                            }
                            reply(commitDiff(requestId, known, sha, path, await bridge.commitFileDiff(known, sha, path)));
                            return;
                        }
                    }
                }
                case 'checkout_commit_request':
                case 'checkout_push_request':
                case 'checkout_pull_request':
                case 'checkout.refresh.request': {
                    const directory = stringField(message, 'cwd');
                    if (directory === undefined) {
                        reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'));
                        return;
                    }
                    const known = await this.knownDirectory(directory);
                    if (known === null) {
                        reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'));
                        return;
                    }
                    reply(await this.runCheckoutOperation(type, requestId, known, message));
                    return;
                }
                case 'delete_agent_request': {
                    const agentId = stringField(message, 'agentId');
                    if (agentId === undefined) {
                        reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'));
                        return;
                    }
                    // DSH has no session delete, so delete and archive land in the same
                    // place: the agent leaves every list and stops running.
                    try {
                        await this.options.bridge.archiveAgent(agentId);
                    }
                    catch (error) {
                        this.options.logger.warn(`paseo: deleting agent ${agentId} failed: ${String(error)}`);
                    }
                    reply(agentDeleted(agentId));
                    return;
                }
                case 'workspace.script.list.request':
                case 'workspace.script.start.request':
                case 'workspace.script.stop.request': {
                    const workspaceId = stringField(message, 'workspaceId');
                    if (workspaceId === undefined) {
                        reply(rpcError(requestId, type, 'workspaceId is required', 'invalid_request'));
                        return;
                    }
                    const responseType = type.replace('.request', '.response');
                    const scriptName = stringField(message, 'scriptName');
                    try {
                        if (type === 'workspace.script.start.request' && scriptName !== undefined) {
                            await this.options.bridge.startWorkspaceScript(workspaceId, scriptName);
                        }
                        if (type === 'workspace.script.stop.request' && scriptName !== undefined) {
                            await this.options.bridge.stopWorkspaceScript(workspaceId, scriptName);
                        }
                        const scripts = await this.options.bridge.listWorkspaceScripts(workspaceId);
                        reply(workspaceScriptResponse(responseType, requestId, workspaceId, scripts, null, scriptName, connection.proxyBase));
                        for (const peer of this.connections) {
                            peer.socket.send(envelope(scriptStatusUpdate(workspaceId, scripts, peer.proxyBase)));
                        }
                    }
                    catch (error) {
                        reply(workspaceScriptResponse(responseType, requestId, workspaceId, [], error instanceof Error ? error.message : String(error), scriptName));
                    }
                    return;
                }
                case 'schedule/list': {
                    reply(scheduleList(requestId, await this.options.bridge.listSchedules()));
                    return;
                }
                case 'schedule/create': {
                    const prompt = stringField(message, 'prompt');
                    const target = recordValue(message.target);
                    const agentId = target === undefined ? undefined : stringField(target, 'agentId');
                    if (prompt === undefined || agentId === undefined) {
                        reply(scheduleCreated(requestId, null, 'a reminder needs a prompt and an agent target'));
                        return;
                    }
                    const cadence = paseoCadence(message.cadence);
                    if (cadence === null) {
                        reply(scheduleCreated(requestId, null, 'the request carries no cadence this daemon understands'));
                        return;
                    }
                    try {
                        const created = await this.options.bridge.createSchedule({
                            agentId,
                            prompt,
                            ...(stringField(message, 'name') === undefined ? {} : { name: stringField(message, 'name') }),
                            cadence,
                        });
                        reply(scheduleCreated(requestId, created, null));
                    }
                    catch (error) {
                        reply(scheduleCreated(requestId, null, error instanceof Error ? error.message : String(error)));
                    }
                    return;
                }
                case 'schedule/delete': {
                    const scheduleId = stringField(message, 'scheduleId');
                    if (scheduleId === undefined) {
                        reply(scheduleDeleted(requestId, '', 'scheduleId is required'));
                        return;
                    }
                    const removed = await this.options.bridge.deleteSchedule(scheduleId);
                    reply(scheduleDeleted(requestId, scheduleId, removed ? null : 'the reminder is gone already'));
                    return;
                }
                case 'schedule/run-once': {
                    const scheduleId = stringField(message, 'scheduleId');
                    if (scheduleId === undefined) {
                        reply(scheduleRanOnce(requestId, '', 'scheduleId is required'));
                        return;
                    }
                    try {
                        await this.options.bridge.runScheduleNow(scheduleId);
                        reply(scheduleRanOnce(requestId, scheduleId));
                    }
                    catch (error) {
                        reply(scheduleRanOnce(requestId, scheduleId, error instanceof Error ? error.message : String(error)));
                    }
                    return;
                }
                case 'schedule/inspect': {
                    const scheduleId = stringField(message, 'scheduleId');
                    const found = (await this.options.bridge.listSchedules()).find((entry) => entry.id === scheduleId);
                    if (found === undefined) {
                        reply({ type: 'schedule/inspect/response', payload: { requestId, schedule: null, error: 'unknown reminder' } });
                        return;
                    }
                    reply({ type: 'schedule/inspect/response', payload: { requestId, schedule: found, error: null } });
                    return;
                }
                case 'schedule/pause': {
                    const scheduleId = stringField(message, 'scheduleId');
                    if (scheduleId === undefined) {
                        reply(schedulePaused(requestId, '', 'scheduleId is required'));
                        return;
                    }
                    const paused = await this.options.bridge.pauseSchedule(scheduleId);
                    reply(schedulePaused(requestId, scheduleId, paused ? null : 'unknown reminder'));
                    return;
                }
                case 'schedule/resume': {
                    const scheduleId = stringField(message, 'scheduleId');
                    if (scheduleId === undefined) {
                        reply(scheduleResumed(requestId, '', null, 'scheduleId is required'));
                        return;
                    }
                    try {
                        reply(scheduleResumed(requestId, scheduleId, await this.options.bridge.resumeSchedule(scheduleId), null));
                    }
                    catch (error) {
                        reply(scheduleResumed(requestId, scheduleId, null, error instanceof Error ? error.message : String(error)));
                    }
                    return;
                }
                case 'schedule/update': {
                    reply(rpcError(requestId, type, 'this daemon cannot retime a reminder in place', 'unsupported'));
                    return;
                }
                case 'schedule/logs': {
                    const scheduleId = stringField(message, 'scheduleId');
                    if (scheduleId === undefined) {
                        reply(rpcError(requestId, type, 'scheduleId is required', 'invalid_request'));
                        return;
                    }
                    reply({ type: 'schedule/logs/response', payload: { requestId, scheduleId, runs: [], error: null } });
                    return;
                }
                case 'file_explorer_request': {
                    const directory = stringField(message, 'cwd');
                    if (directory === undefined) {
                        reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'));
                        return;
                    }
                    const known = await this.knownDirectory(directory);
                    if (known === null) {
                        reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'));
                        return;
                    }
                    const path = stringField(message, 'path') ?? '';
                    if (message.mode === 'file') {
                        if (path.length === 0) {
                            reply(fileContents(requestId, known, path, null, 'path is required to read a file'));
                            return;
                        }
                        const file = await this.options.bridge.readWorkspaceFile(known, path);
                        reply(fileContents(requestId, known, path, file, file === null ? 'the file is unreadable or too large' : null));
                        return;
                    }
                    const entries = await this.options.bridge.listDirectory(known, path);
                    if (entries === null) {
                        reply(rpcError(requestId, type, `cannot list ${path}`, 'invalid_request'));
                        return;
                    }
                    reply(directoryListing(requestId, known, path, entries));
                    return;
                }
                case 'list_available_editors_request': {
                    // Nothing here launches a desktop editor, and claiming otherwise
                    // would make the client offer an action that cannot work.
                    reply(availableEditors(requestId, []));
                    return;
                }
                case 'open_in_editor_request': {
                    reply(openedInEditor(requestId, 'this daemon runs headless; it has no editor to open a file in'));
                    return;
                }
                case 'set_agent_model_request': {
                    const agentId = stringField(message, 'agentId');
                    if (agentId === undefined) {
                        reply(agentActionResponse('set_agent_model_response', requestId, '', false, 'agentId is required'));
                        return;
                    }
                    try {
                        await this.options.bridge.selectAgentModel(agentId, stringField(message, 'modelId') ?? null);
                        reply(agentActionResponse('set_agent_model_response', requestId, agentId, true, null));
                    }
                    catch (error) {
                        reply(agentActionResponse('set_agent_model_response', requestId, agentId, false, error instanceof Error ? error.message : String(error)));
                    }
                    return;
                }
                case 'agent.provider_subagents.list.request': {
                    const parentAgentId = stringField(message, 'parentAgentId');
                    if (parentAgentId === undefined) {
                        reply(rpcError(requestId, type, 'parentAgentId is required', 'invalid_request'));
                        return;
                    }
                    reply(subagentList(requestId, parentAgentId, await this.options.bridge.listSubagents(parentAgentId)));
                    return;
                }
                case 'agent.fork_context.request': {
                    const agentId = stringField(message, 'agentId');
                    if (agentId === undefined) {
                        reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'));
                        return;
                    }
                    const context = await this.options.bridge.forkContext(agentId, stringField(message, 'boundaryMessageId'));
                    reply(forkContextResponse(requestId, agentId, context));
                    return;
                }
                case 'daemon.get_status.request': {
                    reply(daemonStatus({
                        requestId,
                        serverId: this.options.bridge.serverId,
                        version: this.options.bridge.version,
                        listen: this.options.listen ?? null,
                        providers: await this.options.bridge.listProviders(),
                    }));
                    return;
                }
                case 'daemon.get_pairing_offer.request': {
                    const offer = this.options.pairingOffer();
                    reply({
                        type: 'daemon.get_pairing_offer.response',
                        payload: { requestId, url: offer.url, qr: offer.qr, relayEnabled: offer.relayEnabled },
                    });
                    return;
                }
                case 'list_terminals_request': {
                    reply(terminalsResponse(requestId, await this.options.bridge.listTerminals()));
                    return;
                }
                case 'create_terminal_request': {
                    const workspaceId = stringField(message, 'workspaceId')
                        ?? await this.workspaceIdForDirectory(stringField(message, 'cwd'));
                    if (workspaceId === null) {
                        reply(terminalCreated(requestId, null, 'the request names no workspace this daemon knows'));
                        return;
                    }
                    const size = recordValue(message.size);
                    try {
                        const terminal = await this.options.bridge.createTerminal({
                            workspaceId,
                            ...(stringField(message, 'name') === undefined ? {} : { name: stringField(message, 'name') }),
                            ...(size === undefined || typeof size.cols !== 'number' ? {} : { cols: size.cols }),
                            ...(size === undefined || typeof size.rows !== 'number' ? {} : { rows: size.rows }),
                        });
                        reply(terminalCreated(requestId, terminal, null));
                        this.broadcast(terminalsChanged(await this.options.bridge.listTerminals()));
                    }
                    catch (error) {
                        reply(terminalCreated(requestId, null, error instanceof Error ? error.message : String(error)));
                    }
                    return;
                }
                case 'subscribe_terminal_request': {
                    const terminalId = stringField(message, 'terminalId');
                    if (terminalId === undefined) {
                        reply(rpcError(requestId, type, 'terminalId is required', 'invalid_request'));
                        return;
                    }
                    const slot = this.allocateSlot(connection, terminalId, stringField(message, 'subscriptionId'));
                    if (slot === null) {
                        reply(terminalSubscribeFailed(requestId, terminalId, 'no free terminal slot on this connection'));
                        return;
                    }
                    reply(terminalSubscribed(requestId, terminalId, slot, stringField(message, 'subscriptionId')));
                    try {
                        const detach = await this.options.bridge.followTerminal(terminalId, (event) => {
                            this.sendTerminalEvent(connection, slot, event);
                        });
                        connection.terminalStreams.set(terminalId, detach);
                    }
                    catch (error) {
                        this.options.logger.warn(`paseo: attaching to terminal ${terminalId} failed: ${String(error)}`);
                    }
                    return;
                }
                case 'unsubscribe_terminal_request': {
                    const terminalId = stringField(message, 'terminalId');
                    if (terminalId !== undefined)
                        this.stopTerminalStream(connection, terminalId);
                    return;
                }
                case 'kill_terminal_request': {
                    const terminalId = stringField(message, 'terminalId');
                    if (terminalId === undefined) {
                        reply(rpcError(requestId, type, 'terminalId is required', 'invalid_request'));
                        return;
                    }
                    let success = true;
                    try {
                        this.stopTerminalStream(connection, terminalId);
                        await this.options.bridge.closeTerminal(terminalId);
                    }
                    catch (error) {
                        success = false;
                        this.options.logger.warn(`paseo: closing terminal ${terminalId} failed: ${String(error)}`);
                    }
                    reply(terminalKilled(requestId, terminalId, success));
                    this.broadcast(terminalsChanged(await this.options.bridge.listTerminals()));
                    return;
                }
                case 'terminal.rename.request': {
                    const terminalId = stringField(message, 'terminalId');
                    const title = stringField(message, 'title');
                    if (terminalId === undefined || title === undefined) {
                        reply(rpcError(requestId, type, 'terminalId and title are required', 'invalid_request'));
                        return;
                    }
                    await this.options.bridge.renameTerminal(terminalId, title);
                    reply(terminalRenamed(requestId, terminalId, title));
                    return;
                }
                case 'terminal_input': {
                    const terminalId = stringField(message, 'terminalId');
                    const input = recordValue(message.message);
                    if (terminalId === undefined || input === undefined)
                        return;
                    await this.applyTerminalInput(terminalId, input);
                    return;
                }
                case 'subscription.release.request': {
                    reply(subscriptionReleased(requestId));
                    return;
                }
                case 'session.events.set_subscription.request': {
                    reply(eventsSubscriptionSet(requestId));
                    return;
                }
                case 'clear_agent_attention': {
                    reply(attentionCleared(requestId));
                    return;
                }
                case 'project.add.request': {
                    const directory = stringField(message, 'cwd');
                    if (directory === undefined) {
                        reply(projectAdded(requestId, null, 'cwd is required'));
                        return;
                    }
                    try {
                        reply(projectAdded(requestId, await this.options.bridge.createWorkspace({ directory }), null));
                    }
                    catch (error) {
                        reply(projectAdded(requestId, null, error instanceof Error ? error.message : String(error)));
                    }
                    return;
                }
                case 'project.remove.request': {
                    const projectId = stringField(message, 'projectId');
                    if (projectId === undefined) {
                        reply(projectRemoved(requestId, '', [], 'projectId is required'));
                        return;
                    }
                    const workspaces = await this.options.bridge.workspacesOfProject(projectId);
                    if (workspaces.length === 0) {
                        reply(projectRemoved(requestId, projectId, [], 'no workspace belongs to that project'));
                        return;
                    }
                    const removed = [];
                    for (const workspace of workspaces) {
                        if (await this.options.bridge.deleteWorkspace(workspace.id))
                            removed.push(workspace.id);
                    }
                    reply(projectRemoved(requestId, projectId, removed, null));
                    return;
                }
                case 'directory_suggestions_request': {
                    const query = stringField(message, 'query') ?? '';
                    const cwd = stringField(message, 'cwd') ?? (await this.defaultDirectory());
                    const limit = typeof message.limit === 'number' ? message.limit : 20;
                    const includeFiles = message.includeFiles === true;
                    const entries = await this.options.bridge.suggestPaths(query, cwd, limit);
                    reply(directorySuggestions(requestId, includeFiles ? entries : entries.filter((entry) => entry.kind === 'directory'), includeFiles));
                    return;
                }
                case 'read_project_config_request': {
                    const repoRoot = stringField(message, 'repoRoot');
                    if (repoRoot === undefined) {
                        reply(projectConfigMissing(requestId, '', 'project_not_found'));
                        return;
                    }
                    const known = await this.knownDirectory(repoRoot);
                    if (known === null) {
                        reply(projectConfigMissing(requestId, repoRoot, 'project_not_found'));
                        return;
                    }
                    const file = await this.options.bridge.readProjectConfig(known);
                    reply(projectConfigRead(requestId, repoRoot, file?.config ?? null, file?.revision ?? null));
                    return;
                }
                case 'write_project_config_request': {
                    const repoRoot = stringField(message, 'repoRoot');
                    if (repoRoot === undefined) {
                        reply(projectConfigWriteFailed(requestId, '', 'project_not_found'));
                        return;
                    }
                    const known = await this.knownDirectory(repoRoot);
                    if (known === null) {
                        reply(projectConfigWriteFailed(requestId, repoRoot, 'project_not_found'));
                        return;
                    }
                    const expected = revisionOf(message.expectedRevision);
                    const written = await this.options.bridge.writeProjectConfig(known, message.config, expected);
                    if ('error' in written) {
                        reply(projectConfigWriteFailed(requestId, repoRoot, written.error === 'stale_project_config'
                            ? 'stale_project_config'
                            : written.error === 'invalid_project_config' ? 'invalid_project_config' : 'write_failed'));
                        return;
                    }
                    reply(projectConfigWritten(requestId, repoRoot, message.config, written.revision));
                    return;
                }
                case 'archive_workspace_request': {
                    const workspaceId = stringField(message, 'workspaceId');
                    if (workspaceId === undefined) {
                        reply(rpcError(requestId, type, 'workspaceId is required', 'invalid_request'));
                        return;
                    }
                    const removed = await this.options.bridge.deleteWorkspace(workspaceId);
                    reply(workspaceArchived(requestId, workspaceId, removed));
                    return;
                }
                case 'workspace.pin.set.request': {
                    const workspaceId = stringField(message, 'workspaceId');
                    if (workspaceId === undefined) {
                        reply(workspacePinned(requestId, '', false, null, 'workspaceId is required'));
                        return;
                    }
                    const pinned = message.pinned === true;
                    const pinnedAt = await this.options.bridge.setWorkspacePinned(workspaceId, pinned);
                    reply(workspacePinned(requestId, workspaceId, pinned ? pinnedAt !== null : true, pinnedAt, pinned && pinnedAt === null ? 'this daemon cannot pin a workspace' : null));
                    return;
                }
                case 'workspace.title.set.request': {
                    const workspaceId = stringField(message, 'workspaceId') ?? '';
                    // DSH keeps a workspace title as it was created; there is no rename.
                    reply(workspaceTitleSet(requestId, workspaceId, false, null, 'this daemon cannot retitle a workspace'));
                    return;
                }
                case 'workspace.mark_unread.request': {
                    const workspaceId = stringField(message, 'workspaceId') ?? '';
                    reply(workspaceMarkedUnread(requestId, workspaceId, null, false, 'this daemon keeps no unread mark'));
                    return;
                }
                case 'workspace.clear_attention.request': {
                    const requested = message.workspaceId;
                    const workspaceIds = Array.isArray(requested)
                        ? requested.filter((id) => typeof id === 'string')
                        : typeof requested === 'string' ? [requested] : [];
                    reply(attentionClearedFor(requestId, workspaceIds, []));
                    return;
                }
                case 'client_heartbeat':
                case 'subscribe_terminals_request':
                case 'unsubscribe_terminals_request':
                    return;
                default:
                    reply(rpcError(requestId, type, `unsupported request: ${type}`, 'unsupported'));
            }
        }
        catch (error) {
            this.options.logger.warn(`paseo: ${type} failed: ${error instanceof Error ? error.message : String(error)}`);
            reply(rpcError(requestId, type, error instanceof Error ? error.message : String(error), 'internal_error'));
        }
    }
    workspaceCache = new Map();
    /** Last known descriptor of every terminal, for change notifications. */
    terminalCache = new Map();
    /** Pending `wait_for_finish_request` waiters, keyed by agent id. */
    waiters = new Map();
    /** Resolve when an agent settles, or after the client's timeout. */
    waitForSettle(connection, requestId, agent, timeoutMs) {
        const waiter = {
            connection,
            requestId,
            timer: setTimeout(() => {
                this.dropWaiter(agent.id, requestId);
                if (connection.closed)
                    return;
                connection.socket.send(envelope(waitForFinishResponse(requestId, 'timeout', null, null)));
            }, timeoutMs),
        };
        const set = this.waiters.get(agent.id) ?? new Set();
        set.add(waiter);
        this.waiters.set(agent.id, set);
    }
    dropWaiter(agentId, requestId) {
        const set = this.waiters.get(agentId);
        if (set === undefined)
            return;
        for (const waiter of set) {
            if (waiter.requestId !== requestId)
                continue;
            clearTimeout(waiter.timer);
            set.delete(waiter);
        }
        if (set.size === 0)
            this.waiters.delete(agentId);
    }
    /** Settle every waiter watching an agent that just finished. */
    settleWaiters(agent) {
        const set = this.waiters.get(agent.id);
        if (set === undefined || !isSettledStatus(agent.status))
            return;
        this.waiters.delete(agent.id);
        for (const waiter of set) {
            clearTimeout(waiter.timer);
            if (waiter.connection.closed)
                continue;
            const status = agent.status === 'error' ? 'error' : 'idle';
            waiter.connection.socket.send(envelope(waitForFinishResponse(waiter.requestId, status, agent, null)));
        }
    }
    cacheWorkspaces(workspaces) {
        for (const workspace of workspaces)
            this.workspaceCache.set(workspace.id, workspace);
    }
    async workspaceFor(workspaceId) {
        const cached = this.workspaceCache.get(workspaceId);
        if (cached !== undefined)
            return cached;
        this.cacheWorkspaces(await this.options.bridge.listWorkspaces());
        return this.workspaceCache.get(workspaceId);
    }
    /**
     * Resolve a requested directory to one this daemon advertised.
     * @param directory - directory the client asked about.
     * @returns the canonical known directory, or null when nothing matches.
     */
    /**
     * Poll one directory's diff and tell the client when it changed.
     *
     * Git has no watch API, so a subscription is a bounded poll. Only a changed
     * serialization is sent, which keeps an idle working tree silent.
     */
    watchDiff(connection, subscriptionId, directory, compare, initial) {
        this.stopDiffWatch(connection, subscriptionId);
        let previous = JSON.stringify(initial);
        const timer = setInterval(() => {
            if (connection.closed) {
                this.stopDiffWatch(connection, subscriptionId);
                return;
            }
            void this.options.bridge.checkoutDiff(directory, compare).then((files) => {
                const next = JSON.stringify(files);
                if (connection.closed || next === previous)
                    return;
                previous = next;
                connection.socket.send(envelope(checkoutDiffUpdate(subscriptionId, directory, files)));
            }).catch(() => {
                // A poll that fails leaves the previous diff in place; the next tick retries.
            });
        }, DIFF_POLL_INTERVAL_MS);
        timer.unref?.();
        connection.diffWatches.set(subscriptionId, timer);
    }
    /** Drop one live diff subscription. */
    stopDiffWatch(connection, subscriptionId) {
        const timer = connection.diffWatches.get(subscriptionId);
        if (timer === undefined)
            return;
        clearInterval(timer);
        connection.diffWatches.delete(subscriptionId);
    }
    /**
     * Run one checkout write and build its response frame.
     *
     * The directory is already resolved to one this daemon advertised, and the
     * commit message travels as its own argument, never through a shell.
     */
    async runCheckoutOperation(type, requestId, directory, message) {
        const bridge = this.options.bridge;
        switch (type) {
            case 'checkout_commit_request':
                return checkoutOperationResponse(type, requestId, directory, await bridge.commitCheckout(directory, stringField(message, 'message'), message.addAll === true));
            case 'checkout_push_request':
                return checkoutOperationResponse(type, requestId, directory, await bridge.pushCheckout(directory));
            case 'checkout_pull_request':
                return checkoutOperationResponse(type, requestId, directory, await bridge.pullCheckout(directory));
            default:
                // Git reports its state on every read, so a refresh is an acknowledgement
                // that tells the client to re-read status and diff.
                return checkoutOperationResponse(type, requestId, directory, { success: true });
        }
    }
    /** A directory to resolve a relative suggestion against: the newest workspace. */
    async defaultDirectory() {
        const workspaces = await this.options.bridge.listWorkspaces();
        this.cacheWorkspaces(workspaces);
        return workspaces[0]?.directory ?? process.cwd();
    }
    /** Workspace identity for one directory this daemon advertised. */
    async workspaceIdForDirectory(directory) {
        if (directory === undefined)
            return null;
        const known = await this.knownDirectory(directory);
        if (known === null)
            return null;
        const workspace = [...this.workspaceCache.values()].find((candidate) => candidate.directory === known);
        return workspace?.id ?? null;
    }
    /** Claim the lowest free stream slot for one terminal on this connection. */
    allocateSlot(connection, terminalId, subscriptionId) {
        for (const [slot, entry] of connection.slots) {
            if (entry.terminalId === terminalId)
                return slot;
        }
        for (let slot = 0; slot <= TERMINAL_MAX_SLOT; slot += 1) {
            if (connection.slots.has(slot))
                continue;
            connection.slots.set(slot, { terminalId, ...(subscriptionId === undefined ? {} : { subscriptionId }) });
            return slot;
        }
        return null;
    }
    /** End one terminal's stream on this connection and release its slot. */
    stopTerminalStream(connection, terminalId) {
        const detach = connection.terminalStreams.get(terminalId);
        if (detach !== undefined) {
            detach();
            connection.terminalStreams.delete(terminalId);
        }
        for (const [slot, entry] of [...connection.slots]) {
            if (entry.terminalId === terminalId)
                connection.slots.delete(slot);
        }
    }
    /** Send one terminal frame, preferring the binary stream the client subscribed to. */
    sendTerminalEvent(connection, slot, event) {
        if (connection.closed)
            return;
        // The client renders ANSI, so the attachment's recovery screen and later
        // output travel the same way: as output bytes for that slot.
        if (event.type === 'snapshot') {
            if (event.screen.length > 0)
                this.sendTerminalBytes(connection, encodeOutputFrame(slot, event.screen));
            return;
        }
        if (event.type === 'output') {
            if (event.data.length > 0)
                this.sendTerminalBytes(connection, encodeOutputFrame(slot, event.data));
            return;
        }
        void this.publishTerminalState(event.record);
    }
    sendTerminalBytes(connection, frame) {
        if (connection.socket.sendBinary !== undefined) {
            connection.socket.sendBinary(frame);
            return;
        }
        // A transport without binary frames (a test double) still receives the
        // frame, base64 encoded, rather than losing the terminal.
        connection.socket.send(envelope({ type: 'terminal_frame', payload: Buffer.from(frame).toString('base64') }));
    }
    async publishTerminalState(record) {
        this.terminalCache.set(record.id, record);
        this.broadcast(terminalsChanged(await this.options.bridge.listTerminals()));
    }
    /** Apply one JSON terminal input, which is the client's non-stream input path. */
    async applyTerminalInput(terminalId, input) {
        const kind = stringField(input, 'type');
        try {
            if (kind === 'input') {
                const data = stringField(input, 'data');
                if (data !== undefined)
                    await this.options.bridge.writeTerminal(terminalId, data);
                return;
            }
            if (kind === 'resize') {
                const rows = input.rows;
                const cols = input.cols;
                if (typeof rows === 'number' && typeof cols === 'number' && rows > 0 && cols > 0) {
                    await this.options.bridge.resizeTerminal(terminalId, cols, rows);
                }
            }
        }
        catch (error) {
            this.options.logger.warn(`paseo: terminal ${terminalId} input failed: ${String(error)}`);
        }
    }
    async knownDirectory(directory) {
        const cached = [...this.workspaceCache.values()].find((workspace) => workspace.directory === directory);
        if (cached !== undefined)
            return cached.directory;
        this.cacheWorkspaces(await this.options.bridge.listWorkspaces());
        const found = [...this.workspaceCache.values()].find((workspace) => workspace.directory === directory);
        return found?.directory ?? null;
    }
    /** Push one bridge event to every admitted client. */
    onBridgeEvent(event) {
        if (event.kind === 'agent_upsert' || event.kind === 'agent_remove') {
            void this.publishAgentEvent(event);
            return;
        }
        if (event.kind === 'workspace_upsert') {
            this.workspaceCache.set(event.workspace.id, event.workspace);
            this.broadcast(workspaceUpdate(event.workspace));
            return;
        }
        void this.publishTimeline(event.agentId, event.entry);
    }
    async publishAgentEvent(event) {
        if (event.kind === 'agent_remove') {
            this.broadcast(agentRemoved(event.agentId));
            return;
        }
        const workspace = (await this.workspaceFor(event.agent.workspaceId)) ?? null;
        this.broadcast(agentUpdate(event.agent, workspace));
        this.broadcast(agentStatus(event.agent));
        this.settleWaiters(event.agent);
    }
    async publishTimeline(agentId, entry) {
        const agent = await this.options.bridge.getAgent(agentId);
        if (agent === null)
            return;
        this.broadcast(agentStream(agent, entry, epochFor(agent.id)));
    }
    broadcast(message) {
        const text = envelope(message);
        for (const connection of this.connections) {
            if (!connection.ready || connection.closed)
                continue;
            connection.socket.send(text);
        }
    }
}
/** Stable per-agent epoch the client uses to reject cross-epoch cursors. */
export function epochFor(agentId) {
    return `epoch/${agentId}`;
}
function subscriptionIdOf(message) {
    const subscribe = message.subscribe;
    if (subscribe !== null && typeof subscribe === 'object') {
        const id = subscribe.subscriptionId;
        if (typeof id === 'string')
            return id;
    }
    return null;
}
function stringField(message, key) {
    const value = message[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/** Narrow a value to an agent record, for embedders. */
export function isAgentRecord(value) {
    return value !== null && typeof value === 'object' && typeof value.id === 'string';
}
function recordValue(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
/** Images a client attached to one request, or undefined when it attached none. */
function imagesOf(message) {
    const raw = message.images;
    if (!Array.isArray(raw))
        return undefined;
    const images = raw.flatMap((entry) => {
        if (entry === null || typeof entry !== 'object')
            return [];
        const record = entry;
        const data = record.data;
        const mimeType = record.mimeType;
        return typeof data === 'string' && typeof mimeType === 'string' ? [{ data, mimeType }] : [];
    });
    return images.length === 0 ? undefined : images;
}
/** Comparison a diff request asked for, defaulting to the working tree. */
function compareOf(message) {
    const compare = recordValue(message.compare);
    const mode = compare === undefined ? undefined : stringField(compare, 'mode');
    const baseRef = compare === undefined ? undefined : stringField(compare, 'baseRef');
    const ignoreWhitespace = compare?.['ignoreWhitespace'] === true;
    return {
        mode: mode === 'base' ? 'base' : 'uncommitted',
        ...(baseRef === undefined ? {} : { baseRef }),
        ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    };
}
/** Operation result frames a checkout write answers with. */
function checkoutOperationResponse(type, requestId, directory, result) {
    const responseType = type === 'checkout.refresh.request'
        ? 'checkout.refresh.response'
        : `${type.replace(/_request$/, '')}_response`;
    return {
        type: responseType,
        payload: {
            cwd: directory,
            success: result.success,
            error: result.error === undefined ? null : { code: result.error.code, message: result.error.message },
            requestId,
        },
    };
}
/** Cadence a schedule request asked for, or null when it is malformed. */
function paseoCadence(value) {
    const cadence = recordValue(value);
    if (cadence === undefined)
        return null;
    const type = stringField(cadence, 'type');
    if (type === 'every') {
        const everyMs = cadence.everyMs;
        return typeof everyMs === 'number' && Number.isFinite(everyMs) && everyMs > 0 ? { type: 'every', everyMs } : null;
    }
    if (type === 'cron') {
        const expression = stringField(cadence, 'expression');
        if (expression === undefined || expression.trim().length === 0)
            return null;
        const timezone = stringField(cadence, 'timezone');
        return { type: 'cron', expression, ...(timezone === undefined ? {} : { timezone }) };
    }
    return null;
}
/** Merge strategy a client asked for, defaulting to a merge commit. */
function mergeMethodOf(value) {
    return value === 'squash' || value === 'rebase' ? value : 'merge';
}
/** Revision a project config write must match, or null when the client sent none. */
function revisionOf(value) {
    const record = recordValue(value);
    if (record === undefined)
        return null;
    return typeof record.mtimeMs === 'number' && typeof record.size === 'number'
        ? { mtimeMs: record.mtimeMs, size: record.size }
        : null;
}
