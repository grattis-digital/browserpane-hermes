import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Compose leaves enough scratch space for managed AdBlock without raising steady-state memory', async () => {
  const compose = await readFile('compose.yaml', 'utf8');
  const browser = compose.match(/\n  browserpane:\n([\s\S]*?)\n  hermes:\n/)?.[1];
  assert(browser, 'Expected the production browser service');
  assert.match(browser, /\/tmp:size=1g,mode=1777,nosuid,nodev/);
  assert.match(browser, /mem_limit: 2300m/);
  assert.match(browser, /browser-data:\/data/);
  assert.match(browser, /cap_drop: \[ALL\]/);
  assert.match(browser, /no-new-privileges:true/);
  assert.match(browser, /seccomp:\.\/runtime\/chromium-seccomp\.json/);
});

test('the image retains upstream managed AdBlock and EasyPrivacy without a conflicting override', async () => {
  const extension = 'gighmmpiobklfepjocnamgkkbiglidom';
  const policy = JSON.parse(await readFile('upstream/deploy/chromium-policies/managed/bpane.json', 'utf8'));
  assert.deepEqual(policy.ExtensionInstallForcelist, [
    `${extension};https://clients2.google.com/service/update2/crx`,
  ]);
  assert.deepEqual(policy['3rdparty'].extensions[extension], {
    suppress_first_run_page: true, suppress_update_page: true,
    suppress_surveys: true, suppress_premium_cta: true,
    additional_subscriptions: ['https://easylist-downloads.adblockplus.org/easyprivacy.txt'],
  });
  const dockerfile = await readFile('Dockerfile', 'utf8');
  assert(dockerfile.includes('COPY --from=source-builder /source/upstream/deploy/chromium-policies/managed /etc/chromium/policies/managed'));
  const override = JSON.parse(await readFile('runtime/chromium-policy.json', 'utf8'));
  for (const key of ['ExtensionInstallForcelist', 'ExtensionSettings', 'ExtensionInstallBlocklist', '3rdparty']) {
    assert(!Object.hasOwn(override, key), `Review a potentially conflicting ${key} policy`);
  }
  const start = await readFile('upstream/deploy/start-host.sh', 'utf8');
  assert(start.includes('--load-extension='));
  assert(!start.includes('--disable-extensions-except='));
});
