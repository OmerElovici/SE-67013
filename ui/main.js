const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const channelSelect = document.getElementById('channelSelect');
const refreshBtn = document.getElementById('refreshBtn');
const toggleBtn = document.getElementById('toggleBtn');
const toggleIcon = document.getElementById('toggleIcon');
const toggleText = document.getElementById('toggleText');
const clearBtn = document.getElementById('clearBtn');
const errorMessage = document.getElementById('errorMessage');
const emptyState = document.getElementById('emptyState');
const emptyCopy = document.getElementById('emptyCopy');
const transcriptList = document.getElementById('transcriptList');
const activeSpeakersElement = document.getElementById('activeSpeakers');
const transcriptionPanel = document.getElementById('transcriptionPanel');
const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');

// Session Browsing Elements
const sessionSelect = document.getElementById('sessionSelect');
const sessionStatus = document.getElementById('sessionStatus');

// Vocabulary Elements
const vocabInput = document.getElementById('vocabInput');
const vocabSaveBtn = document.getElementById('vocabSaveBtn');
const vocabStatus = document.getElementById('vocabStatus');

// Announcement Elements
const announcementStatus = document.getElementById('announcementStatus');
const announcementFileInput = document.getElementById('announcementFileInput');
const announcementUploadBtn = document.getElementById('announcementUploadBtn');
const announcementRemoveBtn = document.getElementById('announcementRemoveBtn');

// Report & Export Elements
const reportSessionsSelect = document.getElementById('reportSessionsSelect');
const reportLangSelect = document.getElementById('reportLangSelect');
const generateReportBtn = document.getElementById('generateReportBtn');
const reportErrorMessage = document.getElementById('reportErrorMessage');
const reportDisplayContainer = document.getElementById('reportDisplayContainer');
const reportTitle = document.getElementById('reportTitle');
const reportContent = document.getElementById('reportContent');
const exportMdBtn = document.getElementById('exportMdBtn');
const exportTxtBtn = document.getElementById('exportTxtBtn');
const savedReportsList = document.getElementById('savedReportsList');

const backendHost = `${window.location.hostname || 'localhost'}:8000`;
const apiBase = `${window.location.protocol}//${backendHost}/v1`;
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

const CONNECT_ICON = `<path d="M11.596 8.697l-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"/>`;
const DISCONNECT_ICON = `<path d="M5 3.5h6A1.5 1.5 0 0 1 12.5 5v6a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 11V5A1.5 1.5 0 0 1 5 3.5z"/>`;

let eventsSocket = null;
let reconnectTimer = null;
let status = { state: 'starting', connected: false, bot_ready: false };
let isBusy = false;
let currentActiveReport = null;
let currentDisplayedSessionId = 'active';
let sessionLoadPromise = null;
let refreshAfterSessionLoad = false;

const activeSpeakers = new Map();
const speakerLevels = new Map();
const utteranceElements = new Map();

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(canvas.clientWidth * ratio);
  canvas.height = Math.floor(canvas.clientHeight * ratio);
  canvasCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function drawVisualizer(timestamp) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const level = Math.max(0, ...speakerLevels.values());
  const center = height / 2;

  canvasCtx.fillStyle = '#0F172A';
  canvasCtx.fillRect(0, 0, width, height);
  canvasCtx.lineWidth = 2;
  canvasCtx.strokeStyle = '#3B82F6';
  canvasCtx.beginPath();

  const points = 72;
  for (let index = 0; index <= points; index += 1) {
    const x = (index / points) * width;
    const envelope = Math.sin((index / points) * Math.PI);
    const wave = Math.sin(index * 1.7 + timestamp / 90);
    const y = center + wave * level * envelope * (height * 0.38);
    if (index === 0) canvasCtx.moveTo(x, y);
    else canvasCtx.lineTo(x, y);
  }
  canvasCtx.stroke();

  for (const [speakerId, value] of speakerLevels) {
    const nextValue = value * 0.92;
    if (nextValue < 0.005) speakerLevels.delete(speakerId);
    else speakerLevels.set(speakerId, nextValue);
  }
  requestAnimationFrame(drawVisualizer);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
