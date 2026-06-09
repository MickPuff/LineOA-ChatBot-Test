const state = {
  conversations: [],
  filteredConversations: [],
  selectedConversationId: null,
  selectedMessages: [],
  selectedSettings: null,
  activeFilter: 'line',
  currentPage: getCurrentPage(),
  settings: null,
  eventSource: null,
  hasConnectedEvents: false,
  hasLoadedConversations: false,
  isLoadingConversations: false,
  seenUserMessageCounts: new Map(),
  unreadUserMessageCounts: new Map(),
};

const elements = {
  list: document.querySelector('#conversation-list'),
  search: document.querySelector('#search'),
  messages: document.querySelector('#messages'),
  emptyState: document.querySelector('#empty-state'),
  title: document.querySelector('#conversation-title'),
  meta: document.querySelector('#conversation-meta'),
  conversationAvatar: document.querySelector('#conversation-avatar'),
  chatBotStatus: document.querySelector('#chat-bot-status'),
  filterButtons: [...document.querySelectorAll('.queue-tabs button[data-filter]')],
  navButtons: [...document.querySelectorAll('.nav-item')],
  adminReplyInput: document.querySelector('#admin-reply-input'),
  adminReplyButton: document.querySelector('#admin-reply-button'),
  copyIdButton: document.querySelector('#copy-id-button'),
  exportButton: document.querySelector('#export-button'),
  detailAiToggle: document.querySelector('#detail-ai-toggle'),
  detailAiLabel: document.querySelector('#detail-ai-label'),
  detailBotSelectWrap: document.querySelector('#detail-bot-select-wrap'),
  detailBotSelect: document.querySelector('#detail-bot-select'),
  toast: document.querySelector('#toast'),
  pages: [...document.querySelectorAll('.page[data-page]')],
  metricConversations: document.querySelector('#metric-conversations'),
  metricLine: document.querySelector('#metric-line'),
  metricWebsite: document.querySelector('#metric-website'),
  metricFb: document.querySelector('#metric-fb'),
  detailTitle: document.querySelector('#detail-title'),
  detailId: document.querySelector('#detail-id'),
  detailCount: document.querySelector('#detail-count'),
  detailUserCount: document.querySelector('#detail-user-count'),
  detailAssistantCount: document.querySelector('#detail-assistant-count'),
  detailLastAt: document.querySelector('#detail-last-at'),
  detailChannelTag: document.querySelector('#detail-channel-tag'),
  detailAvatar: document.querySelector('#detail-avatar'),
  detailTags: document.querySelector('#detail-tags'),
  tagInput: document.querySelector('#tag-input'),
  saveTagsButton: document.querySelector('#save-tags-button'),
  baselineSystemPromptInput: document.querySelector('#baseline-system-prompt-input'),
  tagAwareSystemPromptInput: document.querySelector('#tag-aware-system-prompt-input'),
  saveSettingsButton: document.querySelector('#save-settings-button'),
  resetPromptButton: document.querySelector('#reset-prompt-button'),
  settingsModel: document.querySelector('#settings-model'),
  settingsStorage: document.querySelector('#settings-storage'),
  settingsContext: document.querySelector('#settings-context'),
  settingsTtl: document.querySelector('#settings-ttl'),
};

elements.search.addEventListener('input', () => filterConversations());
elements.filterButtons.forEach((button) => {
  button.addEventListener('click', () => setActiveFilter(button.dataset.filter));
});
elements.adminReplyButton.addEventListener('click', () => sendAdminReply());
elements.adminReplyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendAdminReply();
  }
});
elements.copyIdButton.addEventListener('click', () => copySelectedConversationId());
elements.exportButton.addEventListener('click', () => exportSelectedConversation());
elements.detailAiToggle.addEventListener('change', () => {
  if (state.selectedConversationId) {
    updateConversationAi(state.selectedConversationId, elements.detailAiToggle.checked);
  }
});
elements.detailBotSelect.addEventListener('change', () => {
  if (state.selectedConversationId) {
    updateConversationBot(state.selectedConversationId, elements.detailBotSelect.value);
  }
});
elements.tagInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addTagFromInput();
  }
});
elements.saveTagsButton.addEventListener('click', () => saveSelectedTags());
elements.saveSettingsButton.addEventListener('click', () => saveBotSettings());
elements.resetPromptButton.addEventListener('click', () => useDefaultPrompt());

renderCurrentPage();
updateComposerState();

