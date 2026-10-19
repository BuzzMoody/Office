/*
 * Office shim. The server injects this into each app's index.html so the apps
 * (which only know the browser's file picker and downloads) use the Office file
 * store instead. It touches three browser APIs the apps call, nothing else:
 *
 *   window.showSaveFilePicker      Save / Save As  -> "Save to Office" dialog, PUT /api/files/<name>
 *   HTMLInputElement#click (file)  Open            -> "Open from Office" dialog, feeds input.files
 *   HTMLAnchorElement#click        Save/Export     -> same "Save to Office" dialog, for apps that save by
 *                                                     clicking <a download href="blob:..."> (DeckCraft)
 *   ?open=<name>                   deep link       -> fetches the file and drops it on the canvas
 *
 * If an upstream release changes how it opens or saves files, this is the file
 * to fix. See AGENTS.md ("Upgrading the bundled apps").
 */
(() => {
  'use strict';

  const script = document.currentScript;
  const APP = script.dataset.app || '';
  const ACCENT = script.dataset.accent || '#3b6cf6';
  const ROOT = new URL('../', script.src); // site root, also correct behind a path prefix
  const apiUrl = (path) => new URL('api/' + path, ROOT);

  // ---------------------------------------------------------------- helpers

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) el.append(c);
    return el;
  }

  const INVALID_NAME = /[\\/:*?"<>|\u0000-\u001f]/;
  const extOf = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '');

  function nameProblem(name) {
    if (!name.trim()) return 'Enter a file name.';
    if (name.startsWith('.') || name.endsWith('.') || name !== name.trim()) return 'Names can’t start or end with a dot or space.';
    if (INVALID_NAME.test(name)) return 'Names can’t contain  \\ / : * ? " < > |';
    if (new TextEncoder().encode(name).length > 200) return 'That name is too long.';
    return '';
  }

  function formatSize(n) {
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
  }

  function formatAge(iso) {
    const secs = (new Date(iso) - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (const [unit, s] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
      if (Math.abs(secs) >= s) return rtf.format(Math.round(secs / s), unit);
    }
    return 'just now';
  }

  async function failure(res, fallback) {
    try { return (await res.json()).error || fallback; } catch { return fallback; }
  }

  async function listFiles() {
    const res = await fetch(apiUrl('files'), { cache: 'no-store' });
    if (!res.ok) throw new Error(await failure(res, 'Could not list files'));
    return (await res.json()).files;
  }

  let infoPromise;
  const getInfo = () => (infoPromise ||= fetch(apiUrl('info')).then((r) => r.json()).catch(() => ({ apps: [] })));

  // -------------------------------------------------------------------- UI

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ui {
      --bg: #ffffff; --fg: #17181c; --muted: #6b6f7b; --line: #e4e6ec; --soft: #f3f4f8; --warn: #b45309;
      --accent: ${ACCENT};
      font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg);
    }
    @media (prefers-color-scheme: dark) {
      .ui { --bg: #1d1e24; --fg: #eceef4; --muted: #9a9eac; --line: #31333c; --soft: #2a2c34; --warn: #fbbf24; }
    }
    .scrim {
      position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 16px;
      background: rgba(10, 12, 20, .45); backdrop-filter: blur(3px); animation: fade .15s ease-out;
    }
    .card {
      width: min(560px, 100%); max-height: min(640px, 92vh); display: flex; flex-direction: column;
      background: var(--bg); border: 1px solid var(--line); border-radius: 16px; overflow: hidden;
      box-shadow: 0 24px 60px rgba(0, 0, 0, .35); animation: pop .18s cubic-bezier(.2, .9, .3, 1.2);
    }
    header { display: flex; align-items: center; gap: 10px; padding: 16px 18px 8px; }
    header .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); flex: none; }
    h2 { margin: 0; font-size: 16px; font-weight: 650; }
    .sub { margin-left: auto; color: var(--muted); font-size: 12px; }
    .body { padding: 6px 18px 12px; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
    input[type=text], select {
      font: inherit; color: inherit; background: var(--soft); border: 1px solid var(--line); border-radius: 10px;
      padding: 9px 11px; width: 100%; outline: none;
    }
    input[type=text]:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
    .row { display: flex; gap: 8px; }
    .list { overflow: auto; border: 1px solid var(--line); border-radius: 10px; min-height: 120px; max-height: 300px; }
    .item {
      display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 12px; background: none; border: 0;
      border-bottom: 1px solid var(--line); color: inherit; font: inherit; text-align: left; cursor: pointer;
    }
    .item:last-child { border-bottom: 0; }
    .item:hover, .item[aria-selected=true] { background: var(--soft); }
    .item[aria-selected=true] { box-shadow: inset 3px 0 0 var(--accent); }
    .ico { width: 28px; height: 28px; border-radius: 8px; flex: none; display: grid; place-items: center;
      font-size: 9px; font-weight: 700; letter-spacing: .02em; color: #fff; background: var(--tone, #8b90a0); }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .empty { color: var(--muted); text-align: center; padding: 28px 12px; }
    .note { font-size: 12px; color: var(--muted); min-height: 16px; }
    .note.warn { color: var(--warn); }
    .note.err { color: #dc2626; }
    footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px 16px; border-top: 1px solid var(--line); }
    footer .grow { margin-right: auto; }
    button.btn {
      font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 10px; cursor: pointer;
      border: 1px solid var(--line); background: var(--soft); color: var(--fg);
    }
    button.btn:hover { border-color: var(--muted); }
    button.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.btn.primary:hover { filter: brightness(1.08); }
    button.btn:disabled { opacity: .5; cursor: not-allowed; }
    label.check { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .toast {
      position: fixed; left: 50%; bottom: 28px; z-index: 2147483100; transform: translateX(-50%);
      background: #17181c; color: #fff; padding: 10px 16px; border-radius: 999px; font-size: 13px; font-weight: 550;
      box-shadow: 0 10px 30px rgba(0,0,0,.35); animation: rise .2s ease-out; max-width: 90vw;
    }
    .toast.err { background: #b91c1c; }

    .dock { position: fixed; left: 0; top: 50%; z-index: 2147482000; transform: translateY(-50%); }
    .tab {
      display: block; width: 12px; height: 56px; border: 0; padding: 0; cursor: pointer; opacity: .55;
      background: var(--accent); border-radius: 0 8px 8px 0; transition: opacity .15s;
    }
    .dock:hover .tab, .dock:focus-within .tab { opacity: 0; }
    .menu {
      position: absolute; left: 0; top: 50%; transform: translate(-110%, -50%); padding: 8px; width: 200px;
      background: var(--bg); border: 1px solid var(--line); border-left: 0; border-radius: 0 14px 14px 0;
      box-shadow: 8px 8px 30px rgba(0,0,0,.25); transition: transform .18s cubic-bezier(.2, .9, .3, 1);
      display: flex; flex-direction: column; gap: 2px;
    }
    .dock:hover .menu, .dock:focus-within .menu, .dock.open .menu { transform: translate(0, -50%); }
    .menu a { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; color: var(--fg);
      text-decoration: none; font-weight: 550; }
    .menu a:hover { background: var(--soft); }
    .menu a[aria-current=page] { background: color-mix(in srgb, var(--tone) 14%, transparent); }
    .menu .ico { width: 22px; height: 22px; border-radius: 7px; }
    .menu hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; width: 100%; }

    @keyframes fade { from { opacity: 0 } }
    @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.97) } }
    @keyframes rise { from { opacity: 0; transform: translate(-50%, 10px) } }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
  `;

  const TONES = { docs: '#3b6cf6', sheets: '#16a36a', slides: '#f2760f' };
  let host, shadow, ui;

  function mount() {
    if (host && host.isConnected) return;
    host = h('div', { id: 'office-shim-ui' });
    shadow = host.attachShadow({ mode: 'open' });
    ui = h('div', { class: 'ui' });
    shadow.append(h('style', {}, CSS), ui);
    // The app listens for keyboard, pointer and clipboard events on the document;
    // nothing typed or clicked inside our dialogs should reach it.
    for (const t of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'copy', 'cut',
      'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'click', 'wheel',
      'touchstart', 'touchend', 'touchmove', 'compositionstart', 'compositionupdate', 'compositionend']) {
      host.addEventListener(t, (e) => e.stopPropagation());
    }
    document.documentElement.append(host);
  }

  function whenBodyReady(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  function toast(message, isError) {
    mount();
    const el = h('div', { class: 'toast' + (isError ? ' err' : ''), role: 'status' }, message);
    ui.append(el);
    setTimeout(() => el.remove(), isError ? 6000 : 3000);
  }

  function icon(file) {
    const ext = extOf(file.name).slice(1);
    return h('span', { class: 'ico', style: `--tone:${TONES[file.app] || '#8b90a0'}`, 'aria-hidden': 'true' }, (ext || 'file').slice(0, 4).toUpperCase());
  }

  /** Shows a modal dialog. `build(close)` returns { title, sub?, body, footer, focus? }. */
  function modal(build) {
    mount();
    const prevFocus = document.activeElement;
    return new Promise((resolve) => {
      const scrim = h('div', { class: 'scrim' });
      const finish = (value) => {
        window.removeEventListener('keydown', onKey, true);
        scrim.remove();
        // Give the keyboard back to the app.
        const canvas = document.querySelector('canvas');
        (canvas || prevFocus)?.focus?.({ preventScroll: true });
        resolve(value);
      };
      const parts = build(finish);
      const card = h('div', { class: 'card', role: 'dialog', 'aria-modal': 'true', 'aria-label': parts.title },
        h('header', {}, h('span', { class: 'dot' }), h('h2', {}, parts.title), parts.sub ? h('span', { class: 'sub' }, parts.sub) : null),
        h('div', { class: 'body' }, parts.body),
        h('footer', {}, parts.footer));
      scrim.append(card);
      scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) parts.cancel(); });
      // Capture phase on window so the app never sees keys while a dialog is open.
      const onKey = (e) => {
        e.stopImmediatePropagation();
        if (e.key === 'Escape') { e.preventDefault(); parts.cancel(); }
        else parts.onKey?.(e);
      };
      window.addEventListener('keydown', onKey, true);
      ui.append(scrim);
      (parts.focus || card.querySelector('input, button'))?.focus();
    });
  }

  // ------------------------------------------------------------ Open dialog

  function acceptMatcher(accept) {
    const exts = (accept || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.startsWith('.'));
    return exts.length ? (name) => exts.includes(extOf(name)) : () => true;
  }

  async function chooseServerFile(accept) {
    let files;
    try { files = await listFiles(); } catch (err) { toast(String(err.message || err), true); return { cancelled: true }; }
    const matches = acceptMatcher(accept);
    const anyHidden = files.some((f) => !matches(f.name));

    return modal((close) => {
      let selected = 0, showAll = false, visible = [];
      const search = h('input', { type: 'text', placeholder: 'Search files…', 'aria-label': 'Search files', autocomplete: 'off', spellcheck: false });
      const list = h('div', { class: 'list', role: 'listbox' });
      const all = h('input', { type: 'checkbox', onchange: (e) => { showAll = e.target.checked; render(); } });
      const pick = (f) => close({ file: f });

      function render() {
        const q = search.value.trim().toLowerCase();
        visible = files.filter((f) => (showAll || matches(f.name)) && f.name.toLowerCase().includes(q));
        selected = Math.min(selected, Math.max(visible.length - 1, 0));
        list.replaceChildren(...(visible.length
          ? visible.map((f, i) => h('button', { class: 'item', role: 'option', type: 'button', 'aria-selected': String(i === selected), onclick: () => pick(f), onmouseenter: () => { selected = i; mark(); } },
              icon(f), h('span', { class: 'name', title: f.name }, f.name), h('span', { class: 'meta' }, formatSize(f.size) + ' · ' + formatAge(f.modified))))
          : [h('div', { class: 'empty' }, files.length ? 'No matching files.' : 'No files yet. Anything you save in Office shows up here.')]));
      }
      function mark() { [...list.children].forEach((el, i) => el.setAttribute('aria-selected', String(i === selected))); }
      search.addEventListener('input', () => { selected = 0; render(); });
      render();

      return {
        title: 'Open from Office', sub: files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : '',
        body: [search, list, anyHidden ? h('label', { class: 'check' }, all, 'Show all file types') : null],
        footer: [
          h('button', { class: 'btn grow', type: 'button', onclick: () => close({ native: true }) }, 'Browse this computer…'),
          h('button', { class: 'btn', type: 'button', onclick: () => close({ cancelled: true }) }, 'Cancel'),
        ],
        focus: search,
        cancel: () => close({ cancelled: true }),
        onKey(e) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            selected = Math.max(0, Math.min(visible.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)));
            mark(); list.children[selected]?.scrollIntoView({ block: 'nearest' });
          } else if (e.key === 'Enter' && visible[selected]) { e.preventDefault(); pick(visible[selected]); }
        },
      };
    });
  }

  async function fetchServerFile(name) {
    const res = await fetch(apiUrl('files/' + encodeURIComponent(name)), { cache: 'no-store' });
    if (!res.ok) throw new Error(await failure(res, `Could not open ${name}`));
    return new File([await res.blob()], name, { type: '', lastModified: Date.parse(res.headers.get('Last-Modified')) || Date.now() });
  }

  const nativeClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type !== 'file') return nativeClick.apply(this, arguments);
    const input = this;
    (async () => {
      const choice = await chooseServerFile(input.accept);
      if (choice.native) return nativeClick.call(input);
      if (choice.cancelled) return input.dispatchEvent(new Event('cancel'));
      try {
        const file = await fetchServerFile(choice.file.name);
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (err) {
        toast(String(err.message || err), true);
        input.dispatchEvent(new Event('cancel'));
      }
    })();
  };

  // ------------------------------------------------------------ Save dialog

  /** Normalises showSaveFilePicker's `types` option into [{ label, ext }]. */
  function saveFormats(types) {
    const out = [];
    for (const t of types || []) {
      for (const exts of Object.values(t.accept || {})) {
        for (const ext of exts) out.push({ label: `${t.description || ext.slice(1).toUpperCase()} (${ext})`, ext: ext.toLowerCase() });
      }
    }
    return out;
  }

  async function chooseSaveTarget(opts) {
    let files = [];
    try { files = await listFiles(); } catch { /* the PUT will report a real error */ }
    const formats = saveFormats(opts && opts.types);
    const existing = new Set(files.map((f) => f.name));

    return modal((close) => {
      const input = h('input', { type: 'text', value: (opts && opts.suggestedName) || 'Untitled', 'aria-label': 'File name', autocomplete: 'off', spellcheck: false });
      const format = formats.length > 1
        ? h('select', { 'aria-label': 'File type', onchange: () => {
            const cur = input.value;
            const stem = formats.some((f) => f.ext === extOf(cur)) ? cur.slice(0, cur.lastIndexOf('.')) : cur;
            input.value = stem + format.value; check();
          } }, formats.map((f) => h('option', { value: f.ext, selected: f.ext === extOf(input.value) }, f.label)))
        : null;
      const note = h('div', { class: 'note', 'aria-live': 'polite' });
      const save = h('button', { class: 'btn primary', type: 'button', onclick: () => submit() }, 'Save');
      const list = h('div', { class: 'list', 'aria-label': 'Existing files' });

      function finalName() {
        let name = input.value.trim();
        const want = format ? format.value : formats[0]?.ext;
        // Not one of the offered formats (e.g. no extension typed): use the chosen one.
        if (want && !formats.some((f) => f.ext === extOf(name))) name += want;
        return name;
      }
      function check() {
        const name = finalName(), problem = nameProblem(name), replaces = existing.has(name);
        note.className = 'note' + (problem ? ' err' : replaces ? ' warn' : '');
        note.textContent = problem || (replaces ? 'A file with this name already exists and will be replaced.' : 'Saved in your Office files.');
        save.textContent = replaces ? 'Replace' : 'Save';
        save.disabled = Boolean(problem);
        if (format && formats.some((f) => f.ext === extOf(name))) format.value = extOf(name);
      }
      function submit() {
        const name = finalName();
        if (!nameProblem(name)) close({ name, replaces: existing.has(name) });
      }
      const wanted = formats.map((f) => f.ext);
      const related = files.filter((f) => !wanted.length || wanted.includes(extOf(f.name)));
      list.replaceChildren(...(related.length
        ? related.slice(0, 50).map((f) => h('button', { class: 'item', type: 'button', onclick: () => { input.value = f.name; check(); input.focus(); } },
            icon(f), h('span', { class: 'name', title: f.name }, f.name), h('span', { class: 'meta' }, formatAge(f.modified))))
        : [h('div', { class: 'empty' }, 'No saved files of this type yet.')]));
      input.addEventListener('input', check);
      check();

      return {
        title: 'Save to Office',
        body: [h('div', { class: 'row' }, input, format), note, list],
        footer: [
          h('button', { class: 'btn grow', type: 'button', onclick: () => close({ download: finalName() }) }, 'Download instead'),
          h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel'),
          save,
        ],
        focus: input,
        cancel: () => close(null),
        onKey(e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } },
      };
    });
  }

  /** A FileSystemWritableFileStream stand-in: collects the bytes, then hands them to `commit`. */
  function makeWritable(commit) {
    const chunks = [];
    let size = 0;
    const append = (data) => { chunks.push(data); size += data.size ?? data.byteLength ?? String(data).length; };
    return {
      async write(chunk) {
        if (chunk && typeof chunk === 'object' && 'type' in chunk && !(chunk instanceof Blob)) {
          if (chunk.type === 'write') {
            if (chunk.position != null && chunk.position !== size) throw new DOMException('Random-access writes are not supported.', 'NotSupportedError');
            return append(chunk.data);
          }
          if (chunk.type === 'truncate' && chunk.size === 0) { chunks.length = 0; size = 0; return; }
          throw new DOMException(`${chunk.type} is not supported.`, 'NotSupportedError');
        }
        append(chunk);
      },
      async seek(position) { if (position !== size) throw new DOMException('Random-access writes are not supported.', 'NotSupportedError'); },
      async truncate(n) { if (n !== 0 || chunks.length) throw new DOMException('truncate is not supported.', 'NotSupportedError'); },
      async close() { await commit(new Blob(chunks)); },
      async abort() { chunks.length = 0; },
    };
  }

  function makeHandle(name, commit) {
    return {
      kind: 'file',
      name,
      async createWritable() { return makeWritable(commit); },
      async getFile() { return fetchServerFile(name); },
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async isSameEntry(other) { return other === this; },
    };
  }

  async function putFile(name, blob) {
    let res;
    try {
      res = await fetch(apiUrl('files/' + encodeURIComponent(name)), { method: 'PUT', body: blob });
    } catch (err) {
      toast(`Couldn’t save ${name}: the server is unreachable.`, true);
      throw err;
    }
    if (!res.ok) {
      const msg = await failure(res, `HTTP ${res.status}`);
      toast(`Couldn’t save ${name}: ${msg}`, true);
      throw new Error(msg);
    }
    toast(`Saved ${name} to Office`);
  }

  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    nativeAnchorClick.call(a);
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  window.showSaveFilePicker = async function (opts) {
    const target = await chooseSaveTarget(opts);
    if (!target) throw new DOMException('The user aborted a request.', 'AbortError');
    if (target.download) return makeHandle(target.download, async (blob) => downloadBlob(target.download, blob));
    return makeHandle(target.name, (blob) => putFile(target.name, blob));
  };

  // Apps that save by clicking a download link get the same dialog.
  const nativeAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.hasAttribute('download') || !this.href.startsWith('blob:')) return nativeAnchorClick.apply(this, arguments);
    const link = this;
    const name = link.download || 'Untitled';
    const blob = fetch(link.href).then((r) => r.blob()); // start now: the app may revoke the URL right away
    blob.catch(() => {});
    (async () => {
      const ext = extOf(name);
      const target = await chooseSaveTarget({ suggestedName: name, types: ext ? [{ description: ext.slice(1).toUpperCase(), accept: { 'application/octet-stream': [ext] } }] : [] });
      if (!target) return;
      try {
        const data = await blob;
        if (target.download) downloadBlob(target.download, data);
        else await putFile(target.name, data);
      } catch (err) { toast(`Couldn’t save ${name}: ${err.message || err}`, true); }
    })();
  };

  // ---------------------------------------------------------- Deep link open

  /** Opens /<app>/?open=<name> by dropping the file on the canvas, as if the user had. */
  async function openFromQuery() {
    const name = new URLSearchParams(location.search).get('open');
    if (!name) return;
    let file;
    try { file = await fetchServerFile(name); } catch (err) { return toast(String(err.message || err), true); }
    const deadline = Date.now() + 20000;
    while (!document.querySelector('canvas') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    // Let the app finish installing its event handlers before the drop.
    await new Promise((r) => setTimeout(r, 600));
    const canvas = document.querySelector('canvas');
    if (!canvas) return toast('The app did not start in time to open ' + name, true);
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      canvas.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  }
  addEventListener('TrunkApplicationStarted', openFromQuery, { once: true });

  // -------------------------------------------------------- App switcher dock

  async function mountDock() {
    const info = await getInfo();
    mount();
    const link = (href, tone, label, glyph, current) => h('a', { href, 'aria-current': current ? 'page' : null, style: `--tone:${tone}` },
      h('span', { class: 'ico', style: `--tone:${tone}`, 'aria-hidden': 'true' }, glyph), label);
    const dock = h('nav', { class: 'dock', 'aria-label': 'Office' },
      h('div', { class: 'menu' },
        link(new URL('./', ROOT).href, '#6b6f7b', 'Office home', '⌂', false),
        h('hr'),
        (info.apps || []).map((a) => link(new URL(a.slug + '/', ROOT).href, a.accent, a.name, a.name[0], a.slug === APP))),
      h('button', { class: 'tab', type: 'button', 'aria-label': 'Open Office menu', onclick: () => dock.classList.toggle('open') }));
    ui.append(dock);
  }
  whenBodyReady(mountDock);
})();
