/**
 * TARS Real-Time Chatbot Sentinel & Audio Chime System
 * Monitors incoming client service chatbot conversations in real time,
 * triggers audio ringtone when problems are detected, and presents
 * instantaneous step-by-step technical solutions within Solar Agenda.
 */

(function () {
  // --- 1. Audio Synthesizer Engine (Web Audio API) ---
  class TarsSoundEngine {
    constructor() {
      this.ctx = null;
      this.volume = parseFloat(localStorage.getItem('tars_ringtone_vol') || '0.85');
      this.soundType = localStorage.getItem('tars_ringtone_type') || 'SOLAR_CHIME';
      this.muted = localStorage.getItem('tars_ringtone_muted') === 'true';
      this.initUnlocker();
    }

    initCtx() {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          this.ctx = new AudioCtx();
        }
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    }

    initUnlocker() {
      const unlock = () => {
        this.initCtx();
        window.removeEventListener('click', unlock);
        window.removeEventListener('keydown', unlock);
        window.removeEventListener('touchstart', unlock);
      };
      window.addEventListener('click', unlock, { once: true });
      window.addEventListener('keydown', unlock, { once: true });
      window.addEventListener('touchstart', unlock, { once: true });
    }

    playAlert(soundOverride) {
      if (this.muted) return;
      this.initCtx();
      if (!this.ctx) return;

      const type = soundOverride || this.soundType;
      const now = this.ctx.currentTime;
      const master = this.ctx.createGain();
      master.gain.setValueAtTime(this.volume, now);
      master.connect(this.ctx.destination);

      if (type === 'SONAR_ALERT') {
        // Dual high-tech radar alert
        this.playTone(880, now, 0.18, master, 'sine');
        this.playTone(1175, now + 0.12, 0.35, master, 'triangle');
      } else if (type === 'URGENT_PULSE') {
        // Three rapid warning pulses
        this.playTone(1046, now, 0.1, master, 'sawtooth', 0.2);
        this.playTone(1046, now + 0.14, 0.1, master, 'sawtooth', 0.2);
        this.playTone(1318, now + 0.28, 0.4, master, 'sine', 0.5);
      } else if (type === 'SOFT_INTERCOM') {
        // Gentle executive intercom chime
        this.playTone(659.25, now, 0.3, master, 'sine');
        this.playTone(880, now + 0.2, 0.5, master, 'sine');
      } else {
        // SOLAR_CHIME (Default): Elegant melodic tri-tone
        // G5 (784Hz) -> C6 (1046Hz) -> E6 (1318Hz) with harmonics
        this.playTone(784, now, 0.18, master, 'sine', 0.6);
        this.playTone(1046.5, now + 0.11, 0.22, master, 'sine', 0.7);
        this.playTone(1318.5, now + 0.24, 0.55, master, 'triangle', 0.85);

        // Subtle bell harmonic
        this.playTone(2637, now + 0.24, 0.35, master, 'sine', 0.15);
      }
    }

    playTone(freq, startTime, duration, targetNode, wave = 'sine', gainScale = 1.0) {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = wave;
      osc.frequency.setValueAtTime(freq, startTime);

      const maxGain = 0.4 * gainScale;
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(maxGain, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      osc.connect(gain);
      gain.connect(targetNode);

      osc.start(startTime);
      osc.stop(startTime + duration + 0.05);
    }

    setVolume(val) {
      this.volume = Math.max(0, Math.min(1, parseFloat(val) || 0.5));
      localStorage.setItem('tars_ringtone_vol', String(this.volume));
    }

    setSoundType(type) {
      this.soundType = type;
      localStorage.setItem('tars_ringtone_type', type);
    }

    toggleMute() {
      this.muted = !this.muted;
      localStorage.setItem('tars_ringtone_muted', String(this.muted));
      return this.muted;
    }
  }

  // --- 2. Real-Time Sentinel Listener & Toast Controller ---
  class TarsSentinel {
    constructor() {
      this.sound = new TarsSoundEngine();
      this.alerts = [];
      this.activeToasts = new Map();
      this.eventSource = null;
      this.pollTimer = null;
      this.lastTimestamp = new Date(Date.now() - 60000).toISOString();
      this.unreadCount = 0;
      this.connected = false;

      this.initUI();
      this.connectSSE();
      this.startPollingFallback();
      this.fetchInitialAlerts();
    }

    initUI() {
      // Create Toast Container if not exists
      let container = document.getElementById('tars-toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'tars-toast-container';
        container.className = 'tars-toast-container';
        document.body.appendChild(container);
      }
      this.toastContainer = container;

      // Inject Styles for Toast, Modal, and Sentinel Pill
      this.injectStyles();

      // Topbar Sentinel Button setup
      this.setupTopbarButton();

      // Setup Modal
      this.setupModal();
    }

    injectStyles() {
      if (document.getElementById('tars-sentinel-styles')) return;
      const style = document.createElement('style');
      style.id = 'tars-sentinel-styles';
      style.textContent = `
        /* TARS Realtime Sentinel Toast Styles */
        .tars-toast-container {
          position: fixed;
          top: 72px;
          right: 24px;
          z-index: 999999;
          display: flex;
          flex-direction: column;
          gap: 14px;
          max-width: 480px;
          width: calc(100vw - 48px);
          pointer-events: none;
        }

        .tars-solution-toast {
          pointer-events: auto;
          background: rgba(18, 22, 34, 0.95);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 179, 0, 0.35);
          border-radius: 14px;
          box-shadow: 0 16px 36px rgba(0, 0, 0, 0.55), 0 0 24px rgba(255, 179, 0, 0.15);
          color: #f1f5f9;
          padding: 18px 20px;
          animation: tarsToastSlideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          transition: all 0.3s ease;
          overflow: hidden;
          position: relative;
        }

        .tars-solution-toast.critical {
          border-color: rgba(239, 68, 68, 0.6);
          box-shadow: 0 16px 36px rgba(0, 0, 0, 0.6), 0 0 28px rgba(239, 68, 68, 0.25);
        }

        .tars-solution-toast::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 3px;
          background: linear-gradient(90deg, #f59e0b, #ef4444, #f59e0b);
          background-size: 200% 100%;
          animation: tarsGradientMove 2.5s linear infinite;
        }

        .tars-solution-toast.critical::before {
          background: linear-gradient(90deg, #ef4444, #dc2626, #f87171);
        }

        @keyframes tarsToastSlideIn {
          from {
            opacity: 0;
            transform: translateX(50px) scale(0.96);
          }
          to {
            opacity: 1;
            transform: translateX(0) scale(1);
          }
        }

        @keyframes tarsToastSlideOut {
          to {
            opacity: 0;
            transform: translateX(60px) scale(0.9);
          }
        }

        @keyframes tarsGradientMove {
          0% { background-position: 0% 0%; }
          100% { background-position: 200% 0%; }
        }

        .tars-toast-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 10px;
        }

        .tars-toast-tag {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          padding: 4px 10px;
          border-radius: 20px;
          background: rgba(245, 158, 11, 0.18);
          color: #fbbf24;
          border: 1px solid rgba(245, 158, 11, 0.35);
        }

        .tars-solution-toast.critical .tars-toast-tag {
          background: rgba(239, 68, 68, 0.2);
          color: #fca5a5;
          border-color: rgba(239, 68, 68, 0.4);
        }

        .tars-toast-tag .pulse-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #f59e0b;
          box-shadow: 0 0 8px #f59e0b;
          animation: tarsPulse 1.2s infinite;
        }

        .tars-solution-toast.critical .pulse-dot {
          background: #ef4444;
          box-shadow: 0 0 8px #ef4444;
        }

        @keyframes tarsPulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.4); opacity: 0.5; }
        }

        .tars-toast-time {
          font-size: 11px;
          color: #94a3b8;
          font-family: monospace;
        }

        .tars-toast-close {
          background: transparent;
          border: none;
          color: #94a3b8;
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
          padding: 2px 6px;
          border-radius: 4px;
          transition: all 0.2s;
        }

        .tars-toast-close:hover {
          color: #fff;
          background: rgba(255, 255, 255, 0.1);
        }

        .tars-toast-title {
          font-size: 15px;
          font-weight: 700;
          color: #fff;
          margin-bottom: 6px;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .tars-toast-quote {
          font-size: 12.5px;
          line-height: 1.45;
          color: #cbd5e1;
          background: rgba(0, 0, 0, 0.35);
          border-left: 3px solid #f59e0b;
          padding: 8px 12px;
          border-radius: 0 8px 8px 0;
          margin-bottom: 12px;
          font-style: italic;
        }

        .tars-solution-box {
          background: rgba(16, 185, 129, 0.1);
          border: 1px solid rgba(16, 185, 129, 0.3);
          border-radius: 10px;
          padding: 12px 14px;
          margin-bottom: 14px;
        }

        .tars-solution-box-title {
          font-size: 12px;
          font-weight: 700;
          color: #34d399;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 6px;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .tars-solution-text {
          font-size: 13px;
          line-height: 1.55;
          color: #e2e8f0;
          white-space: pre-line;
        }

        .tars-toast-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .tars-toast-btn {
          flex: 1;
          padding: 8px 12px;
          border-radius: 8px;
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          border: 1px solid transparent;
          transition: all 0.2s;
        }

        .tars-btn-copy {
          background: #10b981;
          color: #064e3b;
          font-weight: 700;
        }
        .tars-btn-copy:hover {
          background: #059669;
          color: #fff;
          box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
        }

        .tars-btn-view {
          background: rgba(255, 255, 255, 0.08);
          color: #e2e8f0;
          border-color: rgba(255, 255, 255, 0.15);
        }
        .tars-btn-view:hover {
          background: rgba(255, 255, 255, 0.15);
          color: #fff;
        }

        /* Topbar Sentinel Pill */
        .tb-sentinel-btn {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          background: rgba(30, 41, 59, 0.7);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 20px;
          padding: 5px 12px;
          color: #cbd5e1;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          position: relative;
        }

        .tb-sentinel-btn:hover {
          background: rgba(51, 65, 85, 0.9);
          border-color: rgba(245, 158, 11, 0.4);
          color: #fff;
        }

        .tb-sentinel-btn.active-glow {
          border-color: rgba(16, 185, 129, 0.5);
          box-shadow: 0 0 14px rgba(16, 185, 129, 0.25);
        }

        .tb-sentinel-badge {
          background: #ef4444;
          color: #fff;
          font-size: 10px;
          font-weight: 800;
          padding: 1px 6px;
          border-radius: 10px;
          min-width: 16px;
          text-align: center;
          line-height: 14px;
        }

        /* Modal / Drawer for Chatbot Monitor */
        .tars-sentinel-modal-box {
          background: #0f172a;
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 16px;
          width: 92%;
          max-width: 680px;
          max-height: 88vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 24px 64px rgba(0, 0, 0, 0.85);
          overflow: hidden;
          color: #f1f5f9;
        }

        .tars-modal-header {
          padding: 18px 24px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: rgba(15, 23, 42, 0.95);
        }

        .tars-modal-body {
          padding: 24px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .tars-card-section {
          background: rgba(30, 41, 59, 0.5);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 16px 18px;
        }

        .tars-sim-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 10px;
          margin-top: 10px;
        }

        .tars-sim-btn {
          background: rgba(15, 23, 42, 0.8);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 8px;
          padding: 10px 12px;
          color: #e2e8f0;
          font-size: 12px;
          text-align: left;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .tars-sim-btn:hover {
          background: rgba(245, 158, 11, 0.15);
          border-color: #f59e0b;
          color: #fff;
          transform: translateY(-2px);
        }

        .tars-sim-btn strong {
          font-size: 13px;
          color: #fbbf24;
        }
      `;
      document.head.appendChild(style);
    }

    setupTopbarButton() {
      // Find topbar right actions or topbar brand
      const topbarActions = document.querySelector('.topbar-actions') || document.querySelector('.topbar');
      if (!topbarActions) return;

      let btn = document.getElementById('tars-chatbot-sentinel');
      if (btn) {
        // Button already exists in index.html, bind click handler
        btn.onclick = () => this.openModal();
        return;
      }

      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'tars-chatbot-sentinel';
      btn.className = 'tb-sentinel-btn active-glow';
      btn.title = 'TARS Chatbot Sentinel: Monitor de Atendimento em Tempo Real & Toque';
      btn.innerHTML = `
        <span class="sentinel-ico">⚡</span>
        <span class="sentinel-label">Chatbot Sentinel</span>
        <span class="tb-sentinel-badge hidden" id="tars-sentinel-badge">0</span>
      `;

      btn.addEventListener('click', () => {
        this.openModal();
      });

      // Insert before user pill or at end
      const userPill = document.getElementById('user-pill');
      if (userPill && userPill.parentNode === topbarActions) {
        topbarActions.insertBefore(btn, userPill);
      } else {
        topbarActions.appendChild(btn);
      }
    }

    setupModal() {
      if (document.getElementById('tars-sentinel-modal')) return;

      const modal = document.createElement('div');
      modal.id = 'tars-sentinel-modal';
      modal.className = 'modal-backdrop hidden';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:999999;display:none;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

      modal.innerHTML = `
        <div class="tars-sentinel-modal-box">
          <div class="tars-modal-header">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="font-size:20px;">⚡</span>
              <div>
                <h2 style="font-size:16px;font-weight:700;margin:0;">TARS Real-Time Chatbot Sentinel</h2>
                <p style="font-size:12px;color:#94a3b8;margin:2px 0 0 0;">Monitoramento de conversas do atendimento ao cliente & Detecção de Falhas</p>
              </div>
            </div>
            <button type="button" class="tars-toast-close" id="tars-modal-close-btn" style="font-size:22px;">✕</button>
          </div>

          <div class="tars-modal-body">
            <!-- Connection Status -->
            <div class="tars-card-section" style="display:flex;align-items:center;justify-content:space-between;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="pulse-dot" id="sentinel-status-dot" style="width:10px;height:10px;border-radius:50%;background:#10b981;box-shadow:0 0 10px #10b981;display:inline-block;"></span>
                <div>
                  <div style="font-size:13px;font-weight:700;" id="sentinel-status-text">Monitorando Chatbot em Tempo Real</div>
                  <div style="font-size:11.5px;color:#94a3b8;">Stream SSE conectado • Notificações com Ringtone Ativas</div>
                </div>
              </div>
              <button type="button" class="tars-toast-btn tars-btn-copy" id="test-ringtone-btn" style="max-width:140px;">
                🔊 Testar Toque
              </button>
            </div>

            <!-- Sound & Volume Settings -->
            <div class="tars-card-section">
              <h3 style="font-size:13px;font-weight:700;margin:0 0 12px 0;color:#fbbf24;text-transform:uppercase;letter-spacing:0.04em;">Configurações do Toque Sonoro</h3>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
                <div>
                  <label style="font-size:12px;color:#cbd5e1;display:block;margin-bottom:6px;">Estilo do Toque</label>
                  <select id="sentinel-sound-select" style="width:100%;padding:8px 10px;background:#0f172a;border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#fff;font-size:12.5px;">
                    <option value="SOLAR_CHIME">Solar Chime (Tri-tom Melódico Harmônico)</option>
                    <option value="SONAR_ALERT">Sonar Alert (Dual Radar Ping)</option>
                    <option value="URGENT_PULSE">Urgent Pulse (Aviso Rápido)</option>
                    <option value="SOFT_INTERCOM">Soft Intercom (Prompt Suave)</option>
                  </select>
                </div>
                <div>
                  <label style="font-size:12px;color:#cbd5e1;display:block;margin-bottom:6px;">Volume: <span id="vol-display">85%</span></label>
                  <input type="range" id="sentinel-vol-range" min="0" max="100" value="85" style="width:100%;cursor:pointer;">
                </div>
              </div>
            </div>

            <!-- Chatbot Simulator -->
            <div class="tars-card-section">
              <h3 style="font-size:13px;font-weight:700;margin:0 0 6px 0;color:#38bdf8;text-transform:uppercase;letter-spacing:0.04em;">Simulador de Atendimento (Teste ao Vivo)</h3>
              <p style="font-size:12px;color:#94a3b8;margin:0 0 10px 0;">Dispare uma mensagem simulada de cliente para verificar o toque de alerta e a janela popup com a solução imediata do TARS:</p>
              
              <div class="tars-sim-grid">
                <button type="button" class="tars-sim-btn" data-sim="f30">
                  <strong>⚠️ Deye F30 (Relé)</strong>
                  <span>Relé estalando com alarme F30 em inversor SUN-8K</span>
                </button>
                <button type="button" class="tars-sim-btn" data-sim="erro21">
                  <strong>⚠️ FoxESS Erro 21</strong>
                  <span>Sobretensão na rede CA ao meio-dia (255V)</span>
                </button>
                <button type="button" class="tars-sim-btn" data-sim="riso">
                  <strong>⚡ Riso Low</strong>
                  <span>Baixa resistência de isolamento nas strings CC</span>
                </button>
                <button type="button" class="tars-sim-btn" data-sim="dtu">
                  <strong>📡 Hoymiles DTU</strong>
                  <span>DTU offline e microinversores sem comunicação</span>
                </button>
                <button type="button" class="tars-sim-btn" data-sim="trip">
                  <strong>🔌 Disjuntor CA</strong>
                  <span>Disjuntor ou DR desarmando no pico solar</span>
                </button>
                <button type="button" class="tars-sim-btn" data-sim="f18">
                  <strong>⚡ Fuga F18 / GFCI</strong>
                  <span>Corrente de fuga diferencial residual elevada</span>
                </button>
              </div>

              <!-- Custom Text Simulator -->
              <div style="margin-top:14px;display:flex;gap:8px;">
                <input type="text" id="sim-custom-text" placeholder="Ou digite o relato do cliente (ex: inversor apitou e desligou...)" style="flex:1;padding:8px 12px;background:#0f172a;border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#fff;font-size:12px;">
                <button type="button" id="sim-custom-btn" class="tars-toast-btn tars-btn-copy" style="flex:none;padding:8px 16px;">
                  Simular Mensagem
                </button>
              </div>
            </div>

            <!-- Recent Alerts List -->
            <div class="tars-card-section">
              <h3 style="font-size:13px;font-weight:700;margin:0 0 10px 0;color:#a855f7;text-transform:uppercase;letter-spacing:0.04em;">Histórico de Problemas Detectados</h3>
              <div id="sentinel-alerts-list" style="display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto;">
                <div style="font-size:12px;color:#64748b;text-align:center;padding:12px;">Nenhum alerta recente recebido.</div>
              </div>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Bind Modal Events
      modal.querySelector('#tars-modal-close-btn')?.addEventListener('click', () => this.closeModal());
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.closeModal();
      });

      modal.querySelector('#test-ringtone-btn')?.addEventListener('click', () => {
        this.sound.playAlert();
      });

      const soundSel = modal.querySelector('#sentinel-sound-select');
      if (soundSel) {
        soundSel.value = this.sound.soundType;
        soundSel.addEventListener('change', (e) => {
          this.sound.setSoundType(e.target.value);
          this.sound.playAlert();
        });
      }

      const volRange = modal.querySelector('#sentinel-vol-range');
      const volDisp = modal.querySelector('#vol-display');
      if (volRange && volDisp) {
        volRange.value = Math.round(this.sound.volume * 100);
        volDisp.textContent = `${volRange.value}%`;
        volRange.addEventListener('input', (e) => {
          const v = parseInt(e.target.value, 10);
          volDisp.textContent = `${v}%`;
          this.sound.setVolume(v / 100);
        });
      }

      // Simulator Quick Buttons
      modal.querySelectorAll('.tars-sim-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const type = btn.getAttribute('data-sim');
          await this.triggerSimulation(type);
        });
      });

      // Custom message simulator
      modal.querySelector('#sim-custom-btn')?.addEventListener('click', async () => {
        const input = modal.querySelector('#sim-custom-text');
        const txt = input?.value?.trim();
        if (!txt) return;
        await this.triggerSimulation('custom', txt);
        if (input) input.value = '';
      });
    }

    openModal() {
      const modal = document.getElementById('tars-sentinel-modal');
      if (modal) {
        modal.style.display = 'flex';
        modal.classList.remove('hidden');
        this.renderAlertsHistory();
      }
    }

    closeModal() {
      const modal = document.getElementById('tars-sentinel-modal');
      if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
      }
    }

    async triggerSimulation(type, customText) {
      try {
        const res = await fetch('/api/tars/realtime/alerts/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, customText })
        });
        const data = await res.json();
        if (data.ok && data.alert) {
          this.handleIncomingAlert(data.alert);
          this.closeModal();
        } else {
          alert(data.error || 'Erro ao simular atendimento');
        }
      } catch (err) {
        console.error('[Simulator Error]', err);
      }
    }

    // --- 3. SSE Stream & Polling ---
    connectSSE() {
      try {
        if (this.eventSource) {
          try { this.eventSource.close(); } catch (e) {}
          this.eventSource = null;
        }

        this.sseFailCount = this.sseFailCount || 0;
        if (this.sseFailCount >= 3) {
          // Fall back to polling only if SSE stream is unsupported or down
          this.connected = false;
          this.updateStatusBadge(false);
          return;
        }

        this.eventSource = new EventSource('/api/tars/realtime/stream');

        this.eventSource.onopen = () => {
          this.connected = true;
          this.sseFailCount = 0;
          this.updateStatusBadge(true);
        };

        this.eventSource.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            if (data.type === 'PROBLEM_DETECTED' && data.alert) {
              this.handleIncomingAlert(data.alert);
            }
          } catch (err) {
            // ignore non-json pings
          }
        };

        this.eventSource.onerror = () => {
          this.connected = false;
          this.sseFailCount = (this.sseFailCount || 0) + 1;
          this.updateStatusBadge(false);
          try { this.eventSource?.close(); } catch (e) {}
          this.eventSource = null;
          if (this.sseFailCount < 3) {
            setTimeout(() => this.connectSSE(), 10000);
          }
        };
      } catch (e) {
        this.connected = false;
      }
    }

    startPollingFallback() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollFailCount = 0;

      // Periodic safety sync in case SSE drops
      this.pollTimer = setInterval(async () => {
        try {
          const res = await fetch(`/api/tars/realtime/alerts?since=${encodeURIComponent(this.lastTimestamp)}`);
          if (res.ok) {
            this.pollFailCount = 0;
            const data = await res.json();
            if (Array.isArray(data.alerts) && data.alerts.length > 0) {
              for (const alert of data.alerts) {
                if (!this.alerts.some(a => a.id === alert.id)) {
                  this.handleIncomingAlert(alert);
                }
              }
            }
            this.lastTimestamp = new Date().toISOString();
          } else {
            this.pollFailCount = (this.pollFailCount || 0) + 1;
            if (this.pollFailCount >= 3) {
              // Back off to 30s polling if endpoint is down or returning 404
              clearInterval(this.pollTimer);
              this.pollTimer = setTimeout(() => this.startPollingFallback(), 30000);
            }
          }
        } catch (e) {
          this.pollFailCount = (this.pollFailCount || 0) + 1;
        }
      }, 5000);
    }

    async fetchInitialAlerts() {
      try {
        const res = await fetch('/api/tars/realtime/alerts');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.alerts)) {
            this.alerts = data.alerts;
            this.updateBadgeCount();
          }
        }
      } catch (e) {}
    }

    updateStatusBadge(online) {
      const dot = document.getElementById('sentinel-status-dot');
      const text = document.getElementById('sentinel-status-text');
      const btn = document.getElementById('tars-chatbot-sentinel');
      if (dot && text) {
        if (online) {
          dot.style.background = '#10b981';
          dot.style.boxShadow = '0 0 10px #10b981';
          text.textContent = 'Monitorando Chatbot em Tempo Real';
          btn?.classList.add('active-glow');
        } else {
          dot.style.background = '#f59e0b';
          dot.style.boxShadow = '0 0 10px #f59e0b';
          text.textContent = 'Reconectando Sentinel (Modo Polling Ativo)';
        }
      }
    }

    // --- 4. Alert Handling, Ringtone Chime, and Popup Toast ---
    handleIncomingAlert(alert) {
      // Avoid duplicate toasts for the exact same alert ID
      if (this.activeToasts.has(alert.id)) return;

      // Add to internal list
      this.alerts.unshift(alert);
      this.unreadCount++;
      this.updateBadgeCount();

      // 1. Play audible ringtone alert!
      this.sound.playAlert();

      // 2. Display interactive Toast in Solar Agenda interface
      this.showSolutionToast(alert);

      // 3. Update history if modal open
      this.renderAlertsHistory();
    }

    updateBadgeCount() {
      const badge = document.getElementById('tars-sentinel-badge');
      if (badge) {
        const unread = this.alerts.filter(a => !a.read).length;
        if (unread > 0) {
          badge.textContent = unread > 99 ? '99+' : String(unread);
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
        }
      }
    }

    showSolutionToast(alert) {
      const toast = document.createElement('div');
      toast.className = `tars-solution-toast ${alert.severity === 'CRITICAL' ? 'critical' : ''}`;
      toast.id = `toast-${alert.id}`;

      const eq = alert.equipment || {};
      const eqLabel = eq.manufacturer ? `${eq.manufacturer}${eq.model ? ' ' + eq.model : ''}` : 'Inversor Solar';
      const timeStr = new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      // Build solution formatted text
      const solutionContent = alert.solution || (Array.isArray(alert.solutionSteps) ? alert.solutionSteps.join('\n') : 'Procedimento sob análise.');

      toast.innerHTML = `
        <div class="tars-toast-header">
          <div class="tars-toast-tag">
            <span class="pulse-dot"></span>
            <span>${alert.severity === 'CRITICAL' ? 'ALERTA CRÍTICO' : 'PROBLEMA DETECTADO'} • CHATBOT</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="tars-toast-time">${timeStr}</span>
            <button type="button" class="tars-toast-close" title="Dispensar">✕</button>
          </div>
        </div>

        <div class="tars-toast-title">
          <span>⚠️</span>
          <span>${alert.problemTitle}</span>
        </div>

        <div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">
          <strong>Cliente:</strong> ${alert.customerName} (${alert.protocol || 'Sem Protocolo'}) • <strong>Equipamento:</strong> ${eqLabel}
        </div>

        <div class="tars-toast-quote">
          “${alert.messageSnippet || alert.fullCustomerMessage || ''}”
        </div>

        <div class="tars-solution-box">
          <div class="tars-solution-box-title">
            <span>💡</span>
            <span>Solução Técnica Imediata Recomendada pelo TARS:</span>
          </div>
          <div class="tars-solution-text">${this.escapeHTML(solutionContent)}</div>
        </div>

        <div class="tars-toast-actions">
          <button type="button" class="tars-toast-btn tars-btn-copy" id="btn-copy-${alert.id}">
            📋 Copiar Solução
          </button>
          <button type="button" class="tars-toast-btn tars-btn-view" id="btn-obs-${alert.id}">
            🔍 Ver no Observer
          </button>
        </div>
      `;

      // Event: Close / Dismiss
      const closeBtn = toast.querySelector('.tars-toast-close');
      closeBtn?.addEventListener('click', () => {
        this.dismissToast(alert.id);
      });

      // Event: Copy Solution to Clipboard
      const copyBtn = toast.querySelector(`#btn-copy-${alert.id}`);
      copyBtn?.addEventListener('click', () => {
        const textToCopy = `[TARS Diagnóstico & Solução Fotovoltaica]\nCaso: ${alert.protocol} - ${alert.customerName}\nEquipamento: ${eqLabel}\nProblema: ${alert.problemTitle}\n\nSolução Recomendada:\n${solutionContent}`;
        navigator.clipboard.writeText(textToCopy).then(() => {
          copyBtn.textContent = '✓ Solução Copiada!';
          copyBtn.style.background = '#059669';
          copyBtn.style.color = '#fff';
          setTimeout(() => {
            copyBtn.textContent = '📋 Copiar Solução';
            copyBtn.style.background = '#10b981';
            copyBtn.style.color = '#064e3b';
          }, 3000);
        }).catch(() => {
          alert('Solução:\n' + solutionContent);
        });
      });

      // Event: View in Observer
      const obsBtn = toast.querySelector(`#btn-obs-${alert.id}`);
      obsBtn?.addEventListener('click', () => {
        this.dismissToast(alert.id);
        // Switch view to AI Assistant Observer panel
        if (typeof window.switchView === 'function') {
          window.switchView('ai-assistant');
          if (window.TARSAssistantUI) window.TARSAssistantUI.switchSubTab('observer');
        } else {
          document.getElementById('rail-ai-assistant-btn')?.click();
        }
        // If Observer UI is loaded, reload or focus case
        if (window.TarsObserverUI && typeof window.TarsObserverUI.loadCases === 'function') {
          window.TarsObserverUI.loadCases();
        }
      });

      // Auto-dismiss after 30 seconds if user does not interact
      const autoTimer = setTimeout(() => {
        this.dismissToast(alert.id);
      }, 30000);

      this.activeToasts.set(alert.id, { el: toast, timer: autoTimer });
      this.toastContainer.appendChild(toast);
    }

    dismissToast(alertId) {
      const item = this.activeToasts.get(alertId);
      if (item) {
        clearTimeout(item.timer);
        item.el.style.animation = 'tarsToastSlideOut 0.25s forwards';
        setTimeout(() => {
          item.el.remove();
          this.activeToasts.delete(alertId);
        }, 250);
      }

      // Mark alert acknowledged in backend
      fetch('/api/tars/realtime/alerts/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: alertId })
      }).catch(() => {});

      const a = this.alerts.find(x => x.id === alertId);
      if (a) a.read = true;
      this.updateBadgeCount();
    }

    renderAlertsHistory() {
      const container = document.getElementById('sentinel-alerts-list');
      if (!container) return;

      if (!this.alerts || this.alerts.length === 0) {
        container.innerHTML = '<div style="font-size:12px;color:#64748b;text-align:center;padding:12px;">Nenhum alerta recente recebido.</div>';
        return;
      }

      container.innerHTML = this.alerts.map(a => {
        const eq = a.equipment || {};
        const time = new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
          <div style="background:rgba(15,23,42,0.7);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px 12px;font-size:12px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
              <strong style="color:${a.severity === 'CRITICAL' ? '#f87171' : '#fbbf24'};">${this.escapeHTML(a.problemTitle)}</strong>
              <span style="font-family:monospace;color:#94a3b8;font-size:11px;">${time}</span>
            </div>
            <div style="color:#cbd5e1;margin-bottom:6px;">
              ${this.escapeHTML(a.customerName)} • ${this.escapeHTML(eq.manufacturer || 'Inversor')}
            </div>
            <div style="background:rgba(0,0,0,0.3);padding:6px 8px;border-radius:6px;color:#34d399;font-size:11.5px;white-space:pre-line;margin-bottom:6px;">
              ${this.escapeHTML(a.solution || (a.solutionSteps ? a.solutionSteps.join('\n') : ''))}
            </div>
            <div style="display:flex;justify-content:flex-end;">
              <button type="button" class="tars-toast-btn tars-btn-copy" style="font-size:11px;padding:4px 10px;" onclick="navigator.clipboard.writeText('${this.escapeQuotes(a.solution || '')}'); this.textContent='✓ Copiado!';">
                Copiar Solução
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    escapeHTML(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    escapeQuotes(str) {
      if (!str) return '';
      return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, '\\n');
    }
  }

  // Auto-instantiate when DOM is loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.TarsSentinel = new TarsSentinel();
    });
  } else {
    window.TarsSentinel = new TarsSentinel();
  }
})();
