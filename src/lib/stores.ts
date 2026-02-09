import { writable } from 'svelte/store';
import type { MessageEnvelope, PresenceInfo, MemberInfo } from './types.js';

export const messages = writable<MessageEnvelope[]>([]);
export const presence = writable<Map<string, PresenceInfo>>(new Map());
export const connectionStatus = writable<'disconnected' | 'connecting' | 'connected'>('disconnected');
export const systemEvents = writable<MessageEnvelope[]>([]);
export const members = writable<Map<string, MemberInfo>>(new Map());
