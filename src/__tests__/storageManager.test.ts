import { StorageManager } from '../storageManager.js';
import fs from 'fs/promises';
import path from 'path';
import { jest } from '@jest/globals';

describe('StorageManager', () => {
  let storage: StorageManager;
  const testDir = path.join(process.cwd(), '.test-storage');
  
  beforeEach(async () => {
    storage = new StorageManager({ baseDir: testDir });
    await storage.initialize();
  });
  
  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });
  
  describe('initialize', () => {
    it('should create directory structure', async () => {
      const dirs = ['cache', 'analysis', 'reports', 'mappings', 'sessions'];
      
      for (const dir of dirs) {
        const dirPath = path.join(testDir, dir);
        const stats = await fs.stat(dirPath);
        expect(stats.isDirectory()).toBe(true);
      }
    });
  });
  
  describe('store and retrieve', () => {
    it('should store and retrieve data', async () => {
      const testData = { foo: 'bar', count: 42 };
      const id = await storage.store('cache', 'test-key', testData);
      
      expect(id).toBeTruthy();
      
      const retrieved = await storage.retrieve('cache', id);
      expect(retrieved).toBeTruthy();
      expect(retrieved?.data).toEqual(testData);
    });
    
    it('should retrieve by key', async () => {
      const testData = { test: 'data' };
      await storage.store('cache', 'unique-key', testData);
      
      const retrieved = await storage.retrieve('cache', 'unique-key');
      expect(retrieved?.data).toEqual(testData);
    });
    
    it('should handle TTL expiration', async () => {
      const testData = { expires: 'soon' };
      const id = await storage.store('cache', 'ttl-test', testData, {}, 100); // 100ms TTL
      
      // Should exist immediately
      let retrieved = await storage.retrieve('cache', id);
      expect(retrieved).toBeTruthy();
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 150));
      
      retrieved = await storage.retrieve('cache', id);
      expect(retrieved).toBeNull();
    });
    
    it('should store with metadata', async () => {
      const testData = { value: 123 };
      const metadata = { source: 'test', version: 1 };
      
      const id = await storage.store('analysis', 'meta-test', testData, metadata);
      const retrieved = await storage.retrieve('analysis', id);
      
      expect(retrieved?.metadata.source).toBe('test');
      expect(retrieved?.metadata.version).toBe(1);
    });
  });
  
  describe('list', () => {
    it('should list stored items', async () => {
      await storage.store('cache', 'item1', { a: 1 });
      await storage.store('cache', 'item2', { b: 2 });
      await storage.store('cache', 'item3', { c: 3 });
      
      const items = await storage.list('cache');
      expect(items.length).toBe(3);
    });
    
    it('should filter items by metadata', async () => {
      await storage.store('cache', 'item1', { a: 1 }, { project: 'A' });
      await storage.store('cache', 'item2', { b: 2 }, { project: 'B' });
      await storage.store('cache', 'item3', { c: 3 }, { project: 'A' });
      
      const itemsA = await storage.list('cache', { project: 'A' });
      expect(itemsA.length).toBe(2);
      
      const itemsB = await storage.list('cache', { project: 'B' });
      expect(itemsB.length).toBe(1);
    });
    
    it('should sort by timestamp descending', async () => {
      await storage.store('cache', 'old', { a: 1 });
      await new Promise(resolve => setTimeout(resolve, 10));
      await storage.store('cache', 'new', { b: 2 });
      
      const items = await storage.list('cache');
      expect(items[0].metadata.key).toBe('new');
      expect(items[1].metadata.key).toBe('old');
    });
  });
  
  describe('storeDataset and retrieveDataset', () => {
    it('should handle large datasets in chunks', async () => {
      const largeData = Array.from({ length: 2500 }, (_, i) => ({
        id: i,
        value: `item-${i}`
      }));
      
      const datasetId = await storage.storeDataset('large-dataset', largeData, 1000);
      expect(datasetId).toBeTruthy();
      
      const retrieved = await storage.retrieveDataset('large-dataset');
      expect(retrieved).toHaveLength(2500);
      expect(retrieved?.[0]).toEqual({ id: 0, value: 'item-0' });
      expect(retrieved?.[2499]).toEqual({ id: 2499, value: 'item-2499' });
    });
    
    it('should store dataset metadata', async () => {
      const data = [1, 2, 3, 4, 5];
      const metadata = { source: 'test', type: 'numbers' };
      
      await storage.storeDataset('meta-dataset', data, 2, metadata);
      
      const manifest = await storage.retrieve('cache', 'dataset-meta-dataset');
      expect(manifest?.data.metadata).toEqual(metadata);
      expect(manifest?.data.totalItems).toBe(5);
      expect(manifest?.data.chunkSize).toBe(2);
    });
  });
  
  describe('session management', () => {
    it('should create and update sessions', async () => {
      const sessionId = await storage.createSession('test-session', { initial: 'data' });
      expect(sessionId).toBeTruthy();
      
      let session = await storage.retrieve('session', sessionId);
      expect(session?.data.data.initial).toBe('data');
      
      await storage.updateSession(sessionId, { additional: 'info' });
      
      session = await storage.retrieve('session', sessionId);
      expect(session?.data.data.additional).toBe('info');
      expect(session?.data.data.lastUpdated).toBeTruthy();
    });
    
    it('should track session steps', async () => {
      const sessionId = await storage.createSession('multi-step', {});
      
      await storage.updateSession(sessionId, {
        steps: ['step1', 'step2']
      });
      
      const session = await storage.retrieve('session', sessionId);
      expect(session?.data.data.steps).toEqual(['step1', 'step2']);
    });
  });
  
  describe('storeReport', () => {
    it('should store JSON reports', async () => {
      const reportData = { metrics: { total: 100 }, summary: 'test' };
      const reportId = await storage.storeReport('test-report', reportData, 'json');
      
      const report = await storage.retrieve('report', reportId);
      expect(report?.data).toEqual(reportData);
      expect(report?.metadata.format).toBe('json');
    });
    
    it('should convert array to CSV', async () => {
      const data = [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 }
      ];
      
      const reportId = await storage.storeReport('csv-report', data, 'csv');
      const report = await storage.retrieve('report', reportId);
      
      expect(report?.data).toContain('name,age');
      expect(report?.data).toContain('"Alice",30');
      expect(report?.data).toContain('"Bob",25');
    });
    
    it('should convert to markdown', async () => {
      const data = [
        { id: 1, status: 'active' },
        { id: 2, status: 'inactive' }
      ];
      
      const reportId = await storage.storeReport('md-report', data, 'markdown');
      const report = await storage.retrieve('report', reportId);
      
      expect(report?.data).toContain('| id | status |');
      expect(report?.data).toContain('| --- | --- |');
      expect(report?.data).toContain('| 1 | active |');
    });
  });
  
  describe('cleanupExpired', () => {
    it('should remove expired items', async () => {
      // Store items with short TTL
      await storage.store('cache', 'expires1', { a: 1 }, {}, 50);
      await storage.store('cache', 'expires2', { b: 2 }, {}, 50);
      await storage.store('cache', 'permanent', { c: 3 }); // No short TTL
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const cleaned = await storage.cleanupExpired();
      expect(cleaned).toBe(2);
      
      const items = await storage.list('cache');
      expect(items.length).toBe(1);
      expect(items[0].metadata.key).toBe('permanent');
    });
  });
  
  describe('getStats', () => {
    it('should return storage statistics', async () => {
      await storage.store('cache', 'item1', { data: 'test' });
      await storage.store('analysis', 'item2', { result: 123 });
      await storage.store('report', 'item3', { summary: 'report' });
      
      const stats = await storage.getStats();
      
      expect(stats.byType.cache.count).toBe(1);
      expect(stats.byType.analysis.count).toBe(1);
      expect(stats.byType.report.count).toBe(1);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.oldestItem).toBeTruthy();
      expect(stats.newestItem).toBeTruthy();
    });
  });
  
  describe('storeAnalysis', () => {
    it('should store analysis with relationships', async () => {
      const analysisData = { score: 95, issues: [] };
      const relationships = ['session-123', 'dataset-456'];
      
      const id = await storage.storeAnalysis(
        'quality-check',
        analysisData,
        relationships,
        { project: 'test' }
      );
      
      const analysis = await storage.retrieve('analysis', id);
      expect(analysis?.data).toEqual(analysisData);
      expect(analysis?.metadata.relationships).toEqual(relationships);
      expect(analysis?.metadata.analysisType).toBe('quality-check');
    });
  });
});