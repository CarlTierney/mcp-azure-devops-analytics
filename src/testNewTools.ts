import { AzureDevOpsClient } from './azureDevOpsClient.js';
import dotenv from 'dotenv';

dotenv.config();

async function testNewAnalyticsTools() {
  const client = new AzureDevOpsClient({
    orgUrl: process.env.AZURE_DEVOPS_ORG_URL!,
    pat: process.env.AZURE_DEVOPS_PAT!,
    project: 'Fidem'
  });

  console.log('🧪 Testing New Analytics Tools\n');
  console.log('=' .repeat(70));
  
  try {
    // Test 1: Get Iterations
    console.log('\n1️⃣ Testing getIterations()...\n');
    
    const allIterations = await client.getIterations('Fidem');
    console.log(`Total iterations: ${allIterations.value?.length || 0}`);
    
    if (allIterations.value && allIterations.value.length > 0) {
      console.log('Sample iterations:');
      allIterations.value.slice(0, 3).forEach((iter: any) => {
        console.log(`  - ${iter.IterationPath}`);
        console.log(`    Start: ${iter.StartDateSK}, End: ${iter.EndDateSK}`);
      });
    }
    
    // Test current iteration
    console.log('\nGetting current iteration...');
    const currentIteration = await client.getIterations('Fidem', { current: true });
    if (currentIteration.value && currentIteration.value.length > 0) {
      console.log(`Current iteration: ${currentIteration.value[0].IterationPath}`);
    } else {
      console.log('No current iteration found');
    }
    
    // Test 2: Get Work Item History
    console.log('\n2️⃣ Testing getWorkItemHistory()...\n');
    
    // First get a work item to test with
    const workItems = await client.queryAnalytics(
      `WorkItemSnapshot?$select=WorkItemId&$filter=Revision eq 1&$top=1`,
      'Fidem'
    );
    
    if (workItems.value && workItems.value.length > 0) {
      const workItemId = workItems.value[0].WorkItemId;
      console.log(`Testing with work item #${workItemId}...`);
      
      const history = await client.getWorkItemHistory(workItemId, 'Fidem');
      
      if (!history.error) {
        console.log(`\nWork Item #${workItemId} History:`);
        console.log(`  Total Revisions: ${history.totalRevisions}`);
        console.log(`  Current State: ${history.currentState}`);
        console.log(`  Created: ${history.createdDate}`);
        console.log(`  Last Modified: ${history.lastModifiedDate}`);
        
        if (history.cycleTime !== null) {
          console.log(`  Cycle Time: ${history.cycleTime} days`);
        }
        if (history.leadTime !== null) {
          console.log(`  Lead Time: ${history.leadTime} days`);
        }
        
        if (history.stateTransitions.length > 0) {
          console.log(`\n  State Transitions (${history.stateTransitions.length}):`);
          history.stateTransitions.slice(0, 5).forEach((transition: any) => {
            console.log(`    ${transition.fromState || 'Created'} → ${transition.toState} (Rev ${transition.revision})`);
          });
        }
      } else {
        console.log(`Error: ${history.error}`);
      }
    } else {
      console.log('No work items found to test history');
    }
    
    // Test 3: Get Team Members
    console.log('\n3️⃣ Testing getTeamMembers()...\n');
    
    // Test with a known team
    const teamName = 'Services';
    console.log(`Getting members for team: ${teamName}`);
    
    const teamMembers = await client.getTeamMembers(teamName, 'Fidem');
    
    if (!teamMembers.error) {
      console.log(`\nTeam: ${teamMembers.teamName}`);
      console.log(`Member Count: ${teamMembers.memberCount}`);
      if (teamMembers.note) {
        console.log(`Note: ${teamMembers.note}`);
      }
      
      if (teamMembers.members && teamMembers.members.length > 0) {
        console.log('Members:');
        teamMembers.members.slice(0, 5).forEach((member: any) => {
          console.log(`  - ${member.UserName} (${member.UserEmail || 'No email'})`);
        });
      }
    } else {
      console.log(`Error: ${teamMembers.error}`);
    }
    
    // Test 4: Sprint Analytics Example
    console.log('\n4️⃣ Sprint Analytics Example...\n');
    
    // Get past iterations
    const pastIterations = await client.getIterations('Fidem', { timeframe: 'past' });
    const futureIterations = await client.getIterations('Fidem', { timeframe: 'future' });
    
    console.log(`Past iterations: ${pastIterations.value?.length || 0}`);
    console.log(`Future iterations: ${futureIterations.value?.length || 0}`);
    
    // Calculate velocity if we have past iterations
    if (pastIterations.value && pastIterations.value.length > 0) {
      console.log('\nCalculating velocity for past 3 iterations...');
      
      for (const iteration of pastIterations.value.slice(0, 3)) {
        // Get completed work items for this iteration
        const completedQuery = `WorkItemSnapshot?$select=WorkItemId,StoryPoints&$filter=IterationSK eq '${iteration.IterationSK}' and (State eq 'Closed' or State eq 'Done')&$apply=groupby((IterationSK), aggregate(StoryPoints with sum as TotalPoints))`;
        
        try {
          const completed = await client.queryAnalytics(completedQuery, 'Fidem');
          if (completed.value && completed.value.length > 0) {
            console.log(`  ${iteration.IterationPath}: ${completed.value[0].TotalPoints || 0} story points`);
          }
        } catch (err) {
          // Simplified query if aggregation fails
          const simpleQuery = `WorkItemSnapshot?$select=WorkItemId&$filter=IterationSK eq '${iteration.IterationSK}' and (State eq 'Closed' or State eq 'Done')&$count=true`;
          const simple = await client.queryAnalytics(simpleQuery, 'Fidem');
          console.log(`  ${iteration.IterationPath}: ${simple['@odata.count'] || 0} items completed`);
        }
      }
    }
    
    console.log('\n' + '=' .repeat(70));
    console.log('\n✅ New Analytics Tools Test Complete!\n');
    
    console.log('Summary of new capabilities:');
    console.log('1. Sprint/Iteration tracking and velocity calculation');
    console.log('2. Work item history with cycle time and lead time metrics');
    console.log('3. Team member identification (via area associations)');
    console.log('4. Time-based analytics (past, current, future iterations)');
    
  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
  }
}

// Run the test
testNewAnalyticsTools();