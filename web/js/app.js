import { state, login, signup, loadMe, changePassword, logout, pull, subscribe, list, get, save, remove, uid, api, fileUrl, uploadImage } from './api.js';
import { Tracer } from './drawing2d.js';
import { fmt, num, parseLen, getUnit, toggleUnit, toUnit } from './units.js';
import { Model3D, ROUTE_KINDS } from './model3d.js';
import { lengthFromLoop, defaultReturnSize, wpLength, checkLength, positionAlong, polyLength, asBuiltPoints } from './lengths.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const main = $('#main'), dlg = $('#dlg');
let cleanup = null, saveTimer = null;

/** Small modal form. fields: [{name,label,type,value,options,step}] -> {name:value} or null. */
export function ask(title, fields, text = '') {
  return new Promise((resolve) => {
    dlg.innerHTML = `<form method="dialog"><h3 style="margin-top:0">${esc(title)}</h3>${text ? `<p class="dim">${esc(text)}</p>` : ''}
      ${fields.map((f) => `<label>${esc(f.label)}</label>${f.type === 'select'
        ? `<select name="${f.name}">${f.options.map((o) => `<option ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
        : `<input name="${f.name}" type="${f.type || 'text'}" step="${f.step || ''}" value="${esc(f.value ?? '')}" style="width:100%">`}`).join('')}
      <div class="row" style="margin-top:14px;justify-content:flex-end"><button value="cancel" type="button" id="dc">${fields.length ? 'Cancel' : 'OK'}</button>${fields.length ? '<button class="primary" value="ok">OK</button>' : ''}</div></form>`;
    const done = (v) => { dlg.close(); resolve(v); };
    $('#dc', dlg).onclick = () => done(null);
    $('form', dlg).onsubmit = (e) => { e.preventDefault(); done(Object.fromEntries(new FormData(e.target))); };
    dlg.oncancel = () => resolve(null);
    dlg.showModal(); const first = dlg.querySelector('input,select'); first?.focus();
  });
}

let pendingSave = null;
function flush() { clearTimeout(saveTimer); const f = pendingSave; pendingSave = null; if (f) f(); } // leaving a page must not drop an edit
function autosave(kind, id, obj, onSaved) {
  clearTimeout(saveTimer);
  const run = async () => { pendingSave = null; try { await save(kind, id, structuredClone(obj)); onSaved?.(); } catch (e) { alert('Save failed: ' + e.message); } };
  pendingSave = run;
  saveTimer = setTimeout(run, 500);
}

// ---------------- login / sign-up ----------------
function viewLogin(err = '', mode = 'login', keep = {}) {
  const su = mode === 'signup';
  const v = (k) => esc(keep[k] || '');
  main.innerHTML = `<div class="card" style="max-width:420px;margin:60px auto"><h2 style="margin-top:0">Cable Trace</h2>
    <p class="dim">${su ? 'Create an account with your invite code.' : 'Sign in to see your team\'s jobs.'}</p>
    ${su ? '<label>Your name</label><input id="nm" autocomplete="name" value="'+v('nm')+'" style="width:100%">' : ''}
    <label>Email</label><input id="em" type="email" autocomplete="username" autocapitalize="off" value="${v('em')}" style="width:100%">
    <label>Password${su ? ' (at least 10 characters)' : ''}</label><input id="pw" type="password" autocomplete="${su ? 'new-password' : 'current-password'}" style="width:100%">
    ${su ? '<label>Invite code</label><input id="cd" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="'+v('cd')+'" style="width:100%"><label>Team name (only if you are starting a new team)</label><input id="tn" value="'+v('tn')+'" style="width:100%">' : ''}
    <p class="warn">${esc(err)}</p>
    <div class="row"><button class="primary" id="go">${su ? 'Create account' : 'Sign in'}</button>
    <a href="#" id="sw">${su ? 'I already have an account' : 'I have an invite code'}</a></div></div>`;
  const go = async () => {
    try {
      if (su) await signup({ name: $('#nm').value, email: $('#em').value, password: $('#pw').value, code: $('#cd').value, teamName: $('#tn').value });
      else await login($('#em').value, $('#pw').value);
      route();
    } catch (e) {
      const g = (i) => document.querySelector(i)?.value || '';
      viewLogin(e.status ? e.message : 'Could not reach the server', mode, { nm: g('#nm'), em: g('#em'), cd: g('#cd'), tn: g('#tn') });
    }
  };
  $('#go').onclick = go; $('#pw').onkeydown = (e) => e.key === 'Enter' && go();
  $('#sw').onclick = (e) => { e.preventDefault(); viewLogin('', su ? 'login' : 'signup'); };
}

