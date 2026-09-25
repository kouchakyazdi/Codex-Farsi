import { escapeHtml, markdown } from "./markdown.js";

const $ = (selector) => document.querySelector(selector);
const BASE_DOCUMENT_TITLE = "Codex Web";
const NEW_THREAD_DRAFT_PREFIX = "__new_thread__";
const OPTIMISTIC_USER_MESSAGE_PREFIX = "__optimistic_user_message__";
const MAX_ATTACHMENT_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_BATCH = 20;
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const RESPONSE_STYLE_INSTRUCTIONS =
  "Format final responses with clear, polished visual hierarchy. Lead with a short direct answer or outcome and match the user's language. For comparisons between two or more subjects across three or more attributes, use a compact Markdown table by default. Use short descriptive ## headings when the answer has distinct sections, ### only for genuine subsections, bullets for three or more parallel items, options, or findings, and numbered lists only for ordered actions. Selectively bold key terms, labels, decisions, and conclusions so the answer is easy to scan. Turn list-like prose into real lists. Keep paragraphs to one to three sentences and keep simple answers as short prose. Avoid # headings, deep nesting, decorative sections, redundant summaries, and tables for trivial one- or two-point answers.";
const IMAGE_EXTENSIONS = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
// Capabilities each agent CLI can actually back. Slash commands and composer
// tools are gated on these instead of on the provider name.
const PROVIDER_CAPABILITIES = {
  codex: new Set(["plan", "goal", "compact", "usage", "context", "instructions"]),
  claude: new Set(["plan", "goal", "compact", "usage", "context", "instructions"]),
};

const SLASH_COMMANDS = [
  {
    name: "goal",
    label: "Goal mode",
    description: "تعیین هدفی که عامل در چند نوبت تا رسیدن به نتیجه پیگیری کند",
    capability: "goal",
  },
  {
    name: "plan",
    label: "Plan mode",
    description: "روشن یا خاموش‌کردن حالت بررسی و برنامه‌ریزی قبل از اجرا",
    capability: "plan",
  },
  {
    name: "compact",
    label: "فشرده‌سازی گفتگو",
    description: "خلاصه‌کردن context فعلی و آزادکردن فضای گفتگو",
    capability: "compact",
  },
  {
    name: "new",
    label: "گفتگوی تازه",
    description: "شروع یک گفتگوی مستقل جدید",
  },
  {
    name: "resume",
    label: "ادامهٔ یک گفتگو",
    description: "رفتن به فهرست گفتگوهای ذخیره‌شده",
  },
  {
    name: "status",
    label: "وضعیت گفتگو",
    description: "نمایش شناسه، مدل، دسترسی و مصرف context",
  },
  {
    name: "usage",
    label: "مصرف حساب",
    description: "نمایش سهمیه، محدودیت فعال و زمان بازنشانی",
    capability: "usage",
  },
  {
    name: "model",
    label: "انتخاب مدل",
    description: "بازکردن تنظیمات مدل و سطح استدلال",
  },
  {
    name: "permissions",
    label: "تنظیم دسترسی‌ها",
    description: "بازکردن تنظیمات sandbox و approval",
  },
].map((command) => ({ ...command, kind: "builtin", token: `/${command.name}` }));

const BUILTIN_SLASH_COMMAND_NAMES = new Set(SLASH_COMMANDS.map((command) => command.name));
// How long a fetched skill/prompt list stays trusted before the composer asks
// the server again. Keeps newly created skills reachable without polling.
const AGENT_COMMANDS_TTL_MS = 15_000;

const COMMON_ABSOLUTE_PATH_ROOTS = new Set([
  "Applications",
  "Library",
  "System",
  "Users",
  "Volumes",
  "app",
  "bin",
  "boot",
  "dev",
  "etc",
  "home",
  "lib",
  "lib64",
  "media",
  "mnt",
  "nix",
  "opt",
  "private",
  "proc",
  "root",
  "run",
  "sbin",
  "snap",
  "srv",
  "sys",
  "tmp",
  "usr",
  "var",
  "workspace",
]);

const KNOWN_CODEX_COMMAND_NAMES = new Set([
  ...SLASH_COMMANDS.map((command) => command.name),
  "agent",
  "app",
  "apps",
  "approve",
  "archive",
  "btw",
  "clean",
  "cloud",
  "cloud-environment",
  "copy",
  "debug-config",
  "delete",
  "diff",
  "exit",
  "experimental",
  "fast",
  "feedback",
  "fork",
  "goal",
  "hooks",
  "ide",
  "ide-context",
  "import",
  "init",
  "keymap",
  "local",
  "logout",
  "mcp",
  "memories",
  "mention",
  "personality",
  "pet",
  "pets",
  "plan",
  "plugins",
  "project",
  "ps",
  "quit",
  "raw",
  "reasoning",
  "rename",
  "review",
  "sandbox-add-read-dir",
  "setup-default-sandbox",
  "side",
  "skills",
  "statusline",
  "stop",
  "subagents",
  "theme",
  "title",
  "usage",
  "vim",
  "worktree",
]);

const elements = {
  addImages: $("#add-images"),
  approvalAccept: $("#approval-accept"),
  approvalCancel: $("#approval-cancel"),
  approvalContext: $("#approval-context"),
  approvalDecline: $("#approval-decline"),
  approvalDetail: $("#approval-detail"),
  approvalDialog: $("#approval-dialog"),
  approvalLater: $("#approval-later"),
  approvalReason: $("#approval-reason"),
  approvalSession: $("#approval-session"),
  approvalTitle: $("#approval-title"),
  approvalSelect: $("#approval-select"),
  connectionLabel: $("#connection-label"),
  composerHint: $("#composer-hint"),
  composerWrap: $(".composer-wrap"),
  composer: $(".composer"),
  composerDropOverlay: $("#composer-drop-overlay"),
  composerTools: $("#composer-tools"),
  composerToolsMenu: $("#composer-tools-menu"),
  composerToolsNote: $("#composer-tools-note"),
  conversation: $("#conversation"),
  cwdInput: $("#cwd-input"),
  dictate: $("#dictate"),
  effortSelect: $("#effort-select"),
  fullAccessWarning: $("#full-access-warning"),
  headerSettings: $("#header-settings"),
  imageInput: $("#image-input"),
  goalClear: $("#goal-clear"),
  goalDialog: $("#goal-dialog"),
  goalDialogCancel: $("#goal-dialog-cancel"),
  goalDialogClose: $("#goal-dialog-close"),
  goalDialogHelp: $("#goal-dialog-help"),
  goalDialogTitle: $("#goal-dialog-title"),
  goalEdit: $("#goal-edit"),
  goalForm: $("#goal-form"),
  goalInput: $("#goal-input"),
  goalModeOption: $("#goal-mode-option"),
  goalObjective: $("#goal-objective"),
  goalProgress: $("#goal-progress"),
  goalSave: $("#goal-save"),
  goalStatus: $("#goal-status"),
  goalToggle: $("#goal-toggle"),
  goalUsage: $("#goal-usage"),
  inputDialog: $("#input-dialog"),
  inputForm: $("#input-request-form"),
  inputContext: $("#input-context"),
  inputCancel: $("#input-cancel"),
  inputDecline: $("#input-decline"),
  inputLater: $("#input-later"),
  inputQuestions: $("#input-questions"),
  inputSubmit: $("#input-submit"),
  menuButton: $("#menu-button"),
  messages: $("#messages"),
  mobileScrim: $("#mobile-scrim"),
  modelChip: $("#model-chip"),
  modelLabel: $("#model-label"),
  modelOptions: $("#model-options"),
  providerOptions: $("#provider-options"),
  providerNote: $("#provider-note"),
  effortOptions: $("#effort-options"),
  runChipMenu: $("#run-chip-menu"),
  modelSelect: $("#model-select"),
  newChat: $("#new-chat"),
  nextUserMessage: $("#next-user-message"),
  openSettings: $("#open-settings"),
  planModeOption: $("#plan-mode-option"),
  providerSelect: $("#provider-select"),
  claudePermissionMode: $("#claude-permission-mode"),
  previousUserMessage: $("#previous-user-message"),
  projectAdd: $("#project-add"),
  projectCancel: $("#project-cancel"),
  projectCwd: $("#project-cwd"),
  projectDelete: $("#project-delete"),
  projectDialog: $("#project-dialog"),
  projectDialogClose: $("#project-dialog-close"),
  projectDialogTitle: $("#project-dialog-title"),
  projectForm: $("#project-form"),
  projectId: $("#project-id"),
  projectInstructions: $("#project-instructions"),
  projectChip: $("#project-chip"),
  projectChipAdd: $("#project-chip-add"),
  projectChipEmpty: $("#project-chip-empty"),
  projectChipFilter: $("#project-chip-filter"),
  projectChipHint: $("#project-chip-hint"),
  projectChipLabel: $("#project-chip-label"),
  projectChipList: $("#project-chip-list"),
  projectChipMenu: $("#project-chip-menu"),
  projectList: $("#project-list"),
  projectName: $("#project-name"),
  projectSave: $("#project-save"),
  projectSwitcher: $("#project-switcher"),
  projectSwitcherCount: $("#project-switcher-count"),
  projectSwitcherEmpty: $("#project-switcher-empty"),
  projectSwitcherFilter: $("#project-switcher-filter"),
  projectSwitcherMenu: $("#project-switcher-menu"),
  projectSwitcherName: $("#project-switcher-name"),
  prompt: $("#prompt"),
  promptQueue: $("#prompt-queue"),
  promptQueueClear: $("#prompt-queue-clear"),
  promptQueueCount: $("#prompt-queue-count"),
  promptQueueItems: $("#prompt-queue-items"),
  sandboxSelect: $("#sandbox-select"),
  saveSettings: $("#save-settings"),
  scrollBottom: $("#scroll-bottom"),
  sendMessage: $("#send-message"),
  selectionAsk: $("#selection-ask"),
  shareChat: $("#share-chat"),
  shareCopy: $("#share-copy"),
  shareDialog: $("#share-dialog"),
  shareDialogClose: $("#share-dialog-close"),
  shareLink: $("#share-link"),
  shareRefresh: $("#share-refresh"),
  shareRevoke: $("#share-revoke"),
  settingsCancel: $("#settings-cancel"),
  settingsClose: $("#settings-close"),
  settingsDialog: $("#settings-dialog"),
  settingsForm: $("#settings-form"),
  sidebar: $("#sidebar"),
  sidebarClose: $("#sidebar-close"),
  slashCommandEmpty: $("#slash-command-empty"),
  slashCommandMenu: $("#slash-command-menu"),
  slashCommandOptions: $("#slash-command-options"),
  slashCommandStatus: $("#slash-command-status"),
  statusDot: $("#status-dot"),
  stopTurn: $("#stop-turn"),
  threadList: $("#thread-list"),
  threadSearch: $("#thread-search"),
  threadTitle: $("#thread-title"),
  toasts: $("#toasts"),
  uploadStatus: $("#upload-status"),
  contextUsageDetail: $("#context-usage-detail"),
  contextUsageFill: $("#context-usage-fill"),
  contextUsagePercent: $("#context-usage-percent"),
  contextUsageProgress: $("#context-usage-progress"),
  usageAccountDetails: $("#usage-account-details"),
  usageButton: $("#usage-button"),
  usageClose: $("#usage-close"),
  usageDialog: $("#usage-dialog"),
  usageLimits: $("#usage-limits"),
  usageOverview: $("#usage-overview"),
  usagePercent: $("#usage-percent"),
  usageRefresh: $("#usage-refresh"),
  userMessageNavigationStatus: $("#user-message-navigation-status"),
  welcome: $("#welcome"),
  welcomeDescription: $("#welcome-description"),
  welcomeTitle: $("#welcome-title"),
};

const defaultSettings = {
  approvalPolicy: "",
  claudePermissionMode: "acceptEdits",
  cwd: "",
  effort: "",
  modelByProvider: { codex: "", claude: "" },
  palette: "cyan",
  provider: "codex",
  sandbox: "",
  sidebarCollapsed: false,
};

const SETTINGS_VERSION = 6;
const ACCENT_PALETTES = new Set(["cyan", "red", "purple", "green"]);
const ACTIVE_PROJECT_KEY = "codex-web-active-project";
// The project a new conversation should start in: the last one deliberately
// chosen for a chat, which is not the same thing as the sidebar's browse
// filter. Absent means "never chosen"; "" means "chosen: no project".
const LAST_PROJECT_KEY = "codex-web-last-project";
const THREAD_LIST_PAGE_SIZE = 100;
const LAST_OPENED_KEY = "codex-web-last-opened";
// Enough to outlive a working session without letting the map grow forever.
const LAST_OPENED_LIMIT = 50;
// How many recently opened conversations can be pulled up from other projects.
const PINNED_RECENT_COUNT = 3;
const PINNED_LIMIT = 4;

function loadLastOpened() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_OPENED_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).filter(
        ([threadId, at]) => typeof threadId === "string" && Number.isFinite(at),
      ),
    );
  } catch {
    return {};
  }
}

function loadActiveProjectId() {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_KEY) || null;
  } catch {
    return null;
  }
}

function loadLastProjectId() {
  try {
    const saved = localStorage.getItem(LAST_PROJECT_KEY);
    if (saved === null) return undefined;
    return saved || null;
  } catch {
    return undefined;
  }
}

function persistLastProject(projectId) {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, projectId || "");
  } catch {
    // The choice still applies to this tab when storage is unavailable.
  }
}

const state = {
  activeProjectId: loadActiveProjectId(),
  lastProjectId: loadLastProjectId(),
  activeInteractionKey: null,
  busy: false,
  collaborationModes: [],
  completedTurns: new Set(),
  compactPendingThreads: new Set(),
  composerModes: new Map(),
  connected: false,
  currentThread: null,
  currentThreadId: null,
  currentTurnId: null,
  dictationBase: "",
  dictationFinal: "",
  dictationRecognition: null,
  drafts: new Map(),
  draftProjects: new Map(),
  eventSource: null,
  followOutput: true,
  goals: new Map(),
  goalLoadingThreads: new Set(),
  goalSaving: false,
  itemViews: new Map(),
  turnProcessViews: new Map(),
  navigationVersion: 0,
  models: [],
  modelsByProvider: { codex: [], claude: [] },
  navigating: false,
  openingThreadId: null,
  newDraftId: crypto.randomUUID(),
  notifiedTurns: new Set(),
  optimisticUserMessages: new Map(),
  pendingInteractions: new Map(),
  pendingGoals: new Map(),
  planModeSavingKeys: new Set(),
  pendingTurnStarts: 0,
  postponedInteractions: new Set(),
  promptQueues: new Map(),
  projects: [],
  providerStatuses: {
    claude: { message: "Claude Code CLI پیدا نشد", ready: false },
    codex: { message: "در حال راه‌اندازی Codex…", ready: false },
  },
  queueProcessing: new Set(),
  forceNextScroll: false,
  agentCommands: [],
  agentCommandsFetchedAt: 0,
  agentCommandsKey: "",
  agentCommandsPending: null,
  attachmentUploadsByDraft: new Map(),
  interactionSubmitting: false,
  scrollFrame: null,
  scrollingToBottom: false,
  settings: loadSettings(),
  selectedAssistantText: "",
  slashActiveIndex: 0,
  slashCommandExecuting: false,
  slashDismissedValue: null,
  slashFilteredCommands: [],
  threadActivity: new Map(),
  threadEventBacklog: new Map(),
  threadRuntime: new Map(),
  turnTimings: new Map(),
  composerHeight: null,
  lastOpenedAt: loadLastOpened(),
  threadListHasMore: false,
  threadListLimit: THREAD_LIST_PAGE_SIZE,
  threadProjects: new Map(),
  threadTokenUsage: new Map(),
  threads: [],
  threadsRefreshVersion: 0,
  rateLimitError: null,
  rateLimits: null,
  rateLimitsFetchedAt: 0,
  rateLimitsLoading: false,
  // Codex and Claude report quota separately, so a snapshot is only valid for
  // the provider it came from.
  rateLimitsProvider: "",
  notifiedRateLimitKey: null,
  usageClockTimer: null,
  urlHydrationActiveKey: null,
  urlHydrationPending: null,
  urlHydrated: false,
  urlHydrationPromise: null,
  userMessageHighlightTimer: null,
  userMessageNavigationFrame: null,
  userNavigationItemId: null,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("codex-web-settings") || "{}");
    const {
      model: legacyModel,
      modelByProvider: storedModels,
      personality: _removedPersonality,
      ...savedSettings
    } = saved;
    const modelByProvider = {
      ...defaultSettings.modelByProvider,
      ...(storedModels || {}),
    };
    if (!modelByProvider.codex && legacyModel) modelByProvider.codex = legacyModel;
    return {
      ...defaultSettings,
      ...savedSettings,
      claudePermissionMode:
        savedSettings.claudePermissionMode || defaultSettings.claudePermissionMode,
      modelByProvider,
      palette: ACCENT_PALETTES.has(savedSettings.palette)
        ? savedSettings.palette
        : defaultSettings.palette,
      provider: savedSettings.provider === "claude" ? "claude" : defaultSettings.provider,
      sidebarCollapsed: savedSettings.sidebarCollapsed === true,
    };
  } catch {
    return { ...defaultSettings };
  }
}

function applyPalette(palette = defaultSettings.palette) {
  const next = ACCENT_PALETTES.has(palette) ? palette : defaultSettings.palette;
  document.documentElement.dataset.palette = next;
}

function persistSettings() {
  const { model, ...settings } = state.settings;
  localStorage.setItem(
    "codex-web-settings",
    JSON.stringify({ ...settings, version: SETTINGS_VERSION }),
  );
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.details = data.details;
    error.status = response.status;
    throw error;
  }
  return data;
}

function providerForThread(threadId) {
  return typeof threadId === "string" && threadId.startsWith("claude:")
    ? "claude"
    : "codex";
}

function providerLabel(provider) {
  return provider === "claude" ? "Claude" : "Codex";
}

function effectiveProvider() {
  if (state.openingThreadId) return providerForThread(state.openingThreadId);
  if (state.currentThreadId) {
    return state.currentThread?.provider || providerForThread(state.currentThreadId);
  }
  const urlThreadId = !state.urlHydrated ? threadIdFromUrl() : "";
  return urlThreadId ? providerForThread(urlThreadId) : state.settings.provider;
}

function providerSupports(capability, provider = effectiveProvider()) {
  return PROVIDER_CAPABILITIES[provider]?.has(capability) ?? false;
}

function providerSupportsPlanMode(provider = effectiveProvider()) {
  return providerSupports("plan", provider);
}

function providerSupportsGoalMode(provider = effectiveProvider()) {
  return providerSupports("goal", provider);
}

async function rpc(method, params = {}) {
  const response = await api("/api/rpc", {
    method: "POST",
    body: JSON.stringify({ method, params }),
  });
  return response.result;
}

function toast(message, kind = "", options = {}) {
  const actionable = typeof options.onClick === "function";
  const node = document.createElement(actionable ? "button" : "div");
  if (actionable) node.type = "button";
  node.className = `toast ${kind} ${actionable ? "actionable" : ""}`.trim();
  node.textContent = message;
  elements.toasts.append(node);
  const timer = setTimeout(() => node.remove(), options.duration || 4500);
  if (actionable) {
    node.addEventListener("click", () => {
      clearTimeout(timer);
      node.remove();
      options.onClick();
    });
  }
}

function showError(error, context = "") {
  console.error(context, error);
  const detail = error.details?.message || error.message || String(error);
  toast(`${context ? `${context}: ` : ""}${detail}`, "error");
}

function composerCwd() {
  if (state.currentThreadId) {
    return (
      state.threadRuntime.get(state.currentThreadId)?.cwd ||
      state.currentThread?.cwd ||
      state.settings.cwd
    );
  }
  return currentProject()?.cwd || state.settings.cwd;
}

function agentCommandsKey(provider = effectiveProvider(), cwd = composerCwd()) {
  return `${provider}|${cwd || ""}`;
}

// Skills and prompt files live next to the CLI, not in this interface, so the
// composer asks the server for the current provider/cwd pair instead of
// hardcoding a list. Failures stay silent: built-in commands must keep working.
async function refreshAgentCommands({ force = false } = {}) {
  const provider = effectiveProvider();
  const cwd = composerCwd();
  const key = agentCommandsKey(provider, cwd);
  const fresh =
    state.agentCommandsKey === key &&
    Date.now() - state.agentCommandsFetchedAt < AGENT_COMMANDS_TTL_MS;
  if (!force && fresh) return state.agentCommands;
  if (state.agentCommandsPending?.key === key) return state.agentCommandsPending.promise;

  const promise = (async () => {
    try {
      const query = new URLSearchParams({ cwd: cwd || "", provider });
      const data = await api(`/api/agent-commands?${query}`, { headers: {} });
      const commands = (Array.isArray(data.commands) ? data.commands : [])
        .filter(
          (command) =>
            /^[a-z][a-z0-9-]*$/i.test(String(command?.name || "")) &&
            !BUILTIN_SLASH_COMMAND_NAMES.has(String(command.name).toLowerCase()),
        )
        .map((command) => ({
          description:
            String(command.description || "").trim() ||
            (command.kind === "prompt" ? "پرامپت سفارشی" : "مهارت سفارشی"),
          kind: command.kind === "prompt" ? "prompt" : "skill",
          label: String(command.name),
          name: String(command.name).toLowerCase(),
          provider,
          scope: command.scope === "project" ? "project" : "user",
          token: `/${String(command.name).toLowerCase()}`,
        }));
      if (agentCommandsKey() !== key) return state.agentCommands;
      state.agentCommands = commands;
      state.agentCommandsKey = key;
      state.agentCommandsFetchedAt = Date.now();
      if (!elements.slashCommandMenu.classList.contains("hidden")) {
        updateSlashCommandMenu();
      }
      return commands;
    } catch {
      if (agentCommandsKey() === key) {
        state.agentCommandsKey = key;
        state.agentCommandsFetchedAt = Date.now();
      }
      return state.agentCommands;
    } finally {
      if (state.agentCommandsPending?.key === key) state.agentCommandsPending = null;
    }
  })();
  state.agentCommandsPending = { key, promise };
  return promise;
}

function agentCommandsForProvider(provider = effectiveProvider()) {
  if (state.agentCommandsKey !== agentCommandsKey(provider)) return [];
  return state.agentCommands;
}

function isAgentCommand(command) {
  return command?.kind === "skill" || command?.kind === "prompt";
}

function allSlashCommands(provider = effectiveProvider()) {
  return [...SLASH_COMMANDS, ...agentCommandsForProvider(provider)];
}

function slashCommandByName(name) {
  return allSlashCommands().find((command) => command.name === name) || null;
}

function slashCommandSupportsProvider(command, provider = effectiveProvider()) {
  if (isAgentCommand(command)) return command.provider === provider;
  return !command.capability || providerSupports(command.capability, provider);
}

function slashCommandsForProvider(provider = effectiveProvider()) {
  return allSlashCommands(provider).filter((command) =>
    slashCommandSupportsProvider(command, provider),
  );
}

function parseSlashCommand(text) {
  const raw = String(text || "");
  const candidate = raw.trimStart();
  if (!candidate.startsWith("/")) return null;
  const token = candidate.match(/^\/\S*/)?.[0] || "/";
  const singlePathPart = token.slice(1);
  const commandNameMatch = singlePathPart.match(/^([a-z][a-z0-9-]*)$/i);
  const commandName = commandNameMatch ? commandNameMatch[1].toLowerCase() : "";
  const knownCodexCommand = Boolean(
    commandName &&
      (KNOWN_CODEX_COMMAND_NAMES.has(commandName) || slashCommandByName(commandName)),
  );
  const pathLike =
    !knownCodexCommand &&
    (token.slice(1).includes("/") ||
      token.includes("\\") ||
      /^\/[^/\\\s]*\.[^/\\\s]+$/.test(token) ||
      COMMON_ABSOLUTE_PATH_ROOTS.has(singlePathPart) ||
      /^[A-Z][A-Za-z0-9._-]*$/.test(singlePathPart));
  if (pathLike) return null;
  const match = token.match(/^\/([a-z][a-z0-9-]*)$/i);
  return {
    arguments: candidate.slice(token.length).trim(),
    command: match ? slashCommandByName(match[1].toLowerCase()) : null,
    multiline: /[\r\n]/.test(raw),
    token,
  };
}

function slashCommandAvailability(command) {
  if (state.navigating) return { available: false, reason: "تا پایان بازشدن گفتگو صبر کنید." };
  if (!slashCommandSupportsProvider(command)) {
    return {
      available: false,
      reason: `فرمان ${command.token} برای گفتگوهای ${providerLabel(effectiveProvider())} پشتیبانی نمی‌شود.`,
    };
  }
  // Skills and prompt files are expanded by the CLI itself, so the only
  // requirement is a live connection to send the prompt through.
  if (isAgentCommand(command)) {
    return state.connected
      ? { available: true, reason: "" }
      : {
          available: false,
          reason: `${providerLabel(effectiveProvider())} هنوز متصل نیست.`,
        };
  }
  if (state.slashCommandExecuting && command.name === "compact") {
    return { available: false, reason: "یک فرمان دیگر در حال اجراست." };
  }
  if (command.name === "compact") {
    if (!state.currentThreadId) {
      return { available: false, reason: "ابتدا یک گفتگو را شروع یا باز کنید." };
    }
    if (!state.connected) {
      return {
        available: false,
        reason: `${providerLabel(effectiveProvider())} هنوز متصل نیست.`,
      };
    }
    if (state.busy || state.compactPendingThreads.has(state.currentThreadId)) {
      return { available: false, reason: "پس از پایان کار فعلی دوباره امتحان کنید." };
    }
    if (attachmentUploadsForDraft() > 0) {
      return { available: false, reason: "تا پایان افزودن فایل‌ها صبر کنید." };
    }
  }
  if (
    (command.name === "new" || command.name === "clear") &&
    !state.currentThreadId &&
    attachmentUploadsForDraft() > 0
  ) {
    return { available: false, reason: "تا پایان افزودن فایل‌ها صبر کنید." };
  }
  return { available: true, reason: "" };
}

function slashComposerQuery() {
  const value = elements.prompt.value;
  if (state.navigating || state.slashDismissedValue === value) return null;
  if (!/^\/[a-z0-9-]*$/i.test(value)) return null;
  const { start, end } = promptSelection();
  if (start !== value.length || end !== value.length) return null;
  return value.slice(1).toLowerCase();
}

function closeSlashCommandMenu(dismiss = false) {
  if (dismiss) state.slashDismissedValue = elements.prompt.value;
  state.slashFilteredCommands = [];
  state.slashActiveIndex = 0;
  elements.slashCommandMenu.classList.add("hidden");
  elements.prompt.setAttribute("aria-expanded", "false");
  elements.prompt.removeAttribute("aria-activedescendant");
  elements.slashCommandStatus.textContent = "";
}

function updateSlashCommandMenu({ keepActiveCommand = true } = {}) {
  const query = slashComposerQuery();
  if (query === null) {
    closeSlashCommandMenu();
    return;
  }
  void refreshAgentCommands();

  const previousActive = keepActiveCommand
    ? state.slashFilteredCommands[state.slashActiveIndex]?.name
    : null;
  state.slashFilteredCommands = slashCommandsForProvider().filter((command) =>
    command.name.includes(query),
  );
  const previousIndex = previousActive
    ? state.slashFilteredCommands.findIndex((command) => command.name === previousActive)
    : -1;
  state.slashActiveIndex =
    previousIndex >= 0
      ? previousIndex
      : Math.min(state.slashActiveIndex, Math.max(0, state.slashFilteredCommands.length - 1));

  elements.slashCommandOptions.replaceChildren();
  state.slashFilteredCommands.forEach((command, index) => {
    const availability = slashCommandAvailability(command);
    const option = document.createElement("button");
    option.type = "button";
    option.id = `slash-command-${command.name}`;
    option.className = `slash-command-option${index === state.slashActiveIndex ? " active" : ""}`;
    option.dataset.slashCommand = command.name;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(index === state.slashActiveIndex));
    option.setAttribute("aria-disabled", String(!availability.available));

    const name = document.createElement("bdi");
    name.className = "slash-command-name";
    name.dir = "ltr";
    name.textContent = command.token;
    const copy = document.createElement("span");
    copy.className = "slash-command-copy";
    const label = document.createElement("strong");
    label.textContent = command.label;
    const description = document.createElement("small");
    description.textContent = availability.available
      ? command.description
      : `${command.description} — ${availability.reason}`;
    copy.append(label, description);
    option.append(name, copy);
    const badge = slashCommandBadge(command);
    if (badge) {
      const kind = document.createElement("span");
      kind.className = "slash-command-kind";
      kind.textContent = badge;
      option.append(kind);
    }
    elements.slashCommandOptions.append(option);
  });

  const hasCommands = state.slashFilteredCommands.length > 0;
  elements.slashCommandEmpty.classList.toggle("hidden", hasCommands);
  elements.slashCommandMenu.classList.remove("hidden");
  elements.prompt.setAttribute("aria-expanded", "true");
  if (hasCommands) {
    const active = state.slashFilteredCommands[state.slashActiveIndex];
    elements.prompt.setAttribute("aria-activedescendant", `slash-command-${active.name}`);
  } else {
    elements.prompt.removeAttribute("aria-activedescendant");
  }
  elements.slashCommandStatus.textContent = hasCommands
    ? `${state.slashFilteredCommands.length.toLocaleString("fa-IR")} فرمان`
    : "فرمانی پیدا نشد";
}

