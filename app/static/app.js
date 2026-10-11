import { GraphCanvas, colors } from './graph.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const uuid = () => crypto.randomUUID();
const state = { graphs: [], graph: null, saved: null, dirty: false, busy: false, editedNode: null, editedEdge: null, selection: null, search: null };
const canvas = new GraphCanvas($('graph-canvas'), (kind, id) => { state.selection = { kind, id }; renderInspector(); });
const draftKey = id => `graph-studio:draft:${id}`;
let noticeTimer;

function notify(message, error = false, persistent = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').className = error ? 'error' : '';
  $('notice').hidden = false;
  if (!persistent) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 14000 : 6000);
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) {
    const detail = Array.isArray(body.detail) ? body.detail.map(item => item.msg).join(' ') : body.detail;
    throw new Error(detail || `Request failed (${response.status}).`);
  }
  return body;
}

async function busy(action) {
  if (state.busy) return;
  state.busy = true;
  $('workspace-fields').disabled = true;
  $('sidebar-fields').disabled = true;
  try { await action(); }
  catch (error) { notify(error.message, true); }
  finally {
    state.busy = false;
    $('workspace-fields').disabled = false;
    $('sidebar-fields').disabled = false;
    renderStatus();
  }
}

function payload(graph) {
  const { name, revision, node_types, relationship_types, nodes, edges } = graph;
  return { name, revision, node_types, relationship_types, nodes, edges };
}

function readDraft(id) {
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey(id)) || 'null');
    if (draft?.id === id && ['node_types', 'relationship_types', 'nodes', 'edges'].every(key => Array.isArray(draft[key]))) return draft;
  } catch { /* An invalid or unavailable browser draft never replaces saved data. */ }
  return null;
}

function removeDraft(id) {
  try { localStorage.removeItem(draftKey(id)); } catch { /* Server persistence is independent. */ }
}

function changed() {
  state.dirty = true;
  state.search = null;
  try { localStorage.setItem(draftKey(state.graph.id), JSON.stringify(state.graph)); }
  catch { notify('Browser draft storage is unavailable or full. Click Save changes to preserve your edits.', true, true); }
  render();
}

function setOptions(id, items, empty = 'Choose…') {
  const element = $(id), previous = element.value;
  element.replaceChildren(new Option(empty, ''), ...items.map(item => new Option(item.label ?? item.name, item.id)));
  if (items.some(item => item.id === previous)) element.value = previous;
  else if (items.length === 1 && !['search-type', 'edit-edge'].includes(id)) element.value = items[0].id;
}

function nodeLabel(node) { return `${node.name} — ${node.id}`; }
function nodeOptions(id, nodes) { $(id).replaceChildren(...nodes.map(node => new Option(nodeLabel(node), nodeLabel(node)))); }
function nodeTypeName(id, graph = state.graph) { return graph.node_types.find(type => type.id === id)?.name || 'Unknown type'; }
function relType(id, graph = state.graph) { return graph.relationship_types.find(type => type.id === id); }
function nodeById(id, graph = state.graph) { return graph.nodes.find(node => node.id === id); }

function resolveNode(value, allowed = state.graph.nodes) {
  const normalized = value.trim().toLowerCase();
  const exact = allowed.find(node => node.id.toLowerCase() === normalized || nodeLabel(node).toLowerCase() === normalized);
  if (exact) return exact;
  const names = allowed.filter(node => node.name.toLowerCase() === normalized);
  if (names.length === 1) return names[0];
  if (names.length > 1) throw new Error('Several nodes have that name. Choose a full name + UUID option or paste the UUID.');
  throw new Error('Choose an existing node by name or UUID. The node must match the relationship’s allowed type.');
}

function renderSidebar() {
  $('graph-count').textContent = state.graphs.length;
  $('graph-list').innerHTML = state.graphs.map(graph => `<button class="graph-link ${state.graph?.id === graph.id ? 'active' : ''}" data-graph="${graph.id}" ${state.graph?.id === graph.id ? 'aria-current="page"' : ''}><span>◇</span><span class="graph-name">${escape(state.graph?.id === graph.id ? state.graph.name : graph.name)}</span>${readDraft(graph.id) ? '<span class="draft-dot" title="Browser draft">•</span>' : ''}</button>`).join('');
}

function renderStatus() {
  $('save-status').textContent = state.dirty ? '● Unsaved changes' : '✓ All changes saved';
  $('save-status').className = `status-pill ${state.dirty ? 'dirty' : ''}`;
  $('save').disabled = !state.dirty;
  $('search-draft-warning').hidden = !state.dirty;
}

