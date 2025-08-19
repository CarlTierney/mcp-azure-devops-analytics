import { AzureDevOpsClient } from './azureDevOpsClient.js';
import { StorageManager } from './storageManager.js';

export interface DataExtractionConfig {
  project: string;
  dateRange?: {
    start: Date;
    end: Date;
  };
  entities: Array<'areas' | 'teams' | 'users' | 'workitems' | 'iterations' | 'all'>;
  includeHistory?: boolean;
  batchSize?: number;
}

export interface DataQualityIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  description: string;
  affectedItems: any[];
  suggestedFix?: string;
  impact: {
    workItems?: number;
    teams?: number;
    users?: number;
  };
}

export interface DataInsight {
  type: string;
  title: string;
  description: string;
  metrics: Record<string, any>;
  recommendations: string[];
}

export class DataExtractor {
  private client: AzureDevOpsClient;
  private storage: StorageManager;
  
  constructor(client: AzureDevOpsClient, storage: StorageManager) {
    this.client = client;
    this.storage = storage;
  }
  
  /**
   * Extract complete dataset for a time period
   */
  async extractFullDataset(config: DataExtractionConfig): Promise<string> {
    const sessionId = await this.storage.createSession('data-extraction', {
      config,
      startTime: new Date().toISOString()
    });
    
    const dataset: Record<string, any> = {
      project: config.project,
      extractionDate: new Date().toISOString(),
      dateRange: config.dateRange,
      data: {}
    };
    
    // Extract areas
    if (config.entities.includes('areas') || config.entities.includes('all')) {
      console.log('Extracting areas...');
      const areas = await this.client.getAreas(config.project);
      dataset.data.areas = areas.value || [];
      await this.storage.storeDataset(`${sessionId}-areas`, dataset.data.areas);
    }
    
    // Extract teams
    if (config.entities.includes('teams') || config.entities.includes('all')) {
      console.log('Extracting teams...');
      const teams = await this.client.getTeams(config.project);
      dataset.data.teams = teams.value || [];
      await this.storage.storeDataset(`${sessionId}-teams`, dataset.data.teams);
    }
    
    // Extract users
    if (config.entities.includes('users') || config.entities.includes('all')) {
      console.log('Extracting users...');
      const users = await this.client.getUsers(config.project);
      dataset.data.users = users.value || [];
      await this.storage.storeDataset(`${sessionId}-users`, dataset.data.users);
    }
    
    // Extract work items with pagination
    if (config.entities.includes('workitems') || config.entities.includes('all')) {
      console.log('Extracting work items...');
      dataset.data.workItems = await this.extractWorkItemsInBatches(
        config.project,
        config.dateRange,
        config.batchSize || 2000,
        sessionId
      );
    }
    
    // Extract iterations
    if (config.entities.includes('iterations') || config.entities.includes('all')) {
      console.log('Extracting iterations...');
      const iterations = await this.extractIterations(config.project);
      dataset.data.iterations = iterations;
      await this.storage.storeDataset(`${sessionId}-iterations`, iterations);
    }
    
    // Store complete dataset
    await this.storage.updateSession(sessionId, {
      dataset,
      endTime: new Date().toISOString(),
      status: 'complete'
    });
    
    return sessionId;
  }
  
