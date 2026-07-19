const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const toggleBtn = document.getElementById('toggleBtn');
const toggleIcon = document.getElementById('toggleIcon');
const toggleText = document.getElementById('toggleText');
const clearBtn = document.getElementById('clearBtn');
const emptyState = document.getElementById('emptyState');
const finalizedContainer = document.getElementById('finalizedContainer');
const activeText = document.getElementById('activeText');
const transcriptionPanel = document.getElementById('transcriptionPanel');
const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');

let ws = null;
let audioContext = null;
let mediaStream = null;
let processorNode = null;
let isRecording = false;
let finalizedTextHistory = "";

const PLAY_ICON = `<path d="M11.596 8.697l-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"/>`;
const STOP_ICON = `<path d="M5 3.5h6A1.5 1.5 0 0 1 12.5 5v6a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 11V5A1.5 1.5 0 0 1 5 3.5z"/>`;

// Resize visualizer canvas
function resizeCanvas() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  drawFlatLine();
}

function drawFlatLine() {
  canvasCtx.fillStyle = '#0F172A'; // Brand Navy
  canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
  canvasCtx.lineWidth = 2;
  canvasCtx.strokeStyle = '#3B82F6'; // Primary Blue
  canvasCtx.beginPath();
  canvasCtx.moveTo(0, canvas.height / 2);
  canvasCtx.lineTo(canvas.width, canvas.height / 2);
  canvasCtx.stroke();
}

function drawVisualizer(audioData) {
  canvasCtx.fillStyle = '#0F172A';
  canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
  
  canvasCtx.lineWidth = 2;
  canvasCtx.strokeStyle = '#3B82F6';
  canvasCtx.beginPath();
  
  const sliceWidth = canvas.width / audioData.length;
  let x = 0;
  
  for (let i = 0; i < audioData.length; i++) {
    // audioData values are float32 in [-1.0, 1.0].
    // Apply a gain factor of 1.5 to make quiet voices visible
    const v = audioData[i] * 1.5;
    const y = (v + 1) * (canvas.height / 2);
    
    if (i === 0) {
      canvasCtx.moveTo(x, y);
    } else {
      canvasCtx.lineTo(x, y);
    }
    
    x += sliceWidth;
  }
  
  canvasCtx.lineTo(canvas.width, canvas.height / 2);
  canvasCtx.stroke();
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function updateStatus(state) {
  statusDot.className = 'status-dot';
  if (state === 'connected') {
    statusDot.classList.add('connected');
    statusText.innerText = 'Connected';
  } else if (state === 'recording') {
    statusDot.classList.add('recording');
    statusText.innerText = 'Recording';
  } else if (state === 'connecting') {
    statusDot.classList.add('connected');
    statusText.innerText = 'Connecting...';
  } else if (state === 'error') {
    statusDot.classList.add('disconnected');
    statusText.innerText = 'Error';
  } else {
    statusText.innerText = 'Disconnected';
  }
}

async function startRecording() {
  isRecording = true;
  toggleBtn.disabled = true;
  toggleText.innerText = "Connecting...";
  
  updateStatus('connecting');
  
  // Establish WebSocket connection
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const backendHost = 'localhost:8000';
  ws = new WebSocket(`${protocol}//${backendHost}/v1/transcribe`);
  
  ws.onopen = async () => {
    try {
      // Access microphone at 16000Hz mono
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      
      // Initialize AudioContext forcing 16000Hz sampling rate
      audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(mediaStream);
      
      // Create ScriptProcessorNode to read float32 chunks (4096 samples ~250ms)
      processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      
      processorNode.onaudioprocess = (e) => {
        if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        const audioData = new Float32Array(inputData);
        
        // Stream raw binary bytes to backend
        ws.send(audioData.buffer);
        
        // Draw the visualizer waveform
        drawVisualizer(audioData);
      };
      
      source.connect(processorNode);
      processorNode.connect(audioContext.destination);
      
      updateStatus('recording');
      toggleBtn.disabled = false;
      toggleText.innerText = "Stop Transcribing";
      toggleIcon.innerHTML = STOP_ICON;
      
      // Show default "listening..." state
      activeText.innerText = "Listening...";
      activeText.classList.add('listening');
      activeText.style.display = "block";
      emptyState.style.display = "none";
      
    } catch (err) {
      console.error('Microphone access denied or error:', err);
      alert('Could not access microphone. Please check permissions.');
      stopRecording();
    }
  };
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const { text, finalized } = data;
    
    if (finalized) {
      if (text.trim()) {
        finalizedTextHistory += text + " ";
        finalizedContainer.innerText = finalizedTextHistory;
      }
      activeText.innerText = "Listening...";
      activeText.classList.add('listening');
    } else {
      if (text.trim()) {
        activeText.innerText = text;
        activeText.classList.remove('listening');
      } else {
        activeText.innerText = "Listening...";
        activeText.classList.add('listening');
      }
    }
    
    // Toggle empty state
    if (finalizedTextHistory.trim() || isRecording) {
      emptyState.style.display = "none";
    } else {
      emptyState.style.display = "flex";
    }
    
    // Auto-scroll to bottom of the transcription panel
    transcriptionPanel.scrollTop = transcriptionPanel.scrollHeight;
  };
  
  ws.onclose = () => {
    stopRecording();
  };
  
  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    updateStatus('error');
    stopRecording();
  };
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  
  toggleBtn.disabled = false;
  toggleText.innerText = "Start Transcribing";
  toggleIcon.innerHTML = PLAY_ICON;
  
  updateStatus('disconnected');
  drawFlatLine();
  
  activeText.innerText = "";
  activeText.style.display = "none";
  activeText.classList.remove('listening');
  
  if (finalizedTextHistory.trim()) {
    emptyState.style.display = "none";
  } else {
    emptyState.style.display = "flex";
  }
  
  // Clean up Web Audio API
  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }
  if (audioContext) {
    if (audioContext.state !== 'closed') {
      audioContext.close();
    }
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  
  // Clean up WebSocket
  if (ws) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }
}

toggleBtn.addEventListener('click', () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

clearBtn.addEventListener('click', () => {
  finalizedTextHistory = "";
  finalizedContainer.innerText = "";
  activeText.innerText = isRecording ? "Listening..." : "";
  if (isRecording) {
    activeText.classList.add('listening');
    activeText.style.display = "block";
    emptyState.style.display = "none";
  } else {
    activeText.style.display = "none";
    emptyState.style.display = "flex";
  }
});
