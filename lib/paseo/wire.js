/**
 * Paseo wire format: the session messages this daemon emits and accepts.
 *
 * Field sets and required flags mirror the Paseo 0.11.2 protocol schemas. The
 * shapes are protocol facts; this module encodes only the subset a client
 * needs to list workspaces and agents, read a timeline, and drive a turn.
 *
 * @module dsh-paseo-server/paseo/wire
 */
/** Protocol version the 0.11.2 client sends and expects. */
export const PASEO_PROTOCOL_VERSION = 1;
/** Paseo daemon version this server reports. */
export const PASEO_DAEMON_VERSION = '0.11.2';
/** Message types this server answers. Anything else draws `rpc_error`. */
export const SUPPORTED_REQUESTS = [
    'fetch_workspaces_request',
    'fetch_agents_request',
    'project.list.request',
    'fetch_agent_request',
    'fetch_agent_timeline_request',
    'send_agent_message_request',
    'send_agent_message',
    'cancel_agent_request',
    'daemon.get_status.request',
    'agent.create.request',
    'create_agent_request',
    'workspace.create.request',
    'wait_for_finish_request',
    'daemon.get_pairing_offer.request',
    'client_heartbeat',
    'subscription.release.request',
    'session.events.set_subscription.request',
    'clear_agent_attention',
    'list_terminals_request',
    'create_terminal_request',
    'subscribe_terminal_request',
    'unsubscribe_terminal_request',
    'kill_terminal_request',
    'terminal.rename.request',
    'terminal_input',
    'delete_agent_request',
    'workspace.script.list.request',
    'workspace.script.start.request',
    'workspace.script.stop.request',
    'schedule/list',
    'schedule/create',
    'schedule/delete',
    'schedule/run-once',
    'schedule/inspect',
    'schedule/pause',
    'schedule/resume',
    'schedule/update',
    'schedule/logs',
    'checkout_status_request',
    'checkout_pr_status_request',
    'checkout_commit_request',
    'checkout_push_request',
    'checkout_pull_request',
    'checkout.refresh.request',
    'checkout.diff.get.request',
    'subscribe_checkout_diff_request',
    'unsubscribe_checkout_diff_request',
    'archive_agent_request',
    'close_items_request',
    'workspace.mark_unread.request',
    'subscribe_terminals_request',
    'unsubscribe_terminals_request',
    'get_providers_snapshot_request',
    'list_available_providers_request',
    'list_provider_models_request',
];
/**
 * Parse one raw WebSocket text frame.
 * @param raw - frame text.
 * @returns the parsed frame, or null when it is not a known Paseo frame.
 */
