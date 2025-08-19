import { AzureDevOpsClient } from './azureDevOpsClient.js';
import dotenv from 'dotenv';

dotenv.config();

interface TeamAnalytics {
  teamName: string;
  areaPaths: string[];
  totalWorkItems: number;
  activeWorkItems: number;
  completedWorkItems: number;
  bugs: number;
  tasks: number;
  features: number;
  epics: number;
  unassignedItems: number;
  teamMembers: Set<string>;
  averageAge: number;
  oldestItem: any;
}

async function generateImprovedAnalytics() {
  const project = process.env.AZURE_DEVOPS_PROJECT;
  if (!project) {
    console.error('❌ Error: AZURE_DEVOPS_PROJECT environment variable is required');
    process.exit(1);
  }
  
  const client = new AzureDevOpsClient({
    orgUrl: process.env.AZURE_DEVOPS_ORG_URL!,
    pat: process.env.AZURE_DEVOPS_PAT!,
    project
  });

  console.log(`📊 Advanced Azure DevOps Analytics Report - ${project} Project\n`);
  console.log('=' .repeat(70));
  console.log('ASSUMPTION: Team names correspond to area paths\n');
  console.log('=' .repeat(70));
  
  try {
    // Fetch all base data
    console.log('\n⏳ Loading data...\n');
    
    const [areas, teams, users, allWorkItems] = await Promise.all([
      client.getAreas(project),
      client.getTeams(project),
      client.getUsers(project),
      client.queryAnalytics(
        `WorkItemSnapshot?$select=WorkItemId,Title,WorkItemType,State,AssignedToUserSK,AreaSK,CreatedDateSK,ChangedDateSK,StoryPoints,Priority,Tags&$filter=Revision eq 1&$top=2000`,
        project
      )
    ]);
    
    // Create lookup maps
    const areaMap = new Map();
    const areaSKToPath = new Map();
    if (areas.value) {
      areas.value.forEach((area: any) => {
        areaMap.set(area.AreaPath, area);
        areaSKToPath.set(area.AreaSK, area.AreaPath);
      });
    }
    
    const userMap = new Map();
    if (users.value) {
      users.value.forEach((user: any) => {
        userMap.set(user.UserSK, user.UserName);
      });
    }
    
    // 1. EXECUTIVE SUMMARY
    console.log('\n📋 EXECUTIVE SUMMARY\n');
    console.log(`Total Areas: ${areas.value?.length || 0}`);
    console.log(`Total Teams: ${teams.value?.length || 0}`);
    console.log(`Total Users: ${users.value?.length || 0}`);
    console.log(`Total Work Items: ${allWorkItems?.value?.length || 0}`);
    
    // 2. TEAM-BASED ANALYTICS (using area path assumption)
    console.log('\n👥 TEAM PERFORMANCE ANALYTICS\n');
    console.log('(Based on Team Name = Area Path assumption)\n');
    
    const teamAnalytics: Map<string, TeamAnalytics> = new Map();
    
    // Initialize team analytics for each team
    if (teams.value) {
      teams.value.forEach((team: any) => {
        teamAnalytics.set(team.TeamName, {
          teamName: team.TeamName,
          areaPaths: [],
          totalWorkItems: 0,
          activeWorkItems: 0,
          completedWorkItems: 0,
          bugs: 0,
          tasks: 0,
          features: 0,
          epics: 0,
          unassignedItems: 0,
          teamMembers: new Set(),
          averageAge: 0,
          oldestItem: null
        });
      });
    }
    
    // Map areas to teams based on name matching
    if (areas.value && teams.value) {
      areas.value.forEach((area: any) => {
        const areaPath = area.AreaPath;
        const pathParts = areaPath.split('\\');
        
        // Check each part of the path against team names
        teams.value.forEach((team: any) => {
          if (pathParts.some((part: string) => 
            part.toLowerCase() === team.TeamName.toLowerCase() ||
            part.toLowerCase().includes(team.TeamName.toLowerCase()) ||
            team.TeamName.toLowerCase().includes(part.toLowerCase())
          )) {
            const analytics = teamAnalytics.get(team.TeamName);
            if (analytics && !analytics.areaPaths.includes(areaPath)) {
              analytics.areaPaths.push(areaPath);
            }
          }
        });
      });
    }
    
    // Analyze work items for each team
    if (allWorkItems?.value) {
      const today = new Date();
      
      allWorkItems.value.forEach((wi: any) => {
        const areaPath = areaSKToPath.get(wi.AreaSK);
        if (!areaPath) return;
        
        // Find which team owns this work item
        teamAnalytics.forEach((analytics, teamName) => {
          if (analytics.areaPaths.some(path => areaPath.startsWith(path))) {
            analytics.totalWorkItems++;
            
            // State analysis
            if (wi.State === 'Closed' || wi.State === 'Done' || wi.State === 'Resolved') {
              analytics.completedWorkItems++;
            } else {
              analytics.activeWorkItems++;
            }
            
            // Type analysis
            switch (wi.WorkItemType) {
              case 'Bug': analytics.bugs++; break;
              case 'Task': analytics.tasks++; break;
              case 'Feature': analytics.features++; break;
              case 'Epic': analytics.epics++; break;
            }
            
            // Assignment analysis
            if (!wi.AssignedToUserSK) {
              analytics.unassignedItems++;
            } else {
              const userName = userMap.get(wi.AssignedToUserSK);
              if (userName) {
                analytics.teamMembers.add(userName);
              }
            }
            
            // Age analysis
            if (wi.CreatedDateSK && wi.State !== 'Closed' && wi.State !== 'Done') {
              const createdDate = new Date(wi.CreatedDateSK.toString());
              const ageInDays = Math.floor((today.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
              
              if (!analytics.oldestItem || ageInDays > analytics.oldestItem.age) {
                analytics.oldestItem = {
                  id: wi.WorkItemId,
                  title: wi.Title,
                  age: ageInDays
                };
              }
            }
          }
        });
      });
    }
    
    // Display team analytics
    const teamsWithWork = Array.from(teamAnalytics.values())
      .filter(t => t.totalWorkItems > 0)
      .sort((a, b) => b.totalWorkItems - a.totalWorkItems);
    
    console.log(`Teams with work items: ${teamsWithWork.length}/${teams.value?.length || 0}\n`);
    
    teamsWithWork.slice(0, 10).forEach(team => {
      console.log(`📊 ${team.teamName}`);
      console.log(`   Areas Managed: ${team.areaPaths.length}`);
      console.log(`   Total Work Items: ${team.totalWorkItems}`);
      console.log(`   ├─ Active: ${team.activeWorkItems} (${((team.activeWorkItems/team.totalWorkItems)*100).toFixed(1)}%)`);
      console.log(`   └─ Completed: ${team.completedWorkItems} (${((team.completedWorkItems/team.totalWorkItems)*100).toFixed(1)}%)`);
      
      console.log(`   Work Item Types:`);
      if (team.tasks > 0) console.log(`   ├─ Tasks: ${team.tasks}`);
      if (team.bugs > 0) console.log(`   ├─ Bugs: ${team.bugs}`);
      if (team.features > 0) console.log(`   ├─ Features: ${team.features}`);
      if (team.epics > 0) console.log(`   └─ Epics: ${team.epics}`);
      
      console.log(`   Team Size: ${team.teamMembers.size} contributors`);
      console.log(`   Unassigned Items: ${team.unassignedItems} (${((team.unassignedItems/team.totalWorkItems)*100).toFixed(1)}%)`);
      
      if (team.oldestItem) {
        console.log(`   ⚠️  Oldest Active Item: #${team.oldestItem.id} (${team.oldestItem.age} days old)`);
      }
      
      // Quality metrics
      const bugRatio = team.bugs / (team.totalWorkItems || 1);
      const completionRate = team.completedWorkItems / (team.totalWorkItems || 1);
      
      console.log(`   Metrics:`);
      console.log(`   ├─ Bug Ratio: ${(bugRatio * 100).toFixed(1)}%`);
      console.log(`   └─ Completion Rate: ${(completionRate * 100).toFixed(1)}%`);
      console.log('');
    });
    
    // 3. ORGANIZATIONAL INSIGHTS
    console.log('\n🎯 KEY INSIGHTS\n');
    
    // Teams without work
    const teamsWithoutWork = Array.from(teamAnalytics.values())
      .filter(t => t.totalWorkItems === 0);
    
    if (teamsWithoutWork.length > 0) {
      console.log(`⚠️  ${teamsWithoutWork.length} teams have no associated work items:`);
      teamsWithoutWork.slice(0, 5).forEach(t => {
        console.log(`   - ${t.teamName}`);
      });
      console.log('');
    }
    
    // Work distribution analysis
    const workDistribution = teamsWithWork.map(t => t.totalWorkItems);
    const maxWork = Math.max(...workDistribution);
    const minWork = Math.min(...workDistribution);
    const avgWork = workDistribution.reduce((a, b) => a + b, 0) / workDistribution.length;
    const stdDev = Math.sqrt(
      workDistribution.reduce((sq, n) => sq + Math.pow(n - avgWork, 2), 0) / workDistribution.length
    );
    
    console.log('📈 Work Distribution Analysis:');
    console.log(`   Max items per team: ${maxWork}`);
    console.log(`   Min items per team: ${minWork}`);
    console.log(`   Average: ${avgWork.toFixed(1)}`);
    console.log(`   Std Deviation: ${stdDev.toFixed(1)}`);
    
    if (stdDev > avgWork * 0.5) {
      console.log('   ⚠️  High variance in work distribution - consider rebalancing');
    }
    
    // 4. TOP PERFORMERS
    console.log('\n🏆 TOP PERFORMERS\n');
    
    // Most productive teams (by completion)
    const topCompleters = teamsWithWork
      .filter(t => t.completedWorkItems > 0)
      .sort((a, b) => b.completedWorkItems - a.completedWorkItems)
      .slice(0, 5);
    
    if (topCompleters.length > 0) {
      console.log('Top 5 Teams by Completions:');
      topCompleters.forEach((team, i) => {
        console.log(`   ${i + 1}. ${team.teamName}: ${team.completedWorkItems} completed`);
      });
    }
    
    // 5. QUALITY METRICS
    console.log('\n🐛 QUALITY METRICS\n');
    
    const totalBugs = teamsWithWork.reduce((sum, t) => sum + t.bugs, 0);
    const totalFeatures = teamsWithWork.reduce((sum, t) => sum + t.features, 0);
    const totalTasks = teamsWithWork.reduce((sum, t) => sum + t.tasks, 0);
    
    console.log(`Total Bugs: ${totalBugs}`);
    console.log(`Total Features: ${totalFeatures}`);
    console.log(`Total Tasks: ${totalTasks}`);
    console.log(`Bug-to-Feature Ratio: ${(totalBugs / (totalFeatures || 1)).toFixed(2)}:1`);
    
    // Teams with high bug rates
    const highBugTeams = teamsWithWork
      .filter(t => t.bugs / t.totalWorkItems > 0.3)
      .sort((a, b) => (b.bugs/b.totalWorkItems) - (a.bugs/a.totalWorkItems));
    
    if (highBugTeams.length > 0) {
      console.log('\n⚠️  Teams with high bug rates (>30%):');
      highBugTeams.forEach(team => {
        const bugRate = (team.bugs / team.totalWorkItems * 100).toFixed(1);
        console.log(`   - ${team.teamName}: ${bugRate}% bugs`);
      });
    }
    
    // 6. ACTIONABLE RECOMMENDATIONS
    console.log('\n💡 RECOMMENDATIONS\n');
    
    // Unassigned work
    const totalUnassigned = teamsWithWork.reduce((sum, t) => sum + t.unassignedItems, 0);
    const unassignedRate = totalUnassigned / allWorkItems?.value?.length || 0;
    
    if (unassignedRate > 0.15) {
      console.log(`1. Assignment Gap: ${(unassignedRate * 100).toFixed(1)}% of work items are unassigned`);
      console.log(`   → Action: Review and assign ${totalUnassigned} items across teams`);
    }
    
    // Work imbalance
    if (stdDev > avgWork * 0.5) {
      const overloadedTeams = teamsWithWork.filter(t => t.totalWorkItems > avgWork + stdDev);
      console.log(`\n2. Work Imbalance: ${overloadedTeams.length} teams are overloaded`);
      overloadedTeams.slice(0, 3).forEach(t => {
        console.log(`   - ${t.teamName}: ${t.totalWorkItems} items (${((t.totalWorkItems/avgWork - 1) * 100).toFixed(0)}% above average)`);
      });
      console.log(`   → Action: Redistribute work from overloaded teams`);
    }
    
    // Stale items
    const staleTeams = teamsWithWork.filter(t => t.oldestItem && t.oldestItem.age > 90);
    if (staleTeams.length > 0) {
      console.log(`\n3. Stale Work Items: ${staleTeams.length} teams have items >90 days old`);
      staleTeams.slice(0, 3).forEach(t => {
        console.log(`   - ${t.teamName}: Item #${t.oldestItem.id} (${t.oldestItem.age} days)`);
      });
      console.log(`   → Action: Review and close or re-prioritize stale items`);
    }
    
    // Quality concerns
    if (totalBugs / totalFeatures > 2) {
      console.log(`\n4. Quality Alert: Bug-to-Feature ratio is ${(totalBugs/totalFeatures).toFixed(1)}:1`);
      console.log(`   → Action: Implement quality gates and increase testing coverage`);
    }
    
    console.log('\n' + '=' .repeat(70));
    console.log('\n✅ Analytics Report Complete\n');
    
    console.log('📊 Summary Statistics:');
    console.log(`   • ${teamsWithWork.length} active teams`);
    console.log(`   • ${allWorkItems?.value?.length || 0} total work items`);
    console.log(`   • ${Array.from(new Set(teamsWithWork.flatMap(t => Array.from(t.teamMembers)))).length} active contributors`);
    console.log(`   • ${(teamsWithWork.reduce((sum, t) => sum + t.completedWorkItems, 0) / allWorkItems?.value?.length * 100).toFixed(1)}% completion rate`);
    
  } catch (error: any) {
    console.error('\n❌ Error generating analytics:', error.message);
  }
}

// Run the improved analytics
generateImprovedAnalytics();