// ---------------- team ----------------
async function viewTeam() {
  const t = await (await api('/api/team')).json();
  const owner = state.user?.role === 'owner';
  main.innerHTML = `<div class="row"><a href="#/">‹ Jobs</a><h2 style="margin:0">${esc(t.team.name)}</h2></div>
    <div class="card"><h3 style="margin-top:0">People</h3>${t.members.map((m) => `<div class="row"><b>${esc(m.name)}</b><span class="dim">${esc(m.email)} · ${m.role}</span>
      ${owner && m.id !== state.user.id ? `<button data-rm="${m.id}">Remove</button>` : ''}</div>`).join('')}</div>
    ${owner ? `<div class="card"><h3 style="margin-top:0">Invite codes</h3>
      <p class="dim">Give a code to someone you want on this team. They use it on the sign-up page. Codes are shown once.</p>
      <div id="newcode"></div>
      ${t.invites.map((i) => `<div class="row dim">Code expires ${new Date(i.expires_at).toLocaleDateString()} · ${i.uses_left} use${i.uses_left === 1 ? '' : 's'} left <button data-rv="${i.id}">Revoke</button></div>`).join('')}
      <button class="primary" id="mk">Create invite code</button></div>` : ''}
    <div class="card"><h3 style="margin-top:0">Your account</h3><p class="dim">${esc(state.user?.email)}</p><button id="pwb">Change password</button></div>`;
  main.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => { if (confirm('Remove this person from the team?')) { await api('/api/team/members/' + b.dataset.rm, { method: 'DELETE' }); viewTeam(); } }));
  main.querySelectorAll('[data-rv]').forEach((b) => (b.onclick = async () => { await api('/api/team/invites/' + b.dataset.rv, { method: 'DELETE' }); viewTeam(); }));
  const mk = $('#mk'); if (mk) mk.onclick = async () => {
    const r = await ask('New invite code', [{ name: 'uses', label: 'How many people can use it', type: 'number', value: 5 }, { name: 'days', label: 'Valid for (days)', type: 'number', value: 14 }]);
    if (!r) return;
    const j = await (await api('/api/team/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uses: +r.uses, days: +r.days }) })).json();
    await viewTeam();
    $('#newcode').innerHTML = `<div class="banner">New code: <b style="font-size:1.3em;letter-spacing:2px">${esc(j.code)}</b> — copy it now, it will not be shown again.</div>`;
  };
  $('#pwb').onclick = async () => {
    const r = await ask('Change password', [{ name: 'cur', label: 'Current password', type: 'password' }, { name: 'nxt', label: 'New password (10+ characters)', type: 'password' }]);
    if (!r) return;
    try { await changePassword(r.cur, r.nxt); await ask('Password changed', [], 'Other devices have been signed out. Sign in again on the phone.'); } catch (e) { await ask('Could not change password', [], e.message); }
  };
}

// ---------------- jobs ----------------
function viewJobs() {
  const jobs = list('job').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  main.innerHTML = `<div class="row"><h2 style="margin:0">Jobs</h2><button class="primary" id="new">New job</button></div>
    <div class="grid" style="margin-top:12px">${jobs.map((j) => {
      const runs = list('run').filter((r) => r.jobId === j.id).length, dr = list('drawing').filter((r) => r.jobId === j.id).length;
      return `<a class="item" href="#/job/${j.id}"><b>${esc(j.name)}</b><div class="dim">${esc(j.address)}</div><div class="dim">${dr} drawings · ${runs} runs</div></a>`; }).join('') || '<p class="dim">No jobs yet.</p>'}</div>`;
  $('#new').onclick = async () => {
    const r = await ask('New job', [{ name: 'name', label: 'Name' }, { name: 'address', label: 'Address (optional)' }]);
    if (!r || !r.name.trim()) return;
    const id = uid(); await save('job', id, { name: r.name.trim(), address: r.address.trim(), planFile: null, createdAt: Date.now() }); location.hash = `#/job/${id}`;
  };
}

function viewJob(id) {
  const job = get('job', id); if (!job) { location.hash = '#/'; return; }
  const drawings = list('drawing').filter((d) => d.jobId === id), runs = list('run').filter((r) => r.jobId === id).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  main.innerHTML = `<div class="row"><a href="#/">‹ Jobs</a><h2 style="margin:0">${esc(job.name)}</h2><span class="dim">${esc(job.address)}</span>
      <span style="flex:1"></span><button id="rename">Edit</button><button class="danger" id="del">Delete job</button></div>
    <div class="card"><div class="row"><h3 style="margin:0;flex:1">Drawings</h3>
      <label class="btn" style="margin:0;cursor:pointer;color:var(--text)">Add drawing photo<input id="file" type="file" accept="image/*" hidden></label>
      ${job.planFile ? '<button id="useplan">Use the phone\'s job plan</button>' : ''}</div>
      <div class="grid" style="margin-top:10px">${drawings.map((d) => `<a class="item" href="#/drawing/${d.id}"><b>${esc(d.name)}</b>
        <div class="dim">${d.pxPerM ? 'Scale set' : '<span class="warn">Scale not set</span>'} · ${d.walls?.length || 0} walls · ${d.routes?.length || 0} routes</div></a>`).join('') || '<p class="dim">Photograph a drawing and add it here, then trace it.</p>'}</div></div>
    <div class="card"><div class="row"><h3 style="margin:0;flex:1">Cable runs</h3><button id="newrun">New run</button></div>
      <div class="grid" style="margin-top:10px">${runs.map((r) => {
        const rec = wpLength(r.waypoints || []), v = checkLength(rec, r.expectedLengthM);
        return `<a class="item" href="#/run/${r.id}"><b>${esc(r.circuitRef)}</b><div class="dim">${esc(r.cableType)} ${esc(r.sizeMm2)}mm²</div>
        <div class="dim">${(r.waypoints || []).length ? `${r.waypoints.length} points · ${fmt(rec, 1)}` : 'Not recorded yet'}</div>${v.warn ? '<div class="warn">⚠ Length check</div>' : ''}</a>`; }).join('') || '<p class="dim">No runs yet.</p>'}</div></div>`;

  $('#file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = await ask('Drawing name', [{ name: 'name', label: 'Name (e.g. Ground floor)', value: f.name.replace(/\.[^.]+$/, '') }]); if (!r) return;
    try { const up = await uploadImage(f); await newDrawing(id, r.name || 'Drawing', up); } catch (err) { alert('Upload failed: ' + err.message); }
  };
  $('#useplan')?.addEventListener('click', async () => {
    const img = new Image(); img.src = fileUrl(job.planFile); await img.decode().catch(() => {});
    await newDrawing(id, 'Job plan', { name: job.planFile, width: img.naturalWidth, height: img.naturalHeight });
  });
  $('#rename').onclick = async () => { const r = await ask('Edit job', [{ name: 'name', label: 'Name', value: job.name }, { name: 'address', label: 'Address', value: job.address }]); if (r) { await save('job', id, { ...job, name: r.name, address: r.address }); viewJob(id); } };
  $('#del').onclick = async () => {
    if (!confirm('Delete this job with all its drawings and runs?')) return;
    for (const d of drawings) await remove('drawing', d.id);
    for (const r of runs) { await remove('run', r.id); }
    await remove('job', id); location.hash = '#/';
  };
  $('#newrun').onclick = async () => {
    const r = await ask('New cable run', [{ name: 'ref', label: 'Circuit reference' }]); if (!r || !r.ref.trim()) return;
    const rid = uid(); await save('run', rid, { jobId: id, circuitRef: r.ref.trim(), cableType: 'T&E (6242Y)', sizeMm2: '2.5', notes: '', planPoints: [], waypoints: [], expectedLengthM: null, loopMilliohm: null, plugId: null, createdAt: Date.now() });
    location.hash = `#/run/${rid}`;
  };
}

async function newDrawing(jobId, name, up) {
  const id = uid();
  await save('drawing', id, { jobId, name, file: up.name, imgW: up.width, imgH: up.height, pxPerM: 0, calib: null, check: null, ceilingM: 2.4, wallThicknessM: 0.1,
    walls: [], openings: [], marker: null, routes: [], createdAt: Date.now() });
  location.hash = `#/drawing/${id}`;
}

// ---------------- drawing editor ----------------
function viewDrawing(id) {
  const stored = get('drawing', id); if (!stored) { location.hash = '#/'; return; }
  const d = structuredClone(stored); delete d.id; d.routes ||= []; d.walls ||= []; d.openings ||= [];
  const job = get('job', d.jobId);
  let tab = sessionStorage.getItem('ct_tab') || 'trace', tracer = null, model = null, selRoute = null;
  const runs = list('run').filter((r) => r.jobId === d.jobId);
  const showRuns = new Set();
  const asBuiltRuns = runs.filter((r) => r.marker && r.drawingId === id && (r.waypoints || []).length >= 2);
  const applyAsBuilt = () => {
    if (!model) return;
    model.asBuilt = [...showRuns].map((rid) => { const r = runs.find((x) => x.id === rid); const pts = r && asBuiltPoints(r.waypoints, r.marker, d); return pts ? { name: r.circuitRef, points: pts } : null; }).filter(Boolean);
    model.buildRoutes();
  };

  main.innerHTML = `<div class="row"><a href="${job ? '#/job/' + d.jobId : '#/'}">‹ ${esc(job?.name || 'Jobs')}</a><h2 style="margin:0">${esc(d.name)}</h2>
    <span style="flex:1"></span><span id="saved" class="dim"></span><button data-tab="trace">1. Trace drawing</button><button data-tab="model">2. 3D model & routes</button><button class="danger" id="del">Delete</button></div>
    <div id="body"></div>`;
  const changed = () => { $('#saved').textContent = 'Saving…'; autosave('drawing', id, d, () => { $('#saved').textContent = 'Saved'; }); side(); model?.build(); model?.buildRoutes(); };

  function show(t) {
    tab = t; sessionStorage.setItem('ct_tab', t);
    tracer?.destroy(); tracer = null; model?.destroy(); model = null;
    main.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $('#body').innerHTML = `<div class="editor" style="margin-top:10px"><div><div class="tools" id="tools"></div><div class="stage" id="stage"></div><div class="hint" id="hint"></div></div><div class="card side" id="side" style="margin:0"></div></div>`;
    if (t === 'trace') {
      const tools = [['pan', 'Pan'], ['calib', 'Set scale'], ['ratio', 'Scale ratio'], ['check', 'Check scale'], ['measure', 'Measure'], ['wall', 'Walls'], ['opening', 'Door / window'], ['marker', 'Marker'], ['erase', 'Erase']];
      $('#tools').innerHTML = tools.map(([k, l]) => `<button data-tool="${k}">${l}</button>`).join('') +
        '<span class="zoom"><button data-zoom="out" title="Zoom out">−</button><button data-zoom="in" title="Zoom in">+</button><button data-zoom="fit" title="Fit the drawing">Fit</button></span>';
      tracer = new Tracer($('#stage'), d, { onChange: changed, ask });
      const pick = (k) => { tracer.setTool(k); $('#tools').querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === k)); hint(k); };
      $('#tools').onclick = (e) => {
        const z = e.target.dataset.zoom;
        if (z) { z === 'fit' ? (tracer.fit(), tracer.draw()) : tracer.zoomBy(z === 'in' ? 1.4 : 1 / 1.4); return; }
        if (e.target.dataset.tool) pick(e.target.dataset.tool);
      };
      pick(d.pxPerM ? 'wall' : 'calib');
    } else {
      $('#tools').innerHTML = `<button id="planv">Plan view</button><button id="iso">Reset view</button><span class="zoom"><button id="zo" title="Zoom out">−</button><button id="zi" title="Zoom in">+</button></span>`;
      model = new Model3D($('#stage'), d, { onChange: changed });
      model.selected = selRoute; applyAsBuilt();
      $('#zi').onclick = () => model.zoomBy(1 / 1.4); $('#zo').onclick = () => model.zoomBy(1.4);
      $('#planv').onclick = () => model.plan(); $('#iso').onclick = () => model.frameAll();
      $('#hint').textContent = d.pxPerM ? 'Pick a route, then click walls, the floor or the ceiling to add points. Drag to orbit, wheel or pinch to zoom, right-drag or two fingers to pan.' : 'Set the scale on the Trace tab first.';
    }
    side();
  }
  function hint(k) {
    $('#hint').textContent = {
      pan: 'Drag to move, wheel or pinch to zoom, or use the + / − buttons.', calib: 'Tap both ends of a printed dimension, then type its real length. This sets the scale for everything.',
      ratio: 'Use when the drawing says a scale such as 1:24 or 1/4" = 1\'. Tap two ends of something you can measure on the paper (or both ends of the sheet edge), then choose the scale.',
      measure: 'Tap two points to read the distance in the current unit (m / ft).',
      check: 'Tap both ends of a SECOND printed dimension to check the scale. A big error means a skewed photo or a reduced print.',
      wall: 'Tap corners to trace walls (snaps to corners and square angles). Press Enter to type an exact length, Esc or double-click to stop, hold Alt to ignore snapping.',
      opening: 'Tap a wall where the door or window is.', marker: 'Tap the wall where the printed marker will be stuck (it faces the side you tap).', erase: 'Tap a wall, opening or the marker to delete it.' }[k] || '';
  }

  function side() {
    const el = $('#side'); if (!el) return;
    if (tab === 'trace') {
      const chk = d.check; const bad = chk && chk.errPct != null && Math.abs(chk.errPct) > 3;
      el.innerHTML = `<h3 style="margin-top:0">Drawing</h3>
        <div>${d.pxPerM ? `Scale set${d.scaleRatio ? `: drawn at <b>1:${d.scaleRatio}</b>` : ''} · image is ${fmt(d.imgW / d.pxPerM, 1)} wide` : '<span class="warn">Scale not set</span>'}</div>
        ${chk && chk.errPct != null ? `<div class="${bad ? 'warn' : 'ok'}">Check dimension: ${chk.errPct >= 0 ? '+' : ''}${chk.errPct.toFixed(1)}% ${bad ? '— photo is skewed or the print was reduced. Retake it flat-on.' : '— good'}</div>` : '<div class="dim">No second dimension checked yet.</div>'}
        <label>Ceiling height (${getUnit()})</label><input id="ceil" value="${num(d.ceilingM, 2)}">
        <label>Wall thickness (${getUnit()})</label><input id="thick" value="${num(d.wallThicknessM, 3)}">
        <label>Level name</label><input id="lvl" value="${esc(d.name)}">
        <p class="dim">${d.walls.length} walls · ${d.openings.length} openings · marker ${d.marker ? 'placed' : 'not placed'}</p>
        <p class="hint">Photograph the drawing flat-on and well lit. Use the Check scale tool on a second dimension — it catches a crooked photo.</p>
        <p><a href="/marker.html" target="_blank">Print the marker sheet</a><br><span class="hint">Stick it where you placed the marker. The phone uses it to line routes up with the building.</span></p>`;
      $('#ceil').onchange = (e) => { const v = parseLen(e.target.value); d.ceilingM = v > 0 ? v : 2.4; changed(); };
      $('#thick').onchange = (e) => { const v = parseLen(e.target.value); d.wallThicknessM = v > 0 ? v : 0.1; changed(); };
      $('#lvl').onchange = (e) => { d.name = e.target.value; changed(); };
      return;
    }
    const sel = d.routes.find((r) => r.id === selRoute);
    el.innerHTML = `<div class="row"><h3 style="margin:0;flex:1">Routes</h3><button id="nr" class="primary">New route</button></div>
      <div style="margin:8px 0">${d.routes.map((r) => `<div class="row" style="margin:4px 0"><button data-sel="${r.id}" class="${r.id === selRoute ? 'on' : ''}" style="flex:1;text-align:left">
        <span style="color:#${(ROUTE_KINDS[r.kind] || ROUTE_KINDS.cable).color.toString(16).padStart(6, '0')}">●</span> ${esc(r.name)} · ${fmt(polyLength(r.points), 1)}</button></div>`).join('') || '<p class="dim">No routes yet.</p>'}</div>
      ${asBuiltRuns.length ? `<h4 style="margin:12px 0 4px">As built (recorded on site)</h4>${asBuiltRuns.map((r) => `<label style="display:flex;gap:6px;align-items:center;color:var(--text);font-size:14px"><input type="checkbox" data-ab="${r.id}" ${showRuns.has(r.id) ? 'checked' : ''}> <span style="color:#00e5b0">●</span> ${esc(r.circuitRef)} · ${fmt(wpLength(r.waypoints), 1)}</label>`).join('')}` : ''}
      <label>Fixed height for new points (${getUnit()}) — leave blank to click on surfaces</label><input id="hov" placeholder="e.g. ${num(2.4, 1)} for tray" style="width:100%">
      ${sel ? routePanel(sel) : ''}`;
    $('#nr').onclick = async () => {
      const r = await ask('New route', [{ name: 'name', label: 'Name (e.g. Kitchen ring)' }, { name: 'kind', label: 'Type', type: 'select', options: Object.keys(ROUTE_KINDS), value: 'cable' }]);
      if (!r || !r.name.trim()) return; const rid = uid().slice(0, 8);
      d.routes.push({ id: rid, name: r.name.trim(), kind: r.kind, points: [], runId: null }); selRoute = rid; model.selected = rid; model.drawing_route = rid; changed();
    };
    el.querySelectorAll('[data-sel]').forEach((b) => b.onclick = () => { selRoute = b.dataset.sel; model.select(selRoute); model.drawing_route = selRoute; side(); });
    $('#hov').oninput = (e) => { const v = parseLen(e.target.value); model.heightOverride = e.target.value.trim() && v >= 0 ? String(v) : ''; el.dataset.hov = e.target.value; };
    if (model) $('#hov').value = el.dataset.hov || '';
    el.querySelectorAll('[data-ab]').forEach((c) => c.onchange = () => { c.checked ? showRuns.add(c.dataset.ab) : showRuns.delete(c.dataset.ab); applyAsBuilt(); });
    if (sel) wireRoute(el, sel);
  }

  function routePanel(r) {
    const run = r.runId ? runs.find((x) => x.id === r.runId) : null, len = polyLength(r.points);
    const cmp = run ? (() => { const rec = wpLength(run.waypoints || []); return `<div class="hint">Recorded on site: ${rec ? fmt(rec, 1) : 'not recorded'}${run.expectedLengthM ? ` · cable length ${fmt(Number(run.expectedLengthM), 1)}` : ''}</div>`; })() : '';
    return `<div class="card" style="margin:10px 0 0"><div class="row"><b style="flex:1">${esc(r.name)}</b><button class="danger" id="dr">Delete</button></div>
      <div>Planned length: <b>${fmt(len, 2)}</b> (${r.points.length} points)</div>
      <label>Linked cable run</label><select id="lr"><option value="">— none —</option>${runs.map((x) => `<option value="${x.id}" ${x.id === r.runId ? 'selected' : ''}>${esc(x.circuitRef)}</option>`).join('')}</select>${cmp}
      <label>Points (${getUnit()}): x, height, z</label>
      <table>${r.points.map((p, i) => `<tr><td>${i + 1}</td>${[0, 1, 2].map((k) => `<td><input class="n" data-p="${i}" data-k="${k}" value="${num(p[k], 3)}"></td>`).join('')}
        <td><button data-drop="${i}" title="Add a point straight down to 0.3 m">↓</button> <button data-rm="${i}" class="danger">✕</button></td></tr>`).join('')}</table></div>`;
  }
  function wireRoute(el, r) {
    $('#dr').onclick = () => { if (!confirm('Delete this route?')) return; d.routes = d.routes.filter((x) => x.id !== r.id); selRoute = null; model.selected = null; model.drawing_route = null; changed(); };
    $('#lr').onchange = (e) => { r.runId = e.target.value || null; changed(); };
    el.querySelectorAll('[data-p]').forEach((i) => i.onchange = () => { const v = parseLen(i.value); r.points[+i.dataset.p][+i.dataset.k] = Number.isNaN(v) ? 0 : v; changed(); });
    el.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { r.points.splice(+b.dataset.rm, 1); changed(); });
    el.querySelectorAll('[data-drop]').forEach((b) => b.onclick = () => { const p = r.points[+b.dataset.drop]; r.points.splice(+b.dataset.drop + 1, 0, [p[0], 0.3, p[2]]); changed(); });
  }

  main.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => show(b.dataset.tab));
  $('#del').onclick = async () => { if (confirm('Delete this drawing?')) { await remove('drawing', id); location.hash = `#/job/${d.jobId}`; } };
  cleanup = () => { tracer?.destroy(); model?.destroy(); };
  show(tab);
}

