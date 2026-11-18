/**
 * PULSE//SCAN - Moteur de Photopléthysmographie (PPG) & Analyse de Stress
 * Architecture 100% locale : WebRTC + Canvas DSP + Web Audio Synth + Service Worker
 */

class BioAudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  playBeat(stressRatio = 0) {
    if (!this.enabled) return;
    this.init();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    // Fréquence légèrement plus aiguë si le stress monte
    osc.type = "sine";
    osc.frequency.setValueAtTime(660 + stressRatio * 220, now);
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.07);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  }

  playVerdict(isLie) {
    if (!this.enabled) return;
    this.init();
    const now = this.ctx.currentTime;
    const notes = isLie ? [320, 240, 180] : [523.25, 659.25, 783.99];

    notes.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = isLie ? "sawtooth" : "triangle";
      osc.frequency.setValueAtTime(freq, now + idx * 0.12);

      gain.gain.setValueAtTime(0.14, now + idx * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.25);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now + idx * 0.12);
      osc.stop(now + idx * 0.12 + 0.26);
    });
  }
}

class PPGSignalProcessor {
  constructor() {
    this.reset();
  }

  reset() {
    this.rawBuffer = [];       // { t, val }
    this.filteredBuffer = [];  // { t, val }
    this.rrIntervals = [];     // Intervalles entre battements en ms
    this.lastPeakTime = 0;
    this.currentBPM = null;
    this.currentHRV = null;
    this.signalQuality = 0;
    this.fingerDetected = false;
  }

  /**
   * Analyse une frame RGB et détecte la présence du doigt + l'onde de pouls
   */
  ingestFrame(imageData, timestamp) {
    const data = imageData.data;
    let rSum = 0, gSum = 0, bSum = 0;
    const pixelCount = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
    }

    const rAvg = rSum / pixelCount;
    const gAvg = gSum / pixelCount;
    const bAvg = bSum / pixelCount;

    // Heuristique de détection du doigt éclairé par le sang (forte dominance rouge)
    const isRedDominant = rAvg > 125 && rAvg > gAvg * 1.45 && rAvg > bAvg * 1.65;
    this.fingerDetected = isRedDominant;

    if (!isRedDominant) {
      this.signalQuality = Math.max(0, this.signalQuality - 5);
      return { beatDetected: false };
    }

    // Inversion du signal : + de sang = + d'absorption = pixel + sombre -> pic systolique vers le haut
    this.rawBuffer.push({ t: timestamp, val: -rAvg });
    this.rawBuffer = this.rawBuffer.filter((s) => timestamp - s.t <= 4500);

    if (this.rawBuffer.length < 25) {
      return { beatDetected: false };
    }

    // 1. Filtre Passe-Haut (suppression de la dérive lente sur 650ms)
    const highPassed = this.rawBuffer.map((sample) => {
      const windowSamples = this.rawBuffer.filter((w) => Math.abs(w.t - sample.t) <= 325);
      const mean = windowSamples.reduce((acc, s) => acc + s.val, 0) / windowSamples.length;
      return { t: sample.t, val: sample.val - mean };
    });

    // 2. Filtre Passe-Bas (lissage du bruit capteur sur 110ms)
    const latest = highPassed[highPassed.length - 1];
    const smoothWindow = highPassed.filter((w) => latest.t - w.t <= 110);
    const smoothVal = smoothWindow.reduce((acc, s) => acc + s.val, 0) / smoothWindow.length;

    this.filteredBuffer.push({ t: timestamp, val: smoothVal });
    this.filteredBuffer = this.filteredBuffer.filter((s) => timestamp - s.t <= 4000);

