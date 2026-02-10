import { writable } from 'svelte/store';
import type { MessageEnvelope, PresenceInfo, MemberInfo, TelemetryPayload } from './types.js';

export const messages = writable<MessageEnvelope[]>([]);
export const presence = writable<Map<string, PresenceInfo>>(new Map());
export const connectionStatus = writable<'disconnected' | 'connecting' | 'connected'>('disconnected');
export const systemEvents = writable<MessageEnvelope[]>([]);
export const members = writable<Map<string, MemberInfo>>(new Map());
export const telemetry = writable<Map<string, TelemetryPayload>>(new Map());
export const receipts = writable<Map<string, string[]>>(new Map());
export const sentMessageIds = writable<Set<string>>(new Set());
