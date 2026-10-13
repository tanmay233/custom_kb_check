import { GraphCanvas, colors } from './graph.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const uuid = () => crypto.randomUUID();
const state = { graphs: [], graph: null, saved: null, dirty: false, busy: false, editedNode: null, editedEdge: null, selection: null, search: null };
const searchCopy = {
  vector: {
    queryLabel: 'What node name or idea are you looking for?',
    placeholder: 'e.g. renewable energy researchers',
    button: 'Search nodes →',
    idle: 'Vector search ranks saved nodes by their name embeddings.',
    progress: 'Searching node-name embeddings… The local BGE model may download on first use.',
    help: 'Vector search embeds node names using the configured local model (default: BAAI/bge-small-en-v1.5, 384 dimensions). The model downloads once if missing. Higher cosine similarity is better; distance = 1 − similarity, so lower distance is better.',
    score: 'cosine similarity',
  },
  semantic: {
    queryLabel: 'Which words should match a node name?',
    placeholder: 'e.g. solar scientist',
    button: 'Search nodes →',
    idle: 'Semantic search compares words and tokens in saved node names.',
    progress: 'Comparing words and tokens in saved node names…',
    help: 'Semantic here means word-to-word name matching, not embeddings. Matching ignores case and punctuation. A weighted Dice score (0–1) counts exact words fully and substring matches partially; higher is better. No model is needed.',
    score: 'name similarity score',
  },
  cypher: {
    queryLabel: 'Read-only Cypher query',
    placeholder: 'MATCH (n:Entity) RETURN n.id, n.name LIMIT 10',
    button: 'Run query →',
    idle: 'Run a read-only Cypher query against the saved graph.',
    progress: 'Running read-only Cypher query…',
    help: 'Read-only Cypher searches only the selected saved graph. Filter by node name, node UUID, or relationship name; results also include node descriptions. Up to 100 rows are shown. Unsupported queries and database errors appear below.',
  },
};
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
  let response;
  try { response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); }
  catch { throw new Error('Could not reach Graph Studio. Check that the server is running and retry.'); }
  if (response.status === 204) return null;
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch {
    if (response.ok) throw new Error('The server returned an invalid response. Please retry.');
    body = { detail: text || `Request failed (${response.status}).` };
  }
  if (!response.ok) {
    const detail = Array.isArray(body?.detail) ? body.detail.map(item => typeof item === 'object' ? item.msg : item).filter(Boolean).join(' ') : body?.detail;
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

function clearSearchError() {
  const error = $('search-error');
  error.textContent = '';
  error.hidden = true;
}

function showSearchError(message) {
  const error = $('search-error');
  error.textContent = message || 'The search could not be completed.';
  error.hidden = false;
}

function updateSearchMode() {
  const mode = $('search-mode').value;
  const copy = searchCopy[mode] || searchCopy.vector;
  const cypher = mode === 'cypher';
  $('search-query-label').textContent = copy.queryLabel;
  $('search-query').placeholder = copy.placeholder;
  $('search-query').rows = cypher ? 7 : 2;
  $('search-query').setAttribute('aria-label', copy.queryLabel);
  $('search-submit').textContent = copy.button;
  $('search-help').textContent = copy.help;
  $('search-type-field').hidden = cypher;
  $('search-limit-field').hidden = cypher;
  $('search-limit').required = !cypher;
  $('search-limit').disabled = cypher;
  $('search-cypher-help').hidden = !cypher;
  $('search-options').classList.toggle('cypher-mode', cypher);
  if (!state.search) $('search-status').textContent = copy.idle;
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
  updateSearchMode();
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
    clearSearchError();
    $('search-results').replaceChildren();
    $('search-results').classList.remove('cypher-results');
    $('search-status').textContent = searchCopy[$('search-mode').value]?.idle || 'Search uses saved graph data.';
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

function resultId(node) { return node?.id ?? node?.uuid ?? node?.node_id ?? ''; }
function resultName(node) { return node?.name ?? node?.node_name ?? node?.label ?? 'Unnamed node'; }
function scoreText(score, mode) {
  const value = Number(score);
  return Number.isFinite(value) ? value.toFixed(mode === 'vector' ? 4 : 3) : '—';
}

function showSearchMessage(message) {
  const container = $('search-results');
  container.classList.remove('cypher-results');
  container.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'card muted';
  empty.textContent = message;
  container.append(empty);
}

function renderNodeResults(response, mode) {
  const results = Array.isArray(response?.results) ? response.results : [];
  const container = $('search-results');
  container.classList.remove('cypher-results');
  container.replaceChildren();
  if (!results.length) {
    showSearchMessage('No nodes matched. Try a different name or node type, and make sure your graph is saved.');
    return;
  }

  const copy = searchCopy[mode] || searchCopy.vector;
  for (const node of results) {
    const article = document.createElement('article');
    article.className = 'card result';

    const heading = document.createElement('div');
    heading.className = 'result-heading';
    const title = document.createElement('div');
    const name = document.createElement('h3');
    name.textContent = resultName(node);
    title.append(name);
    if (node?.type_name || node?.type) {
      const type = document.createElement('div');
      type.className = 'type-label';
      type.textContent = node.type_name ?? node.type;
      title.append(type);
    }
    const score = document.createElement('span');
    score.className = 'result-score';
    score.title = copy.score;
    score.setAttribute('aria-label', `${copy.score}: ${scoreText(node?.score, mode)}`);
    score.textContent = scoreText(node?.score, mode);
    heading.append(title, score);
    article.append(heading);
    if (mode === 'vector' && Number.isFinite(node.distance)) {
      const distance = document.createElement('small');
      distance.className = 'result-distance hint';
      distance.textContent = `Cosine distance: ${node.distance.toFixed(4)}`;
      article.append(distance);
    }

    const identifier = document.createElement('div');
    identifier.className = 'uuid-box';
    identifier.textContent = resultId(node) || 'UUID unavailable';
    article.append(identifier);

    const description = document.createElement('p');
    description.textContent = node?.description || 'No description.';
    article.append(description);

    const connections = Array.isArray(node?.connections) ? node.connections : [];
    const connectionList = document.createElement('div');
    connectionList.className = 'result-connections';
    const connectionCount = document.createElement('strong');
    connectionCount.textContent = `${connections.length} connection${connections.length === 1 ? '' : 's'}`;
    connectionList.append(connectionCount);
    for (const edge of connections) {
      const row = document.createElement('div');
      row.className = 'connection-row';
      row.append(document.createTextNode(`${edge?.source_name ?? ''} `));
      const relationship = document.createElement('span');
      relationship.className = 'chip';
      relationship.textContent = edge?.relationship ?? 'relationship';
      row.append(relationship, document.createTextNode(` → ${edge?.target_name ?? ''}`));
      connectionList.append(row);
    }
    article.append(connectionList);

    const id = resultId(node);
    if (id) {
      const open = document.createElement('button');
      open.className = 'subtle';
      open.type = 'button';
      open.dataset.action = 'result-node';
      open.dataset.id = id;
      open.textContent = 'Open in creation →';
      article.append(open);
    }
    container.append(article);
  }
}

function cypherRows(response) {
  if (Array.isArray(response?.rows)) return response.rows;
  if (Array.isArray(response?.results)) return response.results;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

function cypherColumnName(column, index) {
  if (column && typeof column === 'object') return String(column.name ?? column.id ?? `Column ${index + 1}`);
  return String(column ?? `Column ${index + 1}`);
}

function cypherColumns(response, rows) {
  const declared = Array.isArray(response?.columns) ? response.columns : (Array.isArray(response?.fields) ? response.fields : []);
  if (declared.length) return declared.map(cypherColumnName);
  const objectRow = rows.find(row => row && typeof row === 'object' && !Array.isArray(row));
  if (objectRow) return Object.keys(objectRow);
  const width = rows.reduce((largest, row) => Math.max(largest, Array.isArray(row) ? row.length : 1), 0);
  return Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
}

function cellText(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return '[unserializable value]'; }
  }
  return String(value);
}

function responseError(response) {
  const value = response?.error ?? response?.detail ?? response?.errors;
  if (!value || (Array.isArray(value) && !value.length)) return '';
  return Array.isArray(value) ? value.map(cellText).join(' ') : cellText(value);
}

function renderCypherResults(response) {
  const allRows = cypherRows(response);
  const rows = allRows.slice(0, 100);
  const container = $('search-results');
  container.classList.add('cypher-results');
  container.replaceChildren();
  if (!allRows.length) {
    showSearchMessage('Cypher returned no rows.');
    return { shown: 0, total: 0 };
  }

  const columns = cypherColumns(response, allRows);
  const wrapper = document.createElement('div');
  wrapper.className = 'cypher-table-wrap card';
  const table = document.createElement('table');
  table.className = 'cypher-table';
  const caption = document.createElement('caption');
  caption.textContent = 'Cypher query results';
  table.append(caption);
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const column of columns) {
    const header = document.createElement('th');
    header.scope = 'col';
    header.textContent = column;
    headerRow.append(header);
  }
  head.append(headerRow);
  table.append(head);

  const body = document.createElement('tbody');
  for (const row of rows) {
    const tableRow = document.createElement('tr');
    const values = Array.isArray(row)
      ? row
      : columns.map(column => row && typeof row === 'object' ? row[column] : row);
    columns.forEach((_, index) => {
      const cell = document.createElement('td');
      cell.textContent = cellText(values[index]);
      tableRow.append(cell);
    });
    body.append(tableRow);
  }
  table.append(body);
  wrapper.append(table);
  container.append(wrapper);
  return { shown: rows.length, total: allRows.length };
}

