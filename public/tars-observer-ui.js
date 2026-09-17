// public/tars-observer-ui.js
// TARS Observer Mode (v1.2.81) UI — Passive Event-Sourced Case Management & Validated Learning
// Solar Agenda Enterprise Interface

(function (window) {
  'use strict';

  let currentCases = [];
  let currentCase = null;
  let activeFilter = 'all';
  let searchQuery = '';
  let pollInterval = null;
  let isInitialized = false;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(message, type = 'info') {
    let toastContainer = document.getElementById('obs-toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'obs-toast-container';
      toastContainer.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
      document.body.appendChild(toastContainer);
    }
    const el = document.createElement('div');
    const bg = type === 'success' ? '#16a34a' : (type === 'error' ? '#dc2626' : '#2563eb');
    el.style.cssText = `background:${bg};color:#fff;padding:10px 18px;border-radius:8px;font-size:0.85rem;font-weight:600;box-shadow:0 10px 25px rgba(0,0,0,0.5);opacity:0;transform:translateY(10px);transition:all 0.25s ease;pointer-events:auto;`;
    el.textContent = message;
    toastContainer.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(10px)';
      setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 300);
    }, 3500);
  }

  function formatDate(isoStr) {
    if (!isoStr) return 'N/A';
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (_) {
      return isoStr;
    }
  }

  function getConfidenceBadge(level, score) {
    const pct = Math.round((score || 0) * 100);
    if (level === 'HIGH' || score >= 0.85) {
      return `<span class="tars-obs-conf high" title="Alta confiança (${pct}%)">ALTA (${pct}%)</span>`;
    }
    if (level === 'MEDIUM' || score >= 0.60) {
      return `<span class="tars-obs-conf medium" title="Confiança moderada (${pct}%)">MÉDIA (${pct}%)</span>`;
    }
    return `<span class="tars-obs-conf low" title="Baixa confiança: revisão obrigatória (${pct}%)">BAIXA (${pct}%) - REVISÃO</span>`;
  }

  function getStatusBadge(status) {
    const s = String(status || 'NEW').toUpperCase();
    const map = {
      NEW: { label: 'Novo', cls: 'status-new' },
      ACTIVE: { label: 'Ativo', cls: 'status-active' },
      WAITING_FOR_CUSTOMER: { label: 'Aguardando Cliente', cls: 'status-waiting' },
      PROCESSING: { label: 'Processando', cls: 'status-processing' },
      HUMAN_REVIEW: { label: 'Revisão Humana', cls: 'status-hr' },
      RESOLVED: { label: 'Resolvido', cls: 'status-resolved' },
      CLOSED: { label: 'Fechado', cls: 'status-closed' }
    };
    const info = map[s] || { label: s, cls: 'status-generic' };
    return `<span class="tars-status-pill ${info.cls}">${info.label}</span>`;
  }

  // API Call helper
  async function fetchCases() {
    try {
      let url = '/api/tars/observer/cases?status=' + encodeURIComponent(activeFilter);
      if (searchQuery) {
        url += '&q=' + encodeURIComponent(searchQuery);
      }
      const [casesRes, allCasesRes] = await Promise.all([
        fetch(url),
        activeFilter !== 'all' ? fetch('/api/tars/observer/cases?status=all').catch(() => null) : null
      ]);
      if (!casesRes.ok) throw new Error('HTTP ' + casesRes.status);
      const data = await casesRes.json();
      currentCases = data.cases || [];

      let allCases = currentCases;
      if (allCasesRes && allCasesRes.ok) {
        const allData = await allCasesRes.json();
        allCases = allData.cases || [];
      }

      renderStats(allCases);
      renderGrid();
      updateSyncIndicator();
    } catch (err) {
      console.warn('[TARS Observer UI] Error loading cases:', err);
      const el = document.getElementById('obs-sync-status');
      if (el) {
        el.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ef4444;"></span> Erro ao atualizar';
        el.style.color = '#ef4444';
      }
    }
  }

  function updateSyncIndicator() {
    let el = document.getElementById('obs-sync-status');
    if (!el) {
      const parent = document.querySelector('.obs-top-actions') || document.querySelector('.tars-obs-header-actions') || document.querySelector('.tars-obs-header');
      if (parent) {
        el = document.createElement('div');
        el.id = 'obs-sync-status';
        el.style.cssText = 'font-size:0.78rem;font-weight:600;color:#10b981;padding:6px 12px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);border-radius:20px;display:inline-flex;align-items:center;gap:6px;';
        parent.insertBefore(el, parent.firstChild);
      }
    }
    if (el) {
      const now = new Date();
      el.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 0 2px rgba(16,185,129,0.25);"></span> Sincronizado às ' + now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      el.style.color = '#10b981';
    }
  }

  function renderStats(casesList) {
    const list = Array.isArray(casesList) ? casesList : currentCases;
    const total = list.length;
    const hr = list.filter(c => c.status === 'HUMAN_REVIEW' || c.needsHumanReview).length;
    const active = list.filter(c => c.status !== 'CLOSED' && c.status !== 'RESOLVED').length;
    const closed = list.filter(c => c.status === 'CLOSED' || c.status === 'RESOLVED').length;
    const candidates = list.filter(c => c.learningMetadata?.isTrainingCandidate || c.learningMetadata?.isValidated).length;

    const elTotal = document.getElementById('obs-stat-total');
    const elHr = document.getElementById('obs-stat-hr');
    const elActive = document.getElementById('obs-stat-active');
    const elClosed = document.getElementById('obs-stat-closed');
    const elCandidates = document.getElementById('obs-stat-candidates');

    if (elTotal) elTotal.textContent = total;
    if (elHr) elHr.textContent = hr;
    if (elActive) elActive.textContent = active;
    if (elClosed) elClosed.textContent = closed;
    if (elCandidates) elCandidates.textContent = candidates;
  }

  function renderGrid() {
    const grid = document.getElementById('tars-observer-cases-grid');
    if (!grid) return;

    if (currentCases.length === 0) {
      grid.innerHTML = `
        <div class="obs-empty-state">
          <div class="obs-empty-icon">📡</div>
          <h3>Nenhum caso encontrado em Modo Observador</h3>
          <p>O TARS Vision Bridge v1.2.81 opera passivamente sem interagir com o cliente. Eventos recebidos em <code>POST /api/tars/observer/events</code> aparecem automaticamente aqui.</p>
          <button class="btn-primary" id="obs-empty-sim-btn" style="margin-top:14px;">⚡ Simular Evento de Atendimento</button>
        </div>
      `;
      document.getElementById('obs-empty-sim-btn')?.addEventListener('click', openSimulateModal);
      return;
    }

    grid.innerHTML = currentCases.map(c => {
      const isCandidate = c.learningMetadata?.isTrainingCandidate;
      const lastMsg = c.messages && c.messages.length > 0 ? c.messages[c.messages.length - 1] : null;
      const evidenceCount = (c.technicalEvidence || []).length;
      const obsCount = (c.aiObservations || []).length;
      const uncertaintyCount = (c.uncertainties || []).length;

      return `
        <div class="obs-case-card ${c.needsHumanReview ? 'requires-review' : ''}" data-case-id="${escapeHtml(c.id)}">
          <div class="obs-card-head">
            <div class="obs-card-id-row">
              <span class="obs-proto-tag">${escapeHtml(c.protocol || 'SEM PROTOCOLO')}</span>
              <span class="obs-conv-tag" title="Conversation ID">${escapeHtml(c.conversationId || '')}</span>
              ${isCandidate ? '<span class="obs-golden-badge" title="Candidato a Aprendizado (Golden Case)">★ Golden Case</span>' : ''}
            </div>
            <div class="obs-card-status-row">
              ${getStatusBadge(c.status)}
              ${getConfidenceBadge(c.confidenceLevel, c.confidence)}
            </div>
          </div>

          <div class="obs-card-body">
            <div class="obs-card-customer">
              <strong>${escapeHtml(c.customer?.name || 'Cliente')}</strong>
              <span class="obs-phone">${escapeHtml(c.customer?.phone || '')}</span>
            </div>

            <div class="obs-card-equip">
              <span class="obs-equip-mfr">${escapeHtml(c.equipment?.manufacturer || 'Inversor')}</span>
              <span class="obs-equip-model">${escapeHtml(c.equipment?.model || '')}</span>
              ${c.equipment?.sn ? `<span class="obs-equip-sn">SN: ${escapeHtml(c.equipment.sn)}</span>` : ''}
            </div>

            ${lastMsg ? `
              <div class="obs-last-msg">
                <span class="obs-speaker-tag">${lastMsg.speaker === 'technician' ? 'Técnico' : 'Cliente'}:</span>
                <span class="obs-msg-preview">${escapeHtml(lastMsg.text)}</span>
              </div>
            ` : ''}

            ${uncertaintyCount > 0 ? `
              <div class="obs-card-warning">
                ⚠️ ${uncertaintyCount} incerteza(s) técnica(s) requerem validação humana
              </div>
            ` : ''}
          </div>

          <div class="obs-card-foot">
            <div class="obs-foot-counts">
              <span title="Evidências Técnicas">📊 ${evidenceCount} evidência(s)</span>
              <span title="Interpretações TARS">🤖 ${obsCount} observação(ões)</span>
            </div>
            <span class="obs-date">${formatDate(c.updatedAt)}</span>
          </div>
        </div>
      `;
    }).join('');

    // Attach click handlers
    grid.querySelectorAll('.obs-case-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.caseId;
        openCaseDetails(id);
      });
    });
  }

  // Deep-dive Modal / Drawer
  async function openCaseDetails(caseId) {
    try {
      const res = await fetch(`/api/tars/observer/cases?id=${encodeURIComponent(caseId)}`);
      if (!res.ok) throw new Error('Case not found');
      const data = await res.json();
      currentCase = data.case;
      renderCaseModal();
    } catch (err) {
      showToast('Erro ao carregar detalhes do caso: ' + err.message, 'error');
    }
  }

  function renderCaseModal() {
    if (!currentCase) return;
    const modal = document.getElementById('tars-obs-modal');
    if (!modal) return;

    const c = currentCase;
    const isCandidate = c.learningMetadata?.isTrainingCandidate;
    const isVal = c.learningMetadata?.isValidated;

    document.getElementById('obs-modal-title').innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <span class="obs-proto-tag" style="font-size:14px; padding:4px 8px;">${escapeHtml(c.protocol)}</span>
        <span style="font-weight:600;">${escapeHtml(c.customer?.name || 'Cliente')}</span>
        ${getStatusBadge(c.status)}
        ${getConfidenceBadge(c.confidenceLevel, c.confidence)}
        ${isCandidate ? '<span class="obs-golden-badge">★ Candidato de Treinamento</span>' : ''}
      </div>
    `;

    document.getElementById('obs-modal-subtitle').innerHTML = `
      ID Conversa: <code>${escapeHtml(c.conversationId)}</code> • Equipamento: <strong>${escapeHtml(c.equipment?.manufacturer)} ${escapeHtml(c.equipment?.model)}</strong> • S/N: <code>${escapeHtml(c.equipment?.sn || 'Pendente')}</code> • Criado em ${formatDate(c.createdAt)}
    `;

    // Low confidence alert banner
    const alertBox = document.getElementById('obs-modal-hr-alert');
    if (c.needsHumanReview || c.status === 'HUMAN_REVIEW') {
      alertBox.classList.remove('hidden');
      alertBox.innerHTML = `
        <div class="obs-alert-content">
          <strong>⚠️ ATENÇÃO: REVISÃO HUMANA OBRIGATÓRIA</strong>
          <p>O TARS identificou baixa confiança (&lt; 70%) ou incertezas técnicas em evidências visuais/dados de medição. A intervenção humana é obrigatória antes de qualquer encerramento ou decisão de garantia.</p>
          <ul>
            ${(c.uncertainties || []).map(u => `<li>${escapeHtml(u)}</li>`).join('')}
          </ul>
        </div>
      `;
    } else {
      alertBox.classList.add('hidden');
    }

    // 1. Timeline Tab
    const tlContainer = document.getElementById('obs-tab-timeline-content');
    if (tlContainer) {
      tlContainer.innerHTML = (c.timeline || []).map(t => `
        <div class="obs-tl-item">
          <div class="obs-tl-dot"></div>
          <div class="obs-tl-body">
            <div class="obs-tl-header">
              <span class="obs-tl-type">${escapeHtml(t.eventType)}</span>
              <span class="obs-tl-time">${formatDate(t.timestamp)}</span>
            </div>
            <div class="obs-tl-title">${escapeHtml(t.title)}</div>
            <div class="obs-tl-detail">${escapeHtml(t.detail)}</div>
            ${t.author ? `<div class="obs-tl-author">Autor: ${escapeHtml(t.author)}</div>` : ''}
          </div>
        </div>
      `).join('');
    }

    // 2. Transcript & Evidence Tab
    const msgContainer = document.getElementById('obs-tab-messages-content');
    if (msgContainer) {
      const msgsHtml = (c.messages || []).map(m => `
        <div class="obs-chat-bubble ${m.speaker === 'technician' ? 'outbound' : 'inbound'}">
          <div class="obs-bubble-meta">
            <strong>${m.speaker === 'technician' ? 'Técnico Solar' : escapeHtml(c.customer?.name || 'Cliente')}</strong>
            <span>${formatDate(m.timestamp)}</span>
          </div>
          <div class="obs-bubble-text">${escapeHtml(m.text)}</div>
          ${m.attachmentCount > 0 ? `<div class="obs-bubble-att">📎 ${m.attachmentCount} anexo(s)</div>` : ''}
        </div>
      `).join('');

      const evHtml = (c.technicalEvidence || []).map(e => `
        <div class="obs-ev-card">
          <div class="obs-ev-type">${escapeHtml(e.type.toUpperCase())}</div>
          <div class="obs-ev-val">${escapeHtml(e.value)}</div>
          <div class="obs-ev-meta">Origem: ${escapeHtml(e.source)} • ${formatDate(e.timestamp)}</div>
          ${e.notes ? `<div class="obs-ev-notes">${escapeHtml(e.notes)}</div>` : ''}
        </div>
      `).join('');

      msgContainer.innerHTML = `
        <div class="obs-tab-split">
          <div class="obs-split-left">
            <h4>Transcrição da Conversa Observada</h4>
            <div class="obs-chat-stream">${msgsHtml || '<p class="text-muted">Nenhuma mensagem interceptada.</p>'}</div>
          </div>
          <div class="obs-split-right">
            <h4>Evidências Técnicas Extraídas</h4>
            <div class="obs-ev-stream">${evHtml || '<p class="text-muted">Nenhuma medição ou alarme isolado.</p>'}</div>
          </div>
        </div>
      `;
    }

    // 3. AI Observations & Human Validation Tab
    const obsContainer = document.getElementById('obs-tab-observations-content');
    if (obsContainer) {
      const obsListHtml = (c.aiObservations || []).map(o => {
        const isObsVal = o.isValidated;
        const hasCorr = !!o.humanCorrection;

        return `
          <div class="obs-item-box ${isObsVal ? 'validated' : ''} ${o.needsHumanReview ? 'needs-hr' : ''}">
            <div class="obs-item-head">
              <span class="obs-item-category">${escapeHtml(o.category)}</span>
              ${getConfidenceBadge(o.confidenceLevel, o.confidence)}
              ${isObsVal ? '<span class="obs-val-pill">✓ Validado por Humano</span>' : '<span class="obs-pending-pill">Aguardando Validação</span>'}
            </div>
            <div class="obs-item-title">${escapeHtml(o.title)}</div>
            <div class="obs-item-detail">${escapeHtml(o.detail)}</div>
            ${o.suggestedAction ? `<div class="obs-item-sugg"><strong>Recomendação Sugerida:</strong> ${escapeHtml(o.suggestedAction)}</div>` : ''}
            
            ${hasCorr ? `
              <div class="obs-corr-box">
                <strong>Correção Humana Aplicada:</strong> ${escapeHtml(o.humanCorrection)}
                ${o.validatedBy ? `<span>(por ${escapeHtml(o.validatedBy)})</span>` : ''}
              </div>
            ` : ''}

            <div class="obs-item-actions">
              <button class="btn-ghost btn-sm" onclick="window.TARSObserverUI.validateObs('${escapeHtml(c.id)}', '${escapeHtml(o.id)}')">
                ${isObsVal ? '✓ Revalidar' : '✓ Validar como Preciso'}
              </button>
              <button class="btn-ghost btn-sm" onclick="window.TARSObserverUI.correctObsPrompt('${escapeHtml(c.id)}', '${escapeHtml(o.id)}')">
                ✎ Corrigir Interpretação
              </button>
            </div>
          </div>
        `;
      }).join('');

      // Human Analysis inputs
      const ha = c.humanAnalysis || {};
      obsContainer.innerHTML = `
        <div class="obs-observations-list">
          <h4>Interpretações da IA & Auditoria Técnica</h4>
          ${obsListHtml || '<p class="text-muted">Nenhuma observação automática gerada.</p>'}
        </div>

        <div class="obs-human-analysis-section">
          <h4>Análise Humana Especializada (Fotos, Vídeos e Laudo Técnico)</h4>
          <p class="text-muted">Registre sua avaliação de fotos com reflexo, ruídos sonoros, multímetro e considerações de engenharia.</p>
          
          <div class="form-group" style="margin-top:10px;">
            <label>Notas de Inspeção Visual (Etiquetas, Cabos, Oxidação, Painel):</label>
            <textarea id="ha-visual-notes" class="obs-textarea" rows="2" placeholder="Ex: Foto da placa ampliada confirma SN 230419824102. Ausência de sinais de queima nos bornes CA...">${escapeHtml(ha.visualNotes || '')}</textarea>
          </div>

          <div class="form-group">
            <label>Conclusão Técnica do Especialista:</label>
            <textarea id="ha-tech-conclusion" class="obs-textarea" rows="2" placeholder="Ex: Defeito de relé de saída CA confirmado após surto. Indicada substituição de placa mãe...">${escapeHtml(ha.technicianConclusion || '')}</textarea>
          </div>

          <button class="btn-primary" style="margin-top:8px;" onclick="window.TARSObserverUI.saveHumanAnalysis('${escapeHtml(c.id)}')">
            💾 Salvar Análise Humana
          </button>
        </div>
      `;
    }

    // 4. Case Closure & Learning Pipeline Tab
    const closeContainer = document.getElementById('obs-tab-closure-content');
    if (closeContainer) {
      closeContainer.innerHTML = `
        <div class="obs-closure-box">
          <h4>Fechamento do Caso & Candidato a Dataset de IA</h4>
          <p class="text-muted">Ao fechar o caso com validação humana, você cria um exemplo confiável para alimentar o pipeline de aprendizado contínuo do TARS.</p>
          
          <div class="form-group" style="margin-top:12px;">
            <label>Diagnóstico Técnico Final Conclusivo:</label>
            <input id="close-final-diag" class="obs-input" value="${escapeHtml(c.finalDiagnosis || '')}" placeholder="Ex: Falha interna do relé de proteção F30 no inversor Deye SUN-8K">
          </div>

          <div class="form-group">
            <label>Resolução Final Aplicada:</label>
            <input id="close-final-res" class="obs-input" value="${escapeHtml(c.finalResolution || '')}" placeholder="Ex: Protocolo de troca de placa controladora aberto e aprovado em garantia">
          </div>

          <div class="obs-candidate-toggle-row">
            <label class="obs-checkbox-label">
              <input type="checkbox" id="close-mark-candidate" ${isCandidate ? 'checked' : ''}>
              <strong>Marcar como Caso Dourado / Candidato a Treinamento de IA (Golden Case)</strong>
            </label>
          </div>

          <div class="form-group" style="margin-top:8px;">
            <label>Motivo da Seleção para o Dataset:</label>
            <input id="close-candidate-reason" class="obs-input" value="${escapeHtml(c.learningMetadata?.candidateReason || '')}" placeholder="Ex: Exemplo de alta qualidade para diagnóstico diferencial de erro F30 com rede normal">
          </div>

          <div class="form-group">
            <label>Tags de Treinamento (separadas por vírgula):</label>
            <input id="close-tags" class="obs-input" value="${escapeHtml((c.learningMetadata?.tags || []).join(', '))}" placeholder="deye, f30, hardware-fault, relay, rma">
          </div>

          <div style="display:flex; gap:10px; margin-top:16px;">
            <button class="btn-primary" onclick="window.TARSObserverUI.submitCloseCase('${escapeHtml(c.id)}')">
              🔒 Salvar & Fechar Caso
            </button>
            <button class="btn-ghost" onclick="window.TARSObserverUI.downloadCaseJSONL('${escapeHtml(c.id)}')">
              ⬇ Exportar Dataset JSONL
            </button>
          </div>
        </div>
      `;
    }

    modal.classList.add('open');
  }

  function closeModal() {
    const modal = document.getElementById('tars-obs-modal');
    if (modal) modal.classList.remove('open');
    currentCase = null;
  }

  // Actions
  async function validateObs(caseId, observationId) {
    try {
      const res = await fetch(`/api/tars/observer/cases?action=validate-observation&caseId=${encodeURIComponent(caseId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ observationId, validated: true, validatedBy: 'Técnico Especialista' })
      });
      if (!res.ok) throw new Error('Falha ao validar observação');
      const data = await res.json();
      currentCase = data.case;
      renderCaseModal();
      fetchCases();
      showToast('Observação validada pelo técnico.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function correctObsPrompt(caseId, observationId) {
    const newVal = prompt('Informe a interpretação técnica correta:');
    if (newVal === null) return;
    const reason = prompt('Informe o motivo técnico da correção (ex: reflexo na imagem, medição de campo):', 'Correção de campo por técnico');
    if (!newVal.trim()) return;

    try {
      const res = await fetch(`/api/tars/observer/cases?action=correction&caseId=${encodeURIComponent(caseId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ observationId, correctedValue: newVal.trim(), reason: reason || 'Ajuste técnico', correctedBy: 'Técnico Especialista' })
      });
      if (!res.ok) throw new Error('Falha ao registrar correção');
      const data = await res.json();
      currentCase = data.case;
      renderCaseModal();
      fetchCases();
      showToast('Correção técnica registrada com sucesso.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function saveHumanAnalysis(caseId) {
    const visualNotes = document.getElementById('ha-visual-notes')?.value || '';
    const technicianConclusion = document.getElementById('ha-tech-conclusion')?.value || '';

    try {
      const res = await fetch(`/api/tars/observer/cases?action=human-analysis&caseId=${encodeURIComponent(caseId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visualNotes, technicianConclusion, updatedBy: 'Técnico Especialista' })
      });
      if (!res.ok) throw new Error('Falha ao salvar análise humana');
      const data = await res.json();
      currentCase = data.case;
      renderCaseModal();
      fetchCases();
      showToast('Análise humana salva com sucesso!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function submitCloseCase(caseId) {
    const finalDiagnosis = document.getElementById('close-final-diag')?.value || '';
    const finalResolution = document.getElementById('close-final-res')?.value || '';
    const markAsCandidate = document.getElementById('close-mark-candidate')?.checked || false;
    const candidateReason = document.getElementById('close-candidate-reason')?.value || '';
    const tagsRaw = document.getElementById('close-tags')?.value || '';
    const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);

    try {
      const res = await fetch(`/api/tars/observer/cases?action=close&caseId=${encodeURIComponent(caseId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          finalDiagnosis,
          finalResolution,
          markAsCandidate,
          candidateReason,
          tags,
          technician: 'Técnico Especialista'
        })
      });
      if (!res.ok) throw new Error('Falha ao fechar caso');
      const data = await res.json();
      currentCase = data.case;
      renderCaseModal();
      fetchCases();
      showToast('Caso encerrado e arquivado com sucesso!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function downloadCaseJSONL(caseId) {
    const a = document.createElement('a');
    a.href = '/api/tars/learning/export';
    a.download = 'tars-validated-cases.jsonl';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('Download do dataset JSONL de aprendizado iniciado.', 'info');
  }

  // Simulation Modal
  function openSimulateModal() {
    const modal = document.getElementById('obs-sim-modal');
    if (modal) modal.classList.add('open');
  }

  function closeSimulateModal() {
    const modal = document.getElementById('obs-sim-modal');
    if (modal) modal.classList.remove('open');
  }

  async function runSimulation() {
    const text = document.getElementById('sim-text')?.value || 'Cliente informa alarme F30 com tensão de 224V e relé estalando.';
    const protocol = document.getElementById('sim-protocol')?.value || 'HF-2041';
    const convId = document.getElementById('sim-conv-id')?.value || 'conv_hf_98412';
    const mfr = document.getElementById('sim-mfr')?.value || 'Deye';
    const model = document.getElementById('sim-model')?.value || 'SUN-8K';
    const sn = document.getElementById('sim-sn')?.value || '230419824102';

    try {
      const res = await fetch('/api/tars/observer/events?action=simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'HYPERFLOW_MESSAGE',
          text,
          protocol,
          conversationId: convId,
          customerName: 'Carlos Eduardo (Simulado)',
          manufacturer: mfr,
          model,
          sn
        })
      });
      if (!res.ok) throw new Error('Erro na simulação');
      closeSimulateModal();
      await fetchCases();
      showToast('Evento simulado processado com sucesso pelo endpoint TARS Observer!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // Tab switching in modal
  function initModalTabs() {
    const tabs = document.querySelectorAll('.obs-modal-tab-btn');
    tabs.forEach(btn => {
      btn.addEventListener('click', () => {
        tabs.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.dataset.tab;
        document.querySelectorAll('.obs-modal-tab-content').forEach(c => {
          c.classList.toggle('hidden', c.id !== `obs-tab-${target}`);
        });
      });
    });
  }

  // Main UI Initialization
  function init() {
    if (isInitialized) return;
    isInitialized = true;
    // Search input
    const searchInput = document.getElementById('obs-search-input');
    if (searchInput) {
      let timer = null;
      searchInput.addEventListener('input', (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          searchQuery = e.target.value;
          fetchCases();
        }, 300);
      });
    }

    // Filter pills
    const filterPills = document.querySelectorAll('.obs-filter-pill');
    filterPills.forEach(pill => {
      pill.addEventListener('click', () => {
        filterPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        activeFilter = pill.dataset.filter || 'all';
        fetchCases();
      });
    });

    // Top action buttons
    document.getElementById('obs-refresh-btn')?.addEventListener('click', () => fetchCases());
    document.getElementById('obs-sim-btn')?.addEventListener('click', openSimulateModal);
    document.getElementById('obs-export-btn')?.addEventListener('click', () => window.open('/api/tars/learning/export', '_blank'));

    // Simulation modal actions
    document.getElementById('obs-sim-cancel-btn')?.addEventListener('click', closeSimulateModal);
    document.getElementById('obs-sim-submit-btn')?.addEventListener('click', runSimulation);

    // Case modal close
    document.getElementById('obs-modal-close-btn')?.addEventListener('click', closeModal);

    initModalTabs();

    // Auto-refresh when returning to tab
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        const obsView = document.getElementById('view-observer');
        if (obsView && !obsView.classList.contains('hidden')) {
          fetchCases();
        }
      }
    });
    window.addEventListener('focus', () => {
      const obsView = document.getElementById('view-observer');
      if (obsView && !obsView.classList.contains('hidden')) {
        fetchCases();
      }
    });
  }

  // Export public namespace
  window.TARSObserverUI = {
    render: function () {
      init();
      fetchCases();
      if (!pollInterval) {
        pollInterval = setInterval(fetchCases, 5000); // 5s refresh for observer
      }
    },
    refresh: fetchCases,
    openCase: openCaseDetails,
    validateObs,
    correctObsPrompt,
    saveHumanAnalysis,
    submitCloseCase,
    downloadCaseJSONL
  };

})(window);
