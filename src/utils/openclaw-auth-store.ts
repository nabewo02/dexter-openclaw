import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function resolveUserPath(inputPath: string): string {
  if (inputPath === '~') {
    return homedir();
  }
  if (inputPath.startsWith('~/')) {
    return path.join(homedir(), inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

function normalizeAgentId(agentId: string): string {
  return agentId.trim().toLowerCase();
}

export function resolveOpenClawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override);
  }
  return path.join(homedir(), '.openclaw');
}

export function resolveOpenClawProfileId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OPENCLAW_AUTH_PROFILE_ID?.trim() || env.OPENCLAW_PROFILE_ID?.trim() || undefined;
}

function authStorePathForAgent(stateDir: string, agentId: string): string {
  return path.join(stateDir, 'agents', normalizeAgentId(agentId), 'agent', 'auth-profiles.json');
}

function listAuthStoreCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicitPath = env.OPENCLAW_AUTH_STORE_PATH?.trim();
  if (explicitPath) {
    return [resolveUserPath(explicitPath)];
  }

  const stateDir = resolveOpenClawStateDir(env);
  const candidates: string[] = [];
  const explicitAgentId = env.OPENCLAW_AGENT_ID?.trim();
  if (explicitAgentId) {
    candidates.push(authStorePathForAgent(stateDir, explicitAgentId));
  }

  const agentsDir = path.join(stateDir, 'agents');
  if (existsSync(agentsDir)) {
    const agentIds = readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => {
        if (a === 'main') return -1;
        if (b === 'main') return 1;
        return a.localeCompare(b);
      });

    for (const agentId of agentIds) {
      candidates.push(authStorePathForAgent(stateDir, agentId));
    }
  }

  candidates.push(authStorePathForAgent(stateDir, 'main'));
  return [...new Set(candidates)];
}

function hasProviderProfile(authStorePath: string, provider: string): boolean {
  try {
    const raw = readFileSync(authStorePath, 'utf8');
    const store = JSON.parse(raw) as { profiles?: Record<string, { provider?: string }> };
    return Object.values(store.profiles ?? {}).some((profile) => profile?.provider === provider);
  } catch {
    return false;
  }
}

export function resolveOpenClawAuthStorePath(
  provider = 'openai-codex',
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidates = listAuthStoreCandidates(env);

  for (const candidate of candidates) {
    if (existsSync(candidate) && hasProviderProfile(candidate, provider)) {
      return candidate;
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? authStorePathForAgent(resolveOpenClawStateDir(env), 'main');
}
