// Shadow-DOM toast and progress card shared by the capture scripts.
(() => {
  if (window.__stashToast) return;
  let host, root, timer;

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483647;bottom:20px;right:20px;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host{all:initial}
      .box{font:500 13px/1.4 system-ui,-apple-system,sans-serif;background:#16161d;color:#fff;border-radius:12px;
        box-shadow:0 8px 28px rgba(0,0,0,.3);width:290px;overflow:hidden}
      .toast{padding:10px 14px;transition:opacity .25s;opacity:0;width:auto;max-width:320px}
      .toast.on{opacity:1}
      .prog{padding:12px 14px 12px}
      .row{display:flex;align-items:center;gap:8px}
      .logo{width:10px;height:10px;border-radius:3px;background:#6d5efc;flex:none}
      .title{font-weight:600;flex:1}
      .detail{color:#b5b5c3;font-size:12px;margin:4px 0 10px}
      .bar{height:6px;border-radius:3px;background:#2c2c38;overflow:hidden}
      .fill{height:100%;width:0;background:#6d5efc;border-radius:3px;transition:width .3s}
      .bar.indet .fill{width:35%;animation:slide 1.2s ease-in-out infinite}
      @keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
      .btns{display:flex;gap:6px;margin-top:10px;justify-content:flex-end}
      .btns:empty{display:none}
      button{all:unset;cursor:pointer;font-size:12px;font-weight:600;padding:5px 10px;border-radius:7px;background:#2c2c38}
      button.primary{background:#6d5efc}
      button:hover{filter:brightness(1.15)}
      .x{background:none;padding:0 2px;opacity:.6;font-size:15px;line-height:1}
    </style>
    <div class="box prog" hidden><div class="row"><span class="logo"></span><span class="title"></span><button class="x" aria-label="Close">×</button></div>
      <div class="detail"></div><div class="bar"><div class="fill"></div></div><div class="btns"></div></div>
    <div class="box toast"></div>`;
    root.querySelector('.x').onclick = () => window.__stashProgress.hide();
    document.documentElement.appendChild(host);
  }

  window.__stashToast = (text) => {
    mount();
    const t = root.querySelector('.toast');
    if (!root.querySelector('.prog').hidden) return window.__stashProgress.update({ detail: text });
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(timer);
    timer = setTimeout(() => t.classList.remove('on'), 3000);
  };

  // show/update({ title, detail, value: 0..1 | null (indeterminate), actions: [{ label, primary, onClick }] })
  window.__stashProgress = {
    update(o) {
      mount();
      const p = root.querySelector('.prog');
      p.hidden = false;
      root.querySelector('.toast').classList.remove('on');
      if (o.title != null) p.querySelector('.title').textContent = o.title;
      if (o.detail != null) p.querySelector('.detail').textContent = o.detail;
      if ('value' in o) {
        p.querySelector('.bar').classList.toggle('indet', o.value == null);
        p.querySelector('.fill').style.width = o.value == null ? '' : `${Math.round(o.value * 100)}%`;
      }
      if (o.actions) {
        const btns = p.querySelector('.btns');
        btns.replaceChildren(
          ...o.actions.map((a) => {
            const b = document.createElement('button');
            b.textContent = a.label;
            if (a.primary) b.className = 'primary';
            b.onclick = a.onClick;
            return b;
          }),
        );
      }
    },
    hide() {
      if (root) root.querySelector('.prog').hidden = true;
    },
  };
})();
