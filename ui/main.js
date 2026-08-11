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
const sessionRecording = document.getElementById('sessionRecording');
const recordingStatus = document.getElementById('recordingStatus');
const replayStatus = document.getElementById('replayStatus');
const replaySeek = document.getElementById('replaySeek');
const replayTime = document.getElementById('replayTime');
const replayPlayBtn = document.getElementById('replayPlayBtn');
const replayPauseBtn = document.getElementById('replayPauseBtn');
const replayRestartBtn = document.getElementById('replayRestartBtn');
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
const reportDialog = document.getElementById('reportDialog');
const closeReportBtn = document.getElementById('closeReportBtn');
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
const ACTIVE_AUDIO_CHUNK_BYTES = 64 * 1024;
const ACTIVE_AUDIO_WINDOW_FRAMES = 5 * 48000;

let eventsSocket = null;
let reconnectTimer = null;
let status = { state: 'starting', connected: false, bot_ready: false };
let isBusy = false;
let currentActiveReport = null;
let currentDisplayedSessionId = 'active';
let transcriptViewVersion = 0;
let sessionLoadPromise = null;
let refreshAfterSessionLoad = false;
let recordingMetadataReady = false;
let pendingRecordingSeek = null;
let pendingRecordingPlay = false;
let pendingProgrammaticRecordingSeek = null;
let activeClipPlayback = null;
let clipBoundaryFrame = null;
let replayState = 'unavailable';
let replayEntries = [];
let replayCurrentSeconds = 0;
let replayDurationSeconds = 0;
let replayStartedAt = null;
let replayTimer = null;
let reportDialogReturnFocus = null;
let activeAudioSocket = null;
let activeAudioReconnectTimer = null;
let activeAudioSessionId = null;
let activeAudioStreamUrl = null;
let activeAudioConfirmedOffset = 0;
let activeAudioRevision = 0;
let activeAudioPendingChunk = null;
let activeAudioMessageChain = Promise.resolve();
let activeAudioContext = null;
let activeAudioSource = null;
let activeAudioChunks = [];
let activeAudioByteLength = 0;
let activeAudioPosition = 0;
let activeAudioResetPosition = null;
let activeAudioStartedAt = null;
let activeAudioPlayIntent = false;
let activeAudioPlaybackFrame = null;
let activeAudioSourceVersion = 0;
let activeAudioSourceEndPosition = 0;
const selectControllers = new Map();

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
  selectControllers.get(channelSelect)?.syncDisabledState();
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
  selectControllers.get(channelSelect)?.refresh();

  try {
    const payload = await apiRequest('/discord/channels');
    renderChannels(payload.channels);
    errorMessage.hidden = true;
  } catch (error) {
    channelSelect.innerHTML = '<option value="">Voice channels unavailable</option>';
    selectControllers.get(channelSelect)?.refresh();
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
  selectControllers.get(channelSelect)?.refresh();
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
      if (event.session_id && Number.isFinite(event.start_seconds)) {
        configureRecording({
          available: true,
          url: `/sessions/${event.session_id}/audio`,
          stream_url: `/sessions/${event.session_id}/audio/stream`,
          duration_seconds: event.end_seconds,
        }, event.session_id, true);
      }
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
  setTranscriptReplayTiming(row, event);

  if (event.finalized) {
    if (!event.text) row.remove();
    else addPlaybackAction(row, event);
    utteranceElements.delete(event.utterance_id);
  }

  updateEmptyState();
  syncTranscriptReplay();
  if (replayState !== 'playing' && replayState !== 'paused') {
    transcriptionPanel.scrollTop = transcriptionPanel.scrollHeight;
  }
}

function createTranscriptRow(event) {
  const row = document.createElement('article');
  row.className = `transcript-entry ${event.finalized ? '' : 'partial'}`;
  setTranscriptReplayTiming(row, event);

  const leading = document.createElement('div');
  leading.className = 'transcript-leading';
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
  leading.appendChild(avatar);

  const content = document.createElement('div');
  content.className = 'transcript-content';
  const name = document.createElement('div');
  name.className = 'speaker-name';
  name.textContent = event.speaker_name;
  const text = document.createElement('div');
  text.className = 'transcript-text';
  text.textContent = event.text;
  content.append(name, text);
  row.append(leading, content);
  if (event.finalized) addPlaybackAction(row, event);
  return row;
}

function setTranscriptReplayTiming(row, event) {
  const startSeconds = event.start_seconds;
  const endSeconds = event.end_seconds;
  if (
    Number.isFinite(startSeconds)
    && startSeconds >= 0
    && Number.isFinite(endSeconds)
    && endSeconds > startSeconds
  ) {
    row.dataset.replayStart = String(startSeconds);
    row.dataset.replayEnd = String(endSeconds);
    return;
  }
  delete row.dataset.replayStart;
  delete row.dataset.replayEnd;
}

function stopReplayTimer() {
  if (replayTimer !== null) {
    window.clearTimeout(replayTimer);
    replayTimer = null;
  }
}

function clearReplayHighlights() {
  for (const row of transcriptList.querySelectorAll('.replay-active')) {
    row.classList.remove('replay-active');
    row.removeAttribute('aria-current');
  }
}

function showAllReplayRows() {
  for (const row of transcriptList.querySelectorAll('.transcript-entry')) {
    row.hidden = false;
  }
}

function formatReplayTime(seconds) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function hasSynchronizedRecording() {
  return isRecordingAvailable() && replayEntries.length > 0;
}

function replayPlaybackLimit() {
  if (!hasSynchronizedRecording()) return replayDurationSeconds;
  const capturedThrough = Number(sessionRecording.dataset.capturedThrough);
  if (!Number.isFinite(capturedThrough) || capturedThrough < 0) {
    return replayDurationSeconds;
  }
  return capturedThrough;
}

function replayStatusPrefix() {
  return hasSynchronizedRecording() ? '' : 'Audio unavailable. ';
}

function updateReplayControls() {
  const available = replayState !== 'unavailable';
  const playbackLimit = replayPlaybackLimit();
  replayPlayBtn.disabled = !available || replayState === 'playing';
  replayPauseBtn.disabled = replayState !== 'playing';
  replayRestartBtn.disabled = !available;
  replaySeek.disabled = !available;
  replaySeek.max = String(playbackLimit);
  replaySeek.value = String(replayCurrentSeconds);
  replayTime.textContent = [
    formatReplayTime(replayCurrentSeconds),
    formatReplayTime(playbackLimit),
  ].join(' / ');

  if (replayState === 'playing') {
    replayStatus.textContent = hasSynchronizedRecording()
      ? 'Playing recording and transcript on one timeline.'
      : `${replayStatusPrefix()}Playing visual-only transcript at original timing.`;
  } else if (replayState === 'paused') {
    replayStatus.textContent = hasSynchronizedRecording()
      ? 'Recording and transcript replay paused.'
      : `${replayStatusPrefix()}Visual-only transcript replay paused.`;
  } else if (replayState === 'ended') {
    replayStatus.textContent = hasSynchronizedRecording()
      ? 'Recording and transcript replay finished.'
      : `${replayStatusPrefix()}Visual-only transcript replay finished.`;
  } else if (replayState === 'ready') {
    replayStatus.textContent = hasSynchronizedRecording()
      ? 'Ready to play recording and transcript together.'
      : `${replayStatusPrefix()}Ready for visual-only replay at original timing.`;
  } else {
    replayStatus.textContent = 'Transcript replay unavailable for this session.';
  }
}

