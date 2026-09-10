import { ObservationError } from './observation-error.mjs';

/** Explicit scope provenance, independent of output pagination/truncation. */
export class SnapshotCoverage {
  static validate(value) {
    if (value === undefined) return undefined;
    const fail = () => { throw new ObservationError('invalid_coverage', 'Invalid capture coverage.'); };
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    const allowed = ['scope', 'enterFrame', 'depth', 'nodeLimit', 'visitedNodes', 'depthLimited', 'nodeLimited', 'framesDeferred', 'complete'];
    if (Object.keys(value).some(key => !allowed.includes(key))) fail();
    if (typeof value.scope !== 'string' || !/^(page|f?\d*e\d+)$/.test(value.scope) || value.scope.length > 40) fail();
    if (![256, 1024].includes(value.nodeLimit) || !Number.isSafeInteger(value.visitedNodes) || value.visitedNodes < 0 || value.visitedNodes > value.nodeLimit) fail();
    if (value.depth !== undefined && (!Number.isSafeInteger(value.depth) || value.depth < 1 || value.depth > 6)) fail();
    if (value.enterFrame !== undefined && (value.enterFrame !== true || value.scope === 'page')) fail();
    for (const key of ['depthLimited', 'nodeLimited', 'complete']) if (typeof value[key] !== 'boolean') fail();
    if (!Number.isSafeInteger(value.framesDeferred) || value.framesDeferred < 0 || value.framesDeferred > value.visitedNodes) fail();
    if (value.complete !== (!value.depthLimited && !value.nodeLimited && value.framesDeferred === 0)) fail();
    return structuredClone(value);
  }
}