function renderMapping() {
  const type = relType($('mapping-type').value);
  nodeOptions('from-options', state.graph.nodes.filter(node => node.type_id === type?.from_type_id));
  nodeOptions('to-options', state.graph.nodes.filter(node => node.type_id === type?.to_type_id));
  $('mapping-hint').textContent = type ? `${nodeTypeName(type.from_type_id)} → ${nodeTypeName(type.to_type_id)} · Search either field by name or UUID.` : 'Create a relationship definition to get started.';
  $('mapping-submit').textContent = state.editedEdge ? 'Update relationship' : '＋ Connect nodes';
  $('mapping-cancel').hidden = !state.editedEdge;
}

function render() {
  renderSidebar();
  $('welcome').hidden = Boolean(state.graph);
  $('workspace-fields').hidden = !state.graph;
  if (!state.graph) { $('breadcrumb').textContent = 'Getting started'; return; }
  const g = state.graph;
  $('graph-title').textContent = g.name;
  $('breadcrumb').textContent = g.name;
  $('graph-name').value = g.name;
  $('graph-summary').textContent = `${g.nodes.length} nodes · ${g.edges.length} connections`;
  renderStatus();
  $('node-types').innerHTML = g.node_types.map((type, i) => `<span class="chip"><span class="legend-dot" style="background:${colors[i % colors.length]}"></span>${escape(type.name)}<button data-action="rename-type" data-id="${type.id}" aria-label="Rename ${escape(type.name)}">✎</button><button data-action="delete-type" data-id="${type.id}" aria-label="Delete ${escape(type.name)}">×</button></span>`).join('');
  $('rel-types').innerHTML = g.relationship_types.map(type => `<div class="definition"><div><strong>${escape(type.name)}</strong><small>${escape(nodeTypeName(type.from_type_id))} → ${escape(nodeTypeName(type.to_type_id))}</small></div><div class="definition-actions"><button data-action="edit-rel-type" data-id="${type.id}" aria-label="Edit ${escape(type.name)}">Edit</button><button data-action="delete-rel-type" data-id="${type.id}" aria-label="Delete ${escape(type.name)}">×</button></div></div>`).join('');
  for (const id of ['rel-from', 'rel-to', 'node-type', 'edit-node-type']) setOptions(id, g.node_types, 'Select node type');
  setOptions('mapping-type', g.relationship_types.map(type => ({ ...type, label: `${type.name} (${nodeTypeName(type.from_type_id)} → ${nodeTypeName(type.to_type_id)})` })), 'Select relationship');
  renderMapping();
  nodeOptions('all-node-options', g.nodes);
  setOptions('edit-edge', g.edges.map(edge => ({ id: edge.id, label: `${nodeById(edge.source_id)?.name} → ${relType(edge.type_id)?.name} → ${nodeById(edge.target_id)?.name} · ${edge.id}` })), 'Select relationship to edit');
  $('delete-edge').disabled = !g.edges.length;
  $('load-edge').disabled = !g.edges.length;
  $('node-editor').hidden = !g.nodes.some(node => node.id === state.editedNode);
  if (state.editedNode && !nodeById(state.editedNode)) state.editedNode = null;
  if (state.editedNode) $('edit-node-type').value = nodeById(state.editedNode).type_id;
  $('canvas-empty').hidden = Boolean(g.nodes.length);
  $('legend').innerHTML = g.node_types.map((type, i) => `<span><i class="legend-dot" style="background:${colors[i % colors.length]}"></i>${escape(type.name)}</span>`).join('');
  canvas.setGraph(g);
  renderInspector();
  setOptions('search-type', state.saved.node_types, 'All node types');
  if (!state.search) {
    $('search-results').replaceChildren();
    $('search-status').textContent = 'Your next discovery starts with a question. Search uses saved graph data.';
  }
}

