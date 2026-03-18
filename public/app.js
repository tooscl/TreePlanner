const DEFAULT_STATE = {
  projects: [],
  tags: [],
  tasks: []
};

const PRIORITY_WEIGHTS = {
  p0: 4,
  p1: 3,
  p2: 2,
  p3: 1,
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

const ui = {
  view: "tasks",
  selectedProjectId: "all",
  selectedTagId: "all",
  smartScope: "none",
  completedOnly: false,
  mapLayout: "lanes",
  mapDirection: "forward",
  sortCriteria: [],
  search: "",
  saveState: "loading",
  pendingFocus: null,
  dragTaskId: null,
  settingsOpen: false,
  saveInfoOpen: false,
  projectComposerOpen: false,
  projectEditMode: false,
  tagEditMode: false,
  taskSelection: new Set(),
  bulkEditOpen: false,
  expandedMetaTaskIds: new Set()
};

let state = structuredClone(DEFAULT_STATE);
let saveTimer = null;
const historyStack = [];
const MAX_HISTORY = 50;
const PREVIEW_DELAY_MS = 4000;
const previewTimers = new Map();
const previewState = {
  targetId: null,
  text: "",
  parsed: null
};

const BULK_ACTION_PRESETS = {
  keep: "__keep__",
  clear: "__clear__"
};

const defaultPreferences = {
  versionLabel: "@1.3.1",
  themeMode: "sand",
  behavior: {
    completedToArchive: false
  },
  colors: {
    accent: "#d36b44",
    accent2: "#6d998e",
    accent3: "#cfaa58",
    background: "#efe7d7",
    background2: "#fff7ee",
    text: "#23303d"
  }
};

let preferences = structuredClone(defaultPreferences);

const elements = {
  sidebar: document.querySelector("#sidebar-content"),
  main: document.querySelector("#main-content")
};

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeTask(task) {
  const estimateMinutes =
    task.estimateMinutes !== undefined && task.estimateMinutes !== null && task.estimateMinutes !== ""
      ? Number(task.estimateMinutes) || ""
      : normalizeEstimateMinutes(task.estimateHours);
  const manualEstimateMinutes =
    task.manualEstimateMinutes !== undefined && task.manualEstimateMinutes !== null && task.manualEstimateMinutes !== ""
      ? Number(task.manualEstimateMinutes) || ""
      : estimateMinutes;
  return {
    id: task.id || uid("task"),
    title: task.title || "",
    description: task.description || "",
    parentId: task.parentId || null,
    projectId: task.projectId || "",
    tagIds: Array.isArray(task.tagIds) ? task.tagIds : [],
    order: Number(task.order || 1),
    priority: task.priority || "",
    status: task.status || "todo",
    previousStatus: task.previousStatus || "todo",
    deadline: task.deadline || "",
    manualEstimateMinutes,
    estimateMinutes,
    trackedMs: Number(task.trackedMs || 0),
    activeStartedAt: task.activeStartedAt || "",
    createdAt: task.createdAt || new Date().toISOString()
  };
}

function normalizeState(raw) {
  const normalized = {
    projects: Array.isArray(raw?.projects) ? raw.projects : [],
    tags: Array.isArray(raw?.tags) ? raw.tags : [],
    tasks: Array.isArray(raw?.tasks) ? raw.tasks.map(normalizeTask) : []
  };
  recomputeDerivedEstimates(normalized.tasks);
  return normalized;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeHexColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(value || "") ? value : fallback;
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex, "#000000").slice(1);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  };
}

function mixHex(base, target, ratio) {
  const baseRgb = hexToRgb(base);
  const targetRgb = hexToRgb(target);
  const blend = (from, to) => Math.round(from + (to - from) * ratio);

  return `#${[blend(baseRgb.r, targetRgb.r), blend(baseRgb.g, targetRgb.g), blend(baseRgb.b, targetRgb.b)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function withAlpha(hex, alpha) {
  const rgb = hexToRgb(hex);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function sortByName(items) {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

function loadPreferences() {
  try {
    const raw = localStorage.getItem("planner-preferences");
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);
    preferences = {
      versionLabel: defaultPreferences.versionLabel,
      themeMode: parsed.themeMode === "midnight" ? "midnight" : "sand",
      behavior: {
        completedToArchive: Boolean(parsed.behavior?.completedToArchive)
      },
      colors: {
        accent: normalizeHexColor(parsed.colors?.accent, defaultPreferences.colors.accent),
        accent2: normalizeHexColor(parsed.colors?.accent2, defaultPreferences.colors.accent2),
        accent3: normalizeHexColor(parsed.colors?.accent3, defaultPreferences.colors.accent3),
        background: normalizeHexColor(parsed.colors?.background, defaultPreferences.colors.background),
        background2: normalizeHexColor(parsed.colors?.background2, defaultPreferences.colors.background2),
        text: normalizeHexColor(parsed.colors?.text, defaultPreferences.colors.text)
      }
    };
  } catch {
    preferences = structuredClone(defaultPreferences);
  }
}

function persistPreferences() {
  localStorage.setItem("planner-preferences", JSON.stringify(preferences));
}

function applyPreferences() {
  const background = preferences.colors.background;
  const text = preferences.colors.text;
  const accent = preferences.colors.accent;
  const accent2 = preferences.colors.accent2;
  const accent3 = preferences.colors.accent3;
  const background2 = preferences.colors.background2;
  const isMidnight = preferences.themeMode === "midnight";

  document.documentElement.style.setProperty("--bg", background);
  document.documentElement.style.setProperty("--page-start", background);
  document.documentElement.style.setProperty("--page-end", isMidnight ? mixHex(background, "#000000", 0.26) : mixHex(background, "#ffffff", 0.08));
  document.documentElement.style.setProperty("--paper", isMidnight ? mixHex(background, "#ffffff", 0.06) : mixHex(background, "#ffffff", 0.78));
  document.documentElement.style.setProperty("--sidebar", withAlpha(isMidnight ? mixHex(background, "#ffffff", 0.08) : mixHex(background, "#ffffff", 0.7), isMidnight ? 0.94 : 0.9));
  document.documentElement.style.setProperty("--canvas-surface", background2);
  document.documentElement.style.setProperty("--ink", text);
  document.documentElement.style.setProperty("--ink-soft", withAlpha(text, 0.66));
  document.documentElement.style.setProperty("--border", withAlpha(text, 0.12));
  document.documentElement.style.setProperty("--paper-line", withAlpha(text, 0.16));
  document.documentElement.style.setProperty("--paper-line-strong", withAlpha(text, 0.28));
  document.documentElement.style.setProperty("--accent", accent);
  document.documentElement.style.setProperty("--accent-deep", mixHex(accent, text, isMidnight ? 0.2 : 0.34));
  document.documentElement.style.setProperty("--accent-soft", withAlpha(accent, 0.14));
  document.documentElement.style.setProperty("--accent-2", accent2);
  document.documentElement.style.setProperty("--accent-3", accent3);
}

function setThemeMode(mode) {
  if (mode === "midnight") {
    preferences.themeMode = "midnight";
    preferences.colors = {
      accent: "#f4f1ea",
      accent2: "#7fd0c2",
      accent3: "#d6a85f",
      background: "#0d1014",
      background2: "#161b22",
      text: "#f4f1ea"
    };
  } else {
    preferences.themeMode = "sand";
    preferences.colors = structuredClone(defaultPreferences.colors);
  }

  persistPreferences();
  applyPreferences();
}

function rememberHistory() {
  const snapshot = JSON.stringify(state);
  const latest = historyStack[historyStack.length - 1];

  if (latest === snapshot) {
    return;
  }

  historyStack.push(snapshot);
  if (historyStack.length > MAX_HISTORY) {
    historyStack.shift();
  }
}

function undoLastAction() {
  const snapshot = historyStack.pop();
  if (!snapshot) {
    return;
  }

  state = normalizeState(JSON.parse(snapshot));
  refreshDerivedTaskState();
  scheduleSave();
  renderAll();
}

function getTask(taskId) {
  return state.tasks.find((task) => task.id === taskId) || null;
}

function getProject(projectId) {
  return state.projects.find((project) => project.id === projectId) || null;
}

function getTag(tagId) {
  return state.tags.find((tag) => tag.id === tagId) || null;
}

function getChildren(parentId) {
  return state.tasks.filter((task) => (task.parentId || null) === (parentId || null));
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const orderA = Number(a.order || 1);
    const orderB = Number(b.order || 1);
    return orderA - orderB || a.createdAt.localeCompare(b.createdAt) || a.title.localeCompare(b.title, "ru");
  });
}

function sortTasksForDisplay(tasks) {
  return [...tasks].sort(compareTasks);
}

function recomputeDerivedEstimates(tasks) {
  const visited = new Set();

  function compute(task) {
    if (!task || visited.has(task.id)) {
      return Number(task?.estimateMinutes || 0);
    }

    const children = tasks.filter((item) => (item.parentId || null) === task.id);
    if (!children.length) {
      task.estimateMinutes = task.status === "done" ? "" : task.manualEstimateMinutes || "";
      visited.add(task.id);
      return Number(task.estimateMinutes || 0);
    }

    children.forEach(compute);
    const openChildren = children.filter((child) => child.status !== "done");

    if (!openChildren.length) {
      task.estimateMinutes = "";
      visited.add(task.id);
      return 0;
    }

    const allOpenChildrenEstimated = openChildren.every((child) => Number(child.estimateMinutes || 0) > 0);
    task.estimateMinutes = allOpenChildrenEstimated
      ? openChildren.reduce((sum, child) => sum + Number(child.estimateMinutes || 0), 0)
      : task.manualEstimateMinutes || "";
    visited.add(task.id);
    return Number(task.estimateMinutes || 0);
  }

  tasks.forEach(compute);
}

function refreshDerivedTaskState() {
  recomputeDerivedEstimates(state.tasks);
}

function normalizeEstimateMinutes(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "";
  }

  if (numeric <= 0) {
    return "";
  }

  if (numeric > 24) {
    return Math.round(numeric);
  }

  return Math.round(numeric * 60);
}

function getStatusLabel(status) {
  if (status === "active") {
    return "Active";
  }

  if (status === "hold") {
    return "Hold";
  }

  if (status === "done") {
    return "Done";
  }

  return "To do";
}

function getStatusTone(status) {
  if (status === "active") {
    return "active";
  }

  if (status === "hold") {
    return "hold";
  }

  if (status === "done") {
    return "done";
  }

  return "todo";
}

function parseEstimateMinutes(rawValue) {
  const source = String(rawValue || "").trim();
  if (!source) {
    return "";
  }

  const match = source.match(/^(\d{1,2})\s*:\s*(\d{1,3})$/);
  if (!match) {
    return "";
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || minutes < 0) {
    return "";
  }

  const totalMinutes = hours * 60 + minutes;
  return totalMinutes > 0 ? totalMinutes : "";
}

function getEstimateWeight(task) {
  return Number(task.estimateMinutes || 0);
}

function getTrackedMs(task) {
  const stored = Number(task.trackedMs || 0);
  if (task.status !== "active" || !task.activeStartedAt) {
    return stored;
  }

  const startedAt = new Date(task.activeStartedAt).getTime();
  if (!Number.isFinite(startedAt)) {
    return stored;
  }

  return stored + Math.max(0, Date.now() - startedAt);
}

function getPlannedBaselineEstimate(task, tasks = state.tasks) {
  if (!task) {
    return 0;
  }

  const children = tasks.filter((item) => (item.parentId || null) === task.id);
  if (!children.length) {
    return Number(task.manualEstimateMinutes || task.estimateMinutes || 0);
  }

  const childBaselines = children.map((child) => getPlannedBaselineEstimate(child, tasks));
  const allChildrenEstimated = childBaselines.every((value) => value > 0);
  if (allChildrenEstimated) {
    return childBaselines.reduce((sum, value) => sum + value, 0);
  }

  return Number(task.manualEstimateMinutes || task.estimateMinutes || 0);
}

function formatTimer(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatTrackedDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(Number(ms || 0) / 60000));
  return formatEstimate(totalMinutes) || "0m";
}

function getEstimateDeltaMinutes(task) {
  return Math.round(getTrackedMs(task) / 60000) - getPlannedBaselineEstimate(task);
}

function getDeadlineWeight(task) {
  if (!task.deadline) {
    return Number.POSITIVE_INFINITY;
  }

  const time = new Date(task.deadline).getTime();
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function getSortComparison(sortKey, a, b) {
  if (sortKey === "deadline") {
    return getDeadlineWeight(a) - getDeadlineWeight(b);
  }

  if (sortKey === "priority") {
    return getPriorityWeight(b.priority) - getPriorityWeight(a.priority);
  }

  if (sortKey === "estimate") {
    return getEstimateWeight(a) - getEstimateWeight(b);
  }

  return 0;
}

function getSortDirection(sortKey) {
  return ui.sortCriteria.find((criterion) => criterion.key === sortKey)?.direction || null;
}

function compareTasks(a, b) {
  const orderA = Number(a.order || 1);
  const orderB = Number(b.order || 1);

  for (const criterion of ui.sortCriteria) {
    const direction = criterion.direction === "desc" ? -1 : 1;
    const result = getSortComparison(criterion.key, a, b) * direction;
    if (result !== 0) {
      return result;
    }
  }

  return orderA - orderB || a.createdAt.localeCompare(b.createdAt) || a.title.localeCompare(b.title, "ru");
}

function normalizeSiblingOrders(parentId) {
  sortTasks(getChildren(parentId)).forEach((task, index) => {
    task.order = index + 1;
  });
}

function setChildrenOrder(parentId, tasks) {
  tasks.forEach((task, index) => {
    task.parentId = parentId;
    task.order = index + 1;
  });
}

function shiftSiblingOrders(parentId, fromOrder) {
  getChildren(parentId).forEach((task) => {
    if (Number(task.order) >= fromOrder) {
      task.order += 1;
    }
  });
}

function getAncestors(taskId) {
  const ancestors = [];
  let current = getTask(taskId);

  while (current?.parentId) {
    current = getTask(current.parentId);
    if (current) {
      ancestors.unshift(current);
    }
  }

  return ancestors;
}

function getDescendantIds(taskId) {
  const ids = new Set();
  const stack = [taskId];

  while (stack.length) {
    const currentId = stack.pop();
    getChildren(currentId).forEach((child) => {
      ids.add(child.id);
      stack.push(child.id);
    });
  }

  return ids;
}

function flattenVisibleTree(visibleIds) {
  const rows = [];

  function walk(task, depth) {
    rows.push({ task, depth });
    sortTasksForDisplay(getChildren(task.id))
      .filter((child) => visibleIds.has(child.id))
      .forEach((child) => walk(child, depth + 1));
  }

  sortTasksForDisplay(
    state.tasks.filter((task) => visibleIds.has(task.id) && (!task.parentId || !visibleIds.has(task.parentId)))
  ).forEach((root) => walk(root, 0));

  return rows;
}

function getVisibleTaskIds() {
  const baseMatches = state.tasks.filter((task) => matchesTaskVisibility(task));

  if (ui.selectedProjectId === "all" && ui.selectedTagId === "all" && ui.smartScope === "none" && !ui.search.trim()) {
    return new Set(baseMatches.map((task) => task.id));
  }

  if (ui.selectedTagId !== "all" || ui.smartScope !== "none") {
    return new Set(baseMatches.map((task) => task.id));
  }

  const visible = new Set();
  baseMatches.forEach((task) => {
    visible.add(task.id);
    getAncestors(task.id).forEach((ancestor) => visible.add(ancestor.id));
  });
  return visible;
}

function getDirectMatchTaskIds() {
  return new Set(
    state.tasks
      .filter((task) => matchesTaskVisibility(task))
      .map((task) => task.id)
  );
}

function matchesSmartScope(task, smartScope = ui.smartScope) {
  if (smartScope === "quick15") {
    const estimate = Number(task.estimateMinutes || 0);
    return estimate > 0 && estimate <= 15;
  }

  return true;
}

function matchesTaskVisibility(task, options = {}) {
  const {
    projectId = ui.selectedProjectId,
    tagId = ui.selectedTagId,
    completedOnly = ui.completedOnly,
    smartScope = ui.smartScope,
    search = ui.search
  } = options;

  if (preferences.behavior.completedToArchive) {
    if (completedOnly && task.status !== "done") {
      return false;
    }

    if (!completedOnly && task.status === "done") {
      return false;
    }
  } else if (completedOnly && task.status !== "done") {
    return false;
  }

  if (!matchesSmartScope(task, smartScope)) {
    return false;
  }

  const projectMatch = projectId === "all" || task.projectId === projectId;
  const tagMatch = tagId === "all" || task.tagIds.includes(tagId);
  const searchNeedle = String(search || "").trim().toLowerCase();
  const tagNames = task.tagIds
    .map((tagItemId) => getTag(tagItemId)?.name || "")
    .join(" ");
  const projectName = getProject(task.projectId)?.name || "";
  const searchStack = `${task.title} ${task.description} ${tagNames} ${projectName}`.toLowerCase();
  const searchMatch = !searchNeedle || searchStack.includes(searchNeedle);

  return projectMatch && tagMatch && searchMatch;
}

function getCurrentScopeLabel() {
  if (ui.completedOnly) {
    return "Completed";
  }

  if (ui.smartScope === "quick15") {
    return "Quick 15m";
  }

  const project = ui.selectedProjectId !== "all" ? getProject(ui.selectedProjectId) : null;
  const tag = ui.selectedTagId !== "all" ? getTag(ui.selectedTagId) : null;
  const parts = [];

  if (project) {
    parts.push(project.name);
  }

  if (tag) {
    parts.push(`#${tag.name}`);
  }

  return parts.length ? parts.join(" / ") : "Inbox";
}