  /**
   * Analyze data quality issues
   */
  async analyzeDataQuality(sessionId: string): Promise<DataQualityIssue[]> {
    const session = await this.storage.retrieve('session', sessionId);
    if (!session) throw new Error('Session not found');
    
    const issues: DataQualityIssue[] = [];
    const data = session.data.dataset.data;
    
    // Check for unassigned work items
    if (data.workItems) {
      const unassignedWorkItems = data.workItems.filter((wi: any) => !wi.AreaSK);
      if (unassignedWorkItems.length > 0) {
        issues.push({
          severity: 'critical',
          category: 'Work Item Areas',
          description: `${unassignedWorkItems.length} work items have no area assigned`,
          affectedItems: unassignedWorkItems.slice(0, 10).map((wi: any) => ({
            id: wi.WorkItemId,
            title: wi.Title
          })),
          suggestedFix: 'Assign areas to work items based on team ownership or title patterns',
          impact: {
            workItems: unassignedWorkItems.length
          }
        });
      }
      
      // Check for orphaned work items (assigned to non-existent users)
      const userSKs = new Set(data.users?.map((u: any) => u.UserSK) || []);
      const orphanedWorkItems = data.workItems.filter((wi: any) => 
        wi.AssignedToUserSK && !userSKs.has(wi.AssignedToUserSK)
      );
      
      if (orphanedWorkItems.length > 0) {
        issues.push({
          severity: 'warning',
          category: 'User Assignments',
          description: `${orphanedWorkItems.length} work items assigned to non-existent users`,
          affectedItems: orphanedWorkItems.slice(0, 10).map((wi: any) => ({
            id: wi.WorkItemId,
            assignedTo: wi.AssignedToUserSK
          })),
          suggestedFix: 'Reassign to active team members',
          impact: {
            workItems: orphanedWorkItems.length
          }
        });
      }
      
      // Check for stale work items
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      
      const staleWorkItems = data.workItems.filter((wi: any) => {
        if (wi.State === 'Closed' || wi.State === 'Done') return false;
        const changedDate = new Date(wi.ChangedDateSK || wi.CreatedDateSK);
        return changedDate < sixMonthsAgo;
      });
      
      if (staleWorkItems.length > 0) {
        issues.push({
          severity: 'warning',
          category: 'Stale Work Items',
          description: `${staleWorkItems.length} work items unchanged for 6+ months`,
          affectedItems: staleWorkItems.slice(0, 10).map((wi: any) => ({
            id: wi.WorkItemId,
            title: wi.Title,
            lastChanged: wi.ChangedDateSK
          })),
          suggestedFix: 'Review and close or re-prioritize stale items',
          impact: {
            workItems: staleWorkItems.length
          }
        });
      }
    }
    
    // Check for teams without areas
    if (data.teams && data.areas) {
      const areaNames = new Set(data.areas.map((a: any) => 
        a.AreaPath.split('\\').pop().toLowerCase()
      ));
      
      const teamsWithoutAreas = data.teams.filter((team: any) => 
        !areaNames.has(team.TeamName.toLowerCase())
      );
      
      if (teamsWithoutAreas.length > 0) {
        issues.push({
          severity: 'critical',
          category: 'Team Configuration',
          description: `${teamsWithoutAreas.length} teams have no matching areas`,
          affectedItems: teamsWithoutAreas.map((t: any) => t.TeamName),
          suggestedFix: 'Create areas for teams or map teams to existing areas',
          impact: {
            teams: teamsWithoutAreas.length
          }
        });
      }
    }
    
    // Check for duplicate work items
    if (data.workItems) {
      const titleMap = new Map<string, any[]>();
      data.workItems.forEach((wi: any) => {
        const title = wi.Title?.toLowerCase();
        if (title) {
          if (!titleMap.has(title)) {
            titleMap.set(title, []);
          }
          titleMap.get(title)!.push(wi);
        }
      });
      
      const duplicates: any[] = [];
      titleMap.forEach((items, title) => {
        if (items.length > 1) {
          duplicates.push({ title, items });
        }
      });
      
      if (duplicates.length > 0) {
        issues.push({
          severity: 'info',
          category: 'Duplicate Work Items',
          description: `${duplicates.length} potential duplicate work items detected`,
          affectedItems: duplicates.slice(0, 5).map(d => ({
            title: d.title,
            ids: d.items.map((i: any) => i.WorkItemId)
          })),
          suggestedFix: 'Review and merge duplicate work items',
          impact: {
            workItems: duplicates.reduce((sum, d) => sum + d.items.length - 1, 0)
          }
        });
      }
    }
    
    // Store quality analysis
    await this.storage.storeAnalysis('data-quality', issues, [sessionId]);
    
    return issues;
  }
  
