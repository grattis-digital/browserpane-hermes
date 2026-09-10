// Serialized into ONE fresh, labelled test browser's sole tab. No website data.
export class RenderFixture {
  static install = ({ token }) => {
    if (!/^[a-f0-9-]{36}$/.test(token) || window.__renderPilot) throw new Error('Invalid/occupied fixture');
    document.title = 'DISPOSABLE rendering pipeline benchmark';
    document.documentElement.style.cssText = 'scroll-behavior:auto;overflow-x:hidden';
    document.body.style.cssText = 'margin:0;background:#eee;font:18px monospace';
    const marker = document.createElement('div');
    marker.id = 'pilot-marker';
    marker.style.cssText = 'position:fixed;left:32px;top:96px;width:24px;height:24px;z-index:3;background:rgb(8,71,159)';
    document.body.append(marker);
    const colors = [];
    for (let row = 0; row < 256; row++) {
      // Repeating content is intentional: the return pass exercises real L2 reuse.
      const color = [32 + row % 16 * 11, 64 + row % 8 * 19, 96 + row % 4 * 37];
      colors.push(color);
      const node = document.createElement('section');
      node.style.cssText = `height:64px;box-sizing:border-box;background:rgb(${color});padding:8px 80px`;
      node.textContent = 'Lossless text and cached row ' + row % 16 + ' — 0123456789';
      document.body.append(node);
    }
    const state = { token, sequence: 0, trusted: 0, colors, actions: [] };
    window.__renderPilot = state;
    document.addEventListener('keydown', event => {
      const moves = { a: 0, s: 32, d: 64, u: -64 };
      if (!(event.key in moves) || event.repeat) return;
      event.preventDefault();
      if (!event.isTrusted || !document.hasFocus()) throw new Error('Untrusted/unfocused fixture input');
      state.trusted++;
      if (moves[event.key]) window.scrollBy({ top: moves[event.key], behavior: 'instant' });
      const n = ++state.sequence;
      marker.style.backgroundColor = `rgb(${8 + n * 37 % 240},71,159)`;
      if (state.actions.length >= 240) throw new Error('Fixture action bound');
      state.actions.push({ sequence: n, key: event.key, scrollY });
    });
    return { installed: true };
  };

  static inspect = ({ token }) => {
    const state = window.__renderPilot;
    if (!state || state.token !== token || document.visibilityState !== 'visible') throw new Error('Unowned/hidden fixture');
    const dpr = devicePixelRatio;
    const top = (screenY + outerHeight - innerHeight) * dpr;
    const left = (screenX + Math.max(0, (outerWidth - innerWidth) / 2)) * dpr;
    return { sequence: state.sequence, trusted: state.trusted, actions: state.actions,
      focused: document.hasFocus(), scrollY, top, left, dpr, innerWidth, innerHeight, stock: state.stock,
      scrollbarWidth: innerWidth - document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      marker: { x: left + 44 * dpr, y: top + 108 * dpr } };
  };
}
