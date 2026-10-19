/* Office home page: app cards and the file manager. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) el.append(c);
    return el;
  }

  const svg = (markup) => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstChild; };
  const extOf = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#3b6cf6');

  function formatSize(n) {
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
  }

  function formatAge(iso) {
    const secs = (new Date(iso) - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (const [unit, s] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
      if (Math.abs(secs) >= s) return rtf.format(Math.round(secs / s), unit);
    }
    return 'just now';
  }

  // -------------------------------------------------------------- theme toggle

  $('#theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('office-theme', root.dataset.theme); } catch { /* private mode */ }
  });

  // ------------------------------------------------------------ pointer effects

  if (matchMedia('(hover: hover)').matches && !reduceMotion) {
    addEventListener('pointermove', (e) => {
      document.body.classList.add('has-pointer');
      const spot = $('.spot');
      spot.style.setProperty('--sx', e.clientX + 'px');
      spot.style.setProperty('--sy', e.clientY + 'px');
    }, { passive: true });
  }

  function enableTilt(card) {
    if (reduceMotion || !matchMedia('(hover: hover)').matches) return;
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      card.classList.add('live');
      card.style.setProperty('--rx', ((0.5 - py) * 7).toFixed(2) + 'deg');
      card.style.setProperty('--ry', ((px - 0.5) * 9).toFixed(2) + 'deg');
      card.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
      card.style.setProperty('--my', (py * 100).toFixed(1) + '%');
    });
    card.addEventListener('pointerleave', () => {
      card.classList.remove('live');
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
    });
  }

  // --------------------------------------------------------------------- art

  const ART = {
    docs: `<svg class="art" viewBox="0 0 320 180" aria-hidden="true">
      <rect class="paper" x="78" y="14" width="164" height="156" rx="10"/>
      <rect class="ln title" style="--n:0" x="96" y="32" width="72" height="9" rx="4.5"/>
      <rect class="ln" style="--n:1" x="96" y="54" width="128" height="5" rx="2.5"/>
      <rect class="ln" style="--n:2" x="96" y="66" width="118" height="5" rx="2.5"/>
      <rect class="ln" style="--n:3" x="96" y="78" width="128" height="5" rx="2.5"/>
      <rect class="ln" style="--n:4" x="96" y="90" width="92" height="5" rx="2.5"/>
      <rect class="ln" style="--n:5" x="96" y="108" width="128" height="5" rx="2.5"/>
      <rect class="ln" style="--n:6" x="96" y="120" width="108" height="5" rx="2.5"/>
      <rect class="ln" style="--n:7" x="96" y="132" width="60" height="5" rx="2.5"/>
      <rect class="caret" x="160" y="129" width="2" height="11" rx="1"/>
      <g class="float" style="--d:-1s"><rect class="badge" x="20" y="38" width="62" height="26" rx="13"/><text class="badge-t" x="51" y="55" text-anchor="middle">B  I  U</text></g>
      <g class="float" style="--d:-2.4s"><rect class="badge" x="246" y="104" width="54" height="26" rx="13" opacity=".85"/><text class="badge-t" x="273" y="121" text-anchor="middle">Aa</text></g>
    </svg>`,
    sheets: `<svg class="art" viewBox="0 0 320 180" aria-hidden="true">
      <rect class="cellbg" x="34" y="18" width="252" height="144" rx="10"/>
      <rect class="head" x="34" y="18" width="252" height="24" rx="10"/>
      <rect class="head" x="34" y="30" width="252" height="12"/>
      <g class="grid"><path d="M94 18v144M154 18v144M214 18v144M34 66h252M34 90h252M34 114h252M34 138h252"/></g>
      <rect class="sel" x="96" y="44" width="56" height="20" rx="3"/>
      <rect class="bar" style="--n:0" x="226" y="112" width="12" height="40" rx="3"/>
      <rect class="bar" style="--n:1" x="242" y="92" width="12" height="60" rx="3" opacity=".8"/>
      <rect class="bar" style="--n:2" x="258" y="74" width="12" height="78" rx="3" opacity=".65"/>
      <g class="float" style="--d:-.6s"><rect class="badge" x="44" y="130" width="96" height="24" rx="12"/><text class="badge-t" x="92" y="146" text-anchor="middle">=SUM(B2:B5)</text></g>
    </svg>`,
    slides: `<svg class="art" viewBox="0 0 320 180" aria-hidden="true">
      <g class="tile t1" style="--d:-1.5s"><rect class="s" x="86" y="24" width="170" height="104" rx="10"/></g>
      <g class="tile t2" style="--d:-3s"><rect class="s" x="66" y="30" width="170" height="104" rx="10"/></g>
      <g class="tile t3">
        <rect class="s" x="74" y="38" width="176" height="106" rx="10"/>
        <rect class="ln title" style="--n:0" x="90" y="54" width="84" height="10" rx="5"/>
        <rect class="ln" style="--n:1" x="90" y="76" width="74" height="5" rx="2.5"/>
        <rect class="ln" style="--n:2" x="90" y="88" width="60" height="5" rx="2.5"/>
        <circle class="shape" cx="212" cy="82" r="20"/>
        <path class="shape alt" d="M196 126l16-26 16 26z"/>
      </g>
      <circle class="play" cx="280" cy="152" r="15"/><path d="M276 145l12 7-12 7z" fill="#fff"/>
      <g fill="currentColor" opacity=".35"><circle cx="146" cy="162" r="3"/><circle cx="160" cy="162" r="3"/><circle cx="174" cy="162" r="3"/></g>
    </svg>`,
  };
  const fallbackArt = (letter) => `<svg class="art" viewBox="0 0 320 180" aria-hidden="true"><rect class="paper" x="100" y="24" width="120" height="132" rx="16"/><text class="letter" x="160" y="122" text-anchor="middle"></text></svg>`.replace('></text>', `>${letter.replace(/[<&]/g, '')}</text>`);

  // ------------------------------------------------------------------- toasts

  function toast(message, isError) {
    const el = h('div', { class: 'toast' + (isError ? ' err' : '') }, message);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), isError ? 6000 : 3200);
  }

  function confetti(x, y, colors) {
    if (reduceMotion) return;
    for (let i = 0; i < 18; i++) {
      const a = (Math.PI * 2 * i) / 18 + Math.random() * 0.4, d = 70 + Math.random() * 90;
      const piece = h('span', { class: 'confetti' });
      piece.style.cssText = `left:${x}px;top:${y}px;background:${colors[i % colors.length]};--x:${Math.cos(a) * d}px;--y:${Math.sin(a) * d + 30}px;--r:${Math.random() * 540}deg`;
      document.body.append(piece);
      setTimeout(() => piece.remove(), 1200);
    }
  }

  // --------------------------------------------------------------------- state

  let apps = [], files = [], maxUpload = Infinity;
  const sort = { key: 'modified', dir: -1 };
  const appBySlug = (slug) => apps.find((a) => a.slug === slug);
  const tone = (slug) => safeColor(appBySlug(slug)?.accent || '#8b90a0');

  async function request(url, init) {
    const res = await fetch(url, init);
    if (!res.ok) {
      let msg = 'Something went wrong';
      try { msg = (await res.json()).error || msg; } catch { /* not json */ }
      throw Object.assign(new Error(msg), { status: res.status });
    }
    return res;
  }

  // --------------------------------------------------------------------- apps

  function renderApps() {
    const wrap = $('#apps');
    wrap.replaceChildren(...apps.map((a, i) => {
      const accent = safeColor(a.accent);
      const card = h('a', { class: 'card reveal', href: encodeURIComponent(a.slug) + '/', style: `--accent:${accent};--i:${i + 3}`, 'aria-label': `Open ${a.name}` },
        h('div', { class: 'art-wrap' }),
        h('div', { class: 'card-body' },
          h('div', { class: 'card-head' }, h('h2', {}, a.name), i < 9 ? h('span', { class: 'kbd', title: `Press ${i + 1}` }, String(i + 1)) : null),
          h('p', {}, a.tagline || ''),
          h('div', { class: 'card-foot' },
            h('span', { class: 'open' }, 'Open ', h('span', { 'aria-hidden': 'true' }, '→')),
            a.engine ? h('span', { class: 'engine' }, 'powered by ' + a.engine) : null)));
      $('.art-wrap', card).append(svg(ART[a.slug] || fallbackArt(a.name[0] || '?')));
      enableTilt(card);
      return card;
    }));
  }

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || /^(input|textarea|select)$/i.test(e.target.tagName) || $('dialog[open]')) return;
    const app = apps[Number(e.key) - 1];
    if (app) location.href = encodeURIComponent(app.slug) + '/';
  });

  // -------------------------------------------------------------------- files

  function visibleFiles() {
    const q = $('#q').value.trim().toLowerCase();
    const list = files.filter((f) => f.name.toLowerCase().includes(q));
    const { key, dir } = sort;
    return list.sort((a, b) => {
      const x = key === 'name' ? a.name.toLowerCase() : key === 'size' ? a.size : Date.parse(a.modified);
      const y = key === 'name' ? b.name.toLowerCase() : key === 'size' ? b.size : Date.parse(b.modified);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }

  const ICONS = {
    open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    rename: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/>',
  };
  const icon = (name) => svg(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`);
  const fileUrl = (name) => 'api/files/' + encodeURIComponent(name);
  const openUrl = (f) => encodeURIComponent(f.app) + '/?open=' + encodeURIComponent(f.name);

  function renderFiles() {
    const rows = $('#rows');
    const list = visibleFiles();
    const total = files.reduce((n, f) => n + f.size, 0);
    $('#files-sub').textContent = files.length
      ? `${files.length} file${files.length === 1 ? '' : 's'} · ${formatSize(total)} saved on this server`
      : 'Saved on this server';

    for (const btn of document.querySelectorAll('#cols button')) {
      const active = btn.dataset.sort === sort.key;
      if (active) { btn.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending'); btn.dataset.arrow = sort.dir > 0 ? '↑' : '↓'; }
      else { btn.removeAttribute('aria-sort'); btn.dataset.arrow = ''; }
    }

    if (!list.length) {
      rows.replaceChildren(files.length
        ? h('div', { class: 'empty' }, h('h3', {}, 'No matches'), h('p', {}, 'Nothing called “' + $('#q').value + '” here.'))
        : emptyState());
      return;
    }
    rows.replaceChildren(...list.map((f, i) => {
      const app = appBySlug(f.app);
      const label = (extOf(f.name) || 'file').slice(0, 4).toUpperCase();
      const chip = h('span', { class: 'ico', style: `--tone:${tone(f.app)}`, 'aria-hidden': 'true' }, label);
      const name = h('span', { class: 't', title: f.name }, f.name);
      return h('div', { class: 'row', style: `--i:${Math.min(i, 12)}` },
        app ? h('a', { class: 'fname', href: openUrl(f), title: `Open in ${app.name}` }, chip, name)
            : h('span', { class: 'fname' }, chip, name),
        h('span', { class: 'muted size r' }, formatSize(f.size)),
        h('span', { class: 'muted when', title: new Date(f.modified).toLocaleString() }, formatAge(f.modified)),
        h('div', { class: 'actions' },
          app ? h('a', { class: 'act', href: openUrl(f), title: `Open in ${app.name}`, 'aria-label': `Open ${f.name} in ${app.name}` }, icon('open')) : null,
          h('a', { class: 'act', href: fileUrl(f.name), title: 'Download', 'aria-label': `Download ${f.name}` }, icon('download')),
          h('button', { class: 'act', type: 'button', title: 'Rename', 'aria-label': `Rename ${f.name}`, onclick: () => renameFile(f) }, icon('rename')),
          h('button', { class: 'act del', type: 'button', title: 'Delete', 'aria-label': `Delete ${f.name}`, onclick: () => deleteFile(f) }, icon('trash'))));
    }));
  }

  function emptyState() {
    const folder = svg(`<svg class="folder" viewBox="0 0 120 96" aria-hidden="true">
      <rect x="8" y="22" width="104" height="66" rx="12" fill="var(--c-docs)" opacity=".18"/>
      <path d="M8 34a12 12 0 0 1 12-12h22l10 10h48a12 12 0 0 1 12 12v42a12 12 0 0 1-12 12H20A12 12 0 0 1 8 86z" fill="var(--c-docs)" opacity=".9"/>
      <circle cx="92" cy="20" r="5" fill="var(--c-slides)"/><circle cx="26" cy="12" r="4" fill="var(--c-sheets)"/><path d="M60 8v10M55 13h10" stroke="var(--c-slides)" stroke-width="3" stroke-linecap="round"/>
    </svg>`);
    return h('div', { class: 'empty' }, folder, h('h3', {}, 'Nothing saved yet'),
      h('p', {}, 'Create something in one of the apps and it will show up here, or drop a file anywhere on this panel.'),
      h('button', { class: 'btn', type: 'button', onclick: () => $('#picker').click() }, 'Upload a file'));
  }

  async function refresh() {
    try {
      files = (await (await request('api/files', { cache: 'no-store' })).json()).files;
      renderFiles();
    } catch (err) { toast('Could not load files: ' + err.message, true); }
  }

  // ----------------------------------------------------------------- dialogs

  /**
   * Modal form. `onSubmit(value)` resolves to an error message to keep the dialog
   * open, or nothing to close it.
   */
  function dialog({ title, text, input, confirm, danger, onSubmit }) {
    const dlg = $('#dlg');
    const field = input != null ? h('input', { type: 'text', value: input, autocomplete: 'off', 'aria-label': title }) : null;
    const err = h('div', { class: 'err', 'aria-live': 'polite' });
    const ok = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'submit' }, confirm);
    const form = h('form', { method: 'dialog' }, h('h3', {}, title), text ? h('p', {}, text) : null, field, err,
      h('div', { class: 'btns' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), ok));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      ok.disabled = true;
      const msg = await onSubmit(field ? field.value.trim() : true);
      ok.disabled = false;
      if (msg) err.textContent = msg; else dlg.close();
    });
    dlg.replaceChildren(form);
    dlg.showModal();
    if (field) { field.focus(); const dot = field.value.lastIndexOf('.'); field.setSelectionRange(0, dot > 0 ? dot : field.value.length); }
  }

  function renameFile(f) {
    dialog({
      title: 'Rename file', input: f.name, confirm: 'Rename',
      async onSubmit(name) {
        if (!name || name === f.name) return;
        try {
          await request(fileUrl(f.name), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        } catch (err) { return err.message; }
        toast(`Renamed to ${name}`);
        refresh();
      },
    });
  }

  function deleteFile(f) {
    dialog({
      title: 'Delete this file?', text: `“${f.name}” will be permanently removed from the server.`, confirm: 'Delete', danger: true,
      async onSubmit() {
        try { await request(fileUrl(f.name), { method: 'DELETE' }); } catch (err) { return err.message; }
        toast(`Deleted ${f.name}`);
        refresh();
      },
    });
  }

  // ------------------------------------------------------------------ upload

  function uniqueName(name) {
    const taken = new Set(files.map((f) => f.name));
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 2; ; n++) if (!taken.has(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
  }

  async function upload(list) {
    let done = 0;
    for (const file of list) {
      if (file.size > maxUpload) { toast(`${file.name} is larger than the ${formatSize(maxUpload)} upload limit`, true); continue; }
      let name = file.name;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await request(fileUrl(name), { method: 'PUT', headers: { 'If-None-Match': '*' }, body: file });
            break;
          } catch (err) {
            if (err.status !== 412) throw err;
            name = uniqueName(name); // already exists: keep both
          }
        }
        files.push({ name, size: file.size, modified: new Date().toISOString(), app: appFor(name) });
        done++;
      } catch (err) { toast(`${file.name}: ${err.message}`, true); }
    }
    if (done) {
      toast(done === 1 ? 'Uploaded!' : `Uploaded ${done} files`);
      const r = $('#panel').getBoundingClientRect();
      confetti(r.left + r.width / 2, r.top + 60, apps.map((a) => safeColor(a.accent)));
    }
    refresh();
  }

  function appFor(name) {
    const ext = extOf(name);
    return apps.find((a) => a.extensions.includes(ext))?.slug || '';
  }

  $('#upload').addEventListener('click', () => $('#picker').click());
  $('#picker').addEventListener('change', (e) => { upload([...e.target.files]); e.target.value = ''; });

  // Drag and drop anywhere on the page, highlighted on the panel.
  const panel = $('#panel');
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; panel.classList.add('dragging'); $('#files').scrollIntoView({ behavior: 'smooth', block: 'center' }); } });
  addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; panel.classList.remove('dragging'); } });
  addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; panel.classList.remove('dragging');
    upload([...e.dataTransfer.files]);
  });

  // ------------------------------------------------------------- sorting/search

  $('#q').addEventListener('input', renderFiles);
  $('#cols').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sort]');
    if (!btn) return;
    sort.dir = sort.key === btn.dataset.sort ? -sort.dir : btn.dataset.sort === 'name' ? 1 : -1;
    sort.key = btn.dataset.sort;
    renderFiles();
  });

  // Scroll reveal for the files section.
  const revealer = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { en.target.classList.add('reveal'); revealer.unobserve(en.target); }
  }, { threshold: 0.08 });
  revealer.observe($('#files'));

  // --------------------------------------------------------------------- boot

  (async () => {
    try {
      const info = await (await request('api/info')).json();
      apps = info.apps;
      maxUpload = info.maxUploadBytes || Infinity;
      $('#version').textContent = info.version && info.version !== 'dev' ? 'v' + info.version : '';
      const credits = apps.filter((a) => a.engine && a.repo);
      if (credits.length) {
        const el = $('#credits');
        el.replaceChildren('Built on open source: ', ...credits.flatMap((a, i) => [i ? ', ' : '', h('a', { href: a.repo, rel: 'noopener', target: '_blank' }, a.engine)]));
      }
      renderApps();
    } catch (err) {
      $('#apps').replaceChildren(h('p', { class: 'muted' }, 'Could not load apps: ' + err.message));
    }
    await refresh();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  })();
})();