if (state.currentPage === 'inbox') {
  loadConversations().finally(() => connectAdminEvents());
}

if (state.currentPage === 'settings') {
  loadSettings();
}

async function loadConversations({ silent = false } = {}) {
  if (state.isLoadingConversations) {
    return;
  }

  state.isLoadingConversations = true;

  try {
    const data = await fetchJson('/api/admin/conversations');
    const conversations = data.conversations || [];

    updateUnreadState(conversations);
    state.conversations = conversations;
    updateMetrics(data.totals);
    filterConversations();

    if (state.selectedConversationId) {
      const stillExists = state.conversations.some(
        (conversation) => conversation.conversationId === state.selectedConversationId,
      );

      if (stillExists) {
        await selectConversation(state.selectedConversationId);
      } else {
        clearSelection();
      }
    }
  } catch (error) {
    if (!silent) {
      showToast(error.message || 'Could not load conversations.');
    }
  } finally {
    state.isLoadingConversations = false;
  }
}

function connectAdminEvents() {
  if (!window.EventSource || state.eventSource) {
    return;
  }

  const eventSource = new EventSource('/api/admin/events');
  state.eventSource = eventSource;

  eventSource.addEventListener('connected', () => {
    if (state.hasConnectedEvents && state.hasLoadedConversations) {
      loadConversations({ silent: true });
    }

    state.hasConnectedEvents = true;
  });

  eventSource.addEventListener('conversation-updated', (event) => {
    applyConversationUpdate(parseEventData(event));
  });

  eventSource.addEventListener('conversation-cleared', (event) => {
    applyConversationCleared(parseEventData(event));
  });

  eventSource.addEventListener('conversation-settings-updated', (event) => {
    applyConversationSettingsUpdate(parseEventData(event));
  });

  eventSource.addEventListener('error', () => {
    showToast('Live updates disconnected. Reconnecting...');
  });
}

function applyConversationUpdate(payload) {
  if (!payload?.conversation?.conversationId) {
    return;
  }

  const conversationId = payload.conversation.conversationId;

  mergeConversation(payload.conversation);

  if (
    state.selectedConversationId === conversationId &&
    payload.message &&
    !hasSelectedMessage(payload.message)
  ) {
    state.selectedMessages = [...state.selectedMessages, payload.message];
    markConversationRead(conversationId);
    renderSelectedConversation();
  }
}

function applyConversationCleared(payload) {
  const conversationId = payload?.conversationId;

  if (!conversationId) {
    return;
  }

  state.conversations = state.conversations.filter(
    (conversation) => conversation.conversationId !== conversationId,
  );
  state.seenUserMessageCounts.delete(conversationId);
  state.unreadUserMessageCounts.delete(conversationId);
  updateMetricsFromState();

  if (state.selectedConversationId === conversationId) {
    clearSelection();
  } else {
    filterConversations();
  }
}

function applyConversationSettingsUpdate(payload) {
  const conversationId = payload?.conversationId;

  if (!conversationId || !payload.settings) {
    return;
  }

  state.conversations = state.conversations.map((conversation) =>
    conversation.conversationId === conversationId
      ? { ...conversation, ...payload.settings }
      : conversation,
  );

  filterConversations();

  if (state.selectedConversationId === conversationId) {
    state.selectedSettings = {
      ...state.selectedSettings,
      ...payload.settings,
    };
    updateSelectedConversationDetails(
      state.conversations.find((conversation) => conversation.conversationId === conversationId),
    );
  }
}

function mergeConversation(conversation) {
  const conversationId = conversation.conversationId;
  const previousUserMessages = state.seenUserMessageCounts.get(conversationId);
  const currentUserMessages = conversation.userMessageCount || 0;
  const existingIndex = state.conversations.findIndex(
    (item) => item.conversationId === conversationId,
  );

  if (existingIndex >= 0) {
    state.conversations.splice(existingIndex, 1, conversation);
  } else {
    state.conversations.push(conversation);
  }

  state.conversations.sort(sortConversationSummaries);

  if (conversationId === state.selectedConversationId) {
    state.seenUserMessageCounts.set(conversationId, currentUserMessages);
    state.unreadUserMessageCounts.set(conversationId, 0);
  } else if (previousUserMessages === undefined) {
    state.seenUserMessageCounts.set(conversationId, currentUserMessages);
    state.unreadUserMessageCounts.set(conversationId, currentUserMessages);
  } else {
    if (currentUserMessages > previousUserMessages) {
      const currentUnread = state.unreadUserMessageCounts.get(conversationId) || 0;
      state.unreadUserMessageCounts.set(
        conversationId,
        currentUnread + currentUserMessages - previousUserMessages,
      );
    }

    state.seenUserMessageCounts.set(conversationId, currentUserMessages);
  }

  updateMetricsFromState();
  filterConversations();
}

