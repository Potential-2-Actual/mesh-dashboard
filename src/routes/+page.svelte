<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { messages, presence, connectionStatus, members, telemetry, receipts, sentMessageIds, activeChannel, unreadChannels } from '$lib/stores.js';
	import MentionInput from '$lib/components/MentionInput.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import { connectNats, publishMessage, disconnectNats, requestSessionHistory, sendSessionMessage } from '$lib/nats-client.js';
	import type { MessageEnvelope, MemberInfo, TelemetryPayload, SessionHistoryMessage, SessionHistoryResponse, SessionSendResponse } from '$lib/types.js';
	import { marked } from 'marked';
	import hljs from 'highlight.js';
	import { page } from '$app/stores';

	// Derive presence name from user (same sanitization as /api/send)
	let userName = $derived.by(() => {
		const user = $page.data?.user;
		if (!user?.name) return 'gp';
		return user.name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'gp';
	});

	let messageInput = $state('');
	let feedEl: HTMLElement;
	let currentMessages: MessageEnvelope[] = $state([]);
	let currentPresence: Map<string, any> = $state(new Map());
	let currentMembers: Map<string, MemberInfo> = $state(new Map());
	let currentTelemetry: Map<string, TelemetryPayload> = $state(new Map());
	let currentReceipts: Map<string, string[]> = $state(new Map());
	let currentSentIds: Set<string> = $state(new Set());
	let currentStatus: string = $state('disconnected');

	// Pagination state
	let hasMore = $state(false);
	let loadingMore = $state(false);

	// Search state
	let searchOpen = $state(false);
	let searchQuery = $state('');
	let searchResults: MessageEnvelope[] = $state([]);
	let searchTotal = $state(0);
	let searchTruncated = $state(false);
	let searchLoading = $state(false);
	let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;

	// Inspector state
	let inspectorAgent = $state<string | null>(null);

	// View mode: channel or session
	let viewMode = $state<'channel' | 'session'>('channel');

	// Session viewer state
	let viewingSession = $state<{ agentName: string; sessionKey: string } | null>(null);
	let sessionHistory = $state<SessionHistoryResponse | null>(null);
	let sessionLoading = $state(false);
	let sessionError = $state<string | null>(null);
	let expandedThinking = $state<Set<string>>(new Set());
	let sessionMessageInput = $state('');
	let sessionSending = $state(false);
	let sessionSendError = $state<string | null>(null);

	// Sidebar collapse state
	let collapsedSections: Record<string, boolean> = $state({});

	function toggleSection(key: string) {
		collapsedSections[key] = !collapsedSections[key];
	}

	// Channel switching
	let currentActiveChannel = $state('general');
	let currentUnread: Set<string> = $state(new Set());
	let knownChannels = $state<string[]>(['general']);
	const unsubActiveChannel = activeChannel.subscribe((v) => { currentActiveChannel = v; });
	const unsubUnread = unreadChannels.subscribe((v) => { currentUnread = v; });

	// Discover channels from incoming messages
	$effect(() => {
		const channels = new Set(knownChannels);
		for (const msg of currentMessages) {
			const ch = (msg as any)._channel;
			if (ch && !channels.has(ch)) {
				channels.add(ch);
				knownChannels = [...channels].sort();
			}
		}
	});

	async function switchChannel(channel: string) {
		if (channel === currentActiveChannel && viewMode === 'channel') return;
		// Exit session mode
		viewMode = 'channel';
		viewingSession = null;
		sessionHistory = null;
		sessionError = null;
		activeChannel.set(channel);
		// Clear unread for this channel
		unreadChannels.update((s) => { const next = new Set(s); next.delete(channel); return next; });
		// Load history for the new channel
		try {
			const res = await fetch(`/api/history?channel=${encodeURIComponent(channel)}`);
			if (res.ok) {
				const data = await res.json();
				// Tag messages with channel
				const tagged = (data.messages ?? data).map((m: any) => ({ ...m, _channel: channel }));
				// Merge with existing messages (keep other channels, replace this channel's history)
				messages.update((msgs) => {
					const otherMsgs = msgs.filter((m: any) => (m as any)._channel !== channel);
					return [...otherMsgs, ...tagged].sort((a, b) => a.ts - b.ts);
				});
				hasMore = data.hasMore ?? false;
			}
		} catch { /* skip */ }
		scrollToBottom();
	}

	function shortSessionLabel(key: string): string {
		// agent:main:nats:group:mesh.channel.general → mesh.channel.general
		// agent:main:telegram:dm:8193672753 → telegram:dm
		// agent:main:main → main
		const parts = key.split(':');
		// Strip leading "agent:<name>:" prefix
		const stripped = parts.length > 2 ? parts.slice(2) : parts;
		const joined = stripped.join(':');
		if (joined === 'main') return 'main';
		// For nats:group:mesh.channel.X → mesh.channel.X
		if (stripped[0] === 'nats' && stripped.length >= 3) return stripped.slice(2).join(':');
		// For telegram:dm:longid → telegram:dm
		if (stripped.length >= 2) {
			const label = stripped.slice(0, 2).join(':');
			return label.length > 28 ? label.slice(0, 28) + '…' : label;
		}
		return joined.length > 28 ? joined.slice(0, 28) + '…' : joined;
	}

	// Agent entries from telemetry, sorted: humans first, then alpha
	let sidebarAgents = $derived.by(() => {
		const agents: Array<{ name: string; type: 'human' | 'ai'; online: boolean; sessions: TelemetryPayload['sessions']['list']; activeCount: number }> = [];
		for (const [name, telem] of currentTelemetry) {
			const member = currentMembers.get(name);
			agents.push({
				name,
				type: member?.type ?? 'ai',
				online: currentPresence.has(name),
				sessions: telem.sessions.list,
				activeCount: telem.sessions.active
			});
		}
		// Members without telemetry are NOT added here —
		// they render in the "People" section in the sidebar template
		agents.sort((a, b) => {
			if (a.type !== b.type) return a.type === 'human' ? -1 : 1;
			if (a.online !== b.online) return a.online ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		return agents;
	});

	// Members without telemetry (e.g. humans) — simple list, no disclosure
	let sidebarPeople = $derived.by(() => {
		const people: Array<{ name: string; type: 'human' | 'ai'; online: boolean }> = [];
		for (const [name, member] of currentMembers) {
			if (!currentTelemetry.has(name)) {
				people.push({ name, type: member.type, online: currentPresence.has(name) });
			}
		}
		people.sort((a, b) => {
			if (a.online !== b.online) return a.online ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		return people;
	});

	const unsubMsgs = messages.subscribe((v) => { currentMessages = v; scrollToBottom(); });

	// Filtered messages for current channel
	let filteredMessages = $derived.by(() => {
		return currentMessages.filter((m) => {
			const ch = (m as any)._channel;
			// Show messages that match active channel, or have no channel tag (legacy/system)
			if (!ch) return currentActiveChannel === 'general'; // legacy untagged = general
			return ch === currentActiveChannel;
		});
	});
	const unsubPresence = presence.subscribe((v) => { currentPresence = v; });
	const unsubMembers = members.subscribe((v) => { currentMembers = v; });
	const unsubStatus = connectionStatus.subscribe((v) => { currentStatus = v; });
	const unsubTelemetry = telemetry.subscribe((v) => { currentTelemetry = v; });
	const unsubReceipts = receipts.subscribe((v) => { currentReceipts = v; });
	const unsubSentIds = sentMessageIds.subscribe((v) => { currentSentIds = v; });

	// Sorted members list: online first, then alphabetical
	let sortedMembers = $derived.by(() => {
		const list = [...currentMembers.values()].map(m => ({
			...m,
			online: currentPresence.has(m.name)
		}));
		list.sort((a, b) => {
			if (a.online !== b.online) return a.online ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		return list;
	});

	// Current inspector telemetry
	let inspectorData = $derived.by(() => {
		if (!inspectorAgent) return null;
		return currentTelemetry.get(inspectorAgent) ?? null;
	});

	let inspectorIsStale = $derived.by(() => {
		if (!inspectorData) return false;
		return (Date.now() / 1000 - inspectorData.ts) > 120; // stale if >2min old
	});

	async function scrollToBottom() {
		await tick();
		if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
	}

	function formatTime(ts: number): string {
		return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function formatDateTime(ts: number): string {
		return new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	function formatUptime(seconds: number): string {
		if (seconds < 60) return `${seconds}s`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
		return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
	}

	function formatTokens(n: number): string {
		if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
		if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
		return `${n}`;
	}

	function isSystemMessage(msg: MessageEnvelope): boolean {
		return msg.to.subject.startsWith('mesh.system.');
	}

	async function send() {
		const text = messageInput.trim();
		if (!text) return;
		messageInput = '';
		try {
			const msgId = await publishMessage(text, currentActiveChannel);
			sentMessageIds.update((s) => { const next = new Set(s); next.add(msgId); return next; });
		} catch (err) {
			console.error('Send failed:', err);
		}
	}

	async function loadMore() {
		if (loadingMore || !hasMore || filteredMessages.length === 0) return;
		loadingMore = true;
		const oldestTs = filteredMessages[0]?.ts;
		const prevScrollHeight = feedEl?.scrollHeight ?? 0;
		try {
			const res = await fetch(`/api/history?before=${oldestTs}&limit=50&channel=${encodeURIComponent(currentActiveChannel)}`);
			if (res.ok) {
				const data = await res.json();
				if (data.messages.length > 0) {
					const tagged = data.messages.map((m: any) => ({ ...m, _channel: currentActiveChannel }));
					const combined = [...tagged, ...currentMessages];
					messages.set(combined);
					hasMore = data.hasMore;
					await tick();
					if (feedEl) {
						feedEl.scrollTop = feedEl.scrollHeight - prevScrollHeight;
					}
				} else {
					hasMore = false;
				}
			}
		} catch { /* skip */ }
		loadingMore = false;
	}

	function toggleSearch() {
		searchOpen = !searchOpen;
		if (!searchOpen) {
			searchQuery = '';
			searchResults = [];
			searchTotal = 0;
			searchTruncated = false;
		}
	}

	function handleSearchInput() {
		if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
		if (!searchQuery.trim()) {
			searchResults = [];
			searchTotal = 0;
			searchTruncated = false;
			return;
		}
		searchDebounceTimer = setTimeout(() => doSearch(), 300);
	}

	async function doSearch() {
		const q = searchQuery.trim();
		if (!q) return;
		searchLoading = true;
		try {
			const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
			if (res.ok) {
				const data = await res.json();
				searchResults = data.results;
				searchTotal = data.total;
				searchTruncated = data.truncated;
			}
		} catch { /* skip */ }
		searchLoading = false;
	}

	function highlightMatch(text: string, query: string): string {
		if (!query.trim()) return escapeHtml(text);
		const escaped = escapeHtml(text);
		const escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const regex = new RegExp(`(${escapedQuery})`, 'gi');
		return escaped.replace(regex, '<mark class="bg-yellow-500/40 text-yellow-200 rounded px-0.5">$1</mark>');
	}

	function escapeHtml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	marked.setOptions({
		highlight(code: string, lang: string) {
			if (lang && hljs.getLanguage(lang)) {
				return hljs.highlight(code, { language: lang }).value;
			}
			return hljs.highlightAuto(code).value;
		},
		breaks: true,
		gfm: true
	});

	function renderMessage(text: string): string {
		let html = marked.parse(text, { async: false }) as string;
		// Apply @mention highlighting, but skip inside <code> and <pre> blocks
		html = html.replace(/(<code[\s\S]*?<\/code>)|(<pre[\s\S]*?<\/pre>)|@(\w+)/g, (match, code, pre, name) => {
			if (code || pre) return match;
			if (!name) return match;
			const member = currentMembers.get(name);
			const agent = currentPresence.get(name);
			if (!member && !agent) return match;
			const type = member?.type ?? agent?.type ?? 'ai';
			const colorClass = type === 'human' ? 'text-emerald-400' : 'text-blue-400';
			return `<span class="font-semibold ${colorClass}">@${name}</span>`;
		});
		return html;
	}

	function scrollToMessage(msgId: string) {
		const el = document.getElementById(`msg-${msgId}`);
		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			el.classList.add('bg-yellow-500/10');
			setTimeout(() => el.classList.remove('bg-yellow-500/10'), 2000);
		}
		searchOpen = false;
	}

	function openInspector(agentName: string) {
		inspectorAgent = agentName;
	}

	function closeInspector() {
		inspectorAgent = null;
	}

	async function openSessionViewer(agentName: string, sessionKey: string) {
		viewMode = 'session';
		viewingSession = { agentName, sessionKey };
		sessionHistory = null;
		sessionError = null;
		sessionLoading = true;
		expandedThinking = new Set();
		inspectorAgent = null;
		try {
			const result = await requestSessionHistory(agentName, sessionKey);
			if ('error' in result) {
				sessionError = (result as any).error;
			} else {
				sessionHistory = result;
			}
		} catch (err) {
			sessionError = `Failed to load session: ${err}`;
		}
		sessionLoading = false;
		scrollToBottom();
	}

	async function sendToSession() {
		if (!viewingSession || !sessionMessageInput.trim() || sessionSending) return;
		const text = sessionMessageInput.trim();
		sessionSending = true;
		sessionSendError = null;
		sessionMessageInput = '';

		// Optimistically append user message to viewer
		if (sessionHistory) {
			sessionHistory = {
				...sessionHistory,
				messages: [
					...sessionHistory.messages,
					{
						id: `pending-user-${Date.now()}`,
						role: 'user',
						content: [{ type: 'text', text }],
						timestamp: new Date().toISOString(),
					},
				],
				total: sessionHistory.total + 1,
			};
		}

		scrollToBottom();

		try {
			const result = await sendSessionMessage(viewingSession.agentName, viewingSession.sessionKey, text);
			if (result.success && result.reply) {
				// Append agent reply optimistically
				if (sessionHistory) {
					sessionHistory = {
						...sessionHistory,
						messages: [
							...sessionHistory.messages,
							{
								id: `pending-reply-${Date.now()}`,
								role: 'assistant',
								content: [{ type: 'text', text: result.reply }],
								timestamp: new Date().toISOString(),
							},
						],
						total: sessionHistory.total + 1,
					};
				}
			} else if (!result.success) {
				sessionSendError = result.error ?? 'Unknown error';
			}

			// Re-fetch full history for consistency
			try {
				const fresh = await requestSessionHistory(viewingSession.agentName, viewingSession.sessionKey);
				if (!('error' in fresh)) {
					sessionHistory = fresh;
				}
			} catch { /* keep optimistic state */ }
		} catch (err) {
			sessionSendError = `${err}`;
		}
		sessionSending = false;
		scrollToBottom();
	}

	function handleSessionKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendToSession();
		}
	}

	function closeSessionViewer() {
		viewMode = 'channel';
		viewingSession = null;
		sessionHistory = null;
		sessionError = null;
	}

	function toggleThinking(msgId: string) {
		const next = new Set(expandedThinking);
		if (next.has(msgId)) next.delete(msgId);
		else next.add(msgId);
		expandedThinking = next;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
			e.preventDefault();
			toggleSearch();
		}
		if (e.key === 'Escape') {
			if (viewingSession) { closeSessionViewer(); return; }
			if (inspectorAgent) { closeInspector(); return; }
			if (searchOpen) { searchOpen = false; searchQuery = ''; searchResults = []; }
		}
	}

	async function fetchMembers() {
		try {
			const res = await fetch(`/api/members?channel=${encodeURIComponent(currentActiveChannel)}`);
			if (res.ok) {
				const data = await res.json();
				const map = new Map<string, MemberInfo>();
				for (const m of data.members) {
					map.set(m.name, m);
				}
				members.set(map);
			}
		} catch { /* skip */ }
	}

	onMount(async () => {
		document.addEventListener('keydown', handleGlobalKeydown);
		await fetchMembers();

		try {
			const res = await fetch('/api/history?channel=general');
			if (res.ok) {
				const data = await res.json();
				const tagged = (data.messages ?? data).map((m: any) => ({ ...m, _channel: 'general' }));
				messages.set(tagged);
				hasMore = data.hasMore ?? false;
			}
		} catch { /* skip */ }

		try {
			const res = await fetch('/api/nats-token');
			if (res.ok) {
				const { seed, url } = await res.json();
				await connectNats(url, seed, userName);
			}
		} catch (err) {
			console.error('Failed to connect to NATS:', err);
		}
	});

	onDestroy(() => {
		typeof document !== "undefined" && document.removeEventListener('keydown', handleGlobalKeydown);
		unsubMsgs();
		unsubPresence();
		unsubMembers();
		unsubStatus();
		unsubTelemetry();
		unsubReceipts();
		unsubSentIds();
		unsubActiveChannel();
		unsubUnread();
		disconnectNats();
	});
</script>

<div class="flex h-[calc(100vh-49px)]">
	<!-- Left navigation sidebar -->
	<div class="hidden md:flex flex-col w-[220px] min-w-[220px] bg-gray-950 border-r border-gray-800 overflow-y-auto">
		<div class="flex-1 py-2">
			<!-- CHANNELS section -->
			<div class="px-2 mb-1">
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase text-gray-500 cursor-pointer hover:text-gray-400 select-none"
					onclick={() => toggleSection('channels')}>
					<svg class="w-3 h-3 transition-transform {collapsedSections['channels'] ? '-rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
					<span>📡 Channels</span>
				</div>
				{#if !collapsedSections['channels']}
					<div class="ml-2 space-y-0.5">
						{#each knownChannels as ch}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="flex items-center gap-1.5 px-2 py-1 rounded text-sm cursor-pointer transition-colors {ch === currentActiveChannel ? 'bg-gray-800/60 text-gray-100 font-medium' : 'text-gray-400 hover:bg-gray-800/30 hover:text-gray-200'}"
								onclick={() => switchChannel(ch)}>
								<span class="text-gray-500">#</span>
								<span>{ch}</span>
								{#if currentUnread.has(ch)}
									<span class="ml-auto w-2 h-2 rounded-full bg-emerald-500"></span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Agent sections from telemetry -->
			{#each sidebarAgents as agent}
				<div class="px-2 mb-0.5">
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase text-gray-500 cursor-pointer hover:text-gray-400 select-none"
						onclick={() => toggleSection(agent.name)}>
						<svg class="w-3 h-3 transition-transform {collapsedSections[agent.name] ? '-rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
						<span>{agent.type === 'human' ? '👤' : '🤖'}</span>
						<span class="inline-block h-1.5 w-1.5 rounded-full {agent.online ? 'bg-emerald-400' : 'bg-gray-600'}"></span>
						<span class="{agent.type === 'human' ? 'text-emerald-500' : 'text-blue-500'}">{agent.name}</span>
						{#if agent.activeCount > 0}
							<span class="ml-auto text-[9px] font-normal normal-case text-gray-600" title="{agent.activeCount} active session{agent.activeCount !== 1 ? 's' : ''}">{agent.activeCount} active</span>
						{/if}
					</div>
					{#if !collapsedSections[agent.name]}
						<div class="ml-2">
							<!-- Telemetry item -->
							{#if currentTelemetry.has(agent.name)}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div class="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs text-gray-400 hover:bg-gray-800/50 hover:text-gray-300 cursor-pointer transition-colors"
									onclick={() => openInspector(agent.name)}>
									<span class="text-[10px]">📊</span>
									<span>Telemetry</span>
								</div>
							{/if}
							<!-- Session list -->
							{#if agent.sessions.length > 0}
								{#each agent.sessions as session}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									{@const isActive = session.updatedAt > 0 && (Date.now() - session.updatedAt) < 30 * 60 * 1000}
									<div class="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs truncate cursor-pointer hover:bg-gray-800/50 transition-colors {viewingSession?.agentName === agent.name && viewingSession?.sessionKey === session.key ? 'bg-gray-800/60 text-gray-100 font-medium' : isActive ? 'text-gray-300' : 'text-gray-600'}"
										title="{session.key}{isActive ? ' (active)' : ''}"
										onclick={() => openSessionViewer(agent.name, session.key)}>
										<span class="text-[10px] {isActive ? 'text-green-400' : 'text-gray-700'}">{isActive ? '●' : '○'}</span>
										<span class="truncate">{shortSessionLabel(session.key)}</span>
									</div>
								{/each}
							{:else}
								<div class="px-2 py-0.5 text-[10px] text-gray-700 italic">no sessions</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}

			<!-- People section (members without telemetry) -->
			{#if sidebarPeople.length > 0}
				<div class="px-2 mb-1 mt-2">
					<div class="px-2 py-1 text-[10px] font-bold uppercase text-gray-500">
						<span>👥 People</span>
					</div>
					{#each sidebarPeople as person}
						<div class="flex items-center gap-1.5 px-2 py-1 ml-2 text-sm">
							<span class="inline-block h-1.5 w-1.5 rounded-full {person.online ? 'bg-emerald-400' : 'bg-gray-600'}"></span>
							<span class="{person.online ? 'text-emerald-400' : 'text-gray-500'}">{person.name}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Bottom: connection status -->
		<div class="border-t border-gray-800 px-3 py-2 flex items-center gap-2 text-xs">
			<span class="inline-block h-2 w-2 rounded-full {currentStatus === 'connected' ? 'bg-emerald-400' : currentStatus === 'connecting' ? 'bg-yellow-400' : 'bg-red-400'}"></span>
			<span class="text-gray-500">{currentStatus}</span>
		</div>
	</div>

	<!-- Main chat area -->
	<div class="flex flex-1 flex-col">
		<!-- Channel/Session header -->
		<div class="flex items-center gap-2 border-b border-gray-800 px-4 py-1.5 text-xs">
			{#if viewMode === 'session' && viewingSession}
				<button onclick={closeSessionViewer} class="text-gray-500 hover:text-gray-300 mr-1" title="Back to channel">
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
				</button>
				<span class="text-blue-400 font-medium">🤖 {viewingSession.agentName}</span>
				<span class="text-gray-600 truncate max-w-[300px]" title={viewingSession.sessionKey}>· {shortSessionLabel(viewingSession.sessionKey)}</span>
				{#if sessionHistory}
					<span class="text-gray-600">· {sessionHistory.total} messages</span>
				{/if}
			{:else}
				<span class="text-gray-400 font-medium"># {currentActiveChannel}</span>
				<span class="text-gray-600">· mesh.channel.{currentActiveChannel}</span>
			{/if}
			<button onclick={toggleSearch} class="ml-auto text-gray-500 hover:text-gray-300 text-xs" title="Search (Ctrl+K)">
				<svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
				<span class="ml-1">Search</span>
			</button>
		</div>

		<!-- Message feed -->
		<div bind:this={feedEl} class="flex-1 overflow-y-auto px-4 py-2 space-y-1">
			{#if viewMode === 'session'}
				<!-- Session messages -->
				{#if sessionLoading}
					<div class="flex items-center justify-center py-12 text-gray-500 text-sm">
						<svg class="animate-spin h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
						Loading session…
					</div>
				{:else if sessionError}
					<div class="flex items-center justify-center py-12 text-red-400 text-sm">{sessionError}</div>
				{:else if sessionHistory}
					{#each sessionHistory.messages as msg (msg.id)}
						{#if msg.role === 'user'}
							<div class="rounded-lg bg-gray-800 p-3 max-w-[90%]">
								<div class="text-[10px] text-emerald-500 font-medium mb-1">User <span class="text-gray-600 ml-1">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
								{#each msg.content as item}
									{#if item.type === 'text' && item.text}
										<div class="text-sm text-gray-200 markdown-body">{@html renderMessage(item.text)}</div>
									{/if}
								{/each}
							</div>
						{:else if msg.role === 'assistant'}
							<div class="rounded-lg bg-gray-800/70 p-3 max-w-[90%] border-l-2 border-blue-500/30">
								<div class="text-[10px] text-blue-400 font-medium mb-1">Assistant <span class="text-gray-600 ml-1">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
								{#each msg.content as item, i}
									{#if item.type === 'text' && item.text}
										<div class="text-sm text-gray-200 markdown-body">{@html renderMessage(item.text)}</div>
									{:else if item.type === 'thinking'}
										<!-- svelte-ignore a11y_click_events_have_key_events -->
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<div class="text-xs text-gray-500 my-1 cursor-pointer hover:text-gray-400" onclick={() => toggleThinking(`${msg.id}-${i}`)}>
											💭 Thinking…
											{#if expandedThinking.has(`${msg.id}-${i}`)}
												<div class="mt-1 text-gray-600 whitespace-pre-wrap">{item.text}</div>
											{/if}
										</div>
									{:else if item.type === 'tool_use'}
										<span class="inline-flex items-center gap-1 text-[10px] bg-gray-700 text-gray-400 rounded px-1.5 py-0.5 mr-1 my-0.5">🔧 {item.name}</span>
									{/if}
								{/each}
							</div>
						{:else if msg.role === 'toolResult'}
							<div class="px-3 py-1">
								{#each msg.content as item}
									{#if item.type === 'tool_result'}
										<span class="text-xs text-gray-500">{item.success ? '✅' : '❌'} {item.name}</span>
									{/if}
								{/each}
							</div>
						{/if}
					{/each}

					{#if sessionSending}
						<div class="rounded-lg bg-gray-800/40 p-3 max-w-[90%] border-l-2 border-blue-500/20 animate-pulse">
							<div class="text-xs text-blue-400/60">Agent thinking…</div>
						</div>
					{/if}
				{:else}
					<div class="flex h-full items-center justify-center text-gray-600">No messages</div>
				{/if}
			{:else}
				<!-- Channel messages -->
				{#if hasMore}
					<div class="flex justify-center py-2">
						<button onclick={loadMore} disabled={loadingMore}
							class="text-xs text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded-md disabled:opacity-50 transition-colors">
							{loadingMore ? 'Loading...' : '↑ Load older messages'}
						</button>
					</div>
				{/if}

				{#each filteredMessages as msg (msg.id)}
					{#if isSystemMessage(msg)}
						<div id="msg-{msg.id}" class="text-xs italic text-gray-500 py-0.5 leading-5 transition-colors duration-1000">
							<span class="text-gray-600">{formatTime(msg.ts)}</span>
							<span class="inline-block align-middle"><Avatar name={msg.from.agent} type={msg.from.type} size={16} /></span>
							<span>[{msg.from.agent}]</span>
							<span>{msg.content.text}</span>
						</div>
					{:else}
						<div id="msg-{msg.id}" class="py-0.5 leading-6 transition-colors duration-1000">
							<span class="text-xs text-gray-500">{formatTime(msg.ts)}</span>
							<span class="inline-block align-middle"><Avatar name={msg.from.agent} type={msg.from.type} size={18} /></span>
							<span class="font-medium {msg.from.type === 'human' ? 'text-emerald-400' : 'text-blue-400'}">[{msg.from.agent}]</span>
							<span class="text-sm text-gray-200 markdown-body">{@html renderMessage(msg.content.text)}</span>
							{#if currentSentIds.has(msg.id)}
								{@const agentReceipts = currentReceipts.get(msg.id)}
								{#if agentReceipts && agentReceipts.length > 0}
									<span class="ml-1.5 text-emerald-400 text-xs cursor-default select-none" title="Received by: {agentReceipts.join(', ')}">✓</span>
								{:else}
									<span class="ml-1.5 text-gray-500 text-xs cursor-default select-none" title="Sent">✓</span>
								{/if}
							{/if}
						</div>
					{/if}
				{/each}
				{#if filteredMessages.length === 0}
					<div class="flex h-full items-center justify-center text-gray-600">No messages yet</div>
				{/if}
			{/if}
		</div>

		<!-- Input -->
		<div class="border-t border-gray-800 p-3">
			{#if viewMode === 'session' && sessionHistory && !sessionError}
				{#if sessionSendError}
					<div class="text-xs text-red-400 mb-2 px-1">{sessionSendError}</div>
				{/if}
				<div class="flex gap-2">
					<input
						type="text"
						bind:value={sessionMessageInput}
						onkeydown={handleSessionKeydown}
						placeholder="Send a message to this session…"
						disabled={sessionSending || currentStatus !== 'connected'}
						class="flex-1 rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500 disabled:opacity-40"
					/>
					<button
						onclick={sendToSession}
						disabled={sessionSending || !sessionMessageInput.trim() || currentStatus !== 'connected'}
						class="rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
						title="This triggers an agent turn and may incur API costs"
					>
						{sessionSending ? 'Sending…' : 'Send (triggers agent turn)'}
					</button>
				</div>
			{:else if viewMode === 'channel'}
				<div class="flex gap-2">
					<MentionInput
						bind:value={messageInput}
						presence={currentPresence}
						members={currentMembers}
						onkeydown={handleKeydown}
						placeholder="Type a message..."
						class="flex-1 rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-emerald-500"
						disabled={currentStatus !== 'connected'}
					/>
					<button onclick={send}
						disabled={currentStatus !== 'connected' || !messageInput.trim()}
						class="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed">
						Send
					</button>
				</div>
			{/if}
		</div>
	</div>

	<!-- Search slide-out panel -->
	{#if searchOpen}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="fixed inset-0 bg-black/30 z-40" onclick={() => { searchOpen = false; }}></div>
		<div class="fixed right-0 top-0 h-full w-96 max-w-[90vw] bg-gray-900 border-l border-gray-700 z-50 flex flex-col shadow-2xl">
			<div class="p-4 border-b border-gray-800">
				<div class="flex items-center justify-between mb-3">
					<h2 class="text-sm font-semibold text-gray-300">Search Messages</h2>
					<button onclick={() => { searchOpen = false; }} class="text-gray-500 hover:text-gray-300">
						<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
					</button>
				</div>
				<input type="text" bind:value={searchQuery} oninput={handleSearchInput}
					placeholder="Search messages..."
					class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500"
					autofocus />
				{#if searchTotal > 0}
					<div class="mt-2 text-xs text-gray-500">
						{searchTotal} result{searchTotal !== 1 ? 's' : ''}{searchTruncated ? ' (truncated)' : ''}
					</div>
				{/if}
			</div>
			<div class="flex-1 overflow-y-auto p-2">
				{#if searchLoading}
					<div class="flex items-center justify-center py-8 text-gray-500 text-sm">Searching...</div>
				{:else if searchResults.length === 0 && searchQuery.trim()}
					<div class="flex items-center justify-center py-8 text-gray-600 text-sm">No results found</div>
				{:else}
					{#each searchResults as result}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="p-2 rounded-md hover:bg-gray-800 cursor-pointer mb-1 transition-colors"
							onclick={() => scrollToMessage(result.id)}>
							<div class="flex items-center gap-2 text-xs text-gray-500 mb-1">
								<span>{formatDateTime(result.ts)}</span>
								<Avatar name={result.from.agent} type={result.from.type} size={18} />
								<span class="font-medium {result.from.type === 'human' ? 'text-emerald-400' : 'text-blue-400'}">{result.from.agent}</span>
							</div>
							<div class="text-sm text-gray-300">{@html highlightMatch(result.content.text, searchQuery)}</div>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}

	<!-- Inspector slide-out panel -->
	{#if inspectorAgent}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="fixed inset-0 bg-black/30 z-40" onclick={closeInspector}></div>
		<div class="fixed right-0 top-0 h-full w-[420px] max-w-[90vw] bg-gray-900 border-l border-gray-700 z-50 flex flex-col shadow-2xl">
			<div class="p-4 border-b border-gray-800">
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-2">
						<span class="inline-block h-2.5 w-2.5 rounded-full {currentPresence.has(inspectorAgent) ? 'bg-emerald-400' : 'bg-gray-600'}"></span>
						<h2 class="text-base font-semibold {currentMembers.get(inspectorAgent)?.type === 'human' ? 'text-emerald-400' : 'text-blue-400'}">{inspectorAgent}</h2>
						{#if inspectorIsStale}
							<span class="text-[10px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">STALE</span>
						{/if}
					</div>
					<button onclick={closeInspector} class="text-gray-500 hover:text-gray-300">
						<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
					</button>
				</div>
			</div>

			<div class="flex-1 overflow-y-auto p-4 space-y-4">
				{#if inspectorData}
					<!-- Overview -->
					<div class="grid grid-cols-2 gap-3">
						<div class="bg-gray-800 rounded-lg p-3">
							<div class="text-[10px] uppercase text-gray-500 mb-1">Model</div>
							<div class="text-sm text-gray-200 truncate">{inspectorData.model}</div>
						</div>
						<div class="bg-gray-800 rounded-lg p-3">
							<div class="text-[10px] uppercase text-gray-500 mb-1">Version</div>
							<div class="text-sm text-gray-200">{inspectorData.version}</div>
						</div>
						<div class="bg-gray-800 rounded-lg p-3">
							<div class="text-[10px] uppercase text-gray-500 mb-1">Uptime</div>
							<div class="text-sm text-gray-200">{formatUptime(inspectorData.uptime)}</div>
						</div>
						<div class="bg-gray-800 rounded-lg p-3">
							<div class="text-[10px] uppercase text-gray-500 mb-1">Last Report</div>
							<div class="text-sm text-gray-200">{formatTime(inspectorData.ts)}</div>
						</div>
					</div>

					<!-- Sessions overview -->
					<div class="bg-gray-800 rounded-lg p-3">
						<div class="flex items-center justify-between mb-2">
							<div class="text-[10px] uppercase text-gray-500">Sessions</div>
							<div class="text-xs text-gray-400">{inspectorData.sessions.active} active / {inspectorData.sessions.total} total</div>
						</div>
						{#if inspectorData.subAgents.running > 0 || inspectorData.subAgents.completed > 0}
							<div class="text-xs text-gray-500 mb-2">
								Sub-agents: <span class="text-emerald-400">{inspectorData.subAgents.running} running</span> · {inspectorData.subAgents.completed} completed
							</div>
						{/if}
					</div>

					<!-- Active sessions with context bars -->
					{#if inspectorData.sessions.list.length > 0}
						<div>
							<div class="text-[10px] uppercase text-gray-500 mb-2">Recent Sessions</div>
							<div class="space-y-2">
								{#each inspectorData.sessions.list as session}
									{@const pct = session.contextMax > 0 ? Math.min(100, (session.tokens / session.contextMax) * 100) : 0}
									{@const barColor = pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-yellow-500' : 'bg-blue-500'}
									<div class="bg-gray-800 rounded-lg p-2.5">
										<div class="flex items-center justify-between mb-1">
											<div class="text-xs text-gray-300 truncate max-w-[240px]" title={session.key}>
												{session.key.split(':').slice(-1)[0] || session.key}
											</div>
											<div class="text-[10px] text-gray-500">{session.channel}</div>
										</div>
										<div class="flex items-center gap-2">
											<div class="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
												<div class="{barColor} h-full rounded-full transition-all" style="width: {pct}%"></div>
											</div>
											<div class="text-[10px] text-gray-400 whitespace-nowrap">
												{formatTokens(session.tokens)} / {formatTokens(session.contextMax)}
											</div>
										</div>
										{#if session.model}
											<div class="text-[10px] text-gray-600 mt-1">{session.model}</div>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{/if}
				{:else}
					<div class="flex flex-col items-center justify-center py-12 text-gray-600">
						<svg class="w-12 h-12 mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
						<div class="text-sm">No telemetry</div>
						<div class="text-xs text-gray-700 mt-1">This agent hasn't reported yet</div>
					</div>
				{/if}
			</div>
		</div>
	{/if}



</div>