$('search-mode').onchange = () => {
  state.search = null;
  $('search-results').replaceChildren();
  $('search-results').classList.remove('cypher-results');
  clearSearchError();
  updateSearchMode();
};

$('search-form').onsubmit = event => {
  event.preventDefault();
  busy(async () => {
    const mode = $('search-mode').value;
    const copy = searchCopy[mode] || searchCopy.vector;
    const query = $('search-query').value.trim();
    const limit = Number($('search-limit').value);
    const request = { query, mode, limit: mode === 'cypher' ? 100 : limit };
    if (mode !== 'cypher') request.node_type_id = $('search-type').value || null;
    state.search = null;
    clearSearchError();
    $('search-submit').textContent = 'Searching…';
    $('search-results').replaceChildren();
    $('search-results').classList.toggle('cypher-results', mode === 'cypher');
    $('search-status').textContent = copy.progress;
    try {
      if (!query) throw new Error('Enter a search query.');
      if (mode !== 'cypher' && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error('Choose a result limit from 1 to 100.');
      const response = await api(`/graphs/${state.graph.id}/search`, { method: 'POST', body: JSON.stringify(request) });
      const backendError = mode === 'cypher' ? responseError(response) : '';
      if (backendError) throw new Error(backendError);
      if (mode === 'cypher' ? !Array.isArray(response?.columns) || !Array.isArray(response?.rows) : !Array.isArray(response?.results)) throw new Error('The server returned invalid search results. Please retry.');
      state.search = { ...(response || {}), mode };
      if (mode === 'cypher') {
        const summary = renderCypherResults(response || {});
        const truncated = response.truncated ? ` · Output limited to ${response.row_limit} rows; refine the query to see other matches` : '';
        const revision = response?.revision === undefined ? '' : ` · Saved revision ${response.revision}`;
        $('search-status').textContent = `${summary.shown} row${summary.shown === 1 ? '' : 's'}${revision}${truncated}`;
      } else {
        const count = Array.isArray(response?.results) ? response.results.length : 0;
        renderNodeResults(response || {}, mode);
        const revision = response?.revision === undefined ? 'saved graph' : `saved revision ${response.revision}`;
        const indexed = response?.indexed_nodes ? ` · ${response.indexed_nodes} node embeddings refreshed` : '';
        $('search-status').textContent = `${count} result${count === 1 ? '' : 's'} · ${revision} · Ranked by ${copy.score}${indexed}`;
      }
    } catch (error) {
      $('search-status').textContent = mode === 'cypher' ? 'Cypher query failed. Your saved graph is unchanged.' : 'Search could not complete. Your saved graph is unchanged.';
      showSearchError(error.message);
      throw error;
    } finally { $('search-submit').textContent = copy.button; }
  });
};

window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });

busy(async () => {
  await refreshGraphs();
  let last; try { last = localStorage.getItem('graph-studio:last-graph'); } catch { /* Optional preference. */ }
  const first = state.graphs.find(graph => graph.id === last) || state.graphs[0];
  if (first) await openGraph(first.id); else render();
});
