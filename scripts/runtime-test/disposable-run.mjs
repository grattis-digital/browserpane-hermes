import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeSafety } from './safety.mjs';

/** Owns all resources, pins container/image IDs, and never uses existing volumes. */
export class DisposableRun {
  constructor(root, image, mcpMode = 'compact') {
    assert(['compact', 'playwright'].includes(mcpMode), 'Unknown MCP test mode');
    this.mcpMode = mcpMode;
    this.root = root;
    this.token = randomUUID();
    this.prefix = `bpane-runtime-${this.token}`;
    this.image = this.docker(['image', 'inspect', image, '--format', '{{.Id}}']).trim();
    assert.match(this.image, /^sha256:[a-f0-9]{64}$/);
    this.network = `${this.prefix}-net`;
    this.volumes = { '/data': `${this.prefix}-data`, '/shared': `${this.prefix}-shared` };
    this.containers = [];
    this.createdVolumes = [];
    this.createdNetwork = false;
    this.browserId = undefined;
  }
  docker(args, input, timeout = 60000) {
    return execFileSync('docker', args, { input, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 }).trim();
  }
  labels() { return ['--label', 'browserpane.test=runtime', '--label', `browserpane.test.run=${this.token}`]; }
  inspect(kind, id) { return JSON.parse(this.docker([kind, 'inspect', id]))[0]; }
  create(args) {
    const id = this.docker(['create', ...this.labels(), '--restart=no', ...args]);
    assert.match(id, /^[a-f0-9]{64}$/);
    this.containers.push(id);
    this.docker(['start', id]);
    return id;
  }
  async prepare() {
    this.docker(['network', 'create', '--internal', ...this.labels(), this.network]);
    this.createdNetwork = true;
    for (const volume of Object.values(this.volumes)) {
      // UUID names are not permission to reuse a colliding pre-existing resource.
      try { this.inspect('volume', volume); throw new Error('Refusing existing test volume'); }
      catch (error) { if (!error.status) throw error; }
      this.docker(['volume', 'create', ...this.labels(), volume]);
      this.createdVolumes.push(volume);
    }
    const fixture = await readFile(join(this.root, 'scripts/runtime-test/fixture.mjs'), 'utf8');
    this.create(['--name', `${this.prefix}-fixture`, '--network', this.network,
      '--network-alias', 'fixture', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '-e', `BPANE_RUNTIME_TEST_ID=${this.token}`, '--entrypoint', 'node', this.image, '--input-type=module', '-e', fixture]);
    const initializer = this.create(['--name', `${this.prefix}-init`, '--network', 'none', '--user', '0:0',
      ...this.mounts(), '--entrypoint', 'node', this.image, '-e',
      "const fs=require('fs');for(const p of ['/data','/shared']){fs.chownSync(p,10000,10000);fs.chmodSync(p,0o700)}"]);
    assert.equal(this.docker(['wait', initializer]), '0', 'Test-volume initialization failed');
  }
  mounts() {
    return Object.entries(this.volumes).flatMap(([target, source]) => ['--mount', `type=volume,src=${source},dst=${target}`]);
  }
  async startBrowser(suffix) {
    this.browserId = this.create(['--name', `${this.prefix}-${suffix}`, '--network', this.network,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--security-opt', `seccomp=${join(this.root, 'runtime/chromium-seccomp.json')}`,
      '--memory', '2300m', '--pids-limit', '512', '--shm-size', '512m',
      '--tmpfs', '/tmp:size=256m,mode=1777,nosuid,nodev', ...this.mounts(),
      '--env-file', join(this.root, 'runtime/host-runtime.env'),
      '-e', 'VIEWER_ORIGIN=https://viewer.test', '-e', 'GATEWAY_URL=https://viewer.test:4433',
      '-e', 'BPANE_PIPELINE_TEST=1', '-e', `BPANE_RUNTIME_TEST_ID=${this.token}`,
      '-e', `BPANE_MCP_MODE=${this.mcpMode}`,
      '-e', 'BPANE_URL=about:blank', '-e', 'BPANE_DEVICE_SCALE=1',
      '-e', 'BPANE_CHROMIUM_SANDBOX_MODE=strict', '-e', 'BPANE_CHROMIUM_EXTRA_FLAGS=--disable-setuid-sandbox',
      '-e', 'BPANE_CHROMIUM_DEBUG_ADDRESS=127.0.0.1', '-e', 'RUST_LOG=warn', this.image]);
    await this.ready();
  }
  assertBrowser() {
    RuntimeSafety.container(this.inspect('container', this.browserId), { id: this.browserId,
      image: this.image, token: this.token, network: this.network, volumes: this.volumes });
    for (const volume of this.createdVolumes) assert.equal(this.inspect('volume', volume).Labels?.['browserpane.test.run'], this.token);
    const network = this.inspect('network', this.network);
    assert.equal(network.Labels?.['browserpane.test.run'], this.token);
    assert.equal(network.Internal, true, 'Fixture network must have no external route');
  }
  async ready() {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      this.assertBrowser();
      assert.equal(this.inspect('container', this.browserId).State.Running, true, 'Browser exited');
      try { this.docker(['exec', this.browserId, '/app/runtime/healthcheck.sh'], undefined, 10000); return; }
      catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    throw new Error('Disposable browser did not become healthy within 120 seconds');
  }
  script(source, args = []) {
    this.assertBrowser();
    return this.docker(['exec', '-i', this.browserId, 'node', '--input-type=module', '-', ...args], source);
  }
  async restart() {
    this.assertBrowser();
    this.docker(['restart', '--time', '45', this.browserId]);
    await this.ready();
  }
  remove(id) {
    assert.equal(this.inspect('container', id).Config.Labels?.['browserpane.test.run'], this.token);
    this.docker(['stop', '--time', '45', id]);
    this.docker(['rm', id]);
    this.containers = this.containers.filter(value => value !== id);
  }
  cleanup() {
    for (const id of [...this.containers].reverse()) this.remove(id);
    for (const volume of this.createdVolumes) {
      assert.equal(this.inspect('volume', volume).Labels?.['browserpane.test.run'], this.token);
      this.docker(['volume', 'rm', volume]);
    }
    if (this.createdNetwork) {
      assert.equal(this.inspect('network', this.network).Labels?.['browserpane.test.run'], this.token);
      this.docker(['network', 'rm', this.network]);
    }
  }
}