function parseEventData(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function filterConversations() {
  const query = elements.search.value.trim().toLowerCase();
  const byFilter = state.conversations.filter((conversation) =>
    matchesActiveFilter(conversation),
  );

  state.filteredConversations = query
    ? byFilter.filter((conversation) =>
        [
          conversation.conversationId,
          conversation.title,
          conversation.lastText,
          conversation.lastRole,
          conversation.channel,
          ...(conversation.tags || []),
        ]
          .join(' ')
          .toLowerCase()
          .includes(query),
      )
    : [...byFilter];

  renderConversationList();
}

function renderConversationList() {
  elements.list.replaceChildren();

  if (state.filteredConversations.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = getEmptyListMessage();
    elements.list.append(empty);
    return;
  }

  for (const conversation of state.filteredConversations) {
    const unreadCount = getUnreadCount(conversation.conversationId);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'conversation-item';
    item.classList.toggle(
      'active',
      conversation.conversationId === state.selectedConversationId,
    );
    item.addEventListener('click', () => selectConversation(conversation.conversationId));

    const avatar = document.createElement('div');
    avatar.className = `avatar${unreadCount > 0 ? ' has-unread' : ''}`;
    setAvatar(avatar, conversation);

    const body = document.createElement('div');
    body.className = 'conversation-main';

    const topRow = document.createElement('div');
    topRow.className = 'conversation-row';

    const title = document.createElement('div');
    title.className = 'conversation-title';
    title.textContent = getConversationDisplayName(conversation);

    const time = document.createElement('div');
    time.className = 'conversation-time';
    time.textContent = formatRelativeDate(conversation.lastAt);

    const preview = document.createElement('div');
    preview.className = 'conversation-preview';
    preview.textContent = conversation.lastText || 'No saved gold request yet';

    const tags = document.createElement('div');
    tags.className = 'conversation-tags';

    const dot = document.createElement('span');
    dot.className = `status-dot${unreadCount > 0 ? ' has-unread' : ''}`;

    const badge = document.createElement('span');
    badge.className = `badge unread-badge${unreadCount > 0 ? ' has-unread' : ''}`;
    badge.textContent = unreadCount > 0 ? `${unreadCount} unread` : 'Read';

    const aiEnabled = conversation.aiEnabled !== false;
    const aiButton = document.createElement('button');
    aiButton.type = 'button';
    aiButton.className = aiEnabled
      ? `mini-toggle bot-badge ${getBotId(conversation)}`
      : 'mini-toggle is-off';
    aiButton.textContent = aiEnabled ? getBotLabel(conversation.botId) : 'AI off';
    aiButton.title = aiEnabled ? 'Disable AI for this customer' : 'Enable AI for this customer';
    aiButton.addEventListener('click', (event) => {
      event.stopPropagation();
      updateConversationAi(conversation.conversationId, conversation.aiEnabled === false);
    });

    topRow.append(title, time);
    tags.append(dot, badge, aiButton);

    for (const tag of conversation.tags || []) {
      const tagBadge = document.createElement('span');
      tagBadge.className = 'badge customer-tag';
      tagBadge.textContent = tag;
      tags.append(tagBadge);
    }

    body.append(topRow, preview, tags);
    item.append(avatar, body);
    elements.list.append(item);
  }
}

async function selectConversation(conversationId) {
  state.selectedConversationId = conversationId;
  markConversationRead(conversationId);
  renderConversationList();

  try {
    const data = await fetchJson(`/api/admin/conversations/${encodeURIComponent(conversationId)}`);
    state.selectedMessages = data.messages || [];
    state.selectedSettings = data.settings || null;
    renderSelectedConversation();
  } catch (error) {
    showToast(error.message || 'Could not load this conversation.');
  }
}

function renderSelectedConversation() {
  const summary = state.conversations.find(
    (conversation) => conversation.conversationId === state.selectedConversationId,
  );

  elements.emptyState.style.display = 'none';
  elements.messages.replaceChildren();
  elements.copyIdButton.disabled = false;
  elements.exportButton.disabled = false;

  const displayName = getConversationDisplayName(summary);

  elements.title.textContent = displayName;
  elements.meta.textContent = `${state.selectedMessages.length} saved messages`;
  elements.detailTitle.textContent = displayName;
  setAvatar(elements.conversationAvatar, summary);
  setAvatar(elements.detailAvatar, summary);

  elements.detailId.textContent = state.selectedConversationId;
  elements.detailCount.textContent = String(state.selectedMessages.length);
  elements.detailUserCount.textContent = String(
    state.selectedMessages.filter((message) => message.role === 'user').length,
  );
  elements.detailAssistantCount.textContent = String(
    state.selectedMessages.filter((message) => message.role === 'assistant').length,
  );
  elements.detailLastAt.textContent = formatRelativeDate(summary?.lastAt);
  updateSelectedConversationDetails(summary);

  for (const message of state.selectedMessages) {
    elements.messages.append(createMessageNode(message));
  }

  updateComposerState();
  requestAnimationFrame(() => {
    const stage = document.querySelector('.conversation-stage');
    stage.scrollTop = stage.scrollHeight;
  });
}

function createMessageNode(message) {
  const wrapper = document.createElement('article');
  wrapper.className = `message ${message.role || 'system'}`;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = `${getMessageSenderLabel(message)} - ${formatDate(message.at)}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = message.text || '';

  wrapper.append(meta, bubble);

  if (message.role === 'assistant' && message.from !== 'admin') {
    wrapper.append(createPerformanceWidget(message.usage));
  }

  return wrapper;
}

function createPerformanceWidget(usage) {
  const details = document.createElement('details');
  details.className = 'performance-widget';

  const summary = document.createElement('summary');
  summary.textContent = 'Performance';

  const body = document.createElement('div');
  body.className = 'performance-grid';

  const metrics = [
    ['Input tokens', usage?.inputTokens],
    ['Output tokens', usage?.outputTokens],
    ['Total tokens', usage?.totalTokens],
  ];

  for (const [label, value] of metrics) {
    const item = document.createElement('span');
    item.textContent = `${label}: ${Number.isFinite(value) ? formatNumber(value) : '-'}`;
    body.append(item);
  }

  details.append(summary, body);
  return details;
}

function clearSelection() {
  state.selectedConversationId = null;
  state.selectedMessages = [];
  state.selectedSettings = null;
  elements.messages.replaceChildren();
  elements.emptyState.style.display = 'grid';
  elements.copyIdButton.disabled = true;
  elements.exportButton.disabled = true;
  elements.title.textContent = 'Select a customer';
  elements.meta.textContent = 'No conversation selected';
  elements.detailTitle.textContent = 'New Customer';
  elements.detailId.textContent = '-';
  elements.detailCount.textContent = '-';
  elements.detailUserCount.textContent = '-';
  elements.detailAssistantCount.textContent = '-';
  elements.detailLastAt.textContent = '-';
  elements.detailChannelTag.textContent = 'Gold lead';
  elements.chatBotStatus.textContent = 'AI - Gold Seller';
  setAvatar(elements.conversationAvatar, null);
  setAvatar(elements.detailAvatar, null);
  elements.detailTags.replaceChildren();
  elements.tagInput.value = '';
  elements.tagInput.disabled = true;
  elements.saveTagsButton.disabled = true;
  elements.detailAiToggle.checked = true;
  elements.detailAiToggle.disabled = true;
  elements.detailAiLabel.textContent = 'AI enabled';
  elements.detailBotSelect.value = 'tagAware';
  elements.detailBotSelect.disabled = true;
  elements.detailBotSelectWrap.hidden = true;
  updateComposerState();
  renderConversationList();
}

async function copySelectedConversationId() {
  if (!state.selectedConversationId) {
    return;
  }

  await navigator.clipboard.writeText(state.selectedConversationId);
  showToast('Conversation ID copied.');
}

function exportSelectedConversation() {
  if (!state.selectedConversationId) {
    return;
  }

  const payload = {
    conversationId: state.selectedConversationId,
    exportedAt: new Date().toISOString(),
    messages: state.selectedMessages,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = `${state.selectedConversationId.replace(/[^a-z0-9_-]+/gi, '_')}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function sendAdminReply() {
  const text = elements.adminReplyInput.value.trim();

  if (!state.selectedConversationId) {
    showToast('Select a customer conversation first.');
    return;
  }

  if (!isAdminReplySupportedConversation(state.selectedConversationId)) {
    showToast('Admin replies support LINE and website chats.');
    return;
  }

  if (!text) {
    showToast('Type a reply before sending.');
    return;
  }

  elements.adminReplyButton.disabled = true;
  elements.adminReplyInput.disabled = true;

  try {
    const data = await fetchJson(`/api/admin/conversations/${encodeURIComponent(state.selectedConversationId)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    elements.adminReplyInput.value = '';
    applyConversationUpdate(data);
    showToast(getSelectedChannel() === 'website' ? 'Admin reply sent to website chat.' : 'Admin reply sent to LINE and saved.');
  } catch (error) {
    showToast(error.message || 'Could not send admin reply.');
  } finally {
    updateComposerState();
  }
}

async function updateConversationAi(conversationId, aiEnabled) {
  try {
    const data = await fetchJson(`/api/admin/conversations/${encodeURIComponent(conversationId)}/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ aiEnabled }),
    });

    state.conversations = state.conversations.map((conversation) =>
      conversation.conversationId === conversationId
        ? { ...conversation, aiEnabled: data.settings.aiEnabled }
        : conversation,
    );

    filterConversations();

    if (state.selectedConversationId === conversationId) {
      state.selectedSettings = {
        ...state.selectedSettings,
        aiEnabled: data.settings.aiEnabled,
      };
      updateSelectedConversationDetails(
        state.conversations.find((conversation) => conversation.conversationId === conversationId),
      );
    }

    showToast(data.settings.aiEnabled ? 'AI enabled for this customer.' : 'AI disabled for this customer.');
  } catch (error) {
    showToast(error.message || 'Could not update AI status.');
    if (state.selectedConversationId) {
      renderSelectedConversation();
    } else {
      renderConversationList();
    }
  }
}

