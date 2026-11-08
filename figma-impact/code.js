// DSH 变更影响分析 —— M0：依赖图构建
//
// 只做一件事：把当前文件的依赖关系抽成一张图，让面板能回答
// "这个节点依赖谁 / 谁依赖它"。
//
// M0 不联网、不调 AI、不修改画布。图的准确性是后面所有功能的地基。
//
// 四类边：
//   prototype  原型跳转（node.reactions → destinationId）
//   instance   实例 → 主组件（getMainComponentAsync）
//   child      父子结构（页面 → 图层……）
//   style      节点 → 样式（textStyleId / fillStyleId / effectStyleId）
//
// 样式这里读的是节点上的引用，不是本地样式列表 —— 库样式（远程）同样能建边。

const REACTIONABLE = new Set([
  'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'TEXT'
]);

const YIELD_EVERY = 400;
const TEXT_PREVIEW = 60;

let graph = null;

figma.showUI(__html__, { width: 480, height: 680, themeColors: true });

const send = (msg) => figma.ui.postMessage(msg);
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- 面板大小：支持拖拽调整并记住 ---
let uiSize = null;
let persistTimer = null;

function resizeUi(w, h, persist) {
  const width = Math.max(360, Math.min(1200, Math.round(Number(w) || 480)));
  const height = Math.max(420, Math.min(1200, Math.round(Number(h) || 680)));
  try {
    figma.ui.resize(width, height);
  } catch (e) {
    return;
  }
  if (!persist) return;
  uiSize = { width, height };
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { figma.clientStorage.setAsync('dsh:uiSize', uiSize); } catch (e) { /* 忽略 */ }
  }, 500);
}

(async () => {
  try {
    const saved = await figma.clientStorage.getAsync('dsh:uiSize');
    if (saved && saved.width && saved.height) resizeUi(saved.width, saved.height, false);
  } catch (e) { /* 首次运行没有记录 */ }
})();

figma.ui.onmessage = async (msg) => {
  if (!msg) return;
  if (msg.type === 'scan') {
    try {
      await buildGraph();
    } catch (err) {
      send({ type: 'error', text: String((err && err.message) || err) });
    }
  } else if (msg.type === 'select') {
    await selectNode(msg.id);
  } else if (msg.type === 'analyze') {
    if (reviewSession && reviewSession.phase === 'REVIEWING') {
      send({ type: 'reviewError', text: '评审进行中，分析已冻结。等发起者结束评审后再分析。' });
      return;
    }
    try {
      await analyze(msg.rootId, msg.depth, msg.showCallout, msg.scope);
    } catch (err) {
      send({ type: 'error', text: String((err && err.message) || err) });
    }
  } else if (msg.type === 'startReview') {
    await startReview(msg.items);
  } else if (msg.type === 'endReview') {
    await endReview();
  } else if (msg.type === 'requestReview') {
    send({ type: 'review', data: describeSession() });
  } else if (msg.type === 'redraw') {
    try {
      if (!Array.isArray(msg.items)) return;
      const drawn = await drawMarks(msg.items, msg.sessionId || 'REDRAW', msg.showCallout !== false);
      send({ type: 'redrawn', drawn });
    } catch (err) {
      send({ type: 'error', text: String((err && err.message) || err) });
    }
  } else if (msg.type === 'clearMarks') {
    clearMarks();
    send({ type: 'cleared' });
  } else if (msg.type === 'resize') {
    resizeUi(msg.w, msg.h, true);
  } else if (msg.type === 'saveAI') {
    const ok = await storeAISettings({
      provider: msg.provider,
      base: msg.base,
      model: msg.model,
      key: msg.key
    });
    send({ type: 'keyStatus', data: describeAiStatus(ok) });
  } else if (msg.type === 'loadHistory') {
    const list = await loadChangeHistory();
    send({ type: 'history', data: list });
  } else if (msg.type === 'pushHistory') {
    const list = await pushChangeHistory(msg.text);
    send({ type: 'history', data: list });
  } else if (msg.type === 'testKey') {
    await testApiKey();
  } else if (msg.type === 'setSemanticLevel') {
    const level = await saveSemanticLevel(msg.level);
    send({ type: 'semanticLevel', data: { level: level } });
  } else if (msg.type === 'aiAnalyze') {
    if (reviewSession && reviewSession.phase === 'REVIEWING') {
      send({ type: 'reviewError', text: '评审进行中，分析已冻结。等发起者结束评审后再分析。' });
      return;
    }
    try {
      await aiAnalyze(msg.change, msg.showCallout, msg.scope);
    } catch (err) {
      send({ type: 'aiError', text: String((err && err.message) || err) });
    }
  } else if (msg.type === 'suggestEdits') {
    try {
      await aiSuggestEdits(msg.change, msg.anchorId, msg.scope, msg.impactItems, msg.impactRootId, msg.impactMode);
    } catch (err) {
      send({ type: 'aiError', text: String((err && err.message) || err) });
    }
  } else if (msg.type === 'applyEdits') {
    try {
      await applyEdits(msg.edits);
    } catch (err) {
      send({ type: 'aiError', text: String((err && err.message) || err) });
    }
  } else if (msg.type === 'verifyImpact') {
    try {
      await describeImpactState(msg.items);
    } catch (err) {
      send({ type: 'aiError', text: String((err && err.message) || err) });
    }
  } else if (msg.type === 'revertEdits') {
    try {
      await revertEdits(msg.edits);
    } catch (err) {
      send({ type: 'aiError', text: String((err && err.message) || err) });
    }
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};

// 启动时的副作用统一放在文件末尾执行（见文件最后），
// 否则会撞上后面 let/const 的暂时性死区。

figma.on('close', () => {
  // 关闭面板就清理画布标记，避免把临时标注留在文件里
  try { clearMarks(); } catch (e) { /* 忽略 */ }
});

figma.on('selectionchange', () => {
  if (!graph) return;
  const sel = figma.currentPage.selection;
  send({
    type: 'selection',
    count: sel.length,
    node: sel.length === 1 ? describeNode(sel[0], 0) : null
  });
});

function describeNode(node, depth) {
  const rec = {
    id: node.id,
    name: node.name,
    type: node.type,
    depth: depth || 0,
    text: null,
    width: null,
    height: null
  };
  try {
    if (node.type === 'TEXT') rec.text = String(node.characters || '').slice(0, TEXT_PREVIEW);
    if (typeof node.width === 'number') rec.width = Math.round(node.width);
    if (typeof node.height === 'number') rec.height = Math.round(node.height);
  } catch (e) {
    /* 某些节点类型没有这些属性 */
  }
  return rec;
}

async function buildGraph() {
  const startedAt = Date.now();
  send({ type: 'start' });

  send({ type: 'progress', text: '加载全部页面…' });
  await figma.loadAllPagesAsync();

  const pages = figma.root.children;
  const nodes = [];
  const byId = new Map();
  const edges = [];

  // 跳过实例内部：依赖图不需要实例的子结构，只需要"实例 → 主组件"
  figma.skipInvisibleInstanceChildren = true;

  const mainComponentCache = new Map();

  // 原型统计：反应对象数 ≠ 导航跳转数
  // 一个 reaction 可能挂多个 action，其中只有 type === 'NODE' 的才产生"画板 → 画板"的边
  let reactionObjects = 0;
  let navActions = 0;
  let otherActions = 0;

  let tick = 0;
  const stack = [];
  for (let i = pages.length - 1; i >= 0; i--) {
    stack.push({ node: pages[i], depth: 0, pageId: pages[i].id, pageName: pages[i].name });
  }

  while (stack.length) {
    const item = stack.pop();
    const { node, depth, pageId, pageName } = item;

    const rec = describeNode(node, depth);
    rec.pageId = pageId;
    rec.pageName = pageName;
    nodes.push(rec);
    byId.set(rec.id, rec);

    // --- prototype 边 ---
    if (REACTIONABLE.has(node.type)) {
      let reactions = [];
      try {
        reactions = node.reactions || [];
      } catch (e) {
        reactions = [];
      }
      reactionObjects += reactions.length;
      for (const reaction of reactions) {
        const actions = reaction.actions || (reaction.action ? [reaction.action] : []);
        if (!actions.length) {
          otherActions++;
          continue;
        }
        for (const action of actions) {
          if (action && action.type === 'NODE' && action.destinationId) {
            navActions++;
            edges.push({
              type: 'prototype',
              from: rec.id,
              to: action.destinationId,
              trigger: (reaction.trigger && reaction.trigger.type) || 'UNKNOWN'
            });
          } else {
            otherActions++;
          }
        }
      }
    }

    // --- instance 边 ---
    if (node.type === 'INSTANCE') {
      try {
        let mainId = mainComponentCache.get(rec.id);
        if (mainId === undefined) {
          const main = await node.getMainComponentAsync();
          mainId = main ? main.id : null;
          if (mainId) mainComponentCache.set(rec.id, mainId);
        }
        if (mainId) {
          edges.push({ type: 'instance', from: rec.id, to: mainId });
        }
      } catch (e) {
        /* 主组件可能在别的文件里，取不到就跳过 */
      }
    }

    // --- style 边（读节点引用，本地/库样式都能拿到 id） ---
    const styleIds = [];
    try {
      if (node.textStyleId) styleIds.push(node.textStyleId);
    } catch (e) {}
    try {
      if (node.fillStyleId) styleIds.push(node.fillStyleId);
    } catch (e) {}
    try {
      if (node.strokeStyleId) styleIds.push(node.strokeStyleId);
    } catch (e) {}
    try {
      if (node.effectStyleId) styleIds.push(node.effectStyleId);
    } catch (e) {}
    for (const sid of styleIds) {
      if (typeof sid === 'string' && sid) {
        edges.push({ type: 'style', from: rec.id, to: sid, targetKind: 'style' });
      }
    }

    // --- child 边 + 压栈 ---
    const kids = node.children;
    if (kids && kids.length) {
      for (let i = kids.length - 1; i >= 0; i--) {
        edges.push({ type: 'child', from: rec.id, to: kids[i].id });
        stack.push({ node: kids[i], depth: depth + 1, pageId, pageName });
      }
    }

    if (++tick % YIELD_EVERY === 0) {
      send({ type: 'progress', text: `已扫描 ${nodes.length.toLocaleString()} 个节点…` });
      await nextTick();
    }
  }

  // 统计
  const edgeCount = { prototype: 0, instance: 0, child: 0, style: 0 };
  for (const e of edges) edgeCount[e.type] = (edgeCount[e.type] || 0) + 1;

  // 影响分析用的邻接表（只保留「节点 → 节点」的边）
  const outAdj = new Map();
  const inAdj = new Map();
  for (const e of edges) {
    if (e.type !== 'prototype' && e.type !== 'instance') continue;
    if (!outAdj.has(e.from)) outAdj.set(e.from, []);
    outAdj.get(e.from).push(e);
    if (!inAdj.has(e.to)) inAdj.set(e.to, []);
    inAdj.get(e.to).push(e);
  }

  graph = {
    fileName: figma.root.name,
    pageCount: pages.length,
    nodes,
    edges,
    edgeCount,
    nodeCount: nodes.length,
    byId,
    outAdj,
    inAdj,
    reactions: {
      objects: reactionObjects,
      navigation: navActions,
      other: otherActions
    },
    durationMs: Date.now() - startedAt,
    scannedAt: new Date().toLocaleString()
  };

  send({ type: 'graph', data: graph });

  // 图建好后同步一次评审会话状态（UI 这时已经就绪）
  send({ type: 'review', data: describeSession() });

  const sel = figma.currentPage.selection;
  send({
    type: 'selection',
    count: sel.length,
    node: sel.length === 1 ? describeNode(sel[0], 0) : null
  });
}

/** 顺着 parent 往上找到所属页面；找不到返回 null。 */
function pageOf(node) {
  let current = node;
  while (current && current.type !== 'PAGE') {
    current = current.parent;
  }
  return current || null;
}

async function selectNode(id) {
  if (!id || typeof id !== 'string') return;
  // 样式 id（S:...）不是节点，不能选中
  if (id.startsWith('S:') || id.startsWith('V:')) return;

  try {
    const node = await figma.getNodeByIdAsync(id);
    if (!node) {
      send({ type: 'error', text: '节点不存在：可能已被删除' });
      return;
    }
    if (node.type === 'PAGE') return;

    // 目标可能在别的页面：先切页，否则 setSelection 会直接抛错
    const page = pageOf(node);
    if (page && page.id !== figma.currentPage.id) {
      if (typeof figma.setCurrentPageAsync === 'function') {
        await figma.setCurrentPageAsync(page);
      } else {
        figma.currentPage = page;
      }
    }

    figma.currentPage.selection = [node];
    try {
      figma.viewport.scrollAndZoomIntoView([node]);
    } catch (e) {
      /* 某些节点没有可视边界，忽略滚动失败 */
    }
    send({ type: 'selected', id: node.id, name: node.name });
  } catch (err) {
    send({ type: 'error', text: '定位失败：' + String((err && err.message) || err) });
  }
}

// ---------------------------------------------------------------------------
// M1：影响分析 + 画布标记
// ---------------------------------------------------------------------------

const LEVEL_COLORS = {
  0: { r: 0.55, g: 0.36, b: 0.96 }, // 语义 · 紫
  1: { r: 0.95, g: 0.26, b: 0.21 }, // 直接 · 红
  2: { r: 0.98, g: 0.56, b: 0.09 }, // 间接 · 橙
  3: { r: 0.95, g: 0.80, b: 0.16 }  // 潜在 · 黄
};
const LEVEL_NAMES = { 0: '语义', 1: '直接', 2: '间接', 3: '潜在' };
const MARKS_PREFIX = '[DSH] ';
const CALLOUT_WIDTH = 240;

function shortReason(item) {
  const graphWhy = String(item.reason || '').trim();
  const aiWhy = String(item.aiWhy || '').trim();
  const parts = [];
  if (graphWhy) parts.push(graphWhy);
  if (aiWhy && aiWhy !== graphWhy) parts.push('AI：' + aiWhy);
  const raw = parts.join(' · ');
  if (!raw) return (LEVEL_NAMES[item.level] || '') + '影响';
  return raw.length > 60 ? raw.slice(0, 57) + '…' : raw;
}

let marksBox = null;
let fontReady = false;

async function ensureFont() {
  if (fontReady) return;
  try {
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    fontReady = true;
  } catch (e) {
    fontReady = false;
  }
}

/** 从变更源出发，按「组件↔实例、画板↔跳转」双向展开，按跳数分级。 */
/**
 * 从某个根节点做双向图传播，返回 id -> { level, reason }。
 * 按钮分析和 AI 分析共用这一份逻辑，保证两条路径的结构部分完全一致。
 */
function computeGraphImpact(rootId, maxDepth) {
  const depth = Math.max(1, Math.min(3, Number(maxDepth) || 3));
  const levels = new Map();
  if (!graph || !graph.byId.has(rootId)) return levels;

  const visited = new Set([rootId]);
  let frontier = [{ id: rootId }];

  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const e of (graph.outAdj.get(cur.id) || [])) {
        if (visited.has(e.to)) continue;
        visited.add(e.to);
        levels.set(e.to, {
          level: d,
          reason: e.type === 'prototype' ? '它跳转到这个画板' : '它是这个组件的实例'
        });
        next.push({ id: e.to });
      }
      for (const e of (graph.inAdj.get(cur.id) || [])) {
        if (visited.has(e.from)) continue;
        visited.add(e.from);
        levels.set(e.from, {
          level: d,
          reason: e.type === 'prototype' ? '它跳转到当前节点' : '它引用了当前组件'
        });
        next.push({ id: e.from });
      }
    }
    frontier = next;
    if (levels.size >= 200) break; // 3 跳在稠密图上可能爆炸，先截断
  }

  return levels;
}

/**
 * 精确影响集合 = 图传播 ∪ 同容器结构扩展。
 * 全部由结构决定，不依赖模型；AI 只在这份集合上写说明，不允许增删节点。
 */
/** 收集与给定节点同组件的全部实例 id（跨页也收）。 */
async function collectSameComponentInstanceIds(node) {
  const ids = new Set();
  try {
    let main = null;
    if (node.type === 'INSTANCE') {
      main = await node.getMainComponentAsync();
    } else if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      main = node;
    }

    const componentIds = new Set();
    if (main && main.type === 'COMPONENT_SET') {
      for (const child of main.children) {
        if (child.type === 'COMPONENT') componentIds.add(child.id);
      }
    } else if (main) {
      componentIds.add(main.id);
    }
    if (!componentIds.size || !graph) return ids;

    for (const [id, rec] of graph.byId) {
      if (!rec || rec.type !== 'INSTANCE') continue;
      const edges = graph.outAdj.get(id) || [];
      const hit = edges.some(function (e) {
        return e.type === 'instance' && componentIds.has(e.to);
      });
      if (hit) ids.add(id);
    }
  } catch (e) { /* 跨文件组件取不到就只留空集 */ }
  return ids;
}