function slashCommandBadge(command) {
  if (!isAgentCommand(command)) return "";
  const kind = command.kind === "prompt" ? "پرامپت" : "مهارت";
  return command.scope === "project" ? `${kind} پروژه` : kind;
}

function moveSlashCommandSelection(direction) {
  const count = state.slashFilteredCommands.length;
  if (!count) return;
  state.slashActiveIndex = (state.slashActiveIndex + direction + count) % count;
  updateSlashCommandMenu({ keepActiveCommand: false });
  const active = elements.slashCommandOptions.querySelector(".slash-command-option.active");
  active?.scrollIntoView?.({ block: "nearest" });
}

function replacePromptWithSlashCommand(command) {
  // Skills and prompt files take arguments, so completing one leaves the caret
  // after a space instead of turning into a ready-to-run local command.
  const text = isAgentCommand(command) ? `${command.token} ` : command.token;
  elements.prompt.value = text;
  elements.prompt.setSelectionRange(text.length, text.length);
  state.slashDismissedValue = null;
  saveCurrentDraft();
  resizePrompt();
  updateSlashCommandMenu({ keepActiveCommand: false });
}

async function activateHighlightedSlashCommand() {
  const command = state.slashFilteredCommands[state.slashActiveIndex];
  if (!command || elements.slashCommandMenu.classList.contains("hidden")) return false;
  if (isAgentCommand(command)) {
    const availability = slashCommandAvailability(command);
    if (!availability.available) {
      toast(availability.reason, "warning");
      return true;
    }
    // A fully typed name means "run it"; anything shorter only completes the
    // name so arguments can still be added before sending.
    if (elements.prompt.value.trim().toLowerCase() === command.token) {
      closeSlashCommandMenu();
      await sendPrompt();
      return true;
    }
    replacePromptWithSlashCommand(command);
    return true;
  }
  replacePromptWithSlashCommand(command);
  await executeSlashCommand(command);
  return true;
}

function clearSlashCommandText(expectedToken, targetDraftKey = draftKey()) {
  const stored = state.drafts.get(targetDraftKey);
  if (typeof stored === "string" && stored.trim().toLowerCase() === expectedToken.toLowerCase()) {
    state.drafts.set(targetDraftKey, "");
  }
  if (draftKey() !== targetDraftKey) return;
  if (elements.prompt.value.trim().toLowerCase() !== expectedToken.toLowerCase()) return;
  elements.prompt.value = "";
  state.drafts.set(targetDraftKey, "");
  resizePrompt();
  state.slashDismissedValue = null;
  closeSlashCommandMenu();
}

function renderLocalCommandCard(title) {
  const card = document.createElement("section");
  card.className = "local-command-card";
  card.setAttribute("aria-label", title);
  const heading = document.createElement("h3");
  heading.textContent = title;
  card.append(heading);
  elements.messages.append(card);
  elements.welcome.classList.add("hidden");
  scheduleScrollToBottom();
  return card;
}

function readableSandbox(value) {
  if (!value) return "پیش‌فرض Codex";
  if (typeof value === "string") return value;
  const names = {
    dangerFullAccess: "دسترسی کامل",
    externalSandbox: "sandbox خارجی",
    readOnly: "فقط خواندن",
    workspaceWrite: "خواندن و نوشتن در workspace",
  };
  return names[value.type] || value.type || "نامشخص";
}

function readableApproval(value) {
  if (!value) return "پیش‌فرض Codex";
  if (typeof value === "string") return value;
  return value.granular ? "granular" : "نامشخص";
}

function contextUsageText(usage) {
  const total = usage?.last?.totalTokens;
  const windowSize = usage?.modelContextWindow;
  if (!Number.isFinite(total)) return "هنوز گزارش نشده";
  const totalText = total.toLocaleString("fa-IR");
  if (!Number.isFinite(windowSize) || windowSize <= 0) return `${totalText} توکن`;
  const percent = Math.min(100, Math.max(0, (total / windowSize) * 100));
  return `${totalText} از ${windowSize.toLocaleString("fa-IR")} توکن (${percent.toLocaleString(
    "fa-IR",
    { maximumFractionDigits: 1 },
  )}٪)`;
}

const RATE_LIMIT_REACHED_LABELS = {
  rate_limit_reached: "سهمیهٔ این بازه تمام شده است",
  workspace_member_credits_depleted: "اعتبار workspace تمام شده؛ مدیر باید اعتبار اضافه کند",
  workspace_owner_credits_depleted: "اعتبار workspace تمام شده است",
  workspace_member_usage_limit_reached: "سقف مصرف workspace پر شده؛ با مدیر workspace تماس بگیرید",
  workspace_owner_usage_limit_reached: "سقف مصرف workspace پر شده است",
};

const PLAN_LABELS = {
  business: "Business",
  edu: "Edu",
  enterprise: "Enterprise",
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
};

function clampUsagePercent(value) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

function formatUsagePercent(value) {
  return `${clampUsagePercent(value).toLocaleString("fa-IR")}٪`;
}

function formatWindowDuration(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return "بازهٔ مصرف";
  if (value % 10_080 === 0) {
    return `بازهٔ ${(value / 10_080).toLocaleString("fa-IR")} هفته‌ای`;
  }
  if (value % 1_440 === 0) {
    return `بازهٔ ${(value / 1_440).toLocaleString("fa-IR")} روزه`;
  }
  if (value % 60 === 0) {
    return `بازهٔ ${(value / 60).toLocaleString("fa-IR")} ساعته`;
  }
  return `بازهٔ ${value.toLocaleString("fa-IR")} دقیقه‌ای`;
}

function relativeResetTime(timestamp) {
  const resetMs = Number(timestamp) * 1000;
  if (!Number.isFinite(resetMs) || resetMs <= 0) return "زمان بازنشانی نامشخص است";
  const deltaMs = resetMs - Date.now();
  const formatter = new Intl.RelativeTimeFormat("fa-IR", { numeric: "auto" });
  const units = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const [unit, size] = units.find(([, threshold]) => Math.abs(deltaMs) >= threshold) || [
    "minute",
    60_000,
  ];
  const raw = deltaMs / size;
  const amount = raw >= 0 ? Math.max(1, Math.ceil(raw)) : Math.floor(raw);
  return formatter.format(amount, unit);
}

function exactResetTime(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  if (Number.isNaN(date.getTime())) return "نامشخص";
  return date.toLocaleString("fa-IR", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// Claude Code exposes the active quota window and its reset time but never a
// used percentage, so the card states what is known instead of charting zero.
function unmeasuredLimitText(bucket) {
  const parts = [
    bucket.allowed === false
      ? `${formatWindowDuration(bucket.windowDurationMins)} پر شده است`
      : `${formatWindowDuration(bucket.windowDurationMins)} فعال است`,
  ];
  if (bucket.isUsingOverage) parts.push("در حال استفاده از سهمیهٔ اضافه");
  if (bucket.resetsAt) {
    parts.push(
      `بازنشانی ${relativeResetTime(bucket.resetsAt)} · ${exactResetTime(bucket.resetsAt)}`,
    );
  }
  parts.push("درصد مصرف را Claude Code گزارش نمی‌کند");
  return parts.join(" · ");
}

function currentRateLimits() {
  return state.rateLimitsProvider === effectiveProvider() ? state.rateLimits : null;
}

function rateLimitBuckets(data = currentRateLimits()) {
  const buckets = Object.values(data?.rateLimitsByLimitId || {}).filter(Boolean);
  if (buckets.length) return buckets;
  return data?.rateLimits ? [data.rateLimits] : [];
}

function rateLimitWindows(bucket) {
  return [bucket?.primary, bucket?.secondary].filter(Boolean);
}

function rateLimitReachedReason(bucket) {
  if (bucket?.rateLimitReachedType) {
    return RATE_LIMIT_REACHED_LABELS[bucket.rateLimitReachedType] || "محدودیت مصرف فعال شده است";
  }
  if (bucket?.spendControlReached) return "سقف هزینهٔ تعیین‌شده پر شده است";
  if (rateLimitWindows(bucket).some((window) => Number(window.usedPercent) >= 100)) {
    return "سهمیهٔ این بازه تمام شده است";
  }
  return "";
}

function rateLimitSummary(data = currentRateLimits()) {
  const buckets = rateLimitBuckets(data);
  const windows = buckets.flatMap(rateLimitWindows);
  const maxUsed = windows.length
    ? Math.max(...windows.map((window) => clampUsagePercent(window.usedPercent)))
    : null;
  const reachedBucket = buckets.find((bucket) => rateLimitReachedReason(bucket));
  const reachedReason = reachedBucket ? rateLimitReachedReason(reachedBucket) : "";
  const resetSources = reachedBucket
    ? [...rateLimitWindows(reachedBucket), reachedBucket]
    : [...windows, ...buckets];
  const resetCandidates = resetSources
    .map((source) => Number(source.resetsAt))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0)
    .sort((left, right) => left - right);
  return {
    maxUsed,
    reachedReason,
    resetAt: resetCandidates[0] || null,
  };
}

function updateUsageButton() {
  const summary = rateLimitSummary();
  elements.usageButton.dataset.state = summary.reachedReason
    ? "reached"
    : summary.maxUsed >= 80
      ? "warning"
      : "normal";
  elements.usagePercent.textContent = Number.isFinite(summary.maxUsed)
    ? formatUsagePercent(summary.maxUsed)
    : "—";
  const reset = summary.resetAt ? `؛ بازنشانی ${relativeResetTime(summary.resetAt)}` : "";
  const label = summary.reachedReason
    ? `${summary.reachedReason}${reset}`
    : Number.isFinite(summary.maxUsed)
      ? `${formatUsagePercent(summary.maxUsed)} از سهمیهٔ حساب استفاده شده${reset}`
      : "نمایش جزئیات مصرف";
  elements.usageButton.title = label;
  elements.usageButton.setAttribute("aria-label", label);
}

function renderContextUsage() {
  const threadId = state.currentThreadId;
  const usage = threadId ? state.threadTokenUsage.get(threadId) : null;
  const usedTokens = usage?.last?.totalTokens;
  const windowSize = usage?.modelContextWindow;

  elements.contextUsagePercent.textContent = "—";
  elements.contextUsageFill.style.width = "0%";
  elements.contextUsageProgress.removeAttribute("aria-valuenow");

  if (!threadId) {
    elements.contextUsageDetail.textContent = "بعد از شروع گفت‌وگو نمایش داده می‌شود.";
    return;
  }
  if (!Number.isFinite(usedTokens)) {
    elements.contextUsageDetail.textContent = `${providerLabel(
      effectiveProvider(),
    )} هنوز آمار Context این گفت‌وگو را گزارش نکرده است.`;
    return;
  }

  const usedText = usedTokens.toLocaleString("fa-IR");
  if (!Number.isFinite(windowSize) || windowSize <= 0) {
    elements.contextUsageDetail.textContent = `${usedText} توکن در Context فعال است؛ سقف مدل گزارش نشده.`;
    return;
  }

  const usedPercent = Math.min(100, Math.max(0, (usedTokens / windowSize) * 100));
  const roundedPercent = Number(usedPercent.toFixed(1));
  const remainingTokens = Math.max(0, windowSize - usedTokens);
  elements.contextUsagePercent.textContent = `${roundedPercent.toLocaleString("fa-IR")}٪ پر`;
  elements.contextUsageDetail.textContent = `${usedText} مصرف · ${remainingTokens.toLocaleString("fa-IR")} باقی · سقف ${windowSize.toLocaleString("fa-IR")} توکن`;
  elements.contextUsageFill.style.width = `${usedPercent}%`;
  elements.contextUsageProgress.setAttribute("aria-valuenow", String(roundedPercent));
}

function appendUsageAccountDetail(list, label, value) {
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value;
  list.append(term, detail);
}

function renderUsageAccountDetails(buckets) {
  const first = buckets[0] || null;
  const details = document.createElement("dl");
  const plan = first?.planType ? PLAN_LABELS[first.planType] || first.planType : "";
  if (plan) appendUsageAccountDetail(details, "پلن", plan);

  const credits = first?.credits;
  if (credits?.unlimited) {
    appendUsageAccountDetail(details, "اعتبار اضافه", "نامحدود");
  } else if (credits?.hasCredits || Number(credits?.balance) > 0) {
    appendUsageAccountDetail(details, "اعتبار باقی‌مانده", String(credits.balance || "۰"));
  }

  const resetCredits = currentRateLimits()?.rateLimitResetCredits;
  if (Number(resetCredits?.availableCount) > 0) {
    appendUsageAccountDetail(
      details,
      "بازنشانی رایگان",
      `${Number(resetCredits.availableCount).toLocaleString("fa-IR")} مورد`,
    );
  }

  if (first?.individualLimit) {
    appendUsageAccountDetail(
      details,
      "سقف هزینه",
      `${Number(first.individualLimit.remainingPercent).toLocaleString("fa-IR")}٪ باقی‌مانده`,
    );
  }

  elements.usageAccountDetails.replaceChildren(details);
  elements.usageAccountDetails.classList.toggle("hidden", details.childElementCount === 0);
}

function renderUsageLimits() {
  renderContextUsage();
  updateUsageButton();
  elements.usageLimits.replaceChildren();

  if (state.rateLimitsLoading && !currentRateLimits()) {
    elements.usageOverview.classList.remove("hidden");
    elements.usageOverview.textContent = "در حال دریافت اطلاعات حساب…";
    const loading = document.createElement("p");
    loading.className = "usage-empty";
    loading.textContent = "کمی صبر کنید.";
    elements.usageLimits.append(loading);
    elements.usageAccountDetails.classList.add("hidden");
    return;
  }

  const buckets = rateLimitBuckets();
  if (!buckets.length) {
    elements.usageOverview.classList.remove("hidden");
    elements.usageOverview.textContent = state.rateLimitError
      ? "اطلاعات مصرف در دسترس نیست."
      : "هنوز اطلاعاتی گزارش نشده است.";
    const empty = document.createElement("p");
    empty.className = "usage-empty";
    empty.textContent = state.rateLimitError?.message || "برای دریافت دوباره، به‌روزرسانی را بزنید.";
    elements.usageLimits.append(empty);
    elements.usageAccountDetails.classList.add("hidden");
    return;
  }

  const summary = rateLimitSummary();
  elements.usageOverview.classList.toggle("hidden", !summary.reachedReason);
  elements.usageOverview.textContent = summary.reachedReason
    ? `${summary.reachedReason}${summary.resetAt ? `؛ ${relativeResetTime(summary.resetAt)} باز می‌شود.` : "."}`
    : "";

  buckets.forEach((bucket, bucketIndex) => {
    const card = document.createElement("section");
    const reachedReason = rateLimitReachedReason(bucket);
    card.className = "usage-limit-card";
    card.dataset.state = reachedReason ? "reached" : "normal";

    const header = document.createElement("div");
    header.className = "usage-limit-header";
    const title = document.createElement("strong");
    title.textContent =
      bucket.limitName || (bucket.limitId === "codex" ? "Codex" : bucket.limitId) ||
      `سهمیهٔ ${(bucketIndex + 1).toLocaleString("fa-IR")}`;
    header.append(title);
    if (reachedReason) {
      const status = document.createElement("span");
      status.className = "usage-limit-status";
      status.textContent = "محدود";
      header.append(status);
    }
    card.append(header);

    for (const window of rateLimitWindows(bucket)) {
      const used = clampUsagePercent(window.usedPercent);
      const row = document.createElement("div");
      row.className = "usage-window";
      const heading = document.createElement("div");
      heading.className = "usage-window-heading";
      const label = document.createElement("span");
      label.textContent = formatWindowDuration(window.windowDurationMins);
      const value = document.createElement("bdi");
      value.textContent = `${formatUsagePercent(used)} استفاده · ${formatUsagePercent(100 - used)} باقی`;
      heading.append(label, value);

      const progress = document.createElement("div");
      progress.className = "usage-progress";
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", "100");
      progress.setAttribute("aria-valuenow", String(used));
      const fill = document.createElement("span");
      fill.style.width = `${used}%`;
      progress.append(fill);
      row.append(heading, progress);

      if (window.resetsAt) {
        const reset = document.createElement("small");
        reset.textContent = `بازنشانی ${relativeResetTime(window.resetsAt)} · ${exactResetTime(window.resetsAt)}`;
        row.append(reset);
      }
      card.append(row);
    }

    if (!rateLimitWindows(bucket).length) {
      const note = document.createElement("p");
      note.className = "usage-empty";
      note.textContent = bucket.usageUnavailable
        ? unmeasuredLimitText(bucket)
        : reachedReason || "جزئیات بازه گزارش نشده است.";
      card.append(note);
    }
    elements.usageLimits.append(card);
  });

  renderUsageAccountDetails(buckets);
}

function mergeRateLimitSnapshot(previous, incoming) {
  if (!previous) return incoming;
  if (!incoming) return previous;
  return {
    ...previous,
    ...incoming,
    primary: incoming.primary
      ? { ...(previous.primary || {}), ...incoming.primary }
      : previous.primary,
    secondary: incoming.secondary
      ? { ...(previous.secondary || {}), ...incoming.secondary }
      : Object.hasOwn(incoming, "secondary")
        ? incoming.secondary
        : previous.secondary,
  };
}

function applyRateLimits(data, { notify = false, provider = "" } = {}) {
  const incoming = data || {};
  const source = provider || incoming.provider || "codex";
  // A snapshot from another agent must replace, never merge into, the current one.
  const previous = state.rateLimitsProvider === source ? state.rateLimits || {} : {};
  if (state.rateLimitsProvider !== source) state.notifiedRateLimitKey = null;
  state.rateLimitsProvider = source;
  const next = {
    ...previous,
    ...incoming,
    rateLimits: mergeRateLimitSnapshot(previous.rateLimits, incoming.rateLimits),
  };
  if (incoming.rateLimitsByLimitId) {
    next.rateLimitsByLimitId = {
      ...(previous.rateLimitsByLimitId || {}),
      ...incoming.rateLimitsByLimitId,
    };
  } else if (incoming.rateLimits?.limitId && previous.rateLimitsByLimitId) {
    const id = incoming.rateLimits.limitId;
    next.rateLimitsByLimitId = {
      ...previous.rateLimitsByLimitId,
      [id]: mergeRateLimitSnapshot(previous.rateLimitsByLimitId[id], incoming.rateLimits),
    };
  }
  state.rateLimits = next;
  state.rateLimitError = null;
  state.rateLimitsFetchedAt = Date.now();
  renderUsageLimits();

  const summary = rateLimitSummary(next);
  if (!summary.reachedReason) {
    state.notifiedRateLimitKey = null;
    return;
  }
  const notificationKey = `${summary.reachedReason}:${summary.resetAt || "unknown"}`;
  if (!notify || state.notifiedRateLimitKey === notificationKey) return;
  state.notifiedRateLimitKey = notificationKey;
  const reset = summary.resetAt ? ` ${relativeResetTime(summary.resetAt)} دوباره باز می‌شود.` : "";
  toast(`${summary.reachedReason}.${reset}`, "error", {
    duration: 12_000,
    onClick: openUsageDialog,
  });
}

async function refreshRateLimits({ force = false, silent = false } = {}) {
  const provider = effectiveProvider();
  if (!providerSupports("usage", provider)) return;
  if (state.rateLimitsLoading) return;
  const stale = state.rateLimitsProvider !== provider;
  if (!force && !stale && Date.now() - state.rateLimitsFetchedAt < 15_000) return;
  state.rateLimitsLoading = true;
  state.rateLimitError = null;
  renderUsageLimits();
  elements.usageRefresh.disabled = true;
  try {
    const result = await rpc("account/rateLimits/read", { provider });
    applyRateLimits(result, { notify: true, provider });
  } catch (error) {
    state.rateLimitError = error;
    renderUsageLimits();
    if (!silent) showError(error, `دریافت سهمیهٔ ${providerLabel(provider)}`);
  } finally {
    state.rateLimitsLoading = false;
    elements.usageRefresh.disabled = false;
    renderUsageLimits();
  }
}

function openUsageDialog() {
  if (!elements.usageDialog.open) elements.usageDialog.showModal();
  renderUsageLimits();
  if (!currentRateLimits() || Date.now() - state.rateLimitsFetchedAt > 60_000) {
    void refreshRateLimits({ force: true });
  }
  clearInterval(state.usageClockTimer);
  state.usageClockTimer = setInterval(renderUsageLimits, 60_000);
}

function closeUsageDialog() {
  clearInterval(state.usageClockTimer);
  state.usageClockTimer = null;
  elements.usageDialog.close();
}

function showSlashStatus() {
  const threadId = state.currentThreadId;
  const runtime = threadId ? state.threadRuntime.get(threadId) || {} : {};
  const thread = state.currentThread;
  const usage = threadId ? state.threadTokenUsage.get(threadId) : null;
  const provider = effectiveProvider();
  const label = providerLabel(provider);
  const selectedModel = state.settings.modelByProvider[provider] || "";
  const rows = [
    ["Agent", label],
    ["اتصال", state.connected ? "متصل" : "قطع"],
    ["وضعیت", state.busy ? "در حال اجرا" : threadId ? "آماده" : "گفتگوی تازه"],
    ["شناسهٔ گفتگو", threadId || "هنوز ساخته نشده"],
    ["پوشهٔ کاری", runtime.cwd || thread?.cwd || state.settings.cwd || "نامشخص"],
    ["مدل", runtime.model || thread?.model || selectedModel || `پیش‌فرض ${label}`],
  ];
  if (provider === "claude") {
    rows.push([
      "Permission mode",
      runtime.permissionMode ||
        thread?.permissionMode ||
        (!threadId ? state.settings.claudePermissionMode : "نامشخص"),
    ]);
  } else {
    rows.push(
      ["Sandbox", readableSandbox(runtime.sandbox || state.settings.sandbox)],
      ["Approval", readableApproval(runtime.approvalPolicy || state.settings.approvalPolicy)],
    );
  }
  if (providerSupports("context", provider)) {
    rows.push(["Context", contextUsageText(usage)]);
  }
  const card = renderLocalCommandCard(`وضعیت ${label}`);
  const list = document.createElement("dl");
  for (const [label, value] of rows) {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    list.append(term, detail);
  }
  card.append(list);
}

async function runCompactSlashCommand(command) {
  const threadId = state.currentThreadId;
  const targetDraftKey = draftKey(threadId);
  saveCurrentDraft();
  state.slashCommandExecuting = true;
  state.compactPendingThreads.add(threadId);
  updateThreadActivity(threadId, {
    phase: "running",
    terminalPhase: null,
    turnId: null,
    unread: false,
  });
  if (state.currentThreadId === threadId) setBusy(true);
  updateSlashCommandMenu();
  updateComposerControls();

  try {
    await rpc("thread/compact/start", { threadId });
    clearSlashCommandText(command.token, targetDraftKey);
    toast("درخواست فشرده‌سازی گفتگو ثبت شد.", "success");
  } catch (error) {
    const requestHadNotStarted = state.compactPendingThreads.delete(threadId);
    if (requestHadNotStarted) {
      const activity = ensureThreadActivity(threadId);
      activity.phase = "idle";
      activity.terminalPhase = null;
      activity.turnId = null;
      activity.unread = false;
      if (state.currentThreadId === threadId) setBusy(false);
      renderThreadList();
      updateAttentionUi();
    } else {
      clearSlashCommandText(command.token, targetDraftKey);
      toast(
        `${providerLabel(
          providerForThread(threadId),
        )} فشرده‌سازی را شروع کرده است، اما پاسخ تأیید آن به رابط نرسید.`,
        "warning",
        { duration: 7000 },
      );
      return;
    }
    const unsupported =
      error.details?.code === -32601 ||
      /method not found|does not provide|not supported/i.test(error.message || "");
    if (unsupported) {
      const label = providerLabel(providerForThread(threadId));
      toast(
        `این نسخهٔ ${label} از فشرده‌سازی بومی پشتیبانی نمی‌کند؛ ${label} CLI را به‌روز کنید.`,
        "error",
        { duration: 7000 },
      );
    } else {
      showError(error, "فشرده‌سازی گفتگو");
    }
  } finally {
    state.slashCommandExecuting = false;
    updateSlashCommandMenu();
    updateComposerControls();
  }
}

async function executeSlashCommand(command) {
  const availability = slashCommandAvailability(command);
  if (!availability.available) {
    toast(availability.reason, "warning");
    updateSlashCommandMenu();
    return;
  }

  const targetDraftKey = draftKey();
  switch (command.name) {
    case "goal":
      clearSlashCommandText(command.token, targetDraftKey);
      openGoalDialog();
      return;
    case "plan":
      clearSlashCommandText(command.token, targetDraftKey);
      togglePlanMode();
      return;
    case "compact":
      await runCompactSlashCommand(command);
      return;
    case "new":
      clearSlashCommandText(command.token, targetDraftKey);
      newChat();
      return;
    case "resume":
      clearSlashCommandText(command.token, targetDraftKey);
      openSidebar();
      setTimeout(() => {
        elements.threadSearch.focus();
        elements.threadSearch.select();
      }, 0);
      return;
    case "status":
      clearSlashCommandText(command.token, targetDraftKey);
      showSlashStatus();
      return;
    case "usage":
      clearSlashCommandText(command.token, targetDraftKey);
      openUsageDialog();
      return;
    case "model":
      clearSlashCommandText(command.token, targetDraftKey);
      openSettings({ focus: elements.modelSelect, provider: effectiveProvider() });
      return;
    case "permissions":
      clearSlashCommandText(command.token, targetDraftKey);
      openSettings({
        focus:
          effectiveProvider() === "claude"
            ? elements.claudePermissionMode
            : elements.sandboxSelect,
        provider: effectiveProvider(),
      });
      return;
  }
}

async function handleSlashCommand(text) {
  const parsed = parseSlashCommand(text);
  if (!parsed) return false;
  // Skills and prompt files belong to the CLI: leave them in the prompt text.
  if (isAgentCommand(parsed.command)) return false;
  if (!parsed.command) {
    toast(
      `فرمان ${parsed.token} در Codex Web پشتیبانی نمی‌شود؛ برای دیدن فهرست فقط / را تایپ کنید.`,
      "warning",
      { duration: 6500 },
    );
    updateSlashCommandMenu();
    return true;
  }
  if (parsed.multiline) {
    toast("فرمان اسلش باید به‌تنهایی در یک خط نوشته شود.", "warning");
    return true;
  }
  if (parsed.arguments) {
    toast(`${parsed.command.token} در این رابط آرگومان نمی‌پذیرد.`, "warning");
    return true;
  }
  await executeSlashCommand(parsed.command);
  return true;
}

function promptSelection() {
  const fallback = elements.prompt.value.length;
  return {
    end: Number.isInteger(elements.prompt.selectionEnd)
      ? elements.prompt.selectionEnd
      : fallback,
    start: Number.isInteger(elements.prompt.selectionStart)
      ? elements.prompt.selectionStart
      : fallback,
  };
}

function insertPromptText(text) {
  if (!text) return;
  const { start, end } = promptSelection();
  if (typeof elements.prompt.setRangeText === "function") {
    elements.prompt.setRangeText(text, start, end, "end");
  } else {
    elements.prompt.value =
      elements.prompt.value.slice(0, start) + text + elements.prompt.value.slice(end);
    const nextPosition = start + text.length;
    elements.prompt.setSelectionRange(nextPosition, nextPosition);
  }
  saveCurrentDraft();
  resizePrompt();
}

function markdownQuote(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function insertAssistantQuote(text) {
  const quote = markdownQuote(text || "");
  if (!quote) return;
  const { start, end } = promptSelection();
  const before = elements.prompt.value.slice(0, start);
  const prefix = before && !before.endsWith("\n\n") ? "\n\n" : "";
  insertPromptText(`${prefix}${quote}\n\n`);
  elements.prompt.focus();
}

function hideSelectionAsk() {
  state.selectedAssistantText = "";
  elements.selectionAsk.classList.add("hidden");
}

function selectedAssistantRange() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount < 1) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;
  const startElement =
    startNode?.nodeType === 1 ? startNode : startNode?.parentElement;
  const content = startElement?.closest?.(".message-row.assistant .message-content");
  if (!content || !content.contains(range.endContainer)) return null;
  return { content, range, selection, text };
}