function resetTranscriptReplay(resetRecordingPlayback = false) {
  stopReplayTimer();
  clearReplayHighlights();
  showAllReplayRows();
  replayState = 'unavailable';
  replayEntries = [];
  replayCurrentSeconds = 0;
  replayDurationSeconds = 0;
  replayStartedAt = null;
  if (resetRecordingPlayback) {
    pendingRecordingPlay = false;
    if (isRecordingAvailable()) {
      pauseRecording();
      seekRecording(0);
    }
    clearActiveClip();
  }
  updateReplayControls();
}

function syncTranscriptReplay() {
  if (replayState === 'playing') updateReplayClock();

  const rows = Array.from(transcriptList.querySelectorAll('.transcript-entry'));
  const entries = rows.map((row) => ({
    row,
    startSeconds: Number(row.dataset.replayStart),
    endSeconds: Number(row.dataset.replayEnd),
    valid: row.dataset.replayStart !== undefined
      && row.dataset.replayEnd !== undefined
      && Number.isFinite(Number(row.dataset.replayStart))
      && Number(row.dataset.replayStart) >= 0
      && Number.isFinite(Number(row.dataset.replayEnd))
      && Number(row.dataset.replayEnd) > Number(row.dataset.replayStart),
  }));

  if (!entries.length || entries.some((entry) => !entry.valid)) {
    resetTranscriptReplay();
    return;
  }

  replayEntries = entries;
  replayDurationSeconds = Math.max(...entries.map((entry) => entry.endSeconds));
  if (replayState === 'unavailable') {
    replayState = 'ready';
    replayCurrentSeconds = 0;
  } else if (replayCurrentSeconds > replayPlaybackLimit()) {
    replayCurrentSeconds = replayPlaybackLimit();
  }

  renderReplayPosition();
  updateReplayControls();
  if (replayState === 'playing') scheduleReplayBoundary();
}

function updateReplayClock() {
  if (replayState !== 'playing') return;
  if (hasSynchronizedRecording()) {
    const recordingPosition = !recordingMetadataReady && pendingRecordingSeek !== null
      ? pendingRecordingSeek
      : currentRecordingTime();
    replayCurrentSeconds = Math.min(
      replayPlaybackLimit(),
      Math.max(0, recordingPosition),
    );
    return;
  }
  if (replayStartedAt === null) return;
  replayCurrentSeconds = Math.min(
    replayPlaybackLimit(),
    Math.max(0, (Date.now() - replayStartedAt) / 1000),
  );
}