/** 直接用画布扫描找同组件实例（不依赖图边，避免漏掉跨页实例）。 */
async function scanSameComponentInstances(rootNode) {
  const out = [];
  try {
    let main = null;
    if (rootNode.type === 'INSTANCE') main = await rootNode.getMainComponentAsync();
    else if (rootNode.type === 'COMPONENT' || rootNode.type === 'COMPONENT_SET') main = rootNode;

    const componentIds = new Set();
    if (main && main.type === 'COMPONENT_SET') {
      for (const child of main.children) {
        if (child.type === 'COMPONENT') componentIds.add(child.id);
      }
    } else if (main) {
      componentIds.add(main.id);
    }
    if (!componentIds.size) return out;

    try { await figma.loadAllPagesAsync(); } catch (e) { /* 已加载 */ }

    for (const page of figma.root.children) {
      let list = [];
      try { list = page.findAllWithCriteria({ types: ['INSTANCE'] }); } catch (e) { list = []; }
      for (const inst of list) {
        if (out.length >= 100) break;
        if (inst.id === rootNode.id) continue;
        if (out.some(function (o) { return o.id === inst.id; })) continue;
        let m = null;
        try { m = await inst.getMainComponentAsync(); } catch (e) { m = null; }
        if (m && componentIds.has(m.id)) out.push({ id: inst.id, name: inst.name });
      }
    }
  } catch (e) { /* 忽略 */ }
  return out;
}

/** 计算结构影响集合（不受范围影响）：图传播 + 同容器兄弟。 */
async function computeImpact(rootId, maxDepth) {
  const out = new Map();
  let rootNode = null;
  try { rootNode = await figma.getNodeByIdAsync(rootId); } catch (e) { rootNode = null; }
  if (!rootNode) return out;

  const graphLevels = computeGraphImpact(rootId, maxDepth);
  for (const [id, meta] of graphLevels) {
    out.set(id, { level: meta.level, reason: meta.reason, source: 'graph' });
  }

  // 锚点本身永远属于"这次要改的东西"，所有范围都保留它
  if (!out.has(rootId)) {
    out.set(rootId, { level: 1, reason: '变更源本身', source: 'graph' });
  }

  try {
    const parent = rootNode.parent;
    const childCount = (parent && parent.children) ? parent.children.length : 0;
    if (parent && parent.type !== 'PAGE' && childCount > 1 && childCount <= 40) {
      for (const sibling of parent.children) {
        if (!sibling || sibling.id === rootId) continue;
        if (!graph.byId.has(sibling.id)) continue;
        if (out.has(sibling.id)) continue;
        out.set(sibling.id, {
          level: 2,
          reason: '与变更源在同一个容器内',
          source: 'sibling'
        });
      }
    }
  } catch (e) { /* 忽略 */ }

  return out;
}

/**
 * 按范围收敛影响集合（只在② AI 分析里使用；① 永远是全文件结构）。
 *   node      —— 只留锚点本身
 *   instances —— 只留同组件实例
 *   related   —— 同页结构 + 同组件实例
 *   file      —— 不收敛
 */
/** 取锚点关联的组件 id 集合（组件集则收所有变体，同族都算）。 */
async function componentIdsOf(rootNode) {
  const ids = new Set();
  try {
    let main = null;
    if (rootNode.type === 'INSTANCE') main = await rootNode.getMainComponentAsync();
    else if (rootNode.type === 'COMPONENT' || rootNode.type === 'COMPONENT_SET') main = rootNode;
    if (!main) return ids;

    // 变体实例的 main 是具体变体，要把整个组件集的兄弟变体都算进"同组件"
    let set = null;
    if (main.type === 'COMPONENT_SET') set = main;
    else if (main.parent && main.parent.type === 'COMPONENT_SET') set = main.parent;

    if (set) {
      for (const c of set.children) {
        if (c.type === 'COMPONENT') ids.add(c.id);
      }
    } else {
      ids.add(main.id);
    }
  } catch (e) { /* 跨文件组件取不到 */ }
  return ids;
}

async function filterItemsByScope(items, rootNode, scope) {
  if (!rootNode) return items;
  if (!scope || scope === 'file') return items;

  let pageId = null;
  try {
    const page = pageOf(rootNode);
    pageId = page ? page.id : null;
  } catch (e) { pageId = null; }

  const compIds = await componentIdsOf(rootNode);
  // 逐个节点问主组件，比"图里有没有实例边"可靠
  async function isSameComponent(id) {
    if (!compIds.size) return false;
    let node = null;
    try { node = await figma.getNodeByIdAsync(id); } catch (e) { node = null; }
    if (!node || node.type !== 'INSTANCE') return false;
    let main = null;
    try { main = await node.getMainComponentAsync(); } catch (e) { main = null; }
    return !!(main && compIds.has(main.id));
  }

  const out = [];
  for (const it of items) {
    if (!it || typeof it.id !== 'string') continue;
    // 锚点在任何范围下都保留
    if (it.id === rootNode.id) { out.push(it); continue; }
    if (scope === 'node') continue;

    const sameComp = await isSameComponent(it.id);

    if (scope === 'instances') {
      if (sameComp) out.push(it);
      continue;
    }

    const rec = graph && graph.byId.get(it.id);
    const onSamePage = !!(rec && rec.pageId && pageId && rec.pageId === pageId);
    // 相关范围：本页结构 + 跨页但同组件的节点
    if (onSamePage || sameComp) out.push(it);
  }

  // 仅选中节点时，至少把锚点本身放进集合，保证画布有标记
  if (scope === 'node' && !out.length) {
    out.push({
      id: rootNode.id,
      name: rootNode.name,
      type: rootNode.type,
      level: 1,
      reason: '变更源本身',
      source: 'graph'
    });
  }

  return out;
}

async function analyze(rootId, maxDepth, showCallout, scope) {
  const depth = Math.max(1, Math.min(3, Number(maxDepth) || 2));
  if (!graph) await buildGraph();

  const root = graph.byId.get(rootId);
  if (!root) {
    send({ type: 'error', text: '选中节点不在图里（它可能在实例内部）' });
    return;
  }

  send({ type: 'progress', text: '展开依赖链…' });

  const levels = await computeImpact(rootId, depth, scope);

  const items = [];
  let index = 0;
  for (const [id, meta] of levels) {
    const rec = graph.byId.get(id);
    items.push({
      index: ++index,
      id,
      name: rec ? rec.name : id,
      type: rec ? rec.type : '?',
      level: meta.level,
      reason: meta.reason,
      source: 'graph'
    });
  }
  items.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

  const sessionId = 'S' + Date.now().toString(36).toUpperCase();
  const drawn = await drawMarks(items, sessionId, showCallout !== false);

  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const it of items) counts[it.level] = (counts[it.level] || 0) + 1;

  try {
    figma.root.setPluginData('dsh:lastSession', JSON.stringify({
      sessionId,
      rootId,
      rootName: root.name,
      depth,
      counts,
      drawn,
      createdAt: new Date().toISOString()
    }));
  } catch (e) { /* 插件数据不可写时忽略 */ }

  markAnalysisFresh();
  send({
    type: 'impact',
    data: { sessionId, rootId, rootName: root.name, depth, scope: scope || 'related', items, counts, drawn }
  });
}

/**
 * 画两层 overlay，按「节点所在页面」分别成层：
 *   [DSH] 影响范围 · <session>  —— 描边框 + 编号，始终显示
 *   [DSH] 建议气泡 · <session>  —— 编号 + 建议文字，可单独隐藏
 * 每一页各一套（只在有标记的页面上创建），所以跨页的变更也能各自标出来。
 * 两层都是普通图层，协作者不开插件也能用「图层 eye」关掉建议气泡。
 * 原节点的尺寸/位置/样式/布局完全不改动。
 */
async function drawMarks(items, sessionId, showCallout) {
  clearMarks();
  await ensureFont();
  try { await figma.loadAllPagesAsync(); } catch (e) { /* 已有页面可能已加载 */ }

  const rangeLayers = new Map(); // pageId -> frame
  const tipLayers = new Map();

  function layerFor(map, page, suffix) {
    if (map.has(page.id)) return map.get(page.id);
    const frame = figma.createFrame();
    frame.name = MARKS_PREFIX + suffix + ' · ' + sessionId;
    frame.fills = [];
    frame.clipsContent = false;
    frame.resize(1, 1);
    page.appendChild(frame);
    frame.x = 0;
    frame.y = 0;
    map.set(page.id, frame);
    return frame;
  }

  let drawn = 0;
  for (const item of items) {
    try {
      const node = await figma.getNodeByIdAsync(item.id);
      if (!node || !node.absoluteBoundingBox) continue;
      const bb = node.absoluteBoundingBox;
      if (!bb.width || !bb.height) continue;
      if (bb.width > 20000 || bb.height > 20000) continue; // 超大容器不画，避免糊满画布

      const color = LEVEL_COLORS[item.level] || LEVEL_COLORS[3];

      // 外扩一圈：Figma 的选中蓝框画在节点边界上，若描边也贴着边界就会被盖住。
      // 外扩 4px + 4px 描边 → 彩色带落在节点外侧 4~8px，和蓝框互不遮挡。
      const PAD = 4;

      // 标记画在「节点自己所在的页面」上，跨页的变更各自标注
      const page = pageOf(node) || figma.currentPage;
      const rangeLayer = layerFor(rangeLayers, page, '影响范围');
      const tipLayer = showCallout ? layerFor(tipLayers, page, '建议气泡') : null;

      const outline = figma.createRectangle();
      rangeLayer.appendChild(outline);
      outline.resize(Math.max(bb.width + PAD * 2, 2), Math.max(bb.height + PAD * 2, 2));
      outline.x = bb.x - PAD;
      outline.y = bb.y - PAD;
      outline.name = '#' + item.index + ' ' + (LEVEL_NAMES[item.level] || '');
      outline.fills = [];
      outline.strokes = [{ type: 'SOLID', color }];
      outline.strokeWeight = 4;
      outline.strokeAlign = 'OUTSIDE';
      outline.cornerRadius = 4;

      // 编号 + 建议气泡：浮在节点左上角，放 overlay 容器里，
      // 不进节点内部，因此不会改动原节点的尺寸、位置、样式或布局。
      const textColor = item.level === 3
        ? { r: 0.20, g: 0.16, b: 0.02 }
        : { r: 1, g: 1, b: 1 };

      if (!showCallout) {
        // 紧凑模式：只显示编号小方块
        const chip = figma.createFrame();
        rangeLayer.appendChild(chip);
        chip.name = 'chip #' + item.index;
        chip.fills = [{ type: 'SOLID', color }];
        chip.cornerRadius = 3;
        chip.resize(26, 16);
        if (fontReady) {
          const num = figma.createText();
          chip.appendChild(num);
          num.fontName = { family: 'Inter', style: 'Regular' };
          num.fontSize = 9;
          num.characters = String(item.index);
          num.fills = [{ type: 'SOLID', color: textColor }];
          num.x = 8;
          num.y = 2;
        }
        const chipY = bb.y - PAD - 20;
        chip.x = bb.x - PAD;
        chip.y = chipY < 0 ? (bb.y + bb.height + PAD + 4) : chipY;
        drawn++;
        continue;
      }

      // 建议气泡：宽度随文字收缩，超过上限再换行
      const callout = figma.createFrame();
      tipLayer.appendChild(callout);
      callout.name = 'callout #' + item.index;
      callout.fills = [{ type: 'SOLID', color }];
      callout.cornerRadius = 4;
      callout.layoutMode = 'VERTICAL';
      callout.primaryAxisSizingMode = 'AUTO';
      callout.counterAxisSizingMode = 'AUTO';
      callout.paddingTop = 4;
      callout.paddingBottom = 4;
      callout.paddingLeft = 6;
      callout.paddingRight = 6;
      callout.itemSpacing = 0;

      if (fontReady) {
        const label = figma.createText();
        callout.appendChild(label);
        label.fontName = { family: 'Inter', style: 'Regular' };
        label.fontSize = 10;
        label.lineHeight = { unit: 'PIXELS', value: 13 };
        label.textAutoResize = 'WIDTH_AND_HEIGHT';
        label.fills = [{ type: 'SOLID', color: textColor }];
        label.characters = '#' + item.index + '  ' + shortReason(item);

        // 超出最大宽度：改成固定宽 + 自动换行
        if (label.width > CALLOUT_WIDTH - 12) {
          label.textAutoResize = 'HEIGHT';
          label.layoutAlign = 'STRETCH';
          callout.counterAxisSizingMode = 'FIXED';
          try { callout.resize(CALLOUT_WIDTH, callout.height); } catch (e) { /* 忽略 */ }
        }
      } else {
        callout.resize(26, 17);
      }

      const calloutHeight = callout.height || 21;
      const aboveY = bb.y - PAD - calloutHeight - 4;
      callout.x = bb.x - PAD;
      callout.y = aboveY < 0 ? (bb.y + bb.height + PAD + 4) : aboveY;
      drawn++;
    } catch (e) {
      /* 单个节点标记失败不影响整体 */
    }
  }
  // 画完再上锁，避免误拖（锁父级不影响已完成的绘制）
  for (const layer of rangeLayers.values()) {
    try { layer.locked = true; } catch (e) { /* 忽略 */ }
  }
  for (const layer of tipLayers.values()) {
    try { layer.locked = true; } catch (e) { /* 忽略 */ }
  }
  return drawn;
}

/** 删除所有页面上本插件生成的 overlay 容器（跨页清理）。 */
function clearMarks() {
  for (const page of figma.root.children) {
    let victims = [];
    try {
      victims = page.children.filter(function (node) {
        return node && typeof node.name === 'string' && node.name.indexOf(MARKS_PREFIX) === 0;
      });
    } catch (e) {
      continue; // 页面没加载，跳过
    }
    for (const node of victims) {
      try {
        node.locked = false;
        node.remove();
      } catch (e) { /* 忽略 */ }
    }
  }
  marksBox = null;
}

// ---------------------------------------------------------------------------
// M2：DeepSeek 语义定位
// ---------------------------------------------------------------------------

const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    base: 'https://api.deepseek.com',
    chatPath: '/chat/completions',
    defaultModel: 'deepseek-flash',
    testPath: '/user/balance',
    extra: { thinking: { type: 'disabled' } }
  },
  openai: {
    label: 'OpenAI',
    base: 'https://api.openai.com',
    chatPath: '/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    testPath: '/v1/models',
    extra: {}
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    base: '',
    chatPath: '/v1/chat/completions',
    defaultModel: '',
    testPath: '/v1/models',
    extra: {}
  }
};

let aiSettings = null;

const HISTORY_KEY = 'dsh:changeHistory';
const HISTORY_MAX = 6;

async function loadChangeHistory() {
  try {
    const list = await figma.clientStorage.getAsync(HISTORY_KEY);
    return Array.isArray(list) ? list.filter(function (s) { return typeof s === 'string'; }).slice(0, HISTORY_MAX) : [];
  } catch (e) {
    return [];
  }
}

/** 记录一条变更描述：去重、置顶、最多 6 条。 */
async function pushChangeHistory(text) {
  const value = String(text == null ? '' : text).trim();
  if (!value) return await loadChangeHistory();
  const list = await loadChangeHistory();
  const next = [value].concat(list.filter(function (s) { return s !== value; })).slice(0, HISTORY_MAX);
  try {
    await figma.clientStorage.setAsync(HISTORY_KEY, next);
  } catch (e) { /* 存不下就只在本次返回 */ }
  return next;
}

/** 读取接入配置：服务商 / Base URL / 模型 / Key（Key 按服务商分开存）。 */
async function loadAiSettings() {
  if (aiSettings) return aiSettings;
  let provider = 'deepseek';
  try {
    provider = (await figma.clientStorage.getAsync('dsh:provider')) || 'deepseek';
  } catch (e) { /* 读不到就用默认 */ }
  if (!PROVIDERS[provider]) provider = 'deepseek';
  aiSettings = await readProviderSettings(provider);
  return aiSettings;
}

/** 每个服务商各存一份 base / model / key。 */
async function readProviderSettings(provider) {
  let base = '';
  let model = '';
  let key = '';
  try {
    base = (await figma.clientStorage.getAsync('dsh:base:' + provider)) || '';
    model = (await figma.clientStorage.getAsync('dsh:model:' + provider)) || '';
    key = sanitizeKey(await figma.clientStorage.getAsync('dsh:apiKey:' + provider));
    if (!key && provider === 'deepseek') {
      // 兼容早期只有一个 Key 的版本
      key = sanitizeKey(await figma.clientStorage.getAsync('dsh:apiKey'));
    }
  } catch (e) { /* 读取失败按未配置处理 */ }
  return { provider, base, model, key };
}

