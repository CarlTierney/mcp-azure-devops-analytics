import { AzureDevOpsClient } from './azureDevOpsClient.js';
import dotenv from 'dotenv';

dotenv.config();

interface MatchResult {
  team: string;
  area: string;
  matchType: 'exact' | 'partial' | 'contains' | 'fuzzy';
  confidence: number;
}

function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().replace(/[-_\s]/g, '');
  const s2 = str2.toLowerCase().replace(/[-_\s]/g, '');
  
  // Exact match
  if (s1 === s2) return 1.0;
  
  // Contains match
  if (s1.includes(s2) || s2.includes(s1)) return 0.8;
  
  // Levenshtein distance for fuzzy matching
  const matrix: number[][] = [];
  for (let i = 0; i <= s2.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= s1.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= s2.length; i++) {
    for (let j = 1; j <= s1.length; j++) {
      if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  const distance = matrix[s2.length][s1.length];
  const maxLength = Math.max(s1.length, s2.length);
  return 1 - (distance / maxLength);
}

async function analyzeTeamAreaMatching() {
  const client = new AzureDevOpsClient({
    orgUrl: process.env.AZURE_DEVOPS_ORG_URL!,
    pat: process.env.AZURE_DEVOPS_PAT!,
    project: 'Fidem'
  });

  console.log('🔍 Analyzing Team-Area Name Matching Patterns\n');
  console.log('=' .repeat(70));
  
  try {
    // Fetch all areas and teams
    const [areas, teams] = await Promise.all([
      client.getAreas('Fidem'),
      client.getTeams('Fidem')
    ]);
    
    console.log(`\n📊 Data Overview:`);
    console.log(`   Total Areas: ${areas.value?.length || 0}`);
    console.log(`   Total Teams: ${teams.value?.length || 0}`);
    
    if (!areas.value || !teams.value) {
      console.log('No data available');
      return;
    }
    
    // Build matching matrix
    const matches: MatchResult[] = [];
    const teamToAreas = new Map<string, MatchResult[]>();
    const areaToTeams = new Map<string, MatchResult[]>();
    
    // Analyze each team against each area
    for (const team of teams.value) {
      const teamName = team.TeamName;
      const teamNameClean = teamName.toLowerCase().replace(/[-_\s]/g, '');
      
      for (const area of areas.value) {
        const areaPath = area.AreaPath;
        const areaParts = areaPath.split('\\');
        
        // Check each part of the area path
        for (let i = 0; i < areaParts.length; i++) {
          const areaPart = areaParts[i];
          const areaPartClean = areaPart.toLowerCase().replace(/[-_\s]/g, '');
          
          // Calculate similarity
          const similarity = calculateSimilarity(teamName, areaPart);
          
          if (similarity >= 0.5) { // 50% similarity threshold
            let matchType: 'exact' | 'partial' | 'contains' | 'fuzzy';
            
            if (teamNameClean === areaPartClean) {
              matchType = 'exact';
            } else if (teamNameClean.includes(areaPartClean) || areaPartClean.includes(teamNameClean)) {
              matchType = 'contains';
            } else if (similarity >= 0.7) {
              matchType = 'partial';
            } else {
              matchType = 'fuzzy';
            }
            
            const match: MatchResult = {
              team: teamName,
              area: areaPath,
              matchType,
              confidence: similarity
            };
            
            matches.push(match);
            
            if (!teamToAreas.has(teamName)) {
              teamToAreas.set(teamName, []);
            }
            teamToAreas.get(teamName)!.push(match);
            
            if (!areaToTeams.has(areaPath)) {
              areaToTeams.set(areaPath, []);
            }
            areaToTeams.get(areaPath)!.push(match);
          }
        }
      }
    }
    
    // Sort matches by confidence
    matches.sort((a, b) => b.confidence - a.confidence);
    
    // Display results
    console.log('\n🎯 EXACT MATCHES (100% confidence)\n');
    const exactMatches = matches.filter(m => m.matchType === 'exact');
    if (exactMatches.length > 0) {
      exactMatches.forEach(m => {
        console.log(`   ✅ Team "${m.team}" = Area "${m.area}"`);
      });
    } else {
      console.log('   No exact matches found');
    }
    
    console.log('\n🔄 PARTIAL/CONTAINS MATCHES (70-99% confidence)\n');
    const partialMatches = matches.filter(m => m.matchType === 'contains' || m.matchType === 'partial');
    if (partialMatches.length > 0) {
      partialMatches.slice(0, 10).forEach(m => {
        console.log(`   📌 Team "${m.team}" ~ Area "${m.area}"`);
        console.log(`      Type: ${m.matchType}, Confidence: ${(m.confidence * 100).toFixed(1)}%`);
      });
      if (partialMatches.length > 10) {
        console.log(`   ... and ${partialMatches.length - 10} more partial matches`);
      }
    } else {
      console.log('   No partial matches found');
    }
    
    console.log('\n🔍 FUZZY MATCHES (50-70% confidence)\n');
    const fuzzyMatches = matches.filter(m => m.matchType === 'fuzzy');
    if (fuzzyMatches.length > 0) {
      fuzzyMatches.slice(0, 5).forEach(m => {
        console.log(`   🔸 Team "${m.team}" ? Area "${m.area}"`);
        console.log(`      Confidence: ${(m.confidence * 100).toFixed(1)}%`);
      });
      if (fuzzyMatches.length > 5) {
        console.log(`   ... and ${fuzzyMatches.length - 5} more fuzzy matches`);
      }
    }
    
    // Teams with no matches
    console.log('\n❌ TEAMS WITH NO AREA MATCHES\n');
    const teamsWithoutMatches = teams.value.filter((t: any) => !teamToAreas.has(t.TeamName));
    if (teamsWithoutMatches.length > 0) {
      teamsWithoutMatches.forEach((t: any) => {
        console.log(`   - ${t.TeamName}`);
      });
    } else {
      console.log('   All teams have at least one potential area match');
    }
    
    // Areas with no team matches
    console.log('\n📁 AREAS WITH NO TEAM MATCHES\n');
    const areasWithoutTeams = areas.value.filter((a: any) => !areaToTeams.has(a.AreaPath));
    if (areasWithoutTeams.length > 0) {
      console.log(`   ${areasWithoutTeams.length} areas have no matching teams:`);
      areasWithoutTeams.slice(0, 10).forEach((a: any) => {
        console.log(`   - ${a.AreaPath}`);
      });
      if (areasWithoutTeams.length > 10) {
        console.log(`   ... and ${areasWithoutTeams.length - 10} more`);
      }
    }
    
    // Pattern analysis
    console.log('\n📈 PATTERN ANALYSIS\n');
    
    // Teams with multiple area matches
    const teamsWithMultipleAreas = Array.from(teamToAreas.entries())
      .filter(([_, areas]) => areas.length > 1)
      .sort((a, b) => b[1].length - a[1].length);
    
    if (teamsWithMultipleAreas.length > 0) {
      console.log('Teams matching multiple areas:');
      teamsWithMultipleAreas.slice(0, 5).forEach(([team, areas]) => {
        console.log(`   ${team}: ${areas.length} potential areas`);
        areas.slice(0, 3).forEach(a => {
          console.log(`      - ${a.area.split('\\').slice(-2).join('\\')} (${(a.confidence * 100).toFixed(0)}%)`);
        });
      });
    }
    
    // Common naming patterns
    console.log('\n🔤 NAMING PATTERNS DETECTED\n');
    
    const patterns = {
      dashSeparated: 0,
      spaceSeparated: 0,
      camelCase: 0,
      abbreviations: 0
    };
    
    teams.value.forEach((t: any) => {
      if (t.TeamName.includes('-')) patterns.dashSeparated++;
      if (t.TeamName.includes(' ')) patterns.spaceSeparated++;
      if (t.TeamName.match(/[a-z][A-Z]/)) patterns.camelCase++;
      if (t.TeamName.length <= 4 || t.TeamName.match(/^[A-Z]{2,}$/)) patterns.abbreviations++;
    });
    
    console.log('Team naming conventions:');
    Object.entries(patterns).forEach(([pattern, count]) => {
      if (count > 0) {
        const percentage = (count / teams.value.length * 100).toFixed(1);
        console.log(`   ${pattern}: ${count} teams (${percentage}%)`);
      }
    });
    
    // Suggested mappings
    console.log('\n💡 SUGGESTED TEAM-AREA MAPPINGS\n');
    console.log('Based on name similarity analysis:\n');
    
    const suggestions = new Map<string, string>();
    
    for (const team of teams.value) {
      const teamMatches = teamToAreas.get(team.TeamName);
      if (teamMatches && teamMatches.length > 0) {
        // Pick the best match for each team
        const bestMatch = teamMatches.reduce((best, current) => 
          current.confidence > best.confidence ? current : best
        );
        suggestions.set(team.TeamName, bestMatch.area);
      }
    }
    
    Array.from(suggestions.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([team, area]) => {
        const match = matches.find(m => m.team === team && m.area === area);
        const confidence = match ? (match.confidence * 100).toFixed(0) : '?';
        console.log(`   ${team} → ${area.split('\\').slice(-2).join('\\')} (${confidence}% confidence)`);
      });
    
    // Summary statistics
    console.log('\n📊 SUMMARY STATISTICS\n');
    console.log(`   Total matches found: ${matches.length}`);
    console.log(`   Exact matches: ${exactMatches.length}`);
    console.log(`   Partial matches: ${partialMatches.length}`);
    console.log(`   Fuzzy matches: ${fuzzyMatches.length}`);
    console.log(`   Teams with matches: ${teamToAreas.size}/${teams.value.length} (${(teamToAreas.size/teams.value.length*100).toFixed(1)}%)`);
    console.log(`   Areas with matches: ${areaToTeams.size}/${areas.value.length} (${(areaToTeams.size/areas.value.length*100).toFixed(1)}%)`);
    
    // Export mappings
    const mappingData = {
      timestamp: new Date().toISOString(),
      project: 'Fidem',
      statistics: {
        totalTeams: teams.value.length,
        totalAreas: areas.value.length,
        teamsWithMatches: teamToAreas.size,
        areasWithMatches: areaToTeams.size
      },
      exactMatches: exactMatches.map(m => ({ team: m.team, area: m.area })),
      suggestedMappings: Array.from(suggestions.entries()).map(([team, area]) => ({
        team,
        area,
        confidence: matches.find(m => m.team === team && m.area === area)?.confidence
      })),
      unmatchedTeams: teamsWithoutMatches.map((t: any) => t.TeamName),
      unmatchedAreas: areasWithoutTeams.map((a: any) => a.AreaPath)
    };
    
    // Save to working directory
    const fs = await import('fs/promises');
    const path = await import('path');
    
    // Use working directory from environment or default
    const workingDir = process.env.MCP_ANALYTICS_CACHE_DIR || '.mcp-analytics-cache';
    const mappingsDir = path.join(workingDir, 'mappings');
    
    // Ensure directory exists
    await fs.mkdir(mappingsDir, { recursive: true });
    
    const filePath = path.join(mappingsDir, 'team-area-mappings.json');
    await fs.writeFile(
      filePath,
      JSON.stringify(mappingData, null, 2)
    );
    
    console.log(`\n✅ Analysis complete! Mappings saved to ${filePath}`);
    
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
  }
}

// Run the analysis
analyzeTeamAreaMatching();