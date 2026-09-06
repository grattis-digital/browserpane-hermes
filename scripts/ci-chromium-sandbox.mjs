import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, lstat, mkdtemp, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

/** CI-only application of Chromium's documented per-executable AppArmor option:
 * https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
 * This is an ephemeral runner exception, not protection against malicious CI code.
 */
export class CiChromiumSandbox {
  static directoryKey = 'BPANE_CI_CHROMIUM_SANDBOX_DIR';

  static context(env, identity) {
    assert.equal(identity.platform, 'linux', 'Only GitHub-hosted Linux is supported');
    assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
    assert.equal(env.RUNNER_OS, 'Linux'); assert.equal(identity.username, 'runner');
    assert.equal(identity.runnerHome, '/home/runner'); assert(Number.isInteger(identity.uid) && identity.uid > 0);
    assert.equal(env.RUNNER_TEMP, '/home/runner/work/_temp', 'Unexpected hosted runner temp path');
    assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]{0,19}$/);
    assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]{0,9}$/);
    assert.match(env.GITHUB_JOB ?? '', /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
    assert.match(env.GITHUB_ENV ?? '', /^\/home\/runner\/work\/_temp\/_runner_file_commands\/set_env_[A-Za-z0-9-]+$/);
    return { run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, job: env.GITHUB_JOB,
      uid: identity.uid, temp: env.RUNNER_TEMP, environmentFile: env.GITHUB_ENV };
  }

  static binary(path) {
    assert.equal(resolve(path), path, 'Chromium path must be canonical');
    assert.match(path, /^\/home\/runner\/\.cache\/ms-playwright\/chromium-[0-9]+\/chrome-linux(?:64)?\/chrome$/,
      'Only one exact installed full Chromium cache binary is allowed');
    return path;
  }

  static profile(owner) {
    CiChromiumSandbox.binary(owner.binary);
    assert.match(owner.name, /^bpane-ci-chromium-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}-[A-Za-z_][A-Za-z0-9_-]{0,63}-[a-f0-9]{24}$/);
    return `abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile ${owner.name} "${owner.binary}" flags=(unconfined) {\n  userns,\n}\n`;
  }

  static owner(context, directory, binary, nonce) {
    assert.match(nonce, /^[a-f0-9]{24}$/);
    const name = `bpane-ci-chromium-${context.run}-${context.attempt}-${context.job}-${nonce}`;
    return { version: 1, run: context.run, attempt: context.attempt, job: context.job,
      uid: context.uid, directory, binary: CiChromiumSandbox.binary(binary), name, nonce };
  }

  static validateOwner(context, directory, owner, profile) {
    assert.equal(dirname(directory), context.temp); assert.equal(resolve(directory), directory);
    assert.match(basename(directory), /^bpane-ci-chromium-[A-Za-z0-9]{6}$/);
    const expected = CiChromiumSandbox.owner(context, directory, owner.binary, owner.nonce);
    assert.deepEqual(owner, expected, 'Manifest must belong to this exact run, attempt, job and user');
    assert.equal(profile, CiChromiumSandbox.profile(expected), 'Profile bytes must match the exact owned binary');
    return expected;
  }

  static async checkedPath(path, uid, directory = false) {
    const info = await lstat(path);
    assert.equal(await realpath(path), path, 'Symlinked paths are not accepted');
    assert(directory ? info.isDirectory() : info.isFile(), 'Unexpected path type');
    assert.equal(info.uid, uid, 'Unexpected filesystem owner');
    if (!directory) assert.equal(info.nlink, 1, 'Hard-linked files are not accepted');
    return info;
  }

  static async parser(operation, profile) {
    assert(['--add', '--remove'].includes(operation));
    const { stdout, stderr } = await promisify(execFile)('/usr/bin/sudo',
      ['-n', '/usr/sbin/apparmor_parser', operation, '--skip-cache', profile],
      { timeout: 30000, maxBuffer: 65536, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' } });
    if (stdout) process.stdout.write(stdout); if (stderr) process.stderr.write(stderr);
  }

  static async install(context, env) {
    assert(!env[CiChromiumSandbox.directoryKey], 'An owned profile is already registered for cleanup');
    const binary = CiChromiumSandbox.binary(chromium.executablePath());
    const executable = await CiChromiumSandbox.checkedPath(binary, context.uid);
    assert(executable.mode & 0o111, 'Chromium must be executable'); assert.equal(executable.mode & 0o022, 0);
    await CiChromiumSandbox.checkedPath(context.temp, context.uid, true);
    await CiChromiumSandbox.checkedPath(context.environmentFile, context.uid);
    const directory = await mkdtemp(join(context.temp, 'bpane-ci-chromium-'));
    const owner = CiChromiumSandbox.owner(context, directory, binary, randomBytes(12).toString('hex'));
    const profile = join(directory, 'profile.apparmor');
    await writeFile(join(directory, 'owner.json'), JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(profile, CiChromiumSandbox.profile(owner), { flag: 'wx', mode: 0o600 });
    // Publish recovery ownership before loading, including failed/cancelled setup.
    await appendFile(context.environmentFile, `${CiChromiumSandbox.directoryKey}=${directory}\n`, { flag: 'a' });
    await writeFile(join(directory, 'load-attempted'), owner.name + '\n', { flag: 'wx', mode: 0o600 });
    await CiChromiumSandbox.parser('--add', profile);
    console.log(`Loaded temporary CI userns profile ${owner.name} for ${binary}; Chromium sandbox remains enabled.`);
  }

  static async remove(context, env) {
    const directory = env[CiChromiumSandbox.directoryKey];
    if (!directory) { console.log('No owned CI Chromium profile was registered.'); return; }
    assert.equal(dirname(directory), context.temp); assert.equal(resolve(directory), directory);
    assert.match(basename(directory), /^bpane-ci-chromium-[A-Za-z0-9]{6}$/);
    const info = await CiChromiumSandbox.checkedPath(directory, context.uid, true); assert.equal(info.mode & 0o777, 0o700);
    const names = await readdir(directory);
    assert.deepEqual(names.sort(), ['load-attempted', 'owner.json', 'profile.apparmor'], 'Unexpected owned-directory contents');
    for (const name of names) {
      const file = await CiChromiumSandbox.checkedPath(join(directory, name), context.uid); assert.equal(file.mode & 0o777, 0o600);
    }
    const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
    const profile = join(directory, 'profile.apparmor');
    CiChromiumSandbox.validateOwner(context, directory, owner, await readFile(profile, 'utf8'));
    assert.equal(await readFile(join(directory, 'load-attempted'), 'utf8'), owner.name + '\n');
    // --add never overwrites a pre-existing name; our random name scopes removal.
    // Any parser failure is surfaced and leaves the recovery files for diagnosis.
    await CiChromiumSandbox.parser('--remove', profile);
    for (const name of names) await unlink(join(directory, name));
    await rmdir(directory);
    console.log(`Removed owned temporary CI profile ${owner.name} and its three recovery files.`);
  }

  static async main(mode, env = process.env) {
    assert(['install', 'remove'].includes(mode), 'Use install or remove');
    const context = CiChromiumSandbox.context(env, { platform: process.platform, uid: process.getuid?.(),
      username: userInfo().username, runnerHome: homedir() });
    if (mode === 'install') await CiChromiumSandbox.install(context, env);
    else await CiChromiumSandbox.remove(context, env);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await CiChromiumSandbox.main(process.argv[2]);