function renderReplayPosition() {
  const revealMode = replayState === 'playing' || replayState === 'paused';
  const activeRows = replayEntries
    .filter((entry) => (
      revealMode
      && entry.startSeconds <= replayCurrentSeconds
      && replayCurrentSeconds < entry.endSeconds
    ))
    .map((entry) => entry.row);
  const activeSet = new Set(activeRows);

  for (const { row, startSeconds } of replayEntries) {
    row.hidden = revealMode && startSeconds > replayCurrentSeconds;
    const active = activeSet.has(row);
    row.classList.toggle('replay-active', active);
    if (active) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
  if (activeRows.length) scrollReplayRowsIntoView(activeRows);
}

function seekTranscriptReplay() {
  if (replayState === 'unavailable') return;
  stopReplayTimer();
  replayStartedAt = null;
  replayCurrentSeconds = Math.min(
    replayPlaybackLimit(),
    Math.max(0, Number(replaySeek.value) || 0),
  );
  if (hasSynchronizedRecording()) {
    clearActiveClip();
    pendingRecordingPlay = false;
    pauseRecording();
    if (recordingMetadataReady) seekRecording(replayCurrentSeconds);
    else pendingRecordingSeek = replayCurrentSeconds;
  }
  replayState = replayCurrentSeconds >= replayPlaybackLimit() ? 'ended' : 'paused';
  renderReplayPosition();
  updateReplayControls();
}

function scrollReplayRowsIntoView(activeRows) {
  const firstTop = Math.min(...activeRows.map((row) => row.offsetTop));
  const lastBottom = Math.max(
    ...activeRows.map((row) => row.offsetTop + row.offsetHeight),
  );
  const viewportTop = transcriptionPanel.scrollTop;
  const viewportBottom = viewportTop + transcriptionPanel.clientHeight;
  let target = viewportTop;

  if (firstTop < viewportTop) target = firstTop;
  else if (lastBottom > viewportBottom) {
    target = Math.max(0, lastBottom - transcriptionPanel.clientHeight);
  }
  if (target !== viewportTop) transcriptionPanel.scrollTop = target;
}

function finishTranscriptReplay() {
  stopReplayTimer();
  replayCurrentSeconds = replayPlaybackLimit();
  replayStartedAt = null;
  replayState = 'ended';
  renderReplayPosition();
  updateReplayControls();
}

function scheduleReplayBoundary() {
  stopReplayTimer();
  if (replayState !== 'playing') return;
  updateReplayClock();
  renderReplayPosition();
  updateReplayControls();
  if (replayCurrentSeconds >= replayPlaybackLimit()) {
    finishTranscriptReplay();
    return;
  }
  if (hasSynchronizedRecording()) return;

  const boundaries = replayEntries.flatMap((entry) => [
    entry.startSeconds,
    entry.endSeconds,
  ]);
  const nextBoundary = Math.min(
    replayPlaybackLimit(),
    ...boundaries.filter((boundary) => boundary > replayCurrentSeconds + 0.0005),
  );
  const delay = Math.max(1, Math.ceil((nextBoundary - replayCurrentSeconds) * 1000));
  replayTimer = window.setTimeout(() => {
    replayTimer = null;
    scheduleReplayBoundary();
  }, delay);
}

function playTranscriptReplay() {
  if (replayState === 'unavailable' || replayState === 'playing') return;
  if (replayState === 'ended' || replayCurrentSeconds >= replayPlaybackLimit()) {
    replayCurrentSeconds = 0;
  }
  clearActiveClip();
  replayState = 'playing';
  if (hasSynchronizedRecording()) {
    replayStartedAt = null;
    startRecordingAt(replayCurrentSeconds);
  } else {
    replayStartedAt = Date.now() - replayCurrentSeconds * 1000;
  }
  updateReplayControls();
  scheduleReplayBoundary();
}

function pauseTranscriptReplay() {
  if (replayState !== 'playing') return;
  updateReplayClock();
  if (hasSynchronizedRecording()) {
    pendingRecordingPlay = false;
    pauseRecording();
  }
  if (replayCurrentSeconds >= replayPlaybackLimit()) {
    finishTranscriptReplay();
    return;
  }
  stopReplayTimer();
  replayStartedAt = null;
  replayState = 'paused';
  renderReplayPosition();
  updateReplayControls();
}

function restartTranscriptReplay() {
  if (replayState === 'unavailable') return;
  stopReplayTimer();
  clearReplayHighlights();
  clearActiveClip();
  replayCurrentSeconds = 0;
  replayState = 'playing';
  if (hasSynchronizedRecording()) {
    replayStartedAt = null;
    startRecordingAt(0);
  } else {
    replayStartedAt = Date.now();
  }
  updateReplayControls();
  scheduleReplayBoundary();
}

function addPlaybackAction(row, event) {
  const startSeconds = Number(event.start_seconds);
  const endSeconds = Number(event.end_seconds);
  const hasStart = Number.isFinite(event.start_seconds) && startSeconds >= 0;
  const hasClip = hasStart
    && Number.isFinite(event.end_seconds)
    && endSeconds > startSeconds;
  const leading = row.querySelector('.transcript-leading');
  const content = row.querySelector('.transcript-content');
  if (!leading || !content) return;

  if (!leading.querySelector('.play-clip')) {
    const clipButton = document.createElement('button');
    clipButton.className = 'play-clip';
    clipButton.type = 'button';
    clipButton.dataset.speakerName = event.speaker_name || 'transcript';
    if (hasClip) {
      clipButton.dataset.startSeconds = String(startSeconds);
      clipButton.dataset.endSeconds = String(endSeconds);
      clipButton.addEventListener('click', () => {
        playRecordingClip(clipButton, startSeconds, endSeconds);
      });
    }
    leading.appendChild(clipButton);
    setClipButtonState(
      clipButton,
      hasClip && isClipCaptured(endSeconds) ? 'idle' : 'unavailable',
    );
  }

  if (!hasStart || content.querySelector('.play-from-here')) return;

  const actions = document.createElement('div');
  actions.className = 'transcript-actions';
  const button = document.createElement('button');
  button.className = 'play-from-here';
  button.type = 'button';
  button.textContent = 'Play from here';
  button.addEventListener('click', () => playRecordingFrom(startSeconds));
  actions.appendChild(button);
  content.appendChild(actions);
}

function isRecordingAvailable() {
  if (activeAudioSessionId) return activeAudioConfirmedOffset > 0;
  return !sessionRecording.hidden && Boolean(sessionRecording.getAttribute('src'));
}

function pauseRecording() {
  if (activeAudioSessionId) pauseActiveAudioPlayback();
  else sessionRecording.pause();
}

function playRecording() {
  if (activeAudioSessionId) return startActiveAudioPlayback();
  return sessionRecording.play();
}

function isRecordingPaused() {
  return activeAudioSessionId ? !activeAudioPlayIntent : sessionRecording.paused;
}

function isClipCaptured(endSeconds) {
  const capturedThrough = Number(sessionRecording.dataset.capturedThrough);
  return isRecordingAvailable()
    && Number.isFinite(capturedThrough)
    && endSeconds <= capturedThrough;
}

function setClipButtonState(button, state) {
  const speakerName = button.dataset.speakerName;
  button.dataset.state = state;
  button.disabled = state === 'unavailable';
  button.setAttribute('aria-pressed', state === 'playing' ? 'true' : 'false');

  if (state === 'playing') {
    button.textContent = 'Playing';
    button.setAttribute('aria-label', `Playing audio clip for ${speakerName}`);
  } else if (state === 'completed') {
    button.textContent = 'Replay clip';
    button.setAttribute('aria-label', `Replay audio clip for ${speakerName}`);
  } else if (state === 'unavailable') {
    button.textContent = 'Unavailable';
    button.setAttribute('aria-label', `Audio clip unavailable for ${speakerName}`);
  } else {
    button.textContent = 'Play clip';
    button.setAttribute('aria-label', `Play audio clip for ${speakerName}`);
  }
}

function updateClipAvailability() {
  for (const button of transcriptList.querySelectorAll('.play-clip')) {
    const startSeconds = Number(button.dataset.startSeconds);
    const endSeconds = Number(button.dataset.endSeconds);
    const hasClip = Number.isFinite(startSeconds)
      && startSeconds >= 0
      && Number.isFinite(endSeconds)
      && endSeconds > startSeconds;
    if (!hasClip || !isClipCaptured(endSeconds)) {
      if (activeClipPlayback?.button === button) clearActiveClip();
      setClipButtonState(button, 'unavailable');
    } else if (activeClipPlayback?.button !== button) {
      const state = button.dataset.state === 'completed' ? 'completed' : 'idle';
      setClipButtonState(button, state);
    }
  }
}

function clearActiveClip(state = 'idle') {
  if (clipBoundaryFrame !== null) {
    cancelAnimationFrame(clipBoundaryFrame);
    clipBoundaryFrame = null;
  }
  if (!activeClipPlayback) return;
  const { button } = activeClipPlayback;
  activeClipPlayback = null;
  if (button.isConnected && !button.disabled) setClipButtonState(button, state);
}

function playRecordingClip(button, startSeconds, endSeconds) {
  if (button.disabled || !isClipCaptured(endSeconds)) {
    recordingStatus.textContent = 'Playback unavailable for this session.';
    updateClipAvailability();
    return;
  }
  clearActiveClip();
  stopReplayTimer();
  clearReplayHighlights();
  showAllReplayRows();
  replayStartedAt = null;
  if (replayState !== 'unavailable') {
    replayCurrentSeconds = Math.min(
      replayPlaybackLimit(),
      Math.max(0, startSeconds),
    );
    replayState = 'ready';
    updateReplayControls();
  }
  activeClipPlayback = { button, endSeconds };
  setClipButtonState(button, 'playing');
  startRecordingAt(startSeconds);
  scheduleClipBoundaryCheck();
}

function scheduleClipBoundaryCheck() {
  if (!activeClipPlayback || clipBoundaryFrame !== null) return;
  clipBoundaryFrame = requestAnimationFrame(() => {
    clipBoundaryFrame = null;
    if (!activeClipPlayback) return;
    if (currentRecordingTime() >= activeClipPlayback.endSeconds) {
      completeClipPlayback();
    } else if (!isRecordingPaused()) {
      scheduleClipBoundaryCheck();
    }
  });
}

function completeClipPlayback() {
  if (!activeClipPlayback) return;
  const endSeconds = activeClipPlayback.endSeconds;
  pauseRecording();
  seekRecording(endSeconds);
  clearActiveClip('completed');
  if (replayState !== 'unavailable') {
    replayCurrentSeconds = Math.min(replayPlaybackLimit(), endSeconds);
    replayStartedAt = null;
    replayState = replayCurrentSeconds >= replayPlaybackLimit() ? 'ended' : 'ready';
    clearReplayHighlights();
    showAllReplayRows();
    updateReplayControls();
  }
}

function playRecordingFrom(startSeconds) {
  if (!isRecordingAvailable()) {
    recordingStatus.textContent = 'Playback unavailable for this session.';
    return;
  }
  clearActiveClip();
  const seekTarget = Math.max(0, startSeconds);
  if (!recordingMetadataReady) {
    pendingRecordingSeek = seekTarget;
    pendingRecordingPlay = true;
    return;
  }
  startRecordingPlayback(seekTarget);
}

function startRecordingAt(seekTarget) {
  if (!recordingMetadataReady) {
    pendingRecordingSeek = seekTarget;
    pendingRecordingPlay = true;
    return;
  }
  startRecordingPlayback(seekTarget);
}

function startRecordingPlayback(seekTarget) {
  seekRecording(seekTarget);
  if (!activeClipPlayback && replayState !== 'unavailable' && replayEntries.length) {
    stopReplayTimer();
    replayCurrentSeconds = Math.min(
      replayPlaybackLimit(),
      Math.max(0, seekTarget),
    );
    replayStartedAt = null;
    replayState = 'playing';
    renderReplayPosition();
    updateReplayControls();
  }
  const playback = playRecording();
  if (playback && typeof playback.catch === 'function') {
    playback.catch(() => {
      handleRecordingPlaybackFailure();
    });
  }
}

function seekRecording(seekTarget) {
  pendingProgrammaticRecordingSeek = seekTarget;
  if (activeAudioSessionId) seekActiveAudio(seekTarget);
  else sessionRecording.currentTime = seekTarget;
}

function syncReplayFromRecording(nextState = null) {
  if (replayState === 'unavailable' || !replayEntries.length) return;
  stopReplayTimer();
  replayStartedAt = null;
  replayCurrentSeconds = Math.min(
    replayPlaybackLimit(),
    Math.max(0, currentRecordingTime()),
  );
  if (activeClipPlayback) {
    replayState = replayCurrentSeconds >= replayPlaybackLimit() ? 'ended' : 'ready';
    clearReplayHighlights();
    showAllReplayRows();
    updateReplayControls();
    return;
  }
  if (nextState) replayState = nextState;
  if (replayCurrentSeconds >= replayPlaybackLimit()) replayState = 'ended';
  renderReplayPosition();
  updateReplayControls();
}

function handleRecordingPlaybackFailure() {
  const previousReplayState = replayState;
  const wasPlaying = replayState === 'playing';
  const wasClipPlayback = Boolean(activeClipPlayback);
  const failedAt = Math.max(0, currentRecordingTime(), replayCurrentSeconds);
  releaseActiveAudioStream(false);
  recordingMetadataReady = false;
  pendingRecordingSeek = null;
  pendingRecordingPlay = false;
  pendingProgrammaticRecordingSeek = null;
  clearActiveClip();
  sessionRecording.removeAttribute('src');
  sessionRecording.hidden = true;
  recordingStatus.textContent = 'Playback unavailable for this session.';
  updateClipAvailability();

  if (replayState === 'unavailable' || !replayEntries.length) return;
  replayCurrentSeconds = Math.min(replayDurationSeconds, failedAt);
  if (wasPlaying && !wasClipPlayback && replayCurrentSeconds < replayDurationSeconds) {
    replayState = 'playing';
    replayStartedAt = Date.now() - replayCurrentSeconds * 1000;
    scheduleReplayBoundary();
  } else {
    stopReplayTimer();
    replayStartedAt = null;
    if (replayCurrentSeconds >= replayDurationSeconds) replayState = 'ended';
    else if (previousReplayState === 'ready') replayState = 'ready';
    else replayState = 'paused';
    renderReplayPosition();
    updateReplayControls();
  }
}

function releaseActiveAudioStream(removeSource = true) {
  activeAudioSessionId = null;
  activeAudioStreamUrl = null;
  if (activeAudioReconnectTimer !== null) {
    window.clearTimeout(activeAudioReconnectTimer);
    activeAudioReconnectTimer = null;
  }
  const socket = activeAudioSocket;
  activeAudioSocket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  activeAudioPendingChunk = null;
  activeAudioConfirmedOffset = 0;
  activeAudioRevision = 0;
  activeAudioMessageChain = Promise.resolve();
  activeAudioPlayIntent = false;
  stopActiveAudioSource();
  if (activeAudioPlaybackFrame !== null) {
    cancelAnimationFrame(activeAudioPlaybackFrame);
    activeAudioPlaybackFrame = null;
  }
  activeAudioContext?.close();
  activeAudioContext = null;
  activeAudioChunks = [];
  activeAudioByteLength = 0;
  activeAudioPosition = 0;
  activeAudioResetPosition = null;
  activeAudioStartedAt = null;
  if (removeSource) sessionRecording.removeAttribute('src');
}

function activeAudioDuration() {
  return activeAudioByteLength / (48000 * 2 * 2);
}

function writeActiveAudioRange(offset, data) {
  const source = new Uint8Array(data);
  let sourceOffset = 0;
  while (sourceOffset < source.byteLength) {
    const targetOffset = offset + sourceOffset;
    const chunkIndex = Math.floor(targetOffset / ACTIVE_AUDIO_CHUNK_BYTES);
    const chunkOffset = targetOffset % ACTIVE_AUDIO_CHUNK_BYTES;
    if (!activeAudioChunks[chunkIndex]) {
      activeAudioChunks[chunkIndex] = new Uint8Array(ACTIVE_AUDIO_CHUNK_BYTES);
    }
    const copySize = Math.min(
      source.byteLength - sourceOffset,
      ACTIVE_AUDIO_CHUNK_BYTES - chunkOffset,
    );
    activeAudioChunks[chunkIndex].set(
      source.subarray(sourceOffset, sourceOffset + copySize),
      chunkOffset,
    );
    sourceOffset += copySize;
  }
  activeAudioByteLength = Math.max(activeAudioByteLength, offset + source.byteLength);
}

function activeAudioSample(byteOffset) {
  const chunkIndex = Math.floor(byteOffset / ACTIVE_AUDIO_CHUNK_BYTES);
  const chunkOffset = byteOffset % ACTIVE_AUDIO_CHUNK_BYTES;
  const chunk = activeAudioChunks[chunkIndex];
  const value = chunk[chunkOffset] | (chunk[chunkOffset + 1] << 8);
  return (value & 0x8000 ? value - 0x10000 : value) / 32768;
}

function currentRecordingTime() {
  if (!activeAudioSessionId) return Number(sessionRecording.currentTime) || 0;
  if (activeAudioStartedAt === null || !activeAudioContext) return activeAudioPosition;
  return Math.min(
    activeAudioDuration(),
    activeAudioSource ? activeAudioSourceEndPosition : activeAudioDuration(),
    activeAudioPosition + activeAudioContext.currentTime - activeAudioStartedAt,
  );
}

function stopActiveAudioSource() {
  activeAudioSourceVersion += 1;
  const source = activeAudioSource;
  activeAudioSource = null;
  activeAudioSourceEndPosition = activeAudioPosition;
  if (source) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // The source may already have ended.
    }
  }
  activeAudioStartedAt = null;
}

