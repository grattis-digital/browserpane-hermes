/** Original bounded traversal extension to the pinned Playwright injected source. */
export class InjectedSnapshotPatch {
  static changes() {
    return [
      ['  const visited = /* @__PURE__ */ new Set();\n  const snapshot = {',
        '  const visited = /* @__PURE__ */ new Set();\n  const coverage = { visitedNodes: 0, depthLimited: false, nodeLimited: false, framesDeferred: 0 };\n  const snapshot = {\n    coverage,'],
      ['  const visit = (ariaNode, node, parentElementVisible) => {\n    if (visited.has(node))',
        `  const visit = (ariaNode, node, parentElementVisible, depth = 0) => {
    if (publicOptions.maxNodes !== void 0 && visited.size >= publicOptions.maxNodes) {
      coverage.nodeLimited = true;
      ariaNode.props["children"] = "deferred";
      return;
    }
    if (visited.has(node))`],
      ['    processElement(childAriaNode || ariaNode, element, ariaChildren, visible);\n  };\n  function processElement(ariaNode, element, ariaChildren, parentElementVisible) {',
        `    if (publicOptions.maxDepth !== void 0 && depth >= publicOptions.maxDepth &&
        (element.firstChild || element.shadowRoot?.firstChild || ariaChildren.length)) {
      coverage.depthLimited = true;
      (childAriaNode || ariaNode).props["children"] = "deferred";
      if (childAriaNode) childAriaNode.props["tag"] = element.localName;
      return;
    }
    processElement(childAriaNode || ariaNode, element, ariaChildren, visible, depth);
  };
  function processElement(ariaNode, element, ariaChildren, parentElementVisible, depth) {
    const childDepth = depth + (ariaNode.role === "generic" && !ariaNode.name && element.childElementCount === 1 ? 0 : 1);`],
      // These four recursive sites occur only in generateAriaTree.
      ['visit(ariaNode, child, parentElementVisible);', 'visit(ariaNode, child, parentElementVisible, childDepth);', 4],
      ['  normalizeStringChildren(snapshot.root);\n  normalizeGenericRoles(snapshot.root);',
        '  coverage.visitedNodes = visited.size;\n  normalizeStringChildren(snapshot.root);\n  normalizeGenericRoles(snapshot.root);'],
      ['const removeSelf = node2.role === "generic" && !node2.name && result.length <= 1',
        'const removeSelf = node2.role === "generic" && !node2.name && !node2.props["children"] && result.length <= 1'],
      ['    this._lastAriaSnapshotForQuery = ariaSnapshot;\n    return { full, incremental, iframeRefs: ariaSnapshot.iframeRefs };',
        `    this._lastAriaSnapshotForQuery = ariaSnapshot;
    // Bounded weak identities let another scoped observation coexist with this
    // one. Ref-to-node authority still belongs to the MCP session's exact view.
    this._bpaneAriaRefs ??= new Map();
    for (const [ref, element] of ariaSnapshot.elements) {
      this._bpaneAriaRefs.delete(ref);
      this._bpaneAriaRefs.set(ref, new WeakRef(element));
      if (this._bpaneAriaRefs.size > 4096) this._bpaneAriaRefs.delete(this._bpaneAriaRefs.keys().next().value);
    }
    return { full, incremental, iframeRefs: ariaSnapshot.iframeRefs, coverage: ariaSnapshot.coverage };`],
      ['      return result && result.isConnected ? [result] : [];\n    };\n    return { queryAll };\n  }\n  elementState(node, state) {',
        `      const candidate = result || this._bpaneAriaRefs?.get(selector)?.deref();
      return candidate && candidate.isConnected && candidate._ariaRef?.ref === selector ? [candidate] : [];
    };
    return { queryAll };
  }
  elementState(node, state) {`],
    ];
  }
}