    // 3. Détection adaptative des pics systoliques
    return this.detectPeak();
  }

  detectPeak() {
    const buf = this.filteredBuffer;
    const len = buf.length;
    if (len < 15) return { beatDetected: false };

    // Calcul de l'écart-type sur les 2.5 dernières secondes
    const recent = buf.slice(-75);
    const mean = recent.reduce((a, b) => a + b.val, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + Math.pow(b.val - mean, 2), 0) / recent.length;
    const stdDev = Math.sqrt(variance);

    // Qualité du signal basée sur l'amplitude pulsatile (ni plat, ni saturé par tremblement)
    if (stdDev > 0.15 && stdDev < 12) {
      this.signalQuality = Math.min(100, this.signalQuality + 3);
    } else {
      this.signalQuality = Math.max(10, this.signalQuality - 2);
    }

    const prev2 = buf[len - 3];
    const prev1 = buf[len - 2];
    const curr = buf[len - 1];

    const threshold = Math.max(0.22, stdDev * 0.6);
    const timeSinceLastBeat = prev1.t - this.lastPeakTime;

    // Pic local au-dessus du seuil avec période réfractaire de 310ms (max ~193 BPM)
    if (
      prev1.val > prev2.val &&
      prev1.val >= curr.val &&
      prev1.val > threshold &&
      timeSinceLastBeat > 310
    ) {
      if (this.lastPeakTime > 0 && timeSinceLastBeat < 1500) {
        this.rrIntervals.push(timeSinceLastBeat);
        if (this.rrIntervals.length > 12) this.rrIntervals.shift();
        this.computeBiometrics();
      }
      this.lastPeakTime = prev1.t;
      return { beatDetected: true };
    }

    return { beatDetected: false };
  }

  computeBiometrics() {
    if (this.rrIntervals.length < 3) return;

    // Médiane des intervalles RR pour éliminer les artefacts
    const sorted = [...this.rrIntervals].sort((a, b) => a - b);
    const medianRR = sorted[Math.floor(sorted.length / 2)];
    this.currentBPM = Math.round(60000 / medianRR);

    // Calcul du RMSSD (Variabilité de fréquence cardiaque en ms)
    if (this.rrIntervals.length >= 4) {
      let sqDiffSum = 0;
      for (let i = 1; i < this.rrIntervals.length; i++) {
        const diff = this.rrIntervals[i] - this.rrIntervals[i - 1];
        sqDiffSum += diff * diff;
      }
      this.currentHRV = Math.round(Math.sqrt(sqDiffSum / (this.rrIntervals.length - 1)));
    }
  }
}

class PulseScanApp {
  constructor() {
    this.audio = new BioAudioEngine();
    this.dsp = new PPGSignalProcessor();
    this.isRunning = false;
    this.stream = null;
    this.rafId = null;

    // Métriques de session
    this.sessionBPMs = [];
    this.frameCount = 0;
    this.lastFpsUpdate = performance.now();

    // État du polygraphe
    this.polyState = {
      mode: "idle", // idle | calibrating | testing
      startTime: 0,
      duration: 0,
      samplesBPM: [],
      samplesHRV: [],
      baselineBPM: null,
      baselineHRV: null
    };

    this.bindDOM();
    this.generateDynamicAppleIcon();
    this.renderHistory();
    this.registerServiceWorker();
    this.drawIdleScope();
  }

  bindDOM() {
    this.video = document.getElementById("camera-video");
    this.procCanvas = document.getElementById("proc-canvas");
    this.procCtx = this.procCanvas.getContext("2d", { willReadFrequently: true });

    this.scopeCanvas = document.getElementById("ppg-canvas");
    this.scopeCtx = this.scopeCanvas.getContext("2d");

    this.btnPower = document.getElementById("btn-power");
    this.powerLabel = document.getElementById("power-label");
    this.cameraSelect = document.getElementById("camera-mode-select");
    this.iosBanner = document.getElementById("ios-light-banner");
    this.statusDot = document.getElementById("status-dot");

    this.fingerBadge = document.getElementById("finger-status-badge");
    this.fingerText = document.getElementById("finger-status-text");
    this.sigBar = document.getElementById("signal-quality-bar");
    this.sigVal = document.getElementById("signal-quality-val");
    this.fpsEl = document.getElementById("fps-counter");

    this.bpmEl = document.getElementById("bpm-value");
    this.hrvEl = document.getElementById("hrv-value");
    this.stressEl = document.getElementById("stress-value");
    this.minEl = document.getElementById("stat-min");
    this.avgEl = document.getElementById("stat-avg");
    this.maxEl = document.getElementById("stat-max");

    // Boutons principaux
    this.btnPower.addEventListener("click", () => this.toggleScanner());
    document.getElementById("btn-sound").addEventListener("click", (e) => {
      this.audio.enabled = !this.audio.enabled;
      e.currentTarget.classList.toggle("active", this.audio.enabled);
      e.currentTarget.textContent = this.audio.enabled ? "🔊" : "🔇";
    });

    // Onglets
    document.getElementById("tab-monitor").addEventListener("click", () => this.switchTab("monitor"));
    document.getElementById("tab-polygraph").addEventListener("click", () => this.switchTab("polygraph"));

    // Historique
    document.getElementById("btn-clear-history").addEventListener("click", () => {
      localStorage.removeItem("pulsescan_history");
      this.renderHistory();
    });

    // Polygraphe
    document.getElementById("btn-poly-calibrate").addEventListener("click", () => this.startPolyPhase("calibrating", 10000));
    document.getElementById("btn-poly-question").addEventListener("click", () => this.startPolyPhase("testing", 6000));
    document.getElementById("btn-poly-reset").addEventListener("click", () => this.resetPolygraph());
  }