async function updateConversationBot(conversationId, botId) {
  try {
    const data = await fetchJson(`/api/admin/conversations/${encodeURIComponent(conversationId)}/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ botId }),
    });

    state.conversations = state.conversations.map((conversation) =>
      conversation.conversationId === conversationId
        ? { ...conversation, botId: data.settings.botId }
        : conversation,
    );

    filterConversations();

    if (state.selectedConversationId === conversationId) {
      state.selectedSettings = {
        ...state.selectedSettings,
        botId: data.settings.botId,
      };
      updateSelectedConversationDetails(
        state.conversations.find((conversation) => conversation.conversationId === conversationId),
      );
    }

    showToast(`${getBotLabel(data.settings.botId)} selected for this customer.`);
  } catch (error) {
    showToast(error.message || 'Could not update selected bot.');
    updateSelectedConversationDetails(getSelectedSummary());
  }
}

function updateSelectedConversationDetails(summary) {
  const aiEnabled = summary?.aiEnabled !== false;
  const channel = summary?.channel || getChannelFromConversationId(summary?.conversationId || state.selectedConversationId);
  const tags = state.selectedSettings?.tags || summary?.tags || [];
  const botId = state.selectedSettings?.botId || summary?.botId || 'tagAware';

  elements.detailAiToggle.disabled = !state.selectedConversationId;
  elements.detailAiToggle.checked = aiEnabled;
  elements.detailAiLabel.textContent = aiEnabled ? 'AI enabled' : 'AI disabled';
  elements.detailBotSelectWrap.hidden = !aiEnabled;
  elements.detailBotSelect.disabled = !state.selectedConversationId || !aiEnabled;
  elements.detailBotSelect.value = getBotId({ botId });
  elements.chatBotStatus.textContent = aiEnabled ? `AI - ${getBotLabel(botId)}` : 'AI disabled';
  elements.detailChannelTag.textContent = getChannelLabel(channel);
  elements.tagInput.disabled = !state.selectedConversationId;
  elements.saveTagsButton.disabled = !state.selectedConversationId;
  renderTagEditor(tags);
}

function renderTagEditor(tags = []) {
  elements.detailTags.replaceChildren();

  if (tags.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'muted small-muted';
    empty.textContent = 'No tags yet';
    elements.detailTags.append(empty);
    return;
  }

  for (const tag of tags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-chip';
    chip.textContent = `${tag} x`;
    chip.title = `Remove ${tag}`;
    chip.addEventListener('click', () => removeSelectedTag(tag));
    elements.detailTags.append(chip);
  }
}

function addTagFromInput() {
  const tag = elements.tagInput.value.trim();

  if (!state.selectedConversationId || !tag) {
    return;
  }

  const currentTags = state.selectedSettings?.tags || getSelectedSummary()?.tags || [];
  const nextTags = normalizeTags([...currentTags, tag]);

  state.selectedSettings = {
    ...state.selectedSettings,
    tags: nextTags,
  };
  elements.tagInput.value = '';
  renderTagEditor(nextTags);
}

function removeSelectedTag(tag) {
  const currentTags = state.selectedSettings?.tags || getSelectedSummary()?.tags || [];
  const nextTags = currentTags.filter((item) => item !== tag);

  state.selectedSettings = {
    ...state.selectedSettings,
    tags: nextTags,
  };
  renderTagEditor(nextTags);
}

async function saveSelectedTags() {
  if (!state.selectedConversationId) {
    return;
  }

  addTagFromInput();
  const tags = state.selectedSettings?.tags || [];
  elements.saveTagsButton.disabled = true;

  try {
    const data = await fetchJson(`/api/admin/conversations/${encodeURIComponent(state.selectedConversationId)}/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tags }),
    });

    state.selectedSettings = data.settings;
    state.conversations = state.conversations.map((conversation) =>
      conversation.conversationId === state.selectedConversationId
        ? { ...conversation, tags: data.settings.tags }
        : conversation,
    );
    filterConversations();
    renderTagEditor(data.settings.tags);
    showToast('Customer tags saved.');
  } catch (error) {
    showToast(error.message || 'Could not save customer tags.');
  } finally {
    elements.saveTagsButton.disabled = !state.selectedConversationId;
  }
}