/** 把配置解析成实际要请求的 base / 路径 / 模型。 */
function resolvedProvider(settings) {
  const def = PROVIDERS[settings.provider] || PROVIDERS.deepseek;
  const base = (settings.provider === 'custom' ? settings.base : def.base)
    .replace(/\/+$/, '');
  return {
    label: def.label,
    base,
    chatPath: def.chatPath,
    testPath: def.testPath,
    model: (settings.model || def.defaultModel || '').trim(),
    defaultModel: def.defaultModel || '',
    extra: def.extra || {}
  };
}

async function readApiKey() {
  const settings = await loadAiSettings();
  return settings.key;
}

/** 复制粘贴常见的脏字符：BOM、首尾空格、包裹的引号、误带的 Bearer 前缀。 */
function sanitizeKey(raw) {
  let key = String(raw == null ? '' : raw).replace(/\uFEFF/g, '').trim();
  key = key.replace(/^Bearer\s+/i, '');
  key = key.replace(/^["'`\s]+/, '').replace(/["'`\s]+$/, '');
  return key;
}

/**
 * 保存接入配置。
 * key 传 undefined 表示"沿用该服务商已存的 Key"（切换服务商时用）。
 */
async function storeAISettings(next) {
  const current = await loadAiSettings();
  const provider = PROVIDERS[next.provider] ? next.provider : current.provider;

  let base = typeof next.base === 'string' ? next.base.trim() : current.base;
  let model = typeof next.model === 'string' ? next.model.trim() : current.model;

  // 只切换服务商（没带 base/model）时，沿用该服务商上次保存的值
  if (provider !== current.provider && base === '' && model === '') {
    const stored = await readProviderSettings(provider);
    base = stored.base;
    model = stored.model;
  }

  let key;
  if (next.key === undefined || next.key === null) {
    key = provider === current.provider
      ? current.key
      : (await readProviderSettings(provider)).key;
  } else {
    key = sanitizeKey(next.key);
  }

  aiSettings = { provider, base, model, key };
  try {
    await figma.clientStorage.setAsync('dsh:provider', provider);
    await figma.clientStorage.setAsync('dsh:base:' + provider, base);
    await figma.clientStorage.setAsync('dsh:model:' + provider, model);
    if (key) await figma.clientStorage.setAsync('dsh:apiKey:' + provider, key);
    else await figma.clientStorage.deleteAsync('dsh:apiKey:' + provider);
    return true;
  } catch (e) {
    return false;
  }
}

function describeAiStatus(saved) {
  const settings = aiSettings || { provider: 'deepseek', base: '', model: '', key: '' };
  const target = resolvedProvider(settings);
  return {
    hasKey: !!settings.key,
    provider: settings.provider,
    label: target.label,
    base: settings.base,
    model: target.model,
    defaultModel: target.defaultModel,
    saved: saved
  };
}

/** 验证 Key：DeepSeek 打余额接口，其它走 /models。 */
async function testApiKey() {
  const settings = await loadAiSettings();
  const target = resolvedProvider(settings);
  if (!settings.key) {
    send({ type: 'keyTest', ok: false, text: '还没有保存 Key' });
    return;
  }
  if (!target.base) {
    send({ type: 'keyTest', ok: false, text: '自定义服务商需要先填 Base URL' });
    return;
  }

  try {
    const res = await fetch(target.base + target.testPath, {
      headers: { 'Authorization': 'Bearer ' + settings.key }
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) {
        send({ type: 'keyTest', ok: false, text: 'Key 无效或已被删除（401）' });
        return;
      }
      send({ type: 'keyTest', ok: false, text: 'HTTP ' + res.status + '：' + text.slice(0, 200) });
      return;
    }

    if (settings.provider === 'deepseek') {
      let data = {};
      try { data = JSON.parse(text); } catch (e) { /* 非 JSON 也当接口正常 */ }
      const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
      const money = infos.map(function (i) {
        return (i.currency || '') + ' ' + (i.total_balance || '?');
      }).join(' / ');
      send({
        type: 'keyTest',
        ok: data.is_available !== false,
        text: (data.is_available === false ? '余额不足 · ' : 'Key 有效 · ') + (money || '接口正常')
      });
      return;
    }

    let data = {};
    try { data = JSON.parse(text); } catch (e) { /* 忽略 */ }
    const list = Array.isArray(data.data) ? data.data : [];
    const sample = list.slice(0, 5).map(function (m) { return m.id; }).join(', ');
    send({
      type: 'keyTest',
      ok: true,
      text: '连接正常 · 可用模型 ' + list.length + ' 个' + (sample ? '：' + sample : '')
    });
  } catch (err) {
    const message = String((err && err.message) || err);
    const hint = /Failed to fetch|NetworkError|Load failed|fetch/i.test(message)
      ? '（通常是 CORS 或网络不通：确认该域名已写进 manifest 的 allowedDomains，且当前网络能访问）'
      : '';
    send({ type: 'keyTest', ok: false, text: '连不上 ' + target.base + '：' + message + hint });
  }
}
function buildDigest() {
  const ids = new Set();
  const lines = [];
  lines.push('文件：' + figma.root.name);

  for (const page of figma.root.children) {
    if (lines.length > 320) break;
    lines.push('');
    lines.push('【页面】' + page.name);
    let top = 0;
    for (const node of page.children) {
      if (top++ >= 24) { lines.push('  ...其余顶层节点省略'); break; }
      if (!node.id) continue;
      ids.add(node.id);
      lines.push('- ' + node.type + ' 「' + node.name + '」 id=' + node.id);
      if ((node.type === 'SECTION' || node.type === 'FRAME') && node.children) {
        let sub = 0;
        for (const child of node.children) {
          if (sub++ >= 10) { lines.push('    ...'); break; }
          if (child.type === 'FRAME' || child.type === 'COMPONENT' ||
              child.type === 'COMPONENT_SET' || child.type === 'SECTION') {
            ids.add(child.id);
            lines.push('    · ' + child.type + ' 「' + child.name + '」 id=' + child.id);
          }
        }
      }
    }
  }
  return { text: lines.join('\n'), ids };
}

function buildPrompt(change, digestText) {
  return [
    '你是设计变更影响分析助手。下面是 Figma 文件的区域清单（每项带 id）。',
    '',
    '用户描述了本次设计变更。请判断哪些区域会受影响，并按程度分级：',
    '1 = 直接影响：定义该内容、或直接体现该变更的区域',
    '2 = 间接影响：依赖它的下游，改了就会出现前后矛盾的区域',
    '3 = 潜在影响：语义相关、需要人工确认的区域',
    '',
    '规则：',
    '- 只能使用下面清单里出现过的 id，禁止编造',
    '- 最多选 12 个区域',
    '- why 用一句中文说明为什么受影响',
    '- 只输出 JSON，不要 markdown 代码块',
    '',
    '输出格式：',
    '{"summary":"一句话概述这次变更的影响范围","areas":[{"id":"1:392","level":1,"why":"色彩规范章节"}]}',
    '',
    '文件结构：',
    digestText,
    '',
    '变更描述：',
    change
  ].join('\n');
}

async function callModel(prompt) {
  const settings = await loadAiSettings();
  const target = resolvedProvider(settings);
  if (!settings.key) throw new Error('还没有保存 API Key');
  if (!target.base) throw new Error('自定义服务商需要先填 Base URL');
  if (!target.model) throw new Error('还没有填模型名');

  const body = {
    model: target.model,
    messages: [
      { role: 'system', content: '你只输出合法 JSON 对象，不输出任何其它文字。' },
      { role: 'user', content: prompt }
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 2500
  };
  Object.assign(body, target.extra);

  const res = await fetch(target.base + target.chatPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + settings.key
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(target.label + ' 的 API Key 无效（401），请重新填写');
    }
    if (res.status === 402) {
      throw new Error('账户余额不足（402），请先充值');
    }
    throw new Error('HTTP ' + res.status + '：' + text.slice(0, 240));
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('接口返回不是 JSON：' + text.slice(0, 160));
  }
  const content = data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.content;
  if (!content) throw new Error('模型没有返回内容');
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error('模型输出不是合法 JSON：' + String(content).slice(0, 160));
  }
}

function buildAnnotatePrompt(change, items) {
  const sample = items.slice(0, 60).map(function (it) {
    return '- id=' + it.id + ' 「' + it.name + '」 type=' + it.type + ' 等级=' + it.level;
  }).join('\n');

  return [
    '影响集合已经由结构分析确定：下面这些节点一定会受影响，你不能增删节点。',
    '你的任务只有一件：为每个节点写一句中文说明，解释它为什么受影响、需要注意改什么。',
    '',
    '输出 JSON：',
    '{"summary":"整体一句话","reasons":[{"id":"1:392","why":"开关默认值变了，这个状态文案要同步"}]}',
    '',
    '规则：',
    '- id 必须来自下面的列表，禁止编造',
    '- 每条 why 不超过 30 字',
    '- 没把握的节点可以不写，但不要瞎猜',
    '- 只输出 JSON，不要 markdown 代码块',
    '',
    '变更：' + change,
    '',
    '受影响节点（共 ' + items.length + ' 个）：',
    sample
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 语义检索（AI）：按「变更需求」而不是按字面词，找语义相关的文本节点
//   两段式：先选区域 → 再在区域里选节点，避免一次性把全文文本塞给模型
// ---------------------------------------------------------------------------

const SEMANTIC_LEVELS = { strict: 'high', medium: 'medium', broad: 'low' };
const SEMANTIC_RANK = { low: 1, medium: 2, high: 3 };

let semanticLevelCache = null;
// 最近一次语义检索的统计，用于在影响栏里显示"断在哪一步"
let lastSemanticStats = { candidates: 0, hits: 0 };

async function loadSemanticLevel() {
  if (semanticLevelCache) return semanticLevelCache;
  try {
    const v = await figma.clientStorage.getAsync('dsh:semanticLevel');
    semanticLevelCache = SEMANTIC_LEVELS[v] ? v : 'medium';
  } catch (e) {
    semanticLevelCache = 'medium';
  }
  return semanticLevelCache;
}

async function saveSemanticLevel(level) {
  semanticLevelCache = SEMANTIC_LEVELS[level] ? level : 'medium';
  try { await figma.clientStorage.setAsync('dsh:semanticLevel', semanticLevelCache); } catch (e) { /* 忽略 */ }
  return semanticLevelCache;
}

/** 候选区域：页面 + 顶层画板/分组 */
function buildAreaList() {
  const areas = [];
  for (const page of figma.root.children) {
    areas.push({ id: page.id, name: page.name, kind: 'page' });
    if (!page.children) continue;
    for (const child of page.children) {
      if (areas.length >= 150) break;
      if (['FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET'].indexOf(child.type) < 0) continue;
      areas.push({ id: child.id, name: child.name, kind: child.type });
    }
  }
  return areas;
}

async function collectTextsInAreas(areaIds, limit) {
  const out = [];
  const seen = new Set();
  for (const areaId of areaIds) {
    if (out.length >= limit) break;
    let node = null;
    try { node = await figma.getNodeByIdAsync(areaId); } catch (e) { node = null; }
    if (!node) continue;

    let texts = [];
    try { texts = node.findAllWithCriteria({ types: ['TEXT'] }); } catch (e) { texts = []; }
    for (const t of texts) {
      if (out.length >= limit) break;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      let chars = '';
      try { chars = String(t.characters || ''); } catch (e) { chars = ''; }
      if (!chars.trim()) continue;
      out.push({
        id: t.id,
        text: chars.replace(/\s+/g, ' ').slice(0, 50),
        full: chars.slice(0, 500)      // 用来校验模型给的证据是否真的存在
      });
    }
  }
  return out;
}

/** 从需求里抽取「旧表述」中的英文术语（如 ICHLM / PLAYGM）。 */
function extractOldTermTokens(change) {
  const frags = extractQuotedFragments(change);
  const oldHint = frags.length ? String(frags[0]) : '';
  return (oldHint.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) || []).filter(function (w, i, arr) {
    return arr.indexOf(w) === i;
  });
}

/**
 * 旧术语的确定性扫描：整个文件里凡是包含该术语的文本都算命中。
 * 术语替换场景下"字面包含"就是正确判据，不需要模型猜。
 */
async function collectTermMatches(change, rootId, pageId) {
  const tokens = extractOldTermTokens(change);
  if (!tokens.length) return [];

  try { await figma.loadAllPagesAsync(); } catch (e) { /* 已加载 */ }

  const out = [];
  const seen = new Set([rootId]);
  for (const page of figma.root.children) {
    if (pageId && page.id !== pageId) continue;
    let texts = [];
    try { texts = page.findAllWithCriteria({ types: ['TEXT'] }); } catch (e) { texts = []; }
    for (const t of texts) {
      if (out.length >= 30) break;
      if (seen.has(t.id)) continue;
      seen.add(t.id);

      let chars = '';
      try { chars = String(t.characters || ''); } catch (e) { chars = ''; }
      if (!chars.trim()) continue;

      const lower = chars.toLowerCase();
      const hit = tokens.filter(function (tok) {
        return lower.indexOf(String(tok).toLowerCase()) >= 0;
      })[0];
      if (!hit) continue;

      out.push({
        id: t.id,
        relation: '同义替换',
        confidence: 'high',
        evidence: hit,
        why: '包含旧术语「' + hit + '」'
      });
    }
  }
  return out;
}

/** 需求里的中文 n-gram / 引号片段 / 英文术语，作为确定性筛选用。 */
const REQ_STOP = {
  '把': 1, '改为': 1, '改成': 1, '换成': 1, '文本': 1, '文案': 1, '相关': 1,
  '含义': 1, '表述': 1, '内容': 1, '这段': 1, '那句': 1, '所有': 1, '需要': 1,
  '进行': 1, '统一': 1, '这个': 1, '一条': 1, '指的': 1
};

function extractRequirementKeywords(change) {
  const raw = String(change || '');
  const set = [];

  function add(s) {
    const t = String(s || '').trim().replace(/^(把|将)/, '');
    if (t.length >= 2 && t.length <= 12 && set.indexOf(t) < 0) set.push(t);
  }

  for (const f of extractQuotedFragments(raw)) add(f);

  // "把 A 改为 B" 两侧都算关键词
  const parts = raw.split(/改为|改成|换成|变成/);
  if (parts.length >= 2) {
    add(parts[0]);
    add(parts[1]);
  }

  // 中文 n-gram：2~4 字全收（不再按长度截断，否则"机制/映射"这类短词会丢）
  const runs = raw.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of runs) {
    for (let n = 4; n >= 2; n--) {
      for (let i = 0; i + n <= run.length; i++) {
        const t = run.slice(i, i + n);
        if (REQ_STOP[t]) continue;
        add(t);
        if (set.length >= 60) return set;
      }
    }
  }

  return set;
}

/**
 * 用需求关键词在全文件筛候选文本（确定性），避免"先选区域"把整块画板漏掉。
 */
async function collectKeywordCandidates(change, rootId, extraTokens, pageId) {
  const keywords = extractRequirementKeywords(change);
  for (const t of (extraTokens || [])) {
    if (keywords.indexOf(t) < 0) keywords.push(t);
  }
  if (!keywords.length) return [];

  const lowerKeys = keywords.map(function (k) { return String(k).toLowerCase(); });

  try { await figma.loadAllPagesAsync(); } catch (e) { /* 已加载 */ }

  const out = [];
  const seen = new Set([rootId]);
  for (const page of figma.root.children) {
    if (pageId && page.id !== pageId) continue;
    let texts = [];
    try { texts = page.findAllWithCriteria({ types: ['TEXT'] }); } catch (e) { texts = []; }
    for (const t of texts) {
      if (out.length >= 150) break;
      if (seen.has(t.id)) continue;
      seen.add(t.id);

      let chars = '';
      try { chars = String(t.characters || ''); } catch (e) { chars = ''; }
      if (!chars.trim()) continue;

      const lower = chars.toLowerCase();
      let matched = '';
      for (let i = 0; i < lowerKeys.length; i++) {
        if (lower.indexOf(lowerKeys[i]) >= 0) { matched = keywords[i]; break; }
      }
      if (!matched) continue;

      out.push({
        id: t.id,
        text: chars.replace(/\s+/g, ' ').slice(0, 50),
        full: chars.slice(0, 500),
        matched: matched
      });
    }
  }
  return out;
}

/** 语义检索：返回 [{ id, relation, confidence, why, evidence }]，按等级过滤。 */
async function aiSemanticRetrieve(change, level, anchorText, pageId, rootId) {
  const wantRank = SEMANTIC_RANK[SEMANTIC_LEVELS[level] || 'medium'];

  // 从需求里抽出「旧表述」的锚定词：严格档要求节点必须真的提到它，
  // 避免"同一主题但根本不涉及旧术语"的节点被算成同一对象
  const frags = extractQuotedFragments(change);
  const oldHint = frags.length ? String(frags[0]) : '';
  const latinTokens = (oldHint.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) || []).filter(function (w, i, arr) {
    return arr.indexOf(w) === i;
  });
  const strictAnchorTokens = latinTokens.length ? latinTokens : (oldHint ? [oldHint] : []);

  // 候选池：先用需求里的关键词做确定性筛选，再交给模型判断。
  lastSemanticStats = { candidates: 0, hits: 0, keywords: 0, error: '' };
  let texts = [];
  try {
    lastSemanticStats.keywords = extractRequirementKeywords(change).length;
    texts = await collectKeywordCandidates(change, rootId, strictAnchorTokens, pageId);
  } catch (e) {
    lastSemanticStats.error = String((e && e.message) || e);
    texts = [];
  }

  // 关键词命中太少时补一批范围内的文本，避免候选池过窄导致语义召回归零
  if (texts.length < 15) {
    const areaIds = pageId
      ? [pageId]
      : figma.root.children.map(function (p) { return p.id; });
    let extra = [];
    try { extra = await collectTextsInAreas(areaIds, 150); } catch (e) {
      if (!lastSemanticStats.error) lastSemanticStats.error = String((e && e.message) || e);
      extra = [];
    }
    const seen = new Set(texts.map(function (t) { return t.id; }));
    for (const t of extra) {
      if (texts.length >= 150) break;
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      texts.push({ id: t.id, text: t.text, full: t.full, matched: '' });
    }
  }

  lastSemanticStats.candidates = texts.length;
  if (!texts.length) return [];

  send({ type: 'progress', text: '语义候选 ' + texts.length + ' 条，交给模型判断…' });

  const textLines = texts.map(function (t) {
    return '- id=' + t.id + (t.matched ? ' [命中:' + t.matched + ']' : '') + ' 「' + t.text + '」';
  }).join('\n');

  const levelRule = level === 'strict'
    ? '严：只列出与目标语义完全一致、改了不会误伤的节点；拿不准一律不列。'
    : level === 'broad'
      ? '宽：只要语义主题相关都列出（含上下位概念、近似说法），由用户自己筛。'
      : '中：列出同一概念或同一状态的等价表述；语境差异明显的不要列。';

  let raw = [];
  try {
    const r2 = await callModel([
      '你在做设计文案的语义关联判断。根据「变更需求」，找出清单里会随着这次变更而需要改的文本节点。',
      '',
      '重要：判断的是「这条文案会不会因为这次变更而变得不一致 / 失效」，不是「主题是否相关」。',
      '如果这次只是替换某个术语或措辞，那么只有**提到旧术语**或**明确指向同一处表述**的节点才需要改；',
      '仅仅是同一个主题、同一个产品的文案，不算。',
      '',
      '判断标准（等级）：' + levelRule,
      '',
      '每个节点必须给出：',
      '- relation：关系类型，只能取 [同义替换 / 同一对象 / 状态一致 / 引用同一定义 / 风格一致]',
      '- confidence：high / medium / low（high = 明确指同一实体或同一状态）',
      '- evidence：该节点原文里的一段话（逐字复制），用来证明它确实涉及这次变更',
      '- why：一句中文说明为什么它会跟着变（不超过 25 字）',
      '',
      '输出 JSON：',
      '{"nodes":[{"id":"1:392","relation":"状态一致","confidence":"high","evidence":"已开启","why":"同一开关的关闭态文案"}]}',
      '',
      '规则：',
      '- id 必须来自下面清单，禁止编造',
      '- evidence 必须逐字出现在该节点的原文里，否则这条会被丢弃',
      '- 最多 20 条；与本次变更无关的不要凑数',
      '- 只输出 JSON，不要 markdown 代码块',
      '',
      '变更需求：' + change,
      (anchorText ? '锚点原文：「' + String(anchorText).slice(0, 120) + '」' : ''),
      '',
      '候选文本：',
      textLines
    ].join('\n'));

    raw = Array.isArray(r2.nodes) ? r2.nodes : [];
  } catch (e) {
    return [];
  }

  const allowed = new Set(texts.map(function (t) { return t.id; }));
  const byId = new Map();
  for (const t of texts) byId.set(t.id, t);

  const out = [];
  for (const n of raw) {
    if (!n || typeof n.id !== 'string' || !allowed.has(n.id)) continue;

    const conf = String(n.confidence || 'low').toLowerCase();
    if (!SEMANTIC_RANK[conf]) continue;
    if (SEMANTIC_RANK[conf] < wantRank) continue;

    const meta = byId.get(n.id) || { full: '' };
    const full = String(meta.full || '');

    // 证据必须真的出现在原文里；严格档不接受"没有证据"的条目
    const evidence = String(n.evidence || '').trim();
    if (evidence) {
      if (full.indexOf(evidence) < 0) continue;
    } else if (level === 'strict') {
      continue;
    }

    // 严格档：节点必须真的提到旧术语，避免"同主题但无关"的节点混进来
    if (level === 'strict' && strictAnchorTokens.length) {
      const lowerFull = full.toLowerCase();
      const hit = strictAnchorTokens.some(function (t) {
        return lowerFull.indexOf(String(t).toLowerCase()) >= 0;
      });
      if (!hit) continue;
    }

    out.push({
      id: n.id,
      relation: String(n.relation || '').slice(0, 12),
      confidence: conf,
      evidence: evidence.slice(0, 40),
      why: String(n.why || '').slice(0, 60)
    });
    if (out.length >= 20) break;
  }

  // 模型一条都没给时，用关键词候选兜底，保证"有候选就有语义条目"
  if (!out.length) {
    let added = 0;
    for (const t of texts) {
      if (added >= 10) break;
      if (!t.matched) continue;
      if (t.id === rootId) continue;
      out.push({
        id: t.id,
        relation: '关键词命中',
        confidence: level === 'strict' ? 'high' : 'medium',
        evidence: t.matched,
        why: '包含需求关键词「' + t.matched + '」'
      });
      added++;
    }
  }

  return out;
}

