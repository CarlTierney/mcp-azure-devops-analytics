import { AzureDevOpsClient } from './azureDevOpsClient.js';
import { StorageManager } from './storageManager.js';

export interface DeploymentRecord {
  id: string;
  timestamp: Date;
  duration: number;
  status: 'succeeded' | 'failed' | 'partial';
  environment: string;
  commits?: string[];
  workItems?: number[];
  pipeline?: string;
}

export interface DeploymentMetrics {
  deployments: DeploymentRecord[];
  frequency: {
    daily: number;
    weekly: number;
    monthly: number;
  };
  successRate: number;
  rollbackRate: number;
}

export interface Incident {
  id: string;
  detectedAt: Date;
  resolvedAt?: Date;
  mttr?: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  relatedDeployment?: string;
  rootCause?: string;
  affectedServices?: string[];
}

export interface IncidentMetrics {
  incidents: Incident[];
  mttr: {
    overall: number;
    bySeverity: Record<string, number>;
    trend: 'improving' | 'stable' | 'degrading';
  };
  failureRate: number;
}

export interface DeliveryPrediction {
  predictedDate: {
    optimistic: Date;
    likely: Date;
    pessimistic: Date;
  };
  assumptions: string[];
  risks: string[];
  recommendations: string[];
  confidence: number;
}

export class DeploymentMetricsCollector {
  private client: AzureDevOpsClient;
  private storage: StorageManager;
  
  constructor(client: AzureDevOpsClient, storage: StorageManager) {
    this.client = client;
    this.storage = storage;
  }
  
  /**
   * Get deployment metrics from Azure DevOps
   * Note: This is a simplified implementation - full version would use Build/Release APIs
   */
  async getDeploymentMetrics(
    project: string,
    dateRange: { start: Date; end: Date },
    environment?: 'development' | 'staging' | 'production',
    pipelineName?: string
  ): Promise<DeploymentMetrics> {
    // In a real implementation, this would query Azure DevOps Build/Release APIs
    // For now, we'll simulate by looking at work items with deployment tags
    
    const startStr = dateRange.start.toISOString().split('T')[0];
    const endStr = dateRange.end.toISOString().split('T')[0];
    
    // Query for deployment-related work items
    const filter = `Tags contains 'deployment' and ChangedDateSK ge ${startStr} and ChangedDateSK le ${endStr}`;
    const deploymentItems = await this.client.queryAnalytics(
      `WorkItemSnapshot?$select=WorkItemId,Title,State,Tags,ChangedDateSK&$filter=${filter}`,
      project
    );
    
    // Simulate deployment records from work items
    const deployments: DeploymentRecord[] = [];
    
    if (deploymentItems.value) {
      for (const item of deploymentItems.value) {
        const isSuccess = item.State === 'Done' || item.State === 'Closed';
        const isFailed = item.State === 'Removed' || item.Tags?.includes('failed');
        
        deployments.push({
          id: `deploy-${item.WorkItemId}`,
          timestamp: new Date(item.ChangedDateSK),
          duration: Math.random() * 3600000, // Simulated duration in ms
          status: isFailed ? 'failed' : isSuccess ? 'succeeded' : 'partial',
          environment: environment || this.extractEnvironment(item.Tags),
          workItems: [item.WorkItemId]
        });
      }
    }
    
    // Calculate metrics
    const days = this.getDaysBetween(dateRange.start, dateRange.end);
    const successCount = deployments.filter(d => d.status === 'succeeded').length;
    const failedCount = deployments.filter(d => d.status === 'failed').length;
    
    return {
      deployments,
      frequency: {
        daily: deployments.length / days,
        weekly: (deployments.length / days) * 7,
        monthly: (deployments.length / days) * 30
      },
      successRate: deployments.length > 0 ? (successCount / deployments.length) * 100 : 100,
      rollbackRate: deployments.length > 0 ? (failedCount / deployments.length) * 100 : 0
    };
  }
  
