import { AzureDevOpsClient } from './azureDevOpsClient.js';
import { StorageManager } from './storageManager.js';

export interface SprintMetrics {
  sprintId: string;
  sprintName: string;
  startDate: Date;
  endDate: Date;
  velocity: number;
  plannedCapacity: number;
  completedStoryPoints: number;
  committedStoryPoints: number;
  carryOverPoints: number;
  completionRate: number;
  burndown: Array<{
    date: string;
    idealRemaining: number;
    actualRemaining: number;
    completedPoints: number;
  }>;
}

export interface FlowMetrics {
  cycleTime: {
    average: number;
    median: number;
    p85: number;
    p95: number;
  };
  leadTime: {
    average: number;
    median: number;
    p85: number;
    p95: number;
  };
  throughput: {
    daily: number;
    weekly: number;
    monthly: number;
  };
  wip: {
    current: number;
    average: number;
    limit?: number;
  };
  flowEfficiency: number;
}

export interface DoraMetrics {
  deploymentFrequency: {
    deploymentsPerDay: number;
    classification: 'elite' | 'high' | 'medium' | 'low';
  };
  leadTimeForChanges: {
    hours: number;
    classification: 'elite' | 'high' | 'medium' | 'low';
  };
  mttr: {
    minutes: number;
    classification: 'elite' | 'high' | 'medium' | 'low';
  };
  changeFailureRate: {
    percentage: number;
    classification: 'elite' | 'high' | 'medium' | 'low';
  };
}

export class MetricsAggregator {
  private client: AzureDevOpsClient;
  private storage: StorageManager;
  
  constructor(client: AzureDevOpsClient, storage: StorageManager) {
    this.client = client;
    this.storage = storage;
  }
  
  /**
   * Calculate sprint metrics including velocity and burndown
   */
  async calculateSprintMetrics(
    project: string,
    iterationPath?: string,
    numberOfSprints: number = 1
  ): Promise<SprintMetrics[]> {
    const metrics: SprintMetrics[] = [];
    
    // Get iterations
    const iterations = await this.client.getIterations(project, {
      timeframe: iterationPath ? undefined : 'past'
    });
    
    if (!iterations.value || iterations.value.length === 0) {
      throw new Error('No iterations found');
    }
    
    // Process each sprint
    const sprints = iterations.value.slice(0, numberOfSprints);
    
    for (const sprint of sprints) {
      const sprintMetric = await this.calculateSingleSprintMetrics(
        project,
        sprint
      );
      metrics.push(sprintMetric);
    }
    
    // Cache the results
    await this.storage.store(
      'analysis',
      `sprint-metrics-${project}`,
      metrics,
      { project, timestamp: new Date().toISOString() },
      3600000 // 1 hour TTL
    );
    
    return metrics;
  }
  
