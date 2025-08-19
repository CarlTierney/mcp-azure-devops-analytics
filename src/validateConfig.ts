import dotenv from 'dotenv';
import { AzureDevOpsClient } from './azureDevOpsClient.js';

// Load environment variables
dotenv.config();

async function validateConfiguration() {
  console.log('🔍 Validating Azure DevOps configuration...\n');

  // Check environment variables
  const orgUrl = process.env.AZURE_DEVOPS_ORG_URL;
  const pat = process.env.AZURE_DEVOPS_PAT;
  const project = process.env.AZURE_DEVOPS_PROJECT;

  if (!orgUrl) {
    console.error('❌ Missing AZURE_DEVOPS_ORG_URL in .env file');
    console.log('   Please set: AZURE_DEVOPS_ORG_URL=https://dev.azure.com/your-organization\n');
    process.exit(1);
  }

  if (!pat) {
    console.error('❌ Missing AZURE_DEVOPS_PAT in .env file');
    console.log('   Please set: AZURE_DEVOPS_PAT=your-personal-access-token\n');
    console.log('   To create a PAT:');
    console.log('   1. Go to Azure DevOps -> User Settings -> Personal Access Tokens');
    console.log('   2. Create token with Analytics (Read) scope\n');
    process.exit(1);
  }

  if (!orgUrl.startsWith('https://dev.azure.com/')) {
    console.error('❌ Invalid AZURE_DEVOPS_ORG_URL format');
    console.log('   URL should start with: https://dev.azure.com/\n');
    process.exit(1);
  }

  console.log('✅ Environment variables configured');
  console.log(`   Organization: ${orgUrl}`);
  console.log(`   PAT: ${pat.substring(0, 4)}...${pat.substring(pat.length - 4)}`);
  if (project) {
    console.log(`   Default Project: ${project}`);
  } else {
    console.log('   Default Project: Not set (will query all projects)');
  }

  // Test connection
  console.log('\n🔗 Testing Azure DevOps connection...\n');
  
  const client = new AzureDevOpsClient({
    orgUrl,
    pat,
    project
  });

  try {
    // Try to get projects
    console.log('   Fetching projects...');
    const projectsResult = await client.getProjects();
    
    if (projectsResult.value && projectsResult.value.length > 0) {
      console.log(`   ✅ Successfully connected! Found ${projectsResult.value.length} projects:`);
      projectsResult.value.slice(0, 5).forEach((p: any) => {
        console.log(`      - ${p.ProjectName}`);
      });
      if (projectsResult.value.length > 5) {
        console.log(`      ... and ${projectsResult.value.length - 5} more`);
      }
    } else {
      console.log('   ✅ Connected successfully, but no projects found');
      console.log('      Check if your PAT has the correct permissions');
    }

    // If a default project is set, verify it exists
    if (project) {
      const projectExists = projectsResult.value.some((p: any) => p.ProjectName === project);
      if (projectExists) {
        console.log(`\n   ✅ Default project '${project}' exists`);
      } else {
        console.log(`\n   ⚠️  Default project '${project}' not found in the organization`);
        console.log('      Available projects:');
        projectsResult.value.forEach((p: any) => {
          console.log(`      - ${p.ProjectName}`);
        });
      }
    }

    // Test a simple query
    console.log('\n   Testing Analytics API...');
    const areas = await client.getAreas(project);
    if (areas.value && areas.value.length > 0) {
      console.log(`   ✅ Analytics API working! Found ${areas.value.length} areas`);
    } else {
      console.log('   ✅ Analytics API connected, but no areas found');
    }

    console.log('\n✅ Configuration validation successful!');
    console.log('   You can now run integration tests with: npm run test:integration');

  } catch (error: any) {
    console.error('\n❌ Connection failed:', error.message);
    
    if (error.message.includes('401')) {
      console.log('\n   This is an authentication error. Please check:');
      console.log('   1. Your PAT is valid and not expired');
      console.log('   2. Your PAT has Analytics (Read) permissions');
      console.log('   3. The organization URL is correct');
    } else if (error.message.includes('404')) {
      console.log('\n   The organization or project was not found. Please check:');
      console.log('   1. The organization URL is correct');
      console.log('   2. You have access to the organization');
    } else {
      console.log('\n   Please check your network connection and Azure DevOps availability');
    }
    
    process.exit(1);
  }
}

// Run validation
validateConfiguration().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});