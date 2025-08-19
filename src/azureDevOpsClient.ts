import * as azdev from 'azure-devops-node-api';

export interface AzureDevOpsConfig {
  orgUrl: string;
  pat: string;
  project?: string; // Optional - if not provided, queries all projects
}

export class AzureDevOpsClient {
  private connection: azdev.WebApi;
  private config: AzureDevOpsConfig;
  private analyticsUrl: string;

  constructor(config: AzureDevOpsConfig) {
    this.config = config;
    const authHandler = azdev.getPersonalAccessTokenHandler(config.pat);
    this.connection = new azdev.WebApi(config.orgUrl, authHandler);
    
    // Extract organization name and construct Analytics URL
    const orgName = config.orgUrl.split('/').pop();
    this.analyticsUrl = `https://analytics.dev.azure.com/${orgName}`;
  }

  async queryAnalytics(query: string, project?: string): Promise<any> {
    const projectPath = project || this.config.project;
    
    if (!projectPath) {
      throw new Error('Project name is required. Please specify a project parameter or configure a default project.');
    }
    
    const url = `${this.analyticsUrl}/${projectPath}/_odata/v3.0-preview/${query}`;

    try {
      const response = await this.connection.rest.get(url);
      return response.result;
    } catch (error: any) {
      if (error.message?.includes('VS403496')) {
        throw new Error(`Access denied to project '${projectPath}'. Please verify the project name and your permissions.`);
      }
      if (error.message?.includes('404')) {
        throw new Error(`Project '${projectPath}' not found. Please provide a valid project name.`);
      }
      throw new Error(`Analytics query failed for project '${projectPath}': ${error.message || error}`);
    }
  }

  async getProjects(): Promise<any> {
    const query = `Projects?$select=ProjectSK,ProjectId,ProjectName&$orderby=ProjectName`;
    const url = `${this.analyticsUrl}/_odata/v3.0-preview/${query}`;
    
    try {
      const response = await this.connection.rest.get(url);
      return response.result;
    } catch (error: any) {
      throw new Error(`Failed to get projects: ${error.message || error}`);
    }
  }

  async getAreas(project?: string): Promise<any> {
    // When no project is specified, aggregate from all accessible projects
    if (!project && !this.config.project) {
      const projects = await this.getProjects();
      if (projects.value && projects.value.length > 0) {
        // Fetch areas from each project and combine
        const allAreas: any[] = [];
        for (const proj of projects.value) {
          try {
            const query = `Areas?$select=AreaId,AreaName,AreaPath,ProjectSK,AreaLevel1,AreaLevel2,AreaLevel3,AreaLevel4&$orderby=AreaPath`;
            const result = await this.queryAnalytics(query, proj.ProjectName);
            if (result?.value) {
              allAreas.push(...result.value);
            }
          } catch (err) {
            // Skip projects we can't access
          }
        }
        return { value: allAreas, '@odata.context': 'Areas' };
      }
    }
    const query = `Areas?$select=AreaId,AreaName,AreaPath,ProjectSK,AreaLevel1,AreaLevel2,AreaLevel3,AreaLevel4&$orderby=AreaPath`;
    return this.queryAnalytics(query, project);
  }

  async getTeams(project?: string): Promise<any> {
    // When no project is specified, aggregate from all accessible projects
    if (!project && !this.config.project) {
      const projects = await this.getProjects();
      if (projects.value && projects.value.length > 0) {
        const allTeams: any[] = [];
        for (const proj of projects.value) {
          try {
            const query = `Teams?$select=TeamId,TeamName,TeamSK,ProjectSK&$orderby=TeamName`;
            const result = await this.queryAnalytics(query, proj.ProjectName);
            if (result?.value) {
              // Add project name to each team for reference
              result.value.forEach((team: any) => {
                team.ProjectName = proj.ProjectName;
              });
              allTeams.push(...result.value);
            }
          } catch (err) {
            // Skip projects we can't access
          }
        }
        return { value: allTeams, '@odata.context': 'Teams' };
      }
    }
    const query = `Teams?$select=TeamId,TeamName,TeamSK,ProjectSK&$orderby=TeamName`;
    return this.queryAnalytics(query, project);
  }

  async getUsers(project?: string): Promise<any> {
    // Domain field is not available when querying with project scope
    const selectFields = project || this.config.project 
      ? 'UserSK,UserName,UserEmail' 
      : 'UserSK,UserName,UserEmail,Domain';
    const query = `Users?$select=${selectFields}&$orderby=UserName`;
    return this.queryAnalytics(query, project);
  }

