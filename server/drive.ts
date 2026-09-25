/**
 * Google Drive Automated Ingestion Engine for Solar Agenda & Hyperflow
 * Handles automated folder tree generation:
 * ~Fabricante~/Mês/Nome do Cliente + Telefone/Testes ou Documentos
 */

export interface DriveAuditEntry {
  id: string;
  timestamp: string;
  sourceUrl: string;
  filename: string;
  mediaType: 'image' | 'video' | 'document' | 'other';
  targetFolder: 'Testes' | 'Documentos';
  manufacturer: string;
  clientName: string;
  clientPhone: string;
  resolvedPath: string;
  fileId?: string;
  webViewLink?: string;
  fileSize?: number;
  status: 'SUCCESS' | 'SKIPPED' | 'FAILED' | 'PENDING';
  reason?: string;
  conversationId?: string;
}

const auditLogs: DriveAuditEntry[] = [];
const folderCache = new Map<string, string>(); // pathKey -> folderId

const MONTH_NAMES_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

export class GoogleDriveService {
  private static defaultRootFolderName = 'Belenergy - Garantias';

  public static getAuditLogs(limit: number = 50): DriveAuditEntry[] {
    return auditLogs.slice(-limit).reverse();
  }

  public static recordAudit(entry: Omit<DriveAuditEntry, 'id' | 'timestamp'>): DriveAuditEntry {
    const record: DriveAuditEntry = {
      id: 'drv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      ...entry
    };
    auditLogs.push(record);
    if (auditLogs.length > 200) auditLogs.shift();
    return record;
  }

  public static getMonthFolderLabel(date: Date = new Date()): string {
    const monthIndex = date.getMonth();
    const monthNum = String(monthIndex + 1).padStart(2, '0');
    const monthName = MONTH_NAMES_PT[monthIndex];
    const year = date.getFullYear();
    return `${monthNum} - ${monthName} ${year}`;
  }

  public static cleanManufacturerName(raw: string = ''): string {
    const text = String(raw || '').trim().toLowerCase();
    if (text.includes('deye')) return 'Deye';
    if (text.includes('hoymiles')) return 'Hoymiles';
    if (text.includes('growatt')) return 'Growatt';
    if (text.includes('solis')) return 'Solis';
    if (text.includes('saj')) return 'SAJ';
    if (text.includes('goodwe')) return 'GoodWe';
    if (text.includes('canadian')) return 'Canadian Solar';
    if (text.includes('sungrow')) return 'Sungrow';
    if (text.includes('livoltek')) return 'Livoltek';
    if (text.includes('intelbras')) return 'Intelbras';
    if (text.includes('solar')) return 'Solar';
    return text ? `~${raw.trim()}~` : '~Geral~';
  }