requestAnimationFrame(drawVisualizer);

function updateStatus(nextStatus) {
  status = { ...status, ...nextStatus };
  statusDot.className = 'status-dot';
  const state = status.state || 'disconnected';

  if (state === 'connected') {
    statusDot.classList.add('recording');
    statusText.textContent = `Listening - ${status.channel_name}`;
  } else if (state === 'ready') {
    statusDot.classList.add('connected');
    statusText.textContent = 'Bot Ready';
  } else if (state === 'connecting' || state === 'disconnecting' || state === 'starting') {
    statusDot.classList.add('connecting');
    statusText.textContent = state === 'starting' ? 'Bot starting...' : `${capitalize(state)}...`;
  } else if (state === 'error') {
    statusDot.classList.add('disconnected');
    statusText.textContent = 'Error';
  } else {
    statusText.textContent = 'Disconnected';
  }

  errorMessage.textContent = status.error || '';
  errorMessage.hidden = !status.error;
  emptyCopy.textContent = status.connected
    ? 'Listening for speakers in the selected Discord channel.'
    : 'Connect the bot to a voice channel to begin.';
  updateControls();
}

function updateControls() {
  const connected = Boolean(status.connected);
  const transitioning = ['connecting', 'disconnecting', 'starting'].includes(status.state);
  toggleBtn.disabled = isBusy || transitioning || (!connected && !channelSelect.value);
  channelSelect.disabled = connected || isBusy || !status.bot_ready;
  refreshBtn.disabled = connected || isBusy || !status.bot_ready;

  if (connected) {
    toggleText.textContent = 'Disconnect';
    toggleIcon.innerHTML = DISCONNECT_ICON;
    toggleBtn.classList.add('disconnect');
  } else {
    toggleText.textContent = isBusy ? 'Connecting...' : 'Connect bot';
    toggleIcon.innerHTML = CONNECT_ICON;
    toggleBtn.classList.remove('disconnect');
  }
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      message = payload.detail || message;
    } catch {
      // Keep status-based message
    }
    throw new Error(message);
  }
  return response.json();
}

async function loadChannels() {
  refreshBtn.disabled = true;
  channelSelect.innerHTML = '<option value="">Loading voice channels...</option>';

  try {
    const payload = await apiRequest('/discord/channels');
    renderChannels(payload.channels);
    errorMessage.hidden = true;
  } catch (error) {
    channelSelect.innerHTML = '<option value="">Voice channels unavailable</option>';
    showError(error.message);
  } finally {
    updateControls();
  }
}

function renderChannels(channels) {
  const previousValue = channelSelect.value || status.channel_id;
  channelSelect.innerHTML = '<option value="">Choose a voice channel</option>';
  const groups = new Map();

  for (const channel of channels) {
    let group = groups.get(channel.guild_id);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = channel.guild_name;
      groups.set(channel.guild_id, group);
      channelSelect.appendChild(group);
    }

    const option = document.createElement('option');
    option.value = channel.channel_id;
    option.dataset.guildId = channel.guild_id;
    option.textContent = channel.channel_name;
    group.appendChild(option);
  }

  if (previousValue) channelSelect.value = previousValue;
  if (!channels.length) {
    channelSelect.innerHTML = '<option value="">No voice channels found</option>';
  }
}

async function toggleConnection() {
  isBusy = true;
  updateControls();
  errorMessage.hidden = true;

  try {
    if (status.connected) {
      updateStatus({ state: 'disconnecting' });
      const nextStatus = await apiRequest('/discord/disconnect', { method: 'POST' });
      updateStatus(nextStatus);
      clearActiveSpeakers();
      await loadSessions();
      return;
    }

    const option = channelSelect.selectedOptions[0];
    if (!option || !option.value) return;

    updateStatus({ state: 'connecting' });
    const nextStatus = await apiRequest('/discord/connect', {
      method: 'POST',
      body: JSON.stringify({
        guild_id: option.dataset.guildId,
        channel_id: option.value,
      }),
    });
    updateStatus(nextStatus);
    await loadSessions();
  } catch (error) {
    showError(error.message);
    await refreshStatus();
  } finally {
    isBusy = false;
    updateControls();
  }
}

