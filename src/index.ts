import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { AzureDevOpsClient, AzureDevOpsConfig } from './azureDevOpsClient.js';
import { StorageManager } from './storageManager.js';
import { MetricsAggregator } from './metricsAggregator.js';
import { AnalyticsClient } from './analyticsClient.js';
import { AdvancedAnalyticsClient } from './advancedAnalytics.js';
import { HistoricalDataCollector } from './historicalDataCollector.js';
import { DeploymentMetricsCollector } from './deploymentMetrics.js';
import { ContributionAnalyzer, compareToBenchmark, comparePeriods } from './git/contribution.js';
import { sdkRepoSource } from './git/repoSync.js';
import { sdkPrSource } from './git/prSync.js';
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
const analyticsClient = new AnalyticsClient(client);
const advancedAnalytics = new AdvancedAnalyticsClient(client);

// Initialize storage and metrics
const cacheDir = process.env.MCP_ANALYTICS_CACHE_DIR || '.mcp-analytics-cache';
const storage = new StorageManager({ baseDir: path.resolve(cacheDir) });
storage.initialize().catch(console.error);

const metricsAggregator = new MetricsAggregator(client, storage);
const historicalCollector = new HistoricalDataCollector(client, storage);
const deploymentCollector = new DeploymentMetricsCollector(client, storage);

const splitList = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
const contribution = new ContributionAnalyzer(
  sdkRepoSource(client.getConnection()),
  sdkPrSource(client.getConnection()),
  {
    cacheDir: path.resolve(cacheDir),
    orgUrl: config.orgUrl,
    pat: config.pat,
    identityMapFile: process.env.IDENTITY_MAP_FILE,
    benchmark: splitList(process.env.BENCHMARK_IDENTITY),
    excludePaths: splitList(process.env.EXCLUDE_PATHS),
    cloneConcurrency: process.env.GIT_CLONE_CONCURRENCY ? Number(process.env.GIT_CLONE_CONCURRENCY) : undefined,
    reworkDays: process.env.REWORK_DAYS ? Number(process.env.REWORK_DAYS) : undefined,
    survivalDays: process.env.SURVIVAL_DAYS ? Number(process.env.SURVIVAL_DAYS) : undefined,
    minActiveWeekLines: process.env.MIN_ACTIVE_WEEK_LINES ? Number(process.env.MIN_ACTIVE_WEEK_LINES) : undefined,
  }
);