  async getWorkItemSnapshots(options: {
    project?: string;
    top?: number;
    skip?: number;
    filter?: string;
    select?: string;
    expand?: string;
    orderby?: string;
  } = {}): Promise<any> {
    const queryParams: string[] = [];
    
    // When no project is specified, we need to query from first accessible project
    // or aggregate from multiple projects
    if (!options.project && !this.config.project) {
      const projects = await this.getProjects();
      if (projects.value && projects.value.length > 0) {
        // For simplicity, query from first project when no specific project is given
        // You could also aggregate from all projects if needed
        options.project = projects.value[0].ProjectName;
      }
    }
    
    if (options.top) queryParams.push(`$top=${options.top}`);
    if (options.skip) queryParams.push(`$skip=${options.skip}`);
    if (options.filter) queryParams.push(`$filter=${encodeURIComponent(options.filter)}`);
    if (options.select) queryParams.push(`$select=${options.select}`);
    if (options.expand) queryParams.push(`$expand=${options.expand}`);
    if (options.orderby) queryParams.push(`$orderby=${options.orderby}`);

    const query = `WorkItemSnapshot${queryParams.length > 0 ? '?' + queryParams.join('&') : ''}`;
    return this.queryAnalytics(query, options.project);
  }

  async getWorkItemsByArea(areaPath: string, project?: string): Promise<any> {
    const filter = `AreaPath eq '${areaPath}' and DateValue eq DateSK`;
    const select = 'WorkItemId,Title,WorkItemType,State,AssignedUser,AreaPath,IterationPath';
    return this.getWorkItemSnapshots({ project, filter, select, top: 100 });
  }

  async getTeamAreas(teamName: string, project?: string): Promise<any> {
    const teamsResponse = await this.getTeams(project);
    const team = teamsResponse.value?.find((t: any) => t.TeamName === teamName);
    
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }

    const areasQuery = `TeamAreas?$filter=TeamSK eq ${team.TeamSK}&$select=AreaPath&$orderby=AreaPath`;
    const areasResponse = await this.queryAnalytics(areasQuery, project);
    
