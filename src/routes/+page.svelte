<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { messages, presence, connectionStatus, members } from '$lib/stores.js';
	import MentionInput from '$lib/components/MentionInput.svelte';
	import { connectNats, publishMessage, disconnectNats } from '$lib/nats-client.js';
	import type { MessageEnvelope, MemberInfo } from '$lib/types.js';

	let messageInput = $state('');
	let feedEl: HTMLElement;
	let currentMessages: MessageEnvelope[] = $state([]);
	let currentPresence: Map<string, any> = $state(new Map());
	let currentMembers: Map<string, MemberInfo> = $state(new Map());
	let currentStatus: string = $state('disconnected');

	let hasMore = $state(false);
	let loadingMore = $state(false);

	let searchOpen = $state(false);
	let searchQuery = $state('');
	let searchResults: MessageEnvelope[] = $state([]);
	let searchTotal = $state(0);
	let searchTruncated = $state(false);
	let searchLoading = $state(false);
	let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;

	const unsubMsgs = messages.subscribe((v) => { currentMessages = v; scrollToBottom(); });
	const unsubPresence = presence.subscribe((v) => { currentPresence = v; });
	const unsubMembers = members.subscribe((v) => { currentMembers = v; });
	const unsubStatus = connectionStatus.subscribe((v) => { currentStatus = v; });

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

	function isSystemMessage(msg: MessageEnvelope): boolean {
		return msg.to.subject.startsWith('mesh.system.');
	}

	async function send() {
		const text = messageInput.trim();
		if (!text) return;
		publishMessage(text);
		messageInput = '';
	}

	async function loadMore() {
		if (loadingMore || !hasMore || currentMessages.length === 0) return;
		loadingMore = true;
		const oldestTs = currentMessages[0]?.ts;
		const prevScrollHeight = feedEl?.scrollHeight ?? 0;
		try {
			const res = await fetch(`/api/history?before=${oldestTs}&limit=50`);
			if (res.ok) {
				const data = await res.json();
				if (data.messages.length > 0) {
					const combined = [...data.messages, ...currentMessages];
					messages.set(combined);
					hasMore = data.hasMore;
					await tick();
					if (feedEl) {
						const newScrollHeight = feedEl.scrollHeight;
						feedEl.scrollTop = newScrollHeight - prevScrollHeight;
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

	function renderMessage(text: string): string {
		const escaped = escapeHtml(text);
		return escaped.replace(/@(\w+)/g, (match, name) => {
			// Check members first, then presence
			const member = currentMembers.get(name);
			const agent = currentPresence.get(name);
			if (!member && !agent) return match;
			const type = member?.type ?? agent?.type ?? 'ai';
			const colorClass = type === 'human' ? 'text-emerald-400' : 'text-blue-400';
			return `<span class="font-semibold ${colorClass}">@${name}</span>`;
		});
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
		if (e.key === 'Escape' && searchOpen) {
			searchOpen = false;
			searchQuery = '';
			searchResults = [];
		}
	}

	async function fetchMembers() {
		try {
			const res = await fetch('/api/members?channel=general');
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

		// Load members
		await fetchMembers();

		// Load history
		try {
			const res = await fetch('/api/history');
			if (res.ok) {
				const data = await res.json();
				messages.set(data.messages ?? data);
				hasMore = data.hasMore ?? false;
			}
		} catch { /* skip */ }

		// Connect NATS
		try {
			const res = await fetch('/api/nats-token');
			if (res.ok) {
				const { seed, url } = await res.json();
				await connectNats(url, seed);
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
		disconnectNats();
	});
</script>

<div class="flex h-[calc(100vh-49px)]">
	<!-- Main chat area -->
	<div class="flex flex-1 flex-col">
		<!-- Connection status -->
		<div class="flex items-center gap-2 border-b border-gray-800 px-4 py-1.5 text-xs">
			<span class="inline-block h-2 w-2 rounded-full {currentStatus === 'connected' ? 'bg-emerald-400' : currentStatus === 'connecting' ? 'bg-yellow-400' : 'bg-red-400'}"></span>
			<span class="text-gray-400">{currentStatus}</span>
			<span class="text-gray-600">· mesh.channel.general</span>
			<button onclick={toggleSearch} class="ml-auto text-gray-500 hover:text-gray-300 text-xs" title="Search (Ctrl+K)">
				<svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
				<span class="ml-1">Search</span>
			</button>
		</div>

		<!-- Message feed -->
		<div bind:this={feedEl} class="flex-1 overflow-y-auto px-4 py-2 space-y-1">
			{#if hasMore}
				<div class="flex justify-center py-2">
					<button
						onclick={loadMore}
						disabled={loadingMore}
						class="text-xs text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded-md disabled:opacity-50 transition-colors"
					>
						{loadingMore ? 'Loading...' : '↑ Load older messages'}
					</button>
				</div>
			{/if}

			{#each currentMessages as msg (msg.id)}
				{#if isSystemMessage(msg)}
					<div id="msg-{msg.id}" class="text-xs italic text-gray-500 py-0.5 transition-colors duration-1000">
						<span class="text-gray-600">{formatTime(msg.ts)}</span>
						<span class="ml-1">[{msg.from.agent}]</span>
						<span class="ml-1">{msg.content.text}</span>
					</div>
				{:else}
					<div id="msg-{msg.id}" class="py-0.5 transition-colors duration-1000">
						<span class="text-xs text-gray-500">{formatTime(msg.ts)}</span>
						<span class="ml-1 font-medium {msg.from.type === 'human' ? 'text-emerald-400' : 'text-blue-400'}">[{msg.from.agent}]</span>
						<span class="ml-1 text-sm text-gray-200">{@html renderMessage(msg.content.text)}</span>
					</div>
				{/if}
			{/each}
			{#if currentMessages.length === 0}
				<div class="flex h-full items-center justify-center text-gray-600">No messages yet</div>
			{/if}
		</div>

		<!-- Input -->
		<div class="border-t border-gray-800 p-3">
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
				<button
					onclick={send}
					disabled={currentStatus !== 'connected' || !messageInput.trim()}
					class="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
				>
					Send
				</button>
			</div>
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
				<input
					type="text"
					bind:value={searchQuery}
					oninput={handleSearchInput}
					placeholder="Search messages..."
					class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500"
					autofocus
				/>
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
						<div
							class="p-2 rounded-md hover:bg-gray-800 cursor-pointer mb-1 transition-colors"
							onclick={() => scrollToMessage(result.id)}
						>
							<div class="flex items-center gap-2 text-xs text-gray-500 mb-1">
								<span>{formatDateTime(result.ts)}</span>
								<span class="font-medium {result.from.type === 'human' ? 'text-emerald-400' : 'text-blue-400'}">{result.from.agent}</span>
							</div>
							<div class="text-sm text-gray-300">{@html highlightMatch(result.content.text, searchQuery)}</div>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}

	<!-- Members sidebar -->
	<div class="hidden w-48 border-l border-gray-800 p-3 md:block">
		<h2 class="mb-2 text-xs font-semibold uppercase text-gray-500">Members ({sortedMembers.length})</h2>
		{#each sortedMembers as agent}
			<div class="flex items-center gap-2 py-1">
				<span class="inline-block h-2 w-2 rounded-full {agent.online ? 'bg-emerald-400' : 'bg-gray-600'}"></span>
				<span class="text-sm {agent.online ? (agent.type === 'human' ? 'text-emerald-400' : 'text-blue-400') : 'text-gray-500'}">{agent.name}</span>
			</div>
		{:else}
			<div class="text-xs text-gray-600">No members</div>
		{/each}
	</div>
</div>