function updateSelectionAsk() {
  const selected = selectedAssistantRange();
  if (!selected) {
    hideSelectionAsk();
    return;
  }
  const rect = selected.range.getBoundingClientRect?.();
  if (!rect) {
    hideSelectionAsk();
    return;
  }
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
  const center = Math.min(viewportWidth - 82, Math.max(82, rect.left + rect.width / 2));
  const below = rect.bottom + 9;
  const top = below + 42 < viewportHeight ? below : Math.max(8, rect.top - 47);
  state.selectedAssistantText = selected.text;
  elements.selectionAsk.style.left = `${center}px`;
  elements.selectionAsk.style.top = `${top}px`;
  elements.selectionAsk.classList.remove("hidden");
}

let selectionAskFrame = null;
function scheduleSelectionAskUpdate() {
  if (selectionAskFrame !== null) return;
  selectionAskFrame = requestAnimationFrame(() => {
    selectionAskFrame = null;
    updateSelectionAsk();
  });
}

function appendAttachmentPaths(value, paths) {
  const pathText = paths.join("\n");
  if (!value) return pathText;
  return `${value}${value.endsWith("\n") ? "" : "\n"}${pathText}`;
}

function insertAttachmentPaths(paths, targetDraftKey) {
  if (!paths.length) return;
  if (draftKey() !== targetDraftKey) {
    state.drafts.set(
      targetDraftKey,
      appendAttachmentPaths(state.drafts.get(targetDraftKey) || "", paths),
    );
    toast("مسیر پیوست به پیش‌نویس گفتگوی مربوط اضافه شد.", "success");
    return;
  }

  elements.prompt.value = appendAttachmentPaths(elements.prompt.value, paths);
  elements.prompt.setSelectionRange(
    elements.prompt.value.length,
    elements.prompt.value.length,
  );
  saveCurrentDraft();
  resizePrompt();
  elements.prompt.focus();
}

async function uploadAttachment(file) {
  const declaredType = String(file.type || "").toLowerCase();
  const image = Object.hasOwn(IMAGE_EXTENSIONS, declaredType);
  const type = declaredType || "application/octet-stream";
  if (!file.size) throw new Error("فایل خالی است.");
  if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
    throw new Error("حجم هر فایل باید حداکثر ۲۵ مگابایت باشد.");
  }

  const fallbackName = image
    ? `clipboard-${Date.now()}.${IMAGE_EXTENSIONS[type]}`
    : `attachment-${Date.now()}`;
  const response = await fetch(image ? "/api/uploads/images" : "/api/uploads/files", {
    method: "POST",
    headers: {
      "Content-Type": type,
      "X-File-Name": encodeURIComponent(file.name || fallbackName),
    },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  if (
    typeof data.path !== "string" ||
    (!data.path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(data.path))
  ) {
    throw new Error("سرور مسیر معتبری برای فایل برنگرداند.");
  }
  return data.path;
}

async function uploadAttachments(files, targetDraftKey = draftKey()) {
  const selectedAttachments = [...files].filter(Boolean);
  const attachments = selectedAttachments.slice(0, MAX_ATTACHMENTS_PER_BATCH);
  if (!attachments.length) return;
  if (selectedAttachments.length > MAX_ATTACHMENTS_PER_BATCH) {
    toast(
      `در هر نوبت حداکثر ${MAX_ATTACHMENTS_PER_BATCH.toLocaleString("fa-IR")} فایل اضافه می‌شود.`,
      "warning",
      { duration: 7000 },
    );
  }

  state.attachmentUploadsByDraft.set(
    targetDraftKey,
    attachmentUploadsForDraft(targetDraftKey) + attachments.length,
  );
  updateComposerControls();
  try {
    const results = [];
    for (const attachment of attachments) {
      try {
        results.push({ status: "fulfilled", value: await uploadAttachment(attachment) });
      } catch (reason) {
        results.push({ reason, status: "rejected" });
      }
    }
    const paths = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const failures = results.filter((result) => result.status === "rejected");
    insertAttachmentPaths(paths, targetDraftKey);
    if (paths.length > 1) {
      toast(`${paths.length.toLocaleString("fa-IR")} فایل اضافه شد.`, "success");
    } else if (paths.length === 1) {
      toast("فایل اضافه شد.", "success");
    }
    if (failures.length) {
      const firstError = failures[0].reason?.message || "خطای نامشخص";
      const count = failures.length.toLocaleString("fa-IR");
      toast(
        failures.length === 1
          ? `افزودن فایل انجام نشد: ${firstError}`
          : `افزودن ${count} فایل انجام نشد: ${firstError}`,
        "error",
        { duration: 7000 },
      );
    }
  } finally {
    const remaining = Math.max(
      0,
      attachmentUploadsForDraft(targetDraftKey) - attachments.length,
    );
    if (remaining) state.attachmentUploadsByDraft.set(targetDraftKey, remaining);
    else state.attachmentUploadsByDraft.delete(targetDraftKey);
    updateComposerControls();
  }
}

function handlePromptPaste(event) {
  const items = [...(event.clipboardData?.items || [])];
  const images = items
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!images.length) return;

  event.preventDefault();
  const targetDraftKey = draftKey();
  const plainText = event.clipboardData.getData("text/plain");
  if (plainText) insertPromptText(plainText);
  void uploadAttachments(images, targetDraftKey);
}

function attachmentUploadsForDraft(key = draftKey()) {
  return state.attachmentUploadsByDraft.get(key) || 0;
}

function dragCarriesFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

function setComposerDropActive(active) {
  elements.composer.classList.toggle("drop-active", active);
  elements.composerDropOverlay.classList.toggle("hidden", !active);
}

function handleComposerDragEnter(event) {
  if (!dragCarriesFiles(event)) return;
  event.preventDefault();
  setComposerDropActive(true);
}

