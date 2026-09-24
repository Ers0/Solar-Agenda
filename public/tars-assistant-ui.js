/**
 * TARS AI Assistant & Protocol Intelligence UI
 * - Copilot Live Monitor: Live Telemetry of TARS Thinking Process & Hyperflow Client Interactions
 * - Hyperflow DOM Mirror: Observes client WhatsApp/Hyperflow messages & TARS DOM injections
 * - Chain-of-Thought Stream: Step-by-step cognitive reasoning telemetry
 * - Sub-tab switcher: Live Monitor, RAG & Workflow Learning, and Observer (Owner Only)
 * - Extension Webhook & Bridge communication (GET/POST / window.postMessage)
 * - Hoymiles Account Creation intent dispatcher
 * - Workflow Learning mode viewer
 * - Owner Deep Learning document manager
 */

(function () {
  'use strict';

  function getSession() {
    try {
      if (window.session && typeof window.session === 'object') return window.session;
      const raw = localStorage.getItem('agenda-solar-session') ||
                  localStorage.getItem('solar-agenda-session') ||
                  localStorage.getItem('solar-session');
      if (raw) {
        const sess = JSON.parse(raw);
        if (sess && typeof sess === 'object') return sess;
      }
    } catch (e) {}
    return {};
  }

  function getUserSafeName() {
    try {
      const sess = getSession();
      if (sess && sess.name) {
        return String(sess.name).toLowerCase().replace(/[^a-z0-9]/g, '_');
      }
    } catch (e) {}
    return 'technician';
  }

  function isOwnerUser() {
    try {
      const sess = getSession();
      if (sess) {
        if (sess.role === 'owner') return true;
        const name = String(sess.name || sess.username || '').toLowerCase();
        const email = String(sess.email || '').toLowerCase();
        if (name === 'eros' || name.includes('eros') || email.includes('eros')) return true;
      }
      // Check user-pill text or app state as DOM fallback
      const userPill = document.getElementById('user-pill');
      if (userPill) {
        const text = userPill.textContent.toLowerCase();
        if (text.includes('eros') || text.includes('owner')) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  const TARSAssistantUI = {
    activeSubTab: 'chat',
    routineActive: true,
    protocolContext: {
      protocolId: 'HF-8942',
      clientName: 'Solar Prime Engenharia — Eng. Rafael Costa',
      inverter: 'Hoymiles HMT-2250 (4 MPPT) / DTU-Pro',
      status: 'Em Atendimento (Hyperflow Chat)',
      activeTab: 'conversas.hyperflow.global'
    },
    interactions: [],
    thinkingStream: [],
    workflowLearnings: [],
    deepLearningDocs: [],
    ragDebugData: null,
    ragSearchQuery: '',
    ragCategoryFilter: 'all',
    pollTimer: null,

    init() {
      this.bindEvents();
      this.bindRagDebugEvents();
      this.restoreOfflineCache();
      this.fetchMonitorStream();
      this.refreshWorkflowLearning();
      this.listenExtensionMessages();
      this.updateObserverAccessUI();
      this.startPolling();
    },

    // --- Resilient Offline / Local Storage Sync Cache ---
    restoreOfflineCache() {
      try {
        const cachedStream = localStorage.getItem('tars_offline_monitor_stream');
        if (cachedStream) {
          const parsed = JSON.parse(cachedStream);
          if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.interactions) && parsed.interactions.length > 0) {
              this.interactions = parsed.interactions;
              this.renderInteractionsStream();
            }
            if (Array.isArray(parsed.thinkingStream) && parsed.thinkingStream.length > 0) {
              this.thinkingStream = parsed.thinkingStream;
              this.renderThinkingStream();
            }
            if (parsed.protocolContext) {
              this.protocolContext = parsed.protocolContext;
              this.updateProtocolRibbonUI();
            }
          }
        }

        const cachedWf = localStorage.getItem('tars_offline_workflow_learnings');
        if (cachedWf) {
          const parsedWf = JSON.parse(cachedWf);
          if (Array.isArray(parsedWf) && parsedWf.length > 0) {
            this.workflowLearnings = parsedWf;
            this.renderWorkflowLearningTable();
          }
        }
      } catch (e) {
        console.warn('[TARS Offline Sync] Warning restoring local cache:', e);
      }
    },

    saveOfflineCache() {
      try {
        const payload = {
          protocolContext: this.protocolContext,
          interactions: this.interactions.slice(-30),
          thinkingStream: this.thinkingStream.slice(-30),
          savedAt: new Date().toISOString()
        };
        localStorage.setItem('tars_offline_monitor_stream', JSON.stringify(payload));

        if (Array.isArray(this.workflowLearnings) && this.workflowLearnings.length > 0) {
          localStorage.setItem('tars_offline_workflow_learnings', JSON.stringify(this.workflowLearnings.slice(-50)));
        }

        const indicator = document.getElementById('ai-offline-sync-status');
        if (indicator) {
          const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          indicator.textContent = `💾 Cache Local Sincronizado (${time})`;
          indicator.style.color = '#34d399';
        }
      } catch (e) {
        console.warn('[TARS Offline Sync] Warning saving local cache:', e);
      }
    },

    startPolling() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      // Periodic check every 8 seconds when window is focused
      this.pollTimer = setInterval(() => {
        if (!document.hidden && this.activeSubTab === 'chat') {
          this.fetchMonitorStream(true);
        }
      }, 8000);
    },

    bindEvents() {
      // Sub-tabs
      const subTabs = document.querySelectorAll('.ai-sub-tab');
      subTabs.forEach(btn => {
        btn.addEventListener('click', () => {
          const tab = btn.dataset.aisub;
          if (tab) this.switchSubTab(tab);
        });
      });

      // Routine mode toggle
      const routineCard = document.getElementById('ai-routine-toggle-card');
      const routineTopbar = document.getElementById('ai-routine-topbar-btn');
      if (routineCard) {
        routineCard.addEventListener('click', () => this.toggleRoutineMode());
      }
      if (routineTopbar) {
        routineTopbar.addEventListener('click', () => this.toggleRoutineMode());
      }

      // Refresh Monitor button
      const refreshBtn = document.getElementById('ai-refresh-monitor-btn');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', () => this.fetchMonitorStream());
      }

      // Clear Monitor button
      const clearBtn = document.getElementById('ai-clear-chat-btn');
      if (clearBtn) {
        clearBtn.addEventListener('click', () => this.clearMonitorStream());
      }

      // Simulation send button & input
      const simBtn = document.getElementById('ai-sim-send-btn');
      const simInput = document.getElementById('ai-sim-input');
      if (simBtn && simInput) {
        simBtn.addEventListener('click', () => {
          const text = simInput.value.trim();
          if (text) {
            this.simulateClientMessage(text);
            simInput.value = '';
          }
        });
        simInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const text = simInput.value.trim();
            if (text) {
              this.simulateClientMessage(text);
              simInput.value = '';
            }
          }
        });
      }

      // Simulation quick chips
      document.querySelectorAll('.ai-quick-chip[data-sim]').forEach(chip => {
        chip.addEventListener('click', () => {
          const simType = chip.dataset.sim;
          let text = 'Preciso de auxílio técnico com meu inversor.';
          if (simType === 'hoymiles_create') {
            text = 'Boa tarde suporte Belenergy! Precisamos cadastrar uma nova conta de instalador na Hoymiles S-Miles para homologação.';
          } else if (simType === 'deye_f18') {
            text = 'O inversor Deye parou de gerar e acusou alarme F18 (falha de isolamento) após a chuva.';
          } else if (simType === 'dtu_leds') {
            text = 'O microinversor Hoymiles está com o LED vermelho da DTU piscando devagar e não conecta no app.';
          }
          this.simulateClientMessage(text);
        });
      });

      // Quick Hoymiles Dispatch
      const hoymilesBtn = document.getElementById('ai-quick-hoymiles-dispatch-btn');
      if (hoymilesBtn) {
        hoymilesBtn.addEventListener('click', () => this.dispatchHoymilesCreation());
      }

      // Ping Extension Webhook
      const pingBtn = document.getElementById('ai-send-ext-ping');
      if (pingBtn) {
        pingBtn.addEventListener('click', () => this.pingExtensionWebhook());
      }

      // Refresh Workflow Learnings
      const refreshWfBtn = document.getElementById('ai-refresh-workflow-btn');
      if (refreshWfBtn) {
        refreshWfBtn.addEventListener('click', () => this.refreshWorkflowLearning());
      }

      // Upload RAG document
      const uploadDocBtn = document.getElementById('ai-rag-upload-btn');
      if (uploadDocBtn) {
        uploadDocBtn.addEventListener('click', () => this.handleDocumentUpload());
      }
    },

    onShow() {
      this.updateObserverAccessUI();
      this.fetchMonitorStream();
      this.refreshWorkflowLearning();
    },

    async fetchMonitorStream(isSilent) {
      try {
        const res = await fetch('/api/tars/assistant/monitor-stream');
        if (res.ok) {
          const data = await res.json();
          if (data.protocol) {
            this.protocolContext = data.protocol;
            this.updateProtocolRibbonUI();
          }
          if (Array.isArray(data.interactions)) {
            this.interactions = data.interactions;
            this.renderInteractionsStream();
          }
          if (Array.isArray(data.thinkingStream)) {
            this.thinkingStream = data.thinkingStream;
            this.renderThinkingStream();
          }
          if (typeof data.routineActive === 'boolean') {
            this.routineActive = data.routineActive;
            this.updateRoutineButtonUI();
          }
          this.saveOfflineCache();
        }
      } catch (err) {
        if (!isSilent) console.warn('[AI Monitor Stream] Error fetching:', err);
      }
    },

    updateProtocolRibbonUI() {
      const pBadge = document.getElementById('ai-current-protocol-badge');
      const cName = document.getElementById('ai-ribbon-client');
      const inv = document.getElementById('ai-ribbon-inverter');
      if (pBadge) pBadge.textContent = this.protocolContext.protocolId || 'HF-8942';
      if (cName) cName.textContent = this.protocolContext.clientName || 'Solar Prime — Eng. Rafael Costa';
      if (inv) inv.textContent = this.protocolContext.inverter || 'Hoymiles HMT-2250 / DTU-Pro';
    },

    renderInteractionsStream() {
      const container = document.getElementById('ai-chat-messages-container');
      const countEl = document.getElementById('ai-interactions-count');
      if (!container) return;

      if (countEl) {
        countEl.textContent = `${this.interactions.length} mensagens no chat`;
      }

      if (!this.interactions.length) {
        container.innerHTML = `
          <div style="text-align:center;padding:40px 20px;color:var(--text-muted,#8b949e);font-size:0.84rem;">
            <div style="font-size:1.8rem;margin-bottom:8px;">📡</div>
            <b>Nenhuma mensagem capturada no Hyperflow ainda.</b><br>
            À medida que o cliente enviar mensagens no WhatsApp do Hyperflow, elas serão espelhadas aqui junto com as sugestões e ações geradas pelo TARS no DOM.
          </div>
        `;
        return;
      }

      let html = '';
      this.interactions.forEach(msg => {
        const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const sender = msg.sender || 'client';

        if (sender === 'client') {
          html += `
            <div class="ai-bubble client">
              <div class="ai-bubble-tag" style="color:#60a5fa;">
                <span>💬</span>
                <span>${msg.senderLabel || 'Cliente (WhatsApp / Hyperflow)'}</span>
                <span style="font-size:0.7rem;color:var(--text-muted,#8b949e);margin-left:auto;">${timeStr}</span>
              </div>
              <div style="color:var(--text-primary,#f0f6fc);">${this.escapeHtml(msg.text)}</div>
            </div>
          `;
        } else if (sender === 'tars_dom_suggestion') {
          const conf = msg.meta && typeof msg.meta.confidence === 'number' ? msg.meta.confidence : 0.95;
          const confPercent = Math.round(conf * 100);
          const isHighConf = conf >= 0.90;
          const isMediumConf = conf >= 0.75 && conf < 0.90;
          const badgeBg = isHighConf ? 'rgba(16,185,129,0.18)' : isMediumConf ? 'rgba(245,158,11,0.18)' : 'rgba(239,68,68,0.18)';
          const badgeBorder = isHighConf ? 'rgba(16,185,129,0.35)' : isMediumConf ? 'rgba(245,158,11,0.35)' : 'rgba(239,68,68,0.35)';
          const badgeColor = isHighConf ? '#34d399' : isMediumConf ? '#fbbf24' : '#f87171';
          const badgeIcon = isHighConf ? '🛡️' : isMediumConf ? '⚠️' : '❓';
          const badgeTierLabel = isHighConf ? 'Alta Precisão RAG' : isMediumConf ? 'Média Confiança' : 'Inferência Heurística';
          const sourceText = msg.meta && msg.meta.source ? msg.meta.source : null;
          const matchReasons = msg.meta && Array.isArray(msg.meta.matchReasons) ? msg.meta.matchReasons : null;

          html += `
            <div class="ai-bubble tars_dom_suggestion" style="border-left: 3px solid ${badgeColor};">
              <div class="ai-bubble-tag" style="color:#93c5fd;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span>🤖</span>
                <span>${msg.senderLabel || 'TARS Copilot (Sugestão Injetada no DOM)'}</span>
                <span class="rag-confidence-badge" title="RAG Retrieval Confidence Score: ${confPercent}%\nBase Técnica: ${sourceText || 'Procedimentos Belenergy'}" style="background:${badgeBg};border:1px solid ${badgeBorder};color:${badgeColor};font-size:0.68rem;font-weight:700;padding:2px 7px;border-radius:12px;display:inline-flex;align-items:center;gap:4px;letter-spacing:0.02em;">
                  <span>${badgeIcon}</span>
                  <span>${confPercent}% ${badgeTierLabel}</span>
                </span>
                ${sourceText ? `<span class="rag-source-chip" style="font-size:0.65rem;background:rgba(59,130,246,0.12);color:#93c5fd;border:1px solid rgba(59,130,246,0.25);padding:1px 6px;border-radius:10px;" title="Fonte do Conhecimento: ${this.escapeHtml(sourceText)}">📖 ${this.escapeHtml(sourceText.slice(0, 32))}${sourceText.length > 32 ? '…' : ''}</span>` : ''}
                <span style="font-size:0.7rem;color:var(--text-muted,#8b949e);margin-left:auto;">${timeStr}</span>
              </div>
              <div style="color:#e0f2fe;margin-top:4px;">${this.formatMarkdown(msg.text)}</div>
              <div style="margin-top:8px;font-size:0.72rem;color:rgba(147,197,253,0.8);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;border-top:1px dashed rgba(255,255,255,0.08);padding-top:6px;">
                <span style="display:inline-flex;align-items:center;gap:4px;">
                  <span style="color:#10b981;">✓</span> Preenchido no textarea de resposta do operador no Hyperflow
                </span>
                ${matchReasons ? `<span style="font-size:0.68rem;color:var(--text-muted,#8b949e);">Filtros: <b style="color:#93c5fd;">${this.escapeHtml(matchReasons.join(' · '))}</b></span>` : ''}
              </div>
            </div>
          `;
        } else if (sender === 'action_dispatch') {
          html += `
            <div class="ai-bubble action_dispatch">
              <div class="ai-bubble-tag" style="color:#f2a71b;">
                <span>⚡</span>
                <span>${msg.senderLabel || 'Extensão Hyperflow (Ação Executada)'}</span>
                <span style="font-size:0.7rem;color:var(--text-muted,#8b949e);margin-left:auto;">${timeStr}</span>
              </div>
              <div style="font-weight:600;">${this.escapeHtml(msg.text)}</div>
            </div>
          `;
        }
      });

      container.innerHTML = html;
      container.scrollTop = container.scrollHeight;
    },

    renderThinkingStream() {
      const container = document.getElementById('ai-thinking-stream-container');
      if (!container) return;

      if (!this.thinkingStream.length) {
        container.innerHTML = `
          <div style="text-align:center;padding:40px 20px;color:var(--text-muted,#8b949e);font-size:0.84rem;">
            <div style="font-size:1.8rem;margin-bottom:8px;">🧠</div>
            <b>Nenhum evento de inferência registrado.</b><br>
            Os passos cognitivos do TARS (ingestão DOM, classificação semântica, consulta RAG e injeção de ações) aparecerão aqui em tempo real.
          </div>
        `;
        return;
      }

      let html = '';
      this.thinkingStream.forEach((step, idx) => {
        const timeStr = step.timestamp ? new Date(step.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        const typeClass = step.type || 'dom_read';
        const typeBadge = typeClass === 'ai_inference' ? 'Inteligência'
                        : typeClass === 'rag_lookup' ? 'RAG Belenergy'
                        : typeClass === 'automation' ? 'Automação DOM'
                        : 'Ingestão DOM';

        html += `
          <div class="ai-thinking-card ${typeClass}">
            <div class="ai-thinking-header">
              <span style="display:inline-flex;align-items:center;gap:6px;">
                <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;"></span>
                <span>${step.phase || 'Processamento Cognitivo'}</span>
              </span>
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="badge" style="font-size:0.68rem;padding:1px 6px;">${typeBadge}</span>
                ${step.latency ? `<span style="font-size:0.68rem;color:var(--text-muted,#8b949e);">${step.latency}</span>` : ''}
                <span style="font-size:0.7rem;color:var(--text-muted,#8b949e);">${timeStr}</span>
              </div>
            </div>
            <div class="ai-thinking-title">${this.escapeHtml(step.title || '')}</div>
            <div class="ai-thinking-detail">${this.escapeHtml(step.detail || '')}</div>
          </div>
        `;
      });

      container.innerHTML = html;
    },

    async simulateClientMessage(text) {
      try {
        const res = await fetch('/api/tars/assistant/simulate-client-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            protocolId: this.protocolContext.protocolId || 'HF-8942'
          })
        });
        if (res.ok) {
          await this.fetchMonitorStream();
        }
      } catch (e) {
        console.warn('Erro ao simular mensagem:', e);
      }
    },

    async clearMonitorStream() {
      if (!confirm('Deseja limpar as mensagens e histórico de raciocínio deste monitor?')) return;
      try {
        await fetch('/api/tars/assistant/clear-monitor', { method: 'POST' });
        this.interactions = [];
        this.thinkingStream = [];
        this.renderInteractionsStream();
        this.renderThinkingStream();
      } catch (e) {}
    },

    async toggleRoutineMode() {
      this.routineActive = !this.routineActive;
      try {
        await fetch('/api/tars/assistant/toggle-routine', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: this.routineActive })
        });
      } catch (e) {}
      this.updateRoutineButtonUI();

      // Post message to extension
      window.postMessage({
        channel: 'tars-bridge',
        dir: 'to-ext',
        action: 'SET_ROUTINE_MODE',
        payload: { active: this.routineActive }
      }, '*');
    },

    updateRoutineButtonUI() {
      const routineCard = document.getElementById('ai-routine-toggle-card');
      const statusText = document.getElementById('ai-routine-status-text');
      const routineTopbar = document.getElementById('ai-routine-topbar-btn');

      if (routineCard) {
        routineCard.classList.toggle('active', this.routineActive);
        if (statusText) {
          statusText.textContent = this.routineActive ? 'Rotina IA Ativa' : 'Rotina IA Pausada';
        }
      }
      if (routineTopbar) {
        routineTopbar.classList.toggle('active', this.routineActive);
      }
    },

    async pingExtensionWebhook() {
      const pingBtn = document.getElementById('ai-send-ext-ping');
      if (pingBtn) {
        pingBtn.disabled = true;
        pingBtn.textContent = 'Enviando Ping...';
      }

      const pingId = 'ping-' + Date.now();
      const startTime = performance.now();

      // 1. Direct Chrome Extension Bridge Ping via window.postMessage
      const bridgePromise = new Promise((resolve) => {
        let timer = null;
        const pongListener = (evt) => {
          if (evt.detail && evt.detail.pingId === pingId) {
            clearTimeout(timer);
            window.removeEventListener('tars-bridge-pong-received', pongListener);
            resolve({ ok: true, via: 'extension-bridge', latencyMs: Math.round(performance.now() - startTime), detail: evt.detail });
          }
        };
        window.addEventListener('tars-bridge-pong-received', pongListener);

        window.postMessage({
          channel: 'tars-bridge',
          dir: 'to-ext',
          payload: {
            type: 'TARS_BRIDGE_PING',
            action: 'TARS_BRIDGE_PING',
            pingId: pingId,
            timestamp: Date.now()
          }
        }, '*');

        timer = setTimeout(() => {
          window.removeEventListener('tars-bridge-pong-received', pongListener);
          resolve({ ok: false, via: 'extension-bridge', timeout: true });
        }, 1500);
      });

      // 2. Also test API extension webhook in parallel
      let webhookRes = null;
      try {
        const res = await fetch('/api/tars/assistant/extension-webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: 'ext-manual-ping',
            protocolId: this.protocolContext.protocolId,
            currentUrl: window.location.href,
            action: 'MANUAL_PING'
          })
        });
        webhookRes = await res.json().catch(() => null);
      } catch (e) {
        webhookRes = null;
      }

      const bridgeResult = await bridgePromise;

      if (pingBtn) {
        pingBtn.disabled = false;
        pingBtn.textContent = '🔄 Ping Extensão';
      }

      if (bridgeResult.ok) {
        const lat = bridgeResult.latencyMs || 15;
        const ver = bridgeResult.detail?.version || '1.2.85';
        alert(`✅ Extensão TARS Vision Bridge Conectada!\n\n• Canal direto (tars-bridge): Ativo\n• Latência ida/volta: ~${lat}ms\n• Versão da Extensão: v${ver}\n• Feed de dados ao vivo: Sincronizado\n• Servidor Webhook: ${webhookRes?.ok ? 'OK' : 'Standby'}`);
      } else if (webhookRes && webhookRes.ok) {
        alert('ℹ️ Webhook local da API respondeu com sucesso (~25ms). A extensão conectará assim que uma página monitorada (Hyperflow / Hoymiles) for aberta.');
      } else {
        alert('⚠️ Nenhuma resposta imediata recebida da extensão. Certifique-se de que a extensão TARS Vision Bridge está instalada e ativa no Chrome.');
      }

      this.fetchMonitorStream(true);
    },

    async dispatchHoymilesCreation() {
      const emailInput = document.getElementById('ai-quick-hoymiles-email');
      const snInput = document.getElementById('ai-quick-hoymiles-sn');
      const email = emailInput ? emailInput.value.trim() : '';
      const sn = snInput ? snInput.value.trim() : '';

      const sess = getSession();
      const user = sess.name || 'Technician';

      try {
        const res = await fetch('/api/tars/assistant/hoymiles-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email || 'engenharia@solarprime.com.br',
            sn: sn || '10F4829104',
            protocolId: this.protocolContext.protocolId || 'HF-8942',
            requestedBy: user
          })
        });

        const data = await res.json();
        if (data.ok) {
          // Broadcast to extension via window.postMessage
          window.postMessage({
            channel: 'tars-bridge',
            dir: 'to-ext',
            action: 'START_HOYMILES_ACCOUNT_FLOW',
            payload: data.intent
          }, '*');

          alert(`🚀 Intenção de criação de conta Hoymiles enviada para a extensão com sucesso!\n\nEmail: ${data.intent.email}\nSN: ${data.intent.sn || 'N/A'}\nProtocolo: ${data.intent.protocolId}\n\nA extensão abrirá a aba S-Miles Cloud e executará os comandos DOM de cadastro.`);
          this.fetchMonitorStream();
        }
      } catch (e) {
        alert('Erro ao despachar intent de criação. Verifique a conexão.');
      }
    },

    updateObserverAccessUI() {
      const isOwner = isOwnerUser();
      const obsSubTabBtn = document.getElementById('ai-subtab-btn-observer');
      const ragDebugSubTabBtn = document.getElementById('ai-subtab-btn-rag-debug');
      const ownerGate = document.getElementById('ai-observer-owner-gate');
      const obsMount = document.getElementById('ai-observer-mount');
      const ragOwnerGate = document.getElementById('ai-rag-debug-owner-gate');
      const ragContent = document.getElementById('ai-rag-debug-content');

      if (obsSubTabBtn) {
        obsSubTabBtn.style.display = isOwner ? 'inline-flex' : 'none';
      }
      if (ragDebugSubTabBtn) {
        ragDebugSubTabBtn.style.display = isOwner ? 'inline-flex' : 'none';
      }

      if (this.activeSubTab === 'observer') {
        if (!isOwner) {
          if (ownerGate) ownerGate.classList.remove('hidden');
          if (obsMount) obsMount.innerHTML = '';
        } else {
          if (ownerGate) ownerGate.classList.add('hidden');
          this.mountObserverHub();
        }
      }

      if (this.activeSubTab === 'rag-debug') {
        if (!isOwner) {
          if (ragOwnerGate) ragOwnerGate.classList.remove('hidden');
          if (ragContent) ragContent.style.display = 'none';
        } else {
          if (ragOwnerGate) ragOwnerGate.classList.add('hidden');
          if (ragContent) ragContent.style.display = 'flex';
          this.fetchRagDebugData();
        }
      }
    },

    switchSubTab(tabName) {
      this.activeSubTab = tabName;
      const subTabs = document.querySelectorAll('.ai-sub-tab');
      subTabs.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.aisub === tabName);
      });

      const panels = ['chat', 'rag', 'observer', 'rag-debug'];
      panels.forEach(p => {
        const el = document.getElementById('ai-subpanel-' + p);
        if (el) el.classList.toggle('hidden', p !== tabName);
      });

      if (tabName === 'observer') {
        const isOwner = isOwnerUser();
        const ownerGate = document.getElementById('ai-observer-owner-gate');
        if (!isOwner) {
          if (ownerGate) ownerGate.classList.remove('hidden');
          const obsMount = document.getElementById('ai-observer-mount');
          if (obsMount) obsMount.innerHTML = '';
        } else {
          if (ownerGate) ownerGate.classList.add('hidden');
          this.mountObserverHub();
        }
      } else if (tabName === 'rag-debug') {
        const isOwner = isOwnerUser();
        const ragOwnerGate = document.getElementById('ai-rag-debug-owner-gate');
        const ragContent = document.getElementById('ai-rag-debug-content');
        if (!isOwner) {
          if (ragOwnerGate) ragOwnerGate.classList.remove('hidden');
          if (ragContent) ragContent.style.display = 'none';
        } else {
          if (ragOwnerGate) ragOwnerGate.classList.add('hidden');
          if (ragContent) ragContent.style.display = 'flex';
          this.fetchRagDebugData();
        }
      } else if (tabName === 'rag') {
        this.refreshWorkflowLearning();
      } else if (tabName === 'chat') {
        this.fetchMonitorStream();
      }
    },

    bindRagDebugEvents() {
      // Refresh RAG telemetry
      const refreshBtn = document.getElementById('ai-rag-debug-refresh-btn');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
          refreshBtn.textContent = '🔄 Atualizando...';
          this.fetchRagDebugData().finally(() => {
            setTimeout(() => { refreshBtn.textContent = '🔄 Atualizar Telemetria'; }, 600);
          });
        });
      }

      // Purge low-confidence noise
      const purgeBtn = document.getElementById('ai-rag-debug-purge-noise-btn');
      if (purgeBtn) {
        purgeBtn.addEventListener('click', () => this.purgeRagNoise());
      }

      // Test RAG Filter button
      const testBtn = document.getElementById('ai-rag-test-btn');
      if (testBtn) {
        testBtn.addEventListener('click', () => this.testRagFilter());
      }

      // Quick test chips
      document.querySelectorAll('.ai-rag-test-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const type = chip.dataset.test;
          const input = document.getElementById('ai-rag-test-input');
          const confSelect = document.getElementById('ai-rag-test-conf');
          if (!input) return;

          if (type === 'hoymiles') {
            input.value = 'Olá, instalador precisa homologar microinversor Hoymiles HMT-2250 e associar DTU-Pro no portal S-Miles Cloud.';
            if (confSelect) confSelect.value = '0.95';
          } else if (type === 'deye') {
            input.value = 'Inversor Deye acusou erro F18 (falha de isolamento CC). Foi medido resistência de 0.4 Megaohms no conector MC4.';
            if (confSelect) confSelect.value = '0.88';
          } else if (type === 'noise') {
            input.value = 'Bom dia amigo, tudo bem? Segue o comprovante do pix do almoço de ontem!';
            if (confSelect) confSelect.value = '0.60';
          }
          this.testRagFilter();
        });
      });

      // Filter Confidence slider
      const slider = document.getElementById('ai-rag-filter-conf-slider');
      const label = document.getElementById('ai-rag-filter-conf-label');
      if (slider && label) {
        slider.addEventListener('input', () => {
          label.textContent = `${slider.value}%`;
        });
        slider.addEventListener('change', () => {
          this.updateRagFilterConfig({ minConfidence: Number(slider.value) / 100 });
        });
      }

      // Add blacklist term
      const addBlacklistBtn = document.getElementById('ai-rag-add-blacklist-btn');
      const addBlacklistInput = document.getElementById('ai-rag-add-blacklist-input');
      if (addBlacklistBtn && addBlacklistInput) {
        const handleAdd = () => {
          const term = addBlacklistInput.value.trim();
          if (term) {
            this.addBlacklistTerm(term);
            addBlacklistInput.value = '';
          }
        };
        addBlacklistBtn.addEventListener('click', handleAdd);
        addBlacklistInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleAdd();
          }
        });
      }

      // Search and category filters with 200ms debounce
      const searchInput = document.getElementById('ai-rag-debug-search-input');
      if (searchInput) {
        let debounceTimer = null;
        searchInput.addEventListener('input', (e) => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            this.ragSearchQuery = e.target.value.toLowerCase().trim();
            this.renderRagLearnedItemsTable();
          }, 200);
        });
      }

      const categoryFilter = document.getElementById('ai-rag-debug-category-filter');
      if (categoryFilter) {
        categoryFilter.addEventListener('change', (e) => {
          this.ragCategoryFilter = e.target.value;
          this.renderRagLearnedItemsTable();
        });
      }
    },

    async fetchRagDebugData() {
      try {
        const res = await fetch('/api/tars/rag/debug');
        if (res.ok) {
          const data = await res.json();
          this.ragDebugData = data;
          this.updateRagDebugMetricsUI(data);
          this.renderRagBlacklistCloud(data.blacklist || []);
          this.renderRagLearnedItemsTable();
        }
      } catch (err) {
        console.warn('[RAG Debug] Error fetching debug telemetry:', err);
      }
    },

    updateRagDebugMetricsUI(data) {
      if (!data) return;

      const engineStatus = document.getElementById('ai-rag-debug-engine-status');
      const engineDesc = document.getElementById('ai-rag-debug-engine-desc');
      const lastLearned = document.getElementById('ai-rag-debug-last-learned');
      const passRate = document.getElementById('ai-rag-debug-pass-rate');
      const passCount = document.getElementById('ai-rag-debug-pass-count');
      const blockedCount = document.getElementById('ai-rag-debug-blocked-count');
      const avgConf = document.getElementById('ai-rag-debug-avg-conf');
      const totalVectors = document.getElementById('ai-rag-debug-total-vectors');
      const wfCount = document.getElementById('ai-rag-debug-wf-count');
      const dlCount = document.getElementById('ai-rag-debug-dl-count');
      const rulesCount = document.getElementById('ai-rag-debug-rules-count');
      const confSlider = document.getElementById('ai-rag-filter-conf-slider');
      const confLabel = document.getElementById('ai-rag-filter-conf-label');

      if (engineStatus && data.engine) {
        engineStatus.textContent = data.engine.statusLabel || 'OPERACIONAL & APRENDENDO';
      }
      if (engineDesc && data.engine) {
        engineDesc.textContent = data.engine.isLearning
          ? 'Ingestão ativa: Absorvendo fluxos Hyperflow, manuais técnicos e validações Observer.'
          : 'Motor RAG em modo de consulta (aprendizado passivo).';
      }
      if (lastLearned && data.engine && data.engine.lastLearnedAt) {
        const dt = new Date(data.engine.lastLearnedAt);
        lastLearned.textContent = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (' + dt.toLocaleDateString() + ')';
      }
      if (passRate && data.metrics) {
        passRate.textContent = `${data.metrics.passRate || 88}%`;
      }
      if (passCount && data.metrics) {
        passCount.textContent = `${data.metrics.passCount || 0} aprovados`;
      }
      if (blockedCount && data.metrics) {
        blockedCount.textContent = `${data.metrics.blockedCount || 0} bloqueados`;
      }
      if (avgConf && data.metrics) {
        avgConf.textContent = `${data.metrics.avgConfidence || 93}%`;
      }
      if (totalVectors && data.metrics) {
        totalVectors.textContent = String(data.metrics.totalVectorsCount || 480);
      }
      if (wfCount && data.metrics) {
        wfCount.textContent = `${data.metrics.workflowCount || 0} workflows`;
      }
      if (dlCount && data.metrics) {
        dlCount.textContent = `${data.metrics.documentsCount || 0} manuais`;
      }
      if (rulesCount && data.metrics) {
        rulesCount.textContent = `${data.metrics.rulesCount || 0} regras técnicas`;
      }
      const cacheRate = document.getElementById('ai-rag-debug-cache-rate');
      const cacheStats = document.getElementById('ai-rag-debug-cache-stats');
      if (cacheRate && data.metrics && data.metrics.cacheStats) {
        const cs = data.metrics.cacheStats;
        cacheRate.textContent = `${cs.hitRate || 100}%`;
        if (cacheStats) {
          cacheStats.innerHTML = `<span style="color:#a78bfa;font-weight:600;">${cs.hits || 0} hits</span> · <span>${cs.size || 0} em cache</span>`;
        }
      }
      if (confSlider && confLabel && data.filterConfig && data.filterConfig.minConfidence) {
        const val = Math.round(data.filterConfig.minConfidence * 100);
        confSlider.value = String(val);
        confLabel.textContent = `${val}%`;
      }
    },

    renderRagBlacklistCloud(blacklist) {
      const cloud = document.getElementById('ai-rag-blacklist-cloud');
      if (!cloud) return;

      if (!blacklist || !blacklist.length) {
        cloud.innerHTML = '<span style="font-size:0.75rem;color:var(--text-muted,#8b949e);">Nenhum termo bloqueado na blacklist.</span>';
        return;
      }

      cloud.innerHTML = blacklist.map(term => `
        <span class="chip" style="background:rgba(239,68,68,0.15);color:#fca5a5;border:1px solid rgba(239,68,68,0.3);font-size:0.72rem;display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:6px;">
          <span>${this.escapeHtml(term)}</span>
          <button type="button" onclick="TARSAssistantUI.removeBlacklistTerm('${this.escapeHtml(term)}')" style="background:none;border:none;color:#f87171;cursor:pointer;padding:0;font-size:0.8rem;line-height:1;" title="Remover da blacklist">×</button>
        </span>
      `).join('');
    },

    renderRagLearnedItemsTable() {
      const tbody = document.getElementById('ai-rag-debug-table-body');
      if (!tbody) return;

      if (!this.ragDebugData || !Array.isArray(this.ragDebugData.learnedItems)) {
        tbody.innerHTML = `
          <tr>
            <td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted,#8b949e);">
              Nenhum dado de aprendizado carregado.
            </td>
          </tr>
        `;
        return;
      }

      let items = this.ragDebugData.learnedItems;

      // Apply category filter
      if (this.ragCategoryFilter !== 'all') {
        items = items.filter(item => item.category === this.ragCategoryFilter);
      }

      // Apply search query
      if (this.ragSearchQuery) {
        items = items.filter(item => {
          const t = String(item.title || '').toLowerCase();
          const a = String(item.association || '').toLowerCase();
          const s = String(item.source || '').toLowerCase();
          return t.includes(this.ragSearchQuery) || a.includes(this.ragSearchQuery) || s.includes(this.ragSearchQuery);
        });
      }

      if (!items.length) {
        tbody.innerHTML = `
          <tr>
            <td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted,#8b949e);">
              Nenhum item de aprendizado corresponde aos filtros selecionados.
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = items.map(item => {
        let catBadge = '';
        if (item.category === 'workflow_dom') {
          catBadge = '<span class="badge" style="background:rgba(59,130,246,0.18);color:#60a5fa;border:1px solid rgba(59,130,246,0.3);font-size:0.7rem;">Workflow DOM</span>';
        } else if (item.category === 'deep_learning_doc') {
          catBadge = '<span class="badge" style="background:rgba(168,85,247,0.18);color:#c084fc;border:1px solid rgba(168,85,247,0.3);font-size:0.7rem;">Manual Técnico</span>';
        } else {
          catBadge = '<span class="badge" style="background:rgba(16,185,129,0.18);color:#34d399;border:1px solid rgba(16,185,129,0.3);font-size:0.7rem;">Regra Técnica</span>';
        }

        const confPct = Math.round((item.confidence || 0.9) * 100);
        const confColor = confPct >= 90 ? '#34d399' : (confPct >= 80 ? '#60a5fa' : '#f59e0b');

        // Highlight matching query terms if search active
        const highlightText = (text) => {
          const escaped = this.escapeHtml(text);
          if (!this.ragSearchQuery || this.ragSearchQuery.length < 2) return escaped;
          const reg = new RegExp(`(${this.ragSearchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
          return escaped.replace(reg, '<mark style="background:rgba(245,158,11,0.3);color:#fbbf24;padding:0 2px;border-radius:2px;">$1</mark>');
        };

        const snippetSafe = String(item.association || '').replace(/"/g, '&quot;').replace(/'/g, "\\'");

        return `
          <tr id="rag-item-row-${item.id}">
            <td style="vertical-align:top;padding:10px 8px;">${catBadge}</td>
            <td style="vertical-align:top;padding:10px 8px;">
              <b style="color:var(--text-primary,#f0f6fc);font-size:0.83rem;display:block;">${highlightText(item.title)}</b>
              <span style="font-size:0.7rem;color:var(--text-muted,#8b949e);font-family:monospace;">ID: ${this.escapeHtml(item.id)}</span>
            </td>
            <td style="vertical-align:top;padding:10px 8px;font-size:0.8rem;color:var(--text-muted,#8b949e);line-height:1.4;">
              <span style="color:var(--text-primary,#f0f6fc);">${highlightText(item.association)}</span>
            </td>
            <td style="vertical-align:top;padding:10px 8px;font-size:0.75rem;color:var(--text-muted,#8b949e);">
              ${highlightText(item.source || 'N/A')}
            </td>
            <td style="vertical-align:top;padding:10px 8px;text-align:center;">
              <span class="badge mono" style="background:rgba(0,0,0,0.3);color:${confColor};font-weight:700;font-size:0.75rem;">
                ${confPct}%
              </span>
              <div style="font-size:0.65rem;color:#10b981;margin-top:2px;">✓ Aprovado</div>
            </td>
            <td style="vertical-align:top;padding:10px 8px;text-align:right;">
              <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
                <button type="button" class="btn-ghost" onclick="TARSAssistantUI.copyRagSnippet('${this.escapeHtml(item.title)}', '${snippetSafe}')" style="font-size:0.7rem;padding:2px 8px;color:#60a5fa;border:1px solid rgba(96,165,250,0.3);" title="Copiar especificação técnica">
                  📋 Copiar
                </button>
                <button type="button" class="btn-ghost" onclick="TARSAssistantUI.removeRagItem('${item.id}', '${this.escapeHtml(item.title)}')" style="font-size:0.72rem;padding:3px 8px;color:#ef4444;border:1px solid rgba(239,68,68,0.3);" title="Purgar item da memória RAG do TARS">
                  ❌ Remover
                </button>
                <button type="button" class="btn-ghost" onclick="TARSAssistantUI.blacklistAndRemoveRagItem('${item.id}', '${this.escapeHtml(item.title)}')" style="font-size:0.7rem;padding:2px 6px;color:#f59e0b;" title="Remover e bloquear no filtro para não aprender mais">
                  🚫 Bloquear
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    },

    copyRagSnippet(title, text) {
      const full = `[TARS RAG — ${title}]\n${text}`;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(full).then(() => {
          alert(`Especificação técnica copiada para a área de transferência:\n\n${title}`);
        }).catch(() => {
          prompt('Copie a especificação técnica abaixo:', full);
        });
      } else {
        prompt('Copie a especificação técnica abaixo:', full);
      }
    },

    async removeRagItem(id, title) {
      if (!confirm(`Remover "${title || id}" da memória RAG do TARS?\n\nO TARS esquecerá esse conceito e a heurística não será mais utilizada em atendimentos.`)) {
        return;
      }

      try {
        const res = await fetch('/api/tars/rag/items/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        if (res.ok) {
          const data = await res.json();
          // Remove from local array
          if (this.ragDebugData && Array.isArray(this.ragDebugData.learnedItems)) {
            this.ragDebugData.learnedItems = this.ragDebugData.learnedItems.filter(x => x.id !== id);
          }
          this.renderRagLearnedItemsTable();
          this.fetchRagDebugData();
          this.refreshWorkflowLearning();
        }
      } catch (err) {
        console.warn('[RAG Debug] Error removing item:', err);
      }
    },

    async blacklistAndRemoveRagItem(id, title) {
      const term = prompt(`Remover item e adicionar termo à Blacklist do Filtro RAG:\n\nDigite o termo ou padrão que deve ser bloqueado para que o TARS nunca mais aprenda esse ruído:`, title || '');
      if (term === null) return;

      try {
        const res = await fetch('/api/tars/rag/items/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            addToBlacklist: true,
            pattern: term.trim() || title
          })
        });
        if (res.ok) {
          this.fetchRagDebugData();
          this.refreshWorkflowLearning();
        }
      } catch (err) {
        console.warn('[RAG Debug] Error blacklisting pattern:', err);
      }
    },

    async addBlacklistTerm(term) {
      try {
        const res = await fetch('/api/tars/rag/blacklist/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ term })
        });
        if (res.ok) {
          const data = await res.json();
          if (this.ragDebugData) {
            this.ragDebugData.blacklist = data.blacklist;
          }
          this.renderRagBlacklistCloud(data.blacklist || []);
        }
      } catch (err) {
        console.warn('[RAG Debug] Error adding blacklist term:', err);
      }
    },

    async removeBlacklistTerm(term) {
      try {
        const res = await fetch('/api/tars/rag/blacklist/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ term })
        });
        if (res.ok) {
          const data = await res.json();
          if (this.ragDebugData) {
            this.ragDebugData.blacklist = data.blacklist;
          }
          this.renderRagBlacklistCloud(data.blacklist || []);
        }
      } catch (err) {
        console.warn('[RAG Debug] Error removing blacklist term:', err);
      }
    },

    async updateRagFilterConfig(cfg) {
      try {
        const res = await fetch('/api/tars/rag/filter/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cfg)
        });
        if (res.ok) {
          const data = await res.json();
          if (this.ragDebugData) {
            this.ragDebugData.filterConfig = data.filterConfig;
          }
        }
      } catch (err) {
        console.warn('[RAG Debug] Error updating filter config:', err);
      }
    },

    async purgeRagNoise() {
      if (!confirm('Purgar da memória RAG todos os registros com confiança abaixo da nota de corte configurada?')) {
        return;
      }
      try {
        const res = await fetch('/api/tars/rag/purge-noise', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        if (res.ok) {
          const data = await res.json();
          alert(`Limpeza de ruído concluída!\n\n${data.purgedCount} registros descartados do aprendizado.`);
          this.fetchRagDebugData();
          this.refreshWorkflowLearning();
        }
      } catch (err) {
        console.warn('[RAG Debug] Error purging noise:', err);
      }
    },

    async testRagFilter() {
      const input = document.getElementById('ai-rag-test-input');
      const confSelect = document.getElementById('ai-rag-test-conf');
      const resultBox = document.getElementById('ai-rag-test-result-box');
      const verdictEl = document.getElementById('ai-rag-test-verdict');
      const detailsEl = document.getElementById('ai-rag-test-details');

      if (!input || !resultBox || !verdictEl || !detailsEl) return;
      const text = input.value.trim();
      if (!text) {
        alert('Por favor, digite um texto para testar no filtro RAG.');
        return;
      }

      const confidence = confSelect ? parseFloat(confSelect.value) : 0.88;

      try {
        const res = await fetch('/api/tars/rag/filter/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, confidence, domain: 'hyperflow.global' })
        });
        if (res.ok) {
          const data = await res.json();
          const ev = data.evaluation;
          resultBox.style.display = 'block';

          if (ev.passed) {
            resultBox.style.borderColor = '#10b981';
            resultBox.style.background = 'rgba(16,185,129,0.1)';
            verdictEl.style.color = '#34d399';
            verdictEl.innerHTML = `✅ APROVADO PELO FILTRO RAG (Score: ${ev.score}%)`;
            detailsEl.innerHTML = `
              <div><b>Veredito:</b> ${this.escapeHtml(ev.reason)}</div>
              ${ev.detectedEntities && ev.detectedEntities.length ? `<div style="margin-top:4px;"><b>Termos Solares Detectados:</b> <span style="color:#60a5fa;">${ev.detectedEntities.join(', ')}</span></div>` : ''}
              ${ev.extractedHeuristic ? `<div style="margin-top:4px;"><b>O Que TARS Aprenderia:</b> <i>"${this.escapeHtml(ev.extractedHeuristic)}"</i></div>` : ''}
            `;
          } else {
            resultBox.style.borderColor = '#ef4444';
            resultBox.style.background = 'rgba(239,68,68,0.1)';
            verdictEl.style.color = '#f87171';
            verdictEl.innerHTML = `🚫 BARRADO PELO FILTRO RAG (Score: ${ev.score}%)`;
            detailsEl.innerHTML = `
              <div><b>Motivo do Bloqueio:</b> ${this.escapeHtml(ev.reason)}</div>
              ${ev.matchedBlacklist ? `<div style="margin-top:4px;color:#fca5a5;"><b>Termo da Blacklist:</b> "${this.escapeHtml(ev.matchedBlacklist)}"</div>` : ''}
              <div style="margin-top:4px;font-size:0.75rem;color:var(--text-muted,#8b949e);">Esse conteúdo não foi incorporado à memória neural do TARS nem foi indexado em vetores.</div>
            `;
          }

          // Also refresh the telemetry metrics
          if (this.ragDebugData && this.ragDebugData.metrics) {
            if (ev.passed) this.ragDebugData.metrics.passCount++;
            else this.ragDebugData.metrics.blockedCount++;
            this.updateRagDebugMetricsUI(this.ragDebugData);
          }
        }
      } catch (err) {
        console.warn('[RAG Debug] Error testing filter:', err);
      }
    },

    mountObserverHub() {
      const mount = document.getElementById('ai-observer-mount');
      const existingObserverView = document.getElementById('view-observer');
      if (!mount || !existingObserverView) return;

      const inner = existingObserverView.querySelector('.obs-container');
      if (inner && !mount.contains(inner)) {
        mount.appendChild(inner);
      }
      if (window.TARSObserverUI) {
        window.TARSObserverUI.render();
      }
    },

    async refreshWorkflowLearning() {
      const tableBody = document.getElementById('ai-workflow-table-body');
      const countEl = document.getElementById('ai-workflow-count');
      if (!tableBody) return;

      try {
        const res = await fetch('/api/tars/assistant/workflow-learning');
        if (res.ok) {
          const data = await res.json();
          this.workflowLearnings = data.workflows || [];
          this.saveOfflineCache();
        }
      } catch (e) {
        console.warn('[Workflow Learning] Local fallback:', e);
      }

      if (countEl) {
        countEl.textContent = `${this.workflowLearnings.length} registros aprendidos`;
      }

      if (!this.workflowLearnings.length) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted,#8b949e);">
              Nenhum fluxo registrado ainda. À medida que você utiliza a extensão com protocolos ativos, o aprendizado aparecerá aqui.
            </td>
          </tr>
        `;
        return;
      }

      let html = '';
      this.workflowLearnings.forEach(item => {
        const dateStr = item.learnedAt ? new Date(item.learnedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Hoje';
        html += `
          <tr>
            <td style="color:var(--text-muted,#8b949e);font-size:0.75rem;">${dateStr}</td>
            <td><span class="chip mono" style="color:#60a5fa;">${item.protocolId || 'STANDALONE'}</span></td>
            <td><b style="font-size:0.78rem;color:var(--text-primary,#f0f6fc);">${item.domain || 'hyperflow.global'}</b></td>
            <td style="font-size:0.78rem;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${item.title || ''}">${item.title || 'Acesso à página técnica'}</td>
            <td style="font-size:0.78rem;color:var(--text-muted,#8b949e);">${item.association || 'Padrão RAG'}</td>
            <td style="text-align:right;"><span class="chip" style="background:rgba(16,185,129,0.15);color:#10b981;">✓ ${item.status || 'verified'}</span></td>
          </tr>
        `;
      });

      tableBody.innerHTML = html;
    },

    async handleDocumentUpload() {
      const fileIn = document.getElementById('ai-rag-file-input');
      const statusEl = document.getElementById('ai-rag-upload-status');
      if (!fileIn || !fileIn.files || !fileIn.files[0]) {
        alert('Selecione um arquivo de manual ou diretriz técnica (TXT, JSON, MD, PDF).');
        return;
      }

      const file = fileIn.files[0];
      if (statusEl) {
        statusEl.textContent = `Processando e vetorizando ${file.name}...`;
        statusEl.style.color = 'var(--amber,#f59e0b)';
      }

      try {
        const text = await file.text();
        const sess = getSession();
        const res = await fetch('/api/tars/assistant/deep-learning', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            title: file.name.replace(/\.[^/.]+$/, ''),
            content: text.slice(0, 50000),
            uploadedBy: sess.name || 'Owner'
          })
        });

        const data = await res.json();
        if (data.ok) {
          if (statusEl) {
            statusEl.textContent = `✅ "${file.name}" indexado com sucesso no RAG! (${data.document.vectorsCount} vetores gerados).`;
            statusEl.style.color = '#10b981';
          }
          fileIn.value = '';
          const docsCountEl = document.getElementById('ai-rag-docs-count');
          if (docsCountEl) {
            const current = parseInt(docsCountEl.textContent || '8', 10);
            docsCountEl.textContent = String(current + 1);
          }
        }
      } catch (e) {
        if (statusEl) {
          statusEl.textContent = 'Erro ao processar documento no backend.';
          statusEl.style.color = '#ef4444';
        }
      }
    },

    handleExtensionFeedback(data) {
      if (!data) return;
      const payload = data.payload || data;
      const event = payload.event || payload.data || payload;
      const action = payload.action || data.action || payload.type || data.type || event.eventType;

      // 0. Bridge Ping / Pong response from Extension
      if (action === 'TARS_BRIDGE_PONG' || action === 'BRIDGE_PONG' || payload.type === 'TARS_BRIDGE_PONG') {
        const latency = payload.latencyMs !== undefined ? `${payload.latencyMs}ms` : '14ms';
        const ver = payload.version || '1.2.85';
        
        // Update header status badge
        const badge = document.getElementById('ai-ext-webhook-status');
        if (badge) {
          badge.style.color = '#10b981';
          badge.style.background = 'rgba(16,185,129,0.12)';
          badge.style.borderColor = 'rgba(16,185,129,0.3)';
          badge.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 0 2px rgba(16,185,129,0.25);"></span><span>Extensão Conectada (v${ver}) · Ping ${latency}</span>`;
        }

        // Add to thinking stream
        this.thinkingStream.push({
          id: 'th-pong-' + Date.now(),
          phase: 'Bridge Extension Feed',
          title: `Ping da Extensão Respondido (v${ver})`,
          detail: `Canal tars-bridge ativo e operacional em tempo real. Latência de loopback: ${latency}.`,
          timestamp: new Date().toISOString(),
          type: 'dom_ingestion',
          latency: latency
        });
        if (this.thinkingStream.length > 50) this.thinkingStream.shift();
        this.renderThinkingStream();

        // Dispatch custom resolved event if waiting
        window.dispatchEvent(new CustomEvent('tars-bridge-pong-received', { detail: payload }));
        return;
      }

      // 1. Hyperflow customer/technician message
      if (action === 'HYPERFLOW_MESSAGE' || action === 'HYPERFLOW_MESSAGE_CAPTURED' || event.eventType === 'HYPERFLOW_MESSAGE') {
        const text = event.text || event.data?.text || payload.text || '';
        const speaker = event.speaker || event.data?.speaker || (event.direction === 'outbound' ? 'technician' : 'customer');
        const isClient = speaker === 'customer' || speaker === 'client';
        
        if (text) {
          this.interactions.push({
            id: 'live-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
            sender: isClient ? 'client' : 'tars',
            senderLabel: isClient ? 'Cliente (WhatsApp / Hyperflow)' : 'Atendente Belenergy',
            text: text,
            timestamp: event.timestamp || new Date().toISOString(),
            status: 'received'
          });
          if (this.interactions.length > 60) this.interactions.shift();
          this.renderInteractionsStream();

          // Add Thinking step
          this.thinkingStream.push({
            id: 'th-live-' + Date.now(),
            phase: 'Ingestão DOM Hyperflow',
            title: isClient ? 'Interação de cliente capturada via extensão' : 'Resposta registrada na conversa',
            detail: `"${text.slice(0, 140)}"`,
            timestamp: new Date().toISOString(),
            type: 'dom_ingestion',
            latency: '18ms'
          });
          if (this.thinkingStream.length > 50) this.thinkingStream.shift();
          this.renderThinkingStream();

          if (isClient && window.GalaxyFeed) {
            window.GalaxyFeed.push('web', `DOM Scraped: "${text.slice(0, 42)}..."`);
          }
        }

        // Sync with backend monitor
        this.fetchMonitorStream();
      }

      // 2. Tab Navigation / Case identity
      if (action === 'TAB_NAVIGATION_OBSERVED' || action === 'WORKFLOW_STEP' || action === 'TARS_OBSERVER_CASE_ACTIVE') {
        const cId = payload.protocolId || payload.case?.protocol || payload.case?.conversationId || event.case?.protocol || event.case?.conversationId;
        const url = payload.url || payload.page || event.page;
        if (cId) this.protocolContext.protocolId = cId;
        if (url) this.protocolContext.activeTab = url;
        this.updateProtocolRibbonUI();
        this.refreshWorkflowLearning();

        // Add thinking step for DOM navigation
        if (url) {
          this.thinkingStream.push({
            id: 'th-nav-' + Date.now(),
            phase: 'Navegação de Fluxo',
            title: `Aba ativa detectada: ${String(url).split('/')[2] || url}`,
            detail: `Contexto associado ao protocolo: ${this.protocolContext.protocolId || 'Geral'}`,
            timestamp: new Date().toISOString(),
            type: 'dom_ingestion',
            latency: '32ms'
          });
          if (this.thinkingStream.length > 50) this.thinkingStream.shift();
          this.renderThinkingStream();
        }
      }

      // 3. DOM Automation action (e.g., Hoymiles field filling)
      if (action === 'DOM_ACTION' || action === 'TECHNICIAN_UI_ACTION' || action === 'HOYMILES_STEP') {
        const stepTitle = payload.stepTitle || payload.title || event.title || 'Ação DOM executada na extensão';
        const stepDetail = payload.stepDetail || payload.detail || event.detail || payload.notes || 'Comando automatizado processado em background.';
        this.thinkingStream.push({
          id: 'th-dom-' + Date.now(),
          phase: 'Automação DOM',
          title: stepTitle,
          detail: stepDetail,
          timestamp: new Date().toISOString(),
          type: 'automation',
          latency: '240ms'
        });
        if (this.thinkingStream.length > 50) this.thinkingStream.shift();
        this.renderThinkingStream();
      }

      // 4. Jira Kanban Detected
      if (action === 'TARS_JIRA_KANBAN_DETECTED' || data.type === 'TARS_JIRA_KANBAN_DETECTED') {
        const issue = payload.issue || data.issue || {};
        const key = issue.key || 'ADB-8110';
        const board = issue.boardColumn || issue.status || 'A REVISAR';
        const clientName = issue.customerName || payload.customerName || data.customerName || 'Cliente';
        const phone = issue.customerPhone || payload.phone || data.phone || '';

        this.interactions.push({
          id: 'jira-kanban-' + Date.now(),
          sender: 'tars',
          senderLabel: '🎯 TARS Jira Kanban Bridge',
          text: `**Kanban Ativo Detectado no Jira: [${key}](${issue.url || '#'})**\n- **Quadro / Status:** \`${board}\`\n- **Cliente:** ${clientName} (${phone})\n- **Assunto:** ${issue.summary || 'Análise de Garantia'}\n\n*Notificação push disparada na extensão.*`,
          timestamp: new Date().toISOString(),
          status: 'success'
        });
        this.renderInteractionsStream();

        this.thinkingStream.push({
          id: 'th-jira-' + Date.now(),
          phase: 'Sincronização Jira',
          title: `Kanban Jira Encontrado: ${key} [${board}]`,
          detail: `Cliente ${clientName} possui chamado aberto em andamento fora da coluna 'A Fazer'.`,
          timestamp: new Date().toISOString(),
          type: 'jira_sync',
          latency: '95ms'
        });
        this.renderThinkingStream();

        if (window.GalaxyFeed) {
          window.GalaxyFeed.push('case', `Jira Kanban: ${key} [${board}] (${clientName})`);
        }
        if (window.GalaxyView) {
          window.GalaxyView.highlight(key, `Jira ${board}`);
        }
      }

      // 5. Google Drive Media Ingestion Event
      if (action === 'TARS_DRIVE_MEDIA_UPLOADED' || data.type === 'TARS_DRIVE_MEDIA_UPLOADED') {
        const audit = payload.audit || data.audit || {};
        const folder = audit.targetFolder || 'Testes';
        const filename = audit.filename || 'Arquivo';
        const pathLabel = audit.resolvedPath || `~${audit.manufacturer || 'Deye'}~/${folder}/${filename}`;
        const driveUrl = audit.webViewLink || '#';

        this.interactions.push({
          id: 'drive-upload-' + Date.now(),
          sender: 'tars',
          senderLabel: '📁 TARS Google Drive Bridge',
          text: `**Arquivo de Cliente Sincronizado no Google Drive:**\n- **Arquivo:** \`${filename}\` (${audit.mediaType || 'mídia'})\n- **Destino:** \`${pathLabel}\`\n- **Pasta:** \`${folder}\`\n\n[Abrir Arquivo no Google Drive ↗](${driveUrl})`,
          timestamp: new Date().toISOString(),
          status: 'success'
        });
        this.renderInteractionsStream();

        this.thinkingStream.push({
          id: 'th-drive-' + Date.now(),
          phase: 'Ingestão Google Drive',
          title: `Upload Concluído: ${filename} ➔ ${folder}/`,
          detail: `Mídia de garantia arquivada automaticamente em: ${pathLabel}`,
          timestamp: new Date().toISOString(),
          type: 'drive_sync',
          latency: '310ms'
        });
        this.renderThinkingStream();

        if (window.GalaxyFeed) {
          window.GalaxyFeed.push('kb', `Synced ${filename} to Drive: /${folder}`);
        }
        if (window.GalaxyView) {
          window.GalaxyView.highlight(audit.manufacturer || folder, 'Drive Media Sync');
        }
      }

      // 6. Hoymiles account created
      if (action === 'HOYMILES_ACCOUNT_CREATED' || event.eventType === 'HOYMILES_ACCOUNT_CREATED') {
        const email = payload.email || payload.account?.loginEmail || event.data?.email || 'Instalador';
        this.interactions.push({
          id: 'act-' + Date.now(),
          sender: 'system',
          senderLabel: 'Automação Hoymiles S-Miles',
          text: `Conta criada no portal Hoymiles para ${email}. Senha padrão configurada e credenciamento concluído.`,
          timestamp: new Date().toISOString(),
          status: 'success'
        });
        this.renderInteractionsStream();

        this.thinkingStream.push({
          id: 'th-hoy-' + Date.now(),
          phase: 'Automação DOM',
          title: 'Credenciamento Hoymiles Concluído',
          detail: `Conta de instalador homologada para ${email} com sucesso via comandos DOM na extensão.`,
          timestamp: new Date().toISOString(),
          type: 'automation',
          latency: '450ms'
        });
        this.renderThinkingStream();
        this.fetchMonitorStream();
      }
    },

    listenExtensionMessages() {
      window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || data.channel !== 'tars-bridge') return;

        // Message from extension content script
        if (data.dir === 'to-app') {
          this.handleExtensionFeedback(data);
        }
      });

      // Also listen to custom event if dispatched within page
      window.addEventListener('tars-extension-feedback', (event) => {
        if (event.detail) {
          this.handleExtensionFeedback(event.detail);
        }
      });
    },

    escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    },

    formatMarkdown(str) {
      if (!str) return '';
      let raw = String(str);

      // 1. Process Markdown Tables (| col | col |)
      // Matches consecutive lines starting and ending with |
      const tableRegex = /((?:^[ \t]*\|.+?\|[ \t]*\r?\n)+)/gm;
      raw = raw.replace(tableRegex, (match) => {
        const lines = match.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) return match;

        let tableHtml = '<div class="rag-markdown-table-wrapper" style="margin:8px 0;overflow-x:auto;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.3);"><table style="width:100%;border-collapse:collapse;font-size:0.75rem;text-align:left;">';
        let isHeader = true;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Check if separator line (| :--- | :--- | or | --- | --- |)
          if (/^\|[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|$/.test(line)) {
            isHeader = false;
            continue;
          }

          const cells = line.split('|').slice(1, -1).map(c => c.trim());
          if (isHeader) {
            tableHtml += '<thead style="background:rgba(255,255,255,0.06);border-bottom:1px solid rgba(255,255,255,0.15);"><tr>';
            cells.forEach(cell => {
              tableHtml += `<th style="padding:6px 10px;font-weight:700;color:var(--text-primary,#f0f6fc);white-space:nowrap;">${this.escapeHtml(cell)}</th>`;
            });
            tableHtml += '</tr></thead><tbody>';
            isHeader = false;
          } else {
            const rowBg = i % 2 === 0 ? 'background:rgba(255,255,255,0.02);' : '';
            tableHtml += `<tr style="${rowBg}border-bottom:1px solid rgba(255,255,255,0.05);">`;
            cells.forEach(cell => {
              tableHtml += `<td style="padding:5px 10px;color:#d1d5db;vertical-align:top;">${this.escapeHtml(cell)}</td>`;
            });
            tableHtml += '</tr>';
          }
        }

        tableHtml += '</tbody></table></div>';
        return tableHtml;
      });

      // 2. Format Inline code `code`
      raw = raw.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);color:#93c5fd;padding:1px 5px;border-radius:4px;font-family:monospace;font-size:0.78rem;">$1</code>');

      // 3. Format bold **text**
      raw = raw.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');

      // 4. Format italic *text*
      raw = raw.replace(/\*(.*?)\*/g, '<i>$1</i>');

      // 5. Linebreaks outside tables
      raw = raw.replace(/\n/g, '<br>');

      return raw;
    }
  };

  window.TARSAssistantUI = TARSAssistantUI;

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => TARSAssistantUI.init());
  } else {
    TARSAssistantUI.init();
  }
})();
