import { AzureDevOpsClient } from './azureDevOpsClient.js';

export interface AnalyticsFilter {
  teamName?: string;
  areaPath?: string;
  assignedTo?: string;
  workItemType?: string;
  state?: string;
  tags?: string[];
  dateRange?: {
    start: Date;
    end: Date;
  };
  iterationPath?: string;
}

export interface MetricsPeriod {
  days: number;
  label: string;
}

export interface LeadTimeAnalysis {
  periods: {
    twoWeeks: number;
    thirtyDays: number;
    sixtyDays: number;
    year: number;
  };
  trend: 'improving' | 'degrading' | 'stable';
  breakdown: {
    byTeam?: Record<string, number>;
    byArea?: Record<string, number>;
    byUser?: Record<string, number>;
    byWorkItemType?: Record<string, number>;
  };
  percentiles: {
    p50: number;
    p75: number;
    p90: number;
    p95: number;
  };
}

export interface CycleTimeAnalysis {
  periods: {
    twoWeeks: number;
    thirtyDays: number;
    sixtyDays: number;
    year: number;
  };
  trend: 'improving' | 'degrading' | 'stable';
  breakdown: {
    byTeam?: Record<string, number>;
    byArea?: Record<string, number>;
    byUser?: Record<string, number>;
    byWorkItemType?: Record<string, number>;
  };
  percentiles: {
    p50: number;
    p75: number;
    p90: number;
    p95: number;
  };
}

export interface ThroughputAnalysis {
  baseline: number;
  projectedBaseline: number;
  historicalAverage: number;
  breakdown: {
    byTeam?: Record<string, number>;
    byArea?: Record<string, number>;
    byUser?: Record<string, number>;
    byWorkItemType?: Record<string, number>;
  };
  trend: Array<{
    date: string;
    actual: number;
    baseline: number;
    deviation: number;
  }>;
  spikes: Array<{
    date: string;
    value: number;
    severity: 'low' | 'medium' | 'high';
  }>;
}

export interface FailureLoadAnalysis {
  current: number;
  trend: 'increasing' | 'decreasing' | 'stable';
  calculated: {
    bugRatio: number;
    defectDensity: number;
    escapeRate: number;
    mttr: number; // Mean Time To Resolve
  };
  breakdown: {
    byTeam?: Record<string, number>;
    byArea?: Record<string, number>;
    byPriority?: Record<string, number>;
    bySeverity?: Record<string, number>;
  };
  timeline: Array<{
    date: string;
    failureLoad: number;
    newBugs: number;
    resolvedBugs: number;
  }>;
}

export interface CardAgeAnalysis {
  averageAge: {
    overall: number;
    byType: Record<string, number>;
    byState: Record<string, number>;
  };
  aging: {
    critical: Array<{ id: number; age: number; title: string }>;
    warning: Array<{ id: number; age: number; title: string }>;
    normal: Array<{ id: number; age: number; title: string }>;
  };
  distribution: {
    buckets: Array<{ range: string; count: number }>;
  };
}

export interface BacklogAnalysis {
  growthRate: number;
  averageNewCards: {
    daily: number;
    weekly: number;
    monthly: number;
  };
  spikes: Array<{
    date: string;
    count: number;
    impact: 'low' | 'medium' | 'high';
    possibleCause?: string;
  }>;
  breakdown: {
    byTeam?: Record<string, number>;
    byArea?: Record<string, number>;
    byType?: Record<string, number>;
    byPriority?: Record<string, number>;
  };
  forecast: {
    nextWeek: number;
    nextMonth: number;
    capacity: 'sufficient' | 'warning' | 'critical';
  };
}

export class AdvancedAnalyticsClient {
  constructor(private client: AzureDevOpsClient) {}

