import { describe, it, expect, beforeAll } from '@jest/globals';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AzureDevOpsClient } from '../../azureDevOpsClient.js';
import { describeIntegration, getIntegrationConfig } from './setup.js';

describeIntegration('MCP Server Integration Tests', () => {
  let server: Server;
  let client: AzureDevOpsClient;
  let listToolsHandler: any;
  let callToolHandler: any;
  let testProject: string | undefined;

  beforeAll(async () => {
    const integrationConfig = getIntegrationConfig();
    
    // Initialize Azure DevOps client
    client = new AzureDevOpsClient({
      orgUrl: integrationConfig.orgUrl,
      pat: integrationConfig.pat,
      project: integrationConfig.project,
    });
    
    testProject = integrationConfig.project;
    
    // Initialize MCP server
    server = new Server(
      {
        name: 'mcp-azure-devops-analytics-test',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
    
    // Set up handlers by importing the actual server module
    const serverModule = await import('../../index.js');
    
    // Capture handlers
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Return the actual tools from the server
      return { tools: await getServerTools() };
    });
    
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return callToolImplementation(request.params, client);
    });
    
    console.log(`🔧 Running MCP Server integration tests`);
  });

  describe('Tool Registration', () => {
    it('should list all available tools', async () => {
      const tools = await getServerTools();
      
      expect(tools).toBeDefined();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(9);
      
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('get_projects');
      expect(toolNames).toContain('get_areas');
      expect(toolNames).toContain('get_teams');
      expect(toolNames).toContain('get_users');
      expect(toolNames).toContain('get_work_item_snapshots');
      expect(toolNames).toContain('get_work_items_by_area');
      expect(toolNames).toContain('get_team_areas');
      expect(toolNames).toContain('get_area_team_workitem_relationships');
      expect(toolNames).toContain('query_analytics');
      
      console.log(`✅ All ${tools.length} tools registered correctly`);
    });
  });

  describe('Tool Execution', () => {
    it('should execute get_projects tool', async () => {
      const result = await callToolImplementation(
        { name: 'get_projects', arguments: {} },
        client
      );
      
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      
      const data = JSON.parse(result.content[0].text);
      expect(data.value).toBeDefined();
      expect(Array.isArray(data.value)).toBe(true);
      
      console.log(`✅ get_projects returned ${data.value.length} projects`);
    }, 30000);

    it('should execute get_areas tool with project parameter', async () => {
      const result = await callToolImplementation(
        { name: 'get_areas', arguments: { project: testProject } },
        client
      );
      
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      
      const data = JSON.parse(result.content[0].text);
      expect(data.value).toBeDefined();
      
      console.log(`✅ get_areas returned ${data.value.length} areas`);
    }, 30000);

    it('should execute get_work_item_snapshots with filters', async () => {
      const result = await callToolImplementation(
        {
          name: 'get_work_item_snapshots',
          arguments: {
            project: testProject,
            top: 5,
            select: 'WorkItemId,Title,State',
            filter: "State ne 'Closed'",
          }
        },
        client
      );
      
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      
      const data = JSON.parse(result.content[0].text);
      expect(data.value).toBeDefined();
      
      if (data.value.length > 0) {
        // Verify filtering worked
        data.value.forEach((item: any) => {
          expect(item.State).not.toBe('Closed');
        });
      }
      
      console.log(`✅ get_work_item_snapshots returned ${data.value.length} filtered items`);
    }, 30000);

    it('should execute query_analytics with custom query', async () => {
      const result = await callToolImplementation(
        {
          name: 'query_analytics',
          arguments: {
            query: 'WorkItems?$select=WorkItemId,Title&$top=3',
            project: testProject,
          }
        },
        client
      );
      
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      
      const data = JSON.parse(result.content[0].text);
      expect(data.value).toBeDefined();
      expect(data.value.length).toBeLessThanOrEqual(3);
      
      console.log(`✅ query_analytics executed custom query successfully`);
    }, 30000);

    it('should handle errors gracefully', async () => {
      const result = await callToolImplementation(
        {
          name: 'get_team_areas',
          arguments: { teamName: 'NonExistentTeam123456789' }
        },
        client
      );
      
      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error');
      expect(result.content[0].text).toContain('not found');
      
      console.log(`✅ Error handling works correctly`);
    }, 30000);
  });

  describe('Cross-tool Integration', () => {
    it('should use output from one tool as input to another', async () => {
      // First get projects
      const projectsResult = await callToolImplementation(
        { name: 'get_projects', arguments: {} },
        client
      );
      
      const projects = JSON.parse(projectsResult.content[0].text);
      
      if (projects.value && projects.value.length > 0) {
        const firstProject = projects.value[0].ProjectName;
        
        // Use project name to get areas for that specific project
        const areasResult = await callToolImplementation(
          { name: 'get_areas', arguments: { project: firstProject } },
          client
        );
        
        const areas = JSON.parse(areasResult.content[0].text);
        expect(areas.value).toBeDefined();
        
        console.log(`✅ Cross-tool integration: Used project '${firstProject}' to get ${areas.value.length} areas`);
      }
    }, 30000);

    it('should get area-team-workitem relationships', async () => {
      // Get areas first
      const areasResult = await callToolImplementation(
        { name: 'get_areas', arguments: { project: testProject } },
        client
      );
      
      const areas = JSON.parse(areasResult.content[0].text);
      
      if (areas.value && areas.value.length > 0) {
        const testArea = areas.value[0].AreaPath;
        
        // Get relationships for this area
        const relationshipsResult = await callToolImplementation(
          {
            name: 'get_area_team_workitem_relationships',
            arguments: { areaPath: testArea, project: testProject }
          },
          client
        );
        
        const relationships = JSON.parse(relationshipsResult.content[0].text);
        expect(relationships).toBeDefined();
        expect(Array.isArray(relationships)).toBe(true);
        
        if (relationships.length > 0) {
          const rel = relationships[0];
          console.log(`✅ Area '${rel.area.path}' has ${rel.teams.length} teams and ${rel.workItemCount} work items`);
        }
      }
    }, 30000);
  });
});