async function refreshStatus() {
  try {
    updateStatus(await apiRequest('/discord/status'));
  } catch (error) {
    updateStatus({ state: 'error', error: error.message });
  }
}

function connectEventStream() {
  if (eventsSocket) eventsSocket.close();
  eventsSocket = new WebSocket(`${wsProtocol}//${backendHost}/v1/discord/events`);

  eventsSocket.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    handleEvent(payload);
  };

  eventsSocket.onclose = () => {
    eventsSocket = null;
    if (!reconnectTimer) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectEventStream();
      }, 2000);
    }
  };

  eventsSocket.onerror = () => {
    eventsSocket.close();
  };
}

let activeSessionId = null;

function isViewingActiveSession() {
  const val = sessionSelect.value;
  return val === 'active' || (activeSessionId && val === activeSessionId);
}

export function handleEvent(event) {
  if (event.type === 'status') {
    const wasReady = status.bot_ready;
    updateStatus(event);
    if (!wasReady && event.bot_ready) loadChannels();
    if (!event.connected) clearActiveSpeakers();
  } else if (event.type === 'speaker') {
    updateSpeaker(event);
  } else if (event.type === 'audio_level') {
    speakerLevels.set(event.speaker_id, event.level);
  } else if (event.type === 'transcript') {
    if (isViewingActiveSession()) {
      updateTranscript(event);
    }
    if (event.finalized && String(event.text || '').trim() && !activeSessionId) {
      requestActiveSessionRefresh();
    }
  } else if (event.type === 'error') {
    showError(event.message);
  }
}

function updateSpeaker(event) {
  if (event.speaking) {
    activeSpeakers.set(event.speaker_id, event.speaker_name);
  } else {
    activeSpeakers.delete(event.speaker_id);
    speakerLevels.delete(event.speaker_id);
  }
  renderActiveSpeakers();
}

function renderActiveSpeakers() {
  activeSpeakersElement.innerHTML = '';
  if (!activeSpeakers.size) {
    activeSpeakersElement.innerHTML = '<span class="speaker-placeholder">No active speaker</span>';
    return;
  }

  for (const name of activeSpeakers.values()) {
    const chip = document.createElement('span');
    chip.className = 'speaker-chip';
    chip.textContent = `${name} is speaking`;
    activeSpeakersElement.appendChild(chip);
  }
}

function clearActiveSpeakers() {
  activeSpeakers.clear();
  speakerLevels.clear();
  renderActiveSpeakers();
}

function updateTranscript(event) {
  let row = utteranceElements.get(event.utterance_id);
  if (!row && event.text) {
    row = createTranscriptRow(event);
    utteranceElements.set(event.utterance_id, row);
    transcriptList.appendChild(row);
  }

  if (!row) return;
  const textElement = row.querySelector('.transcript-text');
  textElement.textContent = event.text;
  row.classList.toggle('partial', !event.finalized);

  if (event.finalized) {
    if (!event.text) row.remove();
    utteranceElements.delete(event.utterance_id);
  }

  updateEmptyState();
  transcriptionPanel.scrollTop = transcriptionPanel.scrollHeight;
}

function createTranscriptRow(event) {
  const row = document.createElement('article');
  row.className = `transcript-entry ${event.finalized ? '' : 'partial'}`;

  const avatar = document.createElement('div');
  avatar.className = 'speaker-avatar';
  if (event.avatar_url) {
    const image = document.createElement('img');
    image.src = event.avatar_url;
    image.alt = '';
    avatar.appendChild(image);
  } else {
    avatar.textContent = (event.speaker_name || '?').slice(0, 1).toUpperCase();
  }

  const content = document.createElement('div');
  content.className = 'transcript-content';
  const name = document.createElement('div');
  name.className = 'speaker-name';
  name.textContent = event.speaker_name;
  const text = document.createElement('div');
  text.className = 'transcript-text';
  text.textContent = event.text;
  content.append(name, text);
  row.append(avatar, content);
  return row;
}

