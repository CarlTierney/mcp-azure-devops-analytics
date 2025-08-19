import { AzureDevOpsClient } from './azureDevOpsClient.js';
import { StorageManager } from './storageManager.js';
import { MetricsAggregator } from './metricsAggregator.js';

export interface HistoricalMetric {
  timestamp: Date;
  project: string;
  team?: string;
  metric: string;
  value: number;
  metadata?: Record<string, any>;
}

export interface MetricsTrend {
  metric: string;
  project: string;
  interval: string;
  data: Array<{
    period: string;
    value: number;
    change?: number;
    percentChange?: number;
  }>;
  trend: 'increasing' | 'stable' | 'decreasing';
  average: number;
  stdDev: number;
  forecast?: {
    nextPeriod: number;
    confidence: number;
  };
}

export class HistoricalDataCollector {
  private client: AzureDevOpsClient;
  private storage: StorageManager;
  private metricsAggregator: MetricsAggregator;
  
  constructor(client: AzureDevOpsClient, storage: StorageManager) {
    this.client = client;
    this.storage = storage;
    this.metricsAggregator = new MetricsAggregator(client, storage);
  }
  
  /**
   * Collect historical data for a time period
   */
  async collectHistoricalData(
    project: string,
    dateRange: { start: Date; end: Date },
    metricTypes: string[] = ['velocity', 'flow', 'dora']
  ): Promise<any> {
    const sessionId = await this.storage.createSession('historical-collection', {
      project,
      dateRange,
      metricTypes,
      startTime: new Date().toISOString()
    });
    
    const results: Record<string, any> = {};
    
    try {
      // Collect velocity metrics
      if (metricTypes.includes('velocity')) {
        results.velocity = await this.collectVelocityHistory(project, dateRange);
      }
      
      // Collect flow metrics
      if (metricTypes.includes('flow')) {
        results.flow = await this.collectFlowHistory(project, dateRange);
      }
      
      // Collect DORA metrics
      if (metricTypes.includes('dora')) {
        results.dora = await this.collectDoraHistory(project, dateRange);
      }
      
      // Collect quality metrics
      if (metricTypes.includes('quality')) {
        results.quality = await this.collectQualityHistory(project, dateRange);
      }
      
      // Store collected data
      await this.storage.updateSession(sessionId, {
        results,
        endTime: new Date().toISOString(),
        status: 'completed'
      });
      
      // Generate aggregations
      await this.generateAggregations(project, dateRange, results);
      
      return {
        sessionId,
        project,
        dateRange,
        metricsCollected: Object.keys(results),
        summary: this.generateSummary(results)
      };
      
    } catch (error: any) {
      await this.storage.updateSession(sessionId, {
        error: error.message,
        status: 'failed'
      });
      throw error;
    }
  }
  
  /**
   * Get historical trend for a specific metric
   */
  async getMetricsTrend(
    project: string,
    metricType: string,
    periods: number = 6,
    interval: string = 'sprint'
  ): Promise<MetricsTrend> {
    const cachedKey = `trend-${project}-${metricType}-${interval}-${periods}`;
    
    // Check cache first
    const cached = await this.storage.retrieve('cache', cachedKey);
    if (cached && this.isCacheValid(cached.timestamp)) {
      return cached.data;
    }
    
    // Collect historical data points
    const dataPoints: Array<{ period: string; value: number }> = [];
    
    if (interval === 'sprint') {
      // Get sprint-based metrics
      const sprints = await this.metricsAggregator.calculateSprintMetrics(
        project,
        undefined,
        periods
      );
      
      for (const sprint of sprints) {
        const value = this.extractMetricValue(sprint, metricType);
        dataPoints.push({
          period: sprint.sprintName,
          value
        });
      }
    } else {
      // Get time-based metrics
      const endDate = new Date();
      const startDate = this.calculateStartDate(endDate, interval, periods);
      
      for (let i = 0; i < periods; i++) {
        const periodEnd = new Date(endDate);
        periodEnd.setDate(periodEnd.getDate() - (i * this.getIntervalDays(interval)));
        
        const periodStart = new Date(periodEnd);
        periodStart.setDate(periodStart.getDate() - this.getIntervalDays(interval));
        
        const metrics = await this.getMetricsForPeriod(
          project,
          { start: periodStart, end: periodEnd },
          metricType
        );
        
        dataPoints.unshift({
          period: this.formatPeriod(periodEnd, interval),
          value: metrics.value
        });
      }
    }
    
    // Calculate trend statistics
    const trend = this.calculateTrend(dataPoints);
    
    // Add change calculations
    for (let i = 1; i < dataPoints.length; i++) {
      const current = dataPoints[i] as any;
      const previous = dataPoints[i - 1];
      
      current.change = current.value - previous.value;
      current.percentChange = previous.value !== 0 
        ? ((current.value - previous.value) / previous.value) * 100 
        : 0;
    }
    
    const result: MetricsTrend = {
      metric: metricType,
      project,
      interval,
      data: dataPoints,
      trend: trend.direction,
      average: trend.average,
      stdDev: trend.stdDev,
      forecast: this.generateForecast(dataPoints)
    };
    
    // Cache the result
    await this.storage.store('cache', cachedKey, result, {}, 3600000); // 1 hour TTL
    
    return result;
  }
  
