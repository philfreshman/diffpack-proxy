import { env } from "cloudflare:workers";

export const TEST_GITHUB_TOKEN = String(env.GITHUB_TOKEN);
