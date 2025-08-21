import { AzureDevOpsClient } from './azureDevOpsClient.js';

export interface DashboardMetrics {
  velocity: VelocityMetrics;
  cycleTime: CycleTimeMetrics;
  throughput: ThroughputMetrics;
  quality: QualityMetrics;
  dora: DORAMetrics;
  teamHealth: TeamHealthMetrics;
}

export interface VelocityMetrics {
  currentSprint: number;
  averageVelocity: number;
  trend: number[];
  predictedVelocity: number;
}

export interface CycleTimeMetrics {
  average: number;
  median: number;
  p85: number;
  p95: number;
  byWorkItemType: Record<string, number>;
}

export interface ThroughputMetrics {
  daily: number;
  weekly: number;
  monthly: number;
  trend: Array<{ date: string; count: number }>;
}

export interface QualityMetrics {
  bugRate: number;
  escapeRate: number;
  reworkRate: number;
  testCoverage: number;
  codeReviewCoverage: number;
}

export interface DORAMetrics {
  deploymentFrequency: number;
  leadTimeForChanges: number;
  meanTimeToRestore: number;
  changeFailureRate: number;
}

export interface TeamHealthMetrics {
  workInProgress: number;
  blockedItems: number;
  overdueItems: number;
  teamUtilization: number;
  happiness: number;
}

export class AnalyticsClient {
  constructor(private client: AzureDevOpsClient) {}

  /**
   * Get work item count by state over time using proper aggregation
   */
  async getWorkItemTrend(project: string, days: number = 30): Promise<any> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const startDateSK = this.dateToSK(startDate);
    const endDateSK = this.dateToSK(endDate);
    
    const query = `WorkItemSnapshot?$apply=` +
      `filter(DateSK ge ${startDateSK} and DateSK le ${endDateSK})/` +
      `groupby((DateSK, State), aggregate($count as Count))` +
      `&$orderby=DateSK`;
    