function seekActiveAudio(position) {
  stopActiveAudioSource();
  activeAudioPosition = Math.min(activeAudioDuration(), Math.max(0, position));
  sessionRecording.currentTime = activeAudioPosition;
}

function scheduleActiveAudioPlaybackUpdate() {
  if (activeAudioPlaybackFrame !== null || !activeAudioPlayIntent) return;
  activeAudioPlaybackFrame = requestAnimationFrame(() => {
    activeAudioPlaybackFrame = null;
    if (!activeAudioPlayIntent) return;
    sessionRecording.currentTime = currentRecordingTime();
    syncReplayFromRecording();
    if (
      activeClipPlayback
      && sessionRecording.currentTime >= activeClipPlayback.endSeconds
    ) {
      completeClipPlayback();
      return;
    }
    scheduleActiveAudioPlaybackUpdate();
  });
}

function startActiveAudioPlayback() {
  if (!activeAudioContext || !activeAudioByteLength) {
    activeAudioPlayIntent = true;
    return Promise.resolve();
  }
  stopActiveAudioSource();
  const startFrame = Math.floor(activeAudioPosition * 48000);
  const totalFrames = activeAudioByteLength / 4;
  if (startFrame >= totalFrames) {
    activeAudioPlayIntent = true;
    return Promise.resolve();
  }

  const frameCount = Math.min(
    totalFrames - startFrame,
    ACTIVE_AUDIO_WINDOW_FRAMES,
  );
  const buffer = activeAudioContext.createBuffer(2, frameCount, 48000);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const byteOffset = (startFrame + frame) * 4;
    left[frame] = activeAudioSample(byteOffset);
    right[frame] = activeAudioSample(byteOffset + 2);
  }

  const source = activeAudioContext.createBufferSource();
  const sourceVersion = ++activeAudioSourceVersion;
  source.buffer = buffer;
  activeAudioSourceEndPosition = (startFrame + frameCount) / 48000;
  source.connect(activeAudioContext.destination);
  source.onended = () => {
    if (sourceVersion !== activeAudioSourceVersion || source !== activeAudioSource) return;
    activeAudioPosition = activeAudioSourceEndPosition;
    activeAudioStartedAt = null;
    activeAudioSource = null;
    if (activeAudioPlayIntent && activeAudioPosition < activeAudioDuration()) {
      startActiveAudioPlayback();
    }
  };
  activeAudioSource = source;
  activeAudioStartedAt = activeAudioContext.currentTime;
  activeAudioPlayIntent = true;
  source.start();
  scheduleActiveAudioPlaybackUpdate();
  return activeAudioContext.resume();
}