  switchTab(tabName) {
    document.getElementById("tab-monitor").classList.toggle("active", tabName === "monitor");
    document.getElementById("tab-polygraph").classList.toggle("active", tabName === "polygraph");
    document.getElementById("panel-monitor").classList.toggle("active", tabName === "monitor");
    document.getElementById("panel-polygraph").classList.toggle("active", tabName === "polygraph");
  }

  async toggleScanner() {
    if (this.isRunning) {
      this.stopScanner();
    } else {
      await this.startScanner();
    }
  }

  async startScanner() {
    this.audio.init();
    this.dsp.reset();
    this.sessionBPMs = [];

    const selectedMode = this.cameraSelect.value;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const useFront = selectedMode === "front" || (selectedMode === "auto" && isIOS);

    try {
      const constraints = {
        audio: false,
        video: {
          facingMode: useFront ? "user" : "environment",
          width: { ideal: 128 },
          height: { ideal: 128 },
          frameRate: { ideal: 60 }
        }
      };

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.video.srcObject = this.stream;
      await this.video.play();

      const track = this.stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities ? track.getCapabilities() : {};

      if (!useFront && capabilities.torch) {
        await track.applyConstraints({ advanced: [{ torch: true }] });
        this.iosBanner.classList.add("hidden");
      } else {
        // Fallback illumination écran (indispensable sur iOS Safari)
        this.iosBanner.classList.remove("hidden");
      }

      this.isRunning = true;
      this.btnPower.classList.add("running");
      this.powerLabel.textContent = "ARRÊTER LE SCANNER";
      this.statusDot.classList.add("active");
      this.updateSensorUI("Posez le doigt sur l'objectif", "warn");

      this.loop();
    } catch (err) {
      alert("Impossible d'accéder à la caméra. Vérifiez les permissions HTTPS : " + err.message);
    }
  }

  stopScanner() {
    if (this.sessionBPMs.length >= 5) {
      this.saveSessionToHistory();
    }

    this.isRunning = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    this.iosBanner.classList.add("hidden");
    this.btnPower.classList.remove("running");
    this.powerLabel.textContent = "ACTIVER LE SCANNER";
    this.statusDot.classList.remove("active", "beat");
    this.updateSensorUI("Capteur en veille", "idle");
    this.drawIdleScope();
  }

  loop() {
    if (!this.isRunning) return;

    const now = performance.now();
    this.frameCount++;
    if (now - this.lastFpsUpdate >= 1000) {
      this.fpsEl.textContent = `${this.frameCount} FPS`;
      this.frameCount = 0;
      this.lastFpsUpdate = now;
    }

    if (this.video.readyState >= 2) {
      this.procCtx.drawImage(this.video, 0, 0, 64, 64);
      const frame = this.procCtx.getImageData(0, 0, 64, 64);
      const { beatDetected } = this.dsp.ingestFrame(frame, now);

      this.updateUI(beatDetected, now);
      this.drawScope();
    }

    this.rafId = requestAnimationFrame(() => this.loop());
  }

  updateUI(beatDetected, now) {
    this.sigBar.style.width = `${this.dsp.signalQuality}%`;
    this.sigVal.textContent = `${this.dsp.signalQuality}%`;

    if (!this.dsp.fingerDetected) {
      this.updateSensorUI("Doigt non détecté — Couvrez la caméra", "warn");
      return;
    }

    this.updateSensorUI("Lecture optique active", "ok");

    const bpm = this.dsp.currentBPM;
    const hrv = this.dsp.currentHRV;

    if (bpm) {
      this.bpmEl.textContent = bpm;
      this.sessionBPMs.push(bpm);
      const min = Math.min(...this.sessionBPMs);
      const max = Math.max(...this.sessionBPMs);
      const avg = Math.round(this.sessionBPMs.reduce((a, b) => a + b, 0) / this.sessionBPMs.length);
      this.minEl.textContent = min;
      this.avgEl.textContent = avg;
      this.maxEl.textContent = max;
    }

    if (hrv !== null) {
      this.hrvEl.textContent = hrv;
    }

    const stress = this.computeStressIndex(bpm, hrv);
    if (stress !== null) {
      this.stressEl.textContent = stress;
    }

    if (beatDetected) {
      this.audio.playBeat((stress || 20) / 100);
      this.statusDot.classList.add("beat");
      setTimeout(() => this.statusDot.classList.remove("beat"), 110);
    }

    this.processPolygraphTick(now, bpm, hrv);
  }

