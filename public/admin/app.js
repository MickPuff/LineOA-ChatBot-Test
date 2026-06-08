const state = {
  conversations: [],
  filteredConversations: [],
  selectedConversationId: null,
  selectedMessages: [],
};

const elements = {
  list: document.querySelector('#conversation-list'),
  search: document.querySelector('#search'),
  messages: document.querySelector('#messages'),
  emptyState: document.querySelector('#empty-state'),
  title: document.querySelector('#conversation-title'),
  meta: document.querySelector('#conversation-meta'),
  refreshButton: document.querySelector('#refresh-button'),
  copyIdButton: document.querySelector('#copy-id-button'),
  exportButton: document.querySelector('#export-button'),
  toast: document.querySelector('#toast'),
  metricConversations: document.querySelector('#metric-conversations'),
  metricMessages: document.querySelector('#metric-messages'),
  detailTitle: document.querySelector('#detail-title'),
  detailId: document.querySelector('#detail-id'),
  detailCount: document.querySelector('#detail-count'),
  detailUserCount: document.querySelector('#detail-user-count'),
  detailAssistantCount: document.querySelector('#detail-assistant-count'),
  detailLastAt: document.querySelector('#detail-last-at'),
};

elements.refreshButton.addEventListener('click', () => loadConversations());
elements.search.addEventListener('input', () => filterConversations());
elements.copyIdButton.addEventListener('click', () => copySelectedConversationId());
elements.exportButton.addEventListener('click', () => exportSelectedConversation());

loadConversations();

async function loadConversations() {
  setLoading(true);

  try {
    const data = await fetchJson('/api/admin/conversations');
    state.conversations = data.conversations || [];
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
    showToast(error.message || 'Could not load conversations.');
  } finally {
    setLoading(false);
  }
}

function filterConversations() {
  const query = elements.search.value.trim().toLowerCase();

  state.filteredConversations = query
    ? state.conversations.filter((conversation) =>
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
    : [...state.conversations];

  renderConversationList();
}

function renderConversationList() {
  elements.list.replaceChildren();

  if (state.filteredConversations.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No chats found.';
    elements.list.append(empty);
    return;
  }

  for (const conversation of state.filteredConversations) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'conversation-item';
    item.classList.toggle(
      'active',
      conversation.conversationId === state.selectedConversationId,
    );
    item.addEventListener('click', () => selectConversation(conversation.conversationId));

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
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
    preview.textContent = conversation.lastText || 'ยังไม่มีข้อความที่บันทึก';

    const tags = document.createElement('div');
    tags.className = 'conversation-tags';

    const dot = document.createElement('span');
    dot.className = 'status-dot';

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `${conversation.messageCount} ข้อความ`;

    topRow.append(title, time);
    tags.append(dot, badge);
    body.append(topRow, preview, tags);
    item.append(avatar, body);
    elements.list.append(item);
  }
}

async function selectConversation(conversationId) {
  state.selectedConversationId = conversationId;
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
  elements.meta.textContent = `${state.selectedMessages.length} ข้อความที่บันทึกไว้`;
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
  elements.title.textContent = 'เลือกลูกค้า';
  elements.meta.textContent = 'ยังไม่ได้เลือกบทสนทนา';
  elements.detailTitle.textContent = 'ลูกค้าใหม่';
  elements.detailId.textContent = '-';
  elements.detailCount.textContent = '-';
  elements.detailUserCount.textContent = '-';
  elements.detailAssistantCount.textContent = '-';
  elements.detailLastAt.textContent = '-';
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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status}`);
  }

  return response.json();
}

function updateMetrics(totals = {}) {
  elements.metricConversations.textContent = `${formatNumber(totals.conversations || 0)} แชท`;
  elements.metricMessages.textContent = formatNumber(totals.messages || 0);
}

function setLoading(isLoading) {
  elements.refreshButton.disabled = isLoading;
  elements.refreshButton.textContent = isLoading ? 'Loading' : 'Refresh';
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
    return 'ตอนนี้';
  }

  if (diffMs < hourMs) {
    return `${Math.max(1, Math.floor(diffMs / minuteMs))} นาที`;
  }

  if (diffMs < dayMs) {
    return `${Math.floor(diffMs / hourMs)} ชม.`;
  }

  if (diffMs < 10 * dayMs) {
    return `${Math.floor(diffMs / dayMs)} วันก่อน`;
  }

  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric',
    month: 'short',
  }).format(date);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function getConversationDisplayName(conversation) {
  if (!conversation) {
    return 'ลูกค้าใหม่';
  }

  const id = conversation.conversationId || '';

  if (id.startsWith('group:')) {
    return 'กลุ่มลูกค้า';
  }

  if (id.startsWith('room:')) {
    return 'ห้องแชทลูกค้า';
  }

  return 'ลูกค้าใหม่';
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');

  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    elements.toast.classList.remove('show');
  }, 2800);
}
