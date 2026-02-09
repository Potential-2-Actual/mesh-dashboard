<script lang="ts">
	import type { PresenceInfo } from '$lib/types.js';

	let {
		value = $bindable(''),
		presence,
		onkeydown: parentKeydown,
		disabled = false,
		placeholder = 'Type a message...',
		class: className = ''
	}: {
		value: string;
		presence: Map<string, PresenceInfo>;
		onkeydown?: (e: KeyboardEvent) => void;
		disabled?: boolean;
		placeholder?: string;
		class?: string;
	} = $props();

	let inputEl: HTMLInputElement;
	let showDropdown = $state(false);
	let selectedIndex = $state(0);
	let mentionStart = $state(-1); // index of the '@' in the string
	let query = $state('');

	let suggestions = $derived.by(() => {
		if (!showDropdown) return [];
		const names = [...presence.values()].map((p) => ({ name: p.agent, type: p.type }));
		if (!query) return names;
		const q = query.toLowerCase();
		return names.filter((n) => n.name.toLowerCase().includes(q));
	});

	// Close when no matches
	$effect(() => {
		if (showDropdown && suggestions.length === 0) {
			showDropdown = false;
		}
	});

	// Clamp selectedIndex
	$effect(() => {
		if (selectedIndex >= suggestions.length) {
			selectedIndex = Math.max(0, suggestions.length - 1);
		}
	});

	function checkForMention() {
		const cursor = inputEl?.selectionStart ?? 0;
		const text = value;
		// Walk backwards from cursor to find '@'
		let i = cursor - 1;
		while (i >= 0) {
			const ch = text[i];
			if (ch === '@') {
				// Found it — everything between @ and cursor is the query
				mentionStart = i;
				query = text.slice(i + 1, cursor);
				showDropdown = true;
				selectedIndex = 0;
				return;
			}
			if (ch === ' ' || ch === '\n') break;
			i--;
		}
		showDropdown = false;
	}

	function selectSuggestion(name: string) {
		const cursor = inputEl?.selectionStart ?? 0;
		const before = value.slice(0, mentionStart);
		const after = value.slice(cursor);
		value = `${before}@${name} ${after}`;
		showDropdown = false;
		// Set cursor after inserted mention
		const newPos = mentionStart + name.length + 2; // @name + space
		requestAnimationFrame(() => {
			inputEl?.focus();
			inputEl?.setSelectionRange(newPos, newPos);
		});
	}

	function handleInput() {
		checkForMention();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (showDropdown && suggestions.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				selectedIndex = (selectedIndex + 1) % suggestions.length;
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				selectedIndex = (selectedIndex - 1 + suggestions.length) % suggestions.length;
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				selectSuggestion(suggestions[selectedIndex].name);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				showDropdown = false;
				return;
			}
		}
		// Pass through to parent handler
		parentKeydown?.(e);
	}

	function handleClick(e: MouseEvent) {
		// Re-check on click since cursor may have moved
		setTimeout(checkForMention, 0);
	}
</script>

<div class="relative flex-1">
	{#if showDropdown && suggestions.length > 0}
		<div class="absolute bottom-full left-0 mb-1 w-56 max-h-[216px] overflow-y-auto rounded-md border border-gray-700 bg-gray-800 shadow-lg z-50">
			{#each suggestions as suggestion, i}
				<button
					type="button"
					class="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-gray-700 {i === selectedIndex ? 'bg-gray-700' : ''}"
					onmousedown={(e) => { e.preventDefault(); selectSuggestion(suggestion.name); }}
					onmouseenter={() => { selectedIndex = i; }}
				>
					<span class="inline-block h-2 w-2 rounded-full {suggestion.type === 'human' ? 'bg-emerald-400' : 'bg-blue-400'}"></span>
					<span class="{suggestion.type === 'human' ? 'text-emerald-400' : 'text-blue-400'}">{suggestion.name}</span>
				</button>
			{/each}
		</div>
	{/if}
	<input
		bind:this={inputEl}
		type="text"
		bind:value={value}
		oninput={handleInput}
		onkeydown={handleKeydown}
		onclick={handleClick}
		{placeholder}
		{disabled}
		class={className}
	/>
</div>
