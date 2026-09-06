import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CiChromiumSandbox } from '../scripts/ci-chromium-sandbox.mjs';

const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
  RUNNER_TEMP: '/home/runner/work/_temp', GITHUB_ENV: '/home/runner/work/_temp/_runner_file_commands/set_env_abcd-1234',
  GITHUB_RUN_ID: '34016678876', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'javascript' };
const identity = { platform: 'linux', uid: 1001, username: 'runner', runnerHome: '/home/runner' };
const binary = '/home/runner/.cache/ms-playwright/chromium-1212/chrome-linux64/chrome';
const directory = '/home/runner/work/_temp/bpane-ci-chromium-abcdef';
const context = () => CiChromiumSandbox.context(env, identity);
const owner = () => CiChromiumSandbox.owner(context(), directory, binary, 'ab'.repeat(12));

test('CI guard rejects local, self-hosted, root and malformed runner environments without side effects', () => {
  assert.equal(context().job, 'javascript');
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_OS: 'macOS' },
    { RUNNER_TEMP: '/tmp' }, { GITHUB_RUN_ID: '1\nprofile unsafe' }, { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_JOB: '../job' }, { GITHUB_ENV: '/etc/profile' }]) assert.throws(() => CiChromiumSandbox.context({ ...env, ...patch }, identity));
  for (const patch of [{ platform: 'darwin' }, { platform: 'win32' }, { uid: 0 }, { username: 'operator' },
    { runnerHome: '/home/operator' }]) assert.throws(() => CiChromiumSandbox.context(env, { ...identity, ...patch }));
});

test('profile permits userns for one exact cache binary without globbing or global changes', () => {
  const profile = CiChromiumSandbox.profile(owner());
  assert.equal(profile, `abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile ${owner().name} "${binary}" flags=(unconfined) {\n  userns,\n}\n`);
  assert.equal((profile.match(/userns,/g) ?? []).length, 1);
  assert(!/[?*{}]/.test(binary)); assert(!profile.includes('sysctl')); assert(!profile.includes('no-sandbox'));
  assert.equal(CiChromiumSandbox.binary(binary.replace('chrome-linux64', 'chrome-linux')), binary.replace('chrome-linux64', 'chrome-linux'));
  for (const path of [binary.replace('1212', '*'), '/usr/bin/chromium', binary + '"\nuserns,',
    binary.replace('/chrome-linux64/', '/../chrome-linux64/'), binary.replace('chromium-1212', 'chromium_headless_shell-1212'),
    binary.replace('/home/runner/', '/home/operator/')]) assert.throws(() => CiChromiumSandbox.binary(path));
});

test('cleanup manifest is bound to exact run/attempt/job/user/directory/profile bytes', () => {
  const owned = owner(), profile = CiChromiumSandbox.profile(owned);
  assert.deepEqual(CiChromiumSandbox.validateOwner(context(), directory, owned, profile), owned);
  for (const patch of [{ run: '2' }, { attempt: '2' }, { job: 'other' }, { uid: 0 }, { directory: '/tmp/other' },
    { name: 'chrome' }, { nonce: 'injected' }, { binary: '/usr/bin/chrome' }, { extra: true }])
    assert.throws(() => CiChromiumSandbox.validateOwner(context(), directory, { ...owned, ...patch }, profile));
  for (const path of ['/home/runner/work/_temp', directory + '/..', '/tmp/bpane-ci-chromium-abcdef'])
    assert.throws(() => CiChromiumSandbox.validateOwner(context(), path, owned, profile));
  assert.throws(() => CiChromiumSandbox.validateOwner(context(), directory, owned, profile.replace('userns,', 'capability,')));
});

test('unprivileged path guard rejects links, wrong ownership and unexpected path types', async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'bpane-ci-profile-test-')));
  try {
    const file = join(temporary, 'owned'), link = join(temporary, 'link');
    await writeFile(file, 'synthetic'); await symlink(file, link);
    const uid = process.getuid();
    assert((await CiChromiumSandbox.checkedPath(file, uid)).isFile());
    await assert.rejects(CiChromiumSandbox.checkedPath(link, uid));
    await assert.rejects(CiChromiumSandbox.checkedPath(file, uid + 1));
    await assert.rejects(CiChromiumSandbox.checkedPath(temporary, uid));
  } finally { await rm(temporary, { recursive: true }); }
});

test('workflow always removes only the registered profile after sandboxed browser checks', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/bundle.yml', import.meta.url), 'utf8');
  const install = workflow.indexOf('node scripts/ci-chromium-sandbox.mjs install');
  const check = workflow.indexOf('run: npm run test:mcp');
  const cleanup = workflow.indexOf('node scripts/ci-chromium-sandbox.mjs remove');
  assert(install > 0 && install < check && cleanup > check);
  assert.match(workflow.slice(cleanup - 100, cleanup), /if: always\(\)/);
  assert(!workflow.includes('apparmor_restrict_unprivileged_userns'));
});
