import assert from 'node:assert/strict';

// Independent child oracles must both produce evidence. Keep every failure,
// including process-launch errors, and fail the parent only after all ran.
export class ViewerOracleRunner {
  static run(scripts, runner) {
    const failures = [];
    for (const script of scripts) {
      try {
        const result = runner(script);
        if (result.error) throw result.error;
        assert.equal(result.status, 0,
          `${script} exited unsuccessfully${result.signal ? ` (${result.signal})` : ''}`);
      } catch (error) {
        failures.push(new Error(`${script} failed`, { cause: error }));
      }
    }
    if (failures.length) {
      throw new AggregateError(failures,
        `${failures.length} viewer oracle(s) failed: ${failures.map(error => error.message).join('; ')}`);
    }
  }
}