  /**
   * Comprehensive lead time analysis with flexible filtering
   */
  async analyzeLeadTime(project: string, filter: AnalyticsFilter = {}): Promise<LeadTimeAnalysis> {
    const periods: MetricsPeriod[] = [
      { days: 14, label: 'twoWeeks' },
      { days: 30, label: 'thirtyDays' },
      { days: 60, label: 'sixtyDays' },
      { days: 365, label: 'year' }
    ];

    const periodResults: any = {};
    const breakdown: any = {};

    for (const period of periods) {
      const query = this.buildLeadTimeQuery(project, period.days, filter);
      const result = await this.client.queryAnalytics(query, project);
      
      if (result.value && result.value.length > 0) {
        // Calculate lead times from date fields
        const leadTimes = result.value.map((item: any) => {
          if (item.CreatedDateSK && item.ClosedDateSK) {
            return this.calculateDaysBetweenSK(item.CreatedDateSK, item.ClosedDateSK);
          }
          return 0;
        }).filter((lt: number) => lt > 0);
        
        periodResults[period.label] = leadTimes.length > 0 ? this.calculateAverage(leadTimes) : 0;
        
        // Collect breakdown data
        if (filter.teamName === undefined && result.value.length > 1) {
          breakdown.byTeam = this.groupByField(result.value, 'TeamName', 'AvgLeadTime');
        }
        if (filter.areaPath === undefined && result.value.length > 1) {
          breakdown.byArea = this.groupByField(result.value, 'AreaPath', 'AvgLeadTime');
        }
        if (filter.assignedTo === undefined && result.value.length > 1) {
          breakdown.byUser = this.groupByField(result.value, 'AssignedTo', 'AvgLeadTime');
        }
        if (filter.workItemType === undefined && result.value.length > 1) {
          breakdown.byWorkItemType = this.groupByField(result.value, 'WorkItemType', 'AvgLeadTime');
        }
      }
    }

    // Calculate percentiles from raw data
    const percentilesQuery = this.buildPercentilesQuery(project, 'LeadTimeDays', filter);
    const percentilesResult = await this.client.queryAnalytics(percentilesQuery, project);
    
    let percentiles = { p50: 0, p75: 0, p90: 0, p95: 0 };
    
    if (percentilesResult.value && percentilesResult.value.length > 0) {
      const allLeadTimes = percentilesResult.value.map((item: any) => {
        if (item.CreatedDateSK && item.ClosedDateSK) {
          return this.calculateDaysBetweenSK(item.CreatedDateSK, item.ClosedDateSK);
        }
        return 0;
      }).filter((lt: number) => lt > 0).sort((a: number, b: number) => a - b);
      
      if (allLeadTimes.length > 0) {
        percentiles = {
          p50: this.calculatePercentile(allLeadTimes, 50),
          p75: this.calculatePercentile(allLeadTimes, 75),
          p90: this.calculatePercentile(allLeadTimes, 90),
          p95: this.calculatePercentile(allLeadTimes, 95)
        };
      }
    }

    // Determine trend
    const trend = this.calculateTrend([
      periodResults.twoWeeks,
      periodResults.thirtyDays,
      periodResults.sixtyDays
    ]);

    return {
      periods: periodResults,
      trend,
      breakdown,
      percentiles
    };
  }

