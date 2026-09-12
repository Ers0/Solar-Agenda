// server/jira.ts - Atlassian Jira Cloud Integration Service for Solar Agenda
// Acts as the formal warranty/protocol synchronization bridge for SLA cases

export interface JiraConfig {
  host?: string;
  email?: string;
  apiToken?: string;
  defaultProjectKey?: string;
  defaultIssueType?: string;
}

export interface CreateJiraIssueParams {
  slaCaseId: string;
  summary: string;
  description?: string;
  priority?: string;
  issueType?: string;
  projectKey?: string;
  customerName?: string;
  customerPhone?: string;
  serialNumber?: string;
  equipmentModel?: string;
  manufacturer?: string;
}

export interface JiraIssueResponse {
  id?: string;
  key: string;
  self?: string;
  url?: string;
  status?: string;
  summary?: string;
  description?: string;
  isSimulated?: boolean;
}

export class JiraService {
  private config: JiraConfig;

  constructor(customConfig?: JiraConfig) {
    this.config = this.resolveConfig(customConfig);
  }

  private resolveConfig(custom?: JiraConfig): JiraConfig {
    const rawHost = custom?.host || process.env.JIRA_HOST || "";
    let cleanHost = rawHost.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");

    return {
      host: cleanHost,
      email: (custom?.email || process.env.JIRA_EMAIL || "").trim(),
      apiToken: (custom?.apiToken || process.env.JIRA_API_TOKEN || "").trim(),
      defaultProjectKey: (custom?.defaultProjectKey || process.env.JIRA_DEFAULT_PROJECT_KEY || "SOL").trim().toUpperCase(),
      defaultIssueType: (custom?.defaultIssueType || process.env.JIRA_DEFAULT_ISSUE_TYPE || "Task").trim(),
    };
  }

  public isConfigured(): boolean {
    return Boolean(this.config.host && this.config.email && this.config.apiToken);
  }

  public getConfigSummary() {
    return {
      configured: this.isConfigured(),
      host: this.config.host || null,
      email: this.config.email ? this.config.email.replace(/(?<=.{2}).(?=.*@)/g, "*") : null,
      defaultProjectKey: this.config.defaultProjectKey,
      defaultIssueType: this.config.defaultIssueType,
      hasToken: Boolean(this.config.apiToken),
    };
  }

  private getAuthHeader(): string {
    const credentials = `${this.config.email}:${this.config.apiToken}`;
    return `Basic ${Buffer.from(credentials).toString("base64")}`;
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error("Jira integration is not fully configured (host, email, and API token required).");
    }

