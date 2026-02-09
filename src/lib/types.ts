export interface MessageEnvelope {
	v: number;
	id: string;
	from: { agent: string; type: 'human' | 'ai' | 'system' };
	to: { subject: string };
	content: { text: string };
	ts: number;
	replyTo: string | null;
}

export interface PresenceInfo {
	agent: string;
	type: string;
	status: 'online' | 'offline';
	lastSeen: number;
}

export interface MemberInfo {
	name: string;
	type: 'human' | 'ai';
	joinedAt: number;
}