  /**
   * Collect velocity history
   */
  private async collectVelocityHistory(
    project: string,
    dateRange: { start: Date; end: Date }
  ): Promise<any[]> {
    const velocityData: any[] = [];
    
    // Get iterations in date range
    const iterations = await this.client.getIterations(project);
    
    if (!iterations.value) return velocityData;
    
    for (const iteration of iterations.value) {
      // Skip if outside date range
      if (iteration.StartDateSK && iteration.EndDateSK) {
        const startDate = new Date(iteration.StartDateSK);
        const endDate = new Date(iteration.EndDateSK);
        
        if (startDate >= dateRange.start && endDate <= dateRange.end) {
          // Calculate velocity for this iteration
          const metrics = await this.metricsAggregator.calculateSprintMetrics(
            project,
            iteration.IterationPath,
            1
          );
          
          if (metrics.length > 0) {
            velocityData.push({
              iteration: iteration.IterationPath,
              startDate,
              endDate,
              velocity: metrics[0].velocity,
              completionRate: metrics[0].completionRate,
              carryOver: metrics[0].carryOverPoints
            });
          }
        }
      }
    }
    
    return velocityData;
  }
  
  /**
   * Collect flow metrics history
   */
  private async collectFlowHistory(
    project: string,
    dateRange: { start: Date; end: Date }
  ): Promise<any[]> {
    const flowData: any[] = [];
    
    // Break date range into weekly chunks
    const current = new Date(dateRange.start);
    
    while (current < dateRange.end) {
      const weekEnd = new Date(current);
      weekEnd.setDate(weekEnd.getDate() + 7);
      
      if (weekEnd > dateRange.end) {
        weekEnd.setTime(dateRange.end.getTime());
      }
      
      const weekMetrics = await this.metricsAggregator.calculateFlowMetrics(
        project,
        { start: current, end: weekEnd }
      );
      
      flowData.push({
        week: this.getWeekNumber(current),
        startDate: new Date(current),
        endDate: new Date(weekEnd),
        cycleTime: weekMetrics.cycleTime.average,
        leadTime: weekMetrics.leadTime.average,
        throughput: weekMetrics.throughput.weekly,
        wip: weekMetrics.wip.average,
        flowEfficiency: weekMetrics.flowEfficiency
      });
      
      current.setDate(current.getDate() + 7);
    }
    
    return flowData;
  }
  
  /**
   * Collect DORA metrics history
   */
  private async collectDoraHistory(
    project: string,
    dateRange: { start: Date; end: Date }
  ): Promise<any[]> {
    const doraData: any[] = [];
    
    // Break into monthly chunks for DORA metrics
    const current = new Date(dateRange.start);
    current.setDate(1); // Start of month
    
    while (current < dateRange.end) {
      const monthEnd = new Date(current);
      monthEnd.setMonth(monthEnd.getMonth() + 1);
      monthEnd.setDate(0); // Last day of month
      
      if (monthEnd > dateRange.end) {
        monthEnd.setTime(dateRange.end.getTime());
      }
      
      const monthMetrics = await this.metricsAggregator.calculateDoraMetrics(
        project,
        { start: current, end: monthEnd }
      );
      
      doraData.push({
        month: `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`,
        startDate: new Date(current),
        endDate: new Date(monthEnd),
        deploymentFrequency: monthMetrics.deploymentFrequency.deploymentsPerDay,
        leadTimeHours: monthMetrics.leadTimeForChanges.hours,
        mttrMinutes: monthMetrics.mttr.minutes,
        changeFailureRate: monthMetrics.changeFailureRate.percentage,
        performanceLevel: this.calculatePerformanceLevel(monthMetrics)
      });
      
      current.setMonth(current.getMonth() + 1);
    }
    
    return doraData;
  }
  
