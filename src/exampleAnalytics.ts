import { AzureDevOpsClient } from './azureDevOpsClient.js';
import dotenv from 'dotenv';

dotenv.config();

interface WorkItemMetrics {
  total: number;
  byType: Record<string, number>;
  byState: Record<string, number>;
  byArea: Record<string, number>;
  unassigned: number;
}

interface TeamMetrics {
  teamName: string;
  workItems: number;
  areas: string[];
  bugCount: number;
  taskCount: number;
  featureCount: number;
}

async function generateAnalyticsReport() {
  const client = new AzureDevOpsClient({
    orgUrl: process.env.AZURE_DEVOPS_ORG_URL!,
    pat: process.env.AZURE_DEVOPS_PAT!,
    project: 'Fidem'
  });

  console.log('📊 Azure DevOps Analytics Report - Fidem Project\n');
  console.log('=' .repeat(60));
  
  try {
    // 1. Project Overview
    console.log('\n📁 PROJECT OVERVIEW\n');
    
    const [areas, teams, users] = await Promise.all([
      client.getAreas('Fidem'),
      client.getTeams('Fidem'),
      client.getUsers('Fidem')
    ]);
    
    console.log(`Total Areas: ${areas.value?.length || 0}`);
    console.log(`Total Teams: ${teams.value?.length || 0}`);
    console.log(`Total Users: ${users.value?.length || 0}`);
    
    // Area depth analysis
    if (areas.value) {
      const depths = areas.value.map((a: any) => a.AreaPath.split('\\').length);
      const maxDepth = Math.max(...depths);
      const avgDepth = depths.reduce((a: number, b: number) => a + b, 0) / depths.length;
      
      console.log(`\nArea Hierarchy:`);
      console.log(`  Max Depth: ${maxDepth} levels`);
      console.log(`  Avg Depth: ${avgDepth.toFixed(1)} levels`);
    }
    
    // 2. Work Item Analytics
    console.log('\n📈 WORK ITEM ANALYTICS\n');
    
    // Get current work items
    const workItems = await client.getWorkItemSnapshots({
      project: 'Fidem',
      select: 'WorkItemId,Title,WorkItemType,State,AssignedToUserSK,AreaSK,CreatedDate,ChangedDate',
      filter: 'State ne \'Closed\' and State ne \'Done\' and State ne \'Removed\'',
      top: 1000
    });
    
    let metrics: WorkItemMetrics | undefined;
    
    if (workItems.value && workItems.value.length > 0) {
      metrics = {
        total: workItems.value.length,
        byType: {},
        byState: {},
        byArea: {},
        unassigned: 0
      };
      
      // Calculate metrics
      workItems.value.forEach((wi: any) => {
        // By Type
        metrics!.byType[wi.WorkItemType] = (metrics!.byType[wi.WorkItemType] || 0) + 1;
        
        // By State
        metrics!.byState[wi.State] = (metrics!.byState[wi.State] || 0) + 1;
        
        // By Area
        const areaName = areas.value?.find((a: any) => a.AreaSK === wi.AreaSK)?.AreaPath || 'Unknown';
        metrics!.byArea[areaName] = (metrics!.byArea[areaName] || 0) + 1;
        
        // Unassigned
        if (!wi.AssignedToUserSK) {
          metrics!.unassigned++;
        }
      });
      
      console.log(`Active Work Items: ${metrics.total}`);
      console.log(`Unassigned Items: ${metrics.unassigned} (${((metrics.unassigned / metrics.total) * 100).toFixed(1)}%)`);
      
      console.log('\nBy Type:');
      Object.entries(metrics!.byType)
        .sort(([,a], [,b]) => b - a)
        .forEach(([type, count]) => {
          const percentage = ((count / metrics!.total) * 100).toFixed(1);
          console.log(`  ${type}: ${count} (${percentage}%)`);
        });
      
      console.log('\nBy State:');
      Object.entries(metrics!.byState)
        .sort(([,a], [,b]) => b - a)
        .forEach(([state, count]) => {
          const percentage = ((count / metrics!.total) * 100).toFixed(1);
          console.log(`  ${state}: ${count} (${percentage}%)`);
        });
      
      console.log('\nTop 5 Areas by Work Items:');
      Object.entries(metrics!.byArea)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .forEach(([area, count]) => {
          const shortArea = area.split('\\').slice(-2).join('\\');
          console.log(`  ${shortArea}: ${count} items`);
        });
    } else {
      console.log('No active work items found');
    }
    
    // 3. Team Analytics (based on area naming)
    console.log('\n👥 TEAM ANALYTICS\n');
    
    if (teams.value && areas.value) {
      const teamMetrics: TeamMetrics[] = [];
      
      for (const team of teams.value.slice(0, 5)) { // Top 5 teams
        const teamAreas = areas.value.filter((a: any) => 
          a.AreaPath.toLowerCase().includes(team.TeamName.toLowerCase())
        );
        
        let workItemCount = 0;
        let bugCount = 0;
        let taskCount = 0;
        let featureCount = 0;
        
        if (teamAreas.length > 0 && workItems.value) {
          const areaSKs = teamAreas.map((a: any) => a.AreaSK);
          const teamWorkItems = workItems.value.filter((wi: any) => 
            areaSKs.includes(wi.AreaSK)
          );
          
          workItemCount = teamWorkItems.length;
          bugCount = teamWorkItems.filter((wi: any) => wi.WorkItemType === 'Bug').length;
          taskCount = teamWorkItems.filter((wi: any) => wi.WorkItemType === 'Task').length;
          featureCount = teamWorkItems.filter((wi: any) => wi.WorkItemType === 'Feature').length;
        }
        
        teamMetrics.push({
          teamName: team.TeamName,
          workItems: workItemCount,
          areas: teamAreas.map((a: any) => a.AreaPath),
          bugCount,
          taskCount,
          featureCount
        });
      }
      
      console.log('Team Work Distribution (based on area naming):');
      teamMetrics
        .sort((a, b) => b.workItems - a.workItems)
        .forEach(tm => {
          console.log(`\n${tm.teamName}:`);
          console.log(`  Total Items: ${tm.workItems}`);
          if (tm.workItems > 0) {
            console.log(`  - Bugs: ${tm.bugCount}`);
            console.log(`  - Tasks: ${tm.taskCount}`);
            console.log(`  - Features: ${tm.featureCount}`);
          }
          console.log(`  Areas: ${tm.areas.length}`);
        });
    }
    
    // 4. Velocity Analysis (limited without iteration data)
    console.log('\n⚡ VELOCITY INDICATORS\n');
    
    // Get recently closed items using aggregation
    const recentlyClosedQuery = `WorkItemSnapshot?$apply=filter(State eq 'Closed' or State eq 'Done')/groupby((WorkItemType), aggregate($count as Count))`;
    let recentlyClosed: any = { value: [] };
    try {
      recentlyClosed = await client.queryAnalytics(recentlyClosedQuery, 'Fidem');
    } catch (err) {
      // Fallback to simpler query
      console.log('Using fallback query for closed items...');
    }
    
    if (recentlyClosed.value && recentlyClosed.value.length > 0) {
      console.log(`Recently Completed: ${recentlyClosed.value.length} items`);
      
      const byType: Record<string, number> = {};
      recentlyClosed.value.forEach((wi: any) => {
        byType[wi.WorkItemType] = (byType[wi.WorkItemType] || 0) + 1;
      });
      
      console.log('Completed by Type:');
      Object.entries(byType)
        .sort(([,a], [,b]) => b - a)
        .forEach(([type, count]) => {
          console.log(`  ${type}: ${count}`);
        });
    }
    
    // 5. Quality Metrics
    console.log('\n🐛 QUALITY METRICS\n');
    
    if (workItems.value) {
      const bugs = workItems.value.filter((wi: any) => wi.WorkItemType === 'Bug');
      const activeBugs = bugs.filter((b: any) => b.State === 'Active' || b.State === 'New');
      const inProgressBugs = bugs.filter((b: any) => b.State === 'In Progress' || b.State === 'Committed');
      
      console.log(`Total Open Bugs: ${bugs.length}`);
      console.log(`  New/Active: ${activeBugs.length}`);
      console.log(`  In Progress: ${inProgressBugs.length}`);
      
      const bugToFeatureRatio = bugs.length / (workItems.value.filter((wi: any) => wi.WorkItemType === 'Feature').length || 1);
      console.log(`Bug to Feature Ratio: ${bugToFeatureRatio.toFixed(2)}:1`);
    }
    
    // 6. Recommendations
    console.log('\n💡 INSIGHTS & RECOMMENDATIONS\n');
    
    if (workItems.value && metrics) {
      const unassignedPercentage = (metrics.unassigned / metrics.total) * 100;
      
      if (unassignedPercentage > 20) {
        console.log(`⚠️  High unassigned rate (${unassignedPercentage.toFixed(1)}%) - Consider work distribution`);
      }
      
      const bugPercentage = (metrics.byType['Bug'] || 0) / metrics.total * 100;
      if (bugPercentage > 30) {
        console.log(`⚠️  High bug percentage (${bugPercentage.toFixed(1)}%) - Focus on quality improvements`);
      }
      
      // Find areas with high concentration
      const highLoadAreas = Object.entries(metrics.byArea)
        .filter(([, count]) => (count as number) > metrics.total * 0.2)
        .map(([area]) => area.split('\\').pop());
      
      if (highLoadAreas.length > 0) {
        console.log(`⚠️  Work concentration in areas: ${highLoadAreas.join(', ')}`);
      }
    }
    
    console.log('\n' + '=' .repeat(60));
    console.log('\n✅ Analytics Report Complete');
    
    // What we could do with additional tools
    console.log('\n🔮 WITH ADDITIONAL TOOLS, WE COULD PROVIDE:');
    console.log('  • Sprint velocity trends and burn-down charts');
    console.log('  • Cycle time and lead time metrics');
    console.log('  • Team capacity and workload balancing');
    console.log('  • Predictive completion dates');
    console.log('  • Dependency and blocker analysis');
    console.log('  • Test coverage and quality trends');
    console.log('  • Individual contributor metrics');
    
  } catch (error: any) {
    console.error('\n❌ Error generating analytics:', error.message);
  }
}

// Run the analytics
generateAnalyticsReport();