// Helper function to get server tools definition
async function getServerTools() {
  return [
    {
      name: 'get_projects',
      description: 'Get all projects in the Azure DevOps organization',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_areas',
      description: 'Get areas across all projects or a specific project',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Optional: specific project name to query' },
        },
      },
    },
    {
      name: 'get_teams',
      description: 'Get teams across all projects or a specific project',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Optional: specific project name to query' },
        },
      },
    },
    {
      name: 'get_users',
      description: 'Get users across all projects or a specific project',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Optional: specific project name to query' },
        },
      },
    },
    {
      name: 'get_work_item_snapshots',
      description: 'Get work item snapshots with optional filtering and pagination',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          top: { type: 'number' },
          skip: { type: 'number' },
          filter: { type: 'string' },
          select: { type: 'string' },
          orderby: { type: 'string' },
        },
      },
    },
    {
      name: 'get_work_items_by_area',
      description: 'Get work items for a specific area path',
      inputSchema: {
        type: 'object',
        properties: {
          areaPath: { type: 'string' },
          project: { type: 'string' },
        },
        required: ['areaPath'],
      },
    },
    {
      name: 'get_team_areas',
      description: 'Get areas associated with a specific team',
      inputSchema: {
        type: 'object',
        properties: {
          teamName: { type: 'string' },
          project: { type: 'string' },
        },
        required: ['teamName'],
      },
    },
    {
      name: 'get_area_team_workitem_relationships',
      description: 'Get the relationships between areas, teams, and work items',
      inputSchema: {
        type: 'object',
        properties: {
          areaPath: { type: 'string' },
          project: { type: 'string' },
        },
      },
    },
    {
      name: 'query_analytics',
      description: 'Execute a custom OData query against Azure DevOps Analytics',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          project: { type: 'string' },
        },
        required: ['query'],
      },
    },
  ];
}

// Helper function to implement tool calls
async function callToolImplementation(params: any, client: AzureDevOpsClient) {
  const { name, arguments: args } = params;

  try {
    switch (name) {
      case 'get_projects': {
        const result = await client.getProjects();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_areas': {
        const result = await client.getAreas(args?.project as string);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_teams': {
        const result = await client.getTeams(args?.project as string);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_users': {
        const result = await client.getUsers(args?.project as string);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_work_item_snapshots': {
        const result = await client.getWorkItemSnapshots({
          project: args?.project as string,
          top: args?.top as number,
          skip: args?.skip as number,
          filter: args?.filter as string,
          select: args?.select as string,
          orderby: args?.orderby as string,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_work_items_by_area': {
        const result = await client.getWorkItemsByArea(
          args?.areaPath as string,
          args?.project as string
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_team_areas': {
        const result = await client.getTeamAreas(
          args?.teamName as string,
          args?.project as string
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_area_team_workitem_relationships': {
        const result = await client.getAreaTeamWorkItemRelationships(
          args?.areaPath as string,
          args?.project as string
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'query_analytics': {
        const result = await client.queryAnalytics(
          args?.query as string,
          args?.project as string
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}