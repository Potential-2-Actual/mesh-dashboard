import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { readFileSync } from 'fs';

const SEED_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedSeed: string | null = null;

function getReadSeed(): string {
	if (cachedSeed) return cachedSeed;
	const seedPath = env.NATS_READ_SEED_PATH;
	if (!seedPath) throw error(500, 'NATS read seed not configured');
	cachedSeed = readFileSync(seedPath, 'utf-8').split('\n')[0].trim();
	return cachedSeed;
}

export const GET: RequestHandler = async (event) => {
	const session = await event.locals.auth();
	if (!session?.user) {
		throw error(401, 'Unauthorized');
	}

	const seed = getReadSeed();
	const expiresAt = Date.now() + SEED_TTL_MS;

	return json(
		{ seed, expiresAt, ttlMs: SEED_TTL_MS },
		{
			headers: {
				'Cache-Control': 'no-store, no-cache, must-revalidate',
				Pragma: 'no-cache'
			}
		}
	);
};
