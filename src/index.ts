import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { AzureDevOpsClient, AzureDevOpsConfig } from './azureDevOpsClient.js';
import { StorageManager } from './storageManager.js';
import { MetricsAggregator } from './metricsAggregator.js';
import { HistoricalDataCollector } from './historicalDataCollector.js';
import { DeploymentMetricsCollector } from './deploymentMetrics.js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const config: AzureDevOpsConfig = {
  orgUrl: process.env.AZURE_DEVOPS_ORG_URL || '',
  pat: process.env.AZURE_DEVOPS_PAT || '',
  project: process.env.AZURE_DEVOPS_PROJECT // Optional - can be undefined
};

if (!config.orgUrl || !config.pat) {
  console.error('Missing required environment variables. Please set AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PAT');
  process.exit(1);
}

const client = new AzureDevOpsClient(config);

// Initialize storage and metrics
const cacheDir = process.env.MCP_ANALYTICS_CACHE_DIR || '.mcp-analytics-cache';
const storage = new StorageManager({ baseDir: path.resolve(cacheDir) });
storage.initialize().catch(console.error);

const metricsAggregator = new MetricsAggregator(client, storage);
const historicalCollector = new HistoricalDataCollector(client, storage);
const deploymentCollector = new DeploymentMetricsCollector(client, storage);