  public static formatClientFolderLabel(name: string, phone: string): string {
    const cleanName = (name || 'Cliente Sem Nome').trim().replace(/[/\\?%*:|"<>]/g, '-');
    const cleanPhone = (phone || '').trim().replace(/[/\\?%*:|"<>]/g, '');
    if (cleanPhone) {
      return `${cleanName} (${cleanPhone})`;
    }
    return cleanName;
  }

  /**
   * Finds or creates a subfolder by name inside a parent folder on Google Drive
   */
  public static async findOrCreateFolder(
    folderName: string,
    parentId?: string,
    accessToken?: string
  ): Promise<string> {
    if (!accessToken) {
      throw new Error('Google Drive Access Token is required');
    }

    const cleanName = folderName.replace(/'/g, "\\'");
    const cacheKey = `${parentId || 'root'}:${folderName}`;
    if (folderCache.has(cacheKey)) {
      return folderCache.get(cacheKey)!;
    }

    // 1. Search for existing folder
    let q = `name = '${cleanName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    if (parentId) {
      q += ` and '${parentId}' in parents`;
    }

    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;
    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!searchRes.ok) {
      const errText = await searchRes.text();
      throw new Error(`Failed to search folder '${folderName}': ${searchRes.status} ${errText}`);
    }

    const searchData = (await searchRes.json()) as { files?: Array<{ id: string; name: string }> };
    if (searchData.files && searchData.files.length > 0) {
      const folderId = searchData.files[0].id;
      folderCache.set(cacheKey, folderId);
      return folderId;
    }

    // 2. Create folder if not found
    const createUrl = 'https://www.googleapis.com/drive/v3/files';
    const body: Record<string, any> = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder'
    };
    if (parentId) {
      body.parents = [parentId];
    }

    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Failed to create folder '${folderName}': ${createRes.status} ${errText}`);
    }

    const createData = (await createRes.json()) as { id: string };
    folderCache.set(cacheKey, createData.id);
    return createData.id;
  }

  /**
   * Resolves full warranty nested folder structure:
   * [Belenergy - Garantias] -> [~Fabricante~] -> [Mês] -> [Cliente + Telefone] -> [Testes / Documentos]
   */
  public static async resolveTargetFolder(params: {
    manufacturer: string;
    clientName: string;
    clientPhone: string;
    subfolder: 'Testes' | 'Documentos';
    rootFolderId?: string;
    accessToken: string;
  }): Promise<{ folderId: string; fullPath: string }> {
    const { manufacturer, clientName, clientPhone, subfolder, rootFolderId, accessToken } = params;

    // 1. Root / Belenergy Warranty Base Folder
    let currentParentId = rootFolderId;
    if (!currentParentId) {
      currentParentId = await this.findOrCreateFolder(this.defaultRootFolderName, undefined, accessToken);
    }

    // 2. ~Manufacturer~ Folder
    const mfgLabel = this.cleanManufacturerName(manufacturer);
    const mfgFolderId = await this.findOrCreateFolder(`~${mfgLabel.replace(/~/g, '')}~`, currentParentId, accessToken);

    // 3. Month Folder (e.g. "09 - Setembro 2026")
    const monthLabel = this.getMonthFolderLabel();
    const monthFolderId = await this.findOrCreateFolder(monthLabel, mfgFolderId, accessToken);

    // 4. Client Name + Phone Folder
    const clientLabel = this.formatClientFolderLabel(clientName, clientPhone);
    const clientFolderId = await this.findOrCreateFolder(clientLabel, monthFolderId, accessToken);

    // 5. Categorized Subfolder (Testes or Documentos)
    const targetFolderId = await this.findOrCreateFolder(subfolder, clientFolderId, accessToken);

    const fullPath = `${this.defaultRootFolderName}/~${mfgLabel.replace(/~/g, '')}~/` +
      `${monthLabel}/${clientLabel}/${subfolder}`;

    return { folderId: targetFolderId, fullPath };
  }

  /**
   * Uploads a file buffer directly to the resolved Google Drive folder using multipart upload
   */
  public static async uploadFileBuffer(params: {
    filename: string;
    mimeType: string;
    buffer: Buffer;
    parentFolderId: string;
    accessToken: string;
  }): Promise<{ fileId: string; webViewLink?: string; size: number }> {
    const { filename, mimeType, buffer, parentFolderId, accessToken } = params;

    const metadata = {
      name: filename,
      parents: [parentFolderId]
    };

    const boundary = '-------TARS_DRIVE_UPLOAD_BOUNDARY_' + Date.now();
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metadataPart =
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata);

    const binaryHeader =
      `Content-Type: ${mimeType || 'application/octet-stream'}\r\n` +
      `Content-Transfer-Encoding: binary\r\n\r\n`;

    const headerBuf = Buffer.from(delimiter + metadataPart + delimiter + binaryHeader);
    const footerBuf = Buffer.from(closeDelimiter);
    const multipartBody = Buffer.concat([headerBuf, buffer, footerBuf]);

    const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,size';
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(multipartBody.length)
      },
      body: multipartBody
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Google Drive upload failed: ${uploadRes.status} ${errText}`);
    }

    const resData = (await uploadRes.json()) as { id: string; name: string; webViewLink?: string; size?: string };
    return {
      fileId: resData.id,
      webViewLink: resData.webViewLink || `https://drive.google.com/file/d/${resData.id}/view`,
      size: Number(resData.size) || buffer.length
    };
  }