function renderInspector() {
  const container = $('inspector-content');
  container.replaceChildren();
  container.className = '';
  const selected = state.selection;
  if (selected?.kind === 'node') {
    const node = nodeById(selected.id);
    if (node) {
      const count = state.graph.edges.filter(edge => [edge.source_id, edge.target_id].includes(node.id)).length;
      container.innerHTML = `<h3>${escape(node.name)}</h3><span class="chip">${escape(nodeTypeName(node.type_id))}</span><div class="uuid-box">${node.id}</div><p class="description">${escape(node.description || 'No description yet.')}</p><p class="hint">${count} connected relationship${count === 1 ? '' : 's'}</p><div class="button-row space-top"><button class="subtle" data-action="inspect-edit-node" data-id="${node.id}">Edit node</button><button class="subtle" data-action="copy-uuid" data-id="${node.id}">Copy UUID</button></div>`;
      return;
    }
  } else if (selected?.kind === 'edge') {
    const edge = state.graph.edges.find(item => item.id === selected.id);
    if (edge) {
      container.innerHTML = `<h3>${escape(relType(edge.type_id)?.name)}</h3><p class="description">${escape(nodeById(edge.source_id)?.name)} → ${escape(nodeById(edge.target_id)?.name)}</p><div class="uuid-box">${edge.id}</div><button class="subtle space-top" data-action="inspect-edit-edge" data-id="${edge.id}">Edit relationship</button>`;
      return;
    }
  }
  container.className = 'muted';
  container.textContent = 'Nothing selected yet. Click a node or relationship to explore it.';
}

async function refreshGraphs() { state.graphs = await api('/graphs'); }

async function openGraph(id, useDraft = true) {
  const saved = await api(`/graphs/${id}`);
  const draft = useDraft && readDraft(id);
  state.saved = saved;
  state.graph = draft || structuredClone(saved);
  state.dirty = Boolean(draft);
  state.editedNode = state.editedEdge = state.selection = state.search = null;
  resetRelTypeForm();
  $('edit-node-lookup').value = $('canvas-find').value = '';
  canvas.highlight('');
  for (const id of ['node-type-form', 'rel-type-form', 'node-form', 'mapping-form', 'edit-node-form']) $(id).reset();
  try { localStorage.setItem('graph-studio:last-graph', saved.id); } catch { /* Optional preference. */ }
  render();
  if (draft) notify(draft.revision !== saved.revision ? 'This browser draft is based on an older saved version. It is preserved, but cannot overwrite the newer version. Use Reload saved data to discard it.' : 'Your unsaved browser draft has been restored. Click Save changes to keep it in Kùzu.', draft.revision !== saved.revision, true);
}

function showGraphDialog() {
  if (state.busy) return;
  $('graph-form').reset(); $('dialog-error').textContent = '';
  $('graph-dialog').showModal(); $('new-graph-name').focus();
}
$('new-graph').onclick = $('first-graph').onclick = showGraphDialog;
$('cancel-graph').onclick = () => $('graph-dialog').close();
$('graph-form').onsubmit = async event => {
  event.preventDefault();
  if (state.busy) return;
  const button = event.submitter;
  button.disabled = true;
  await busy(async () => {
    try {
      const graph = await api('/graphs', { method: 'POST', body: JSON.stringify({ name: $('new-graph-name').value.trim() }) });
      $('graph-dialog').close();
      await refreshGraphs(); await openGraph(graph.id);
      switchTab('creation'); notify('Graph created. Start by adding a node type.');
    } catch (error) { $('dialog-error').textContent = error.message; }
  });
  button.disabled = false;
};

$('graph-list').onclick = event => {
  const button = event.target.closest('[data-graph]');
  if (button && button.dataset.graph !== state.graph?.id) busy(() => openGraph(button.dataset.graph));
};

$('save').onclick = () => busy(async () => {
  $('save').textContent = 'Saving…';
  try {
    const saved = await api(`/graphs/${state.graph.id}`, { method: 'PUT', body: JSON.stringify(payload(state.graph)) });
    state.graph = structuredClone(saved); state.saved = saved; state.dirty = false; state.search = null;
    removeDraft(saved.id);
    await refreshGraphs(); render();
    notify('Saved to Kùzu. Your graph will be here when you return.');
  } finally { $('save').textContent = 'Save changes'; }
});

