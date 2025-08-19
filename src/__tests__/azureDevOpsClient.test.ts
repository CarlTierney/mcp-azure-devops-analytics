import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AzureDevOpsClient, AzureDevOpsConfig } from '../azureDevOpsClient.js';

describe('AzureDevOpsClient', () => {
  let client: AzureDevOpsClient;
  const mockConfig: AzureDevOpsConfig = {
    orgUrl: 'https://dev.azure.com/test-org',
    pat: 'test-pat',
    project: 'test-project',
  };

  beforeEach(() => {
    client = new AzureDevOpsClient(mockConfig);
  });

  describe('constructor', () => {
    it('should initialize with correct configuration', () => {
      expect(client).toBeDefined();
      expect(client).toBeInstanceOf(AzureDevOpsClient);
    });
  });

  describe('getProjects', () => {
    it('should have getProjects method', () => {
      expect(client.getProjects).toBeDefined();
      expect(typeof client.getProjects).toBe('function');
    });
  });

  describe('getAreas', () => {
    it('should have getAreas method', () => {
      expect(client.getAreas).toBeDefined();
      expect(typeof client.getAreas).toBe('function');
    });

    it('should accept optional project parameter', () => {
      expect(() => {
        client.getAreas('TestProject');
      }).not.toThrow();
    });
  });

  describe('getTeams', () => {
    it('should have getTeams method', () => {
      expect(client.getTeams).toBeDefined();
      expect(typeof client.getTeams).toBe('function');
    });

    it('should accept optional project parameter', () => {
      expect(() => {
        client.getTeams('TestProject');
      }).not.toThrow();
    });
  });

  describe('getUsers', () => {
    it('should have getUsers method', () => {
      expect(client.getUsers).toBeDefined();
      expect(typeof client.getUsers).toBe('function');
    });

    it('should accept optional project parameter', () => {
      expect(() => {
        client.getUsers('TestProject');
      }).not.toThrow();
    });
  });

  describe('getWorkItemSnapshots', () => {
    it('should have getWorkItemSnapshots method', () => {
      expect(client.getWorkItemSnapshots).toBeDefined();
      expect(typeof client.getWorkItemSnapshots).toBe('function');
    });

    it('should accept optional parameters including project', () => {
      const options = {
        project: 'TestProject',
        top: 10,
        skip: 5,
        filter: "State eq 'Active'",
        select: 'WorkItemId,Title',
        expand: 'AssignedTo',
        orderby: 'ChangedDate desc',
      };
      
      // Validate method accepts the options object
      expect(() => {
        client.getWorkItemSnapshots(options);
      }).not.toThrow();
    });
  });

  describe('getWorkItemsByArea', () => {
    it('should have getWorkItemsByArea method', () => {
      expect(client.getWorkItemsByArea).toBeDefined();
      expect(typeof client.getWorkItemsByArea).toBe('function');
    });

    it('should accept area path and optional project', () => {
      expect(() => {
        client.getWorkItemsByArea('\\Project\\Area', 'TestProject');
      }).not.toThrow();
    });
  });

  describe('getTeamAreas', () => {
    it('should have getTeamAreas method', () => {
      expect(client.getTeamAreas).toBeDefined();
      expect(typeof client.getTeamAreas).toBe('function');
    });
  });

  describe('getAreaTeamWorkItemRelationships', () => {
    it('should have getAreaTeamWorkItemRelationships method', () => {
      expect(client.getAreaTeamWorkItemRelationships).toBeDefined();
      expect(typeof client.getAreaTeamWorkItemRelationships).toBe('function');
    });
  });

  describe('queryAnalytics', () => {
    it('should have queryAnalytics method', () => {
      expect(client.queryAnalytics).toBeDefined();
      expect(typeof client.queryAnalytics).toBe('function');
    });

    it('should accept query and optional project', () => {
      expect(() => {
        client.queryAnalytics('WorkItems?$top=10', 'TestProject');
      }).not.toThrow();
    });
  });
});