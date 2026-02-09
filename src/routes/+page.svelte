<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { messages, presence, connectionStatus } from '$lib/stores.js';
	import MentionInput from '$lib/components/MentionInput.svelte';
	import { connectNats, publishMessage, disconnectNats } from '$lib/nats-client.js';
	import type { MessageEnvelope } from '$lib/types.js';

	let messageInput = $state('');
	let feedEl: HTMLElement;
	let currentMessages: MessageEnvelope[] = $state([]);
	let currentPresence: Map<string, any> = $state(new Map());
	let currentStatus: string = $state('disconnected');

	const unsubMsgs = messages.subscribe((v) => { currentMessages = v; scrollToBottom(); });
	const unsubPresence = presence.subscribe((v) => { currentPresence = v; });
	const unsubStatus = connectionStatus.subscribe((v) => { currentStatus = v; });

	async function scrollToBottom() {
		await tick();
		if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
	}

	function formatTime(ts: number): string {
		return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	onMount(async () => {
		// Load history
		try {
			const res = await fetch('/api/history');
			if (res.ok) {
				const history: MessageEnvelope[] = await res.json();
				messages.set(history);
			}
		} catch { /* skip */ }

		// Get NATS token and connect
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
		unsubMsgs();
		unsubPresence();
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
		</div>

		<!-- Message feed -->
		<div bind:this={feedEl} class="flex-1 overflow-y-auto px-4 py-2 space-y-1">
			{#each currentMessages as msg (msg.id)}
				{#if isSystemMessage(msg)}
					<div class="text-xs italic text-gray-500 py-0.5">
						<span class="text-gray-600">{formatTime(msg.ts)}</span>
						<span class="ml-1">[{msg.from.agent}]</span>
						<span class="ml-1">{msg.content.text}</span>
					</div>
				{:else}
					<div class="py-0.5 {msg.from.type === 'human' ? '' : ''}">
						<span class="text-xs text-gray-500">{formatTime(msg.ts)}</span>
						<span class="ml-1 font-medium {msg.from.type === 'human' ? 'text-emerald-400' : 'text-blue-400'}">[{msg.from.agent}]</span>
						<span class="ml-1 text-sm text-gray-200">{msg.content.text}</span>
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

	<!-- Presence sidebar -->
	<div class="hidden w-48 border-l border-gray-800 p-3 md:block">
		<h2 class="mb-2 text-xs font-semibold uppercase text-gray-500">Online</h2>
		{#each [...currentPresence.values()] as agent}
			<div class="flex items-center gap-2 py-1">
				<span class="inline-block h-2 w-2 rounded-full bg-emerald-400"></span>
				<span class="text-sm {agent.type === 'human' ? 'text-emerald-400' : 'text-blue-400'}">{agent.agent}</span>
			</div>
		{:else}
			<div class="text-xs text-gray-600">No agents online</div>
		{/each}
	</div>
</div>
