/** Read-only /proc parser: inspect listeners without printing socket identities. */
export class ListenerStatus {
  static inspect(tcp, tcp6 = '') {
    const listeners = [];
    for (const [content, ipv6] of [[tcp, false], [tcp6, true]]) {
      for (const line of content.trim().split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields[3] !== '0A') continue;
        const [address, encodedPort] = fields[1].split(':');
        const port = Number.parseInt(encodedPort, 16);
        const loopback = ipv6 ? address === '00000000000000000000000001000000' :
          address.length === 8 && address.slice(6) === '7F';
        listeners.push({ port, loopback });
      }
    }
    const privatePort = port => listeners.some(item => item.port === port) &&
      listeners.filter(item => item.port === port).every(item => item.loopback);
    return Object.freeze({
      cdpLoopback: privatePort(9222),
      adminLoopback: privatePort(8932),
      cdpProxyDisabled: !listeners.some(item => item.port === 9223),
      mcpListening: listeners.some(item => item.port === 8931),
    });
  }
}