function getCurrentContextProjectId() {
  return ui.selectedProjectId !== "all" ? ui.selectedProjectId : "";
}

function getCurrentContextTagIds() {
  return ui.selectedTagId !== "all" ? [ui.selectedTagId] : [];
}

function getSelectedTasks() {
  return state.tasks.filter((task) => ui.taskSelection.has(task.id));
}

function clearTaskSelection() {
  ui.taskSelection.clear();
  ui.bulkEditOpen = false;
}

function isTaskArchivedByPreference(task) {
  return preferences.behavior.completedToArchive && task.status === "done";
}

function getVisibleNavTaskCount(projectId = "all", tagId = "all") {
  return state.tasks.filter((task) => {
    if (isTaskArchivedByPreference(task)) {
      return false;
    }

    return matchesTaskVisibility(task, {
      projectId,
      tagId,
      completedOnly: false,
      smartScope: "none",
      search: ""
    });
  }).length;
}

function generateColor(seed) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = seed.charCodeAt(index) + ((hash << 5) - hash);
  }

  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 60% 62%)`;
}

function ensureTagByName(name) {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const existing = state.tags.find((tag) => tag.name.toLowerCase() === normalized);
  if (existing) {
    return existing;
  }

  const tag = {
    id: uid("tag"),
    name: normalized,
    color: generateColor(normalized)
  };
  state.tags.push(tag);
  return tag;
}

function parseInlineDate(day, month, year) {
  const numericDay = Number(day);
  const numericMonth = Number(month);

  if (numericDay < 1 || numericDay > 31 || numericMonth < 1 || numericMonth > 12) {
    return "";
  }

  let fullYear = year ? Number(year) : new Date().getFullYear();
  if (String(fullYear).length === 2) {
    fullYear += 2000;
  }

  const date = new Date(Date.UTC(fullYear, numericMonth - 1, numericDay));
  if (
    date.getUTCFullYear() !== fullYear ||
    date.getUTCMonth() !== numericMonth - 1 ||
    date.getUTCDate() !== numericDay
  ) {
    return "";
  }

  return `${String(fullYear).padStart(4, "0")}-${String(numericMonth).padStart(2, "0")}-${String(numericDay).padStart(2, "0")}`;
}

function extractInlinePreview(text) {
  let working = text.trim();
  let deadline = "";
  let priority = "";
  let estimateMinutes = "";
  const tags = [];

  working = working.replace(/(^|\s)(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (match, lead, day, month, year) => {
    const parsed = parseInlineDate(day, month, year);
    if (parsed) {
      deadline = parsed;
      return lead;
    }
    return match;
  });

  working = working.replace(/(^|\s)(P[0-3])\b/gi, (match, lead, rawPriority) => {
    priority = rawPriority.toLowerCase();
    return lead;
  });

  working = working.replace(/(^|\s)#([A-Za-zА-Яа-яЁё0-9_-]+)/g, (match, lead, rawTag) => {
    const normalized = rawTag.trim().toLowerCase();
    if (normalized) {
      tags.push(normalized);
    }
    return lead;
  });

  working = working.replace(/(^|\s)~\s*(\d{1,2}\s*:\s*\d{1,3})\b/g, (match, lead, rawEstimate) => {
    const parsed = parseEstimateMinutes(rawEstimate);
    if (parsed) {
      estimateMinutes = parsed;
      return lead;
    }
    return match;
  });

  return {
    title: working.replace(/\s+/g, " ").trim(),
    deadline,
    priority,
    estimateMinutes,
    tags
  };
}

function parseInlineTaskText(text, task) {
  const extracted = extractInlinePreview(text);
  const tagIds = new Set(task.tagIds || []);

  extracted.tags.forEach((tagName) => {
    const tag = ensureTagByName(tagName);
    if (tag) {
      tagIds.add(tag.id);
    }
  });

  return {
    title: extracted.title,
    deadline: extracted.deadline || task.deadline || "",
    priority: extracted.priority || task.priority || "",
    estimateMinutes: extracted.estimateMinutes || task.manualEstimateMinutes || task.estimateMinutes || "",
    tagIds: [...tagIds]
  };
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short"
  }).format(date);
}

function formatPriority(value) {
  if (!value || !/^p[0-3]$/i.test(value)) {
    return "";
  }
  return value.toUpperCase();
}

function formatEstimate(minutes) {
  const numeric = Number(minutes || 0);
  if (!numeric) {
    return "";
  }

  if (numeric < 60) {
    return `${numeric}m`;
  }

  const hours = Math.floor(numeric / 60);
  const remainingMinutes = numeric % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function renderGhostPreviewMarkup(text) {
  const parsed = extractInlinePreview(text);
  const chips = [];

  if (parsed.tags.length) {
    parsed.tags.forEach((tag) => {
      chips.push(`<span class="meta-chip ghost-chip">#${escapeHtml(tag)}</span>`);
    });
  }

  if (parsed.deadline) {
    chips.push(`<span class="meta-chip ghost-chip">${escapeHtml(formatDate(parsed.deadline))}</span>`);
  }

  if (parsed.priority) {
    chips.push(`<span class="meta-chip ghost-chip">${escapeHtml(formatPriority(parsed.priority))}</span>`);
  }

  if (parsed.estimateMinutes) {
    chips.push(`<span class="meta-chip ghost-chip">${escapeHtml(formatEstimate(parsed.estimateMinutes))}</span>`);
  }

  if (!chips.length) {
    return "";
  }

  return `
    <div class="task-meta-line ghost-line">
      <span class="ghost-label">preview</span>
      ${chips.join("")}
    </div>
  `;
}

