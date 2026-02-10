<script lang="ts">
	import type { PresenceInfo, MemberInfo } from '$lib/types.js';

	let {
		value = $bindable(''),
		presence,
		members,
		onkeydown: parentKeydown,
		disabled = false,
		placeholder = 'Type a message...',
		class: className = ''
	}: {
		value: string;
		presence?: Map<string, PresenceInfo>;
		members?: Map<string, MemberInfo>;
		onkeydown?: (e: KeyboardEvent) => void;
		disabled?: boolean;
		placeholder?: string;
		class?: string;
	} = $props();

	let inputEl: HTMLTextAreaElement;
	let showDropdown = $state(false);
	let selectedIndex = $state(0);
	let mentionStart = $state(-1);
	let query = $state('');

	let suggestions = $derived.by(() => {
		if (!showDropdown) return [];
		let names: { name: string; type: string; online: boolean }[] = [];
		if (members && members.size > 0) {
			for (const [, m] of members) {
				const online = presence ? presence.has(m.name) : false;
				names.push({ name: m.name, type: m.type, online });
			}
		} else if (presence) {
			for (const [, p] of presence) {
				names.push({ name: p.agent, type: p.type, online: true });
			}
		}
		names.sort((a, b) => {
			if (a.online !== b.online) return a.online ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		if (!query) return names;
		const q = query.toLowerCase();
		return names.filter((n) => n.name.toLowerCase().includes(q));
	});

	$effect(() => {
		if (showDropdown && suggestions.length === 0) {
			showDropdown = false;
		}
	});

	$effect(() => {
		if (selectedIndex >= suggestions.length) {
			selectedIndex = Math.max(0, suggestions.length - 1);
		}
	});

	function isInCodeBlock(text: string, cursorPos: number): boolean {
		const beforeCursor = text.substring(0, cursorPos);
		const matches = beforeCursor.match(/```/g);
		return matches ? matches.length % 2 !== 0 : false;
	}

	function autoResize() {
		if (!inputEl) return;
		inputEl.style.height = 'auto';
		inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
	}

	function checkForMention() {
		const cursor = inputEl?.selectionStart ?? 0;
		const text = value;
		let i = cursor - 1;
		while (i >= 0) {
			const ch = text[i];
			if (ch === '@') {
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
		const newPos = mentionStart + name.length + 2;
		requestAnimationFrame(() => {
			inputEl?.focus();
			inputEl?.setSelectionRange(newPos, newPos);
			autoResize();
		});
	}

	function handleInput() {
		checkForMention();
		autoResize();
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
			if (e.key === 'Enter' || e.key === 'Tab') {
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

		if (e.key === 'Enter') {
			if (e.altKey || e.ctrlKey) {
				// Opt+Enter (Mac) / Ctrl+Enter (PC): insert newline
				requestAnimationFrame(autoResize);
				return;
			}
			const cursorPos = inputEl?.selectionStart ?? 0;
			if (isInCodeBlock(value, cursorPos)) {
				// Inside code block: let default behavior insert newline
				requestAnimationFrame(autoResize);
				return;
			}
			// Normal Enter: send (prevent newline, call parent)
			e.preventDefault();
			parentKeydown?.(e);
			requestAnimationFrame(autoResize);
			return;
		}

		parentKeydown?.(e);
	}

	function handleClick(e: MouseEvent) {
		setTimeout(checkForMention, 0);
	}

	// Reset height when value is cleared (after send)
	$effect(() => {
		// Track value changes
		value;
		requestAnimationFrame(autoResize);
	});
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
					<span class="inline-block h-2 w-2 rounded-full {suggestion.online ? (suggestion.type === 'human' ? 'bg-emerald-400' : 'bg-blue-400') : 'bg-gray-500'}"></span>
					<span class="{suggestion.online ? (suggestion.type === 'human' ? 'text-emerald-400' : 'text-blue-400') : 'text-gray-500'}">{suggestion.name}</span>
				</button>
			{/each}
		</div>
	{/if}
	<textarea
		bind:this={inputEl}
		bind:value={value}
		oninput={handleInput}
		onkeydown={handleKeydown}
		onclick={handleClick}
		{placeholder}
		{disabled}
		rows="1"
		class="w-full resize-none overflow-y-auto {className}"
		style="max-height: 200px;"
	></textarea>
</div>