function updateEmptyState() {
  emptyState.style.display = transcriptList.children.length ? 'none' : 'flex';
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

// ----------------------------------------------------
// 1. Vocabulary Management
// ----------------------------------------------------
async function loadVocabulary() {
  try {
    const payload = await apiRequest('/vocabulary');
    vocabInput.value = payload.raw_text || '';
  } catch (err) {
    vocabStatus.textContent = 'Failed to load vocabulary';
  }
}

async function saveVocabulary() {
  vocabSaveBtn.disabled = true;
  vocabStatus.textContent = 'Saving...';
  try {
    const payload = await apiRequest('/vocabulary', {
      method: 'POST',
      body: JSON.stringify({ raw_text: vocabInput.value }),
    });
    vocabInput.value = payload.raw_text || '';
    vocabStatus.textContent = `Saved (${payload.words.length} terms active)`;
    setTimeout(() => { vocabStatus.textContent = ''; }, 3000);
  } catch (err) {
    vocabStatus.textContent = `Error: ${err.message}`;
  } finally {
    vocabSaveBtn.disabled = false;
  }
}

// ----------------------------------------------------
// 2. Announcement Management
// ----------------------------------------------------
async function loadAnnouncementStatus() {
  try {
    const status = await apiRequest('/discord/announcement');
    if (status.exists) {
      announcementStatus.textContent = `Active clip: ${status.filename} (${status.duration_seconds?.toFixed(1)}s)`;
      announcementRemoveBtn.hidden = false;
    } else {
      announcementStatus.textContent = 'No announcement clip configured.';
      announcementRemoveBtn.hidden = true;
    }
  } catch (err) {
    announcementStatus.textContent = 'Announcement status unavailable.';
  }
}

async function uploadAnnouncement() {
  const file = announcementFileInput.files[0];
  if (!file) {
    announcementStatus.textContent = 'Please choose an MP3 file first.';
    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    announcementStatus.textContent = 'File size exceeds 10 MB limit.';
    return;
  }

  announcementUploadBtn.disabled = true;
  announcementStatus.textContent = 'Validating and uploading MP3...';

  try {
    const buffer = await file.arrayBuffer();
    const response = await fetch(`${apiBase}/discord/announcement`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: buffer,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: 'Upload failed' }));
      throw new Error(err.detail || 'Upload failed');
    }

    const payload = await response.json();
    announcementStatus.textContent = `Uploaded successfully: ${payload.filename} (${payload.duration_seconds?.toFixed(1)}s)`;
    announcementRemoveBtn.hidden = false;
    announcementFileInput.value = '';
  } catch (err) {
    announcementStatus.textContent = `Upload rejected: ${err.message}`;
  } finally {
    announcementUploadBtn.disabled = false;
  }
}

async function removeAnnouncement() {
  announcementRemoveBtn.disabled = true;
  try {
    await apiRequest('/discord/announcement', { method: 'DELETE' });
    announcementStatus.textContent = 'Announcement clip removed.';
    announcementRemoveBtn.hidden = true;
    announcementFileInput.value = '';
  } catch (err) {
    announcementStatus.textContent = `Remove failed: ${err.message}`;
  } finally {
    announcementRemoveBtn.disabled = false;
  }
}

// ----------------------------------------------------
// 3. Session Browsing
// ----------------------------------------------------
export function loadSessions() {
  if (sessionLoadPromise) return sessionLoadPromise;

  sessionLoadPromise = performSessionLoad().finally(() => {
    sessionLoadPromise = null;
    if (refreshAfterSessionLoad && !activeSessionId) {
      refreshAfterSessionLoad = false;
      void loadSessions();
    } else {
      refreshAfterSessionLoad = false;
    }
  });
  return sessionLoadPromise;
}

async function performSessionLoad() {
  sessionStatus.textContent = 'Loading...';
  reportSessionsSelect.setAttribute('aria-busy', 'true');
  try {
    const payload = await apiRequest('/sessions');
    activeSessionId = payload.active_session ? payload.active_session.session_id : null;
    renderSessionSelects(payload.active_session, payload.past_sessions || []);
  } catch (err) {
    sessionStatus.textContent = 'Unavailable';
    renderReportSessionMessage('Sessions unavailable.');
    showReportError(`Could not load sessions: ${err.message}`);
  } finally {
    reportSessionsSelect.setAttribute('aria-busy', 'false');
  }
}

