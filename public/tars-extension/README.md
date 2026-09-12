# TARS Vision Bridge (v1.2.37) & Solar Agenda SLA Webhook

Extensão oficial do ecossistema **Solar Agenda** e **TARS**, unindo a memória contínua do atendimento Hyperflow, a automação de criação de contas no portal global da Hoymiles e a camada não-bloqueante de Webhook para o SLA Hub do Solar Agenda.

---

## 🚀 Novidades da Versão 1.2.37 (Aba SLA & Webhook)

1. **Aba SLA & Webhook no Popup**:
   - **Gerenciador de Webhook**: visualize e configure o endpoint do webhook (padrão: `https://solar-agenda.vercel.app/api/sla/webhook`).
   - **Teste de Ping Imediato**: envie um evento real `hoymiles.account.created` com um clique para testar a comunicação entre a extensão e o Solar Agenda.
   - **Histórico & Memória de Contas**: visualização da última conta criada (email, empresa, data/hora) e botão para limpar a memória de duplicação para testes repetidos.
   - **Atalho Direto para o SLA Hub**: botão para abrir ou focar a aba do Solar Agenda já na visualização de SLA.

2. **Aba Hoymiles Test Lab**:
   - Diagnóstico passo a passo: `Inspect`, `Ping`, `Org & User`, `Add Organization`, `Parent → APItest`, `Type → Installer`, `Region`, `Contacts`, etc.

3. **Aba TARS Vision**:
   - Captura de aba ativa com inteligência contextual transmitida em tempo real para o Solar Agenda.

---

## ⚡ Arquitetura do Webhook SLA Solar Agenda

O webhook é **estritamente não-bloqueante**. A criação de conta e o envio das credenciais ao cliente pelo Hyperflow nunca são interrompidos se o Solar Agenda estiver temporariamente offline ou a rota estiver sendo provisionada:

```
Conta Hoymiles criada no portal
               ↓
        ACCOUNT_CREATED
        ├──→ Hyperflow → cliente recebe o login e links de treinamento
        │
        └──→ SLA Webhook → Solar Agenda (POST /api/sla/webhook)
```

### Estrutura do Payload Enviado (`hoymiles.account.created`):
```json
{
  "event": "hoymiles.account.created",
  "version": "1.0",
  "source": "tars-vision-bridge",
  "bridgeVersion": "1.2.37",
  "occurredAt": "2026-09-12T18:30:00.000Z",
  "status": "COMPLETED",
  "conversationId": "hyperflow:12345",
  "customer": {
    "name": "Nome Completo do Cliente",
    "email": "cliente@empresa.com.br",
    "phone": "11988776655",
    "state": "São Paulo"
  },
  "organization": {
    "name": "Empresa Solar Ltda",
    "parentOrganization": "APItest",
    "type": "Installer",
    "role": "Installer"
  },
  "account": {
    "loginEmail": "cliente@empresa.com.br",
    "passwordSharedWithCustomer": true
  },
  "reporting": {}
}
```

*Nota de Segurança: A senha (`Solar123`) **não é transmitida** ao webhook SLA. O Solar Agenda recebe apenas o comprovante de que as credenciais foram compartilhadas com segurança via Hyperflow.*

---

## 📦 Como Instalar no Google Chrome / Brave / Edge

1. Abra `chrome://extensions` no seu navegador.
2. Ative o **Modo do desenvolvedor** (Developer mode) no canto superior direito.
3. Clique em **Carregar sem compactação** (Load unpacked).
4. Selecione esta pasta (`public/tars-extension`).
5. A extensão `TARS Vision Bridge v1.2.37` aparecerá no menu de extensões com o ícone amarelo `T`.
6. Abra o popup e clique em **Testar Ping SLA Webhook** para validar o endpoint!