    return {
      team: team,
      areas: areasResponse.value || []
    };
  }

  async getAreaTeamWorkItemRelationships(areaPath?: string, project?: string): Promise<any> {
    const areasFilter = areaPath ? `&$filter=AreaPath eq '${areaPath}'` : '';
    const areas = await this.queryAnalytics(`Areas?$select=AreaId,AreaPath,AreaName,ProjectSK${areasFilter}`, project);
    
    const relationships: any[] = [];
    
    for (const area of areas.value || []) {
      const teamAreasQuery = `TeamAreas?$filter=AreaPath eq '${area.AreaPath}'&$expand=Team($select=TeamName)`;
      const teamAreas = await this.queryAnalytics(teamAreasQuery, project);
      
      const workItemsFilter = `AreaPath eq '${area.AreaPath}' and DateValue eq DateSK`;
      const workItems = await this.getWorkItemSnapshots({
        project,
        filter: workItemsFilter,
        select: 'WorkItemId,Title,WorkItemType,State',
        top: 50
      });
      
      relationships.push({
        area: {
          id: area.AreaId,
          path: area.AreaPath,
          name: area.AreaName,
          projectSK: area.ProjectSK
        },
        teams: teamAreas.value?.map((ta: any) => ta.Team) || [],
        workItemCount: workItems['@odata.count'] || workItems.value?.length || 0,
        sampleWorkItems: workItems.value?.slice(0, 5) || []
      });
    }
    
    return relationships;
  }

  async getIterations(project?: string, options?: { current?: boolean; timeframe?: 'past' | 'current' | 'future' }): Promise<any> {
    if (!project && !this.config.project) {
      // Aggregate from all projects
      const projects = await this.getProjects();
      if (projects.value && projects.value.length > 0) {
        const allIterations: any[] = [];
        for (const proj of projects.value) {
          try {
            const projIterations = await this.getIterations(proj.ProjectName, options);
            if (projIterations.value) {
              allIterations.push(...projIterations.value);
            }
          } catch (error) {
            console.error(`Error fetching iterations for project ${proj.ProjectName}:`, error);
          }
        }
        return { value: allIterations };
      }
      return { value: [] };
    }

    const projectPath = project || this.config.project;
    let query = `Iterations?$select=IterationSK,IterationPath,IterationName,StartDateSK,EndDateSK,IsEnded`;
    
    if (options?.current) {
      const today = new Date().toISOString().split('T')[0];
      query += `&$filter=StartDateSK le ${today} and EndDateSK ge ${today}`;
    } else if (options?.timeframe) {
      const today = new Date().toISOString().split('T')[0];
      switch (options.timeframe) {
        case 'past':
          query += `&$filter=EndDateSK lt ${today}`;
          break;
        case 'current':
          query += `&$filter=StartDateSK le ${today} and EndDateSK ge ${today}`;
          break;
        case 'future':
          query += `&$filter=StartDateSK gt ${today}`;
          break;
      }
    }
    
    query += `&$orderby=StartDateSK desc`;
    return this.queryAnalytics(query, projectPath);
  }

  async getWorkItemHistory(workItemId: number, project?: string): Promise<any> {
    const projectPath = project || this.config.project;
    
    // Get all snapshots for a work item to see its history
    const query = `WorkItemSnapshot?$select=WorkItemId,Revision,State,ChangedDateSK,AssignedToUserSK,AreaSK,IterationSK,Title` +
                  `&$filter=WorkItemId eq ${workItemId}` +
                  `&$orderby=Revision asc`;
    
    const snapshots = await this.queryAnalytics(query, projectPath);
    
    if (snapshots.value && snapshots.value.length > 0) {
      // Calculate state transitions and cycle time
      const history: any = {
        workItemId,
        totalRevisions: snapshots.value.length,
        stateTransitions: [],
        currentState: snapshots.value[snapshots.value.length - 1].State,
        createdDate: snapshots.value[0].ChangedDateSK,
        lastModifiedDate: snapshots.value[snapshots.value.length - 1].ChangedDateSK,
        cycleTime: null,
        leadTime: null
      };
      
      // Track state transitions
      let previousState = null;
      let inProgressDate = null;
      let doneDate = null;
      
      for (const snapshot of snapshots.value) {
        if (snapshot.State !== previousState) {
          history.stateTransitions.push({
            fromState: previousState,
            toState: snapshot.State,
            date: snapshot.ChangedDateSK,
            revision: snapshot.Revision
          });
          
          // Track key dates for cycle/lead time
          if (snapshot.State === 'Active' || snapshot.State === 'In Progress') {
            inProgressDate = snapshot.ChangedDateSK;
          }
          if (snapshot.State === 'Closed' || snapshot.State === 'Done' || snapshot.State === 'Resolved') {
            doneDate = snapshot.ChangedDateSK;
          }
          
          previousState = snapshot.State;
        }
      }
      
      // Calculate cycle time (from In Progress to Done)
      if (inProgressDate && doneDate) {
        const start = new Date(inProgressDate);
        const end = new Date(doneDate);
        history.cycleTime = Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)); // Days
      }
      
      // Calculate lead time (from Created to Done)
      if (doneDate) {
        const start = new Date(history.createdDate);
        const end = new Date(doneDate);
        history.leadTime = Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)); // Days
      }
      
      return history;
    }
    
    return { error: 'Work item not found' };
  }

  async getTeamMembers(teamName: string, project?: string): Promise<any> {
    const projectPath = project || this.config.project;
    
    // First get the team's TeamSK
    const teamsQuery = `Teams?$select=TeamSK,TeamName&$filter=TeamName eq '${teamName}'`;
    const teams = await this.queryAnalytics(teamsQuery, projectPath);
    
    if (!teams.value || teams.value.length === 0) {
      return { error: `Team '${teamName}' not found` };
    }
    
    const teamSK = teams.value[0].TeamSK;
    
    // Get work items assigned to users in areas managed by this team
    // This is an approximation since direct team membership might not be available
    const teamAreasQuery = `TeamAreas?$select=AreaSK&$filter=TeamSK eq '${teamSK}'`;
    const teamAreas = await this.queryAnalytics(teamAreasQuery, projectPath);
    
    if (!teamAreas.value || teamAreas.value.length === 0) {
      // Fallback: assume team name matches area name
      const areasQuery = `Areas?$select=AreaSK&$filter=contains(AreaPath, '${teamName}')`;
      const areas = await this.queryAnalytics(areasQuery, projectPath);
      
      if (areas.value && areas.value.length > 0) {
        const areaSKs = areas.value.map((a: any) => `'${a.AreaSK}'`).join(',');
        const workItemsQuery = `WorkItemSnapshot?$select=AssignedToUserSK&$filter=AreaSK in (${areaSKs}) and AssignedToUserSK ne null&$apply=groupby((AssignedToUserSK))`;
        const workItems = await this.queryAnalytics(workItemsQuery, projectPath);
        
        if (workItems.value) {
          // Get user details
          const userSKs = workItems.value.map((wi: any) => `'${wi.AssignedToUserSK}'`).join(',');
          const usersQuery = `Users?$select=UserSK,UserName,UserEmail&$filter=UserSK in (${userSKs})`;
          const users = await this.queryAnalytics(usersQuery, projectPath);
          
          return {
            teamName,
            members: users.value || [],
            memberCount: users.value?.length || 0,
            note: 'Members inferred from work item assignments in team areas'
          };
        }
      }
    }
    
    return { teamName, members: [], memberCount: 0, note: 'No members found' };
  }
}