  /**
   * Collect quality metrics history
   */
  private async collectQualityHistory(
    project: string,
    dateRange: { start: Date; end: Date }
  ): Promise<any[]> {
    const qualityData: any[] = [];
    
    // Get bug metrics over time
    const filter = `WorkItemType eq 'Bug' and CreatedDateSK ge ${dateRange.start.toISOString().split('T')[0]} and CreatedDateSK le ${dateRange.end.toISOString().split('T')[0]}`;
    
    const bugs = await this.client.queryAnalytics(
      `WorkItemSnapshot?$select=WorkItemId,State,CreatedDateSK,ResolvedDateSK,Severity,Priority&$filter=${filter}`,
      project
    );
    
    if (bugs.value) {
      // Group by week
      const weeklyBugs = this.groupByWeek(bugs.value, 'CreatedDateSK');
      
      for (const [week, weekBugs] of Object.entries(weeklyBugs)) {
        const resolved = weekBugs.filter((b: any) => b.State === 'Resolved' || b.State === 'Closed');
        const critical = weekBugs.filter((b: any) => b.Severity === '1 - Critical' || b.Priority === 1);
        
        qualityData.push({
          week,
          bugsCreated: weekBugs.length,
          bugsResolved: resolved.length,
          criticalBugs: critical.length,
          escapeRate: this.calculateEscapeRate(weekBugs),
          resolutionTime: this.calculateAvgResolutionTime(resolved)
        });
      }
    }
    
    return qualityData;
  }
  
  /**
   * Generate aggregations for collected data
   */
  private async generateAggregations(
    project: string,
    dateRange: { start: Date; end: Date },
    results: Record<string, any>
  ): Promise<void> {
    // Daily aggregations
    const dailyAggregations: any[] = [];
    const current = new Date(dateRange.start);
    
    while (current <= dateRange.end) {
      const dayData = {
        date: current.toISOString().split('T')[0],
        project,
        metrics: {} as any
      };
      
      // Extract metrics for this day
      if (results.velocity) {
        const velocityForDay = results.velocity.find((v: any) => 
          v.startDate <= current && v.endDate >= current
        );
        if (velocityForDay) {
          dayData.metrics.velocity = velocityForDay.velocity;
        }
      }
      
      if (results.flow) {
        const flowForDay = results.flow.find((f: any) => 
          f.startDate <= current && f.endDate >= current
        );
        if (flowForDay) {
          dayData.metrics.cycleTime = flowForDay.cycleTime;
          dayData.metrics.throughput = flowForDay.throughput / 7; // Daily
        }
      }
      
      dailyAggregations.push(dayData);
      
      // Store daily aggregation
      await this.storage.store(
        'cache',
        `metrics/daily/${current.toISOString().split('T')[0]}`,
        dayData,
        { project },
        86400000 // 1 day TTL
      );
      
      current.setDate(current.getDate() + 1);
    }
    
    // Weekly rollups
    const weeks = this.groupByWeek(dailyAggregations, 'date');
    for (const [week, weekData] of Object.entries(weeks)) {
      const weeklyMetrics = this.aggregateMetrics(weekData as any[]);
      
      await this.storage.store(
        'cache',
        `metrics/weekly/${week}`,
        {
          week,
          project,
          metrics: weeklyMetrics
        },
        { project },
        604800000 // 1 week TTL
      );
    }
  }
  
  // Helper methods
  
  private extractMetricValue(data: any, metricType: string): number {
    switch (metricType) {
      case 'velocity':
        return data.velocity || 0;
      case 'cycleTime':
        return data.cycleTime?.average || 0;
      case 'leadTime':
        return data.leadTime?.average || 0;
      case 'throughput':
        return data.throughput?.weekly || 0;
      case 'deploymentFrequency':
        return data.deploymentFrequency?.deploymentsPerDay || 0;
      case 'mttr':
        return data.mttr?.minutes || 0;
      case 'changeFailureRate':
        return data.changeFailureRate?.percentage || 0;
      default:
        return 0;
    }
  }
  
