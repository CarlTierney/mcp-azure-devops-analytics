import { jest } from '@jest/globals';
import { AnalyticsClient } from '../analyticsClient.js';
import { AzureDevOpsClient } from '../azureDevOpsClient.js';

describe('Analytics Metrics Tests', () => {
  let analyticsClient: AnalyticsClient;
  let mockClient: jest.Mocked<AzureDevOpsClient>;

  beforeEach(() => {
    mockClient = {
      queryAnalytics: jest.fn(),
    } as any;
    analyticsClient = new AnalyticsClient(mockClient);
  });

  describe('Lead Time Metrics by Team and Period', () => {
    const teamName = 'TeamAlpha';
    const project = 'TestProject';
    
    const testCases = [
      { period: 14, label: '2 weeks' },
      { period: 30, label: '30 days' },
      { period: 60, label: '60 days' },
      { period: 365, label: 'year' }
    ];

    testCases.forEach(({ period, label }) => {
      it(`should calculate average lead time for ${label}`, async () => {
        const endDate = new Date('2024-12-20');
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - period);
        
        const mockResponse = {
          value: [
            { WorkItemId: 1, LeadTimeDays: 5, State: 'Closed' },
            { WorkItemId: 2, LeadTimeDays: 8, State: 'Closed' },
            { WorkItemId: 3, LeadTimeDays: 3, State: 'Closed' },
            { WorkItemId: 4, LeadTimeDays: 12, State: 'Closed' },
            { WorkItemId: 5, LeadTimeDays: 7, State: 'Closed' }
          ]
        };
        
        mockClient.queryAnalytics.mockResolvedValue(mockResponse);
        
        // Mock the lead time query with team filter
        const query = expect.stringContaining(`filter(`) && 
                     expect.stringContaining(`contains(AreaPath, '${teamName}')`) &&
                     expect.stringContaining('State eq \'Closed\'');
        
        const result = await analyticsClient.getLeadTimeMetrics(project, teamName, period);
        
        expect(mockClient.queryAnalytics).toHaveBeenCalled();
        expect(result.averageLeadTime).toBe(7); // (5+8+3+12+7)/5
        expect(result.period).toBe(period);
        expect(result.teamName).toBe(teamName);
      });
    });
  });

  describe('Cycle Time Metrics by Team and Period', () => {
    const teamName = 'TeamBeta';
    const project = 'TestProject';
    
    const testCases = [
      { period: 14, label: '2 weeks' },
      { period: 30, label: '30 days' },
      { period: 60, label: '60 days' },
      { period: 365, label: 'year' }
    ];

    testCases.forEach(({ period, label }) => {
      it(`should calculate average cycle time for ${label}`, async () => {
        const mockResponse = {
          value: [
            { WorkItemId: 1, AvgCycleTime: 3, WorkItemType: 'User Story' },
            { WorkItemId: 2, AvgCycleTime: 5, WorkItemType: 'User Story' },
            { WorkItemId: 3, AvgCycleTime: 2, WorkItemType: 'Bug' },
            { WorkItemId: 4, AvgCycleTime: 8, WorkItemType: 'User Story' },
            { WorkItemId: 5, AvgCycleTime: 4, WorkItemType: 'User Story' }
          ]
        };
        
        mockClient.queryAnalytics.mockResolvedValue(mockResponse);
        
        const result = await analyticsClient.getCycleTimeMetrics(project, period);
        
        expect(mockClient.queryAnalytics).toHaveBeenCalled();
        expect(result.average).toBeCloseTo(4.4); // (3+5+2+8+4)/5
        expect(result.byWorkItemType['User Story']).toBe(5); // (3+5+8+4)/4
      });
    });
  });

  describe('Throughput Metrics with Baseline Projection', () => {
    it('should calculate average throughput with baseline projection', async () => {
      const teamName = 'TeamGamma';
      const project = 'TestProject';
      
      // Mock historical throughput data
      const mockResponse = {
        value: [
          { DateSK: 20241201, Count: 5 },
          { DateSK: 20241202, Count: 3 },
          { DateSK: 20241203, Count: 7 },
          { DateSK: 20241204, Count: 4 },
          { DateSK: 20241205, Count: 6 },
          { DateSK: 20241206, Count: 8 },
          { DateSK: 20241207, Count: 2 }
        ]
      };
      
      mockClient.queryAnalytics.mockResolvedValue(mockResponse);
      
      const result = await analyticsClient.getThroughputMetrics(project);
      
      expect(result.daily).toBeCloseTo(5); // Average: 35/7
      expect(result.weekly).toBeCloseTo(35); // 5 * 7
      expect(result.monthly).toBeCloseTo(150); // 5 * 30
      
      // Verify baseline projection exists
      expect(result.trend).toHaveLength(7);
      expect(result.trend[0].count).toBe(5);
    });

    it('should identify throughput spikes and trends', async () => {
      const mockResponse = {
        value: [
          { DateSK: 20241201, Count: 5 },
          { DateSK: 20241202, Count: 5 },
          { DateSK: 20241203, Count: 20 }, // Spike
          { DateSK: 20241204, Count: 6 },
          { DateSK: 20241205, Count: 5 }
        ]
      };
      
      mockClient.queryAnalytics.mockResolvedValue(mockResponse);
      
      const result = await analyticsClient.getThroughputWithSpikes(project);
      
      expect(result.spikes).toContainEqual({
        date: '2024-12-03',
        count: 20,
        deviationFromBaseline: 15 // 20 - 5 (baseline)
      });
    });
  });

  describe('Failure Load Calculations', () => {
    it('should calculate failure load over time', async () => {
      const project = 'TestProject';
      
      // Mock data for bugs and total items
      const bugResponse = {
        value: [
          { DateSK: 20241201, BugCount: 5, TotalCount: 50 },
          { DateSK: 20241202, BugCount: 8, TotalCount: 55 },
          { DateSK: 20241203, BugCount: 3, TotalCount: 48 },
          { DateSK: 20241204, BugCount: 12, TotalCount: 60 },
          { DateSK: 20241205, BugCount: 6, TotalCount: 52 }
        ]
      };
      
      mockClient.queryAnalytics.mockResolvedValue(bugResponse);
      
      const result = await analyticsClient.getFailureLoad(project, 30);
      
      expect(result.timeline).toHaveLength(5);
      expect(result.timeline[0].failureRate).toBe(10); // 5/50 * 100
      expect(result.timeline[3].failureRate).toBe(20); // 12/60 * 100
      expect(result.averageFailureRate).toBeCloseTo(13.3); // Average of all
    });

    it('should identify failure load trends', async () => {
      const mockResponse = {
        value: [
          { DateSK: 20241201, BugCount: 2, TotalCount: 50 },
          { DateSK: 20241202, BugCount: 4, TotalCount: 50 },
          { DateSK: 20241203, BugCount: 6, TotalCount: 50 },
          { DateSK: 20241204, BugCount: 8, TotalCount: 50 },
          { DateSK: 20241205, BugCount: 10, TotalCount: 50 }
        ]
      };
      
      mockClient.queryAnalytics.mockResolvedValue(mockResponse);
      
      const result = await analyticsClient.getFailureLoadTrend(project, 5);
      
      expect(result.trend).toBe('increasing');
      expect(result.trendStrength).toBeGreaterThan(0.8); // Strong upward trend
    });
  });

  describe('Average Card Age by Work Item Type', () => {
    it('should calculate average age for User Stories', async () => {
      const project = 'TestProject';
      const currentDateSK = 20241220;
      
      const mockResponse = {
        value: [
          { 
            WorkItemId: 1, 
            WorkItemType: 'User Story',
            CreatedDateSK: 20241210,
            State: 'Active',
            AgeDays: 10
          },
          { 
            WorkItemId: 2, 
            WorkItemType: 'User Story',
            CreatedDateSK: 20241205,
            State: 'Active',
            AgeDays: 15
          },
          { 
            WorkItemId: 3, 
            WorkItemType: 'User Story',
            CreatedDateSK: 20241215,
            State: 'Active',
            AgeDays: 5
          },
          { 
            WorkItemId: 4, 
            WorkItemType: 'Bug',
            CreatedDateSK: 20241218,
            State: 'Active',
            AgeDays: 2
          }
        ]
      };
      
      mockClient.queryAnalytics.mockResolvedValue(mockResponse);
      
      const result = await analyticsClient.getAverageCardAge(project, 'User Story');
      
      expect(result.workItemType).toBe('User Story');
      expect(result.averageAge).toBe(10); // (10+15+5)/3
      expect(result.oldestCard).toBe(15);
      expect(result.newestCard).toBe(5);
      expect(result.totalCards).toBe(3);
    });

    it('should identify aging cards that need attention', async () => {
      const mockResponse = {
        value: [
          { WorkItemId: 1, WorkItemType: 'User Story', AgeDays: 45 },
          { WorkItemId: 2, WorkItemType: 'User Story', AgeDays: 60 },
          { WorkItemId: 3, WorkItemType: 'User Story', AgeDays: 90 },
          { WorkItemId: 4, WorkItemType: 'User Story', AgeDays: 15 },
          { WorkItemId: 5, WorkItemType: 'User Story', AgeDays: 120 }
        ]
      };
      
      mockClient.queryAnalytics.mockResolvedValue(mockResponse);
      
      const result = await analyticsClient.getAgingCards(project, 'User Story', 30);
      
      expect(result.agingCards).toHaveLength(4); // Cards older than 30 days
      expect(result.criticalCards).toHaveLength(2); // Cards older than 60 days
      expect(result.oldestCard.AgeDays).toBe(120);
    });
  });

  describe('Backlog Growth and Spike Detection', () => {
    it('should calculate average new cards added to backlog', async () => {
      const project = 'TestProject';
      
      const mockResponse = {
        value: [
          { DateSK: 20241201, NewCards: 5 },
          { DateSK: 20241202, NewCards: 3 },
          { DateSK: 20241203, NewCards: 8 },
          { DateSK: 20241204, NewCards: 4 },
          { DateSK: 20241205, NewCards: 25 }, // Spike
          { DateSK: 20241206, NewCards: 6 },
          { DateSK: 20241207, NewCards: 4 }
        ]
      };
      
      mockClient.queryAnalytics.mockResolvedValue(mockResponse);
      
      const result = await analyticsClient.getBacklogGrowth(project, 30);
      
      expect(result.averageNewCardsPerDay).toBeCloseTo(7.86); // 55/7
      expect(result.totalNewCards).toBe(55);
      expect(result.spikes).toHaveLength(1);
      expect(result.spikes[0]).toMatchObject({
        date: '2024-12-05',
        count: 25,
        deviationFromAverage: expect.any(Number)
      });
    });

    it('should identify backlog growth patterns', async () => {
      const mockResponse = {
        value: Array.from({ length: 30 }, (_, i) => ({
          DateSK: 20241201 + i,
          NewCards: Math.floor(5 + i * 0.5) // Increasing trend
        }))
      };
      
      mockClient.queryAnalytics.mockResolvedValue(mockResponse);
      
      const result = await analyticsClient.getBacklogGrowthTrend(project, 30);
      
      expect(result.trend).toBe('increasing');
      expect(result.projectedGrowth).toBeGreaterThan(result.currentRate);
      expect(result.recommendations).toContain('Consider capacity planning');
    });

    it('should detect multiple spikes in backlog additions', async () => {
      const mockResponse = {
        value: [
          { DateSK: 20241201, NewCards: 5 },
          { DateSK: 20241202, NewCards: 30 }, // Spike 1
          { DateSK: 20241203, NewCards: 6 },
          { DateSK: 20241204, NewCards: 5 },
          { DateSK: 20241205, NewCards: 45 }, // Spike 2
          { DateSK: 20241206, NewCards: 7 },
          { DateSK: 20241207, NewCards: 5 }
        ]
      };
      
      mockClient.queryAnalytics.mockResolvedValue(mockResponse);
      
      const result = await analyticsClient.detectBacklogSpikes(project, 7, 2.0);
      
      expect(result.spikes).toHaveLength(2);
      expect(result.spikes[0].count).toBe(30);
      expect(result.spikes[1].count).toBe(45);
      expect(result.spikeFrequency).toBeCloseTo(0.286); // 2/7
    });
  });
});

// Extension methods for AnalyticsClient (to be added to analyticsClient.ts)
declare module '../analyticsClient.js' {
  interface AnalyticsClient {
    getLeadTimeMetrics(project: string, teamName: string, days: number): Promise<any>;
    getThroughputWithSpikes(project: string): Promise<any>;
    getFailureLoad(project: string, days: number): Promise<any>;
    getFailureLoadTrend(project: string, days: number): Promise<any>;
    getAverageCardAge(project: string, workItemType: string): Promise<any>;
    getAgingCards(project: string, workItemType: string, thresholdDays: number): Promise<any>;
    getBacklogGrowth(project: string, days: number): Promise<any>;
    getBacklogGrowthTrend(project: string, days: number): Promise<any>;
    detectBacklogSpikes(project: string, days: number, threshold: number): Promise<any>;
  }
}