async function loadSettings() {
  try {
    const settings = await fetchJson('/api/admin/settings');
    state.settings = settings;
    elements.baselineSystemPromptInput.value =
      settings.bots?.baseline?.systemInstruction || settings.defaultSystemInstruction || '';
    elements.tagAwareSystemPromptInput.value =
      settings.bots?.tagAware?.systemInstruction || settings.defaultSystemInstruction || '';
    elements.settingsModel.textContent = settings.geminiModel || '-';
    elements.settingsStorage.textContent = settings.storageProvider || '-';
    elements.settingsContext.textContent = `${settings.maxContextMessages || '-'} recent messages`;
    elements.settingsTtl.textContent = `${settings.processedEventTtlSeconds || '-'} seconds`;
  } catch (error) {
    showToast(error.message || 'Could not load settings.');
  }
}

async function saveBotSettings() {
  const baselineSystemInstruction = elements.baselineSystemPromptInput.value.trim();
  const tagAwareSystemInstruction = elements.tagAwareSystemPromptInput.value.trim();

  if (!baselineSystemInstruction || !tagAwareSystemInstruction) {
    showToast('Both bot prompts are required.');
    return;
  }

  elements.saveSettingsButton.disabled = true;

  try {
    const data = await fetchJson('/api/admin/settings', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bots: {
          baseline: { systemInstruction: baselineSystemInstruction },
          tagAware: { systemInstruction: tagAwareSystemInstruction },
        },
      }),
    });

    state.settings = {
      ...state.settings,
      bots: data.settings.bots,
    };
    elements.baselineSystemPromptInput.value = data.settings.bots.baseline.systemInstruction;
    elements.tagAwareSystemPromptInput.value = data.settings.bots.tagAware.systemInstruction;
    showToast('Bot prompts saved in Redis.');
  } catch (error) {
    showToast(error.message || 'Could not save settings.');
  } finally {
    elements.saveSettingsButton.disabled = false;
  }
}

