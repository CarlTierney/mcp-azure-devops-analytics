import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export interface StorageConfig {
  baseDir?: string;
  maxCacheAge?: number; // milliseconds
  maxFileSize?: number; // bytes
}

export interface StoredData {
  id: string;
  type: 'cache' | 'analysis' | 'report' | 'mapping' | 'session';
  project?: string;
  timestamp: string;
  expiresAt?: string;
  metadata: Record<string, any>;
  data: any;
}

export class StorageManager {
  private baseDir: string;
  private maxCacheAge: number;
  private maxFileSize: number;
  
  constructor(config: StorageConfig = {}) {
    this.baseDir = config.baseDir || path.join(process.cwd(), '.mcp-analytics-cache');
    this.maxCacheAge = config.maxCacheAge || 24 * 60 * 60 * 1000; // 24 hours default
    this.maxFileSize = config.maxFileSize || 50 * 1024 * 1024; // 50MB default
  }
  
  async initialize(): Promise<void> {
    // Create directory structure
    const dirs = [
      this.baseDir,
      path.join(this.baseDir, 'cache'),
      path.join(this.baseDir, 'analysis'),
      path.join(this.baseDir, 'reports'),
      path.join(this.baseDir, 'mappings'),
      path.join(this.baseDir, 'sessions')
    ];
    
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
    
    // Clean up expired files on initialization
    await this.cleanupExpired();
  }
  
  /**
   * Store data with automatic categorization and indexing
   */
  async store(
    type: StoredData['type'],
    key: string,
    data: any,
    metadata: Record<string, any> = {},
    ttl?: number
  ): Promise<string> {
    const id = this.generateId(key);
    const timestamp = new Date().toISOString();
    const expiresAt = ttl 
      ? new Date(Date.now() + ttl).toISOString()
      : new Date(Date.now() + this.maxCacheAge).toISOString();
    
    const storedData: StoredData = {
      id,
      type,
      timestamp,
      expiresAt,
      metadata: {
        ...metadata,
        key,
        size: JSON.stringify(data).length
      },
      data
    };
    
    // Ensure directory exists
    const dir = path.join(this.baseDir, type);
    await fs.mkdir(dir, { recursive: true });
    
    const filePath = path.join(dir, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(storedData, null, 2));
    
    // Update index
    await this.updateIndex(type, id, key, metadata);
    
    return id;
  }
  
  /**
   * Retrieve stored data
   */
  async retrieve(type: StoredData['type'], keyOrId: string): Promise<StoredData | null> {
    try {
      // Try as ID first
      let filePath = path.join(this.baseDir, type, `${keyOrId}.json`);
      
      // If not found, try to find by key
      if (!await this.fileExists(filePath)) {
        const id = await this.findIdByKey(type, keyOrId);
        if (!id) return null;
        filePath = path.join(this.baseDir, type, `${id}.json`);
      }
      
      const content = await fs.readFile(filePath, 'utf-8');
      const storedData = JSON.parse(content) as StoredData;
      
      // Check if expired
      if (storedData.expiresAt && new Date(storedData.expiresAt) < new Date()) {
        await fs.unlink(filePath);
        return null;
      }
      
      return storedData;
    } catch (error) {
      return null;
    }
  }
  
  /**
   * List stored items of a specific type
   */
  async list(type: StoredData['type'], filter?: Record<string, any>): Promise<StoredData[]> {
    const dir = path.join(this.baseDir, type);
    
    // Check if directory exists
    try {
      await fs.access(dir);
    } catch {
      return []; // Return empty array if directory doesn't exist
    }
    
    const files = await fs.readdir(dir);
    const items: StoredData[] = [];
    
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'index.json') continue;
      