function handleComposerDragOver(event) {
  if (!dragCarriesFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function handleComposerDragLeave(event) {
  if (!dragCarriesFiles(event)) return;
  if (event.relatedTarget && elements.composer.contains(event.relatedTarget)) return;
  setComposerDropActive(false);
}

function handleComposerDrop(event) {
  if (!dragCarriesFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  setComposerDropActive(false);
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  void uploadAttachments(files, draftKey());
}

function speechRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function setDictationActive(active) {
  elements.dictate.classList.toggle("active", active);
  elements.dictate.setAttribute("aria-pressed", String(active));
  elements.dictate.title = active ? "پایان دیکته" : "دیکته (Ctrl+Shift+D)";
}

function stopDictation() {
  const recognition = state.dictationRecognition;
  if (!recognition) return false;
  try {
    recognition.stop();
  } catch {
    try {
      recognition.abort();
    } catch {
      // Recognition may already have ended.
    }
  }
  return true;
}

function dictationErrorMessage(errorCode) {
  if (errorCode === "not-allowed" || errorCode === "service-not-allowed") {
    if (!window.isSecureContext) {
      return "Chrome اجازهٔ Dictation را روی این آدرس نداد؛ از میکروفون Gboard داخل فیلد پیام استفاده کنید.";
    }
    return "اجازهٔ میکروفون برای Dictation داده نشد؛ دسترسی Microphone این سایت را فعال کنید.";
  }
  if (errorCode === "audio-capture") {
    return "میکروفون در دسترس نیست؛ اتصال یا مجوز میکروفون دستگاه را بررسی کنید.";
  }
  if (errorCode === "network") {
    return "سرویس تبدیل گفتار در دسترس نیست؛ اتصال اینترنت را بررسی یا از میکروفون Gboard استفاده کنید.";
  }
  if (errorCode === "language-not-supported") {
    return "Dictation فارسی در این مرورگر دردسترس نیست؛ از میکروفون Gboard استفاده کنید.";
  }
  return `Dictation متوقف شد: ${errorCode || "خطای ناشناخته"}`;
}

function toggleDictation() {
  if (state.dictationRecognition) {
    stopDictation();
    return;
  }
  const SpeechRecognition = speechRecognitionConstructor();
  if (!SpeechRecognition) {
    toast("مرورگر شما Dictation را پشتیبانی نمی‌کند؛ Chrome یا Edge جدید را امتحان کنید.", "warning", {
      duration: 7000,
    });
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = "fa-IR";
  recognition.continuous = true;
  recognition.interimResults = true;
  state.dictationBase = elements.prompt.value;
  state.dictationFinal = "";
  state.dictationRecognition = recognition;

  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";
    for (let index = 0; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result?.[0]?.transcript || "";
      if (result?.isFinal) finalText += transcript;
      else interimText += transcript;
    }
    state.dictationFinal = finalText.trim();
    const spoken = [state.dictationFinal, interimText.trim()].filter(Boolean).join(" ");
    const separator = state.dictationBase && spoken && !/\s$/.test(state.dictationBase) ? " " : "";
    elements.prompt.value = `${state.dictationBase}${separator}${spoken}`;
    elements.prompt.setSelectionRange(elements.prompt.value.length, elements.prompt.value.length);
    saveCurrentDraft();
    resizePrompt();
  };
  recognition.onerror = (event) => {
    if (!["aborted", "no-speech"].includes(event.error)) {
      const permission = event.error === "not-allowed" || event.error === "service-not-allowed";
      toast(dictationErrorMessage(event.error), permission ? "warning" : "error", {
        duration: 8000,
      });
    }
  };
  recognition.onend = () => {
    if (state.dictationRecognition !== recognition) return;
    state.dictationRecognition = null;
    setDictationActive(false);
    saveCurrentDraft();
    resizePrompt();
  };

  try {
    recognition.start();
    setDictationActive(true);
  } catch (error) {
    state.dictationRecognition = null;
    setDictationActive(false);
    showError(error, "شروع Dictation");
  }
}

function updateComposerControls() {
  const uploadingAttachments = attachmentUploadsForDraft();
  const uploading = uploadingAttachments > 0;
  const text = elements.prompt.value.trim();
  const parsedSlash = parseSlashCommand(elements.prompt.value);
  const slash = isAgentCommand(parsedSlash?.command) ? null : parsedSlash;
  const slashCanRun =
    slash &&
    (slash.command
      ? slashCommandAvailability(slash.command).available
      : !state.navigating && !state.slashCommandExecuting);
  const queueMode = state.busy && !slash;
  elements.sendMessage.disabled = slash
    ? !slashCanRun
    : !state.connected || state.navigating || uploading || !text;
  elements.sendMessage.classList.toggle("queue-mode", queueMode);
  elements.sendMessage.setAttribute(
    "aria-label",
    queueMode ? "افزودن پیام به صف" : "ارسال پیام",
  );
  elements.sendMessage.title = queueMode ? "افزودن به صف" : "ارسال";
  elements.composerHint.textContent = state.busy
    ? "Enter برای افزودن به صف · Shift+Enter برای خط جدید"
    : "Enter برای ارسال · Shift+Enter برای خط جدید";
  elements.addImages.disabled = state.navigating || uploading;
  elements.imageInput.disabled = state.navigating || uploading;
  elements.composerTools.disabled = state.navigating;
  elements.dictate.disabled = state.navigating;
  elements.uploadStatus.textContent = uploadingAttachments > 1
    ? `در حال افزودن ${uploadingAttachments.toLocaleString("fa-IR")} فایل…`
    : "در حال افزودن فایل…";
  elements.uploadStatus.classList.toggle("hidden", !uploading);
  updateComposerModeUi();
  updateSlashCommandMenu();
}

function updateAgentCopy(provider) {
  const label = providerLabel(provider);
  elements.prompt.placeholder = `پیام به ${label}…`;
  elements.prompt.setAttribute("aria-label", `پیام به ${label}`);
  const project = currentProject();
  if (project) {
    elements.welcomeTitle.textContent = `در پروژهٔ «${project.name}» روی چی کار کنیم؟`;
    elements.welcomeDescription.textContent =
      "پوشه و دستورهای این پروژه برای گفتگوی تازه اعمال می‌شوند.";
    return;
  }
  if (provider === "claude") {
    elements.welcomeTitle.textContent = "امروز چی رو به Claude بسپاریم؟";
    elements.welcomeDescription.textContent =
      "کد، فایل یا ایده‌ات را بفرست؛ ابزارهای فنی Claude پشت صحنه آماده‌اند.";
  } else {
    elements.welcomeTitle.textContent = "امروز روی چی کار کنیم؟";
    elements.welcomeDescription.textContent =
      "کد، فایل یا ایده‌ات را بفرست؛ ابزارهای فنی پشت صحنه آماده‌اند.";
  }
}

function updateConnection() {
  const provider = effectiveProvider();
  const status = state.providerStatuses[provider] || {};
  const ready = Boolean(status.ready);
  const label = providerLabel(provider);
  state.connected = ready;
  elements.statusDot.className = `status-dot ${ready ? "ready" : "starting"}`;
  elements.connectionLabel.textContent = ready
    ? `${label} متصل است`
    : status.message || `در حال اتصال به ${label}…`;
  updateAgentCopy(provider);
  updateComposerControls();
}

function setProviderStatus(provider, status = {}) {
  if (provider !== "codex" && provider !== "claude") return false;
  const previous = state.providerStatuses[provider] || {};
  const next = {
    ...previous,
    ...status,
    ready: Boolean(status.ready),
  };
  state.providerStatuses[provider] = next;
  return previous.ready !== next.ready || previous.message !== next.message;
}

function applyProviderStatusPayload(data = {}) {
  let changed = false;
  if (data.providers) {
    for (const provider of ["codex", "claude"]) {
      if (data.providers[provider]) {
        changed = setProviderStatus(provider, data.providers[provider]) || changed;
      }
    }
  } else if (
    (data.provider === "codex" || data.provider === "claude") &&
    Object.hasOwn(data, "ready")
  ) {
    changed =
      setProviderStatus(data.provider, {
        message: data.message || "",
        ready: Boolean(data.ready),
      }) || changed;
  } else if (Object.hasOwn(data, "ready")) {
    // Provider-less app-server status notifications have historically described Codex only.
    changed =
      setProviderStatus("codex", {
        message: data.message || "",
        ready: Boolean(data.ready),
      }) || changed;
  }
  updateConnection();
  return changed;
}

function markProviderConnectionsUnavailable(message) {
  setProviderStatus("codex", { message, ready: false });
  setProviderStatus("claude", { message, ready: false });
  updateConnection();
}

function setBusy(busy, turnId = null) {
  state.busy = busy;
  state.currentTurnId = busy ? turnId : null;
  elements.stopTurn.classList.toggle("hidden", !busy || !state.currentTurnId);
  updateComposerControls();
}

function setNavigating(navigating) {
  state.navigating = navigating;
  if (navigating) {
    closeSlashCommandMenu();
    closeComposerToolsMenu();
    stopDictation();
  }
  elements.prompt.disabled = navigating;
  updateConnection();
  updateComposerControls();
  resizePrompt();
}

function updateFullAccessWarning(provider = elements.providerSelect.value) {
  const dangerous =
    provider === "claude"
      ? elements.claudePermissionMode.value === "bypassPermissions"
      : elements.sandboxSelect.value === "danger-full-access";
  elements.fullAccessWarning.classList.toggle("visible", dangerous);
}

function updateSettingsProviderUi(provider) {
  elements.settingsDialog.dataset.provider = provider;
  const ultraEffort = elements.effortSelect.querySelector('option[value="ultra"]');
  if (ultraEffort) {
    ultraEffort.disabled = provider === "claude";
    ultraEffort.hidden = provider === "claude";
    if (provider === "claude" && elements.effortSelect.value === "ultra") {
      elements.effortSelect.value = "";
    } else if (
      provider === "codex" &&
      !elements.effortSelect.value &&
      state.settings.effort === "ultra"
    ) {
      elements.effortSelect.value = "ultra";
    }
  }
  updateFullAccessWarning(provider);
}

const EFFORT_LABELS = {
  "": "پیش‌فرض مدل",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

function modelEntry(provider = state.settings.provider) {
  const models = state.modelsByProvider[provider] || [];
  const selected = state.settings.modelByProvider[provider] || "";
  return (
    models.find(
      (candidate) => candidate.id === selected || candidate.model === selected,
    ) || null
  );
}

// Codex reports which efforts a model actually accepts; Claude's list carries no
// metadata, so fall back to everything the provider will validate.
// Codex reports each level as { reasoningEffort, description }; tolerate a bare
// string too so the shape is not load-bearing.
function normalizeEffort(entry) {
  if (typeof entry === "string") return { value: entry, description: "" };
  if (entry && typeof entry === "object") {
    return {
      value: String(entry.reasoningEffort || entry.effort || entry.id || ""),
      description: String(entry.description || ""),
    };
  }
  return { value: "", description: "" };
}

function effortsForCurrentModel(provider = state.settings.provider) {
  const model = modelEntry(provider);
  const supported = model?.supportedReasoningEfforts;
  const entries =
    Array.isArray(supported) && supported.length
      ? supported.map(normalizeEffort)
      : Object.keys(EFFORT_LABELS)
          .filter((value) => value)
          .map((value) => ({ value, description: "" }));
  const allowed = entries.filter(
    ({ value }) =>
      EFFORT_LABELS[value] && (provider === "codex" || CLAUDE_EFFORTS.has(value)),
  );
  const fallbackLabel = model?.defaultReasoningEffort
    ? `پیش‌فرض مدل (${EFFORT_LABELS[model.defaultReasoningEffort] || model.defaultReasoningEffort})`
    : EFFORT_LABELS[""];
  return [{ value: "", description: "", label: fallbackLabel }, ...allowed];
}

function updateModelLabel(provider = state.settings.provider) {
  const selected = state.settings.modelByProvider[provider] || "";
  const name = modelEntry(provider)?.displayName || selected || "مدل پیش‌فرض";
  const effort = state.settings.effort;
  elements.modelLabel.textContent =
    effort && EFFORT_LABELS[effort] ? `${name} · ${EFFORT_LABELS[effort]}` : name;

  // The topbar readout used to carry the open thread's real provider/cwd/model;
  // keep that detail here rather than losing it with the readout.
  const thread = state.currentThreadId ? state.currentThread : null;
  const runtime = state.currentThreadId
    ? state.threadRuntime.get(state.currentThreadId) || {}
    : {};
  elements.modelChip.title = thread
    ? [
        providerLabel(thread.provider || providerForThread(thread.id)),
        runtime.model || thread.model || name,
      ]
        .filter(Boolean)
        .join("  ·  ")
    : `${name} — برای گفتگوی تازه`;
  // Models arrive asynchronously, so an open menu has to pick them up.
  renderRunChipMenu();
}

function buildChoiceRow({ value, label, selected, dataset }) {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", String(selected));
  button.className = `project-item ${selected ? "active" : ""}`;
  button.dataset[dataset] = value;

  const check = document.createElement("span");
  check.className = "project-item-check";
  check.textContent = selected ? "✓" : "";
  check.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "project-item-name";
  name.textContent = label;
  button.append(check, name);
  return button;
}

function renderRunChipMenu() {
  const provider = state.settings.provider;
  const models = state.modelsByProvider[provider] || [];
  const selectedModel = state.settings.modelByProvider[provider] || "";

  elements.providerOptions.replaceChildren();
  for (const candidate of ["codex", "claude"]) {
    elements.providerOptions.append(
      buildChoiceRow({
        value: candidate,
        label: candidate === "claude" ? "Claude Code CLI" : "Codex CLI",
        selected: candidate === provider,
        dataset: "providerValue",
      }),
    );
  }
  // An open conversation keeps the provider it was started with.
  elements.providerNote.classList.toggle("hidden", !state.currentThreadId);

  elements.modelOptions.replaceChildren();
  for (const model of [{ model: "", displayName: `پیش‌فرض ${providerLabel(provider)}` }, ...models]) {
    const value = model.model || model.id || "";
    elements.modelOptions.append(
      buildChoiceRow({
        value,
        label: `${model.displayName}${model.isDefault ? " — پیش‌فرض" : ""}`,
        selected: value === selectedModel,
        dataset: "modelValue",
      }),
    );
  }

  elements.effortOptions.replaceChildren();
  for (const entry of effortsForCurrentModel(provider)) {
    const button = document.createElement("button");
    button.type = "button";
    const selected = entry.value === (state.settings.effort || "");
    button.className = `effort-option ${selected ? "active" : ""}`;
    button.dataset.effortValue = entry.value;
    button.setAttribute("aria-pressed", String(selected));
    button.textContent = entry.label || EFFORT_LABELS[entry.value];
    if (entry.description) button.title = entry.description;
    elements.effortOptions.append(button);
  }
}

function setRunProvider(provider) {
  if (provider !== "codex" && provider !== "claude") return;
  if (provider === state.settings.provider) return;
  state.settings.provider = provider;
  persistSettings();
  state.models = state.modelsByProvider[provider] || [];
  updateSettingsUi();
  updateConnection();
  void loadModels(provider);
  void refreshProviderStatus();
}

function setRunSetting({ model, effort }) {
  if (model !== undefined) {
    state.settings.modelByProvider = {
      ...state.settings.modelByProvider,
      [state.settings.provider]: model,
    };
  }
  if (effort !== undefined) state.settings.effort = effort;
  persistSettings();
  updateSettingsUi();
}

function updateSettingsUi() {
  const provider = state.settings.provider;
  state.models = state.modelsByProvider[provider] || [];
  const selectedModel = state.settings.modelByProvider[provider] || "";
  elements.cwdInput.value = state.settings.cwd;
  updateProjectChip();
  void refreshAgentCommands();
  elements.providerSelect.value = provider;
  renderModelOptions(state.models, selectedModel, provider);
  elements.effortSelect.value = state.settings.effort;
  elements.sandboxSelect.value = state.settings.sandbox;
  elements.approvalSelect.value = state.settings.approvalPolicy;
  elements.claudePermissionMode.value = state.settings.claudePermissionMode;
  for (const input of document.querySelectorAll('input[name="accent-palette"]')) {
    input.checked = input.value === state.settings.palette;
  }
  applyPalette(state.settings.palette);
  updateSettingsProviderUi(provider);
  updateModelLabel(provider);
}

function shortPath(path, length = 30) {
  if (!path) return "";
  if (path.length <= length) return path;
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return `…${path.slice(-(length - 1))}`;
  return `…/${parts.slice(-2).join("/")}`;
}

function openSettings({ focus = elements.cwdInput, provider = state.settings.provider } = {}) {
  updateSettingsUi();
  if (provider !== state.settings.provider) {
    elements.providerSelect.value = provider;
    updateSettingsProviderUi(provider);
    const models = state.modelsByProvider[provider] || [];
    renderModelOptions(models, state.settings.modelByProvider[provider] || "", provider);
    void loadModels(provider);
  }
  elements.settingsDialog.showModal();
  setTimeout(() => focus.focus(), 0);
}

function saveSettings() {
  const cwd = elements.cwdInput.value.trim();
  if (!cwd.startsWith("/")) {
    toast("پوشه کاری باید با / شروع شود.", "error");
    return;
  }
  const provider = elements.providerSelect.value;
  state.settings = {
    approvalPolicy: elements.approvalSelect.value,
    claudePermissionMode: elements.claudePermissionMode.value,
    cwd,
    effort: elements.effortSelect.value,
    modelByProvider: {
      ...state.settings.modelByProvider,
      [provider]: elements.modelSelect.value,
    },
    palette:
      [...document.querySelectorAll('input[name="accent-palette"]')].find(
        (input) => input.checked,
      )?.value ||
      defaultSettings.palette,
    provider,
    sandbox: elements.sandboxSelect.value,
    sidebarCollapsed: state.settings.sidebarCollapsed,
  };
  persistSettings();
  applyPalette(state.settings.palette);
  state.models = state.modelsByProvider[provider] || [];
  updateSettingsUi();
  updateConnection();
  void loadModels();
  void refreshThreads();
  void refreshProviderStatus();
  elements.settingsDialog.close();
}

function formatRelativeTime(seconds) {
  if (!seconds) return "";
  const elapsed = Math.max(0, Date.now() - seconds * 1000);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const fa = (value) => value.toLocaleString("fa-IR");
  if (elapsed < minute) return "اکنون";
  if (elapsed < hour) return `${fa(Math.floor(elapsed / minute))} دقیقه`;
  if (elapsed < day) return `${fa(Math.floor(elapsed / hour))} ساعت`;
  if (elapsed < 7 * day) return `${fa(Math.floor(elapsed / day))} روز`;
  return new Intl.DateTimeFormat("fa-IR", { month: "short", day: "numeric" }).format(
    seconds * 1000,
  );
}

// Neither provider timestamps individual messages — Codex does not record it at
// all, and Claude keeps it only in its own transcript. Both do report when a
// turn started and finished, in seconds, so time is shown at turn boundaries.
function formatClockTime(seconds) {
  if (!seconds) return "";
  return new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(seconds * 1000);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 1) return "";
  const fa = (value) => value.toLocaleString("fa-IR");
  if (seconds < 60) return `${fa(Math.round(seconds))} ثانیه`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${fa(minutes)} دقیقه`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${fa(hours)} ساعت و ${fa(rest)} دقیقه` : `${fa(hours)} ساعت`;
}

function turnDurationSeconds(timing) {
  if (!timing) return null;
  if (Number.isFinite(timing.durationMs)) return timing.durationMs / 1000;
  if (timing.startedAt && timing.completedAt) {
    return timing.completedAt - timing.startedAt;
  }
  return null;
}

function applyTurnTiming(turnId) {
  const timing = state.turnTimings.get(turnId);
  if (!timing) return;
  const clock = formatClockTime(timing.startedAt);
  const duration = formatDuration(turnDurationSeconds(timing));
  for (const row of elements.messages.querySelectorAll(".message-row")) {
    if (row.dataset.turnId !== turnId) continue;
    const slot = row.querySelector(".message-time");
    if (!slot) continue;
    const assistant = row.classList.contains("assistant");
    // The clock marks when the exchange began; the duration is only meaningful
    // once the answer has landed.
    const text = assistant ? duration : clock;
    slot.textContent = text;
    if (timing.startedAt) {
      slot.dateTime = new Date(timing.startedAt * 1000).toISOString();
    }
    slot.title = assistant && clock ? `شروع ${clock}` : "";
  }
}

function recordTurnTiming(turnId, patch) {
  if (!turnId) return;
  const current = state.turnTimings.get(turnId) || {};
  state.turnTimings.set(turnId, { ...current, ...patch });
  applyTurnTiming(turnId);
}

function threadDisplayTitle(thread) {
  const name = thread.name?.trim();
  if (name) return name;
  const preview = thread.preview?.trim();
  if (preview) return preview.replace(/\s+/g, " ").slice(0, 70);
  return "گفتگوی بدون عنوان";
}

function projectById(projectId) {
  return state.projects.find((project) => project.id === projectId) || null;
}

function normalizeCwd(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const withoutTrailing = text.replace(/[\\/]+$/, "");
  return withoutTrailing || text;
}

// Threads are only linked to a project when the user assigns one explicitly, so
// fall back to matching the thread's cwd against project folders. An exact match
// wins over a parent folder, and a deeper parent wins over a shallower one.
function resolveThreadProject(thread) {
  if (!thread) return null;
  const explicit = state.threadProjects.get(thread.id);
  if (explicit && projectById(explicit)) return explicit;
  const cwd = normalizeCwd(thread.cwd);
  if (!cwd) return null;
  let bestId = null;
  let bestLength = -1;
  for (const project of state.projects) {
    const base = normalizeCwd(project.cwd);
    if (!base) continue;
    if (cwd !== base && !cwd.startsWith(`${base}/`) && !cwd.startsWith(`${base}\\`)) {
      continue;
    }
    if (base.length > bestLength) {
      bestId = project.id;
      bestLength = base.length;
    }
  }
  return bestId;
}

// Conversation timestamps are seconds, so keep this in the same unit.
function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

function rememberThreadOpened(threadId) {
  if (!threadId) return;
  state.lastOpenedAt[threadId] = nowInSeconds();
  const entries = Object.entries(state.lastOpenedAt).sort(
    (left, right) => right[1] - left[1],
  );
  if (entries.length > LAST_OPENED_LIMIT) {
    state.lastOpenedAt = Object.fromEntries(entries.slice(0, LAST_OPENED_LIMIT));
  }
  try {
    localStorage.setItem(LAST_OPENED_KEY, JSON.stringify(state.lastOpenedAt));
  } catch {
    // Recency still works for this tab when storage is unavailable.
  }
}

// Reading a conversation never bumps its updatedAt, so recency has to combine
// what the agent did with what the user last looked at.
function lastActiveAt(thread) {
  return Math.max(thread.updatedAt || 0, state.lastOpenedAt[thread.id] || 0);
}

function threadsForProject(projectId) {
  if (!projectId) return state.threads;
  return state.threads.filter((thread) => resolveThreadProject(thread) === projectId);
}

function projectIdFor(key = draftKey()) {
  if (state.currentThreadId && key === state.currentThreadId) {
    return state.threadProjects.get(state.currentThreadId) || null;
  }
  return state.draftProjects.get(key) || null;
}

function currentProject() {
  return projectById(projectIdFor());
}

function projectInstructions(project, { includeResponseStyle = true } = {}) {
  return [
    includeResponseStyle ? RESPONSE_STYLE_INSTRUCTIONS : "",
    project?.instructions
      ? `Project instructions:\n${project.instructions}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function persistActiveProject() {
  try {
    if (state.activeProjectId) {
      localStorage.setItem(ACTIVE_PROJECT_KEY, state.activeProjectId);
    } else {
      localStorage.removeItem(ACTIVE_PROJECT_KEY);
    }
  } catch {
    // The project filter remains usable for this tab when storage is unavailable.
  }
}

function updateShareAvailability() {
  elements.shareChat.disabled = !state.currentThreadId;
}

// The chip names the project this conversation runs in. When the project was
// only inferred from the folder it says so, because project instructions are
// not applied until the assignment is made explicit.
function updateProjectChip() {
  const assigned = currentProject();
  const thread = state.currentThreadId ? threadById(state.currentThreadId) : null;
  const inferred = assigned ? null : projectById(resolveThreadProject(thread));
  const project = assigned || inferred;
  const cwd = composerCwd();

  elements.projectChipLabel.textContent = project ? project.name : shortPath(cwd, 38);
  elements.projectChipHint.classList.toggle("hidden", !inferred);
  elements.projectChip.classList.toggle("inferred", Boolean(inferred));
  elements.projectChip.classList.toggle("assigned", Boolean(assigned));
  elements.projectChip.title = project
    ? `${project.name} — ${project.cwd}`
    : cwd;

  updateShareAvailability();
}

// One popover component, two jobs: filtering the sidebar list, and setting the
// project a conversation runs in.
const projectMenus = [
  {
    mode: "filter",
    trigger: elements.projectSwitcher,
    menu: elements.projectSwitcherMenu,
    filter: elements.projectSwitcherFilter,
    list: elements.projectList,
    empty: elements.projectSwitcherEmpty,
    showCwd: false,
  },
  {
    mode: "assign",
    trigger: elements.projectChip,
    menu: elements.projectChipMenu,
    filter: elements.projectChipFilter,
    list: elements.projectChipList,
    empty: elements.projectChipEmpty,
    showCwd: true,
  },
];

function selectedProjectIdFor(mode) {
  return (mode === "assign" ? projectIdFor() : state.activeProjectId) || "";
}

function projectHasActivity(projectId) {
  return state.threads.some((thread) => {
    if (resolveThreadProject(thread) !== projectId) return false;
    const phase = state.threadActivity.get(thread.id)?.phase;
    return phase === "running" || phase === "needs-input";
  });
}

// How many recently used projects sit above the divider.
const PROJECT_MENU_RECENT_COUNT = 3;

function renderProjectMenu(descriptor, counts, lastUsed) {
  descriptor.list.replaceChildren();
  const filter = descriptor.filter.value.trim().toLowerCase();
  const selectedId = selectedProjectIdFor(descriptor.mode);
  const assigning = descriptor.mode === "assign";

  const makeRow = (project) => {
    const row = document.createElement("div");
    row.className = "project-row";
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "option");
    const selected = project.id === selectedId;
    button.setAttribute("aria-selected", String(selected));
    button.className = `project-item ${selected ? "active" : ""}`;
    button.dataset.projectId = project.id;

    const check = document.createElement("span");
    check.className = "project-item-check";
    check.textContent = selected ? "✓" : "";
    check.setAttribute("aria-hidden", "true");

    const copy = document.createElement("span");
    copy.className = "project-item-copy";
    const name = document.createElement("span");
    name.className = "project-item-name";
    name.dir = "auto";
    name.textContent = project.name;
    copy.append(name);
    // Picking where a conversation runs needs the folder; filtering does not.
    // Every folder here shares a long prefix, so only the tail carries signal.
    if (descriptor.showCwd && project.cwd) {
      const cwd = document.createElement("small");
      cwd.className = "project-item-cwd";
      cwd.dir = "ltr";
      cwd.textContent = shortPath(project.cwd, 28);
      copy.append(cwd);
    }
    if (project.cwd) button.title = project.cwd;

    button.append(check, copy);
    if (project.id && projectHasActivity(project.id)) {
      const dot = document.createElement("span");
      dot.className = "project-item-activity";
      dot.title = "این پروژه گفتگوی فعال دارد";
      dot.setAttribute("aria-label", "گفتگوی فعال");
      button.append(dot);
    }
    // The conversation count answers "what am I browsing", not "where should
    // this run", so it only belongs in the sidebar filter.
    if (!assigning) {
      const count = document.createElement("span");
      count.className = "project-item-count";
      count.textContent = project.count.toLocaleString("fa-IR");
      button.append(count);
    }
    row.append(button);

    if (project.id) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "project-item-edit";
      edit.dataset.projectEdit = project.id;
      edit.setAttribute("aria-label", `ویرایش پروژهٔ ${project.name}`);
      edit.title = "ویرایش پروژه";
      edit.textContent = "⋯";
      row.append(edit);
    }
    return row;
  };

  const fallbackRow = {
    id: "",
    name: assigning ? "بدون پروژه" : "همهٔ گفتگوها",
    cwd: "",
    count: state.threads.length,
  };
  // Most recently worked in first — with many projects that is almost always
  // the one being reached for.
  const projects = state.projects
    .map((project) => ({ ...project, count: counts.get(project.id) || 0 }))
    .sort((left, right) => (lastUsed.get(right.id) || 0) - (lastUsed.get(left.id) || 0));

  const rows = (assigning ? [...projects, fallbackRow] : [fallbackRow, ...projects]).filter(
    (project) =>
      !filter ||
      !project.id ||
      `${project.name} ${project.cwd || ""}`.toLowerCase().includes(filter),
  );

  const dividerAfter =
    !filter && assigning && rows.length > PROJECT_MENU_RECENT_COUNT + 1
      ? PROJECT_MENU_RECENT_COUNT
      : -1;
  rows.forEach((project, index) => {
    descriptor.list.append(makeRow(project));
    if (index === dividerAfter - 1) {
      const divider = document.createElement("div");
      divider.className = "project-menu-divider";
      divider.setAttribute("aria-hidden", "true");
      descriptor.list.append(divider);
    }
  });
  descriptor.empty.classList.toggle("hidden", rows.length > 0);
  highlightProjectRow(descriptor, 0);
}

function renderProjects() {
  const counts = new Map();
  const lastUsed = new Map();
  for (const thread of state.threads) {
    const projectId = resolveThreadProject(thread);
    if (!projectId) continue;
    counts.set(projectId, (counts.get(projectId) || 0) + 1);
    const at = thread.updatedAt || thread.createdAt || 0;
    if (at > (lastUsed.get(projectId) || 0)) lastUsed.set(projectId, at);
  }
  for (const descriptor of projectMenus) {
    renderProjectMenu(descriptor, counts, lastUsed);
  }

  const active = projectById(state.activeProjectId);
  elements.projectSwitcherName.textContent = active ? active.name : "همهٔ گفتگوها";
  elements.projectSwitcherCount.textContent = (
    active ? counts.get(active.id) || 0 : state.threads.length
  ).toLocaleString("fa-IR");
  elements.projectSwitcher.title = active?.cwd || "فیلتر بر اساس پروژه";
  updateProjectChip();
}

const runChipMenu = {
  mode: "run",
  trigger: elements.modelChip,
  menu: elements.runChipMenu,
};

function allChipMenus() {
  return [...projectMenus, runChipMenu];
}

function projectRowsIn(descriptor) {
  return [...descriptor.list.querySelectorAll("[data-project-id]")];
}

function highlightProjectRow(descriptor, index) {
  const rows = projectRowsIn(descriptor);
  if (!rows.length) {
    descriptor.activeIndex = 0;
    return;
  }
  const next = Math.max(0, Math.min(index, rows.length - 1));
  descriptor.activeIndex = next;
  rows.forEach((row, position) => {
    row.classList.toggle("highlighted", position === next);
  });
  rows[next].scrollIntoView?.({ block: "nearest" });
}

function moveProjectHighlight(descriptor, delta) {
  const rows = projectRowsIn(descriptor);
  if (!rows.length) return;
  const current = descriptor.activeIndex || 0;
  // Wrap, so holding one arrow key always reaches every row.
  const next = (current + delta + rows.length) % rows.length;
  highlightProjectRow(descriptor, next);
}

function activateHighlightedProject(descriptor) {
  const rows = projectRowsIn(descriptor);
  const row = rows[descriptor.activeIndex || 0];
  if (row) row.click();
}

function menuIsOpen(descriptor) {
  return !descriptor.menu.classList.contains("hidden");
}

function openProjectMenu(descriptor) {
  for (const other of allChipMenus()) {
    if (other !== descriptor) closeProjectMenu(other);
  }
  descriptor.menu.classList.remove("hidden");
  descriptor.trigger.setAttribute("aria-expanded", "true");
  if (descriptor.mode === "run") renderRunChipMenu();
  else renderProjects();
  if (descriptor.filter) setTimeout(() => descriptor.filter.focus(), 0);
}

function closeProjectMenu(descriptor, { focusTrigger = false } = {}) {
  if (!menuIsOpen(descriptor)) return;
  descriptor.menu.classList.add("hidden");
  descriptor.trigger.setAttribute("aria-expanded", "false");
  if (descriptor.filter) {
    descriptor.filter.value = "";
    renderProjects();
  }
  if (focusTrigger) descriptor.trigger.focus();
}

function closeProjectMenus() {
  for (const descriptor of allChipMenus()) closeProjectMenu(descriptor);
}

function toggleProjectMenu(descriptor) {
  if (menuIsOpen(descriptor)) closeProjectMenu(descriptor, { focusTrigger: true });
  else openProjectMenu(descriptor);
}

async function loadProjects() {
  let result;
  try {
    result = await api("/api/projects", { headers: {} });
  } catch (error) {
    if (error.status && error.status !== 404) {
      console.warn("Project metadata is unavailable", error);
    }
    state.projects = [];
    state.threadProjects = new Map();
    state.activeProjectId = null;
    renderProjects();
    return;
  }
  state.projects = Array.isArray(result.projects) ? result.projects : [];
  state.threadProjects = new Map(Object.entries(result.threadProjects || {}));
  if (state.activeProjectId && !projectById(state.activeProjectId)) {
    state.activeProjectId = null;
    persistActiveProject();
  }
  renderProjects();
  renderThreadList();
  updateSettingsUi();
}

function openProjectDialog(project = null) {
  elements.projectId.value = project?.id || "";
  elements.projectName.value = project?.name || "";
  elements.projectCwd.value = project?.cwd || currentProject()?.cwd || state.settings.cwd;
  elements.projectInstructions.value = project?.instructions || "";
  elements.projectDialogTitle.textContent = project ? "ویرایش پروژه" : "پروژهٔ تازه";
  elements.projectDelete.classList.toggle("hidden", !project);
  elements.projectDialog.showModal();
  setTimeout(() => elements.projectName.focus(), 0);
}

async function saveProject(event) {
  event.preventDefault();
  const projectId = elements.projectId.value;
  const body = {
    name: elements.projectName.value.trim(),
    cwd: elements.projectCwd.value.trim(),
    instructions: elements.projectInstructions.value.trim(),
  };
  if (!body.name || !body.cwd) return;
  elements.projectSave.disabled = true;
  try {
    const result = await api(projectId ? `/api/projects/${projectId}` : "/api/projects", {
      method: projectId ? "PATCH" : "POST",
      body: JSON.stringify(body),
    });
    elements.projectDialog.close();
    await loadProjects();
    if (!projectId) {
      selectProject(result.project.id);
      state.lastProjectId = result.project.id;
      persistLastProject(result.project.id);
      newChat({ projectId: result.project.id });
    } else {
      updateProjectChip();
    }
  } catch (error) {
    showError(error, projectId ? "ویرایش پروژه" : "ساخت پروژه");
  } finally {
    elements.projectSave.disabled = false;
  }
}

async function deleteProject() {
  const projectId = elements.projectId.value;
  const project = projectById(projectId);
  if (!project || !window.confirm(`پروژهٔ «${project.name}» حذف شود؟ گفتگوها حذف نمی‌شوند.`)) {
    return;
  }
  elements.projectDelete.disabled = true;
  try {
    await api(`/api/projects/${projectId}`, { method: "DELETE" });
    elements.projectDialog.close();
    if (state.activeProjectId === projectId) {
      state.activeProjectId = null;
      persistActiveProject();
    }
    if (state.lastProjectId === projectId) {
      state.lastProjectId = null;
      persistLastProject(null);
    }
    await loadProjects();
    updateProjectChip();
  } catch (error) {
    showError(error, "حذف پروژه");
  } finally {
    elements.projectDelete.disabled = false;
  }
}

function selectProject(projectId) {
  const nextProjectId = projectId && projectById(projectId) ? projectId : null;
  state.activeProjectId = nextProjectId;
  state.threadListLimit = THREAD_LIST_PAGE_SIZE;
  persistActiveProject();
  closeProjectMenus();
  renderProjects();
  renderThreadList();
}

async function assignChatProject(projectId) {
  const nextId = projectId && projectById(projectId) ? projectId : null;
  try {
    if (state.currentThreadId) {
      await api("/api/project-threads", {
        method: "POST",
        body: JSON.stringify({ threadId: state.currentThreadId, projectId: nextId }),
      });
      if (nextId) state.threadProjects.set(state.currentThreadId, nextId);
      else state.threadProjects.delete(state.currentThreadId);
    } else {
      const key = draftKey();
      if (nextId) state.draftProjects.set(key, nextId);
      else state.draftProjects.delete(key);
    }
    state.lastProjectId = nextId;
    persistLastProject(nextId);
    renderProjects();
    renderThreadList();
    // The chip label and the welcome copy both derive from the project, and
    // each is only refreshed by one of these.
    updateSettingsUi();
    updateConnection();
  } catch (error) {
    showError(error, "تغییر پروژهٔ گفتگو");
  }
}

function showShare(share) {
  const link = new URL(`/share/${share.id}`, window.location.href).href;
  elements.shareDialog.dataset.shareId = share.id;
  elements.shareLink.value = link;
  elements.shareRevoke.classList.remove("hidden");
  if (!elements.shareDialog.open) elements.shareDialog.showModal();
}

async function refreshShare({ open = true } = {}) {
  if (!state.currentThreadId) return;
  elements.shareChat.disabled = true;
  elements.shareRefresh.disabled = true;
  try {
    let share = null;
    if (open) {
      const existing = await api(
        `/api/shares?threadId=${encodeURIComponent(state.currentThreadId)}`,
        { headers: {} },
      );
      share = existing.share;
    }
    if (!share) {
      const result = await api("/api/shares", {
        method: "POST",
        body: JSON.stringify({ threadId: state.currentThreadId }),
      });
      share = result.share;
    }
    showShare(share);
    if (!open) toast("نسخهٔ اشتراکی به‌روز شد.", "success");
  } catch (error) {
    showError(error, "اشتراک گفتگو");
  } finally {
    elements.shareChat.disabled = !state.currentThreadId;
    elements.shareRefresh.disabled = false;
  }
}

async function copyShareLink() {
  const link = elements.shareLink.value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    const previous = elements.shareCopy.textContent;
    elements.shareCopy.textContent = "کپی شد";
    setTimeout(() => (elements.shareCopy.textContent = previous), 1200);
  } catch {
    elements.shareLink.select();
    toast("لینک را از فیلد بالا کپی کنید.", "warning");
  }
}

async function revokeShare() {
  const shareId = elements.shareDialog.dataset.shareId;
  if (!shareId || !window.confirm("این لینک اشتراک غیرفعال شود؟")) return;
  elements.shareRevoke.disabled = true;
  try {
    await api(`/api/shares/${shareId}`, { method: "DELETE" });
    elements.shareDialog.close();
    elements.shareDialog.dataset.shareId = "";
    elements.shareLink.value = "";
    toast("لینک اشتراک لغو شد.", "success");
  } catch (error) {
    showError(error, "لغو لینک اشتراک");
  } finally {
    elements.shareRevoke.disabled = false;
  }
}

function threadById(threadId) {
  return state.threads.find((thread) => thread.id === threadId) || null;
}

function threadTitleById(threadId) {
  const thread = threadById(threadId);
  return thread ? threadDisplayTitle(thread) : "گفتگو";
}

function ensureThreadActivity(threadId) {
  if (!state.threadActivity.has(threadId)) {
    state.threadActivity.set(threadId, {
      phase: "idle",
      terminalPhase: null,
      turnId: null,
      unread: false,
    });
  }
  return state.threadActivity.get(threadId);
}

function phaseFromThreadStatus(status) {
  if (status?.type !== "active") return "idle";
  const flags = status.activeFlags || [];
  return flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput")
    ? "needs-input"
    : "running";
}

function syncThreadActivity(thread) {
  const activity = ensureThreadActivity(thread.id);
  if (hasPendingInteractionForThread(thread.id)) {
    activity.phase = "needs-input";
    return;
  }
  const phase = phaseFromThreadStatus(thread.status);
  if (phase !== "idle") {
    activity.phase = phase;
  } else if (activity.unread) {
    activity.phase = activity.terminalPhase || "completed";
  } else if (!activity.unread) {
    activity.phase = "idle";
    activity.terminalPhase = null;
    activity.turnId = null;
  }
}

function updateAttentionUi() {
  const count = [...state.threadActivity.values()].filter(
    (activity) => activity.unread || activity.phase === "needs-input",
  ).length;
  document.title = count ? `(${count}) ${BASE_DOCUMENT_TITLE}` : BASE_DOCUMENT_TITLE;
}

function updateThreadActivity(threadId, patch) {
  if (!threadId) return;
  Object.assign(ensureThreadActivity(threadId), patch);
  renderThreadList();
  updateAttentionUi();
}

function markThreadSeen(threadId) {
  if (!threadId) return;
  const activity = ensureThreadActivity(threadId);
  activity.unread = false;
  if (["completed", "failed", "interrupted"].includes(activity.phase)) {
    activity.phase = "idle";
    activity.terminalPhase = null;
    activity.turnId = null;
  }
  updateAttentionUi();
}

function threadActivityPresentation(threadId) {
  const activity = state.threadActivity.get(threadId);
  if (!activity) return null;
  if (activity.phase === "needs-input") {
    return { className: "needs-input", label: "پاسخ لازم" };
  }
  if (activity.phase === "running") {
    return { className: "running", label: "در حال کار" };
  }
  if (!activity.unread) return null;
  if (activity.phase === "failed") {
    return { className: "failed", label: "خطا" };
  }
  if (activity.phase === "interrupted") {
    return { className: "interrupted", label: "متوقف شد" };
  }
  return { className: "completed", label: "تمام شد" };
}

let completionAudioContext = null;
let completionAudioUnavailable = false;
let completionAudioPrimed = false;
const COMPLETION_AUDIO_HISTORY_KEY = "codex-web-completion-audio-history";

function primeCompletionAudio(event) {
  if (event) completionAudioPrimed = true;
  if (completionAudioUnavailable) return null;
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    completionAudioUnavailable = true;
    return null;
  }
  try {
    completionAudioContext ||= new AudioContextConstructor();
    if (completionAudioContext.state === "suspended") {
      completionAudioContext.resume().catch(() => {});
    }
    return completionAudioContext;
  } catch (error) {
    completionAudioUnavailable = true;
    console.warn("Could not initialize completion audio", error);
    return null;
  }
}

async function playCompletionSound(status) {
  const context = completionAudioContext;
  if (!completionAudioPrimed || !context) return;
  try {
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") return;

    const notes =
      status === "failed"
        ? [
            [330, 0, 0.18],
            [220, 0.13, 0.24],
          ]
        : status === "interrupted" || status === "cancelled"
          ? [
              [440, 0, 0.16],
              [349.23, 0.12, 0.2],
            ]
          : [
              [659.25, 0, 0.15],
              [880, 0.11, 0.22],
            ];
    const start = context.currentTime + 0.015;
    for (const [frequency, offset, duration] of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const noteStart = start + offset;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(0.065, noteStart + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + duration + 0.02);
      oscillator.addEventListener(
        "ended",
        () => {
          oscillator.disconnect();
          gain.disconnect();
        },
        { once: true },
      );
    }
  } catch (error) {
    console.warn("Could not play completion audio", error);
  }
}

function claimCompletionAudio(turnKey) {
  const now = Date.now();
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  let history = [];
  try {
    const saved = JSON.parse(localStorage.getItem(COMPLETION_AUDIO_HISTORY_KEY) || "[]");
    if (Array.isArray(saved)) {
      history = saved.filter(
        (entry) =>
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          Number.isFinite(entry[1]) &&
          entry[1] >= cutoff,
      );
    }
    if (history.some(([key]) => key === turnKey)) return false;
    history.unshift([turnKey, now]);
    localStorage.setItem(
      COMPLETION_AUDIO_HISTORY_KEY,
      JSON.stringify(history.slice(0, 200)),
    );
  } catch (error) {
    console.warn("Could not coordinate completion audio between tabs", error);
  }
  return true;
}

async function playCompletionSoundOnce(turnKey, status) {
  if (!completionAudioPrimed || !completionAudioContext) return;
  const claimAndPlay = async () => {
    if (!claimCompletionAudio(turnKey)) return;
    await playCompletionSound(status);
  };
  if (navigator.locks?.request) {
    try {
      await navigator.locks.request(
        `codex-web-completion-audio:${turnKey}`,
        claimAndPlay,
      );
      return;
    } catch (error) {
      console.warn("Could not acquire the completion audio lock", error);
    }
  }
  await claimAndPlay();
}

function announceThreadCompletion(threadId, status) {
  const title = threadTitleById(threadId);
  const detail =
    status === "failed"
      ? `کار «${title}» با خطا تمام شد — نمایش`
      : status === "interrupted"
        ? `کار «${title}» متوقف شد — نمایش`
        : `کار «${title}» تمام شد — نمایش`;
  const kind =
    status === "failed" ? "error" : status === "interrupted" ? "warning" : "success";
  toast(detail, kind, {
    duration: 8000,
    onClick: () => openThread(threadId),
  });

  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    const notification = new Notification(BASE_DOCUMENT_TITLE, {
      body: detail.replace(" — نمایش", ""),
      tag: `codex-web-${threadId}`,
    });
    notification.onclick = () => {
      window.focus();
      openThread(threadId);
      notification.close();
    };
  }
}

// The row is two lines on purpose. Sharing one line, the title competed with a
// provider badge, an activity pill and a timestamp and was left ~80px — about
// ten Persian characters. Giving it a line of its own restores ~254px.
function buildThreadItem(thread, { showProject = false } = {}) {
  const button = document.createElement("button");
  button.className = `thread-item ${thread.id === state.currentThreadId ? "active" : ""}`;
  button.dataset.threadId = thread.id;

  const title = document.createElement("span");
  title.className = "thread-item-title";
  title.dir = "auto";
  title.textContent = threadDisplayTitle(thread);

  const heading = document.createElement("span");
  heading.className = "thread-item-heading";
  heading.append(title);

  // Needing an answer is the one thing worth stealing title width for.
  const presentation = threadActivityPresentation(thread.id);
  if (presentation) {
    const activity = document.createElement("span");
    activity.className = `thread-activity ${presentation.className}`;
    activity.textContent = presentation.label;
    activity.setAttribute("aria-label", presentation.label);
    heading.append(activity);
  }
  button.append(heading);

  const meta = document.createElement("span");
  meta.className = "thread-item-meta";
  const origin = document.createElement("span");
  origin.className = "thread-item-origin";

  if (showProject) {
    const project = projectById(resolveThreadProject(thread));
    const label = document.createElement("span");
    label.className = "thread-item-project";
    label.dir = "auto";
    label.textContent = project ? project.name : shortPath(thread.cwd, 23);
    label.title = thread.cwd || "";
    origin.append(label);
    const separator = document.createElement("span");
    separator.className = "thread-item-separator";
    separator.setAttribute("aria-hidden", "true");
    separator.textContent = "·";
    origin.append(separator);
  }

  const provider = document.createElement("span");
  provider.className = "thread-provider";
  provider.dir = "ltr";
  provider.textContent = thread.provider === "claude" ? "Claude" : "Codex";
  provider.title = thread.provider === "claude" ? "Claude Code CLI" : "Codex CLI";
  origin.append(provider);

  const time = document.createElement("span");
  time.className = "thread-item-time";
  time.textContent = formatRelativeTime(thread.updatedAt || thread.createdAt);
  meta.append(origin, time);
  button.append(meta);
  return button;
}

function threadIsBusy(threadId) {
  const phase = state.threadActivity.get(threadId)?.phase;
  return phase === "running" || phase === "needs-input";
}

// A small board above the list for conversations the list itself cannot show:
// anything working or waiting, plus the last few opened in another project so
// that stepping away from a chat and back does not mean hunting for it.
function pinnedThreads() {
  const recentElsewhere = new Set(
    [...state.threads]
      .filter(
        (thread) =>
          state.activeProjectId &&
          resolveThreadProject(thread) !== state.activeProjectId,
      )
      .sort((left, right) => lastActiveAt(right) - lastActiveAt(left))
      .slice(0, PINNED_RECENT_COUNT)
      .map((thread) => thread.id),
  );
  return state.threads
    .filter((thread) => threadIsBusy(thread.id) || recentElsewhere.has(thread.id))
    .sort((left, right) => {
      const byBusy = Number(threadIsBusy(right.id)) - Number(threadIsBusy(left.id));
      return byBusy || lastActiveAt(right) - lastActiveAt(left);
    })
    .slice(0, PINNED_LIMIT);
}

function renderThreadList() {
  elements.threadList.replaceChildren();
  const searching = Boolean(elements.threadSearch.value.trim());
  // Search always spans every project; browsing is scoped to the selected one.
  const scoped = searching ? state.threads : threadsForProject(state.activeProjectId);
  const pinned = searching ? [] : pinnedThreads();
  const pinnedIds = new Set(pinned.map((thread) => thread.id));
  // A pinned conversation moves to the board instead of appearing twice.
  const threads = scoped.filter((thread) => !pinnedIds.has(thread.id));

  if (pinned.length) {
    const section = document.createElement("div");
    section.className = "thread-pinned";
    const heading = document.createElement("div");
    heading.className = "thread-pinned-heading";
    heading.textContent = "فعال و اخیر";
    section.append(heading);
    for (const thread of pinned) {
      section.append(buildThreadItem(thread, { showProject: true }));
    }
    elements.threadList.append(section);
  }

  if (!threads.length) {
    if (!pinned.length) {
      const empty = document.createElement("div");
      empty.className = "thread-empty";
      empty.textContent = searching
        ? "گفتگویی با این جستجو پیدا نشد."
        : state.activeProjectId
          ? "هنوز گفتگویی در این پروژه نیست."
          : "هنوز گفتگویی پیدا نشد.";
      elements.threadList.append(empty);
    }
    return;
  }

  for (const thread of threads) {
    elements.threadList.append(
      buildThreadItem(thread, {
        showProject: searching || !state.activeProjectId,
      }),
    );
  }

  if (state.threadListHasMore && !searching) {
    const more = document.createElement("button");
    more.className = "thread-load-more";
    more.id = "thread-load-more";
    more.type = "button";
    more.textContent = "موارد قدیمی‌تر";
    elements.threadList.append(more);
  }
}

async function refreshThreads(searchTerm = elements.threadSearch.value.trim()) {
  const refreshVersion = ++state.threadsRefreshVersion;
  const limit = state.threadListLimit;
  try {
    const result = await rpc("thread/list", {
      archived: false,
      limit,
      searchTerm: searchTerm || null,
      sortDirection: "desc",
      sortKey: "updated_at",
    });
    if (refreshVersion !== state.threadsRefreshVersion) return;
    state.threads = result.data || [];
    // Neither provider returns a cursor, so a full page means there may be more.
    state.threadListHasMore = state.threads.length >= limit;
    for (const thread of state.threads) syncThreadActivity(thread);
    renderProjects();
    renderThreadList();
    updateAttentionUi();
  } catch (error) {
    if (refreshVersion !== state.threadsRefreshVersion) return;
    showError(error, "دریافت فهرست گفتگوها");
  }
}

async function loadMoreThreads() {
  state.threadListLimit += THREAD_LIST_PAGE_SIZE;
  await refreshThreads();
}

function clearConversation() {
  state.turnTimings.clear();
  closeSlashCommandMenu();
  resetScrollFollowing();
  if (state.userMessageNavigationFrame !== null) {
    cancelAnimationFrame(state.userMessageNavigationFrame);
    state.userMessageNavigationFrame = null;
  }
  clearTimeout(state.userMessageHighlightTimer);
  state.userNavigationItemId = null;
  elements.previousUserMessage.disabled = true;
  elements.nextUserMessage.disabled = true;
  elements.userMessageNavigationStatus.textContent = "";
  state.itemViews.clear();
  state.turnProcessViews.clear();
  elements.messages.replaceChildren();
}

function draftKey(threadId = state.currentThreadId) {
  return threadId || `${NEW_THREAD_DRAFT_PREFIX}:${state.newDraftId}`;
}

function composerModeFor(key = draftKey()) {
  return state.composerModes.get(key) || "default";
}

function goalFor(key = draftKey()) {
  return state.pendingGoals.get(key) || state.goals.get(key) || null;
}

function closeComposerToolsMenu() {
  elements.composerToolsMenu.classList.add("hidden");
  elements.composerTools.setAttribute("aria-expanded", "false");
}

function updateComposerModeUi() {
  const provider = effectiveProvider();
  const planSupported = providerSupportsPlanMode(provider);
  const goalSupported = providerSupportsGoalMode(provider);
  const planSaving = state.planModeSavingKeys.has(draftKey());
  const plan = planSupported && composerModeFor() === "plan";
  const goal = goalSupported ? goalFor() : null;
  elements.planModeOption.disabled = !planSupported || planSaving;
  elements.goalModeOption.disabled = !goalSupported;
  elements.planModeOption.setAttribute("aria-checked", String(plan));
  elements.composerToolsNote.classList.toggle(
    "hidden",
    planSupported && goalSupported,
  );
  elements.composerTools.classList.toggle("active-mode", Boolean(plan || goal));
  const toolLabel = !planSupported && !goalSupported
    ? `Plan و Goal برای ${providerLabel(provider)} در دسترس نیستند`
    : plan
      ? "ابزارهای گفتگو؛ Plan mode روشن است"
      : goal
        ? "ابزارهای گفتگو؛ Goal فعال است"
        : "ابزارهای گفتگو";
  elements.composerTools.setAttribute("aria-label", toolLabel);
  elements.composerTools.title = toolLabel;
}

function toggleComposerToolsMenu() {
  const opening = elements.composerToolsMenu.classList.contains("hidden");
  closeSlashCommandMenu();
  elements.composerToolsMenu.classList.toggle("hidden", !opening);
  elements.composerTools.setAttribute("aria-expanded", String(opening));
}

async function togglePlanMode() {
  const provider = effectiveProvider();
  if (!providerSupportsPlanMode(provider)) {
    toast(`Plan mode برای ${providerLabel(provider)} در دسترس نیست.`, "warning");
    return false;
  }
  const key = draftKey();
  if (state.planModeSavingKeys.has(key)) return false;
  const plan = composerModeFor(key) !== "plan";
  const collaborationMode = plan && provider === "codex"
    ? planCollaborationMode()
    : provider === "codex"
      ? defaultCollaborationMode()
      : null;
  if (plan && provider === "codex" && !collaborationMode) {
    toast("برای Plan mode ابتدا یک مدل Codex انتخاب یا بارگذاری کنید.", "warning");
    return false;
  }
  if (plan) state.composerModes.set(key, "plan");
  else state.composerModes.delete(key);
  updateComposerModeUi();
  closeComposerToolsMenu();
  if (state.currentThreadId && provider === "codex") {
    state.planModeSavingKeys.add(key);
    updateComposerModeUi();
    try {
      await rpc("thread/settings/update", {
        threadId: state.currentThreadId,
        collaborationMode,
      });
    } catch (error) {
      if (plan) state.composerModes.delete(key);
      else state.composerModes.set(key, "plan");
      showError(error, plan ? "روشن‌کردن Plan mode" : "خاموش‌کردن Plan mode");
      return false;
    } finally {
      state.planModeSavingKeys.delete(key);
      updateComposerModeUi();
    }
  }
  toast(plan ? "Plan mode روشن شد." : "Plan mode خاموش شد.", "success");
  return plan;
}

function effectivePlanModel() {
  const selected = state.settings.modelByProvider.codex || "";
  if (selected) return selected;
  const runtime = state.currentThreadId
    ? state.threadRuntime.get(state.currentThreadId) || {}
    : {};
  if (runtime.model) return runtime.model;
  if (state.currentThread?.model) return state.currentThread.model;
  const models = state.modelsByProvider.codex || [];
  const fallback = models.find((model) => model.isDefault) || models[0];
  return fallback?.model || fallback?.id || "";
}

function planCollaborationMode() {
  const template =
    state.collaborationModes.find((mode) => mode.mode === "plan") || {};
  const model = effectivePlanModel() || template.model || "";
  if (!model) return null;
  return {
    mode: "plan",
    settings: {
      developer_instructions: null,
      model,
      reasoning_effort:
        template.reasoning_effort || state.settings.effort || "medium",
    },
  };
}

function defaultCollaborationMode() {
  const template =
    state.collaborationModes.find((mode) => mode.mode === "default") || {};
  const model = effectivePlanModel() || template.model || "";
  if (!model) return null;
  return {
    mode: "default",
    settings: {
      developer_instructions: null,
      model,
      reasoning_effort: template.reasoning_effort || state.settings.effort || null,
    },
  };
}

async function loadCollaborationModes() {
  try {
    const result = await rpc("collaborationMode/list", {});
    state.collaborationModes = Array.isArray(result?.data) ? result.data : [];
  } catch {}
}

const GOAL_STATUS_LABELS = {
  active: "فعال",
  paused: "مکث",
  blocked: "متوقف",
  usageLimited: "محدودیت مصرف",
  budgetLimited: "پایان بودجه",
  complete: "کامل",
};

function formatGoalUsage(goal) {
  const parts = [];
  if (Number.isFinite(goal?.tokensUsed) && goal.tokensUsed > 0) {
    const tokens = goal.tokensUsed.toLocaleString("fa-IR");
    parts.push(
      Number.isFinite(goal.tokenBudget) && goal.tokenBudget > 0
        ? `${tokens} از ${goal.tokenBudget.toLocaleString("fa-IR")} توکن`
        : `${tokens} توکن`,
    );
  }
  if (Number.isFinite(goal?.timeUsedSeconds) && goal.timeUsedSeconds > 0) {
    const minutes = Math.max(1, Math.round(goal.timeUsedSeconds / 60));
    parts.push(`${minutes.toLocaleString("fa-IR")} دقیقه`);
  }
  return parts.join(" · ");
}

function renderGoalProgress() {
  const goal = providerSupportsGoalMode() ? goalFor() : null;
  elements.goalProgress.classList.toggle("hidden", !goal);
  if (!goal) {
    elements.goalProgress.removeAttribute("data-status");
    elements.goalObjective.textContent = "";
    elements.goalUsage.classList.add("hidden");
    updateComposerModeUi();
    return;
  }

  const status = goal.status || "active";
  elements.goalProgress.dataset.status = status;
  elements.goalObjective.textContent = goal.objective || "";
  elements.goalObjective.title = goal.objective || "";
  elements.goalStatus.textContent = goal.pending
    ? "با اولین ارسال فعال می‌شود"
    : GOAL_STATUS_LABELS[status] || status;
  const usage = formatGoalUsage(goal);
  elements.goalUsage.textContent = usage;
  elements.goalUsage.classList.toggle("hidden", !usage);

  const paused = status !== "active";
  elements.goalToggle.disabled = Boolean(goal.pending || status === "complete" || state.goalSaving);
  elements.goalEdit.disabled = state.goalSaving;
  elements.goalClear.disabled = state.goalSaving;
  elements.goalToggle.setAttribute(
    "aria-label",
    paused ? "ادامهٔ هدف" : "مکث هدف",
  );
  elements.goalToggle.title = paused ? "ادامهٔ هدف" : "مکث هدف";
  elements.goalToggle.innerHTML = paused
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 8 5-8 5z" /></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7v10m6-10v10" /></svg>';
  updateComposerModeUi();
}

async function loadGoal(threadId) {
  if (!threadId || !providerSupportsGoalMode(providerForThread(threadId))) return null;
  if (state.goalLoadingThreads.has(threadId)) return null;
  state.goalLoadingThreads.add(threadId);
  try {
    const result = await rpc("thread/goal/get", { threadId });
    if (result?.goal) state.goals.set(threadId, result.goal);
    else state.goals.delete(threadId);
    if (state.currentThreadId === threadId) renderGoalProgress();
    return result?.goal || null;
  } catch {
    return null;
  } finally {
    state.goalLoadingThreads.delete(threadId);
  }
}

function openGoalDialog() {
  closeComposerToolsMenu();
  const provider = effectiveProvider();
  if (!providerSupportsGoalMode(provider)) {
    toast(`Goal mode برای ${providerLabel(provider)} در دسترس نیست.`, "warning");
    return;
  }
  const goal = goalFor();
  elements.goalInput.value = goal?.objective || "";
  elements.goalDialogTitle.textContent = goal ? "ویرایش هدف" : "یک هدف تعیین کن";
  elements.goalSave.textContent = goal ? "ذخیرهٔ هدف" : "شروع Goal";
  elements.goalDialogHelp.textContent = state.currentThreadId
    ? "تغییر هدف از همین گفتگو ادامه پیدا می‌کند."
    : "هدف با اولین ارسال روی گفتگوی تازه فعال می‌شود.";
  elements.goalDialog.showModal();
  elements.goalInput.focus();
}

async function saveGoalFromDialog(event) {
  event.preventDefault();
  if (state.goalSaving) return;
  const objective = elements.goalInput.value.trim();
  if (!objective) {
    elements.goalInput.focus();
    return;
  }
  const key = draftKey();
  if (!state.currentThreadId) {
    const previous = goalFor(key);
    const replaceGeneratedPrompt =
      !elements.prompt.value.trim() ||
      (previous?.pending && elements.prompt.value.trim() === previous.objective);
    state.pendingGoals.set(key, {
      objective,
      pending: true,
      status: "active",
      timeUsedSeconds: 0,
      tokensUsed: 0,
    });
    if (replaceGeneratedPrompt) {
      elements.prompt.value = objective;
      saveCurrentDraft();
      resizePrompt();
    }
    elements.goalDialog.close();
    renderGoalProgress();
    elements.prompt.focus();
    return;
  }

  state.goalSaving = true;
  elements.goalSave.disabled = true;
  renderGoalProgress();
  try {
    const current = goalFor();
    const status = ["active", "paused"].includes(current?.status)
      ? current.status
      : "active";
    const result = await rpc("thread/goal/set", {
      threadId: state.currentThreadId,
      objective,
      status,
    });
    if (result?.goal) state.goals.set(state.currentThreadId, result.goal);
    elements.goalDialog.close();
    toast("هدف گفتگو ذخیره شد.", "success");
  } catch (error) {
    showError(error, "ذخیرهٔ هدف");
  } finally {
    state.goalSaving = false;
    elements.goalSave.disabled = false;
    renderGoalProgress();
  }
}

async function toggleGoalStatus() {
  const threadId = state.currentThreadId;
  const goal = goalFor();
  if (!threadId || !goal || goal.pending || state.goalSaving) return;
  const status = goal.status === "active" ? "paused" : "active";
  state.goalSaving = true;
  renderGoalProgress();
  try {
    const result = await rpc("thread/goal/set", { threadId, status });
    if (result?.goal) state.goals.set(threadId, result.goal);
    toast(status === "paused" ? "Goal موقتاً متوقف شد." : "Goal دوباره فعال شد.", "success");
  } catch (error) {
    showError(error, status === "paused" ? "مکث هدف" : "ادامهٔ هدف");
  } finally {
    state.goalSaving = false;
    renderGoalProgress();
  }
}

async function clearGoal() {
  const key = draftKey();
  if (!state.currentThreadId) {
    state.pendingGoals.delete(key);
    renderGoalProgress();
    return;
  }
  if (!goalFor() || state.goalSaving) return;
  const threadId = state.currentThreadId;
  state.goalSaving = true;
  renderGoalProgress();
  try {
    await rpc("thread/goal/clear", { threadId });
    state.goals.delete(threadId);
    state.pendingGoals.delete(threadId);
    toast("Goal از گفتگو برداشته شد.", "success");
  } catch (error) {
    showError(error, "پاک‌کردن هدف");
  } finally {
    state.goalSaving = false;
    renderGoalProgress();
  }
}

function migrateComposerState(sourceKey, targetKey) {
  if (!sourceKey || sourceKey === targetKey) return;
  if (state.composerModes.has(sourceKey)) {
    state.composerModes.set(targetKey, state.composerModes.get(sourceKey));
    state.composerModes.delete(sourceKey);
  }
  if (state.pendingGoals.has(sourceKey)) {
    state.pendingGoals.set(targetKey, state.pendingGoals.get(sourceKey));
    state.pendingGoals.delete(sourceKey);
  }
}

async function activatePendingGoal(threadId) {
  const pending = state.pendingGoals.get(threadId);
  if (!pending) return null;
  if (!providerSupportsGoalMode(providerForThread(threadId))) {
    state.pendingGoals.delete(threadId);
    return null;
  }
  const result = await rpc("thread/goal/set", {
    threadId,
    objective: pending.objective,
    status: "active",
  });
  if (result?.goal) state.goals.set(threadId, result.goal);
  state.pendingGoals.delete(threadId);
  if (state.currentThreadId === threadId) renderGoalProgress();
  return result?.goal || null;
}

function promptQueueFor(key = draftKey(), create = false) {
  if (!state.promptQueues.has(key) && create) state.promptQueues.set(key, []);
  return state.promptQueues.get(key) || [];
}

function renderPromptQueue() {
  const queue = promptQueueFor();
  elements.promptQueue.classList.toggle("hidden", queue.length === 0);
  elements.promptQueueCount.textContent = queue.length.toLocaleString("fa-IR");
  elements.promptQueueItems.replaceChildren();

  queue.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "prompt-queue-item";
    row.dataset.queueId = item.id;

    const order = document.createElement("span");
    order.className = "prompt-queue-index";
    order.textContent = String(index + 1).padStart(2, "0");

    const preview = document.createElement("bdi");
    preview.className = "prompt-queue-preview";
    preview.textContent = item.text.replace(/\s+/g, " ").trim();
    preview.title = item.text;

    const actions = document.createElement("span");
    actions.className = "prompt-queue-actions";
    actions.innerHTML = `
      <button class="prompt-queue-action" type="button" data-queue-action="edit" aria-label="ویرایش پیام صف" title="ویرایش">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.7 5.3 4 4M4.75 19.25l3.6-.8L19.2 7.6a1.4 1.4 0 0 0 0-2l-.8-.8a1.4 1.4 0 0 0-2 0L5.55 15.65z" /></svg>
      </button>
      <button class="prompt-queue-action" type="button" data-queue-action="remove" aria-label="حذف پیام از صف" title="حذف">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4.75h6V7M8 10v7M12 10v7M16 10v7M6.5 7l.7 12.25h9.6L17.5 7" /></svg>
      </button>`;
    row.append(order, preview, actions);
    elements.promptQueueItems.append(row);
  });
}

function migratePromptQueue(sourceKey, targetKey) {
  if (!sourceKey || sourceKey === targetKey) return;
  const source = promptQueueFor(sourceKey);
  if (!source.length) return;
  const target = promptQueueFor(targetKey);
  state.promptQueues.set(targetKey, [...source, ...target]);
  state.promptQueues.delete(sourceKey);
  if (draftKey() === targetKey) renderPromptQueue();
}

function enqueuePrompt(text, key = draftKey()) {
  const queue = promptQueueFor(key, true);
  const item = { id: crypto.randomUUID(), text };
  queue.push(item);
  if (key === draftKey()) {
    elements.prompt.value = "";
    state.drafts.set(key, "");
    closeSlashCommandMenu();
    resizePrompt();
    renderPromptQueue();
  }
  return item;
}

function removeQueuedPrompt(queueId, { edit = false } = {}) {
  const key = draftKey();
  const queue = promptQueueFor(key);
  const index = queue.findIndex((item) => item.id === queueId);
  if (index < 0) return;
  const [item] = queue.splice(index, 1);
  if (!queue.length) state.promptQueues.delete(key);
  renderPromptQueue();
  if (!edit) return;

  const existing = elements.prompt.value.trim();
  elements.prompt.value = existing ? `${item.text}\n\n${elements.prompt.value}` : item.text;
  elements.prompt.setSelectionRange(elements.prompt.value.length, elements.prompt.value.length);
  saveCurrentDraft();
  resizePrompt();
  elements.prompt.focus();
}

function clearPromptQueue() {
  state.promptQueues.delete(draftKey());
  renderPromptQueue();
}

function scheduleNextQueuedPrompt(threadId = state.currentThreadId) {
  if (!threadId) return;
  setTimeout(() => void processNextQueuedPrompt(threadId), 0);
}

async function processNextQueuedPrompt(threadId) {
  if (
    !threadId ||
    threadId !== state.currentThreadId ||
    state.busy ||
    state.navigating ||
    !state.connected ||
    state.pendingTurnStarts > 0 ||
    attachmentUploadsForDraft(threadId) > 0
  ) {
    return false;
  }
  const key = draftKey(threadId);
  if (state.queueProcessing.has(key)) return false;
  const queue = promptQueueFor(key);
  const item = queue.shift();
  if (!item) return false;
  if (!queue.length) state.promptQueues.delete(key);
  state.queueProcessing.add(key);
  renderPromptQueue();
  try {
    const started = await sendPrompt(item.text, { fromQueue: true });
    if (!started) {
      promptQueueFor(key, true).unshift(item);
      renderPromptQueue();
    }
    return started;
  } finally {
    state.queueProcessing.delete(key);
  }
}

function saveCurrentDraft() {
  state.drafts.set(draftKey(), elements.prompt.value);
}

function restoreDraft(threadId = state.currentThreadId) {
  elements.prompt.value = state.drafts.get(draftKey(threadId)) || "";
  state.slashDismissedValue = null;
  renderPromptQueue();
  renderGoalProgress();
  resizePrompt();
}

function threadIdFromUrl() {
  if (!window.location?.href) return "";
  const searchParams = new URL(window.location.href).searchParams;
  // app-server calls this value threadId; the user-facing URL calls it a session.
  const sessionId = searchParams.get("session");
  return sessionId !== null ? sessionId : searchParams.get("thread") || "";
}

function historyStateMatches(stateValue) {
  const current = window.history?.state || {};
  return (
    (current.threadId || "") === (stateValue.threadId || "") &&
    (current.draftId || "") === (stateValue.draftId || "")
  );
}

function updateThreadUrl(threadId, mode = "push", draftId = state.newDraftId) {
  if (!window.location?.href || !window.history) return;
  const url = new URL(window.location.href);
  const target = threadId || "";
  const current = threadIdFromUrl();
  const currentSessionIds = url.searchParams.getAll("session");
  const canonicalUrlMatches =
    !url.searchParams.has("thread") &&
    (target
      ? currentSessionIds.length === 1 && currentSessionIds[0] === target
      : currentSessionIds.length === 0);
  const sameTarget = current === target;
  if (mode === "none" && !sameTarget) return;
  if (threadId) url.searchParams.set("session", threadId);
  else url.searchParams.delete("session");
  url.searchParams.delete("thread");
  const stateValue = threadId ? { threadId } : { draftId };
  if (canonicalUrlMatches && historyStateMatches(stateValue)) return;
  if (mode === "none" || sameTarget) mode = "replace";
  const method = mode === "replace" ? "replaceState" : "pushState";
  if (typeof window.history[method] !== "function") return;
  window.history[method](stateValue, "", `${url.pathname}${url.search}${url.hash}`);
}

function urlHydrationTarget(draftId = null) {
  const threadId = threadIdFromUrl();
  const historyDraftId =
    typeof window.history?.state?.draftId === "string"
      ? window.history.state.draftId
      : "";
  const targetDraftId = threadId
    ? ""
    : draftId || historyDraftId || state.newDraftId;
  return {
    draftId: targetDraftId,
    key: threadId ? `thread:${threadId}` : `draft:${targetDraftId}`,
    threadId,
  };
}

function hydrationTargetMatchesCurrentView(target) {
  return target.threadId
    ? state.currentThreadId === target.threadId
    : !state.currentThreadId && state.newDraftId === target.draftId;
}

async function hydrateThreadFromUrl({ draftId = null, force = false } = {}) {
  const requestedTarget = urlHydrationTarget(draftId);
  if (force) state.urlHydrated = false;
  if (state.urlHydrated && !state.urlHydrationPromise) return true;
  if (state.urlHydrationPromise) {
    if (
      requestedTarget.key !== state.urlHydrationActiveKey &&
      requestedTarget.key !== state.urlHydrationPending?.key
    ) {
      state.urlHydrationPending = requestedTarget;
      // Cancel an in-flight resume before it can commit a now-stale history target.
      state.navigationVersion += 1;
    }
    return state.urlHydrationPromise;
  }

  state.urlHydrationPending = requestedTarget;
  state.urlHydrationPromise = (async () => {
    let hydrated = false;
    while (state.urlHydrationPending) {
      const target = state.urlHydrationPending;
      state.urlHydrationPending = null;
      state.urlHydrationActiveKey = target.key;
      state.urlHydrated = false;

      const currentTarget = urlHydrationTarget();
      if (currentTarget.key !== target.key) {
        state.urlHydrationPending = currentTarget;
        continue;
      }

      hydrated = target.threadId
        ? await openThread(target.threadId, { historyMode: "none" })
        : newChat({
            draftId: target.draftId,
            historyMode: "none",
          });

      const latestTarget = urlHydrationTarget();
      if (latestTarget.key !== target.key) {
        state.urlHydrationPending = latestTarget;
        continue;
      }
      state.urlHydrated =
        Boolean(hydrated) || hydrationTargetMatchesCurrentView(target);
      updateConnection();
    }
    return state.urlHydrated;
  })();
  try {
    return await state.urlHydrationPromise;
  } finally {
    state.urlHydrationActiveKey = null;
    state.urlHydrationPending = null;
    state.urlHydrationPromise = null;
  }
}

function restoreCurrentViewUrl() {
  if (state.currentThreadId) {
    updateThreadUrl(state.currentThreadId, "replace");
  } else {
    updateThreadUrl(null, "replace", state.newDraftId);
  }
}

// Where a new conversation starts, in order:
//   1. the sidebar filter, when it is narrowed to one project — starting a chat
//      while browsing a project almost always means starting it there;
//   2. otherwise the project last chosen from the composer chip;
//   3. otherwise no project.
// A caller passing projectId explicitly (creating a project) overrides all of it.
function defaultProjectForNewChat() {
  if (state.activeProjectId && projectById(state.activeProjectId)) {
    return state.activeProjectId;
  }
  if (state.lastProjectId === undefined) return null;
  return state.lastProjectId;
}

function newChat({
  draftId = null,
  historyMode = "push",
  projectId = defaultProjectForNewChat(),
} = {}) {
  if (!state.currentThreadId && attachmentUploadsForDraft() > 0) {
    toast("برای حفظ فایل‌های این پیش‌نویس، تا پایان افزودن آن‌ها صبر کنید.", "warning");
    if (historyMode === "none") restoreCurrentViewUrl();
    return false;
  }
  saveCurrentDraft();
  stopDictation();
  state.navigationVersion += 1;
  closeInteractionDialogs();
  state.openingThreadId = null;
  state.currentThread = null;
  state.currentThreadId = null;
  state.currentTurnId = null;
  state.newDraftId = draftId || crypto.randomUUID();
  if (projectId && projectById(projectId)) {
    state.draftProjects.set(draftKey(), projectId);
  } else {
    state.draftProjects.delete(draftKey());
  }
  setNavigating(false);
  setBusy(false);
  clearConversation();
  elements.welcome.classList.remove("hidden");
  updateAgentCopy(effectiveProvider());
  elements.threadTitle.textContent = "گفتگوی تازه";
  updateThreadUrl(null, historyMode, state.newDraftId);
  restoreDraft(null);
  renderThreadList();
  updateAttentionUi();
  updateProjectChip();
  updateSettingsUi();
  updateConnection();
  closeSidebar();
  elements.prompt.focus();
  return true;
}

function setCurrentThread(thread, metadata = {}) {
  if (state.currentThreadId !== thread.id) closeInteractionDialogs();
  state.currentThread = thread;
  state.currentThreadId = thread.id;
  const runtime = { ...(state.threadRuntime.get(thread.id) || {}) };
  if (metadata.approvalPolicy !== undefined) runtime.approvalPolicy = metadata.approvalPolicy;
  if (metadata.reasoningEffort !== undefined) runtime.reasoningEffort = metadata.reasoningEffort;
  if (metadata.permissionMode !== undefined) runtime.permissionMode = metadata.permissionMode;
  if (metadata.sandbox !== undefined) runtime.sandbox = metadata.sandbox;
  if (metadata.cwd || thread.cwd) runtime.cwd = metadata.cwd || thread.cwd;
  if (metadata.model || thread.model) runtime.model = metadata.model || thread.model;
  if (thread.permissionMode) runtime.permissionMode = thread.permissionMode;
  state.threadRuntime.set(thread.id, runtime);
  if (metadata.tokenUsage !== undefined) {
    state.threadTokenUsage.set(thread.id, metadata.tokenUsage || null);
  }
  syncThreadActivity(thread);
  markThreadSeen(thread.id);
  elements.threadTitle.textContent = threadDisplayTitle(thread);
  elements.welcome.classList.add("hidden");
  restoreDraft(thread.id);
  renderThreadList();
  activateThreadInteractions(thread.id);
  updateProjectChip();
  updateSettingsUi();
  updateConnection();
  void loadGoal(thread.id);
}

function itemText(item) {
  if (item.type === "userMessage") {
    return (item.content || [])
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "image" || part.type === "localImage") return `[تصویر: ${part.path || part.url}]`;
        if (part.type === "audio" || part.type === "localAudio") return "🎙️ پیام صوتی";
        if (part.type === "skill") return `$${part.name}`;
        if (part.type === "mention") return `@${part.name}`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (item.type === "agentMessage" || item.type === "plan") return item.text || "";
  return "";
}

function createAssistantMessageActions() {
  const actions = document.createElement("div");
  actions.className = "message-actions";
  actions.setAttribute("aria-label", "کارهای پاسخ");
  actions.innerHTML = `
    <button class="message-action" type="button" data-message-action="copy" title="کپی Markdown" aria-label="کپی پاسخ به‌صورت Markdown">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
      <span>کپی</span>
    </button>
    <button class="message-action" type="button" data-message-action="quote" title="ارجاع به این پاسخ" aria-label="ارجاع به این پاسخ در پیام تازه">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.25 10.75H4.5A5.5 5.5 0 0 1 10 5.25v3A2.5 2.5 0 0 1 7.5 10.75v3H4.75M16.25 10.75H13.5A5.5 5.5 0 0 1 19 5.25v3a2.5 2.5 0 0 1-2.5 2.5v3h-2.75" /></svg>
      <span>ارجاع</span>
    </button>`;
  return actions;
}

function isCommentaryItem(item) {
  return item.type === "agentMessage" && item.phase === "commentary";
}

function processViewKey(turnId, itemId = "") {
  return turnId || `item:${itemId}`;
}

function setTurnProcessState(view, running, { autoOpen = false } = {}) {
  view.running = running;
  view.element.classList.toggle("running", running);
  view.element.classList.toggle("completed", !running);
  view.element.setAttribute("aria-busy", String(running));
  if (autoOpen && running) view.element.open = true;
  if (!running) view.element.open = false;

  const icon = document.createElement("span");
  icon.className = "turn-process-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = running ? "✦" : "✓";
  const label = document.createElement("span");
  label.className = "turn-process-label";
  label.textContent = running ? "در حال انجام کار" : "روند کار";
  view.summary.replaceChildren(icon, label);

  if (!running) return;
  const dots = document.createElement("span");
  dots.className = "thinking-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) dots.append(document.createElement("span"));
  view.summary.append(dots);
}

function ensureTurnProcessView(turnId, itemId, running = false) {
  const key = processViewKey(turnId, itemId);
  let view = state.turnProcessViews.get(key);
  if (view) {
    if (running && !view.running) setTurnProcessState(view, true);
    return view;
  }

  const element = document.createElement("details");
  element.className = "turn-process";
  element.dataset.turnId = turnId || "";
  const summary = document.createElement("summary");
  const content = document.createElement("div");
  content.className = "turn-process-content";
  element.append(summary, content);
  elements.messages.append(element);
  view = { content, element, key, running, summary };
  state.turnProcessViews.set(key, view);
  setTurnProcessState(view, running, { autoOpen: true });
  return view;
}

function completeTurnProcess(turnId) {
  if (!turnId) return;
  const view = state.turnProcessViews.get(turnId);
  if (view) setTurnProcessState(view, false);
}

function removeItemViewElement(view) {
  const processView = view.processView;
  view.element.remove();
  if (processView && !processView.content.childElementCount) {
    processView.element.remove();
    state.turnProcessViews.delete(processView.key);
  }
}

function createMessageView(item, turnId = null, { continuation = false } = {}) {
  const role = item.type === "userMessage" ? "user" : "assistant";
  const plan = item.type === "plan";
  const row = document.createElement("article");
  row.className = `message-row ${role}`;
  if (turnId) row.dataset.turnId = turnId;
  if (role === "assistant") {
    row.classList.add("final-answer");
    row.classList.toggle("continuation", continuation);
    row.dataset.phase = plan ? "plan" : item.phase || "final_answer";
    row.setAttribute(
      "aria-label",
      plan ? "برنامه" : continuation ? "ادامهٔ پاسخ قبلی" : "پاسخ نهایی",
    );
  }
  row.dataset.itemId = item.id;

  const body = document.createElement("div");
  body.className = "message-body";
  const content = document.createElement("div");
  content.className = "message-content";
  content.dir = "auto";
  if (continuation) {
    const label = document.createElement("div");
    label.className = "message-continuation-label";
    label.textContent = "ادامهٔ پاسخ";
    body.append(label);
  }
  body.append(content);
  const time = document.createElement("time");
  time.className = "message-time";
  body.append(time);
  if (role === "assistant") body.append(createAssistantMessageActions());
  row.append(body);
  elements.messages.append(row);
  if (role === "user") scheduleUserMessageNavigationUpdate();
  return { content, element: row, kind: "message", text: "", type: item.type };
}

function activityTitle(item) {
  const titles = {
    collabAgentToolCall: "عامل‌های همکار",
    commandExecution: "ترمینال",
    contextCompaction: "بهینه‌سازی گفتگو",
    dynamicToolCall: item.tool ? `ابزار · ${item.tool}` : "ابزار",
    enteredReviewMode: "حالت بررسی",
    exitedReviewMode: "پایان بررسی",
    fileChange: "ویرایش فایل‌ها",
    hookPrompt: "Hook",
    imageGeneration: "ساخت تصویر",
    imageView: "مشاهده تصویر",
    mcpToolCall: item.tool ? `ابزار · ${item.tool}` : "ابزار MCP",
    plan: "برنامه",
    reasoning: "تفکر",
    sleep: "انتظار",
    subAgentActivity: "عامل‌های همکار",
    webSearch: item.query ? `جستجوی وب · ${item.query}` : "جستجوی وب",
  };
  return titles[item.type] || item.type || "فعالیت";
}

function createCommentaryView(item, turnId, phase) {
  const processView = ensureTurnProcessView(turnId, item.id, phase !== "completed");
  const element = document.createElement("section");
  element.className = "turn-process-update";
  element.dataset.itemId = item.id;
  const content = document.createElement("div");
  content.className = "turn-process-message";
  content.dir = "auto";
  element.append(content);
  processView.content.append(element);
  return {
    content,
    element,
    kind: "commentary",
    processView,
    text: "",
    type: item.type,
  };
}

function createActivityView(item, turnId, phase = "completed") {
  const processView = ensureTurnProcessView(turnId, item.id, phase !== "completed");
  const details = document.createElement("details");
  details.className = `activity-card activity-${item.type.replace(/[^a-z0-9_-]/gi, "-")}`;
  details.dataset.itemId = item.id;
  details.dataset.activityType = item.type;
  const summary = document.createElement("summary");
  summary.textContent = activityTitle(item);
  summary.addEventListener("click", (event) => {
    if (
      details.classList.contains("reasoning-status") ||
      details.classList.contains("compaction-status")
    ) {
      event.preventDefault();
    }
  });
  const content = document.createElement("div");
  content.className = "activity-content";
  details.append(summary, content);
  processView.content.append(details);
  return {
    content,
    element: details,
    kind: "activity",
    processView,
    summary,
    text: "",
    type: item.type,
  };
}

function formatChanges(changes) {
  if (!changes) return "";
  if (Array.isArray(changes)) {
    return changes
      .map((change) => {
        const header = `${change.kind || change.type || "change"} ${change.path || ""}`.trim();
        return [header, change.diff || change.unifiedDiff || change.unified_diff || ""]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
  }
  return Object.entries(changes)
    .map(([path, value]) => {
      const detail =
        typeof value === "string"
          ? value
          : value.unified_diff || value.diff || value.content || JSON.stringify(value, null, 2);
      return `${path}\n${detail}`;
    })
    .join("\n\n");
}

function reasoningPartsText(parts) {
  if (Array.isArray(parts)) {
    return parts
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  return typeof parts === "string" ? parts : "";
}

function reasoningItemText(item) {
  const summary = reasoningPartsText(item.summary);
  return summary.trim() ? summary : reasoningPartsText(item.content);
}

function setReasoningStatusLabel(view, label, thinking = false) {
  const text = document.createElement("span");
  text.textContent = label;
  view.summary.replaceChildren(text);
  if (!thinking) return;

  const dots = document.createElement("span");
  dots.className = "thinking-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) {
    dots.append(document.createElement("span"));
  }
  view.summary.append(dots);
}

function updateReasoning(view, item = {}, phase = "completed", outcome = "completed") {
  const incomingText = reasoningItemText(item);
  if (incomingText.trim()) view.text = incomingText;

  const running = phase !== "completed";
  const hasText = Boolean(view.text.trim());
  const wasRunning = view.element.classList.contains("running");
  view.element.hidden = false;
  view.element.classList.add("reasoning-card");
  view.element.classList.toggle("running", running);
  view.element.setAttribute("aria-busy", String(running));

  if (hasText) {
    view.element.classList.remove(
      "reasoning-status",
      "reasoning-complete",
      "reasoning-stopped",
    );
    view.summary.removeAttribute("aria-disabled");
    view.summary.textContent = running ? "در حال فکر کردن" : "تفکر";
    view.content.hidden = false;
    view.content.className = "activity-content";
    view.content.textContent = view.text;
    if (!running && wasRunning) view.element.open = false;
    return;
  }

  const stopped = !running && outcome === "stopped";
  view.element.classList.add("reasoning-status");
  view.element.classList.toggle("reasoning-complete", !running && !stopped);
  view.element.classList.toggle("reasoning-stopped", stopped);
  view.element.open = false;
  view.element.hidden = !running && !stopped;
  view.summary.setAttribute("aria-disabled", "true");
  view.content.hidden = true;
  view.content.replaceChildren();
  setReasoningStatusLabel(
    view,
    running ? "در حال فکر کردن" : stopped ? "تفکر متوقف شد" : "تفکر انجام شد",
    running,
  );
}

applyPalette(state.settings.palette);

function updateCompaction(view, phase) {
  const running = phase !== "completed";
  view.element.classList.add("compaction-status");
  view.element.classList.toggle("running", running);
  view.element.classList.toggle("completed", !running);
  view.element.open = false;
  view.element.hidden = !running;
  view.element.setAttribute("aria-busy", String(running));
  view.summary.setAttribute("aria-disabled", "true");
  view.summary.textContent = running
    ? "در حال فشرده‌سازی زمینهٔ گفتگو…"
    : "زمینهٔ گفتگو فشرده شد";
  view.content.hidden = true;
  view.content.replaceChildren();
}

function updateActivity(view, item, phase) {
  if (item.type === "reasoning") {
    updateReasoning(view, item, phase);
    return;
  }
  if (item.type === "contextCompaction") {
    updateCompaction(view, phase);
    return;
  }

  const wasRunning = view.element.classList.contains("running");
  const running = phase !== "completed" && ["inProgress", "running"].includes(item.status);
  const failed =
    ["failed", "error"].includes(item.status) ||
    (item.type === "commandExecution" && item.exitCode != null && item.exitCode !== 0);
  view.element.hidden = false;
  view.element.classList.toggle("running", running);
  view.element.classList.toggle("completed", !running);
  view.element.classList.toggle("failed", failed);
  if (!running && wasRunning) view.element.open = false;

  if (item.type === "commandExecution") {
    view.content.className = "activity-sections";
    const command = escapeHtml(item.command || "");
    const output = escapeHtml(item.aggregatedOutput || view.output || "");
    const status = [item.status, item.exitCode == null ? "" : `exit ${item.exitCode}`]
      .filter(Boolean)
      .join(" · ");
    view.content.innerHTML =
      `<div><b>COMMAND</b><pre class="activity-content command">${command}</pre></div>` +
      (output
        ? `<div><b>OUTPUT</b><pre class="activity-content output">${output}</pre></div>`
        : "") +
      (status ? `<div><b>STATUS</b><span dir="ltr">${escapeHtml(status)}</span></div>` : "");
    return;
  }

  if (item.type === "fileChange") {
    view.content.className = "activity-content diff";
    view.text = formatChanges(item.changes) || view.text || "";
    view.content.textContent = view.text;
    return;
  }

  if (item.type === "plan") {
    view.content.textContent = item.text || view.text;
    return;
  }

  const generic = {
    ...item,
    id: undefined,
    type: undefined,
  };
  view.content.textContent = JSON.stringify(generic, null, 2).replace(
    /{\s*"[^"]+": undefined\s*}/g,
    "",
  );
}

function reconcileOptimisticUserMessage(item, existingView, turnId = null) {
  const optimistic = state.optimisticUserMessages.get(item.clientId);
  if (!optimistic) return existingView;
  if (item.id === optimistic.itemId) return existingView;
  optimistic.accepted = true;
  optimistic.serverItemId = item.id;
  if (turnId) optimistic.turnId = turnId;

  const optimisticId = optimistic.itemId;
  const optimisticView = state.itemViews.get(optimisticId);
  if (!optimisticView) return existingView;
  state.itemViews.delete(optimisticId);
  if (state.userNavigationItemId === optimisticId) {
    state.userNavigationItemId = item.id;
  }

  if (existingView && existingView !== optimisticView) {
    optimisticView.element.remove();
    scheduleUserMessageNavigationUpdate();
    return existingView;
  }

  optimisticView.element.dataset.itemId = item.id;
  state.itemViews.set(item.id, optimisticView);
  return optimisticView;
}

function renderItem(item, phase = "completed", turnId = null, options = {}) {
  if (!item?.id || !item.type) return null;
  let view = state.itemViews.get(item.id);
  if (item.type === "plan" && item.text?.trim()) {
    const duplicate = [...state.itemViews.entries()].find(
      ([itemId, candidate]) =>
        itemId !== item.id &&
        candidate.type === "plan" &&
        candidate.text.trim() === item.text.trim(),
    );
    if (duplicate) {
      if (view) {
        removeItemViewElement(view);
        state.itemViews.delete(item.id);
      }
      return duplicate[1];
    }
  }
  if (item.type === "userMessage" && item.clientId) {
    view = reconcileOptimisticUserMessage(item, view, turnId);
  }
  const commentary = isCommentaryItem(item);
  const isMessage =
    item.type === "userMessage" ||
    item.type === "plan" ||
    (item.type === "agentMessage" && !commentary);
  const kind = commentary ? "commentary" : isMessage ? "message" : "activity";
  let previousText = "";
  if (view && view.kind !== kind) {
    previousText = view.text || "";
    removeItemViewElement(view);
    state.itemViews.delete(item.id);
    view = null;
  }
  if (!view) {
    view = commentary
      ? createCommentaryView(item, turnId, phase)
      : isMessage
        ? createMessageView(item, turnId, options)
        : createActivityView(item, turnId, phase);
    view.text = previousText;
    state.itemViews.set(item.id, view);
  }

  if (commentary) {
    view.text = itemText(item) || view.text;
    view.content.innerHTML = markdown(view.text);
  } else if (isMessage) {
    view.text = itemText(item) || view.text;
    view.content.innerHTML = markdown(view.text);
    view.content.classList.toggle("streaming-cursor", phase === "started" && item.type === "agentMessage");
    if (
      item.type === "plan" ||
      (item.type === "agentMessage" && item.phase === "final_answer")
    ) {
      completeTurnProcess(turnId);
    }
  } else {
    updateActivity(view, item, phase);
  }
  scheduleScrollToBottom();
  return view;
}

function renderOptimisticUserMessage(clientId, input, threadId = null) {
  const item = {
    clientId,
    content: input,
    id: `${OPTIMISTIC_USER_MESSAGE_PREFIX}:${clientId}`,
    type: "userMessage",
  };
  const view = renderItem(item, "completed");
  if (!view) return;
  state.optimisticUserMessages.set(clientId, {
    accepted: false,
    input,
    itemId: item.id,
    serverItemId: null,
    threadId,
    turnId: null,
  });
  while (state.optimisticUserMessages.size > 50) {
    const oldestClientId = state.optimisticUserMessages.keys().next().value;
    if (!oldestClientId || oldestClientId === clientId) break;
    state.optimisticUserMessages.delete(oldestClientId);
  }
  elements.welcome.classList.add("hidden");
}

function updateOptimisticUserMessageTarget(clientId, threadId, turnId = null) {
  const optimistic = state.optimisticUserMessages.get(clientId);
  if (!optimistic) return;
  optimistic.threadId = threadId;
  if (turnId) optimistic.turnId = turnId;
}

function acceptBackgroundOptimisticUserMessage(clientId, itemId, threadId, turnId = null) {
  const optimistic = state.optimisticUserMessages.get(clientId);
  if (!optimistic) return;
  optimistic.accepted = true;
  optimistic.serverItemId = itemId || optimistic.serverItemId;
  optimistic.threadId = threadId || optimistic.threadId;
  if (turnId) optimistic.turnId = turnId;
}

function rollbackOptimisticUserMessage(clientId) {
  const optimistic = state.optimisticUserMessages.get(clientId);
  if (optimistic?.accepted) return false;
  state.optimisticUserMessages.delete(clientId);
  if (!optimistic) return true;

  const optimisticId = optimistic.itemId;
  const view = state.itemViews.get(optimisticId);
  if (view) {
    state.itemViews.delete(optimisticId);
    view.element.remove();
    if (state.userNavigationItemId === optimisticId) {
      state.userNavigationItemId = null;
      elements.userMessageNavigationStatus.textContent = "";
    }
    elements.welcome.classList.toggle(
      "hidden",
      elements.messages.childElementCount > 0,
    );
    scheduleUserMessageNavigationUpdate();
    updateScrollButton();
  }
  return true;
}

function restoreRecentUserMessages(thread) {
  for (const [clientId, optimistic] of state.optimisticUserMessages) {
    if (optimistic.threadId !== thread.id) continue;
    const canonicalView = optimistic.serverItemId
      ? state.itemViews.get(optimistic.serverItemId)
      : null;
    if (canonicalView) {
      state.optimisticUserMessages.delete(clientId);
      continue;
    }

    const item = {
      clientId,
      content: optimistic.input,
      id: optimistic.itemId,
      type: "userMessage",
    };
    const view = renderItem(item, "completed", optimistic.turnId);
    if (!view || !optimistic.turnId) continue;
    const firstTurnElement = [...elements.messages.querySelectorAll("[data-turn-id]")].find(
      (element) => element.dataset.turnId === optimistic.turnId && element !== view.element,
    );
    if (firstTurnElement) elements.messages.insertBefore(view.element, firstTurnElement);
  }
}

function isContinuationTurn(turn) {
  return (
    String(turn?.id || "").startsWith("rollout-") &&
    !(turn.items || []).some((item) => item.type === "userMessage")
  );
}

function renderHistory(thread) {
  clearConversation();
  let activeTurn = null;
  const inProgressTurns = [];
  for (const turn of thread.turns || []) {
    const continuation = isContinuationTurn(turn);
    for (const item of turn.items || []) {
      renderItem(item, "completed", turn.id, {
        continuation: continuation && item.type === "agentMessage" && !isCommentaryItem(item),
      });
    }
    recordTurnTiming(turn.id, {
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    });
    const processView = state.turnProcessViews.get(turn.id);
    if (processView) {
      setTurnProcessState(processView, turn.status === "inProgress", {
        autoOpen: turn.status === "inProgress",
      });
    }
    if (turn.status === "inProgress") {
      inProgressTurns.push(turn);
      if (!state.completedTurns.has(turnEventKey(thread.id, turn.id))) {
        activeTurn = turn;
      }
    }
  }
  restoreRecentUserMessages(thread);
  const activity = ensureThreadActivity(thread.id);
  const hasPendingInteraction = hasPendingInteractionForThread(thread.id);
  if (activeTurn) {
    activity.phase = hasPendingInteraction ? "needs-input" : "running";
    activity.terminalPhase = null;
    activity.turnId = activeTurn.id;
  } else if (hasPendingInteraction) {
    activity.phase = "needs-input";
  } else if (!activity.unread) {
    activity.phase = "idle";
    activity.terminalPhase = null;
    activity.turnId = null;
  }
  const onlyKnownCompletedTurnsRemain =
    inProgressTurns.length > 0 &&
    inProgressTurns.every((turn) =>
      state.completedTurns.has(turnEventKey(thread.id, turn.id)),
    );
  const threadIsActive =
    thread.status?.type === "active" && !onlyKnownCompletedTurnsRemain;
  setBusy(Boolean(activeTurn) || hasPendingInteraction || threadIsActive, activeTurn?.id);
  elements.welcome.classList.toggle("hidden", Boolean((thread.turns || []).length));
  renderThreadList();
  updateAttentionUi();
  scheduleScrollToBottom(true);
  if (!state.busy) scheduleNextQueuedPrompt(thread.id);
}

async function openThread(threadId, { historyMode = "push" } = {}) {
  if (!threadId) return false;
  if (!state.currentThreadId && attachmentUploadsForDraft() > 0) {
    toast("برای حفظ فایل‌های این پیش‌نویس، تا پایان افزودن آن‌ها صبر کنید.", "warning");
    if (historyMode === "none") restoreCurrentViewUrl();
    return false;
  }
  const navigationVersion = ++state.navigationVersion;
  rememberThreadOpened(threadId);
  if (threadId === state.currentThreadId) {
    state.openingThreadId = null;
    updateThreadUrl(threadId, historyMode);
    setNavigating(false);
    markThreadSeen(threadId);
    renderThreadList();
    activateThreadInteractions(threadId);
    updateConnection();
    if (!state.busy) scheduleNextQueuedPrompt(threadId);
    closeSidebar();
    return true;
  }
  saveCurrentDraft();
  closeInteractionDialogs();
  state.openingThreadId = threadId;
  setNavigating(true);
  state.threadEventBacklog.set(threadId, []);
  try {
    elements.threadTitle.textContent = "در حال باز کردن…";
    const result = await rpc("thread/resume", { threadId });
    if (navigationVersion !== state.navigationVersion) return false;
    setCurrentThread(result.thread, result);
    renderHistory(result.thread);
    flushThreadEventBacklog(result.thread.id);
    updateThreadUrl(result.thread.id, historyMode);
    state.openingThreadId = null;
    setNavigating(false);
    updateConnection();
    closeSidebar();
    elements.prompt.focus();
    return true;
  } catch (error) {
    if (navigationVersion !== state.navigationVersion) return false;
    showError(error, "باز کردن گفتگو");
    state.openingThreadId = null;
    setNavigating(false);
    elements.threadTitle.textContent = state.currentThread
      ? threadDisplayTitle(state.currentThread)
      : "گفتگوی تازه";
    if (historyMode === "none") restoreCurrentViewUrl();
    updateConnection();
    return false;
  } finally {
    if (state.openingThreadId === threadId) state.openingThreadId = null;
    updateConnection();
  }
}

const BOTTOM_THRESHOLD = 48;
let scrollEndTimer;

function distanceFromBottom() {
  return Math.max(
    0,
    elements.conversation.scrollHeight -
      elements.conversation.scrollTop -
      elements.conversation.clientHeight,
  );
}

function updateScrollButton() {
  const shouldShow =
    elements.messages.childElementCount > 0 &&
    !state.followOutput &&
    distanceFromBottom() > BOTTOM_THRESHOLD;
  elements.scrollBottom.classList.toggle("hidden", !shouldShow);
}

function resetScrollFollowing() {
  clearTimeout(scrollEndTimer);
  if (state.scrollFrame !== null) cancelAnimationFrame(state.scrollFrame);
  state.followOutput = true;
  state.forceNextScroll = false;
  state.scrollFrame = null;
  state.scrollingToBottom = false;
  elements.scrollBottom.classList.add("hidden");
}

function updateScrollState() {
  const atBottom = distanceFromBottom() <= BOTTOM_THRESHOLD;
  if (atBottom) {
    clearTimeout(scrollEndTimer);
    state.followOutput = !state.userNavigationItemId;
    state.scrollingToBottom = false;
  } else if (!state.scrollingToBottom) {
    state.followOutput = false;
  }
  updateScrollButton();
}

function cancelScrollAnimation(event) {
  if (event) {
    state.userNavigationItemId = null;
    elements.userMessageNavigationStatus.textContent = "";
    scheduleUserMessageNavigationUpdate();
  }
  if (state.scrollFrame !== null) {
    cancelAnimationFrame(state.scrollFrame);
    state.scrollFrame = null;
    state.forceNextScroll = false;
  }
  if (event?.type === "wheel" && event.deltaY < 0 && elements.conversation.scrollTop > 0) {
    state.followOutput = false;
  }
  if (!state.scrollingToBottom) {
    updateScrollButton();
    return;
  }
  clearTimeout(scrollEndTimer);
  state.scrollingToBottom = false;
  state.followOutput = distanceFromBottom() <= BOTTOM_THRESHOLD;
  updateScrollButton();
}

function scrollToBottom(immediate = true, force = false) {
  if (!force && !state.followOutput) {
    updateScrollButton();
    return;
  }

  if (force) {
    state.userNavigationItemId = null;
    elements.userMessageNavigationStatus.textContent = "";
    scheduleUserMessageNavigationUpdate();
  }
  clearTimeout(scrollEndTimer);
  state.followOutput = true;
  state.scrollingToBottom = !immediate;
  elements.scrollBottom.classList.add("hidden");
  elements.conversation.scrollTo({
    top: elements.conversation.scrollHeight,
    behavior: immediate ? "auto" : "smooth",
  });

  if (!immediate) {
    scrollEndTimer = setTimeout(updateScrollState, 1000);
  }
}

function scheduleScrollToBottom(force = false) {
  state.forceNextScroll ||= force;
  if (state.scrollFrame !== null) return;

  state.scrollFrame = requestAnimationFrame(() => {
    state.scrollFrame = null;
    const shouldForce = state.forceNextScroll;
    state.forceNextScroll = false;
    if (shouldForce || state.followOutput) {
      scrollToBottom(true, shouldForce);
    } else {
      updateScrollButton();
    }
  });
}

function userMessageNavigationTargets() {
  const rows = [...elements.messages.querySelectorAll(".message-row.user")];
  if (!rows.length) return { next: null, previous: null };

  if (state.userNavigationItemId) {
    const index = rows.findIndex(
      (row) => row.dataset.itemId === state.userNavigationItemId,
    );
    if (index !== -1) {
      return {
        next: rows[index + 1] || null,
        previous: rows[index - 1] || null,
      };
    }
    state.userNavigationItemId = null;
  }

  const conversationRect = elements.conversation.getBoundingClientRect();
  const viewportCenter = conversationRect.top + elements.conversation.clientHeight / 2;
  let next = null;
  let previous = null;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const rowCenter = rect.top + rect.height / 2;
    if (rowCenter < viewportCenter - 12) {
      previous = row;
    } else if (rowCenter > viewportCenter + 12 && !next) {
      next = row;
    }
  }
  return { next, previous };
}

function updateUserMessageNavigation() {
  state.userMessageNavigationFrame = null;
  const { next, previous } = userMessageNavigationTargets();
  const focused = document.activeElement;
  elements.previousUserMessage.disabled = !previous;
  elements.nextUserMessage.disabled = !next;
  if (focused === elements.previousUserMessage && !previous && next) {
    elements.nextUserMessage.focus();
  } else if (focused === elements.nextUserMessage && !next && previous) {
    elements.previousUserMessage.focus();
  }
}

function scheduleUserMessageNavigationUpdate() {
  if (state.userMessageNavigationFrame !== null) return;
  state.userMessageNavigationFrame = requestAnimationFrame(updateUserMessageNavigation);
}

function navigateToUserMessage(direction) {
  const target = userMessageNavigationTargets()[direction];
  if (!target) return;

  clearTimeout(scrollEndTimer);
  if (state.scrollFrame !== null) {
    cancelAnimationFrame(state.scrollFrame);
    state.scrollFrame = null;
  }
  state.forceNextScroll = false;
  state.followOutput = false;
  state.scrollingToBottom = false;
  state.userNavigationItemId = target.dataset.itemId;
  const rows = [...elements.messages.querySelectorAll(".message-row.user")];
  const targetIndex = rows.indexOf(target);
  elements.userMessageNavigationStatus.textContent =
    targetIndex === -1
      ? ""
      : `پیام ${(targetIndex + 1).toLocaleString("fa-IR")} از ${rows.length.toLocaleString(
          "fa-IR",
        )}`;

  elements.messages
    .querySelectorAll(".message-row.user-message-target")
    .forEach((row) => row.classList.remove("user-message-target"));
  target.classList.add("user-message-target");
  clearTimeout(state.userMessageHighlightTimer);
  state.userMessageHighlightTimer = setTimeout(
    () => target.classList.remove("user-message-target"),
    1400,
  );

  const conversationRect = elements.conversation.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetTop =
    elements.conversation.scrollTop +
    targetRect.top -
    conversationRect.top -
    Math.max(18, (elements.conversation.clientHeight - targetRect.height) / 2);
  elements.conversation.scrollTo({
    top: Math.max(0, targetTop),
    behavior: "smooth",
  });
  updateScrollButton();
  scheduleUserMessageNavigationUpdate();
}

function appendDelta(
  itemId,
  delta,
  kind,
  turnId = null,
  itemPhase = null,
  continuation = false,
) {
  let view = state.itemViews.get(itemId);
  if (!view) {
    const item =
      kind === "agent"
        ? { id: itemId, phase: itemPhase, type: "agentMessage", text: "" }
        : {
            id: itemId,
            type:
              kind === "reasoning"
                ? "reasoning"
                : kind === "file"
                  ? "fileChange"
                  : "commandExecution",
          };
    view = renderItem(item, "started", turnId, { continuation });
  }
  if (!view) return;

  if (kind === "agent") {
    view.text += delta;
    view.content.innerHTML = markdown(view.text);
    if (view.kind === "commentary") {
      view.content.classList.remove("streaming-cursor");
      if (view.processView && !view.processView.running) {
        setTurnProcessState(view.processView, true);
      }
    } else {
      view.content.classList.add("streaming-cursor");
    }
  } else if (kind === "reasoning") {
    view.text += delta;
    updateReasoning(view, {}, "started");
  } else if (kind === "command") {
    view.output = (view.output || "") + delta;
    const outputNode = view.element.querySelector(".output");
    if (outputNode) outputNode.textContent = view.output;
    else {
      updateActivity(
        view,
        { id: itemId, type: "commandExecution", status: "inProgress", aggregatedOutput: view.output },
        "started",
      );
    }
  } else if (kind === "file") {
    view.text += delta;
    view.content.textContent = view.text;
  }
  scheduleScrollToBottom();
}

function renderPlan(params) {
  const id = `plan-${params.turnId}`;
  let view = state.itemViews.get(id);
  if (!view) {
    view = createActivityView({ id, type: "plan" }, params.turnId, "started");
    view.element.open = false;
    state.itemViews.set(id, view);
  }
  view.content.className = "plan-list";
  view.content.replaceChildren();
  for (const step of params.plan || []) {
    const item = document.createElement("li");
    const status = document.createElement("span");
    status.className = `plan-status ${step.status}`;
    status.textContent =
      step.status === "completed" ? "✓" : step.status === "in_progress" ? "◉" : "○";
    const text = document.createElement("span");
    text.className = "plan-step-text";
    text.dir = "auto";
    text.textContent = step.step;
    item.append(status, text);
    view.content.append(item);
  }
  scheduleScrollToBottom();
}

async function ensureThread(sourceThreadId, navigationVersion, sourceDraftKey) {
  if (sourceThreadId) return sourceThreadId;
  const projectId = state.draftProjects.get(sourceDraftKey) || null;
  const project = projectById(projectId);
  const planMode = composerModeFor(sourceDraftKey) === "plan";
  const params = {
    cwd: project?.cwd || state.settings.cwd,
    provider: state.settings.provider,
  };
  if (state.settings.provider === "codex") {
    const instructions = projectInstructions(project, {
      includeResponseStyle: !planMode,
    });
    if (instructions) params.developerInstructions = instructions;
    if (state.settings.approvalPolicy) params.approvalPolicy = state.settings.approvalPolicy;
    if (state.settings.sandbox) params.sandbox = state.settings.sandbox;
  }
  const model = state.settings.modelByProvider[state.settings.provider] || "";
  if (model) params.model = model;
  if (state.settings.provider === "claude" && state.settings.claudePermissionMode) {
    params.permissionMode = state.settings.claudePermissionMode;
  }
  const result = await rpc("thread/start", params);
  if (projectId) {
    try {
      await api("/api/project-threads", {
        method: "POST",
        body: JSON.stringify({ threadId: result.thread.id, projectId }),
      });
      state.threadProjects.set(result.thread.id, projectId);
    } catch (error) {
      showError(error, "افزودن گفتگوی تازه به پروژه");
    }
  }
  state.draftProjects.delete(sourceDraftKey);
  state.threadsRefreshVersion += 1;
  if (!state.threads.some((thread) => thread.id === result.thread.id)) {
    state.threads.unshift(result.thread);
  }
  migratePromptQueue(sourceDraftKey, result.thread.id);
  migrateComposerState(sourceDraftKey, result.thread.id);
  if (state.drafts.has(sourceDraftKey)) {
    state.drafts.set(result.thread.id, state.drafts.get(sourceDraftKey));
    state.drafts.delete(sourceDraftKey);
  }
  syncThreadActivity(result.thread);
  if (
    navigationVersion === state.navigationVersion &&
    state.currentThreadId === null &&
    draftKey() === sourceDraftKey
  ) {
    setCurrentThread(result.thread, result);
    updateThreadUrl(result.thread.id, "replace");
  } else {
    renderThreadList();
  }
  return result.thread.id;
}

function turnEventKey(threadId, turnId) {
  return `${threadId}:${turnId}`;
}

async function sendPrompt(
  text = elements.prompt.value,
  { fromQueue = false } = {},
) {
  if (parseSlashCommand(text) && (await handleSlashCommand(text))) return true;
  text = String(text || "").trim();
  const input = text ? [{ type: "text", text }] : [];
  if (!input.length || !state.connected || state.navigating || attachmentUploadsForDraft() > 0) {
    return false;
  }
  if (state.busy) {
    if (fromQueue) return false;
    enqueuePrompt(text);
    return true;
  }
  const sourceThreadId = state.currentThreadId;
  const sourceDraftKey = draftKey(sourceThreadId);
  const navigationVersion = state.navigationVersion;
  let targetThreadId = sourceThreadId;
  const clientUserMessageId = crypto.randomUUID();
  if (!fromQueue) {
    elements.prompt.value = "";
    state.drafts.set(sourceDraftKey, "");
    resizePrompt();
  }
  renderOptimisticUserMessage(clientUserMessageId, input, sourceThreadId);
  scrollToBottom(true, true);
  setBusy(true);
  if (sourceThreadId) {
    updateThreadActivity(sourceThreadId, {
      phase: "running",
      terminalPhase: null,
      turnId: null,
      unread: false,
    });
  }
  state.pendingTurnStarts += 1;
  let turnAccepted = false;
  try {
    const threadId = await ensureThread(
      sourceThreadId,
      navigationVersion,
      sourceDraftKey,
    );
    targetThreadId = threadId;
    updateOptimisticUserMessageTarget(clientUserMessageId, threadId);
    await activatePendingGoal(threadId);
    const provider =
      state.currentThreadId === threadId && state.currentThread?.provider
        ? state.currentThread.provider
        : providerForThread(threadId);
    const params = {
      clientUserMessageId,
      input,
      threadId,
      provider,
    };
    const planMode =
      providerSupportsPlanMode(provider) && composerModeFor(threadId) === "plan";
    if (planMode && provider === "codex") {
      const collaborationMode = planCollaborationMode();
      if (!collaborationMode) {
        throw new Error("برای Plan mode ابتدا یک مدل Codex انتخاب یا بارگذاری کنید.");
      }
      params.collaborationMode = collaborationMode;
    } else if (provider === "codex") {
      // App-server keeps a thread's collaboration mode across turns. Explicitly
      // select the default preset so switching Plan mode off changes the next turn.
      params.collaborationMode = defaultCollaborationMode();
    }
    if (planMode && provider === "claude") {
      // Claude Code has no collaboration mode; plan mode is a permission mode.
      params.permissionMode = "plan";
    }
    if (providerSupports("instructions", provider)) {
      const project = projectById(state.threadProjects.get(threadId));
      const instructions = projectInstructions(project, {
        includeResponseStyle: !planMode,
      });
      if (instructions) params.developerInstructions = instructions;
    }
    if (
      state.settings.effort &&
      !params.collaborationMode &&
      (provider === "codex" || CLAUDE_EFFORTS.has(state.settings.effort))
    ) {
      params.effort = state.settings.effort;
    }
    const result = await rpc("turn/start", params);
    turnAccepted = true;
    updateOptimisticUserMessageTarget(clientUserMessageId, threadId, result.turn.id);
    const completedBeforeResponse = state.completedTurns.has(
      turnEventKey(threadId, result.turn.id),
    );
    if (!completedBeforeResponse) {
      updateThreadActivity(threadId, {
        phase: "running",
        terminalPhase: null,
        turnId: result.turn.id,
        unread: false,
      });
      if (state.currentThreadId === threadId) {
        setBusy(true, result.turn.id);
        elements.welcome.classList.add("hidden");
      }
    } else if (state.currentThreadId === threadId) {
      setBusy(false);
    }
  } catch (error) {
    const shouldRollback = rollbackOptimisticUserMessage(clientUserMessageId);
    turnAccepted = !shouldRollback;
    if (shouldRollback) {
      const restoreThreadId = targetThreadId || sourceThreadId;
      const restoreKey = restoreThreadId ? draftKey(restoreThreadId) : sourceDraftKey;
      if (!fromQueue) {
        const newerDraft = state.drafts.get(restoreKey) || "";
        state.drafts.set(restoreKey, newerDraft ? `${text}\n\n${newerDraft}` : text);
      }
      if (restoreThreadId) {
        const activity = ensureThreadActivity(restoreThreadId);
        if (activity.phase === "running" && !activity.turnId) {
          activity.phase = "idle";
          activity.terminalPhase = null;
          activity.unread = false;
          renderThreadList();
          updateAttentionUi();
        }
      }
      if (
        state.currentThreadId === restoreThreadId ||
        (!restoreThreadId && draftKey() === sourceDraftKey)
      ) {
        setBusy(false);
        if (!fromQueue) restoreDraft(restoreThreadId);
      }
    }
    showError(error, "ارسال پیام");
  } finally {
    state.pendingTurnStarts = Math.max(0, state.pendingTurnStarts - 1);
    if (turnAccepted && state.currentThreadId && !state.busy) {
      scheduleNextQueuedPrompt(state.currentThreadId);
    }
  }
  return turnAccepted;
}

async function stopTurn() {
  const threadId = state.currentThreadId;
  const turnId = threadId
    ? ensureThreadActivity(threadId).turnId || state.currentTurnId
    : null;
  if (!threadId || !turnId) return;
  try {
    await rpc("turn/interrupt", {
      threadId,
      turnId,
      provider:
        state.currentThread?.provider || providerForThread(threadId),
    });
  } catch (error) {
    showError(error, "توقف پاسخ");
  }
}

function appendTurnError(message) {
  const previous = elements.messages.lastElementChild;
  if (previous?.classList.contains("error-message") && previous.dataset.rawMessage === message) {
    return;
  }
  const node = document.createElement("div");
  node.className = "error-message";
  node.dataset.rawMessage = message;
  node.textContent = /refresh token (was already used|has already been used)|token_expired/i.test(message)
    ? "ورود Codex منقضی شده است. در ترمینال ابتدا `codex logout` و سپس `codex login` را اجرا کنید و Codex Web را دوباره راه بیندازید."
    : message;
  elements.messages.append(node);
  scheduleScrollToBottom();
}

const THREAD_RENDER_METHODS = new Set([
  "error",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/completed",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/started",
  "turn/plan/updated",
]);

function terminalTurnPhase(status) {
  if (status === "failed") return "failed";
  if (status === "interrupted" || status === "cancelled") return "interrupted";
  return "completed";
}

function finishVisibleTurn(turn) {
  setBusy(false);
  for (const view of state.itemViews.values()) {
    if (view.type === "reasoning" && view.element?.classList.contains("running")) {
      const stopped = ["failed", "interrupted", "cancelled"].includes(turn?.status);
      updateReasoning(view, {}, "completed", stopped ? "stopped" : "completed");
    }
    view.content?.classList.remove("streaming-cursor");
    view.element?.classList.remove("running");
  }
  if (turn?.id && state.turnProcessViews.has(turn.id)) {
    completeTurnProcess(turn.id);
  } else {
    for (const processView of state.turnProcessViews.values()) {
      if (processView.running) setTurnProcessState(processView, false);
    }
  }
  if (turn?.status === "failed") {
    appendTurnError(turn.error?.message || "اجرای turn ناموفق بود.");
  }
}

function queueThreadEvent(message) {
  const threadId = message.params?.threadId;
  if (!threadId || !THREAD_RENDER_METHODS.has(message.method)) return;
  const backlog = state.threadEventBacklog.get(threadId) || [];
  backlog.push(message);
  if (backlog.length > 300) backlog.splice(0, backlog.length - 300);
  state.threadEventBacklog.set(threadId, backlog);
}

function renderThreadEvent(message) {
  const { method, params = {} } = message;
  const continuation = String(params.turnId || "").startsWith("rollout-");
  switch (method) {
    case "item/started":
      renderItem(params.item, "started", params.turnId, {
        continuation:
          continuation && params.item?.type === "agentMessage" && !isCommentaryItem(params.item),
      });
      break;
    case "item/completed":
      renderItem(params.item, "completed", params.turnId, {
        continuation:
          continuation && params.item?.type === "agentMessage" && !isCommentaryItem(params.item),
      });
      break;
    case "item/agentMessage/delta":
      appendDelta(
        params.itemId,
        params.delta || "",
        "agent",
        params.turnId,
        params.phase,
        continuation,
      );
      break;
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      appendDelta(params.itemId, params.delta || "", "reasoning", params.turnId);
      break;
    case "item/commandExecution/outputDelta":
      appendDelta(params.itemId, params.delta || "", "command", params.turnId);
      break;
    case "item/fileChange/outputDelta":
      appendDelta(params.itemId, params.delta || "", "file", params.turnId);
      break;
    case "turn/plan/updated":
      renderPlan(params);
      break;
    case "error":
      appendTurnError(params.error?.message || params.message || "خطای Codex");
      break;
  }
}

function flushThreadEventBacklog(threadId) {
  const backlog = state.threadEventBacklog.get(threadId) || [];
  state.threadEventBacklog.delete(threadId);
  if (threadId !== state.currentThreadId) return;
  const snapshotItemIds = new Set(state.itemViews.keys());
  for (const message of backlog) {
    const { method, params = {} } = message;
    const itemId = params.itemId || params.item?.id;
    const isIncremental =
      method === "item/started" ||
      method.endsWith("/delta") ||
      method.endsWith("Delta");
    if (itemId && snapshotItemIds.has(itemId) && isIncremental) continue;
    renderThreadEvent(message);
  }
}

function handleNotification(message) {
  const { method, params = {} } = message;
  const threadId = params.threadId || params.conversationId || null;

  if (method === "serverRequest/resolved") {
    if (params.requestId !== undefined) {
      removePendingInteraction(params.requestId, params.threadId || null);
    }
    return;
  }

  if (method === "account/rateLimits/updated") {
    const source = params.provider || "codex";
    // A background turn on one agent must not overwrite the quota card the user
    // is currently looking at for the other.
    if (source === effectiveProvider()) {
      applyRateLimits(params, { notify: true, provider: source });
    }
    return;
  }

  if (method === "thread/tokenUsage/updated" && threadId) {
    state.threadTokenUsage.set(threadId, params.tokenUsage || null);
    if (threadId === state.currentThreadId) renderContextUsage();
    return;
  }

  if (method === "thread/settings/updated" && threadId) {
    const collaborationMode = params.threadSettings?.collaborationMode;
    if (collaborationMode?.mode === "plan") {
      state.composerModes.set(threadId, "plan");
    } else {
      state.composerModes.delete(threadId);
    }
    if (threadId === state.currentThreadId) updateComposerModeUi();
    return;
  }

  if (method === "thread/goal/updated" && threadId) {
    if (params.goal) state.goals.set(threadId, params.goal);
    state.pendingGoals.delete(threadId);
    if (threadId === state.currentThreadId) renderGoalProgress();
    return;
  }

  if (method === "thread/goal/cleared" && threadId) {
    state.goals.delete(threadId);
    state.pendingGoals.delete(threadId);
    if (threadId === state.currentThreadId) renderGoalProgress();
    return;
  }

  if (
    threadId &&
    (method === "item/started" || method === "item/completed") &&
    params.item?.type === "contextCompaction"
  ) {
    state.compactPendingThreads.delete(threadId);
    if (method === "item/started") {
      updateThreadActivity(threadId, {
        phase: "running",
        terminalPhase: null,
        turnId: params.turnId || null,
        unread: false,
      });
      if (threadId === state.currentThreadId) setBusy(true, params.turnId || null);
    }
  }

  if (method === "thread/name/updated") {
    const threadName = params.threadName || params.name;
    const thread = threadById(threadId);
    if (thread && threadName) thread.name = threadName;
    if (threadId === state.currentThreadId && threadName) {
      elements.threadTitle.textContent = threadName;
    }
    refreshThreads();
    return;
  }

  if (method === "thread/status/changed" && threadId) {
    const thread = threadById(threadId);
    if (thread) thread.status = params.status;
    if (state.currentThread?.id === threadId) state.currentThread.status = params.status;
    const activity = ensureThreadActivity(threadId);
    if (hasPendingInteractionForThread(threadId)) {
      activity.phase = "needs-input";
    } else {
      const phase = phaseFromThreadStatus(params.status);
      if (phase !== "idle") {
        activity.phase = phase;
      } else if (activity.unread) {
        activity.phase = activity.terminalPhase || "completed";
      } else if (!activity.unread) {
        activity.phase = "idle";
        activity.terminalPhase = null;
        activity.turnId = null;
      }
    }
    if (threadId === state.currentThreadId) {
      setBusy(params.status?.type === "active", activity.turnId);
    }
    renderThreadList();
    updateAttentionUi();
    return;
  }

  if (method === "turn/started" && threadId) {
    const turnId = params.turn?.id || null;
    if (threadId === state.currentThreadId) {
      recordTurnTiming(turnId, { startedAt: nowInSeconds() });
    }
    state.compactPendingThreads.delete(threadId);
    updateThreadActivity(threadId, {
      phase: hasPendingInteractionForThread(threadId) ? "needs-input" : "running",
      terminalPhase: null,
      turnId,
      unread: false,
    });
    if (threadId === state.currentThreadId) {
      setBusy(true, turnId);
      elements.welcome.classList.add("hidden");
    }
    return;
  }

  if (method === "turn/completed" && threadId) {
    void refreshRateLimits({ silent: true });
    const turn = params.turn || {};
    const turnId = turn.id || "unknown";
    const key = turnEventKey(threadId, turnId);
    if (threadId === state.currentThreadId) {
      recordTurnTiming(turnId, { completedAt: nowInSeconds() });
    }
    state.compactPendingThreads.delete(threadId);
    state.completedTurns.add(key);

    const activity = ensureThreadActivity(threadId);
    const isTrackedTurn = !activity.turnId || activity.turnId === turn.id;
    const isBackground = threadId !== state.currentThreadId;
    const isUnseen = isBackground || document.hidden;
    if (isTrackedTurn) {
      activity.terminalPhase = terminalTurnPhase(turn.status);
      activity.phase = activity.terminalPhase;
      activity.turnId = null;
    }
    if (isUnseen) activity.unread = true;
    else if (isTrackedTurn) activity.unread = false;

    if (!state.notifiedTurns.has(key)) {
      state.notifiedTurns.add(key);
      void playCompletionSoundOnce(key, turn.status);
      if (isUnseen) {
        announceThreadCompletion(threadId, turn.status);
      }
    }

    if (!isBackground && isTrackedTurn) {
      finishVisibleTurn(turn);
      scheduleNextQueuedPrompt(threadId);
    }
    renderThreadList();
    updateAttentionUi();
    refreshThreads();
    return;
  }

  if (method === "thread/closed" && threadId) {
    state.compactPendingThreads.delete(threadId);
    const activity = ensureThreadActivity(threadId);
    activity.phase = "idle";
    activity.terminalPhase = null;
    activity.turnId = null;
    if (threadId === state.currentThreadId) {
      setBusy(false);
      toast("ارتباط این گفتگو بسته شد.", "error");
    }
    renderThreadList();
    updateAttentionUi();
    return;
  }

  if (threadId && threadId !== state.currentThreadId) {
    if (
      (method === "item/started" || method === "item/completed") &&
      params.item?.type === "userMessage" &&
      params.item.clientId
    ) {
      acceptBackgroundOptimisticUserMessage(
        params.item.clientId,
        params.item.id,
        threadId,
        params.turnId,
      );
    }
    queueThreadEvent(message);
    return;
  }
  renderThreadEvent(message);
}

function approvalDetail(params) {
  if (params.command) {
    const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
    return [params.cwd ? `cwd: ${params.cwd}` : "", command].filter(Boolean).join("\n\n");
  }
  if (params.fileChanges) return formatChanges(params.fileChanges);
  if (params.permissions) return JSON.stringify(params.permissions, null, 2);
  const copy = { ...params };
  delete copy.threadId;
  delete copy.turnId;
  delete copy.startedAtMs;
  delete copy.itemId;
  delete copy.reason;
  return JSON.stringify(copy, null, 2);
}

const HUMAN_INTERACTION_METHODS = new Set([
  "applyPatchApproval",
  "execCommandApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

function interactionKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function interactionThreadId(message) {
  return message?.params?.threadId || message?.params?.conversationId || null;
}

function hasPendingInteractionForThread(threadId) {
  if (!threadId) return false;
  return [...state.pendingInteractions.values()].some(
    (message) => interactionThreadId(message) === threadId,
  );
}

function interactionForCurrentThread() {
  for (const [key, message] of state.pendingInteractions) {
    const threadId = interactionThreadId(message);
    if (
      !state.postponedInteractions.has(key) &&
      threadId === state.currentThreadId
    ) {
      return { key, message };
    }
  }
  return null;
}

function setInteractionSubmitting(submitting) {
  state.interactionSubmitting = submitting;
  for (const control of document.querySelectorAll(
    "#approval-dialog button, #input-dialog button, #input-dialog input, #input-dialog textarea",
  )) {
    control.disabled = submitting;
  }
}

function closeInteractionDialogs() {
  if (elements.approvalDialog.open) elements.approvalDialog.close();
  if (elements.inputDialog.open) elements.inputDialog.close();
  state.activeInteractionKey = null;
  setInteractionSubmitting(false);
}

function updateThreadAfterInteractionChange(threadId, render = true) {
  if (!threadId) return;
  const activity = ensureThreadActivity(threadId);
  if (hasPendingInteractionForThread(threadId)) {
    activity.phase = "needs-input";
  } else if (activity.phase === "needs-input") {
    const status =
      threadById(threadId)?.status ||
      (state.currentThread?.id === threadId ? state.currentThread.status : null);
    const phase = phaseFromThreadStatus(status);
    if (activity.unread) activity.phase = activity.terminalPhase || "completed";
    else if (phase !== "idle" || activity.turnId) activity.phase = "running";
    else if (!activity.unread) activity.phase = "idle";
  }
  if (threadId === state.currentThreadId) {
    setBusy(
      activity.phase === "running" || activity.phase === "needs-input",
      activity.turnId,
    );
  }
  if (render) {
    renderThreadList();
    updateAttentionUi();
  }
}

function removePendingInteraction(id, expectedThreadId = null) {
  const key = interactionKey(id);
  const message = state.pendingInteractions.get(key);
  if (!message) return;
  const threadId = interactionThreadId(message);
  if (expectedThreadId && threadId !== expectedThreadId) return;
  state.pendingInteractions.delete(key);
  state.postponedInteractions.delete(key);
  if (state.activeInteractionKey === key) closeInteractionDialogs();
  updateThreadAfterInteractionChange(threadId);
  showNextInteraction();
}

function queueInteraction(message, { notify = true } = {}) {
  if (!HUMAN_INTERACTION_METHODS.has(message.method)) {
    console.debug("Ignoring unsupported app-server request", message.method);
    return;
  }
  const key = interactionKey(message.id);
  if (state.pendingInteractions.has(key)) return;
  state.pendingInteractions.set(key, message);
  const threadId = interactionThreadId(message);
  updateThreadAfterInteractionChange(threadId);

  if (threadId && threadId !== state.currentThreadId) {
    if (notify) {
      toast(`گفتگوی «${threadTitleById(threadId)}» منتظر پاسخ شماست — نمایش`, "warning", {
        duration: 8000,
        onClick: () => openThread(threadId),
      });
    }
    return;
  }
  showNextInteraction();
}

function syncPendingInteractions(requests) {
  const supported = (requests || []).filter((message) =>
    HUMAN_INTERACTION_METHODS.has(message.method),
  );
  const next = new Map(
    supported.map((message) => [interactionKey(message.id), message]),
  );
  const affectedThreads = new Set();
  for (const message of state.pendingInteractions.values()) {
    affectedThreads.add(interactionThreadId(message));
  }
  for (const message of next.values()) affectedThreads.add(interactionThreadId(message));

  state.pendingInteractions = next;
  state.postponedInteractions = new Set(
    [...state.postponedInteractions].filter((key) => next.has(key)),
  );
  if (state.activeInteractionKey && !next.has(state.activeInteractionKey)) {
    closeInteractionDialogs();
  }
  for (const threadId of affectedThreads) {
    updateThreadAfterInteractionChange(threadId, false);
  }
  renderThreadList();
  updateAttentionUi();
  showNextInteraction();
}

function activateThreadInteractions(threadId) {
  for (const [key, message] of state.pendingInteractions) {
    if (interactionThreadId(message) === threadId) {
      state.postponedInteractions.delete(key);
    }
  }
  showNextInteraction();
}

function postponeInteraction() {
  if (state.activeInteractionKey) {
    state.postponedInteractions.add(state.activeInteractionKey);
  }
  closeInteractionDialogs();
}

function showNextInteraction() {
  if (elements.approvalDialog.open || elements.inputDialog.open) return;
  const interaction = interactionForCurrentThread();
  if (!interaction) return;
  const { key, message } = interaction;
  state.activeInteractionKey = key;
  setInteractionSubmitting(false);
  const title = threadTitleById(interactionThreadId(message));

  if (message.method === "item/tool/requestUserInput") {
    elements.inputContext.textContent = `سؤال Codex · ${title}`;
    showInputRequest(message);
    return;
  }
  if (
    message.method === "mcpServer/elicitation/request" &&
    message.params?.mode === "form"
  ) {
    elements.inputContext.textContent =
      `درخواست ${message.params.serverName || "MCP"} · ${title}`;
    showMcpFormRequest(message);
    return;
  }

  const params = message.params || {};
  elements.approvalContext.textContent = `درخواست Codex · ${title}`;
  const isFile = message.method.includes("fileChange") || message.method === "applyPatchApproval";
  const isPermission = message.method.includes("permissions");
  const isMcp = message.method.includes("elicitation");
  elements.approvalTitle.textContent = isFile
    ? "تأیید تغییر فایل‌ها"
    : isPermission
      ? "درخواست دسترسی بیشتر"
      : isMcp
        ? "درخواست MCP"
        : "تأیید اجرای فرمان";
  elements.approvalReason.textContent =
    params.reason ||
    (isFile
      ? "Codex می‌خواهد این تغییرات را روی فایل‌ها اعمال کند."
      : isPermission
        ? "Codex برای ادامه به دسترسی بیشتری نیاز دارد."
        : isMcp
          ? "یک MCP server برای ادامه به ورودی یا تأیید نیاز دارد."
          : "Codex می‌خواهد این فرمان را اجرا کند.");
  elements.approvalDetail.textContent = approvalDetail(params);
  elements.approvalSession.classList.toggle(
    "hidden",
    isPermission || isMcp || !message.method.includes("requestApproval"),
  );
  elements.approvalDialog.showModal();
}

function interactionResult(message, action) {
  if (message.method === "item/permissions/requestApproval") {
    return {
      permissions: action === "accept" || action === "session" ? message.params.permissions : {},
      scope: action === "session" ? "session" : "turn",
    };
  }
  if (message.method === "mcpServer/elicitation/request") {
    const accepted = action === "accept" || action === "session";
    return {
      action: accepted ? "accept" : action === "cancel" ? "cancel" : "decline",
      content: null,
      _meta: {},
    };
  }
  if (message.method === "execCommandApproval" || message.method === "applyPatchApproval") {
    if (action === "accept") return { decision: "approved" };
    if (action === "session") return { decision: "approved_for_session" };
    if (action === "cancel") return { decision: "abort" };
    return { decision: { denied: { rejection: "کاربر در Codex Web این درخواست را رد کرد." } } };
  }
  const decisions = {
    accept: "accept",
    cancel: "cancel",
    decline: "decline",
    session: "acceptForSession",
  };
  return { decision: decisions[action] };
}

async function respondToInteraction(message, result, context) {
  const key = interactionKey(message.id);
  const threadId = interactionThreadId(message);
  if (!threadId || state.activeInteractionKey !== key) return;

  setInteractionSubmitting(true);
  try {
    await api("/api/respond", {
      method: "POST",
      body: JSON.stringify({ id: message.id, threadId, result }),
    });
    removePendingInteraction(message.id);
  } catch (error) {
    if (error.status === 404) {
      removePendingInteraction(message.id);
      toast("این درخواست قبلاً پاسخ داده شده است.", "warning");
      return;
    }
    if (state.pendingInteractions.has(key)) {
      setInteractionSubmitting(false);
      showError(error, context);
    }
  }
}

async function answerInteraction(action) {
  const message = state.pendingInteractions.get(state.activeInteractionKey);
  if (!message) return;
  await respondToInteraction(
    message,
    interactionResult(message, action),
    "ارسال پاسخ تأیید",
  );
}

function configureInputDialog(isMcpForm) {
  elements.inputDecline.classList.toggle("hidden", !isMcpForm);
  elements.inputCancel.classList.toggle("hidden", !isMcpForm);
  elements.inputSubmit.textContent = isMcpForm ? "ارسال و ادامه" : "ارسال پاسخ";
}

function mcpSchemaOptions(schema) {
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map((option) => ({
      label: option.title || String(option.const),
      value: String(option.const),
    }));
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value, index) => ({
      label: schema.enumNames?.[index] || String(value),
      value: String(value),
    }));
  }
  if (Array.isArray(schema.items?.anyOf)) {
    return schema.items.anyOf.map((option) => ({
      label: option.title || String(option.const),
      value: String(option.const),
    }));
  }
  if (Array.isArray(schema.items?.enum)) {
    return schema.items.enum.map((value) => ({
      label: String(value),
      value: String(value),
    }));
  }
  return [];
}

function createMcpFormField(fieldName, schema, required) {
  const block = document.createElement("section");
  block.className = "question-block mcp-form-field";
  block.dataset.mcpField = fieldName;

  const header = document.createElement("span");
  header.className = "question-header";
  header.textContent = `${schema.title || fieldName}${required ? " *" : ""}`;
  block.append(header);

  if (schema.description) {
    const description = document.createElement("p");
    description.dir = "auto";
    description.textContent = schema.description;
    block.append(description);
  }

  const controlName = `mcp:${fieldName}`;
  const options = mcpSchemaOptions(schema);
  if (schema.type === "array") {
    const optionGroup = document.createElement("div");
    optionGroup.className = "question-options";
    for (const option of options) {
      const label = document.createElement("label");
      label.className = "question-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = controlName;
      checkbox.value = option.value;
      checkbox.checked = (schema.default || []).map(String).includes(option.value);
      const title = document.createElement("strong");
      title.textContent = option.label;
      label.append(checkbox, title);
      optionGroup.append(label);
    }
    block.dataset.minimumItems = String(schema.minItems ?? (required ? 1 : 0));
    block.dataset.maximumItems =
      schema.maxItems == null ? "" : String(schema.maxItems);
    block.append(optionGroup);
    return block;
  }

  if (options.length || schema.type === "boolean") {
    const select = document.createElement("select");
    select.className = "question-control";
    select.name = controlName;
    select.required = required;
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = required ? "انتخاب کنید…" : "بدون انتخاب";
    select.append(empty);
    const selectOptions =
      schema.type === "boolean"
        ? [
            { label: "بله", value: "true" },
            { label: "خیر", value: "false" },
          ]
        : options;
    for (const option of selectOptions) {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      select.append(node);
    }
    if (schema.default != null) select.value = String(schema.default);
    block.append(select);
    return block;
  }

  const input = document.createElement("input");
  input.className = "question-control";
  input.name = controlName;
  input.required = required;
  input.value = schema.default ?? "";
  if (schema.type === "number" || schema.type === "integer") {
    input.type = "number";
    if (schema.type === "integer") input.step = "1";
    if (schema.minimum != null) input.min = String(schema.minimum);
    if (schema.maximum != null) input.max = String(schema.maximum);
    input.dir = "ltr";
  } else {
    const inputTypes = {
      date: "date",
      "date-time": "datetime-local",
      email: "email",
      password: "password",
      uri: "url",
    };
    input.type = inputTypes[schema.format] || "text";
    if (input.type === "password" || schema.writeOnly === true) {
      input.type = "password";
      input.autocomplete = "off";
    }
    if (schema.minLength != null) input.minLength = schema.minLength;
    if (schema.maxLength != null) input.maxLength = schema.maxLength;
    input.dir = schema.format === "email" || schema.format === "uri" ? "ltr" : "auto";
  }
  block.append(input);
  return block;
}

function showMcpFormRequest(message) {
  configureInputDialog(true);
  elements.inputQuestions.replaceChildren();

  const intro = document.createElement("p");
  intro.className = "mcp-form-message";
  intro.dir = "auto";
  intro.textContent = message.params.message || "برای ادامه، فرم MCP را کامل کنید.";
  elements.inputQuestions.append(intro);

  const schema = message.params.requestedSchema || {};
  const requiredFields = new Set(schema.required || []);
  for (const [fieldName, fieldSchema] of Object.entries(schema.properties || {})) {
    elements.inputQuestions.append(
      createMcpFormField(
        fieldName,
        fieldSchema || { type: "string" },
        requiredFields.has(fieldName),
      ),
    );
  }
  elements.inputDialog.showModal();
}

function showInputRequest(message) {
  configureInputDialog(false);
  elements.inputQuestions.replaceChildren();
  for (const question of message.params.questions || []) {
    const block = document.createElement("section");
    block.className = "question-block";
    block.dataset.questionId = question.id;

    const header = document.createElement("span");
    header.className = "question-header";
    header.textContent = question.header || "سؤال";
    const prompt = document.createElement("p");
    prompt.dir = "auto";
    prompt.textContent = question.question;
    block.append(header, prompt);

    if (question.options?.length) {
      const options = document.createElement("div");
      options.className = "question-options";
      for (const [index, option] of question.options.entries()) {
        const label = document.createElement("label");
        label.className = "question-option";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = `question-${question.id}`;
        radio.value = option.label;
        radio.required = index === 0;
        const description = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = option.label;
        const small = document.createElement("small");
        small.textContent = option.description;
        description.append(title, small);
        label.append(radio, description);
        options.append(label);
      }
      block.append(options);
    } else {
      const input = document.createElement(question.isSecret ? "input" : "textarea");
      input.className = "question-control";
      if (question.isSecret) {
        input.type = "password";
        input.autocomplete = "off";
      } else {
        input.rows = 3;
      }
      input.dir = "auto";
      input.required = true;
      input.name = `question-${question.id}`;
      block.append(input);
    }
    elements.inputQuestions.append(block);
  }
  elements.inputDialog.showModal();
}

function collectMcpFormContent(message) {
  const formData = new FormData(elements.inputForm);
  const content = {};
  const schema = message.params.requestedSchema || {};
  const requiredFields = new Set(schema.required || []);

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties || {})) {
    const controlName = `mcp:${fieldName}`;
    if (fieldSchema.type === "array") {
      const values = formData.getAll(controlName).map(String);
      const minimum = fieldSchema.minItems ?? (requiredFields.has(fieldName) ? 1 : 0);
      const maximum = fieldSchema.maxItems ?? Number.POSITIVE_INFINITY;
      if (values.length < minimum || values.length > maximum) {
        toast(
          `برای «${fieldSchema.title || fieldName}» بین ${minimum} تا ${
            Number.isFinite(maximum) ? maximum : "چند"
          } گزینه انتخاب کنید.`,
          "error",
        );
        return null;
      }
      if (values.length || requiredFields.has(fieldName)) content[fieldName] = values;
      continue;
    }

    const rawValue = formData.get(controlName);
    if ((rawValue === null || rawValue === "") && !requiredFields.has(fieldName)) {
      continue;
    }
    if (fieldSchema.type === "boolean") {
      content[fieldName] = rawValue === "true";
    } else if (fieldSchema.type === "number" || fieldSchema.type === "integer") {
      content[fieldName] = Number(rawValue);
    } else if (fieldSchema.format === "date-time" && rawValue) {
      content[fieldName] = new Date(String(rawValue)).toISOString();
    } else {
      content[fieldName] = String(rawValue ?? "");
    }
  }
  return content;
}

async function submitInputRequest(event) {
  event.preventDefault();
  const message = state.pendingInteractions.get(state.activeInteractionKey);
  if (!message) return;
  if (message.method === "mcpServer/elicitation/request") {
    const content = collectMcpFormContent(message);
    if (content === null) return;
    await respondToInteraction(
      message,
      { action: "accept", content, _meta: {} },
      "ارسال فرم MCP",
    );
    return;
  }
  const answers = {};
  for (const question of message.params.questions || []) {
    const control = elements.inputForm.elements.namedItem(`question-${question.id}`);
    let value = "";
    if (control instanceof RadioNodeList) value = control.value;
    else value = control?.value || "";
    answers[question.id] = { answers: [value] };
  }
  await respondToInteraction(message, { answers }, "ارسال پاسخ");
}

function handleRpcMessage(message) {
  if (message.method && Object.hasOwn(message, "id")) {
    queueInteraction(message);
    return;
  }
  if (message.method) handleNotification(message);
}

function connectEvents() {
  state.eventSource?.close();
  const events = new EventSource("/api/events");
  state.eventSource = events;
  events.addEventListener("status", (event) => {
    const data = JSON.parse(event.data);
    const changed = applyProviderStatusPayload(data);
    void hydrateThreadFromUrl();
    if (data.providers || (changed && data.ready)) {
      const refreshes = [refreshThreads()];
      if (!(state.modelsByProvider[state.settings.provider] || []).length) {
        refreshes.push(loadModels());
      }
      void Promise.allSettled(refreshes);
    }
  });
  events.addEventListener("rpc", (event) => {
    try {
      handleRpcMessage(JSON.parse(event.data));
    } catch (error) {
      console.error("Could not process Codex event", error);
    }
  });
  events.addEventListener("pending-interactions", (event) => {
    try {
      const data = JSON.parse(event.data);
      syncPendingInteractions(data.requests || []);
    } catch (error) {
      console.error("Could not restore pending Codex interactions", error);
    }
  });
  events.addEventListener("request-resolved", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.id !== undefined) {
        removePendingInteraction(data.id, data.threadId || null);
      }
    } catch (error) {
      console.error("Could not resolve Codex interaction", error);
    }
  });
  events.addEventListener("log", (event) => {
    const data = JSON.parse(event.data);
    console.debug("[codex app-server]", data.message);
  });
  events.onerror = () => markProviderConnectionsUnavailable("در حال اتصال دوباره…");
}

function renderModelOptions(
  models,
  selectedModel = "",
  provider = elements.providerSelect.value || state.settings.provider,
) {
  const defaultOption = elements.modelSelect.querySelector("option:first-child");
  if (defaultOption) defaultOption.textContent = `پیش‌فرض ${providerLabel(provider)}`;
  elements.modelSelect.querySelectorAll("option:not(:first-child)").forEach((node) => node.remove());
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.model || model.id;
    option.textContent = `${model.displayName}${model.isDefault ? " — پیش‌فرض" : ""}`;
    elements.modelSelect.append(option);
  }
  elements.modelSelect.value = models.some(
    (model) => (model.model || model.id) === selectedModel,
  )
    ? selectedModel
    : "";
}

async function loadModels(provider = state.settings.provider) {
  try {
    const result = await rpc("model/list", { limit: 100, provider });
    const models = (result.data || []).filter((model) => !model.hidden);
    state.modelsByProvider[provider] = models;
    const selectedModel = state.settings.modelByProvider[provider] || "";
    if (
      provider === state.settings.provider &&
      selectedModel &&
      !models.some((model) => (model.model || model.id) === selectedModel)
    ) {
      state.settings.modelByProvider[provider] = "";
      persistSettings();
    }
    if (provider === elements.providerSelect.value) {
      state.models = models;
      renderModelOptions(
        models,
        state.settings.modelByProvider[provider] || "",
        provider,
      );
      if (provider === state.settings.provider) updateModelLabel(provider);
    }
  } catch (error) {
    console.warn(`Could not load ${provider} models`, error);
  }
}

async function refreshProviderStatus() {
  try {
    const status = await api("/api/status", { headers: {} });
    applyProviderStatusPayload(status);
  } catch (error) {
    markProviderConnectionsUnavailable("سرور در دسترس نیست");
    console.warn("Could not refresh provider status", error);
  }
}

// The composer floats over the conversation, so the space the messages reserve
// at the bottom has to follow its real height. A fixed reserve meant a grown
// textarea buried the last messages with no way to scroll to them.
function syncComposerHeight() {
  const height = elements.composerWrap?.offsetHeight;
  if (!Number.isFinite(height) || height <= 0) return;
  const previous = state.composerHeight;
  if (previous === height) return;
  state.composerHeight = height;
  document.documentElement.style.setProperty("--composer-height", `${height}px`);
  // Growing the box would otherwise push the newest message out of sight.
  if (previous !== null && height > previous) scheduleScrollToBottom();
}

function resizePrompt() {
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 210)}px`;
  updateComposerControls();
  syncComposerHeight();
}

function sidebarUsesOverlay() {
  return window.matchMedia?.("(max-width: 820px)").matches ?? false;
}

function updateSidebarUi() {
  const overlay = sidebarUsesOverlay();
  const open = overlay
    ? document.body.classList.contains("sidebar-open")
    : !state.settings.sidebarCollapsed;
  document.body.classList.toggle(
    "sidebar-collapsed",
    !overlay && state.settings.sidebarCollapsed,
  );
  elements.sidebar.setAttribute("aria-hidden", String(!open));
  elements.sidebar.toggleAttribute("inert", !open);
  elements.menuButton.setAttribute("aria-expanded", String(open));
  elements.sidebarClose.setAttribute("aria-expanded", String(open));
}

function openSidebar() {
  if (sidebarUsesOverlay()) {
    document.body.classList.add("sidebar-open");
  } else if (state.settings.sidebarCollapsed) {
    state.settings.sidebarCollapsed = false;
    persistSettings();
  }
  updateSidebarUi();
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
  updateSidebarUi();
}

function collapseSidebar() {
  if (sidebarUsesOverlay()) {
    closeSidebar();
  } else {
    state.settings.sidebarCollapsed = true;
    persistSettings();
    updateSidebarUi();
  }
  elements.menuButton.focus();
}

let searchTimer;

// Attachments, the prompt queue and the goal strip all change the composer's
// height too, so observe the box rather than chasing each of them.
if (typeof ResizeObserver === "function" && elements.composerWrap) {
  new ResizeObserver(() => syncComposerHeight()).observe(elements.composerWrap);
} else {
  window.addEventListener("resize", syncComposerHeight);
}
syncComposerHeight();

elements.prompt.addEventListener("input", () => {
  if (state.slashDismissedValue !== elements.prompt.value) {
    state.slashDismissedValue = null;
  }
  saveCurrentDraft();
  resizePrompt();
});
elements.prompt.addEventListener("click", () => updateSlashCommandMenu());
elements.prompt.addEventListener("keyup", (event) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    updateSlashCommandMenu();
  }
});
elements.prompt.addEventListener("paste", handlePromptPaste);
elements.composer.addEventListener("dragenter", handleComposerDragEnter);
elements.composer.addEventListener("dragover", handleComposerDragOver);
elements.composer.addEventListener("dragleave", handleComposerDragLeave);
elements.composer.addEventListener("drop", handleComposerDrop);
elements.addImages.addEventListener("click", () => elements.imageInput.click());
elements.composerTools.addEventListener("click", toggleComposerToolsMenu);
elements.planModeOption.addEventListener("click", togglePlanMode);
elements.goalModeOption.addEventListener("click", openGoalDialog);
elements.goalEdit.addEventListener("click", openGoalDialog);
elements.goalToggle.addEventListener("click", () => void toggleGoalStatus());
elements.goalClear.addEventListener("click", () => void clearGoal());
elements.goalForm.addEventListener("submit", (event) => void saveGoalFromDialog(event));
elements.goalDialogCancel.addEventListener("click", () => elements.goalDialog.close());
elements.goalDialogClose.addEventListener("click", () => elements.goalDialog.close());
elements.dictate.addEventListener("click", toggleDictation);
elements.imageInput.addEventListener("change", () => {
  const files = [...elements.imageInput.files];
  const targetDraftKey = draftKey();
  elements.imageInput.value = "";
  void uploadAttachments(files, targetDraftKey);
});
elements.conversation.addEventListener(
  "scroll",
  () => {
    hideSelectionAsk();
    updateScrollState();
    scheduleUserMessageNavigationUpdate();
  },
  { passive: true },
);
elements.conversation.addEventListener("scrollend", updateScrollState, { passive: true });
elements.conversation.addEventListener("wheel", cancelScrollAnimation, { passive: true });
elements.conversation.addEventListener("touchstart", cancelScrollAnimation, { passive: true });
elements.conversation.addEventListener("pointerdown", cancelScrollAnimation, { passive: true });
elements.scrollBottom.addEventListener("click", () => {
  state.userNavigationItemId = null;
  elements.userMessageNavigationStatus.textContent = "";
  scrollToBottom(false, true);
  scheduleUserMessageNavigationUpdate();
});
elements.previousUserMessage.addEventListener("click", () =>
  navigateToUserMessage("previous"),
);
elements.nextUserMessage.addEventListener("click", () => navigateToUserMessage("next"));
elements.prompt.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  const slashMenuOpen = !elements.slashCommandMenu.classList.contains("hidden");
  const toolsMenuOpen = !elements.composerToolsMenu.classList.contains("hidden");
  if (toolsMenuOpen && event.key === "Escape") {
    event.preventDefault();
    closeComposerToolsMenu();
    return;
  }
  if (slashMenuOpen && event.key === "Escape") {
    event.preventDefault();
    closeSlashCommandMenu(true);
    return;
  }
  if (slashMenuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    moveSlashCommandSelection(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (
    slashMenuOpen &&
    event.key === "Tab" &&
    !event.shiftKey &&
    state.slashFilteredCommands.length
  ) {
    event.preventDefault();
    replacePromptWithSlashCommand(state.slashFilteredCommands[state.slashActiveIndex]);
    return;
  }
  if (event.key === "Tab" && event.shiftKey && !slashMenuOpen) {
    event.preventDefault();
    togglePlanMode();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (slashMenuOpen && state.slashFilteredCommands.length) {
      void activateHighlightedSlashCommand();
    } else {
      void sendPrompt();
    }
  }
});
elements.slashCommandOptions.addEventListener("pointerdown", (event) => {
  if (event.target.closest("[data-slash-command]")) event.preventDefault();
});
elements.slashCommandOptions.addEventListener("click", (event) => {
  const option = event.target.closest("[data-slash-command]");
  if (!option) return;
  const command = slashCommandByName(option.dataset.slashCommand);
  const index = state.slashFilteredCommands.findIndex(
    (candidate) => candidate.name === command?.name,
  );
  if (index >= 0) state.slashActiveIndex = index;
  void activateHighlightedSlashCommand();
});
elements.sendMessage.addEventListener("click", () => {
  if (
    !elements.slashCommandMenu.classList.contains("hidden") &&
    state.slashFilteredCommands.length
  ) {
    void activateHighlightedSlashCommand();
  } else {
    void sendPrompt();
  }
});
elements.promptQueueItems.addEventListener("click", (event) => {
  const action = event.target.closest("[data-queue-action]");
  const row = action?.closest("[data-queue-id]");
  if (!action || !row) return;
  removeQueuedPrompt(row.dataset.queueId, {
    edit: action.dataset.queueAction === "edit",
  });
});
elements.promptQueueClear.addEventListener("click", clearPromptQueue);
elements.stopTurn.addEventListener("click", stopTurn);
elements.newChat.addEventListener("click", () => newChat());
elements.projectAdd.addEventListener("click", () => {
  closeProjectMenus();
  openProjectDialog();
});
elements.projectChipAdd.addEventListener("click", () => {
  closeProjectMenus();
  openProjectDialog();
});
for (const descriptor of projectMenus) {
  descriptor.trigger.addEventListener("click", () => toggleProjectMenu(descriptor));
  descriptor.filter.addEventListener("input", renderProjects);
  descriptor.filter.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeProjectMenu(descriptor, { focusTrigger: true });
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveProjectHighlight(descriptor, event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activateHighlightedProject(descriptor);
    }
  });
  descriptor.list.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-project-edit]");
    if (edit) {
      closeProjectMenu(descriptor);
      openProjectDialog(projectById(edit.dataset.projectEdit));
      return;
    }
    const project = event.target.closest("[data-project-id]");
    if (!project) return;
    const projectId = project.dataset.projectId || null;
    closeProjectMenu(descriptor);
    if (descriptor.mode === "assign") assignChatProject(projectId);
    else selectProject(projectId);
  });
}
elements.modelChip.addEventListener("click", () => toggleProjectMenu(runChipMenu));
elements.providerOptions.addEventListener("click", (event) => {
  const option = event.target.closest("[data-provider-value]");
  if (!option) return;
  setRunProvider(option.dataset.providerValue);
});
elements.modelOptions.addEventListener("click", (event) => {
  const option = event.target.closest("[data-model-value]");
  if (!option) return;
  setRunSetting({ model: option.dataset.modelValue });
});
elements.effortOptions.addEventListener("click", (event) => {
  const option = event.target.closest("[data-effort-value]");
  if (!option) return;
  setRunSetting({ effort: option.dataset.effortValue });
});
document.addEventListener("click", (event) => {
  if (event.target.closest(".project-switcher")) return;
  closeProjectMenus();
});
elements.threadList.addEventListener("click", (event) => {
  if (event.target.closest("#thread-load-more")) {
    loadMoreThreads();
    return;
  }
  const button = event.target.closest("[data-thread-id]");
  if (button) openThread(button.dataset.threadId);
});
elements.threadSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refreshThreads(), 250);
});
elements.openSettings.addEventListener("click", () => openSettings());
elements.headerSettings.addEventListener("click", () => openSettings());
elements.usageButton.addEventListener("click", openUsageDialog);
elements.usageClose.addEventListener("click", closeUsageDialog);
elements.usageRefresh.addEventListener("click", () =>
  refreshRateLimits({ force: true }),
);
elements.usageDialog.addEventListener("close", () => {
  clearInterval(state.usageClockTimer);
  state.usageClockTimer = null;
});
elements.shareChat.addEventListener("click", () => refreshShare());
elements.projectForm.addEventListener("submit", saveProject);
elements.projectCancel.addEventListener("click", () => elements.projectDialog.close());
elements.projectDialogClose.addEventListener("click", () => elements.projectDialog.close());
elements.projectDelete.addEventListener("click", deleteProject);
elements.shareDialogClose.addEventListener("click", () => elements.shareDialog.close());
elements.shareCopy.addEventListener("click", copyShareLink);
elements.shareRefresh.addEventListener("click", () => refreshShare({ open: false }));
elements.shareRevoke.addEventListener("click", revokeShare);
elements.saveSettings.addEventListener("click", (event) => {
  event.preventDefault();
  saveSettings();
});
elements.settingsForm.addEventListener("submit", (event) => event.preventDefault());
elements.settingsCancel.addEventListener("click", () => elements.settingsDialog.close());
elements.settingsClose.addEventListener("click", () => elements.settingsDialog.close());
elements.settingsDialog.addEventListener("close", updateSettingsUi);
for (const input of document.querySelectorAll('input[name="accent-palette"]')) {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    for (const candidate of document.querySelectorAll('input[name="accent-palette"]')) {
      candidate.checked = candidate === input;
    }
    applyPalette(input.value);
  });
}
elements.providerSelect.addEventListener("change", () => {
  const provider = elements.providerSelect.value;
  updateSettingsProviderUi(provider);
  const cachedModels = state.modelsByProvider[provider] || [];
  renderModelOptions(
    cachedModels,
    state.settings.modelByProvider[provider] || "",
    provider,
  );
  void loadModels(provider);
});
elements.claudePermissionMode.addEventListener("change", () =>
  updateFullAccessWarning(elements.providerSelect.value),
);
elements.sandboxSelect.addEventListener("change", () =>
  updateFullAccessWarning(elements.providerSelect.value),
);
elements.menuButton.addEventListener("click", openSidebar);
elements.sidebarClose.addEventListener("click", collapseSidebar);
elements.mobileScrim.addEventListener("click", closeSidebar);
elements.approvalAccept.addEventListener("click", () => answerInteraction("accept"));
elements.approvalSession.addEventListener("click", () => answerInteraction("session"));
elements.approvalDecline.addEventListener("click", () => answerInteraction("decline"));
elements.approvalCancel.addEventListener("click", () => answerInteraction("cancel"));
elements.approvalLater.addEventListener("click", postponeInteraction);
elements.approvalDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  postponeInteraction();
});
elements.inputLater.addEventListener("click", postponeInteraction);
elements.inputDecline.addEventListener("click", () => answerInteraction("decline"));
elements.inputCancel.addEventListener("click", () => answerInteraction("cancel"));
elements.inputDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  postponeInteraction();
});
elements.inputForm.addEventListener("submit", submitInputRequest);
document.addEventListener("pointerdown", primeCompletionAudio, {
  capture: true,
  once: true,
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".composer")) closeSlashCommandMenu(true);
  if (!event.target.closest("#composer-tools, #composer-tools-menu")) {
    closeComposerToolsMenu();
  }
});
document.addEventListener("selectionchange", scheduleSelectionAskUpdate);
elements.messages.addEventListener("pointerup", scheduleSelectionAskUpdate);
elements.selectionAsk.addEventListener("pointerdown", (event) => event.preventDefault());
elements.selectionAsk.addEventListener("click", () => {
  const text = state.selectedAssistantText;
  if (!text) return;
  insertAssistantQuote(text);
  window.getSelection?.()?.removeAllRanges?.();
  hideSelectionAsk();
});
document.addEventListener("keydown", primeCompletionAudio, {
  capture: true,
  once: true,
});
document.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "d") {
    event.preventDefault();
    toggleDictation();
  }
});
window.addEventListener(
  "resize",
  () => {
    hideSelectionAsk();
    scheduleUserMessageNavigationUpdate();
    updateSidebarUi();
  },
  { passive: true },
);
window.addEventListener("popstate", (event) => {
  void hydrateThreadFromUrl({
    draftId:
      typeof event.state?.draftId === "string" && event.state.draftId
        ? event.state.draftId
        : null,
    force: true,
  });
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    if (state.currentThreadId) {
      markThreadSeen(state.currentThreadId);
      renderThreadList();
    }
    if (Date.now() - state.rateLimitsFetchedAt > 5 * 60_000) {
      void refreshRateLimits({ silent: true });
    }
  }
});
elements.messages.addEventListener("click", async (event) => {
  const messageAction = event.target.closest("[data-message-action]");
  if (messageAction) {
    const row = messageAction.closest(".message-row.assistant");
    const view = row ? state.itemViews.get(row.dataset.itemId) : null;
    const text = view?.text || row?.querySelector(".message-content")?.textContent || "";
    if (!text) return;
    if (messageAction.dataset.messageAction === "quote") {
      insertAssistantQuote(text);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      const label = messageAction.querySelector("span");
      messageAction.classList.add("success");
      if (label) label.textContent = "کپی شد";
      setTimeout(() => {
        messageAction.classList.remove("success");
        if (label) label.textContent = "کپی";
      }, 1200);
    } catch {
      toast("کپی‌کردن ممکن نبود.", "error");
    }
    return;
  }

  const button = event.target.closest(".copy-code");
  if (!button) return;
  const code = button.parentElement.querySelector("code")?.textContent || "";
  try {
    await navigator.clipboard.writeText(code);
    button.textContent = "کپی شد";
    setTimeout(() => (button.textContent = "کپی"), 1200);
  } catch {
    toast("کپی‌کردن ممکن نبود.", "error");
  }
});

async function initialize() {
  updateSidebarUi();
  updateSettingsUi();
  updateConnection();
  resizePrompt();
  connectEvents();
  try {
    const status = await api("/api/status", { headers: {} });
    if (status.cwd && state.settings.cwd === defaultSettings.cwd) {
      state.settings.cwd = status.cwd;
      persistSettings();
      updateSettingsUi();
    }
    applyProviderStatusPayload(status);
    await loadProjects();
    await Promise.allSettled([
      loadModels(),
      loadCollaborationModes(),
      refreshAgentCommands({ force: true }),
      refreshThreads(),
      hydrateThreadFromUrl(),
      refreshRateLimits({ force: true, silent: true }),
    ]);
  } catch (error) {
    markProviderConnectionsUnavailable("سرور در دسترس نیست");
    showError(error, "اتصال به سرور");
  }
}

initialize();
