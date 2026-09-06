import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** Exact UTF-8 payload accounting; token figures are deliberately only estimates. */
export class McpBaselineMetrics {
  #samples = [];
  static text(result) {
    return (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  }
  static size(result) {
    const json = JSON.stringify(result), text = McpBaselineMetrics.text(result);
    return { jsonBytes: Buffer.byteLength(json), textBytes: Buffer.byteLength(text), textCodePoints: [...text].length,
      estimatedTextTokensCharsDiv4: Math.ceil([...text].length / 4),
      jsonSha256: createHash('sha256').update(json).digest('hex') };
  }
  static percentile(values, fraction) {
    assert(values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0));
    assert(fraction > 0 && fraction <= 1);
    return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  }
  static distribution(values) {
    return { samples: values.length, median: this.percentile(values, 0.5), p95: this.percentile(values, 0.95),
      min: Math.min(...values), max: Math.max(...values) };
  }
  static totals(calls) {
    const totals = {};
    for (const call of calls) {
      const value = totals[call.operation] ??= { calls: 0, latencyMs: 0, jsonBytes: 0, textBytes: 0, estimatedTextTokensCharsDiv4: 0 };
      value.calls++;
      for (const key of ['latencyMs', 'jsonBytes', 'textBytes', 'estimatedTextTokensCharsDiv4']) value[key] += call[key];
    }
    return totals;
  }
  static summarizeTotals(trials) {
    const operations = [...new Set(trials.flatMap(trial => Object.keys(trial.operations)))];
    return Object.fromEntries(operations.map(operation => [operation, Object.fromEntries(
      ['calls', 'latencyMs', 'jsonBytes', 'textBytes', 'estimatedTextTokensCharsDiv4'].map(key => [key,
        this.distribution(trials.map(trial => trial.operations[operation][key]))]))]));
  }
  async measure(meta, operation) {
    const started = performance.now();
    let recorded = false;
    try {
      const result = await operation();
      const sample = { ...meta, latencyMs: performance.now() - started, completedWallMs: Date.now(),
        ...McpBaselineMetrics.size(result), isError: result.isError === true };
      this.#samples.push(sample);
      recorded = true;
      assert(!sample.isError, `MCP tool failed: ${meta.operation}: ${McpBaselineMetrics.text(result).slice(0, 500)}`);
      return result;
    } catch (error) {
      if (!recorded)
        this.#samples.push({ ...meta, latencyMs: performance.now() - started, failed: true, error: String(error.message ?? error) });
      throw error;
    }
  }
  samples() { return this.#samples.map(sample => ({ ...sample })); }
  summarize() {
    const groups = {};
    for (const sample of this.#samples.filter(value => !value.warmup && !value.failed && !value.isError))
      (groups[sample.operation] ??= []).push(sample);
    return Object.fromEntries(Object.entries(groups).map(([operation, samples]) => [operation, {
      latencyMs: McpBaselineMetrics.distribution(samples.map(sample => sample.latencyMs)),
      jsonBytes: McpBaselineMetrics.distribution(samples.map(sample => sample.jsonBytes)),
      textBytes: McpBaselineMetrics.distribution(samples.map(sample => sample.textBytes)),
      estimatedTextTokensCharsDiv4: McpBaselineMetrics.distribution(samples.map(sample => sample.estimatedTextTokensCharsDiv4)),
    }]));
  }
}