$('reload').onclick = () => {
  if (state.dirty && !confirm('Discard this graph’s browser draft and load the last saved version?')) return;
  busy(async () => { const id = state.graph.id; await openGraph(id, false); removeDraft(id); await refreshGraphs(); render(); notify('Loaded the saved version.'); });
};
$('delete-graph').onclick = () => {
  if (!confirm(`Permanently delete “${state.graph.name}” and all its saved nodes, types, relationships, and browser draft?`)) return;
  busy(async () => {
    const id = state.graph.id;
    await api(`/graphs/${id}?revision=${state.saved.revision}`, { method: 'DELETE' });
    removeDraft(id); state.graph = state.saved = null; state.dirty = false;
    await refreshGraphs();
    if (state.graphs.length) await openGraph(state.graphs[0].id); else render();
    notify('Graph deleted.');
  });
};
$('graph-name').onchange = () => {
  const name = $('graph-name').value.trim();
  if (!name) { $('graph-name').value = state.graph.name; notify('Graph name cannot be empty.', true); return; }
  if (state.graphs.some(graph => graph.id !== state.graph.id && graph.name.toLowerCase() === name.toLowerCase())) {
    $('graph-name').value = state.graph.name; notify('Another graph already has this name.', true); return;
  }
  if (name !== state.graph.name) { state.graph.name = name; changed(); }
};

function switchTab(tab) {
  for (const name of ['creation', 'search']) {
    $(`${name}-page`).hidden = name !== tab;
    $(`${name}-tab`).classList.toggle('active', name === tab);
    $(`${name}-tab`).setAttribute('aria-selected', String(name === tab));
  }
  if (tab === 'creation') requestAnimationFrame(() => canvas.fit());
}
$('creation-tab').onclick = () => switchTab('creation');
$('search-tab').onclick = () => switchTab('search');
document.querySelector('.tabs').onkeydown = event => {
  if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    const tab = $('creation-page').hidden ? 'creation' : 'search'; switchTab(tab); $(`${tab}-tab`).focus();
  }
};

function onForm(id, handler) {
  $(id).onsubmit = event => {
    event.preventDefault();
    if (state.busy) return;
    try { handler(); } catch (error) { notify(error.message, true); }
  };
}

function uniqueName(name, collection, ignoreId = '') {
  if (!name.trim()) throw new Error('A name is required.');
  if (name.length > 120) throw new Error('Names may contain at most 120 characters.');
  if (collection.some(item => item.id !== ignoreId && item.name.toLowerCase() === name.toLowerCase())) throw new Error('That name already exists in this graph.');
}

onForm('node-type-form', () => {
  const name = $('type-name').value.trim(); uniqueName(name, state.graph.node_types);
  state.graph.node_types.push({ id: uuid(), name });
  $('type-name').value = ''; changed();
});

let editedRelType = null;
onForm('rel-type-form', () => {
  const name = $('rel-name').value.trim(), from = $('rel-from').value, to = $('rel-to').value;
  uniqueName(name, state.graph.relationship_types, editedRelType);
  if (!from || !to) throw new Error('Choose the source and target node types.');
  if (editedRelType) {
    if (state.graph.edges.some(edge => edge.type_id === editedRelType && (nodeById(edge.source_id).type_id !== from || nodeById(edge.target_id).type_id !== to))) throw new Error('Existing mappings use the current endpoint types. Update or delete those mappings before changing the definition’s endpoint types.');
    Object.assign(relType(editedRelType), { name, from_type_id: from, to_type_id: to });
  } else state.graph.relationship_types.push({ id: uuid(), name, from_type_id: from, to_type_id: to });
  resetRelTypeForm(); changed();
});

function resetRelTypeForm() {
  editedRelType = null; $('rel-name').value = '';
  $('rel-type-form').querySelector('button[type="submit"]').textContent = '＋ Add relationship definition';
  $('cancel-rel-type')?.remove();
}

onForm('node-form', () => {
  const name = $('node-name').value.trim(), type_id = $('node-type').value;
  if (!name || !type_id) throw new Error('Choose a node type and enter a name.');
  const node = { id: uuid(), type_id, name, description: $('node-description').value.trim() };
  state.graph.nodes.push(node); state.selection = { kind: 'node', id: node.id };
  $('node-name').value = $('node-description').value = '';
  changed(); canvas.select('node', node.id);
});

onForm('mapping-form', () => {
  const type = relType($('mapping-type').value);
  if (!type) throw new Error('Choose a relationship definition first.');
  const source = resolveNode($('mapping-from').value, state.graph.nodes.filter(node => node.type_id === type.from_type_id));
  const target = resolveNode($('mapping-to').value, state.graph.nodes.filter(node => node.type_id === type.to_type_id));
  if (state.graph.edges.some(edge => edge.id !== state.editedEdge && edge.type_id === type.id && edge.source_id === source.id && edge.target_id === target.id)) throw new Error('That relationship is already mapped between these nodes.');
  const data = { type_id: type.id, source_id: source.id, target_id: target.id };
  let edge;
  if (state.editedEdge) { edge = state.graph.edges.find(item => item.id === state.editedEdge); Object.assign(edge, data); }
  else { edge = { id: uuid(), ...data }; state.graph.edges.push(edge); }
  state.selection = { kind: 'edge', id: edge.id };
  cancelMapping(); changed(); canvas.select('edge', edge.id);
});
$('mapping-type').onchange = () => { $('mapping-from').value = $('mapping-to').value = ''; renderMapping(); };
function cancelMapping() { state.editedEdge = null; $('mapping-from').value = $('mapping-to').value = ''; renderMapping(); }
$('mapping-cancel').onclick = cancelMapping;