function pauseActiveAudioPlayback() {
  if (!activeAudioSessionId) return;
  activeAudioPosition = currentRecordingTime();
  activeAudioPlayIntent = false;
  stopActiveAudioSource();
  sessionRecording.currentTime = activeAudioPosition;
}

function updateActiveAudioCapturedThrough() {
  const capturedThrough = activeAudioConfirmedOffset / (48000 * 2 * 2);
  sessionRecording.dataset.capturedThrough = String(capturedThrough);
  updateClipAvailability();
  if (replayEntries.length) {
    renderReplayPosition();
    updateReplayControls();
  }
}

function scheduleActiveAudioReconnect() {
  if (!activeAudioSessionId || activeAudioReconnectTimer !== null) return;
  activeAudioReconnectTimer = window.setTimeout(() => {
    activeAudioReconnectTimer = null;
    connectActiveAudioStream();
  }, 1000);
}

async function handleActiveAudioMessage(event, socket) {
  if (socket !== activeAudioSocket) return;
  if (typeof event.data === 'string') {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      failActiveAudioStream();
      return;
    }
    if (message.type === 'ready') {
      if (
        message.session_id !== activeAudioSessionId
        || !Number.isInteger(message.revision)
        || message.revision < activeAudioRevision
        || message.sample_rate !== 48000
        || message.channels !== 2
        || message.sample_width !== 2
      ) {
        failActiveAudioStream();
        return;
      }
      if (message.reset) {
        const shouldResume = activeAudioPlayIntent;
        const resumePosition = currentRecordingTime();
        stopActiveAudioSource();
        activeAudioChunks = [];
        activeAudioByteLength = 0;
        activeAudioConfirmedOffset = 0;
        activeAudioPosition = 0;
        sessionRecording.currentTime = 0;
        activeAudioPlayIntent = shouldResume;
        activeAudioResetPosition = Math.max(0, resumePosition);
      }
      if (message.offset !== activeAudioConfirmedOffset) {
        failActiveAudioStream();
        return;
      }
      activeAudioRevision = message.revision;
      recordingStatus.textContent = 'Live recording. Playback ends at the latest captured point.';
      return;
    }
    if (message.type === 'chunk') {
      if (
        activeAudioPendingChunk
        || !Number.isInteger(message.id)
        || !Number.isInteger(message.offset)
        || !Number.isInteger(message.size)
        || !Number.isInteger(message.revision)
        || message.offset < 0
        || message.offset > activeAudioByteLength
        || message.size <= 0
        || message.size % 4
      ) {
        failActiveAudioStream();
        return;
      }
      activeAudioPendingChunk = message;
      return;
    }
    if (message.type === 'complete') {
      const completedSessionId = activeAudioSessionId;
      const completedUrl = message.url;
      const completedDuration = activeAudioConfirmedOffset / (48000 * 2 * 2);
      releaseActiveAudioStream();
      configureRecording({
        available: Boolean(completedUrl),
        url: completedUrl,
        duration_seconds: completedDuration,
      }, completedSessionId);
      return;
    }
    if (message.type === 'error') {
      failActiveAudioStream();
      return;
    }
    failActiveAudioStream();
    return;
  }

  if (!activeAudioPendingChunk) {
    failActiveAudioStream();
    return;
  }
  const data = event.data instanceof ArrayBuffer
    ? event.data
    : await event.data.arrayBuffer();
  const {
    id, offset, size, revision,
  } = activeAudioPendingChunk;
  activeAudioPendingChunk = null;
  if (data.byteLength !== size || socket !== activeAudioSocket) {
    failActiveAudioStream();
    return;
  }
  const wasReplacement = offset < activeAudioByteLength;
  writeActiveAudioRange(offset, data);
  activeAudioConfirmedOffset = activeAudioByteLength;
  activeAudioRevision = Math.max(activeAudioRevision, revision);
  if (
    activeAudioResetPosition !== null
    && activeAudioDuration() >= activeAudioResetPosition
  ) {
    activeAudioPosition = activeAudioResetPosition;
    sessionRecording.currentTime = activeAudioPosition;
    activeAudioResetPosition = null;
  }
  updateActiveAudioCapturedThrough();
  if (wasReplacement && activeAudioPlayIntent) {
    const resumePosition = currentRecordingTime();
    seekActiveAudio(resumePosition);
    startActiveAudioPlayback();
  } else if (
    activeAudioPlayIntent
    && !activeAudioSource
    && activeAudioResetPosition === null
  ) {
    startActiveAudioPlayback();
  }
  if (activeAudioSocket?.readyState === WebSocket.OPEN) {
    activeAudioSocket.send(JSON.stringify({
      type: 'ack',
      id,
    }));
  }
}

