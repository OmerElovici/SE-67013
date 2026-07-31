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
    statusText.textContent = `Listening · ${status.channel_name}`;
  } else if (state === 'ready') {
    statusDot.classList.add('connected');
    statusText.textContent = 'Bot Ready';
  } else if (state === 'connecting' || state === 'disconnecting' || state === 'starting') {
    statusDot.classList.add('connecting');
    statusText.textContent = state === 'starting' ? 'Bot Starting…' : `${capitalize(state)}…`;
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
    toggleText.textContent = isBusy ? 'Connecting…' : 'Connect Bot';
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
  channelSelect.innerHTML = '<option value="">Loading voice channels…</option>';

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

function handleEvent(event) {
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
    activeSpeakersElement.innerHTML = '<span class="speaker-placeholder">Waiting for someone to speak…</span>';
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
  vocabStatus.textContent = 'Saving…';
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
  announcementStatus.textContent = 'Validating and uploading MP3…';

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
async function loadSessions() {
  try {
    const payload = await apiRequest('/sessions');
    activeSessionId = payload.active_session ? payload.active_session.session_id : null;
    renderSessionSelects(payload.active_session, payload.past_sessions || []);
  } catch (err) {
    // Keep defaults
  }
}

function renderSessionSelects(activeSession, pastSessions) {
  const currentSessionVal = sessionSelect.value;
  sessionSelect.innerHTML = '';
  reportSessionsSelect.innerHTML = '';

  const activeLabel = activeSession
    ? `⚡ Live Active Session (${activeSession.channel_name || status.channel_name || 'Voice'})`
    : 'Live Active Session';

  const liveViewerOpt = document.createElement('option');
  liveViewerOpt.value = 'active';
  liveViewerOpt.textContent = activeLabel;
  sessionSelect.appendChild(liveViewerOpt);

  if (activeSession) {
    const activeReportOpt = document.createElement('option');
    activeReportOpt.value = activeSession.session_id;
    activeReportOpt.textContent = activeLabel;
    reportSessionsSelect.appendChild(activeReportOpt);
  }

  for (const s of pastSessions) {
    const dateStr = s.started_at ? new Date(s.started_at).toLocaleString() : 'Unknown date';
    const label = `${s.channel_name || 'Channel'} - ${dateStr} (${s.utterance_count} lines)`;

    const viewerOpt = document.createElement('option');
    viewerOpt.value = s.session_id;
    viewerOpt.textContent = label;
    sessionSelect.appendChild(viewerOpt);

    const reportOpt = document.createElement('option');
    reportOpt.value = s.session_id;
    reportOpt.textContent = label;
    reportSessionsSelect.appendChild(reportOpt);
  }

  if (currentSessionVal && Array.from(sessionSelect.options).some((o) => o.value === currentSessionVal)) {
    sessionSelect.value = currentSessionVal;
  } else {
    sessionSelect.value = 'active';
  }
  currentDisplayedSessionId = sessionSelect.value;
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
  reportErrorMessage.hidden = true;
  const selectedOptions = Array.from(reportSessionsSelect.selectedOptions).map((o) => o.value);

  if (!selectedOptions.length) {
    reportErrorMessage.textContent = 'Please select at least one session to summarize.';
    reportErrorMessage.hidden = false;
    return;
  }

  generateReportBtn.disabled = true;
  generateReportBtn.textContent = 'Generating report with Ollama…';

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
    reportErrorMessage.textContent = err.message;
    reportErrorMessage.hidden = false;
  } finally {
    generateReportBtn.disabled = false;
    generateReportBtn.textContent = 'Get Summary';
  }
}

async function loadSavedReports() {
  try {
    const payload = await apiRequest('/reports');
    renderSavedReportsList(payload.reports || []);
  } catch (err) {
    savedReportsList.innerHTML = '<p class="text-muted">Saved reports history unavailable.</p>';
  }
}

function renderSavedReportsList(reports) {
  if (!reports.length) {
    savedReportsList.innerHTML = '<p class="text-muted">No saved reports yet.</p>';
    return;
  }

  savedReportsList.innerHTML = '';
  for (const rep of reports) {
    const item = document.createElement('div');
    item.className = 'saved-report-item';

    const meta = document.createElement('div');
    meta.className = 'saved-report-meta';

    const timeStr = rep.created_at ? new Date(rep.created_at).toLocaleString() : 'Unknown date';
    const langLabel = rep.language === 'he' ? 'Hebrew (עברית)' : 'English';
    const sessionNames = (rep.session_previews || [])
      .map((s) => s.channel_name || s.session_id)
      .join(', ');

    meta.innerHTML = `
      <div class="saved-report-time">${timeStr} · ${langLabel}</div>
      <div class="saved-report-sess">Sessions: ${sessionNames || 'Selected sessions'}</div>
    `;

    item.appendChild(meta);
    item.addEventListener('click', () => {
      currentActiveReport = rep;
      renderReportDisplay(rep);
    });
    savedReportsList.appendChild(item);
  }
}

function renderReportDisplay(report) {
  reportTitle.textContent = `Summary Report (${new Date(report.created_at).toLocaleString()})`;
  reportContent.textContent = report.content;
  reportDisplayContainer.hidden = false;
}

function exportReport(format) {
  if (!currentActiveReport) return;

  const createdStr = new Date(currentActiveReport.created_at).toLocaleString();
  const sessionNames = (currentActiveReport.session_previews || [])
    .map((s) => `${s.channel_name} (${s.guild_name})`)
    .join(', ');

  let fileContent = '';
  let filename = `DTT_Report_${currentActiveReport.report_id.slice(0, 8)}`;
  let mimeType = 'text/plain';

  if (format === 'md') {
    mimeType = 'text/markdown';
    filename += '.md';
    fileContent = `# Discord Transcription Report\n` +
      `**Generated At:** ${createdStr}\n` +
      `**Language:** ${currentActiveReport.language}\n` +
      `**Model:** ${currentActiveReport.model}\n` +
      `**Source Sessions:** ${sessionNames}\n\n` +
      `---\n\n` +
      `${currentActiveReport.content}`;
  } else {
    filename += '.txt';
    const plainTextBody = currentActiveReport.content
      .replace(/#+\s?/g, '')
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/`/g, '');

    fileContent = `DISCORD TRANSCRIPTION REPORT\n` +
      `Generated At: ${createdStr}\n` +
      `Language: ${currentActiveReport.language}\n` +
      `Model: ${currentActiveReport.model}\n` +
      `Source Sessions: ${sessionNames}\n` +
      `--------------------------------------------------\n\n` +
      `${plainTextBody}`;
  }

  const blob = new Blob([fileContent], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
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
