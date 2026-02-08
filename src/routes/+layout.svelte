<script lang="ts">
	import '../app.css';
	let { children, data } = $props();
</script>

<div class="min-h-screen bg-gray-950 text-gray-100">
	{#if data.user}
		<header class="flex items-center justify-between border-b border-gray-800 px-4 py-2">
			<h1 class="text-lg font-semibold text-emerald-400">Mesh Dashboard</h1>
			<div class="flex items-center gap-3">
				<span class="text-sm text-gray-400">{data.user.email}</span>
				<a href="/auth/logout" class="text-sm text-red-400 hover:text-red-300">Logout</a>
			</div>
		</header>
	{/if}
	{@render children()}
</div>
