import { writable } from 'svelte/store';
import type { MessageEnvelope, PresenceInfo, MemberInfo, TelemetryPayload } from './types.js';

export const messages = writable<MessageEnvelope[]>([]);
// Load presence from localStorage cache for instant rendering
function loadCachedPresence(): Map<string, PresenceInfo> {
	try {
		const cached = typeof localStorage !== 'undefined' ? localStorage.getItem('mesh-presence-cache') : null;
		if (cached) {
			const entries: [string, PresenceInfo][] = JSON.parse(cached);
			return new Map(entries);
		}
	} catch { /* ignore */ }
	return new Map();
}

export const presence = writable<Map<string, PresenceInfo>>(loadCachedPresence());

// Persist presence to localStorage on every update
presence.subscribe((p) => {
	try {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('mesh-presence-cache', JSON.stringify([...p.entries()]));
		}
	} catch { /* ignore */ }
});
export const connectionStatus = writable<'disconnected' | 'connecting' | 'connected'>('disconnected');
export const systemEvents = writable<MessageEnvelope[]>([]);
export const members = writable<Map<string, MemberInfo>>(new Map());
export const telemetry = writable<Map<string, TelemetryPayload>>(new Map());
export const receipts = writable<Map<string, string[]>>(new Map());
export const sentMessageIds = writable<Set<string>>(new Set());
export const activeChannel = writable<string>('general');
export const unreadChannels = writable<Set<string>>(new Set());
