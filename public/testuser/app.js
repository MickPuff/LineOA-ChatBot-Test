const STORAGE_KEY = 'roastline-test-user';

const state = {
  userId: '',
  displayName: '',
  conversationId: '',
  messages: [],
  eventSource: null,
};

const elements = {
  identityPanel: document.querySelector('#identity-panel'),
  chatPanel: document.querySelector('#chat-panel'),
  identityForm: document.querySelector('#identity-form'),
  displayNameInput: document.querySelector('#display-name-input'),
  userIdInput: document.querySelector('#user-id-input'),
  conversationLabel: document.querySelector('#conversation-label'),
  changeUserButton: document.querySelector('#change-user-button'),
  messages: document.querySelector('#messages'),
  messageForm: document.querySelector('#message-form'),
  messageInput: document.querySelector('#message-input'),
  sendButton: document.querySelector('#send-button'),
  toast: document.querySelector('#toast'),
};

hydrateIdentity();

elements.identityForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await startChat({
    displayName: elements.displayNameInput.value.trim(),
    userId: elements.userIdInput.value.trim(),
  });
});

elements.changeUserButton.addEventListener('click', () => {
  disconnectEvents();
  state.userId = '';
  state.displayName = '';
  state.conversationId = '';
  state.messages = [];
  window.localStorage.removeItem(STORAGE_KEY);
  elements.chatPanel.hidden = true;
  elements.identityPanel.hidden = false;
  elements.messages.replaceChildren();
});

elements.messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await sendMessage();
});

async function startChat({ displayName, userId }) {
  if (!displayName || !userId) {
    showToast('Display name and user ID are required.');
    return;
  }

  state.displayName = displayName;
  state.userId = userId;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ displayName, userId }));
  elements.identityPanel.hidden = true;
  elements.chatPanel.hidden = false;
  elements.conversationLabel.textContent = `${displayName} - website:${normalizeUserId(userId)}`;

  await loadMessages();
  connectEvents();
  elements.messageInput.focus();
}

async function loadMessages() {
  try {
    const params = new URLSearchParams({
      userId: state.userId,
      displayName: state.displayName,
    });
    const data = await fetchJson(`/api/testuser/messages?${params}`);

    state.conversationId = data.conversationId;
    state.messages = data.messages || [];
    renderMessages();
  } catch (error) {
    showToast(error.message || 'Could not load chat history.');
  }
}

function connectEvents() {
  if (!window.EventSource || state.eventSource) {
    return;
  }

  const params = new URLSearchParams({ userId: state.userId });
  const eventSource = new EventSource(`/api/testuser/events?${params}`);
  state.eventSource = eventSource;

  eventSource.addEventListener('message', (event) => {
    const payload = parseEventData(event);

    if (!payload?.message || payload.conversationId !== state.conversationId) {
      return;
    }

    addMessage(payload.message);
  });

  eventSource.addEventListener('conversation-cleared', () => {
    state.messages = [];
    renderMessages();
  });

  eventSource.addEventListener('error', () => {
    showToast('Live chat disconnected. Reconnecting...');
  });
}

function disconnectEvents() {
  state.eventSource?.close();
  state.eventSource = null;
}

async function sendMessage() {
  const text = elements.messageInput.value.trim();

  if (!text) {
    return;
  }

  elements.sendButton.disabled = true;
  elements.messageInput.disabled = true;

  try {
    const data = await fetchJson('/api/testuser/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: state.userId,
        displayName: state.displayName,
        text,
      }),
    });

    elements.messageInput.value = '';
    state.conversationId = data.conversationId || state.conversationId;

    for (const message of data.messages || []) {
      addMessage(message);
    }
  } catch (error) {
    showToast(error.message || 'Could not send message.');
  } finally {
    elements.sendButton.disabled = false;
    elements.messageInput.disabled = false;
    elements.messageInput.focus();
  }
}

function addMessage(message) {
  if (hasMessage(message)) {
    return;
  }

  state.messages = [...state.messages, message];
  renderMessages();
}

function hasMessage(message) {
  return state.messages.some((existingMessage) =>
    existingMessage.role === message.role &&
    existingMessage.text === message.text &&
    existingMessage.at === message.at &&
    (existingMessage.from || '') === (message.from || ''),
  );
}

function renderMessages() {
  elements.messages.replaceChildren();

  if (state.messages.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'message-meta';
    empty.textContent = 'No messages yet.';
    elements.messages.append(empty);
    return;
  }

  for (const message of state.messages) {
    elements.messages.append(createMessageNode(message));
  }

  requestAnimationFrame(() => {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  });
}

function createMessageNode(message) {
  const wrapper = document.createElement('article');
  wrapper.className = `message ${message.role === 'user' ? 'user' : 'assistant'}`;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = `${message.role === 'user' ? state.displayName : getSenderLabel(message)} - ${formatDate(message.at)}`;

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

function getSenderLabel(message) {
  return message.from === 'admin' ? 'Admin' : 'AI gold seller';
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
      // Keep the HTTP status fallback.
    }

    throw new Error(errorMessage);
  }

  return response.json();
}

function hydrateIdentity() {
  let stored = null;

  try {
    stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    stored = null;
  }

  elements.displayNameInput.value = stored?.displayName || '';
  elements.userIdInput.value = stored?.userId || `web-${crypto.randomUUID().slice(0, 8)}`;

  if (stored?.displayName && stored?.userId) {
    startChat(stored);
  }
}

function parseEventData(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function normalizeUserId(userId) {
  return String(userId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'anonymous';
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
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');

  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    elements.toast.classList.remove('show');
  }, 2800);
}
