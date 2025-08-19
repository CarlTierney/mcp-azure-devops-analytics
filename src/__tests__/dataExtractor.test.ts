import { DataExtractor } from '../dataExtractor.js';
import { AzureDevOpsClient } from '../azureDevOpsClient.js';
import { StorageManager } from '../storageManager.js';
import { jest } from '@jest/globals';

// Mock the dependencies
jest.mock('../azureDevOpsClient.js');
jest.mock('../storageManager.js');

describe('DataExtractor', () => {
  let extractor: DataExtractor;
  let mockClient: jest.Mocked<AzureDevOpsClient>;
  let mockStorage: jest.Mocked<StorageManager>;
  
  beforeEach(() => {
    // Create mocked instances
    mockClient = new AzureDevOpsClient({
      orgUrl: 'https://test.com',
      pat: 'test-pat'
    }) as jest.Mocked<AzureDevOpsClient>;
    
    mockStorage = new StorageManager() as jest.Mocked<StorageManager>;
    
    // Setup default mock implementations
    mockStorage.createSession = jest.fn().mockResolvedValue('session-123') as any;
    mockStorage.updateSession = jest.fn().mockResolvedValue(undefined) as any;
    mockStorage.storeDataset = jest.fn().mockResolvedValue('dataset-123') as any;
    mockStorage.storeAnalysis = jest.fn().mockResolvedValue('analysis-123') as any;
    mockStorage.storeReport = jest.fn().mockResolvedValue('report-123') as any;
    mockStorage.retrieve = jest.fn().mockResolvedValue({
      data: {
        dataset: {
          data: {
            areas: [],
            teams: [],
            users: [],
            workItems: []
          }
        }
      }
    }) as any;
    
    extractor = new DataExtractor(mockClient, mockStorage);
  });
  
  describe('extractFullDataset', () => {
    it('should extract all entities when "all" is specified', async () => {
      // Setup mocks
      mockClient.getAreas = jest.fn().mockResolvedValue({ value: [{ AreaPath: 'Test\\Area' }] }) as any;
      mockClient.getTeams = jest.fn().mockResolvedValue({ value: [{ TeamName: 'Test Team' }] }) as any;
      mockClient.getUsers = jest.fn().mockResolvedValue({ value: [{ UserName: 'Test User' }] }) as any;
      mockClient.getWorkItemSnapshots = jest.fn().mockResolvedValue({ 
        value: [{ WorkItemId: 1, Title: 'Test' }] 
      }) as any;
      mockClient.queryAnalytics = jest.fn().mockResolvedValue({ value: [] }) as any;
      
      const sessionId = await extractor.extractFullDataset({
        project: 'TestProject',
        entities: ['all']
      });
      
      expect(sessionId).toBe('session-123');
      expect(mockClient.getAreas).toHaveBeenCalledWith('TestProject');
      expect(mockClient.getTeams).toHaveBeenCalledWith('TestProject');
      expect(mockClient.getUsers).toHaveBeenCalledWith('TestProject');
      expect(mockStorage.createSession).toHaveBeenCalled();
      expect(mockStorage.updateSession).toHaveBeenCalled();
    });
    
    it('should extract only specified entities', async () => {
      mockClient.getAreas = jest.fn().mockResolvedValue({ value: [] }) as any;
      mockClient.getTeams = jest.fn().mockResolvedValue({ value: [] }) as any;
      mockClient.getUsers = jest.fn().mockResolvedValue({ value: [] }) as any;
      
      await extractor.extractFullDataset({
        project: 'TestProject',
        entities: ['areas', 'teams']
      });
      
      expect(mockClient.getAreas).toHaveBeenCalled();
      expect(mockClient.getTeams).toHaveBeenCalled();
      expect(mockClient.getUsers).not.toHaveBeenCalled();
    });
    
    it('should handle date range filtering', async () => {
      mockClient.getAreas = jest.fn().mockResolvedValue({ value: [] }) as any;
      mockClient.getWorkItemSnapshots = jest.fn().mockResolvedValue({ value: [] }) as any;
      
      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');
      
      await extractor.extractFullDataset({
        project: 'TestProject',
        entities: ['workitems'],
        dateRange: { start, end }
      });
      
      expect(mockClient.getWorkItemSnapshots).toHaveBeenCalled();
    });
  });
  
  describe('analyzeDataQuality', () => {
    it('should identify unassigned work items', async () => {
      mockStorage.retrieve = jest.fn().mockResolvedValue({
        data: {
          dataset: {
            data: {
              workItems: [
                { WorkItemId: 1, Title: 'No Area', AreaSK: null },
                { WorkItemId: 2, Title: 'Has Area', AreaSK: 'area-123' }
              ],
              users: [],
              teams: [],
              areas: []
            }
          }
        }
      }) as any;
      
      const issues = await extractor.analyzeDataQuality('session-123');
      
      const unassignedIssue = issues.find(i => i.category === 'Work Item Areas');
      expect(unassignedIssue).toBeDefined();
      expect(unassignedIssue?.severity).toBe('critical');
      expect(unassignedIssue?.impact.workItems).toBe(1);
    });
    
    it('should identify orphaned work items', async () => {
      mockStorage.retrieve = jest.fn().mockResolvedValue({
        data: {
          dataset: {
            data: {
              workItems: [
                { WorkItemId: 1, AssignedToUserSK: 'user-999' }
              ],
              users: [
                { UserSK: 'user-1', UserName: 'Valid User' }
              ],
              teams: [],
              areas: []
            }
          }
        }
      }) as any;
      
      const issues = await extractor.analyzeDataQuality('session-123');
      
      const orphanedIssue = issues.find(i => i.category === 'User Assignments');
      expect(orphanedIssue).toBeDefined();
      expect(orphanedIssue?.severity).toBe('warning');
    });
    
    it('should identify stale work items', async () => {
      const oldDate = new Date();
      oldDate.setFullYear(oldDate.getFullYear() - 1);
      
      mockStorage.retrieve = jest.fn().mockResolvedValue({
        data: {
          dataset: {
            data: {
              workItems: [
                { 
                  WorkItemId: 1,
                  State: 'Active',
                  ChangedDateSK: oldDate.toISOString()
                }
              ],
              users: [],
              teams: [],
              areas: []
            }
          }
        }
      }) as any;
      
      const issues = await extractor.analyzeDataQuality('session-123');
      
      const staleIssue = issues.find(i => i.category === 'Stale Work Items');
      expect(staleIssue).toBeDefined();
      expect(staleIssue?.severity).toBe('warning');
    });
    
    it('should identify teams without areas', async () => {
      mockStorage.retrieve = jest.fn().mockResolvedValue({
        data: {
          dataset: {
            data: {
              teams: [
                { TeamName: 'Orphaned Team' }
              ],
              areas: [
                { AreaPath: 'Project\\Different Area' }
              ],
              workItems: [],
              users: []
            }
          }
        }
      }) as any;
      
      const issues = await extractor.analyzeDataQuality('session-123');
      
      const teamIssue = issues.find(i => i.category === 'Team Configuration');
      expect(teamIssue).toBeDefined();
      expect(teamIssue?.severity).toBe('critical');
    });
    
    it('should identify duplicate work items', async () => {
      mockStorage.retrieve = jest.fn().mockResolvedValue({
        data: {
          dataset: {
            data: {
              workItems: [
                { WorkItemId: 1, Title: 'Duplicate Title' },
                { WorkItemId: 2, Title: 'Duplicate Title' },
                { WorkItemId: 3, Title: 'Unique Title' }
              ],
              users: [],
              teams: [],
              areas: []
            }
          }
        }
      }) as any;
      
      const issues = await extractor.analyzeDataQuality('session-123');
      
      const duplicateIssue = issues.find(i => i.category === 'Duplicate Work Items');
      expect(duplicateIssue).toBeDefined();
      expect(duplicateIssue?.severity).toBe('info');
    });
  });
  
  describe('extractInsights', () => {
    it('should analyze team productivity', async () => {
      mockStorage.retrieve = jest.fn().mockResolvedValue({
        data: {
          dataset: {
            data: {
              workItems: [
                { WorkItemId: 1, AreaPath: 'Project\\Team A', State: 'Done' },
                { WorkItemId: 2, AreaPath: 'Project\\Team A', State: 'Active' },
                { WorkItemId: 3, AreaPath: 'Project\\Team B', State: 'Done' }
              ],
              teams: [
                { TeamName: 'Team A' },
                { TeamName: 'Team B' }
              ],
              areas: [],
              users: []
            }
          }
        }
      }) as any;
      
      const insights = await extractor.extractInsights('session-123');
      
      const productivityInsight = insights.find(i => i.type === 'team-productivity');
      expect(productivityInsight).toBeDefined();
      expect(productivityInsight?.metrics).toBeDefined();
      expect(productivityInsight?.recommendations).toHaveLength(3);
    });
    
    it('should analyze work distribution', async () => {
      mockStorage.retrieve = jest.fn().mockResolvedValue({
        data: {
          dataset: {
            data: {
              workItems: [
                { WorkItemType: 'Bug', State: 'New' },
                { WorkItemType: 'Bug', State: 'Active' },
                { WorkItemType: 'Task', State: 'Done' }
              ],
              teams: [],
              areas: [],
              users: []
            }
          }
        }
      }) as any;
      
      const insights = await extractor.extractInsights('session-123');
      
      const distributionInsight = insights.find(i => i.type === 'work-distribution');
      expect(distributionInsight).toBeDefined();
      expect(distributionInsight?.metrics.bugRatio).toBeCloseTo(0.666, 2);
    });
    
    it('should analyze velocity trends', async () => {
      mockStorage.retrieve = jest.fn().mockResolvedValue({
        data: {
          dataset: {
            data: {
              workItems: [
                { State: 'Done', IterationPath: 'Sprint 1' },
                { State: 'Done', IterationPath: 'Sprint 1' },
                { State: 'Done', IterationPath: 'Sprint 2' }
              ],
              iterations: [
                { IterationPath: 'Sprint 1' },
                { IterationPath: 'Sprint 2' }
              ],
              teams: [],
              areas: [],
              users: []
            }
          }
        }
      }) as any;
      
      const insights = await extractor.extractInsights('session-123');
      
      const velocityInsight = insights.find(i => i.type === 'velocity-trend');
      expect(velocityInsight).toBeDefined();
      expect(velocityInsight?.metrics.averageVelocity).toBeDefined();
    });
  });
  
  describe('generateHealthReport', () => {
    it('should generate comprehensive health report', async () => {
      // Mock quality issues and insights
      jest.spyOn(extractor, 'analyzeDataQuality').mockResolvedValue([
        {
          severity: 'critical',
          category: 'Test Issue',
          description: 'Test',
          affectedItems: [],
          impact: { workItems: 10 }
        }
      ]);
      
      jest.spyOn(extractor, 'extractInsights').mockResolvedValue([
        {
          type: 'test',
          title: 'Test Insight',
          description: 'Test',
          metrics: {},
          recommendations: ['Test recommendation']
        }
      ]);
      
      const reportId = await extractor.generateHealthReport('session-123');
      
      expect(reportId).toBe('report-123');
      expect(mockStorage.storeReport).toHaveBeenCalledWith(
        'health-report',
        expect.objectContaining({
          summary: expect.objectContaining({
            criticalIssues: 1,
            warnings: 0,
            insights: 1
          })
        }),
        'json',
        { sessionId: 'session-123' }
      );
    });
    
    it('should generate recommendations based on issues', async () => {
      jest.spyOn(extractor, 'analyzeDataQuality').mockResolvedValue([
        {
          severity: 'critical',
          category: 'Test',
          description: 'Critical issue',
          affectedItems: [],
          suggestedFix: 'Fix this immediately',
          impact: {}
        }
      ]);
      
      jest.spyOn(extractor, 'extractInsights').mockResolvedValue([]);
      
      await extractor.generateHealthReport('session-123');
      
      const reportCall = (mockStorage.storeReport as jest.Mock).mock.calls[0];
      const report = reportCall[1] as any;
      
      expect(report.recommendations).toContain('IMMEDIATE ACTION REQUIRED:');
      expect(report.recommendations).toContain('- Fix this immediately');
    });
  });
});