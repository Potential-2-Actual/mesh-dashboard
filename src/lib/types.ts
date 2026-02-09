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

export interface TelemetrySessionInfo {
	key: string;
	kind: string;
	channel: string;
	tokens: number;
	contextMax: number;
	updatedAt: number;
	model?: string;
}

export interface TelemetryPayload {
	agent: string;
	version: string;
	model: string;
	uptime: number;
	sessions: {
		total: number;
		active: number;
		list: TelemetrySessionInfo[];
	};
	subAgents: {
		running: number;
		completed: number;
	};
	ts: number;
}