  /**
   * Extract critical insights from data
   */
  async extractInsights(sessionId: string): Promise<DataInsight[]> {
    const session = await this.storage.retrieve('session', sessionId);
    if (!session) throw new Error('Session not found');
    
    const insights: DataInsight[] = [];
    const data = session.data.dataset.data;
    
    // Team productivity insights
    if (data.workItems && data.teams) {
      const workItemsByArea = new Map<string, any[]>();
      data.workItems.forEach((wi: any) => {
        const area = wi.AreaPath || 'Unassigned';
        if (!workItemsByArea.has(area)) {
          workItemsByArea.set(area, []);
        }
        workItemsByArea.get(area)!.push(wi);
      });
      
      // Find most and least productive teams
      const teamProductivity: any[] = [];
      data.teams.forEach((team: any) => {
        const matchingAreas = Array.from(workItemsByArea.keys()).filter(area =>
          area.toLowerCase().includes(team.TeamName.toLowerCase())
        );
        
        let totalItems = 0;
        let completedItems = 0;
        
        matchingAreas.forEach(area => {
          const items = workItemsByArea.get(area) || [];
          totalItems += items.length;
          completedItems += items.filter((wi: any) => 
            wi.State === 'Closed' || wi.State === 'Done'
          ).length;
        });
        
        if (totalItems > 0) {
          teamProductivity.push({
            team: team.TeamName,
            totalItems,
            completedItems,
            completionRate: completedItems / totalItems
          });
        }
      });
      
      teamProductivity.sort((a, b) => b.completionRate - a.completionRate);
      
      insights.push({
        type: 'team-productivity',
        title: 'Team Productivity Analysis',
        description: 'Teams ranked by work item completion rate',
        metrics: {
          topPerformers: teamProductivity.slice(0, 3),
          bottomPerformers: teamProductivity.slice(-3),
          averageCompletionRate: teamProductivity.reduce((sum, t) => sum + t.completionRate, 0) / teamProductivity.length
        },
        recommendations: [
          'Share best practices from top-performing teams',
          'Investigate blockers for low-performing teams',
          'Consider workload rebalancing'
        ]
      });
    }
    
    // Work distribution insights
    if (data.workItems) {
      const typeDistribution = new Map<string, number>();
      const stateDistribution = new Map<string, number>();
      
      data.workItems.forEach((wi: any) => {
        typeDistribution.set(wi.WorkItemType, (typeDistribution.get(wi.WorkItemType) || 0) + 1);
        stateDistribution.set(wi.State, (stateDistribution.get(wi.State) || 0) + 1);
      });
      
      const bugRatio = (typeDistribution.get('Bug') || 0) / data.workItems.length;
      const newItemsRatio = (stateDistribution.get('New') || 0) / data.workItems.length;
      
      insights.push({
        type: 'work-distribution',
        title: 'Work Item Distribution Analysis',
        description: 'Analysis of work item types and states',
        metrics: {
          totalWorkItems: data.workItems.length,
          typeDistribution: Object.fromEntries(typeDistribution),
          stateDistribution: Object.fromEntries(stateDistribution),
          bugRatio,
          newItemsRatio
        },
        recommendations: bugRatio > 0.3 ? [
          'High bug ratio detected - focus on quality improvements',
          'Implement additional testing practices',
          'Review code review processes'
        ] : newItemsRatio > 0.7 ? [
          'Large backlog of new items - prioritize and plan sprints',
          'Consider archiving or closing outdated items',
          'Review capacity planning'
        ] : [
          'Work distribution appears balanced',
          'Continue current practices'
        ]
      });
    }
    
    // Velocity trends
    if (data.workItems && data.iterations) {
      const velocityByIteration = new Map<string, number>();
      
      data.workItems
        .filter((wi: any) => wi.State === 'Closed' || wi.State === 'Done')
        .forEach((wi: any) => {
          if (wi.IterationPath) {
            velocityByIteration.set(
              wi.IterationPath,
              (velocityByIteration.get(wi.IterationPath) || 0) + 1
            );
          }
        });
      
      const velocityTrend = Array.from(velocityByIteration.entries())
        .map(([iteration, count]) => ({ iteration, count }))
        .sort((a, b) => a.iteration.localeCompare(b.iteration));
      
      insights.push({
        type: 'velocity-trend',
        title: 'Sprint Velocity Trends',
        description: 'Work items completed per iteration',
        metrics: {
          velocityByIteration: velocityTrend,
          averageVelocity: velocityTrend.reduce((sum, v) => sum + v.count, 0) / velocityTrend.length,
          trend: this.calculateTrend(velocityTrend.map(v => v.count))
        },
        recommendations: [
          'Use historical velocity for sprint planning',
          'Monitor velocity stability for predictability',
          'Investigate causes of velocity changes'
        ]
      });
    }
    
    // Store insights
    await this.storage.storeAnalysis('insights', insights, [sessionId]);
    
    return insights;
  }
  
