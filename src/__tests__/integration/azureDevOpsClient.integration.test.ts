import { describe, it, expect, beforeAll } from '@jest/globals';
import { AzureDevOpsClient, AzureDevOpsConfig } from '../../azureDevOpsClient.js';
import { describeIntegration, getIntegrationConfig } from './setup.js';

describeIntegration('AzureDevOpsClient Integration Tests', () => {
  let client: AzureDevOpsClient;
  let config: AzureDevOpsConfig;
  let testProject: string | undefined;

  beforeAll(() => {
    const integrationConfig = getIntegrationConfig();
    config = {
      orgUrl: integrationConfig.orgUrl,
      pat: integrationConfig.pat,
      project: integrationConfig.project,
    };
    client = new AzureDevOpsClient(config);
    testProject = config.project;
    
    console.log(`🔧 Running integration tests against: ${config.orgUrl}`);
    if (testProject) {
      console.log(`📁 Default project: ${testProject}`);
    }
  });

  describe('getProjects', () => {
    it('should fetch real projects from Azure DevOps', async () => {
      const result = await client.getProjects();
      
      expect(result).toBeDefined();
      expect(result.value).toBeDefined();
      expect(Array.isArray(result.value)).toBe(true);
      
      if (result.value.length > 0) {
        const project = result.value[0];
        expect(project).toHaveProperty('ProjectSK');
        expect(project).toHaveProperty('ProjectId');
        expect(project).toHaveProperty('ProjectName');
        
        console.log(`✅ Found ${result.value.length} projects`);
        console.log(`   First project: ${project.ProjectName}`);
      }
    }, 30000);
  });

  describe('getAreas', () => {
    it('should fetch areas from Azure DevOps', async () => {
      const result = await client.getAreas(testProject);
      
      expect(result).toBeDefined();
      expect(result.value).toBeDefined();
      expect(Array.isArray(result.value)).toBe(true);
      
      if (result.value.length > 0) {
        const area = result.value[0];
        expect(area).toHaveProperty('AreaId');
        expect(area).toHaveProperty('AreaName');
        expect(area).toHaveProperty('AreaPath');
        
        console.log(`✅ Found ${result.value.length} areas`);
        console.log(`   Sample area: ${area.AreaPath}`);
      }
    }, 30000);

    it('should fetch areas from all projects when no project specified', async () => {
      const result = await client.getAreas();
      
      expect(result).toBeDefined();
      expect(result.value).toBeDefined();
      expect(Array.isArray(result.value)).toBe(true);
      
      if (result.value.length > 0) {
        console.log(`✅ Found ${result.value.length} areas across all projects`);
      }
    }, 30000);
  });

  describe('getTeams', () => {
    it('should fetch teams from Azure DevOps', async () => {
      const result = await client.getTeams(testProject);
      
      expect(result).toBeDefined();
      expect(result.value).toBeDefined();
      expect(Array.isArray(result.value)).toBe(true);
      
      if (result.value.length > 0) {
        const team = result.value[0];
        expect(team).toHaveProperty('TeamId');
        expect(team).toHaveProperty('TeamName');
        expect(team).toHaveProperty('TeamSK');
        
        console.log(`✅ Found ${result.value.length} teams`);
        console.log(`   Sample team: ${team.TeamName}`);
      }
    }, 30000);
  });

  describe('getUsers', () => {
    it('should fetch users from Azure DevOps', async () => {
      const result = await client.getUsers(testProject);
      
      expect(result).toBeDefined();
      expect(result.value).toBeDefined();
      expect(Array.isArray(result.value)).toBe(true);
      
      if (result.value.length > 0) {
        const user = result.value[0];
        expect(user).toHaveProperty('UserSK');
        expect(user).toHaveProperty('UserName');
        
        console.log(`✅ Found ${result.value.length} users`);
        console.log(`   Sample user: ${user.UserName}`);
      }
    }, 30000);
  });

  describe('getWorkItemSnapshots', () => {
    it('should fetch work item snapshots with filtering', async () => {
      const result = await client.getWorkItemSnapshots({
        project: testProject,
        top: 5,
        select: 'WorkItemId,Title,WorkItemType,State',
      });
      
      expect(result).toBeDefined();
      expect(result.value).toBeDefined();
      expect(Array.isArray(result.value)).toBe(true);
      
      if (result.value.length > 0) {
        const workItem = result.value[0];
        expect(workItem).toHaveProperty('WorkItemId');
        expect(workItem).toHaveProperty('Title');
        
        console.log(`✅ Found ${result.value.length} work items (max 5 requested)`);
        console.log(`   Sample: #${workItem.WorkItemId} - ${workItem.Title}`);
      }
    }, 30000);

    it('should support pagination', async () => {
      const firstPage = await client.getWorkItemSnapshots({
        project: testProject,
        top: 2,
        skip: 0,
        select: 'WorkItemId,Title',
      });
      
      const secondPage = await client.getWorkItemSnapshots({
        project: testProject,
        top: 2,
        skip: 2,
        select: 'WorkItemId,Title',
      });
      
      expect(firstPage.value).toBeDefined();
      expect(secondPage.value).toBeDefined();
      
      if (firstPage.value.length > 0 && secondPage.value.length > 0) {
        // Verify different work items
        const firstId = firstPage.value[0].WorkItemId;
        const secondId = secondPage.value[0].WorkItemId;
        expect(firstId).not.toBe(secondId);
        
        console.log(`✅ Pagination working - Page 1: ${firstPage.value.length} items, Page 2: ${secondPage.value.length} items`);
      }
    }, 30000);

    it('should support OData filtering', async () => {
      const result = await client.getWorkItemSnapshots({
        project: testProject,
        filter: "WorkItemType eq 'Task' or WorkItemType eq 'Bug'",
        select: 'WorkItemId,WorkItemType,Title',
        top: 10,
      });
      
      expect(result).toBeDefined();
      expect(result.value).toBeDefined();
      
      if (result.value.length > 0) {
        // Verify all items match filter
        result.value.forEach((item: any) => {
          expect(['Task', 'Bug']).toContain(item.WorkItemType);
        });
        
        console.log(`✅ Filtered ${result.value.length} items of type Task or Bug`);
      }
    }, 30000);
  });

  describe('getWorkItemsByArea', () => {
    it('should fetch work items for a specific area', async () => {
      // First get an area to test with
      const areas = await client.getAreas(testProject);
      
      if (areas.value && areas.value.length > 0) {
        const testArea = areas.value[0];
        const result = await client.getWorkItemsByArea(testArea.AreaPath, testProject);
        
        expect(result).toBeDefined();
        expect(result.value).toBeDefined();
        expect(Array.isArray(result.value)).toBe(true);
        
        if (result.value.length > 0) {
          const workItem = result.value[0];
          expect(workItem.AreaPath).toBe(testArea.AreaPath);
          
          console.log(`✅ Found ${result.value.length} work items in area: ${testArea.AreaPath}`);
        }
      }
    }, 30000);
  });

  describe('getTeamAreas', () => {
    it('should fetch areas for a specific team', async () => {
      // First get a team to test with
      const teams = await client.getTeams(testProject);
      
      if (teams.value && teams.value.length > 0) {
        const testTeam = teams.value[0];
        
        try {
          const result = await client.getTeamAreas(testTeam.TeamName, testProject);
          
          expect(result).toBeDefined();
          expect(result.team).toBeDefined();
          expect(result.areas).toBeDefined();
          expect(Array.isArray(result.areas)).toBe(true);
          
          console.log(`✅ Team '${testTeam.TeamName}' has ${result.areas.length} areas`);
        } catch (error: any) {
          // Some teams might not have areas configured
          if (error.message.includes('not found')) {
            console.log(`⚠️  Team '${testTeam.TeamName}' - ${error.message}`);
          } else {
            throw error;
          }
        }
      }
    }, 30000);
  });

  describe('getAreaTeamWorkItemRelationships', () => {
    it('should fetch relationships between areas, teams, and work items', async () => {
      // Get areas first
      const areas = await client.getAreas(testProject);
      
      if (areas.value && areas.value.length > 0) {
        // Test with first area
        const testArea = areas.value[0];
        const result = await client.getAreaTeamWorkItemRelationships(testArea.AreaPath, testProject);
        
        expect(result).toBeDefined();
        expect(Array.isArray(result)).toBe(true);
        
        if (result.length > 0) {
          const relationship = result[0];
          expect(relationship).toHaveProperty('area');
          expect(relationship).toHaveProperty('teams');
          expect(relationship).toHaveProperty('workItemCount');
          expect(relationship).toHaveProperty('sampleWorkItems');
          
          console.log(`✅ Found relationships for ${result.length} areas`);
          console.log(`   Area: ${relationship.area.path}`);
          console.log(`   Teams: ${relationship.teams.length}`);
          console.log(`   Work Items: ${relationship.workItemCount}`);
        }
      }
    }, 30000);

    it('should fetch all relationships when no area specified', async () => {
      // This might return a lot of data, so we'll be careful
      const result = await client.getAreaTeamWorkItemRelationships(undefined, testProject);
      
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      
      if (result.length > 0) {
        console.log(`✅ Found relationships for ${result.length} areas in total`);
        
        // Calculate some statistics
        const totalTeams = result.reduce((sum: number, r: any) => sum + r.teams.length, 0);
        const totalWorkItems = result.reduce((sum: number, r: any) => sum + r.workItemCount, 0);
        
        console.log(`   Total teams across areas: ${totalTeams}`);
        console.log(`   Total work items: ${totalWorkItems}`);
      }
    }, 60000); // Longer timeout for potentially large query
  });

  describe('queryAnalytics', () => {
    it('should execute custom OData queries', async () => {
      // Use WorkItemSnapshot instead of WorkItems to avoid project filter issues
      const query = 'WorkItemSnapshot?$select=WorkItemId,Title,State&$filter=DateValue eq DateSK&$top=3';
      const result = await client.queryAnalytics(query, testProject);
      
      expect(result).toBeDefined();
      expect(result.value).toBeDefined();
      expect(Array.isArray(result.value)).toBe(true);
      
      if (result.value.length > 0) {
        const item = result.value[0];
        expect(item).toHaveProperty('WorkItemId');
        expect(item).toHaveProperty('Title');
        expect(item).toHaveProperty('State');
        
        console.log(`✅ Custom query returned ${result.value.length} items`);
      }
    }, 30000);

    it('should support complex OData queries', async () => {
      const query = "WorkItemSnapshot?$select=WorkItemId,Title,State,WorkItemType&$filter=State ne 'Closed' and DateValue eq DateSK&$top=5&$orderby=ChangedDateSK desc";
      const result = await client.queryAnalytics(query, testProject);
      
      expect(result).toBeDefined();
      expect(result.value).toBeDefined();
      
      if (result.value.length > 0) {
        // Verify no closed items
        result.value.forEach((item: any) => {
          expect(item.State).not.toBe('Closed');
        });
        
        console.log(`✅ Complex query returned ${result.value.length} non-closed items`);
      }
    }, 30000);
  });

  describe('Cross-project queries', () => {
    it('should query across all projects when project is not specified', async () => {
      // Create a client without default project for this test
      const crossProjectClient = new AzureDevOpsClient({
        orgUrl: config.orgUrl,
        pat: config.pat,
        // Explicitly no project to test cross-project functionality
      });
      
      const areas = await crossProjectClient.getAreas();
      const teams = await crossProjectClient.getTeams();
      const users = await crossProjectClient.getUsers();
      
      expect(areas.value).toBeDefined();
      expect(teams.value).toBeDefined();
      expect(users.value).toBeDefined();
      
      console.log('✅ Cross-project queries:');
      console.log(`   Areas: ${areas.value?.length || 0} across all projects`);
      console.log(`   Teams: ${teams.value?.length || 0} across all projects`);
      console.log(`   Users: ${users.value?.length || 0} across all projects`);
    }, 30000);
  });
});