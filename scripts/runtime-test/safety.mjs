import assert from 'node:assert/strict';

/** Validate the launcher's exact disposable identity before browser/storage writes. */
export class RuntimeSafety {
  static token(value) {
    assert.match(value ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    return value;
  }

  static container(state, expected) {
    assert.equal(state.Id, expected.id, 'Container identity changed');
    assert.equal(state.Image, expected.image, 'Container image changed');
    assert.equal(state.Config.Labels?.['browserpane.test.run'], expected.token);
    assert.equal(state.Config.Labels?.['browserpane.test'], 'runtime');
    assert.equal(state.Config.User, '10000:10000');
    assert(state.Config.Env.includes('BPANE_PIPELINE_TEST=1'));
    assert(state.Config.Env.includes(`BPANE_RUNTIME_TEST_ID=${expected.token}`));
    assert.equal(state.HostConfig.Privileged, false);
    assert(state.HostConfig.CapDrop?.includes('ALL'));
    assert(state.HostConfig.SecurityOpt?.includes('no-new-privileges:true'));
    assert.notEqual(state.HostConfig.NetworkMode, 'host');
    assert.deepEqual(state.HostConfig.PortBindings ?? {}, {}, 'Runtime fixture must not publish ports');
    assert.equal(state.Mounts.length, 2, 'Only this run’s two named test volumes are allowed');
    assert.deepEqual(state.Mounts.map(mount => mount.Destination).sort(), Object.keys(expected.volumes).sort());
    for (const mount of state.Mounts) {
      assert.equal(mount.Type, 'volume', 'Host bind mounts are forbidden');
      assert.equal(mount.Name, expected.volumes[mount.Destination], 'Unexpected volume');
    }
    assert.deepEqual(Object.keys(state.NetworkSettings.Networks), [expected.network]);
  }
}
