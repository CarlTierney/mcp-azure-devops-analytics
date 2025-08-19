/**
 * READ-ONLY Integration Tests
 * These tests only READ from Azure DevOps and never modify production data
 * All analysis and storage operations use local temporary directories
 */

import { AzureDevOpsClient } from '../../azureDevOpsClient.js';
import { StorageManager } from '../../storageManager.js';
import { DataExtractor } from '../../dataExtractor.js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';
import { jest } from '@jest/globals';

dotenv.config();

// Skip tests if no credentials
const skipIfNoCredentials = !process.env.AZURE_DEVOPS_PAT || !process.env.AZURE_DEVOPS_ORG_URL;

describe('Safe Read-Only Integration Tests', () => {
  if (skipIfNoCredentials) {
    it.skip('Skipping integration tests - no credentials configured', () => {});
    return;
  }
  
  let client: AzureDevOpsClient;
  let storage: StorageManager;
  let extractor: DataExtractor;
  const testStorageDir = path.join(process.cwd(), '.test-integration-storage');
  const project = process.env.AZURE_DEVOPS_PROJECT || process.env.TEST_PROJECT || 'TestProject';
  
  beforeAll(async () => {
    // Initialize with test storage directory (not production)
    client = new AzureDevOpsClient({
      orgUrl: process.env.AZURE_DEVOPS_ORG_URL!,
      pat: process.env.AZURE_DEVOPS_PAT!,
      project
    });
    
    storage = new StorageManager({ 
      baseDir: testStorageDir,
      maxCacheAge: 60 * 60 * 1000 // 1 hour for tests
    });
    await storage.initialize();
    
    extractor = new DataExtractor(client, storage);
  });
  
  afterAll(async () => {
    // Clean up test storage only
    try {
      await fs.rm(testStorageDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });
  
  describe('Read-Only Data Extraction', () => {
    it('should extract and cache areas without modifying Azure DevOps', async () => {
      // READ from Azure DevOps
      const areas = await client.getAreas(project);
      expect(areas.value).toBeDefined();
      
      // STORE locally only
      const cacheId = await storage.storeDataset('test-areas', areas.value || []);
      expect(cacheId).toBeTruthy();
      
      // Verify local storage
      const cached = await storage.retrieveDataset('test-areas');
      expect(cached).toEqual(areas.value);
    }, 30000);
    
    it('should extract teams and analyze patterns locally', async () => {
      // READ teams and areas
      const [teams, areas] = await Promise.all([
        client.getTeams(project),
        client.getAreas(project)
      ]);
      
      expect(teams.value).toBeDefined();
      expect(areas.value).toBeDefined();
      
      // Analyze patterns locally (no Azure DevOps modifications)
      const patterns: any[] = [];
      
      teams.value?.forEach((team: any) => {
        const matchingAreas = areas.value?.filter((area: any) =>
          area.AreaPath.toLowerCase().includes(team.TeamName.toLowerCase())
        );
        
        if (matchingAreas && matchingAreas.length > 0) {
          patterns.push({
            team: team.TeamName,
            matchedAreas: matchingAreas.map((a: any) => a.AreaPath),
            confidence: 1.0
          });
        }
      });
      
      // Store analysis locally
      const analysisId = await storage.storeAnalysis('team-area-patterns', patterns);
      expect(analysisId).toBeTruthy();
      
      // Verify we found some patterns
      expect(patterns.length).toBeGreaterThan(0);
    }, 30000);
    
    it('should safely analyze work item quality without modifications', async () => {
      // READ a small sample of work items
      const workItems = await client.getWorkItemSnapshots({
        project,
        top: 100, // Small sample for testing
        select: 'WorkItemId,Title,State,AreaSK,AssignedToUserSK'
      });
      
      expect(workItems.value).toBeDefined();
      
      // Analyze quality issues locally
      const qualityIssues = {
        unassignedAreas: workItems.value?.filter((wi: any) => !wi.AreaSK).length || 0,
        unassignedUsers: workItems.value?.filter((wi: any) => !wi.AssignedToUserSK).length || 0,
        totalAnalyzed: workItems.value?.length || 0
      };
      
      // Store report locally
      const reportId = await storage.storeReport(
        'quality-analysis',
        qualityIssues,
        'json',
        { project, sampleSize: 100 }
      );
      
      expect(reportId).toBeTruthy();
      expect(qualityIssues.totalAnalyzed).toBeGreaterThan(0);
    }, 30000);
  });
  
  describe('Safe Analytics Tool Testing', () => {
    it('should test new iteration tool (read-only)', async () => {
      // Try to read iterations
      try {
        const iterations = await client.getIterations(project);
        
        if (iterations.value) {
          expect(Array.isArray(iterations.value)).toBe(true);
          
          // Cache iterations locally for analysis
          await storage.storeDataset('test-iterations', iterations.value);
        }
      } catch (error: any) {
        // If iterations not available, that's OK - we're just testing
        console.log('Iterations not available:', error.message);
        expect(error.message).toContain('not available');
      }
    }, 30000);
    
    it('should test work item history (read-only)', async () => {
      // Get a sample work item
      const workItems = await client.queryAnalytics(
        `WorkItemSnapshot?$select=WorkItemId&$top=1`,
        project
      );
      
      if (workItems.value && workItems.value.length > 0) {
        const workItemId = workItems.value[0].WorkItemId;
        
        // Read history without modifications
        const history = await client.getWorkItemHistory(workItemId, project);
        
        if (!history.error) {
          expect(history.workItemId).toBe(workItemId);
          expect(history.stateTransitions).toBeDefined();
          
          // Store history analysis locally
          await storage.storeAnalysis('work-item-history', history, [], {
            workItemId,
            project
          });
        }
      }
    }, 30000);
    
    it('should test team members extraction (read-only)', async () => {
      // Get a team to test
      const teams = await client.getTeams(project);
      
      if (teams.value && teams.value.length > 0) {
        const teamName = teams.value[0].TeamName;
        
        // Try to get team members
        const members = await client.getTeamMembers(teamName, project);
        
        expect(members).toBeDefined();
        if (!members.error) {
          expect(members.teamName).toBe(teamName);
          
          // Cache member info locally
          await storage.store('cache', `team-members-${teamName}`, members);
        }
      }
    }, 30000);
  });
  
  describe('Data Quality Analysis (Local Only)', () => {
    let sessionId: string;
    
    beforeAll(async () => {
      // Extract a small dataset for testing
      sessionId = await extractor.extractFullDataset({
        project,
        entities: ['areas', 'teams'],
        batchSize: 100 // Small batch for testing
      });
    }, 60000);
    
    it('should analyze data quality without Azure DevOps modifications', async () => {
      const qualityIssues = await extractor.analyzeDataQuality(sessionId);
      
      expect(Array.isArray(qualityIssues)).toBe(true);
      
      // Check issue structure
      qualityIssues.forEach(issue => {
        expect(issue.severity).toMatch(/critical|warning|info/);
        expect(issue.category).toBeTruthy();
        expect(issue.description).toBeTruthy();
      });
      
      // Store quality report locally
      const reportId = await storage.storeReport(
        'quality-issues',
        qualityIssues,
        'json',
        { sessionId }
      );
      
      expect(reportId).toBeTruthy();
    }, 30000);
    
    it('should extract insights without modifications', async () => {
      const insights = await extractor.extractInsights(sessionId);
      
      expect(Array.isArray(insights)).toBe(true);
      
      insights.forEach(insight => {
        expect(insight.type).toBeTruthy();
        expect(insight.title).toBeTruthy();
        expect(insight.metrics).toBeDefined();
        expect(Array.isArray(insight.recommendations)).toBe(true);
      });
    }, 30000);
    
    it('should generate health report locally', async () => {
      const reportId = await extractor.generateHealthReport(sessionId);
      
      expect(reportId).toBeTruthy();
      
      // Verify report was stored locally
      const report = await storage.retrieve('report', reportId);
      expect(report).toBeTruthy();
      expect(report?.data.qualityIssues).toBeDefined();
      expect(report?.data.insights).toBeDefined();
    }, 30000);
  });
  
  describe('Storage Manager (Local Operations)', () => {
    it('should manage sessions locally', async () => {
      const sessionId = await storage.createSession('test-readonly', {
        purpose: 'integration-test',
        readOnly: true
      });
      
      expect(sessionId).toBeTruthy();
      
      await storage.updateSession(sessionId, {
        step1: 'completed',
        timestamp: new Date().toISOString()
      });
      
      const session = await storage.retrieve('session', sessionId);
      expect(session?.data.data.step1).toBe('completed');
    });
    
    it('should handle large datasets locally', async () => {
      // Create synthetic data for testing
      const largeDataset = Array.from({ length: 5000 }, (_, i) => ({
        id: i,
        type: 'test',
        value: Math.random()
      }));
      
      const datasetId = await storage.storeDataset(
        'large-test-dataset',
        largeDataset,
        1000
      );
      
      expect(datasetId).toBeTruthy();
      
      const retrieved = await storage.retrieveDataset('large-test-dataset');
      expect(retrieved).toHaveLength(5000);
    });
    
    it('should generate reports in multiple formats', async () => {
      const testData = [
        { id: 1, name: 'Test 1', status: 'active' },
        { id: 2, name: 'Test 2', status: 'inactive' }
      ];
      
      // JSON report
      const jsonId = await storage.storeReport('test', testData, 'json');
      const jsonReport = await storage.retrieve('report', jsonId);
      expect(jsonReport?.data).toEqual(testData);
      
      // CSV report
      const csvId = await storage.storeReport('test', testData, 'csv');
      const csvReport = await storage.retrieve('report', csvId);
      expect(csvReport?.data).toContain('id,name,status');
      
      // Markdown report
      const mdId = await storage.storeReport('test', testData, 'markdown');
      const mdReport = await storage.retrieve('report', mdId);
      expect(mdReport?.data).toContain('| id | name | status |');
    });
    
    it('should provide storage statistics', async () => {
      const stats = await storage.getStats();
      
      expect(stats.totalSize).toBeGreaterThanOrEqual(0);
      expect(stats.byType).toBeDefined();
      expect(stats.byType.cache).toBeDefined();
      expect(stats.byType.analysis).toBeDefined();
    });
  });
  
  describe('Validation Only Operations', () => {
    it('should validate team-area mappings without applying them', async () => {
      const [teams, areas] = await Promise.all([
        client.getTeams(project),
        client.getAreas(project)
      ]);
      
      const validationResults: any[] = [];
      
      // Validate mappings without applying
      teams.value?.slice(0, Math.min(5, teams.value.length)).forEach((team: any) => {
        const matchingArea = areas.value?.find((area: any) =>
          area.AreaPath.includes(team.TeamName)
        );
        
        validationResults.push({
          team: team.TeamName,
          suggestedArea: matchingArea?.AreaPath || null,
          isValid: !!matchingArea,
          confidence: matchingArea ? 1.0 : 0.0
        });
      });
      
      // Store validation results locally
      await storage.storeAnalysis(
        'mapping-validation',
        validationResults,
        [],
        { project, validatedAt: new Date().toISOString() }
      );
      
      expect(validationResults.length).toBeGreaterThan(0);
    }, 30000);
    
    it('should simulate work item area assignment without applying', async () => {
      const workItems = await client.getWorkItemSnapshots({
        project,
        filter: 'AreaSK eq null',
        top: 10
      });
      
      const simulatedAssignments: any[] = [];
      
      if (workItems.value) {
        const areas = await client.getAreas(project);
        
        workItems.value.forEach((wi: any) => {
          // Simulate assignment based on title
          let suggestedArea = project; // Default to project root
          
          if (wi.Title) {
            // Find area based on title keywords
            const matchedArea = areas.value?.find((area: any) => {
              const areaName = area.AreaPath.split('\\').pop().toLowerCase();
              return wi.Title.toLowerCase().includes(areaName);
            });
            
            if (matchedArea) {
              suggestedArea = matchedArea.AreaPath;
            }
          }
          
          simulatedAssignments.push({
            workItemId: wi.WorkItemId,
            title: wi.Title,
            currentArea: null,
            suggestedArea,
            simulationOnly: true
          });
        });
      }
      
      // Store simulation results locally
      const reportId = await storage.storeReport(
        'area-assignment-simulation',
        simulatedAssignments,
        'json',
        { 
          project,
          simulatedAt: new Date().toISOString(),
          disclaimer: 'Simulation only - no changes made to Azure DevOps'
        }
      );
      
      expect(reportId).toBeTruthy();
    }, 30000);
  });
});