    const url = `https://${this.config.host}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: this.getAuthHeader(),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> || {}),
    };

    const response = await fetch(url, { ...options, headers });
    const text = await response.text();

    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (!response.ok) {
      const errorMsg = json?.errorMessages?.join("; ") ||
        (json?.errors ? Object.entries(json.errors).map(([k, v]) => `${k}: ${v}`).join(", ") : null) ||
        `Jira API responded with HTTP ${response.status} ${response.statusText}`;
      throw new Error(errorMsg);
    }

    return json;
  }

  public async testConnection(): Promise<{ ok: boolean; message: string; user?: any }> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        message: "Jira credentials missing. Set JIRA_HOST, JIRA_EMAIL, and JIRA_API_TOKEN in environment variables or configuration.",
      };
    }

    try {
      const user = await this.request("/rest/api/3/myself");
      return {
        ok: true,
        message: `Successfully connected to Jira as ${user.displayName || user.emailAddress}!`,
        user: {
          displayName: user.displayName,
          emailAddress: user.emailAddress,
          timeZone: user.timeZone,
          active: user.active,
        },
      };
    } catch (err: any) {
      return {
        ok: false,
        message: `Jira connection test failed: ${err.message}`,
      };
    }
  }

  public async getProjects(): Promise<any[]> {
    if (!this.isConfigured()) {
      return [
        {
          key: this.config.defaultProjectKey || "SOL",
          name: "Solar Technical Support (Local)",
          id: "10000",
          projectTypeKey: "software",
          simulated: true,
        },
      ];
    }

    try {
      const projects = await this.request("/rest/api/3/project");
      return (projects || []).map((p: any) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        projectTypeKey: p.projectTypeKey,
      }));
    } catch (err) {
      console.warn("[JiraService] Failed to load projects from cloud, returning default:", err);
      return [{ key: this.config.defaultProjectKey, name: "Default Solar Support Project" }];
    }
  }

  public async getIssue(issueKey: string): Promise<any> {
    if (!issueKey) throw new Error("Issue key is required.");

    if (!this.isConfigured()) {
      return {
        key: issueKey,
        summary: `Solar Support Warranty Protocol [${issueKey}]`,
        status: { name: "Awaiting Manufacturer Response", statusCategory: { name: "In Progress" } },
        priority: { name: "High" },
        created: new Date().toISOString(),
        isSimulated: true,
      };
    }

    const data = await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,priority,assignee,created,updated,comment`);
    const fields = data.fields || {};

    let descriptionText = "";
    if (typeof fields.description === "string") {
      descriptionText = fields.description;
    } else if (fields.description?.content) {
      // Atlassian Document Format (ADF) text extraction
      try {
        descriptionText = JSON.stringify(fields.description);
      } catch {}
    }

    return {
      id: data.id,
      key: data.key,
      summary: fields.summary,
      description: descriptionText,
      status: fields.status?.name || "Unknown",
      statusCategory: fields.status?.statusCategory?.name || "To Do",
      priority: fields.priority?.name || "Normal",
      assignee: fields.assignee?.displayName || "Unassigned",
      created: fields.created,
      updated: fields.updated,
      commentsCount: fields.comment?.total || 0,
      url: `https://${this.config.host}/browse/${data.key}`,
    };
  }

  public async createIssue(params: CreateJiraIssueParams): Promise<JiraIssueResponse> {
    const projectKey = (params.projectKey || this.config.defaultProjectKey || "SOL").toUpperCase();
    const issueType = params.issueType || this.config.defaultIssueType || "Task";
    const summary = params.summary || `[${params.slaCaseId}] Defeito Inversor ${params.manufacturer || ""} - ${params.customerName || "Suporte"}`;

    const priorityMap: Record<string, string> = {
      urgente: "Highest",
      alta: "High",
      media: "Medium",
      baixa: "Low",
    };
    const jiraPriority = priorityMap[(params.priority || "").toLowerCase()] || "High";

    // Format rich text description for Jira
    const descriptionLines = [
      `*SLA Case ID:* ${params.slaCaseId}`,
      `*Customer:* ${params.customerName || "N/A"} (${params.customerPhone || "N/A"})`,
      `*Equipment / Manufacturer:* ${params.manufacturer || "N/A"} - ${params.equipmentModel || "N/A"}`,
      `*Serial Number (SN):* ${params.serialNumber || "N/A"}`,
      "",
      `*Problem Summary:*`,
      params.description || "Inverter technical anomaly reported via Solar Agenda support routine.",
      "",
      `_Synchronized from Solar Agenda SLA Control Layer at ${new Date().toISOString()}_`,
    ];
    const plainDescription = descriptionLines.join("\n");

    if (!this.isConfigured()) {
      // Offline / unconfigured development sandbox fallback
      const simulatedKey = `${projectKey}-${Math.floor(1000 + Math.random() * 9000)}`;
      return {
        key: simulatedKey,
        summary,
        status: "Open",
        url: `https://${this.config.host || "atlassian.net"}/browse/${simulatedKey}`,
        isSimulated: true,
      };
    }

    // ADF payload format for Jira v3 REST API
    const adfDescription = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: plainDescription }],
        },
      ],
    };

    const payload = {
      fields: {
        project: { key: projectKey },
        summary: summary.slice(0, 250),
        description: adfDescription,
        issuetype: { name: issueType },
        priority: { name: jiraPriority },
      },
    };

    try {
      const res = await this.request("/rest/api/3/issue", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      return {
        id: res.id,
        key: res.key,
        self: res.self,
        url: `https://${this.config.host}/browse/${res.key}`,
        status: "Created",
      };
    } catch (err: any) {
      console.warn("[JiraService] Failed with v3 ADF, attempting v2 text fallback:", err.message);
      // Fallback to Jira v2 endpoint with plain string description
      const v2Payload = {
        fields: {
          project: { key: projectKey },
          summary: summary.slice(0, 250),
          description: plainDescription,
          issuetype: { name: issueType },
        },
      };
      const v2Res = await this.request("/rest/api/2/issue", {
        method: "POST",
        body: JSON.stringify(v2Payload),
      });

      return {
        id: v2Res.id,
        key: v2Res.key,
        self: v2Res.self,
        url: `https://${this.config.host}/browse/${v2Res.key}`,
        status: "Created",
      };
    }
  }

  public async addComment(issueKey: string, commentBody: string): Promise<any> {
    if (!issueKey) throw new Error("Issue key is required.");
    if (!commentBody) throw new Error("Comment text is required.");

    if (!this.isConfigured()) {
      return {
        id: `sim-comment-${Date.now()}`,
        body: commentBody,
        created: new Date().toISOString(),
        isSimulated: true,
      };
    }

    const payload = {
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: commentBody }],
          },
        ],
      },
    };

    try {
      return await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    } catch {
      // Try v2 fallback
      return await this.request(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`, {
        method: "POST",
        body: JSON.stringify({ body: commentBody }),
      });
    }
  }
}