  computeStressIndex(bpm, hrv) {
    if (!bpm) return null;
    if (this.polyState.baselineBPM) {
      const bpmDelta = Math.max(0, bpm - this.polyState.baselineBPM);
      const hrvDrop = this.polyState.baselineHRV && hrv
        ? Math.max(0, this.polyState.baselineHRV - hrv)
        : 0;
      return Math.min(100, Math.round(18 + bpmDelta * 3.8 + hrvDrop * 0.9));
    }
    // Estimation autonome basée sur BPM + faible HRV
    const baseFromBpm = Math.max(0, (bpm - 58) * 1.35);
    const hrvFactor = hrv ? Math.max(0, (65 - hrv) * 0.55) : 15;
    return Math.min(100, Math.max(5, Math.round(baseFromBpm + hrvFactor)));
  }

  /* --- LOGIQUE POLYGRAPHE --- */
  startPolyPhase(mode, duration) {
    if (!this.isRunning || !this.dsp.fingerDetected) {
      alert("Activez d'abord le scanner et posez le doigt sur la caméra !");
      return;
    }
    this.polyState.mode = mode;
    this.polyState.startTime = performance.now();
    this.polyState.duration = duration;
    this.polyState.samplesBPM = [];
    this.polyState.samplesHRV = [];

    document.getElementById("poly-verdict-box").classList.add("hidden");
    document.getElementById("poly-step-title").textContent =
      mode === "calibrating" ? "Calibration en cours..." : "Analyse de la réponse...";
    document.getElementById("poly-step-desc").textContent =
      mode === "calibrating"
        ? "Ne bougez pas et respirez normalement pendant 10 secondes."
        : "Posez votre question maintenant et observez les micro-variations.";
  }

  processPolygraphTick(now, bpm, hrv) {
    const liveBpmEl = document.getElementById("poly-live-bpm");
    const liveDeltaEl = document.getElementById("poly-live-delta");

    if (bpm) {
      liveBpmEl.textContent = `${bpm} BPM`;
      if (this.polyState.baselineBPM) {
        const diff = bpm - this.polyState.baselineBPM;
        liveDeltaEl.textContent = `Écart: ${diff >= 0 ? "+" : ""}${diff} BPM`;
      }
    }

    if (this.polyState.mode === "idle") return;

    const elapsed = now - this.polyState.startTime;
    const pct = Math.min(100, (elapsed / this.polyState.duration) * 100);
    document.getElementById("poly-progress-fill").style.width = `${pct}%`;

    if (bpm) this.polyState.samplesBPM.push(bpm);
    if (hrv) this.polyState.samplesHRV.push(hrv);

    if (elapsed >= this.polyState.duration) {
      this.finishPolyPhase();
    }
  }

  finishPolyPhase() {
    const avgBPM = this.polyState.samplesBPM.length
      ? Math.round(this.polyState.samplesBPM.reduce((a, b) => a + b, 0) / this.polyState.samplesBPM.length)
      : this.dsp.currentBPM || 72;

    const avgHRV = this.polyState.samplesHRV.length
      ? Math.round(this.polyState.samplesHRV.reduce((a, b) => a + b, 0) / this.polyState.samplesHRV.length)
      : this.dsp.currentHRV || 45;

    if (this.polyState.mode === "calibrating") {
      this.polyState.baselineBPM = avgBPM;
      this.polyState.baselineHRV = avgHRV;
      document.getElementById("poly-baseline-bpm").textContent = `${avgBPM} BPM`;
      document.getElementById("poly-baseline-hrv").textContent = `HRV: ${avgHRV} ms`;
      document.getElementById("poly-step-title").textContent = "Calibration terminée ✓";
      document.getElementById("poly-step-desc").textContent = "Prêt. Cliquez sur « Tester une question » avant d'interroger.";
      document.getElementById("btn-poly-question").disabled = false;
    } else if (this.polyState.mode === "testing") {
      const deltaBPM = avgBPM - this.polyState.baselineBPM;
      const deltaHRV = avgHRV - this.polyState.baselineHRV;
      // Score de stress : hausse rapide du pouls ou chute marquée de la variabilité
      const isStressSpike = deltaBPM >= 6 || (deltaBPM >= 3 && deltaHRV <= -8);

      const box = document.getElementById("poly-verdict-box");
      const title = document.getElementById("poly-verdict-title");
      const detail = document.getElementById("poly-verdict-detail");

      box.classList.remove("hidden", "truth", "lie");
      box.classList.add(isStressSpike ? "lie" : "truth");

      title.textContent = isStressSpike ? "⚠️ PIC DE STRESS / MENSONGE PROBABLE" : "✅ RÉPONSE CALME / VÉRITÉ PROBABLE";
      detail.textContent = `Pouls: ${deltaBPM >= 0 ? "+" : ""}${deltaBPM} BPM | Variabilité HRV: ${deltaHRV >= 0 ? "+" : ""}${deltaHRV} ms`;

      this.audio.playVerdict(isStressSpike);
      document.getElementById("poly-step-title").textContent = "Analyse terminée";
    }

    this.polyState.mode = "idle";
  }

