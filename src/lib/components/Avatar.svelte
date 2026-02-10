<script lang="ts">
	const EMOJI_OVERRIDES: Record<string, string> = {
		sentinel: '🛡️',
		junior: '🤖',
	};

	function hashHue(name: string): number {
		let hash = 0;
		for (let i = 0; i < name.length; i++) {
			hash = name.charCodeAt(i) + ((hash << 5) - hash);
		}
		return ((hash % 360) + 360) % 360;
	}

	interface Props {
		name: string;
		type?: 'human' | 'ai';
		size?: number;
	}

	let { name, type = 'ai', size = 24 }: Props = $props();

	let emoji = $derived(EMOJI_OVERRIDES[name.toLowerCase()]);
	let initial = $derived(name.charAt(0).toUpperCase());
	let hue = $derived(hashHue(name));
	let bg = $derived(`hsl(${hue}, 55%, 35%)`);
	let fontSize = $derived(Math.round(size * 0.45));
</script>

{#if emoji}
	<span
		class="inline-flex items-center justify-center flex-shrink-0 rounded-full"
		style="width:{size}px;height:{size}px;font-size:{fontSize + 2}px;background:rgba(255,255,255,0.08)"
		title={name}
	>{emoji}</span>
{:else}
	<span
		class="inline-flex items-center justify-center flex-shrink-0 rounded-full text-white font-semibold select-none"
		style="width:{size}px;height:{size}px;font-size:{fontSize}px;background:{bg}"
		title={name}
	>{initial}</span>
{/if}