function loadNode(id) {
  const node = nodeById(id);
  if (!node) throw new Error('This node is not in the current draft. Reload saved data if it was removed.');
  state.editedNode = node.id;
  $('edit-node-lookup').value = nodeLabel(node);
  $('edit-node-id').textContent = node.id;
  $('edit-node-type').value = node.type_id;
  $('edit-node-name').value = node.name;
  $('edit-node-description').value = node.description;
  $('node-editor').hidden = false;
  canvas.select('node', node.id);
}
$('load-node').onclick = () => { try { loadNode(resolveNode($('edit-node-lookup').value).id); } catch (error) { notify(error.message, true); } };
onForm('edit-node-form', () => {
  const node = nodeById(state.editedNode);
  if (!node) throw new Error('Load a node first.');
  const name = $('edit-node-name').value.trim(), type_id = $('edit-node-type').value;
  if (!name || !type_id) throw new Error('Node name and type are required.');
  for (const edge of state.graph.edges) {
    const type = relType(edge.type_id);
    if ((edge.source_id === node.id && type.from_type_id !== type_id) || (edge.target_id === node.id && type.to_type_id !== type_id)) throw new Error('This type would invalidate an existing relationship. Update or delete those relationships first.');
  }
  Object.assign(node, { name, type_id, description: $('edit-node-description').value.trim() });
  $('edit-node-lookup').value = nodeLabel(node); changed(); notify('Node updated in the draft. Save changes to persist it.');
});
$('delete-node').onclick = () => {
  const node = nodeById(state.editedNode); if (!node) return;
  const edges = state.graph.edges.filter(edge => [edge.source_id, edge.target_id].includes(node.id));
  if (!confirm(`Delete “${node.name}” and its ${edges.length} connected relationship(s) from this draft?`)) return;
  state.graph.nodes = state.graph.nodes.filter(item => item.id !== node.id);
  state.graph.edges = state.graph.edges.filter(edge => ![edge.source_id, edge.target_id].includes(node.id));
  if (edges.some(edge => edge.id === state.editedEdge)) cancelMapping();
  state.editedNode = null; $('edit-node-lookup').value = ''; changed();
};

