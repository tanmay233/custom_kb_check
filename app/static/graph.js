const NS = 'http://www.w3.org/2000/svg';
export const colors = ['#54a88b', '#6d91c4', '#c99a54', '#a78bbb', '#cd8082', '#69a8b2', '#9ca757', '#b78866'];
function svgElement(tag, attributes = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

export class GraphCanvas {
  constructor(svg, onSelect) {
    this.svg = svg;
    this.onSelect = onSelect;
    this.positions = new Map();
    this.graph = { nodes: [], edges: [], node_types: [], relationship_types: [] };
    this.view = { x: 0, y: 0, scale: 1 };
    this.selection = null;
    this.filter = '';
    this.svg.addEventListener('wheel', event => {
      event.preventDefault();
      const point = this.localPoint(event);
      this.zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, point);
    }, { passive: false });
    this.svg.addEventListener('pointerdown', event => this.pointerDown(event));
    this.svg.addEventListener('pointermove', event => this.pointerMove(event));
    this.svg.addEventListener('pointerup', event => this.pointerUp(event));
    this.svg.addEventListener('pointercancel', () => { this.drag = null; });
    this.svg.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        const item = event.target.closest('[data-kind]');
        if (item) { event.preventDefault(); this.select(item.dataset.kind, item.dataset.id); }
      }
    });
    new ResizeObserver(() => this.fit()).observe(this.svg);
  }

  localPoint(event) {
    const rect = this.svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  setGraph(graph) {
    const different = graph.id !== this.graph.id;
    if (different) { this.positions.clear(); this.selection = null; }
    this.graph = graph;
    const n = graph.nodes.length;
    const radius = Math.max(125, Math.sqrt(n) * 55);
    graph.nodes.forEach((node, i) => {
      if (!this.positions.has(node.id)) {
        const angle = 2 * Math.PI * i / Math.max(n, 1) - Math.PI / 2;
        this.positions.set(node.id, n === 1 ? { x: 0, y: 0 } : { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
      }
    });
    for (const id of this.positions.keys()) if (!graph.nodes.some(node => node.id === id)) this.positions.delete(id);
    this.render();
    if (different || this.previousCount !== n) this.fit();
    this.previousCount = n;
  }

  layout() { this.positions.clear(); this.setGraph(this.graph); this.fit(); }

  fit() {
    const width = this.svg.clientWidth, height = this.svg.clientHeight;
    if (!width || !height) return;
    const points = [...this.positions.values()];
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const left = points.length ? Math.min(...xs) - 95 : -150;
    const right = points.length ? Math.max(...xs) + 95 : 150;
    const top = points.length ? Math.min(...ys) - 80 : -150;
    const bottom = points.length ? Math.max(...ys) + 90 : 150;
    const scale = Math.min(width / (right - left), height / (bottom - top), 1.4);
    this.view = { scale, x: width / 2 - (left + right) / 2 * scale, y: height / 2 - (top + bottom) / 2 * scale };
    this.transform();
  }

  zoom(factor, point = { x: this.svg.clientWidth / 2, y: this.svg.clientHeight / 2 }) {
    const old = this.view.scale;
    this.view.scale = Math.max(.08, Math.min(5, old * factor));
    this.view.x = point.x - (point.x - this.view.x) * this.view.scale / old;
    this.view.y = point.y - (point.y - this.view.y) * this.view.scale / old;
    this.transform();
  }

  transform() { this.layer?.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.scale})`); }

  select(kind, id) {
    this.selection = { kind, id };
    this.render();
    this.onSelect(kind, id);
  }

  highlight(query) { this.filter = query.trim().toLowerCase(); this.render(); }

  pointerDown(event) {
    if (event.button !== 0) return;
    const item = event.target.closest('[data-kind]');
    this.drag = { point: this.localPoint(event), item: item ? { kind: item.dataset.kind, id: item.dataset.id } : null, moved: false };
    this.svg.setPointerCapture(event.pointerId);
  }

  pointerMove(event) {
    if (!this.drag) return;
    const point = this.localPoint(event), dx = point.x - this.drag.point.x, dy = point.y - this.drag.point.y;
    if (Math.abs(dx) + Math.abs(dy) < 2 && !this.drag.moved) return;
    this.drag.moved = true;
    if (this.drag.item?.kind === 'node') {
      const pos = this.positions.get(this.drag.item.id);
      pos.x += dx / this.view.scale;
      pos.y += dy / this.view.scale;
      this.render();
    } else {
      this.view.x += dx; this.view.y += dy; this.transform();
    }
    this.drag.point = point;
  }

  pointerUp(event) {
    if (this.drag?.item && !this.drag.moved) this.select(this.drag.item.kind, this.drag.item.id);
    this.drag = null;
    if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
  }

  render() {
    this.svg.replaceChildren();
    const defs = svgElement('defs');
    const marker = svgElement('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    marker.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#97afa0' }));
    defs.append(marker); this.svg.append(defs);
    this.layer = svgElement('g'); this.svg.append(this.layer);
    const typeColors = new Map(this.graph.node_types.map((type, i) => [type.id, colors[i % colors.length]]));
    const relTypes = new Map(this.graph.relationship_types.map(type => [type.id, type.name]));
    const matching = new Set(this.graph.nodes.filter(node => `${node.name} ${node.id}`.toLowerCase().includes(this.filter)).map(node => node.id));
    const pairs = new Map();
    for (const edge of this.graph.edges) {
      const key = [edge.source_id, edge.target_id].sort().join(':');
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(edge);
    }
    for (const edge of this.graph.edges) {
      const a = this.positions.get(edge.source_id), b = this.positions.get(edge.target_id);
      if (!a || !b) continue;
      const group = svgElement('g', { class: `graph-edge${this.selection?.id === edge.id ? ' selected' : ''}${this.filter && !matching.has(edge.source_id) && !matching.has(edge.target_id) ? ' dim' : ''}`, 'data-kind': 'edge', 'data-id': edge.id, tabindex: '0', role: 'button', 'aria-label': `Relationship ${relTypes.get(edge.type_id)}` });
      const siblings = pairs.get([edge.source_id, edge.target_id].sort().join(':'));
      const index = siblings.indexOf(edge);
      let path, label;
      if (edge.source_id === edge.target_id) {
        const size = 65 + index * 32;
        path = `M ${a.x - 15} ${a.y - 15} C ${a.x - size} ${a.y - size - 30}, ${a.x + size} ${a.y - size - 30}, ${a.x + 16} ${a.y - 17}`;
        label = { x: a.x, y: a.y - size - 6 };
      } else {
        const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
        const sign = edge.source_id < edge.target_id ? 1 : -1;
        const bend = (index - (siblings.length - 1) / 2) * 60 * sign;
        const cx = (a.x + b.x) / 2 - dy / length * bend;
        const cy = (a.y + b.y) / 2 + dx / length * bend;
        const al = Math.hypot(cx - a.x, cy - a.y) || 1, bl = Math.hypot(cx - b.x, cy - b.y) || 1;
        const start = { x: a.x + (cx - a.x) / al * 23, y: a.y + (cy - a.y) / al * 23 };
        const end = { x: b.x + (cx - b.x) / bl * 27, y: b.y + (cy - b.y) / bl * 27 };
        path = `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`;
        label = { x: (start.x + 2 * cx + end.x) / 4, y: (start.y + 2 * cy + end.y) / 4 - 7 };
      }
      group.append(svgElement('path', { d: path, fill: 'none', stroke: 'transparent', 'stroke-width': 16 }));
      group.append(svgElement('path', { class: 'edge-line', d: path, fill: 'none', stroke: '#aec1b3', 'stroke-width': 1.5, 'marker-end': 'url(#arrow)' }));
      group.append(svgElement('text', { x: label.x, y: label.y, 'text-anchor': 'middle' }, relTypes.get(edge.type_id)));
      this.layer.append(group);
    }
    for (const node of this.graph.nodes) {
      const pos = this.positions.get(node.id), color = typeColors.get(node.type_id) || colors[0];
      const group = svgElement('g', { class: `graph-node${this.selection?.id === node.id ? ' selected' : ''}${this.filter && !matching.has(node.id) ? ' dim' : ''}`, transform: `translate(${pos.x},${pos.y})`, 'data-kind': 'node', 'data-id': node.id, tabindex: '0', role: 'button', 'aria-label': `${node.name}, UUID ${node.id}` });
      group.append(svgElement('title', {}, `${node.name}\n${node.id}\n${node.description}`));
      group.append(svgElement('circle', { r: 23, fill: color + '22', stroke: color, 'stroke-width': 2 }));
      group.append(svgElement('circle', { r: 6, fill: color }));
      group.append(svgElement('text', { y: 43, 'text-anchor': 'middle' }, node.name.length > 24 ? node.name.slice(0, 23) + '…' : node.name));
      this.layer.append(group);
    }
    this.transform();
  }
}
