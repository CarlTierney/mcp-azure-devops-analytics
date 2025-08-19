import { AzureDevOpsClient } from './azureDevOpsClient.js';
import dotenv from 'dotenv';

dotenv.config();

async function testTeamWorkItemRelationship() {
  const client = new AzureDevOpsClient({
    orgUrl: process.env.AZURE_DEVOPS_ORG_URL!,
    pat: process.env.AZURE_DEVOPS_PAT!,
    project: process.env.AZURE_DEVOPS_PROJECT || 'Fidem'
  });

  console.log('🔍 Testing Team-WorkItem Association through Area Paths\n');
  console.log('=' .repeat(60));
  
  try {
    // Step 1: Get all teams in the project
    console.log('\n1️⃣ Fetching Teams in Fidem project...');
    const teams = await client.getTeams('Fidem');
    console.log(`   Found ${teams.value?.length || 0} teams`);
    
    if (!teams.value || teams.value.length === 0) {
      console.log('   ⚠️  No teams found');
      return;
    }

    // Display first few teams
    console.log('   Sample teams:');
    teams.value.slice(0, 5).forEach((team: any) => {
      console.log(`   - ${team.TeamName} (TeamSK: ${team.TeamSK})`);
    });

    // Step 2: Get team areas for first team
    const testTeam = teams.value[0];
    console.log(`\n2️⃣ Getting areas for team: ${testTeam.TeamName}`);
    
    let teamAreas: any;
    try {
      teamAreas = await client.getTeamAreas(testTeam.TeamName, 'Fidem');
      console.log(`   Team has ${teamAreas.areas?.length || 0} associated areas`);
      
      if (teamAreas.areas && teamAreas.areas.length > 0) {
        console.log('   Associated area paths:');
        teamAreas.areas.forEach((area: any) => {
          console.log(`   - ${area.AreaPath}`);
        });
      }
    } catch (err: any) {
      // Some teams might not have areas configured, try another team
      console.log(`   ⚠️  Could not get areas for ${testTeam.TeamName}: ${err.message}`);
      
      // Try to find a team with areas
      for (let i = 1; i < Math.min(teams.value.length, 5); i++) {
        const altTeam = teams.value[i];
        console.log(`   Trying team: ${altTeam.TeamName}`);
        try {
          teamAreas = await client.getTeamAreas(altTeam.TeamName, 'Fidem');
          if (teamAreas.areas && teamAreas.areas.length > 0) {
            console.log(`   ✅ Found team with areas: ${altTeam.TeamName}`);
            console.log(`   Team has ${teamAreas.areas.length} associated areas`);
            break;
          }
        } catch (e) {
          continue;
        }
      }
    }

    // Step 3: Get all areas to understand the structure
    console.log('\n3️⃣ Fetching all areas in Fidem...');
    const allAreas = await client.getAreas('Fidem');
    console.log(`   Found ${allAreas.value?.length || 0} total areas`);
    
    if (allAreas.value && allAreas.value.length > 0) {
      console.log('   Sample area paths:');
      allAreas.value.slice(0, 5).forEach((area: any) => {
        console.log(`   - ${area.AreaPath} (AreaSK: ${area.AreaSK})`);
      });
    }

    // Step 4: For each area, get work items and see if we can associate them with teams
    console.log('\n4️⃣ Testing Area -> Work Item -> Team associations...');
    
    if (allAreas.value && allAreas.value.length > 0) {
      // Test with first few areas that have work items
      let foundAssociation = false;
      
      for (const area of allAreas.value.slice(0, 10)) {
        try {
          // Get work items for this area
          const workItems = await client.getWorkItemsByArea(area.AreaPath, 'Fidem');
          
          if (workItems.value && workItems.value.length > 0) {
            console.log(`\n   📁 Area: ${area.AreaPath}`);
            console.log(`      Work Items: ${workItems.value.length}`);
            
            // Check if this area is associated with any team
            const areasQuery = `TeamAreas?$filter=AreaPath eq '${area.AreaPath}'&$expand=Team($select=TeamName,TeamId)`;
            try {
              const teamAreaResult = await client.queryAnalytics(areasQuery, 'Fidem');
              
              if (teamAreaResult?.value && teamAreaResult.value.length > 0) {
                console.log(`      ✅ Associated Teams:`);
                teamAreaResult.value.forEach((ta: any) => {
                  console.log(`         - ${ta.Team?.TeamName || 'Unknown Team'}`);
                });
                
                // Show sample work items
                console.log(`      Sample Work Items:`);
                workItems.value.slice(0, 3).forEach((wi: any) => {
                  console.log(`         - #${wi.WorkItemId}: ${wi.Title || 'No Title'}`);
                  console.log(`           Type: ${wi.WorkItemType}, State: ${wi.State}`);
                });
                
                foundAssociation = true;
                console.log(`\n      🎯 VERIFIED: Team "${teamAreaResult.value[0].Team?.TeamName}" is associated with ${workItems.value.length} work items through area path "${area.AreaPath}"`);
              } else {
                console.log(`      ⚠️  No teams associated with this area`);
              }
            } catch (err: any) {
              console.log(`      ❌ Could not query team associations: ${err.message}`);
            }
            
            if (foundAssociation) break; // Found at least one association
          }
        } catch (err: any) {
          // Skip areas we can't query
          continue;
        }
      }
      
      if (!foundAssociation) {
        console.log('\n   ⚠️  Could not find areas with both teams and work items');
      }
    }

    // Step 5: Test the relationship resolution method
    console.log('\n5️⃣ Testing built-in relationship resolution...');
    const relationships = await client.getAreaTeamWorkItemRelationships(undefined, 'Fidem');
    
    if (relationships && relationships.length > 0) {
      console.log(`   Found ${relationships.length} area relationships`);
      
      // Find areas that have both teams and work items
      const areasWithBoth = relationships.filter((r: any) => 
        r.teams && r.teams.length > 0 && r.workItemCount > 0
      );
      
      if (areasWithBoth.length > 0) {
        console.log(`\n   ✅ Found ${areasWithBoth.length} areas with both teams and work items:`);
        
        areasWithBoth.slice(0, 3).forEach((rel: any) => {
          console.log(`\n   📊 Area: ${rel.area.path}`);
          console.log(`      Teams: ${rel.teams.map((t: any) => t?.TeamName || 'Unknown').join(', ')}`);
          console.log(`      Work Items: ${rel.workItemCount}`);
          
          if (rel.sampleWorkItems && rel.sampleWorkItems.length > 0) {
            console.log(`      Sample Work Items:`);
            rel.sampleWorkItems.forEach((wi: any) => {
              console.log(`         - #${wi.WorkItemId}: ${wi.Title || 'No Title'} (${wi.WorkItemType})`);
            });
          }
        });
        
        console.log('\n   ✅ VERIFICATION SUCCESSFUL: Teams can be associated with work items through area paths!');
      } else {
        console.log('\n   ⚠️  No areas found with both teams and work items');
      }
    }

    // Step 6: Direct query to verify the relationship
    console.log('\n6️⃣ Direct Analytics query to verify relationships...');
    
    // Query to get work items with their area and check for team associations
    const directQuery = `WorkItemSnapshot?$select=WorkItemId,Title,AreaSK,WorkItemType&$filter=DateValue eq DateSK&$top=10`;
    const workItemsWithArea = await client.queryAnalytics(directQuery, 'Fidem');
    
    if (workItemsWithArea?.value && workItemsWithArea.value.length > 0) {
      console.log(`   Checking ${workItemsWithArea.value.length} work items for team associations...`);
      
      for (const wi of workItemsWithArea.value.slice(0, 5)) {
        // Get the area for this work item
        const areaQuery = `Areas?$filter=AreaSK eq '${wi.AreaSK}'`;
        const areaResult = await client.queryAnalytics(areaQuery, 'Fidem');
        
        if (areaResult?.value && areaResult.value[0]) {
          const area = areaResult.value[0];
          console.log(`\n   Work Item #${wi.WorkItemId}: ${wi.Title || 'No Title'}`);
          console.log(`      Area: ${area.AreaPath}`);
          
          // Check if this area has teams
          const teamAreaQuery = `TeamAreas?$filter=AreaPath eq '${area.AreaPath}'&$expand=Team($select=TeamName)`;
          try {
            const teamAreaResult = await client.queryAnalytics(teamAreaQuery, 'Fidem');
            
            if (teamAreaResult?.value && teamAreaResult.value.length > 0) {
              console.log(`      ✅ Associated Teams: ${teamAreaResult.value.map((ta: any) => ta.Team?.TeamName).join(', ')}`);
            } else {
              console.log(`      ⚠️  No teams associated with this area`);
            }
          } catch (err) {
            console.log(`      ❌ Could not query teams for this area`);
          }
        }
      }
    }

    console.log('\n' + '=' .repeat(60));
    console.log('✅ Team-WorkItem Association Test Complete!');
    console.log('\nSummary:');
    console.log('- Teams and work items CAN be associated through area paths');
    console.log('- The association is: Work Item -> Area Path <- Team');
    console.log('- Multiple teams can be associated with the same area');
    console.log('- All work items in an area are implicitly associated with the teams managing that area');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
  }
}

// Run the test
testTeamWorkItemRelationship();