function optDate(v: unknown, name: string): Date | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ${name}: ${v}. Use an ISO date (YYYY-MM-DD).`);
  return d;
}

/** Window plus optional benchmark window and pivot, from args with env fallbacks. */
function parsePeriods(args: any) {
  const window = parseWindow(args);
  const bSince = optDate(args?.benchmarkSince ?? process.env.BENCHMARK_SINCE, 'benchmarkSince');
  const bUntil = optDate(args?.benchmarkUntil ?? process.env.BENCHMARK_UNTIL, 'benchmarkUntil');
  const pivot = optDate(args?.pivot ?? process.env.PIVOT_DATE, 'pivot');
  if (pivot && (pivot <= window.since || pivot >= window.until)) {
    throw new Error('pivot must fall inside the since/until window.');
  }
  const benchmarkWindow = { since: bSince ?? window.since, until: bUntil ?? window.until };
  if (benchmarkWindow.since >= benchmarkWindow.until) throw new Error('benchmarkSince must be before benchmarkUntil.');
  return { window, benchmarkWindow, pivot, separateBenchmark: !!(bSince || bUntil) };
}

function splitAtPivot(window: { since: Date; until: Date }, pivot: Date) {
  return {
    before: { since: window.since, until: new Date(pivot.getTime() - 1) },
    after: { since: pivot, until: window.until },
  };
}

function parseWindow(args: any) {
  const until = args?.until ? new Date(args.until as string) : new Date();
  const since = args?.since ? new Date(args.since as string) : new Date(until.getTime() - 90 * 86400000);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) {
    throw new Error('Invalid date window. Use ISO dates (YYYY-MM-DD) with since before until.');
  }
  return { since, until };
}

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
  {
    name: 'get_dashboard_metrics',
    description: 'Get comprehensive dashboard metrics including velocity, cycle time, throughput, quality, DORA, and team health. Supports aggregation queries with filters like date ranges, states, and team names.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name to analyze',
        },
        teamName: {
          type: 'string',
          description: 'Optional team name for team-specific metrics',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'get_work_item_trend',
    description: 'Get work item count by state over time using aggregation. Supports filters: DateSK ranges, State, AreaPath, WorkItemType',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name',
        },
        days: {
          type: 'number',
          description: 'Number of days to look back (default: 30)',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'get_burndown_data',
    description: 'Get burndown chart data for a specific iteration using aggregation by DateSK and State',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name',
        },
        iterationPath: {
          type: 'string',
          description: 'Full iteration path',
        },
      },
      required: ['project', 'iterationPath'],
    },
  },
  {
    name: 'get_cumulative_flow',
    description: 'Get cumulative flow diagram data using aggregation. Groups by DateSK and State',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name',
        },
        days: {
          type: 'number',
          description: 'Number of days to include (default: 30)',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'analyze_lead_time',
    description: 'Analyze lead time with flexible filters (team, area, user, date range) across multiple periods',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name',
        },
        filter: {
          type: 'object',
          properties: {
            teamName: { type: 'string' },
            areaPath: { type: 'string' },
            assignedTo: { type: 'string' },
            workItemType: { type: 'string' },
            state: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            dateRange: {
              type: 'object',
              properties: {
                start: { type: 'string', format: 'date' },
                end: { type: 'string', format: 'date' },
              },
            },
            iterationPath: { type: 'string' },
          },
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'analyze_cycle_time',
    description: 'Analyze cycle time with flexible filters across multiple periods with percentiles',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name',
        },
        filter: {
          type: 'object',
          properties: {
            teamName: { type: 'string' },
            areaPath: { type: 'string' },
            assignedTo: { type: 'string' },
            workItemType: { type: 'string' },
            state: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            dateRange: {
              type: 'object',
              properties: {
                start: { type: 'string', format: 'date' },
                end: { type: 'string', format: 'date' },
              },
            },
          },
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'analyze_throughput',
    description: 'Analyze throughput with baseline projection and spike detection, filterable by team/area/user',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name',
        },
        filter: {
          type: 'object',
          properties: {
            teamName: { type: 'string' },
            areaPath: { type: 'string' },
            assignedTo: { type: 'string' },
            workItemType: { type: 'string' },
          },
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'analyze_failure_load',
    description: 'Analyze failure load with calculated metrics (bug ratio, defect density, escape rate, MTTR)',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name',
        },
        filter: {
          type: 'object',
          properties: {
            teamName: { type: 'string' },
            areaPath: { type: 'string' },
            assignedTo: { type: 'string' },
          },
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'analyze_card_age',
    description: 'Analyze card age distribution with aging detection, filterable by type/team/area/user',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name',
        },
        filter: {
          type: 'object',
          properties: {
            teamName: { type: 'string' },
            areaPath: { type: 'string' },
            assignedTo: { type: 'string' },
            workItemType: { type: 'string' },
            state: { type: 'string' },
          },
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'analyze_backlog_growth',
    description: 'Analyze backlog growth with spike detection and forecasting, filterable by team/area/type',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name',
        },
        filter: {
          type: 'object',
          properties: {
            teamName: { type: 'string' },
            areaPath: { type: 'string' },
            workItemType: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'query_analytics_aggregation',
    description: 'Execute custom OData aggregation queries on Analytics API. Use $apply for aggregations with filter(), groupby(), and aggregate() functions. Example: "WorkItemSnapshot?$apply=filter(DateSK ge 20240101)/groupby((State), aggregate($count as Count))"',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'OData aggregation query with $apply syntax. Must use aggregation for Snapshot tables.',
        },
        project: {
          type: 'string',
          description: 'Project name for the query',
        },
      },
      required: ['query', 'project'],
    },
  },
  {
    name: 'sync_repositories',
    description: 'Mirror-clone (first run) or fetch every Git repository in the organization into the local cache, including forks, empty and hidden repos, then pull pull-request metadata (reviewers, votes, comment threads). Returns a coverage report listing anything not covered and why. Needs a PAT with Code (Read). Run before the contribution tools and again to refresh.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Sync one project only. Default: all projects.' },
        prSince: { type: 'string', description: 'Pull PRs created on or after this date (ISO). Default: 365 days ago.' },
        includeIterations: { type: 'boolean', description: 'Also count push iterations per PR (one extra API call per PR). Default false.' },
      },
    },
  },
  {
    name: 'get_coverage_report',
    description: 'Coverage of the last repository sync: repos discovered, cloned, fetched, empty, disabled, failed (with reasons), plus commit and PR counts per repo.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'analyze_developer_contribution',
    description: 'Per-developer change and pull request metrics from the local git mirrors plus cached PR metadata: commit frequency, active days and weeks, lines and files changed (generated and lock files excluded), rework, PR counts, PR size, time to first review and to complete, approvals, abandon rate, reviews given. Basis is landed work on each default branch.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Start date (ISO, e.g. 2026-07-01). Default: 90 days before until.' },
        until: { type: 'string', description: 'End date (ISO). Default: now.' },
        project: { type: 'string', description: 'Limit to one project. Default: all synced projects.' },
        repository: { type: 'string', description: 'Limit to one repository (name or id).' },
        developers: { type: 'array', items: { type: 'string' }, description: 'Emails or ADO unique names to include. Default: everyone.' },
        pivot: { type: 'string', description: 'Split the window at this date (e.g. the date a team change happened) and report before and after separately. Env fallback: PIVOT_DATE.' },
        survival: { type: 'boolean', description: 'Measure code survival with blame (default true). First run is slow on large orgs; results are cached.' },
      },
    },
  },
  {
    name: 'compare_to_benchmark',
    description: 'Compare each developer to the benchmark developer (BENCHMARK_IDENTITY env or the benchmark argument). Returns per-metric values, the benchmark value, the ratio and which direction is better, normalized per active week, plus a throughput index (1.0 = benchmark). The benchmark can come from its own window (benchmarkSince/benchmarkUntil), and a pivot date splits developers into before and after periods, each compared to the same benchmark.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Start date (ISO, e.g. 2026-07-01). Default: 90 days before until.' },
        until: { type: 'string', description: 'End date (ISO). Default: now.' },
        project: { type: 'string', description: 'Limit to one project. Default: all synced projects.' },
        repository: { type: 'string', description: 'Limit to one repository (name or id).' },
        benchmark: { type: 'array', items: { type: 'string' }, description: 'Benchmark identities (emails / unique names). Overrides BENCHMARK_IDENTITY.' },
        benchmarkSince: { type: 'string', description: 'Take the benchmark figures only from this date on (e.g. when the benchmark started coding). Env fallback: BENCHMARK_SINCE.' },
        benchmarkUntil: { type: 'string', description: 'Benchmark window end. Env fallback: BENCHMARK_UNTIL.' },
        pivot: { type: 'string', description: 'Split the window at this date (e.g. the date a team change happened) and report before and after separately. Env fallback: PIVOT_DATE.' },
        survival: { type: 'boolean', description: 'Measure code survival with blame (default true). First run is slow on large orgs; results are cached.' },
        developers: { type: 'array', items: { type: 'string' }, description: 'Limit to these developers. Default: everyone.' },
      },
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

      case 'get_dashboard_metrics': {
        const result = await analyticsClient.getDashboardMetrics(
          args?.project as string,
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

      case 'get_work_item_trend': {
        const result = await analyticsClient.getWorkItemTrend(
          args?.project as string,
          args?.days as number || 30
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

      case 'get_burndown_data': {
        const result = await analyticsClient.getBurndownData(
          args?.project as string,
          args?.iterationPath as string
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
        const result = await analyticsClient.getCumulativeFlowData(
          args?.project as string,
          args?.days as number || 30
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

      case 'analyze_lead_time': {
        const filter: any = args?.filter || {};
        if (filter.dateRange) {
          filter.dateRange.start = new Date(filter.dateRange.start);
          filter.dateRange.end = new Date(filter.dateRange.end);
        }
        const result = await advancedAnalytics.analyzeLeadTime(
          args?.project as string,
          filter
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

      case 'analyze_cycle_time': {
        const filter: any = args?.filter || {};
        if (filter.dateRange) {
          filter.dateRange.start = new Date(filter.dateRange.start);
          filter.dateRange.end = new Date(filter.dateRange.end);
        }
        const result = await advancedAnalytics.analyzeCycleTime(
          args?.project as string,
          filter
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

      case 'analyze_throughput': {
        const result = await advancedAnalytics.analyzeThroughput(
          args?.project as string,
          args?.filter || {}
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

      case 'analyze_failure_load': {
        const result = await advancedAnalytics.analyzeFailureLoad(
          args?.project as string,
          args?.filter || {}
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

      case 'analyze_card_age': {
        const result = await advancedAnalytics.analyzeCardAge(
          args?.project as string,
          args?.filter || {}
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

      case 'analyze_backlog_growth': {
        const result = await advancedAnalytics.analyzeBacklogGrowth(
          args?.project as string,
          args?.filter || {}
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

      case 'query_analytics_aggregation': {
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

      case 'sync_repositories': {
        const result = await contribution.sync({
          project: args?.project as string | undefined,
          prSince: args?.prSince ? new Date(args.prSince as string) : undefined,
          includeIterations: args?.includeIterations === true,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_coverage_report': {
        const result = await contribution.coverage();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'analyze_developer_contribution': {
        const { window, pivot } = parsePeriods(args);
        const scope = {
          project: args?.project as string | undefined,
          repository: args?.repository as string | undefined,
          developers: args?.developers as string[] | undefined,
          survival: args?.survival !== false,
        };
        const result = pivot
          ? await contribution.analyzePeriods({ ...scope, windows: splitAtPivot(window, pivot) })
          : await contribution.analyze({ ...scope, window });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'compare_to_benchmark': {
        const { window, benchmarkWindow, pivot, separateBenchmark } = parsePeriods(args);
        const scope = {
          project: args?.project as string | undefined,
          repository: args?.repository as string | undefined,
          developers: args?.developers as string[] | undefined,
          benchmark: args?.benchmark as string[] | undefined,
          survival: args?.survival !== false,
        };
        let result: unknown;
        if (pivot) {
          const { before, after } = splitAtPivot(window, pivot);
          const r = await contribution.analyzePeriods({ ...scope, windows: { before, after, benchmark: benchmarkWindow } });
          result = comparePeriods({ before: r.before, after: r.after }, r.benchmark);
        } else if (separateBenchmark) {
          const r = await contribution.analyzePeriods({ ...scope, windows: { window, benchmark: benchmarkWindow } });
          result = compareToBenchmark(r.window, r.benchmark);
        } else {
          result = compareToBenchmark(await contribution.analyze({ ...scope, window }));
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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