function clearGhostPreview(targetId) {
  if (targetId && previewTimers.has(targetId)) {
    window.clearTimeout(previewTimers.get(targetId));
    previewTimers.delete(targetId);
  }

  const selector = targetId ? `[data-ghost-preview-for="${targetId}"]` : "[data-ghost-preview-for]";
  elements.main.querySelectorAll(selector).forEach((container) => {
    container.innerHTML = "";
  });

  if (!targetId || previewState.targetId === targetId) {
    previewState.targetId = null;
    previewState.text = "";
    previewState.parsed = null;
  }
}

function scheduleGhostPreview(targetId, text) {
  clearGhostPreview(targetId);

  if (!text.trim()) {
    return;
  }

  previewTimers.set(
    targetId,
    window.setTimeout(() => {
      const container = elements.main.querySelector(`[data-ghost-preview-for="${targetId}"]`);
      if (!container) {
        return;
      }

      const markup = renderGhostPreviewMarkup(text);
      container.innerHTML = markup;
      previewState.targetId = targetId;
      previewState.text = text;
      previewState.parsed = extractInlinePreview(text);
      previewTimers.delete(targetId);
    }, PREVIEW_DELAY_MS)
  );
}

function getTotalEstimate(tasks) {
  const taskIds = new Set(tasks.map((task) => task.id));

  function getChildrenFromPool(parentId) {
    return tasks.filter((task) => (task.parentId || null) === parentId);
  }

  function getBranchEstimate(task) {
    const children = getChildrenFromPool(task.id);
    if (!children.length) {
      return Number(task.estimateMinutes || 0);
    }

    const allChildrenEstimated = children.every((child) => Number(child.estimateMinutes || 0) > 0);
    if (allChildrenEstimated) {
      return children.reduce((sum, child) => sum + getBranchEstimate(child), 0);
    }

    return Number(task.manualEstimateMinutes || task.estimateMinutes || 0);
  }

  return tasks
    .filter((task) => !task.parentId || !taskIds.has(task.parentId))
    .reduce((sum, task) => sum + getBranchEstimate(task), 0);
}

function getOpenTasks(tasks) {
  return tasks.filter((task) => task.status !== "done");
}

function getPriorityWeight(priority) {
  return PRIORITY_WEIGHTS[priority] || 0;
}

function scheduleSave() {
  refreshDerivedTaskState();
  ui.saveState = "saving";
  renderSidebar();

  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveState, 300);
}

async function saveState() {
  try {
    const response = await fetch("/api/state", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(state)
    });

    if (!response.ok) {
      throw new Error("Could not save data");
    }

    state = normalizeState(await response.json());
    ui.saveState = "saved";
  } catch (error) {
    console.error(error);
    ui.saveState = "error";
  }

  renderAll();
}

async function loadState() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) {
      throw new Error("Could not load data");
    }

    state = normalizeState(await response.json());
    refreshDerivedTaskState();
    ui.saveState = "saved";
  } catch (error) {
    console.error(error);
    ui.saveState = "error";
  }

  renderAll();
}

function queueFocus(target) {
  ui.pendingFocus = target;
}

function applyPendingFocus() {
  if (!ui.pendingFocus) {
    return;
  }

  const target = elements.main.querySelector(`[data-focus-id="${ui.pendingFocus}"]`);
  if (target) {
    target.focus();
    if (target instanceof HTMLInputElement) {
      const length = target.value.length;
      target.setSelectionRange(length, length);
    }
  }

  ui.pendingFocus = null;
}

function createProject(name) {
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }

  const exists = state.projects.find((project) => project.name.toLowerCase() === trimmed.toLowerCase());
  if (exists) {
    ui.selectedProjectId = exists.id;
    renderAll();
    return;
  }

  const project = {
    id: uid("project"),
    name: trimmed,
    color: generateColor(trimmed)
  };
  rememberHistory();
  state.projects.push(project);
  ui.selectedProjectId = project.id;
  scheduleSave();
  renderAll();
}

function deleteProject(projectId) {
  const project = getProject(projectId);
  if (!project) {
    return;
  }

  rememberHistory();
  state.projects = state.projects.filter((item) => item.id !== projectId);
  state.tasks.forEach((task) => {
    if (task.projectId === projectId) {
      task.projectId = "";
    }
  });

  if (ui.selectedProjectId === projectId) {
    ui.selectedProjectId = "all";
  }

  scheduleSave();
  renderAll();
}

function deleteTag(tagId) {
  const tag = getTag(tagId);
  if (!tag) {
    return;
  }

  rememberHistory();
  state.tags = state.tags.filter((item) => item.id !== tagId);
  state.tasks.forEach((task) => {
    task.tagIds = task.tagIds.filter((value) => value !== tagId);
  });

  if (ui.selectedTagId === tagId) {
    ui.selectedTagId = "all";
  }

  scheduleSave();
  renderAll();
}

function createTaskAtEnd(rawTitle = "") {
  const rootTasks = sortTasks(getChildren(null));
  const task = normalizeTask({
    id: uid("task"),
    title: rawTitle.trim(),
    parentId: null,
    projectId: getCurrentContextProjectId(),
    tagIds: getCurrentContextTagIds(),
    order: rootTasks.length + 1,
    status: "todo"
  });

  const parsed = parseInlineTaskText(task.title, task);
  task.title = parsed.title;
  task.deadline = parsed.deadline;
  task.priority = parsed.priority;
  task.manualEstimateMinutes = parsed.estimateMinutes;
  task.estimateMinutes = parsed.estimateMinutes;
  task.tagIds = parsed.tagIds;

  rememberHistory();
  state.tasks.push(task);
  normalizeSiblingOrders(null);
  queueFocus(task.id);
  scheduleSave();
  renderAll();
}

function createTaskAfter(taskId, initialTitle = "") {
  const current = getTask(taskId);
  if (!current) {
    createTaskAtEnd(initialTitle);
    return;
  }

  shiftSiblingOrders(current.parentId, Number(current.order) + 1);
  const task = normalizeTask({
    id: uid("task"),
    title: initialTitle.trim(),
    parentId: current.parentId,
    projectId: current.projectId || getCurrentContextProjectId(),
    tagIds: getCurrentContextTagIds(),
    order: Number(current.order) + 1,
    status: "todo"
  });

  const parsed = parseInlineTaskText(task.title, task);
  task.title = parsed.title;
  task.deadline = parsed.deadline;
  task.priority = parsed.priority;
  task.manualEstimateMinutes = parsed.estimateMinutes;
  task.estimateMinutes = parsed.estimateMinutes;
  task.tagIds = parsed.tagIds;

  rememberHistory();
  state.tasks.push(task);
  normalizeSiblingOrders(current.parentId);
  queueFocus(task.id);
  scheduleSave();
  renderAll();
}

function createChildTask(parentId, initialTitle = "") {
  const parent = getTask(parentId);
  if (!parent) {
    createTaskAtEnd(initialTitle);
    return;
  }

  const task = normalizeTask({
    id: uid("task"),
    title: initialTitle.trim(),
    parentId,
    projectId: parent.projectId || getCurrentContextProjectId(),
    tagIds: getCurrentContextTagIds(),
    order: getChildren(parentId).length + 1,
    status: "todo"
  });

  const parsed = parseInlineTaskText(task.title, task);
  task.title = parsed.title;
  task.deadline = parsed.deadline;
  task.priority = parsed.priority;
  task.manualEstimateMinutes = parsed.estimateMinutes;
  task.estimateMinutes = parsed.estimateMinutes;
  task.tagIds = parsed.tagIds;

  rememberHistory();
  state.tasks.push(task);
  normalizeSiblingOrders(parentId);
  queueFocus(task.id);
  scheduleSave();
  renderAll();
}

function moveTaskAsChild(taskId, parentId) {
  const task = getTask(taskId);
  const parent = getTask(parentId);

  if (!task || !parent || task.id === parent.id) {
    return;
  }

  if (getDescendantIds(task.id).has(parent.id)) {
    return;
  }

  const oldParentId = task.parentId || null;
  const oldSiblings = sortTasks(getChildren(oldParentId).filter((item) => item.id !== task.id));
  const newSiblings = sortTasks(getChildren(parent.id).filter((item) => item.id !== task.id));

  rememberHistory();
  newSiblings.push(task);
  setChildrenOrder(parent.id, newSiblings);

  if (oldParentId !== parent.id) {
    setChildrenOrder(oldParentId, oldSiblings);
  }

  if (!task.projectId && parent.projectId) {
    task.projectId = parent.projectId;
  }

  queueFocus(task.id);
  scheduleSave();
  renderAll();
}

function moveTaskAfter(taskId, targetId) {
  const task = getTask(taskId);
  const target = getTask(targetId);

  if (!task || !target || task.id === target.id) {
    return;
  }

  if (getDescendantIds(task.id).has(target.id)) {
    return;
  }

  const oldParentId = task.parentId || null;
  const newParentId = target.parentId || null;
  const targetSiblings = sortTasks(getChildren(newParentId).filter((item) => item.id !== task.id));
  const insertIndex = targetSiblings.findIndex((item) => item.id === target.id);

  if (insertIndex === -1) {
    return;
  }

  const oldSiblings = sortTasks(getChildren(oldParentId).filter((item) => item.id !== task.id));
  rememberHistory();
  targetSiblings.splice(insertIndex + 1, 0, task);
  setChildrenOrder(newParentId, targetSiblings);

  if (oldParentId !== newParentId) {
    setChildrenOrder(oldParentId, oldSiblings);
  }

  if (!task.projectId && target.projectId) {
    task.projectId = target.projectId;
  }

  queueFocus(task.id);
  scheduleSave();
  renderAll();
}

function updateTask(taskId, patch) {
  const task = getTask(taskId);
  if (!task) {
    return;
  }

  rememberHistory();
  Object.assign(task, patch);
  scheduleSave();
  renderAll();
}

function stopActiveTimer(task) {
  if (!task || task.status !== "active" || !task.activeStartedAt) {
    return;
  }

  const startedAt = new Date(task.activeStartedAt).getTime();
  if (!Number.isFinite(startedAt)) {
    task.activeStartedAt = "";
    return;
  }

  task.trackedMs = Number(task.trackedMs || 0) + Math.max(0, Date.now() - startedAt);
  task.activeStartedAt = "";
}

function setTaskStatus(taskId, nextStatus) {
  const task = getTask(taskId);
  if (!task || !nextStatus) {
    return;
  }

  const normalizedNextStatus = nextStatus === "inactive" ? task.previousStatus || "todo" : nextStatus;
  if (task.status === normalizedNextStatus) {
    return;
  }

  rememberHistory();

  if (normalizedNextStatus === "active") {
    state.tasks.forEach((item) => {
      if (item.id !== task.id && item.status === "active") {
        stopActiveTimer(item);
        item.previousStatus = item.previousStatus || "todo";
        item.status = "hold";
      }
    });

    task.previousStatus =
      task.status === "active" ? task.previousStatus || "todo" : task.status === "done" ? "todo" : task.status || "todo";
    task.status = "active";
    task.activeStartedAt = new Date().toISOString();
  } else {
    stopActiveTimer(task);
    task.status = normalizedNextStatus;
    if (normalizedNextStatus !== "done") {
      task.previousStatus = normalizedNextStatus === "hold" ? "todo" : task.previousStatus || "todo";
    }
  }

  if (normalizedNextStatus === "done") {
    task.previousStatus = "todo";
  }

  if (preferences.behavior.completedToArchive && normalizedNextStatus === "done") {
    ui.completedOnly = false;
  }

  scheduleSave();
  renderAll();
}

function toggleActiveTask(taskId) {
  const task = getTask(taskId);
  if (!task || task.status === "done") {
    return;
  }

  if (task.status === "active") {
    setTaskStatus(task.id, task.previousStatus || "todo");
    return;
  }

  setTaskStatus(task.id, "active");
}

