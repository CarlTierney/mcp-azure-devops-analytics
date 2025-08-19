import { AzureDevOpsClient } from './azureDevOpsClient.js';
import dotenv from 'dotenv';

dotenv.config();

async function testIterationFields() {
  const client = new AzureDevOpsClient({
    orgUrl: process.env.AZURE_DEVOPS_ORG_URL!,
    pat: process.env.AZURE_DEVOPS_PAT!,
    project: 'Fidem'
  });

  console.log('🔍 Discovering Iteration Fields\n');
  
  try {
    // Try to get iterations with minimal fields
    console.log('Testing basic Iterations query...');
    const basicQuery = `Iterations?$top=1`;
    const basic = await client.queryAnalytics(basicQuery, 'Fidem');
    
    if (basic.value && basic.value.length > 0) {
      console.log('\nAvailable fields in Iterations:');
      console.log(JSON.stringify(basic.value[0], null, 2));
    }
    
    // Try alternative entities
    console.log('\n\nTrying WorkItemSnapshot with IterationSK...');
    const iterationQuery = `WorkItemSnapshot?$select=IterationSK&$filter=IterationSK ne null&$apply=groupby((IterationSK))&$top=5`;
    const iterations = await client.queryAnalytics(iterationQuery, 'Fidem');
    
    if (iterations.value) {
      console.log(`Found ${iterations.value.length} unique iterations in work items`);
      console.log('Sample IterationSKs:', iterations.value.slice(0, 3).map((i: any) => i.IterationSK));
    }
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

testIterationFields();