  /**
   * Comprehensive cycle time analysis with flexible filtering
   */
  async analyzeCycleTime(project: string, filter: AnalyticsFilter = {}): Promise<CycleTimeAnalysis> {
    const periods: MetricsPeriod[] = [
      { days: 14, label: 'twoWeeks' },
      { days: 30, label: 'thirtyDays' },
      { days: 60, label: 'sixtyDays' },
      { days: 365, label: 'year' }
    ];

    const periodResults: any = {};
    const breakdown: any = {};

    for (const period of periods) {
      const query = this.buildCycleTimeQuery(project, period.days, filter);
      const result = await this.client.queryAnalytics(query, project);
      
      if (result.value && result.value.length > 0) {
        // Calculate cycle times from date fields
        // If ActivatedDateSK is not available, use CreatedDateSK as fallback
        const cycleTimes = result.value.map((item: any) => {
          const startDate = item.ActivatedDateSK || item.CreatedDateSK;
          if (startDate && item.ClosedDateSK) {
            return this.calculateDaysBetweenSK(startDate, item.ClosedDateSK);
          }
          return 0;
        }).filter((ct: number) => ct > 0);
        
        periodResults[period.label] = cycleTimes.length > 0 ? this.calculateAverage(cycleTimes) : 0;
        
        // Collect breakdown data
        if (filter.teamName === undefined && result.value.length > 1) {
          breakdown.byTeam = this.groupByField(result.value, 'TeamName', 'AvgCycleTime');
        }
        if (filter.areaPath === undefined && result.value.length > 1) {
          breakdown.byArea = this.groupByField(result.value, 'AreaPath', 'AvgCycleTime');
        }
        if (filter.assignedTo === undefined && result.value.length > 1) {
          breakdown.byUser = this.groupByField(result.value, 'AssignedTo', 'AvgCycleTime');
        }
        if (filter.workItemType === undefined && result.value.length > 1) {
          breakdown.byWorkItemType = this.groupByField(result.value, 'WorkItemType', 'AvgCycleTime');
        }
      }
    }

    // Calculate percentiles from raw data
    const percentilesQuery = this.buildPercentilesQuery(project, 'CycleTimeDays', filter);
    const percentilesResult = await this.client.queryAnalytics(percentilesQuery, project);
    
    let percentiles = { p50: 0, p75: 0, p90: 0, p95: 0 };
    
    if (percentilesResult.value && percentilesResult.value.length > 0) {
      const allCycleTimes = percentilesResult.value.map((item: any) => {
        const startDate = item.ActivatedDateSK || item.CreatedDateSK;
        if (startDate && item.ClosedDateSK) {
          return this.calculateDaysBetweenSK(startDate, item.ClosedDateSK);
        }
        return 0;
      }).filter((ct: number) => ct > 0).sort((a: number, b: number) => a - b);
      
      if (allCycleTimes.length > 0) {
        percentiles = {
          p50: this.calculatePercentile(allCycleTimes, 50),
          p75: this.calculatePercentile(allCycleTimes, 75),
          p90: this.calculatePercentile(allCycleTimes, 90),
          p95: this.calculatePercentile(allCycleTimes, 95)
        };
      }
    }

    // Determine trend
    const trend = this.calculateTrend([
      periodResults.twoWeeks,
      periodResults.thirtyDays,
      periodResults.sixtyDays
    ]);

    return {
      periods: periodResults,
      trend,
      breakdown,
      percentiles
    };
  }

  /**
   * Throughput analysis with baseline projection and flexible filtering
   */
  async analyzeThroughput(project: string, filter: AnalyticsFilter = {}): Promise<ThroughputAnalysis> {
    const days = 90; // Look back 90 days for baseline
    const query = this.buildThroughputQuery(project, days, filter);
    const result = await this.client.queryAnalytics(query, project);

    const dailyData = result.value || [];
    const throughputValues = dailyData.map((d: any) => d.Count || 0);
    
    // Calculate baseline (median of historical data)
    const baseline = this.calculateMedian(throughputValues);
    
    // Calculate historical average
    const historicalAverage = throughputValues.length > 0
      ? throughputValues.reduce((a: number, b: number) => a + b, 0) / throughputValues.length
      : 0;
    
    // Project baseline (using linear regression)
    const projectedBaseline = this.projectBaseline(throughputValues);
    
    // Build trend data
    const trend = dailyData.map((d: any) => ({
      date: this.formatDate(d.DateSK),
      actual: d.Count || 0,
      baseline,
      deviation: (d.Count || 0) - baseline
    }));
    
    // Detect spikes
    const spikes = this.detectSpikes(dailyData, baseline);
    
    // Get breakdown if no specific filters
    const breakdown: any = {};
    if (!filter.teamName && !filter.areaPath && !filter.assignedTo) {
      const breakdownQuery = this.buildThroughputBreakdownQuery(project, 30, filter);
      const breakdownResult = await this.client.queryAnalytics(breakdownQuery, project);
      
      if (breakdownResult.value) {
        breakdown.byTeam = this.groupByField(breakdownResult.value, 'TeamName', 'Count');
        breakdown.byArea = this.groupByField(breakdownResult.value, 'AreaPath', 'Count');
        breakdown.byUser = this.groupByField(breakdownResult.value, 'AssignedTo', 'Count');
        breakdown.byWorkItemType = this.groupByField(breakdownResult.value, 'WorkItemType', 'Count');
      }
    }

    return {
      baseline,
      projectedBaseline,
      historicalAverage,
      breakdown,
      trend,
      spikes
    };
  }

