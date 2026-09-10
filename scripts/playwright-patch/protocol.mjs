/** Small private-protocol extension; ordinary Playwright calls keep their defaults. */
export class SnapshotProtocolPatch {
  static files() {
    return [
      { path: 'lib/client/page.js', sha256: '95938614e09bb30158aa08fc613571b90d6665c3b3f965997e3de067a024fad9', changes: [
        ['return await this._channel.snapshotForAI({ timeout: this._timeoutSettings.timeout(options), track: options.track });',
          'return await this._channel.snapshotForAI({ timeout: this._timeoutSettings.timeout(options), track: options.track, selector: options.selector, maxDepth: options.maxDepth, maxNodes: options.maxNodes, includeFrames: options.includeFrames });'],
      ] },
      { path: 'lib/protocol/validator.js', sha256: 'ab97465cd25a7ee4d3228abf58f9d4ee73704c199f261ad4ce8edfaf5265a330', changes: [
        ['import_validatorPrimitives.scheme.PageSnapshotForAIParams = (0, import_validatorPrimitives.tObject)({\n  track:',
          `import_validatorPrimitives.scheme.PageSnapshotForAIParams = (0, import_validatorPrimitives.tObject)({
  selector: (0, import_validatorPrimitives.tOptional)(import_validatorPrimitives.tString),
  maxDepth: (0, import_validatorPrimitives.tOptional)(import_validatorPrimitives.tFloat),
  maxNodes: (0, import_validatorPrimitives.tOptional)(import_validatorPrimitives.tFloat),
  includeFrames: (0, import_validatorPrimitives.tOptional)(import_validatorPrimitives.tBoolean),
  track:`],
        ['import_validatorPrimitives.scheme.PageSnapshotForAIResult = (0, import_validatorPrimitives.tObject)({\n  full:',
          `import_validatorPrimitives.scheme.PageSnapshotForAIResult = (0, import_validatorPrimitives.tObject)({
  scopeMissing: (0, import_validatorPrimitives.tOptional)(import_validatorPrimitives.tBoolean),
  coverage: (0, import_validatorPrimitives.tOptional)((0, import_validatorPrimitives.tObject)({
    visitedNodes: import_validatorPrimitives.tFloat,
    depthLimited: import_validatorPrimitives.tBoolean,
    nodeLimited: import_validatorPrimitives.tBoolean,
    framesDeferred: import_validatorPrimitives.tFloat
  })),
  full:`],
      ] },
      { path: 'lib/server/page.js', sha256: 'e0c04c37345675c023d8d6b11ed301728bedead821ddac91a45318970f62d0ca', changes: [
        ['    const snapshot = await snapshotFrameForAI(progress, this.mainFrame(), options);\n    return { full: snapshot.full.join("\\n"), incremental: snapshot.incremental?.join("\\n") };',
          `    let frame = this.mainFrame();
    if (options.selector) {
      const resolved = await progress.race(frame.selectors.resolveFrameForSelector(options.selector, { strict: true }));
      if (!resolved) return { full: "", scopeMissing: true };
      frame = resolved.frame;
      options = { ...options, selector: resolved.info.parsed };
    }
    const snapshot = await snapshotFrameForAI(progress, frame, options);
    return { full: snapshot.full.join("\\n"), incremental: snapshot.incremental?.join("\\n"), coverage: snapshot.coverage, scopeMissing: snapshot.scopeMissing };`],
        ['        const node = injected.document.body;\n        if (!node)',
          '        const node = options2.selector ? injected.querySelector(options2.selector, injected.document, true) : injected.document.body;\n        if (!node && options2.selector) return { scopeMissing: true };\n        if (!node)'],
        ['{ refPrefix: frame.seq ? "f" + frame.seq : "", track: options.track, doNotRenderActive: options.doNotRenderActive }',
          '{ refPrefix: frame.seq ? "f" + frame.seq : "", track: options.track, doNotRenderActive: options.doNotRenderActive, selector: options.selector, maxDepth: options.maxDepth, maxNodes: options.maxNodes }'],
        ['  const childSnapshotPromises = snapshot.iframeRefs.map((ref) => snapshotFrameRefForAI(progress, frame, ref, options));',
          '  if (snapshot.scopeMissing) return { full: [], scopeMissing: true };\n  snapshot.coverage.framesDeferred = options.includeFrames === false ? snapshot.iframeRefs.length : 0;\n  const childSnapshotPromises = options.includeFrames === false ? [] : snapshot.iframeRefs.map((ref) => snapshotFrameRefForAI(progress, frame, ref, options));'],
        ['      const childSnapshot = childSnapshots[i];\n      if (childSnapshot.incremental)',
          '      const childSnapshot = childSnapshots[i];\n      if (!childSnapshot) continue;\n      if (childSnapshot.incremental)'],
        ['  return { full, incremental };\n}\nasync function snapshotFrameRefForAI',
          `  for (const child of childSnapshots) {
    if (!child.coverage) continue;
    snapshot.coverage.visitedNodes += child.coverage.visitedNodes;
    snapshot.coverage.depthLimited ||= child.coverage.depthLimited;
    snapshot.coverage.nodeLimited ||= child.coverage.nodeLimited;
    snapshot.coverage.framesDeferred += child.coverage.framesDeferred;
  }
  return { full, incremental, coverage: snapshot.coverage };
}
async function snapshotFrameRefForAI`],
        ['return await snapshotFrameForAI(progress, child.frame, options);',
          'return await snapshotFrameForAI(progress, child.frame, { ...options, selector: void 0 });'],
      ] },
    ];
  }
}
