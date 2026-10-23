import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadLocalConfigForScope: vi.fn(),
  requireInit: vi.fn(),
  detectProjectConfig: vi.fn(),
}));

vi.mock('../dashboard-collector.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dashboard-collector.js')>()),
  readEvents: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn(),
  pushRepoDirectly: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    persist: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

import { saveSession } from '../save-session.js';
import { detectProjectConfig, loadLocalConfigForScope, requireInit } from '../config.js';
import { readEvents } from '../dashboard-collector.js';
import { log } from '../utils/logger.js';
import type { DashboardEvent, LocalConfig } from '../types.js';

/**
 * The push destination is `sessions/<username>/<month>.md`. A --dry-run load
 * answers with the bootstrap preview for a self-mode install that has never
 * been bootstrapped, and that preview carries no username — the message must
 * show a placeholder there, not an empty path segment (#853 review).
 */
describe('session save --push --dry-run', () => {
  const event = {
    type: 'prompt_submit',
    sessionId: 'session-1',
    timestamp: '2026-09-27T00:00:00.000Z',
    tool: 'claude',
  } as unknown as DashboardEvent;

  beforeEach(() => {
    vi.mocked(readEvents).mockResolvedValue([event]);
    vi.mocked(log.info).mockClear();
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.error).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockConfig(username: string): void {
    const localConfig = {
      repo: { localPath: '/repo', remote: 'https://github.com/acme/team.git' },
      username,
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    } as LocalConfig;
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig as never);
    vi.mocked(detectProjectConfig).mockResolvedValue(localConfig as never);
    vi.mocked(requireInit).mockResolvedValue({ localConfig, teamConfig: {} as never });
  }

  it('shows the username when the config carries one', async () => {
    mockConfig('dev');

    await saveSession({ push: true, force: true, dryRun: true, sessionId: 'session-1' });

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('Would push session summary to sessions/dev/2026-09.md'),
    );
  });

  it('shows a placeholder instead of an empty segment when the username is unknown (#853 review)', async () => {
    // The dry-run bootstrap preview of a fresh self-mode clone: no username.
    mockConfig('');

    await saveSession({ push: true, force: true, dryRun: true, sessionId: 'session-1' });

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('Would push session summary to sessions/<username>/2026-09.md'),
    );
    const lines = vi.mocked(log.info).mock.calls.map(([m]) => String(m));
    expect(lines.some((line) => line.includes('sessions//'))).toBe(false);
  });
});