function loadEdge(id) {
  const edge = state.graph.edges.find(item => item.id === id);
  if (!edge) throw new Error('Select an existing relationship.');
  state.editedEdge = id;
  $('mapping-type').value = edge.type_id; renderMapping();
  $('mapping-from').value = nodeLabel(nodeById(edge.source_id));
  $('mapping-to').value = nodeLabel(nodeById(edge.target_id));
  canvas.select('edge', edge.id);
  $('mapping-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
$('load-edge').onclick = () => { try { loadEdge($('edit-edge').value); } catch (error) { notify(error.message, true); } };
$('delete-edge').onclick = () => {
  const id = $('edit-edge').value;
  if (!id) { notify('Select a relationship first.', true); return; }
  if (!confirm('Delete this relationship from the draft?')) return;
  state.graph.edges = state.graph.edges.filter(edge => edge.id !== id);
  if (state.editedEdge === id) cancelMapping(); changed();
};

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button || state.busy) return;
  const { action, id } = button.dataset;
  try {
    if (action === 'rename-type') {
      const type = state.graph.node_types.find(item => item.id === id), value = prompt('Node type name', type.name);
      if (value === null) return;
      const name = value.trim(); uniqueName(name, state.graph.node_types, id); type.name = name; changed();
    } else if (action === 'delete-type') {
      if (state.graph.nodes.some(node => node.type_id === id) || state.graph.relationship_types.some(type => [type.from_type_id, type.to_type_id].includes(id))) throw new Error('Delete nodes and relationship definitions that use this type first.');
      if (!confirm('Delete this node type from the draft?')) return;
      state.graph.node_types = state.graph.node_types.filter(type => type.id !== id); changed();
    } else if (action === 'edit-rel-type') {
      const type = relType(id); editedRelType = id;
      $('rel-name').value = type.name; $('rel-from').value = type.from_type_id; $('rel-to').value = type.to_type_id;
      $('rel-type-form').querySelector('button[type="submit"]').textContent = 'Update relationship definition';
      if (!$('cancel-rel-type')) {
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.id = 'cancel-rel-type'; cancel.className = 'subtle'; cancel.textContent = 'Cancel edit'; cancel.onclick = resetRelTypeForm;
        $('rel-type-form').append(cancel);
      }
      $('rel-type-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (action === 'delete-rel-type') {
      const count = state.graph.edges.filter(edge => edge.type_id === id).length;
      if (!confirm(`Delete this relationship definition and its ${count} mapping(s) from the draft?`)) return;
      if (state.graph.edges.some(edge => edge.id === state.editedEdge && edge.type_id === id)) cancelMapping();
      state.graph.edges = state.graph.edges.filter(edge => edge.type_id !== id);
      state.graph.relationship_types = state.graph.relationship_types.filter(type => type.id !== id);
      if (editedRelType === id) resetRelTypeForm(); changed();
    } else if (action === 'inspect-edit-node' || action === 'result-node') {
      switchTab('creation'); loadNode(id); $('edit-section').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (action === 'inspect-edit-edge') loadEdge(id);
    else if (action === 'copy-uuid') { await navigator.clipboard.writeText(id); notify('UUID copied.'); }
  } catch (error) { notify(error.message, true); }
});

$('canvas-find').oninput = () => canvas.highlight($('canvas-find').value);
$('fit').onclick = () => canvas.fit();
$('layout').onclick = () => canvas.layout();
$('zoom-in').onclick = () => canvas.zoom(1.25);
$('zoom-out').onclick = () => canvas.zoom(.8);

$('search-form').onsubmit = event => {
  event.preventDefault();
  busy(async () => {
    const mode = $('search-mode').value;
    $('search-submit').textContent = 'Searching…';
    $('search-results').replaceChildren();
    $('search-status').textContent = mode === 'keyword' ? 'Searching Kùzu…' : 'Preparing local embeddings and searching Kùzu… The first model download may take a few minutes.';
    try {
      const response = await api(`/graphs/${state.graph.id}/search`, { method: 'POST', body: JSON.stringify({ query: $('search-query').value.trim(), mode, limit: Number($('search-limit').value), node_type_id: $('search-type').value || null }) });
      state.search = response;
      const label = { semantic: 'cosine similarity', keyword: 'keyword relevance', hybrid: 'hybrid RRF score' }[mode];
      $('search-status').textContent = `${response.results.length} result${response.results.length === 1 ? '' : 's'} · Saved revision ${response.revision} · Ranked by ${label}${response.indexed_nodes ? ` · ${response.indexed_nodes} node embeddings refreshed` : ''}`;
      $('search-results').innerHTML = response.results.map(node => `<article class="card result"><div class="result-heading"><div><h3>${escape(node.name)}</h3><div class="type-label">${escape(node.type_name)}</div></div><span class="result-score" title="${label}">${node.score.toFixed(mode === 'hybrid' ? 4 : 3)}</span></div><div class="uuid-box">${node.id}</div><p>${escape(node.description || 'No description.')}</p><div class="result-connections"><strong>${node.connections.length} connection${node.connections.length === 1 ? '' : 's'}</strong>${node.connections.map(edge => `<div class="connection-row">${escape(edge.source_name)} <span class="chip">${escape(edge.relationship)}</span> → ${escape(edge.target_name)}</div>`).join('')}</div><button class="subtle" data-action="result-node" data-id="${node.id}">Open in creation →</button></article>`).join('');
      if (!response.results.length) $('search-results').innerHTML = '<div class="card muted">No nodes matched. Try a different query or node type, and make sure your graph is saved.</div>';
    } catch (error) {
      $('search-status').textContent = 'Search could not complete. Your saved graph is unchanged.'; throw error;
    } finally { $('search-submit').textContent = 'Search graph →'; }
  });
};

window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });

busy(async () => {
  await refreshGraphs();
  let last; try { last = localStorage.getItem('graph-studio:last-graph'); } catch { /* Optional preference. */ }
  const first = state.graphs.find(graph => graph.id === last) || state.graphs[0];
  if (first) await openGraph(first.id); else render();
});
