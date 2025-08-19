import * as azdev from 'azure-devops-node-api';
import dotenv from 'dotenv';

dotenv.config();

async function checkAnalyticsAvailability() {
  const orgUrl = process.env.AZURE_DEVOPS_ORG_URL!;
  const pat = process.env.AZURE_DEVOPS_PAT!;
  
  console.log('Checking Analytics availability...\n');
  
  try {
    const authHandler = azdev.getPersonalAccessTokenHandler(pat);
    const connection = new azdev.WebApi(orgUrl, authHandler);
    
    // Get organization name from URL
    const orgName = orgUrl.split('/').pop();
    console.log(`Organization: ${orgName}`);
    
    // Try different Analytics endpoints
    const endpoints = [
      `${orgUrl}/_apis/analytics/v1.0/projects`,
      `${orgUrl}/_odata/v1.0/Projects`,
      `${orgUrl}/_odata/v2.0/Projects`, 
      `${orgUrl}/_odata/v3.0-preview/Projects`,
      `${orgUrl}/_odata/v3.0/Projects`,
      `${orgUrl}/_odata/v4.0-preview/Projects`,
      `https://analytics.dev.azure.com/${orgName}/_odata/v3.0-preview/Projects`,
      `https://analytics.dev.azure.com/${orgName}/_odata/v4.0-preview/Projects`
    ];
    
    console.log('\nTesting Analytics endpoints:\n');
    
    for (const endpoint of endpoints) {
      try {
        console.log(`Testing: ${endpoint}`);
        const response = await connection.rest.get(endpoint);
        
        if (response.statusCode === 200) {
          console.log(`✅ SUCCESS! Status: ${response.statusCode}`);
          console.log(`   Found working endpoint!`);
          
          if (response.result) {
            const data = response.result as any;
            if (data.value && Array.isArray(data.value)) {
              console.log(`   Projects found: ${data.value.length}`);
              data.value.slice(0, 2).forEach((p: any) => {
                console.log(`   - ${p.ProjectName || p.Name || p.name}`);
              });
            }
          }
          
          console.log('\n🎉 Analytics is available at this endpoint!');
          console.log('Update your client to use this URL format.\n');
          return endpoint;
        } else {
          console.log(`   Status: ${response.statusCode}`);
        }
      } catch (err: any) {
        console.log(`   Error: ${err.statusCode || err.message}`);
      }
    }
    
    console.log('\n❌ Analytics API not found at any standard endpoint.');
    console.log('\nPossible reasons:');
    console.log('1. Analytics extension is not installed');
    console.log('2. Your PAT doesn\'t have Analytics scope');
    console.log('3. Analytics is disabled for this organization');
    console.log('\nTo enable Analytics:');
    console.log('1. Go to https://dev.azure.com/' + orgName);
    console.log('2. Click Organization Settings → Extensions');
    console.log('3. Browse Marketplace and search for "Analytics"');
    console.log('4. Install the Analytics extension');
    console.log('\nTo check PAT permissions:');
    console.log('1. Go to User Settings → Personal Access Tokens');
    console.log('2. Edit your PAT and ensure it has:');
    console.log('   - Analytics (Read)');
    console.log('   - Work Items (Read)');
    console.log('   - Project and Team (Read)');
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

checkAnalyticsAvailability();