  /**
   * Failure load analysis with calculated metrics and flexible filtering
   */
  async analyzeFailureLoad(project: string, filter: AnalyticsFilter = {}): Promise<FailureLoadAnalysis> {
    const days = 30;
    const query = this.buildFailureLoadQuery(project, days, filter);
    const result = await this.client.queryAnalytics(query, project);

    const data = result.value || [];
    
    // Calculate current failure load
    const current = data.length > 0
      ? (data[data.length - 1].BugCount / data[data.length - 1].TotalCount) * 100
      : 0;
    
    // Calculate trend
    const trend = this.calculateFailureTrend(data);
    
    // Calculate detailed metrics
    const bugQuery = this.buildBugMetricsQuery(project, days, filter);
    const bugResult = await this.client.queryAnalytics(bugQuery, project);
    
    const calculated = {
      bugRatio: this.calculateBugRatio(bugResult.value),
      defectDensity: this.calculateDefectDensity(bugResult.value),
      escapeRate: this.calculateEscapeRate(bugResult.value),
      mttr: this.calculateMTTR(bugResult.value)
    };
    
    // Get breakdown
    const breakdownQuery = this.buildFailureBreakdownQuery(project, days, filter);
    const breakdownResult = await this.client.queryAnalytics(breakdownQuery, project);
    
    const breakdown = {
      byTeam: this.groupByField(breakdownResult.value, 'TeamName', 'BugCount'),
      byArea: this.groupByField(breakdownResult.value, 'AreaPath', 'BugCount'),
      byPriority: this.groupByField(breakdownResult.value, 'Priority', 'BugCount'),
      bySeverity: this.groupByField(breakdownResult.value, 'Severity', 'BugCount')
    };
    
    // Build timeline
    const timeline = data.map((d: any) => ({
      date: this.formatDate(d.DateSK),
      failureLoad: (d.BugCount / d.TotalCount) * 100,
      newBugs: d.NewBugs || 0,
      resolvedBugs: d.ResolvedBugs || 0
    }));

    return {
      current,
      trend,
      calculated,
      breakdown,
      timeline
    };
  }

  /**
   * Card age analysis with distribution and aging detection
   * Note: Card age is calculated from when work started (State changed from New) to current date for active items,
   * or to closed date for completed items. If your project tracks age differently, you can specify
   * in the filter or use custom queries.
   */
  async analyzeCardAge(project: string, filter: AnalyticsFilter = {}): Promise<CardAgeAnalysis> {
    const query = this.buildCardAgeQuery(project, filter);
    const result = await this.client.queryAnalytics(query, project);

    const cards = result.value || [];
    const currentDateSK = this.dateToSK(new Date());
    
    // Calculate age for each card
    // Using CreatedDateSK as a fallback since AgeDays is not available
    // Ideally, age should be from when State != 'New' to current/closed date
    const cardsWithAge = cards.map((c: any) => ({
      ...c,
      AgeDays: this.calculateDaysBetweenSK(c.CreatedDateSK || currentDateSK, currentDateSK)
    }));
    
    // Calculate average ages
    const averageAge = {
      overall: this.calculateAverage(cardsWithAge.map((c: any) => c.AgeDays || 0)),
      byType: this.groupByField(cardsWithAge, 'WorkItemType', 'AgeDays'),
      byState: this.groupByField(cardsWithAge, 'State', 'AgeDays')
    };
    
    // Categorize aging cards
    const aging = {
      critical: cardsWithAge.filter((c: any) => c.AgeDays > 90)
        .map((c: any) => ({ id: c.WorkItemId, age: c.AgeDays, title: c.Title })),
      warning: cardsWithAge.filter((c: any) => c.AgeDays > 60 && c.AgeDays <= 90)
        .map((c: any) => ({ id: c.WorkItemId, age: c.AgeDays, title: c.Title })),
      normal: cardsWithAge.filter((c: any) => c.AgeDays <= 60)
        .map((c: any) => ({ id: c.WorkItemId, age: c.AgeDays, title: c.Title }))
    };
    
    // Create age distribution
    const distribution = {
      buckets: [
        { range: '0-7 days', count: cardsWithAge.filter((c: any) => c.AgeDays <= 7).length },
        { range: '8-14 days', count: cardsWithAge.filter((c: any) => c.AgeDays > 7 && c.AgeDays <= 14).length },
        { range: '15-30 days', count: cardsWithAge.filter((c: any) => c.AgeDays > 14 && c.AgeDays <= 30).length },
        { range: '31-60 days', count: cardsWithAge.filter((c: any) => c.AgeDays > 30 && c.AgeDays <= 60).length },
        { range: '61-90 days', count: cardsWithAge.filter((c: any) => c.AgeDays > 60 && c.AgeDays <= 90).length },
        { range: '90+ days', count: cardsWithAge.filter((c: any) => c.AgeDays > 90).length }
      ]
    };

    return {
      averageAge,
      aging,
      distribution
    };
  }