// ---------------- run editor ----------------
function viewRun(id) {
  const stored = get('run', id); if (!stored) { location.hash = '#/'; return; }
  const r = structuredClone(stored); delete r.id; r.waypoints ||= [];
  const job = get('job', r.jobId);
  const KINDS = ['start', 'clip', 'corner', 'penetration', 'joint', 'reference', 'end'];
  const TYPES = ['T&E (6242Y)', 'SWA', 'FP200', 'Flex', 'Singles in conduit', 'Cat5e/Cat6', 'Coax', 'Other'];
  const SIZES = ['1.0', '1.5', '2.5', '4', '6', '10', '16', '25'];
  const render = () => {
    const rec = wpLength(r.waypoints), v = checkLength(rec, r.expectedLengthM);
    main.innerHTML = `<div class="row"><a href="#/job/${r.jobId}">‹ ${esc(job?.name || 'Job')}</a><h2 style="margin:0">${esc(r.circuitRef)}</h2><span style="flex:1"></span><span id="saved" class="dim"></span><button class="danger" id="del">Delete</button></div>
      <div class="editor" style="margin-top:10px"><div>
        <div class="card"><h3 style="margin-top:0">Details</h3><div class="row">
          <div><label>Circuit reference</label><input id="ref" value="${esc(r.circuitRef)}"></div>
          <div><label>Cable type</label><select id="type">${TYPES.map((t) => `<option ${t === r.cableType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
          <div><label>Size (mm²)</label><select id="size">${SIZES.map((t) => `<option ${t === String(r.sizeMm2) ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
          <label>Notes</label><textarea id="notes" rows="2" style="width:100%">${esc(r.notes)}</textarea></div>
        <div class="card"><h3 style="margin-top:0">Length check <span class="dim" style="font-size:12px">(dead circuits only)</span></h3>
          <div class="hint">Loop resistance: circuit isolated, proved dead, far end shorted. Never connect a transmitter or terminator to a live circuit.</div>
          <div class="row"><div><label>Loop resistance (Ω)</label><input id="loop" type="number" step="0.001" value="${r.loopMilliohm != null ? r.loopMilliohm / 1000 : ''}"></div>
            <button id="tolen" style="align-self:flex-end">→ length</button>
            <div><label>Actual cable length (${getUnit()})</label><input id="len" value="${r.expectedLengthM != null ? num(r.expectedLengthM, 2) : ''}"></div>
            <div><label>Plug circuit no.</label><input id="plug" type="number" value="${r.plugId ?? ''}" style="width:90px"></div></div>
          <div class="${v.warn ? 'banner' : 'dim'}" style="margin-top:10px">${esc(r.waypoints.length >= 2 ? v.message : 'Record the run on site to compare lengths.')}</div>
          <div class="row" style="margin-top:8px"><div><label>Distance along cable to a fault or break (${getUnit()})</label><input id="brk"></div><button id="loc" style="align-self:flex-end">Locate</button><span id="locmsg"></span></div></div>
        <div class="card"><h3 style="margin-top:0">Recorded points</h3>
          ${r.waypoints.length ? `<table><tr><th>#</th><th>Kind</th><th>Depth mm</th><th>Note</th><th>Photo</th><th></th></tr>${r.waypoints.map((w, i) => `<tr><td>${i + 1}</td>
            <td><select data-w="${i}" data-f="kind">${KINDS.map((k) => `<option ${k === w.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></td>
            <td><input class="n" type="number" data-w="${i}" data-f="depthMm" value="${w.depthMm ?? ''}"></td>
            <td><input data-w="${i}" data-f="note" value="${esc(w.note)}"></td>
            <td>${w.photoFile ? `<a href="${fileUrl(w.photoFile)}" target="_blank"><img class="thumb" src="${fileUrl(w.photoFile)}"></a>` : ''}</td>
            <td><button data-rm="${i}" class="danger">✕</button></td></tr>`).join('')}</table>
          <p class="dim">${r.waypoints.length} points · ${fmt(rec, 1)} (AR estimate, ±10%)</p>` : '<p class="dim">Nothing recorded yet. Record the run in the phone app and it appears here after sync.</p>'}</div></div>
        <div class="card side" style="margin:0"><h3 style="margin-top:0">Route (top view)</h3><canvas id="plot" width="280" height="280" style="width:100%;background:#000;border-radius:8px"></canvas>
          <p class="hint">Plan view of the recorded points in the phone's AR frame. Shape only — not to a drawing.</p></div></div>`;
    wire(); plot();
  };
  const changed = () => { $('#saved').textContent = 'Saving…'; autosave('run', id, r, () => { $('#saved').textContent = 'Saved'; }); };
  function wire() {
    $('#ref').onchange = (e) => { r.circuitRef = e.target.value; changed(); };
    $('#type').onchange = (e) => { r.cableType = e.target.value; changed(); };
    $('#size').onchange = (e) => { r.sizeMm2 = e.target.value; changed(); };
    $('#notes').onchange = (e) => { r.notes = e.target.value; changed(); };
    $('#loop').onchange = (e) => { r.loopMilliohm = e.target.value === '' ? null : Math.round(Number(e.target.value) * 1000); changed(); };
    $('#len').onchange = (e) => { const v = parseLen(e.target.value); r.expectedLengthM = e.target.value.trim() === '' || !(v > 0) ? null : v; changed(); render(); };
    $('#plug').onchange = (e) => { r.plugId = e.target.value === '' ? null : Number(e.target.value); changed(); };
    $('#tolen').onclick = () => {
      const size = Number(r.sizeMm2), l = lengthFromLoop((r.loopMilliohm || 0) / 1000, size, defaultReturnSize(r.cableType, size));
      if (!l) { alert('Enter the loop resistance in ohms first.'); return; } r.expectedLengthM = Math.round(l * 10) / 10; changed(); render();
    };
    $('#loc').onclick = () => { const dm = parseLen($('#brk').value); const p = positionAlong(r.waypoints, dm); $('#locmsg').textContent = p ? `${fmt(dm, 1)} from the start is ${p}.` : 'Enter a distance and record the run first.'; };
    main.querySelectorAll('[data-w]').forEach((el) => el.onchange = () => {
      const w = r.waypoints[+el.dataset.w], f = el.dataset.f;
      w[f] = f === 'depthMm' ? (el.value === '' ? null : Number(el.value)) : el.value; changed();
    });
    main.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { r.waypoints.splice(+b.dataset.rm, 1); r.waypoints.forEach((w, i) => (w.seq = i)); changed(); render(); });
    $('#del').onclick = async () => { if (confirm('Delete this run?')) { await remove('run', id); location.hash = `#/job/${r.jobId}`; } };
  }
  function plot() {
    const c = $('#plot'), g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
    const w = r.waypoints; if (w.length < 1) return;
    const xs = w.map((p) => p.x), zs = w.map((p) => p.z), minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const span = Math.max(maxX - minX, maxZ - minZ, 0.5), s = (c.width - 40) / span;
    const P = (p) => [20 + (p.x - minX) * s, 20 + (p.z - minZ) * s];
    g.strokeStyle = '#ffc400'; g.lineWidth = 2; g.beginPath(); w.forEach((p, i) => { const q = P(p); i ? g.lineTo(...q) : g.moveTo(...q); }); g.stroke();
    w.forEach((p, i) => { const q = P(p); g.fillStyle = i === 0 ? '#6fcf7a' : '#ffc400'; g.beginPath(); g.arc(q[0], q[1], 4, 0, 7); g.fill(); g.fillStyle = '#fff'; g.font = '10px sans-serif'; g.fillText(i + 1, q[0] + 6, q[1] - 6); });
  }
  render();
}

// ---------------- router ----------------
function route() {
  cleanup?.(); cleanup = null; flush();
  $('#logout').hidden = !state.token; $('#who').hidden = !state.token; if (state.user) $('#who').textContent = state.user.name + ' · ' + state.user.team.name;
  if (!state.token) return viewLogin();
  const [, kind, id] = location.hash.split('/');
  try { if (kind === 'team') viewTeam().catch((e) => { main.innerHTML = `<div class="banner">${esc(e.message)}</div>`; }); else if (kind === 'job') viewJob(id); else if (kind === 'drawing') viewDrawing(id); else if (kind === 'run') viewRun(id); else viewJobs(); }
  catch (e) { main.innerHTML = `<div class="banner">Something went wrong: ${esc(e.message)}</div>`; console.error(e); }
}
$('#logout').onclick = async () => { await logout(); route(); };
const unitBtn = $('#unit');
const showUnit = () => { unitBtn.textContent = getUnit() === 'ft' ? 'ft' : 'm'; unitBtn.title = 'Switch between metres and feet'; };
unitBtn.onclick = () => { toggleUnit(); showUnit(); route(); };
showUnit();
window.addEventListener('hashchange', route);

// Re-render list views when the phone syncs new data; leave editors alone.
subscribe(() => {
  $('#status').textContent = state.token ? (state.online ? 'Online' : 'Offline') : '';
  const kind = location.hash.split('/')[1];
  if (state.token && (!kind || kind === 'job') && !dlg.open) route();
});

(async () => {
  if (state.token) { try { await loadMe(); await pull(); } catch (e) { if (e.status === 401) { await logout(); } } }
  route();
})();
