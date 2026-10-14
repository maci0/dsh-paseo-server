/**
 * Paseo wire format: the session messages this daemon emits and accepts.
 *
 * Field sets and required flags mirror the Paseo 0.11.2 protocol schemas. The
 * shapes are protocol facts; this module encodes only the subset a client
 * needs to list workspaces and agents, read a timeline, and drive a turn.
 *
 * @module dsh-paseo-server/paseo/wire
 */
import { PROXY_PREFIX } from './script-proxy.js';
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
    'archive_workspace_request',
    'project.add.request',
    'project.remove.request',
    'project.rename.request',
    'project.icon.get.request',
    'project.icon.set.request',
    'project_icon_request',
    'directory_suggestions_request',
    'read_project_config_request',
    'agent.provider_subagents.list.request',
    'agent.fork_context.request',
    'set_agent_model_request',
    'write_project_config_request',
    'workspace.pin.set.request',
    'workspace.title.set.request',
    'workspace.clear_attention.request',
    'file_explorer_request',
    'fetch_agent_history_request',
    'list_commands_request',
    'diagnostics.request',
    'provider.usage.list.request',
    'usage.list_reports.request',
    'get_daemon_config_request',
    'project.create_directory.request',
    'project.github.clone.request',
    'workspace.github.search_repositories.request',
    'forge.search.request',
    'github_search_request',
    'refresh_providers_snapshot_request',
    'list_provider_modes_request',
    'list_provider_features_request',
    'start_workspace_script_request',
    'set_agent_thinking_request',
    'set_agent_mode_request',
    'set_agent_feature_request',
    'agent.provider_subagents.timeline.get.request',
    'workspace.setup.run.request',
    'resume_agent_request',
    'workspace_setup_status_request',
    'restart_server_request',
    'shutdown_server_request',
    'daemon.config.reload.request',
    'set_daemon_config_request',
    'daemon.update.request',
    'push.unregister.request',
    'agent.rewind.request',
    'agent.detach.request',
    'agent.timeline.append.request',
    'agent.config.apply.request',
    'agent.skills.save_selection.request',
    'agent.skills.import_legacy_selection.request',
    'import_agent_request',
    'fetch_recent_provider_sessions_request',
    'creation.subscribe.request',
    'capture_terminal_request',
    'workspace.recovery.inspect.request',
    'workspace.recovery.restore.request',
    'workspace.label.list.request',
    'workspace.label.update.request',
    'workspace.label.delete.request',
    'workspace.label.delete.inspect.request',
    'workspace.label.assignment.set.request',
    'project.rename.request',
    'project.icon.get.request',
    'project.icon.set.request',
    'project_icon_request',
    'open_project_request',
    'provider.usage.list.request',
    'usage.list_reports.request',
    'provider_diagnostic_request',
    'hub.execution.agent.create.request',
    'hub.execution.agent.validate.request',
    'hub.execution.control.request',
    'hub.management.daemon.connect.request',
    'hub.management.daemon.disconnect.request',
    'hub.management.daemon.get_status.request',
    'hub.management.daemon.permissions.update.request',
    'plugin.list.request',
    'plugin.catalog.get.request',
    'plugin.logs.get.request',
    'plugin.rpc.invoke.request',
    'plugin.directory.inspect.request',
    'plugin.directory.install.request',
    'plugin.source.install.request',
    'plugin.source.status.request',
    'plugin.source.update.request',
    'plugin.source.update.preview.request',
    'plugin.source.update.apply.request',
    'browser.host.register.request',
    'paseo_worktree_list_request',
    'create_paseo_worktree_request',
    'paseo_worktree_archive_request',
    'refresh_agent_request',
    'update_agent_request',
    'abort_request',
    'agent.timeline.set_subscription.request',
    'agent.timeline.search.request',
    'agent.timeline.list_prompts.request',
    'fs.file.subscribe.request',
    'fs.file.unsubscribe.request',
    'fs.file.write.request',
    'fs.entry.create.request',
    'fs.entry.rename.request',
    'fs.entry.duplicate.request',
    'fs.entry.delete.request',
    'file_download_token_request',
    'file.upload.request',
    'list_available_editors_request',
    'open_in_editor_request',
    'branch_suggestions_request',
    'validate_branch_request',
    'checkout_switch_branch_request',
    'checkout.rename_branch.request',
    'checkout.discard_changes.request',
    'stash_save_request',
    'stash_pop_request',
    'stash_list_request',
    'checkout_merge_request',
    'checkout_merge_from_base_request',
    'checkout.commits.list.request',
    'checkout.commits.file_diff.request',
    'checkout_pr_create_request',
    'checkout_pr_merge_request',
    'checkout.forge.set_auto_merge.request',
    'checkout.github.set_auto_merge.request',
    'pull_request_timeline_request',
    'checkout.forge.get_check_details.request',
    'checkout.github.get_check_details.request',
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
        projectCustomName: workspace.customProjectName ?? null,
        projectRootPath: workspace.projectRootPath,
        workspaceDirectory: workspace.directory,
        projectKind: workspace.projectKind,
        workspaceKind: 'directory',
        name: workspace.name,
        title: workspace.name,
        pinnedAt: null,
        labels: [...workspace.labels],
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
        projectCustomName: workspace.customProjectName ?? null,
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
/** `update_agent_response`, which carries the agent after the change. */
export function agentUpdateResponse(requestId, agent, workspace, error) {
    return {
        type: 'update_agent_response',
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
/** One changed file in the client's shape. */
function diffFileWire(file) {
    return {
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
    };
}
/** Shared body of every checkout-diff frame. */
function diffPayload(directory, files) {
    return {
        cwd: directory,
        files: files.map(diffFileWire),
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
/**
 * One workspace script in the client's shape.
 * @param record - the script and its lifecycle.
 * @param proxyBase - base a client can reach this daemon on, for the local proxy URL.
 */
export function workspaceScript(record, proxyBase) {
    const proxyUrl = proxyBase === undefined || record.port === null || record.lifecycle !== 'running'
        ? null
        : `${proxyBase}${PROXY_PREFIX}/${record.workspaceId}/${encodeURIComponent(record.name)}`;
    return {
        scriptName: record.name,
        type: record.type,
        // A script runs inside this machine's shell; the daemon itself is the host.
        hostname: 'localhost',
        port: record.port,
        localProxyUrl: proxyUrl,
        // No tunnel is published, so the same URL is only reachable where the
        // daemon is, which is what the local field means.
        publicProxyUrl: null,
        proxyUrl,
        lifecycle: record.lifecycle,
        health: record.health,
        exitCode: record.exitCode,
        terminalId: null,
    };
}
/** One `workspace.script.*` response, which all three requests share. */
export function workspaceScriptResponse(type, requestId, workspaceId, scripts, error = null, scriptName, proxyBase) {
    return {
        type,
        payload: {
            requestId,
            workspaceId,
            ...(scriptName === undefined ? {} : { scriptName }),
            scripts: scripts.map((record) => workspaceScript(record, proxyBase)),
            error,
        },
    };
}
/** `script_status_update`, which tells clients to re-list a workspace's scripts. */
export function scriptStatusUpdate(workspaceId, scripts, proxyBase) {
    return {
        type: 'script_status_update',
        payload: { workspaceId, scripts: scripts.map((record) => workspaceScript(record, proxyBase)) },
    };
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
        pausedAt: record.pausedAt,
        expiresAt: record.expiresAt,
        maxRuns: record.maxRuns,
    };
}
/** `schedule/pause/response`. */
export function schedulePaused(requestId, scheduleId, error) {
    return { type: 'schedule/pause/response', payload: { requestId, scheduleId, error } };
}
/** `schedule/resume/response`. */
export function scheduleResumed(requestId, scheduleId, schedule, error) {
    return {
        type: 'schedule/resume/response',
        payload: { requestId, scheduleId, schedule: schedule === null ? null : scheduleSummary(schedule), error },
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
/** `checkout_pr_create_response`. */
export function pullRequestCreated(requestId, directory, result) {
    return {
        type: 'checkout_pr_create_response',
        payload: {
            cwd: directory,
            url: result.url,
            number: result.number,
            error: result.error === null ? null : { code: 'UNKNOWN', message: result.error },
            requestId,
        },
    };
}
/** `checkout_pr_merge_response` and its auto-merge sibling. */
export function pullRequestWriteResponse(type, requestId, directory, result, enabled) {
    return {
        type,
        payload: {
            cwd: directory,
            ...(enabled === undefined ? {} : { enabled }),
            success: result.success,
            error: result.error === null ? null : { code: 'UNKNOWN', message: result.error },
            requestId,
        },
    };
}
/** `pull_request_timeline_response`. */
export function pullRequestTimelineResponse(requestId, directory, number, items, error) {
    return {
        type: 'pull_request_timeline_response',
        payload: {
            cwd: directory,
            prNumber: number,
            items: items.map((item) => ({
                id: item.id,
                kind: item.kind,
                author: item.author,
                body: item.body,
                createdAt: item.createdAt,
                url: item.url,
                ...(item.reviewState === undefined ? {} : { reviewState: item.reviewState }),
            })),
            truncated: false,
            error: error === null ? null : { kind: 'unknown', message: error },
            requestId,
            githubFeaturesEnabled: error === null,
            authState: error === null ? 'authenticated' : 'unauthenticated',
        },
    };
}
/** `checkout.forge.get_check_details.response` and its GitHub sibling. */
export function checkDetailsResponse(type, requestId, directory, details, error) {
    return {
        type,
        payload: {
            cwd: directory,
            success: details !== null,
            details,
            error: error === null ? null : { code: 'UNKNOWN', message: error },
            requestId,
        },
    };
}
/** `branch_suggestions_response`. */
export function branchSuggestions(requestId, branches, error = null) {
    return {
        type: 'branch_suggestions_response',
        payload: {
            branches: branches.map((branch) => branch.name),
            branchDetails: branches.map((branch) => ({
                name: branch.name,
                committerDate: branch.committerDate,
                hasLocal: branch.hasLocal,
                hasRemote: branch.hasRemote,
            })),
            error,
            requestId,
        },
    };
}
/** `validate_branch_response`. */
export function branchValidated(requestId, result) {
    return {
        type: 'validate_branch_response',
        payload: { requestId, exists: result.exists, resolvedRef: result.resolvedRef, isRemote: result.isRemote, error: null },
    };
}
/** `stash_list_response`. */
export function stashEntries(requestId, directory, entries) {
    return { type: 'stash_list_response', payload: { cwd: directory, entries: [...entries], error: null, requestId } };
}
/** `checkout.commits.list.response`. */
export function commitList(requestId, directory, commits, baseRef = null) {
    return {
        type: 'checkout.commits.list.response',
        payload: { cwd: directory, baseRef, commits: commits.map((commit) => ({ ...commit, isOnBase: false })), error: null, requestId },
    };
}
/** `checkout.commits.file_diff.response`, carrying the same parsed files as a working diff. */
export function commitDiff(requestId, directory, sha, path, files) {
    return {
        type: 'checkout.commits.file_diff.response',
        payload: { cwd: directory, sha, path, files: files.map(diffFileWire), error: null, requestId },
    };
}
/** `file_explorer_response` for a directory listing. */
export function directoryListing(requestId, directory, path, entries) {
    return {
        type: 'file_explorer_response',
        payload: {
            cwd: directory,
            path,
            mode: 'list',
            directory: { path, entries: entries.map((entry) => ({ ...entry })) },
            file: null,
            error: null,
            requestId,
        },
    };
}
/** `file_explorer_response` for one file. */
export function fileContents(requestId, directory, path, file, error) {
    return {
        type: 'file_explorer_response',
        payload: { cwd: directory, path, mode: 'file', directory: null, file, error, requestId },
    };
}
/** `list_available_editors_response`, which names the editors a client may open in. */
export function availableEditors(requestId, editors) {
    return { type: 'list_available_editors_response', payload: { requestId, editors: [...editors], error: null } };
}
/** `open_in_editor_response`. */
export function openedInEditor(requestId, error) {
    return { type: 'open_in_editor_response', payload: { requestId, error } };
}
/** `archive_workspace_response`. */
export function workspaceArchived(requestId, workspaceId, success) {
    return { type: 'archive_workspace_response', payload: { requestId, workspaceId, success, error: null } };
}
/** `workspace.pin.set.response`. */
export function workspacePinned(requestId, workspaceId, accepted, pinnedAt, error) {
    return { type: 'workspace.pin.set.response', payload: { requestId, workspaceId, accepted, pinnedAt, error } };
}
/** `workspace.title.set.response`, which reports that this daemon cannot retitle. */
export function workspaceTitleSet(requestId, workspaceId, accepted, title, error) {
    return { type: 'workspace.title.set.response', payload: { requestId, workspaceId, accepted, title, error } };
}
/** `workspace.clear_attention.response`. */
export function attentionClearedFor(requestId, workspaceIds, clearedAgentIds) {
    const results = workspaceIds.map((workspaceId) => ({ workspaceId, clearedAgentIds: [...clearedAgentIds], success: true, error: null }));
    return {
        type: 'workspace.clear_attention.response',
        payload: {
            requestId,
            workspaceId: workspaceIds.length === 1 ? workspaceIds[0] ?? '' : [...workspaceIds],
            clearedAgentIds: [...clearedAgentIds],
            results,
            error: null,
        },
    };
}
/** `workspace.mark_unread.response`. */
export function workspaceMarkedUnread(requestId, workspaceId, markedAgentId, success, error) {
    return { type: 'workspace.mark_unread.response', payload: { requestId, workspaceId, markedAgentId, success, error } };
}
/** `project.add.response`. */
export function projectAdded(requestId, workspace, error) {
    return {
        type: 'project.add.response',
        payload: {
            requestId,
            project: workspace === null ? null : placement(workspace),
            error,
            errorCode: workspace === null && error !== null ? 'directory_not_found' : null,
        },
    };
}
/** `project.remove.response`. */
export function projectRemoved(requestId, projectId, workspaceIds, error) {
    return {
        type: 'project.remove.response',
        payload: { requestId, projectId, accepted: error === null, removedWorkspaceIds: [...workspaceIds], error },
    };
}
/** `directory_suggestions_response`. */
export function directorySuggestions(requestId, entries, includeFiles) {
    const directories = entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path);
    return {
        type: 'directory_suggestions_response',
        payload: {
            directories,
            entries: includeFiles ? entries.map((entry) => ({ path: entry.path, kind: entry.kind })) : [],
            error: null,
            requestId,
        },
    };
}
/** `read_project_config_response`. */
export function projectConfigRead(requestId, repoRoot, config, revision) {
    return { type: 'read_project_config_response', payload: { requestId, repoRoot, ok: true, config, revision } };
}
/** `read_project_config_response` for a directory this daemon does not serve. */
export function projectConfigMissing(requestId, repoRoot, code) {
    return { type: 'read_project_config_response', payload: { requestId, repoRoot, ok: false, error: { code } } };
}
/** `write_project_config_response`. */
export function projectConfigWritten(requestId, repoRoot, config, revision) {
    return {
        type: 'write_project_config_response',
        payload: { requestId, repoRoot, ok: true, config, revision },
    };
}
/** `write_project_config_response` failure. */
export function projectConfigWriteFailed(requestId, repoRoot, code) {
    return { type: 'write_project_config_response', payload: { requestId, repoRoot, ok: false, error: { code } } };
}
/** One of the agent action responses, which share a payload. */
export function agentActionResponse(type, requestId, agentId, accepted, error) {
    return { type, payload: { requestId, agentId, accepted, error, notice: null } };
}
/** `agent.fork_context.response`. */
export function forkContextResponse(requestId, agentId, context) {
    return {
        type: 'agent.fork_context.response',
        payload: {
            requestId,
            agentId,
            attachment: context.itemCount === 0
                ? null
                : { type: 'text', mimeType: 'text/plain', contextKind: 'chat_history', title: 'Conversation', text: context.text },
            itemCount: context.itemCount,
            boundaryMessageId: context.boundaryMessageId,
            boundaryCursor: null,
            error: null,
        },
    };
}
/** `agent.provider_subagents.list.response`. */
export function subagentList(requestId, parentAgentId, subagents) {
    return {
        type: 'agent.provider_subagents.list.response',
        payload: {
            requestId,
            parentAgentId,
            subagents: subagents.map((agent) => ({
                id: agent.id,
                parentAgentId,
                parentSubagentId: null,
                provider: agent.provider,
                title: agent.title,
                description: null,
                status: agent.status === 'running' ? 'running' : agent.status === 'error' ? 'failed' : 'completed',
                createdAt: agent.createdAt,
                updatedAt: agent.updatedAt,
                toolCallId: null,
                cwd: agent.cwd,
                subtitle: null,
            })),
            error: null,
        },
    };
}
/** `fs.file.write.response` for a write result. */
export function fileWriteResponse(requestId, outcome) {
    const result = outcome.status === 'written'
        ? { status: 'written', modifiedAt: outcome.modifiedAt, size: outcome.size }
        : outcome.status === 'conflict'
            ? { status: 'conflict', version: { modifiedAt: outcome.modifiedAt, size: outcome.size, revision: null } }
            : { status: 'error', error: outcome.error };
    return { type: 'fs.file.write.response', payload: { result, requestId } };
}
/** One `fs.entry.*` response. */
export function entryResponse(type, requestId, directory, path, outcome) {
    const success = outcome.error === undefined;
    if (type === 'fs.entry.delete.response') {
        return { type, payload: { cwd: directory, path, success, error: outcome.error ?? null, requestId } };
    }
    if (type === 'fs.entry.create.response') {
        return {
            type,
            payload: { cwd: directory, parentPath: path, path: outcome.path ?? null, success, error: outcome.error ?? null, requestId },
        };
    }
    const field = type === 'fs.entry.rename.response' ? 'renamedPath' : 'duplicatedPath';
    return {
        type,
        payload: { cwd: directory, path, [field]: outcome.path ?? null, success, error: outcome.error ?? null, requestId },
    };
}
/** `file_download_token_response`. */
export function downloadGrantResponse(requestId, directory, path, grant, error) {
    return {
        type: 'file_download_token_response',
        payload: {
            cwd: directory,
            path,
            token: grant?.token ?? null,
            fileName: grant?.fileName ?? null,
            mimeType: grant?.mimeType ?? null,
            size: grant?.size ?? null,
            error,
            requestId,
        },
    };
}
/** `file.upload.response`, sent once the last chunk landed. */
export function uploadResponse(requestId, target, error) {
    return {
        type: 'file.upload.response',
        payload: {
            requestId,
            file: target === null
                ? null
                : {
                    type: 'uploaded_file',
                    id: target.id,
                    fileName: target.fileName,
                    mimeType: target.mimeType,
                    size: target.expectedSize,
                    path: target.path,
                },
            error,
        },
    };
}
/** `fetch_agent_history_response`, the paginated directory. */
export function agentHistory(requestId, rows, nextCursor, hasMore) {
    return {
        type: 'fetch_agent_history_response',
        payload: {
            requestId,
            entries: rows.map(({ agent, workspace }) => ({ agent: agentSnapshot(agent), project: placement(workspace) })),
            pageInfo: { nextCursor, prevCursor: null, hasMore },
        },
    };
}
/** `agent.timeline.search.response`. */
export function timelineSearchResult(requestId, agentId, epoch, result) {
    return {
        type: 'agent.timeline.search.response',
        payload: {
            requestId,
            agentId,
            epoch,
            locations: result.locations.map((location) => ({ seq: location.seq, role: location.role, count: location.count })),
            nextCursor: result.nextCursor,
            error: null,
        },
    };
}
/** `agent.timeline.list_prompts.response`. */
export function timelinePrompts(requestId, agentId, epoch, prompts) {
    return {
        type: 'agent.timeline.list_prompts.response',
        payload: { requestId, agentId, epoch, prompts: prompts.map((prompt) => ({ ...prompt })), error: null },
    };
}
/** `fs.file.subscribe.response`, opening a file watch. */
export function fileSubscribed(requestId, subscriptionId, version) {
    return { type: 'fs.file.subscribe.response', payload: { subscriptionId, initial: version, requestId } };
}
/** `fs.file.update`, sent when a watched file changed. */
export function fileUpdated(subscriptionId, version) {
    return { type: 'fs.file.update', payload: { subscriptionId, version } };
}
/** `fs.file.unsubscribe.response`. */
export function fileUnsubscribed(requestId, subscriptionId) {
    return { type: 'fs.file.unsubscribe.response', payload: { subscriptionId, requestId } };
}
/** `agent.provider_subagents.timeline.get.response`, the child session's rows. */
export function subagentTimeline(requestId, parentAgentId, subagentId, provider, entries, error) {
    const seqs = entries.map((entry) => entry.seq);
    const minSeq = seqs.length === 0 ? 0 : Math.min(...seqs);
    const maxSeq = seqs.length === 0 ? 0 : Math.max(...seqs);
    const sealed = entries.map((entry) => timelineEntry(provider, entry));
    return {
        type: 'agent.provider_subagents.timeline.get.response',
        payload: {
            requestId,
            parentAgentId,
            subagentId,
            provider: null,
            direction: 'tail',
            epoch: `epoch/${subagentId}`,
            reset: false,
            staleCursor: false,
            gap: false,
            window: { minSeq, maxSeq, nextSeq: maxSeq + 1 },
            hasOlder: false,
            entries: sealed,
            error,
        },
    };
}
/** `workspace.setup.run.response`. */
export function workspaceSetupStarted(requestId, workspaceId, started, error) {
    return { type: 'workspace.setup.run.response', payload: { requestId, workspaceId, started, error } };
}
/** `workspace_setup_status_response`, which reports no setup when none ran. */
export function workspaceSetupStatus(requestId, workspaceId, snapshot) {
    return { type: 'workspace_setup_status_response', payload: { requestId, workspaceId, snapshot } };
}
/** `paseo_worktree_list_response`. */
export function worktreeList(requestId, worktrees) {
    return {
        type: 'paseo_worktree_list_response',
        payload: {
            worktrees: worktrees.map((entry) => ({
                worktreePath: entry.path,
                createdAt: new Date().toISOString(),
                branchName: entry.branch,
                head: entry.head,
            })),
            error: null,
            requestId,
        },
    };
}
/** `create_paseo_worktree_response`. */
export function worktreeCreated(requestId, workspace, error) {
    return {
        type: 'create_paseo_worktree_response',
        payload: {
            workspace: workspace === null ? null : workspaceDescriptor(workspace),
            error,
            ...(error === null ? {} : { errorCode: 'worktree_create_failed' }),
            // Nothing here opens a setup terminal; the setup command runs as a job.
            setupTerminalId: null,
            setupSkippedReason: 'setup runs as a background job in this daemon',
            requestId,
        },
    };
}
/** `paseo_worktree_archive_response`. */
export function worktreeArchived(requestId, success, error) {
    return { type: 'paseo_worktree_archive_response', payload: { success, removedAgents: [], error, requestId } };
}
/** `list_commands_response`. */
export function commandList(requestId, agentId, commands) {
    return {
        type: 'list_commands_response',
        payload: {
            agentId,
            commands: commands.map((command) => ({
                name: command.name,
                description: command.description,
                argumentHint: command.argumentHint,
                kind: 'command',
            })),
            error: null,
            requestId,
        },
    };
}
/** `diagnostics.response`, a snapshot of what this daemon is doing. */
export function diagnosticsResponse(requestId, facts) {
    return { type: 'diagnostics.response', payload: { requestId, ...facts } };
}
/** `get_daemon_config_response`. */
export function daemonConfigResponse(requestId, config, error = null) {
    return { type: 'get_daemon_config_response', payload: { requestId, config, error } };
}
/** `project.create_directory.response`. */
export function projectDirectoryCreated(requestId, path, workspace, error) {
    return {
        type: 'project.create_directory.response',
        payload: {
            requestId,
            directoryPath: path,
            workspace: workspace === null ? null : workspaceDescriptor(workspace),
            error,
            errorCode: error === null ? null : 'create_failed',
        },
    };
}
/** `project.github.clone.response`. */
export function projectCloned(requestId, repo, checkoutPath, workspace, error) {
    return {
        type: 'project.github.clone.response',
        payload: {
            requestId,
            repo,
            checkoutPath,
            workspace: workspace === null ? null : workspaceDescriptor(workspace),
            error,
        },
    };
}
/**
 * Surfaces this daemon refuses on purpose, with the reason a client shows.
 *
 * Each entry maps a request to the response type its client waits for. The
 * alternative, a generic protocol error, tells the operator nothing about why
 * the action is missing.
 */
export const REFUSED_REQUESTS = {
    'restart_server_request': { response: 'restart_server_response', reason: 'this daemon does not restart the harness it runs inside; restart dsh web on the host' },
    'shutdown_server_request': { response: 'shutdown_server_response', reason: 'this daemon does not stop the harness it runs inside; stop dsh web on the host' },
    'daemon.config.reload.request': { response: 'daemon.config.reload.response', reason: 'configuration is owned by the harness composition on the host' },
    'set_daemon_config_request': { response: 'set_daemon_config_response', reason: 'configuration is owned by the harness composition on the host' },
    'daemon.update.request': { response: 'daemon.update.response', reason: 'update the plugin through the harness package manager on the host' },
    'push.unregister.request': { response: 'push.unregister.response', reason: 'this daemon sends no push notifications' },
    'agent.rewind.request': { response: 'agent.rewind.response', reason: 'a session log is append-only; there is no rewind' },
    'agent.detach.request': { response: 'agent.detach.response', reason: 'a session detaches when its last client disconnects' },
    'agent.timeline.append.request': { response: 'agent.timeline.append.response', reason: 'timeline rows are written by turns, not by clients' },
    'agent.config.apply.request': { response: 'agent.config.apply.response', reason: 'agent configuration lives in the harness composition' },
    'agent.skills.save_selection.request': { response: 'agent.skills.save_selection.response', reason: 'this daemon has no per-agent skill selection' },
    'agent.skills.import_legacy_selection.request': { response: 'agent.skills.import_legacy_selection.response', reason: 'this daemon has no per-agent skill selection' },
    'import_agent_request': { response: 'import_agent_response', reason: 'importing a provider session is not supported; sessions live in the harness' },
    'fetch_recent_provider_sessions_request': { response: 'fetch_recent_provider_sessions_response', reason: 'this daemon keeps no provider-session index' },
    'creation.subscribe.request': { response: 'creation.subscribe.response', reason: 'creation progress is reported on the request that started it' },
    'capture_terminal_request': { response: 'capture_terminal_response', reason: 'attach to the terminal and read its stream instead' },
    'workspace.recovery.inspect.request': { response: 'workspace.recovery.inspect.response', reason: 'this daemon keeps no worktree recovery journal' },
    'workspace.recovery.restore.request': { response: 'workspace.recovery.restore.response', reason: 'this daemon keeps no worktree recovery journal' },
    'open_project_request': { response: 'open_project_response', reason: 'opening a project is a client action; this daemon only serves it' },
    'provider_diagnostic_request': { response: 'provider_diagnostic_response', reason: 'provider diagnostics belong to the harness LLM composition' },
    'voice_input_state': { response: 'voice_input_state', reason: 'this daemon has no voice input' },
    'browser.host.register.request': { response: 'browser.host.register.response', reason: 'this daemon hosts no browser' },
    'hub.execution.agent.create.request': { response: 'hub.execution.agent.create.response', reason: 'this daemon does not run cloud executions' },
    'hub.execution.agent.validate.request': { response: 'hub.execution.agent.validate.response', reason: 'this daemon does not run cloud executions' },
    'hub.execution.control.request': { response: 'hub.execution.control.response', reason: 'this daemon does not run cloud executions' },
    'hub.management.daemon.connect.request': { response: 'hub.management.daemon.connect.response', reason: 'this daemon is not a management hub' },
    'hub.management.daemon.disconnect.request': { response: 'hub.management.daemon.disconnect.response', reason: 'this daemon is not a management hub' },
    'hub.management.daemon.get_status.request': { response: 'hub.management.daemon.get_status.response', reason: 'this daemon is not a management hub' },
    'hub.management.daemon.permissions.update.request': { response: 'hub.management.daemon.permissions.update.response', reason: 'this daemon is not a management hub' },
    'plugin.list.request': { response: 'plugin.list.response', reason: 'this daemon manages no plugins; the harness owns them' },
    'plugin.catalog.get.request': { response: 'plugin.catalog.get.response', reason: 'this daemon manages no plugins; the harness owns them' },
    'plugin.logs.get.request': { response: 'plugin.logs.get.response', reason: 'this daemon manages no plugins; the harness owns them' },
    'plugin.rpc.invoke.request': { response: 'plugin.rpc.invoke.response', reason: 'this daemon manages no plugins; the harness owns them' },
    'plugin.directory.inspect.request': { response: 'plugin.directory.inspect.response', reason: 'this daemon manages no plugins; the harness owns them' },
    'plugin.directory.install.request': { response: 'plugin.directory.install.response', reason: 'this daemon manages no plugins; the harness owns them' },
    'plugin.source.install.request': { response: 'plugin.source.install.response', reason: 'this daemon manages no plugins; the harness owns them' },
    'plugin.source.status.request': { response: 'plugin.source.status.response', reason: 'this daemon manages no plugins; the harness owns them' },
    'plugin.source.update.request': { response: 'plugin.source.update.response', reason: 'this daemon manages no plugins; the harness owns them' },
    'plugin.source.update.preview.request': { response: 'plugin.source.update.preview.response', reason: 'this daemon manages no plugins; the harness owns them' },
    'plugin.source.update.apply.request': { response: 'plugin.source.update.apply.response', reason: 'this daemon manages no plugins; the harness owns them' },
};
/** One refusal frame for a request whose surface this daemon does not offer. */
export function refusalResponse(response, requestId, reason) {
    return { type: response, payload: { requestId, error: reason, success: false, accepted: false, ok: false } };
}
/** `workspace.github.search_repositories.response`. */
export function repositorySearch(requestId, repositories, error, authenticated) {
    if (error !== null || !authenticated) {
        return {
            type: 'workspace.github.search_repositories.response',
            payload: { status: 'unavailable', requestId, repositories: [], reason: 'gh_missing', available: false, error },
        };
    }
    return {
        type: 'workspace.github.search_repositories.response',
        payload: { status: 'success', requestId, repositories: [...repositories], available: true, error: null },
    };
}
/** `forge.search.response` and its legacy GitHub sibling. */
export function forgeSearch(type, requestId, items, error, authenticated) {
    return {
        type,
        payload: {
            items: items.map((item) => ({ ...item })),
            authState: authenticated ? 'authenticated' : 'unauthenticated',
            ...(type === 'github_search_response'
                ? { featuresEnabled: authenticated, githubFeaturesEnabled: authenticated }
                : {}),
            error,
            requestId,
        },
    };
}
/** `refresh_providers_snapshot_response`, which acknowledges a re-read. */
export function providersSnapshotRefreshed(requestId, acknowledged) {
    return { type: 'refresh_providers_snapshot_response', payload: { requestId, acknowledged } };
}
/**
 * `provider.usage.list.response` and `usage.list_reports.response`.
 *
 * Both surfaces report a provider account's own quota, which Paseo reads from
 * the provider CLIs. This daemon has no such source: the harness token meter
 * measures the requests it made, not what the account has left. An empty
 * report says that, where an error would read as a failed call.
 */
export function emptyUsage(type, requestId) {
    return type === 'provider.usage.list.response'
        ? { type, payload: { requestId, fetchedAt: new Date().toISOString(), providers: [], error: null } }
        : { type, payload: { requestId, error: null } };
}
/** `workspace.label.list.response`. */
export function labelCatalog(requestId, labels, generation, headSeq, subscriptionId) {
    return {
        type: 'workspace.label.list.response',
        payload: {
            requestId,
            ...(subscriptionId === undefined ? {} : { subscriptionId }),
            labels: labels.map((label) => ({ ...label })),
            sync: { mode: 'snapshot', generation, headSeq, removals: [] },
        },
    };
}
/** `workspace.label.update.response`. */
export function labelUpdated(requestId, label, affectedWorkspaceCount) {
    return {
        type: 'workspace.label.update.response',
        payload: { requestId, label: { ...label }, affectedWorkspaceCount },
    };
}
/** `workspace.label.delete.response` and its inspect sibling. */
export function labelAffected(type, requestId, affectedWorkspaceCount) {
    return { type, payload: { requestId, affectedWorkspaceCount } };
}
/** `workspace.label.assignment.set.response`. */
export function labelAssigned(requestId, label, workspaceLabels) {
    return {
        type: 'workspace.label.assignment.set.response',
        payload: { requestId, label: { ...label }, workspaceLabels: [...workspaceLabels] },
    };
}
/** `workspace.label.update`, the push half of the catalog. */
export function labelUpdateEvent(label, workspaceLabels, subscriptionId) {
    return {
        type: 'workspace.label.update',
        payload: {
            ...(subscriptionId === undefined ? {} : { subscriptionId }),
            kind: 'upsert',
            label: { ...label },
            workspaceLabels: [...workspaceLabels],
        },
    };
}
/** `project.rename.response`. */
export function projectRenamed(requestId, projectId, customName, error) {
    return { type: 'project.rename.response', payload: { requestId, projectId, accepted: error === null, customName, error } };
}
/** `project.icon.set.response`. */
export function projectIconSet(requestId, projectId, accepted, error) {
    return { type: 'project.icon.set.response', payload: { requestId, projectId, accepted, error } };
}
/** `project.icon.get.response`. */
export function projectIconGot(requestId, projectId, icon) {
    return { type: 'project.icon.get.response', payload: { requestId, projectId, icon, error: null } };
}
/** `project_icon_response`, which answers for a directory. */
export function projectIconForDirectory(requestId, directory, icon, error) {
    return { type: 'project_icon_response', payload: { requestId, cwd: directory, icon, error } };
}
/** `project.update`, the push half of a rename or icon change. */
export function projectUpdated(workspace) {
    return {
        type: 'project.update',
        payload: { kind: 'upsert', project: placement(workspace) },
    };
}