function requestActiveSessionRefresh() {
  if (activeSessionId) return;
  if (sessionLoadPromise) {
    refreshAfterSessionLoad = true;
    return;
  }
  void loadSessions();
}

export function renderSessionSelects(activeSession, pastSessions) {
  const currentSessionVal = sessionSelect.value;
  const selectedReportIds = new Set(
    Array.from(reportSessionsSelect.querySelectorAll('input[type="checkbox"]:checked'))
      .map((input) => input.value),
  );
  sessionSelect.replaceChildren();
  reportSessionsSelect.replaceChildren();

  const activeLabel = activeSession
    ? `Live - ${activeSession.channel_name || status.channel_name || 'Voice channel'}`
    : 'Live active session';

  const liveViewerOpt = document.createElement('option');
  liveViewerOpt.value = 'active';
  liveViewerOpt.textContent = activeLabel;
  sessionSelect.appendChild(liveViewerOpt);

  if (activeSession) {
    appendReportSessionOption(activeSession, {
      checked: selectedReportIds.has(activeSession.session_id),
      isActive: true,
    });
  }

  for (const s of pastSessions) {
    const dateStr = s.started_at ? new Date(s.started_at).toLocaleString() : 'Unknown date';
    const label = `${s.channel_name || 'Channel'} - ${dateStr} (${s.utterance_count} lines)`;

    const viewerOpt = document.createElement('option');
    viewerOpt.value = s.session_id;
    viewerOpt.textContent = label;
    sessionSelect.appendChild(viewerOpt);

    appendReportSessionOption(s, {
      checked: selectedReportIds.has(s.session_id),
      isActive: false,
    });
  }

  if (!activeSession && !pastSessions.length) {
    renderReportSessionMessage('No transcript sessions yet.');
  }

  if (currentSessionVal && Array.from(sessionSelect.options).some((o) => o.value === currentSessionVal)) {
    sessionSelect.value = currentSessionVal;
  } else {
    sessionSelect.value = 'active';
  }
  currentDisplayedSessionId = sessionSelect.value;
  const total = pastSessions.length + (activeSession ? 1 : 0);
  sessionStatus.textContent = total ? `${total} available` : 'Empty';
  reportSessionsSelect.setAttribute('aria-busy', 'false');
}

function appendReportSessionOption(session, { checked, isActive }) {
  const option = document.createElement('label');
  option.className = 'session-check-option';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = 'report-session';
  input.value = session.session_id;
  input.checked = checked;

  const copy = document.createElement('span');
  copy.className = 'session-check-copy';
  const name = document.createElement('span');
  name.className = 'session-check-name';
  name.textContent = isActive
    ? `Live - ${session.channel_name || status.channel_name || 'Voice channel'}`
    : session.channel_name || 'Discord channel';
  const meta = document.createElement('span');
  meta.className = 'session-check-meta';
  if (isActive) {
    meta.textContent = `${session.guild_name || 'Discord server'} - active now`;
  } else {
    const date = session.started_at ? new Date(session.started_at).toLocaleString() : 'Unknown date';
    const lineCount = Number.isFinite(session.utterance_count) ? `${session.utterance_count} lines` : 'Saved session';
    meta.textContent = `${date} - ${lineCount}`;
  }

  copy.append(name, meta);
  option.append(input, copy);
  reportSessionsSelect.appendChild(option);
}

function renderReportSessionMessage(message) {
  const copy = document.createElement('p');
  copy.className = 'checklist-message';
  copy.textContent = message;
  reportSessionsSelect.replaceChildren(copy);
}

async function handleSessionSelectChange() {
  const val = sessionSelect.value;
  currentDisplayedSessionId = val;

  if (val === 'active') {
    if (activeSessionId) {
      try {
        const detail = await apiRequest(`/sessions/${activeSessionId}`);
        renderHistoricalSession(detail);
        return;
      } catch {
        // Fallback to clearing on error
      }
    }
    transcriptList.innerHTML = '';
    utteranceElements.clear();
    updateEmptyState();
    return;
  }

  try {
    const detail = await apiRequest(`/sessions/${val}`);
    renderHistoricalSession(detail);
  } catch (err) {
    showError(`Could not load session transcript: ${err.message}`);
  }
}

