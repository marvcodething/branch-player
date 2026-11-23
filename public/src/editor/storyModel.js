// Pure operations on the authoring format (story.json). No DOM; every function mutates the
// story it's given. Node ids are permanent once created (they name the media/<id>/ build dirs);
// `label` is the editable display name.

export const GRID = 25;
export const CARD_W = 150, CARD_H = 100;
// The player maps number keys 1–4 to choices; more than that can only be clicked.
export const MAX_CHOICES = 4;

// No lower clamp: the canvas pans freely, so nodes may sit left of or above the origin.
const snap = v => Math.round(v / GRID) * GRID;

function uniqueId(story, base) {
  const slug = String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'node';
  let id = slug, n = 2;
  while (story.nodes[id]) id = `${slug}-${n++}`;
  return id;
}

export function addNode(story, { x, y, label = 'Untitled' } = {}) {
  const id = uniqueId(story, label === 'Untitled' ? 'node' : label);
  story.nodes[id] = { label, source: '', prompt: '', choices: [], editor: { x: snap(x ?? 0), y: snap(y ?? 0) } };
  return id;
}

export function deleteNode(story, id) {
  if (id === story.start) throw new Error("The start node can't be deleted. Set another start first.");
  delete story.nodes[id];
  for (const n of Object.values(story.nodes)) n.choices = (n.choices || []).filter(c => c.to !== id);
}

export function setStart(story, id) {
  if (story.nodes[id]) story.start = id;
}

export function addChoice(story, from, to, label = 'New choice') {
  const n = story.nodes[from];
  if (!n || !story.nodes[to]) return false;
  n.choices ||= [];
  if (n.choices.some(c => c.to === to)) return false;
  n.choices.push({ label, to });
  return true;
}

// Point an existing choice at another node, keeping its index so a default stays the default.
export function retargetChoice(story, from, i, to) {
  const cs = story.nodes[from]?.choices;
  if (!cs?.[i] || !story.nodes[to]) return false;
  if (cs.some((c, j) => j !== i && c.to === to)) return false;
  cs[i].to = to;
  return true;
}

// Move a choice to another source node. It is appended there, so it isn't that node's default.
export function moveChoiceTo(story, from, i, newFrom) {
  const choice = story.nodes[from]?.choices?.[i], dest = story.nodes[newFrom];
  if (!choice || !dest) return false;
  dest.choices ||= [];
  if (dest.choices.some(c => c.to === choice.to)) return false;
  story.nodes[from].choices.splice(i, 1);
  dest.choices.push(choice);
  return true;
}

export function updateChoice(story, from, i, patch) {
  Object.assign(story.nodes[from].choices[i], patch);
}

export function removeChoice(story, from, i) {
  story.nodes[from].choices.splice(i, 1);
}

// Order matters: the first choice is what fallback "first" takes.
export function moveChoice(story, from, i, delta) {
  const cs = story.nodes[from].choices, j = i + delta;
  if (j < 0 || j >= cs.length) return;
  [cs[i], cs[j]] = [cs[j], cs[i]];
}

export function setSource(story, id, source) {
  story.nodes[id].source = source;
}

export function setPosition(story, id, x, y) {
  story.nodes[id].editor = { x: snap(x), y: snap(y) };
}

// Layered layout by distance from start, for nodes that have never been placed in the editor.
export function autoLayout(story) {
  const ids = Object.keys(story.nodes);
  if (ids.every(id => story.nodes[id].editor)) return false;
  const depth = depths(story);
  const maxDepth = Math.max(0, ...Object.values(depth));
  const rows = {};
  for (const id of ids) {
    const d = depth[id] ?? maxDepth + 1; // unreachable nodes go in a column at the end
    const row = (rows[d] = (rows[d] || 0) + 1) - 1;
    if (!story.nodes[id].editor) story.nodes[id].editor = { x: snap(50 + d * 300), y: snap(50 + row * 175) };
  }
  return true;
}

// Shortest number of choices from start to each reachable node.
export function depths(story) {
  const depth = { [story.start]: 0 }, queue = [story.start];
  while (queue.length) {
    const id = queue.shift();
    for (const c of story.nodes[id]?.choices || []) {
      if (depth[c.to] == null && story.nodes[c.to]) { depth[c.to] = depth[id] + 1; queue.push(c.to); }
    }
  }
  return depth;
}

export function reachable(story) {
  const seen = new Set(), stack = [story.start];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id) || !story.nodes[id]) continue;
    seen.add(id);
    for (const c of story.nodes[id].choices || []) stack.push(c.to);
  }
  return seen;
}

// { errors: { id: [msg] }, warnings: { id: [msg] } }. Errors block a build; warnings don't.
export function validate(story, sources = null) {
  const errors = {}, warnings = {};
  const add = (bag, id, msg) => (bag[id] ||= []).push(msg);
  const seen = reachable(story);
  for (const [id, n] of Object.entries(story.nodes)) {
    if (!n.source) add(errors, id, 'No video');
    else if (sources && !sources.includes(n.source)) add(errors, id, `Video not found: ${n.source}`);
    if (!seen.has(id)) add(warnings, id, 'Unreachable from start');
    if ((n.choices || []).length > MAX_CHOICES) add(warnings, id, `More than ${MAX_CHOICES} choices (keys 1–${MAX_CHOICES} only)`);
    // A single choice continues automatically with no UI, so only multi-choice labels are shown.
    if ((n.choices || []).length > 1 && n.choices.some(c => !c.label?.trim())) add(warnings, id, 'Choice without a label');
  }
  return { errors, warnings };
}
