const state = {
  conversations: [],
  filteredConversations: [],
  selectedConversationId: null,
  selectedMessages: [],
  activeFilter: 'all',
  hasLoadedConversations: false,
  isLoadingConversations: false,
  seenUserMessageCounts: new Map(),
  unreadUserMessageCounts: new Map(),
};

const AUTO_REFRESH_MS = 4000;

const elements = {
  list: document.querySelector('#conversation-list'),
  search: document.querySelector('#search'),
  messages: document.querySelector('#messages'),
  emptyState: document.querySelector('#empty-state'),
  title: document.querySelector('#conversation-title'),
  meta: document.querySelector('#conversation-meta'),
  filterButtons: [...document.querySelectorAll('.queue-tabs button[data-filter]')],
  navButtons: [...document.querySelectorAll('.nav-item[type="button"]')],
  adminReplyInput: document.querySelector('#admin-reply-input'),
  adminReplyButton: document.querySelector('#admin-reply-button'),
  copyIdButton: document.querySelector('#copy-id-button'),
  exportButton: document.querySelector('#export-button'),
  toast: document.querySelector('#toast'),
  metricConversations: document.querySelector('#metric-conversations'),
  metricMessages: document.querySelector('#metric-messages'),
  metricAdmin: document.querySelector('#metric-admin'),
  metricFollowUp: document.querySelector('#metric-follow-up'),
  detailTitle: document.querySelector('#detail-title'),
  detailId: document.querySelector('#detail-id'),
  detailCount: document.querySelector('#detail-count'),
  detailUserCount: document.querySelector('#detail-user-count'),
  detailAssistantCount: document.querySelector('#detail-assistant-count'),
  detailLastAt: document.querySelector('#detail-last-at'),
};

elements.search.addEventListener('input', () => filterConversations());
elements.filterButtons.forEach((button) => {
  button.addEventListener('click', () => setActiveFilter(button.dataset.filter));
});
document.querySelector('#nav-inbox')?.addEventListener('click', () => showInbox());
document.querySelector('#nav-test-bot')?.addEventListener('click', () => showTestBotStatus());
document.querySelector('#nav-analytics')?.addEventListener('click', () => showSalesAnalytics());
document.querySelector('#nav-repeat-buyers')?.addEventListener('click', () => showRepeatBuyers());
document.querySelector('#nav-customer-db')?.addEventListener('click', () => showCustomerDatabase());
document.querySelector('#nav-settings')?.addEventListener('click', () => showSettings());
elements.adminReplyButton.addEventListener('click', () => sendAdminReply());
elements.adminReplyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendAdminReply();
  }
});
elements.copyIdButton.addEventListener('click', () => copySelectedConversationId());
elements.exportButton.addEventListener('click', () => exportSelectedConversation());

updateComposerState();
loadConversations();
window.setInterval(() => loadConversations({ silent: true }), AUTO_REFRESH_MS);

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
    avatar.textContent = '?';

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
    preview.textContent = conversation.lastText || 'No saved coffee request yet';

    const tags = document.createElement('div');
    tags.className = 'conversation-tags';

    const dot = document.createElement('span');
    dot.className = `status-dot${unreadCount > 0 ? ' has-unread' : ''}`;

    const badge = document.createElement('span');
    badge.className = `badge unread-badge${unreadCount > 0 ? ' has-unread' : ''}`;
    badge.textContent = unreadCount > 0 ? `${unreadCount} unread` : 'Read';

    topRow.append(title, time);
    tags.append(dot, badge);
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

  elements.detailId.textContent = state.selectedConversationId;
  elements.detailCount.textContent = String(state.selectedMessages.length);
  elements.detailUserCount.textContent = String(
    state.selectedMessages.filter((message) => message.role === 'user').length,
  );
  elements.detailAssistantCount.textContent = String(
    state.selectedMessages.filter((message) => message.role === 'assistant').length,
  );
  elements.detailLastAt.textContent = formatRelativeDate(summary?.lastAt);

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
  meta.textContent = `${message.role || 'unknown'} - ${formatDate(message.at)}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = message.text || '';

  wrapper.append(meta, bubble);
  return wrapper;
}

function clearSelection() {
  state.selectedConversationId = null;
  state.selectedMessages = [];
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

  if (!isPushableLineConversation(state.selectedConversationId)) {
    showToast('Admin replies support LINE user, group, or room chats only.');
    return;
  }

  if (!text) {
    showToast('Type a reply before sending.');
    return;
  }

  elements.adminReplyButton.disabled = true;
  elements.adminReplyInput.disabled = true;

  try {
    await fetchJson(`/api/admin/conversations/${encodeURIComponent(state.selectedConversationId)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    elements.adminReplyInput.value = '';
    showToast('Admin reply sent to LINE and saved.');
    await loadConversations();
  } catch (error) {
    showToast(error.message || 'Could not send admin reply.');
  } finally {
    updateComposerState();
  }
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
  elements.metricMessages.textContent = formatNumber(state.conversations.length);
  elements.metricAdmin.textContent = formatNumber(
    state.conversations.filter((conversation) => conversation.lastRole === 'user').length,
  );
  elements.metricFollowUp.textContent = formatNumber(
    state.conversations.filter(isFollowUpConversation).length,
  );
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
  if (state.activeFilter === 'needs-admin') {
    return conversation.lastRole === 'user';
  }

  if (state.activeFilter === 'follow-up') {
    return isFollowUpConversation(conversation);
  }

  if (state.activeFilter === 'repeat-buyers') {
    return conversation.messageCount >= 4;
  }

  return true;
}

