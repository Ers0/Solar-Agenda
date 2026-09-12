# ☀️ Solar Agenda & TARS Intelligent Operations Hub

> **Comprehensive Enterprise Platform for Solar Inverter Support, SLA Governance, Autonomous Voice/Vision Intelligence, and Hyperflow Automation.**

---

## 📑 Table of Contents
1. [Overview](#-overview)
2. [Key Capabilities & Modules](#-key-capabilities--modules)
   - [Support Agenda & Daily Dial](#1-support-agenda--daily-dial)
   - [TARS AI (Voice, Vision & Proactive Diagnostic Engine)](#2-tars-ai-voice-vision--proactive-diagnostic-engine)
   - [Enterprise SLA Hub & Lifecycle Tracking](#3-enterprise-sla-hub--lifecycle-tracking)
   - [TARS Vision Bridge Chrome Extension (v1.2.37)](#4-tars-vision-bridge-chrome-extension-v1237)
   - [Hoymiles Automation & SLA Webhook](#5-hoymiles-automation--sla-webhook)
   - [Knowledge Base & Galaxy Visualizer](#6-knowledge-base--galaxy-visualizer)
   - [Notebooks & Client-side Zero-Knowledge Encryption](#7-notebooks--client-side-zero-knowledge-encryption)
   - [Bilingual Architecture (EN / PT-BR)](#8-bilingual-architecture-en--pt-br)
3. [Architecture & Technology Stack](#-architecture--technology-stack)
4. [Getting Started & Installation](#-getting-started--installation)
   - [Prerequisites](#prerequisites)
   - [Running Locally](#running-locally)
   - [Installing the TARS Vision Bridge Extension](#installing-the-tars-vision-bridge-extension)
5. [Configuration & Environment Variables](#-configuration--environment-variables)
6. [API Endpoints Reference](#-api-endpoints-reference)
7. [User Guide: First Time Walkthrough](#-user-guide-first-time-walkthrough)
8. [License](#-license)

---

## 🌟 Overview

**Solar Agenda** is an enterprise-grade operational workstation engineered specifically for solar energy technical support teams, field engineers, and operations managers. 

By combining:
- A circadian, phase-aware daily dial interface,
- **TARS** (an autonomous voice and reasoning assistant with adjustable humour and honesty vectors),
- An unyielding **12-stage SLA governance engine** with precision clock countdowns,
- **Hyperflow WhatsApp integration** through the **TARS Vision Bridge Chrome Extension**, and
- Zero-friction Hoymiles installer account automation,

Solar Agenda ensures that no customer request, manufacturer warranty RMA, or inverter fault slip through the cracks.

---

## 🚀 Key Capabilities & Modules

### 1. Support Agenda & Daily Dial
- **Circadian Day Dial**: A 288-degree radial dial (07:00 to 19:00) mapping your live workday, cases, and priorities against real-time solar hours and local weather.
- **First Hour Priority Filter**: Auto-isolates critical and high-priority cases so engineers tackle high-urgency solar plant outages before standard tasks.
- **Live Meteorological Telemetry**: Built-in Open-Meteo integration monitoring local irradiation and rain conditions (e.g. Vinhedo station) plus alerts for severe weather across Brazil.

### 2. TARS AI (Voice, Vision & Proactive Diagnostic Engine)
- **Persistent Conversational AI**: Voice-activated via *"Hey TARS"* or one-click HUD mode.
- **Adjustable Parameters**: Fine-tune **Humour (0–100%)** and **Honesty/Candor (0–100%)** directly in Settings.
- **Autonomous Multi-Factor Diagnostics**: Synthesizes customer transcripts, error codes (e.g., *Grid Vol Fault, Isolation Resistance, Over-temperature*), inverter schematics, and the internal knowledge base into structured:
  - 🔎 **Facts & Measurements**
  - 🧠 **Diagnostic Inferences**
  - 🛠️ **Recommended Action Plans**
- **Vision Screen Inspection**: Captures active tabs and technical schematics for instant optical analysis.

### 3. Enterprise SLA Hub & Lifecycle Tracking
- **12 Lifecycle Stages**: Complete tracking from intake to closure:
  `NEW` ➔ `TRIAGE / ANALYSIS` ➔ `PENDING MANUFACTURER CONTACT` ➔ `WAITING MANUFACTURER RESPONSE` ➔ `MANUFACTURER RESPONDED` ➔ `WAITING CUSTOMER INFO / TEST` ➔ `CUSTOMER RESPONDED` ➔ `SCHEDULED VISIT / PAC` ➔ `TECHNICAL FOLLOW-UP` ➔ `RESOLVED` ➔ `CLOSED` ➔ `CANCELED`.
- **Real-Time SLA Clocks & Risk Alerts**:
  - 🟢 **No Prazo (Healthy)**
  - 🟡 **Em Risco (At Risk)** — Less than 8 hours or <45% time remaining.
  - 🔴 **Estourado (Breached)** — Visual strobe, red countdown timer, and incident logging.
- **Serial Number (SN) Extraction Engine**: Regex & contextual Named Entity Recognition (NER) capable of parsing serial numbers and models from Deye, FoxESS, Huawei, Solis, Growatt, Sungrow, Hoymiles, and Sofar.

### 4. TARS Vision Bridge Chrome Extension (v1.2.37)
- Located in `public/tars-extension` (also packaged in `public/tars-vision-bridge.zip`).
- Bridges customer WhatsApp web chats (Hyperflow) directly to the Solar Agenda SLA Hub.
- Provides a rich popup with tabs for:
  - 🛡️ **SLA & Webhook**: URL manager, live ping testing, memory cleaner, and direct SLA Hub deep-link.
  - ⚡ **Hoymiles Lab**: 13 automated diagnostic buttons for portal validation.
  - 👁️ **Vision Bridge**: Screen grab and real-time page context transfer.

### 5. Hoymiles Automation & SLA Webhook
- **Non-Blocking Background Pipeline**: When an installer account is provisioned via Hoymiles Global Portal, the extension fires an asynchronous webhook event:
  `POST /api/sla/webhook` (`hoymiles.account.created`).
- **Zero Effort Case Matching**:
  - Matches the client conversation ID or phone.
  - If a case exists: links the credentials, updates equipment tags to `⚡ Hoymiles: [Company]`, and posts a timeline event.
  - If no case exists: **automatically generates a complete SLA case** in the background with manufacturer, protocol number (`SLA-HOY-XXXX`), customer info, and initial triage status.
- **Security Guarantee**: Generated passwords are never transmitted or stored on the SLA server; only `passwordSharedWithCustomer: true` is reported.

### 6. Knowledge Base & Galaxy Visualizer
- Searchable solar inverter manuals, error code dictionaries, grid-tied inverter wiring diagrams, and warranty procedures.
- **3D/2D Knowledge Galaxy**: Visual node graph of technical relationships and diagnostic trees.

### 7. Notebooks & Client-Side Zero-Knowledge Encryption
- AES-256-GCM encryption for notes, private customer details, and incident records using Web Crypto.
- Keys are derived and stored locally (`enc:v1:...`), meaning database dumps contain only ciphertext.

### 8. Bilingual Architecture (EN / PT-BR)
- Native language toggle switch located in the top navigation header right beside the **TARS online** pill:
  - 🇺🇸 **EN** (English)
  - 🇧🇷 **PT** (Português do Brasil)
- Switches all navigation tabs, headers, SLA stages, placeholders, and speech synthesis languages synchronously.

---

## 🏗️ Architecture & Technology Stack

```
┌────────────────────────────────────────────────────────┐
│               TARS Vision Bridge (Chrome Extension)    │
│  • Hyperflow WhatsApp DOM Watcher                      │
│  • Hoymiles Automation Engine                          │
│  • Non-blocking SLA Webhook Dispatcher                 │
└──────────────────────────┬─────────────────────────────┘
                           │ (POST /api/sla/webhook)
                           ▼
┌────────────────────────────────────────────────────────┐
│             Solar Agenda Full-Stack Node/Express       │
│  • /api/sla/webhook  ── Ingests Hoymiles & Bot events  │
│  • /api/app-data     ── Offline-first data sync        │
│  • /api/send-email   ── SMTP dispatch with failover    │
│  • /api/jira-webhook ── External issue tracking        │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│            Frontend Single Page Application            │
│  • index.html (Responsive grid & HUD Fullscreen)       │
│  • i18n.js (Bilingual Reactive Engine: EN/PT)          │
│  • sla-hub.js (Autonomous SLA Management & SN NER)     │
│  • app.js (TARS Core, Audio Engine, AES-256 Crypto)    │
│  • Tailwind CSS & Canvas HUD Particle Sweeps           │
└────────────────────────────────────────────────────────┘
```

---

## 💻 Getting Started & Installation

### Prerequisites
- Node.js 18+ or Bun
- Google Chrome, Brave, or Microsoft Edge (for the extension)

### Running Locally

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Ers0/Solar-Agenda.git
   cd Solar-Agenda
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment:**
   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
   *(Edit `.env` if you have custom SMTP, Jira, or Gemini API keys).*

4. **Start the Development Server:**
   ```bash
   npm run dev
   ```
   Open your browser at `http://localhost:3000`.

5. **Production Build:**
   ```bash
   npm run build
   npm start
   ```

### Installing the TARS Vision Bridge Extension

1. In Chrome/Brave/Edge, navigate to: `chrome://extensions/`
2. Enable **Developer mode** (top right switch).
3. Click **Load unpacked** (Carregar sem compactação).
4. Select the folder: `public/tars-extension` in your project directory.
5. The extension **TARS Vision Bridge v1.2.37** will appear in your toolbar.
6. Open the popup, verify the SLA webhook endpoint (`http://localhost:3000/api/sla/webhook` or your production URL), and click **🚀 Testar Ping SLA Webhook**.

---

## ⚙️ Configuration & Environment Variables

| Variable | Description | Default / Optional |
|---|---|---|
| `PORT` | Web server listening port | `3000` |
| `GEMINI_API_KEY` | Google Gemini API Key for server-side AI logic | Optional |
| `SMTP_HOST` | Host for outgoing notification emails | Optional |
| `SMTP_PORT` | Port for SMTP (465 SSL or 587 STARTTLS) | Optional |
| `SMTP_USER` | Email user authentication | Optional |
| `SMTP_PASS` | Email password or app-password | Optional |
| `JIRA_WEBHOOK_SECRET` | Secret verification token for Jira callbacks | Optional |

---

## 📡 API Endpoints Reference

### SLA Webhook
- `POST /api/sla/webhook`
  - Ingests `hoymiles.account.created` or third-party CRM tickets.
  - Automatically matches or creates SLA cases.
- `GET /api/sla/webhook/logs`
  - Retrieves real-time event logs and payloads received by the webhook.

### System Health
- `GET /api/health`
  - Returns `{"status":"ok", "service":"Solar Agenda Full-Stack Server"}`.

### Email & Jira Integrations
- `POST /api/send-email` — Dispatches automated notifications with fallback.
- `POST /api/jira-webhook` — Bi-directional status sync with Jira Service Management.
- `GET /api/ml-export-dataset` — Exports diagnostic cases for offline ML model training.

---

## 📖 User Guide: First Time Walkthrough

1. **Selecting Your Language:**
   - Look at the top navigation header beside **TARS online**.
   - Click the `🇺🇸 EN / 🇧🇷 PT` button to toggle all interface texts and speech synthesis accents between English and Brazilian Portuguese.

2. **Managing Your Daily Agenda:**
   - The top dial displays the current time and scheduled cases.
   - High-priority items show up in **First Hour** on the left column.
   - Click **+ New Case** to log a technical visit, preventive maintenance, or customer ticket.

3. **Navigating to the SLA Hub:**
   - Click **SLA** in the left navigation rail (or bottom bar on mobile).
   - View your cases categorized by status pills: *Active*, *Critical/In Danger*, *Pending Manufacturer*, and *Resolved*.
   - Click on any case card to open the **Multi-Tab Inspection Modal**:
     - **📋 Overview**: Customer info, equipment model, and serial numbers.
     - **⏱️ SLA Clocks**: Real-time elapsed time vs. SLA deadline countdown.
     - **🧠 TARS Analysis**: Click *Analyze with TARS* for autonomous diagnostic inference.
     - **📝 Timeline**: Chronological history of actions, measurements, and visits.
     - **⚡ Hoymiles & Protocols**: View linked installer accounts and credentials status.

4. **Interacting with TARS:**
   - Press the microphone icon or say *"Hey TARS"* to speak.
   - Open Settings ➔ Assistant to adjust TARS's humour and candor sliders.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

Developed with ⚡ for the future of solar energy operations.
