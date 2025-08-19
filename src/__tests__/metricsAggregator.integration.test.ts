import { MetricsAggregator } from '../metricsAggregator.js';
import { AzureDevOpsClient } from '../azureDevOpsClient.js';
import { StorageManager } from '../storageManager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Skip tests if no credentials are configured
const skipTests = !process.env.AZURE_DEVOPS_ORG_URL || !process.env.AZURE_DEVOPS_PAT;

describe.skipIf(skipTests)('MetricsAggregator Integration Tests', () => {
  let aggregator: MetricsAggregator;
  let client: AzureDevOpsClient;
  let storage: StorageManager;
  const testProject = process.env.AZURE_DEVOPS_PROJECT;
  
  beforeAll(async () => {
    if (!testProject) {
      console.warn('No project specified in AZURE_DEVOPS_PROJECT, some tests may be skipped');
    }
    
    client = new AzureDevOpsClient({
      orgUrl: process.env.AZURE_DEVOPS_ORG_URL!,
      pat: process.env.AZURE_DEVOPS_PAT!,
      project: testProject
    });
    
    // Use test-specific cache directory
    const cacheDir = path.join(__dirname, '../../.test-cache');
    storage = new StorageManager({ baseDir: cacheDir });
    await storage.initialize();
    
    aggregator = new MetricsAggregator(client, storage);
  });
  
  afterAll(async () => {
    // Clean up test cache
    await storage.cleanup();
  });
  
  describe('Sprint Metrics (READ-ONLY)', () => {
    it.skipIf(!testProject)('should retrieve sprint metrics for current project', async () => {
      const metrics = await aggregator.calculateSprintMetrics(testProject!, undefined, 1);
      
      expect(metrics).toBeDefined();
      expect(Array.isArray(metrics)).toBe(true);
      
      if (metrics.length > 0) {
        const sprint = metrics[0];
        expect(sprint.sprintName).toBeTruthy();
        expect(typeof sprint.velocity).toBe('number');
        expect(typeof sprint.completionRate).toBe('number');
        expect(sprint.completionRate).toBeGreaterThanOrEqual(0);
        expect(sprint.completionRate).toBeLessThanOrEqual(100);
      }
    }, 30000);
    
    it.skipIf(!testProject)('should handle multiple sprints', async () => {
      const metrics = await aggregator.calculateSprintMetrics(testProject!, undefined, 3);
      
      expect(metrics).toBeDefined();
      expect(Array.isArray(metrics)).toBe(true);
      expect(metrics.length).toBeLessThanOrEqual(3);
      
      // Verify each sprint has required fields
      metrics.forEach(sprint => {
        expect(sprint.sprintId).toBeTruthy();
        expect(sprint.sprintName).toBeTruthy();
        expect(typeof sprint.velocity).toBe('number');
        expect(typeof sprint.committedStoryPoints).toBe('number');
      });
    }, 30000);
  });
  
  describe('Flow Metrics (READ-ONLY)', () => {
    it.skipIf(!testProject)('should calculate flow metrics for date range', async () => {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30); // Last 30 days
      
      const metrics = await aggregator.calculateFlowMetrics(
        testProject!,
        { start: startDate, end: endDate }
      );
      
      expect(metrics).toBeDefined();
      expect(metrics.cycleTime).toBeDefined();
      expect(typeof metrics.cycleTime.average).toBe('number');
      expect(typeof metrics.cycleTime.median).toBe('number');
      
      expect(metrics.leadTime).toBeDefined();
      expect(typeof metrics.leadTime.average).toBe('number');
      
      expect(metrics.throughput).toBeDefined();
      expect(typeof metrics.throughput.daily).toBe('number');
      expect(typeof metrics.throughput.weekly).toBe('number');
      
      expect(metrics.wip).toBeDefined();
      expect(typeof metrics.wip.current).toBe('number');
      
      expect(typeof metrics.flowEfficiency).toBe('number');
    }, 30000);
    
    it.skipIf(!testProject)('should handle empty date ranges gracefully', async () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);
      
      const metrics = await aggregator.calculateFlowMetrics(
        testProject!,
        { start: futureDate, end: futureDate }
      );
      
      expect(metrics).toBeDefined();
      expect(metrics.cycleTime.average).toBe(0);
      expect(metrics.leadTime.average).toBe(0);
      expect(metrics.throughput.daily).toBe(0);
    }, 30000);
  });
  
  describe('DORA Metrics (READ-ONLY)', () => {
    it.skipIf(!testProject)('should calculate DORA metrics', async () => {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);
      
      const metrics = await aggregator.calculateDoraMetrics(
        testProject!,
        { start: startDate, end: endDate }
      );
      
      expect(metrics).toBeDefined();
      
      // Deployment Frequency
      expect(metrics.deploymentFrequency).toBeDefined();
      expect(typeof metrics.deploymentFrequency.deploymentsPerDay).toBe('number');
      expect(metrics.deploymentFrequency.classification).toMatch(/elite|high|medium|low/);
      
      // Lead Time for Changes
      expect(metrics.leadTimeForChanges).toBeDefined();
      expect(typeof metrics.leadTimeForChanges.hours).toBe('number');
      expect(metrics.leadTimeForChanges.classification).toMatch(/elite|high|medium|low/);
      
      // MTTR
      expect(metrics.mttr).toBeDefined();
      expect(typeof metrics.mttr.minutes).toBe('number');
      expect(metrics.mttr.classification).toMatch(/elite|high|medium|low/);
      
      // Change Failure Rate
      expect(metrics.changeFailureRate).toBeDefined();
      expect(typeof metrics.changeFailureRate.percentage).toBe('number');
      expect(metrics.changeFailureRate.classification).toMatch(/elite|high|medium|low/);
    }, 30000);
  });
  
  describe('Cumulative Flow Diagram (READ-ONLY)', () => {
    it.skipIf(!testProject)('should generate cumulative flow data', async () => {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7); // Last week
      
      const result = await aggregator.getCumulativeFlow(
        testProject!,
        { start: startDate, end: endDate },
        'daily'
      );
      
      expect(result).toBeDefined();
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      
      if (result.data.length > 0) {
        const day = result.data[0];
        expect(day.date).toBeTruthy();
        expect(day.states).toBeDefined();
        expect(typeof day.total).toBe('number');
      }
      
      expect(result.bottlenecks).toBeDefined();
      expect(Array.isArray(result.bottlenecks)).toBe(true);
    }, 30000);
    
    it.skipIf(!testProject)('should generate weekly cumulative flow data', async () => {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 28); // Last 4 weeks
      
      const result = await aggregator.getCumulativeFlow(
        testProject!,
        { start: startDate, end: endDate },
        'weekly'
      );
      
      expect(result).toBeDefined();
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
    }, 30000);
  });
  
  describe('Storage and Caching (READ-ONLY)', () => {
    it('should cache metrics results', async () => {
      if (!testProject) {
        console.log('Skipping cache test - no project configured');
        return;
      }
      
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);
      
      // First call - should cache
      const metrics1 = await aggregator.calculateFlowMetrics(
        testProject,
        { start: startDate, end: endDate }
      );
      
      // Verify data was cached
      const cached = await storage.retrieve('analysis', `flow-metrics-${testProject}`);
      expect(cached).toBeDefined();
      expect(cached?.data).toBeDefined();
      
      // Second call - should use cache (faster)
      const startTime = Date.now();
      const metrics2 = await aggregator.calculateFlowMetrics(
        testProject,
        { start: startDate, end: endDate }
      );
      const endTime = Date.now();
      
      expect(metrics2).toEqual(metrics1);
      
      // Note: Cache retrieval test would require mocking to verify it's actually used
      console.log(`Second call completed in ${endTime - startTime}ms`);
    }, 30000);
  });
  
  describe('Error Handling (READ-ONLY)', () => {
    it('should handle invalid project names gracefully', async () => {
      const invalidProject = 'NonExistentProject12345';
      
      try {
        await aggregator.calculateSprintMetrics(invalidProject);
      } catch (error: any) {
        expect(error).toBeDefined();
        // Azure DevOps typically returns 404 or 403 for invalid projects
        expect(error.message).toMatch(/404|403|not found|access/i);
      }
    }, 30000);
    
    it('should handle invalid date ranges', async () => {
      if (!testProject) {
        console.log('Skipping invalid date test - no project configured');
        return;
      }
      
      const invalidStart = new Date('invalid');
      const invalidEnd = new Date('invalid');
      
      try {
        await aggregator.calculateFlowMetrics(
          testProject,
          { start: invalidStart, end: invalidEnd }
        );
      } catch (error: any) {
        expect(error).toBeDefined();
      }
    }, 30000);
  });
});