function connectActiveAudioStream() {
  if (!activeAudioSessionId || !activeAudioStreamUrl || activeAudioSocket) return;
  const socket = new WebSocket(`${wsProtocol}//${backendHost}/v1${activeAudioStreamUrl}`);
  socket.binaryType = 'arraybuffer';
  activeAudioSocket = socket;
  activeAudioPendingChunk = null;

  socket.onopen = () => {
    if (socket !== activeAudioSocket) return;
    socket.send(JSON.stringify({
      type: 'resume',
      offset: activeAudioConfirmedOffset,
      revision: activeAudioRevision,
    }));
  };
  socket.onmessage = (event) => {
    activeAudioMessageChain = activeAudioMessageChain
      .then(() => handleActiveAudioMessage(event, socket))
      .catch(() => failActiveAudioStream());
  };
  socket.onerror = () => socket.close();
  socket.onclose = () => {
    if (socket !== activeAudioSocket) return;
    activeAudioSocket = null;
    activeAudioPendingChunk = null;
    scheduleActiveAudioReconnect();
  };
}

function failActiveAudioStream() {
  const failedSessionId = activeAudioSessionId;
  releaseActiveAudioStream();
  if (sessionRecording.dataset.sessionId === failedSessionId) {
    delete sessionRecording.dataset.sessionId;
    delete sessionRecording.dataset.capturedThrough;
    sessionRecording.hidden = true;
    recordingMetadataReady = false;
    recordingStatus.textContent = 'Live playback unavailable. Transcription remains active.';
    updateClipAvailability();
    updateReplayControls();
  }
}

function configureActiveRecording(recording, sessionId) {
  if (activeAudioSessionId === sessionId) {
    updateClipAvailability();
    return;
  }
  releaseActiveAudioStream();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    delete sessionRecording.dataset.sessionId;
    delete sessionRecording.dataset.capturedThrough;
    sessionRecording.hidden = true;
    recordingMetadataReady = false;
    recordingStatus.textContent = 'Live playback unavailable. Transcription remains active.';
    updateClipAvailability();
    return;
  }

  activeAudioSessionId = sessionId;
  activeAudioStreamUrl = recording.stream_url;
  activeAudioContext = new AudioContextClass();
  sessionRecording.removeAttribute('src');
  sessionRecording.dataset.sessionId = sessionId;
  sessionRecording.dataset.capturedThrough = '0';
  sessionRecording.hidden = true;
  recordingMetadataReady = true;
  recordingStatus.textContent = 'Connecting live recording playback...';
  connectActiveAudioStream();
}

function configureRecording(recording, sessionId, isActive = false) {
  if (isActive && recording?.available && recording.stream_url) {
    configureActiveRecording(recording, sessionId);
    return;
  }
  if (!recording?.available || !recording.url) {
    const previousReplayState = replayState;
    const continueVisualReplay = replayState === 'playing' && !activeClipPlayback;
    const fallbackPosition = Math.max(
      replayCurrentSeconds,
      currentRecordingTime(),
    );
    releaseActiveAudioStream(false);
    if (!sessionRecording.hidden || activeAudioSessionId) pauseRecording();
    clearActiveClip();
    sessionRecording.removeAttribute('src');
    delete sessionRecording.dataset.sessionId;
    delete sessionRecording.dataset.capturedThrough;
    recordingMetadataReady = false;
    pendingRecordingSeek = null;
    pendingRecordingPlay = false;
    pendingProgrammaticRecordingSeek = null;
    sessionRecording.hidden = true;
    recordingStatus.textContent = 'Playback unavailable for this session.';
    updateClipAvailability();
    if (replayEntries.length) {
      replayCurrentSeconds = Math.min(replayDurationSeconds, fallbackPosition);
      if (continueVisualReplay && replayCurrentSeconds < replayDurationSeconds) {
        replayState = 'playing';
        replayStartedAt = Date.now() - replayCurrentSeconds * 1000;
        scheduleReplayBoundary();
      } else {
        if (previousReplayState === 'ready') replayState = 'ready';
        renderReplayPosition();
        updateReplayControls();
      }
    }
    return;
  }

  releaseActiveAudioStream(false);
  const baseSource = `${apiBase}${recording.url}`;
  const capturedThrough = Number(recording.duration_seconds);
  const currentSessionId = sessionRecording.dataset.sessionId;
  const currentCapturedThrough = Number(
    sessionRecording.dataset.capturedThrough || 0,
  );
  if (
    isActive
    && currentSessionId === sessionId
    && Number.isFinite(capturedThrough)
    && capturedThrough <= currentCapturedThrough
  ) {
    updateClipAvailability();
    return;
  }

  const source = baseSource;
  if (sessionRecording.getAttribute('src') !== source) {
    const sameSession = currentSessionId === sessionId;
    const previousTime = Number.isFinite(sessionRecording.currentTime)
      ? sessionRecording.currentTime
      : 0;
    const shouldResume = replayState === 'playing'
      || (!sessionRecording.paused && !sessionRecording.ended);
    if (sameSession) {
      if (pendingRecordingSeek === null && previousTime > 0) {
        pendingRecordingSeek = previousTime;
      }
      pendingRecordingPlay ||= shouldResume;
    } else {
      clearActiveClip();
      pendingRecordingSeek = null;
      pendingRecordingPlay = false;
      pendingProgrammaticRecordingSeek = null;
    }
    recordingMetadataReady = false;
    sessionRecording.src = source;
  }
  sessionRecording.dataset.sessionId = sessionId;
  if (Number.isFinite(capturedThrough) && capturedThrough >= 0) {
    sessionRecording.dataset.capturedThrough = String(capturedThrough);
  } else {
    delete sessionRecording.dataset.capturedThrough;
  }
  sessionRecording.hidden = false;
  updateClipAvailability();
  if (replayEntries.length) {
    if (replayCurrentSeconds > replayPlaybackLimit()) {
      replayCurrentSeconds = replayPlaybackLimit();
    }
    renderReplayPosition();
    updateReplayControls();
  }
  recordingStatus.textContent = 'Full session recording available.';
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
    if (activeSessionId && sessionSelect.value === 'active') {
      const viewVersion = transcriptViewVersion;
      try {
        const detail = await apiRequest(`/sessions/${activeSessionId}`);
        if (viewVersion === transcriptViewVersion && sessionSelect.value === 'active') {
          renderHistoricalSession(detail);
        }
      } catch {
        if (viewVersion === transcriptViewVersion && sessionSelect.value === 'active') {
          configureRecording(null, activeSessionId);
        }
      }
    }
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
  if (currentDisplayedSessionId !== sessionSelect.value) {
    transcriptViewVersion += 1;
    resetTranscriptReplay(true);
    configureRecording(null, null);
    transcriptList.innerHTML = '';
    utteranceElements.clear();
    updateEmptyState();
  }
  currentDisplayedSessionId = sessionSelect.value;
  if (sessionSelect.value === 'active' && !activeSession) {
    configureRecording(null, null);
  }
  const total = pastSessions.length + (activeSession ? 1 : 0);
  sessionStatus.textContent = total ? `${total} available` : 'Empty';
  reportSessionsSelect.setAttribute('aria-busy', 'false');
  selectControllers.get(sessionSelect)?.refresh();
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
  const viewVersion = ++transcriptViewVersion;
  currentDisplayedSessionId = val;
  resetTranscriptReplay(true);
  configureRecording(null, null);

  if (val === 'active') {
    if (activeSessionId) {
      try {
        const detail = await apiRequest(`/sessions/${activeSessionId}`);
        if (viewVersion === transcriptViewVersion && sessionSelect.value === val) {
          renderHistoricalSession(detail);
        }
        return;
      } catch {
        // Fallback to clearing on error
      }
    }
    transcriptList.innerHTML = '';
    utteranceElements.clear();
    configureRecording(null, null);
    updateEmptyState();
    return;
  }

  try {
    const detail = await apiRequest(`/sessions/${val}`);
    if (viewVersion === transcriptViewVersion && sessionSelect.value === val) {
      renderHistoricalSession(detail);
    }
  } catch (err) {
    if (viewVersion === transcriptViewVersion && sessionSelect.value === val) {
      showError(`Could not load session transcript: ${err.message}`);
    }
  }
}

