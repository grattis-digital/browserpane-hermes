import { readFile } from 'node:fs/promises';

export const trustedBootstrap = (headers, origin) =>
  headers.origin === origin && headers['sec-fetch-site'] !== 'cross-site';

// Only adopt one static session and issue short-lived tickets; never expose the admin token.
export class GatewayAdmin {
  constructor({ fetchFn = fetch, readToken = () => readFile('/tmp/bpane/gateway/token', 'utf8'),
    api = 'http://127.0.0.1:8932', gatewayUrl, certHashUrl } = {}) {
    Object.assign(this, { fetchFn, readToken, api, gatewayUrl, certHashUrl });
    this.queue = Promise.resolve();
  }
  bootstrap() {
    const operation = this.queue.then(() => this.issueTicket());
    this.queue = operation.catch(() => {});
    return operation;
  }
  async issueTicket() {
    const token = (await this.readToken()).trim();
    if (!token) throw new Error('Gateway is starting');
    const request = async (path, body) => {
      const response = await this.fetchFn(`${this.api}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Gateway request failed (${response.status})`);
      return response.json();
    };
    if (this.token !== token || !this.sessionId) {
      this.sessionId = null;
      this.token = token;
      const { sessions } = await request('/api/v1/sessions');
      let session = sessions.find((item) => item.labels?.application === 'browserpane-hermes' && item.state !== 'stopped');
      if (!session) session = await request('/api/v1/sessions', {
        labels: { application: 'browserpane-hermes' }, idle_timeout_sec: 3153600000,
      });
      this.sessionId = session.id;
    }
    const ticket = await request(`/api/v1/sessions/${this.sessionId}/access-tokens`, {});
    if (ticket.token_type !== 'session_connect_ticket' || !ticket.token) throw new Error('Invalid gateway ticket');
    return { gatewayUrl: this.gatewayUrl, certHashUrl: this.certHashUrl, connectTicket: ticket.token };
  }
}
