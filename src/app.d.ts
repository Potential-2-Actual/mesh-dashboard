declare global {
	namespace App {
		interface Locals {
			user: { email: string; name: string } | null;
		}
		interface PageData {
			user: { email: string; name: string } | null;
		}
	}
}

export {};
