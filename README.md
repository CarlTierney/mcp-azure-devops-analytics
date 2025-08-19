# MCP Azure DevOps Analytics Server

An MCP (Model Context Protocol) server that provides AI assistants with powerful analytics capabilities for Azure DevOps. This server enables AI to analyze work items, teams, areas, provide data quality insights, and offer intelligent coaching for Azure DevOps configuration.

## Features

### Core Analytics (12 Tools)
- Query across all projects or specific projects in your organization
- List all projects in the Azure DevOps organization
- Query Azure DevOps areas, teams, and users (organization-wide or per project)
- Access work item snapshots with flexible filtering
- Resolve relationships between areas, teams, and work items
- Execute custom OData queries against Azure DevOps Analytics
- Get sprint/iteration data with time-based filtering
- Track work item history with cycle time and lead time metrics
- Retrieve team member information
- Full pagination and filtering support

### Advanced Capabilities
- **Local Storage Management** - Cache large datasets locally for efficient analysis
- **Data Quality Analysis** - Identify unassigned work items, orphaned data, duplicates
- **Insight Extraction** - Generate team productivity metrics, velocity trends
- **Health Reports** - Comprehensive project health assessments
- **AI Coaching** - Guide users through Azure DevOps configuration

### Agile & DORA Metrics (6 New Tools)
- **Sprint Metrics** - Calculate velocity, burndown, and sprint health
- **Flow Metrics** - Measure cycle time, lead time, WIP, and throughput
- **DORA Metrics** - Track deployment frequency, lead time for changes, MTTR, and change failure rate
- **Cumulative Flow** - Generate CFD data to identify workflow bottlenecks
- **Historical Data** - Collect and analyze historical metrics for trend analysis
- **Delivery Prediction** - Predict delivery dates based on historical velocity

## MCP Configuration

To use this server with Claude or other AI assistants, add it to your MCP configuration:

### Example MCP Configuration

Create or update your MCP configuration file (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "azure-devops-analytics": {
      "command": "node",
      "args": ["path/to/mcp-azure-devops-analytics/dist/index.js"],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://dev.azure.com/your-organization",
        "AZURE_DEVOPS_PAT": "your-personal-access-token",
        "AZURE_DEVOPS_PROJECT": "your-project-name",
        "MCP_ANALYTICS_CACHE_DIR": "/absolute/path/to/analytics/cache"
      }
    }
  }
}
```

Alternatively, you can use npx:

```json
{
  "mcpServers": {
    "azure-devops-analytics": {
      "command": "npx",
      "args": ["mcp-azure-devops-analytics"],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://dev.azure.com/your-organization",
        "AZURE_DEVOPS_PAT": "your-personal-access-token",
        "MCP_ANALYTICS_CACHE_DIR": "/absolute/path/to/analytics/cache"
      }
    }
  }
}
```

## Setup

### Prerequisites

- Node.js 18+ installed
- Azure DevOps organization with Analytics enabled
- Personal Access Token (PAT) with analytics read permissions

### Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file based on `.env.example`:
   ```bash
   cp .env.example .env
   ```

4. Configure your Azure DevOps settings in `.env`:
   ```
   AZURE_DEVOPS_ORG_URL=https://dev.azure.com/your-organization
   AZURE_DEVOPS_PAT=your-personal-access-token
   AZURE_DEVOPS_PROJECT=your-project-name  # Optional - leave empty to query all projects
   MCP_ANALYTICS_CACHE_DIR=.mcp-analytics-cache  # Working directory for analytics cache
   ```

### Working Directory Configuration

The MCP server uses a local working directory to store:
- Cached analytics data for faster queries
- Historical metrics for trend analysis
- Session data for complex multi-step analyses
- Generated reports in JSON, CSV, and Markdown formats

The working directory is configured via the `MCP_ANALYTICS_CACHE_DIR` environment variable:
- **Default**: `.mcp-analytics-cache` in the current directory
- **Recommended**: Use an absolute path for production deployments
- **Structure**: Automatically organized into subdirectories for different data types

Example directory structure:
```
.mcp-analytics-cache/
├── cache/           # Temporary cached data
├── sessions/        # Active analysis sessions
├── reports/         # Generated reports
├── analysis/        # Analysis results
└── metrics/         # Historical metrics data
    ├── daily/       # Daily aggregations
    ├── weekly/      # Weekly rollups
    └── monthly/     # Monthly summaries