function renderHistoricalSession(detail) {
  resetTranscriptReplay();
  transcriptList.innerHTML = '';
  utteranceElements.clear();

  for (const utt of detail.transcripts || []) {
    const row = createTranscriptRow({
      utterance_id: utt.utterance_id,
      speaker_name: utt.speaker_name,
      avatar_url: utt.avatar_url,
      text: utt.text,
      finalized: true,
      start_seconds: utt.start_seconds,
      end_seconds: utt.end_seconds,
    });
    transcriptList.appendChild(row);
  }
  configureRecording(
    detail.recording,
    detail.session?.session_id,
    detail.session?.status === 'active',
  );
  updateEmptyState();
  syncTranscriptReplay();
}

// ----------------------------------------------------
// 4. Reports & Summaries & Export
// ----------------------------------------------------
function createSelectController(select, root, instanceIndex) {
  const labelId = root.dataset.labelId;
  const idPrefix = `${select.id || 'select'}Custom${instanceIndex}`;
  const control = document.createElement('div');
  control.className = 'select-control';
  const trigger = document.createElement('button');
  trigger.id = `${idPrefix}Trigger`;
  trigger.className = 'select-trigger';
  trigger.type = 'button';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', `${idPrefix}Content`);
  trigger.setAttribute('aria-labelledby', `${labelId} ${idPrefix}Value`);
  trigger.dataset.state = 'closed';
  const valueText = document.createElement('span');
  valueText.id = `${idPrefix}Value`;
  valueText.className = 'select-value';
  const indicator = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  indicator.classList.add('select-indicator');
  indicator.setAttribute('viewBox', '0 0 24 24');
  indicator.setAttribute('aria-hidden', 'true');
  const indicatorPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  indicatorPath.setAttribute('d', 'm7 10 5 5 5-5');
  indicatorPath.setAttribute('fill', 'none');
  indicatorPath.setAttribute('stroke', 'currentColor');
  indicatorPath.setAttribute('stroke-linecap', 'round');
  indicatorPath.setAttribute('stroke-linejoin', 'round');
  indicatorPath.setAttribute('stroke-width', '2');
  indicator.appendChild(indicatorPath);
  trigger.append(valueText, indicator);
  const positioner = document.createElement('div');
  positioner.className = 'select-positioner';
  positioner.hidden = true;
  const content = document.createElement('div');
  content.id = `${idPrefix}Content`;
  content.className = 'select-content';
  content.setAttribute('role', 'listbox');
  content.setAttribute('aria-labelledby', labelId);
  content.tabIndex = -1;
  content.dataset.state = 'closed';
  positioner.appendChild(content);
  control.append(trigger, positioner);
  root.appendChild(control);
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  let entries = [];
  let highlightedIndex = -1;

  function availableIndexes() {
    return entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => !entry.disabled)
      .map(({ index }) => index);
  }

  function highlight(index) {
    entries.forEach(({ item }) => item.removeAttribute('data-highlighted'));
    const available = availableIndexes();
    const nextIndex = available.includes(index) ? index : available[0];
    const entry = entries[nextIndex];
    if (!entry) {
      highlightedIndex = -1;
      content.removeAttribute('aria-activedescendant');
      return;
    }
    highlightedIndex = nextIndex;
    entry.item.setAttribute('data-highlighted', '');
    content.setAttribute('aria-activedescendant', entry.item.id);
    if (typeof entry.item.scrollIntoView === 'function') {
      entry.item.scrollIntoView({ block: 'nearest' });
    }
  }

  function moveHighlight(offset) {
    const available = availableIndexes();
    if (!available.length) return;
    const currentPosition = Math.max(0, available.indexOf(highlightedIndex));
    const nextPosition = Math.max(
      0,
      Math.min(currentPosition + offset, available.length - 1),
    );
    highlight(available[nextPosition]);
  }

  function close({ restoreFocus = true } = {}) {
    if (trigger.getAttribute('aria-expanded') !== 'true') return;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.dataset.state = 'closed';
    content.dataset.state = 'closed';
    positioner.hidden = true;
    highlightedIndex = -1;
    content.removeAttribute('aria-activedescendant');
    entries.forEach(({ item }) => item.removeAttribute('data-highlighted'));
    if (restoreFocus) trigger.focus();
  }

  function syncSelection() {
    const selectedOption = select.selectedOptions[0] || select.options[0];
    valueText.textContent = selectedOption?.textContent || 'Select an option';
    entries.forEach((entry) => {
      const selected = entry.option === selectedOption;
      entry.item.setAttribute('aria-selected', String(selected));
      entry.item.dataset.state = selected ? 'checked' : 'unchecked';
    });
  }

  function addOption(option, groupDisabled = false) {
    const item = document.createElement('div');
    item.id = `${idPrefix}Option${entries.length}`;
    item.className = 'select-item';
    item.setAttribute('role', 'option');
    item.dataset.value = option.value;
    const text = document.createElement('span');
    text.className = 'select-item-text';
    text.textContent = option.textContent;
    const check = document.createElement('span');
    check.className = 'select-item-indicator';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';
    item.append(text, check);
    const entry = {
      item,
      option,
      groupDisabled,
      disabled: select.disabled || groupDisabled || option.disabled,
    };
    const entryIndex = entries.length;
    entries.push(entry);
    item.addEventListener('pointermove', () => {
      if (!entry.disabled) highlight(entryIndex);
    });
    item.addEventListener('pointerdown', (event) => event.preventDefault());
    item.addEventListener('click', () => {
      if (entry.disabled) return;
      const changed = select.value !== option.value;
      select.value = option.value;
      syncSelection();
      close();
      if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    content.appendChild(item);
  }

  function syncDisabledState() {
    for (const entry of entries) {
      entry.disabled = select.disabled || entry.groupDisabled || entry.option.disabled;
      entry.item.setAttribute('aria-disabled', String(entry.disabled));
      entry.item.toggleAttribute('data-disabled', entry.disabled);
    }
    trigger.disabled = select.disabled || !availableIndexes().length;
    trigger.setAttribute('aria-disabled', String(trigger.disabled));
    if (trigger.disabled) {
      close({ restoreFocus: false });
    } else if (
      trigger.getAttribute('aria-expanded') === 'true'
      && entries[highlightedIndex]?.disabled
    ) {
      const selectedIndex = entries.findIndex(
        (entry) => entry.option.selected && !entry.disabled,
      );
      highlight(selectedIndex);
    }
  }

  function refresh() {
    close({ restoreFocus: false });
    content.replaceChildren();
    entries = [];
    for (const child of select.children) {
      if (child instanceof HTMLOptGroupElement) {
        const groupLabel = document.createElement('div');
        groupLabel.className = 'select-group-label';
        groupLabel.textContent = child.label;
        content.appendChild(groupLabel);
        for (const option of child.children) addOption(option, child.disabled);
      } else if (child instanceof HTMLOptionElement) {
        addOption(child);
      }
    }
    syncDisabledState();
    syncSelection();
  }

  function open() {
    if (trigger.disabled || trigger.getAttribute('aria-expanded') === 'true') return;
    refresh();
    if (trigger.disabled) return;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.dataset.state = 'open';
    content.dataset.state = 'open';
    positioner.hidden = false;
    const selectedIndex = entries.findIndex((entry) => entry.option.selected);
    highlight(selectedIndex);
    content.focus();
  }

  trigger.addEventListener('click', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') close();
    else open();
  });
  trigger.addEventListener('keydown', (event) => {
    if (!['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    open();
    if (event.key === 'ArrowDown') moveHighlight(1);
    if (event.key === 'ArrowUp') moveHighlight(-1);
  });
  content.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const available = availableIndexes();
      highlight(event.key === 'Home' ? available[0] : available[available.length - 1]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      entries[highlightedIndex]?.item.click();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      close({ restoreFocus: false });
    }
  });
  select.addEventListener('change', syncSelection);
  document.addEventListener('pointerdown', (event) => {
    if (!root.contains(event.target)) close({ restoreFocus: false });
  });
  refresh();
  return {
    close,
    content,
    refresh,
    root,
    syncDisabledState,
    trigger,
    valueText,
  };
}