async function useDefaultPrompt() {
  if (!state.settings?.defaultSystemInstruction) {
    await loadSettings();
  }

  elements.baselineSystemPromptInput.value = state.settings?.defaultSystemInstruction || '';
  elements.tagAwareSystemPromptInput.value = state.settings?.defaultSystemInstruction || '';
  await saveBotSettings();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    let errorMessage = `Request failed with HTTP ${response.status}`;

    try {
      const errorBody = await response.json();
      errorMessage = errorBody.error || errorMessage;
    } catch {
      // Keep the HTTP status fallback when the server did not return JSON.
    }

    throw new Error(errorMessage);
  }

  return response.json();
}

function updateMetrics(totals = {}) {
  elements.metricConversations.textContent = `${formatNumber(totals.conversations || 0)} chats`;
  elements.metricLine.textContent = formatNumber(
    state.conversations.filter((conversation) => getConversationChannel(conversation) === 'line').length,
  );
  elements.metricWebsite.textContent = formatNumber(
    state.conversations.filter((conversation) => getConversationChannel(conversation) === 'website').length,
  );
  elements.metricFb.textContent = formatNumber(
    state.conversations.filter((conversation) => getConversationChannel(conversation) === 'fb').length,
  );
}

function updateMetricsFromState() {
  updateMetrics({ conversations: state.conversations.length });
}

