import * as azdev from 'azure-devops-node-api';
import dotenv from 'dotenv';

dotenv.config();

async function testConnection() {
  const orgUrl = process.env.AZURE_DEVOPS_ORG_URL!;
  const pat = process.env.AZURE_DEVOPS_PAT!;
  
  console.log('Testing Azure DevOps connection...');
  console.log(`Organization URL: ${orgUrl}`);
  console.log(`PAT: ${pat.substring(0, 4)}...${pat.substring(pat.length - 4)}`);
  
  try {
    // Test basic connection
    const authHandler = azdev.getPersonalAccessTokenHandler(pat);
    const connection = new azdev.WebApi(orgUrl, authHandler);
    
    // Try to get core client first
    console.log('\n1. Testing Core API...');
    const coreApi = await connection.getCoreApi();
    const projects = await coreApi.getProjects();
    console.log(`✅ Core API works! Found ${projects.length} projects`);
    projects.slice(0, 3).forEach(p => {
      console.log(`   - ${p.name} (${p.id})`);
    });
    
    // Now test Analytics endpoint directly
    console.log('\n2. Testing Analytics API...');
    const analyticsUrl = `${orgUrl}/_odata/v3.0-preview/Projects`;
    console.log(`   URL: ${analyticsUrl}`);
    
    const response = await connection.rest.get(analyticsUrl);
    console.log('   Response status:', response.statusCode);
    console.log('   Response result:', JSON.stringify(response.result, null, 2).substring(0, 500));
    
    const result = response.result as any;
    if (result && result.value) {
      console.log(`✅ Analytics API works! Found ${result.value.length} projects`);
    } else {
      console.log('⚠️  Analytics API returned unexpected format:', result);
    }
    
    // Test with a specific project if available
    if (projects.length > 0) {
      const testProject = projects[0].name;
      console.log(`\n3. Testing project-specific Analytics (${testProject})...`);
      const projectAnalyticsUrl = `${orgUrl}/${testProject}/_odata/v3.0-preview/Areas?$top=5`;
      console.log(`   URL: ${projectAnalyticsUrl}`);
      
      try {
        const projectResponse = await connection.rest.get(projectAnalyticsUrl);
        console.log('   Response status:', projectResponse.statusCode);
        const projectResult = projectResponse.result as any;
        if (projectResult && projectResult.value) {
          console.log(`✅ Project Analytics works! Found ${projectResult.value.length} areas`);
        }
      } catch (err: any) {
        console.log(`❌ Project Analytics failed: ${err.message}`);
      }
    }
    
    // Test Analytics v2.0 endpoint (older version)
    console.log('\n4. Testing Analytics v2.0 endpoint...');
    const v2Url = `${orgUrl}/_odata/v2.0/WorkItems?$top=1`;
    try {
      const v2Response = await connection.rest.get(v2Url);
      console.log('   v2.0 Response status:', v2Response.statusCode);
      if (v2Response.result) {
        console.log('✅ Analytics v2.0 endpoint accessible');
      }
    } catch (err: any) {
      console.log(`   v2.0 not available: ${err.message}`);
    }
    
    // Test Analytics v4.0-preview endpoint (newer version)
    console.log('\n5. Testing Analytics v4.0-preview endpoint...');
    const v4Url = `${orgUrl}/_odata/v4.0-preview/WorkItems?$top=1`;
    try {
      const v4Response = await connection.rest.get(v4Url);
      console.log('   v4.0-preview Response status:', v4Response.statusCode);
      if (v4Response.result) {
        console.log('✅ Analytics v4.0-preview endpoint accessible');
      }
    } catch (err: any) {
      console.log(`   v4.0-preview not available: ${err.message}`);
    }
    
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    if (error.statusCode) {
      console.error('   Status code:', error.statusCode);
    }
    if (error.result) {
      console.error('   Result:', error.result);
    }
  }
}

testConnection();