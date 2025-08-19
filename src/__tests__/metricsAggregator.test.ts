import { MetricsAggregator } from '../metricsAggregator.js';
import { AzureDevOpsClient } from '../azureDevOpsClient.js';
import { StorageManager } from '../storageManager.js';
import { jest } from '@jest/globals';

// Mock the dependencies
jest.mock('../azureDevOpsClient.js');
jest.mock('../storageManager.js');

describe('MetricsAggregator', () => {
  let aggregator: MetricsAggregator;
  let mockClient: jest.Mocked<AzureDevOpsClient>;
  let mockStorage: jest.Mocked<StorageManager>;
  
  beforeEach(() => {
    // Create mocked instances
    mockClient = new AzureDevOpsClient({
      orgUrl: 'https://test.com',
      pat: 'test-pat'
    }) as jest.Mocked<AzureDevOpsClient>;
    
    mockStorage = new StorageManager() as jest.Mocked<StorageManager>;
    mockStorage.store = jest.fn().mockResolvedValue('stored') as any;
    
    aggregator = new MetricsAggregator(mockClient, mockStorage);
  });
  
  describe('calculateSprintMetrics', () => {
    it('should calculate velocity and completion rate', async () => {
      // Mock iterations
      mockClient.getIterations = jest.fn().mockResolvedValue({
        value: [{
          IterationSK: 'iter-1',
          IterationPath: 'Sprint 1',
          StartDateSK: '2024-01-01',
          EndDateSK: '2024-01-14'
        }]
      }) as any;
      
      // Mock work items in sprint
      mockClient.queryAnalytics = jest.fn().mockResolvedValue({
        value: [
          { WorkItemId: 1, State: 'Done', StoryPoints: 5 },
          { WorkItemId: 2, State: 'Done', StoryPoints: 3 },
          { WorkItemId: 3, State: 'Active', StoryPoints: 2 }
        ]
      }) as any;
      
      const metrics = await aggregator.calculateSprintMetrics('TestProject');
      
      expect(metrics).toHaveLength(1);
      expect(metrics[0].velocity).toBe(8); // 5 + 3
      expect(metrics[0].committedStoryPoints).toBe(10); // 5 + 3 + 2
      expect(metrics[0].completionRate).toBe(80); // 8/10 * 100
      expect(metrics[0].carryOverPoints).toBe(2);
    });
    
    it('should handle sprints with no work items', async () => {
      mockClient.getIterations = jest.fn().mockResolvedValue({
        value: [{
          IterationSK: 'iter-1',
          IterationPath: 'Sprint 1'
        }]
      }) as any;
      
      mockClient.queryAnalytics = jest.fn().mockResolvedValue({
        value: []
      }) as any;
      
      const metrics = await aggregator.calculateSprintMetrics('TestProject');
      
      expect(metrics[0].velocity).toBe(0);
      expect(metrics[0].completionRate).toBe(0);
    });
  });
  
  describe('calculateFlowMetrics', () => {
    it('should calculate cycle time and lead time metrics', async () => {
      const dateRange = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-31')
      };
      
      mockClient.getWorkItemSnapshots = jest.fn().mockResolvedValue({
        value: [
          { WorkItemId: 1, State: 'Done', CycleTimeDays: 5, LeadTimeDays: 10 },
          { WorkItemId: 2, State: 'Done', CycleTimeDays: 3, LeadTimeDays: 7 },
          { WorkItemId: 3, State: 'Active', CycleTimeDays: 2 },
          { WorkItemId: 4, State: 'In Progress' }
        ]
      }) as any;
      
      const metrics = await aggregator.calculateFlowMetrics('TestProject', dateRange);
      
      expect(metrics.cycleTime.average).toBe(4); // (5 + 3) / 2
      expect(metrics.leadTime.average).toBe(8.5); // (10 + 7) / 2
      expect(metrics.wip.current).toBe(2); // Active + In Progress
      expect(metrics.throughput.daily).toBeGreaterThan(0);
    });
    
    it('should handle empty work item data', async () => {
      const dateRange = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-31')
      };
      
      mockClient.getWorkItemSnapshots = jest.fn().mockResolvedValue({
        value: []
      }) as any;
      
      const metrics = await aggregator.calculateFlowMetrics('TestProject', dateRange);
      
      expect(metrics.cycleTime.average).toBe(0);
      expect(metrics.leadTime.average).toBe(0);
      expect(metrics.wip.current).toBe(0);
      expect(metrics.throughput.daily).toBe(0);
    });
    
    it('should calculate flow efficiency', async () => {
      const dateRange = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-31')
      };
      
      mockClient.getWorkItemSnapshots = jest.fn().mockResolvedValue({
        value: [
          { WorkItemId: 1, State: 'Done', CycleTimeDays: 2, LeadTimeDays: 10 },
          { WorkItemId: 2, State: 'Done', CycleTimeDays: 3, LeadTimeDays: 10 }
        ]
      }) as any;
      
      const metrics = await aggregator.calculateFlowMetrics('TestProject', dateRange);
      
      // Flow efficiency = (avg cycle time / avg lead time) * 100
      // = (2.5 / 10) * 100 = 25%
      expect(metrics.flowEfficiency).toBe(25);
    });
  });
  
  describe('calculateDoraMetrics', () => {
    it('should calculate and classify DORA metrics', async () => {
      const dateRange = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-31')
      };
      
      const metrics = await aggregator.calculateDoraMetrics('TestProject', dateRange);
      
      expect(metrics.deploymentFrequency).toBeDefined();
      expect(metrics.deploymentFrequency.classification).toMatch(/elite|high|medium|low/);
      
      expect(metrics.leadTimeForChanges).toBeDefined();
      expect(metrics.leadTimeForChanges.classification).toMatch(/elite|high|medium|low/);
      
      expect(metrics.mttr).toBeDefined();
      expect(metrics.mttr.classification).toMatch(/elite|high|medium|low/);
      
      expect(metrics.changeFailureRate).toBeDefined();
      expect(metrics.changeFailureRate.classification).toMatch(/elite|high|medium|low/);
    });
    
    it('should classify deployment frequency correctly', async () => {
      const dateRange = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-31')
      };
      
      // Test will use default mock values from the implementation
      const metrics = await aggregator.calculateDoraMetrics('TestProject', dateRange);
      
      // Default mock returns 1.5 deployments per day = elite
      expect(metrics.deploymentFrequency.deploymentsPerDay).toBe(1.5);
      expect(metrics.deploymentFrequency.classification).toBe('elite');
    });
  });
  
  describe('getCumulativeFlow', () => {
    it('should generate daily cumulative flow data', async () => {
      const dateRange = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-03')
      };
      
      mockClient.queryAnalytics = jest.fn().mockResolvedValue({
        value: [
          { State: 'New', Count: 10 },
          { State: 'Active', Count: 5 },
          { State: 'Done', Count: 15 }
        ]
      }) as any;
      
      const result = await aggregator.getCumulativeFlow('TestProject', dateRange, 'daily');
      
      expect(result.data).toBeDefined();
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data[0].states).toBeDefined();
      expect(result.data[0].total).toBe(30); // 10 + 5 + 15
      expect(result.bottlenecks).toBeDefined();
    });
    
    it('should generate weekly cumulative flow data', async () => {
      const dateRange = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-15')
      };
      
      mockClient.queryAnalytics = jest.fn().mockResolvedValue({
        value: [
          { State: 'New', Count: 20 },
          { State: 'Done', Count: 30 }
        ]
      }) as any;
      
      const result = await aggregator.getCumulativeFlow('TestProject', dateRange, 'weekly');
      
      expect(result.data).toBeDefined();
      expect(result.data.length).toBeGreaterThan(0);
    });
  });
  
  describe('Storage integration', () => {
    it('should cache sprint metrics', async () => {
      mockClient.getIterations = jest.fn().mockResolvedValue({
        value: [{
          IterationSK: 'iter-1',
          IterationPath: 'Sprint 1'
        }]
      }) as any;
      
      mockClient.queryAnalytics = jest.fn().mockResolvedValue({
        value: []
      }) as any;
      
      await aggregator.calculateSprintMetrics('TestProject');
      
      expect(mockStorage.store).toHaveBeenCalledWith(
        'analysis',
        'sprint-metrics-TestProject',
        expect.any(Array),
        expect.objectContaining({ project: 'TestProject' }),
        3600000
      );
    });
    
    it('should cache flow metrics', async () => {
      const dateRange = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-31')
      };
      
      mockClient.getWorkItemSnapshots = jest.fn().mockResolvedValue({
        value: []
      }) as any;
      
      await aggregator.calculateFlowMetrics('TestProject', dateRange);
      
      expect(mockStorage.store).toHaveBeenCalledWith(
        'analysis',
        'flow-metrics-TestProject',
        expect.any(Object),
        expect.objectContaining({ project: 'TestProject', dateRange }),
        3600000
      );
    });
    
    it('should cache DORA metrics', async () => {
      const dateRange = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-31')
      };
      
      await aggregator.calculateDoraMetrics('TestProject', dateRange);
      
      expect(mockStorage.store).toHaveBeenCalledWith(
        'analysis',
        'dora-metrics-TestProject',
        expect.any(Object),
        expect.objectContaining({ project: 'TestProject', dateRange }),
        3600000
      );
    });
  });
});