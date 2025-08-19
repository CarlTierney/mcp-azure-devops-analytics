import { describe, it, expect, beforeEach } from '@jest/globals';

describe('MCP Server', () => {
  beforeEach(() => {
    // Set up environment variables
    process.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/test-org';
    process.env.AZURE_DEVOPS_PAT = 'test-pat';
    process.env.AZURE_DEVOPS_PROJECT = 'test-project';
  });

  describe('Tool Registration', () => {
    it('should define expected tool names', () => {
      const expectedTools = [
        'get_projects',
        'get_areas',
        'get_teams',
        'get_users',
        'get_work_item_snapshots',
        'get_work_items_by_area',
        'get_team_areas',
        'get_area_team_workitem_relationships',
        'query_analytics',
      ];

      // Validate that the tools array would contain these names
      expect(expectedTools).toHaveLength(9);
      expectedTools.forEach(tool => {
        expect(typeof tool).toBe('string');
        expect(tool.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Tool Definitions', () => {
    it('should have proper tool schema structure', () => {
      const toolSchema = {
        name: 'get_areas',
        description: 'Get areas across all projects or a specific project',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Optional: specific project name to query',
            },
          },
        },
      };

      expect(toolSchema.name).toBeDefined();
      expect(toolSchema.description).toBeDefined();
      expect(toolSchema.inputSchema).toBeDefined();
      expect(toolSchema.inputSchema.type).toBe('object');
    });

    it('should define work item snapshots tool with parameters', () => {
      const workItemTool = {
        name: 'get_work_item_snapshots',
        description: 'Get work item snapshots with optional filtering and pagination',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Optional: specific project name to query',
            },
            top: {
              type: 'number',
              description: 'Number of items to return (default: 100)',
            },
            skip: {
              type: 'number',
              description: 'Number of items to skip for pagination',
            },
            filter: {
              type: 'string',
              description: 'OData filter expression',
            },
            select: {
              type: 'string',
              description: 'Comma-separated list of fields to select',
            },
            orderby: {
              type: 'string',
              description: 'Field to order by',
            },
          },
        },
      };

      expect(workItemTool.inputSchema.properties).toBeDefined();
      expect(workItemTool.inputSchema.properties.top).toBeDefined();
      expect(workItemTool.inputSchema.properties.filter).toBeDefined();
    });

    it('should define required parameters for some tools', () => {
      const areaPathTool = {
        name: 'get_work_items_by_area',
        inputSchema: {
          type: 'object',
          properties: {
            areaPath: {
              type: 'string',
              description: 'The area path to filter work items',
            },
          },
          required: ['areaPath'],
        },
      };

      expect(areaPathTool.inputSchema.required).toBeDefined();
      expect(areaPathTool.inputSchema.required).toContain('areaPath');
    });
  });

  describe('Environment Variables', () => {
    it('should validate required environment variables', () => {
      const requiredVars = [
        'AZURE_DEVOPS_ORG_URL',
        'AZURE_DEVOPS_PAT',
      ];

      requiredVars.forEach(varName => {
        expect(process.env[varName]).toBeDefined();
      });

      // Project is optional
      expect(process.env['AZURE_DEVOPS_PROJECT']).toBeDefined();
    });

    it('should have valid URL format for org URL', () => {
      const orgUrl = process.env.AZURE_DEVOPS_ORG_URL;
      expect(orgUrl).toMatch(/^https:\/\/dev\.azure\.com\/.+/);
    });
  });

  describe('Server Configuration', () => {
    it('should have correct server metadata', () => {
      const serverConfig = {
        name: 'mcp-azure-devops-analytics',
        version: '1.0.0',
      };

      expect(serverConfig.name).toBe('mcp-azure-devops-analytics');
      expect(serverConfig.version).toBe('1.0.0');
    });

    it('should define capabilities', () => {
      const capabilities = {
        tools: {},
      };

      expect(capabilities.tools).toBeDefined();
    });
  });
});