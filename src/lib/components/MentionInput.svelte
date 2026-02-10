<script lang="ts">
	import type { PresenceInfo, MemberInfo } from '$lib/types.js';
	import { onMount, onDestroy } from 'svelte';
	import {
		createEditor,
		getRoot,
		getSelection,
		isRangeSelection,
		createParagraphNode,
		createTextNode,
		KEY_ENTER_COMMAND,
		COMMAND_PRIORITY_HIGH,
		isTextNode,
		TextNode,
		CodeNode,
		CodeHighlightNode,
		createCodeNode,
		isCodeNode,
		registerPlainText
	} from './lexical-helpers.js';

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

	let editorDiv: HTMLDivElement;
	let wrapperDiv: HTMLDivElement;
	let editor: ReturnType<typeof createEditor> | null = null;
	let showDropdown = $state(false);
	let selectedIndex = $state(0);
	let mentionStart = $state(-1);
	let query = $state('');
	let internalUpdate = false;
	let cleanups: (() => void)[] = [];

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

	// Watch for external value clears (e.g. after send)
	$effect(() => {
		if (value === '' && editor && !internalUpdate) {
			editor.update(() => {
				const root = getRoot();
				root.clear();
				root.append(createParagraphNode());
			});
		}
	});

	function getPlainText(): string {
		let text = '';
		if (!editor) return text;
		editor.getEditorState().read(() => {
			const root = getRoot();
			const children = root.getChildren();
			const parts: string[] = [];
			for (const child of children) {
				if (child.getType() === 'code') {
					parts.push('\n```\n' + child.getTextContent() + '\n```\n');
				} else {
					parts.push(child.getTextContent());
				}
			}
			text = parts.join('\n').trim();
		});
		return text;
	}

	function isInCodeBlock(): boolean {
		let inCode = false;
		if (editor) {
			editor.getEditorState().read(() => {
				const sel = getSelection();
				if (isRangeSelection(sel)) {
					let node = sel.anchor.getNode();
					let parent = node.getParent();
					while (parent) {
						if (parent.getType() === 'code') {
							inCode = true;
							return;
						}
						parent = parent.getParent();
					}
				}
			});
		}
		return inCode;
	}

	function checkForMention() {
		const text = getPlainText();
		// Get cursor position from editor
		let cursor = text.length;
		if (editor) {
			editor.getEditorState().read(() => {
				const sel = getSelection();
				if (isRangeSelection(sel)) {
					const anchor = sel.anchor;
					const node = anchor.getNode();
					let offset = anchor.offset;
					const prevSiblings = node.getPreviousSiblings();
					for (const sib of prevSiblings) {
						offset += sib.getTextContent().length;
					}
					let pNode = node.getParent();
					if (pNode) {
						const pPrev = pNode.getPreviousSiblings();
						for (const pp of pPrev) {
							offset += pp.getTextContent().length + 1;
						}
					}
					cursor = offset;
				}
			});
		}

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
		if (!editor) return;
		const text = getPlainText();
		// Get cursor position
		let cursor = text.length;
		editor.getEditorState().read(() => {
			const sel = getSelection();
			if (isRangeSelection(sel)) {
				const anchor = sel.anchor;
				const node = anchor.getNode();
				let offset = anchor.offset;
				const prevSiblings = node.getPreviousSiblings();
				for (const sib of prevSiblings) {
					offset += sib.getTextContent().length;
				}
				let pNode = node.getParent();
				if (pNode) {
					const pPrev = pNode.getPreviousSiblings();
					for (const pp of pPrev) {
						offset += pp.getTextContent().length + 1;
					}
				}
				cursor = offset;
			}
		});

		const before = text.slice(0, mentionStart);
		const after = text.slice(cursor);
		const newText = `${before}@${name} ${after}`;

		editor.update(() => {
			const root = getRoot();
			root.clear();
			const para = createParagraphNode();
			para.append(createTextNode(newText));
			root.append(para);
			// Set cursor after the mention
			const textNode = para.getFirstChild();
			if (isTextNode(textNode)) {
				const newPos = mentionStart + name.length + 2;
				textNode.select(newPos, newPos);
			}
		});

		showDropdown = false;
	}

	function autoResize() {
		if (!editorDiv) return;
		// The contenteditable div auto-grows; we just cap it
		const scrollH = editorDiv.scrollHeight;
		if (scrollH > 200) {
			editorDiv.style.maxHeight = '200px';
			editorDiv.style.overflowY = 'auto';
		} else {
			editorDiv.style.maxHeight = '';
			editorDiv.style.overflowY = '';
		}
	}

	onMount(() => {
		const theme = {
			code: 'lexical-code',
			paragraph: 'lexical-paragraph',
			text: {}
		};

		editor = createEditor({
			namespace: 'MentionInput',
			theme,
			nodes: [CodeNode, CodeHighlightNode],
			onError: (error: Error) => {
				console.error('Lexical error:', error);
			}
		});

		editor.setRootElement(editorDiv);

		// Register plain text plugin
		cleanups.push(registerPlainText(editor));

		// Listen for text changes
		cleanups.push(
			editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
				editorState.read(() => {
					const text = getRoot().getTextContent();
					internalUpdate = true;
					value = text;
					internalUpdate = false;
				});
				requestAnimationFrame(autoResize);
				// Check mentions on every update
				setTimeout(checkForMention, 0);
			})
		);

		// Handle triple-backtick detection: consume ``` and insert a CodeNode
		cleanups.push(
			editor.registerNodeTransform(TextNode, (node) => {
				// Don't transform text nodes inside code blocks
				const parent = node.getParent();
				if (!parent || parent.getType() === 'code') return;

				const text = node.getTextContent();
				const idx = text.indexOf('```');
				if (idx === -1) return;

				const before = text.slice(0, idx);
				const after = text.slice(idx + 3);
				const parentPara = parent;

				// Build nodes to insert after the current paragraph
				const codeNode = createCodeNode();
				const nodesToInsert: any[] = [];

				if (before) {
					// Keep text before ``` in original paragraph
					node.setTextContent(before);
				} else {
					// Nothing before — remove the text node
					node.remove();
				}

				// Add the code block
				nodesToInsert.push(codeNode);

				// Add text after ``` in a new paragraph
				if (after.trim()) {
					const afterPara = createParagraphNode();
					afterPara.append(createTextNode(after));
					nodesToInsert.push(afterPara);
				}

				// Insert all nodes after the parent paragraph
				let insertAfter = parentPara;
				for (const n of nodesToInsert) {
					insertAfter.insertAfter(n);
					insertAfter = n;
				}

				// Clean up empty parent paragraph
				if (parentPara.getChildrenSize() === 0) {
					parentPara.remove();
				}

				// Focus inside the code block
				codeNode.selectEnd();
			})
		);

		// Enter key handling
		cleanups.push(
			editor.registerCommand(
				KEY_ENTER_COMMAND,
				(event: KeyboardEvent | null) => {
					if (!event) return false;

					// If dropdown is showing, don't handle here (handled in wrapper keydown)
					if (showDropdown && suggestions.length > 0) {
						return true; // prevent default
					}

					const wantsNewline = event.shiftKey || event.altKey || event.ctrlKey;

					if (wantsNewline) {
						// Let Lexical handle newline insertion naturally
						return false;
					}

					// Normal Enter: send message
					event.preventDefault();
					parentKeydown?.(event);
					return true;
				},
				COMMAND_PRIORITY_HIGH
			)
		);
	});

	onDestroy(() => {
		cleanups.forEach((c) => c());
		cleanups = [];
	});

	function handleWrapperKeydown(e: KeyboardEvent) {
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

		// Forward non-Enter keys to parent
		if (e.key !== 'Enter') {
			parentKeydown?.(e);
		}
	}

	function handleClick() {
		setTimeout(checkForMention, 0);
	}
</script>

<div class="relative flex-1" bind:this={wrapperDiv}>
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
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		bind:this={editorDiv}
		class="w-full resize-none overflow-y-auto {className}"
		style="max-height: 200px; min-height: 1.5rem; outline: none; white-space: pre-wrap; word-wrap: break-word;"
		contenteditable={!disabled}
		role="textbox"
		tabindex="0"
		aria-placeholder={placeholder}
		aria-disabled={disabled}
		data-placeholder={placeholder}
		onkeydown={handleWrapperKeydown}
		onclick={handleClick}
	></div>
</div>

<style>
	[data-placeholder]:empty::before {
		content: attr(data-placeholder);
		color: rgb(156 163 175);
		pointer-events: none;
	}
	:global(.lexical-code) {
		font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
		background-color: rgb(31 41 55 / 0.5);
		border-radius: 0.25rem;
		padding: 0.25rem 0.5rem;
		font-size: 0.875rem;
		line-height: 1.25rem;
		display: block;
		white-space: pre;
	}
	:global(.lexical-paragraph) {
		margin: 0;
	}
</style>