function applyTaskInput(taskId, inputValue) {
  const task = getTask(taskId);
  if (!task) {
    return;
  }

  const parsed = parseInlineTaskText(inputValue, task);
  const hasChildren = getChildren(task.id).length > 0;

  if (!parsed.title && !hasChildren) {
    deleteTask(taskId);
    return;
  }

  updateTask(taskId, {
    title: parsed.title || (hasChildren ? task.title || "Untitled" : ""),
    deadline: parsed.deadline,
    priority: parsed.priority,
    manualEstimateMinutes: parsed.estimateMinutes,
    estimateMinutes: parsed.estimateMinutes,
    tagIds: parsed.tagIds
  });
}

function deleteTask(taskId) {
  const ids = getDescendantIds(taskId);
  ids.add(taskId);

  const task = getTask(taskId);
  const parentId = task?.parentId || null;
  const flatRows = flattenVisibleTree(getVisibleTaskIds());
  const currentIndex = flatRows.findIndex((row) => row.task.id === taskId);
  const previous = currentIndex > 0 ? flatRows[currentIndex - 1]?.task?.id : null;

  rememberHistory();
  state.tasks = state.tasks.filter((item) => !ids.has(item.id));
  ids.forEach((id) => ui.taskSelection.delete(id));
  if (!ui.taskSelection.size) {
    ui.bulkEditOpen = false;
  }
  normalizeSiblingOrders(parentId);

  if (previous) {
    queueFocus(previous);
  } else {
    queueFocus("new-task");
  }

  scheduleSave();
  renderAll();
}

function toggleTaskSelection(taskId) {
  if (!taskId) {
    return;
  }

  if (ui.taskSelection.has(taskId)) {
    ui.taskSelection.delete(taskId);
  } else {
    ui.taskSelection.add(taskId);
  }

  if (!ui.taskSelection.size) {
    ui.bulkEditOpen = false;
  }

  renderMain();
}

function deleteSelectedTasks() {
  const selectedIds = [...ui.taskSelection];
  if (!selectedIds.length) {
    return;
  }

  const parentIds = new Set();
  selectedIds.forEach((taskId) => {
    const task = getTask(taskId);
    if (task) {
      parentIds.add(task.parentId || null);
    }
  });

  rememberHistory();
  const allIds = new Set();
  selectedIds.forEach((taskId) => {
    allIds.add(taskId);
    getDescendantIds(taskId).forEach((id) => allIds.add(id));
  });

  state.tasks = state.tasks.filter((task) => !allIds.has(task.id));
  parentIds.forEach((parentId) => normalizeSiblingOrders(parentId));

  clearTaskSelection();
  queueFocus("new-task");
  scheduleSave();
  renderAll();
}

function applyBulkEdit(payload) {
  const selectedTasks = getSelectedTasks();
  if (!selectedTasks.length) {
    return;
  }

  const projectId = payload.projectId || BULK_ACTION_PRESETS.keep;
  const deadline = payload.deadline ?? BULK_ACTION_PRESETS.keep;
  const tagAction = payload.tagAction || BULK_ACTION_PRESETS.keep;
  const tagId = payload.tagId || "";

  rememberHistory();
  selectedTasks.forEach((task) => {
    if (projectId !== BULK_ACTION_PRESETS.keep) {
      task.projectId = projectId === BULK_ACTION_PRESETS.clear ? "" : projectId;
    }

    if (deadline !== BULK_ACTION_PRESETS.keep) {
      task.deadline = deadline === BULK_ACTION_PRESETS.clear ? "" : deadline;
    }

    if (tagAction === "add" && tagId && !task.tagIds.includes(tagId)) {
      task.tagIds = [...task.tagIds, tagId];
    }

    if (tagAction === "remove" && tagId) {
      task.tagIds = task.tagIds.filter((value) => value !== tagId);
    }

    if (tagAction === BULK_ACTION_PRESETS.clear) {
      task.tagIds = [];
    }
  });

  clearTaskSelection();
  scheduleSave();
  renderAll();
}

function toggleTaskDone(taskId) {
  const task = getTask(taskId);
  if (!task) {
    return;
  }

  setTaskStatus(taskId, task.status === "done" ? "todo" : "done");
}

function indentTask(taskId) {
  const task = getTask(taskId);
  if (!task) {
    return;
  }

  const siblings = sortTasks(getChildren(task.parentId));
  const index = siblings.findIndex((item) => item.id === task.id);
  const previousSibling = index > 0 ? siblings[index - 1] : null;

  if (!previousSibling) {
    return;
  }

  rememberHistory();
  const oldParentId = task.parentId;
  task.parentId = previousSibling.id;
  task.order = getChildren(previousSibling.id).length + 1;
  normalizeSiblingOrders(oldParentId);
  normalizeSiblingOrders(previousSibling.id);
  queueFocus(taskId);
  scheduleSave();
  renderAll();
}

function outdentTask(taskId) {
  const task = getTask(taskId);
  if (!task?.parentId) {
    return;
  }

  const parent = getTask(task.parentId);
  if (!parent) {
    return;
  }

  const oldParentId = task.parentId;
  const newParentId = parent.parentId || null;

  rememberHistory();
  shiftSiblingOrders(newParentId, Number(parent.order) + 1);
  task.parentId = newParentId;
  task.order = Number(parent.order) + 1;
  normalizeSiblingOrders(oldParentId);
  normalizeSiblingOrders(newParentId);
  queueFocus(taskId);
  scheduleSave();
  renderAll();
}

function clearTaskMeta(taskId, type, value = "") {
  const task = getTask(taskId);
  if (!task) {
    return;
  }

  rememberHistory();
  if (type === "deadline") {
    task.deadline = "";
  }

  if (type === "priority") {
    task.priority = "";
  }

  if (type === "estimate") {
    task.manualEstimateMinutes = "";
    task.estimateMinutes = "";
  }

  if (type === "tag") {
    task.tagIds = task.tagIds.filter((tagId) => tagId !== value);
  }

  scheduleSave();
  renderAll();
}

function renderSidebar() {
  const visibleTasks = state.tasks.filter((task) => getVisibleTaskIds().has(task.id));
  const saveLabel =
    ui.saveState === "saving" ? "Saving" : ui.saveState === "error" ? "Save error" : "Saved";

  elements.sidebar.innerHTML = `
    <section class="nav-shell">
      <div class="nav-header">
        <div>
          <h1>Planner</h1>
        </div>
        <button class="save-pill ${ui.saveState}" id="save-info-toggle" type="button">
          <span class="save-dot"></span>
          <span>${saveLabel}</span>
        </button>
      </div>

      ${
        ui.saveInfoOpen
          ? `
            <div class="save-note">
              Autosave writes your current state into the local JSON file in this workspace. Green means the latest changes are already on disk.
            </div>
          `
          : ""
      }

      <div class="nav-scroll">
        <section class="nav-group">
        <div class="view-switch">
          <button class="view-button ${ui.view === "tasks" ? "active" : ""}" data-view="tasks">Tasks</button>
          <button class="view-button ${ui.view === "kanban" ? "active" : ""}" data-view="kanban">Kanban</button>
          <button class="view-button ${ui.view === "map" ? "active" : ""}" data-view="map">MindMap</button>
          <button class="view-button ${ui.view === "status" ? "active" : ""}" data-view="status">Status</button>
        </div>
        </section>

        <section class="nav-group">
          <div class="section-heading">
          <h2>Scope</h2>
        </div>
        <button class="sidebar-link ${ui.selectedProjectId === "all" && ui.selectedTagId === "all" && ui.smartScope === "none" && !ui.completedOnly ? "active" : ""}" data-scope="inbox">
          <span>Inbox</span>
          <strong>${getVisibleNavTaskCount()}</strong>
        </button>
        <button class="sidebar-link ${ui.smartScope === "quick15" && !ui.completedOnly ? "active" : ""}" data-scope="quick15">
          <span>Quick 15m</span>
          <strong>${state.tasks.filter((task) => !isTaskArchivedByPreference(task) && matchesSmartScope(task, "quick15")).length}</strong>
        </button>
        <button class="sidebar-link ${ui.completedOnly ? "active" : ""}" data-scope="completed">
          <span>Completed</span>
          <strong>${state.tasks.filter((task) => task.status === "done").length}</strong>
        </button>
        </section>

        <section class="nav-group">
          <div class="section-heading">
          <h2>Projects</h2>
          <button class="text-button" id="toggle-project-edit" type="button">${ui.projectEditMode ? "Done" : "Edit"}</button>
        </div>
        ${
          ui.projectComposerOpen
            ? `
              <form id="project-form" class="project-form">
                <input name="name" placeholder="Project name" />
                <button class="mini-button" type="submit">Save</button>
              </form>
            `
            : `<button class="mini-button nav-action" id="open-project-composer" type="button">Add project</button>`
        }
        <div class="sidebar-list">
          ${sortByName(state.projects)
            .map((project) => {
              const count = getVisibleNavTaskCount(project.id, "all");
              return `
                <div class="sidebar-item-row">
                  <button class="sidebar-link ${ui.selectedProjectId === project.id ? "active" : ""}" data-project-filter="${escapeHtml(project.id)}">
                    <span>${escapeHtml(project.name)}</span>
                    <strong>${count}</strong>
                  </button>
                  ${
                    ui.projectEditMode
                      ? `<button class="icon-button danger" data-delete-project="${escapeHtml(project.id)}" title="Delete project">×</button>`
                      : ""
                  }
                </div>
              `;
            })
            .join("")}
        </div>
        </section>

        <section class="nav-group">
          <div class="section-heading">
          <h2>Tags</h2>
          <button class="text-button" id="toggle-tag-edit" type="button">${ui.tagEditMode ? "Done" : "Edit"}</button>
        </div>
        <div class="sidebar-list">
          ${sortByName(state.tags)
            .map((tag) => {
              const count = getVisibleNavTaskCount("all", tag.id);
              return `
                <div class="sidebar-item-row">
                  <button class="sidebar-link ${ui.selectedTagId === tag.id ? "active" : ""}" data-tag-filter="${escapeHtml(tag.id)}">
                    <span class="tag-dot" style="background:${escapeHtml(tag.color || "#d8b4a0")}"></span>
                    <span>#${escapeHtml(tag.name)}</span>
                    <strong>${count}</strong>
                  </button>
                  ${
                    ui.tagEditMode
                      ? `<button class="icon-button danger" data-delete-tag="${escapeHtml(tag.id)}" title="Delete tag">×</button>`
                      : ""
                  }
                </div>
              `;
            })
            .join("")}
        </div>
        </section>
      </div>

      <div class="nav-footer">
        <div class="nav-footer-row">
          <span class="nav-version">${escapeHtml(preferences.versionLabel)}</span>
          <button class="mini-button nav-settings-toggle" id="toggle-settings">
            ${ui.settingsOpen ? "Close" : "Settings"}
          </button>
        </div>

        ${
          ui.settingsOpen
            ? `
              <div class="settings-panel">
                <div class="settings-row">
                  <label for="theme-mode">Theme</label>
                  <select id="theme-mode" class="settings-select">
                    <option value="sand" ${preferences.themeMode === "sand" ? "selected" : ""}>Sand</option>
                    <option value="midnight" ${preferences.themeMode === "midnight" ? "selected" : ""}>Midnight</option>
                  </select>
                </div>
                <label class="settings-check">
                  <input type="checkbox" id="completed-to-archive" ${preferences.behavior.completedToArchive ? "checked" : ""} />
                  <span>Move completed tasks to Completed view</span>
                </label>
                <div class="settings-grid">
                  <label><span>Accent 1</span><input type="color" data-color-setting="accent" value="${escapeHtml(preferences.colors.accent)}" /></label>
                  <label><span>Accent 2</span><input type="color" data-color-setting="accent2" value="${escapeHtml(preferences.colors.accent2)}" /></label>
                  <label><span>Accent 3</span><input type="color" data-color-setting="accent3" value="${escapeHtml(preferences.colors.accent3)}" /></label>
                  <label><span>Background</span><input type="color" data-color-setting="background" value="${escapeHtml(preferences.colors.background)}" /></label>
                  <label><span>Background 2</span><input type="color" data-color-setting="background2" value="${escapeHtml(preferences.colors.background2)}" /></label>
                  <label><span>Text</span><input type="color" data-color-setting="text" value="${escapeHtml(preferences.colors.text)}" /></label>
                </div>
              </div>
            `
            : ""
        }
      </div>
    </section>
  `;

  elements.sidebar.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      ui.view = button.getAttribute("data-view") || "tasks";
      renderAll();
    });
  });

  elements.sidebar.querySelector("#save-info-toggle")?.addEventListener("click", () => {
    ui.saveInfoOpen = !ui.saveInfoOpen;
    renderSidebar();
  });

  elements.sidebar.querySelector("[data-scope='inbox']")?.addEventListener("click", () => {
    ui.completedOnly = false;
    ui.smartScope = "none";
    ui.selectedProjectId = "all";
    ui.selectedTagId = "all";
    renderAll();
  });

  elements.sidebar.querySelector("[data-scope='quick15']")?.addEventListener("click", () => {
    ui.completedOnly = false;
    ui.smartScope = "quick15";
    ui.selectedProjectId = "all";
    ui.selectedTagId = "all";
    renderAll();
  });

  elements.sidebar.querySelector("[data-scope='completed']")?.addEventListener("click", () => {
    ui.completedOnly = true;
    ui.smartScope = "none";
    ui.selectedProjectId = "all";
    ui.selectedTagId = "all";
    renderAll();
  });

  elements.sidebar.querySelectorAll("[data-project-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.getAttribute("data-project-filter") || "all";
      ui.completedOnly = false;
      ui.smartScope = "none";
      ui.selectedProjectId = ui.selectedProjectId === value ? "all" : value;
      renderAll();
    });
  });

  elements.sidebar.querySelectorAll("[data-delete-project]").forEach((button) => {
    button.addEventListener("click", () => {
      const projectId = button.getAttribute("data-delete-project");
      const project = getProject(projectId);
      if (!project) {
        return;
      }

      const shouldDelete = window.confirm(`Delete project "${project.name}"? Tasks will stay, but leave the project.`);
      if (shouldDelete) {
        deleteProject(projectId);
      }
    });
  });

  elements.sidebar.querySelectorAll("[data-tag-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.getAttribute("data-tag-filter") || "all";
      ui.completedOnly = false;
      ui.smartScope = "none";
      ui.selectedTagId = ui.selectedTagId === value ? "all" : value;
      renderAll();
    });
  });

  elements.sidebar.querySelector("#toggle-project-edit")?.addEventListener("click", () => {
    ui.projectEditMode = !ui.projectEditMode;
    renderSidebar();
  });

  elements.sidebar.querySelector("#toggle-tag-edit")?.addEventListener("click", () => {
    ui.tagEditMode = !ui.tagEditMode;
    renderSidebar();
  });

  elements.sidebar.querySelectorAll("[data-delete-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      const tagId = button.getAttribute("data-delete-tag");
      const tag = getTag(tagId);
      if (!tag) {
        return;
      }

      const shouldDelete = window.confirm(`Delete tag "#${tag.name}"? It will be removed from all tasks.`);
      if (shouldDelete) {
        deleteTag(tagId);
      }
    });
  });

  elements.sidebar.querySelector("#open-project-composer")?.addEventListener("click", () => {
    ui.projectComposerOpen = true;
    renderSidebar();
    elements.sidebar.querySelector("#project-form input")?.focus();
  });

  elements.sidebar.querySelector("#project-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    if (!name) {
      return;
    }

    ui.projectComposerOpen = false;
    createProject(name);
    event.currentTarget.reset();
  });

  elements.sidebar.querySelector("#toggle-settings")?.addEventListener("click", () => {
    ui.settingsOpen = !ui.settingsOpen;
    renderSidebar();
  });

  elements.sidebar.querySelector("#theme-mode")?.addEventListener("change", (event) => {
    setThemeMode(event.currentTarget.value);
    renderSidebar();
  });

  elements.sidebar.querySelector("#completed-to-archive")?.addEventListener("change", (event) => {
    preferences.behavior.completedToArchive = event.currentTarget.checked;
    if (!preferences.behavior.completedToArchive && ui.completedOnly) {
      ui.completedOnly = false;
    }
    persistPreferences();
    renderAll();
  });

  elements.sidebar.querySelectorAll("[data-color-setting]").forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.getAttribute("data-color-setting");
      if (!key) {
        return;
      }

      preferences.colors[key] = input.value;
      persistPreferences();
      applyPreferences();
    });
  });
}

