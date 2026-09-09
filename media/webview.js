/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();

  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const planBadge = document.getElementById('planBadge');
  const modelSelect = document.getElementById('modelSelect');

  let streamingEl = null;
  let currentModels = [];
  let activeModel = null;
  let deviceCardEl = null;

  function planLabel(p) {
    if (!p || !p.plan) return '–';
    return p.planName || p.plan;
  }
  function planClass(p) {
    return p && p.plan ? p.plan : '';
  }

  function addMessage(cls, text) {
    if (streamingEl && cls === 'assistant' && text !== '__new__') {
      return streamingEl;
    }
    const el = document.createElement('div');
    el.className = 'msg ' + cls;
    if (text && text !== '__new__') {
      el.textContent = text;
    }
    messages.appendChild(el);
    scrollBottom();
    return el;
  }

  function scrollBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function appendStream(text) {
    if (!streamingEl) {
      streamingEl = addMessage('assistant', '__new__');
    }
    streamingEl.textContent = (streamingEl.textContent || '') + text;
    scrollBottom();
  }

  function addToolBadge(name) {
    const badge = document.createElement('span');
    badge.className = 'tool-badge';
    badge.textContent = '⚙ ' + name;
    messages.appendChild(badge);
    scrollBottom();
  }

  // ---- Model dropdown -------------------------------------------------
  function renderModels(plan) {
    const models = (plan && plan.models) || [];
    currentModels = models;
    const active = (plan && plan.activeModel) || models[0]?.id;

    modelSelect.innerHTML = '';

    if (!models || models.length === 0) {
      modelSelect.style.display = 'none';
      activeModel = null;
      return;
    }

    modelSelect.style.display = 'inline-block';
    models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name || m.id;
      modelSelect.appendChild(opt);
    });

    if (active) {
      modelSelect.value = active;
      activeModel = active;
    } else if (models.length > 0) {
      activeModel = models[0].id;
      modelSelect.value = activeModel;
    }
  }

  function showLogin() {
    planBadge.textContent = 'not logged in';
    planBadge.className = 'plan-badge';
    modelSelect.style.display = 'none';
    const el = document.createElement('div');
    el.className = 'msg system login-card';
    el.innerHTML =
      '<div>Connect your Meldrix account to unlock your plan &amp; tools.</div>' +
      '<button id="loginBtn">Login</button>';
    messages.appendChild(el);
    document.getElementById('loginBtn').onclick = () =>
      vscode.postMessage({ type: 'login' });
    scrollBottom();
  }

  // ---- Device code card (device authorization flow) -------------------
  function showDeviceCode(userCode, verificationUri) {
    removeDeviceCard();

    deviceCardEl = document.createElement('div');
    deviceCardEl.className = 'device-card';

    const title = document.createElement('div');
    title.className = 'device-title';
    title.textContent = 'Sign in with Meldrix';
    deviceCardEl.appendChild(title);

    const code = document.createElement('div');
    code.className = 'device-code';
    code.textContent = userCode;
    deviceCardEl.appendChild(code);

    const hint = document.createElement('div');
    hint.className = 'device-hint';
    hint.textContent = `1. Browser opened at ${verificationUri}\n2. Sign in with your Gmail\n3. Enter the code above`;
    deviceCardEl.appendChild(hint);

    const actions = document.createElement('div');
    actions.className = 'device-actions';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy Code';
    copyBtn.onclick = () => {
      navigator.clipboard?.writeText(userCode);
      vscode.postMessage({ type: 'copyCode', userCode });
    };
    actions.appendChild(copyBtn);

    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open Browser';
    openBtn.onclick = () => vscode.postMessage({ type: 'openBrowser' });
    actions.appendChild(openBtn);

    deviceCardEl.appendChild(actions);

    const status = document.createElement('div');
    status.className = 'device-pending';
    status.textContent = 'Waiting for authorization…';
    deviceCardEl.appendChild(status);

    messages.appendChild(deviceCardEl);
    scrollBottom();
  }

  function removeDeviceCard() {
    if (deviceCardEl && deviceCardEl.parentNode) {
      deviceCardEl.parentNode.removeChild(deviceCardEl);
      deviceCardEl = null;
    }
  }

  function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMessage('user', text);
    vscode.postMessage({ type: 'chat', text, model: activeModel });
  }

  send.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  modelSelect.addEventListener('change', () => {
    activeModel = modelSelect.value;
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'plan':
        removeDeviceCard();
        planBadge.textContent = planLabel(msg.plan);
        planBadge.className = 'plan-badge ' + planClass(msg.plan);
        renderModels(msg.plan);
        break;
      case 'deviceCode':
        showDeviceCode(msg.userCode, msg.verificationUri);
        break;
      case 'status':
        streamingEl = null;
        addMessage('system', msg.text);
        break;
      case 'token':
        appendStream(msg.text);
        break;
      case 'tool':
        addToolBadge(msg.name);
        break;
      case 'done':
        streamingEl = null;
        break;
      case 'error':
        streamingEl = null;
        removeDeviceCard();
        addMessage('error', msg.text);
        break;
      case 'loggedOut':
        removeDeviceCard();
        planBadge.textContent = 'not logged in';
        planBadge.className = 'plan-badge';
        break;
    }
  });

  // Request initial state on load.
  vscode.postMessage({ type: 'ready' });
})();