  /**
   * Backlog growth analysis with spike detection and forecasting
   */
  async analyzeBacklogGrowth(project: string, filter: AnalyticsFilter = {}): Promise<BacklogAnalysis> {
    const days = 90;
    const query = this.buildBacklogGrowthQuery(project, days, filter);
    const result = await this.client.queryAnalytics(query, project);

    const data = result.value || [];
    
    // Calculate growth rate
    const growthRate = this.calculateGrowthRate(data);
    
    // Calculate averages
    const dailyValues = data.map((d: any) => d.NewCards || 0);
    const dailyAvg = this.calculateAverage(dailyValues);
    
    const averageNewCards = {
      daily: dailyAvg,
      weekly: dailyAvg * 7,
      monthly: dailyAvg * 30
    };
    
    // Detect spikes with analysis
    const spikes = this.analyzeSpikes(data, dailyAvg);
    
    // Get breakdown
    const breakdownQuery = this.buildBacklogBreakdownQuery(project, 30, filter);
    const breakdownResult = await this.client.queryAnalytics(breakdownQuery, project);
    
    const breakdown = {
      byTeam: this.groupByField(breakdownResult.value, 'TeamName', 'NewCards'),
      byArea: this.groupByField(breakdownResult.value, 'AreaPath', 'NewCards'),
      byType: this.groupByField(breakdownResult.value, 'WorkItemType', 'NewCards'),
      byPriority: this.groupByField(breakdownResult.value, 'Priority', 'NewCards')
    };
    
    // Forecast
    const forecast = this.forecastBacklog(data, dailyAvg);

    return {
      growthRate,
      averageNewCards,
      spikes,
      breakdown,
      forecast
    };
  }

