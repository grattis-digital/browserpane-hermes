import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeSafety } from '../scripts/runtime-test/safety.mjs';

const token = '55f94415-dd54-46e6-953c-da32066cf252';
function fixture() {
  const expected = { id: 'owned-id', image: 'owned-image', token, network: 'owned-net',
    volumes: { '/data': 'owned-data', '/shared': 'owned-shared' } };
  const state = { Id: expected.id, Image: expected.image,
    Config: { User: '10000:10000', Labels: { 'browserpane.test': 'runtime', 'browserpane.test.run': token },
      Env: ['BPANE_PIPELINE_TEST=1', `BPANE_RUNTIME_TEST_ID=${token}`] },
    HostConfig: { Privileged: false, NetworkMode: 'owned-net', PortBindings: {},
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] },
    Mounts: Object.entries(expected.volumes).map(([Destination, Name]) => ({ Type: 'volume', Destination, Name })),
    NetworkSettings: { Networks: { 'owned-net': {} } } };
  return { expected, state };
}
test('runtime guard accepts only the complete owned container identity', () => {
  const { state, expected } = fixture();
  RuntimeSafety.token(token);
  RuntimeSafety.container(state, expected);
});
for (const [name, mutate] of [
  ['replacement ID', value => { value.Id = 'replacement'; }],
  ['different image', value => { value.Image = 'other'; }],
  ['missing label', value => { delete value.Config.Labels['browserpane.test']; }],
  ['other run', value => { value.Config.Labels['browserpane.test.run'] = 'other'; }],
  ['missing environment marker', value => { value.Config.Env = []; }],
  ['root user', value => { value.Config.User = '0'; }],
  ['privileged', value => { value.HostConfig.Privileged = true; }],
  ['missing capability drop', value => { value.HostConfig.CapDrop = []; }],
  ['privilege escalation', value => { value.HostConfig.SecurityOpt = []; }],
  ['host network', value => { value.HostConfig.NetworkMode = 'host'; }],
  ['published port', value => { value.HostConfig.PortBindings = { '8090/tcp': [{ HostIp: '0.0.0.0' }] }; }],
  ['host bind', value => { value.Mounts[0].Type = 'bind'; }],
  ['foreign volume', value => { value.Mounts[0].Name = 'user-profile'; }],
  ['extra mount', value => { value.Mounts.push({}); }],
  ['duplicate destination', value => { value.Mounts[1] = { ...value.Mounts[0] }; }],
  ['extra network', value => { value.NetworkSettings.Networks.bridge = {}; }],
]) test(`runtime guard rejects ${name}`, () => {
  const { state, expected } = fixture(); mutate(state);
  assert.throws(() => RuntimeSafety.container(state, expected));
});
test('runtime tokens reject paths, blanks and non-UUID identifiers', () => {
  for (const value of [undefined, '', '../profile', 'not-a-test', 'a'.repeat(36)]) assert.throws(() => RuntimeSafety.token(value));
});
