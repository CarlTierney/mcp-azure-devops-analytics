import * as azdev from 'azure-devops-node-api';
import dotenv from 'dotenv';

dotenv.config();

async function testTeamWorkItemAssociation() {
  const orgUrl = process.env.AZURE_DEVOPS_ORG_URL!;
  const pat = process.env.AZURE_DEVOPS_PAT!;
  const orgName = orgUrl.split('/').pop();
  const analyticsUrl = `https://analytics.dev.azure.com/${orgName}`;
  
  console.log('🔍 Testing Team-WorkItem-Area Relationships in Fidem\n');
  console.log('=' .repeat(60));
  
  try {
    const authHandler = azdev.getPersonalAccessTokenHandler(pat);
    const connection = new azdev.WebApi(orgUrl, authHandler);
    
    // Step 1: Get Areas with proper fields
    console.log('\n1️⃣ Fetching Areas with all fields...');
    const areasUrl = `${analyticsUrl}/Fidem/_odata/v3.0-preview/Areas?$select=AreaSK,AreaPath,AreaName,ProjectSK`;
    const areasResponse = await connection.rest.get(areasUrl);
    const areas = areasResponse.result as any;
    
    if (areas?.value) {
      console.log(`   Found ${areas.value.length} areas`);
      console.log('   Sample areas with AreaSK:');
      areas.value.slice(0, 5).forEach((area: any) => {
        console.log(`   - ${area.AreaPath}`);
        console.log(`     AreaSK: ${area.AreaSK}`);
      });
    }
    
    // Step 2: Get Teams
    console.log('\n2️⃣ Fetching Teams...');
    const teamsUrl = `${analyticsUrl}/Fidem/_odata/v3.0-preview/Teams?$select=TeamSK,TeamName`;
    const teamsResponse = await connection.rest.get(teamsUrl);
    const teams = teamsResponse.result as any;
    
    if (teams?.value) {
      console.log(`   Found ${teams.value.length} teams`);
      
      // Create TeamSK to Name map
      const teamMap = new Map();
      teams.value.forEach((team: any) => {
        teamMap.set(team.TeamSK, team.TeamName);
      });
    }
    
    // Step 3: Get TeamAreas (the association table)
    console.log('\n3️⃣ Fetching Team-Area associations...');
    const teamAreasUrl = `${analyticsUrl}/Fidem/_odata/v3.0-preview/TeamAreas?$select=TeamSK,AreaSK`;
    const teamAreasResponse = await connection.rest.get(teamAreasUrl);
    const teamAreas = teamAreasResponse.result as any;
    
    if (teamAreas?.value && teamAreas.value.length > 0) {
      console.log(`   ✅ Found ${teamAreas.value.length} team-area associations`);
      
      // Build area to teams mapping
      const areaToTeams = new Map();
      teamAreas.value.forEach((ta: any) => {
        if (!areaToTeams.has(ta.AreaSK)) {
          areaToTeams.set(ta.AreaSK, []);
        }
        areaToTeams.get(ta.AreaSK).push(ta.TeamSK);
      });
      
      console.log(`   ${areaToTeams.size} areas have team associations`);
      
      // Show some examples
      console.log('\n   Sample Area-Team associations:');
      let count = 0;
      for (const [areaSK, teamSKs] of areaToTeams) {
        if (count >= 3) break;
        
        // Find area name
        const area = areas.value?.find((a: any) => a.AreaSK === areaSK);
        if (area) {
          console.log(`\n   Area: ${area.AreaPath}`);
          console.log(`   Teams managing this area:`);
          teamSKs.forEach((teamSK: string) => {
            const team = teams.value?.find((t: any) => t.TeamSK === teamSK);
            console.log(`   - ${team?.TeamName || teamSK}`);
          });
          count++;
        }
      }
    } else {
      console.log('   ⚠️  No team-area associations found');
    }
    
    // Step 4: Get Work Items (use current snapshot)
    console.log('\n4️⃣ Fetching Work Items...');
    // Use a simpler query without date filter
    const workItemsUrl = `${analyticsUrl}/Fidem/_odata/v3.0-preview/WorkItemSnapshot?$select=WorkItemId,Title,AreaSK,WorkItemType,State&$filter=Revision eq 1&$top=20`;
    let workItems: any;
    
    try {
      const workItemsResponse = await connection.rest.get(workItemsUrl);
      workItems = workItemsResponse.result as any;
    } catch (err) {
      // Try alternative query
      console.log('   Trying alternative work item query...');
      const altUrl = `${analyticsUrl}/Fidem/_odata/v3.0-preview/WorkItems?$select=WorkItemId,Title,AreaSK,WorkItemType,State&$top=20`;
      const altResponse = await connection.rest.get(altUrl);
      workItems = altResponse.result as any;
    }
    
    if (workItems?.value && workItems.value.length > 0) {
      console.log(`   Found ${workItems.value.length} work items`);
      
      // Group by area
      const workItemsByArea = new Map();
      workItems.value.forEach((wi: any) => {
        if (!workItemsByArea.has(wi.AreaSK)) {
          workItemsByArea.set(wi.AreaSK, []);
        }
        workItemsByArea.get(wi.AreaSK).push(wi);
      });
      
      console.log(`   Work items are in ${workItemsByArea.size} different areas`);
    }
    
    // Step 5: Verify the complete relationship
    console.log('\n5️⃣ Verifying Team -> Area -> Work Item relationships...\n');
    
    if (teamAreas?.value && workItems?.value) {
      // Find work items in areas that have teams
      let verifiedRelationships = 0;
      
      for (const wi of workItems.value) {
        // Find teams for this work item's area
        const teamsForWI = teamAreas.value
          .filter((ta: any) => ta.AreaSK === wi.AreaSK)
          .map((ta: any) => ta.TeamSK);
        
        if (teamsForWI.length > 0) {
          verifiedRelationships++;
          
          if (verifiedRelationships <= 3) {
            const area = areas.value?.find((a: any) => a.AreaSK === wi.AreaSK);
            console.log(`   ✅ Work Item #${wi.WorkItemId}: ${wi.Title || 'No Title'}`);
            console.log(`      Type: ${wi.WorkItemType}, State: ${wi.State}`);
            console.log(`      Area: ${area?.AreaPath || wi.AreaSK}`);
            console.log(`      Managed by teams:`);
            teamsForWI.forEach((teamSK: string) => {
              const team = teams.value?.find((t: any) => t.TeamSK === teamSK);
              console.log(`      - ${team?.TeamName || teamSK}`);
            });
            console.log('');
          }
        }
      }
      
      if (verifiedRelationships > 0) {
        console.log('=' .repeat(60));
        console.log('\n🎯 VERIFICATION SUCCESSFUL!\n');
        console.log(`Found ${verifiedRelationships} work items associated with teams through areas`);
        console.log('\nHow the association works:');
        console.log('1. Work Items have an AreaSK field');
        console.log('2. TeamAreas table maps TeamSK to AreaSK');
        console.log('3. This creates the relationship: Team -> TeamAreas -> Area <- Work Item');
        console.log('\nThis means:');
        console.log('- Teams own areas through TeamAreas configuration');
        console.log('- Work items belong to areas through their AreaSK');
        console.log('- Therefore, teams implicitly own all work items in their areas');
      } else {
        console.log('\n⚠️  Could not verify team-workitem relationships');
        console.log('Possible reasons:');
        console.log('- TeamAreas might not be configured in Azure DevOps');
        console.log('- Work items might be in areas without team assignments');
      }
    }
    
    // Step 6: Check for naming conventions
    console.log('\n6️⃣ Checking Area-Team naming patterns...');
    
    if (areas?.value && teams?.value) {
      const nameMatches: any[] = [];
      
      areas.value.forEach((area: any) => {
        const areaLastPart = area.AreaPath.split('\\').pop();
        const matchingTeam = teams.value.find((team: any) => 
          team.TeamName === areaLastPart ||
          team.TeamName.toLowerCase() === areaLastPart?.toLowerCase()
        );
        
        if (matchingTeam) {
          nameMatches.push({ area: area.AreaPath, team: matchingTeam.TeamName });
        }
      });
      
      if (nameMatches.length > 0) {
        console.log(`\n   Found ${nameMatches.length} areas with matching team names:`);
        nameMatches.slice(0, 5).forEach(match => {
          console.log(`   - Area "${match.area}" matches Team "${match.team}"`);
        });
        console.log('\n   This suggests teams are organized to match the area hierarchy');
      }
    }
    
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    if (error.result) {
      console.error('Details:', JSON.stringify(error.result, null, 2));
    }
  }
}

// Run the test
testTeamWorkItemAssociation();