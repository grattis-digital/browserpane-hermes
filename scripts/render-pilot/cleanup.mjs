// Remote watchdog lifetime must not depend on local browser shutdown speed.
export class RenderPilotCleanup {
  static async run(rpc, browser) {
    const result = {};
    try { result.cleanup = await rpc.call('finish'); }
    catch (error) { result.cleanupError = error.message; }
    try { result.ownerExit = await rpc.close(); }
    catch (error) { result.ownerExitError = error.message; }
    try { await browser?.close(); }
    catch (error) { result.viewerCleanupError = error.message; }
    result.ok = result.cleanup?.cleaned === true && result.ownerExit?.code === 0
      && !result.cleanupError && !result.ownerExitError && !result.viewerCleanupError;
    return result;
  }
}