  private calculateTrend(dataPoints: Array<{ value: number }>): any {
    if (dataPoints.length < 2) {
      return { direction: 'stable', average: 0, stdDev: 0 };
    }
    
    const values = dataPoints.map(d => d.value);
    const average = values.reduce((a, b) => a + b, 0) / values.length;
    
    // Calculate standard deviation
    const squaredDiffs = values.map(v => Math.pow(v - average, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    
    // Calculate trend direction
    const firstHalf = values.slice(0, Math.floor(values.length / 2));
    const secondHalf = values.slice(Math.floor(values.length / 2));
    
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    
    const change = (secondAvg - firstAvg) / firstAvg;
    
    let direction: 'increasing' | 'stable' | 'decreasing';
    if (change > 0.1) direction = 'increasing';
    else if (change < -0.1) direction = 'decreasing';
    else direction = 'stable';
    
    return { direction, average, stdDev };
  }
  
  private generateForecast(dataPoints: Array<{ value: number }>): any {
    if (dataPoints.length < 3) return null;
    
    // Simple linear regression for forecast
    const n = dataPoints.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = dataPoints.map(d => d.value);
    
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((a, b, i) => a + b * y[i], 0);
    const sumX2 = x.reduce((a, b) => a + b * b, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    const nextPeriod = slope * n + intercept;
    
    // Calculate confidence based on variance
    const predictions = x.map(xi => slope * xi + intercept);
    const errors = y.map((yi, i) => Math.abs(yi - predictions[i]));
    const avgError = errors.reduce((a, b) => a + b, 0) / errors.length;
    const confidence = Math.max(0, Math.min(100, 100 - (avgError / Math.abs(nextPeriod)) * 100));
    
    return {
      nextPeriod: Math.max(0, nextPeriod),
      confidence
    };
  }
  
  private calculateStartDate(endDate: Date, interval: string, periods: number): Date {
    const startDate = new Date(endDate);
    const days = this.getIntervalDays(interval) * periods;
    startDate.setDate(startDate.getDate() - days);
    return startDate;
  }
  
  private getIntervalDays(interval: string): number {
    switch (interval) {
      case 'daily': return 1;
      case 'weekly': return 7;
      case 'monthly': return 30;
      case 'sprint': return 14; // Typical 2-week sprint
      default: return 7;
    }
  }
  
  private formatPeriod(date: Date, interval: string): string {
    switch (interval) {
      case 'daily':
        return date.toISOString().split('T')[0];
      case 'weekly':
        return `W${this.getWeekNumber(date)}`;
      case 'monthly':
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      default:
        return date.toISOString().split('T')[0];
    }
  }
  
  private getWeekNumber(date: Date): string {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }
  
  private async getMetricsForPeriod(
    project: string,
    dateRange: { start: Date; end: Date },
    metricType: string
  ): Promise<{ value: number }> {
    switch (metricType) {
      case 'velocity':
        const sprints = await this.metricsAggregator.calculateSprintMetrics(project);
        return { value: sprints[0]?.velocity || 0 };
        
      case 'cycleTime':
      case 'leadTime':
      case 'throughput':
        const flow = await this.metricsAggregator.calculateFlowMetrics(project, dateRange);
        if (metricType === 'cycleTime') return { value: flow.cycleTime.average };
        if (metricType === 'leadTime') return { value: flow.leadTime.average };
        return { value: flow.throughput.weekly };
        
      case 'deploymentFrequency':
      case 'mttr':
      case 'changeFailureRate':
        const dora = await this.metricsAggregator.calculateDoraMetrics(project, dateRange);
        if (metricType === 'deploymentFrequency') return { value: dora.deploymentFrequency.deploymentsPerDay };
        if (metricType === 'mttr') return { value: dora.mttr.minutes };
        return { value: dora.changeFailureRate.percentage };
        
      default:
        return { value: 0 };
    }
  }
  
  private groupByWeek(data: any[], dateField: string): Record<string, any[]> {
    const grouped: Record<string, any[]> = {};
    
    for (const item of data) {
      const date = new Date(item[dateField]);
      const week = this.getWeekNumber(date);
      
      if (!grouped[week]) {
        grouped[week] = [];
      }
      grouped[week].push(item);
    }
    
    return grouped;
  }
  
  private aggregateMetrics(data: any[]): any {
    const result: any = {};
    
    if (data.length === 0) return result;
    
    // Get all metric keys
    const metricKeys = new Set<string>();
    data.forEach(d => {
      if (d.metrics) {
        Object.keys(d.metrics).forEach(key => metricKeys.add(key));
      }
    });
    
    // Calculate averages for each metric
    for (const key of metricKeys) {
      const values = data
        .filter(d => d.metrics && d.metrics[key] !== undefined)
        .map(d => d.metrics[key]);
      
      if (values.length > 0) {
        result[key] = values.reduce((a, b) => a + b, 0) / values.length;
      }
    }
    
    return result;
  }
  
  private calculatePerformanceLevel(metrics: any): string {
    let score = 0;
    
    if (metrics.deploymentFrequency.classification === 'elite') score += 25;
    else if (metrics.deploymentFrequency.classification === 'high') score += 15;
    else if (metrics.deploymentFrequency.classification === 'medium') score += 10;
    
    if (metrics.leadTimeForChanges.classification === 'elite') score += 25;
    else if (metrics.leadTimeForChanges.classification === 'high') score += 15;
    else if (metrics.leadTimeForChanges.classification === 'medium') score += 10;
    
    if (metrics.mttr.classification === 'elite') score += 25;
    else if (metrics.mttr.classification === 'high') score += 15;
    else if (metrics.mttr.classification === 'medium') score += 10;
    
    if (metrics.changeFailureRate.classification === 'elite') score += 25;
    else if (metrics.changeFailureRate.classification === 'high') score += 15;
    else if (metrics.changeFailureRate.classification === 'medium') score += 10;
    
    if (score >= 80) return 'elite';
    if (score >= 50) return 'high';
    if (score >= 30) return 'medium';
    return 'low';
  }
  
  private calculateEscapeRate(bugs: any[]): number {
    const production = bugs.filter((b: any) => 
      b.Environment === 'Production' || b.FoundIn === 'Production'
    );
    return bugs.length > 0 ? (production.length / bugs.length) * 100 : 0;
  }
  
  private calculateAvgResolutionTime(resolvedBugs: any[]): number {
    if (resolvedBugs.length === 0) return 0;
    
    const resolutionTimes = resolvedBugs.map((bug: any) => {
      if (bug.CreatedDateSK && bug.ResolvedDateSK) {
        const created = new Date(bug.CreatedDateSK);
        const resolved = new Date(bug.ResolvedDateSK);
        return (resolved.getTime() - created.getTime()) / (1000 * 60 * 60 * 24); // Days
      }
      return 0;
    }).filter(time => time > 0);
    
    return resolutionTimes.length > 0
      ? resolutionTimes.reduce((a, b) => a + b, 0) / resolutionTimes.length
      : 0;
  }
  
  private isCacheValid(timestamp: string): boolean {
    const cacheTime = new Date(timestamp);
    const now = new Date();
    const hoursDiff = (now.getTime() - cacheTime.getTime()) / (1000 * 60 * 60);
    return hoursDiff < 1; // Cache valid for 1 hour
  }
  
  private generateSummary(results: Record<string, any>): any {
    const summary: any = {
      dataPoints: 0,
      datesCovered: 0,
      metrics: {}
    };
    
    for (const [key, value] of Object.entries(results)) {
      if (Array.isArray(value)) {
        summary.dataPoints += value.length;
        
        if (key === 'velocity' && value.length > 0) {
          summary.metrics.avgVelocity = value.reduce((sum, v) => sum + v.velocity, 0) / value.length;
        }
        
        if (key === 'flow' && value.length > 0) {
          summary.metrics.avgCycleTime = value.reduce((sum, f) => sum + f.cycleTime, 0) / value.length;
        }
        
        if (key === 'dora' && value.length > 0) {
          const latest = value[value.length - 1];
          summary.metrics.currentPerformanceLevel = latest.performanceLevel;
        }
      }
    }
    
    return summary;
  }
}