  /**
   * Get incident metrics
   * Note: This is a simplified implementation - full version would use incident management system
   */
  async getIncidentMetrics(
    project: string,
    dateRange: { start: Date; end: Date },
    severity?: 'critical' | 'high' | 'medium' | 'low',
    includeRootCause?: boolean
  ): Promise<IncidentMetrics> {
    const startStr = dateRange.start.toISOString().split('T')[0];
    const endStr = dateRange.end.toISOString().split('T')[0];
    
    // Query for incident-related work items (bugs with incident tag or high priority)
    let filter = `(WorkItemType eq 'Bug' or Tags contains 'incident') and CreatedDateSK ge ${startStr} and CreatedDateSK le ${endStr}`;
    if (severity) {
      filter += ` and Priority eq ${this.mapSeverityToPriority(severity)}`;
    }
    
    const incidentItems = await this.client.queryAnalytics(
      `WorkItemSnapshot?$select=WorkItemId,Title,State,Priority,Severity,CreatedDateSK,ResolvedDateSK,Tags&$filter=${filter}`,
      project
    );
    
    const incidents: Incident[] = [];
    
    if (incidentItems.value) {
      for (const item of incidentItems.value) {
        const incident: Incident = {
          id: `incident-${item.WorkItemId}`,
          detectedAt: new Date(item.CreatedDateSK),
          severity: this.mapPriorityToSeverity(item.Priority || item.Severity),
          affectedServices: this.extractServices(item.Tags)
        };
        
        if (item.ResolvedDateSK) {
          incident.resolvedAt = new Date(item.ResolvedDateSK);
          incident.mttr = (incident.resolvedAt.getTime() - incident.detectedAt.getTime()) / 60000; // Minutes
        }
        
        if (includeRootCause && item.Tags) {
          incident.rootCause = this.extractRootCause(item.Tags);
        }
        
        incidents.push(incident);
      }
    }
    
    // Calculate MTTR metrics
    const resolvedIncidents = incidents.filter(i => i.mttr !== undefined);
    const mttrBySeverity: Record<string, number> = {};
    
    for (const severity of ['critical', 'high', 'medium', 'low']) {
      const severityIncidents = resolvedIncidents.filter(i => i.severity === severity);
      if (severityIncidents.length > 0) {
        mttrBySeverity[severity] = severityIncidents.reduce((sum, i) => sum + (i.mttr || 0), 0) / severityIncidents.length;
      }
    }
    
    const overallMttr = resolvedIncidents.length > 0
      ? resolvedIncidents.reduce((sum, i) => sum + (i.mttr || 0), 0) / resolvedIncidents.length
      : 0;
    
    // Determine trend (simplified - would need historical data)
    const trend = this.calculateMttrTrend(incidents);
    
    return {
      incidents,
      mttr: {
        overall: overallMttr,
        bySeverity: mttrBySeverity,
        trend
      },
      failureRate: this.calculateFailureRate(incidents, dateRange)
    };
  }
  
  /**
   * Predict delivery date based on historical velocity
   */
  async predictDelivery(
    project: string,
    remainingWork: number,
    workUnit: 'points' | 'items' = 'points',
    teamName?: string,
    confidenceLevel: number = 85
  ): Promise<DeliveryPrediction> {
    // Get historical velocity data
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 3); // Last 3 months
    
    const filter = `State eq 'Done' and ChangedDateSK ge ${startDate.toISOString().split('T')[0]}`;
    const completedWork = await this.client.queryAnalytics(
      `WorkItemSnapshot?$select=WorkItemId,StoryPoints,ChangedDateSK,IterationPath&$filter=${filter}&$apply=groupby((IterationPath), aggregate(StoryPoints with sum as TotalPoints, $count as ItemCount))`,
      project
    );
    
    // Calculate velocity statistics
    const velocities: number[] = [];
    
    if (completedWork.value) {
      for (const iteration of completedWork.value) {
        const velocity = workUnit === 'points' 
          ? (iteration.TotalPoints || 0)
          : (iteration.ItemCount || 0);
        if (velocity > 0) {
          velocities.push(velocity);
        }
      }
    }
    
    if (velocities.length === 0) {
      // No historical data, use defaults
      velocities.push(20); // Default velocity
    }
    
    // Calculate statistics
    const avgVelocity = velocities.reduce((a, b) => a + b, 0) / velocities.length;
    const stdDev = this.calculateStdDev(velocities);
    
    // Monte Carlo simulation for predictions
    const simulations = this.runMonteCarloSimulation(
      remainingWork,
      avgVelocity,
      stdDev,
      1000
    );
    
    // Get percentile predictions
    const optimistic = this.getPercentile(simulations, 100 - confidenceLevel);
    const likely = this.getPercentile(simulations, 50);
    const pessimistic = this.getPercentile(simulations, confidenceLevel);
    
    // Generate predictions
    const now = new Date();
    const sprintLength = 14; // Assume 2-week sprints
    
    const predictions: DeliveryPrediction = {
      predictedDate: {
        optimistic: this.addDays(now, optimistic * sprintLength),
        likely: this.addDays(now, likely * sprintLength),
        pessimistic: this.addDays(now, pessimistic * sprintLength)
      },
      assumptions: [
        `Team maintains average velocity of ${avgVelocity.toFixed(1)} ${workUnit} per sprint`,
        'No major scope changes',
        'Team capacity remains stable',
        `${sprintLength}-day sprint length`
      ],
      risks: [],
      recommendations: [],
      confidence: confidenceLevel
    };
    