      try {
        const content = await fs.readFile(path.join(dir, file), 'utf-8');
        const item = JSON.parse(content) as StoredData;
        
        // Check expiration
        if (item.expiresAt && new Date(item.expiresAt) < new Date()) {
          await fs.unlink(path.join(dir, file));
          continue;
        }
        
        // Apply filter
        if (filter) {
          let matches = true;
          for (const [key, value] of Object.entries(filter)) {
            if (item.metadata[key] !== value) {
              matches = false;
              break;
            }
          }
          if (!matches) continue;
        }
        
        items.push(item);
      } catch (error) {
        // Skip invalid files
        continue;
      }
    }
    
    return items.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }
  
  /**
   * Store large dataset in chunks
   */
  async storeDataset(
    key: string,
    data: any[],
    chunkSize: number = 1000,
    metadata: Record<string, any> = {}
  ): Promise<string> {
    const datasetId = this.generateId(`dataset-${key}`);
    const chunks: string[] = [];
    
    // Split data into chunks
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      const chunkId = await this.store(
        'cache',
        `${key}-chunk-${i}`,
        chunk,
        {
          ...metadata,
          datasetId,
          chunkIndex: i / chunkSize,
          totalChunks: Math.ceil(data.length / chunkSize)
        }
      );
      chunks.push(chunkId);
    }
    
    // Store dataset manifest
    await this.store('cache', `dataset-${key}`, {
      datasetId,
      key,
      totalItems: data.length,
      chunkSize,
      chunks,
      metadata
    }, metadata);
    
    return datasetId;
  }
  
  /**
   * Retrieve large dataset from chunks
   */
  async retrieveDataset(key: string): Promise<any[] | null> {
    const manifest = await this.retrieve('cache', `dataset-${key}`);
    if (!manifest) return null;
    
    const data: any[] = [];
    for (const chunkId of manifest.data.chunks) {
      const chunk = await this.retrieve('cache', chunkId);
      if (chunk) {
        data.push(...chunk.data);
      }
    }
    
    return data;
  }
  
  /**
   * Store analysis results with relationships
   */
  async storeAnalysis(
    analysisType: string,
    results: any,
    relationships: string[] = [],
    metadata: Record<string, any> = {}
  ): Promise<string> {
    return this.store('analysis', analysisType, results, {
      ...metadata,
      analysisType,
      relationships,
      timestamp: new Date().toISOString()
    });
  }
  
  /**
   * Create a session for multi-step operations
   */
  async createSession(sessionType: string, initialData: any = {}): Promise<string> {
    const sessionId = this.generateId(`session-${sessionType}`);
    await this.store('session', sessionId, {
      sessionId,
      sessionType,
      state: 'active',
      steps: [],
      data: initialData,
      createdAt: new Date().toISOString()
    }, { sessionType });
    
    return sessionId;
  }
  
  /**
   * Update session data
   */
  async updateSession(sessionId: string, updates: any): Promise<void> {
    const session = await this.retrieve('session', sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    
    session.data = {
      ...session.data,
      ...updates,
      lastUpdated: new Date().toISOString()
    };
    
    const filePath = path.join(this.baseDir, 'session', `${sessionId}.json`);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2));
  }
  
  /**
   * Generate report and store it
   */
  async storeReport(
    reportType: string,
    content: any,
    format: 'json' | 'csv' | 'markdown' = 'json',
    metadata: Record<string, any> = {}
  ): Promise<string> {
    const reportId = this.generateId(`report-${reportType}`);
    
    let formattedContent = content;
    if (format === 'csv' && Array.isArray(content)) {
      formattedContent = this.arrayToCsv(content);
    } else if (format === 'markdown') {
      formattedContent = this.jsonToMarkdown(content);
    }
    
    await this.store('report', reportId, formattedContent, {
      ...metadata,
      reportType,
      format,
      timestamp: new Date().toISOString()
    });
    
    return reportId;
  }
  
  /**
   * Clean up expired files
   */
  async cleanupExpired(): Promise<number> {
    let cleaned = 0;
    const types: StoredData['type'][] = ['cache', 'analysis', 'report', 'mapping', 'session'];
    
    for (const type of types) {
      const items = await this.list(type);
      for (const item of items) {
        if (item.expiresAt && new Date(item.expiresAt) < new Date()) {
          const filePath = path.join(this.baseDir, type, `${item.id}.json`);
          await fs.unlink(filePath);
          cleaned++;
        }
      }
    }
    
    return cleaned;
  }
  
  /**
   * Get storage statistics
   */
  async getStats(): Promise<Record<string, any>> {
    const stats: Record<string, any> = {
      totalSize: 0,
      byType: {},
      oldestItem: null,
      newestItem: null
    };
    
    const types: StoredData['type'][] = ['cache', 'analysis', 'report', 'mapping', 'session'];
    
    for (const type of types) {
      const items = await this.list(type);
      stats.byType[type] = {
        count: items.length,
        size: 0
      };
      
      for (const item of items) {
        const size = item.metadata.size || 0;
        stats.byType[type].size += size;
        stats.totalSize += size;
        
        if (!stats.oldestItem || new Date(item.timestamp) < new Date(stats.oldestItem.timestamp)) {
          stats.oldestItem = { type, timestamp: item.timestamp, id: item.id };
        }
        
        if (!stats.newestItem || new Date(item.timestamp) > new Date(stats.newestItem.timestamp)) {
          stats.newestItem = { type, timestamp: item.timestamp, id: item.id };
        }
      }
    }
    
    return stats;
  }
  
  // Helper methods
  
  private generateId(key: string): string {
    const hash = crypto.createHash('md5').update(key).digest('hex');
    return `${hash.substring(0, 8)}-${Date.now()}`;
  }
  
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  
  private async findIdByKey(type: string, key: string): Promise<string | null> {
    const indexPath = path.join(this.baseDir, type, 'index.json');
    if (!await this.fileExists(indexPath)) return null;
    
    try {
      const index = JSON.parse(await fs.readFile(indexPath, 'utf-8'));
      return index[key] || null;
    } catch {
      return null;
    }
  }
  
  private async updateIndex(type: string, id: string, key: string, metadata: Record<string, any>): Promise<void> {
    const indexPath = path.join(this.baseDir, type, 'index.json');
    let index: Record<string, any> = {};
    
    if (await this.fileExists(indexPath)) {
      try {
        index = JSON.parse(await fs.readFile(indexPath, 'utf-8'));
      } catch {
        index = {};
      }
    }
    
    index[key] = id;
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  }
  
  private arrayToCsv(data: any[]): string {
    if (data.length === 0) return '';
    
    const headers = Object.keys(data[0]);
    const csv = [
      headers.join(','),
      ...data.map(row => 
        headers.map(header => 
          JSON.stringify(row[header] || '')
        ).join(',')
      )
    ];
    
    return csv.join('\n');
  }
  
  private jsonToMarkdown(data: any): string {
    if (typeof data === 'string') return data;
    
    let markdown = '';
    
    if (Array.isArray(data)) {
      if (data.length > 0 && typeof data[0] === 'object') {
        // Table format
        const headers = Object.keys(data[0]);
        markdown += '| ' + headers.join(' | ') + ' |\n';
        markdown += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
        data.forEach(row => {
          markdown += '| ' + headers.map(h => row[h] || '').join(' | ') + ' |\n';
        });
      } else {
        // List format
        data.forEach(item => {
          markdown += `- ${item}\n`;
        });
      }
    } else if (typeof data === 'object') {
      // Key-value format
      Object.entries(data).forEach(([key, value]) => {
        markdown += `**${key}**: ${JSON.stringify(value)}\n`;
      });
    }
    
    return markdown;
  }
}