  // Helper methods for building queries
  private buildLeadTimeQuery(project: string, days: number, filter: AnalyticsFilter): string {
    const filters = this.buildFilterString(filter, days);
    const groupBy = this.buildGroupByString(filter);
    
    // Since LeadTimeDays might not be available, we'll get CreatedDateSK and ClosedDateSK
    // and calculate lead time in the processing logic
    return `WorkItemSnapshot?$apply=` +
      `filter(${filters} and State eq 'Closed')/` +
      `${groupBy ? `groupby((${groupBy}, CreatedDateSK, ClosedDateSK), ` : 'groupby((CreatedDateSK, ClosedDateSK), '}` +
      `aggregate($count as CompletedItems))`;
  }

  private buildCycleTimeQuery(project: string, days: number, filter: AnalyticsFilter): string {
    const filters = this.buildFilterString(filter, days);
    const groupBy = this.buildGroupByString(filter);
    
    // Since CycleTimeDays might not be available, we'll get ActivatedDateSK and ClosedDateSK
    // and calculate cycle time in the processing logic
    return `WorkItemSnapshot?$apply=` +
      `filter(${filters} and State eq 'Closed')/` +
      `${groupBy ? `groupby((${groupBy}, ActivatedDateSK, ClosedDateSK), ` : 'groupby((ActivatedDateSK, ClosedDateSK), '}` +
      `aggregate($count as CompletedItems))`;
  }

  private buildThroughputQuery(project: string, days: number, filter: AnalyticsFilter): string {
    const filters = this.buildFilterString(filter, days);
    
    return `WorkItemSnapshot?$apply=` +
      `filter(${filters} and State eq 'Closed')/` +
      `groupby((DateSK), aggregate($count as Count))` +
      `&$orderby=DateSK desc`;
  }

  private buildThroughputBreakdownQuery(project: string, days: number, filter: AnalyticsFilter): string {
    const filters = this.buildFilterString(filter, days);
    
    return `WorkItemSnapshot?$apply=` +
      `filter(${filters} and State eq 'Closed')/` +
      `groupby((TeamName, AreaPath, AssignedTo, WorkItemType), ` +
      `aggregate($count as Count))`;
  }

  private buildFailureLoadQuery(project: string, days: number, filter: AnalyticsFilter): string {
    const filters = this.buildFilterString(filter, days);
    
    return `WorkItemSnapshot?$apply=` +
      `filter(${filters})/` +
      `groupby((DateSK), ` +
      `aggregate($count as TotalCount, ` +
      `$count($filter=WorkItemType eq 'Bug') as BugCount, ` +
      `$count($filter=WorkItemType eq 'Bug' and State eq 'New') as NewBugs, ` +
      `$count($filter=WorkItemType eq 'Bug' and State eq 'Closed') as ResolvedBugs))` +
      `&$orderby=DateSK`;
  }

  private buildBugMetricsQuery(project: string, days: number, filter: AnalyticsFilter): string {
    const filters = this.buildFilterString(filter, days);
    
    return `WorkItemSnapshot?$apply=` +
      `filter(${filters} and WorkItemType eq 'Bug')/` +
      `groupby((State, Priority, Severity), ` +
      `aggregate($count as Count, ` +
      `CycleTimeDays with average as AvgResolutionTime))`;
  }

  private buildFailureBreakdownQuery(project: string, days: number, filter: AnalyticsFilter): string {
    const filters = this.buildFilterString(filter, days);
    
    return `WorkItemSnapshot?$apply=` +
      `filter(${filters} and WorkItemType eq 'Bug')/` +
      `groupby((TeamName, AreaPath, Priority, Severity), ` +
      `aggregate($count as BugCount))`;
  }

  private buildCardAgeQuery(project: string, filter: AnalyticsFilter): string {
    const currentDateSK = this.dateToSK(new Date());
    let filters = `DateSK eq ${currentDateSK} and State ne 'Closed'`;
    
    if (filter.teamName) filters += ` and contains(AreaPath, '${filter.teamName}')`;
    if (filter.areaPath) filters += ` and AreaPath eq '${filter.areaPath}'`;
    if (filter.assignedTo) filters += ` and AssignedTo eq '${filter.assignedTo}'`;
    if (filter.workItemType) filters += ` and WorkItemType eq '${filter.workItemType}'`;
    
    return `WorkItemSnapshot?$apply=` +
      `filter(${filters})/` +
      `groupby((WorkItemId, WorkItemType, State, Title, CreatedDateSK), ` +
      `aggregate($count as Count))`;
  }

  private buildBacklogGrowthQuery(project: string, days: number, filter: AnalyticsFilter): string {
    const filters = this.buildFilterString(filter, days);
    
    return `WorkItemSnapshot?$apply=` +
      `filter(${filters} and State eq 'New')/` +
      `groupby((DateSK), aggregate($count as NewCards))` +
      `&$orderby=DateSK`;
  }

  private buildBacklogBreakdownQuery(project: string, days: number, filter: AnalyticsFilter): string {
    const filters = this.buildFilterString(filter, days);
    
    return `WorkItemSnapshot?$apply=` +
      `filter(${filters} and State eq 'New')/` +
      `groupby((TeamName, AreaPath, WorkItemType, Priority), ` +
      `aggregate($count as NewCards))`;
  }

  private buildPercentilesQuery(project: string, metric: string, filter: AnalyticsFilter): string {
    const days = 90;
    const filters = this.buildFilterString(filter, days);
    
    // Since percentile functions might not work with calculated fields,
    // we'll get the raw data and calculate percentiles in code
    return `WorkItemSnapshot?$apply=` +
      `filter(${filters} and State eq 'Closed')/` +
      `groupby((WorkItemId, CreatedDateSK, ClosedDateSK, ActivatedDateSK), ` +
      `aggregate($count as Count))`;
  }

  private buildFilterString(filter: AnalyticsFilter, days?: number): string {
    const filters: string[] = [];
    
    if (days) {
      const endDateSK = this.dateToSK(new Date());
      const startDateSK = this.dateToSK(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
      filters.push(`DateSK ge ${startDateSK} and DateSK le ${endDateSK}`);
    }
    
    if (filter.dateRange) {
      const startDateSK = this.dateToSK(filter.dateRange.start);
      const endDateSK = this.dateToSK(filter.dateRange.end);
      filters.push(`DateSK ge ${startDateSK} and DateSK le ${endDateSK}`);
    }
    
    if (filter.teamName) filters.push(`contains(AreaPath, '${filter.teamName}')`);
    if (filter.areaPath) filters.push(`AreaPath eq '${filter.areaPath}'`);
    if (filter.assignedTo) filters.push(`AssignedTo eq '${filter.assignedTo}'`);
    if (filter.workItemType) filters.push(`WorkItemType eq '${filter.workItemType}'`);
    if (filter.state) filters.push(`State eq '${filter.state}'`);
    if (filter.iterationPath) filters.push(`IterationPath eq '${filter.iterationPath}'`);
    if (filter.tags && filter.tags.length > 0) {
      filter.tags.forEach(tag => filters.push(`contains(Tags, '${tag}')`));
    }
    
    return filters.join(' and ');
  }

  private buildGroupByString(filter: AnalyticsFilter): string {
    const groupBy: string[] = [];
    
    if (!filter.teamName) groupBy.push('TeamName');
    if (!filter.areaPath) groupBy.push('AreaPath');
    if (!filter.assignedTo) groupBy.push('AssignedTo');
    if (!filter.workItemType) groupBy.push('WorkItemType');
    
    return groupBy.join(', ');
  }

  // Utility methods
  private dateToSK(date: Date): number {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return parseInt(`${year}${month}${day}`);
  }

  private formatDate(dateSK: number): string {
    const str = dateSK.toString();
    const year = str.substring(0, 4);
    const month = str.substring(4, 6);
    const day = str.substring(6, 8);
    return `${year}-${month}-${day}`;
  }

  private calculateAverage(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private calculateMedian(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 
      ? (sorted[mid - 1] + sorted[mid]) / 2 
      : sorted[mid];
  }

  private calculateDaysBetweenSK(startSK: number, endSK: number): number {
    const startStr = startSK.toString();
    const endStr = endSK.toString();
    
    const startDate = new Date(
      parseInt(startStr.substring(0, 4)),
      parseInt(startStr.substring(4, 6)) - 1,
      parseInt(startStr.substring(6, 8))
    );
    
    const endDate = new Date(
      parseInt(endStr.substring(0, 4)),
      parseInt(endStr.substring(4, 6)) - 1,
      parseInt(endStr.substring(6, 8))
    );
    
    return Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  private calculateTrend(values: number[]): 'improving' | 'degrading' | 'stable' {
    if (values.length < 2) return 'stable';
    
    const firstHalf = values.slice(0, Math.floor(values.length / 2));
    const secondHalf = values.slice(Math.floor(values.length / 2));
    
    const firstAvg = this.calculateAverage(firstHalf);
    const secondAvg = this.calculateAverage(secondHalf);
    
    if (secondAvg < firstAvg * 0.9) return 'improving';
    if (secondAvg > firstAvg * 1.1) return 'degrading';
    return 'stable';
  }

  private calculateFailureTrend(data: any[]): 'increasing' | 'decreasing' | 'stable' {
    if (data.length < 2) return 'stable';
    
    const rates = data.map((d: any) => (d.BugCount / d.TotalCount) * 100);
    const firstHalf = rates.slice(0, Math.floor(rates.length / 2));
    const secondHalf = rates.slice(Math.floor(rates.length / 2));
    
    const firstAvg = this.calculateAverage(firstHalf);
    const secondAvg = this.calculateAverage(secondHalf);
    
    if (secondAvg > firstAvg * 1.1) return 'increasing';
    if (secondAvg < firstAvg * 0.9) return 'decreasing';
    return 'stable';
  }

  private projectBaseline(values: number[]): number {
    if (values.length < 2) return values[0] || 0;
    
    // Simple linear regression
    const n = values.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = values.reduce((sum, y, x) => sum + x * y, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Project to next period
    return intercept + slope * n;
  }

  private detectSpikes(data: any[], baseline: number): any[] {
    return data
      .filter((d: any) => d.Count > baseline * 2)
      .map((d: any) => ({
        date: this.formatDate(d.DateSK),
        value: d.Count,
        severity: d.Count > baseline * 4 ? 'high' : d.Count > baseline * 3 ? 'medium' : 'low'
      }));
  }

  private analyzeSpikes(data: any[], average: number): any[] {
    return data
      .filter((d: any) => d.NewCards > average * 2)
      .map((d: any) => {
        const impact = d.NewCards > average * 5 ? 'high' : d.NewCards > average * 3 ? 'medium' : 'low';
        const possibleCause = this.inferSpikeCause(d, data);
        
        return {
          date: this.formatDate(d.DateSK),
          count: d.NewCards,
          impact,
          possibleCause
        };
      });
  }

  private inferSpikeCause(spike: any, data: any[]): string | undefined {
    const date = spike.DateSK;
    const dayOfWeek = new Date(this.formatDate(date)).getDay();
    
    if (dayOfWeek === 1) return 'Monday - Start of week';
    if (dayOfWeek === 5) return 'Friday - End of week';
    
    // Check if it's start of month
    const day = parseInt(date.toString().substring(6, 8));
    if (day <= 3) return 'Start of month';
    if (day >= 28) return 'End of month';
    
    return undefined;
  }

  private calculateGrowthRate(data: any[]): number {
    if (data.length < 2) return 0;
    
    const firstValue = data[0].NewCards || 0;
    const lastValue = data[data.length - 1].NewCards || 0;
    
    return ((lastValue - firstValue) / firstValue) * 100;
  }

  private calculateBugRatio(data: any[]): number {
    if (!data || data.length === 0) return 0;
    
    const totalBugs = data.reduce((sum: number, d: any) => sum + (d.Count || 0), 0);
    const totalItems = data.reduce((sum: number, d: any) => sum + (d.TotalCount || 0), 0) || 1;
    
    return (totalBugs / totalItems) * 100;
  }

  private calculateDefectDensity(data: any[]): number {
    // Simplified: bugs per 1000 lines of code (would need actual LOC data)
    // For now, return bugs per 100 work items
    if (!data || data.length === 0) return 0;
    
    const totalBugs = data.reduce((sum: number, d: any) => sum + (d.Count || 0), 0);
    return totalBugs / 100;
  }

  private calculateEscapeRate(data: any[]): number {
    if (!data || data.length === 0) return 0;
    
    const productionBugs = data
      .filter((d: any) => d.State === 'Active' || d.State === 'New')
      .reduce((sum: number, d: any) => sum + (d.Count || 0), 0);
    
    const totalBugs = data.reduce((sum: number, d: any) => sum + (d.Count || 0), 0) || 1;
    
    return (productionBugs / totalBugs) * 100;
  }

  private calculateMTTR(data: any[]): number {
    if (!data || data.length === 0) return 0;
    
    const resolutionTimes = data
      .filter((d: any) => d.AvgResolutionTime)
      .map((d: any) => d.AvgResolutionTime);
    
    return this.calculateAverage(resolutionTimes);
  }

  private forecastBacklog(data: any[], dailyAvg: number): any {
    const growthRate = this.calculateGrowthRate(data);
    
    const nextWeek = dailyAvg * 7 * (1 + growthRate / 100);
    const nextMonth = dailyAvg * 30 * (1 + growthRate / 100);
    
    // Determine capacity status based on growth rate
    let capacity: 'sufficient' | 'warning' | 'critical';
    if (growthRate < 10) capacity = 'sufficient';
    else if (growthRate < 25) capacity = 'warning';
    else capacity = 'critical';
    
    return {
      nextWeek,
      nextMonth,
      capacity
    };
  }

  private groupByField(data: any[], field: string, valueField: string): Record<string, number> {
    if (!data || data.length === 0) return {};
    
    const grouped: Record<string, number[]> = {};
    
    data.forEach((item: any) => {
      const key = item[field] || 'Unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(item[valueField] || 0);
    });
    
    const result: Record<string, number> = {};
    Object.entries(grouped).forEach(([key, values]) => {
      result[key] = this.calculateAverage(values);
    });
    
    return result;
  }
}