    // Identify risks
    if (stdDev / avgVelocity > 0.3) {
      predictions.risks.push('High velocity variability (>30%) reduces prediction accuracy');
    }
    
    if (remainingWork > avgVelocity * 10) {
      predictions.risks.push('Large amount of remaining work increases uncertainty');
    }
    
    if (velocities.length < 3) {
      predictions.risks.push('Limited historical data reduces prediction reliability');
    }
    
    // Generate recommendations
    if (pessimistic > 6) {
      predictions.recommendations.push('Consider breaking work into smaller, incremental deliveries');
    }
    
    if (stdDev / avgVelocity > 0.3) {
      predictions.recommendations.push('Focus on stabilizing team velocity through better estimation');
    }
    
    predictions.recommendations.push(
      `Plan for ${likely} sprints with buffer for ${pessimistic - likely} additional sprints`
    );
    
    // Cache the prediction
    await this.storage.store(
      'analysis',
      `prediction-${project}-${Date.now()}`,
      predictions,
      { project, remainingWork, teamName },
      3600000 // 1 hour TTL
    );
    
    return predictions;
  }
  
  // Helper methods
  
  private extractEnvironment(tags?: string): string {
    if (!tags) return 'production';
    if (tags.includes('dev')) return 'development';
    if (tags.includes('staging')) return 'staging';
    return 'production';
  }
  
  private extractServices(tags?: string): string[] {
    if (!tags) return [];
    const services: string[] = [];
    const tagList = tags.split(';');
    for (const tag of tagList) {
      if (tag.startsWith('service:')) {
        services.push(tag.replace('service:', '').trim());
      }
    }
    return services;
  }
  
  private extractRootCause(tags?: string): string {
    if (!tags) return 'Unknown';
    const tagList = tags.split(';');
    for (const tag of tagList) {
      if (tag.startsWith('root-cause:')) {
        return tag.replace('root-cause:', '').trim();
      }
    }
    return 'Under investigation';
  }
  
  private mapSeverityToPriority(severity: string): number {
    switch (severity) {
      case 'critical': return 1;
      case 'high': return 2;
      case 'medium': return 3;
      case 'low': return 4;
      default: return 3;
    }
  }
  
  private mapPriorityToSeverity(priority: number | string): 'critical' | 'high' | 'medium' | 'low' {
    const p = typeof priority === 'string' ? parseInt(priority) : priority;
    if (p <= 1) return 'critical';
    if (p === 2) return 'high';
    if (p === 3) return 'medium';
    return 'low';
  }
  
  private calculateMttrTrend(incidents: Incident[]): 'improving' | 'stable' | 'degrading' {
    if (incidents.length < 10) return 'stable';
    
    // Simple trend calculation - compare first half vs second half
    const midPoint = Math.floor(incidents.length / 2);
    const firstHalf = incidents.slice(0, midPoint).filter(i => i.mttr);
    const secondHalf = incidents.slice(midPoint).filter(i => i.mttr);
    
    if (firstHalf.length === 0 || secondHalf.length === 0) return 'stable';
    
    const firstAvg = firstHalf.reduce((sum, i) => sum + (i.mttr || 0), 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, i) => sum + (i.mttr || 0), 0) / secondHalf.length;
    
    const change = (secondAvg - firstAvg) / firstAvg;
    
    if (change < -0.1) return 'improving';
    if (change > 0.1) return 'degrading';
    return 'stable';
  }
  
  private calculateFailureRate(incidents: Incident[], dateRange: { start: Date; end: Date }): number {
    const days = this.getDaysBetween(dateRange.start, dateRange.end);
    return incidents.length / days;
  }
  
  private getDaysBetween(start: Date, end: Date): number {
    const diffTime = Math.abs(end.getTime() - start.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }
  
  private calculateStdDev(values: number[]): number {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(variance);
  }
  
  private runMonteCarloSimulation(
    remainingWork: number,
    avgVelocity: number,
    stdDev: number,
    iterations: number
  ): number[] {
    const results: number[] = [];
    
    for (let i = 0; i < iterations; i++) {
      let work = remainingWork;
      let sprints = 0;
      
      while (work > 0) {
        // Generate random velocity based on normal distribution
        const velocity = this.normalRandom(avgVelocity, stdDev);
        work -= Math.max(0, velocity);
        sprints++;
        
        // Safety check to prevent infinite loop
        if (sprints > 100) break;
      }
      
      results.push(sprints);
    }
    
    return results.sort((a, b) => a - b);
  }
  
  private normalRandom(mean: number, stdDev: number): number {
    // Box-Muller transform for normal distribution
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z0 * stdDev;
  }
  
  private getPercentile(sortedValues: number[], percentile: number): number {
    const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
    return sortedValues[Math.max(0, index)];
  }
  
  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }
}