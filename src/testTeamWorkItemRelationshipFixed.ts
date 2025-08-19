import { AzureDevOpsClient } from './azureDevOpsClient.js';
import dotenv from 'dotenv';

dotenv.config();

async function testTeamWorkItemRelationship() {
  const client = new AzureDevOpsClient({
    orgUrl: process.env.AZURE_DEVOPS_ORG_URL!,
    pat: process.env.AZURE_DEVOPS_PAT!,
    project: 'Fidem'
  });

  console.log('🔍 Testing Team-WorkItem Association through Area Paths\n');
  console.log('=' .repeat(60));
  
  try {
    // Step 1: Get all areas with their SKs
    console.log('\n1️⃣ Fetching all areas in Fidem project...');
    const allAreas = await client.getAreas('Fidem');
    console.log(`   Found ${allAreas.value?.length || 0} areas`);
    
    if (!allAreas.value || allAreas.value.length === 0) {
      console.log('   ⚠️  No areas found');
      return;
    }

    // Create a map of AreaSK to AreaPath for quick lookup
    const areaMap = new Map();
    allAreas.value.forEach((area: any) => {
      areaMap.set(area.AreaSK, area);
      console.log(`   - ${area.AreaPath} (AreaSK: ${area.AreaSK})`);
    });

    // Step 2: Get teams
    console.log('\n2️⃣ Fetching Teams in Fidem project...');
    const teams = await client.getTeams('Fidem');
    console.log(`   Found ${teams.value?.length || 0} teams`);
    
    if (teams.value && teams.value.length > 0) {
      console.log('   Sample teams:');
      teams.value.slice(0, 5).forEach((team: any) => {
        console.log(`   - ${team.TeamName} (TeamSK: ${team.TeamSK})`);
      });
    }

    // Step 3: Get TeamAreas mapping using direct query
    console.log('\n3️⃣ Fetching Team-Area associations...');
    const teamAreasQuery = `TeamAreas?$select=TeamSK,AreaSK&$top=100`;
    const teamAreas = await client.queryAnalytics(teamAreasQuery, 'Fidem');
    
    if (teamAreas?.value) {
      console.log(`   Found ${teamAreas.value.length} team-area associations`);
      
      // Create a map of AreaSK to TeamSKs
      const areaToTeamsMap = new Map();
      teamAreas.value.forEach((ta: any) => {
        if (!areaToTeamsMap.has(ta.AreaSK)) {
          areaToTeamsMap.set(ta.AreaSK, []);
        }
        areaToTeamsMap.get(ta.AreaSK).push(ta.TeamSK);
      });
      
      console.log(`   Areas with team associations: ${areaToTeamsMap.size}`);
    }

    // Step 4: Get work items with their Area associations
    console.log('\n4️⃣ Fetching Work Items with Area associations...');
    const workItemQuery = `WorkItemSnapshot?$select=WorkItemId,Title,AreaSK,WorkItemType,State&$filter=DateValue eq DateSK&$top=20`;
    const workItems = await client.queryAnalytics(workItemQuery, 'Fidem');
    
    if (!workItems?.value || workItems.value.length === 0) {
      console.log('   ⚠️  No work items found');
      return;
    }
    
    console.log(`   Found ${workItems.value.length} work items`);

    // Step 5: Analyze the relationships
    console.log('\n5️⃣ Analyzing Team -> Area -> WorkItem relationships...\n');
    
    // Group work items by AreaSK
    const workItemsByArea = new Map();
    workItems.value.forEach((wi: any) => {
      if (!workItemsByArea.has(wi.AreaSK)) {
        workItemsByArea.set(wi.AreaSK, []);
      }
      workItemsByArea.get(wi.AreaSK).push(wi);
    });
    
    console.log(`   Work items are distributed across ${workItemsByArea.size} areas`);

    // Step 6: Find areas that have both teams and work items
    console.log('\n6️⃣ Finding areas with both Teams and Work Items...\n');
    
    let foundAssociations = 0;
    
    // Check TeamAreas for matches with work items
    if (teamAreas?.value) {
      for (const [areaSK, workItemList] of workItemsByArea) {
        // Find teams for this area
        const teamsForArea = teamAreas.value.filter((ta: any) => ta.AreaSK === areaSK);
        
        if (teamsForArea.length > 0) {
          foundAssociations++;
          
          // Get area details
          const area = areaMap.get(areaSK);
          console.log(`   📁 Area: ${area?.AreaPath || areaSK}`);
          
          // Get team names
          const teamNames: string[] = [];
          for (const ta of teamsForArea) {
            const team = teams.value?.find((t: any) => t.TeamSK === ta.TeamSK);
            if (team) {
              teamNames.push(team.TeamName);
            }
          }
          
          console.log(`      ✅ Associated Teams: ${teamNames.join(', ') || 'Teams found but names not resolved'}`);
          console.log(`      📊 Work Items: ${workItemList.length}`);
          
          // Show sample work items
          workItemList.slice(0, 3).forEach((wi: any) => {
            console.log(`         - #${wi.WorkItemId}: ${wi.Title || 'No Title'}`);
            console.log(`           Type: ${wi.WorkItemType}, State: ${wi.State}`);
          });
          
          console.log('');
          
          if (foundAssociations >= 3) break; // Show first 3 associations
        }
      }
    }

    // Step 7: Summary
    console.log('=' .repeat(60));
    
    if (foundAssociations > 0) {
      console.log('\n✅ VERIFICATION SUCCESSFUL!\n');
      console.log('Team-WorkItem Association through Area Paths is WORKING:');
      console.log(`- Found ${foundAssociations} areas with both teams and work items`);
      console.log('- Work Items are associated with Areas via AreaSK');
      console.log('- Teams are associated with Areas via TeamAreas entity');
      console.log('- This creates an indirect association: Team -> Area <- Work Item');
      console.log('\nKey Insights:');
      console.log('- Multiple teams can manage the same area');
      console.log('- All work items in an area are implicitly owned by the teams managing that area');
      console.log('- The AreaSK field is the key linking Work Items to Teams');
    } else {
      console.log('\n⚠️  No direct associations found between teams and work items');
      console.log('This might indicate:');
      console.log('- Teams are not configured with area paths');
      console.log('- Work items are in areas not managed by teams');
      console.log('- The TeamAreas configuration needs to be set up in Azure DevOps');
    }

    // Step 8: Alternative approach - check if area names match team names
    console.log('\n8️⃣ Checking for area-team name correlations...');
    
    let nameMatches = 0;
    allAreas.value.forEach((area: any) => {
      const areaName = area.AreaName;
      const matchingTeam = teams.value?.find((t: any) => 
        t.TeamName === areaName || 
        area.AreaPath.includes(t.TeamName)
      );
      
      if (matchingTeam) {
        nameMatches++;
        if (nameMatches <= 3) {
          console.log(`   ✅ Area "${area.AreaPath}" likely corresponds to team "${matchingTeam.TeamName}"`);
        }
      }
    });
    
    if (nameMatches > 0) {
      console.log(`\n   Found ${nameMatches} areas with names matching team names`);
      console.log('   This suggests teams are organized by area hierarchy');
    }

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the test
testTeamWorkItemRelationship();