```

### Building

```bash
npm run build
```

### Running

For development:
```bash
npm run dev
```

For production:
```bash
npm start
```

### Testing

#### Unit Tests
Run unit tests (no Azure DevOps connection required):
```bash
npm test              # Run unit tests
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
```

#### Integration Tests
Integration tests require a valid Azure DevOps connection. Set up your `.env` file with:
- `AZURE_DEVOPS_ORG_URL`: Your Azure DevOps organization URL
- `AZURE_DEVOPS_PAT`: A valid Personal Access Token with Analytics read permissions
- `AZURE_DEVOPS_PROJECT`: (Optional) Default project for testing

Validate your configuration:
```bash
npm run validate  # Test connection and verify credentials
```

Run integration tests:
```bash
npm run test:integration  # Run integration tests only
npm run test:all         # Run both unit and integration tests
```

**Note**: Integration tests will be automatically skipped if no valid credentials are found in the `.env` file.

## Available Tools

### get_projects
Get all projects in the Azure DevOps organization.

### get_areas
Get areas across all projects or a specific project.

Parameters:
- `project`: Optional specific project name to query

### get_teams
Get teams across all projects or a specific project.

Parameters:
- `project`: Optional specific project name to query

### get_users
Get users across all projects or a specific project.

Parameters:
- `project`: Optional specific project name to query

### get_work_item_snapshots
Get work item snapshots with optional filtering and pagination.

Parameters:
- `project`: Optional specific project name to query
- `top`: Number of items to return
- `skip`: Number of items to skip for pagination
- `filter`: OData filter expression
- `select`: Comma-separated list of fields to select
- `orderby`: Field to order by

### get_work_items_by_area
Get work items for a specific area path.

Parameters:
- `areaPath`: The area path to filter work items
- `project`: Optional specific project name to query

### get_team_areas
Get areas associated with a specific team.

Parameters:
- `teamName`: The name of the team
- `project`: Optional specific project name to query

### get_area_team_workitem_relationships
Get the relationships between areas, teams, and work items.

Parameters:
- `areaPath`: Optional specific area path to analyze
- `project`: Optional specific project name to query

### query_analytics
Execute a custom OData query against Azure DevOps Analytics.

Parameters:
- `query`: The OData query string
- `project`: Optional specific project name to query

## MCP Client Configuration

To use this server with an MCP client (e.g., Claude Desktop), add the following to your MCP client configuration:

```json
{
  "mcpServers": {
    "azure-devops-analytics": {
      "command": "node",
      "args": ["path/to/dist/index.js"],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://dev.azure.com/your-organization",
        "AZURE_DEVOPS_PAT": "your-pat",
        "AZURE_DEVOPS_PROJECT": "your-project",  // Optional - default project
        "MCP_ANALYTICS_CACHE_DIR": "path/to/cache"  // Optional - working directory
      },
      "workingDirectory": "path/to/mcp-azure-devops-analytics"
    }
  }
}
```

### Working Directory Structure

The server creates a local cache directory for analytics operations:

```
.mcp-analytics-cache/
├── cache/          # Temporary cached data (auto-expires)
├── analysis/       # Analysis results
├── reports/        # Generated reports (JSON, CSV, Markdown)
├── mappings/       # Team-area relationship mappings
└── sessions/       # Multi-step operation tracking
```

## Example Queries

### Get all projects
```javascript
{
  "tool": "get_projects"
}
```

### Get areas from a specific project
```javascript
{
  "tool": "get_areas",
  "arguments": {
    "project": "MyProject"
  }
}
```

### Get work items in active state from all projects
```javascript
{
  "tool": "get_work_item_snapshots",
  "arguments": {
    "filter": "State eq 'Active'",
    "select": "WorkItemId,Title,AssignedUser,ProjectSK",
    "top": 20
  }
}
```

### Get work items from a specific project
```javascript
{
  "tool": "get_work_item_snapshots",
  "arguments": {
    "project": "MyProject",
    "filter": "State eq 'Active'",
    "select": "WorkItemId,Title,AssignedUser",
    "top": 20
  }
}
```

### Get area-team relationships
```javascript
{
  "tool": "get_area_team_workitem_relationships",
  "arguments": {
    "areaPath": "ProjectName\\AreaPath"
  }
}
```

### Custom analytics query
```javascript
{
  "tool": "query_analytics",
  "arguments": {
    "query": "WorkItems?$filter=WorkItemType eq 'Bug' and State ne 'Closed'&$top=50"
  }
}
```

## Testing

### Integration Testing

This project includes comprehensive integration tests that validate the actual connection to Azure DevOps Analytics. These tests:

1. **Verify API connectivity** - Ensures your PAT and organization URL are valid
2. **Test all query methods** - Validates each tool against real Azure DevOps data
3. **Check data relationships** - Tests the area-team-workitem relationship resolution
4. **Validate filtering and pagination** - Ensures OData queries work correctly
5. **Test cross-project queries** - Verifies organization-wide data access

#### Running Integration Tests

1. Create a `.env` file with your Azure DevOps credentials:
   ```env
   AZURE_DEVOPS_ORG_URL=https://dev.azure.com/your-organization
   AZURE_DEVOPS_PAT=your-personal-access-token
   AZURE_DEVOPS_PROJECT=optional-default-project
   ```

2. Ensure your PAT has the following permissions:
   - Analytics (Read)
   - Work Items (Read)
   - Project and Team (Read)

3. Validate your configuration:
   ```bash
   npm run validate
   ```
   
   This will test your connection and show available projects.

4. Run the integration tests:
   ```bash
   npm run test:integration
   ```

#### What the Integration Tests Validate

- **Projects**: Lists all projects in your organization
- **Areas**: Fetches area paths and validates hierarchy
- **Teams**: Retrieves team information and configurations
- **Users**: Gets user data from the organization
- **Work Items**: Tests querying, filtering, and pagination
- **Relationships**: Validates complex area-team-workitem relationships
- **Custom Queries**: Tests OData query execution
- **Error Handling**: Ensures graceful handling of invalid requests

Integration tests provide detailed console output showing:
- Number of items retrieved
- Sample data from each query
- Performance metrics (each test has a 30-60 second timeout)
- Clear error messages if authentication fails

## License

MIT