import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const source = await readFile('upstream/deploy/start-host.sh', 'utf8');
const start = source.indexOf('chromium_has_saved_session() {');
const end = source.indexOf('# Start PipeWire audio stack', start);
assert(start > 0 && end > start, 'Ordered startup patch must be applied');
const launch = source.slice(start, end);
const detection = launch.slice(0, launch.indexOf('launch_chromium() {'));

async function fixture(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bpane-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

for (const [name, files, expected] of [
  ['fresh profile', {}, false],
  ['preferences written before first Chromium launch', { 'Default/Preferences': '{}' }, false],
  ['empty session record', { 'Default/Sessions/Session_1': '' }, false],
  ['header-only session record', { 'Default/Sessions/Session_1': 'SNSS\x03\x00\x00\x00' }, false],
  ['closed-tab records alone', { 'Default/Sessions/Tabs_1': 'saved closed tab' }, false],
  ['modern session record', { 'Default/Sessions/Session_1': 'saved session' }, true],
  ['legacy current session', { 'Default/Current Session': 'saved session' }, true],
  ['legacy last session', { 'Default/Last Session': 'saved session' }, true],
]) test(`Chromium startup recognizes ${name}`, async t => {
  const root = await fixture(t, files);
  const result = execFileSync('bash', ['-c', `set -eu\nPROFILE_DIR="$1"\n${detection}\nif chromium_has_saved_session; then printf yes; else printf no; fi`, '_', root], { encoding: 'utf8' });
  assert.equal(result, expected ? 'yes' : 'no');
});

for (const restored of [false, true]) {
  for (const appMode of [false, true]) {
    test(`supervised Chromium ${restored ? 'restored' : 'fresh'} ${appMode ? 'app' : 'normal'} launches do not accumulate URLs`, async t => {
      const root = await fixture(t, restored ? { 'Default/Sessions/Session_1': 'saved session' } : {});
      const flags = ['--restore-last-session', '--ozone-platform=x11', ...(appMode ? ['--app=https://app.invalid/'] : [])];
      // Execute the real supervisor twice with synthetic process/state adapters.
      // The first child saves session state, exactly as a fresh browser can do.
      // Match upstream's set -e: macOS Bash 3 treats empty arrays as unset with -u.
      const harness = `set -e
PROFILE_DIR="$1"; shift
BPANE_CHROMIUM_SANDBOX_MODE=strict
CHROMIUM_FLAGS=("$@")
${launch}
chromium() {
  local record="$PROFILE_DIR/args-1"
  if [ -f "$record" ]; then record="$PROFILE_DIR/args-2"; fi
  printf '%s\\0' "$@" > "$record"
  mkdir -p "$PROFILE_DIR/Default/Sessions"
  printf 'saved session' > "$PROFILE_DIR/Default/Sessions/Session_1"
}
chromium_log_filter() { cat >/dev/null; }
sleep() { :; }
write_chromium_preferences() { if [ -f "$PROFILE_DIR/args-2" ]; then exit 0; fi; }
launch_chromium 'https://startup.invalid/a path?q=quoted'
wait "$!"
`;
      execFileSync('bash', ['-c', harness, '_', root, ...flags], { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
      const args = async name => (await readFile(join(root, name), 'utf8')).split('\0').slice(0, -1);
      assert.deepEqual(await args('args-1'), [...flags, ...(!restored && !appMode ? ['https://startup.invalid/a path?q=quoted'] : [])]);
      assert.deepEqual(await args('args-2'), flags, 'Retry must recheck newly saved state and retain all Chromium flags');
    });
  }
}
