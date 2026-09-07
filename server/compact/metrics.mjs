const rounded = value => Math.round(value * 1000) / 1000;

class PaneTrace {
  #now;
  #sink;
  #started;
  #record;

  constructor(id, tool, now, sink) {
    this.#now = now; this.#sink = sink; this.#started = now();
    this.#record = { kind: 'bpane_mcp_timing', v: 1, id, tool };
  }

  queueDone() { this.#record.queueMs = rounded(this.#now() - this.#started); }
  increment(name, value = 1) { this.#record[name] = (this.#record[name] ?? 0) + value; }

  async span(name, work) {
    const started = this.#now();
    try { return await work(); }
    finally { this.#record[name] = rounded((this.#record[name] ?? 0) + this.#now() - started); }
  }

  finish(result) {
    this.#record.totalMs = rounded(this.#now() - this.#started);
    this.#record.outputBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    this.#record.ok = !result?.isError;
    if (result?.isError) {
      try { this.#record.errorCode = JSON.parse(result.content?.[0]?.text)?.error?.code ?? 'UNKNOWN'; }
      catch { this.#record.errorCode = 'UNKNOWN'; }
    }
    try { this.#sink(JSON.stringify(this.#record)); } catch { /* Diagnostics must never change browser outcomes. */ }
  }
}

/** Opt-in, content-free timing records. No URLs, page text, selectors or input values are logged. */
export class PaneMetrics {
  #enabled;
  #sink;
  #now;
  #sequence = 0;

  constructor({ enabled = process.env.BPANE_MCP_TIMINGS === '1',
    sink = line => console.error(line), now = () => performance.now() } = {}) {
    this.#enabled = enabled; this.#sink = sink; this.#now = now;
  }

  start(tool) {
    if (!this.#enabled) return undefined;
    return new PaneTrace(`m${++this.#sequence}`, tool, this.#now, this.#sink);
  }
}