function updateUnreadState(conversations) {
  for (const conversation of conversations) {
    const id = conversation.conversationId;
    const currentUserMessages = conversation.userMessageCount || 0;
    const previousUserMessages = state.seenUserMessageCounts.get(id);

    if (id === state.selectedConversationId) {
      state.seenUserMessageCounts.set(id, currentUserMessages);
      state.unreadUserMessageCounts.set(id, 0);
      continue;
    }

    if (previousUserMessages === undefined) {
      state.seenUserMessageCounts.set(id, currentUserMessages);
      state.unreadUserMessageCounts.set(id, state.hasLoadedConversations ? currentUserMessages : 0);
      continue;
    }

    if (currentUserMessages > previousUserMessages) {
      const currentUnread = state.unreadUserMessageCounts.get(id) || 0;
      state.unreadUserMessageCounts.set(
        id,
        currentUnread + currentUserMessages - previousUserMessages,
      );
    }

    state.seenUserMessageCounts.set(id, currentUserMessages);
  }

  const currentIds = new Set(conversations.map((conversation) => conversation.conversationId));

  for (const id of state.unreadUserMessageCounts.keys()) {
    if (!currentIds.has(id)) {
      state.unreadUserMessageCounts.delete(id);
      state.seenUserMessageCounts.delete(id);
    }
  }

  state.hasLoadedConversations = true;
}

function hasSelectedMessage(message) {
  return state.selectedMessages.some((existingMessage) =>
    existingMessage.role === message.role &&
    existingMessage.text === message.text &&
    existingMessage.at === message.at &&
    (existingMessage.from || '') === (message.from || ''),
  );
}

function getUnreadCount(conversationId) {
  return state.unreadUserMessageCounts.get(conversationId) || 0;
}

function markConversationRead(conversationId) {
  const conversation = state.conversations.find((item) => item.conversationId === conversationId);

  state.unreadUserMessageCounts.set(conversationId, 0);

  if (conversation) {
    state.seenUserMessageCounts.set(conversationId, conversation.userMessageCount || 0);
  }
}

function setActiveFilter(filter) {
  state.activeFilter = filter;
  elements.filterButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === filter);
  });
  filterConversations();
}

function matchesActiveFilter(conversation) {
  return getConversationChannel(conversation) === state.activeFilter;
}

function sortConversationSummaries(left, right) {
  const leftTime = left.lastAt ? Date.parse(left.lastAt) : 0;
  const rightTime = right.lastAt ? Date.parse(right.lastAt) : 0;
  return rightTime - leftTime;
}

function renderCurrentPage() {
  elements.pages.forEach((page) => {
    page.classList.toggle('active', page.dataset.page === state.currentPage);
  });

  elements.navButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.page === state.currentPage);
  });
}

function updateComposerState() {
  const canReply = isAdminReplySupportedConversation(state.selectedConversationId);
  elements.adminReplyInput.disabled = !canReply;
  elements.adminReplyButton.disabled = !canReply;
  elements.adminReplyInput.placeholder = canReply
    ? 'Reply as admin to this customer'
    : 'Select a LINE or website chat to reply';
}

function isPushableLineConversation(conversationId) {
  return ['user:', 'group:', 'room:'].some((prefix) => conversationId?.startsWith(prefix));
}

function isAdminReplySupportedConversation(conversationId) {
  return isPushableLineConversation(conversationId) || conversationId?.startsWith('website:');
}

function getEmptyListMessage() {
  if (state.activeFilter === 'line') {
    return 'No LINE chats found.';
  }

  if (state.activeFilter === 'website') {
    return 'No website chats found.';
  }

  if (state.activeFilter === 'fb') {
    return 'FB Messenger support is ready for future chats.';
  }

  return 'No chats found.';
}

function formatDate(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatRelativeDate(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const diffMs = Date.now() - date.getTime();
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (diffMs < minuteMs) {
    return 'now';
  }

  if (diffMs < hourMs) {
    return `${Math.max(1, Math.floor(diffMs / minuteMs))} min`;
  }

  if (diffMs < dayMs) {
    return `${Math.floor(diffMs / hourMs)} hr`;
  }

  if (diffMs < 10 * dayMs) {
    return `${Math.floor(diffMs / dayMs)} days ago`;
  }

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
  }).format(date);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function getMessageSenderLabel(message) {
  if (message.role === 'user') {
    return 'Customer';
  }

  if (message.from === 'admin') {
    return 'Admin';
  }

  if (message.role === 'assistant') {
    return message.botName || getBotLabel(message.botId);
  }

  return message.role || 'unknown';
}