function renderTaskRow(row) {
  const { task, depth } = row;
  const tags = task.tagIds.map(getTag).filter(Boolean);
  const parent = task.parentId ? getTask(task.parentId) : null;
  const meta = [];
  const metaTaskId = task.id;

  if (task.status === "active" || task.status === "hold") {
    meta.push(`<span class="meta-chip status-chip ${getStatusTone(task.status)}">${escapeHtml(getStatusLabel(task.status))}</span>`);
  }

  if (task.deadline) {
    meta.push(`
      <button class="meta-chip" data-clear-meta="deadline" data-task-id="${escapeHtml(task.id)}">
        ${escapeHtml(formatDate(task.deadline))}
      </button>
    `);
  }

  const priorityLabel = formatPriority(task.priority);

  if (priorityLabel) {
    meta.push(`
      <button class="meta-chip priority-chip" data-clear-meta="priority" data-task-id="${escapeHtml(task.id)}">
        ${escapeHtml(priorityLabel)}
      </button>
    `);
  }

  if (task.estimateMinutes) {
    meta.push(`
      <button class="meta-chip" data-clear-meta="estimate" data-task-id="${escapeHtml(task.id)}">
        ${escapeHtml(formatEstimate(task.estimateMinutes))}
      </button>
    `);
  }

  tags.forEach((tag) => {
    meta.push(`
      <button class="meta-chip" data-clear-meta="tag" data-meta-value="${escapeHtml(tag.id)}" data-task-id="${escapeHtml(task.id)}">
        #${escapeHtml(tag.name)}
      </button>
    `);
  });

  const isExpanded = ui.expandedMetaTaskIds.has(metaTaskId);
  const visibleMeta = isExpanded ? meta : meta.slice(0, 2);
  const hiddenMetaCount = Math.max(meta.length - visibleMeta.length, 0);

  const isSelected = ui.taskSelection.has(task.id);

  return `
    <div class="task-row depth-${Math.min(depth, 6)} ${task.status === "done" ? "done" : ""} ${task.status === "active" ? "active" : ""} ${task.status === "hold" ? "hold" : ""} ${isSelected ? "selected" : ""}">
      <button class="select-button ${isSelected ? "selected" : ""}" data-select-task="${escapeHtml(task.id)}" aria-label="Select task"></button>
      <button class="check-button ${task.status === "done" ? "checked" : ""}" data-toggle-done="${escapeHtml(task.id)}" aria-label="Toggle done"></button>
      <div class="task-body">
        <input
          class="task-input"
          data-task-input="${escapeHtml(task.id)}"
          data-focus-id="${escapeHtml(task.id)}"
          value="${escapeHtml(task.title)}"
          placeholder="Task"
          spellcheck="false"
        />
        ${
          (ui.selectedTagId !== "all" || ui.completedOnly || ui.smartScope !== "none") && parent
            ? `<div class="task-context-line">From <span>${escapeHtml(parent.title || "Untitled task")}</span></div>`
            : ""
        }
        <div class="ghost-preview" data-ghost-preview-for="${escapeHtml(task.id)}"></div>
        ${
          meta.length
            ? `
              <div class="task-meta-line">
                ${visibleMeta.join("")}
                ${
                  hiddenMetaCount
                    ? `<button class="meta-chip ghost-chip" data-toggle-meta="${escapeHtml(task.id)}">+${hiddenMetaCount}</button>`
                    : ""
                }
                ${
                  isExpanded && meta.length > 2
                    ? `<button class="meta-chip ghost-chip" data-toggle-meta="${escapeHtml(task.id)}">Hide</button>`
                    : ""
                }
              </div>
            `
            : ""
        }
      </div>
      <div class="row-tools">
        <button class="row-tool" data-add-below="${escapeHtml(task.id)}" title="Add below">+ below</button>
        <button class="row-tool" data-add-child="${escapeHtml(task.id)}" title="Add child">+ child</button>
        <button class="row-tool" data-indent="${escapeHtml(task.id)}" title="Nest deeper">nest</button>
        <button class="row-tool" data-outdent="${escapeHtml(task.id)}" title="Move up">up</button>
        <button class="row-tool danger" data-delete-task="${escapeHtml(task.id)}" title="Delete">Del</button>
      </div>
    </div>
  `;
}