    return this.client.queryAnalytics(query, project);
  }

  /**
   * Get velocity metrics for sprints
   */
  async getVelocityMetrics(project: string, teamName?: string): Promise<VelocityMetrics> {
    const query = `WorkItemSnapshot?$apply=` +
      `filter(DateSK ge ${this.dateToSK(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))}` +
      ` and State eq 'Closed'` +
      `${teamName ? ` and contains(AreaPath, '${teamName}')` : ''})/` +
      `groupby((IterationPath), aggregate(StoryPoints with sum as TotalPoints, $count as CompletedItems))` +
      `&$orderby=IterationPath desc`;
    
    const result = await this.client.queryAnalytics(query, project);
    
    const velocities = result.value?.map((v: any) => v.TotalPoints || 0) || [];
    const averageVelocity = velocities.length > 0 
      ? velocities.reduce((a: number, b: number) => a + b, 0) / velocities.length 
      : 0;
    
    return {
      currentSprint: velocities[0] || 0,
      averageVelocity,
      trend: velocities.slice(0, 6),
      predictedVelocity: this.calculatePredictedVelocity(velocities)
    };
  }

  /**
   * Get cycle time metrics using aggregation
   */
  async getCycleTimeMetrics(project: string, days: number = 30): Promise<CycleTimeMetrics> {
    const startDateSK = this.dateToSK(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    
    const query = `WorkItemSnapshot?$apply=` +
      `filter(DateSK ge ${startDateSK} and State eq 'Closed')/` +
      `groupby((WorkItemId, WorkItemType), ` +
      `aggregate(CycleTimeDays with average as AvgCycleTime, ` +
      `CycleTimeDays with min as MinCycleTime, ` +
      `CycleTimeDays with max as MaxCycleTime))`;
    
    const result = await this.client.queryAnalytics(query, project);
    
    const cycleTimes = result.value?.map((v: any) => v.AvgCycleTime || 0) || [];
    const byType: Record<string, number> = {};
    
    result.value?.forEach((item: any) => {
      if (item.WorkItemType) {
        if (!byType[item.WorkItemType]) {
          byType[item.WorkItemType] = 0;
        }
        byType[item.WorkItemType] = item.AvgCycleTime || 0;
      }
    });
    
    return {
      average: this.calculateAverage(cycleTimes),
      median: this.calculateMedian(cycleTimes),
      p85: this.calculatePercentile(cycleTimes, 85),
      p95: this.calculatePercentile(cycleTimes, 95),
      byWorkItemType: byType
    };
  }

  /**
   * Get throughput metrics
   */
  async getThroughputMetrics(project: string): Promise<ThroughputMetrics> {
    const query = `WorkItemSnapshot?$apply=` +
      `filter(DateSK ge ${this.dateToSK(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))} and State eq 'Closed')/` +
      `groupby((DateSK), aggregate($count as Count))` +
      `&$orderby=DateSK desc`;
    
    const result = await this.client.queryAnalytics(query, project);
    
    const trend = result.value?.map((v: any) => ({
      date: this.skToDate(v.DateSK).toISOString().split('T')[0],
      count: v.Count || 0
    })) || [];
    
    const dailyAvg = trend.length > 0 
      ? trend.reduce((sum: number, t: { count: number }) => sum + t.count, 0) / trend.length 
      : 0;
    
    return {
      daily: dailyAvg,
      weekly: dailyAvg * 7,
      monthly: dailyAvg * 30,
      trend: trend.slice(0, 30)
    };
  }

  /**
   * Get quality metrics
   */
  async getQualityMetrics(project: string): Promise<QualityMetrics> {
    const bugQuery = `WorkItemSnapshot?$apply=` +
      `filter(DateSK eq ${this.dateToSK(new Date())} and WorkItemType eq 'Bug')/` +
      `groupby((State), aggregate($count as Count))`;
    
    const allItemsQuery = `WorkItemSnapshot?$apply=` +
      `filter(DateSK eq ${this.dateToSK(new Date())})/` +
      `aggregate($count as TotalCount)`;
    
    const [bugResult, totalResult] = await Promise.all([
      this.client.queryAnalytics(bugQuery, project),
      this.client.queryAnalytics(allItemsQuery, project)
    ]);
    
    const totalBugs = bugResult.value?.reduce((sum: number, v: any) => sum + (v.Count || 0), 0) || 0;
    const totalItems = totalResult.value?.[0]?.TotalCount || 1;
    
    return {
      bugRate: (totalBugs / totalItems) * 100,
      escapeRate: this.calculateEscapeRate(bugResult.value),
      reworkRate: 0, // Would need revision data
      testCoverage: 0, // Would need test data
      codeReviewCoverage: 0 // Would need PR data
    };
  }

  /**
   * Get DORA metrics
   */
  async getDORAMetrics(project: string): Promise<DORAMetrics> {
    // These would typically come from deployment/pipeline data
    // For now, we'll calculate proxies from work items
    
    const deploymentQuery = `WorkItemSnapshot?$apply=` +
      `filter(DateSK ge ${this.dateToSK(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))} ` +
      `and WorkItemType eq 'Task' and contains(Tags, 'deployment'))/` +
      `groupby((DateSK), aggregate($count as DeploymentCount))`;
    
    const result = await this.client.queryAnalytics(deploymentQuery, project);
    const deploymentDays = result.value?.filter((v: any) => v.DeploymentCount > 0).length || 1;
    
    return {
      deploymentFrequency: 30 / deploymentDays, // Deployments per day
      leadTimeForChanges: 48, // Hours - would need commit to deploy data
      meanTimeToRestore: 2, // Hours - would need incident data
      changeFailureRate: 5 // Percentage - would need failure data
    };
  }

  /**
   * Get team health metrics
   */
  async getTeamHealthMetrics(project: string, teamName?: string): Promise<TeamHealthMetrics> {
    const teamFilter = teamName ? ` and contains(AreaPath, '${teamName}')` : '';
    
    const wipQuery = `WorkItemSnapshot?$apply=` +
      `filter(DateSK eq ${this.dateToSK(new Date())} and State eq 'Active'${teamFilter})/` +
      `aggregate($count as WIPCount)`;
    
    const blockedQuery = `WorkItemSnapshot?$apply=` +
      `filter(DateSK eq ${this.dateToSK(new Date())} and contains(Tags, 'blocked')${teamFilter})/` +
      `aggregate($count as BlockedCount)`;
    
    const overdueQuery = `WorkItemSnapshot?$apply=` +
      `filter(DateSK eq ${this.dateToSK(new Date())} and DueDate lt ${this.dateToSK(new Date())}${teamFilter})/` +
      `aggregate($count as OverdueCount)`;
    
    const [wipResult, blockedResult, overdueResult] = await Promise.all([
      this.client.queryAnalytics(wipQuery, project),
      this.client.queryAnalytics(blockedQuery, project),
      this.client.queryAnalytics(overdueQuery, project)
    ]);
    
    return {
      workInProgress: wipResult.value?.[0]?.WIPCount || 0,
      blockedItems: blockedResult.value?.[0]?.BlockedCount || 0,
      overdueItems: overdueResult.value?.[0]?.OverdueCount || 0,
      teamUtilization: 75, // Would need capacity data
      happiness: 7.5 // Would need survey data
    };
  }

  /**
   * Get burndown chart data
   */
  async getBurndownData(project: string, iterationPath: string): Promise<any> {
    const query = `WorkItemSnapshot?$apply=` +
      `filter(IterationPath eq '${iterationPath}')/` +
      `groupby((DateSK, State), ` +
      `aggregate(StoryPoints with sum as RemainingPoints, $count as ItemCount))` +
      `&$orderby=DateSK`;
    
    const result = await this.client.queryAnalytics(query, project);
    
    const burndownData: Array<{ date: string; remaining: number; completed: number }> = [];
    const dataByDate: Record<string, { remaining: number; completed: number }> = {};
    
    result.value?.forEach((item: any) => {
      const date = this.skToDate(item.DateSK).toISOString().split('T')[0];
      if (!dataByDate[date]) {
        dataByDate[date] = { remaining: 0, completed: 0 };
      }
      
      if (item.State === 'Closed' || item.State === 'Done') {
        dataByDate[date].completed += item.RemainingPoints || 0;
      } else {
        dataByDate[date].remaining += item.RemainingPoints || 0;
      }
    });
    
    Object.entries(dataByDate).forEach(([date, data]) => {
      burndownData.push({ date, ...data });
    });
    
    return burndownData.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Get cumulative flow diagram data
   */
  async getCumulativeFlowData(project: string, days: number = 30): Promise<any> {
    const startDateSK = this.dateToSK(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    
    const query = `WorkItemSnapshot?$apply=` +
      `filter(DateSK ge ${startDateSK})/` +
      `groupby((DateSK, State), aggregate($count as Count))` +
      `&$orderby=DateSK`;
    
    const result = await this.client.queryAnalytics(query, project);
    
    const flowData: Record<string, Record<string, number>> = {};
    const states = new Set<string>();
    
    result.value?.forEach((item: any) => {
      const date = this.skToDate(item.DateSK).toISOString().split('T')[0];
      if (!flowData[date]) {
        flowData[date] = {};
      }
      flowData[date][item.State] = item.Count || 0;
      states.add(item.State);
    });
    
    return {
      dates: Object.keys(flowData).sort(),
      states: Array.from(states),
      data: flowData
    };
  }

  /**
   * Get complete dashboard metrics
   */
  async getDashboardMetrics(project: string, teamName?: string): Promise<DashboardMetrics> {
    const [velocity, cycleTime, throughput, quality, dora, teamHealth] = await Promise.all([
      this.getVelocityMetrics(project, teamName),
      this.getCycleTimeMetrics(project),
      this.getThroughputMetrics(project),
      this.getQualityMetrics(project),
      this.getDORAMetrics(project),
      this.getTeamHealthMetrics(project, teamName)
    ]);
    
    return {
      velocity,
      cycleTime,
      throughput,
      quality,
      dora,
      teamHealth
    };
  }

  /**
   * Helper to convert Date to DateSK format (YYYYMMDD)
   */
  private dateToSK(date: Date): number {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return parseInt(`${year}${month}${day}`);
  }

  /**
   * Helper to convert DateSK to Date
   */
  private skToDate(dateSK: number): Date {
    const str = dateSK.toString();
    const year = parseInt(str.substring(0, 4));
    const month = parseInt(str.substring(4, 6)) - 1;
    const day = parseInt(str.substring(6, 8));
    return new Date(year, month, day);
  }

  /**
   * Calculate predicted velocity using simple moving average
   */
  private calculatePredictedVelocity(velocities: number[]): number {
    if (velocities.length < 3) return velocities[0] || 0;
    const recentVelocities = velocities.slice(0, 3);
    return recentVelocities.reduce((a, b) => a + b, 0) / recentVelocities.length;
  }

  /**
   * Calculate average
   */
  private calculateAverage(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Calculate median
   */
  private calculateMedian(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 
      ? (sorted[mid - 1] + sorted[mid]) / 2 
      : sorted[mid];
  }

  /**
   * Calculate percentile
   */
  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Calculate escape rate (bugs found in production)
   */
  private calculateEscapeRate(bugStates: any[]): number {
    if (!bugStates || bugStates.length === 0) return 0;
    const productionBugs = bugStates.find((s: any) => 
      s.State === 'Active' || s.State === 'New'
    )?.Count || 0;
    const totalBugs = bugStates.reduce((sum: number, s: any) => sum + (s.Count || 0), 0) || 1;
    return (productionBugs / totalBugs) * 100;
  }

  /**
   * Get lead time metrics for a team over a period
   */
  async getLeadTimeMetrics(project: string, teamName: string, days: number): Promise<any> {
    const endDateSK = this.dateToSK(new Date());
    const startDateSK = this.dateToSK(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    
    const query = `WorkItemSnapshot?$apply=` +
      `filter(DateSK ge ${startDateSK} and DateSK le ${endDateSK} and State eq 'Closed'` +
      `${teamName ? ` and contains(AreaPath, '${teamName}')` : ''})/` +
      `aggregate(LeadTimeDays with average as AvgLeadTime, ` +
      `LeadTimeDays with min as MinLeadTime, ` +
      `LeadTimeDays with max as MaxLeadTime, ` +
      `$count as CompletedItems)`;
    
    const result = await this.client.queryAnalytics(query, project);
    
    return {
      teamName,
      period: days,
      averageLeadTime: result.value?.[0]?.AvgLeadTime || 0,
      minLeadTime: result.value?.[0]?.MinLeadTime || 0,
      maxLeadTime: result.value?.[0]?.MaxLeadTime || 0,
      completedItems: result.value?.[0]?.CompletedItems || 0
    };
  }

  /**
   * Get throughput with spike detection
   */
  async getThroughputWithSpikes(project: string): Promise<any> {
    const metrics = await this.getThroughputMetrics(project);
    const baseline = metrics.daily;
    
    const spikes = metrics.trend.filter((t: any) => {
      const deviation = t.count - baseline;
      return deviation > baseline * 2; // Spike if more than 2x baseline
    }).map((t: any) => ({
      date: t.date,
      count: t.count,
      deviationFromBaseline: t.count - baseline
    }));
    
    return { ...metrics, spikes };
  }

  /**
   * Calculate failure load over time
   */
  async getFailureLoad(project: string, days: number): Promise<any> {
    const endDateSK = this.dateToSK(new Date());
    const startDateSK = this.dateToSK(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    
    const query = `WorkItemSnapshot?$apply=` +
      `filter(DateSK ge ${startDateSK} and DateSK le ${endDateSK})/` +
      `groupby((DateSK), ` +
      `aggregate($count as TotalCount, ` +
      `$count($filter=WorkItemType eq 'Bug') as BugCount))`;
    
    const result = await this.client.queryAnalytics(query, project);
    
    const timeline = result.value?.map((v: any) => ({
      date: this.skToDate(v.DateSK).toISOString().split('T')[0],
      bugCount: v.BugCount || 0,
      totalCount: v.TotalCount || 0,
      failureRate: ((v.BugCount || 0) / (v.TotalCount || 1)) * 100
    })) || [];
    
    const averageFailureRate = timeline.length > 0
      ? timeline.reduce((sum: number, t: any) => sum + t.failureRate, 0) / timeline.length
      : 0;
    
    return { timeline, averageFailureRate };
  }

  /**
   * Analyze failure load trend
   */
  async getFailureLoadTrend(project: string, days: number): Promise<any> {
    const failureLoad = await this.getFailureLoad(project, days);
    
    if (failureLoad.timeline.length < 2) {
      return { trend: 'insufficient-data', trendStrength: 0 };
    }
    
    // Simple linear regression for trend
    const rates = failureLoad.timeline.map((t: any) => t.failureRate);
    const n = rates.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = rates.reduce((a: number, b: number) => a + b, 0);
    const sumXY = rates.reduce((sum: number, y: number, x: number) => sum + x * y, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const trend = slope > 0.1 ? 'increasing' : slope < -0.1 ? 'decreasing' : 'stable';
    const trendStrength = Math.min(Math.abs(slope) / 2, 1); // Normalize to 0-1
    
    return { trend, trendStrength, slope };
  }

  /**
   * Get average card age by work item type
   */
  async getAverageCardAge(project: string, workItemType: string): Promise<any> {
    const currentDateSK = this.dateToSK(new Date());
    
    const query = `WorkItemSnapshot?$apply=` +
      `filter(DateSK eq ${currentDateSK} and WorkItemType eq '${workItemType}' and State ne 'Closed')/` +
      `aggregate(AgeDays with average as AvgAge, ` +
      `AgeDays with min as MinAge, ` +
      `AgeDays with max as MaxAge, ` +
      `$count as TotalCards)`;
    
    const result = await this.client.queryAnalytics(query, project);
    
    return {
      workItemType,
      averageAge: result.value?.[0]?.AvgAge || 0,
      newestCard: result.value?.[0]?.MinAge || 0,
      oldestCard: result.value?.[0]?.MaxAge || 0,
      totalCards: result.value?.[0]?.TotalCards || 0
    };
  }

  /**
   * Get aging cards that need attention
   */
  async getAgingCards(project: string, workItemType: string, thresholdDays: number): Promise<any> {
    const currentDateSK = this.dateToSK(new Date());
    
    const query = `WorkItemSnapshot?$apply=` +
      `filter(DateSK eq ${currentDateSK} and WorkItemType eq '${workItemType}' ` +
      `and State ne 'Closed' and AgeDays gt ${thresholdDays})/` +
      `groupby((WorkItemId, AgeDays), aggregate($count as Count))` +
      `&$orderby=AgeDays desc`;
    
    const result = await this.client.queryAnalytics(query, project);
    
    const agingCards = result.value || [];
    const criticalCards = agingCards.filter((c: any) => c.AgeDays > thresholdDays * 2);
    const oldestCard = agingCards[0] || { AgeDays: 0 };
    
    return { agingCards, criticalCards, oldestCard };
  }

  /**
   * Get backlog growth metrics
   */
  async getBacklogGrowth(project: string, days: number): Promise<any> {
    const endDateSK = this.dateToSK(new Date());
    const startDateSK = this.dateToSK(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    
    const query = `WorkItemSnapshot?$apply=` +
      `filter(DateSK ge ${startDateSK} and DateSK le ${endDateSK} and State eq 'New')/` +
      `groupby((DateSK), aggregate($count as NewCards))` +
      `&$orderby=DateSK`;
    
    const result = await this.client.queryAnalytics(query, project);
    
    const dailyData = result.value?.map((v: any) => ({
      date: this.skToDate(v.DateSK).toISOString().split('T')[0],
      count: v.NewCards || 0
    })) || [];
    
    const totalNewCards = dailyData.reduce((sum: number, d: any) => sum + d.count, 0);
    const averageNewCardsPerDay = dailyData.length > 0 ? totalNewCards / dailyData.length : 0;
    
    // Detect spikes (days with 3x average or more)
    const spikes = dailyData.filter((d: any) => d.count > averageNewCardsPerDay * 3)
      .map((d: any) => ({
        ...d,
        deviationFromAverage: d.count - averageNewCardsPerDay
      }));
    
    return {
      totalNewCards,
      averageNewCardsPerDay,
      dailyData,
      spikes
    };
  }

  /**
   * Analyze backlog growth trend
   */
  async getBacklogGrowthTrend(project: string, days: number): Promise<any> {
    const growth = await this.getBacklogGrowth(project, days);
    
    if (growth.dailyData.length < 2) {
      return { 
        trend: 'insufficient-data', 
        currentRate: 0,
        projectedGrowth: 0,
        recommendations: []
      };
    }
    
    // Calculate trend
    const firstHalf = growth.dailyData.slice(0, Math.floor(growth.dailyData.length / 2));
    const secondHalf = growth.dailyData.slice(Math.floor(growth.dailyData.length / 2));
    
    const firstHalfAvg = firstHalf.reduce((sum: number, d: any) => sum + d.count, 0) / firstHalf.length;
    const secondHalfAvg = secondHalf.reduce((sum: number, d: any) => sum + d.count, 0) / secondHalf.length;
    
    const trend = secondHalfAvg > firstHalfAvg * 1.2 ? 'increasing' : 
                 secondHalfAvg < firstHalfAvg * 0.8 ? 'decreasing' : 'stable';
    
    const projectedGrowth = secondHalfAvg * 1.1; // Project 10% growth
    
    const recommendations = [];
    if (trend === 'increasing') {
      recommendations.push('Consider capacity planning');
      recommendations.push('Review backlog prioritization');
    }
    
    return {
      trend,
      currentRate: growth.averageNewCardsPerDay,
      projectedGrowth,
      recommendations
    };
  }

  /**
   * Detect backlog spikes with configurable threshold
   */
  async detectBacklogSpikes(project: string, days: number, threshold: number): Promise<any> {
    const growth = await this.getBacklogGrowth(project, days);
    const baseline = growth.averageNewCardsPerDay;
    
    const spikes = growth.dailyData.filter((d: any) => d.count > baseline * threshold)
      .map((d: any) => ({
        date: d.date,
        count: d.count,
        multiplier: d.count / baseline
      }));
    
    const spikeFrequency = spikes.length / growth.dailyData.length;
    
    return {
      spikes,
      spikeFrequency,
      baseline
    };
  }
}