function renderHistoricalSession(detail) {
  transcriptList.innerHTML = '';
  utteranceElements.clear();

  for (const utt of detail.transcripts || []) {
    const row = createTranscriptRow({
      utterance_id: utt.utterance_id,
      speaker_name: utt.speaker_name,
      avatar_url: utt.avatar_url,
      text: utt.text,
      finalized: true,
    });
    transcriptList.appendChild(row);
  }
  updateEmptyState();
}

// ----------------------------------------------------
// 4. Reports & Summaries & Export
// ----------------------------------------------------
async function generateReport() {
  clearReportError();
  const selectedOptions = Array.from(
    reportSessionsSelect.querySelectorAll('input[type="checkbox"]:checked'),
  ).map((input) => input.value);

  if (!selectedOptions.length) {
    showReportError('Please select at least one session to summarize.');
    return;
  }

  generateReportBtn.disabled = true;
  generateReportBtn.textContent = 'Generating...';
  generateReportBtn.setAttribute('aria-busy', 'true');

  try {
    const payload = await apiRequest('/reports', {
      method: 'POST',
      body: JSON.stringify({
        session_ids: selectedOptions,
        language: reportLangSelect.value,
      }),
    });
    currentActiveReport = payload;
    renderReportDisplay(payload);
    await loadSavedReports();
  } catch (err) {
    showReportError(err.message);
  } finally {
    generateReportBtn.disabled = false;
    generateReportBtn.textContent = 'Generate';
    generateReportBtn.removeAttribute('aria-busy');
  }
}

async function loadSavedReports() {
  try {
    const payload = await apiRequest('/reports');
    renderSavedReportsList(payload.reports || []);
  } catch (err) {
    renderSavedReportsMessage('Saved reports history unavailable.');
    showReportError(`Could not load saved reports: ${err.message}`);
  }
}

function renderSavedReportsMessage(message) {
  const copy = document.createElement('p');
  copy.className = 'text-muted';
  copy.textContent = message;
  savedReportsList.replaceChildren(copy);
}

function clearReportError() {
  reportErrorMessage.textContent = '';
  reportErrorMessage.hidden = true;
}

function showReportError(message) {
  reportErrorMessage.textContent = message;
  reportErrorMessage.hidden = false;
}

function sourceSessionName(session) {
  const channelName = session.channel_name || session.session_id || 'Selected session';
  const guildName = session.guild_name || 'Discord Server';
  return `${channelName} (${guildName})`;
}

async function openSavedReport(reportId, trigger) {
  clearReportError();
  trigger?.setAttribute('aria-busy', 'true');
  if (trigger) trigger.disabled = true;
  try {
    const report = await apiRequest(`/reports/${encodeURIComponent(reportId)}`);
    currentActiveReport = report;
    renderReportDisplay(report);
    for (const item of savedReportsList.querySelectorAll('.saved-report-item')) {
      if (item.dataset.reportId === String(reportId)) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
  } catch (err) {
    showReportError(`Could not open saved report: ${err.message}`);
  } finally {
    trigger?.removeAttribute('aria-busy');
    if (trigger) trigger.disabled = false;
  }
}

export function renderSavedReportsList(reports) {
  if (!reports.length) {
    renderSavedReportsMessage('No saved reports yet.');
    return;
  }

  savedReportsList.replaceChildren();
  for (const rep of reports) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'saved-report-item';
    item.dataset.reportId = String(rep.report_id || '');

    const meta = document.createElement('div');
    meta.className = 'saved-report-meta';

    const timeStr = rep.created_at ? new Date(rep.created_at).toLocaleString() : 'Unknown date';
    const langLabel = rep.language === 'he' ? 'Hebrew (עברית)' : 'English';
    const sessionNames = (rep.session_previews || []).map(sourceSessionName).join(', ');
    item.setAttribute(
      'aria-label',
      `Open ${langLabel} report from ${timeStr}. Sessions: ${sessionNames || 'Selected sessions'}`,
    );
    const time = document.createElement('div');
    time.className = 'saved-report-time';
    time.textContent = `${timeStr} - ${langLabel}`;
    const sessions = document.createElement('div');
    sessions.className = 'saved-report-sess';
    sessions.textContent = `Sessions: ${sessionNames || 'Selected sessions'}`;
    meta.append(time, sessions);

    const arrow = document.createElement('span');
    arrow.className = 'saved-report-arrow';
    arrow.textContent = '›';
    arrow.setAttribute('aria-hidden', 'true');
    item.append(meta, arrow);
    item.addEventListener('click', () => openSavedReport(rep.report_id, item));
    savedReportsList.appendChild(item);
  }
}