  /**
   * Calculate flow metrics (cycle time, lead time, WIP, throughput)
   */
  async calculateFlowMetrics(
    project: string,
    dateRange: { start: Date; end: Date },
    teamName?: string
  ): Promise<FlowMetrics> {
    // Get work items in the date range
    const startStr = dateRange.start.toISOString().split('T')[0];
    const endStr = dateRange.end.toISOString().split('T')[0];
    
    const filter = `ChangedDateSK ge ${startStr} and ChangedDateSK le ${endStr}`;
    const workItems = await this.client.getWorkItemSnapshots({
      project,
      filter,
      select: 'WorkItemId,State,CreatedDateSK,ChangedDateSK,CycleTimeDays,LeadTimeDays',
      top: 5000
    });
    
    if (!workItems.value || workItems.value.length === 0) {
      return this.getEmptyFlowMetrics();
    }
    
    // Calculate cycle times
    const cycleTimes: number[] = [];
    const leadTimes: number[] = [];
    const completedItems: any[] = [];
    const inProgressItems: any[] = [];
    
    for (const wi of workItems.value) {
      // Track state transitions
      if (wi.State === 'Done' || wi.State === 'Closed') {
        completedItems.push(wi);
        
        // Calculate cycle time (if available in data)
        if (wi.CycleTimeDays) {
          cycleTimes.push(wi.CycleTimeDays);
        }
        
        // Calculate lead time
        if (wi.LeadTimeDays) {
          leadTimes.push(wi.LeadTimeDays);
        } else if (wi.CreatedDateSK && wi.ChangedDateSK) {
          const created = new Date(wi.CreatedDateSK);
          const changed = new Date(wi.ChangedDateSK);
          const leadTime = (changed.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
          leadTimes.push(leadTime);
        }
      }
      
      if (wi.State === 'Active' || wi.State === 'In Progress' || wi.State === 'Committed') {
        inProgressItems.push(wi);
      }
    }
    
    // Calculate metrics
    const metrics: FlowMetrics = {
      cycleTime: {
        average: this.calculateAverage(cycleTimes),
        median: this.calculatePercentile(cycleTimes, 50),
        p85: this.calculatePercentile(cycleTimes, 85),
        p95: this.calculatePercentile(cycleTimes, 95)
      },
      leadTime: {
        average: this.calculateAverage(leadTimes),
        median: this.calculatePercentile(leadTimes, 50),
        p85: this.calculatePercentile(leadTimes, 85),
        p95: this.calculatePercentile(leadTimes, 95)
      },
      throughput: {
        daily: completedItems.length / this.getDaysBetween(dateRange.start, dateRange.end),
        weekly: (completedItems.length / this.getDaysBetween(dateRange.start, dateRange.end)) * 7,
        monthly: (completedItems.length / this.getDaysBetween(dateRange.start, dateRange.end)) * 30
      },
      wip: {
        current: inProgressItems.length,
        average: inProgressItems.length, // Would need historical data for true average
        limit: undefined // Would need team settings
      },
      flowEfficiency: this.calculateFlowEfficiency(cycleTimes, leadTimes)
    };
    
    // Cache the results
    await this.storage.store(
      'analysis',
      `flow-metrics-${project}`,
      metrics,
      { project, dateRange, teamName },
      3600000
    );
    
    return metrics;
  }
  
  /**
   * Calculate DORA metrics (requires additional Azure DevOps APIs)
   */
  async calculateDoraMetrics(
    project: string,
    dateRange: { start: Date; end: Date }
  ): Promise<DoraMetrics> {
    // Note: This is a simplified implementation
    // Full DORA metrics would require Build/Release/Pipeline APIs
    
    const deploymentFrequency = await this.calculateDeploymentFrequency(project, dateRange);
    const leadTime = await this.calculateLeadTimeForChanges(project, dateRange);
    const mttr = await this.calculateMTTR(project, dateRange);
    const failureRate = await this.calculateChangeFailureRate(project, dateRange);
    
    const metrics: DoraMetrics = {
      deploymentFrequency: {
        deploymentsPerDay: deploymentFrequency,
        classification: this.classifyDeploymentFrequency(deploymentFrequency)
      },
      leadTimeForChanges: {
        hours: leadTime,
        classification: this.classifyLeadTime(leadTime)
      },
      mttr: {
        minutes: mttr,
        classification: this.classifyMTTR(mttr)
      },
      changeFailureRate: {
        percentage: failureRate,
        classification: this.classifyFailureRate(failureRate)
      }
    };
    
    // Cache the results
    await this.storage.store(
      'analysis',
      `dora-metrics-${project}`,
      metrics,
      { project, dateRange },
      3600000
    );
    
    return metrics;
  }
  
  /**
   * Generate cumulative flow diagram data
   */
  async getCumulativeFlow(
    project: string,
    dateRange: { start: Date; end: Date },
    interval: 'daily' | 'weekly' = 'daily'
  ): Promise<any> {
    const data: Array<{
      date: string;
      states: Record<string, number>;
      total: number;
    }> = [];
    
    // Get work item states over time
    const currentDate = new Date(dateRange.start);
    const endDate = new Date(dateRange.end);
    
    while (currentDate <= endDate) {
      const dateStr = currentDate.toISOString().split('T')[0];
      
      // Query work items for this date
      const filter = `AsOfDateSK eq ${dateStr}`;
      const workItems = await this.client.queryAnalytics(
        `WorkItemSnapshot?$select=State&$filter=${filter}&$apply=groupby((State), aggregate($count as Count))`,
        project
      );
      
      if (workItems.value) {
        const states: Record<string, number> = {};
        let total = 0;
        
        for (const item of workItems.value) {
          states[item.State] = item.Count || 0;
          total += item.Count || 0;
        }
        
        data.push({
          date: dateStr,
          states,
          total
        });
      }
      
      // Move to next interval
      if (interval === 'daily') {
        currentDate.setDate(currentDate.getDate() + 1);
      } else {
        currentDate.setDate(currentDate.getDate() + 7);
      }
    }
    
    // Identify bottlenecks
    const bottlenecks = this.identifyBottlenecks(data);
    
    return {
      data,
      bottlenecks
    };
  }
  
  /**
   * Aggregate metrics for a specific time period
   */
  async aggregateMetrics(
    project: string,
    date: Date,
    type: 'daily' | 'weekly' | 'monthly'
  ): Promise<void> {
    const dateRange = this.getDateRange(date, type);
    
    // Collect all metrics
    const [flowMetrics, sprintMetrics] = await Promise.all([
      this.calculateFlowMetrics(project, dateRange),
      this.calculateSprintMetrics(project)
    ]);
    
    const aggregatedMetrics = {
      date: date.toISOString(),
      type,
      project,
      flow: flowMetrics,
      sprint: sprintMetrics[0], // Current sprint
      timestamp: new Date().toISOString()
    };
    
    // Store aggregated metrics
    const key = `${type}/${date.toISOString().split('T')[0]}`;
    await this.storage.store(
      'cache',
      key,
      aggregatedMetrics,
      { project, type },
      type === 'daily' ? 86400000 : // 1 day
      type === 'weekly' ? 604800000 : // 1 week
      2592000000 // 30 days
    );
  }
  
  // Helper methods
  
  private async calculateSingleSprintMetrics(
    project: string,
    sprint: any
  ): Promise<SprintMetrics> {
    // Get work items for this sprint
    const filter = `IterationSK eq '${sprint.IterationSK}'`;
    const workItems = await this.client.queryAnalytics(
      `WorkItemSnapshot?$select=WorkItemId,State,StoryPoints&$filter=${filter}`,
      project
    );
    
    let completedPoints = 0;
    let committedPoints = 0;
    let remainingPoints = 0;
    
    if (workItems.value) {
      for (const wi of workItems.value) {
        const points = wi.StoryPoints || 0;
        committedPoints += points;
        
        if (wi.State === 'Done' || wi.State === 'Closed') {
          completedPoints += points;
        } else {
          remainingPoints += points;
        }
      }
    }
    
    return {
      sprintId: sprint.IterationSK,
      sprintName: sprint.IterationPath,
      startDate: new Date(sprint.StartDateSK || Date.now()),
      endDate: new Date(sprint.EndDateSK || Date.now()),
      velocity: completedPoints,
      plannedCapacity: committedPoints,
      completedStoryPoints: completedPoints,
      committedStoryPoints: committedPoints,
      carryOverPoints: remainingPoints,
      completionRate: committedPoints > 0 ? (completedPoints / committedPoints) * 100 : 0,
      burndown: [] // Would need daily snapshots for burndown
    };
  }
  
  private calculateAverage(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  
  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    
    const sorted = values.sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
  
  private calculateFlowEfficiency(cycleTimes: number[], leadTimes: number[]): number {
    if (cycleTimes.length === 0 || leadTimes.length === 0) return 0;
    
    const avgCycleTime = this.calculateAverage(cycleTimes);
    const avgLeadTime = this.calculateAverage(leadTimes);
    
    return avgLeadTime > 0 ? (avgCycleTime / avgLeadTime) * 100 : 0;
  }
  
  private getDaysBetween(start: Date, end: Date): number {
    const diffTime = Math.abs(end.getTime() - start.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }
  
  private getEmptyFlowMetrics(): FlowMetrics {
    return {
      cycleTime: { average: 0, median: 0, p85: 0, p95: 0 },
      leadTime: { average: 0, median: 0, p85: 0, p95: 0 },
      throughput: { daily: 0, weekly: 0, monthly: 0 },
      wip: { current: 0, average: 0 },
      flowEfficiency: 0
    };
  }
  
  private async calculateDeploymentFrequency(
    project: string,
    dateRange: { start: Date; end: Date }
  ): Promise<number> {
    // This would require Azure DevOps Build/Release API
    // Placeholder implementation
    return 1.5; // deployments per day
  }
  
  private async calculateLeadTimeForChanges(
    project: string,
    dateRange: { start: Date; end: Date }
  ): Promise<number> {
    // Would need commit to deployment tracking
    return 24; // hours
  }
  
  private async calculateMTTR(
    project: string,
    dateRange: { start: Date; end: Date }
  ): Promise<number> {
    // Would need incident tracking
    return 60; // minutes
  }
  
  private async calculateChangeFailureRate(
    project: string,
    dateRange: { start: Date; end: Date }
  ): Promise<number> {
    // Would need deployment success/failure tracking
    return 15; // percentage
  }
  
  private classifyDeploymentFrequency(deploymentsPerDay: number): 'elite' | 'high' | 'medium' | 'low' {
    if (deploymentsPerDay >= 1) return 'elite';
    if (deploymentsPerDay >= 1/7) return 'high';
    if (deploymentsPerDay >= 1/30) return 'medium';
    return 'low';
  }
  
  private classifyLeadTime(hours: number): 'elite' | 'high' | 'medium' | 'low' {
    if (hours < 1) return 'elite';
    if (hours < 24 * 7) return 'high';
    if (hours < 24 * 30) return 'medium';
    return 'low';
  }
  
  private classifyMTTR(minutes: number): 'elite' | 'high' | 'medium' | 'low' {
    if (minutes < 60) return 'elite';
    if (minutes < 60 * 24) return 'high';
    if (minutes < 60 * 24 * 7) return 'medium';
    return 'low';
  }
  
  private classifyFailureRate(percentage: number): 'elite' | 'high' | 'medium' | 'low' {
    if (percentage <= 15) return 'elite';
    if (percentage <= 30) return 'high';
    if (percentage <= 45) return 'medium';
    return 'low';
  }
  
  private identifyBottlenecks(data: any[]): any[] {
    // Analyze where work items accumulate
    const bottlenecks: any[] = [];
    
    // This is simplified - real implementation would track state transitions
    
    return bottlenecks;
  }
  
  private getDateRange(date: Date, type: 'daily' | 'weekly' | 'monthly'): { start: Date; end: Date } {
    const start = new Date(date);
    const end = new Date(date);
    
    switch (type) {
      case 'daily':
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        break;
      case 'weekly':
        const day = start.getDay();
        start.setDate(start.getDate() - day);
        end.setDate(end.getDate() + (6 - day));
        break;
      case 'monthly':
        start.setDate(1);
        end.setMonth(end.getMonth() + 1);
        end.setDate(0);
        break;
    }
    
    return { start, end };
  }
}