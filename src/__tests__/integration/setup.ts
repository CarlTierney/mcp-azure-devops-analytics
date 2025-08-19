import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file from project root
dotenv.config({ path: path.join(__dirname, '../../../.env') });

// Check if integration tests should run
export const shouldRunIntegrationTests = (): boolean => {
  const hasOrgUrl = !!process.env.AZURE_DEVOPS_ORG_URL;
  const hasPat = !!process.env.AZURE_DEVOPS_PAT;
  
  if (!hasOrgUrl || !hasPat) {
    console.log('⚠️  Skipping integration tests - Missing Azure DevOps credentials');
    console.log('   To run integration tests, create a .env file with:');
    console.log('   - AZURE_DEVOPS_ORG_URL');
    console.log('   - AZURE_DEVOPS_PAT');
    return false;
  }
  
  // Validate URL format
  const orgUrl = process.env.AZURE_DEVOPS_ORG_URL;
  if (!orgUrl?.startsWith('https://dev.azure.com/')) {
    console.log('⚠️  Invalid AZURE_DEVOPS_ORG_URL format. Should start with https://dev.azure.com/');
    return false;
  }
  
  return true;
};

export const getIntegrationConfig = () => {
  return {
    orgUrl: process.env.AZURE_DEVOPS_ORG_URL!,
    pat: process.env.AZURE_DEVOPS_PAT!,
    project: process.env.AZURE_DEVOPS_PROJECT,
    testTimeout: 30000, // 30 seconds for API calls
  };
};

// Helper to conditionally run integration tests
export const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;