  resetPolygraph() {
    this.polyState = {
      mode: "idle",
      startTime: 0,
      duration: 0,
      samplesBPM: [],
      samplesHRV: [],
      baselineBPM: null,
      baselineHRV: null
    };
    document.getElementById("poly-progress-fill").style.width = "0%";
    document.getElementById("poly-baseline-bpm").textContent = "-- BPM";
    document.getElementById("poly-baseline-hrv").textContent = "HRV: -- ms";
    document.getElementById("poly-verdict-box").classList.add("hidden");
    document.getElementById("btn-poly-question").disabled = true;
    document.getElementById("poly-step-title").textContent = "Étape 1 : Calibration";
  }

  /* --- DESSIN OSCILLOSCOPE --- */
  drawIdleScope() {
    const canvas = this.scopeCanvas;
    canvas.width = canvas.clientWidth * window.devicePixelRatio;
    canvas.height = canvas.clientHeight * window.devicePixelRatio;
    const ctx = this.scopeCtx;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.drawGrid(ctx, canvas.width, canvas.height);

    ctx.strokeStyle = "rgba(0, 240, 255, 0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }

  drawScope() {
    const canvas = this.scopeCanvas;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== canvas.clientWidth * dpr) {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    }

    const ctx = this.scopeCtx;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    this.drawGrid(ctx, w, h);

    const buf = this.dsp.filteredBuffer;
    if (buf.length < 2) return;

    const maxAbs = Math.max(0.8, ...buf.map((s) => Math.abs(s.val)));
    ctx.strokeStyle = this.dsp.fingerDetected ? "#ff2a55" : "#00f0ff";
    ctx.lineWidth = 2.5 * dpr;
    ctx.shadowColor = this.dsp.fingerDetected ? "#ff2a55" : "#00f0ff";
    ctx.shadowBlur = 10;

    ctx.beginPath();
    buf.forEach((sample, idx) => {
      const x = (idx / (buf.length - 1)) * w;
      const norm = sample.val / maxAbs;
      const y = h / 2 - norm * (h * 0.36);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  drawGrid(ctx, w, h) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
    ctx.lineWidth = 1;
    const step = 32;
    for (let x = 0; x < w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  updateSensorUI(text, state) {
    this.fingerText.textContent = text;
    this.fingerBadge.className = `badge badge-${state}`;
  }

  /* --- STOCKAGE & PWA --- */
  saveSessionToHistory() {
    const avg = Math.round(this.sessionBPMs.reduce((a, b) => a + b, 0) / this.sessionBPMs.length);
    const history = JSON.parse(localStorage.getItem("pulsescan_history") || "[]");
    history.unshift({
      date: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      bpm: avg,
      hrv: this.dsp.currentHRV || "--"
    });
    localStorage.setItem("pulsescan_history", JSON.stringify(history.slice(0, 15)));
    this.renderHistory();
  }

  renderHistory() {
    const list = document.getElementById("history-list");
    const history = JSON.parse(localStorage.getItem("pulsescan_history") || "[]");
    if (!history.length) {
      list.innerHTML = `<li class="empty-msg">Aucune mesure enregistrée.</li>`;
      return;
    }
    list.innerHTML = history
      .map(
        (item) => `
        <li>
          <span>🕒 ${item.date}</span>
          <strong>${item.bpm} BPM <small style="color:#7f91b0">(HRV ${item.hrv}ms)</small></strong>
        </li>`
      )
      .join("");
  }

  generateDynamicAppleIcon() {
    const c = document.createElement("canvas");
    c.width = 180;
    c.height = 180;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#06090f";
    ctx.fillRect(0, 0, 180, 180);
    ctx.strokeStyle = "#ff2a55";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(20, 95);
    ctx.lineTo(60, 95);
    ctx.lineTo(78, 42);
    ctx.lineTo(102, 140);
    ctx.lineTo(120, 95);
    ctx.lineTo(160, 95);
    ctx.stroke();
    document.getElementById("apple-icon").href = c.toDataURL("image/png");
  }

  registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("SW error:", err));
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new PulseScanApp();
});