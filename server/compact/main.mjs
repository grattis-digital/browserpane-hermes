import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import downloads from '../mcp-downloads.cjs';
import { SharedBrowser } from './browser.mjs';
import { SerialExecutor } from './executor.mjs';
import { RequestLedger } from './request-ledger.mjs';
import { ObservationStore } from './observations.mjs';
import { SharedUploads } from './uploads.mjs';
import { ActionSteps } from './action-steps.mjs';
import { ActionRunner } from './action-runner.mjs';
import { FlowRunner } from './flow-runner.mjs';
import { PaneSession } from './session.mjs';
import { CompactMcpHttpServer } from './http-server.mjs';
import { PaneMetrics } from './metrics.mjs';

export class CompactRuntime {
  #http;
  #browser;
  #executor;
  constructor(http, browser, executor) { this.#http = http; this.#browser = browser; this.#executor = executor; }

  static async create({ endpoint = 'http://127.0.0.1:9222', host = '0.0.0.0', port = 8931,
    allowedHosts = ['browserpane:8931', 'localhost:8931', '127.0.0.1:8931'],
    downloadDirectory = '/shared/downloads', sharedDirectory = '/shared' } = {}) {
    const connection = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
    const context = connection.contexts()[0];
    if (!context) { await connection.close(); throw new Error('Shared Chromium context is missing.'); }
    const browser = new SharedBrowser(connection, context, downloads.forwardDownload, downloadDirectory);
    browser.start();
    const executor = new SerialExecutor(8);
    const uploads = new SharedUploads(sharedDirectory);
    const steps = new ActionSteps(browser, uploads);
    const actions = new ActionRunner(browser, steps, () => performance.now());
    const metrics = new PaneMetrics();
    const http = new CompactMcpHttpServer({ host, port, allowedHosts, createSession: () => {
      const observations = new ObservationStore({ idFactory: () => randomBytes(9).toString('base64url') });
      const flow = new FlowRunner({ browser, actions, observations });
      return new PaneSession({ browser, executor, actions, flow, observations, ledger: new RequestLedger(64),
        lease: randomBytes(12).toString('base64url'), metrics });
    } });
    return new CompactRuntime(http, browser, executor);
  }

  async start() { return this.#http.start(); }
  async close() {
    await this.#http.close();
    this.#executor.close();
    await this.#browser.disconnect();
  }
}
