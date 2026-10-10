// Quick-save card shown after Alt+Shift+S or a toolbar click. Keyboard-first:
// type tags (comma or Enter to add, Tab to accept a suggestion), Ctrl+Enter
// saves, Esc closes. The page has already been saved; this only adds detail.
(() => {
  const data = window.__stashQuickSave;
  if (!data) return;
  document.getElementById('__stash-qs')?.remove();

  const host = document.createElement('div');
  host.id = '__stash-qs';
  host.style.cssText = 'position:fixed;z-index:2147483647;top:16px;right:16px;';
  const root = host.attachShadow({ mode: 'closed' });
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  root.innerHTML = `
  <style>
    :host{all:initial}
    .card{width:340px;font:13px/1.45 system-ui,-apple-system,sans-serif;border-radius:14px;padding:14px;
      background:${dark ? '#1b1b22' : '#fff'};color:${dark ? '#ececf1' : '#16161d'};
      border:1px solid ${dark ? '#2e2e38' : '#e4e4ea'};box-shadow:0 12px 40px rgba(0,0,0,.22)}
    .top{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-weight:600}
    .dot{width:8px;height:8px;border-radius:50%;background:#22c55e}
    .title{font-size:12px;opacity:.7;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tags{display:flex;flex-wrap:wrap;gap:6px;padding:6px;border-radius:8px;border:1px solid ${dark ? '#34343f' : '#d9d9e1'};cursor:text}
    .tag{background:${dark ? '#2b2b36' : '#efeff4'};border-radius:6px;padding:2px 6px;display:flex;gap:4px;align-items:center}
    .tag button{all:unset;cursor:pointer;opacity:.6}
    input,select,textarea{font:inherit;color:inherit;background:transparent;border:none;outline:none}
    .tags input{flex:1;min-width:80px}
    .row{margin-top:8px}
    select,textarea{width:100%;box-sizing:border-box;border:1px solid ${dark ? '#34343f' : '#d9d9e1'};border-radius:8px;padding:6px}
    select option{color:#000}
    textarea{resize:none;height:48px}
    .sugg{font-size:12px;opacity:.65;margin-top:4px;min-height:16px}
    .foot{display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:11px;opacity:.6}
    .save{all:unset;cursor:pointer;background:#6d5efc;color:#fff;border-radius:8px;padding:6px 12px;font-weight:600;opacity:1}
  </style>
  <div class="card" role="dialog" aria-label="Saved to Stash">
    <div class="top"><span class="dot"></span>Saved to Stash</div>
    <div class="title"></div>
    <div class="tags"><input placeholder="Add tags…" aria-label="Tags"></div>
    <div class="sugg"></div>
    <div class="row"><select aria-label="Collection"><option value="">No collection</option></select></div>
    <div class="row"><textarea placeholder="Note (optional)" aria-label="Note"></textarea></div>
    <div class="foot"><span>Ctrl+Enter save · Esc close</span><button class="save">Done</button></div>
  </div>`;

  const $ = (s) => root.querySelector(s);
  $('.title').textContent = data.title;
  const tags = [...(data.tags || [])];
  const input = $('.tags input');
  const select = $('select');
  const note = $('textarea');
  note.value = data.note || '';
  for (const c of data.collections || []) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    select.appendChild(o);
  }
  select.value = data.collectionId || '';

  function renderTags() {
    root.querySelectorAll('.tag').forEach((t) => t.remove());
    for (const t of tags) {
      const el = document.createElement('span');
      el.className = 'tag';
      el.textContent = t;
      const x = document.createElement('button');
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove ${t}`);
      x.onclick = () => {
        tags.splice(tags.indexOf(t), 1);
        renderTags();
      };
      el.appendChild(x);
      input.before(el);
    }
  }
  function suggestion() {
    const v = input.value.trim().toLowerCase();
    if (!v) return '';
    return (data.allTags || []).find((t) => t.startsWith(v) && !tags.includes(t)) || '';
  }
  function addTag(t) {
    t = t.trim().toLowerCase().replace(/^#/, '');
    if (t && !tags.includes(t)) tags.push(t);
    input.value = '';
    renderTags();
    $('.sugg').textContent = '';
  }
  function close() {
    host.remove();
    document.removeEventListener('keydown', onDocKey, true);
  }
  async function save() {
    if (input.value.trim()) addTag(input.value);
    await chrome.runtime.sendMessage({ type: 'quickSaveApply', id: data.id, tags, collectionId: select.value, note: note.value.trim() });
    close();
  }
  function onDocKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }

  input.addEventListener('input', () => {
    if (input.value.includes(',')) input.value.split(',').slice(0, -1).forEach(addTag), (input.value = input.value.split(',').pop());
    const s = suggestion();
    $('.sugg').textContent = s ? `Tab → ${s}` : '';
  });
  root.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep the page's own shortcuts from firing while typing
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) return e.preventDefault(), save();
    if (e.target === input) {
      if (e.key === 'Tab' && suggestion()) return e.preventDefault(), addTag(suggestion());
      if (e.key === 'Enter') return e.preventDefault(), addTag(input.value);
      if (e.key === 'Backspace' && !input.value && tags.length) tags.pop(), renderTags();
    }
  });
  $('.tags').onclick = () => input.focus();
  $('.save').onclick = save;
  document.addEventListener('keydown', onDocKey, true);

  renderTags();
  document.documentElement.appendChild(host);
  input.focus();
  setTimeout(() => {
    if (host.isConnected && !host.matches(':focus-within') && !root.activeElement) close();
  }, 8000);
})();