export function renderReportDisplay(report) {
  const createdAt = report.created_at ? new Date(report.created_at) : null;
  const createdLabel = createdAt && !Number.isNaN(createdAt.getTime())
    ? createdAt.toLocaleString()
    : 'Unknown date';
  reportTitle.textContent = `Summary report - ${createdLabel}`;
  reportContent.lang = report.language || 'en';
  reportContent.dir = report.language === 'he' ? 'rtl' : 'ltr';
  renderReportMarkdown(reportContent, report.content);
  reportDisplayContainer.hidden = false;
  if (typeof reportDisplayContainer.scrollIntoView === 'function') {
    reportDisplayContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function appendInlineMarkdown(parent, value) {
  const text = String(value || '');
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
  let cursor = 0;

  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    let element;
    let content;
    if (token.startsWith('`')) {
      element = document.createElement('code');
      content = token.slice(1, -1);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      element = document.createElement('strong');
      content = token.slice(2, -2);
    } else {
      element = document.createElement('em');
      content = token.slice(1, -1);
    }
    element.textContent = content;
    parent.appendChild(element);
    cursor = match.index + token.length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

export function renderReportMarkdown(container, markdown) {
  container.replaceChildren();
  const lines = String(markdown || '').split(/\r?\n/);
  let paragraphLines = [];
  let list = null;
  let codeFence = null;
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const paragraph = document.createElement('p');
    appendInlineMarkdown(paragraph, paragraphLines.join(' '));
    container.appendChild(paragraph);
    paragraphLines = [];
  };

  const closeList = () => {
    list = null;
  };

  const flushCode = () => {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = codeLines.join('\n');
    pre.appendChild(code);
    container.appendChild(pre);
    codeLines = [];
    codeFence = null;
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (codeFence) {
      if (fenceMatch && fenceMatch[1][0] === codeFence.character && fenceMatch[1].length >= codeFence.length) {
        flushCode();
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      flushParagraph();
      closeList();
      codeFence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    const headingMatch = line.match(/^ {0,3}(#{1,6})[ \t]+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const heading = document.createElement(`h${headingMatch[1].length}`);
      appendInlineMarkdown(heading, headingMatch[2].replace(/[ \t]+#+[ \t]*$/, ''));
      container.appendChild(heading);
      continue;
    }

    if (/^ {0,3}((\*|-|_)\s*){3,}$/.test(line)) {
      flushParagraph();
      closeList();
      container.appendChild(document.createElement('hr'));
      continue;
    }

    const quoteMatch = line.match(/^ {0,3}>[ \t]?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      closeList();
      const quote = document.createElement('blockquote');
      appendInlineMarkdown(quote, quoteMatch[1]);
      container.appendChild(quote);
      continue;
    }

    const listMatch = line.match(/^ {0,3}([-+*]|\d+[.)])[ \t]+(.+)$/);
    if (listMatch) {
      flushParagraph();
      const listType = /^\d/.test(listMatch[1]) ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== listType) {
        list = document.createElement(listType);
        container.appendChild(list);
      }
      const item = document.createElement('li');
      appendInlineMarkdown(item, listMatch[2]);
      list.appendChild(item);
      continue;
    }

    closeList();
    paragraphLines.push(line);
  }

  flushParagraph();
  if (codeFence) flushCode();
  if (!container.children.length) {
    const empty = document.createElement('p');
    empty.className = 'text-muted';
    empty.textContent = 'This report has no content.';
    container.appendChild(empty);
  }
}

export function markdownToPlainText(markdown) {
  const codeSpans = [];
  let fence = null;

  return String(markdown || '').split('\n').map((originalLine) => {
    const fenceMatch = originalLine.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { character: marker[0], length: marker.length };
        return null;
      }
      if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = null;
        return null;
      }
    }
    if (fence) return originalLine;

    let line = originalLine.replace(/(?<!\\)(`+)([^\n]*?)\1/g, (_match, _ticks, code) => {
      const token = `\u0000CODE${codeSpans.length}\u0000`;
      codeSpans.push(code);
      return token;
    });

    line = line
      .replace(/^ {0,3}#{1,6}[ \t]+/, '')
      .replace(/^ {0,3}>[ \t]?/, '')
      .replace(/^([ \t]*)[-+*][ \t]+/, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/(?<![\\*])\*\*(?=\S)(.+?\S)\*\*(?!\*)/g, '$1')
      .replace(/(?<![\\*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1')
      .replace(/(?<![\\_])__(?=\S)(.+?\S)__(?!_)/g, '$1')
      .replace(/(?<![\\_])_(?=\S)([^_\n]*?\S)_(?!_)/g, '$1')
      .replace(/\\([\\`*_[\]{}()#+.!<>-])/g, '$1');

    return line.replace(/\u0000CODE(\d+)\u0000/g, (_match, index) => codeSpans[Number(index)]);
  }).filter((line) => line !== null).join('\n');
}

export function buildReportExport(report, format) {
  const createdStr = report.created_at
    ? new Date(report.created_at).toLocaleString()
    : 'Unknown date';
  const sessionNames = (report.session_previews || []).map(sourceSessionName).join(', ') || 'Selected sessions';
  const filenameBase = `DTT_Report_${String(report.report_id || 'report').slice(0, 8)}`;

  if (format === 'md') {
    return {
      filename: `${filenameBase}.md`,
      mimeType: 'text/markdown',
      content: `# Discord Transcription Report\n` +
        `**Generated At:** ${createdStr}\n` +
        `**Language:** ${report.language}\n` +
        `**Model:** ${report.model}\n` +
        `**Source Sessions:** ${sessionNames}\n\n` +
        `---\n\n` +
        `${report.content || ''}`,
    };
  }

  if (format !== 'txt') throw new Error(`Unsupported report export format: ${format}`);
  return {
    filename: `${filenameBase}.txt`,
    mimeType: 'text/plain',
    content: `DISCORD TRANSCRIPTION REPORT\n` +
      `Generated At: ${createdStr}\n` +
      `Language: ${report.language}\n` +
      `Model: ${report.model}\n` +
      `Source Sessions: ${sessionNames}\n` +
      `--------------------------------------------------\n\n` +
      markdownToPlainText(report.content),
  };
}

function exportReport(format) {
  if (!currentActiveReport) return;
  const exported = buildReportExport(currentActiveReport, format);
  const blob = new Blob([exported.content], { type: exported.mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exported.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ----------------------------------------------------
// Event Listeners
// ----------------------------------------------------
toggleBtn.addEventListener('click', toggleConnection);
refreshBtn.addEventListener('click', loadChannels);
channelSelect.addEventListener('change', updateControls);
clearBtn.addEventListener('click', () => {
  transcriptList.innerHTML = '';
  utteranceElements.clear();
  updateEmptyState();
});

sessionSelect.addEventListener('change', handleSessionSelectChange);
vocabSaveBtn.addEventListener('click', saveVocabulary);
announcementUploadBtn.addEventListener('click', uploadAnnouncement);
announcementRemoveBtn.addEventListener('click', removeAnnouncement);
generateReportBtn.addEventListener('click', generateReport);
exportMdBtn.addEventListener('click', () => exportReport('md'));
exportTxtBtn.addEventListener('click', () => exportReport('txt'));

// Initial Load
if (!import.meta.env.VITEST) {
  renderActiveSpeakers();
  updateControls();
  connectEventStream();
  loadVocabulary();
  loadAnnouncementStatus();
  loadSessions();
  loadSavedReports();
  refreshStatus().then(() => {
    if (status.bot_ready) loadChannels();
  });
}
