// Browser.close asks Chromium to flush session/profile data; SIGTERM alone can
// leave recently opened tabs out of the periodically checkpointed session.
import WebSocket from 'ws';

try {
  const response = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`CDP returned ${response.status}`);
  const { webSocketDebuggerUrl } = await response.json();
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Graceful browser close timed out')); }, 6000);
    socket.once('open', () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
    socket.once('close', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
} catch (error) {
  console.warn(`Browser shutdown fallback: ${error.message}`);
  process.exitCode = 1;
}
