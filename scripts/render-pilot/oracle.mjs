import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export class RenderOracle {
  static points(fixture, sequence, scrollY) {
    assert.equal(fixture.dpr, 1);
    assert(Number.isInteger(sequence) && sequence > 0 && sequence <= 240);
    const points = [{ ...fixture.marker, rgb: [8 + sequence * 37 % 240, 71, 159] }];
    for (const y of [176, 224]) {
      const row = Math.floor((y + scrollY) / 64);
      points.push({ x: fixture.left + 20, y: fixture.top + y,
        rgb: [32 + row % 16 * 11, 64 + row % 8 * 19, 96 + row % 4 * 37] });
    }
    return points;
  }

  static pixels = () => {
    const session = window.browserpaneSession, canvas = document.querySelector('#screen canvas');
    if (!session || canvas.width !== 1280 || canvas.height !== 720) throw new Error('Oracle geometry');
    let pixels;
    if (session.getRenderDiagnostics().backend === 'webgl2') {
      const gl = canvas.getContext('webgl2'), raw = new Uint8Array(1280 * 720 * 4);
      gl.readPixels(0, 0, 1280, 720, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      pixels = new Uint8Array(raw.length);
      for (let y = 0; y < 720; y++) pixels.set(raw.subarray((719-y)*5120, (720-y)*5120), y*5120);
    } else pixels = canvas.getContext('2d').getImageData(0, 0, 1280, 720).data;
    let binary = '';
    for (let i = 0; i < pixels.length; i += 32768) binary += String.fromCharCode(...pixels.subarray(i, i+32768));
    return btoa(binary);
  };

  static async checkpoint(page, rpc) {
    // Expensive full-surface oracle is OUTSIDE latency/resource/wire intervals.
    // It observes; it never calls flush() or repairs the rendering under test.
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.waitForTimeout(350);
      const before = Buffer.from(await rpc.call('pixels'), 'base64');
      const actual = Buffer.from(await page.evaluate(RenderOracle.pixels), 'base64');
      const after = Buffer.from(await rpc.call('pixels'), 'base64');
      assert.equal(actual.length, 1280 * 720 * 4);
      if (!before.equals(after)) continue;
      if (actual.equals(after)) return { matched: true, sha256: createHash('sha256').update(actual).digest('hex') };
    }
    throw new Error('Quiescent viewer pixels did not match X11');
  }

  static snapshot = () => {
    const session = window.browserpaneSession;
    if (!session?.connected) throw new Error('Viewer disconnected');
    if (!window.__renderPilotSession) window.__renderPilotSession = session;
    if (window.__renderPilotSession !== session) throw new Error('Unexpected viewer reconnect');
    return { epoch: 1, cache: session.getTileCacheStats(), ...session.getSessionStats() };
  };

  static delta(before, after) {
    const seconds = after.monotonic - before.monotonic;
    assert(seconds > 0);
    const difference = (a, b) => { assert(b >= a, 'Counter rollback'); return b - a; };
    const network = Object.fromEntries(Object.entries(before.network).map(([key, value]) => [key, {
      ipBytes: difference(value.ipBytes, after.network[key].ipBytes),
      packets: difference(value.packets, after.network[key].packets),
    }]));
    const containers = Object.fromEntries(Object.entries(before.containers).map(([key, value]) => [key, {
      meanCpuCores: difference(value.cpuUsec, after.containers[key].cpuUsec) / 1e6 / seconds,
      throttledUsec: difference(value.throttledUsec, after.containers[key].throttledUsec),
      memoryMiBAfter: after.containers[key].memoryBytes / 1048576,
      processes: RenderOracle.processDelta(value.processes, after.containers[key].processes, seconds),
    }]));
    return { seconds, wallStartMs: before.wallTimeMs, wallEndMs: after.wallTimeMs,
      monotonicStartMs: before.monotonic * 1000, monotonicEndMs: after.monotonic * 1000,
      network, containers, hostBefore: before.host, hostAfter: after.host };
  }

  static processDelta(before, after, seconds) {
    if (!before || !after) return undefined;
    const byRole = {};
    for (const [id, value] of Object.entries(before)) {
      if (!after[id]) continue;
      assert(after[id].role === value.role && after[id].cpuUsec >= value.cpuUsec, 'Process counter/role changed');
      byRole[value.role] = (byRole[value.role] ?? 0) + (after[id].cpuUsec - value.cpuUsec) / 1e6 / seconds;
    }
    return { meanCpuCoresByRole: byRole,
      exited: Object.keys(before).filter(id => !after[id]).length,
      started: Object.keys(after).filter(id => !before[id]).length,
      scope: 'Surviving disposable processes only, kernel tick precision; cgroup total includes churn' };
  }
}
