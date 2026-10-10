// Tiny shadow-DOM toast shared by the capture scripts.
(() => {
  if (window.__stashToast) return;
  let host, timer;
  window.__stashToast = (text) => {
    if (!host) {
      host = document.createElement('div');
      host.style.cssText = 'position:fixed;z-index:2147483647;bottom:20px;right:20px;';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>
        div{font:500 13px/1.4 system-ui,sans-serif;background:#16161d;color:#fff;padding:10px 14px;border-radius:10px;
        box-shadow:0 6px 24px rgba(0,0,0,.25);transition:opacity .25s;opacity:0}
        div.on{opacity:1}</style><div></div>`;
      host.__box = root.querySelector('div');
      document.documentElement.appendChild(host);
    }
    host.__box.textContent = text;
    host.__box.classList.add('on');
    clearTimeout(timer);
    timer = setTimeout(() => host.__box.classList.remove('on'), 3000);
  };
})();
