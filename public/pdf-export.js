// ============================================================================
// Solar Agenda — PDF Technical Report Generator & Exporter
// Generates professional, vector-sharp PDF reports for Cases & SLAs
// Supports both active/in-progress and completed/closed lifecycles
// Bilingual (EN / PT-BR) with instant download, preview modal & email bridge
// ============================================================================

(function(window){
  'use strict';

  const PDFExport = {
    // Check if jsPDF library is loaded
    isReady: function() {
      return !!(window.jspdf && window.jspdf.jsPDF);
    },

    // Helper to get active language strings
    t: function(key, fallback) {
      if (window.SolarI18n && typeof window.SolarI18n.t === 'function') {
        const val = window.SolarI18n.t(key);
        if (val && val !== key) return val;
      }
      return fallback || key;
    },

    getLang: function() {
      return (window.SolarI18n && window.SolarI18n.getLanguage) ? window.SolarI18n.getLanguage() : 'pt';
    },

    // ------------------------------------------------------------------------
    // 1. Export Standard Agenda Case (During or Finished)
    // ------------------------------------------------------------------------
    generateCasePdf: function(c, isPt = null) {
      if (!c) return null;
      if (isPt === null) isPt = this.getLang() === 'pt';
      const isFinished = (typeof window.statusRank === 'function') ? window.statusRank(c.status) === 1 : (c.status === 'done' || c.status === 'closed' || c.status === 1);
      
      if (!this.isReady()) {
        throw new Error('jsPDF library is not loaded');
      }

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

        const pageWidth = 210;
        const pageHeight = 297;
        const margin = 15;
        const contentWidth = pageWidth - (margin * 2);
        let y = margin;

        // Colors
        const primaryColor = [26, 32, 44]; // #1a202c
        const accentGold = [242, 167, 27]; // #f2a71b (Solar amber)
        const successGreen = [16, 185, 129]; // #10b981
        const urgentRed = [239, 68, 68]; // #ef4444
        const textMuted = [100, 116, 139]; // #64748b
        const lightBg = [248, 250, 252]; // #f8fafc
        const borderColor = [226, 232, 240]; // #e2e8f0

        // Header Background Banner
        doc.setFillColor(26, 32, 44);
        doc.rect(margin, y, contentWidth, 24, 'F');

        // Gold Accent Stripe on top
        doc.setFillColor(242, 167, 27);
        doc.rect(margin, y, contentWidth, 2, 'F');

        // Brand & Title
        doc.setTextColor(242, 167, 27);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.text('SOLAR AGENDA', margin + 6, y + 10);

        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.text(isPt ? 'LAUDO TÉCNICO DE ATENDIMENTO DE CAMPO' : 'FIELD SERVICE TECHNICAL REPORT', margin + 6, y + 16);

        // Date & Document ID (Right aligned in header)
        doc.setTextColor(203, 213, 225);
        doc.setFontSize(7.5);
        const docId = `DOC-${(c.ticket || c.id || 'CASE').replace(/[^a-zA-Z0-9-]/g, '')}-${new Date().toISOString().slice(0,10)}`;
        doc.text(docId, pageWidth - margin - 6, y + 9, { align: 'right' });
        doc.text(`${isPt ? 'Emitido em' : 'Generated on'}: ${new Date().toLocaleString(isPt ? 'pt-BR' : 'en-US')}`, pageWidth - margin - 6, y + 15, { align: 'right' });

        y += 28;

        // Lifecycle Status Banner
        const statusBoxHeight = 12;
        if (isFinished) {
          doc.setFillColor(236, 253, 245);
          doc.setDrawColor(16, 185, 129);
          doc.roundedRect(margin, y, contentWidth, statusBoxHeight, 2, 2, 'FD');
          doc.setTextColor(6, 95, 70);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9);
          const finishText = isPt 
            ? `✓ ATENDIMENTO CONCLUÍDO & RESOLVIDO ${c.actual_end ? `(Horário de Encerramento: ${c.actual_end})` : ''}` 
            : `✓ CASE COMPLETED & RESOLVED ${c.actual_end ? `(Actual End Time: ${c.actual_end})` : ''}`;
          doc.text(finishText, margin + 5, y + 7.5);
        } else {
          doc.setFillColor(254, 243, 199);
          doc.setDrawColor(245, 158, 11);
          doc.roundedRect(margin, y, contentWidth, statusBoxHeight, 2, 2, 'FD');
          doc.setTextColor(146, 64, 14);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9);
          const inProgressText = isPt
            ? `⚡ ATENDIMENTO EM ANDAMENTO (Status Ativo na Agenda)`
            : `⚡ CASE IN PROGRESS (Active Agenda Status)`;
          doc.text(inProgressText, margin + 5, y + 7.5);
        }

        y += statusBoxHeight + 6;

        // Case Title & Ticket Block
        doc.setFillColor(248, 250, 252);
        doc.setDrawColor(226, 232, 240);
        doc.roundedRect(margin, y, contentWidth, 20, 2, 2, 'FD');

        doc.setTextColor(100, 116, 139);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.text(isPt ? 'TÍTULO / FALHA REPORTADA' : 'CASE TITLE / REPORTED ISSUE', margin + 5, y + 5.5);

        doc.setTextColor(15, 23, 42);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10.5);
        const titleLines = doc.splitTextToSize(c.titulo || 'Caso Solar', contentWidth - 10);
        doc.text(titleLines[0] || '', margin + 5, y + 11.5);
        if (titleLines[1]) {
          doc.setFontSize(9);
          doc.text(titleLines[1], margin + 5, y + 16.5);
        }

        y += 24;

        // Case Metadata 4-Box Grid (2x2)
        const colWidth = (contentWidth - 6) / 2;
        const rowHeight = 16;

        // Box 1: Ticket / Protocol
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(226, 232, 240);
        doc.roundedRect(margin, y, colWidth, rowHeight, 1.5, 1.5, 'FD');
        doc.setFontSize(7);
        doc.setTextColor(100, 116, 139);
        doc.text(isPt ? 'PROTOCOLO / TICKET' : 'PROTOCOL / TICKET', margin + 4, y + 5);
        doc.setFontSize(9.5);
        doc.setTextColor(15, 23, 42);
        doc.setFont('helvetica', 'bold');
        doc.text(c.ticket || '—', margin + 4, y + 11.5);

        // Box 2: Priority
        doc.setFillColor(255, 255, 255);
        doc.roundedRect(margin + colWidth + 6, y, colWidth, rowHeight, 1.5, 1.5, 'FD');
        doc.setFontSize(7);
        doc.setTextColor(100, 116, 139);
        doc.setFont('helvetica', 'normal');
        doc.text(isPt ? 'PRIORIDADE' : 'PRIORITY', margin + colWidth + 10, y + 5);
        doc.setFontSize(9.5);
        doc.setFont('helvetica', 'bold');
        const prio = (c.prioridade || 'media').toLowerCase();
        if (prio === 'urgente') doc.setTextColor(220, 38, 38);
        else if (prio === 'alta') doc.setTextColor(234, 88, 12);
        else doc.setTextColor(30, 41, 59);
        doc.text((c.prioridade || 'Normal').toUpperCase(), margin + colWidth + 10, y + 11.5);

        y += rowHeight + 4;

        // Box 3: Date & Time Window
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(226, 232, 240);
        doc.roundedRect(margin, y, colWidth, rowHeight, 1.5, 1.5, 'FD');
        doc.setFontSize(7);
        doc.setTextColor(100, 116, 139);
        doc.setFont('helvetica', 'normal');
        doc.text(isPt ? 'DATA & JANELA DE HORÁRIO' : 'SCHEDULED DATE & TIME', margin + 4, y + 5);
        doc.setFontSize(8.5);
        doc.setTextColor(15, 23, 42);
        doc.setFont('helvetica', 'bold');
        const timeWindow = `${c.case_date || ''} (${c.horario || '—'} - ${c.horario_fim || '—'})`;
        doc.text(timeWindow, margin + 4, y + 11.5);

        // Box 4: Contact / Phone / WhatsApp
        doc.setFillColor(255, 255, 255);
        doc.roundedRect(margin + colWidth + 6, y, colWidth, rowHeight, 1.5, 1.5, 'FD');
        doc.setFontSize(7);
        doc.setTextColor(100, 116, 139);
        doc.setFont('helvetica', 'normal');
        doc.text(isPt ? 'CONTATO / INSTALADOR' : 'CONTACT / INSTALLER', margin + colWidth + 10, y + 5);
        doc.setFontSize(8.5);
        doc.setTextColor(15, 23, 42);
        doc.setFont('helvetica', 'bold');
        doc.text(c.phone || (isPt ? 'Não informado' : 'Not provided'), margin + colWidth + 10, y + 11.5);

        y += rowHeight + 5;

        // Tags
        if (c.tags && c.tags.length > 0) {
          doc.setFontSize(7.5);
          doc.setTextColor(100, 116, 139);
          doc.setFont('helvetica', 'normal');
          doc.text(isPt ? 'TAGS / CLASSIFICAÇÃO:' : 'TAGS / CATEGORIES:', margin, y + 3);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(30, 41, 59);
          doc.text(c.tags.join(' • '), margin + 35, y + 3);
          y += 7;
        }

        // Section Title: Diagnostic Notes & Log
        doc.setFillColor(241, 245, 249);
        doc.rect(margin, y, contentWidth, 7, 'F');
        doc.setFontSize(8);
        doc.setTextColor(30, 41, 59);
        doc.setFont('helvetica', 'bold');
        doc.text(isPt ? 'HISTÓRICO DE NOTAS TÉCNICAS & DIAGNÓSTICO DE CAMPO' : 'TECHNICAL DIAGNOSTIC NOTES & LOG', margin + 4, y + 5);

        y += 10;

        const notesLog = c.notes_log || [];
        if (notesLog.length === 0) {
          doc.setFontSize(8.5);
          doc.setFont('helvetica', 'italic');
          doc.setTextColor(148, 163, 184);
          doc.text(isPt ? 'Nenhuma anotação técnica registrada para este caso.' : 'No technical notes recorded for this case yet.', margin + 4, y + 4);
          y += 12;
        } else {
          for (let i = 0; i < notesLog.length; i++) {
            const entry = notesLog[i];
            const dateStr = entry.at ? new Date(entry.at).toLocaleString(isPt ? 'pt-BR' : 'en-US') : (isPt ? 'Data não informada' : 'No date');

            // Check page overflow
            if (y > pageHeight - 35) {
              doc.addPage();
              y = margin;
              // Sub header on next page
              doc.setFillColor(26, 32, 44);
              doc.rect(margin, y, contentWidth, 10, 'F');
              doc.setTextColor(242, 167, 27);
              doc.setFontSize(8);
              doc.text(`SOLAR AGENDA — ${c.ticket || c.titulo} (Cont.)`, margin + 4, y + 6.5);
              y += 15;
            }

            // Note bullet header
            doc.setFillColor(248, 250, 252);
            doc.setDrawColor(226, 232, 240);
            doc.roundedRect(margin, y, contentWidth, 6, 1, 1, 'FD');
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(7);
            doc.setTextColor(71, 85, 105);
            doc.text(`[${dateStr}] • ${isPt ? 'Registro Técnico #' : 'Note Entry #'}${notesLog.length - i}`, margin + 3, y + 4.2);

            y += 8;

            // Note body
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.setTextColor(30, 41, 59);
            const wrappedText = doc.splitTextToSize(entry.text || '', contentWidth - 8);
            for (let line of wrappedText) {
              if (y > pageHeight - 25) {
                doc.addPage();
                y = margin + 10;
              }
              doc.text(line, margin + 4, y);
              y += 4.5;
            }
            y += 4;
          }
        }

        // Signature & Audit Box
        if (y > pageHeight - 45) {
          doc.addPage();
          y = margin;
        }

        y += 6;
        doc.setDrawColor(203, 213, 225);
        doc.setLineDash([1, 1], 0);
        doc.line(margin, y, pageWidth - margin, y);
        doc.setLineDash([], 0);

        y += 10;
        const sigWidth = (contentWidth - 20) / 2;

        // Tech signature line
        doc.line(margin + 5, y + 12, margin + 5 + sigWidth, y + 12);
        doc.setFontSize(7);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(100, 116, 139);
        doc.text(isPt ? 'Assinatura do Técnico / Responsável Solar' : 'Solar Technical Support Signature', margin + 5, y + 16);

        // Client signature line
        doc.line(margin + 15 + sigWidth, y + 12, pageWidth - margin - 5, y + 12);
        doc.text(isPt ? 'Ciente do Cliente / Instalador' : 'Customer / Installer Acknowledgment', margin + 15 + sigWidth, y + 16);

        // Footer
        const totalPages = doc.internal.getNumberOfPages();
        for (let p = 1; p <= totalPages; p++) {
          doc.setPage(p);
          doc.setFontSize(6.5);
          doc.setTextColor(148, 163, 184);
          doc.text(
            `${isPt ? 'Documento gerado automaticamente pela plataforma Solar Agenda & TARS Vision Bridge' : 'Document generated by Solar Agenda & TARS Vision Bridge'} | ${isPt ? 'Página' : 'Page'} ${p} ${isPt ? 'de' : 'of'} ${totalPages}`,
            pageWidth / 2,
            pageHeight - 8,
            { align: 'center' }
          );
        }

        // Output PDF
        const safeName = (c.ticket || c.titulo || 'caso-solar').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
        const fileName = `Solar-Case-${safeName}-${new Date().toISOString().slice(0,10)}.pdf`;
        const dataUri = doc.output('datauristring');
        const base64 = dataUri.split(',')[1];
        const size = Math.round((base64.length * 3) / 4 / 1024) + ' KB';
        return { doc, fileName, base64, size, dataUri };
    },

    exportCase: function(c, options = {}) {
      if (!c) return null;
      const isPt = this.getLang() === 'pt';
      if (!this.isReady()) {
        console.warn('[PDFExport] jsPDF not loaded, falling back to print preview');
        this.openPreviewModal('case', c);
        return null;
      }

      try {
        const result = this.generateCasePdf(c, isPt);
        if (!result) return null;

        if (options.download !== false) {
          result.doc.save(result.fileName);
          if (typeof window.showToast === 'function') {
            window.showToast(`✓ ${isPt ? 'PDF salvo com sucesso' : 'PDF saved successfully'}: ${result.fileName}`);
          }
        }

        if (options.preview !== false) {
          this.openPreviewModal('case', c, result.fileName);
        }
        return result;
      } catch (err) {
        console.error('[PDFExport] Error generating Case PDF:', err);
        alert(isPt ? `Erro ao gerar PDF: ${err.message}` : `Error generating PDF: ${err.message}`);
        return null;
      }
    },

    // ------------------------------------------------------------------------
    // 2. Export SLA Hub Case (During or Finished)
    // ------------------------------------------------------------------------
    generateSLAPdf: function(sla, isPt = null) {
      if (!sla) return null;
      if (isPt === null) isPt = this.getLang() === 'pt';
      const isFinished = (sla.status === 'CLOSED' || sla.status === 'RESOLVED');

      if (!this.isReady()) {
        throw new Error('jsPDF library is not loaded');
      }

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

        const pageWidth = 210;
        const pageHeight = 297;
        const margin = 14;
        const contentWidth = pageWidth - (margin * 2);
        let y = margin;

        // Header Background Banner
        doc.setFillColor(15, 23, 42); // slate-900
        doc.rect(margin, y, contentWidth, 26, 'F');

        // Gold Accent Stripe on top
        doc.setFillColor(242, 167, 27);
        doc.rect(margin, y, contentWidth, 2.5, 'F');

        // Brand & Title
        doc.setTextColor(242, 167, 27);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.text('SOLAR AGENDA — SLA HUB', margin + 6, y + 11);

        doc.setTextColor(226, 232, 240);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.text(isPt ? 'LAUDO TÉCNICO DE TELEMETRIA, GARANTIA & SLA' : 'ENTERPRISE SLA, WARRANTY & TELEMETRY REPORT', margin + 6, y + 17);

        // Right side: SLA ID & Timestamps
        doc.setTextColor(242, 167, 27);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.text(sla.id || 'SLA-1000', pageWidth - margin - 6, y + 11, { align: 'right' });

        doc.setTextColor(148, 163, 184);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.text(`${isPt ? 'Emitido em' : 'Generated'}: ${new Date().toLocaleString(isPt ? 'pt-BR' : 'en-US')}`, pageWidth - margin - 6, y + 17, { align: 'right' });
        doc.text(`TARS Bridge v1.2.37`, pageWidth - margin - 6, y + 22, { align: 'right' });

        y += 30;

        // Compute SLA health
        const now = new Date();
        const deadline = new Date(sla.sla_deadline || now);
        const msLeft = deadline - now;
        const isOverdue = msLeft <= 0 && !isFinished;

        // SLA Status Bar
        const statHeight = 14;
        if (isFinished) {
          doc.setFillColor(236, 253, 245);
          doc.setDrawColor(16, 185, 129);
          doc.roundedRect(margin, y, contentWidth, statHeight, 2, 2, 'FD');
          doc.setTextColor(6, 95, 70);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9.5);
          doc.text(isPt ? '✓ PROTOCOLO CONCLUÍDO & RESOLVIDO' : '✓ SLA PROTOCOL RESOLVED & CLOSED', margin + 5, y + 6);
          doc.setFontSize(7.5);
          doc.setFont('helvetica', 'normal');
          doc.text(`${isPt ? 'Encerrado em' : 'Closed at'}: ${new Date(sla.updated_at || sla.created_at).toLocaleString(isPt ? 'pt-BR' : 'en-US')} | ${isPt ? 'Prazo Contratual' : 'Contract SLA'}: ${sla.sla_limit_hours || 24}h`, margin + 5, y + 11);
        } else if (isOverdue) {
          doc.setFillColor(254, 242, 242);
          doc.setDrawColor(239, 68, 68);
          doc.roundedRect(margin, y, contentWidth, statHeight, 2, 2, 'FD');
          doc.setTextColor(153, 27, 27);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9.5);
          doc.text(isPt ? '⚠️ CASO EM ANDAMENTO — ESTOURO CONTRATUAL DE SLA' : '⚠️ CASE IN PROGRESS — CONTRACTUAL SLA OVERDUE', margin + 5, y + 6);
          doc.setFontSize(7.5);
          doc.setFont('helvetica', 'normal');
          doc.text(`${isPt ? 'Prazo Limite expirou em' : 'Deadline expired on'}: ${deadline.toLocaleString(isPt ? 'pt-BR' : 'en-US')} (${sla.sla_limit_hours || 24}h)`, margin + 5, y + 11);
        } else {
          doc.setFillColor(254, 243, 199);
          doc.setDrawColor(245, 158, 11);
          doc.roundedRect(margin, y, contentWidth, statHeight, 2, 2, 'FD');
          doc.setTextColor(146, 64, 14);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9.5);
          doc.text(isPt ? '⚡ CASO EM ANDAMENTO — SLA DENTRO DO PRAZO' : '⚡ CASE IN PROGRESS — ON-TIME SLA', margin + 5, y + 6);
          doc.setFontSize(7.5);
          doc.setFont('helvetica', 'normal');
          doc.text(`${isPt ? 'Prazo Limite' : 'SLA Deadline'}: ${deadline.toLocaleString(isPt ? 'pt-BR' : 'en-US')} (${sla.sla_limit_hours || 24}h)`, margin + 5, y + 11);
        }

        y += statHeight + 6;

        // Section 1: Customer & Equipment (Two Column Cards)
        const colW = (contentWidth - 6) / 2;
        const boxH = 34;

        // Left: Customer Information
        doc.setFillColor(248, 250, 252);
        doc.setDrawColor(226, 232, 240);
        doc.roundedRect(margin, y, colW, boxH, 2, 2, 'FD');
        doc.setFontSize(8);
        doc.setTextColor(100, 116, 139);
        doc.setFont('helvetica', 'bold');
        doc.text(isPt ? 'DADOS DO CLIENTE & LOCAL' : 'CUSTOMER & PLANT SITE', margin + 4, y + 5.5);

        doc.setFontSize(8);
        doc.setTextColor(30, 41, 59);
        doc.setFont('helvetica', 'bold');
        doc.text(`${isPt ? 'Nome' : 'Name'}: ${sla.customer?.name || 'Cliente'}`, margin + 4, y + 12);
        doc.setFont('helvetica', 'normal');
        doc.text(`${isPt ? 'Contato' : 'Phone'}: ${sla.customer?.phone || '—'}`, margin + 4, y + 17.5);
        doc.text(`${isPt ? 'E-mail' : 'Email'}: ${sla.customer?.email || '—'}`, margin + 4, y + 23);
        doc.text(`${isPt ? 'Local/Usina' : 'Site'}: ${sla.customer?.site_location || '—'}`, margin + 4, y + 28.5);

        // Right: Equipment & Serial Numbers
        doc.setFillColor(248, 250, 252);
        doc.roundedRect(margin + colW + 6, y, colW, boxH, 2, 2, 'FD');
        doc.setFontSize(8);
        doc.setTextColor(100, 116, 139);
        doc.setFont('helvetica', 'bold');
        doc.text(isPt ? 'EQUIPAMENTO & NÚMEROS DE SÉRIE' : 'EQUIPMENT & SERIAL NUMBERS', margin + colW + 10, y + 5.5);

        doc.setFontSize(8);
        doc.setTextColor(30, 41, 59);
        doc.setFont('helvetica', 'bold');
        doc.text(`${isPt ? 'Fabricante' : 'Manufacturer'}: ${sla.equipment?.manufacturer || '—'}`, margin + colW + 10, y + 12);
        doc.setFont('helvetica', 'normal');
        doc.text(`${isPt ? 'Modelo' : 'Model'}: ${sla.equipment?.model || '—'}`, margin + colW + 10, y + 17.5);
        const snList = (sla.equipment?.serial_numbers || []).join(', ') || '—';
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(242, 167, 27);
        doc.text(`SN: ${snList}`, margin + colW + 10, y + 23);
        doc.setTextColor(30, 41, 59);
        doc.setFont('helvetica', 'normal');
        doc.text(`${isPt ? 'Falha' : 'Category'}: ${sla.equipment?.category || '—'} | FW: ${sla.equipment?.firmware || '—'}`, margin + colW + 10, y + 28.5);

        y += boxH + 6;

        // Section 2: Problem Description & Next Operational Action
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(226, 232, 240);
        doc.roundedRect(margin, y, contentWidth, 26, 2, 2, 'FD');

        doc.setFontSize(7.5);
        doc.setTextColor(100, 116, 139);
        doc.setFont('helvetica', 'bold');
        doc.text(isPt ? 'RESUMO DO PROBLEMA REPORTADO' : 'PROBLEM SUMMARY', margin + 4, y + 5);

        doc.setFontSize(8);
        doc.setTextColor(15, 23, 42);
        doc.setFont('helvetica', 'normal');
        const probLines = doc.splitTextToSize(sla.problem_summary || (isPt ? 'Nenhum resumo informado.' : 'No problem summary logged.'), contentWidth - 8);
        doc.text(probLines.slice(0, 2), margin + 4, y + 10);

        // Next action
        doc.setFontSize(7.5);
        doc.setTextColor(217, 119, 6);
        doc.setFont('helvetica', 'bold');
        doc.text(isPt ? 'PRÓXIMA AÇÃO OPERACIONAL:' : 'NEXT OPERATIONAL ACTION:', margin + 4, y + 19);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(30, 41, 59);
        const nextLines = doc.splitTextToSize(sla.next_action || (isPt ? 'Aguardando evolução do chamado.' : 'Awaiting ticket progression.'), contentWidth - 45);
        doc.text(nextLines[0] || '—', margin + 46, y + 19);

        y += 30;

        // Section 3: Protocols & External References (Jira / Hyperflow / Hoymiles)
        doc.setFillColor(241, 245, 249);
        doc.rect(margin, y, contentWidth, 6.5, 'F');
        doc.setFontSize(8);
        doc.setTextColor(30, 41, 59);
        doc.setFont('helvetica', 'bold');
        doc.text(isPt ? 'PROTOCOLOS EXTERNOS & RASTREABILIDADE' : 'EXTERNAL PROTOCOLS & TRACEABILITY', margin + 4, y + 4.5);

        y += 10;

        const jiraList = (sla.protocols?.jira || []).map(j => `${j.board}-${j.issue_key} (${j.status || 'Active'})`).join(', ') || 'Nenhum';
        const hfId = sla.protocols?.hyperflow_id || 'Nenhum';
        const hoymilesAccs = (sla.protocols?.hoymiles || []).map(h => `${h.account_email || h.company || 'Conta Hoymiles'}`).join(', ') || null;

        doc.setFontSize(8);
        doc.setTextColor(71, 85, 105);
        doc.setFont('helvetica', 'normal');
        doc.text(`• Jira Cloud: `, margin + 4, y);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(2, 132, 199);
        doc.text(jiraList, margin + 24, y);

        y += 5;
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(71, 85, 105);
        doc.text(`• Hyperflow: `, margin + 4, y);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(16, 185, 129);
        doc.text(String(hfId), margin + 24, y);

        if (hoymilesAccs) {
          y += 5;
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(71, 85, 105);
          doc.text(`• Hoymiles Bridge: `, margin + 4, y);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(217, 119, 6);
          doc.text(hoymilesAccs, margin + 30, y);
        }

        y += 8;

        // Section 4: Timeline of Operational Events
        doc.setFillColor(241, 245, 249);
        doc.rect(margin, y, contentWidth, 6.5, 'F');
        doc.setFontSize(8);
        doc.setTextColor(30, 41, 59);
        doc.setFont('helvetica', 'bold');
        doc.text(isPt ? 'LINHA DO TEMPO CRONOLÓGICA DE AÇÕES & EVENTOS' : 'CHRONOLOGICAL ACTIVITY STREAM & MILESTONES', margin + 4, y + 4.5);

        y += 10;

        const timeline = sla.timeline || [];
        if (timeline.length === 0) {
          doc.setFontSize(8);
          doc.setFont('helvetica', 'italic');
          doc.setTextColor(148, 163, 184);
          doc.text(isPt ? 'Nenhum evento registrado no histórico deste SLA.' : 'No chronological events recorded.', margin + 4, y + 4);
          y += 10;
        } else {
          for (let ev of timeline) {
            if (y > pageHeight - 32) {
              doc.addPage();
              y = margin;
              doc.setFillColor(15, 23, 42);
              doc.rect(margin, y, contentWidth, 10, 'F');
              doc.setTextColor(242, 167, 27);
              doc.setFontSize(8);
              doc.text(`SOLAR AGENDA — ${sla.id} (Continuação / Cont.)`, margin + 4, y + 6.5);
              y += 15;
            }

            const timeStr = ev.timestamp ? new Date(ev.timestamp).toLocaleString(isPt ? 'pt-BR' : 'en-US') : '—';
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(7.5);
            doc.setTextColor(15, 23, 42);
            doc.text(`• [${timeStr}] ${ev.title || 'Evento'}`, margin + 4, y);

            if (ev.author) {
              doc.setFont('helvetica', 'italic');
              doc.setFontSize(7);
              doc.setTextColor(100, 116, 139);
              doc.text(`— por ${ev.author}`, margin + 110, y);
            }

            y += 4.5;
            if (ev.detail) {
              doc.setFont('helvetica', 'normal');
              doc.setFontSize(7.5);
              doc.setTextColor(71, 85, 105);
              const detLines = doc.splitTextToSize(ev.detail, contentWidth - 10);
              doc.text(detLines, margin + 7, y);
              y += (detLines.length * 4) + 2;
            }
          }
        }

        // Section 5: TARS Autonomous Diagnosis (if present)
        if (sla.tars_analysis && sla.tars_analysis.inferences) {
          if (y > pageHeight - 40) {
            doc.addPage();
            y = margin + 10;
          }

          y += 4;
          doc.setFillColor(254, 243, 199);
          doc.rect(margin, y, contentWidth, 6.5, 'F');
          doc.setFontSize(8);
          doc.setTextColor(180, 83, 9);
          doc.setFont('helvetica', 'bold');
          doc.text(`🧠 TARS AUTONOMOUS SLA DIAGNOSIS & REASONING`, margin + 4, y + 4.5);

          y += 10;
          const facts = sla.tars_analysis.facts || [];
          const inferences = sla.tars_analysis.inferences || [];
          const recs = sla.tars_analysis.recommendations || [];

          doc.setFontSize(7.5);
          doc.setTextColor(30, 41, 59);
          doc.setFont('helvetica', 'bold');
          doc.text(isPt ? 'Recomendações Operacionais da IA:' : 'AI Operational Recommendations:', margin + 4, y);
          y += 4.5;
          doc.setFont('helvetica', 'normal');
          for (let r of recs) {
            doc.text(`→ ${r}`, margin + 6, y);
            y += 4.5;
          }
        }

        // Final Signature & Audit Footer
        if (y > pageHeight - 45) {
          doc.addPage();
          y = margin;
        }

        y += 8;
        doc.setDrawColor(203, 213, 225);
        doc.setLineDash([1, 1], 0);
        doc.line(margin, y, pageWidth - margin, y);
        doc.setLineDash([], 0);

        y += 10;
        const sigW = (contentWidth - 20) / 2;

        doc.line(margin + 5, y + 12, margin + 5 + sigW, y + 12);
        doc.setFontSize(7);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(100, 116, 139);
        doc.text(isPt ? 'Engenharia de Suporte & Diagnóstico Solar' : 'Solar Technical Diagnostic Support', margin + 5, y + 16);

        doc.line(margin + 15 + sigW, y + 12, pageWidth - margin - 5, y + 12);
        doc.text(isPt ? 'Validação / Aprovação de Garantia' : 'Warranty Validation & Acknowledgment', margin + 15 + sigW, y + 16);

        // Page numbering
        const totalPages = doc.internal.getNumberOfPages();
        for (let p = 1; p <= totalPages; p++) {
          doc.setPage(p);
          doc.setFontSize(6.5);
          doc.setTextColor(148, 163, 184);
          doc.text(
            `${isPt ? 'Laudo técnico oficial de SLA emitido por Solar Agenda' : 'Official SLA technical report by Solar Agenda'} | ${isPt ? 'Página' : 'Page'} ${p} ${isPt ? 'de' : 'of'} ${totalPages}`,
            pageWidth / 2,
            pageHeight - 8,
            { align: 'center' }
          );
        }

        // Output PDF
        const safeName = (sla.id || 'sla').replace(/[^a-zA-Z0-9_-]/g, '_');
        const mfr = (sla.equipment?.manufacturer || 'solar').replace(/[^a-zA-Z0-9_-]/g, '_');
        const fileName = `SLA-Report-${safeName}-${mfr}-${new Date().toISOString().slice(0,10)}.pdf`;
        const dataUri = doc.output('datauristring');
        const base64 = dataUri.split(',')[1];
        const size = Math.round((base64.length * 3) / 4 / 1024) + ' KB';
        return { doc, fileName, base64, size, dataUri };
    },

    exportSLACase: function(sla, options = {}) {
      if (!sla) return null;
      const isPt = this.getLang() === 'pt';
      if (!this.isReady()) {
        console.warn('[PDFExport] jsPDF not loaded, falling back to print preview');
        this.openPreviewModal('sla', sla);
        return null;
      }

      try {
        const result = this.generateSLAPdf(sla, isPt);
        if (!result) return null;

        if (options.download !== false) {
          result.doc.save(result.fileName);
          if (typeof window.showToast === 'function') {
            window.showToast(`✓ ${isPt ? 'Laudo SLA PDF salvo com sucesso' : 'SLA PDF report saved successfully'}: ${result.fileName}`);
          }
        }

        if (options.preview !== false) {
          this.openPreviewModal('sla', sla, result.fileName);
        }
        return result;
      } catch (err) {
        console.error('[PDFExport] Error generating SLA PDF:', err);
        alert(isPt ? `Erro ao gerar PDF do SLA: ${err.message}` : `Error generating SLA PDF: ${err.message}`);
        return null;
      }
    },

    // ------------------------------------------------------------------------
    // 3. Technical Report Preview Modal (Print, Download, Email)
    // ------------------------------------------------------------------------
    openPreviewModal: function(type, data, lastFileName = '') {
      let modal = document.getElementById('pdf-preview-backdrop');
      if (!modal) {
        this.createPreviewModalDOM();
        modal = document.getElementById('pdf-preview-backdrop');
      }

      const isPt = this.getLang() === 'pt';
      const container = document.getElementById('pdf-preview-content');
      if (!container) return;

      // Store current data on modal for action buttons
      modal.dataset.reportType = type;
      modal.dataset.reportId = data.id || data.ticket || '';
      this._activeReportData = { type, data, fileName: lastFileName };

      // Render formatted HTML report inside preview
      container.innerHTML = type === 'sla' 
        ? this.generateSLAHtml(data, isPt)
        : this.generateCaseHtml(data, isPt);

      // Show modal
      modal.classList.add('open');
      if (window.SFX && typeof window.SFX.open === 'function') {
        window.SFX.open();
      }
    },

    closePreviewModal: function() {
      const modal = document.getElementById('pdf-preview-backdrop');
      if (modal) modal.classList.remove('open');
    },

    createPreviewModalDOM: function() {
      const isPt = this.getLang() === 'pt';
      const div = document.createElement('div');
      div.id = 'pdf-preview-backdrop';
      div.className = 'modal-backdrop';
      div.style.zIndex = '210';

      div.innerHTML = `
        <div class="modal pdf-report-modal" style="max-width:860px; max-height:92vh; display:flex; flex-direction:column; padding:0; overflow:hidden; background:var(--bg); border:1px solid var(--line); border-radius:12px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.4);">
          <!-- Modal Toolbar -->
          <div style="display:flex; justify-content:space-between; align-items:center; padding:14px 20px; background:var(--card-bg, #1a202c); border-bottom:1px solid var(--line);">
            <div style="display:flex; align-items:center; gap:10px;">
              <span style="font-size:1.3rem;">📄</span>
              <div>
                <h3 id="pdf-modal-title" style="margin:0; font-size:1.05rem; font-weight:700; color:var(--text);">
                  ${isPt ? 'Laudo Técnico em PDF' : 'Technical Report PDF'}
                </h3>
                <span style="font-size:0.75rem; color:var(--muted);">
                  ${isPt ? 'Visualização de Impressão e Exportação Vetorial' : 'Print & Vector Export Preview'}
                </span>
              </div>
            </div>
            
            <div style="display:flex; align-items:center; gap:8px;">
              <button type="button" class="btn-primary" id="pdf-modal-download-btn" style="display:inline-flex; align-items:center; gap:6px; font-size:0.82rem; padding:6px 14px;">
                📥 <span>${isPt ? 'Baixar PDF' : 'Download PDF'}</span>
              </button>
              <button type="button" class="btn-ghost" id="pdf-modal-print-btn" style="display:inline-flex; align-items:center; gap:6px; font-size:0.82rem; padding:6px 12px;">
                🖨️ <span>${isPt ? 'Imprimir' : 'Print'}</span>
              </button>
              <button type="button" class="btn-ghost" id="pdf-modal-email-btn" style="display:inline-flex; align-items:center; gap:6px; font-size:0.82rem; padding:6px 12px;">
                ✉️ <span>${isPt ? 'Enviar por E-mail' : 'Email Report'}</span>
              </button>
              <button type="button" class="btn-ghost" id="pdf-modal-close-btn" style="font-size:1.3rem; padding:4px 10px; cursor:pointer;">×</button>
            </div>
          </div>

          <!-- Printable Area Container -->
          <div style="flex:1; overflow-y:auto; padding:24px; background:#525659; display:flex; justify-content:center;">
            <div id="pdf-preview-content" class="printable-paper" style="width:100%; max-width:760px; background:#ffffff; color:#0f172a; padding:36px; border-radius:4px; box-shadow:0 4px 20px rgba(0,0,0,0.3); font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
              <!-- HTML Report gets injected here -->
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(div);

      // Attach Event Listeners
      document.getElementById('pdf-modal-close-btn')?.addEventListener('click', () => this.closePreviewModal());
      div.addEventListener('click', (e) => {
        if (e.target === div) this.closePreviewModal();
      });

      document.getElementById('pdf-modal-download-btn')?.addEventListener('click', () => {
        if (!this._activeReportData) return;
        const { type, data } = this._activeReportData;
        if (type === 'sla') this.exportSLACase(data);
        else this.exportCase(data);
      });

      document.getElementById('pdf-modal-print-btn')?.addEventListener('click', () => {
        window.print();
      });

      document.getElementById('pdf-modal-email-btn')?.addEventListener('click', () => {
        if (!this._activeReportData) return;
        const { type, data } = this._activeReportData;
        this.closePreviewModal();
        this.emailReport(type, data);
      });
    },

    // ------------------------------------------------------------------------
    // 4. HTML Templates for Preview & Clean Browser Printing
    // ------------------------------------------------------------------------
    generateCaseHtml: function(c, isPt) {
      const isFinished = (typeof window.statusRank === 'function') ? window.statusRank(c.status) === 1 : (c.status === 'done' || c.status === 'closed' || c.status === 1);
      const notesLog = c.notes_log || [];

      return `
        <div class="pdf-doc-wrap" style="color:#0f172a;">
          <!-- Header -->
          <div style="background:#1e293b; color:#fff; padding:18px 24px; border-radius:6px; border-top:4px solid #f2a71b; display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
            <div>
              <div style="font-size:1.15rem; font-weight:800; color:#f2a71b; letter-spacing:0.5px;">SOLAR AGENDA</div>
              <div style="font-size:0.8rem; color:#cbd5e1;">${isPt ? 'LAUDO TÉCNICO DE ATENDIMENTO DE CAMPO' : 'FIELD SERVICE TECHNICAL REPORT'}</div>
            </div>
            <div style="text-align:right; font-size:0.75rem; color:#94a3b8;">
              <div style="font-family:monospace; color:#f8fafc; font-weight:700;">${c.ticket || c.id || 'CASE'}</div>
              <div>${isPt ? 'Emitido em' : 'Generated'}: ${new Date().toLocaleString(isPt ? 'pt-BR' : 'en-US')}</div>
            </div>
          </div>

          <!-- Status Banner -->
          <div style="padding:10px 16px; border-radius:6px; margin-bottom:20px; font-weight:600; font-size:0.88rem; background:${isFinished ? '#ecfdf5' : '#fef3c7'}; color:${isFinished ? '#065f46' : '#92400e'}; border:1px solid ${isFinished ? '#10b981' : '#f59e0b'};">
            ${isFinished 
              ? `✓ ${isPt ? 'ATENDIMENTO CONCLUÍDO & RESOLVIDO' : 'CASE COMPLETED & RESOLVED'} ${c.actual_end ? `(${isPt ? 'Encerramento' : 'Actual End'}: ${c.actual_end})` : ''}` 
              : `⚡ ${isPt ? 'ATENDIMENTO EM ANDAMENTO (Status Ativo)' : 'CASE IN PROGRESS (Active Status)'}`}
          </div>

          <!-- Title -->
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:14px; margin-bottom:20px;">
            <div style="font-size:0.72rem; font-weight:700; color:#64748b; text-transform:uppercase;">${isPt ? 'Título / Falha Reportada' : 'Case Title / Reported Issue'}</div>
            <div style="font-size:1.1rem; font-weight:700; color:#0f172a; margin-top:4px;">${escapeHtml(c.titulo || 'Caso Solar')}</div>
          </div>

          <!-- Meta Grid -->
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:24px;">
            <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:10px;">
              <div style="font-size:0.7rem; color:#64748b; font-weight:600;">${isPt ? 'PROTOCOLO' : 'PROTOCOL / TICKET'}</div>
              <div style="font-size:0.95rem; font-weight:700; color:#0f172a;">${escapeHtml(c.ticket || '—')}</div>
            </div>
            <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:10px;">
              <div style="font-size:0.7rem; color:#64748b; font-weight:600;">${isPt ? 'PRIORIDADE' : 'PRIORITY'}</div>
              <div style="font-size:0.95rem; font-weight:700; color:${c.prioridade === 'urgente' ? '#ef4444' : '#0f172a'};">${(c.prioridade || 'Normal').toUpperCase()}</div>
            </div>
            <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:10px;">
              <div style="font-size:0.7rem; color:#64748b; font-weight:600;">${isPt ? 'DATA & HORÁRIO' : 'SCHEDULED DATE & TIME'}</div>
              <div style="font-size:0.88rem; font-weight:700; color:#0f172a;">${c.case_date || ''} (${c.horario || '—'} - ${c.horario_fim || '—'})</div>
            </div>
            <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:10px;">
              <div style="font-size:0.7rem; color:#64748b; font-weight:600;">${isPt ? 'CONTATO / INSTALADOR' : 'CONTACT / INSTALLER'}</div>
              <div style="font-size:0.88rem; font-weight:700; color:#0f172a;">${escapeHtml(c.phone || (isPt ? 'Não informado' : 'Not provided'))}</div>
            </div>
          </div>

          <!-- Tags -->
          ${c.tags && c.tags.length ? `
            <div style="margin-bottom:20px; font-size:0.8rem;">
              <span style="color:#64748b; font-weight:600;">Tags:</span>
              ${c.tags.map(t => `<span style="display:inline-block; background:#f1f5f9; color:#475569; padding:2px 8px; border-radius:4px; margin-left:6px; font-weight:500;">#${escapeHtml(t)}</span>`).join('')}
            </div>
          ` : ''}

          <!-- Diagnostic Notes Log -->
          <div style="margin-bottom:24px;">
            <div style="background:#f1f5f9; padding:8px 12px; border-radius:4px; font-weight:700; font-size:0.85rem; color:#1e293b; margin-bottom:12px;">
              ${isPt ? 'HISTÓRICO DE NOTAS TÉCNICAS & DIAGNÓSTICO' : 'TECHNICAL DIAGNOSTIC NOTES & FIELD LOG'}
            </div>
            ${notesLog.length === 0 
              ? `<div style="color:#94a3b8; font-style:italic; font-size:0.85rem; padding:8px;">${isPt ? 'Nenhuma anotação registrada para este caso.' : 'No notes recorded.'}</div>`
              : notesLog.map((n, i) => `
                <div style="border-left:3px solid #f2a71b; padding:8px 12px; background:#fafafa; margin-bottom:8px; border-radius:0 4px 4px 0;">
                  <div style="font-size:0.72rem; color:#64748b; font-weight:600; font-family:monospace;">
                    [${n.at ? new Date(n.at).toLocaleString(isPt ? 'pt-BR' : 'en-US') : '—'}] • #${notesLog.length - i}
                  </div>
                  <div style="font-size:0.85rem; color:#1e293b; margin-top:4px; white-space:pre-wrap; line-height:1.5;">${escapeHtml(n.text || '')}</div>
                </div>
              `).join('')}
          </div>

          <!-- Signatures -->
          <div style="margin-top:36px; padding-top:20px; border-top:1px dashed #cbd5e1; display:grid; grid-template-columns:1fr 1fr; gap:30px;">
            <div style="text-align:center;">
              <div style="border-top:1px solid #94a3b8; margin:0 20px 8px;"></div>
              <div style="font-size:0.75rem; color:#64748b;">${isPt ? 'Responsável Técnico / Suporte Solar' : 'Technical Support Engineer'}</div>
            </div>
            <div style="text-align:center;">
              <div style="border-top:1px solid #94a3b8; margin:0 20px 8px;"></div>
              <div style="font-size:0.75rem; color:#64748b;">${isPt ? 'Ciente do Cliente / Instalador' : 'Customer / Installer Acknowledgment'}</div>
            </div>
          </div>
        </div>
      `;
    },

    generateSLAHtml: function(sla, isPt) {
      const isFinished = (sla.status === 'CLOSED' || sla.status === 'RESOLVED');
      const now = new Date();
      const deadline = new Date(sla.sla_deadline || now);
      const isOverdue = deadline - now <= 0 && !isFinished;
      const timeline = sla.timeline || [];

      return `
        <div class="pdf-doc-wrap" style="color:#0f172a;">
          <!-- Header -->
          <div style="background:#0f172a; color:#fff; padding:18px 24px; border-radius:6px; border-top:4px solid #f2a71b; display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
            <div>
              <div style="font-size:1.15rem; font-weight:800; color:#f2a71b; letter-spacing:0.5px;">SOLAR AGENDA — SLA HUB</div>
              <div style="font-size:0.8rem; color:#cbd5e1;">${isPt ? 'LAUDO TÉCNICO DE TELEMETRIA, GARANTIA & SLA' : 'ENTERPRISE SLA, WARRANTY & TELEMETRY REPORT'}</div>
            </div>
            <div style="text-align:right; font-size:0.75rem; color:#94a3b8;">
              <div style="font-family:monospace; color:#f2a71b; font-weight:700; font-size:1.1rem;">${sla.id}</div>
              <div>${isPt ? 'Emitido em' : 'Generated'}: ${new Date().toLocaleString(isPt ? 'pt-BR' : 'en-US')}</div>
            </div>
          </div>

          <!-- Status Banner -->
          <div style="padding:10px 16px; border-radius:6px; margin-bottom:20px; font-weight:600; font-size:0.88rem; background:${isFinished ? '#ecfdf5' : (isOverdue ? '#fef2f2' : '#fef3c7')}; color:${isFinished ? '#065f46' : (isOverdue ? '#991b1b' : '#92400e')}; border:1px solid ${isFinished ? '#10b981' : (isOverdue ? '#ef4444' : '#f59e0b')};">
            ${isFinished 
              ? `✓ ${isPt ? 'PROTOCOLO CONCLUÍDO & RESOLVIDO' : 'SLA PROTOCOL RESOLVED & CLOSED'} (${isPt ? 'Prazo Contratual' : 'Limit'}: ${sla.sla_limit_hours || 24}h)`
              : (isOverdue 
                  ? `⚠️ ${isPt ? 'ESTOURO CONTRATUAL DE SLA' : 'CONTRACTUAL SLA OVERDUE'} (${isPt ? 'Expirou em' : 'Expired on'}: ${deadline.toLocaleString(isPt ? 'pt-BR' : 'en-US')})`
                  : `⚡ ${isPt ? 'CASO EM ANDAMENTO — SLA DENTRO DO PRAZO' : 'CASE IN PROGRESS — ON-TIME SLA'} (${isPt ? 'Prazo' : 'Deadline'}: ${deadline.toLocaleString(isPt ? 'pt-BR' : 'en-US')})`)}
          </div>

          <!-- Customer & Equipment Grid -->
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px;">
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:14px;">
              <div style="font-size:0.75rem; font-weight:700; color:#64748b; text-transform:uppercase; margin-bottom:8px;">${isPt ? 'Dados do Cliente & Usina' : 'Customer & Site Info'}</div>
              <div style="font-size:0.95rem; font-weight:700; color:#0f172a;">${escapeHtml(sla.customer?.name || 'Cliente')}</div>
              <div style="font-size:0.82rem; color:#475569; margin-top:4px;"><b>${isPt ? 'Contato' : 'Phone'}:</b> ${escapeHtml(sla.customer?.phone || '—')}</div>
              <div style="font-size:0.82rem; color:#475569;"><b>E-mail:</b> ${escapeHtml(sla.customer?.email || '—')}</div>
              <div style="font-size:0.82rem; color:#475569;"><b>${isPt ? 'Local' : 'Site'}:</b> ${escapeHtml(sla.customer?.site_location || '—')}</div>
            </div>

            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:14px;">
              <div style="font-size:0.75rem; font-weight:700; color:#64748b; text-transform:uppercase; margin-bottom:8px;">${isPt ? 'Equipamento & Telemetria' : 'Equipment & Telemetry'}</div>
              <div style="font-size:0.95rem; font-weight:700; color:#0f172a;">${escapeHtml(sla.equipment?.manufacturer || '—')} • ${escapeHtml(sla.equipment?.model || '—')}</div>
              <div style="font-size:0.82rem; color:#d97706; font-weight:700; margin-top:4px;">SN: ${(sla.equipment?.serial_numbers || []).join(', ') || '—'}</div>
              <div style="font-size:0.82rem; color:#475569;"><b>${isPt ? 'Categoria' : 'Category'}:</b> ${escapeHtml(sla.equipment?.category || '—')}</div>
              <div style="font-size:0.82rem; color:#475569;"><b>Firmware:</b> ${escapeHtml(sla.equipment?.firmware || '—')}</div>
            </div>
          </div>

          <!-- Problem & Action -->
          <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:14px; margin-bottom:20px;">
            <div style="font-size:0.75rem; font-weight:700; color:#64748b; text-transform:uppercase;">${isPt ? 'Sintoma / Falha Reportada' : 'Problem Summary'}</div>
            <div style="font-size:0.9rem; color:#0f172a; margin-top:4px; line-height:1.5;">${escapeHtml(sla.problem_summary || '—')}</div>
            
            <div style="margin-top:10px; padding-top:10px; border-top:1px dashed #e2e8f0; font-size:0.82rem;">
              <span style="color:#d97706; font-weight:700;">${isPt ? 'Próxima Ação:' : 'Next Action:'}</span>
              <span style="color:#334155; margin-left:6px;">${escapeHtml(sla.next_action || '—')}</span>
            </div>
          </div>

          <!-- External Protocols -->
          <div style="background:#f1f5f9; padding:8px 12px; border-radius:4px; font-weight:700; font-size:0.85rem; color:#1e293b; margin-bottom:10px;">
            ${isPt ? 'PROTOCOLOS & RASTREABILIDADE' : 'PROTOCOLS & TRACEABILITY'}
          </div>
          <div style="font-size:0.82rem; color:#475569; margin-bottom:20px; line-height:1.6;">
            <div>• <b>Jira:</b> ${(sla.protocols?.jira || []).map(j => `${j.board}-${j.issue_key} (${j.status})`).join(', ') || 'Nenhum'}</div>
            <div>• <b>Hyperflow:</b> ${sla.protocols?.hyperflow_id || 'Nenhum'}</div>
            ${(sla.protocols?.hoymiles || []).length ? `<div>• <b>Hoymiles:</b> ${(sla.protocols.hoymiles).map(h => `${h.account_email || h.company}`).join(', ')}</div>` : ''}
          </div>

          <!-- Timeline -->
          <div style="background:#f1f5f9; padding:8px 12px; border-radius:4px; font-weight:700; font-size:0.85rem; color:#1e293b; margin-bottom:12px;">
            ${isPt ? 'LINHA DO TEMPO CRONOLÓGICA' : 'CHRONOLOGICAL ACTIVITY STREAM'}
          </div>
          <div style="margin-bottom:24px;">
            ${timeline.map(ev => `
              <div style="border-left:3px solid #38bdf8; padding:6px 12px; background:#fafafa; margin-bottom:6px;">
                <div style="font-size:0.72rem; color:#64748b; font-weight:600;">
                  [${ev.timestamp ? new Date(ev.timestamp).toLocaleString(isPt ? 'pt-BR' : 'en-US') : '—'}] • ${escapeHtml(ev.title || 'Evento')} ${ev.author ? `<span style="font-style:italic;">(${ev.author})</span>` : ''}
                </div>
                ${ev.detail ? `<div style="font-size:0.8rem; color:#334155; margin-top:2px;">${escapeHtml(ev.detail)}</div>` : ''}
              </div>
            `).join('')}
          </div>

          <!-- Signatures -->
          <div style="margin-top:36px; padding-top:20px; border-top:1px dashed #cbd5e1; display:grid; grid-template-columns:1fr 1fr; gap:30px;">
            <div style="text-align:center;">
              <div style="border-top:1px solid #94a3b8; margin:0 20px 8px;"></div>
              <div style="font-size:0.75rem; color:#64748b;">${isPt ? 'Engenharia de Suporte / Diagnóstico Solar' : 'Diagnostic Support Engineer'}</div>
            </div>
            <div style="text-align:center;">
              <div style="border-top:1px solid #94a3b8; margin:0 20px 8px;"></div>
              <div style="font-size:0.75rem; color:#64748b;">${isPt ? 'Validação / Aprovação de Garantia' : 'Warranty Acknowledgment'}</div>
            </div>
          </div>
        </div>
      `;
    },

    // ------------------------------------------------------------------------
    // 5. Email Report Bridge (Attaches PDF to Email Dispatch)
    // ------------------------------------------------------------------------
    emailReport: function(type, data) {
      const isPt = this.getLang() === 'pt';

      if (type === 'sla') {
        const sla = data;
        let pdfResult = null;
        try {
          pdfResult = this.generateSLAPdf(sla, isPt);
        } catch (err) {
          console.warn('[PDFExport] Failed to generate SLA PDF for email dispatch:', err);
        }

        const attachments = [];
        if (pdfResult && pdfResult.base64) {
          attachments.push({
            filename: pdfResult.fileName,
            content: pdfResult.base64,
            encoding: 'base64',
            contentType: 'application/pdf',
            size: pdfResult.size,
            dataUri: pdfResult.dataUri
          });
        }

        const customerName = sla.customer?.name || (isPt ? 'Cliente' : 'Customer');
        const eqInfo = `${sla.equipment?.manufacturer || ''} ${sla.equipment?.model || ''}`.trim() || (isPt ? 'Equipamento Solar' : 'Solar Equipment');
        const snList = (sla.equipment?.serial_numbers || []).join(', ') || 'N/A';
        const deadlineStr = sla.sla_deadline ? new Date(sla.sla_deadline).toLocaleString(isPt ? 'pt-BR' : 'en-US') : 'N/A';

        const bodyText = isPt
          ? `Prezado(a) ${customerName},\n\n`
            + `Segue em anexo o Laudo Técnico Oficial de Atendimento Solar & SLA em formato PDF referente ao chamado [${sla.id}].\n\n`
            + `RESUMO OPERACIONAL DO CASO:\n`
            + `---------------------------------------------------\n`
            + `• Protocolo SLA: ${sla.id}\n`
            + `• Cliente: ${customerName}\n`
            + `• Local da Usina: ${sla.customer?.site_location || 'Conforme cadastro'}\n`
            + `• Equipamento: ${eqInfo} (N/S: ${snList})\n`
            + `• Status Atual: ${sla.status}\n`
            + `• Prazo Limite SLA: ${deadlineStr}\n\n`
            + `DIAGNÓSTICO E RESUMO DA FALHA:\n`
            + `${sla.problem_summary || 'Análise técnica em andamento.'}\n\n`
            + `PRÓXIMA AÇÃO OPERACIONAL:\n`
            + `${sla.next_action || 'Aguardando tratativa técnica.'}\n\n`
            + `O relatório técnico completo, histórico de telemetria e registros de conformidade com o fabricante encontram-se no documento PDF anexo.\n\n`
            + `---\nDisparado automaticamente via Solar Agenda & TARS Vision Bridge`
          : `Dear ${customerName},\n\n`
            + `Please find attached the official Solar Technical Support & SLA Report (PDF) regarding protocol [${sla.id}].\n\n`
            + `TICKET OPERATIONAL SUMMARY:\n`
            + `---------------------------------------------------\n`
            + `• SLA Protocol: ${sla.id}\n`
            + `• Customer: ${customerName}\n`
            + `• Site Location: ${sla.customer?.site_location || 'On file'}\n`
            + `• Equipment: ${eqInfo} (SN: ${snList})\n`
            + `• Current Status: ${sla.status}\n`
            + `• SLA Deadline: ${deadlineStr}\n\n`
            + `PROBLEM SUMMARY & DIAGNOSTICS:\n`
            + `${sla.problem_summary || 'Technical diagnosis in progress.'}\n\n`
            + `NEXT OPERATIONAL ACTION:\n`
            + `${sla.next_action || 'Pending technical action.'}\n\n`
            + `The complete technical report, telemetry logs, and manufacturer warranty tracking are included in the attached PDF.\n\n`
            + `---\nDispatched automatically via Solar Agenda & TARS Vision Bridge`;

        if (typeof window.openCompose === 'function') {
          window.openCompose({
            name: isPt ? `Laudo SLA: ${sla.id}` : `SLA Report: ${sla.id}`,
            to: sla.customer?.email || '',
            subject: `[${sla.id}] ${isPt ? 'Laudo Técnico de Atendimento Solar' : 'Solar Technical Support Report'} — ${sla.equipment?.manufacturer || 'Equipamento'}`,
            body: bodyText,
            attachments: attachments
          }, {});
        } else {
          alert(bodyText);
        }
      } else {
        const c = data;
        let pdfResult = null;
        try {
          pdfResult = this.generateCasePdf(c, isPt);
        } catch (err) {
          console.warn('[PDFExport] Failed to generate Case PDF for email dispatch:', err);
        }

        const attachments = [];
        if (pdfResult && pdfResult.base64) {
          attachments.push({
            filename: pdfResult.fileName,
            content: pdfResult.base64,
            encoding: 'base64',
            contentType: 'application/pdf',
            size: pdfResult.size,
            dataUri: pdfResult.dataUri
          });
        }

        const destEmail = (c.phone && c.phone.includes('@')) ? c.phone : '';
        const bodyText = isPt
          ? `Prezado(a),\n\n`
            + `Segue em anexo o Laudo Técnico de Atendimento de Campo referente ao chamado [${c.ticket || 'SOLAR-CASE'}].\n\n`
            + `DETALHES DO ATENDIMENTO:\n`
            + `---------------------------------------------------\n`
            + `• Chamado: ${c.ticket || 'N/A'}\n`
            + `• Assunto: ${c.titulo}\n`
            + `• Prioridade: ${c.prioridade || 'Normal'}\n`
            + `• Data: ${c.case_date || ''} (${c.horario || ''} - ${c.horario_fim || ''})\n`
            + `• Tags / Categoria: ${(c.tags || []).join(', ') || 'Geral'}\n\n`
            + `O laudo técnico com histórico de apontamentos e validações encontra-se no arquivo PDF anexo.\n\n`
            + `---\nDisparado via Solar Agenda`
          : `Dear Client,\n\n`
            + `Please find attached the Field Service Technical Report regarding ticket [${c.ticket || 'SOLAR-CASE'}].\n\n`
            + `CASE DETAILS:\n`
            + `---------------------------------------------------\n`
            + `• Ticket: ${c.ticket || 'N/A'}\n`
            + `• Title: ${c.titulo}\n`
            + `• Priority: ${c.prioridade || 'Normal'}\n`
            + `• Date: ${c.case_date || ''} (${c.horario || ''} - ${c.horario_fim || ''})\n`
            + `• Tags: ${(c.tags || []).join(', ') || 'General'}\n\n`
            + `The complete technical report and diagnostics are included in the attached PDF.\n\n`
            + `---\nDispatched via Solar Agenda`;

        if (typeof window.openCompose === 'function') {
          window.openCompose({
            name: `Email Case: ${c.ticket || c.titulo}`,
            to: destEmail,
            subject: `[${c.ticket || 'SOLAR-CASE'}] ${c.titulo}`,
            body: bodyText,
            attachments: attachments
          }, {});
        } else {
          alert(bodyText);
        }
      }
    }
  };

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Export to window
  window.PDFExport = PDFExport;

})(window);
