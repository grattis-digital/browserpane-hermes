// Additional synthetic observers only, installed equally in trace-on/off runs.
export class StockFixture {
  static install = ({ token }) => {
    const state = window.__renderPilot;
    if (state?.token !== token || state.stock) throw new Error('Unowned/occupied stock fixture');
    const stock = { wheels: 0, scrolls: 0, animations: 0, animationActive: false };
    state.stock = stock;
    const mark = name => {
      performance.mark(name);
      performance.clearMarks(name); // Trace retains events; page retains no growing mark buffer.
    };
    document.addEventListener('keydown', event => {
      if (!event.isTrusted || !document.hasFocus()) return;
      if (['a', 's', 'd', 'u'].includes(event.key)) mark('bph-input-' + state.sequence);
      if (event.key !== 'g' || event.repeat || stock.animationActive || stock.animations >= 1) return;
      stock.animations++; stock.animationActive = true;
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:180px;top:160px;width:24px;height:24px;z-index:5;background:#ef7823;will-change:transform';
      document.body.append(box);
      mark('bph-animation-start');
      // Native compositor animation, finite even if the test controller disappears.
      const animation = box.animate([{ transform: 'translateX(0px)' }, { transform: 'translateX(320px)' }],
        { duration: 800, iterations: 2, direction: 'alternate' });
      animation.onfinish = () => { box.remove(); stock.animationActive = false; mark('bph-animation-end'); };
    });
    document.addEventListener('wheel', () => {
      if (++stock.wheels <= 256) mark('bph-wheel-' + stock.wheels);
    }, { passive: true });
    document.addEventListener('scroll', () => {
      if (++stock.scrolls <= 1024) mark('bph-scroll-' + stock.scrolls);
    }, { passive: true });
    return true;
  };
}
