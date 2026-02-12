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

export interface SessionHistoryMessage {
	id: string;
	role: 'user' | 'assistant' | 'toolResult';
	content: Array<{ type: string; text?: string; name?: string; id?: string; success?: boolean }>;
	timestamp: string;
}

export interface SessionHistoryResponse {
	sessionKey: string;
	sessionId: string;
	messages: SessionHistoryMessage[];
	total: number;
}

export interface SessionSendResponse {
	sessionKey: string;
	reply?: string;
	error?: string;
	success: boolean;
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
	tokens?: {
		totalInput: number;
		totalOutput: number;
		last24hInput: number;
		last24hOutput: number;
	};
	messages?: {
		sent: number;
		received: number;
		errors: number;
	};
	system?: {
		cpuPercent: number;
		memoryMB: number;
		memoryPercent: number;
		pid: number;
	};
	ts: number;
}
