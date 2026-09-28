/**
 * #866 review round 5: `push --dry-run` must not write what only the real push
 * may write.
 *
 * `pushCore` reaches its own dry-run guard at step 2, but the block just before
 * it ran for real: beside the pre-scan that brings the member's local copies up
 * to the team repo (which the preview NEEDS — the scanners compare against the
 * team repo, and skipping the sync makes a preview silently under-report, see
 * #812's first case) sits a `saveStateForScope` that records the revision those
 * copies were brought to. That record outlives the preview and is not part of
 * answering "what would be pushed".
 *
 * The fixture is a project-scope install with a linked worktree, because that is
 * the shape where the write is reachable at all: `recordsBase` is
 * `bases.source === 'checkout'`, and a fresh self-mode clone (no record) never
 * reaches it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateSchema } from '../../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

const R1 = '# Team rule\n\nVersion one.\n';
const R2 = '# Team rule\n\nVersion two, from a teammate.\n';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

function runCLI(args: string[], cwd: string, home: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** Every `state.json` under `dir`, which is where a scope keeps its records. */
function findStateFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => path.basename(rel) === 'state.json')
    .map((rel) => path.join(dir, rel));
}

describe('push --dry-run writes no state and no local copy (#866)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let worktree: string;
  let teammate: string;

  const ruleIn = (root: string) => path.join(root, '.claude', 'rules', 'team-rule.md');

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-866-e2e-')));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    worktree = path.join(sandbox, 'wt-b');
    teammate = path.join(sandbox, 'teammate');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team-remote.git');
    const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(seed, 'rules'), { recursive: true });
    fs.writeFileSync(
      path.join(seed, 'teamai.yaml'),
      'team: issue-866-e2e\nrepo: https://example.com/team.git\nprovider: tgit\n',
    );
    fs.writeFileSync(path.join(seed, 'rules', 'team-rule.md'), R1);
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    git(['clone', '-q', remote, teammate], sandbox);

    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), '{}\n');
    fs.writeFileSync(
      path.join(projectRoot, '.gitignore'),
      '.teamai/\n.claude/skills/\n.claude/rules/\n.claude/agents/\n',
    );
    git(['init', '-q', '-b', 'main'], projectRoot);
    git(['add', '-A'], projectRoot);
    git(['commit', '-q', '-m', 'project'], projectRoot);

    fs.mkdirSync(path.join(projectRoot, '.teamai'), { recursive: true });
    git(['clone', '-q', remote, teamRepo], sandbox);
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      'username: ci-866',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      'enabledAgents: [claude]',
      '',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const run = async (args: string[], cwd: string): Promise<string> => {
    const r = await runCLI(args, cwd, home);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };

  it('records no push base for a revision the preview only read', async () => {
    // Both checkouts pull R1, so the worktree has a checkout record.
    await run(['pull'], projectRoot);
    if (!fs.existsSync(worktree)) {
      git(['worktree', 'add', '-q', worktree, '-b', 'wt-b'], projectRoot);
    }
    await run(['pull'], worktree);

    // A teammate publishes R2. Only the main checkout pulls it, so the
    // worktree's copy is still R1 and its record still names R1.
    fs.writeFileSync(path.join(teammate, 'rules', 'team-rule.md'), R2);
    try {
      git(['commit', '-q', '-am', 'rule R2'], teammate);
    } catch {
      // Already published by the config's one retry.
    }
    git(['push', '-q', 'origin', 'main'], teammate);
    await run(['pull'], projectRoot);

    // The state file the worktree shares, before the preview.
    const stateFile = findStateFiles(path.join(home, '.teamai'))
      .concat(findStateFiles(path.join(projectRoot, '.teamai')))
      .find((file) => {
        try {
          return StateSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).lastPullByWorkspace !== undefined;
        } catch {
          return false;
        }
      });
    expect(stateFile).toBeDefined();
    const before = fs.readFileSync(stateFile!, 'utf8');

    // The preview still has to SEE the teammate's update — under-reporting is
    // the defect #812's first case exists to prevent — so the sync it needs
    // runs, and the worktree's copy is brought up to R2 (#812). Compared with
    // line endings normalised: the sync writes through a helper that keeps the
    // platform's, which is not what this case is about.
    const output = await run(['--dry-run', 'push'], worktree);
    expect(output).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(ruleIn(worktree), 'utf8').replace(/\r\n/g, '\n')).toBe(R2);

    // But the revision the sync reached must not be recorded as a push base:
    // that record outlives the preview, and the real push writes its own after
    // its own sync.
    expect(fs.readFileSync(stateFile!, 'utf8')).toBe(before);
  }, 120_000);
});