  /**
   * Generate comprehensive health report
   */
  async generateHealthReport(sessionId: string): Promise<string> {
    const [qualityIssues, insights] = await Promise.all([
      this.analyzeDataQuality(sessionId),
      this.extractInsights(sessionId)
    ]);
    
    const report = {
      generatedAt: new Date().toISOString(),
      sessionId,
      summary: {
        criticalIssues: qualityIssues.filter(i => i.severity === 'critical').length,
        warnings: qualityIssues.filter(i => i.severity === 'warning').length,
        insights: insights.length
      },
      qualityIssues,
      insights,
      recommendations: this.generateRecommendations(qualityIssues, insights)
    };
    
    const reportId = await this.storage.storeReport(
      'health-report',
      report,
      'json',
      { sessionId }
    );
    
    return reportId;
  }
  
  // Helper methods
  
  private async extractWorkItemsInBatches(
    project: string,
    dateRange?: { start: Date; end: Date },
    batchSize: number = 2000,
    sessionId?: string
  ): Promise<any[]> {
    const allWorkItems: any[] = [];
    let skip = 0;
    let hasMore = true;
    
    while (hasMore) {
      let filter = 'Revision eq 1';
      if (dateRange) {
        const startStr = dateRange.start.toISOString().split('T')[0];
        const endStr = dateRange.end.toISOString().split('T')[0];
        filter += ` and ChangedDateSK ge ${startStr} and ChangedDateSK le ${endStr}`;
      }
      
      const batch = await this.client.getWorkItemSnapshots({
        project,
        filter,
        top: batchSize,
        skip,
        select: 'WorkItemId,Title,WorkItemType,State,AreaSK,AreaPath,AssignedToUserSK,CreatedDateSK,ChangedDateSK,IterationPath,StoryPoints,Priority'
      });
      
      if (batch.value && batch.value.length > 0) {
        allWorkItems.push(...batch.value);
        skip += batch.value.length;
        hasMore = batch.value.length === batchSize;
        
        // Store batch if sessionId provided
        if (sessionId) {
          await this.storage.storeDataset(
            `${sessionId}-workitems-batch-${skip}`,
            batch.value,
            batchSize
          );
        }
      } else {
        hasMore = false;
      }
      
      console.log(`Extracted ${allWorkItems.length} work items...`);
    }
    
    return allWorkItems;
  }
  
  private async extractIterations(project: string): Promise<any[]> {
    // Try to get iterations - handle if not available
    try {
      const query = `WorkItemSnapshot?$select=IterationPath&$filter=IterationPath ne null&$apply=groupby((IterationPath))`;
      const result = await this.client.queryAnalytics(query, project);
      return result.value || [];
    } catch (error) {
      console.warn('Iterations not available, using work item data');
      return [];
    }
  }
  
  private calculateTrend(values: number[]): string {
    if (values.length < 2) return 'insufficient-data';
    
    const firstHalf = values.slice(0, Math.floor(values.length / 2));
    const secondHalf = values.slice(Math.floor(values.length / 2));
    
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    
    const change = (secondAvg - firstAvg) / firstAvg;
    
    if (change > 0.1) return 'increasing';
    if (change < -0.1) return 'decreasing';
    return 'stable';
  }
  
  private generateRecommendations(
    issues: DataQualityIssue[],
    insights: DataInsight[]
  ): string[] {
    const recommendations: string[] = [];
    
    // Priority 1: Critical issues
    const criticalIssues = issues.filter(i => i.severity === 'critical');
    if (criticalIssues.length > 0) {
      recommendations.push('IMMEDIATE ACTION REQUIRED:');
      criticalIssues.forEach(issue => {
        recommendations.push(`- ${issue.suggestedFix}`);
      });
    }
    
    // Priority 2: Performance improvements
    const productivityInsight = insights.find(i => i.type === 'team-productivity');
    if (productivityInsight && productivityInsight.metrics.averageCompletionRate < 0.5) {
      recommendations.push('PRODUCTIVITY IMPROVEMENTS:');
      recommendations.push('- Review and reduce work in progress');
      recommendations.push('- Implement WIP limits');
      recommendations.push('- Focus on completing started work');
    }
    
    // Priority 3: Quality improvements
    const distributionInsight = insights.find(i => i.type === 'work-distribution');
    if (distributionInsight && distributionInsight.metrics.bugRatio > 0.3) {
      recommendations.push('QUALITY IMPROVEMENTS:');
      recommendations.push('- Increase test coverage');
      recommendations.push('- Implement automated testing');
      recommendations.push('- Strengthen code review process');
    }
    
    return recommendations;
  }
}