async function aiAnalyze(changeText, showCallout, scope, analysisItems, anchorId) {
  const change = String(changeText || '').trim();
  const mode = scope || 'related';
  if (!change) {
    send({ type: 'aiError', text: '先写一句变更描述' });
    return;
  }
  const key = await readApiKey();
  if (!key) {
    send({ type: 'aiError', text: '还没有保存 API Key' });
    return;
  }
  if (!graph) await buildGraph();

  // 起点优先用「影响节点显示」传下来的那一次结果，避免重复计算导致口径分叉
  let rootId = (typeof anchorId === 'string' && graph.byId.has(anchorId)) ? anchorId : null;
  if (!rootId) {
    const selection = figma.currentPage.selection;
    if (selection.length === 1 && graph.byId.has(selection[0].id)) {
      rootId = selection[0].id;
    }
  }
  if (!rootId) {
    send({ type: 'aiError', text: '先在画布上选中变更源节点——影响集合由图传播确定，AI 只负责写说明' });
    return;
  }

  let draftItems = [];

  if (Array.isArray(analysisItems) && analysisItems.length) {
    // 直接沿用①给出的集合
    for (const it of analysisItems) {
      if (!it || typeof it.id !== 'string') continue;
      const rec = graph.byId.get(it.id);
      draftItems.push({
        id: it.id,
        name: (rec && rec.name) || it.name || it.id,
        type: (rec && rec.type) || it.type || 'TEXT',
        level: typeof it.level === 'number' ? it.level : 2,
        reason: it.reason || '',
        source: it.source || 'graph'
      });
    }
  } else {
    // 兜底：UI 没传（例如直接调用），自己算一遍结构影响
    send({ type: 'progress', text: '先用依赖图算精确影响集合…' });
    const impact = await computeImpact(rootId, 3, mode);
    for (const [id, meta] of impact) {
      const rec = graph.byId.get(id);
      if (!rec) continue;
      draftItems.push({
        id: id,
        name: rec.name,
        type: rec.type,
        level: meta.level,
        reason: meta.reason,
        source: meta.source || 'graph'
      });
    }
  }

  draftItems.sort(function (a, b) {
    return a.level - b.level || a.name.localeCompare(b.name);
  });

  // 文本锚点：额外做一次「按需求」的语义检索，结果追加在结构影响之后
  let rootNode = null;
  try { rootNode = await figma.getNodeByIdAsync(rootId); } catch (e) { rootNode = null; }

  // 范围在这里收敛：① 给出的是全文件结构集合，② 按范围裁剪
  draftItems = await filterItemsByScope(draftItems, rootNode, mode);

  // 补一刀：直接用画布扫描把同组件实例并进来（图边可能漏掉跨页实例）
  let scanAdded = 0;
  if (rootNode && mode !== 'node') {
    try {
      const scanned = await scanSameComponentInstances(rootNode);
      const have = new Set(draftItems.map(function (it) { return it.id; }));
      for (const inst of scanned) {
        if (have.has(inst.id)) continue;
        have.add(inst.id);
        scanAdded++;
        draftItems.push({
          id: inst.id,
          name: inst.name || inst.id,
          type: 'INSTANCE',
          level: 1,
          reason: '同组件的实例（画布扫描补充）',
          source: 'graph'
        });
      }
    } catch (e) { /* 忽略 */ }
    if (scanAdded) send({ type: 'progress', text: '画布扫描补充了 ' + scanAdded + ' 个同组件实例' });
  }

  let usedLevel = null;
  const allowSemantic = (mode === 'related' || mode === 'file');
  if (rootNode && rootNode.type === 'TEXT' && allowSemantic) {
    const level = await loadSemanticLevel();
    usedLevel = level;
    const anchorText = String(rootNode.characters || '');
    // 相关范围 → 语义只在本页找；整个文件 → 全文件
    const page = pageOf(rootNode);
    const pageId = (mode === 'related' && page) ? page.id : null;
    send({ type: 'progress', text: '按需求做语义检索（' + (level === 'strict' ? '严' : level === 'broad' ? '宽' : '中') + '）…' });
    lastSemanticStats = { candidates: 0, hits: 0 };
    let hits = [];
    try { hits = await aiSemanticRetrieve(change, level, anchorText, pageId, rootId); } catch (e) {
      lastSemanticStats.error = String((e && e.message) || e);
      hits = [];
    }
    lastSemanticStats.hits = hits.length;
    send({ type: 'progress', text: '语义命中 ' + hits.length + ' 条' });

    // 旧术语的字面扫描（确定性）：AI 检索可能漏掉区域
    let termHits = [];
    try { termHits = await collectTermMatches(change, rootId, pageId); } catch (e) { termHits = []; }

    if (termHits.length) {
      const merged = [];
      const seenHit = new Set();
      for (const h of termHits) {
        if (seenHit.has(h.id)) continue;
        seenHit.add(h.id);
        merged.push(h);
      }
      for (const h of hits) {
        if (seenHit.has(h.id)) continue;
        seenHit.add(h.id);
        merged.push(h);
      }
      hits = merged;
    }

    const existingIds = new Set(draftItems.map(function (it) { return it.id; }));
    for (const hit of hits) {
      if (existingIds.has(hit.id)) continue;          // 结构里已有，不重复
      let node = null;
      try { node = await figma.getNodeByIdAsync(hit.id); } catch (e) { node = null; }
      if (!node) continue;
      existingIds.add(hit.id);
      draftItems.push({
        id: hit.id,
        name: node.name,
        type: 'TEXT',
        level: 0,                                     // 0 = 语义
        reason: '语义·' + (hit.relation || '相关') + '（' + hit.confidence + '）：' + hit.why +
          (hit.evidence ? '（证据：「' + hit.evidence + '」）' : ''),
        source: 'semantic'
      });
    }
  }

  if (!draftItems.length) {
    send({ type: 'aiError', text: '既没有结构关系，也没有检索到语义相关的节点' });
    return;
  }

  send({ type: 'progress', text: '让 AI 为这 ' + draftItems.length + ' 个节点写说明…' });
  let result = null;
  try {
    result = await callModel(buildAnnotatePrompt(change, draftItems));
  } catch (err) {
    // 说明失败不影响影响集合：仍然把结构结果给用户
    send({ type: 'progress', text: 'AI 说明失败，仅展示结构影响：' + String((err && err.message) || err) });
  }

  const whyById = new Map();
  if (result && Array.isArray(result.reasons)) {
    for (const reason of result.reasons) {
      if (!reason || typeof reason.id !== 'string') continue;
      if (whyById.has(reason.id)) continue;
      whyById.set(reason.id, String(reason.why || '').slice(0, 60));
    }
  }
  let annotated = 0;
  for (const it of draftItems) {
    const why = whyById.get(it.id);
    if (why) {
      // 语义说明单独存，不覆盖图传播的理由：按钮视角永远显示"图"，
      // AI 只是在这之上追加一条说明
      it.aiWhy = why;
      annotated++;
    }
  }

  const items = [];
  let index = 0;
  for (const it of draftItems) {
    items.push({
      index: ++index,
      id: it.id,
      name: it.name,
      type: it.type,
      level: it.level,
      reason: it.reason,
      aiWhy: it.aiWhy || '',
      source: it.source
    });
  }
  // 语义（level 0）排在结构之后
  const orderOf = function (lv) { return lv === 0 ? 99 : lv; };
  items.sort(function (a, b) {
    return orderOf(a.level) - orderOf(b.level) || a.name.localeCompare(b.name);
  });

  const sessionId = 'AI' + Date.now().toString(36).toUpperCase();
  const drawn = await drawMarks(items, sessionId, showCallout !== false);

  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const it of items) counts[it.level] = (counts[it.level] || 0) + 1;

  const rootRec = graph.byId.get(rootId);
  const rootName = rootRec ? rootRec.name : rootId;

  try {
    figma.root.setPluginData('dsh:lastSession', JSON.stringify({
      sessionId, mode: 'ai', change, rootId, depth: 3,
      counts, drawn, createdAt: new Date().toISOString()
    }));
  } catch (e) { /* 忽略 */ }

  markAnalysisFresh();
  send({
    type: 'impact',
    data: {
      sessionId,
      mode: 'ai',
      change,
      summary: String((result && result.summary) || ''),
      rootId,
      rootName,
      depth: 3,
      scope: scope || 'related',
      semanticLevel: usedLevel,
      semantic: lastSemanticStats,
      scanAdded: scanAdded,
      items,
      counts,
      drawn,
      annotated
    }
  });
}

// ---------------------------------------------------------------------------
// M3：评审会话状态机
//    IDLE → REVIEWING → SETTLING → IDLE
//   状态写 figma.root 的插件数据，所有协作者打开插件看到同一个 phase
//   评审期冻结分析（只记录改动），发起者结算时对账 + 越界审计
// ---------------------------------------------------------------------------

const REVIEW_KEY = 'dsh:review';

let reviewSession = null;   // { id, phase, owner, ownerName, startedAt, marks[], log: Map }
let reviewListener = null;
let lastReport = null;

function currentUserInfo() {
  let user = null;
  try { user = figma.currentUser; } catch (e) { user = null; }
  return {
    id: (user && user.id) || 'unknown',
    name: (user && user.name) || '未知用户'
  };
}

/** 轻量指纹：用来判断"这个节点在这次评审里被人改过没有"。 */
function fingerprintNode(node) {
  try {
    const parts = [
      node.type,
      String(node.name || ''),
      Math.round(node.x || 0),
      Math.round(node.y || 0),
      Math.round(node.width || 0),
      Math.round(node.height || 0)
    ];
    if (node.type === 'TEXT') {
      const chars = String(node.characters || '');
      parts.push(chars.length, chars.slice(0, 24));
    }
    return parts.join('|');
  } catch (e) {
    return '';
  }
}

async function persistSession() {
  try {
    if (!reviewSession) {
      figma.root.setPluginData(REVIEW_KEY, '');
      return;
    }
    figma.root.setPluginData(REVIEW_KEY, JSON.stringify({
      id: reviewSession.id,
      phase: reviewSession.phase,
      owner: reviewSession.owner,
      ownerName: reviewSession.ownerName,
      startedAt: reviewSession.startedAt,
      marks: reviewSession.marks
    }));
  } catch (e) { /* 插件数据不可写时忽略 */ }
}