  /**
   * Downloads a media file from Hyperflow CDN and uploads it to Google Drive in the organized hierarchy
   */
  public static async processAndUploadMedia(params: {
    sourceUrl: string;
    filename?: string;
    mimeType?: string;
    mediaType: 'image' | 'video' | 'document' | 'other';
    manufacturer?: string;
    clientName: string;
    clientPhone: string;
    isWarranty?: boolean;
    conversationId?: string;
    accessToken: string;
    rootFolderId?: string;
  }): Promise<DriveAuditEntry> {
    const {
      sourceUrl,
      filename,
      mimeType,
      mediaType,
      manufacturer = 'Deye',
      clientName,
      clientPhone,
      isWarranty = true,
      conversationId,
      accessToken,
      rootFolderId
    } = params;

    const subfolder: 'Testes' | 'Documentos' = (mediaType === 'document' || String(filename || '').toLowerCase().endsWith('.pdf'))
      ? 'Documentos'
      : 'Testes';

    let resolvedFilename = filename;
    if (!resolvedFilename) {
      const urlExt = sourceUrl.split('?')[0].split('.').pop() || '';
      const dateTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      if (mediaType === 'image') resolvedFilename = `Foto_${dateTag}.${urlExt || 'jpg'}`;
      else if (mediaType === 'video') resolvedFilename = `Video_${dateTag}.${urlExt || 'mp4'}`;
      else if (mediaType === 'document') resolvedFilename = `Documento_${dateTag}.pdf`;
      else resolvedFilename = `Arquivo_${dateTag}`;
    }

    try {
      // 1. Fetch file content from Hyperflow storage
      const fetchHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (TARS Solar Agenda Extension)'
      };
      const mediaRes = await fetch(sourceUrl, { headers: fetchHeaders });
      if (!mediaRes.ok) {
        throw new Error(`Failed to download media from Hyperflow CDN: HTTP ${mediaRes.status}`);
      }
      const arrayBuffer = await mediaRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const detectedMime = mimeType || mediaRes.headers.get('content-type') || 'application/octet-stream';

      // 2. Resolve Target Folder Hierarchy on Google Drive
      const { folderId, fullPath } = await this.resolveTargetFolder({
        manufacturer,
        clientName,
        clientPhone,
        subfolder,
        rootFolderId,
        accessToken
      });

      // 3. Upload File to Google Drive
      const uploadResult = await this.uploadFileBuffer({
        filename: resolvedFilename,
        mimeType: detectedMime,
        buffer,
        parentFolderId: folderId,
        accessToken
      });

      // 4. Record Audit Log
      const audit = this.recordAudit({
        sourceUrl,
        filename: resolvedFilename,
        mediaType,
        targetFolder: subfolder,
        manufacturer,
        clientName,
        clientPhone,
        resolvedPath: fullPath,
        fileId: uploadResult.fileId,
        webViewLink: uploadResult.webViewLink,
        fileSize: uploadResult.size,
        status: 'SUCCESS',
        conversationId
      });

      return audit;
    } catch (err: any) {
      const audit = this.recordAudit({
        sourceUrl,
        filename: resolvedFilename,
        mediaType,
        targetFolder: subfolder,
        manufacturer,
        clientName,
        clientPhone,
        resolvedPath: `[Error Path] ~${manufacturer}~/...`,
        status: 'FAILED',
        reason: String(err?.message || err),
        conversationId
      });
      return audit;
    }
  }
}