document.querySelectorAll('[data-custom-select]').forEach((root, index) => {
  const select = root.querySelector('select');
  selectControllers.set(select, createSelectController(select, root, index));
});

function openReportDialog(trigger = document.activeElement) {
  if (trigger instanceof HTMLElement && !reportDisplayContainer.contains(trigger)) {
    reportDialogReturnFocus = trigger;
  }
  for (const controller of selectControllers.values()) {
    controller.close({ restoreFocus: false });
  }
  reportDisplayContainer.hidden = false;
  document.body.classList.add('report-modal-open');
  closeReportBtn.focus();
}

function closeReportDialog() {
  if (reportDisplayContainer.hidden) return;
  reportDisplayContainer.hidden = true;
  document.body.classList.remove('report-modal-open');
  const returnFocus = reportDialogReturnFocus;
  reportDialogReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}

function handleReportDialogKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeReportDialog();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(
    reportDialog.querySelectorAll('button:not(:disabled), a[href], [tabindex="0"]'),
  ).filter((element) => !element.hidden);
  if (!focusable.length) {
    event.preventDefault();
    reportDialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

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
    renderReportDisplay(payload, generateReportBtn);
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
    renderReportDisplay(report, trigger);
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

export function renderReportDisplay(report, trigger = document.activeElement) {
  const createdAt = report.created_at ? new Date(report.created_at) : null;
  const createdLabel = createdAt && !Number.isNaN(createdAt.getTime())
    ? createdAt.toLocaleString()
    : 'Unknown date';
  reportTitle.textContent = `Summary report - ${createdLabel}`;
  reportContent.lang = report.language || 'en';
  reportContent.dir = report.language === 'he' ? 'rtl' : 'ltr';
  renderReportMarkdown(reportContent, report.content);
  openReportDialog(trigger);
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
  transcriptViewVersion += 1;
  resetTranscriptReplay(true);
  transcriptList.innerHTML = '';
  utteranceElements.clear();
  updateEmptyState();
});

sessionSelect.addEventListener('change', handleSessionSelectChange);
replayPlayBtn.addEventListener('click', playTranscriptReplay);
replayPauseBtn.addEventListener('click', pauseTranscriptReplay);
replayRestartBtn.addEventListener('click', restartTranscriptReplay);
replaySeek.addEventListener('input', seekTranscriptReplay);
closeReportBtn.addEventListener('click', closeReportDialog);
reportDialog.addEventListener('keydown', handleReportDialogKeydown);
reportDisplayContainer.addEventListener('pointerdown', (event) => {
  if (event.target === reportDisplayContainer) closeReportDialog();
});
sessionRecording.addEventListener('loadedmetadata', () => {
  recordingMetadataReady = true;
  const seekTarget = pendingRecordingSeek;
  const shouldPlay = pendingRecordingPlay;
  pendingRecordingSeek = null;
  pendingRecordingPlay = false;
  if (shouldPlay) {
    startRecordingPlayback(seekTarget ?? currentRecordingTime());
  } else if (seekTarget !== null) {
    seekRecording(seekTarget);
  }
});
sessionRecording.addEventListener('seeking', () => {
  const isProgrammaticSeek = pendingProgrammaticRecordingSeek !== null
    && Math.abs(
      sessionRecording.currentTime - pendingProgrammaticRecordingSeek,
    ) < 0.001;
  pendingProgrammaticRecordingSeek = null;
  if (isProgrammaticSeek) return;
  clearActiveClip();
  syncReplayFromRecording(replayState === 'ready' ? 'paused' : null);
});
sessionRecording.addEventListener('pointerdown', () => {
  pendingProgrammaticRecordingSeek = null;
  clearActiveClip();
});
sessionRecording.addEventListener('keydown', () => {
  pendingProgrammaticRecordingSeek = null;
  clearActiveClip();
});
sessionRecording.addEventListener('timeupdate', () => {
  syncReplayFromRecording();
  if (
    activeClipPlayback
    && currentRecordingTime() >= activeClipPlayback.endSeconds
  ) {
    completeClipPlayback();
  }
});
sessionRecording.addEventListener('playing', () => {
  syncReplayFromRecording('playing');
  scheduleClipBoundaryCheck();
});
sessionRecording.addEventListener('pause', () => {
  if (pendingRecordingPlay || replayState !== 'playing') return;
  syncReplayFromRecording('paused');
});
sessionRecording.addEventListener('ended', () => {
  clearActiveClip('completed');
  if (replayState !== 'unavailable') finishTranscriptReplay();
});
sessionRecording.addEventListener('error', () => {
  handleRecordingPlaybackFailure();
});
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
