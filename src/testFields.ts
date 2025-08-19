import * as azdev from 'azure-devops-node-api';
import dotenv from 'dotenv';

dotenv.config();

async function testFields() {
  const orgUrl = process.env.AZURE_DEVOPS_ORG_URL!;
  const pat = process.env.AZURE_DEVOPS_PAT!;
  const orgName = orgUrl.split('/').pop();
  const analyticsUrl = `https://analytics.dev.azure.com/${orgName}`;
  
  console.log('Testing field availability...\n');
  
  try {
    const authHandler = azdev.getPersonalAccessTokenHandler(pat);
    const connection = new azdev.WebApi(orgUrl, authHandler);
    
    // Test what fields are available in Areas for a specific project
    console.log('1. Testing Areas fields with project scope...');
    const projectUrl = `${analyticsUrl}/Fidem/_odata/v3.0-preview/Areas?$top=1`;
    const projectResponse = await connection.rest.get(projectUrl);
    
    if (projectResponse.result) {
      const data = projectResponse.result as any;
      if (data.value && data.value[0]) {
        console.log('Available fields in Areas:');
        Object.keys(data.value[0]).forEach(key => {
          console.log(`   - ${key}: ${typeof data.value[0][key]}`);
        });
      }
    }
    
    // Test Teams fields
    console.log('\n2. Testing Teams fields...');
    const teamsUrl = `${analyticsUrl}/Fidem/_odata/v3.0-preview/Teams?$top=1`;
    const teamsResponse = await connection.rest.get(teamsUrl);
    
    if (teamsResponse.result) {
      const data = teamsResponse.result as any;
      if (data.value && data.value[0]) {
        console.log('Available fields in Teams:');
        Object.keys(data.value[0]).forEach(key => {
          console.log(`   - ${key}: ${typeof data.value[0][key]}`);
        });
      }
    }
    
    // Test WorkItemSnapshot fields
    console.log('\n3. Testing WorkItemSnapshot fields...');
    const workItemsUrl = `${analyticsUrl}/Fidem/_odata/v3.0-preview/WorkItemSnapshot?$top=1`;
    const workItemsResponse = await connection.rest.get(workItemsUrl);
    
    if (workItemsResponse.result) {
      const data = workItemsResponse.result as any;
      if (data.value && data.value[0]) {
        console.log('Available fields in WorkItemSnapshot (sample):');
        const fields = Object.keys(data.value[0]);
        fields.slice(0, 20).forEach(key => {
          console.log(`   - ${key}: ${typeof data.value[0][key]}`);
        });
        if (fields.length > 20) {
          console.log(`   ... and ${fields.length - 20} more fields`);
        }
      }
    }
    
    // Test if we can query across projects without filter
    console.log('\n4. Testing cross-project query on Projects (no filter needed)...');
    const allProjectsUrl = `${analyticsUrl}/_odata/v3.0-preview/Projects`;
    const allProjectsResponse = await connection.rest.get(allProjectsUrl);
    
    if (allProjectsResponse.statusCode === 200) {
      console.log('✅ Projects can be queried without project filter');
    }
    
    // Test Users
    console.log('\n5. Testing Users query (usually doesn\'t need project filter)...');
    const usersUrl = `${analyticsUrl}/_odata/v3.0-preview/Users?$top=1`;
    const usersResponse = await connection.rest.get(usersUrl);
    
    if (usersResponse.statusCode === 200) {
      console.log('✅ Users can be queried without project filter');
    }
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

testFields();