const server = new Server(
  {
    name: 'mcp-azure-devops-analytics',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const tools = [
  {
    name: 'get_projects',
    description: 'Get all projects in the Azure DevOps organization',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
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
  },
  {
    name: 'get_teams',
    description: 'Get teams across all projects or a specific project',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Optional: specific project name to query',
        },
      },
    },
  },
  {
    name: 'get_users',
    description: 'Get users across all projects or a specific project',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Optional: specific project name to query',
        },
      },
    },
  },
  {
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
          description: 'OData filter expression (e.g., "State eq \'Active\'")',
        },
        select: {
          type: 'string',
          description: 'Comma-separated list of fields to select',
        },
        orderby: {
          type: 'string',
          description: 'Field to order by (e.g., "ChangedDate desc")',
        },
      },
    },
  },
  {
    name: 'get_work_items_by_area',
    description: 'Get work items for a specific area path',
    inputSchema: {
      type: 'object',
      properties: {
        areaPath: {
          type: 'string',
          description: 'The area path to filter work items',
        },
        project: {
          type: 'string',
          description: 'Optional: specific project name to query',
        },
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
        teamName: {
          type: 'string',
          description: 'The name of the team',
        },
        project: {
          type: 'string',
          description: 'Optional: specific project name to query',
        },
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
        areaPath: {
          type: 'string',
          description: 'Optional: specific area path to analyze',
        },
        project: {
          type: 'string',
          description: 'Optional: specific project name to query',
        },
      },
    },
  },
  {
    name: 'query_analytics',
    description: 'Execute a custom OData query against Azure DevOps Analytics',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The OData query string (e.g., "WorkItems?$select=WorkItemId,Title&$top=10")',
        },
        project: {
          type: 'string',
          description: 'Optional: specific project name to query',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_iterations',
    description: 'Get iteration/sprint data for a project',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Optional: specific project name to query',
        },
        current: {
          type: 'boolean',
          description: 'Get only the current iteration',
        },
        timeframe: {
          type: 'string',
          enum: ['past', 'current', 'future'],
          description: 'Filter iterations by timeframe',
        },
      },
    },
  },
  {
    name: 'get_work_item_history',
    description: 'Get the complete history and state transitions of a work item',
    inputSchema: {
      type: 'object',
      properties: {
        workItemId: {
          type: 'number',
          description: 'The ID of the work item',
        },
        project: {
          type: 'string',
          description: 'Optional: specific project name to query',
        },
      },
      required: ['workItemId'],
    },
  },
  {
    name: 'get_team_members',
    description: 'Get members of a specific team',
    inputSchema: {
      type: 'object',
      properties: {
        teamName: {
          type: 'string',
          description: 'The name of the team',
        },
        project: {
          type: 'string',
          description: 'Optional: specific project name to query',
        },
      },
      required: ['teamName'],
    },
  },
  {
    name: 'get_sprint_metrics',
    description: 'Calculate sprint velocity, burndown, and health metrics for Agile dashboards',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name to analyze',
        },
        iterationPath: {
          type: 'string',
          description: 'Optional: specific sprint/iteration path',
        },
        numberOfSprints: {
          type: 'number',
          description: 'Number of sprints to analyze for trends (default: 1)',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'calculate_flow_metrics',
    description: 'Calculate cycle time, lead time, WIP, and throughput for Kanban/flow metrics',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name to analyze',
        },
        dateRange: {
          type: 'object',
          properties: {
            start: {
              type: 'string',
              description: 'Start date (ISO format)',
            },
            end: {
              type: 'string',
              description: 'End date (ISO format)',
            },
          },
          required: ['start', 'end'],
        },
        teamName: {
          type: 'string',
          description: 'Optional: specific team to analyze',
        },
      },
      required: ['project', 'dateRange'],
    },
  },
  {
    name: 'calculate_dora_metrics',
    description: 'Calculate DORA metrics: deployment frequency, lead time, MTTR, and change failure rate',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name to analyze',
        },
        dateRange: {
          type: 'object',
          properties: {
            start: {
              type: 'string',
              description: 'Start date (ISO format)',
            },
            end: {
              type: 'string',
              description: 'End date (ISO format)',
            },
          },
          required: ['start', 'end'],
        },
      },
      required: ['project', 'dateRange'],
    },
  },
  {
    name: 'get_cumulative_flow',
    description: 'Get cumulative flow diagram data to identify bottlenecks in workflow',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name to analyze',
        },
        dateRange: {
          type: 'object',
          properties: {
            start: {
              type: 'string',
              description: 'Start date (ISO format)',
            },
            end: {
              type: 'string',
              description: 'End date (ISO format)',
            },
          },
          required: ['start', 'end'],
        },
        interval: {
          type: 'string',
          enum: ['daily', 'weekly'],
          description: 'Data interval (default: daily)',
        },
      },
      required: ['project', 'dateRange'],
    },
  },
  {
    name: 'collect_historical_data',
    description: 'Collect and cache historical metrics data for trend analysis',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name to analyze',
        },
        dateRange: {
          type: 'object',
          properties: {
            start: {
              type: 'string',
              description: 'Start date (ISO format)',
            },
            end: {
              type: 'string',
              description: 'End date (ISO format)',
            },
          },
          required: ['start', 'end'],
        },
        metricTypes: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['velocity', 'flow', 'dora', 'quality'],
          },
          description: 'Types of metrics to collect (default: all)',
        },
      },
      required: ['project', 'dateRange'],
    },
  },
  {
    name: 'get_metrics_trend',
    description: 'Get historical trend for a specific metric with forecasting',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name to analyze',
        },
        metricType: {
          type: 'string',
          description: 'Type of metric (velocity, cycleTime, leadTime, throughput, deploymentFrequency, mttr, changeFailureRate)',
        },
        periods: {
          type: 'number',
          description: 'Number of periods to analyze (default: 6)',
        },
        interval: {
          type: 'string',
          enum: ['daily', 'weekly', 'monthly', 'sprint'],
          description: 'Time interval for trend (default: sprint)',
        },
      },
      required: ['project', 'metricType'],
    },
  },
  {
    name: 'get_deployment_metrics',
    description: 'Get build, deployment, and pipeline metrics for DORA calculations',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name to analyze',
        },
        dateRange: {
          type: 'object',
          properties: {
            start: {
              type: 'string',
              description: 'Start date (ISO format)',
            },
            end: {
              type: 'string',
              description: 'End date (ISO format)',
            },
          },
          required: ['start', 'end'],
        },
        environment: {
          type: 'string',
          enum: ['development', 'staging', 'production'],
          description: 'Deployment environment to filter by',
        },
        pipelineName: {
          type: 'string',
          description: 'Specific pipeline name to filter by',
        },
      },
      required: ['project', 'dateRange'],
    },
  },
  {
    name: 'get_incident_metrics',
    description: 'Track incidents and recovery times for MTTR calculations',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name to analyze',
        },
        dateRange: {
          type: 'object',
          properties: {
            start: {
              type: 'string',
              description: 'Start date (ISO format)',
            },
            end: {
              type: 'string',
              description: 'End date (ISO format)',
            },
          },
          required: ['start', 'end'],
        },
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Filter by incident severity',
        },
        includeRootCause: {
          type: 'boolean',
          description: 'Include root cause analysis in results',
        },
      },
      required: ['project', 'dateRange'],
    },
  },
  {
    name: 'predict_delivery',
    description: 'Predict delivery dates based on historical velocity and remaining work',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name to analyze',
        },
        remainingWork: {
          type: 'number',
          description: 'Amount of remaining work (story points or item count)',
        },
        workUnit: {
          type: 'string',
          enum: ['points', 'items'],
          description: 'Unit of work measurement (default: points)',
        },
        teamName: {
          type: 'string',
          description: 'Specific team for velocity calculation',
        },
        confidenceLevel: {
          type: 'number',
          description: 'Confidence level for predictions (50-95, default: 85)',
        },
      },
      required: ['project', 'remainingWork'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_projects': {
        const result = await client.getProjects();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_areas': {
        const result = await client.getAreas(args?.project as string);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_teams': {
        const result = await client.getTeams(args?.project as string);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_users': {
        const result = await client.getUsers(args?.project as string);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
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
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_work_items_by_area': {
        const result = await client.getWorkItemsByArea(
          args?.areaPath as string,
          args?.project as string
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_team_areas': {
        const result = await client.getTeamAreas(
          args?.teamName as string,
          args?.project as string
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_area_team_workitem_relationships': {
        const result = await client.getAreaTeamWorkItemRelationships(
          args?.areaPath as string,
          args?.project as string
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'query_analytics': {
        const result = await client.queryAnalytics(
          args?.query as string,
          args?.project as string
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_iterations': {
        const result = await client.getIterations(
          args?.project as string,
          {
            current: args?.current as boolean,
            timeframe: args?.timeframe as 'past' | 'current' | 'future'
          }
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_work_item_history': {
        const result = await client.getWorkItemHistory(
          args?.workItemId as number,
          args?.project as string
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_team_members': {
        const result = await client.getTeamMembers(
          args?.teamName as string,
          args?.project as string
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_sprint_metrics': {
        const result = await metricsAggregator.calculateSprintMetrics(
          args?.project as string,
          args?.iterationPath as string,
          args?.numberOfSprints as number
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'calculate_flow_metrics': {
        const dateRange = args?.dateRange as { start: string; end: string };
        const result = await metricsAggregator.calculateFlowMetrics(
          args?.project as string,
          {
            start: new Date(dateRange.start),
            end: new Date(dateRange.end)
          },
          args?.teamName as string
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'calculate_dora_metrics': {
        const dateRange = args?.dateRange as { start: string; end: string };
        const result = await metricsAggregator.calculateDoraMetrics(
          args?.project as string,
          {
            start: new Date(dateRange.start),
            end: new Date(dateRange.end)
          }
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_cumulative_flow': {
        const dateRange = args?.dateRange as { start: string; end: string };
        const result = await metricsAggregator.getCumulativeFlow(
          args?.project as string,
          {
            start: new Date(dateRange.start),
            end: new Date(dateRange.end)
          },
          args?.interval as 'daily' | 'weekly'
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'collect_historical_data': {
        const dateRange = args?.dateRange as { start: string; end: string };
        const result = await historicalCollector.collectHistoricalData(
          args?.project as string,
          {
            start: new Date(dateRange.start),
            end: new Date(dateRange.end)
          },
          args?.metricTypes as string[]
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_metrics_trend': {
        const result = await historicalCollector.getMetricsTrend(
          args?.project as string,
          args?.metricType as string,
          args?.periods as number,
          args?.interval as string
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_deployment_metrics': {
        const dateRange = args?.dateRange as { start: string; end: string };
        const result = await deploymentCollector.getDeploymentMetrics(
          args?.project as string,
          {
            start: new Date(dateRange.start),
            end: new Date(dateRange.end)
          },
          args?.environment as 'development' | 'staging' | 'production',
          args?.pipelineName as string
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_incident_metrics': {
        const dateRange = args?.dateRange as { start: string; end: string };
        const result = await deploymentCollector.getIncidentMetrics(
          args?.project as string,
          {
            start: new Date(dateRange.start),
            end: new Date(dateRange.end)
          },
          args?.severity as 'critical' | 'high' | 'medium' | 'low',
          args?.includeRootCause as boolean
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'predict_delivery': {
        const result = await deploymentCollector.predictDelivery(
          args?.project as string,
          args?.remainingWork as number,
          args?.workUnit as 'points' | 'items',
          args?.teamName as string,
          args?.confidenceLevel as number
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Azure DevOps Analytics MCP server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});