function getConversationDisplayName(conversation) {
  if (!conversation) {
    return 'New Customer';
  }

  const id = conversation.conversationId || '';
  const title = conversation.title && conversation.title !== id ? conversation.title : '';

  if (id.startsWith('website:')) {
    return title || 'Website Customer';
  }

  if (id.startsWith('group:')) {
    return title || 'Gold Group';
  }

  if (id.startsWith('room:')) {
    return title || 'Gold Chat Room';
  }

  return title || 'New Customer';
}

function setAvatar(avatar, conversation) {
  if (!avatar) {
    return;
  }

  const displayName = getConversationDisplayName(conversation);
  const fallback = getAvatarFallback(displayName);

  avatar.classList.remove('with-image');
  avatar.replaceChildren();

  if (conversation?.profilePictureUrl) {
    const image = document.createElement('img');
    image.src = conversation.profilePictureUrl;
    image.alt = `${displayName} profile picture`;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => {
      if (image.parentElement !== avatar) {
        return;
      }

      avatar.classList.remove('with-image');
      avatar.textContent = fallback;
    });
    avatar.classList.add('with-image');
    avatar.append(image);
    appendChannelIcon(avatar, conversation);
    return;
  }

  avatar.textContent = fallback;
  appendChannelIcon(avatar, conversation);
}

function getAvatarFallback(displayName) {
  const normalized = String(displayName || '').trim();

  if (!normalized || normalized === 'New Customer') {
    return '?';
  }

  return normalized[0].toUpperCase();
}

function appendChannelIcon(avatar, conversation) {
  const channel = getConversationChannel(conversation);

  if (!conversation || channel === 'unknown') {
    return;
  }

  const icon = document.createElement('span');
  icon.className = `channel-icon ${channel}`;
  icon.textContent = getChannelIconLabel(channel);
  icon.title = getChannelLabel(channel);
  icon.setAttribute('aria-label', getChannelLabel(channel));
  avatar.append(icon);
}

function getConversationChannel(conversation) {
  return conversation?.channel || getChannelFromConversationId(conversation?.conversationId);
}

function getSelectedSummary() {
  return state.conversations.find(
    (conversation) => conversation.conversationId === state.selectedConversationId,
  );
}

function getSelectedChannel() {
  return getConversationChannel(getSelectedSummary());
}

function getChannelFromConversationId(conversationId = '') {
  if (conversationId.startsWith('website:')) {
    return 'website';
  }

  if (conversationId.startsWith('fb:') || conversationId.startsWith('messenger:')) {
    return 'fb';
  }

  if (
    conversationId.startsWith('user:') ||
    conversationId.startsWith('group:') ||
    conversationId.startsWith('room:')
  ) {
    return 'line';
  }

  return 'unknown';
}

function getChannelLabel(channel = 'unknown') {
  if (channel === 'line') {
    return 'LINE';
  }

  if (channel === 'website') {
    return 'Website';
  }

  if (channel === 'fb') {
    return 'FB Messenger';
  }

  return 'Unknown';
}

function getChannelIconLabel(channel = 'unknown') {
  if (channel === 'line') {
    return 'LINE';
  }

  if (channel === 'website') {
    return 'WEB';
  }

  if (channel === 'fb') {
    return 'FB';
  }

  return '?';
}

function getBotId(conversation = {}) {
  return conversation?.botId === 'baseline' ? 'baseline' : 'tagAware';
}

function getBotLabel(botId = 'tagAware') {
  if (botId === 'baseline') {
    return 'Baseline Bot';
  }

  return 'Tag-Aware Bot';
}

function normalizeTags(tags) {
  return Array.from(
    new Set(
      tags
        .map((tag) => String(tag || '').trim())
        .filter(Boolean)
        .map((tag) => tag.slice(0, 40)),
    ),
  ).slice(0, 12);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');

  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    elements.toast.classList.remove('show');
  }, 2800);
}

function getCurrentPage() {
  if (window.location.pathname.startsWith('/admin/settings')) {
    return 'settings';
  }

  return 'inbox';
}