function isFollowUpConversation(conversation) {
  if (!conversation.lastAt) {
    return false;
  }

  return Date.now() - Date.parse(conversation.lastAt) > 24 * 60 * 60 * 1000;
}

function showInbox() {
  setActiveNav('nav-inbox');
  elements.search.value = '';
  setActiveFilter('all');
  showToast('Showing all coffee conversations.');
}

function showTestBotStatus() {
  setActiveNav('nav-test-bot');
  showToast('Send a LINE message to the bot. New chats appear here automatically.');
}

function showSalesAnalytics() {
  setActiveNav('nav-analytics');
  const messages = state.conversations.reduce(
    (total, conversation) => total + conversation.messageCount,
    0,
  );
  showToast(`${state.conversations.length} chats and ${messages} saved messages.`);
}

function showRepeatBuyers() {
  setActiveNav('nav-repeat-buyers');
  state.activeFilter = 'repeat-buyers';
  elements.filterButtons.forEach((button) => button.classList.remove('active'));
  filterConversations();
  showToast('Showing customers with longer coffee conversations.');
}

function showCustomerDatabase() {
  setActiveNav('nav-customer-db');
  elements.search.value = '';
  setActiveFilter('all');
  elements.search.focus();
  showToast('Customer database view uses the searchable inbox list.');
}

async function showSettings() {
  setActiveNav('nav-settings');

  try {
    const config = await fetchJson('/debug/config');
    showToast(`Model: ${config.geminiModel}. Storage: ${config.storageProvider}. Admin enabled: ${config.adminEnabled}.`);
  } catch (error) {
    showToast(error.message || 'Could not load settings.');
  }
}

function setActiveNav(id) {
  elements.navButtons.forEach((button) => {
    button.classList.toggle('active', button.id === id);
  });
}

function updateComposerState() {
  const canReply = isPushableLineConversation(state.selectedConversationId);
  elements.adminReplyInput.disabled = !canReply;
  elements.adminReplyButton.disabled = !canReply;
  elements.adminReplyInput.placeholder = canReply
    ? 'Reply as admin to this LINE customer'
    : 'Select a LINE user, group, or room chat to reply';
}

function isPushableLineConversation(conversationId) {
  return ['user:', 'group:', 'room:'].some((prefix) => conversationId?.startsWith(prefix));
}

function getEmptyListMessage() {
  if (state.activeFilter === 'needs-admin') {
    return 'No chats currently need admin attention.';
  }

  if (state.activeFilter === 'follow-up') {
    return 'No follow-up chats found.';
  }

  if (state.activeFilter === 'repeat-buyers') {
    return 'No repeat-buyer conversations found yet.';
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

function getConversationDisplayName(conversation) {
  if (!conversation) {
    return 'New Customer';
  }

  const id = conversation.conversationId || '';

  if (id.startsWith('group:')) {
    return 'Coffee Group';
  }

  if (id.startsWith('room:')) {
    return 'Coffee Chat Room';
  }

  return 'New Customer';
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');

  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    elements.toast.classList.remove('show');
  }, 2800);
}