function loadSessionFromFile() {
  let raw = '';
  try { raw = figma.root.getPluginData(REVIEW_KEY) || ''; } catch (e) { raw = ''; }
  lastReport = null;
  if (!raw) { reviewSession = null; return; }
  try {
    const parsed = JSON.parse(raw);
    reviewSession = parsed && parsed.phase === 'REVIEWING' ? parsed : null;
    if (reviewSession) reviewSession.log = new Map();
  } catch (e) {
    reviewSession = null;
  }
}

function describeSession() {
  const me = currentUserInfo();
  return {
    phase: reviewSession ? reviewSession.phase : 'IDLE',
    id: reviewSession ? reviewSession.id : null,
    owner: reviewSession ? reviewSession.owner : null,
    ownerName: reviewSession ? reviewSession.ownerName : null,
    startedAt: reviewSession ? reviewSession.startedAt : null,
    isOwner: !!(reviewSession && reviewSession.owner === me.id),
    me: me.name,
    markCount: reviewSession ? reviewSession.marks.length : 0,
    logCount: reviewSession && reviewSession.log ? reviewSession.log.size : 0,
    report: lastReport
  };
}

function reviewListenerFn(event) {
  if (!reviewSession || reviewSession.phase !== 'REVIEWING') return;
  for (const change of event.documentChanges || []) {
    const id = change.id;
    if (!id) continue;
    if (!reviewSession.log.has(id)) reviewSession.log.set(id, new Set());
    const bucket = reviewSession.log.get(id);
    if (Array.isArray(change.properties)) {
      for (const prop of change.properties) bucket.add(prop);
    } else {
      bucket.add(change.type);
    }
  }
  send({ type: 'reviewTick', data: describeSession() });
}

function attachReviewListener() {
  if (reviewListener) return;
  reviewListener = reviewListenerFn;
  try { figma.on('documentchange', reviewListener); } catch (e) { reviewListener = null; }
}

function detachReviewListener() {
  if (!reviewListener) return;
  try { figma.off('documentchange', reviewListener); } catch (e) { /* 忽略 */ }
  reviewListener = null;
}

async function startReview(items) {
  if (reviewSession && reviewSession.phase === 'REVIEWING') {
    send({ type: 'review', data: describeSession() });
    return;
  }
  if (!Array.isArray(items) || !items.length) {
    send({ type: 'reviewError', text: '先做一次影响分析，再开始评审' });
    return;
  }

  const me = currentUserInfo();
  const marks = [];
  for (const item of items) {
    try {
      const node = await figma.getNodeByIdAsync(item.id);
      if (!node) continue;
      marks.push({
        id: item.id,
        level: item.level,
        reason: shortReason(item),
        fp: fingerprintNode(node)
      });
    } catch (e) { /* 跳过取不到的节点 */ }
  }
  if (!marks.length) {
    send({ type: 'reviewError', text: '标记节点都取不到，无法开始评审' });
    return;
  }

  reviewSession = {
    id: 'R' + Date.now().toString(36).toUpperCase(),
    phase: 'REVIEWING',
    owner: me.id,
    ownerName: me.name,
    startedAt: new Date().toISOString(),
    marks,
    log: new Map()
  };
  lastReport = null;
  attachReviewListener();
  await persistSession();
  send({ type: 'review', data: describeSession() });
  try { figma.notify('评审已开始：分析冻结，改动会被记录'); } catch (e) {}
}

async function endReview() {
  if (!reviewSession || reviewSession.phase !== 'REVIEWING') {
    send({ type: 'reviewError', text: '当前没有进行中的评审' });
    return;
  }
  const me = currentUserInfo();
  if (reviewSession.owner !== me.id) {
    send({ type: 'reviewError', text: '只有发起者（' + reviewSession.ownerName + '）可以结束评审' });
    return;
  }

  reviewSession.phase = 'SETTLING';
  send({ type: 'progress', text: '结算中：对账标记节点…' });

  const report = {
    id: reviewSession.id,
    ownerName: reviewSession.ownerName,
    startedAt: reviewSession.startedAt,
    total: reviewSession.marks.length,
    changed: [],
    unchangedCount: 0,
    deleted: [],
    outOfScope: []
  };

  const marked = new Set(reviewSession.marks.map(function (m) { return m.id; }));

  for (const mark of reviewSession.marks) {
    let node = null;
    try { node = await figma.getNodeByIdAsync(mark.id); } catch (e) { node = null; }
    if (!node) {
      report.deleted.push(mark.id);
      continue;
    }
    if (fingerprintNode(node) !== mark.fp) {
      report.changed.push({ id: mark.id, name: node.name, level: mark.level });
    } else {
      report.unchangedCount++;
    }
  }

  const log = reviewSession.log || new Map();
  for (const entry of log.entries()) {
    const id = entry[0];
    if (marked.has(id)) continue;
    let node = null;
    try { node = await figma.getNodeByIdAsync(id); } catch (e) { node = null; }
    if (!node) continue;
    if (typeof node.name === 'string' && node.name.indexOf(MARKS_PREFIX) === 0) continue;
    report.outOfScope.push({
      id,
      name: node.name,
      props: Array.from(entry[1]).slice(0, 6)
    });
  }

  lastReport = report;
  detachReviewListener();
  reviewSession = null;
  await persistSession();
  send({ type: 'review', data: describeSession() });
  try { figma.notify('评审已结算：改动 ' + report.changed.length + ' / 越界 ' + report.outOfScope.length); } catch (e) {}
}

/** 重开插件时，如果评审还在进行，按会话里记录的标记把画布重新标出来。 */
async function restoreMarksFromSession() {
  if (!reviewSession || reviewSession.phase !== 'REVIEWING') return;
  if (!Array.isArray(reviewSession.marks) || !reviewSession.marks.length) return;

  const items = [];
  let index = 0;
  for (const mark of reviewSession.marks) {
    let node = null;
    try { node = await figma.getNodeByIdAsync(mark.id); } catch (e) { node = null; }
    if (!node) continue;
    items.push({
      index: ++index,
      id: mark.id,
      name: node.name,
      type: node.type,
      level: mark.level,
      reason: mark.reason || ''
    });
  }
  if (!items.length) return;
  await drawMarks(items, reviewSession.id, true);
  send({ type: 'review', data: describeSession() });
}

// ---------------------------------------------------------------------------
// 启动副作用：必须放在文件末尾
// 上面有 let / const 声明（lastReport、REVIEW_KEY 等），在声明执行前访问会抛
// "X is not initialized" 的 ReferenceError（暂时性死区）。
// ---------------------------------------------------------------------------
loadAiSettings()
  .then(() => send({ type: 'keyStatus', data: describeAiStatus() }))
  .catch(() => {});
loadSemanticLevel()
  .then((level) => send({ type: 'semanticLevel', data: { level: level } }))
  .catch(() => {});
loadSessionFromFile();