function renderTasksView(visibleIds) {
  const rows = flattenVisibleTree(visibleIds);
  const selectedTasks = getSelectedTasks();
  const canCreateTasks = !ui.completedOnly;
  const sortLabels = {
    deadline: "Deadline",
    priority: "Priority",
    estimate: "Time"
  };

  return `
    <section class="canvas-shell">
      <div class="canvas-topbar">
        <div>
          <h2>${escapeHtml(getCurrentScopeLabel())}</h2>
        </div>
        <div class="canvas-controls">
          <input id="search-input" class="search-input" value="${escapeHtml(ui.search)}" placeholder="Search tasks, tags, projects" />
          ${canCreateTasks ? '<button class="mini-button" id="new-root-task">New line</button>' : ""}
        </div>
      </div>

      <div class="sort-bar">
        <span class="sort-label">Sort</span>
        ${["deadline", "priority", "estimate"]
          .map((criterion) => {
            const index = ui.sortCriteria.findIndex((item) => item.key === criterion);
            const direction = getSortDirection(criterion);
            const stateLabel = index >= 0 ? `${direction === "desc" ? "↓" : "↑"}${index + 1}` : " ";
            return `
              <button class="sort-chip ${index >= 0 ? "active" : ""}" data-sort-toggle="${criterion}" type="button">
                ${escapeHtml(sortLabels[criterion])}
                <span class="sort-chip-state">${escapeHtml(stateLabel)}</span>
              </button>
            `;
          })
          .join("")}
        ${
          ui.sortCriteria.length
            ? '<button class="sort-chip" id="clear-sort" type="button">Clear</button>'
            : ""
        }
      </div>

      ${
        selectedTasks.length
          ? `
            <section class="bulk-bar">
              <div class="bulk-bar-head">
                <strong>${selectedTasks.length} selected</strong>
                <div class="bulk-bar-actions">
                  <button class="mini-button" id="toggle-bulk-edit">${ui.bulkEditOpen ? "Hide edit" : "Edit selected"}</button>
                  <button class="mini-button" id="clear-selection">Clear</button>
                  <button class="mini-button danger-button" id="delete-selected">Delete</button>
                </div>
              </div>
              ${
                ui.bulkEditOpen
                  ? `
                    <form id="bulk-edit-form" class="bulk-form">
                      <label>
                        <span>Project</span>
                        <select name="projectId" class="settings-select">
                          <option value="${BULK_ACTION_PRESETS.keep}">Keep current</option>
                          <option value="${BULK_ACTION_PRESETS.clear}">Remove project</option>
                          ${sortByName(state.projects)
                            .map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`)
                            .join("")}
                        </select>
                      </label>
                      <label>
                        <span>Deadline</span>
                        <select name="deadlineMode" class="settings-select">
                          <option value="${BULK_ACTION_PRESETS.keep}">Keep current</option>
                          <option value="set">Set date</option>
                          <option value="${BULK_ACTION_PRESETS.clear}">Clear date</option>
                        </select>
                      </label>
                      <label>
                        <span>Date</span>
                        <input type="date" name="deadline" class="settings-select" />
                      </label>
                      <label>
                        <span>Tags</span>
                        <select name="tagAction" class="settings-select">
                          <option value="${BULK_ACTION_PRESETS.keep}">Keep tags</option>
                          <option value="add">Add tag</option>
                          <option value="remove">Remove tag</option>
                          <option value="${BULK_ACTION_PRESETS.clear}">Clear tags</option>
                        </select>
                      </label>
                      <label>
                        <span>Tag</span>
                        <select name="tagId" class="settings-select">
                          <option value="">Choose tag</option>
                          ${sortByName(state.tags)
                            .map((tag) => `<option value="${escapeHtml(tag.id)}">#${escapeHtml(tag.name)}</option>`)
                            .join("")}
                        </select>
                      </label>
                      <button class="mini-button" type="submit">Apply</button>
                    </form>
                  `
                  : ""
              }
            </section>
          `
          : ""
      }

      <section class="paper">
        <div class="task-list">
          ${rows.length ? rows.map(renderTaskRow).join("") : '<div class="empty-paper">No tasks yet.</div>'}
          ${
            canCreateTasks
              ? `
                <div class="task-row composer">
                  <span class="composer-spacer"></span>
                  <span class="composer-dot"></span>
                  <div class="task-body">
                    <input
                      class="task-input"
                      id="new-task-input"
                      data-focus-id="new-task"
                      placeholder="New task"
                      spellcheck="false"
                    />
                    <div class="ghost-preview" data-ghost-preview-for="new-task"></div>
                  </div>
                </div>
              `
              : ""
          }
        </div>
      </section>
    </section>
  `;
}

function buildFlowLanes(visibleIds) {
  const lanes = [];

  function walk(task, branch) {
    const nextBranch = [...branch, task];
    const children = sortTasksForDisplay(getChildren(task.id)).filter((child) => visibleIds.has(child.id));

    if (!children.length) {
      lanes.push(nextBranch);
      return;
    }

    children.forEach((child) => walk(child, nextBranch));
  }

  sortTasksForDisplay(
    state.tasks.filter((task) => visibleIds.has(task.id) && (!task.parentId || !visibleIds.has(task.parentId)))
  ).forEach((root) => walk(root, []));

  return lanes;
}

function getVisibleRoots(visibleIds) {
  return sortTasksForDisplay(
    state.tasks.filter((task) => visibleIds.has(task.id) && (!task.parentId || !visibleIds.has(task.parentId)))
  );
}

function getDisplayBranch(branch) {
  return ui.mapDirection === "reverse" ? [...branch].reverse() : branch;
}

function getDirectionLabel() {
  return ui.mapDirection === "reverse" ? "Flip to root -> leaf" : "Flip to leaf -> root";
}

function getSideActionClass() {
  return ui.mapDirection === "reverse" ? "left" : "right";
}

function getProjectTone(project) {
  return project?.color || "#7fb3a7";
}

function renderMapMeta(task) {
  const tags = task.tagIds.map(getTag).filter(Boolean);
  const priorityLabel = formatPriority(task.priority);

  return `
    <div class="map-meta">
      ${task.status === "active" || task.status === "hold" ? `<span class="status-chip ${getStatusTone(task.status)}">${escapeHtml(getStatusLabel(task.status))}</span>` : ""}
      ${task.deadline ? `<span>${escapeHtml(formatDate(task.deadline))}</span>` : ""}
      ${priorityLabel ? `<span>${escapeHtml(priorityLabel)}</span>` : ""}
      ${task.estimateMinutes ? `<span>${escapeHtml(formatEstimate(task.estimateMinutes))}</span>` : ""}
      ${tags.map((tag) => `<span>#${escapeHtml(tag.name)}</span>`).join("")}
    </div>
  `;
}

function buildTimelineBuckets(visibleIds) {
  const tasks = state.tasks
    .filter((task) => visibleIds.has(task.id))
    .sort((a, b) => {
      const noDeadlineA = a.deadline ? 1 : 0;
      const noDeadlineB = b.deadline ? 1 : 0;
      const deadlineOrder = getDeadlineWeight(a) - getDeadlineWeight(b);
      return noDeadlineA - noDeadlineB || deadlineOrder || compareTasks(a, b) || a.title.localeCompare(b.title, "ru");
    });

  const bucketMap = new Map();
  tasks.forEach((task) => {
    const key = task.deadline || "__no_deadline__";
    if (!bucketMap.has(key)) {
      bucketMap.set(key, []);
    }
    bucketMap.get(key).push(task);
  });

  return [...bucketMap.entries()].map(([key, items]) => ({
    key,
    label: key === "__no_deadline__" ? "No deadline" : formatDate(key),
    items
  }));
}

function renderTimelineView(visibleIds) {
  const buckets = buildTimelineBuckets(visibleIds);

  return `
    <div class="timeline-board">
      ${buckets
        .map(
          (bucket) => `
            <section class="timeline-column">
              <div class="timeline-head">
                <strong>${escapeHtml(bucket.label)}</strong>
                <span>${bucket.items.length}</span>
              </div>
              <div class="timeline-track">
                ${bucket.items.map((task) => renderMapNodeCard(task, { graph: true, timeline: true })).join("")}
              </div>
            </section>
          `
        )
        .join("")}
    </div>
  `;
}

function renderMapNodeCard(task, options = {}) {
  const sideActionClass = getSideActionClass();
  const shellClass = options.graph ? "graph-card-shell" : "lane-card-shell";
  const canCreateChild = !options.timeline && ui.mapDirection !== "reverse";
  const canCreateSibling = !options.timeline;
  const project = getProject(task.projectId);
  const projectTone = getProjectTone(project);

  return `
    <div class="map-node-shell ${shellClass}" style="--project-tone:${escapeHtml(projectTone)};">
      ${
        canCreateChild
          ? `
            <button
              class="node-plus node-plus-side ${sideActionClass}"
              data-map-add-child="${escapeHtml(task.id)}"
              title="Add nested task"
            >
              +
            </button>
          `
          : ""
      }

      <article
        class="map-card ${task.status === "done" ? "done" : ""}"
        draggable="${options.timeline ? "false" : "true"}"
        ${options.timeline ? "" : `data-drag-task="${escapeHtml(task.id)}"`}
        ${canCreateChild ? `data-drop-child-card="${escapeHtml(task.id)}"` : ""}
      >
        <input
          class="map-card-input"
          data-map-task-input="${escapeHtml(task.id)}"
          value="${escapeHtml(task.title || "")}"
          placeholder="Task"
          spellcheck="false"
        />
        <div class="ghost-preview map-ghost-preview" data-ghost-preview-for="map-${escapeHtml(task.id)}"></div>
        ${renderMapMeta(task)}
      </article>

      ${
        canCreateSibling
          ? `
            <button
              class="node-plus node-plus-bottom"
              data-map-add-sibling="${escapeHtml(task.id)}"
              title="Add sibling task"
            >
              +
            </button>
          `
          : ""
      }
    </div>
  `;
}

function renderGraphNode(task, visibleIds) {
  const children = sortTasksForDisplay(getChildren(task.id)).filter((child) => visibleIds.has(child.id));
  const reverseClass = ui.mapDirection === "reverse" ? "reverse" : "";

  return `
    <div class="graph-node ${reverseClass}">
      ${renderMapNodeCard(task, { graph: true })}
      ${
        children.length
          ? `
            <div class="graph-children">
              ${children.map((child) => renderGraphNode(child, visibleIds)).join("")}
            </div>
          `
          : ""
      }
    </div>
  `;
}

function renderMapView(visibleIds) {
  const lanes = buildFlowLanes(visibleIds);
  const visibleRoots = getVisibleRoots(visibleIds);

  if (!visibleRoots.length) {
    return `
      <section class="canvas-shell">
        <div class="empty-paper">No branches yet. Create tasks in the main list, then come back here.</div>
      </section>
    `;
  }

  return `
    <section class="canvas-shell">
      <div class="canvas-topbar">
        <div>
          <h2>${escapeHtml(getCurrentScopeLabel())}</h2>
          <p>Switch between paths, one combined tree, and a lightweight deadline timeline.</p>
        </div>
        <div class="map-toolbar">
            <div class="segmented-control">
            <button class="view-button ${ui.mapLayout === "lanes" ? "active" : ""}" data-map-layout="lanes">Paths</button>
            <button class="view-button ${ui.mapLayout === "graph" ? "active" : ""}" data-map-layout="graph">Tree</button>
            <button class="view-button ${ui.mapLayout === "timeline" ? "active" : ""}" data-map-layout="timeline">Timeline</button>
          </div>
          ${
            ui.mapLayout === "timeline"
              ? ""
              : `
                <button class="mini-button" data-map-direction="${ui.mapDirection === "forward" ? "reverse" : "forward"}">
                  ${escapeHtml(getDirectionLabel())}
                </button>
              `
          }
        </div>
      </div>
      ${
        ui.mapLayout === "timeline"
          ? renderTimelineView(visibleIds)
          : ui.mapLayout === "graph"
          ? `
            <div class="graph-board">
              ${visibleRoots
                .map(
                  (root) => `
                    <section class="graph-root">
                      ${renderGraphNode(root, visibleIds)}
                    </section>
                  `
                )
                .join("")}
            </div>
          `
          : `
            <div class="map-board">
              ${lanes
                .map((lane, index) => {
                  const displayLane = getDisplayBranch(lane);
                  const nextOpen =
                    ui.mapDirection === "reverse"
                      ? [...displayLane].find((task) => task.status !== "done")
                      : displayLane.find((task) => task.status !== "done");

                  return `
                    <section class="lane">
                      <div class="lane-head">
                        <div>
                          <strong>Lane ${index + 1}</strong>
                          <span>${escapeHtml(nextOpen?.title || "Completed")}</span>
                        </div>
                      </div>
                      <div class="lane-track">
                        ${displayLane.map((task) => renderMapNodeCard(task)).join("")}
                      </div>
                    </section>
                  `;
                })
                .join("")}
            </div>
          `
      }
    </section>
  `;
}

function renderKanbanCard(task) {
  const tags = task.tagIds.map(getTag).filter(Boolean);
  const parent = task.parentId ? getTask(task.parentId) : null;
  const project = getProject(task.projectId);
  const trackedMs = getTrackedMs(task);
  const actualLabel =
    task.status === "active"
      ? `<strong class="kanban-timer" data-live-timer-task="${escapeHtml(task.id)}">${escapeHtml(formatTimer(trackedMs))}</strong>`
      : `<strong class="kanban-timer static">${escapeHtml(formatTrackedDuration(trackedMs))}</strong>`;
  const baselineEstimate = getPlannedBaselineEstimate(task);

  return `
    <article
      class="kanban-card ${task.status === "active" ? "active" : ""} ${task.status === "hold" ? "hold" : ""} ${task.status === "done" ? "done" : ""}"
      style="--project-tone:${escapeHtml(getProjectTone(project))};"
      draggable="true"
      data-kanban-task="${escapeHtml(task.id)}"
      ${task.status !== "done" ? `data-kanban-toggle-active="${escapeHtml(task.id)}"` : ""}
    >
      <div class="kanban-card-top">
        <span class="status-chip ${getStatusTone(task.status)}">${escapeHtml(getStatusLabel(task.status))}</span>
        ${baselineEstimate ? `<span class="kanban-pill">${escapeHtml(formatEstimate(baselineEstimate))}</span>` : ""}
      </div>
      <h3>${escapeHtml(task.title || "Untitled task")}</h3>
      ${
        (ui.selectedTagId !== "all" || ui.completedOnly || ui.smartScope !== "none") && parent
          ? `<div class="task-context-line">From <span>${escapeHtml(parent.title || "Untitled task")}</span></div>`
          : ""
      }
      <div class="kanban-meta">
        ${task.deadline ? `<span class="kanban-pill">${escapeHtml(formatDate(task.deadline))}</span>` : ""}
        ${tags.map((tag) => `<span class="kanban-pill">#${escapeHtml(tag.name)}</span>`).join("")}
      </div>
      <div class="kanban-timer-row">
        <span>Actual</span>
        ${actualLabel}
      </div>
      ${
        baselineEstimate
          ? `
            <div class="kanban-delta-row ${getEstimateDeltaMinutes(task) > 0 ? "over" : getEstimateDeltaMinutes(task) < 0 ? "under" : "balanced"}">
              <span>Delta</span>
              <strong>${escapeHtml(formatEstimate(Math.abs(getEstimateDeltaMinutes(task))) || "0m")}${getEstimateDeltaMinutes(task) > 0 ? " over" : getEstimateDeltaMinutes(task) < 0 ? " under" : ""}</strong>
            </div>
          `
          : ""
      }
    </article>
  `;
}

function renderKanbanView(visibleIds) {
  const columns = [
    { key: "todo", title: "To do", note: "Ready to pick up." },
    { key: "active", title: "Active", note: "Only one task runs the timer." },
    { key: "hold", title: "Hold", note: "Paused without losing tracked time." },
    { key: "done", title: "Complete", note: "Finished work." }
  ];

  return `
    <section class="canvas-shell">
      <div class="canvas-topbar">
        <div>
          <h2>${escapeHtml(getCurrentScopeLabel())}</h2>
          <p>Click a card to make it active. Click the active card again to send it back. Drag between columns when you want to move it manually.</p>
        </div>
        <div class="canvas-controls">
          <input id="search-input" class="search-input" value="${escapeHtml(ui.search)}" placeholder="Search tasks, tags, projects" />
        </div>
      </div>

      <div class="kanban-board">
        ${columns
          .map((column) => {
            const columnTasks = state.tasks
              .filter((task) => visibleIds.has(task.id) && task.status === column.key)
              .sort(compareTasks);

            return `
              <section class="kanban-column" data-kanban-drop="${column.key}">
                <div class="kanban-column-head">
                  <div>
                    <h3>${escapeHtml(column.title)}</h3>
                    <p>${escapeHtml(column.note)}</p>
                  </div>
                  <strong>${columnTasks.length}</strong>
                </div>
                <div class="kanban-column-body">
                  ${columnTasks.length ? columnTasks.map(renderKanbanCard).join("") : '<div class="kanban-empty">No tasks</div>'}
                </div>
              </section>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderStatusView() {
  const openTasks = getOpenTasks(state.tasks);
  const doneTasks = state.tasks.filter((task) => task.status === "done");
  const activeTask = state.tasks.find((task) => task.status === "active") || null;
  const totalTrackedMs = state.tasks.reduce((sum, task) => sum + getTrackedMs(task), 0);
  const totalPlannedOpen = getTotalEstimate(openTasks);
  const quickTasks = openTasks
    .filter((task) => matchesSmartScope(task, "quick15"))
    .sort(compareTasks);
  const projectStats = sortByName(state.projects).map((project) => {
    const tasks = state.tasks.filter((task) => task.projectId === project.id);
    const open = tasks.filter((task) => task.status !== "done");
    return {
      name: project.name,
      total: tasks.length,
      open: open.length,
      done: tasks.length - open.length,
      hours: getTotalEstimate(open)
    };
  });
  const tagStats = sortByName(state.tags)
    .map((tag) => {
      const tasks = state.tasks.filter((task) => task.tagIds.includes(tag.id));
      return {
        name: tag.name,
        total: tasks.length,
        planned: getTotalEstimate(tasks),
        actualMs: tasks.reduce((sum, task) => sum + getTrackedMs(task), 0)
      };
    })
    .filter((tag) => tag.total > 0);
  const executionStats = [...state.tasks]
    .filter((task) => task.status === "done")
    .filter((task) => getPlannedBaselineEstimate(task) > 0 || getTrackedMs(task) > 0)
    .sort((a, b) => Math.abs(getEstimateDeltaMinutes(b)) - Math.abs(getEstimateDeltaMinutes(a)))
    .slice(0, 10);

  return `
    <section class="canvas-shell">
      <div class="status-grid">
        <article class="status-card">
          <span>Open tasks</span>
          <strong>${openTasks.length}</strong>
          <p>${escapeHtml(formatEstimate(totalPlannedOpen) || "0m")} left to do</p>
        </article>
        <article class="status-card">
          <span>Closed tasks</span>
          <strong>${doneTasks.length}</strong>
          <p>${state.tasks.length ? Math.round((doneTasks.length / state.tasks.length) * 100) : 0}% complete</p>
        </article>
        <article class="status-card">
          <span>Planned work</span>
          <strong>${escapeHtml(formatEstimate(getTotalEstimate(state.tasks)) || "0m")}</strong>
          <p>Total estimated workload across the current tree.</p>
        </article>
        <article class="status-card">
          <span>Tracked actual</span>
          <strong>${escapeHtml(formatTrackedDuration(totalTrackedMs))}</strong>
          <p>${activeTask ? `Active: ${escapeHtml(activeTask.title || "Untitled task")}` : "No task in focus"}</p>
        </article>
      </div>

      <div class="status-columns">
        <section class="status-panel">
          <div class="section-heading">
            <h2>By project</h2>
            <p>How much work is still left inside each project.</p>
          </div>
          <div class="status-list">
            ${
              projectStats.length
                ? projectStats
                    .map(
                      (item) => `
                        <div class="status-row">
                          <strong>${escapeHtml(item.name)}</strong>
                          <span>${item.open} open</span>
                          <span>${item.done} done</span>
                          <span>${escapeHtml(formatEstimate(item.hours) || "0m")} left</span>
                        </div>
                      `
                    )
                    .join("")
                : '<div class="empty-paper">Projects will appear here once you create them.</div>'
            }
          </div>
        </section>

        <section class="status-panel">
          <div class="section-heading">
            <h2>By tag</h2>
            <p>Planned vs actual by tag.</p>
          </div>
          <div class="status-list">
            ${
              tagStats.length
                ? tagStats
                    .map(
                      (item) => `
                        <div class="status-row">
                          <strong>#${escapeHtml(item.name)}</strong>
                          <span>${item.total} tasks</span>
                          <span>${escapeHtml(formatEstimate(item.planned) || "0m")} planned</span>
                          <span>${escapeHtml(formatTrackedDuration(item.actualMs))} actual</span>
                        </div>
                      `
                    )
                    .join("")
                : '<div class="empty-paper">Tags appear automatically when you type them in tasks.</div>'
            }
          </div>
        </section>

        <section class="status-panel">
          <div class="section-heading">
            <h2>Quick 15m</h2>
            <p>Tasks you can close fast.</p>
          </div>
          <div class="status-list">
            ${
              quickTasks.length
                ? quickTasks
                    .map((task) => {
                      const parent = task.parentId ? getTask(task.parentId) : null;
                      return `
                        <div class="status-row">
                          <strong>${escapeHtml(task.title || "Untitled task")}</strong>
                          <span>${escapeHtml(formatEstimate(task.estimateMinutes) || "15m")}</span>
                          <span>${task.deadline ? escapeHtml(formatDate(task.deadline)) : "No date"}</span>
                          <span>${parent ? `From ${escapeHtml(parent.title || "Untitled task")}` : "Top level"}</span>
                        </div>
                      `;
                    })
                    .join("")
                : '<div class="empty-paper">No quick tasks yet.</div>'
            }
          </div>
        </section>

        <section class="status-panel">
          <div class="section-heading">
            <h2>Plan vs actual</h2>
            <p>Where execution drifted from the estimate.</p>
          </div>
          <div class="status-list">
            ${
              executionStats.length
                ? executionStats
                    .map((task) => {
                      const delta = getEstimateDeltaMinutes(task);
                      return `
                        <div class="status-row">
                          <strong>${escapeHtml(task.title || "Untitled task")}</strong>
                          <span>${escapeHtml(formatEstimate(getPlannedBaselineEstimate(task)) || "0m")} planned</span>
                          <span>${escapeHtml(formatTrackedDuration(getTrackedMs(task)))} actual</span>
                          <span>${delta === 0 ? "on plan" : `${escapeHtml(formatEstimate(Math.abs(delta)) || "0m")} ${delta > 0 ? "over" : "under"}`}</span>
                        </div>
                      `;
                    })
                    .join("")
                : '<div class="empty-paper">Tracked work will appear here once you start using Active.</div>'
            }
          </div>
        </section>
      </div>
    </section>
  `;
}

function bindTaskInteractions() {
  elements.main.querySelector("#search-input")?.addEventListener("input", (event) => {
    ui.search = event.currentTarget.value;
    renderMain();
  });

  elements.main.querySelectorAll("[data-sort-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const criterion = button.getAttribute("data-sort-toggle");
      if (!criterion) {
        return;
      }

      const existing = ui.sortCriteria.find((item) => item.key === criterion);

      if (!existing) {
        ui.sortCriteria = [...ui.sortCriteria, { key: criterion, direction: "asc" }];
      } else if (existing.direction === "asc") {
        ui.sortCriteria = ui.sortCriteria.map((item) =>
          item.key === criterion ? { ...item, direction: "desc" } : item
        );
      } else {
        ui.sortCriteria = ui.sortCriteria.filter((item) => item.key !== criterion);
      }

      renderMain();
    });
  });

  elements.main.querySelector("#clear-sort")?.addEventListener("click", () => {
    ui.sortCriteria = [];
    renderMain();
  });

  elements.main.querySelector("#new-root-task")?.addEventListener("click", () => {
    createTaskAtEnd("");
  });

  elements.main.querySelectorAll("[data-add-below]").forEach((button) => {
    button.addEventListener("click", () => {
      createTaskAfter(button.getAttribute("data-add-below"));
    });
  });

  elements.main.querySelectorAll("[data-add-child]").forEach((button) => {
    button.addEventListener("click", () => {
      createChildTask(button.getAttribute("data-add-child"));
    });
  });

  elements.main.querySelectorAll("[data-select-task]").forEach((button) => {
    button.addEventListener("click", () => {
      toggleTaskSelection(button.getAttribute("data-select-task"));
    });
  });

  elements.main.querySelectorAll("[data-toggle-done]").forEach((button) => {
    button.addEventListener("click", () => {
      toggleTaskDone(button.getAttribute("data-toggle-done"));
    });
  });

  elements.main.querySelectorAll("[data-indent]").forEach((button) => {
    button.addEventListener("click", () => {
      indentTask(button.getAttribute("data-indent"));
    });
  });

  elements.main.querySelectorAll("[data-outdent]").forEach((button) => {
    button.addEventListener("click", () => {
      outdentTask(button.getAttribute("data-outdent"));
    });
  });

  elements.main.querySelectorAll("[data-delete-task]").forEach((button) => {
    button.addEventListener("click", () => {
      deleteTask(button.getAttribute("data-delete-task"));
    });
  });

  elements.main.querySelectorAll("[data-clear-meta]").forEach((button) => {
    button.addEventListener("click", () => {
      clearTaskMeta(
        button.getAttribute("data-task-id"),
        button.getAttribute("data-clear-meta"),
        button.getAttribute("data-meta-value") || ""
      );
    });
  });

  elements.main.querySelectorAll("[data-toggle-meta]").forEach((button) => {
    button.addEventListener("click", () => {
      const taskId = button.getAttribute("data-toggle-meta");
      if (!taskId) {
        return;
      }

      if (ui.expandedMetaTaskIds.has(taskId)) {
        ui.expandedMetaTaskIds.delete(taskId);
      } else {
        ui.expandedMetaTaskIds.add(taskId);
      }
      renderMain();
    });
  });

  elements.main.querySelectorAll("[data-task-input]").forEach((input) => {
    input.addEventListener("input", (event) => {
      scheduleGhostPreview(input.getAttribute("data-task-input"), event.currentTarget.value);
    });

    input.addEventListener("blur", (event) => {
      clearGhostPreview(input.getAttribute("data-task-input"));
      applyTaskInput(input.getAttribute("data-task-input"), event.currentTarget.value);
    });
  });

  elements.main.querySelector("#new-task-input")?.addEventListener("input", (event) => {
    scheduleGhostPreview("new-task", event.currentTarget.value);
  });

  elements.main.querySelector("#new-task-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const value = event.currentTarget.value.trim();
      clearGhostPreview("new-task");
      createTaskAtEnd(value);
      event.currentTarget.value = "";
    }
  });

  elements.main.querySelector("#toggle-bulk-edit")?.addEventListener("click", () => {
    ui.bulkEditOpen = !ui.bulkEditOpen;
    renderMain();
  });

  elements.main.querySelector("#clear-selection")?.addEventListener("click", () => {
    clearTaskSelection();
    renderMain();
  });

  elements.main.querySelector("#delete-selected")?.addEventListener("click", () => {
    const shouldDelete = window.confirm(`Delete ${ui.taskSelection.size} selected task(s)?`);
    if (shouldDelete) {
      deleteSelectedTasks();
    }
  });

  elements.main.querySelector("#bulk-edit-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const deadlineMode = String(form.get("deadlineMode") || BULK_ACTION_PRESETS.keep);
    const deadlineValue = String(form.get("deadline") || "");

    applyBulkEdit({
      projectId: String(form.get("projectId") || BULK_ACTION_PRESETS.keep),
      deadline:
        deadlineMode === "set"
          ? deadlineValue || BULK_ACTION_PRESETS.keep
          : deadlineMode,
      tagAction: String(form.get("tagAction") || BULK_ACTION_PRESETS.keep),
      tagId: String(form.get("tagId") || "")
    });
  });

  elements.main.onkeydown = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("task-input")) {
      return;
    }

    const isComposer = target.id === "new-task-input";
    const taskId = target.getAttribute("data-task-input");
    const currentValue = target.value;

    if (event.key === "Tab") {
      event.preventDefault();

      if (isComposer) {
        const lastVisible = flattenVisibleTree(getVisibleTaskIds()).at(-1)?.task || null;
        if (!currentValue.trim() && !lastVisible) {
          return;
        }

        clearGhostPreview("new-task");
        createTaskAtEnd(currentValue.trim());
        target.value = "";

        if (!event.shiftKey && ui.pendingFocus) {
          const createdTaskId = ui.pendingFocus;
          window.setTimeout(() => indentTask(createdTaskId), 0);
        }
        return;
      }

      clearGhostPreview(taskId);
      applyTaskInput(taskId, currentValue);
      if (event.shiftKey) {
        outdentTask(taskId);
      } else {
        indentTask(taskId);
      }
      return;
    }

    if (!isComposer && event.key === "Enter") {
      event.preventDefault();
      clearGhostPreview(taskId);
      applyTaskInput(taskId, currentValue);
      createTaskAfter(taskId);
      return;
    }

    if (!isComposer && event.key === "Backspace" && !currentValue.trim()) {
      event.preventDefault();
      clearGhostPreview(taskId);
      deleteTask(taskId);
    }
  };
}

function bindMapInteractions() {
  elements.main.querySelectorAll("[data-map-layout]").forEach((button) => {
    button.addEventListener("click", () => {
      ui.mapLayout = button.getAttribute("data-map-layout") || "lanes";
      renderMain();
    });
  });

  elements.main.querySelector("[data-map-direction]")?.addEventListener("click", (event) => {
    ui.mapDirection = event.currentTarget.getAttribute("data-map-direction") || "forward";
    renderMain();
  });

  elements.main.querySelectorAll("[data-map-add-child]").forEach((button) => {
    button.addEventListener("click", () => {
      createChildTask(button.getAttribute("data-map-add-child"));
    });
  });

  elements.main.querySelectorAll("[data-map-add-sibling]").forEach((button) => {
    button.addEventListener("click", () => {
      createTaskAfter(button.getAttribute("data-map-add-sibling"));
    });
  });

  elements.main.querySelectorAll("[data-map-task-input]").forEach((input) => {
    input.addEventListener("input", (event) => {
      const taskId = input.getAttribute("data-map-task-input");
      scheduleGhostPreview(`map-${taskId}`, event.currentTarget.value);
    });

    input.addEventListener("blur", (event) => {
      const taskId = input.getAttribute("data-map-task-input");
      clearGhostPreview(`map-${taskId}`);
      applyTaskInput(taskId, event.currentTarget.value);
    });

    input.addEventListener("keydown", (event) => {
      const taskId = input.getAttribute("data-map-task-input");
      if (!taskId) {
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        clearGhostPreview(`map-${taskId}`);
        applyTaskInput(taskId, event.currentTarget.value);
        input.blur();
      }

      if (event.key === "Escape") {
        event.preventDefault();
        clearGhostPreview(`map-${taskId}`);
        const task = getTask(taskId);
        if (task) {
          input.value = task.title;
        }
        input.blur();
      }
    });
  });

  elements.main.querySelectorAll("[data-drag-task]").forEach((card) => {
    card.addEventListener("dragstart", () => {
      ui.dragTaskId = card.getAttribute("data-drag-task");
      card.classList.add("dragging");
    });

    card.addEventListener("dragend", () => {
      ui.dragTaskId = null;
      card.classList.remove("dragging");
    });
  });

  elements.main.querySelectorAll("[data-drop-child-card]").forEach((card) => {
    card.addEventListener("dragover", (event) => {
      if (!ui.dragTaskId) {
        return;
      }

      event.preventDefault();
      card.classList.add("drag-over");
    });

    card.addEventListener("dragleave", () => {
      card.classList.remove("drag-over");
    });

    card.addEventListener("drop", (event) => {
      event.preventDefault();
      card.classList.remove("drag-over");
      const targetId = card.getAttribute("data-drop-child-card");
      if (ui.dragTaskId && targetId && ui.dragTaskId !== targetId) {
        moveTaskAsChild(ui.dragTaskId, targetId);
      }
      ui.dragTaskId = null;
    });
  });

  elements.main.querySelectorAll("[data-map-add-child]").forEach((button) => {
    button.addEventListener("dragover", (event) => {
      if (!ui.dragTaskId) {
        return;
      }

      event.preventDefault();
      button.classList.add("drag-over");
    });

    button.addEventListener("dragleave", () => {
      button.classList.remove("drag-over");
    });

    button.addEventListener("drop", (event) => {
      event.preventDefault();
      button.classList.remove("drag-over");
      const parentId = button.getAttribute("data-map-add-child");
      if (ui.dragTaskId && parentId && ui.dragTaskId !== parentId) {
        moveTaskAsChild(ui.dragTaskId, parentId);
      }
      ui.dragTaskId = null;
    });
  });

  elements.main.querySelectorAll("[data-map-add-sibling]").forEach((button) => {
    button.addEventListener("dragover", (event) => {
      if (!ui.dragTaskId) {
        return;
      }

      event.preventDefault();
      button.classList.add("drag-over");
    });

    button.addEventListener("dragleave", () => {
      button.classList.remove("drag-over");
    });

    button.addEventListener("drop", (event) => {
      event.preventDefault();
      button.classList.remove("drag-over");
      const targetId = button.getAttribute("data-map-add-sibling");
      if (ui.dragTaskId && targetId && ui.dragTaskId !== targetId) {
        moveTaskAfter(ui.dragTaskId, targetId);
      }
      ui.dragTaskId = null;
    });
  });
}

function bindKanbanInteractions() {
  elements.main.querySelector("#search-input")?.addEventListener("input", (event) => {
    ui.search = event.currentTarget.value;
    renderMain();
  });

  elements.main.querySelectorAll("[data-kanban-toggle-active]").forEach((card) => {
    card.addEventListener("click", (event) => {
      const taskId = card.getAttribute("data-kanban-toggle-active");
      if (!taskId) {
        return;
      }

      if (event.target instanceof HTMLElement && event.target.closest("[draggable='true']")) {
        toggleActiveTask(taskId);
      }
    });
  });

  elements.main.querySelectorAll("[data-kanban-task]").forEach((card) => {
    card.addEventListener("dragstart", () => {
      ui.dragTaskId = card.getAttribute("data-kanban-task");
      card.classList.add("dragging");
    });

    card.addEventListener("dragend", () => {
      ui.dragTaskId = null;
      card.classList.remove("dragging");
    });
  });

  elements.main.querySelectorAll("[data-kanban-drop]").forEach((column) => {
    column.addEventListener("dragover", (event) => {
      if (!ui.dragTaskId) {
        return;
      }

      event.preventDefault();
      column.classList.add("drag-over");
    });

    column.addEventListener("dragleave", () => {
      column.classList.remove("drag-over");
    });

    column.addEventListener("drop", (event) => {
      event.preventDefault();
      column.classList.remove("drag-over");
      const nextStatus = column.getAttribute("data-kanban-drop");
      if (ui.dragTaskId && nextStatus) {
        setTaskStatus(ui.dragTaskId, nextStatus);
      }
      ui.dragTaskId = null;
    });
  });
}

function syncLiveTimers() {
  document.querySelectorAll("[data-live-timer-task]").forEach((element) => {
    const taskId = element.getAttribute("data-live-timer-task");
    const task = getTask(taskId);
    if (!task) {
      return;
    }

    element.textContent = formatTimer(getTrackedMs(task));
  });
}

window.setInterval(() => {
  if (!state.tasks.some((task) => task.status === "active")) {
    return;
  }

  syncLiveTimers();
}, 1000);

function renderMain() {
  const visibleIds = getVisibleTaskIds();

  if (ui.view === "map") {
    elements.main.innerHTML = renderMapView(visibleIds);
    bindMapInteractions();
  } else if (ui.view === "kanban") {
    elements.main.innerHTML = renderKanbanView(visibleIds);
    bindKanbanInteractions();
  } else if (ui.view === "status") {
    elements.main.innerHTML = renderStatusView();
  } else {
    elements.main.innerHTML = renderTasksView(visibleIds);
    bindTaskInteractions();
  }

  syncLiveTimers();
  applyPendingFocus();
}

function renderAll() {
  renderSidebar();
  renderMain();
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const target = event.target;

    if (target instanceof HTMLInputElement && target.classList.contains("task-input")) {
      clearGhostPreview(target.getAttribute("data-task-input") || (target.id === "new-task-input" ? "new-task" : ""));

      if (target.id === "new-task-input") {
        target.value = "";
      } else {
        const taskId = target.getAttribute("data-task-input");
        const task = getTask(taskId);
        if (task) {
          target.value = task.title;
        }
      }

      target.blur();
      return;
    }

    if (ui.projectComposerOpen || ui.projectEditMode || ui.tagEditMode || ui.bulkEditOpen || ui.settingsOpen || ui.saveInfoOpen || ui.taskSelection.size) {
      ui.projectComposerOpen = false;
      ui.projectEditMode = false;
      ui.tagEditMode = false;
      ui.bulkEditOpen = false;
      ui.settingsOpen = false;
      ui.saveInfoOpen = false;
      clearTaskSelection();
      renderAll();
    }

    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    const target = event.target;
    const isTaskInput = target instanceof HTMLElement && target.classList.contains("task-input");
    const isRegularInput =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;

    if (target instanceof HTMLElement && target.closest(".settings-panel")) {
      return;
    }

    if (isRegularInput && !isTaskInput) {
      return;
    }

    event.preventDefault();
    undoLastAction();
  }
});

loadPreferences();
applyPreferences();
loadState();
