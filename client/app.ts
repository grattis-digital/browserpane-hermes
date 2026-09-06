import { BpaneSession } from '../upstream/code/web/bpane-client/js/bpane.js';
import { DisplayController } from './display-controller.js';

const screen = document.querySelector<HTMLElement>('#screen')!;
const status = document.querySelector<HTMLElement>('#status')!;
const connect = document.querySelector<HTMLButtonElement>('#connect')!;
const disconnect = document.querySelector<HTMLButtonElement>('#disconnect')!;
const fullscreen = document.querySelector<HTMLButtonElement>('#fullscreen')!;
const display = new DisplayController();
let session: BpaneSession | null = null;
let desired = true;
let generation = 0;
let retry: ReturnType<typeof setTimeout> | undefined;

function reconnect(current: number): void {
  if (!desired || current !== generation) return;
  clearTimeout(retry);
  retry = setTimeout(() => { void attach(); }, 2000);
}

async function attach(): Promise<void> {
  const current = ++generation;
  clearTimeout(retry);
  session?.disconnect();
  session = null;
  display.attach(null);
  connect.disabled = true;
  disconnect.disabled = false;
  status.textContent = 'Connecting…';
  if (!display.hasDrawableSpace()) {
    status.textContent = 'Waiting for display space…';
    reconnect(current);
    return;
  }
  try {
    const response = await fetch(new URL('bootstrap', location.href), {
      method: 'POST', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('Browser gateway is starting');
    const access = await response.json();
    if (current !== generation || !desired) return;
    const attached = await BpaneSession.connect({
      ...access, container: screen,
      // Chrome stays at DPR 1. The viewer explicitly owns physical capture
      // size and fits it locally; HiDPI never changes shared Chrome settings.
      hiDpi: false, resizeSource: 'container', resizeAlignment: { width: 8, height: 2 },
      ...display.getConnectOptions(),
      renderBackend: 'auto', scrollCopy: true,
      audio: true, clipboard: true, fileTransfer: true,
      onDisplayStateChange: (state) => { if (current === generation) display.onDisplayStateChange(state); },
      onConnect: () => { if (current === generation) status.textContent = 'Connected · shared with Hermes'; },
      onDisconnect: () => {
        if (current === generation) {
          session = null; display.attach(null);
          status.textContent = 'Reconnecting…'; reconnect(current);
        }
      },
      onError: () => { if (current === generation) status.textContent = 'Connection interrupted'; },
    });
    if (current !== generation || !desired) { attached.disconnect(); return; }
    session = attached;
    display.attach(attached);
    Object.defineProperty(window, 'browserpaneSession', { value: session, configurable: true });
  } catch (error) {
    if (current !== generation) return;
    status.textContent = `${error instanceof Error ? error.message : String(error)} · retrying…`;
    connect.disabled = false;
    reconnect(current);
  }
}

connect.addEventListener('click', () => { desired = true; void attach(); });
disconnect.addEventListener('click', () => {
  desired = false; ++generation; clearTimeout(retry);
  session?.disconnect(); session = null;
  display.attach(null);
  status.textContent = 'Disconnected'; connect.disabled = false; disconnect.disabled = true;
});
fullscreen.disabled = !document.fullscreenEnabled;
fullscreen.addEventListener('click', () => {
  const change = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  change.catch((error: Error) => { display.showNotice(`Full screen unavailable: ${error.message}`); });
});
document.addEventListener('fullscreenchange', () => {
  const active = Boolean(document.fullscreenElement);
  fullscreen.textContent = active ? 'Exit full screen' : 'Full screen';
  fullscreen.setAttribute('aria-pressed', String(active));
});
window.addEventListener('beforeunload', () => { desired = false; display.destroy(); session?.disconnect(); });
void attach();