export function parseInbound(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (value === null || typeof value !== 'object')
        return null;
    const frame = value;
    if (frame.type === 'ping')
        return { kind: 'ping' };
    if (frame.type === 'recording_state')
        return { kind: 'recording_state' };
    if (frame.type === 'hello') {
        if (typeof frame.clientId !== 'string' || typeof frame.protocolVersion !== 'number')
            return null;
        const clientType = frame.clientType;
        if (clientType !== 'mobile' && clientType !== 'browser' && clientType !== 'cli' && clientType !== 'mcp' && clientType !== 'hub')
            return null;
        const auth = frame.auth;
        let parsedAuth;
        if (auth !== null && typeof auth === 'object') {
            const record = auth;
            if (record.kind === 'password' && typeof record.password === 'string')
                parsedAuth = { kind: 'password', password: record.password };
            else if (record.kind === 'localCredential' && typeof record.token === 'string')
                parsedAuth = { kind: 'localCredential', token: record.token };
        }
        const hello = {
            clientId: frame.clientId,
            clientType,
            protocolVersion: frame.protocolVersion,
            ...(parsedAuth === undefined ? {} : { auth: parsedAuth }),
            ...(typeof frame.appVersion === 'string' ? { appVersion: frame.appVersion } : {}),
        };
        return { kind: 'hello', hello };
    }
    if (frame.type === 'session' && frame.message !== null && typeof frame.message === 'object') {
        return { kind: 'request', message: frame.message };
    }
    return null;
}
/** Wrap one session message in the WebSocket envelope. */
export function envelope(message) {
    return JSON.stringify({ type: 'session', message });
}
/** The `status` frame sent once per connection right after `hello`. */
export function serverInfo(bridge, hostname) {
    return {
        type: 'status',
        payload: {
            status: 'server_info',
            protocolVersion: PASEO_PROTOCOL_VERSION,
            serverId: bridge.serverId,
            hostname,
            version: PASEO_DAEMON_VERSION,
            daemonVersion: bridge.version,
            permissions: ['daemon.read', 'workspace.read', 'workspace.write', 'workspace.manage'],
            capabilities: { voice: false, pushNotifications: false },
            // Every gate stays off except the status RPC: a client that believes the
            // daemon supports a feature asks for messages this server does not answer.
            features: { daemonStatusRpc: true },
        },
    };
}
/** `pong` for a `ping` frame. */
export function pong() {
    return JSON.stringify({ type: 'pong' });
}
/** A correlated failure for one request. */
export function rpcError(requestId, requestType, message, code = 'unsupported') {
    return { type: 'rpc_error', payload: { requestId, requestType, error: message, code } };
}
/** One workspace as the client's workspace descriptor. */
export function workspaceDescriptor(workspace) {
    const checkout = workspace.checkout.isGit
        ? {
            cwd: workspace.directory,
            isGit: true,
            currentBranch: null,
            remoteUrl: null,
            worktreeRoot: workspace.directory,
            isPaseoOwnedWorktree: false,
            mainRepoRoot: workspace.projectRootPath,
        }
        : {
            cwd: workspace.directory,
            isGit: false,
            currentBranch: null,
            remoteUrl: null,
            worktreeRoot: null,
            isPaseoOwnedWorktree: false,
            mainRepoRoot: null,
        };
    return {
        id: workspace.id,
        projectId: workspace.projectId,
        projectDisplayName: workspace.projectName,
        projectRootPath: workspace.projectRootPath,
        workspaceDirectory: workspace.directory,
        projectKind: workspace.projectKind,
        workspaceKind: 'directory',
        name: workspace.name,
        title: workspace.name,
        pinnedAt: null,
        labels: [],
        archivingAt: null,
        status: workspace.status,
        statusEnteredAt: workspace.statusEnteredAt,
        activityAt: workspace.activityAt,
        scripts: [],
        gitRuntime: {
            currentBranch: null,
            remoteUrl: null,
            isPaseoOwnedWorktree: false,
            isDirty: null,
            aheadBehind: null,
            aheadOfOrigin: null,
            behindOfOrigin: null,
        },
        githubRuntime: { featuresEnabled: false, pullRequest: null, error: null, refreshedAt: null },
        project: {
            projectKey: workspace.projectKey,
            projectName: workspace.projectName,
            workspaceName: workspace.name,
            checkout,
        },
    };
}
/** One project descriptor. */
export function projectDescriptor(workspace) {
    return {
        projectId: workspace.projectId,
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectName,
        projectCustomName: null,
        projectRootPath: workspace.projectRootPath,
        projectKind: workspace.projectKind,
    };
}
/** One placement payload for an agent's project. */
export function placement(workspace) {
    const descriptor = workspaceDescriptor(workspace);
    return descriptor.project;
}
/** One agent snapshot. */
export function agentSnapshot(agent) {
    return {
        id: agent.id,
        provider: agent.provider,
        cwd: agent.cwd,
        workspaceId: agent.workspaceId,
        model: agent.model,
        features: [],
        thinkingOptionId: null,
        effectiveThinkingOptionId: null,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        lastUserMessageAt: agent.lastUserMessageAt,
        status: agent.status,
        activeTurn: agent.activeTurn ?? null,
        capabilities: {
            supportsStreaming: true,
            supportsSessionPersistence: true,
            supportsSessionListing: true,
            supportsDynamicModes: false,
            supportsMcpServers: false,
            supportsReasoningStream: true,
            supportsToolInvocations: true,
        },
        currentModeId: null,
        availableModes: [{ id: 'default', label: 'Default' }],
        pendingPermissions: [],
        persistence: { provider: agent.provider, sessionId: agent.id },
        title: agent.title,
        labels: {},
        requiresAttention: false,
        attentionReason: null,
        attentionTimestamp: null,
        archivedAt: agent.archivedAt ?? null,
    };
}
/** One timeline item in wire form. */
export function timelineItem(item) {
    switch (item.type) {
        case 'user_message':
            return {
                type: 'user_message',
                text: item.text,
                ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
                ...(item.clientMessageId === undefined ? {} : { clientMessageId: item.clientMessageId }),
            };
        case 'assistant_message':
            return {
                type: 'assistant_message',
                text: item.text,
                ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
            };
        case 'reasoning':
            return { type: 'reasoning', text: item.text };
        case 'tool_call':
            return {
                type: 'tool_call',
                callId: item.callId,
                name: item.name,
                status: item.status,
                error: item.error ?? null,
                detail: { type: 'unknown', input: item.input ?? null, output: item.output ?? null },
            };
        case 'error':
            return { type: 'error', message: item.message };
        case 'notification':
            return { type: 'notification', level: item.level, message: item.message };
    }
}
/** One timeline entry in wire form. */
export function timelineEntry(provider, entry) {
    return {
        provider,
        item: timelineItem(entry.item),
        ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }),
        timestamp: entry.timestamp,
        seqStart: entry.seq,
        seqEnd: entry.seq,
        sourceSeqRanges: [{ startSeq: entry.seq, endSeq: entry.seq }],
        collapsed: [],
    };
}
/** `fetch_workspaces_response`. */
export function workspacesResponse(requestId, subscriptionId, workspaces) {
    return {
        type: 'fetch_workspaces_response',
        payload: {
            requestId,
            subscriptionId,
            entries: workspaces.map(workspaceDescriptor),
            emptyProjects: [],
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        },
    };
}
/** `project.list.response`. */
export function projectsResponse(requestId, workspaces) {
    const seen = new Set();
    const projects = [];
    for (const workspace of workspaces) {
        if (seen.has(workspace.projectId))
            continue;
        seen.add(workspace.projectId);
        projects.push(projectDescriptor(workspace));
    }
    return { type: 'project.list.response', payload: { requestId, projects } };
}
/** `fetch_agents_response`. */
export function agentsResponse(requestId, subscriptionId, entries) {
    return {
        type: 'fetch_agents_response',
        payload: {
            requestId,
            subscriptionId,
            entries: entries.map(({ agent, workspace }) => ({ agent: agentSnapshot(agent), project: placement(workspace) })),
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        },
    };
}
/** `fetch_agent_response`. */
export function agentResponse(requestId, agent, workspace, error) {
    return {
        type: 'fetch_agent_response',
        payload: {
            requestId,
            agent: agent === null ? null : agentSnapshot(agent),
            project: workspace === null ? null : placement(workspace),
            error,
        },
    };
}
/** `fetch_agent_timeline_response`. */
export function timelineResponse(requestId, agent, epoch, entries) {
    const seqs = entries.map((entry) => entry.seq);
    const minSeq = seqs.length === 0 ? 0 : Math.min(...seqs);
    const maxSeq = seqs.length === 0 ? 0 : Math.max(...seqs);
    return {
        type: 'fetch_agent_timeline_response',
        payload: {
            requestId,
            agentId: agent.id,
            agent: agentSnapshot(agent),
            direction: 'tail',
            projection: 'projected',
            epoch,
            reset: true,
            staleCursor: false,
            gap: false,
            window: { minSeq, maxSeq, nextSeq: maxSeq + 1 },
            startCursor: null,
            endCursor: null,
            hasOlder: false,
            hasNewer: false,
            entries: entries.map((entry) => timelineEntry(agent.provider, entry)),
            error: null,
        },
    };
}
/** `send_agent_message_response`. */
export function sendMessageResponse(requestId, agent) {
    return {
        type: 'send_agent_message_response',
        payload: { requestId, agentId: agent.id, accepted: true, error: null },
    };
}
/** `send_agent_message_response` for a rejected prompt. */
export function sendMessageRejected(requestId, agentId, error) {
    return { type: 'send_agent_message_response', payload: { requestId, agentId, accepted: false, error } };
}
/** `cancel_agent_response`. */
export function cancelResponse(requestId, agentId, agent) {
    return {
        type: 'cancel_agent_response',
        payload: { requestId, agentId, agent: agent === null ? null : agentSnapshot(agent), error: null },
    };
}
/** `wait_for_finish_response`. */
export function waitForFinishResponse(requestId, status, agent, lastMessage, error = null) {
    return {
        type: 'wait_for_finish_response',
        payload: {
            requestId,
            status,
            final: agent === null ? null : agentSnapshot(agent),
            error,
            lastMessage,
        },
    };
}
/** Statuses an agent settles into, which end a `wait_for_finish_request`. */
export function isSettledStatus(status) {
    return status === 'idle' || status === 'error' || status === 'closed';
}
/** Legacy creation success: a `status` frame, not a correlated response. */
export function agentCreatedStatus(requestId, agent) {
    return { type: 'status', payload: { status: 'agent_created', requestId, agentId: agent.id, agent: agentSnapshot(agent) } };
}
/** Legacy creation failure: a `status` frame, not a correlated response. */
export function agentCreateFailedStatus(requestId, error) {
    return { type: 'status', payload: { status: 'agent_create_failed', requestId, error } };
}
/** `agent.create.response`. */
export function agentCreateResponse(requestId, agent, error) {
    return { type: 'agent.create.response', payload: { requestId, agent: agent === null ? null : agentSnapshot(agent), error } };
}
/** `workspace.create.response`. */
export function workspaceCreateResponse(requestId, workspace, agent, error) {
    return {
        type: 'workspace.create.response',
        payload: {
            requestId,
            workspace: workspace === null ? null : workspaceDescriptor(workspace),
            agent: agent === null ? undefined : agentSnapshot(agent),
            setupTerminalId: null,
            error,
        },
    };
}
/** `get_providers_snapshot_response`. */
export function providersSnapshotResponse(requestId, entries) {
    return {
        type: 'get_providers_snapshot_response',
        payload: {
            entries: entries.map((entry) => ({
                provider: entry.provider,
                status: entry.available ? 'ready' : 'unavailable',
                enabled: true,
                models: entry.models.map((model) => ({
                    provider: entry.provider,
                    id: model.id,
                    label: model.label,
                    isSelectable: true,
                    ...(model.description === undefined ? {} : { description: model.description }),
                })),
                modes: [{ id: 'default', label: 'Default' }],
                defaultModeId: 'default',
                ...(entry.available ? {} : { error: 'no credential is configured for this provider' }),
            })),
            generatedAt: new Date().toISOString(),
            requestId,
        },
    };
}
/** `list_provider_models_response`. */
export function providerModelsResponse(requestId, provider, models) {
    return {
        type: 'list_provider_models_response',
        payload: {
            provider,
            models: models.map((model) => ({
                provider,
                id: model.id,
                label: model.label,
                isSelectable: true,
                ...(model.description === undefined ? {} : { description: model.description }),
            })),
            error: null,
            fetchedAt: new Date().toISOString(),
            requestId,
        },
    };
}
/** `list_available_providers_response`. */
export function availableProvidersResponse(requestId, providers) {
    return {
        type: 'list_available_providers_response',
        payload: {
            providers: providers.map((entry) => ({ provider: entry.provider, available: entry.available, error: null })),
            error: null,
            fetchedAt: new Date().toISOString(),
            requestId,
        },
    };
}
/** `list_provider_modes_response`; DSH has no provider-owned modes. */
export function providerModesResponse(requestId, provider) {
    return {
        type: 'list_provider_modes_response',
        payload: { provider, modes: [{ id: 'default', label: 'Default' }], error: null, fetchedAt: new Date().toISOString(), requestId },
    };
}
/** `checkout_status_response` for one directory. */
export function checkoutStatusResponse(requestId, directory, status) {
    const common = { cwd: directory, error: null, requestId, isPaseoOwnedWorktree: false };
    if (!status.isGit) {
        return {
            type: 'checkout_status_response',
            payload: {
                ...common,
                isGit: false,
                repoRoot: null,
                currentBranch: null,
                isDirty: null,
                baseRef: null,
                aheadBehind: null,
                aheadOfOrigin: null,
                behindOfOrigin: null,
                hasRemote: false,
                remoteUrl: null,
            },
        };
    }
    const ahead = status.aheadOfOrigin;
    const behind = status.behindOfOrigin;
    return {
        type: 'checkout_status_response',
        payload: {
            ...common,
            isGit: true,
            repoRoot: status.repoRoot ?? directory,
            mainRepoRoot: null,
            currentBranch: status.currentBranch,
            isDirty: status.isDirty,
            baseRef: null,
            aheadBehind: ahead === null || behind === null ? null : { ahead, behind },
            aheadOfOrigin: ahead,
            behindOfOrigin: behind,
            hasRemote: status.hasRemote,
            remoteUrl: status.remoteUrl,
            upstreamRef: status.upstreamRef,
        },
    };
}
/** Shared body of every checkout-diff frame. */
function diffPayload(directory, files) {
    return {
        cwd: directory,
        files: files.map((file) => ({
            path: file.path,
            ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
            isNew: file.isNew,
            isDeleted: file.isDeleted,
            additions: file.additions,
            deletions: file.deletions,
            hunks: file.hunks.map((hunk) => ({
                oldStart: hunk.oldStart,
                oldCount: hunk.oldCount,
                newStart: hunk.newStart,
                newCount: hunk.newCount,
                lines: hunk.lines.map((line) => ({ type: line.type, content: line.content })),
            })),
            ...(file.status === undefined ? {} : { status: file.status }),
        })),
        error: null,
    };
}
/** `checkout.diff.get.response`, the one-shot read. */
export function checkoutDiffGetResponse(requestId, directory, files) {
    return { type: 'checkout.diff.get.response', payload: { ...diffPayload(directory, files), requestId } };
}
/** `subscribe_checkout_diff_response`, the opening frame of a live subscription. */
export function subscribeCheckoutDiffResponse(requestId, subscriptionId, directory, files) {
    return {
        type: 'subscribe_checkout_diff_response',
        payload: { subscriptionId, ...diffPayload(directory, files), requestId },
    };
}
/** `checkout_diff_update`, sent when the working tree changed under a subscription. */
export function checkoutDiffUpdate(subscriptionId, directory, files) {
    return { type: 'checkout_diff_update', payload: { subscriptionId, ...diffPayload(directory, files) } };
}
/** `agent_update` upsert. */
export function agentUpdate(agent, workspace) {
    return {
        type: 'agent_update',
        payload: {
            kind: 'upsert',
            agent: agentSnapshot(agent),
            project: workspace === null ? null : placement(workspace),
        },
    };
}
/** `agent_update` remove. */
export function agentRemoved(agentId) {
    return { type: 'agent_update', payload: { kind: 'remove', agentId } };
}
/** `agent_status`. */
export function agentStatus(agent) {
    return { type: 'agent_status', payload: { agentId: agent.id, status: agent.status, info: agentSnapshot(agent) } };
}
/** `agent_stream` carrying one timeline row. */
export function agentStream(agent, entry, epoch) {
    return {
        type: 'agent_stream',
        payload: {
            agentId: agent.id,
            event: { type: 'timeline', provider: agent.provider, item: timelineItem(entry.item), ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }) },
            timestamp: entry.timestamp,
            seq: entry.seq,
            epoch,
        },
    };
}
/** `workspace_update` upsert. */
export function workspaceUpdate(workspace) {
    return { type: 'workspace_update', payload: { kind: 'upsert', workspace: workspaceDescriptor(workspace) } };
}
/** `daemon.get_status.response`. */
export function daemonStatus(input) {
    return {
        type: 'daemon.get_status.response',
        payload: {
            requestId: input.requestId,
            serverId: input.serverId,
            version: input.version,
            pid: process.pid,
            nodePath: process.execPath,
            startedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
            listen: input.listen,
            relay: null,
            providers: input.providers.map((entry) => ({ provider: entry.provider, available: entry.available, error: null })),
        },
    };
}
/** One terminal in the client's shape. */
export function terminalInfo(record) {
    return {
        id: record.id,
        name: record.title.length > 0 ? record.title : 'Terminal',
        cwd: record.cwd,
        workspaceId: record.workspaceId,
        title: record.title,
        activity: null,
    };
}
/** `list_terminals_response`. */
export function terminalsResponse(requestId, terminals) {
    return { type: 'list_terminals_response', payload: { requestId, terminals: terminals.map(terminalInfo) } };
}
/** `create_terminal_response`. */
export function terminalCreated(requestId, terminal, error) {
    return {
        type: 'create_terminal_response',
        payload: { requestId, terminal: terminal === null ? null : terminalInfo(terminal), error },
    };
}
/** `subscribe_terminal_response`, which hands the client its stream slot. */
export function terminalSubscribed(requestId, terminalId, slot, subscriptionId) {
    return {
        type: 'subscribe_terminal_response',
        payload: {
            requestId,
            terminalId,
            slot,
            error: null,
            ...(subscriptionId === undefined ? {} : { subscriptionId }),
        },
    };
}
/** `subscribe_terminal_response` for a terminal that cannot be attached. */
export function terminalSubscribeFailed(requestId, terminalId, error) {
    return { type: 'subscribe_terminal_response', payload: { requestId, terminalId, error } };
}
/** `kill_terminal_response`. */
export function terminalKilled(requestId, terminalId, success) {
    return { type: 'kill_terminal_response', payload: { requestId, terminalId, success } };
}
/** `terminal.rename.response`. */
export function terminalRenamed(requestId, terminalId, title) {
    return { type: 'terminal.rename.response', payload: { requestId, terminalId, title, error: null } };
}
/** `terminals_changed`, which tells every client to re-list. */
export function terminalsChanged(terminals) {
    return { type: 'terminals_changed', payload: { terminals: terminals.map(terminalInfo) } };
}
/** `subscription.release.response`. */
export function subscriptionReleased(requestId) {
    return { type: 'subscription.release.response', payload: { requestId } };
}
/** `session.events.set_subscription.response`. */
export function eventsSubscriptionSet(requestId) {
    return { type: 'session.events.set_subscription.response', payload: { requestId } };
}
/** `clear_agent_attention_response`. */
export function attentionCleared(requestId) {
    return { type: 'clear_agent_attention_response', payload: { requestId } };
}
/** Statuses whose agents the client shows as needing attention. */
export const ATTENTION_STATUSES = ['idle', 'error'];
/** One workspace script in the client's shape. */
export function workspaceScript(record) {
    return {
        scriptName: record.name,
        type: record.type,
        // A script runs inside this machine's shell; the daemon itself is the host.
        hostname: 'localhost',
        port: record.port,
        localProxyUrl: null,
        publicProxyUrl: null,
        proxyUrl: null,
        lifecycle: record.lifecycle,
        health: record.health,
        exitCode: record.exitCode,
        terminalId: null,
    };
}
/** One `workspace.script.*` response, which all three requests share. */
export function workspaceScriptResponse(type, requestId, workspaceId, scripts, error = null, scriptName) {
    return {
        type,
        payload: {
            requestId,
            workspaceId,
            ...(scriptName === undefined ? {} : { scriptName }),
            scripts: scripts.map(workspaceScript),
            error,
        },
    };
}
/** `script_status_update`, which tells clients to re-list a workspace's scripts. */
export function scriptStatusUpdate(workspaceId, scripts) {
    return { type: 'script_status_update', payload: { workspaceId, scripts: scripts.map(workspaceScript) } };
}
/** `agent_deleted`, the answer to a delete request this daemon archives instead. */
export function agentDeleted(agentId) {
    return { type: 'agent_deleted', payload: { agentId } };
}
/** `schedule/list/response`. */
export function scheduleList(requestId, schedules) {
    return { type: 'schedule/list/response', payload: { requestId, schedules: schedules.map(scheduleSummary), error: null } };
}
/** `schedule/create/response`. */
export function scheduleCreated(requestId, schedule, error) {
    return {
        type: 'schedule/create/response',
        payload: { requestId, schedule: schedule === null ? null : scheduleSummary(schedule), error },
    };
}
/** `schedule/delete/response`. */
export function scheduleDeleted(requestId, scheduleId, error = null) {
    return { type: 'schedule/delete/response', payload: { requestId, scheduleId, error } };
}
/** `schedule/run-once/response`. */
export function scheduleRanOnce(requestId, scheduleId, error = null) {
    return { type: 'schedule/run-once/response', payload: { requestId, scheduleId, error } };
}
/** One reminder in the client's shape. */
function scheduleSummary(record) {
    return {
        id: record.id,
        name: record.name,
        prompt: record.prompt,
        cadence: record.cadence,
        target: { type: 'agent', agentId: record.agentId },
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
        nextRunAt: record.nextRunAt,
        lastRunAt: null,
        pausedAt: null,
        expiresAt: null,
        maxRuns: null,
    };
}
/** `checkout_pr_status_response`. */
export function checkoutPrStatusResponse(requestId, directory, lookup) {
    const status = lookup.status;
    return {
        type: 'checkout_pr_status_response',
        payload: {
            cwd: directory,
            status: status === null
                ? null
                : {
                    forge: 'github',
                    projectPath: directory,
                    number: status.number,
                    url: status.url,
                    title: status.title,
                    state: status.state,
                    baseRefName: status.baseRefName,
                    headRefName: status.headRefName,
                    isMerged: status.isMerged,
                    isDraft: status.isDraft,
                    mergeable: status.mergeable,
                    checks: status.checks.map((check) => ({ name: check.name, status: check.status, url: check.url })),
                    checksStatus: null,
                    reviewDecision: null,
                    repoOwner: status.repoOwner,
                    repoName: status.repoName,
                },
            // Features follow authentication, not whether this branch happens to have a pull request.
            githubFeaturesEnabled: lookup.authenticated,
            authState: lookup.authenticated ? 'authenticated' : 'unauthenticated',
            forge: 'github',
            error: lookup.error === null ? null : { code: 'UNKNOWN', message: lookup.error },
            requestId,
        },
    };
}
