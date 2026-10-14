/**
 * Paseo daemon: one WebSocket session per connected Paseo client, plus the
 * fan-out of live agent, workspace, and timeline events from the bridge.
 *
 * @module dsh-paseo-server/paseo/daemon
 */
import { agentRemoved, agentCreateFailedStatus, agentCreateResponse, agentCreatedStatus, agentResponse, agentStatus, agentStream, availableProvidersResponse, agentUpdate, agentsResponse, attentionCleared, cancelResponse, daemonStatus, eventsSubscriptionSet, envelope, noTerminals, parseInbound, pong, providerModelsResponse, providerModesResponse, providersSnapshotResponse, projectsResponse, rpcError, sendMessageRejected, sendMessageResponse, serverInfo, subscriptionReleased, timelineResponse, waitForFinishResponse, workspaceUpdate, workspaceCreateResponse, workspacesResponse, isSettledStatus, } from './wire.js';
/** Default `wait_for_finish_request` deadline when the client names none. */
const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
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
    attach(socket) {
        const connection = { socket, ready: false, closed: false };
        this.connections.add(connection);
        return {
            receive: (text) => { this.onFrame(connection, text); },
            dispose: () => {
                connection.closed = true;
                this.connections.delete(connection);
            },
        };
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
                    await this.options.bridge.sendPrompt(agent.id, text, stringField(message, 'messageId'));
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
                        payload: { requestId, url: offer.url, qr: null, relayEnabled: offer.relayEnabled },
                    });
                    return;
                }
                case 'list_terminals_request': {
                    reply(noTerminals(requestId));
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
                case 'client_heartbeat':
                case 'subscribe_terminals_request':
                case 'unsubscribe_terminals_request':
                case 'workspace.mark_unread.request':
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