// dynamic-page 模式下，必须先 loadAllPagesAsync 才能注册 documentchange 监听
figma.loadAllPagesAsync().catch(() => {}).then(() => {
  try { figma.on('documentchange', docChangeTracker); } catch (e) { /* 忽略 */ }

  if (reviewSession) {
    attachReviewListener();
    // 关闭面板时会清掉标记；若评审仍在进行，重开时按会话记录把标记画回来
    restoreMarksFromSession().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// M4：AI 生成结构化修改建议 → 校验 → 预览 → 一键应用（可整批撤销）
// ---------------------------------------------------------------------------

const EDIT_KINDS = {
  text: true, variant: true, boolean: true, visible: true,
  fill: true, opacity: true, radius: true, font: true, size: true, spacing: true
};

// ---- 基础属性的读写工具 ----

function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

function rgbToHex(color) {
  if (!color) return '';
  const to = function (v) {
    const n = Math.round(clamp01(v) * 255);
    return ('0' + n.toString(16)).slice(-2);
  };
  return ('#' + to(color.r) + to(color.g) + to(color.b)).toUpperCase();
}

function hexToRgb(hex) {
  const s = String(hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255
  };
}

function sameNumber(a, b) {
  return Math.abs(Number(a) - Number(b)) <= 0.5;
}

/**
 * from 只用于防呆，真正决定改哪里的是 nodeId。
 * 模型常常抄错/串行当前值（尤其同名节点），这里按实际值校正并记录原值，
 * 不因为"抄错旧值"就整条作废。
 */
function acceptFrom(edit, actual) {
  const shown = typeof actual === 'number'
    ? String(Math.round(actual * 100) / 100)
    : String(actual);
  if (String(edit.from) !== shown) {
    edit.correctedFrom = edit.from;
    edit.from = shown;
  }
}

/** 读取节点上"可被机器改"的基础属性，拼成一行摘要给模型看。 */
function describeEditableProps(node) {
  const parts = [];
  try {
    if (Array.isArray(node.fills) && node.fills.length) {
      if (node.fills[0].type === 'SOLID') {
        parts.push('fill=' + rgbToHex(node.fills[0].color));
      } else {
        // 图片/渐变填充：不能改颜色，但透明度可以改
        parts.push('fill=(' + String(node.fills[0].type || '非纯色') + ')');
      }
    }
  } catch (e) { /* 混合填充 */ }
  try {
    // 默认值也要列出来，否则模型不知道这个属性可改（例如 opacity=1 时想改成 0）
    if (typeof node.opacity === 'number') {
      parts.push('opacity=' + Math.round(node.opacity * 100) / 100);
    }
  } catch (e) { /* 忽略 */ }
  try {
    if (typeof node.cornerRadius === 'number') {
      parts.push('radius=' + Math.round(node.cornerRadius));
    }
  } catch (e) { /* 混合圆角 */ }
  try {
    if (node.type === 'TEXT') {
      const fs = node.fontSize;
      parts.push('fontSize=' + (typeof fs === 'number' ? Math.round(fs * 100) / 100 : '(混合)'));
    }
  } catch (e) { /* 忽略 */ }
  try {
    if (node.type === 'TEXT') {
      const fn = node.fontName;
      // 用 | 分隔 family / style，避免 "Semi Bold" 这类带空格的样式名歧义
      parts.push('font=' + (fn === figma.mixed
        ? '(混合)'
        : fn.family + '|' + fn.style));
    }
  } catch (e) { /* 忽略 */ }
  try {
    if (node.layoutMode && node.layoutMode !== 'NONE') {
      parts.push('spacing=' + Math.round(node.itemSpacing || 0));
    }
  } catch (e) { /* 忽略 */ }
  try {
    if ((node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') &&
        typeof node.width === 'number' && typeof node.height === 'number') {
      parts.push('size=' + Math.round(node.width) + 'x' + Math.round(node.height));
    }
  } catch (e) { /* 忽略 */ }
  return parts.length ? '  可改: ' + parts.join('; ') : '';
}

/** 盘点"可被机器修改"的对象，带上当前值，供模型生成 from→to 指令。 */
/**
 * 以「影响分析的结果」为唯一候选池：只在这些节点里挑需要跟着改的。
 * 这样建议和画布上的红/橙/黄标记是同一批对象，不会再和影响分析脱节。
 */
async function buildFocusedDigest(anchorId, impactItems) {
  const ids = new Set();
  const lines = [];
  lines.push('【已分析出的受影响对象】影响分析已经圈定的节点，只在这里面挑');
  const levelName = { 0: '语义', 1: '直接', 2: '间接', 3: '潜在' };

  let anchorPageId = null;
  try {
    const a = anchorId ? await figma.getNodeByIdAsync(anchorId) : null;
    const p = a ? pageOf(a) : null;
    anchorPageId = p ? p.id : null;
  } catch (e) { anchorPageId = null; }
  const crossIds = [];

  for (const item of impactItems) {
    if (!item || typeof item.id !== 'string') continue;
    let node = null;
    try { node = await figma.getNodeByIdAsync(item.id); } catch (e) { node = null; }
    if (!node) {
      // 读不到节点也不能从清单里丢掉：否则模型看不到它，更不可能给它出指令
      ids.add(item.id);
      lines.push('- 「' + (item.name || item.id) + '」 type=' + (item.type || '?') +
        ' id=' + item.id + '  （节点当前不可读，只能按 id 处理）');
      continue;
    }

    let extra = '';
    if (node.type === 'INSTANCE') {
      let cp = {};
      try { cp = node.componentProperties || {}; } catch (e) { cp = {}; }
      const keys = Object.keys(cp);
      if (keys.length) {
        extra = '  属性: ' + keys.map(function (key) {
          return key + '(' + (cp[key].type || '?') + ')=' + String(cp[key].value);
        }).join('; ');
      } else {
        extra = '  （无组件属性，只能改显隐）';
      }
    } else if (node.type === 'TEXT') {
      const chars = String(node.characters || '');
      if (!chars || !chars.trim()) continue;
      // 长文本也要收：只展示开头，改局部时用 from 片段或 range
      const preview = chars.length > 60 ? chars.slice(0, 60) + '…（共 ' + chars.length + ' 字）' : chars;
      extra = '  文本: 「' + preview + '」' + (chars.length > 60 ? '（长文本，改局部请用 from 片段或 range）' : '');
    } else {
      extra = '  （图形节点）';
    }

    // 基础属性（fill / opacity / radius / fontSize / spacing / size）拼进同一行
    extra += describeEditableProps(node);

    ids.add(node.id);
    const isSemantic = item.source === 'semantic' || item.level === 0;
    const recPage = graph && graph.byId.get(node.id);
    if (anchorPageId && recPage && recPage.pageId && recPage.pageId !== anchorPageId) {
      crossIds.push(node.id);
    }
    // 同组件的实例：跨页面也要同步，单独标出来，避免模型当成"无关节点"跳过
    const isInstanceOf = /组件的实例|引用了当前组件/.test(String(item.reason || ''));
    lines.push('- [' + (levelName[item.level] || '') + ']' +
      (isSemantic ? '【语义检索命中】' : '') +
      (isInstanceOf ? '【同组件实例·需与锚点保持一致】' : '') +
      ' 「' + node.name + '」 type=' + node.type + ' id=' + node.id + extra +
      (item.reason ? '  影响原因: ' + item.reason : ''));
  }

  // 锚点也放进来（它本身往往就是第一个要改的）；
  // 若①已经把锚点放进集合了，就不再重复插一条
  const anchorAlready = impactItems.some(function (it) {
    return it && it.id === anchorId;
  });
  if (anchorId && !anchorAlready) {
    let anchor = null;
    try { anchor = await figma.getNodeByIdAsync(anchorId); } catch (e) { anchor = null; }
    if (anchor) {
      ids.add(anchor.id);

      let anchorExtra = '';
      let cp = {};
      try { cp = anchor.componentProperties || {}; } catch (e) { cp = {}; }
      const keys = Object.keys(cp);
      if (keys.length) {
        anchorExtra += '  属性: ' + keys.map(function (key) {
          return key + '(' + (cp[key].type || '?') + ')=' + String(cp[key].value);
        }).join('; ');
      }
      if (anchor.type === 'TEXT') {
        const chars = String(anchor.characters || '');
        const preview = chars.length > 60 ? chars.slice(0, 60) + '…（共 ' + chars.length + ' 字）' : chars;
        anchorExtra += '  文本: 「' + preview + '」';
      }
      // 关键：锚点同样要列出可改的基础属性，否则模型看不出它能调透明度/圆角等
      anchorExtra += describeEditableProps(anchor);

      lines.unshift('【本次变更的锚点】它本身也是可改对象，优先考虑');
      lines.splice(1, 0, '- 「' + anchor.name + '」 type=' + anchor.type + ' id=' + anchor.id + anchorExtra);
      lines.splice(2, 0, '');
    }
  }

  let crossPage = 0;
  if (anchorPageId) {
    for (const id of ids) {
      const rec = graph && graph.byId.get(id);
      if (rec && rec.pageId && rec.pageId !== anchorPageId) crossPage++;
    }
  }

  // 把跨页节点单独提到最前面，避免它们埋在长清单里被忽略
  if (crossIds.length) {
    lines.splice(1, 0,
      '【跨页同组件节点】共 ' + crossIds.length + ' 个，必须逐个检查（不需要改就在 summary 说明原因）：' +
      crossIds.slice(0, 20).join('、'));
  }

  return {
    text: lines.join('\n'),
    ids: ids,
    allowedIds: ids,
    stats: { focus: ids.size, crossPage: crossPage }
  };
}

async function buildEditableDigest(anchorId, scope) {
  if (!graph) await buildGraph();
  try { await figma.loadAllPagesAsync(); } catch (e) { /* 已加载 */ }

  // 先解析锚点：related 范围要靠它的页面来收窄
  let anchorNode = null;
  let anchorPageId = null;
  let anchorComponentId = null;
  if (anchorId) {
    try { anchorNode = await figma.getNodeByIdAsync(anchorId); } catch (e) { anchorNode = null; }
    if (anchorNode) {
      const pg = pageOf(anchorNode);
      anchorPageId = pg ? pg.id : null;
      if (anchorNode.type === 'INSTANCE') {
        try {
          const main = await anchorNode.getMainComponentAsync();
          if (main) anchorComponentId = main.id;
        } catch (e) { /* 跨文件组件 */ }
      }
    }
  }
  const related = scope === 'related' && !!anchorPageId;

  // 锚点所在的顶层画板（比"整页"窄得多），以及它的全部后代 id
  const insideIds = new Set();
  let anchorKeywords = [];
  if (anchorNode) {
    let container = anchorNode;
    while (container && container.parent && container.parent.type !== 'PAGE') {
      container = container.parent;
    }
    if (container) {
      insideIds.add(container.id);
      try {
        for (const n of container.findAll(function () { return true; })) insideIds.add(n.id);
      } catch (e) { /* 容器没有子节点 */ }
      // 关键词：锚点名 + 容器名，用来把"画板外但语义相关"的节点也捞进来
      const raw = String(anchorNode.name || '') + ' ' + String(container.name || '');
      const latin = raw.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [];
      const cjk = raw.match(/[\u4e00-\u9fff]{2,}/g) || [];
      const drop = { '开关': 1, '设置': 1, '按钮': 1, '标题': 1, '内容': 1, '文本': 1, '组件': 1, '实例': 1, '页面': 1, 'Frame': 1, 'Group': 1 };
      const set = new Set();
      for (const w of latin) { if (!drop[w]) set.add(w); }
      for (const run of cjk) {
        for (let n = 2; n <= Math.min(4, run.length); n++) {
          for (let i = 0; i + n <= run.length; i++) {
            const token = run.slice(i, i + n);
            if (!drop[token]) set.add(token);
          }
        }
      }
      anchorKeywords = Array.from(set).slice(0, 24);
    }
  }

  function matchesKeywords(text) {
    if (!anchorKeywords.length) return false;
    const s = String(text || '');
    for (const key of anchorKeywords) {
      if (key && s.indexOf(key) >= 0) return true;
    }
    return false;
  }

  const lines = [];
  const ids = new Set();
  const sets = [];
  const instances = [];
  const instTexts = [];   // 实例内部的文本：状态文案大多在这里
  const otherTexts = [];

  for (const rec of graph.nodes) {
    if (rec.type === 'COMPONENT_SET') {
      if (sets.length < 20) sets.push(rec);
    } else if (rec.type === 'INSTANCE') {
      if (instances.length < 120) instances.push(rec);
    } else if (rec.type === 'TEXT') {
      if (rec.id.indexOf('I') === 0) {
        if (instTexts.length < 80) instTexts.push(rec);
      } else if (otherTexts.length < 120) {
        otherTexts.push(rec);
      }
    }
  }

  const texts = instTexts.concat(otherTexts);

  lines.push('【组件集】');
  for (const rec of sets) {
    let node = null;
    try { node = await figma.getNodeByIdAsync(rec.id); } catch (e) { node = null; }
    if (!node) continue;
    let desc = '';
    try {
      const props = node.variantGroupProperties || {};
      desc = Object.keys(props).map(function (key) {
        return key + '=' + ((props[key] && props[key].values) || []).join('|');
      }).join('; ');
    } catch (e) { desc = ''; }
    ids.add(rec.id);
    lines.push('- 组件集「' + rec.name + '」 id=' + rec.id +
      (desc ? '  变体属性: ' + desc : '') + '  （本体：不能直接改变体，改变体请用实例 id）');
  }

  lines.push('');

  // 专门全量扫描「带 BOOLEAN 属性的实例」，不依赖上面按图顺序截断的列表
  const boolRows = [];
  const otherRows = [];
  const seenIds = new Set();
  const prevSkip = figma.skipInvisibleInstanceChildren;
  try { figma.skipInvisibleInstanceChildren = false; } catch (e) { /* 忽略 */ }

  for (const page of figma.root.children) {
    if (boolRows.length >= 60) break;
    if (related && page.id !== anchorPageId) continue;
    let pageInstances = [];
    try {
      pageInstances = page.findAllWithCriteria({ types: ['INSTANCE'] });
    } catch (e) {
      pageInstances = [];
    }
    for (const inst of pageInstances) {
      if (boolRows.length >= 60) break;
      let cp = {};
      try { cp = inst.componentProperties || {}; } catch (e) { cp = {}; }
      const keys = Object.keys(cp);
      const hasBool = keys.some(function (key) {
        return cp[key] && cp[key].type === 'BOOLEAN';
      });
      if (!hasBool) continue;

      let mainName = '';
      let mainId = null;
      try {
        const main = await inst.getMainComponentAsync();
        if (main) { mainName = main.name; mainId = main.id; }
      } catch (e) { /* 跨文件组件取不到 */ }

      // related：只要锚点画板内的，或和锚点同组件的
      if (related && !insideIds.has(inst.id) && !(anchorComponentId && mainId === anchorComponentId)) {
        continue;
      }
      if (seenIds.has(inst.id)) continue;
      seenIds.add(inst.id);

      const desc = keys.map(function (key) {
        return key + '(' + (cp[key].type || '?') + ')=' + String(cp[key].value);
      }).join('; ');

      ids.add(inst.id);
      boolRows.push('- 实例「' + inst.name + '」 id=' + inst.id +
        (mainName ? '  主组件:「' + mainName + '」' : '') + '  属性: ' + desc);
    }
  }
  try { figma.skipInvisibleInstanceChildren = prevSkip; } catch (e) { /* 忽略 */ }

  // 其余实例（只有变体等属性），从图里取
  for (const rec of instances) {
    if (seenIds.has(rec.id)) continue;
    // related：只收锚点画板内的实例
    if (related && !insideIds.has(rec.id)) continue;
    let node = null;
    try { node = await figma.getNodeByIdAsync(rec.id); } catch (e) { node = null; }
    if (!node) continue;

    let cp = {};
    try { cp = node.componentProperties || {}; } catch (e) { cp = {}; }
    const keys = Object.keys(cp);
    if (!keys.length) continue;

    const desc = keys.map(function (key) {
      return key + '(' + (cp[key].type || '?') + ')=' + String(cp[key].value);
    }).join('; ');

    let mainName = '';
    for (const edge of (graph.outAdj.get(rec.id) || [])) {
      if (edge.type !== 'instance') continue;
      const comp = graph.byId.get(edge.to);
      if (comp) { mainName = comp.name; break; }
    }

    seenIds.add(rec.id);
    ids.add(rec.id);
    otherRows.push('- 实例「' + rec.name + '」 id=' + rec.id +
      (mainName ? '  主组件:「' + mainName + '」' : '') + '  属性: ' + desc);
  }

  lines.push('【可改布尔属性的实例】开关的"默认值"一般属于这一类，用 kind=boolean');
  lines.push(boolRows.length ? boolRows.join('\n') : '（这个文件里没有任何实例带 BOOLEAN 属性）');
  lines.push('');
  lines.push('【其它实例】只有变体属性等，用 kind=variant');
  lines.push(otherRows.length ? otherRows.join('\n') : '（无）');

  const stats = {
    boolInstances: boolRows.length,
    otherInstances: otherRows.length,
    componentSets: sets.length
  };

  lines.push('');
  lines.push('【文本】');
  for (const rec of texts) {
    if (related && rec.pageId !== anchorPageId) continue;
    let node = null;
    try { node = await figma.getNodeByIdAsync(rec.id); } catch (e) { node = null; }
    if (!node || node.type !== 'TEXT') continue;
    let chars = '';
    try { chars = String(node.characters || ''); } catch (e) { chars = ''; }
    // 只收短文本：长段落不可能是"开关状态文案"，而且 from 必须精确匹配
    if (!chars || chars.length > 40) continue;
    // related：只收锚点所在画板内的，或命中关键词的文本
    if (related && !insideIds.has(rec.id) && !matchesKeywords(chars)) continue;
    ids.add(rec.id);
    lines.push('- 「' + chars + '」 id=' + rec.id);
  }

  // ---- 锚点：用户当前选中的节点，优先围绕它工作 ----
  const anchorLines = [];
  const allowedIds = new Set();

  if (scope === 'file') {
    for (const id of ids) allowedIds.add(id);
  }

  if (anchorId) {
    let anchor = null;
    try { anchor = await figma.getNodeByIdAsync(anchorId); } catch (e) { anchor = null; }

    if (anchor) {
      let cp = {};
      try { cp = anchor.componentProperties || {}; } catch (e) { cp = {}; }
      const propKeys = Object.keys(cp);
      const propDesc = propKeys.length
        ? propKeys.map(function (key) {
            return key + '(' + (cp[key].type || '?') + ')=' + String(cp[key].value);
          }).join('; ')
        : '（无组件属性）';

      let mainName = '';
      if (anchor.type === 'INSTANCE') {
        try {
          const main = await anchor.getMainComponentAsync();
          if (main) mainName = main.name;
        } catch (e) { /* 跨文件组件 */ }
      }

      anchorLines.push('【本次变更的锚点】' + (scope === 'node' ? '只在这个范围内改' : '围绕它工作'));
      anchorLines.push('- 「' + anchor.name + '」 type=' + anchor.type + ' id=' + anchor.id +
        (mainName ? '  主组件:「' + mainName + '」' : ''));
      anchorLines.push('  属性: ' + propDesc);

      // 锚点自身必须进清单，否则针对它的建议会被判"不在清单里"
      ids.add(anchor.id);

      if (scope === 'node' || scope === 'related') allowedIds.add(anchor.id);

      if (scope !== 'file') {
        const innerTexts = [];
        try {
          const all = anchor.findAll(function (n) { return n.type === 'TEXT'; });
          for (const t of all) {
            if (innerTexts.length >= 20) break;
            const chars = String(t.characters || '');
            if (!chars || chars.length > 40) continue;
            innerTexts.push('- 内部文本「' + chars + '」 id=' + t.id);
            ids.add(t.id);
            if (scope === 'node' || scope === 'related') allowedIds.add(t.id);
          }
        } catch (e) { /* 没有子节点 */ }
        if (innerTexts.length) {
          anchorLines.push('  内部文本：');
          for (const line of innerTexts) anchorLines.push('  ' + line);
        }
      }

      if (scope === 'instances') {
        let compId = null;
        if (anchor.type === 'INSTANCE') {
          try {
            const main = await anchor.getMainComponentAsync();
            if (main) compId = main.id;
          } catch (e) { /* 忽略 */ }
        }
        allowedIds.add(anchor.id);
        if (compId) {
          const prev = figma.skipInvisibleInstanceChildren;
          try { figma.skipInvisibleInstanceChildren = false; } catch (e) { /* 忽略 */ }
          for (const page of figma.root.children) {
            let list = [];
            try { list = page.findAllWithCriteria({ types: ['INSTANCE'] }); } catch (e) { list = []; }
            for (const inst of list) {
              if (inst.id === anchor.id) continue;
              let main2 = null;
              try { main2 = await inst.getMainComponentAsync(); } catch (e) { main2 = null; }
              if (main2 && main2.id === compId) allowedIds.add(inst.id);
            }
          }
          try { figma.skipInvisibleInstanceChildren = prev; } catch (e) { /* 忽略 */ }
        }
      }
    }
  }

  // related：清单已经按锚点所在页面收窄过，整份清单都可改
  if (scope === 'related') {
    for (const id of ids) allowedIds.add(id);
  }

  const finalText = (anchorLines.length ? anchorLines.join('\n') + '\n\n' : '') + lines.join('\n');

  return {
    text: finalText,
    ids: ids,
    allowedIds: allowedIds.size ? allowedIds : null,
    stats: stats
  };
}

/** 收集某个节点及其全部后代的 id，用于"仅选中节点"范围过滤。 */
async function collectSubtreeIds(rootId) {
  const ids = new Set([rootId]);
  try {
    const node = await figma.getNodeByIdAsync(rootId);
    if (node && typeof node.findAll === 'function') {
      for (const child of node.findAll(function () { return true; })) ids.add(child.id);
    }
  } catch (e) { /* 没有子节点 */ }
  return ids;
}

function extractQuotedFragments(text) {
  const out = [];
  const s = String(text || '');
  // 支持：中文方头括号【】、方括号[]、直角引号「」『』、弯引号“”、直引号"" 与 ''
  const re = /「([^」]{1,30})」|『([^』]{1,30})』|【([^】]{1,30})】|\[([^\]]{1,30})\]|“([^”]{1,30})”|"([^"]{1,30})"|'([^']{1,30})'/g;
  let m = null;
  while ((m = re.exec(s)) !== null) {
    const frag = String(m[1] || m[2] || m[3] || m[4] || m[5] || m[6] || m[7] || '').trim();
    if (frag && out.indexOf(frag) < 0) out.push(frag);
  }
  return out;
}

function buildEditPrompt(change, digestText, scopeText) {
  return [
    '你是设计变更执行助手。用户描述了一次变更，你要给出可以机器执行的修改指令。',
    '',
    '下面列出文件里可编辑的对象（id + 当前值）。可执行的操作：',
    '1. text    —— 改文本内容，值是字符串',
    '2. variant —— 改实例的变体属性（VARIANT），需要 property 字段，值是变体名（字符串）',
    '3. boolean —— 改实例的布尔属性（BOOLEAN），需要 property 字段，值是 true / false',
    '4. visible —— 改显隐，值是 true / false',
    '5. fill    —— 改纯色填充，from / to 都是 #RRGGBB（大写）',
    '6. opacity —— 改不透明度，from / to 是 0~1 的数字',
    '7. radius  —— 改圆角，from / to 是数字（px）',
    '8. font    —— 改字号 / 行高 / 字体，需要 property 字段：',
    '              property="fontSize" 或 "lineHeight" 时，值是数字；',
    '              property="fontName" 时，from / to 都是 "Family|Style" 格式，例如 "Inter|Bold"',
    '              换字体不需要加载原字体，所以原字体缺失也能换',
    '9. size    —— 改尺寸，from / to 都是 "宽x高"，例如 "320x48"',
    '10. spacing —— 改 auto-layout 间距，需要 property 字段（itemSpacing / paddingTop / paddingBottom / paddingLeft / paddingRight），值是数字',
    '',
    '清单里每条会带「可改: fill=#FFFFFF; radius=8; ...」，只有列出来的属性才能改。',
    '清单里每个属性都标了类型，例如 `Property 1(BOOLEAN)=true`、`State(VARIANT)=Default`。',
    '开关的「默认值」几乎都是 BOOLEAN 属性：变更描述说的是默认值/默认状态时，',
    '必须在【可改布尔属性的实例】里找 BOOLEAN 属性，用 kind=boolean，不要用 variant 顶替。',
    '只有当目标实例根本没有 BOOLEAN 属性时，才退回 variant。',
    '',
    '规则：',
    '- nodeId 必须来自下面的清单，禁止编造',
    '- from 必须和清单里的当前值完全一致（大小写、空格都要一致）',
    '- from 与 to 不能相同：相同就是无效指令，会被直接丢弃',
    '- text 的 from 可以是整段文本，也可以是其中的一小段（会做局部替换），但必须是当前文本里真实存在的片段',
    '- 清单里标了【同组件实例·需与锚点保持一致】的节点，是同一个组件的其它实例（可能在其他页面）；' +
      '逐个检查它的当前属性值：**只要和锚点目标值不同，就必须给出一条同步指令**，不要因为"它在别的页面"而跳过',
    '- 如果某个节点已经是目标状态，就不要为它输出指令（禁止 from = to 的空操作）；' +
      '如果清单里所有节点都已经是目标状态，返回 {"summary":"...","edits":[]} 并说明原因',
    '- 清单里标了【语义检索命中】的节点，是检索出来的、可能和本次变更相关的文案；' +
      '只要它确实需要同步修改（例如含有旧术语、或同一处表述要统一），**同样要给出一条指令**，不要跳过',
    '- 变更描述通常说的是锚点本身（例如"把透明度改成 0"），锚点必须优先处理；只有确实需要时才改其它受影响节点',
    '- 清单里可能有同名节点：id 和当前值必须取自**同一行**，不要串行',
    '- 清单里的 opacity / radius / fill / size / fontSize 就是当前值；即使是默认值（如 opacity=1、radius=0）也完全可以改',
    '- 数值类（fontSize / lineHeight / opacity / radius / spacing / size）必须使用清单里「可改:」给出的当前值，不要自行推测',
    '- 清单里显示 (混合) 的字体或字号，说明整段不统一：只能配合 range 改局部',
    '- 改字体用 property="fontName"，格式 "Family|Style"；中文字体名可以直接写（如 "宋体|Bold"），插件会做别名映射',
    '- 只想改句中某个词时，在 font 指令里加 "range":"那个词"，只会给这一段应用字体或字号，不影响整句',
    '- 变体（variant）和布尔属性（boolean）只能改「实例」：组件本体、组件集的 id 不能用于这两类，请给出它们所有实例的 id，每个实例单独一条',
    '- 除了控件本体，还要找跟着变的地方：状态文案、说明文字、依赖该状态的显隐元素',
    '- 跨页面不是跳过理由：清单里同组件的实例即使分散在不同页面，只要状态需要同步就必须给指令；' +
      '真正要排除的是与本次状态无关的内容页（帮助中心、FAQ、营销页、法务页），不是"其它页面"这个属性',
    '- 拿不准的不要选，宁缺毋滥',
    '- 最多 30 条，只改真正需要跟着变的地方',
    '- why 用一句中文说明为什么改',
    '- 只输出 JSON，不要 markdown 代码块',
    '',
    '输出格式：',
    '{"summary":"一句话概述","edits":[{"nodeId":"1:392","kind":"text","from":"已开启","to":"已关闭","why":"开关状态文案"}]}',
    '',
    scopeText,
    '',
    '可编辑对象与锚点：',
    digestText,
    '',
    '变更描述：',
    change
  ].join('\n');
}

/** 逐条校验模型给的指令；不通过的不应用，只把原因带回去。 */
async function validateEdit(raw, allowedIds) {
  const edit = {
    id: raw && raw.nodeId,
    kind: raw && raw.kind,
    property: raw && raw.property,
    from: raw && raw.from,
    to: raw && raw.to,
    why: String((raw && raw.why) || ''),
    name: '',
    valid: false,
    reason: ''
  };

  if (!raw || typeof edit.id !== 'string' || !allowedIds.has(edit.id)) {
    edit.reason = '节点不在清单里';
    return edit;
  }
  if (!EDIT_KINDS[edit.kind]) {
    edit.reason = '不支持的操作类型：' + edit.kind;
    return edit;
  }

  let node = null;
  try { node = await figma.getNodeByIdAsync(edit.id); } catch (e) { node = null; }
  if (!node) {
    edit.reason = '节点不存在';
    return edit;
  }
  edit.name = node.name;

  if (EXTRA_KINDS[edit.kind]) return validateExtraEdit(edit, node);

  if (edit.kind === 'text') {
    if (node.type !== 'TEXT') { edit.reason = '不是文本节点'; return edit; }
    if (typeof edit.to !== 'string') { edit.reason = '目标值不是字符串'; return edit; }
    const current = String(node.characters || '');
    const fromStr = String(edit.from);
    // 允许两种情况：整段替换（from = 全部文本），或局部替换（from 是其中一段）
    if (current !== fromStr && current.indexOf(fromStr) < 0) {
      edit.reason = '当前文本里找不到建议的 from';
      return edit;
    }
    edit.valid = true;
    return edit;
  }

  if (edit.kind === 'variant') {
    if (node.type !== 'INSTANCE') { edit.reason = '不是实例节点'; return edit; }
    if (!edit.property) { edit.reason = '缺少 property'; return edit; }
    let cp = {};
    try { cp = node.componentProperties || {}; } catch (e) { cp = {}; }
    if (!cp[edit.property]) { edit.reason = '实例没有变体属性「' + edit.property + '」'; return edit; }
    if (String(cp[edit.property].value) !== String(edit.from)) {
      acceptFrom(edit, cp[edit.property].value);
    }
    edit.valid = true;
    return edit;
  }

  if (edit.kind === 'boolean') {
    if (node.type !== 'INSTANCE') { edit.reason = '不是实例节点'; return edit; }
    if (!edit.property) { edit.reason = '缺少 property'; return edit; }
    let cp = {};
    try { cp = node.componentProperties || {}; } catch (e) { cp = {}; }
    if (!cp[edit.property]) { edit.reason = '实例没有属性「' + edit.property + '」'; return edit; }
    if (cp[edit.property].type !== 'BOOLEAN') {
      edit.reason = '属性「' + edit.property + '」不是布尔类型（实际 ' + cp[edit.property].type + '）';
      return edit;
    }
    if (typeof edit.to !== 'boolean') { edit.reason = '目标值必须是 true / false'; return edit; }
    if (Boolean(cp[edit.property].value) !== Boolean(edit.from)) {
      acceptFrom(edit, cp[edit.property].value);
    }
    edit.valid = true;
    return edit;
  }

  if (edit.kind === 'visible') {
    if (typeof edit.to !== 'boolean') { edit.reason = '目标值必须是 true / false'; return edit; }
    if (Boolean(node.visible) !== Boolean(edit.from)) {
      acceptFrom(edit, node.visible ? 'true' : 'false');
    }
    edit.valid = true;
    return edit;
  }

  edit.reason = '未通过校验';
  return edit;
}

function invalidEdit(raw, reason) {
  return {
    id: (raw && raw.nodeId) || '',
    kind: (raw && raw.kind) || '',
    property: raw && raw.property,
    from: raw && raw.from,
    to: raw && raw.to,
    why: String((raw && raw.why) || ''),
    name: '',
    valid: false,
    reason: reason
  };
}

/**
 * 模型如果把变体改动指到了「组件本体 / 组件集」，自动展开成它的所有实例。
 * 组件本体没有变体属性可写，只有实例才有。
 */
async function expandVariantToInstances(node, raw) {
  const componentIds = [];
  if (node.type === 'COMPONENT_SET') {
    for (const child of node.children) {
      if (child.type === 'COMPONENT') componentIds.push(child.id);
    }
  } else {
    componentIds.push(node.id);
  }

  const instanceIds = [];
  const seen = new Set();
  for (const cid of componentIds) {
    for (const edge of (graph.inAdj.get(cid) || [])) {
      if (edge.type !== 'instance') continue;
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      instanceIds.push(edge.from);
    }
  }

  const valid = [];
  let lastReason = '';
  for (const iid of instanceIds.slice(0, 30)) {
    const single = await validateEdit(Object.assign({}, raw, { nodeId: iid }), new Set([iid]));
    if (single.valid) valid.push(single);
    else if (single.reason) lastReason = single.reason;
  }

  if (valid.length) return valid;
  return [invalidEdit(raw, instanceIds.length
    ? '找到 ' + instanceIds.length + ' 个实例但没有可改的：' + lastReason
    : '这个组件目前没有任何实例')];
}

async function expandAndValidate(raw, allowedIds) {
  if (!raw || typeof raw.nodeId !== 'string' || !allowedIds.has(raw.nodeId)) {
    return [invalidEdit(raw, '节点不在清单里')];
  }
  let node = null;
  try { node = await figma.getNodeByIdAsync(raw.nodeId); } catch (e) { node = null; }
  if (!node) return [invalidEdit(raw, '节点不存在')];

  if ((raw.kind === 'variant' || raw.kind === 'boolean') &&
      (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET')) {
    return expandVariantToInstances(node, raw);
  }
  return [await validateEdit(raw, allowedIds)];
}

async function aiSuggestEdits(changeText, anchorId, scopeMode, impactItems, impactRootId, impactMode) {
  const change = String(changeText || '').trim();
  if (!change) {
    send({ type: 'aiError', text: '先写一句变更描述' });
    return;
  }
  const key = await readApiKey();
  if (!key) {
    send({ type: 'aiError', text: '还没有保存 API Key' });
    return;
  }

  // ③ 的候选池直接沿用②（若没跑②则用①）给出的集合：
  // 不重算、不再按范围过滤——范围已经在①里应用过一次了
  const scope = (scopeMode === 'node' || scopeMode === 'instances' || scopeMode === 'file')
    ? scopeMode : 'related';
  const focusItems = (Array.isArray(impactItems) && impactItems.length) ? impactItems : null;
  if (!focusItems) {
    send({ type: 'aiError', text: '没有可用的影响集合：先点「影响节点显示」或「AI 影响分析」' });
    return;
  }

  const scopeText = '【范围】只允许修改【已分析出的受影响对象】里列出的节点（以及锚点）。' +
    '清单外的 id 一律不要返回；清单里但不需要改的也不要凑数。';

  send({ type: 'progress', text: '读取影响集合…' });
  // 动态页面模式下，跨页节点要先加载页面才能读到属性
  try { await figma.loadAllPagesAsync(); } catch (e) { /* 已加载 */ }
  const digest = await buildFocusedDigest(anchorId, focusItems);

  send({ type: 'progress', text: '调用 DeepSeek 生成修改指令…' });
  let result = null;
  try {
    result = await callModel(buildEditPrompt(change, digest.text, scopeText));
  } catch (err) {
    send({ type: 'aiError', text: String((err && err.message) || err) });
    return;
  }

  const rawEdits = Array.isArray(result.edits) ? result.edits : [];
  if (!rawEdits.length) {
    // 模型没给指令不一定是故障：很可能这些节点已经是目标状态
    send({
      type: 'edits',
      data: {
        summary: String((result && result.summary) || ''),
        change: change,
        scope: scope,
        stale: docDirtySinceAnalysis,
        digest: digest.stats,
        edits: [],
        skippedNoop: 0,
        validCount: 0,
        note: '模型没有给出任何修改指令。可能这些节点已经是目标状态，或本次变更不需要改动它们。'
      }
    });
    return;
  }

  const edits = [];
  for (const raw of rawEdits) {
    const list = await expandAndValidate(raw, digest.ids);
    for (const item of list) {
      // 范围外的建议保留在列表里，但标成不可应用
      if (item.valid && digest.allowedIds && !digest.allowedIds.has(item.id)) {
        item.valid = false;
        item.reason = '超出本次范围（' + (scope === 'node' ? '仅选中节点' : '同组件实例') + '）';
      }
      edits.push(item);
    }
  }
  // 变更描述里带引号的片段（如「工序性」）：模型若没给 range，自动限定到该片段，
  // 避免"改一个词"变成"整段换字体/字号"
  const quoted = extractQuotedFragments(change);
  if (quoted.length === 1) {
    for (const edit of edits) {
      if (!edit.valid || edit.range) continue;
      if (edit.kind !== 'font' && edit.kind !== 'fill') continue;
      let targetNode = null;
      try { targetNode = await figma.getNodeByIdAsync(edit.id); } catch (e) { targetNode = null; }
      if (!targetNode || targetNode.type !== 'TEXT') continue;
      const chars = String(targetNode.characters || '');
      if (chars.indexOf(quoted[0]) >= 0) {
        edit.range = quoted[0];
        edit.rangeAuto = true;
      }
    }
  }

  // 同组件实例同步：模型经常只改锚点或其中一个实例、漏掉跨页实例。
  // 取任意一条变体/布尔改动做模板，复制到集合里的每个同组件实例（from 取该实例当前值）。
  const template = edits.filter(function (e) {
    return e.valid && e.property && (e.kind === 'variant' || e.kind === 'boolean');
  })[0];
  if (template) {
    for (const item of focusItems) {
      if (!item || item.id === anchorId) continue;
      let inst = null;
      try { inst = await figma.getNodeByIdAsync(item.id); } catch (e) { inst = null; }
      if (!inst || inst.type !== 'INSTANCE') continue;

      let cp = {};
      try { cp = inst.componentProperties || {}; } catch (e) { cp = {}; }

      const cur = cp[template.property];
      if (!cur) continue;
      const from = String(cur.value);
      const to = String(template.to);
      if (from === to) continue;
      const exists = edits.some(function (e) {
        return e.id === inst.id && e.property === template.property;
      });
      if (exists) continue;

      const list = await expandAndValidate({
        nodeId: inst.id,
        kind: template.kind,
        property: template.property,
        from: from,
        to: to,
        why: '与锚点保持一致的组件属性同步'
      }, digest.ids);
      for (const it2 of list) {
        it2.fromSync = true;
        if (it2.valid && digest.allowedIds && !digest.allowedIds.has(it2.id)) {
          it2.valid = false;
          it2.reason = '超出本次范围';
        }
          edits.push(it2);
        }
      }
    }

  // 过滤「已经是目标状态」的建议：模型经常给出 Off → Off 这种无意义指令
  function isNoop(edit) {
    if (!edit || !edit.valid) return false;
    if (edit.kind === 'boolean' || edit.kind === 'visible') {
      return Boolean(edit.from) === Boolean(edit.to);
    }
    if (edit.kind === 'fill') {
      return String(edit.from).toUpperCase() === String(edit.to).toUpperCase();
    }
    return String(edit.from) === String(edit.to);
  }

  const skippedNoop = edits.filter(isNoop).length;
  const noNoop = edits.filter(function (e) { return !isNoop(e); });

  // 去重：同一节点 + 同 kind + 同属性 + 同 from/to，只保留一条
  const seenEdit = new Set();
  const finalEdits = [];
  for (const e of noNoop) {
    const key = [e.id, e.kind, e.property || '', String(e.from), String(e.to), e.range || ''].join('|');
    if (seenEdit.has(key)) continue;
    seenEdit.add(key);
    finalEdits.push(e);
  }

  let index = 0;
  for (const edit of finalEdits) edit.index = ++index;

  // 覆盖统计：让"哪些候选没被模型处理"可见
  const instanceItems = focusItems.filter(function (it) {
    return it && (it.type === 'INSTANCE' || (graph && graph.byId.get(it.id) && graph.byId.get(it.id).type === 'INSTANCE'));
  });
  const coveredIds = new Set(finalEdits.map(function (e) { return e.id; }));
  const coveredInstances = instanceItems.filter(function (it) {
    return coveredIds.has(it.id);
  }).length;

  let anchorPageId = null;
  try {
    const a = await figma.getNodeByIdAsync(anchorId);
    const p = a ? pageOf(a) : null;
    anchorPageId = p ? p.id : null;
  } catch (e) { anchorPageId = null; }

  let crossItems = [];
  if (anchorPageId) {
    crossItems = focusItems.filter(function (it) {
      const rec = graph && graph.byId.get(it && it.id);
      return !!(rec && rec.pageId && rec.pageId !== anchorPageId);
    });
  }
  const crossCovered = crossItems.filter(function (it) { return coveredIds.has(it.id); }).length;

  send({
    type: 'edits',
    data: {
      summary: String(result.summary || ''),
      change: change,
      scope: scope,
      stale: docDirtySinceAnalysis,
      digest: digest.stats,
      coverage: {
        instances: instanceItems.length,
        covered: coveredInstances,
        crossPage: crossItems.length,
        crossCovered: crossCovered
      },
      edits: finalEdits,
      skippedNoop: skippedNoop,
      validCount: finalEdits.filter(function (e) { return e.valid; }).length
    }
  });
}

async function applyEdits(edits) {
  if (!Array.isArray(edits) || !edits.length) {
    send({ type: 'applyResult', data: { applied: [], failed: [] } });
    return;
  }

  const applied = [];
  const failed = [];

  for (const edit of edits) {
    try {
      const node = await figma.getNodeByIdAsync(edit.id);
      if (!node) { failed.push({ name: edit.name || edit.id, reason: '节点不存在' }); continue; }

      let after = '';
      let beforeText = '';
      if (EXTRA_KINDS[edit.kind]) {
        after = await applyExtraEdit(node, edit);
      } else if (edit.kind === 'text') {
        if (node.type !== 'TEXT') { failed.push({ name: edit.name, reason: '不是文本节点' }); continue; }
        const font = node.fontName;
        if (font === figma.mixed) {
          failed.push({ name: edit.name, reason: '混合字体，跳过' });
          continue;
        }
        await figma.loadFontAsync(font);
        const cur = String(node.characters || '');
        const fromStr = String(edit.from);
        const toStr = String(edit.to);
        let next;
        if (cur === fromStr) {
          next = toStr;                       // 整段替换
        } else if (cur.indexOf(fromStr) >= 0) {
          // 模型有时 from 给片段、to 给"整段新文本"：这时必须整段替换，
          // 否则 replace(片段, 整段) 会把后半句复制一遍
          next = (toStr.indexOf(cur) >= 0) ? toStr : cur.replace(fromStr, toStr);
        } else {
          throw new Error('当前文本里找不到 from');
        }
        if (next === cur) throw new Error('应用后文本没有变化');
        beforeText = cur;
        node.characters = next;
        after = String(node.characters);
      } else if (edit.kind === 'variant' || edit.kind === 'boolean') {
        const payload = {};
        payload[edit.property] = edit.kind === 'boolean' ? !!edit.to : String(edit.to);
        node.setProperties(payload);
        try {
          after = String(node.componentProperties[edit.property].value);
        } catch (e) {
          after = String(edit.to);
        }
      } else if (edit.kind === 'visible') {
        node.visible = !!edit.to;
        after = node.visible ? '显示' : '隐藏';
      } else {
        failed.push({ name: edit.name || edit.id, reason: '不支持的操作类型' });
        continue;
      }
      applied.push({
        id: edit.id,
        name: edit.name || edit.id,
        kind: edit.kind,
        property: edit.property,
        from: edit.from,
        to: edit.to,
        range: edit.range,
        before: beforeText || undefined,
        after: String(after).slice(0, 40)
      });
    } catch (err) {
      failed.push({ name: edit.name || edit.id, reason: String((err && err.message) || err) });
    }
  }

  // 关键：插件改动默认不进撤销历史，这行让整批修改可以用一次 Ctrl+Z 撤销
  try { figma.commitUndo(); } catch (e) { /* 忽略 */ }

  send({ type: 'applyResult', data: { applied: applied, failed: failed } });
}

/**
 * 回滚本次应用：用记录下来的 from 精确恢复，不依赖 Figma 的撤销栈。
 * 适用于"Ctrl+Z 只撤销了一部分"或用户想整体还原的情况。
 */
async function revertEdits(edits) {
  const reverted = [];
  const failed = [];

  for (const edit of edits || []) {
    try {
      const node = await figma.getNodeByIdAsync(edit.id);
      if (!node) { failed.push({ name: edit.name || edit.id, reason: '节点不存在' }); continue; }

      if (EXTRA_KINDS[edit.kind]) {
        await applyExtraEdit(node, { kind: edit.kind, property: edit.property, to: edit.from });
        reverted.push({ id: edit.id, name: edit.name || edit.id });
        continue;
      }

      if (edit.kind === 'text') {
        if (node.type !== 'TEXT') { failed.push({ name: edit.name, reason: '不是文本节点' }); continue; }
        const font = node.fontName;
        if (font === figma.mixed) { failed.push({ name: edit.name, reason: '混合字体，跳过' }); continue; }
        await figma.loadFontAsync(font);
        if (typeof edit.before === 'string') {
          node.characters = edit.before;          // 有原始文本就直接还原，最稳
        } else {
          const cur = String(node.characters || '');
          const toStr = String(edit.to);
          if (cur === toStr) node.characters = String(edit.from);
          else if (cur.indexOf(toStr) >= 0) node.characters = cur.replace(toStr, String(edit.from));
          else node.characters = String(edit.from);
        }
      } else if (edit.kind === 'variant' || edit.kind === 'boolean') {
        if (node.type !== 'INSTANCE') { failed.push({ name: edit.name, reason: '不是实例' }); continue; }
        const payload = {};
        payload[edit.property] = edit.kind === 'boolean' ? !!edit.from : String(edit.from);
        node.setProperties(payload);
      } else if (edit.kind === 'visible') {
        node.visible = !!edit.from;
      } else {
        failed.push({ name: edit.name || edit.id, reason: '不支持的类型' });
        continue;
      }
      reverted.push({ id: edit.id, name: edit.name || edit.id });
    } catch (err) {
      failed.push({ name: edit.name || edit.id, reason: String((err && err.message) || err) });
    }
  }

  try { figma.commitUndo(); } catch (e) { /* 忽略 */ }
  send({ type: 'revertResult', data: { reverted: reverted, failed: failed } });
}

// ---------------------------------------------------------------------------
// 现状核对：撤销/回滚之后，影响集合里的节点到底处于什么状态
// ---------------------------------------------------------------------------

let lastAnalysisAt = 0;
let docDirtySinceAnalysis = false;

/** 文档变动追踪（注册时机见文件末尾的启动块：必须先 loadAllPagesAsync）。 */
function docChangeTracker() {
  // 分析刚跑完那一瞬间会触发自己画标记的事件，用时间窗过滤掉
  if (Date.now() - lastAnalysisAt > 2500) docDirtySinceAnalysis = true;
}

function markAnalysisFresh() {
  lastAnalysisAt = Date.now();
  docDirtySinceAnalysis = false;
}

async function describeImpactState(items) {
  const rows = [];
  for (const item of items || []) {
    if (!item || typeof item.id !== 'string') continue;
    let node = null;
    try { node = await figma.getNodeByIdAsync(item.id); } catch (e) { node = null; }
    if (!node) {
      rows.push({ id: item.id, name: '（节点已删除）', type: '?', state: '不存在' });
      continue;
    }
    let state = '';
    if (node.type === 'INSTANCE') {
      let cp = {};
      try { cp = node.componentProperties || {}; } catch (e) { cp = {}; }
      const keys = Object.keys(cp);
      state = keys.length
        ? keys.map(function (key) {
            return key + '(' + (cp[key].type || '?') + ')=' + String(cp[key].value);
          }).join('; ')
        : '（无组件属性）';
    } else if (node.type === 'TEXT') {
      state = '「' + String(node.characters || '').slice(0, 30) + '」';
    } else {
      state = 'visible=' + String(node.visible);
    }
    rows.push({ id: item.id, name: node.name, type: node.type, state: state });
  }
  send({ type: 'impactState', data: { rows: rows, stale: docDirtySinceAnalysis } });
}

const EXTRA_KINDS = { fill: true, opacity: true, radius: true, font: true, size: true, spacing: true };

// 常见中文字体名 → Figma 里的 family 名
const FONT_ALIASES = {
  '宋体': 'SimSun',
  '黑体': 'SimHei',
  '微软雅黑': 'Microsoft YaHei',
  '苹方': 'PingFang SC',
  '思源黑体': 'Source Han Sans',
  '思源宋体': 'Source Han Serif'
};

/**
 * 加载某个文本范围内现有的全部字体。
 * 局部改字体/字号时 Figma 需要先加载"原字体"才能拆分文本，
 * 返回加载失败的字体名列表（空数组表示全部就绪）。
 */
async function loadRangeFonts(node, start, end) {
  const missing = [];
  let fonts = [];
  try {
    fonts = node.getRangeAllFontNames(start, end) || [];
  } catch (e) {
    fonts = [];
  }
  for (const f of fonts) {
    try {
      await figma.loadFontAsync(f);
    } catch (e) {
      missing.push(f.family + ' ' + f.style);
    }
  }
  return missing;
}

/**
 * 解析并加载字体：先按原名试，失败就按别名 / 可用字体列表做模糊匹配。
 * 这样模型说"宋体"、环境里装的是 SimSun 也能落上。
 */
async function resolveFontAsync(family, style) {
  const fam = FONT_ALIASES[family] || family;

  try {
    const direct = { family: fam, style };
    await figma.loadFontAsync(direct);
    return direct;
  } catch (e) { /* 继续找 */ }

  let fonts = [];
  try { fonts = await figma.listAvailableFontsAsync(); } catch (e) { fonts = []; }

  const lower = String(fam).toLowerCase();
  const styleLower = String(style || '').toLowerCase();
  const matched = fonts.filter(function (f) {
    const name = String((f.fontName && f.fontName.family) || '').toLowerCase();
    return name === lower || name.indexOf(lower) >= 0 || lower.indexOf(name) >= 0;
  });

  if (matched.length) {
    const exact = matched.filter(function (f) {
      return String((f.fontName && f.fontName.style) || '').toLowerCase() === styleLower;
    })[0];
    const target = (exact || matched[0]).fontName;
    try {
      await figma.loadFontAsync(target);
      return target;
    } catch (e) { /* 继续 */ }
  }

  throw new Error('字体「' + family + ' ' + style + '」在当前环境不可用');
}

/** 校验基础属性改动（fill / opacity / radius / font / size / spacing）。 */
function validateExtraEdit(edit, node) {
  if (edit.kind === 'fill') {
    let fills = [];
    try { fills = node.fills; } catch (e) { fills = []; }
    const solid = Array.isArray(fills) && fills.length && fills[0].type === 'SOLID' ? fills[0] : null;
    if (!solid) { edit.reason = '这个节点没有纯色填充'; return edit; }
    const current = rgbToHex(solid.color);
    if (String(edit.from).toUpperCase() !== current) acceptFrom(edit, current);
    if (!hexToRgb(edit.to)) { edit.reason = '目标颜色需要 #RRGGBB'; return edit; }
    edit.valid = true;
    return edit;
  }

  if (edit.kind === 'opacity' || edit.kind === 'radius') {
    const prop = edit.kind === 'opacity' ? 'opacity' : 'cornerRadius';
    let current;
    try { current = node[prop]; } catch (e) { current = undefined; }
    if (typeof current !== 'number') { edit.reason = '当前值不可读（可能混合）'; return edit; }
    if (!sameNumber(edit.from, current)) acceptFrom(edit, current);
    if (!Number.isFinite(Number(edit.to))) { edit.reason = '目标值不是数字'; return edit; }
    edit.valid = true;
    return edit;
  }

  if (edit.kind === 'font') {
    if (node.type !== 'TEXT') { edit.reason = '不是文本节点'; return edit; }
    const chars = String(node.characters || '');
    const mixed = node.fontName === figma.mixed;

    // 局部修改（range）：句子内部字体本来就是混合的，不影响某一段单独换字体/字号
    if (edit.range) {
      if (chars.indexOf(String(edit.range)) < 0) {
        edit.reason = '文本里找不到 range 指定的「' + edit.range + '」';
        return edit;
      }
      if (edit.property === 'fontName') {
        if (String(edit.to || '').indexOf('|') <= 0) {
          edit.reason = '目标字体格式应为 "Family|Style"，例如 宋体|Bold';
          return edit;
        }
      } else if (!Number.isFinite(Number(edit.to))) {
        edit.reason = '目标值不是数字';
        return edit;
      }
      edit.valid = true;
      return edit;
    }

    if (mixed) {
      edit.reason = '整段字体是混合的；改局部请用 range 指定片段';
      return edit;
    }

    if (edit.property === 'fontName') {
      const current = node.fontName.family + '|' + node.fontName.style;
      if (String(edit.from) !== current) acceptFrom(edit, current);
      if (String(edit.to || '').indexOf('|') <= 0) {
        edit.reason = '目标字体格式应为 "Family|Style"，例如 Inter|Bold';
        return edit;
      }
      edit.valid = true;
      return edit;
    }

    const prop = edit.property === 'lineHeight' ? 'lineHeight' : 'fontSize';
    let current;
    try {
      current = prop === 'fontSize' ? node.fontSize : (node.lineHeight && node.lineHeight.value);
    } catch (e) { current = undefined; }
    if (typeof current !== 'number') { edit.reason = '当前值不可读'; return edit; }
    if (!sameNumber(edit.from, current)) acceptFrom(edit, current);
    if (!Number.isFinite(Number(edit.to))) { edit.reason = '目标值不是数字'; return edit; }
    edit.valid = true;
    return edit;
  }

  if (edit.kind === 'size') {
    const w = Math.round(node.width);
    const h = Math.round(node.height);
    const from = String(edit.from || '').replace(/\s/g, '').toLowerCase();
    if (from !== (w + 'x' + h)) acceptFrom(edit, w + 'x' + h);
    if (!/^\d+x\d+$/.test(String(edit.to || '').replace(/\s/g, '').toLowerCase())) {
      edit.reason = '目标尺寸格式应为 320x48';
      return edit;
    }
    edit.valid = true;
    return edit;
  }

  if (edit.kind === 'spacing') {
    const prop = edit.property || 'itemSpacing';
    if (['itemSpacing', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'].indexOf(prop) < 0) {
      edit.reason = '不支持的间距属性';
      return edit;
    }
    let mode = 'NONE';
    try { mode = node.layoutMode; } catch (e) { mode = 'NONE'; }
    if (!mode || mode === 'NONE') { edit.reason = '这个节点不是 auto-layout 容器'; return edit; }
    let current;
    try { current = node[prop]; } catch (e) { current = undefined; }
    if (typeof current !== 'number') { edit.reason = '当前值不可读'; return edit; }
    if (!sameNumber(edit.from, current)) acceptFrom(edit, current);
    if (!Number.isFinite(Number(edit.to))) { edit.reason = '目标值不是数字'; return edit; }
    edit.valid = true;
    return edit;
  }

  edit.reason = '未校验通过';
  return edit;
}

/** 执行基础属性改动，返回"改完后的实际值"用于回显。 */
async function applyExtraEdit(node, edit) {
  if (edit.kind === 'fill') {
    const rgb = hexToRgb(edit.to);
    if (!rgb) throw new Error('目标颜色格式不对（需要 #RRGGBB）');
    node.fills = [{ type: 'SOLID', color: rgb }];
    return String(edit.to).toUpperCase();
  }
  if (edit.kind === 'opacity') {
    node.opacity = clamp01(edit.to);
    return String(Math.round(node.opacity * 100) / 100);
  }
  if (edit.kind === 'radius') {
    node.cornerRadius = Math.max(0, Number(edit.to));
    return String(Math.round(node.cornerRadius));
  }
  if (edit.kind === 'font') {
    if (node.type !== 'TEXT') throw new Error('不是文本节点');
    const mixed = node.fontName === figma.mixed;
    const chars = String(node.characters || '');

    // 换字体只需要加载「目标字体」，和当前字体是否缺失无关
    if (edit.property === 'fontName') {
      const raw = String(edit.to || '').trim();
      const idx = raw.indexOf('|');
      if (idx <= 0) throw new Error('目标字体格式应为 "Family|Style"');
      const resolved = await resolveFontAsync(raw.slice(0, idx).trim(), raw.slice(idx + 1).trim());

      if (edit.range) {
        const start = chars.indexOf(String(edit.range));
        if (start < 0) throw new Error('文本里找不到「' + edit.range + '」');
        const end = start + String(edit.range).length;

        // 局部改字体：Figma 需要先加载这一段现有的字体，否则无法拆分文本
        const missing = await loadRangeFonts(node, start, end);
        if (missing.length) {
          throw new Error('这段文字当前用的是「' + missing.join('、') +
            '」，该字体在当前环境不可用，无法局部替换字体');
        }

        node.setRangeFontName(start, end, resolved);
        return resolved.family + '|' + resolved.style + ' @「' + edit.range + '」';
      }

      if (mixed) throw new Error('整段字体是混合的，无法整体替换；请指定 range');
      // 整段替换：旧字体缺失也允许尝试（成功与否由 Figma 决定）
      try { await figma.loadFontAsync(node.fontName); } catch (e) { /* 继续尝试 */ }
      try {
        node.fontName = resolved;
      } catch (e) {
        throw new Error('替换整段字体失败：' + String((e && e.message) || e));
      }
      return resolved.family + '|' + resolved.style;
    }

    // 字号 / 行高：支持只改 range 那一段
    if (edit.range) {
      const start = chars.indexOf(String(edit.range));
      if (start < 0) throw new Error('文本里找不到「' + edit.range + '」');
      const end = start + String(edit.range).length;

      // 同样要先加载这一段现有的字体，局部修改才能生效
      const missing = await loadRangeFonts(node, start, end);
      if (missing.length) {
        throw new Error('这段文字当前用的是「' + missing.join('、') +
          '」，该字体在当前环境不可用，无法局部改字号');
      }

      if (edit.property === 'lineHeight') {
        node.setRangeLineHeight(start, end, { unit: 'PIXELS', value: Number(edit.to) });
      } else {
        node.setRangeFontSize(start, end, Number(edit.to));
      }
      return String(edit.to) + ' @「' + edit.range + '」';
    }

    if (mixed) throw new Error('整段字体是混合的；改局部请用 range 指定片段');
    try {
      await figma.loadFontAsync(node.fontName);
    } catch (e) {
      throw new Error('当前字体「' + node.fontName.family + ' ' + node.fontName.style +
        '」加载失败，改不了字号/行高；如果只是想换字体，请用 fontName 类别');
    }
    if (edit.property === 'lineHeight') {
      node.lineHeight = { unit: 'PIXELS', value: Number(edit.to) };
      return String(node.lineHeight.value);
    }
    node.fontSize = Number(edit.to);
    return String(node.fontSize);
  }
  if (edit.kind === 'size') {
    const m = String(edit.to).replace(/\s/g, '').toLowerCase().match(/^(\d+)x(\d+)$/);
    if (!m) throw new Error('目标尺寸格式应为 320x48');
    node.resize(Number(m[1]), Number(m[2]));
    return Math.round(node.width) + 'x' + Math.round(node.height);
  }
  if (edit.kind === 'spacing') {
    const prop = edit.property || 'itemSpacing';
    if (!node.layoutMode || node.layoutMode === 'NONE') throw new Error('不是 auto-layout 容器');
    node[prop] = Number(edit.to);
    return String(node[prop]);
  }
  throw new Error('不支持的类型');
}
